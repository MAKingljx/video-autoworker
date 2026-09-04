// @vitest-environment node

import { execFile, execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import { connect, createServer as createNetServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

// The production entrypoint is plain ESM JavaScript so it can run without a
// package install. Vitest loads that exact file to exercise the real router.
import {
  createStandaloneRouter,
  writeRouterRuntimeAttestationAtomic,
  writeRouterStateAtomic,
} from '../../scripts/standalone-router.mjs'

type RunningServer = { server: HttpServer; port: number }
const cleanup: Array<() => void> = []
const execFileAsync = promisify(execFile)

function cleanDeployScriptFixture(root: string): string {
  const repository = join(root, 'repository')
  mkdirSync(repository, { mode: 0o700 })
  cpSync(resolve(process.cwd(), 'scripts'), join(repository, 'scripts'), { recursive: true })
  mkdirSync(join(repository, 'ops', 'n8n'), { recursive: true, mode: 0o700 })
  cpSync(
    resolve(process.cwd(), 'ops/n8n/workflows'),
    join(repository, 'ops/n8n/workflows'),
    { recursive: true },
  )
  execFileSync('git', ['init', '-b', 'main'], { cwd: repository, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Blue Green Test'], { cwd: repository })
  execFileSync('git', ['config', 'user.email', 'blue-green-test@example.invalid'], { cwd: repository })
  execFileSync('git', ['add', '--', 'scripts', 'ops/n8n/workflows'], { cwd: repository })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repository, stdio: 'ignore' })
  return join(repository, 'scripts/deploy-blue-green.sh')
}

async function listen(server: HttpServer): Promise<RunningServer> {
  const sockets = new Set<Socket>()
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind TCP')
  cleanup.push(() => {
    server.closeIdleConnections?.()
    server.closeAllConnections?.()
    for (const socket of sockets) socket.destroy()
    server.close()
  })
  return { server, port: address.port }
}

function backend(name: string): HttpServer {
  const server = createServer((request, response) => {
    if (request.url === '/slow') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`${name}-start\n`)
      setTimeout(() => response.end(`${name}-end\n`), 120)
      return
    }
    response.end(`${name}:${request.url}`)
  })
  server.on('upgrade', (request, socket) => {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: test',
      '',
      `${name}\n`,
    ].join('\r\n'))
    socket.on('data', data => socket.write(`${name}:${data.toString()}`))
  })
  return server
}

type RouterTestState = {
  schema: string
  generation: number
  active: 'blue' | 'green'
  previous: 'blue' | 'green' | null
  updatedAt: string
  slots: Record<'blue' | 'green', { host: string; port: number; releaseId: string }>
}

function state(
  bluePort: number,
  greenPort: number,
  active: 'blue' | 'green' = 'blue',
): RouterTestState {
  return {
    schema: 'video-autoworker-standalone-router/v1',
    generation: 1,
    active,
    previous: null,
    updatedAt: new Date().toISOString(),
    slots: {
      blue: { host: '127.0.0.1', port: bluePort, releaseId: 'release-blue' },
      green: { host: '127.0.0.1', port: greenPort, releaseId: 'release-green' },
    },
  }
}

function releaseReadinessPayload(
  schedulerState: 'leader' | 'follower' | 'inactive' | 'unknown' | 'unavailable',
  generation = 7,
): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1_000)
  const runtime = {
    callbackProtocol: 'slot-v1',
    runtimeSlot: 'blue',
    runtimeReleaseId: 'release-blue',
    port: 43317,
    startedAt: now - 30,
  }
  return {
    readiness: {
      schema: 'video-autoworker-release-readiness/v1',
      globalScope: true,
      observedAt: now,
      intake: {
        schema: 'video-autoworker-intake-control/v1',
        accepting: false,
        mode: 'paused',
        revision: 3,
        counts: { queued: 0, accepted: 0, running: 0, waiting: 0, active: 0 },
      },
      runtime,
      database: {
        schemaEpoch: 1,
        rollingSafeFrom: '052_n8n_intake_controls',
        latestMigration: '059_director_evidence_projection_receipts',
      },
      projection: {
        schema: 'video-autoworker-director-evidence-outbox-readiness/v1',
        contractDigest: 'a'.repeat(64),
        pending: 0,
        incompatiblePending: 0,
      },
      retirement: {
        counts: {
          tracked: 0,
          active: 0,
          queued: 0,
          accepted: 0,
          running: 0,
          topLevel: 0,
          mediaNodes: 0,
          modelNodes: 0,
          childExecutionLeases: 0,
          untrackedCallbacks: 0,
          otherReleaseActive: 0,
        },
      },
      scheduler: {
        state: schedulerState,
        leaseExpiresAt: schedulerState === 'leader' || schedulerState === 'follower'
          ? now + 30
          : null,
        leaseExpired: false,
        observedAt: now,
        reason: schedulerState === 'leader' ? 'slot_active' : 'lease_held_by_other',
        routerGeneration: generation,
        activeJobs: 0,
      },
    },
  }
}

function schedulerPayload(state: 'leader' | 'follower', generation = 7): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1_000)
  return {
    leadership: {
      state,
      leaseExpiresAt: now + 30,
      leaseExpired: false,
      observedAt: now,
      reason: state === 'leader' ? 'slot_active' : 'lease_held_by_other',
      routerGeneration: generation,
      activeJobs: 0,
    },
  }
}

function upgrade(port: number): Promise<{ socket: Socket; received: () => string }> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(port, '127.0.0.1')
    let body = ''
    socket.once('error', reject)
    socket.once('connect', () => {
      socket.write([
        'GET /socket HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: test',
        '',
        '',
      ].join('\r\n'))
    })
    socket.on('data', data => {
      body += data.toString()
      if (body.includes('\r\n\r\n') && body.includes('\n')) {
        resolvePromise({ socket, received: () => body })
      }
    })
  })
}

afterEach(() => {
  while (cleanup.length) cleanup.pop()?.()
})

describe('standalone blue-green router', () => {
  it('keeps the first migration runbook complete and ordered', () => {
    const document = readFileSync(
      resolve(process.cwd(), 'docs/n8n-production-deployment.md'),
      'utf8',
    )
    const start = document.indexOf('#### 逐命令 runbook（首次迁移）')
    const end = document.indexOf('\n从旧单进程 3017 首次迁入 slot-v1', start)
    expect(start).toBeGreaterThan(0)
    expect(end).toBeGreaterThan(start)
    const runbook = document.slice(start, end)
    const anchors = [
      'n8n-backup-managed-workflows.mjs" backup',
      'n8n-stop.sh"',
      'n8n-import-workflows.sh"',
      'n8n-start.sh"',
      'verify-n8n-blue-green-workflows.mjs"',
      'attest-transition',
      'legacy-bootstrap-controller.mjs prepare',
      'legacy-bootstrap-controller.mjs current-confirm',
      'legacy-bootstrap-controller.mjs apply',
      'deploy-blue-green.sh bootstrap',
    ]
    let previous = -1
    for (const anchor of anchors) {
      const current = runbook.indexOf(anchor)
      expect(current, `missing or unordered runbook anchor: ${anchor}`).toBeGreaterThan(previous)
      previous = current
    }
    expect(runbook).toContain('安装器本身不在整个 plist `bootout/bootstrap` 事务期间直接持 maintenance lock')
    expect(runbook).toContain('n8n-start.sh --foreground')
    expect(runbook).toContain('**常规回滚**')
    expect(runbook).toContain('**transition rollback**')
    expect(runbook).toContain('**disaster recovery**')
    expect(runbook).toContain('AIWORKER_OPENCLAW_RUNTIME_CONVERGENCE_PROOF')
    expect(runbook).toContain('第一阶段 `pre-bootstrap`')
    expect(runbook).toContain('第二阶段 `full`')
  })

  it('durably publishes JSON state before exposing the atomic rename', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-durable-json-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const deployScript = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const writerBody = deployScript.slice(
      deployScript.indexOf('write_json_atomic()'),
      deployScript.indexOf('write_router_state_atomic()'),
    )
    expect(writerBody.indexOf('fs.fsyncSync(descriptor)'))
      .toBeLessThan(writerBody.indexOf('fs.renameSync(temporary, destination)'))
    expect(writerBody.indexOf('fs.renameSync(temporary, destination)'))
      .toBeLessThan(writerBody.lastIndexOf('fs.fsyncSync(parent)'))
    const functionPrelude = deployScript.slice(0, deployScript.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'durable-writer.sh')
    writeFileSync(harness, `${functionPrelude}
write_json_atomic "$1" "$2"
`, { mode: 0o700 })
    chmodSync(harness, 0o700)
    const destination = join(root, 'baseline.json')
    for (const generation of [1, 2]) {
      const result = spawnSync('/bin/bash', [harness, destination, JSON.stringify({ generation })], {
        encoding: 'utf8',
        env: { ...process.env, NODE_BIN: process.execPath },
      })
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(readFileSync(destination, 'utf8'))).toEqual({ generation })
      expect(statSync(destination).mode & 0o777).toBe(0o600)
    }
  })

  it('durably finalizes a matching pending marker after a baseline-write crash and rejects an unknown router', async () => {
    const makeFixture = () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-bootstrap-finalize-')))
      cleanup.push(() => rmSync(root, { recursive: true, force: true }))
      const runDir = join(root, 'run')
      const slotsDir = join(runDir, 'slots')
      const attempt = join(root, 'attempt')
      const releaseId = `${'a'.repeat(40)}-runtime`
      const releaseRoot = join(root, 'releases', releaseId, 'standalone')
      const statePath = join(runDir, 'router-state.json')
      const evidence = join(root, 'evidence.json')
      const proof = join(root, 'proof.json')
      const manifest = 'b'.repeat(64)
      const sourceCommit = 'a'.repeat(40)
      const evidenceSource = `${JSON.stringify({
        schema: 'video-autoworker-legacy-freeze-evidence/v3',
        frozen: { socket: { path: join(root, 'guard.sock') } },
      })}\n`
      mkdirSync(slotsDir, { recursive: true, mode: 0o700 })
      mkdirSync(attempt, { mode: 0o700 })
      mkdirSync(releaseRoot, { recursive: true, mode: 0o700 })
      writeFileSync(statePath, '{}\n', { mode: 0o600 })
      writeFileSync(evidence, evidenceSource, { mode: 0o600 })
      chmodSync(evidence, 0o600)
      const pending = {
        schema: 'video-autoworker-blue-green-bootstrap-pending/v4',
        slot: 'blue', releaseId, releaseRoot, manifestSha256: manifest,
        legacyReleaseId: 'legacy-runtime', legacyPid: 123,
        evidence: {
          path: evidence,
          sha256: createHash('sha256').update(evidenceSource).digest('hex'),
        },
        proof: { path: proof },
        authorization: { prepare: { path: join(attempt, 'prepare.receipt.json') } },
        databases: { mission: { path: join(root, 'mission.db') } },
        router: { statePath, port: 3017 },
        n8n: {
          pid: 456, dbPath: join(root, 'n8n.sqlite'),
          workflowSourceCommit: sourceCommit,
          workflowProtocol: 'slot-v1-execution-owner-v1',
          workflowDigest: 'd'.repeat(64),
        },
        baselineSourceCommit: sourceCommit,
      }
      const baseline = {
        schema: 'video-autoworker-blue-green-baseline/v3',
        baselineSlot: 'blue', baselineReleaseId: releaseId,
        baselineReleaseRoot: releaseRoot, baselineManifestSha256: manifest,
        legacyReleaseId: pending.legacyReleaseId, legacyPid: pending.legacyPid,
        evidenceSha256: pending.evidence.sha256,
        dbPath: pending.databases.mission.path,
        routerStatePath: statePath, routerPort: 3017,
        n8nPid: pending.n8n.pid, n8nDbPath: pending.n8n.dbPath,
        baselineSourceCommit: sourceCommit,
        n8nWorkflowSourceCommit: sourceCommit,
        n8nWorkflowProtocol: pending.n8n.workflowProtocol,
        n8nWorkflowDigest: pending.n8n.workflowDigest,
        completedAt: 1,
      }
      writeFileSync(join(runDir, 'baseline.json'), `${JSON.stringify(baseline)}\n`, { mode: 0o600 })
      const pendingPath = join(runDir, 'bootstrap.pending.json')
      writeFileSync(pendingPath, `${JSON.stringify(pending)}\n`, { mode: 0o400 })
      chmodSync(pendingPath, 0o400)
      writeFileSync(join(slotsDir, 'blue.json'), `${JSON.stringify({
        schema: 'video-autoworker-standalone-slot/v1', slot: 'blue',
        releaseId, releaseRoot, manifestSha256: manifest,
        host: '127.0.0.1', port: 3317,
      })}\n`, { mode: 0o600 })
      const manager = join(root, 'manage-blue-green-services.sh')
      writeFileSync(manager, '#!/bin/bash\nexit 0\n', { mode: 0o700 })
      chmodSync(manager, 0o700)
      const deployScript = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
      const functionPrelude = deployScript.slice(0, deployScript.indexOf('\ncommand="${1:-}"'))
      const harness = join(root, 'deploy-blue-green.sh')
      writeFileSync(harness, `${functionPrelude}
PROJECT_ROOT="$SCRIPT_DIR"
acquire_lock() { :; }
validate_state() { :; }
assert_baseline() { printf '%s\\n' legacy-runtime ${releaseId} ${releaseRoot} ${manifest}; }
assert_release() { printf '%s\\n' "$2"; }
release_manifest_sha() { printf '${manifest}\\n'; }
kill() { return 0; }
lsof() { printf 'n${pending.n8n.dbPath}\\n'; }
check_legacy_databases_quiescent() { :; }
check_n8n_workflow_compatibility() {
  printf '%s\\n' '{"combinedSha256":"${pending.n8n.workflowDigest}"}'
}
read_state_field() {
  case "$1" in active) printf 'blue\\n' ;; generation) printf '1\\n' ;; previous) printf '\\n' ;; esac
}
read_state_slot_release() { printf '${releaseId}\\n'; }
assert_router_identity() { [[ "\${FAIL_ROUTER_IDENTITY:-0}" != 1 ]]; }
bootstrap_baseline "$@"
`, { mode: 0o700 })
      chmodSync(harness, 0o700)
      return { root, runDir, attempt, releaseId, releaseRoot, evidence, proof, pendingPath, harness }
    }

    const prepareGuard = async (fixture: ReturnType<typeof makeFixture>, mode: 'active' | 'stale') => {
      const socketPath = join(fixture.root, 'guard.sock')
      const tokenPath = join(fixture.root, 'guard.token')
      const actionLog = join(fixture.root, 'guard-actions.log')
      const scriptsDir = join(fixture.root, 'scripts')
      mkdirSync(scriptsDir, { mode: 0o700 })
      const guardStub = join(scriptsDir, 'legacy-freeze-guard.mjs')
      writeFileSync(guardStub, `#!/usr/bin/env node
import { appendFileSync, existsSync, unlinkSync } from 'node:fs'
const command = process.argv[2]
const value = name => process.argv[process.argv.indexOf(name) + 1]
appendFileSync(${JSON.stringify(actionLog)}, \`\${command}\\n\`)
if (command === 'status') process.exit(${mode === 'active' ? 0 : 1})
if (!['revoke', 'recover-stale'].includes(command)) process.exit(2)
for (const pathname of [value('--socket'), value('--token-file')]) {
  if (existsSync(pathname)) unlinkSync(pathname)
}
`, { mode: 0o700 })
      chmodSync(guardStub, 0o700)
      writeFileSync(tokenPath, 'test-token\n', { mode: 0o600 })
      chmodSync(tokenPath, 0o600)
      const server = createNetServer()
      await new Promise<void>((resolvePromise, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolvePromise)
      })
      cleanup.push(() => server.close())
      chmodSync(socketPath, 0o600)
      return actionLog
    }

    const completed = makeFixture()
    const env = {
      ...process.env,
      NODE_BIN: process.execPath,
      AIWORKER_BG_RUN_DIR: completed.runDir,
      AIWORKER_BG_ROUTER_STATE: join(completed.runDir, 'router-state.json'),
    }
    const finalized = spawnSync('/bin/bash', [
      completed.harness, 'blue', completed.releaseId, completed.releaseRoot,
      completed.evidence, completed.proof, completed.attempt,
    ], { encoding: 'utf8', env })
    expect(finalized.status, finalized.stderr).toBe(0)
    expect(finalized.stdout).toContain('Finalized previously completed')
    expect(existsSync(completed.pendingPath)).toBe(false)

    const activeGuard = makeFixture()
    const activeActionLog = await prepareGuard(activeGuard, 'active')
    const activeFinalized = spawnSync('/bin/bash', [
      activeGuard.harness, 'blue', activeGuard.releaseId, activeGuard.releaseRoot,
      activeGuard.evidence, activeGuard.proof, activeGuard.attempt,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_BIN: process.execPath,
        AIWORKER_BG_RUN_DIR: activeGuard.runDir,
        AIWORKER_BG_ROUTER_STATE: join(activeGuard.runDir, 'router-state.json'),
      },
    })
    expect(activeFinalized.status, activeFinalized.stderr).toBe(0)
    expect(readFileSync(activeActionLog, 'utf8')).toBe('status\nrevoke\n')
    expect(existsSync(activeGuard.pendingPath)).toBe(false)

    const staleGuard = makeFixture()
    const staleActionLog = await prepareGuard(staleGuard, 'stale')
    const staleFinalized = spawnSync('/bin/bash', [
      staleGuard.harness, 'blue', staleGuard.releaseId, staleGuard.releaseRoot,
      staleGuard.evidence, staleGuard.proof, staleGuard.attempt,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_BIN: process.execPath,
        AIWORKER_BG_RUN_DIR: staleGuard.runDir,
        AIWORKER_BG_ROUTER_STATE: join(staleGuard.runDir, 'router-state.json'),
      },
    })
    expect(staleFinalized.status, staleFinalized.stderr).toBe(0)
    expect(readFileSync(staleActionLog, 'utf8')).toBe('status\nrecover-stale\n')
    expect(existsSync(staleGuard.pendingPath)).toBe(false)

    const unknownRouter = makeFixture()
    const refused = spawnSync('/bin/bash', [
      unknownRouter.harness, 'blue', unknownRouter.releaseId, unknownRouter.releaseRoot,
      unknownRouter.evidence, unknownRouter.proof, unknownRouter.attempt,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_BIN: process.execPath,
        AIWORKER_BG_RUN_DIR: unknownRouter.runDir,
        AIWORKER_BG_ROUTER_STATE: join(unknownRouter.runDir, 'router-state.json'),
        FAIL_ROUTER_IDENTITY: '1',
      },
    })
    expect(refused.status).not.toBe(0)
    expect(existsSync(unknownRouter.pendingPath)).toBe(true)
  })

  it('blocks every mutating command during bootstrap recovery while status remains readable', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'blue-green-recovery-gate.')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const runDir = join(root, 'run')
    const releasesDir = join(root, 'releases')
    mkdirSync(runDir, { mode: 0o700 })
    mkdirSync(releasesDir, { mode: 0o700 })
    const pendingPath = join(runDir, 'bootstrap.pending.json')
    writeFileSync(pendingPath, `${JSON.stringify({
      schema: 'video-autoworker-blue-green-bootstrap-pending/v4',
      slot: 'blue',
      releaseId: 'abcdef012345-runtime',
      legacyPid: 1200,
      n8n: { pid: 1300 },
    })}\n`, { mode: 0o400 })
    chmodSync(pendingPath, 0o400)
    const script = resolve(process.cwd(), 'scripts/deploy-blue-green.sh')
    const env = {
      ...process.env,
      AIWORKER_BG_RUN_DIR: runDir,
      AIWORKER_BG_RELEASES_DIR: releasesDir,
      NODE_BIN: process.execPath,
    }
    for (const command of ['init', 'stage', 'bind', 'retire', 'switch', 'rollback']) {
      const result = spawnSync('/bin/bash', [script, command], { encoding: 'utf8', env })
      expect(result.status, `${command}: ${result.stderr}`).not.toBe(0)
      expect(result.stderr).toContain('bootstrap recovery hold is active')
    }
    const incompleteBootstrap = spawnSync('/bin/bash', [script, 'bootstrap'], { encoding: 'utf8', env })
    expect(incompleteBootstrap.status).not.toBe(0)
    expect(incompleteBootstrap.stderr).toContain('bootstrap recovery requires the complete')
    const status = spawnSync('/bin/bash', [script, 'status'], { encoding: 'utf8', env })
    expect(status.status, status.stderr).toBe(0)
    expect(status.stdout).toContain('bootstrap=recovery-hold slot=blue release=abcdef012345-runtime')
  })

  it('routes new requests to the atomically selected slot while an SSE response drains on the old slot', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-router-http-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const blue = await listen(backend('blue'))
    const green = await listen(backend('green'))
    const stateFile = join(root, 'router-state.json')
    writeRouterStateAtomic(stateFile, state(blue.port, green.port))
    chmodSync(stateFile, 0o600)
    const router = await listen(createStandaloneRouter({ stateFile }))

    const slowResponse = await fetch(`http://127.0.0.1:${router.port}/slow`)
    const next = state(blue.port, green.port, 'green')
    next.generation = 2
    next.previous = 'blue'
    writeRouterStateAtomic(stateFile, next)

    await expect(fetch(`http://127.0.0.1:${router.port}/next`).then(result => result.text()))
      .resolves.toBe('green:/next')
    await expect(slowResponse.text()).resolves.toBe('blue-start\nblue-end\n')

    const health = await fetch(`http://127.0.0.1:${router.port}/__router/health`).then(result => result.json())
    expect(health).toMatchObject({
      schema: 'video-autoworker-standalone-router-health/v1',
      ok: true,
      pid: process.pid,
      active: 'green',
      previous: 'blue',
      generation: 2,
    })
  })

  it('keeps the router runtime attestation immutable across normal generation updates', () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-router-attestation-generation-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const stateFile = join(root, 'router-state.json')
    const attestationFile = join(root, 'router.runtime.json')
    writeRouterStateAtomic(stateFile, state(43317, 43417))
    writeRouterRuntimeAttestationAtomic(attestationFile, {
      schema: 'video-autoworker-standalone-router-runtime/v1',
      pid: process.pid,
      host: '127.0.0.1',
      port: 43017,
      stateFile,
      startedAt: Math.floor(Date.now() / 1_000),
    })
    const before = readFileSync(attestationFile)
    const beforeStats = statSync(attestationFile)

    const next = state(43317, 43417, 'green')
    next.generation = 2
    next.previous = 'blue'
    writeRouterStateAtomic(stateFile, next)

    const after = readFileSync(attestationFile)
    const afterStats = statSync(attestationFile)
    expect(createHash('sha256').update(after).digest('hex'))
      .toBe(createHash('sha256').update(before).digest('hex'))
    expect(afterStats.ino).toBe(beforeStats.ino)
    expect(afterStats.mtimeMs).toBe(beforeStats.mtimeMs)
  })

  it('keeps an upgraded socket pinned to its original slot after a switch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-router-upgrade-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const blue = await listen(backend('blue'))
    const green = await listen(backend('green'))
    const stateFile = join(root, 'router-state.json')
    writeRouterStateAtomic(stateFile, state(blue.port, green.port))
    const router = await listen(createStandaloneRouter({ stateFile }))

    const oldSocket = await upgrade(router.port)
    cleanup.push(() => oldSocket.socket.destroy())
    expect(oldSocket.received()).toContain('blue')

    const next = state(blue.port, green.port, 'green')
    next.generation = 2
    next.previous = 'blue'
    writeRouterStateAtomic(stateFile, next)
    oldSocket.socket.write('ping')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 30))
    expect(oldSocket.received()).toContain('blue:ping')

    const newSocket = await upgrade(router.port)
    cleanup.push(() => newSocket.socket.destroy())
    expect(newSocket.received()).toContain('green')
  })

  it('initializes a permission-restricted state file without touching application services', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-router-cli-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = cleanDeployScriptFixture(root)
    const runDir = join(root, 'run')
    const releasesDir = join(root, 'releases')

    execFileSync('bash', [script, 'init', 'blue'], {
      env: {
        ...process.env,
        AIWORKER_BG_RUN_DIR: runDir,
        AIWORKER_BG_RELEASES_DIR: releasesDir,
        AIWORKER_BG_ROUTER_PORT: '43017',
        AIWORKER_BG_BLUE_PORT: '43317',
        AIWORKER_BG_GREEN_PORT: '43417',
        NODE_BIN: process.execPath,
      },
    })

    const payload = JSON.parse(readFileSync(join(runDir, 'router-state.json'), 'utf8'))
    expect(payload).toMatchObject({
      schema: 'video-autoworker-standalone-router/v1',
      generation: 1,
      active: 'blue',
      slots: {
        blue: { host: '127.0.0.1', port: 43317 },
        green: { host: '127.0.0.1', port: 43417 },
      },
    })
  })

  it.each([
    ['self drift', 'scripts/deploy-blue-green.sh', false,
      'critical deployment source differs from Git HEAD: scripts/deploy-blue-green.sh'],
    ['dirty worktree', 'scripts/standalone-router.mjs', false,
      'deployment source worktree and index must be clean'],
    ['dirty index', 'scripts/standalone-router.mjs', true,
      'deployment source worktree and index must be clean'],
  ] as const)('fails closed before creating deployment state for %s', (_label, relative, staged, error) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-source-gate-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = cleanDeployScriptFixture(root)
    const repository = join(root, 'repository')
    const changed = join(repository, relative)
    writeFileSync(changed, `${readFileSync(changed, 'utf8')}\n# source gate drift\n`)
    if (staged) execFileSync('git', ['add', '--', relative], { cwd: repository })
    const runDir = join(root, 'run')

    const result = spawnSync('bash', [script, 'init', 'blue'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AIWORKER_BG_RUN_DIR: runDir,
        AIWORKER_BG_RELEASES_DIR: join(root, 'releases'),
        NODE_BIN: process.execPath,
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(error)
    expect(existsSync(runDir)).toBe(false)
  })

  it('rejects a symlinked deploy entrypoint before creating deployment state', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-source-path-gate-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = cleanDeployScriptFixture(root)
    const linked = join(root, 'deploy-blue-green.sh')
    const runDir = join(root, 'run')
    symlinkSync(script, linked)

    const result = spawnSync('bash', [linked, 'init', 'blue'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AIWORKER_BG_RUN_DIR: runDir,
        AIWORKER_BG_RELEASES_DIR: join(root, 'releases'),
        NODE_BIN: process.execPath,
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('deploy entrypoint must not be a symbolic link')
    expect(existsSync(runDir)).toBe(false)
  })

  it('recovers a sealed dead-owner lock through the deploy Shell bridge', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-stale-lock-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = cleanDeployScriptFixture(root)
    const runDir = join(root, 'run')
    const lockDir = join(runDir, '.deployment.lock')
    mkdirSync(lockDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(lockDir, 'pid'), `${JSON.stringify({
      schema: 'video-autoworker-shared-deployment-lock-owner/v2',
      pid: 2_147_483_647,
      nonce: 'a'.repeat(64),
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      processIdentitySha256: 'b'.repeat(64),
    })}\n`, { mode: 0o600 })

    const result = spawnSync('bash', [script, 'init', 'blue'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AIWORKER_BG_RUN_DIR: runDir,
        AIWORKER_BG_RELEASES_DIR: join(root, 'releases'),
        AIWORKER_BG_ROUTER_PORT: '43017',
        AIWORKER_BG_BLUE_PORT: '43317',
        AIWORKER_BG_GREEN_PORT: '43417',
        NODE_BIN: process.execPath,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(lockDir)).toBe(false)
    expect(existsSync(join(runDir, 'router-state.json'))).toBe(true)
  })

  it('refuses to start a slot whose recorded PID is still alive', () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-slot-live-pid-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const runDir = join(root, 'run')
    mkdirSync(join(runDir, 'slots'), { recursive: true })
    writeFileSync(join(runDir, 'slots', 'blue.json'), '{}\n', { mode: 0o600 })
    writeFileSync(join(runDir, 'slots', 'blue.pid'), `${process.pid}\n`, { mode: 0o600 })

    const result = spawnSync('bash', [resolve(process.cwd(), 'scripts/start-standalone-slot.sh'), 'blue', 'probe'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AIWORKER_BG_RUN_DIR: runDir,
        AIWORKER_BG_RELEASES_DIR: join(root, 'releases'),
        AIWORKER_PLATFORM_ENV_FILE: join(root, 'missing-platform.env'),
        NODE_BIN: process.execPath,
      },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('recorded PID')
    expect(readFileSync(join(runDir, 'slots', 'blue.pid'), 'utf8').trim()).toBe(String(process.pid))
  })

  it('refuses every sourced environment file when it is a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-slot-env-link-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const target = join(root, 'real.env')
    const linked = join(root, 'platform.env')
    writeFileSync(target, 'AUTH_PASS=not-a-real-secret\n', { mode: 0o600 })
    symlinkSync(target, linked)

    const result = spawnSync('bash', [resolve(process.cwd(), 'scripts/start-standalone-slot.sh'), 'green', 'probe'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AIWORKER_BG_RUN_DIR: join(root, 'run'),
        AIWORKER_BG_RELEASES_DIR: join(root, 'releases'),
        AIWORKER_PLATFORM_ENV_FILE: linked,
        NODE_BIN: process.execPath,
      },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('refusing unsafe environment file')
  })

  it('refuses a sourced environment file writable by the group', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-slot-env-mode-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const platformEnv = join(root, 'platform.env')
    writeFileSync(platformEnv, 'AUTH_PASS=not-a-real-secret\n', { mode: 0o620 })
    chmodSync(platformEnv, 0o620)

    const result = spawnSync('bash', [resolve(process.cwd(), 'scripts/start-standalone-slot.sh'), 'green', 'probe'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AIWORKER_BG_RUN_DIR: join(root, 'run'),
        AIWORKER_BG_RELEASES_DIR: join(root, 'releases'),
        AIWORKER_PLATFORM_ENV_FILE: platformEnv,
        NODE_BIN: process.execPath,
      },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('environment file must have mode 0600')
  })

  it('defaults slot material access to local Python while preserving explicit overrides', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-slot-material-env-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const launcher = readFileSync(resolve(process.cwd(), 'scripts/start-standalone-slot.sh'), 'utf8')
    const prefix = launcher.slice(0, launcher.indexOf('\nBINDING_FILE='))
    const harness = join(root, 'material-env-harness.sh')
    writeFileSync(harness, `${prefix}
printf '%s\\n' "$MC_OPENCLAW_PROFILE_TARGET" "$MC_MATERIALS_REMOTE_PYTHON"
`, { mode: 0o700 })
    chmodSync(harness, 0o700)

    const run = (overrides: Record<string, string | undefined> = {}) => spawnSync('/bin/bash', [harness, 'blue', 'probe'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        AIWORKER_PLATFORM_ENV_FILE: join(root, 'missing-platform.env'),
        MC_OPENCLAW_PROFILE_TARGET: '',
        MC_MATERIALS_REMOTE_PYTHON: '',
        ...overrides,
      },
    })

    const defaults = run()
    expect(defaults.status, defaults.stderr).toBe(0)
    expect(defaults.stdout.trim().split('\n')).toEqual(['local', '/usr/bin/python3'])

    const explicit = run({
      MC_OPENCLAW_PROFILE_TARGET: 'ssh',
      MC_MATERIALS_REMOTE_PYTHON: '/opt/custom/python3',
    })
    expect(explicit.status, explicit.stderr).toBe(0)
    expect(explicit.stdout.trim().split('\n')).toEqual(['ssh', '/opt/custom/python3'])
  })

  it('refuses to switch to a probe runtime even when its attestation matches the slot binding', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-switch-probe-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = cleanDeployScriptFixture(root)
    const runDir = join(root, 'run')
    const releasesDir = join(root, 'releases')
    const commonEnv = {
      ...process.env,
      AIWORKER_BG_RUN_DIR: runDir,
      AIWORKER_BG_RELEASES_DIR: releasesDir,
      AIWORKER_BG_ROUTER_PORT: '43017',
      AIWORKER_BG_BLUE_PORT: '43317',
      AIWORKER_BG_GREEN_PORT: '43417',
      NODE_BIN: process.execPath,
    }
    execFileSync('bash', [script, 'init', 'blue'], { env: commonEnv })
    const manifestSha256 = 'a'.repeat(64)
    writeFileSync(join(runDir, 'slots', 'green.json'), `${JSON.stringify({
      schema: 'video-autoworker-standalone-slot/v1',
      slot: 'green',
      releaseId: 'release-green',
      releaseRoot: join(releasesDir, 'release-green', 'standalone'),
      manifestSha256,
      host: '127.0.0.1',
      port: 43417,
    })}\n`, { mode: 0o600 })
    writeFileSync(join(runDir, 'slots', 'green.runtime.json'), `${JSON.stringify({
      schema: 'video-autoworker-standalone-runtime/v1',
      pid: process.pid,
      slot: 'green',
      role: 'probe',
      releaseId: 'release-green',
      manifestSha256,
      host: '127.0.0.1',
      port: 43417,
      dbPath: join(root, 'probe', 'mission-control.db'),
      routerStatePath: realpathSync(join(runDir, 'router-state.json')),
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 })

    const result = spawnSync('bash', [script, 'switch', 'green'], {
      encoding: 'utf8',
      env: commonEnv,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('switch and rollback require active')
    expect(JSON.parse(readFileSync(join(runDir, 'router-state.json'), 'utf8')).active).toBe('blue')
  })

  it('refuses an active runtime whose attested database differs from the explicit live database', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-switch-wrong-db-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = cleanDeployScriptFixture(root)
    const runDir = join(root, 'run')
    const releasesDir = join(root, 'releases')
    const attestedDb = join(root, 'attested.db')
    const liveDb = join(root, 'live.db')
    writeFileSync(attestedDb, '')
    writeFileSync(liveDb, '')
    const commonEnv = {
      ...process.env,
      AIWORKER_BG_RUN_DIR: runDir,
      AIWORKER_BG_RELEASES_DIR: releasesDir,
      AIWORKER_BG_ROUTER_PORT: '43017',
      AIWORKER_BG_BLUE_PORT: '43317',
      AIWORKER_BG_GREEN_PORT: '43417',
      AIWORKER_BG_LIVE_DB_PATH: liveDb,
      NODE_BIN: process.execPath,
    }
    execFileSync('bash', [script, 'init', 'blue'], { env: commonEnv })
    const manifestSha256 = 'b'.repeat(64)
    writeFileSync(join(runDir, 'slots', 'green.json'), `${JSON.stringify({
      schema: 'video-autoworker-standalone-slot/v1',
      slot: 'green',
      releaseId: 'release-green',
      releaseRoot: join(releasesDir, 'release-green', 'standalone'),
      manifestSha256,
      host: '127.0.0.1',
      port: 43417,
    })}\n`, { mode: 0o600 })
    writeFileSync(join(runDir, 'slots', 'green.runtime.json'), `${JSON.stringify({
      schema: 'video-autoworker-standalone-runtime/v1',
      pid: process.pid,
      slot: 'green',
      role: 'active',
      releaseId: 'release-green',
      manifestSha256,
      host: '127.0.0.1',
      port: 43417,
      dbPath: attestedDb,
      routerStatePath: realpathSync(join(runDir, 'router-state.json')),
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 })

    const result = spawnSync('bash', [script, 'switch', 'green'], {
      encoding: 'utf8',
      env: commonEnv,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('runtime database does not match AIWORKER_BG_LIVE_DB_PATH')
    expect(JSON.parse(readFileSync(join(runDir, 'router-state.json'), 'utf8')).active).toBe('blue')
  })

  it('refuses to rebind a stopped production slot without a one-use retirement proof', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-rebind-without-retirement-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = cleanDeployScriptFixture(root)
    const runDir = join(root, 'run')
    const releasesDir = join(root, 'releases')
    const liveDb = join(root, 'mission-control.db')
    writeFileSync(liveDb, 'fixture\n')
    const commonEnv = {
      ...process.env,
      AIWORKER_BG_RUN_DIR: runDir,
      AIWORKER_BG_RELEASES_DIR: releasesDir,
      AIWORKER_BG_ROUTER_PORT: '43017',
      AIWORKER_BG_BLUE_PORT: '43317',
      AIWORKER_BG_GREEN_PORT: '43417',
      AIWORKER_BG_LIVE_DB_PATH: liveDb,
      NODE_BIN: process.execPath,
    }
    execFileSync('bash', [script, 'init', 'blue'], { env: commonEnv })
    const replaced = JSON.parse(readFileSync(join(runDir, 'router-state.json'), 'utf8'))
    replaced.generation = 2
    replaced.active = 'green'
    replaced.previous = 'blue'
    replaced.updatedAt = new Date().toISOString()
    replaced.slots.blue.releaseId = 'release-old'
    replaced.slots.green.releaseId = 'release-current'
    writeRouterStateAtomic(join(runDir, 'router-state.json'), replaced)

    const result = spawnSync('bash', [script, 'bind', 'blue', 'release-next', join(releasesDir, 'release-next', 'standalone')], {
      encoding: 'utf8',
      env: commonEnv,
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('blue retirement proof is missing or unsafe')
    expect(JSON.parse(readFileSync(join(runDir, 'router-state.json'), 'utf8')).slots.blue.releaseId)
      .toBe('release-old')
  })

  it('does not let ordinary init become a legacy hot-switch baseline', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-init-not-bootstrap-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = cleanDeployScriptFixture(root)
    const runDir = join(root, 'run')
    const liveDb = join(root, 'mission-control.db')
    writeFileSync(liveDb, 'fixture\n')
    const env = {
      ...process.env,
      AIWORKER_BG_RUN_DIR: runDir,
      AIWORKER_BG_RELEASES_DIR: join(root, 'releases'),
      AIWORKER_BG_ROUTER_PORT: '43017',
      AIWORKER_BG_BLUE_PORT: '43317',
      AIWORKER_BG_GREEN_PORT: '43417',
      AIWORKER_BG_LIVE_DB_PATH: liveDb,
      NODE_BIN: process.execPath,
    }
    execFileSync('bash', [script, 'init', 'blue'], { env })

    const result = spawnSync('bash', [script, 'switch', 'green'], { env, encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('blue-green baseline is missing or unsafe')
    expect(JSON.parse(readFileSync(join(runDir, 'router-state.json'), 'utf8')).active).toBe('blue')
  })

  it('rejects a tenant-scoped intake response as a global release gate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-global-readiness-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const harness = join(root, 'readiness-harness.sh')
    const endpoint = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        control: {
          accepting: false,
          mode: 'paused',
          revision: 1,
          counts: { queued: 0, accepted: 0, running: 0, waiting: 0, active: 0 },
        },
      }))
    }))
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    writeFileSync(harness, `${functionPrelude}
check_json_endpoint readiness "http://127.0.0.1:${endpoint.port}/api/n8n/release-readiness" blue release-blue 43317
`)

    const failure = await execFileAsync('bash', [harness], {
      env: {
        ...process.env,
        AIWORKER_BG_CONTROL_TOKEN: 'fixture-token-that-must-not-be-logged',
        NODE_BIN: process.execPath,
      },
    }).then(() => null, error => error as Error & { stderr?: string })
    expect(failure?.stderr).toContain('global readiness envelope is invalid')
    expect(failure?.stderr).not.toContain('fixture-token-that-must-not-be-logged')
  })

  it.each(['unknown', 'unavailable'] as const)(
    'rejects scheduler state %s in the deploy readiness parser',
    async schedulerState => {
      const root = mkdtempSync(join(tmpdir(), `standalone-readiness-${schedulerState}-`))
      cleanup.push(() => rmSync(root, { recursive: true, force: true }))
      const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
      const harness = join(root, 'readiness-harness.sh')
      const endpoint = await listen(createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(releaseReadinessPayload(schedulerState)))
      }))
      const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
      writeFileSync(harness, `${functionPrelude}
check_json_endpoint readiness "http://127.0.0.1:${endpoint.port}/api/n8n/release-readiness" \
  blue release-blue 43317 "" "" 7
`)

      const failure = await execFileAsync('bash', [harness], {
        env: {
          ...process.env,
          AIWORKER_BG_CONTROL_TOKEN: 'fixture-token-that-must-not-be-logged',
          NODE_BIN: process.execPath,
        },
      }).then(() => null, error => error as Error & { stderr?: string })
      expect(failure?.stderr).toContain('scheduler readiness is invalid')
      expect(failure?.stderr).not.toContain('fixture-token-that-must-not-be-logged')
    },
  )

  it('rejects an incompatible pending director projection in the deploy readiness parser', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-readiness-projection-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const harness = join(root, 'readiness-harness.sh')
    const payload = releaseReadinessPayload('leader') as {
      readiness: { projection: { incompatiblePending: number } }
    }
    payload.readiness.projection.incompatiblePending = 1
    const endpoint = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }))
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    writeFileSync(harness, `${functionPrelude}
check_json_endpoint readiness "http://127.0.0.1:${endpoint.port}/api/n8n/release-readiness" \
  blue release-blue 43317 "" "" 7
`)

    const failure = await execFileAsync('bash', [harness], {
      env: {
        ...process.env,
        AIWORKER_BG_CONTROL_TOKEN: 'fixture-token-that-must-not-be-logged',
        NODE_BIN: process.execPath,
      },
    }).then(() => null, error => error as Error & { stderr?: string })
    expect(failure?.stderr).toContain('director evidence projection contract is incompatible')
    expect(failure?.stderr).not.toContain('fixture-token-that-must-not-be-logged')
  })

  it('pins routed readiness to the projection contract captured before the transition', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-readiness-projection-pin-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const harness = join(root, 'readiness-harness.sh')
    const endpoint = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(releaseReadinessPayload('leader')))
    }))
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    writeFileSync(harness, `${functionPrelude}
check_json_endpoint readiness "http://127.0.0.1:${endpoint.port}/api/n8n/release-readiness" \
  blue release-blue 43317 "" "" 7 ${'b'.repeat(64)}
`)

    const failure = await execFileAsync('bash', [harness], {
      env: {
        ...process.env,
        AIWORKER_BG_CONTROL_TOKEN: 'fixture-token-that-must-not-be-logged',
        NODE_BIN: process.execPath,
      },
    }).then(() => null, error => error as Error & { stderr?: string })
    expect(failure?.stderr).toContain('director evidence projection contract is incompatible')
    expect(failure?.stderr).not.toContain('fixture-token-that-must-not-be-logged')
  })

  it('waits through a temporary follower state until the routed slot becomes leader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-leader-handoff-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const harness = join(root, 'leader-harness.sh')
    let requests = 0
    const endpoint = await listen(createServer((_request, response) => {
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(schedulerPayload(requests === 1 ? 'follower' : 'leader')))
    }))
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    writeFileSync(harness, `${functionPrelude}
wait_for_scheduler_leader 7
`)

    await expect(execFileAsync('bash', [harness], {
      env: {
        ...process.env,
        AIWORKER_BG_ROUTER_PORT: String(endpoint.port),
        AIWORKER_BG_CONTROL_TOKEN: 'fixture-token-that-must-not-be-logged',
        AIWORKER_BG_LEADER_TIMEOUT_SECONDS: '3',
        AIWORKER_BG_HTTP_TIMEOUT_MS: '500',
        NODE_BIN: process.execPath,
      },
    })).resolves.toBeDefined()
    expect(requests).toBeGreaterThanOrEqual(2)
  })

  it('fails within the configured bound when the routed slot never becomes leader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-leader-timeout-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const harness = join(root, 'leader-harness.sh')
    const endpoint = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(schedulerPayload('follower')))
    }))
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    writeFileSync(harness, `${functionPrelude}
wait_for_scheduler_leader 7
`)

    const startedAt = Date.now()
    const failure = await execFileAsync('bash', [harness], {
      env: {
        ...process.env,
        AIWORKER_BG_ROUTER_PORT: String(endpoint.port),
        AIWORKER_BG_CONTROL_TOKEN: 'fixture-token-that-must-not-be-logged',
        AIWORKER_BG_LEADER_TIMEOUT_SECONDS: '1',
        AIWORKER_BG_HTTP_TIMEOUT_MS: '500',
        NODE_BIN: process.execPath,
      },
    }).then(() => null, error => error as Error & { stderr?: string })

    expect(Date.now() - startedAt).toBeLessThan(3_500)
    expect(failure?.stderr).toContain('new active slot has not acquired valid scheduler leadership')
    expect(failure?.stderr).not.toContain('fixture-token-that-must-not-be-logged')
  })

  it('waits for each committed scheduler generation before switch and automatic rollback verification', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-transition-order-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'transition-harness.sh')
    const eventsFile = join(root, 'events.log')
    writeFileSync(harness, `${functionPrelude}
EVENTS_FILE="$1"
active_slot=blue
previous_slot=""
state_generation=7
transition_committed=0

record_event() {
  printf '%s\\n' "$1" >> "$EVENTS_FILE"
}

read_state_field() {
  case "$1" in
    active) printf '%s\\n' "$active_slot" ;;
    previous) printf '%s\\n' "$previous_slot" ;;
    generation) printf '%s\\n' "$state_generation" ;;
  esac
}

read_state_slot_release() {
  printf 'release-%s\\n' "$1"
}

binding_values() {
  printf 'release-%s\\n' "$1"
  printf '/private/test/releases/release-%s/standalone\\n' "$1"
}

preflight_transition() {
  transition_committed=0
  record_event "preflight:$1:$2:$3"
}

verify_director_video_release_chain() {
  record_event "compatibility:$1:$state_generation"
  printf '%s\n' '${'a'.repeat(64)}'
}

capture_transition_release_evidence() {
  record_event "capture:$1:$2:$state_generation"
  printf '%s\n' "$3"
}

verify_captured_transition_release_evidence() {
  record_event "captured-evidence:$2:$3:$4"
  verify_routed_release "$2" "$3" "$4" 3 1 '${'a'.repeat(64)}'
}

update_state() {
  local target="$1" mode="$2"
  previous_slot="$active_slot"
  active_slot="$target"
  state_generation=$((state_generation + 1))
  transition_committed=1
  rm -f -- "$EVENTS_FILE.leader-$state_generation"
  record_event "update:$mode:$target:$state_generation"
}

assert_router_identity() {
  [[ "$1" == "$active_slot" && "$3" == "$state_generation" ]] || return 1
  record_event "router:$1:$3"
}

check_json_endpoint() {
  local mode="$1" url="$2"
  shift 2
  case "$mode" in
    readiness)
      if (( transition_committed == 1 )); then
        [[ "\${6:-}" == "$state_generation" ]] || return 1
        [[ -f "$EVENTS_FILE.leader-$state_generation" ]] || {
          record_event "violation:readiness-before-leader:$state_generation"
          return 1
        }
        record_event "readiness:$state_generation"
      else
        record_event "pre-readiness:$state_generation"
      fi
      printf '3\\n1\\n%s\\n0\\n0\\n0\\n' '${'a'.repeat(64)}'
      ;;
    leader)
      [[ "\${1:-}" == "$state_generation" ]] || return 1
      if [[ ! -f "$EVENTS_FILE.leader-$state_generation" ]]; then
        record_event "leader-wait:$state_generation"
        : > "$EVENTS_FILE.leader-$state_generation"
        return 1
      fi
      record_event "leader-ready:$state_generation"
      ;;
    health)
      [[ -f "$EVENTS_FILE.leader-$state_generation" ]] || {
        record_event "violation:health-before-leader:$state_generation"
        return 1
      }
      record_event "health:$state_generation"
      ;;
    *) return 1 ;;
  esac
}

check_routed_readonly_endpoint() {
  local pathname="$1" kind="$2"
  [[ -f "$EVENTS_FILE.leader-$state_generation" ]] || {
    record_event "violation:$kind-before-leader:$state_generation"
    return 1
  }
  record_event "$kind:$pathname:$state_generation"
  [[ "$state_generation" != 8 || "$pathname" != /api/tasks ]]
}

probe_slot() {
  record_event "probe:$1:$2:$state_generation"
}

sleep() { :; }

transition_with_verification green switch
`)

    const failure = await execFileAsync('bash', [harness, eventsFile], {
      env: {
        ...process.env,
        AIWORKER_BG_LEADER_TIMEOUT_SECONDS: '3',
        NODE_BIN: process.execPath,
      },
    }).then(() => null, error => error as Error & { stderr?: string })
    expect(failure?.stderr).toContain('post-switch verification failed; attempting automatic rollback to blue')
    expect(failure?.stderr).toContain('router automatically returned to blue generation 9')
    const events = readFileSync(eventsFile, 'utf8').trim().split('\n')
    const position = (event: string) => events.indexOf(event)

    expect(events.some(event => event.startsWith('violation:'))).toBe(false)
    expect(position('compatibility:release-green:7')).toBeGreaterThan(position('pre-readiness:7'))
    expect(position('compatibility:release-green:7')).toBeLessThan(position('update:switch:green:8'))
    for (const generationValue of [8, 9]) {
      expect(events).toContain(`api:/api/tasks:${generationValue}`)
      expect(position(`leader-wait:${generationValue}`)).toBeGreaterThan(position(
        generationValue === 8 ? 'update:switch:green:8' : 'update:rollback:blue:9',
      ))
      expect(position(`leader-ready:${generationValue}`)).toBeGreaterThan(position(`leader-wait:${generationValue}`))
      expect(position(`health:${generationValue}`)).toBeGreaterThan(position(`leader-ready:${generationValue}`))
      expect(position(`readiness:${generationValue}`)).toBeGreaterThan(position(`leader-ready:${generationValue}`))
      expect(position(`page:/materials:${generationValue}`)).toBeGreaterThan(position(`leader-ready:${generationValue}`))
      expect(position(`api:/api/tasks:${generationValue}`)).toBeGreaterThan(position(`leader-ready:${generationValue}`))
    }
    expect(position('update:rollback:blue:9')).toBeGreaterThan(position('api:/api/tasks:8'))
  })

  it('rejects a target whose runtime digest disagrees with the HEAD-bound static verifier', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-projection-static-runtime-mismatch-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'projection-static-runtime-mismatch.sh')
    const updateMarker = join(root, 'updated')
    writeFileSync(harness, `${functionPrelude}
read_state_field() {
  case "$1" in active) printf 'blue\\n' ;; generation) printf '7\\n' ;; esac
}
read_state_slot_release() { printf 'release-%s\\n' "$1"; }
binding_values() {
  printf 'release-%s\\n' "$1"
  printf '/private/test/releases/release-%s/standalone\\n' "$1"
}
preflight_transition() { :; }
check_json_endpoint() {
  [[ "$1" == readiness ]] || return 1
  printf '3\\n1\\n%s\\n0\\n0\\n0\\n' '${'a'.repeat(64)}'
}
verify_director_video_release_chain() { printf '%s\\n' '${'b'.repeat(64)}'; }
update_state() { : > ${JSON.stringify(updateMarker)}; }
transition_with_verification green switch
`)

    const failure = await execFileAsync('bash', [harness], {
      env: { ...process.env, NODE_BIN: process.execPath },
    }).then(() => null, error => error as Error & { stderr?: string })
    expect(failure?.stderr).toContain(
      'target runtime projection contract does not match the HEAD-bound release verifier',
    )
    expect(existsSync(updateMarker)).toBe(false)
  })

  it('seals captured transition evidence and rejects a mutated envelope', () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-transition-evidence-envelope-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'transition-evidence-envelope.sh')
    const eventsFile = join(root, 'events')
    writeFileSync(harness, `${functionPrelude}
EVENTS_FILE="$1"
LIVE_DB_PATH=/private/test/live.db
STATE_FILE=/private/test/router-state.json
read_state_field() {
  case "$1" in active) printf 'blue\\n' ;; generation) printf '7\\n' ;; esac
}
read_state_slot_release() { printf 'release-blue\\n'; }
binding_values() {
  printf 'release-blue\\n/private/test/releases/release-blue/standalone\\n%s\\n127.0.0.1\\n3317\\n' \
    '${'a'.repeat(64)}'
}
assert_release() { printf '%s\\n' "$2"; }
release_manifest_sha() { printf '%s\\n' '${'a'.repeat(64)}'; }
runtime_attestation_values() {
  printf '1234\\nblue\\nactive\\nrelease-blue\\n%s\\n127.0.0.1\\n3317\\n%s\\n%s\\n' \
    '${'a'.repeat(64)}' "$LIVE_DB_PATH" "$STATE_FILE"
}
physical_path() { printf '%s\\n' "$1"; }
binding_file() { printf '/private/test/blue.json\\n'; }
runtime_attestation_file() { printf '/private/test/blue.runtime.json\\n'; }
router_attestation_file() { printf '/private/test/router.runtime.json\\n'; }
assert_private_file() { :; }
file_sha256() {
  case "$1" in
    */blue.json) printf '%s\\n' '${'b'.repeat(64)}' ;;
    */blue.runtime.json) printf '%s\\n' '${'c'.repeat(64)}' ;;
    */router.runtime.json) printf '%s\\n' '${'d'.repeat(64)}' ;;
    *) return 1 ;;
  esac
}
probe_slot() { :; }
verify_routed_release() { printf 'routed:%s:%s:%s:%s:%s:%s\\n' "$@" >> "$EVENTS_FILE"; }
readiness=$(printf '3\\n1\\n%s\\n0\\n0\\n0' '${'e'.repeat(64)}')
evidence="$(capture_transition_release_evidence blue release-blue "$readiness" \
  blue release-blue 7)"
verify_captured_transition_release_evidence "$evidence" blue release-blue 7 0
tampered="$("$NODE_BIN" -e '
  const value = JSON.parse(process.argv[1]); value.payload.readiness.pending = 1;
  process.stdout.write(JSON.stringify(value))
' "$evidence")"
if verify_captured_transition_release_evidence "$tampered" blue release-blue 7 0; then
  printf 'mutated evidence was accepted\\n' >&2
  exit 9
fi
`)

    const result = spawnSync('bash', [harness, eventsFile], {
      env: { ...process.env, NODE_BIN: process.execPath },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(eventsFile, 'utf8').trim()).toBe(
      `routed:blue:release-blue:7:3:1:${'e'.repeat(64)}`,
    )
  })

  it('rejects an ordinary cross-contract switch even when both sides have no active work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-projection-contract-switch-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'projection-switch-harness.sh')
    const updateMarker = join(root, 'updated')
    writeFileSync(harness, `${functionPrelude}
read_state_field() {
  case "$1" in active) printf 'blue\\n' ;; generation) printf '7\\n' ;; esac
}
read_state_slot_release() { printf 'release-%s\\n' "$1"; }
binding_values() {
  printf 'release-%s\\n' "$1"
  printf '/private/test/releases/release-%s/standalone\\n' "$1"
}
preflight_transition() { :; }
check_json_endpoint() {
  [[ "$1" == readiness ]] || return 1
  if [[ "$2" == *':3017/'* ]]; then
    printf '3\\n1\\n%s\\n0\\n0\\n0\\n' '${'a'.repeat(64)}'
  else
    printf '3\\n1\\n%s\\n0\\n0\\n0\\n' '${'b'.repeat(64)}'
  fi
}
verify_director_video_release_chain() { :; }
update_state() { : > ${JSON.stringify(updateMarker)}; }
transition_with_verification green switch
`)

    const failure = await execFileAsync('bash', [harness], {
      env: { ...process.env, NODE_BIN: process.execPath },
    }).then(() => null, error => error as Error & { stderr?: string })
    expect(failure?.stderr).toContain(
      'ordinary switch and rollback cannot cross director projection contracts',
    )
    expect(existsSync(updateMarker)).toBe(false)
  })

  it('rejects an explicit cross-contract rollback even when both sides have no active work', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-projection-contract-rollback-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'projection-rollback-harness.sh')
    const updateMarker = join(root, 'updated')
    writeFileSync(harness, `${functionPrelude}
read_state_field() {
  case "$1" in
    active) printf 'blue\\n' ;;
    previous) printf 'green\\n' ;;
    generation) printf '7\\n' ;;
  esac
}
read_state_slot_release() { printf 'release-%s\\n' "$1"; }
binding_values() {
  printf 'release-%s\\n' "$1"
  printf '/private/test/releases/release-%s/standalone\\n' "$1"
}
preflight_transition() { :; }
check_json_endpoint() {
  [[ "$1" == readiness ]] || return 1
  if [[ "$2" == *':3017/'* ]]; then
    printf '3\\n1\\n%s\\n0\\n0\\n0\\n' '${'a'.repeat(64)}'
  else
    printf '3\\n1\\n%s\\n0\\n0\\n0\\n' '${'b'.repeat(64)}'
  fi
}
update_state() { : > ${JSON.stringify(updateMarker)}; }
transition_with_verification green rollback
`)

    const failure = await execFileAsync('bash', [harness], {
      env: { ...process.env, NODE_BIN: process.execPath },
    }).then(() => null, error => error as Error & { stderr?: string })
    expect(failure?.stderr).toContain(
      'ordinary switch and rollback cannot cross director projection contracts',
    )
    expect(existsSync(updateMarker)).toBe(false)
  })

  it('uses captured source evidence when source=A, HEAD target=B, and the switch fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-projection-post-switch-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'projection-post-switch-harness.sh')
    const eventsFile = join(root, 'events')
    writeFileSync(harness, `${functionPrelude}
EVENTS_FILE="$1"
active_slot=blue
previous_slot=""
state_generation=7
read_state_field() {
  case "$1" in
    active) printf '%s\\n' "$active_slot" ;;
    previous) printf '%s\\n' "$previous_slot" ;;
    generation) printf '%s\\n' "$state_generation" ;;
  esac
}
read_state_slot_release() {
  case "$1" in
    blue) printf '%s-runtime\\n' '${'a'.repeat(40)}' ;;
    green) printf '%s-runtime\\n' '${'b'.repeat(40)}' ;;
  esac
}
binding_values() {
  local release
  release="$(read_state_slot_release "$1")"
  printf '%s\\n' "$release"
  printf '/private/test/releases/%s/standalone\\n' "$release"
}
preflight_transition() { :; }
check_json_endpoint() {
  [[ "$1" == readiness ]] || return 1
  printf '3\\n1\\n%s\\n0\\n0\\n0\\n' '${'a'.repeat(64)}'
}
verify_director_video_release_chain() {
  printf 'compatibility:%s:%s\\n' "$1" "$state_generation" >> "$EVENTS_FILE"
  if [[ "$1" == '${'b'.repeat(40)}-runtime' && "$state_generation" == 7 ]]; then
    printf '%s\\n' '${'a'.repeat(64)}'
    return
  fi
  [[ "$1" != '${'a'.repeat(40)}-runtime' ]] \
    || printf 'forbidden-head-verifier:%s:%s\\n' "$1" "$state_generation" >> "$EVENTS_FILE"
  return 1
}
capture_transition_release_evidence() {
  printf 'capture:%s:%s:%s\\n' "$1" "$2" "$state_generation" >> "$EVENTS_FILE"
  printf 'captured-%s\\n' "$1"
}
verify_captured_transition_release_evidence() {
  printf 'captured-evidence:%s:%s:%s\\n' "$2" "$3" "$4" >> "$EVENTS_FILE"
}
update_state() {
  previous_slot="$active_slot"
  active_slot="$1"
  state_generation=$((state_generation + 1))
  printf 'update:%s:%s:%s\\n' "$2" "$1" "$state_generation" >> "$EVENTS_FILE"
}
probe_slot() { :; }
transition_with_verification green switch
`)

    const failure = await execFileAsync('bash', [harness, eventsFile], {
      env: { ...process.env, NODE_BIN: process.execPath },
    }).then(() => null, error => error as Error & { stderr?: string })
    expect(failure?.stderr).toContain('projection compatibility changed during switch')
    expect(failure?.stderr).toContain('router automatically returned to blue generation 9')
    expect(failure).not.toBeNull()
    expect(readFileSync(eventsFile, 'utf8').trim().split('\n')).toEqual([
      `compatibility:${'b'.repeat(40)}-runtime:7`,
      `capture:blue:${'a'.repeat(40)}-runtime:7`,
      `capture:green:${'b'.repeat(40)}-runtime:7`,
      'update:switch:green:8',
      `captured-evidence:green:${'b'.repeat(40)}-runtime:8`,
      `compatibility:${'b'.repeat(40)}-runtime:8`,
      'update:rollback:blue:9',
      `captured-evidence:blue:${'a'.repeat(40)}-runtime:9`,
    ])
  })

  it('verifies an explicit same-contract rollback through captured target evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-explicit-rollback-evidence-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'explicit-rollback-evidence.sh')
    const eventsFile = join(root, 'events')
    writeFileSync(harness, `${functionPrelude}
EVENTS_FILE="$1"
active_slot=blue
previous_slot=green
state_generation=7
read_state_field() {
  case "$1" in
    active) printf '%s\\n' "$active_slot" ;;
    previous) printf '%s\\n' "$previous_slot" ;;
    generation) printf '%s\\n' "$state_generation" ;;
  esac
}
read_state_slot_release() { printf 'release-%s\\n' "$1"; }
binding_values() {
  printf 'release-%s\\n' "$1"
  printf '/private/test/releases/release-%s/standalone\\n' "$1"
}
preflight_transition() { :; }
check_json_endpoint() {
  [[ "$1" == readiness ]] || return 1
  printf '3\\n1\\n%s\\n0\\n0\\n0\\n' '${'a'.repeat(64)}'
}
verify_director_video_release_chain() {
  printf 'unexpected-head-verifier:%s\\n' "$1" >> "$EVENTS_FILE"
  return 1
}
capture_transition_release_evidence() {
  printf 'capture:%s:%s\\n' "$1" "$2" >> "$EVENTS_FILE"
  printf 'captured-%s\\n' "$1"
}
verify_captured_transition_release_evidence() {
  printf 'captured-evidence:%s:%s:%s\\n' "$2" "$3" "$4" >> "$EVENTS_FILE"
}
update_state() {
  previous_slot="$active_slot"
  active_slot="$1"
  state_generation=$((state_generation + 1))
  printf 'update:%s:%s:%s\\n' "$2" "$1" "$state_generation" >> "$EVENTS_FILE"
}
transition_with_verification green rollback
`)

    const output = execFileSync('bash', [harness, eventsFile], {
      env: { ...process.env, NODE_BIN: process.execPath },
      encoding: 'utf8',
    })
    expect(output).toContain('Rolled back router atomically: active=green generation=8')
    expect(readFileSync(eventsFile, 'utf8').trim().split('\n')).toEqual([
      'capture:blue:release-blue',
      'capture:green:release-green',
      'update:rollback:green:8',
      'captured-evidence:green:release-green:8',
    ])
  })

  it('uses the ancestor-safe static verifier when delayed retirement follows a docs-only HEAD', () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-delayed-retirement-head-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'delayed-retirement-head.sh')
    const eventsFile = join(root, 'events')
    writeFileSync(harness, `${functionPrelude}
EVENTS_FILE="$1"
read_state_field() { printf 'blue\\n'; }
read_state_slot_release() { printf '%s-runtime\\n' '${'a'.repeat(40)}'; }
binding_values() {
  printf '%s-runtime\\n' '${'a'.repeat(40)}'
  printf '/private/test/releases/%s-runtime/standalone\\n' '${'a'.repeat(40)}'
}
verify_director_video_release_chain() {
  printf 'verify:%s:%s:%s\\n' "$1" "$2" "\${3:-head}" >> "$EVENTS_FILE"
  [[ "\${3:-head}" == ancestor ]]
}
verify_active_director_projection_chain
`)

    const result = spawnSync('bash', [harness, eventsFile], {
      env: { ...process.env, NODE_BIN: process.execPath },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(eventsFile, 'utf8').trim()).toContain(':ancestor')
  })

  it('rechecks release quiescence directly from SQLite after callback freeze and shutdown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-retirement-db-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const databasePath = join(root, 'mission-control.db')
    const database = new Database(databasePath)
    database.exec(`
      CREATE TABLE n8n_task_runs (
        task_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        routing TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE n8n_child_execution_leases (
        task_id TEXT PRIMARY KEY,
        updated_at INTEGER NOT NULL
      );
    `)
    const now = Math.floor(Date.now() / 1_000)
    const routing = JSON.stringify({
      callbackProtocol: 'slot-v1',
      runtimeSlot: 'blue',
      runtimeReleaseId: 'release-blue',
      claimCallbackUrl: 'http://127.0.0.1:43317/api/n8n/claim',
    })
    database.prepare(`
      INSERT INTO n8n_task_runs (task_id, status, routing, updated_at)
      VALUES (?, ?, ?, ?)
    `).run('completed', 'succeeded', routing, now - 121)
    database.close()

    const deployScript = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = deployScript.slice(0, deployScript.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'database-retirement-harness.sh')
    writeFileSync(harness, `${functionPrelude}
PROJECT_ROOT=${JSON.stringify(process.cwd())}
check_database_retirement "$1" blue release-blue 43317 ${now - 500} 120
`)
    const environment = { ...process.env, NODE_BIN: process.execPath }
    const passed = execFileSync('bash', [harness, databasePath], { env: environment, encoding: 'utf8' })
    expect(JSON.parse(passed)).toMatchObject({
      tracked: 1,
      active: 0,
      untrackedCallbacks: 0,
      otherReleaseActive: 0,
      childExecutionLeases: 0,
    })

    const activeDatabase = new Database(databasePath)
    activeDatabase.prepare(`UPDATE n8n_task_runs SET status = 'running', updated_at = ?`).run(now)
    activeDatabase.close()
    const blocked = spawnSync('bash', [harness, databasePath], { env: environment, encoding: 'utf8' })
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('not quiescent after callback freeze and listener shutdown')
  })

  it('rechecks the authoritative Mission Control and n8n databases during legacy bootstrap', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-legacy-db-gate-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const missionPath = join(root, 'mission-control.db')
    const n8nPath = join(root, 'n8n.sqlite')
    const mission = new Database(missionPath)
    const n8n = new Database(n8nPath)
    try {
      mission.exec(`
        CREATE TABLE n8n_task_runs (
          source TEXT NOT NULL,
          status TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `)
      n8n.exec(`
        CREATE TABLE execution_entity (
          status TEXT NOT NULL,
          "stoppedAt" TEXT
        );
      `)
    } finally {
      mission.close()
      n8n.close()
    }

    const deployScript = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = deployScript.slice(0, deployScript.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'legacy-db-harness.sh')
    writeFileSync(harness, `${functionPrelude}
PROJECT_ROOT=${JSON.stringify(process.cwd())}
check_legacy_databases_quiescent "$1" "$2"
`)
    const environment = { ...process.env, NODE_BIN: process.execPath }
    expect(JSON.parse(execFileSync('bash', [harness, missionPath, n8nPath], {
      env: environment,
      encoding: 'utf8',
    }))).toEqual({ mediaNodes: 0, running: 0, freshWaiting: 0, n8nActiveExecutions: 0 })

    const activeN8n = new Database(n8nPath)
    activeN8n.prepare('INSERT INTO execution_entity (status, "stoppedAt") VALUES (?, NULL)')
      .run('running')
    activeN8n.close()
    const blocked = spawnSync('bash', [harness, missionPath, n8nPath], {
      env: environment,
      encoding: 'utf8',
    })
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('active or recently waiting work is still present')
  })

  it('keeps switch and rollback transport-only and pins n8n callbacks to the backend slot', () => {
    const deployScript = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const launcher = readFileSync(resolve(process.cwd(), 'scripts/start-standalone-slot.sh'), 'utf8')
    const transitionBody = deployScript.slice(
      deployScript.indexOf('transition_with_verification()'),
      deployScript.indexOf('switch_slot()'),
    )
    const retireBody = deployScript.slice(
      deployScript.indexOf('retire_slot()'),
      deployScript.indexOf('probe_slot()'),
    )

    expect(transitionBody.indexOf('preflight_transition "$source" "$target"'))
      .toBeLessThan(transitionBody.indexOf('update_state "$target" "$mode"'))
    expect(transitionBody.indexOf('update_state "$target" "$mode"'))
      .toBeLessThan(transitionBody.indexOf(
        'verify_captured_transition_release_evidence "$target_evidence"',
      ))
    expect(transitionBody).toContain('attempting automatic rollback')
    expect(transitionBody).toContain('update_state "$source" rollback')
    expect(transitionBody).toContain(
      'verify_captured_transition_release_evidence "$source_evidence"',
    )
    expect(transitionBody).not.toContain('verify_director_video_release_chain "$source_release"')
    expect(transitionBody).toContain(
      '[[ "$target_verified_contract" == "$target_projection_contract" ]]',
    )
    expect(transitionBody).toContain(
      '[[ "$source_projection_contract" == "$target_projection_contract" ]]',
    )
    expect(deployScript).not.toMatch(/\b(?:launchctl|n8n-stop|n8n-start)\b/u)
    expect(deployScript).toContain('source "$SHARED_DEPLOYMENT_LOCK_SHELL"')
    expect(deployScript).toContain('acquire_shared_deployment_lock')
    expect(deployScript).toContain('release_shared_deployment_lock')
    expect(deployScript).not.toContain('if ! mkdir "$LOCK_DIR"')
    expect(deployScript).toContain('deployment source worktree and index must be clean')
    expect(deployScript).toContain('stage_release()')
    expect(deployScript).toContain('source standalone artifact failed verification')
    expect(deployScript).toContain('staged standalone artifact failed verification')
    expect(deployScript).toContain('release target appeared during staging')
    expect(launcher).toContain('ROLE="${2:-probe}"')
    expect(launcher).toContain('probe role requires absolute AIWORKER_BG_PROBE_DATA_DIR')
    expect(launcher).toContain('probe role requires a non-empty, non-symlink SQLite snapshot')
    expect(launcher).toContain('AIWORKER_DISABLE_SCHEDULER=1')
    expect(launcher).toContain('AIWORKER_N8N_NODE_CALLBACK_URL="http://$LISTEN_HOST:$PORT/api/n8n/node-execute"')
    expect(launcher).toContain('AIWORKER_N8N_MEDIA_CALLBACK_URL="http://$LISTEN_HOST:$PORT/api/n8n/media-execute"')
    expect(launcher).toContain('AIWORKER_N8N_CLAIM_CALLBACK_URL="http://$LISTEN_HOST:$PORT/api/n8n/claim"')
    expect(launcher).toContain('AIWORKER_N8N_CALLBACK_FREEZE_FILE="$RUN_DIR/slots/$SLOT.callbacks-frozen.json"')
    expect(launcher).toContain('video-autoworker-standalone-runtime/v1')
    expect(launcher).toContain('export AIWORKER_BG_ROUTER_STATE="$PHYSICAL_ROUTER_STATE_PATH"')
    expect(launcher).toContain('routerStatePath,')
    expect(launcher).toContain('fs.fsyncSync(descriptor)')
    expect(launcher).toContain('refusing unsafe environment file')
    expect(launcher).toContain('environment file must have mode 0600')
    expect(deployScript).toContain('probe_slot "$target" active')
    expect(deployScript).toContain('AIWORKER_BG_LIVE_DB_PATH is required for switch and rollback')
    expect(deployScript).toContain('/api/n8n/release-readiness')
    expect(deployScript).toContain("readiness.globalScope !== true")
    expect(deployScript).toContain("intake.schema !== 'video-autoworker-intake-control/v1'")
    expect(deployScript).toContain('database.schemaEpoch')
    expect(deployScript).toContain('video-autoworker-retirement-proof/v2')
    expect(deployScript).toContain('rm -f -- "$(retirement_file "$slot")" "$(callback_freeze_file "$slot")"')
    expect(retireBody).toContain('video-autoworker-callback-freeze/v1')
    expect(retireBody.indexOf('write_json_atomic "$(callback_freeze_file "$slot")"'))
      .toBeLessThan(retireBody.indexOf('wait_for_frozen_retirement_quiescence'))
    expect(retireBody.indexOf('wait_for_frozen_retirement_quiescence'))
      .toBeLessThan(retireBody.indexOf('"$manager" stop "$slot"'))
    expect(retireBody).toContain('rm -f -- "$(callback_freeze_file "$slot")"')
    expect(retireBody).toContain('callback admission was reopened and the old slot remains running')
    expect(retireBody.indexOf('"$manager" stop "$slot"'))
      .toBeLessThan(retireBody.indexOf('check_database_retirement'))
    expect(retireBody).toContain('! kill -0 "$pid"')
    expect(retireBody).toContain('lsof -nP -iTCP:"$port" -sTCP:LISTEN -t')
    expect(retireBody.indexOf('! kill -0 "$pid"'))
      .toBeLessThan(retireBody.indexOf('check_database_retirement'))
    expect(retireBody.indexOf('check_database_retirement'))
      .toBeLessThan(retireBody.indexOf('write_json_atomic "$(retirement_file "$slot")"'))
    expect(deployScript).toContain("leadership.state !== 'inactive'")
    expect(deployScript).toContain('counters.activeRequests !== 0')
    expect(deployScript).toContain('counters.upgradedSockets !== 0')
    expect(deployScript).toContain('video-autoworker-blue-green-baseline/v3')
    expect(deployScript).toContain('video-autoworker-blue-green-bootstrap-pending/v4')
    expect(deployScript).toContain('workflow transition attestation')
    expect(deployScript).toContain('bootstrapClaim')
    expect(deployScript).toContain('workflowReport')
    expect(deployScript).toContain('slot-v1-execution-owner-v1')
    expect(deployScript).toContain('check_n8n_workflow_compatibility')
    const bootstrapBody = deployScript.slice(
      deployScript.indexOf('bootstrap_baseline()'),
      deployScript.indexOf('bind_slot()'),
    )
    const sourceGate = deployScript.slice(
      deployScript.indexOf('verify_deployment_source_gate()'),
      deployScript.indexOf('verify_director_video_release_chain()'),
    )
    expect(sourceGate).toContain('scripts/deploy-blue-green.sh')
    expect(sourceGate).toContain('scripts/lib/shared-deployment-lock.mjs')
    expect(sourceGate).toContain('GIT_OPTIONAL_LOCKS=0')
    const preShutdownReleaseGate = bootstrapBody.indexOf(
      'bootstrap_preflight_contract="$(verify_director_video_release_preflight',
    )
    expect(preShutdownReleaseGate).toBeGreaterThan(0)
    expect(preShutdownReleaseGate).toBeLessThan(
      bootstrapBody.indexOf('write_json_immutable "$pending"'),
    )
    expect(preShutdownReleaseGate).toBeLessThan(bootstrapBody.indexOf('kill -TERM "$legacy_pid"'))
    const finalWorkflowCheck = bootstrapBody.lastIndexOf('check_n8n_workflow_compatibility')
    expect(finalWorkflowCheck).toBeGreaterThan(bootstrapBody.indexOf('"$manager" status router'))
    expect(finalWorkflowCheck).toBeLessThan(bootstrapBody.indexOf('baseline_payload='))
    expect(bootstrapBody.indexOf('baseline_verified_contract="$(verify_director_video_release_chain'))
      .toBeGreaterThan(bootstrapBody.indexOf('"$manager" start "$slot"'))
    expect(bootstrapBody).toContain(
      'post-migration projection contract differs from the pre-shutdown release preflight',
    )
    expect(bootstrapBody).toContain('"$workflow_compatibility_final" == "$workflow_compatibility_after"')
    expect(bootstrapBody.indexOf('workflow_digest="$($NODE_BIN', finalWorkflowCheck))
      .toBeLessThan(bootstrapBody.indexOf('baseline_payload='))
    expect(deployScript).toContain('video-autoworker-legacy-freeze-evidence/v3')
    expect(deployScript).toContain('generate-legacy-freeze-evidence.mjs')
    expect(deployScript).toContain('--verify-evidence-fd "$evidence_fd"')
    expect(deployScript).toContain('--verify-evidence-static-fd "$evidence_fd"')
    expect(deployScript).toContain('--probe-legacy-state-fd "$evidence_fd"')
    expect(bootstrapBody).toContain('probe_evidenced_legacy_state')
    expect(bootstrapBody).not.toContain('kill -0 "$legacy_pid"')
    expect(bootstrapBody).not.toContain('kill -0 "$pending_legacy_pid"')
    expect(bootstrapBody.indexOf('pending_probe="$(bootstrap_pending_probe "$pending")"'))
      .toBeLessThan(bootstrapBody.indexOf('verified_evidence_sha="$(env'))
    expect(bootstrapBody).toContain('evidence_verify_mode=--verify-evidence-static-fd')
    expect(bootstrapBody).toContain('bootstrap retry evidence does not match the pending digest')
    expect(bootstrapBody).not.toContain('315360000')
    expect(bootstrapBody).not.toContain('evidence_max_age=1800')
    expect(bootstrapBody).toContain('(!staticRecovery && age > Number(rawMaxAge))')
    expect(bootstrapBody).toContain('legacy-bootstrap-controller.mjs')
    expect(bootstrapBody).toContain("value.phase !== 'SHUTDOWN_REQUESTED'")
    expect(bootstrapBody).toContain('legacy bootstrap confirmation is expired or bound to another operation')
    expect(bootstrapBody.indexOf('bootstrap_authorization='))
      .toBeLessThan(bootstrapBody.indexOf('write_json_immutable "$pending"'))
    expect(bootstrapBody.indexOf('write_json_immutable "$workflow_report"'))
      .toBeLessThan(bootstrapBody.indexOf('write_json_immutable "$pending"'))
    expect(deployScript).toContain('assert_bootstrap_operation_gate "$command" "$@"')
    expect(bootstrapBody).toContain('guard_controller" handoff')
    expect(bootstrapBody).toContain('post-shutdown n8n recovery hold did not become active')
    expect(bootstrapBody.indexOf('guard_controller" handoff'))
      .toBeLessThan(bootstrapBody.indexOf('"$manager" start "$slot"'))
    const baselineWrite = bootstrapBody.indexOf('write_json_atomic "$(baseline_file)"')
    const finalGuardRevoke = bootstrapBody.lastIndexOf('guard_controller" revoke')
    expect(baselineWrite).toBeGreaterThan(finalWorkflowCheck)
    expect(finalGuardRevoke).toBeGreaterThan(baselineWrite)
    expect(deployScript).toContain('bootstrap retry requires fresh zero-work evidence while the legacy PID is still alive')
    expect(deployScript).toContain('legacy or n8n full identity changed immediately before SIGTERM')
    expect(deployScript).toContain('reserved bootstrap evidence FD 9 is already open')
    expect(deployScript).toContain('exec 9<"$evidence_file"')
    expect(deployScript).not.toContain('exec {evidence_fd}')
    expect(deployScript).toContain('legacy release ID is not bound to its physical cwd')
    expect(deployScript).toContain('evidenced n8n PID is not using AIWORKER_BG_N8N_DB_PATH')
    expect(deployScript).toContain('check_legacy_databases_quiescent "$live_db" "$n8n_db"')
    expect(deployScript).toContain('delete actual.createdAt')
    expect(deployScript).toContain('manage-blue-green-services.sh')
    expect(deployScript).toContain('check_routed_readonly_endpoint /materials page')
    expect(deployScript).toContain('check_routed_readonly_endpoint /api/tasks api')
    expect(retireBody).toContain('$DRAIN_PATH')
    expect(retireBody).toContain('$SCHEDULER_PATH')
    expect(retireBody).not.toContain('$READINESS_PATH')
    expect(retireBody).toContain('verify_active_director_projection_chain')
    expect(retireBody.indexOf('wait_for_frozen_retirement_quiescence'))
      .toBeLessThan(retireBody.indexOf('verify_active_director_projection_chain'))
    expect(retireBody.indexOf('verify_active_director_projection_chain'))
      .toBeLessThan(retireBody.indexOf('"$manager" stop "$slot"'))
    expect(deployScript).toContain('slot_established_connection_count')
    expect(deployScript).toContain('-sTCP:ESTABLISHED')
    const frozenWaitBody = deployScript.slice(
      deployScript.indexOf('wait_for_frozen_retirement_quiescence()'),
      deployScript.indexOf('check_legacy_databases_quiescent()'),
    )
    expect(frozenWaitBody).toContain('check_json_endpoint drain')
    expect(frozenWaitBody).toContain('check_json_endpoint scheduler')
    expect(frozenWaitBody).toContain('assert_router_identity')
    expect(frozenWaitBody).toContain('slot_established_connection_count')
  })

  it('fails closed if the atomically replaced state selects a non-loopback backend', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-router-invalid-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const blue = await listen(backend('blue'))
    const green = await listen(backend('green'))
    const stateFile = join(root, 'router-state.json')
    writeRouterStateAtomic(stateFile, state(blue.port, green.port))
    const router = await listen(createStandaloneRouter({ stateFile }))
    const invalid = state(blue.port, green.port)
    invalid.slots.blue.host = '192.0.2.10'
    const temporary = `${stateFile}.replacement`
    writeFileSync(temporary, `${JSON.stringify(invalid)}\n`, { mode: 0o600 })
    renameSync(temporary, stateFile)

    const response = await fetch(`http://127.0.0.1:${router.port}/login`)
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({
      ok: false,
      code: 'N8N_ROUTER_STATE_UNAVAILABLE',
      error: '路由状态暂时不可用',
    })
  })
})
