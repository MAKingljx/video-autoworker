// @vitest-environment node
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  OWNER_SCHEMA, PROGRESS_SCHEMA, recordMaintenanceProgress, runManagedChild,
  sanitizeMaintenanceFailure, validateLegacyReleasePlan,
  settleFailedMaintenance,
} from '../../scripts/legacy-release-runner.mjs'

const roots: string[] = []
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
function ownerFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-runner-')))
  roots.push(root)
  const ownerPath = join(root, 'runner.owner.json')
  writeFileSync(ownerPath, JSON.stringify({ schema: OWNER_SCHEMA, attemptId: randomUUID(),
    pid: process.pid, startToken: 'fixture', argvSha256: 'a'.repeat(64), sourceSha256: 'b'.repeat(64),
  }), { mode: 0o600 })
  return { root, ownerPath }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('continuous legacy release execution', () => {
  it('links immutable progress while rejecting heartbeat-only and regressing updates', () => {
    const { ownerPath } = ownerFixture()
    const first = recordMaintenanceProgress(ownerPath, { step: 'capture-complete', controllerRevision: 0 })
    const before = readFileSync(first.path)
    expect(JSON.parse(before.toString())).toMatchObject({ schema: PROGRESS_SCHEMA, sequence: 1, previousSha256: null })
    expect(() => recordMaintenanceProgress(ownerPath, { step: 'capture-complete', controllerRevision: 0 }))
      .toThrow('progress did not advance')
    const second = recordMaintenanceProgress(ownerPath, { step: 'task-flow-complete', controllerRevision: 1 })
    expect(JSON.parse(readFileSync(second.path, 'utf8'))).toMatchObject({ sequence: 2, previousSha256: hash(before), controllerRevision: 1 })
    expect(readFileSync(first.path)).toEqual(before)
    expect(() => recordMaintenanceProgress(ownerPath, { step: 'old-step', controllerRevision: 0 })).toThrow('previous progress is invalid')
  })

  it('returns a completed child result without inventing progress or accepting a failure', async () => {
    await expect(runManagedChild(process.execPath, ['-e', "process.stdout.write('done')"], {
      cwd: process.cwd(), env: process.env, timeoutMs: 3000,
    })).resolves.toBe('done')
    let failure: { code: number | null; stderr: string } | undefined
    await expect(runManagedChild(process.execPath, ['-e', "process.stderr.write('fixture failure'); process.exit(7)"], {
      cwd: process.cwd(), env: process.env, timeoutMs: 3000, onFailure: result => { failure = result },
    })).rejects.toThrow('code=7')
    expect(failure).toMatchObject({ code: 7, stderr: 'fixture failure' })
  })

  it('bounds a stalled child and terminates its process group', async () => {
    const { root } = ownerFixture()
    const pidFile = join(root, 'child.pid')
    const started = Date.now()
    await expect(runManagedChild(process.execPath, ['-e', `
      require('node:fs').writeFileSync(process.argv[1], String(process.pid));
      setInterval(() => {}, 1000);
    `, pidFile], { cwd: process.cwd(), env: process.env, timeoutMs: 1000 })).rejects.toThrow('timeout=true')
    expect(Date.now() - started).toBeLessThan(7000)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(() => process.kill(pid, 0)).toThrow()
  })

  it('does not start a command after cancellation and bounds excessive output', async () => {
    const abort = new AbortController(); abort.abort()
    await expect(runManagedChild(process.execPath, ['-e', 'process.exit(0)'], {
      cwd: process.cwd(), env: process.env, timeoutMs: 3000, signal: abort.signal,
    })).rejects.toThrow('aborted before start')
    await expect(runManagedChild(process.execPath, ['-e', "process.stdout.write('x'.repeat(100000))"], {
      cwd: process.cwd(), env: process.env, timeoutMs: 3000, maxBytes: 1024,
    })).rejects.toThrow('overflow=true')
  })

  it('waits for a surviving grandchild to stop before reporting a failed command', async () => {
    const { root } = ownerFixture()
    const pidFile = join(root, 'grandchild.pid')
    let stopped: boolean | undefined
    const program = `
      const child = require('node:child_process').spawn(process.execPath, ['-e',
        "process.on('SIGTERM',()=>{}); process.on('disconnect',()=>{}); process.send('ready'); setInterval(()=>{},1000)"
      ], {stdio:['ignore','ignore','ignore','ipc']});
      child.once('message', () => {
        require('node:fs').writeFileSync(process.argv[1],String(child.pid)); process.exit(7);
      });
    `
    await expect(runManagedChild(process.execPath, ['-e', program, pidFile], {
      cwd: process.cwd(), env: process.env, timeoutMs: 3000,
      onFailure: result => { stopped = result.groupStopped },
    })).rejects.toThrow('code=7')
    expect(stopped).toBe(true)
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow()
  }, 10000)

  it('retains useful private failure detail while removing session and credential values', () => {
    const session = ['agent', 'fixture', 'session'].join(':')
    const token = 'a'.repeat(64)
    const result = sanitizeMaintenanceFailure({ code: 1, stderr: `stage failed ${session} ${token} Bearer ${'z'.repeat(40)}` }, session)
    expect(result.stderr).toContain('stage failed')
    expect(result.stderr).not.toContain(session)
    expect(result.stderr).not.toContain(token)
    expect(result.stderr).not.toContain('z'.repeat(40))
  })

  it('accepts only the fixed deployment family and rejects arbitrary command plans', () => {
    const home = userInfo().homedir; const commit = 'a'.repeat(40)
    const releasesRoot = join(home, 'ai-worker/services/video-autoworker-app/releases')
    const plan = { schema: 'video-autoworker-legacy-release-plan/v1', sourceCommit: commit,
      controlRoot: join(home, 'ai-worker/state/video-autoworker/maint/fixture'), releasesRoot,
      releaseId: `${commit}-runtime`, releaseRoot: join(releasesRoot, `${commit}-runtime/standalone`),
      runDir: join(home, 'ai-worker/state/video-autoworker/blue-green'),
      missionDb: join(home, '.mission-control-openclaw-profiles/mission-control.db'),
      n8nDb: join(home, 'ai-worker/state/n8n/.n8n/database.sqlite'),
      transitionRoot: join(home, 'ai-worker/state/video-autoworker/maint/transition'), legacyPid: 1, sessionKeySha256: 'b'.repeat(64),
    }
    expect(validateLegacyReleasePlan(plan)).toEqual(plan)
    expect(() => validateLegacyReleasePlan({ ...plan, command: 'arbitrary' })).toThrow('plan contract')
    expect(() => validateLegacyReleasePlan({ ...plan, missionDb: '/tmp/other.db' })).toThrow('production family')
  })

  it('closes ingress but preserves the recovery hold after authorized shutdown or pending bootstrap', async () => {
    for (const scenario of [{ pending: true, mode: 'dual' }, { pending: false, mode: 'recovery-hold' }]) {
      const events: string[] = []
      const result = await settleFailedMaintenance({
        stopGateway: async () => { events.push('stop-gateway') },
        gatewayStopped: async () => true,
        guardPresent: () => true,
        recoveryPending: () => scenario.pending,
        guardStatus: async () => ({ mode: scenario.mode }),
        revokeGuard: async () => { events.push('revoke') },
      })
      expect(result).toEqual({ gatewayStopped: true, guard: 'held' })
      expect(events).toEqual(['stop-gateway'])
    }
    const events: string[] = []
    const result = await settleFailedMaintenance({
      stopGateway: async () => { events.push('stop-gateway') }, gatewayStopped: async () => true,
      guardPresent: () => true, recoveryPending: () => false, guardStatus: async () => ({ mode: 'dual' }),
      revokeGuard: async () => { events.push('revoke') },
    })
    expect(result.guard).toBe('released')
    expect(events).toEqual(['stop-gateway', 'revoke'])
  })
})
