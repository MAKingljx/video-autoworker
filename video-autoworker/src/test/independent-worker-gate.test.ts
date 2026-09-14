// @vitest-environment node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
const servers: http.Server[] = []
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const targetCommit = 'a'.repeat(40)
const contentSha = 'b'.repeat(64)
const contractSha = 'c'.repeat(64)

function verifierSource() {
  const source = readFileSync(resolve('scripts/deploy-blue-green.sh'), 'utf8')
  const start = source.indexOf('check_json_endpoint() {')
  const opening = source.indexOf("<<'NODE'\n", start)
  const closing = source.indexOf('\nNODE\n}', opening)
  if (start < 0 || opening < start || closing < opening) throw new Error('endpoint_verifier_heredoc_not_found')
  return source.slice(opening + "<<'NODE'\n".length, closing)
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/worker-gate-')); roots.push(root)
  const databasePath = join(root, 'database.db')
  const db = new Database(databasePath)
  db.exec('CREATE TABLE gate_fixture (value INTEGER)'); db.close()
  const info = lstatSync(databasePath)
  const database = { dev: String(info.dev), ino: String(info.ino), pathSha256: hash(databasePath) }
  const manifest = join(root, 'worker-manifest.json')
  const manifestSource = JSON.stringify({ schema: 'video-autoworker-scheduler-artifact/v1', contentSha256: contentSha })
  writeFileSync(manifest, manifestSource, { mode: 0o600 })
  const statePath = join(root, 'router-state.json')
  const router = { active: 'green', generation: 8, slots: { green: { releaseId: 'old-release' } } }
  writeFileSync(statePath, JSON.stringify(router), { mode: 0o600 })
  mkdirSync(join(root, 'slots'), { mode: 0o700 })
  writeFileSync(join(root, 'slots/green.runtime.json'), JSON.stringify({
    pid: process.pid, releaseId: 'old-release', dbPath: databasePath,
  }), { mode: 0o600 })
  const now = Math.floor(Date.now() / 1000)
  const webLeadership = { state: 'inactive', reason: 'web_scheduler_disabled', activeJobs: 0,
    leaseExpiresAt: null, leaseExpired: false, routerGeneration: null, observedAt: now }
  const worker = { schema: 'video-autoworker-scheduler-worker/v1', executionMode: 'external-worker',
    observedAt: Date.now(), healthy: true, leaseVerified: true, currentState: 'ready',
    leadership: { state: 'leader', reason: 'worker_ready', leaseExpired: false, leaseExpiresAt: now + 60 },
    worker: { pid: process.pid, contentSha256: contentSha, database }, webLeadership,
    handoff: { migrationPending: false, operationId: 'fixture-handoff', targetApplicationCommit: targetCommit,
      previous: { slot: 'green', routerGeneration: 8, releaseId: 'old-release', pid: process.pid } },
  }
  let payload: unknown = worker
  const server = http.createServer((request, response) => {
    if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify(payload))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const env: NodeJS.ProcessEnv = {
    // Never copy the caller's environment: failed test diagnostics must not contain credentials.
    NODE_ENV: 'test', PATH: dirname(process.execPath),
    AIWORKER_BG_REQUEST_TIMEOUT_MS: '3000',
    AIWORKER_BG_EXPECTED_DB: databasePath, AIWORKER_BG_EXPECTED_ROUTER: statePath,
    AIWORKER_BG_EXPECTED_WORKER_SHA: contentSha, AIWORKER_BG_EXPECTED_WORKER_PID: String(process.pid),
    AIWORKER_BG_EXPECTED_WORKER_MANIFEST: manifest, AIWORKER_BG_EXPECTED_WORKER_MANIFEST_SHA: hash(manifestSource),
    AIWORKER_BG_WORKER_HANDOFF_OPERATION: 'fixture-handoff', AIWORKER_BG_WORKER_TARGET_COMMIT: targetCommit,
  }
  const verify = async (mode: string, value: unknown, expected = ['8']) => {
    payload = value
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveResult, reject) => {
      const child = spawn(process.execPath, ['-', mode, `http://127.0.0.1:${port}/probe`, ...expected], {
        env, stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stdout = ''; let stderr = ''
      const timeout = setTimeout(() => child.kill('SIGKILL'), 6000)
      child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.length > 65_536) child.kill('SIGKILL') })
      child.stderr.on('data', chunk => { stderr += chunk.toString(); if (stderr.length > 65_536) child.kill('SIGKILL') })
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('close', code => { clearTimeout(timeout); resolveResult({ code, stdout, stderr }) })
      child.stdin.end(verifierSource())
    })
  }
  const pending = () => ({ ...structuredClone(worker), healthy: false, leaseVerified: false,
    currentState: 'waiting', leadership: { ...worker.leadership, state: 'follower' },
    handoff: { ...worker.handoff, migrationPending: true } })
  const readiness = (value: unknown) => ({ readiness: {
    schema: 'video-autoworker-release-readiness/v1', globalScope: true, observedAt: now,
    intake: { schema: 'video-autoworker-intake-control/v1', accepting: false, mode: 'paused', revision: 3,
      counts: { queued: 0, accepted: 0, running: 0, waiting: 0, active: 0 } },
    runtime: { callbackProtocol: 'slot-v1', runtimeSlot: 'blue', runtimeReleaseId: `${targetCommit}-runtime`, port: 3018 },
    database: { schemaEpoch: 1, rollingSafeFrom: 'fixture', latestMigration: 'fixture' },
    projection: { schema: 'video-autoworker-director-evidence-outbox-readiness/v1', contractDigest: contractSha,
      pending: 0, incompatiblePending: 0 },
    retirement: { counts: { tracked: 0, active: 0, queued: 0, accepted: 0, running: 0, topLevel: 0,
      mediaNodes: 0, modelNodes: 0, childExecutionLeases: 0, untrackedCallbacks: 0, otherReleaseActive: 0 } },
    scheduler: webLeadership, worker: value,
  } })
  const expectedReadiness = ['blue', `${targetCommit}-runtime`, '3018', '3', '1', '8', contractSha]
  return { root, worker, env, manifest, router, statePath, verify, pending, readiness, expectedReadiness }
}

describe('independent worker gates in the actual deployment verifier', () => {
  it('accepts the live leader only with the sealed database, content, PID and manifest', async () => {
    const f = await fixture()
    const result = await f.verify('leader', f.worker)
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ schedulerState: 'leader', schedulerRouterGeneration: 8 })
  })

  it('rejects same-database workers with changed content or PID and rejects manifest drift', async () => {
    const f = await fixture()
    for (const changed of [{ contentSha256: 'd'.repeat(64) }, { pid: process.pid + 1 }]) {
      const result = await f.verify('leader', { ...f.worker, worker: { ...f.worker.worker, ...changed } })
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('independent worker verification failed')
    }
    writeFileSync(f.manifest, 'changed bytes', { mode: 0o600 })
    expect((await f.verify('leader', f.worker)).code).toBe(1)
  })

  it('rejects a worker bound to a different database identity', async () => {
    const f = await fixture()
    const value = structuredClone(f.worker)
    value.worker.database.ino = `${value.worker.database.ino}0`
    expect((await f.verify('leader', value)).code).toBe(1)
  })

  it('accepts the pending follower for precommit readiness with an exact handoff and live previous PID', async () => {
    const f = await fixture()
    const result = await f.verify('readiness', f.readiness(f.pending()), f.expectedReadiness)
    expect(result.code, result.stderr).toBe(0)
    expect(result.stdout.trim().split('\n')).toEqual(['3', '1', contractSha, '0', '0', '0'])
  })

  it('rejects pending handoff ownership, target commit, previous runtime or router drift', async () => {
    const f = await fixture()
    for (const change of [{ operationId: 'other-operation' }, { targetApplicationCommit: 'd'.repeat(40) },
      { previous: { ...f.worker.handoff.previous, pid: process.pid + 1 } }]) {
      const pending = f.pending(); Object.assign(pending.handoff, change)
      expect((await f.verify('readiness', f.readiness(pending), f.expectedReadiness)).code).toBe(1)
    }
    writeFileSync(f.statePath, JSON.stringify({ ...f.router, generation: 9 }), { mode: 0o600 })
    expect((await f.verify('readiness', f.readiness(f.pending()), f.expectedReadiness)).code).toBe(1)
  })

  it('never accepts the pending follower at the final leader gate', async () => {
    const f = await fixture()
    const result = await f.verify('leader', f.pending())
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('independent worker verification failed')
  })

  it('requires the old Web scheduler to be inactive and empty even while the external worker is healthy', async () => {
    const f = await fixture()
    const valid = await f.verify('scheduler', f.worker)
    expect(valid.code, valid.stderr).toBe(0)
    expect(JSON.parse(valid.stdout).schedulerState).toBe('inactive')
    for (const changed of [{ state: 'leader' }, { activeJobs: 1 }, { leaseExpiresAt: Math.floor(Date.now() / 1000) + 60 }]) {
      const result = await f.verify('scheduler', { ...f.worker, webLeadership: { ...f.worker.webLeadership, ...changed } })
      expect(result.code).toBe(1)
    }
  })
})
