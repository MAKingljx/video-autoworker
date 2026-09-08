// @vitest-environment node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  main,
  publishCompletionAndRemovePending,
  validateCommittedState,
} from '../../ops/recovery/finalize-committed-bootstrap-successor.mjs'

const roots: string[] = []
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const sourceFinisher = resolve(process.cwd(), 'ops/recovery/finalize-committed-bootstrap-successor.mjs')

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const commit = 'd'.repeat(40)
  const historical = '3'.repeat(40)
  const releaseId = `${commit}-runtime`
  const releaseRoot = `/releases/${releaseId}/standalone`
  const manifestSha256 = 'a'.repeat(64)
  const plan = {
    schema: 'video-autoworker-legacy-bootstrap-sdk-successor-plan/v1',
    control: { commit: '5'.repeat(40) }, historical: { commit: historical },
    successorAttempt: '/attempt', target: { slot: 'blue', releaseId, releaseRoot },
    environment: { routerState: '/run/router-state.json' },
  }
  const receipt = {
    schema: 'video-autoworker-legacy-bootstrap-sdk-successor/v1', authorizationId: 'authorization',
    control: { sourceCommit: plan.control.commit },
    historical: {
      sourceCommit: historical, target: { releaseId: 'historical-target' },
      databases: { mission: { path: '/mission.db' }, n8n: { path: '/n8n.db' } },
    },
    compatibility: { compatibilitySha256: 'b'.repeat(64) },
    requestedTarget: { sourceCommit: commit, releaseId, releaseRoot, manifestSha256 },
  }
  const consumed = {
    schema: 'video-autoworker-legacy-bootstrap-sdk-successor-consumed/v1',
    authorizationId: receipt.authorizationId, compatibilitySha256: 'b'.repeat(64),
  }
  const mapping = {
    schema: 'video-autoworker-legacy-bootstrap-sdk-target-mapping/v1',
    authorization: {
      receipt: { path: '/attempt/sdk-successor.receipt.json' },
      consumed: { path: '/attempt/sdk-successor.consumed.json' },
    },
    requested: { releaseId, releaseRoot, manifestSha256 },
  }
  const pending = {
    schema: 'video-autoworker-blue-green-bootstrap-pending/v4', legacyReleaseId: 'legacy-live',
  }
  const baseline = {
    schema: 'video-autoworker-blue-green-baseline/v3', baselineSlot: 'blue',
    baselineReleaseId: releaseId, baselineReleaseRoot: releaseRoot, baselineManifestSha256: manifestSha256,
    baselineSourceCommit: commit, legacyReleaseId: 'legacy-live', dbPath: '/mission.db',
    n8nDbPath: '/n8n.db', n8nPid: 20, n8nWorkflowSourceCommit: historical,
    routerStatePath: '/run/router-state.json', routerPort: 3017,
  }
  const routerState = {
    schema: 'video-autoworker-standalone-router/v1', generation: 1, active: 'blue', previous: null,
    slots: { blue: { host: '127.0.0.1', port: 3317, releaseId } },
  }
  const binding = {
    schema: 'video-autoworker-standalone-slot/v1', slot: 'blue', releaseId, releaseRoot,
    manifestSha256, host: '127.0.0.1', port: 3317,
  }
  const runtime = {
    schema: 'video-autoworker-standalone-runtime/v1', slot: 'blue', role: 'active', releaseId,
    manifestSha256, host: '127.0.0.1', port: 3317, pid: 10,
    dbPath: '/mission.db', routerStatePath: '/run/router-state.json',
  }
  const intake = {
    schema: 'video-autoworker-intake-control/v1', globalScope: true, canManage: true,
    accepting: false, mode: 'paused', revision: 1,
    counts: { active: 0 },
  }
  const router = {
    schema: 'video-autoworker-standalone-router-health/v1', ok: true, active: 'blue',
    releaseId, generation: 1, pid: 11,
  }
  const readiness = { readiness: {
    schema: 'video-autoworker-release-readiness/v1', globalScope: true,
    runtime: { callbackProtocol: 'slot-v1', runtimeSlot: 'blue', runtimeReleaseId: releaseId, port: 3317 },
    intake,
    projection: {
      schema: 'video-autoworker-director-evidence-outbox-readiness/v1', incompatiblePending: 0,
    },
    scheduler: { routerGeneration: 1 },
  } }
  return {
    plan, receipt, consumed, mapping, pending, baseline, routerState, binding, runtime,
    router, readiness, intake,
  }
}

function writeJson(pathname: string, value: unknown, mode = 0o600) {
  mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 })
  writeFileSync(pathname, `${JSON.stringify(value)}\n`, { mode })
  chmodSync(pathname, mode)
}
function reference(pathname: string) {
  const entry = lstatSync(pathname, { bigint: true })
  return {
    path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString(),
    size: Number(entry.size), sha256: digest(readFileSync(pathname)),
  }
}
function commit(repository: string) {
  execFileSync('/usr/bin/git', ['init', '-q', repository])
  execFileSync('/usr/bin/git', ['-C', repository, 'add', '.'])
  execFileSync('/usr/bin/git', ['-C', repository, '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'])
  return execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

describe('committed bootstrap successor finisher', () => {
  it('accepts only the committed baseline with the same paused runtime identity', () => {
    const value = fixture()
    expect(validateCommittedState(value)).toMatchObject({
      pausedIntakeRevision: 1,
      target: { releaseId: value.plan.target.releaseId },
    })
    expect(() => validateCommittedState({
      ...value, intake: { ...value.intake, revision: 2 },
    })).toThrow('paused runtime readiness differs')
    expect(() => validateCommittedState({
      ...value, baseline: { ...value.baseline, baselineReleaseId: 'other' },
    })).toThrow('committed baseline differs')
    expect(() => validateCommittedState({
      ...value,
      baseline: { ...value.baseline, legacyReleaseId: value.receipt.historical.target.releaseId },
    })).toThrow('committed baseline differs')
  })

  it('replays a crash after immutable completion and removes only the same pending inode', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'committed-successor-finisher-')))
    roots.push(root)
    chmodSync(root, 0o700)
    const pendingPath = join(root, 'bootstrap.pending.json')
    const completionPath = join(root, 'recovery-completion.json')
    const pendingSource = `${JSON.stringify({ schema: 'pending' })}\n`
    writeFileSync(pendingPath, pendingSource, { mode: 0o400 })
    chmodSync(pendingPath, 0o400)
    const reference = () => {
      const entry = lstatSync(pendingPath, { bigint: true })
      return {
        path: pendingPath, dev: entry.dev.toString(), ino: entry.ino.toString(),
        size: Number(entry.size), sha256: digest(readFileSync(pendingPath)),
      }
    }
    const completion = {
      schema: 'video-autoworker-legacy-bootstrap-sdk-successor-baseline-established/v1',
      establishedAt: Date.now(), ok: true,
    }
    publishCompletionAndRemovePending({
      completionPath, pendingPath,
      pendingLoaded: { reference: reference() }, completion,
    })
    expect(existsSync(pendingPath)).toBe(false)
    expect(lstatSync(completionPath).mode & 0o777).toBe(0o400)

    writeFileSync(pendingPath, pendingSource, { mode: 0o400 })
    chmodSync(pendingPath, 0o400)
    publishCompletionAndRemovePending({
      completionPath, pendingPath,
      pendingLoaded: { reference: reference() },
      completion: { ...completion, establishedAt: completion.establishedAt + 1 },
    })
    expect(existsSync(pendingPath)).toBe(false)
  })

  it('runs the Git-bound verify-only entry before publishing the same completion', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'committed-successor-entry-')))
    roots.push(root)
    chmodSync(root, 0o700)
    const finisherRepository = join(root, 'finisher')
    const control = join(root, 'control')
    const historical = join(root, 'historical')
    for (const directory of [finisherRepository, control, historical]) mkdirSync(directory, { mode: 0o700 })
    const finisherPath = join(finisherRepository, 'ops/recovery/finalize-committed-bootstrap-successor.mjs')
    mkdirSync(dirname(finisherPath), { recursive: true, mode: 0o700 })
    copyFileSync(sourceFinisher, finisherPath)
    chmodSync(finisherPath, 0o755)
    const finisherCommit = commit(finisherRepository)

    const controlFiles = [
      ['ops/recovery/run-legacy-bootstrap-sdk-successor.mjs', '#!/usr/bin/env node\n', 0o755],
      ['scripts/legacy-bootstrap-sdk-successor-controller.mjs', '#!/usr/bin/env node\n', 0o755],
      ['scripts/verify-openclaw-runtime-compatibility.mjs', '// fixture\n', 0o644],
      ['scripts/verify-director-video-release-readiness.mjs', '// fixture\n', 0o644],
      ['scripts/lib/openclaw-runtime-contract.mjs', '// fixture\n', 0o644],
      ['ops/recovery/install-blue-green-execve-adapter.mjs',
        '#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({schema:"proof"})+"\\n")\n', 0o755],
    ] as const
    for (const [relativePath, source, mode] of controlFiles) {
      const pathname = join(control, relativePath)
      mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 })
      writeFileSync(pathname, source, { mode })
      chmodSync(pathname, mode)
    }
    const controlCommit = commit(control)
    for (const [relativePath, mode] of [
      ['scripts/legacy-bootstrap-controller.mjs', 0o755],
      ['scripts/legacy-freeze-guard.mjs', 0o644],
    ] as const) {
      const pathname = join(historical, relativePath)
      mkdirSync(dirname(pathname), { recursive: true, mode: 0o700 })
      writeFileSync(pathname, '// fixture\n', { mode })
      chmodSync(pathname, mode)
    }
    const historicalCommit = commit(historical)

    const attempt = join(root, 'attempt')
    const bootstrapAttempt = join(root, 'bootstrap', 'attempt')
    const runDir = join(root, 'run')
    const releaseId = `${'d'.repeat(40)}-runtime`
    const releaseRoot = join(root, 'releases', releaseId, 'standalone')
    for (const directory of [attempt, bootstrapAttempt, join(runDir, 'slots'), releaseRoot]) {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
    }
    const mission = join(root, 'mission.db')
    const n8n = join(root, 'n8n.db')
    writeFileSync(mission, 'mission', { mode: 0o600 })
    writeFileSync(n8n, 'n8n', { mode: 0o600 })
    const pendingPath = join(runDir, 'bootstrap.pending.json')
    const resumePath = join(root, 'resume.json')
    const resumeConsumedPath = join(root, 'resume-consumed.json')
    writeJson(resumePath, { schema: 'resume' }, 0o400)
    writeJson(resumeConsumedPath, { schema: 'resume-consumed' }, 0o400)
    writeJson(pendingPath, {
      schema: 'video-autoworker-blue-green-bootstrap-pending/v4', legacyReleaseId: 'legacy-live',
    }, 0o400)
    const compatibilityPath = join(attempt, 'openclaw-runtime-compatibility.json')
    writeJson(compatibilityPath, {
      compatibilitySha256: 'b'.repeat(64), source: { commit: controlCommit },
    })
    const execveProofPath = join(attempt, 'execve-adapter.json')
    writeJson(execveProofPath, { schema: 'proof' })
    const manifestSha256 = 'a'.repeat(64)
    writeJson(join(releaseRoot, 'release-manifest.json'), { fixture: true }, 0o644)
    const actualManifest = digest(readFileSync(join(releaseRoot, 'release-manifest.json')))
    const databaseIdentity = (pathname: string) => {
      const entry = lstatSync(pathname, { bigint: true })
      return { path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString() }
    }
    const receiptPath = join(attempt, 'sdk-successor.receipt.json')
    const receipt = {
      schema: 'video-autoworker-legacy-bootstrap-sdk-successor/v1',
      authorizationId: 'authorization', uid: process.getuid?.() ?? 0, issuedAt: 1, expiresAt: 100,
      nonceSha256: 'c'.repeat(64),
      control: {
        repository: control, sourceCommit: controlCommit,
        controller: reference(join(control, 'scripts/legacy-bootstrap-sdk-successor-controller.mjs')),
        compatibilityValidator: reference(join(control, 'scripts/verify-openclaw-runtime-compatibility.mjs')),
        readinessValidator: reference(join(control, 'scripts/verify-director-video-release-readiness.mjs')),
        runtimeContract: reference(join(control, 'scripts/lib/openclaw-runtime-contract.mjs')),
      },
      historical: {
        repository: historical, sourceCommit: historicalCommit, bootstrapAttempt,
        attemptId: '11111111-1111-4111-8111-111111111111', pending: reference(pendingPath),
        controller: reference(join(historical, 'scripts/legacy-bootstrap-controller.mjs')),
        guardController: reference(join(historical, 'scripts/legacy-freeze-guard.mjs')),
        resume: reference(resumePath), resumeConsumed: reference(resumeConsumedPath),
        target: { releaseId: 'historical-target' },
        databases: { mission: databaseIdentity(mission), n8n: databaseIdentity(n8n) },
      },
      compatibility: { compatibilitySha256: 'b'.repeat(64), reference: reference(compatibilityPath) },
      execveAdapter: { reference: reference(execveProofPath) },
      recoveryHold: { pid: 999_999 },
      requestedTarget: {
        sourceCommit: 'd'.repeat(40), releaseId, releaseRoot, manifestSha256: actualManifest,
      },
    }
    writeJson(receiptPath, receipt, 0o400)
    const readinessPath = join(attempt, 'current-readiness.json')
    writeJson(readinessPath, {
      schema: 'video-autoworker-director-video-preflight/v1', ok: true, phase: 'pre-bootstrap',
      commit: 'd'.repeat(40), app: { releaseId, root: releaseRoot, manifestSha256: actualManifest },
    })
    const consumedPath = join(attempt, 'sdk-successor.consumed.json')
    writeJson(consumedPath, {
      schema: 'video-autoworker-legacy-bootstrap-sdk-successor-consumed/v1',
      authorizationId: receipt.authorizationId, receipt: reference(receiptPath),
      compatibilitySha256: 'b'.repeat(64), consumedAt: 2,
      tokenSha256: 'e'.repeat(64), initialReadinessSha256: reference(readinessPath).sha256,
    }, 0o400)
    writeJson(join(attempt, 'target-mapping.json'), {
      schema: 'video-autoworker-legacy-bootstrap-sdk-target-mapping/v1',
      authorization: {
        receipt: { path: receiptPath, sha256: reference(receiptPath).sha256 },
        consumed: { path: consumedPath, sha256: reference(consumedPath).sha256 },
      },
      requested: { releaseId, releaseRoot, manifestSha256: actualManifest },
    }, 0o400)
    const routerState = {
      schema: 'video-autoworker-standalone-router/v1', generation: 1, active: 'blue', previous: null,
      slots: { blue: { host: '127.0.0.1', port: 3317, releaseId } },
    }
    const binding = {
      schema: 'video-autoworker-standalone-slot/v1', slot: 'blue', releaseId, releaseRoot,
      manifestSha256: actualManifest, host: '127.0.0.1', port: 3317,
    }
    const runtime = {
      schema: 'video-autoworker-standalone-runtime/v1', pid: 10, slot: 'blue', role: 'active',
      releaseId, manifestSha256: actualManifest, host: '127.0.0.1', port: 3317, dbPath: mission,
      routerStatePath: join(runDir, 'router-state.json'),
    }
    writeJson(join(runDir, 'router-state.json'), routerState)
    writeJson(join(runDir, 'slots/blue.json'), binding)
    writeJson(join(runDir, 'slots/blue.runtime.json'), runtime)
    writeJson(join(runDir, 'baseline.json'), {
      schema: 'video-autoworker-blue-green-baseline/v3', baselineSlot: 'blue',
      baselineReleaseId: releaseId, baselineReleaseRoot: releaseRoot,
      baselineManifestSha256: actualManifest, baselineSourceCommit: 'd'.repeat(40),
      legacyReleaseId: 'legacy-live', dbPath: mission, n8nDbPath: n8n,
      n8nPid: 20, n8nWorkflowSourceCommit: historicalCommit,
      routerStatePath: join(runDir, 'router-state.json'), routerPort: 3017,
    })
    const planPath = join(root, 'plan.json')
    writeJson(planPath, {
      schema: 'video-autoworker-legacy-bootstrap-sdk-successor-plan/v1',
      control: { repository: control, commit: controlCommit },
      historical: { repository: historical, commit: historicalCommit, bootstrapAttempt, pending: pendingPath },
      successorAttempt: attempt,
      target: { slot: 'blue', releaseId, releaseRoot, releasesRoot: join(root, 'releases') },
      environment: { runDir, routerState: join(runDir, 'router-state.json') },
      guard: { socket: join(root, 'guard.sock') },
      execve: { installation: join(root, 'installation.json'), launchAgentsDir: join(root, 'LaunchAgents') },
    })
    const intake = {
      schema: 'video-autoworker-intake-control/v1', globalScope: true, canManage: true,
      accepting: false, mode: 'paused', revision: 1, counts: { active: 0 },
    }
    const probes = {
      scriptPath: finisherPath,
      processAbsent: () => {}, processOwnsPath: () => {},
      listenerPids: (pid: number) => [String(pid)],
      getJson: async (url: string) => url.includes('__router') ? {
        schema: 'video-autoworker-standalone-router-health/v1', ok: true,
        pid: 11, active: 'blue', releaseId, generation: 1,
      } : url.includes('release-readiness') ? { readiness: {
        schema: 'video-autoworker-release-readiness/v1', globalScope: true,
        runtime: { callbackProtocol: 'slot-v1', runtimeSlot: 'blue', runtimeReleaseId: releaseId, port: 3317 },
        intake, projection: {
          schema: 'video-autoworker-director-evidence-outbox-readiness/v1', incompatiblePending: 0,
        }, scheduler: { routerGeneration: 1 },
      } } : { control: intake },
    }
    const args = ['--plan', planPath, '--finisher-repository', finisherRepository,
      '--finisher-commit', finisherCommit]
    await main(['--verify-only', ...args], probes)
    expect(existsSync(join(attempt, 'recovery-completion.json'))).toBe(false)
    expect(existsSync(pendingPath)).toBe(true)
    const readinessSource = readFileSync(readinessPath)
    writeJson(readinessPath, { schema: 'changed-after-consume' })
    await expect(main(['--apply', ...args], probes)).rejects.toThrow(
      'stored release readiness differs',
    )
    writeFileSync(readinessPath, readinessSource, { mode: 0o600 })
    chmodSync(readinessPath, 0o600)
    await main(['--apply', ...args], probes)
    expect(existsSync(join(attempt, 'recovery-completion.json'))).toBe(true)
    expect(existsSync(pendingPath)).toBe(false)
  })
})
