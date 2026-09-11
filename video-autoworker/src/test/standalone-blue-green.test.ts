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
import type { Duplex } from 'node:stream'
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

function cleanDeployScriptFixture(root: string, prefixed = false): string {
  const gitRoot = join(root, 'repository')
  const repository = prefixed ? join(gitRoot, 'video-autoworker') : gitRoot
  mkdirSync(repository, { recursive: true, mode: 0o700 })
  cpSync(resolve(process.cwd(), 'scripts'), join(repository, 'scripts'), { recursive: true })
  mkdirSync(join(repository, 'ops', 'n8n'), { recursive: true, mode: 0o700 })
  cpSync(
    resolve(process.cwd(), 'ops/n8n/workflows'),
    join(repository, 'ops/n8n/workflows'),
    { recursive: true },
  )
  mkdirSync(join(repository, 'ops', 'recovery'), { recursive: true, mode: 0o700 })
  cpSync(
    resolve(process.cwd(), 'ops/recovery/install-blue-green-execve-adapter.mjs'),
    join(repository, 'ops/recovery/install-blue-green-execve-adapter.mjs'),
  )
  writeFileSync(join(repository, 'package.json'), '{"name":"video-autoworker"}\n')
  writeFileSync(join(repository, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  writeFileSync(join(repository, 'next.config.js'), 'export default {}\n')
  execFileSync('git', ['init', '-b', 'main'], { cwd: gitRoot, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Blue Green Test'], { cwd: gitRoot })
  execFileSync('git', ['config', 'user.email', 'blue-green-test@example.invalid'], { cwd: gitRoot })
  execFileSync('git', ['add', '.'], { cwd: gitRoot })
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: gitRoot, stdio: 'ignore' })
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

function rawHttp(port: number, lines: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(port, '127.0.0.1')
    let response = ''
    socket.once('error', reject)
    socket.once('connect', () => socket.end(`${lines.join('\r\n')}\r\n\r\n`))
    socket.on('data', data => { response += data.toString() })
    socket.once('close', () => resolvePromise(response))
  })
}

type RouterHealth = {
  counters: Record<'blue' | 'green', {
    requests: number
    activeRequests: number
    upgradedSockets: number
  }>
} & Record<string, unknown>

async function waitForRouterCounter(
  port: number,
  slot: 'blue' | 'green',
  field: 'activeRequests' | 'upgradedSockets',
  expected: number,
): Promise<RouterHealth> {
  let health: RouterHealth | null = null
  for (let attempt = 0; attempt < 100; attempt += 1) {
    health = await fetch(`http://127.0.0.1:${port}/__router/health`)
      .then(response => response.json()) as RouterHealth
    if (health.counters?.[slot]?.[field] === expected) return health
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
  }
  throw new Error(`router counter did not reach ${slot}.${field}=${expected}`)
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
      'n8n-stop.sh"',
      'n8n-install.sh"',
      'n8n-backup-managed-workflows.mjs" backup',
      'n8n-workflow-transition-anchor.mjs" prepare-intent',
      'n8n-workflow-transition-anchor.mjs" current-confirm',
      'n8n-import-workflows.sh"',
      'n8n-start.sh"',
      'node "$repository_root/scripts/verify-n8n-blue-green-workflows.mjs"',
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

  it('keeps stage copy boundaries fully audited and fast-checks repeated transition assertions', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-verification-counts-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const sourceRoot = join(root, 'source')
    const releasesRoot = join(root, 'releases')
    const runRoot = join(root, 'run')
    mkdirSync(sourceRoot, { mode: 0o700 })
    mkdirSync(releasesRoot, { mode: 0o700 })
    mkdirSync(runRoot, { mode: 0o700 })
    writeFileSync(join(sourceRoot, 'release-manifest.json'), '{"schemaVersion":2}\n', { mode: 0o600 })
    writeFileSync(join(sourceRoot, 'release-provenance.json'), '{}\n', { mode: 0o600 })
    const auditor = join(root, 'auditor.mjs')
    writeFileSync(auditor, `
if (process.argv[2] === '--verify-bundle') {
  const value = JSON.parse(process.argv[4] || 'null')
  process.exit(value?.schema === 'video-autoworker-standalone-verification-bundle/v1' ? 0 : 2)
}
if (process.argv[2] === '--write-manifest') process.exit(0)
process.stdout.write(JSON.stringify({ok:true,verificationBundle:{
  schema:'video-autoworker-standalone-verification-bundle/v1',bundleSha256:'${'a'.repeat(64)}'
}})+'\\n')
`)
    const deploy = readFileSync(resolve('scripts/deploy-blue-green.sh'), 'utf8')
    const prelude = deploy.slice(0, deploy.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'verification-counts.sh')
    writeFileSync(harness, `${prelude}
AUDITOR="$1"
RUN_DIR="$2"
RELEASES_DIR="$3"
NODE_BIN="$4"
source_root="$5"
acquire_lock() {
  prepare_run_dir
  ensure_release_verification_cache
}
stage_release release-test "$source_root"
published="$RELEASES_DIR/release-test/standalone"
assert_release release-test "$published" >/dev/null
assert_release release-test "$published" >/dev/null
printf 'COUNTS_BEFORE full=%s fast=%s fallback=%s\\n' \
  "$(cat "$RELEASE_VERIFICATION_CACHE_DIR/full")" \
  "$(cat "$RELEASE_VERIFICATION_CACHE_DIR/fast")" \
  "$(cat "$RELEASE_VERIFICATION_CACHE_DIR/fallback")"
cache="$(release_verification_cache_path "$published")"
printf '{}\\n' > "$cache"
assert_release release-test "$published" >/dev/null
printf 'COUNTS_AFTER full=%s fast=%s fallback=%s\\n' \
  "$(cat "$RELEASE_VERIFICATION_CACHE_DIR/full")" \
  "$(cat "$RELEASE_VERIFICATION_CACHE_DIR/fast")" \
  "$(cat "$RELEASE_VERIFICATION_CACHE_DIR/fallback")"
`, { mode: 0o700 })
    chmodSync(harness, 0o700)
    const result = spawnSync('/bin/bash', [
      harness, auditor, runRoot, releasesRoot, process.execPath, sourceRoot,
    ], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('COUNTS_BEFORE full=2 fast=3 fallback=0')
    expect(result.stdout).toContain('COUNTS_AFTER full=3 fast=3 fallback=1')
  })

  it.each([
    ['success', 0, false],
    ['probe-failure', 1, true],
    ['attest-failure', 1, false],
    ['switch-compensated', 1, false],
  ])('settles the operation-owned candidate for transition-app: %s', (mode, expectedStatus, stopped) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-transition-app-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const events = join(root, 'events')
    const deploy = readFileSync(resolve('scripts/deploy-blue-green.sh'), 'utf8')
    const prelude = deploy.slice(0, deploy.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'transition-app.sh')
    writeFileSync(harness, `${prelude}
MODE="$1"
EVENTS="$2"
ACTIVE=green
BOUND=release-old
GENERATION=7
record_event() { printf '%s\n' "$*" >> "$EVENTS"; }
require_slot() { printf '%s\n' "$1"; }
acquire_lock() {
  if [[ "\${DEPLOYMENT_LOCK_OWNED:-0}" == 1 ]]; then record_event acquire-reused; return; fi
  record_event acquire; DEPLOYMENT_LOCK_OWNED=1; trap cleanup_operation EXIT
}
release_shared_deployment_lock() { record_event release-lock; DEPLOYMENT_LOCK_OWNED=0; }
validate_state() { record_event validate; }
managed_runtime_paths() { :; }
read_state_field() {
  case "$1" in active) printf '%s\n' "$ACTIVE" ;; generation) printf '%s\n' "$GENERATION" ;; previous) printf 'green\n' ;; esac
}
read_state_slot_release() { if [[ "$1" == blue ]]; then printf '%s\n' "$BOUND"; else printf 'release-source\n'; fi; }
retire_slot() { record_event "retire:$1"; acquire_lock; }
bind_slot() { record_event "bind:$1:$2"; acquire_lock; BOUND="$2"; }
normal_service_manager() { record_event "manager:$*"; return 0; }
probe_slot() { record_event "probe:$1"; [[ "$MODE" != probe-failure ]]; }
prewarm_slot() { record_event "prewarm:$1"; }
switch_slot() {
  record_event "switch:$1"; acquire_lock
  if [[ "$MODE" == switch-compensated ]]; then ACTIVE=green; GENERATION=9; return 1; fi
  ACTIVE="$1"; GENERATION=8
}
attest_current() { record_event attest; [[ "$MODE" != attest-failure ]]; }
transition_app blue release-new /release/new
`, { mode: 0o700 })
    chmodSync(harness, 0o700)
    const result = spawnSync('/bin/bash', [harness, mode, events], {
      encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath },
    })
    expect(result.status === 0 ? 0 : 1, result.stderr).toBe(expectedStatus)
    const sequence = readFileSync(events, 'utf8').trim().split('\n')
    expect(sequence.slice(0, 10)).toEqual([
      'acquire', 'validate', 'retire:blue', 'acquire-reused',
      'bind:blue:release-new', 'acquire-reused', 'manager:start blue',
      'probe:blue', ...(mode === 'probe-failure'
        ? ['manager:stop blue', 'release-lock'] : ['prewarm:blue', 'switch:blue']),
    ])
    expect(sequence.includes('manager:stop blue')).toBe(stopped)
    if (mode === 'success') expect(sequence).toContain('attest')
    if (mode !== 'probe-failure') {
      expect(sequence.indexOf('prewarm:blue')).toBeLessThan(sequence.indexOf('switch:blue'))
      expect(sequence.filter(item => item === 'acquire')).toHaveLength(1)
      expect(sequence.filter(item => item === 'acquire-reused')).toHaveLength(3)
    }
    if (mode === 'attest-failure') {
      expect(sequence).toContain('attest')
      expect(sequence).not.toContain('manager:stop blue')
      expect(result.stdout).toContain('Route commit observed')
    }
    if (mode === 'switch-compensated') {
      expect(sequence).not.toContain('manager:stop blue')
      expect(result.stderr).toContain('Route commit was compensated before settlement')
    }
  })

  it('prewarms only candidate health and one manifest-bound static asset', async () => {
    const requests: string[] = []
    const endpoint = await listen(createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`)
      if (request.url === '/api/status?action=health') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ status: 'healthy',
          checks: [{ name: 'Database', status: 'healthy' }] }))
        return
      }
      if (request.url === '/_next/static/chunk.js' && request.method === 'HEAD') {
        response.statusCode = 200; response.end(); return
      }
      response.statusCode = 404; response.end()
    }))
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-prewarm-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const release = join(root, 'release')
    const database = join(root, 'mission-control.db')
    mkdirSync(release, { mode: 0o700 })
    writeFileSync(join(release, 'release-manifest.json'), JSON.stringify({
      files: [{ path: '.next/static/chunk.js' }],
    }), { mode: 0o600 })
    writeFileSync(database, 'database-sentinel\n', { mode: 0o600 })
    const before = createHash('sha256').update(readFileSync(database)).digest('hex')
    const deploy = readFileSync(resolve('scripts/deploy-blue-green.sh'), 'utf8')
    const prelude = deploy.slice(0, deploy.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'prewarm.sh')
    writeFileSync(harness, `${prelude}
binding_values() { printf 'release-new\n${release}\nmanifest\n127.0.0.1\n${endpoint.port}\n'; }
slot_port() { printf '${endpoint.port}\n'; }
prewarm_slot blue
`, { mode: 0o700 })
    chmodSync(harness, 0o700)
    const result = await execFileAsync('/bin/bash', [harness], {
      encoding: 'utf8', env: { ...process.env, NODE_BIN: process.execPath },
    })
    expect(result.stdout).toContain('sideEffects=unverified contract=read-only')
    expect(requests).toEqual([
      'GET /api/status?action=health', 'HEAD /_next/static/chunk.js',
    ])
    expect(createHash('sha256').update(readFileSync(database)).digest('hex')).toBe(before)
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

  it('settles HTTP activity once when the backend aborts or the client cancels', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-router-http-settlement-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const abnormalBackend = createServer((request, response) => {
      if (request.url === '/backend-abort') {
        response.writeHead(200, { 'content-length': '100' })
        response.write('partial')
        setTimeout(() => response.socket?.destroy(), 10)
        return
      }
      if (request.url === '/client-cancel') {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write('started\n')
        return
      }
      response.end('ok')
    })
    const blue = await listen(abnormalBackend)
    const green = await listen(backend('green'))
    const stateFile = join(root, 'router-state.json')
    writeRouterStateAtomic(stateFile, state(blue.port, green.port))
    const router = await listen(createStandaloneRouter({ stateFile }))

    await expect(fetch(`http://127.0.0.1:${router.port}/backend-abort`)
      .then(response => response.text())).rejects.toThrow()
    await waitForRouterCounter(router.port, 'blue', 'activeRequests', 0)

    const cancellation = new AbortController()
    const response = await fetch(`http://127.0.0.1:${router.port}/client-cancel`, {
      signal: cancellation.signal,
    })
    await waitForRouterCounter(router.port, 'blue', 'activeRequests', 1)
    cancellation.abort()
    await expect(response.text()).rejects.toThrow()
    const health = await waitForRouterCounter(router.port, 'blue', 'activeRequests', 0)
    expect(health.counters.blue).toMatchObject({ requests: 2, activeRequests: 0 })
  })

  it('settles an upgraded socket once when either side closes early', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-router-upgrade-settlement-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const earlyCloseBackend = createServer((_request, response) => response.end('ok'))
    const backendSockets = new Set<Duplex>()
    earlyCloseBackend.on('upgrade', (_request, socket) => {
      backendSockets.add(socket)
      socket.once('close', () => backendSockets.delete(socket))
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: test',
        '',
        'connected\n',
      ].join('\r\n'))
    })
    const blue = await listen(earlyCloseBackend)
    const green = await listen(backend('green'))
    const stateFile = join(root, 'router-state.json')
    writeRouterStateAtomic(stateFile, state(blue.port, green.port))
    const router = await listen(createStandaloneRouter({ stateFile }))

    const upgraded = await upgrade(router.port)
    await waitForRouterCounter(router.port, 'blue', 'upgradedSockets', 1)
    const [backendSocket] = backendSockets
    if (!backendSocket) throw new Error('backend upgrade socket was not retained')
    backendSocket.destroy()
    await new Promise<void>(resolvePromise => upgraded.socket.once('close', () => resolvePromise()))
    const health = await waitForRouterCounter(router.port, 'blue', 'upgradedSockets', 0)
    expect(health.counters.blue).toMatchObject({ upgradedSockets: 0 })
  })

  it('preserves the validated browser Host for same-origin CSRF and strips forged forwarding identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-router-origin-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const received: Array<Record<string, string | string[] | undefined>> = []
    const csrfBackend = createServer((request, response) => {
      received.push(request.headers)
      const originHost = request.headers.origin ? new URL(request.headers.origin).host : ''
      if (originHost !== request.headers.host) {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end('{"error":"CSRF origin mismatch"}\n')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{"ok":true}\n')
    })
    const blue = await listen(csrfBackend)
    const green = await listen(backend('green'))
    const stateFile = join(root, 'router-state.json')
    writeRouterStateAtomic(stateFile, state(blue.port, green.port))
    const router = await listen(createStandaloneRouter({ stateFile }))
    const publicOrigin = `http://127.0.0.1:${router.port}`

    const sameOrigin = await fetch(`${publicOrigin}/api/n8n/intake-control`, {
      method: 'POST',
      headers: {
        origin: publicOrigin,
        forwarded: 'host=evil.example.test',
        'x-forwarded-host': 'evil.example.test',
        'x-forwarded-port': '443',
        'x-forwarded-proto': 'https',
        'x-forwarded-for': '192.0.2.1',
        'x-original-host': 'evil.example.test',
        'x-forwarded-server': 'evil.example.test',
      },
    })
    expect(sameOrigin.status).toBe(200)
    await expect(sameOrigin.json()).resolves.toEqual({ ok: true })
    expect(received[0]?.host).toBe(`127.0.0.1:${router.port}`)
    for (const name of ['forwarded', 'x-forwarded-host', 'x-forwarded-port',
      'x-forwarded-proto', 'x-forwarded-for', 'x-original-host', 'x-forwarded-server']) {
      expect(received[0]?.[name]).toBeUndefined()
    }

    const crossOrigin = await fetch(`${publicOrigin}/api/n8n/intake-control`, {
      method: 'POST', headers: { origin: 'https://evil.example.test' },
    })
    expect(crossOrigin.status).toBe(403)
    await expect(crossOrigin.json()).resolves.toEqual({ error: 'CSRF origin mismatch' })

    const invalidHost = await rawHttp(router.port, [
      'POST /api/n8n/intake-control HTTP/1.1',
      `Host: 127.0.0.1:${router.port},evil.example.test`,
      `Origin: ${publicOrigin}`,
      'Connection: close',
    ])
    expect(invalidHost).toContain('HTTP/1.1 400 Bad Request')
    expect(received).toHaveLength(2)
  })

  it('rejects duplicate Host before proxying and preserves trusted Host for WebSocket upgrades', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-router-host-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    let upgradedHeaders: Record<string, string | string[] | undefined> = {}
    const blueServer = backend('blue')
    blueServer.removeAllListeners('upgrade')
    blueServer.on('upgrade', (request, socket) => {
      upgradedHeaders = request.headers
      socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\nblue\n')
    })
    const blue = await listen(blueServer)
    const green = await listen(backend('green'))
    const stateFile = join(root, 'router-state.json')
    writeRouterStateAtomic(stateFile, state(blue.port, green.port))
    const router = await listen(createStandaloneRouter({ stateFile }))

    const duplicate = await rawHttp(router.port, [
      'POST /api/test HTTP/1.1',
      `Host: 127.0.0.1:${router.port}`,
      'Host: evil.example.test',
      'Connection: close',
    ])
    expect(duplicate).toContain('HTTP/1.1 400 Bad Request')

    const socket = connect(router.port, '127.0.0.1')
    cleanup.push(() => socket.destroy())
    let response = ''
    await new Promise<void>((resolvePromise, reject) => {
      socket.once('error', reject)
      socket.once('connect', () => socket.write([
        'GET /socket HTTP/1.1',
        `Host: 127.0.0.1:${router.port}`,
        'Connection: Upgrade',
        'Upgrade: test',
        'Forwarded: host=evil.example.test',
        'X-Forwarded-Host: evil.example.test',
        'X-Forwarded-For: 192.0.2.1',
        '',
        '',
      ].join('\r\n')))
      socket.on('data', data => {
        response += data.toString()
        if (response.includes('\r\n\r\n')) resolvePromise()
      })
    })
    expect(response).toContain('101 Switching Protocols')
    expect(upgradedHeaders.host).toBe(`127.0.0.1:${router.port}`)
    expect(upgradedHeaders.forwarded).toBeUndefined()
    expect(upgradedHeaders['x-forwarded-host']).toBeUndefined()
    expect(upgradedHeaders['x-forwarded-for']).toBeUndefined()
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

  it('uses a configurable startup window instead of the old fixed ten-second wait', () => {
    const manager = resolve(process.cwd(), 'scripts/manage-blue-green-services.sh')
    const source = readFileSync(manager, 'utf8')
    const invalid = spawnSync('bash', [manager, 'status'], {
      encoding: 'utf8',
      env: { ...process.env, AIWORKER_BG_STARTUP_WAIT_SECONDS: '9' },
    })

    expect(invalid.status).not.toBe(0)
    expect(invalid.stderr).toContain(
      'AIWORKER_BG_STARTUP_WAIT_SECONDS must be between 10 and 3600',
    )
    expect(source).toContain('AIWORKER_BG_STARTUP_WAIT_SECONDS:-90')
    expect(source).toContain('STARTUP_WAIT_ATTEMPTS=$((10#$STARTUP_WAIT_SECONDS * 10))')
    expect(source).toContain('_attempt < STARTUP_WAIT_ATTEMPTS')
  })

  it('rejects an invalid authorized maintenance replacement mode before creating state', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-maintenance-replace-config-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = cleanDeployScriptFixture(root)
    const runDir = join(root, 'run')

    const result = spawnSync('bash', [script, 'init', 'blue'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AIWORKER_BG_RUN_DIR: runDir,
        AIWORKER_BG_RELEASES_DIR: join(root, 'releases'),
        AIWORKER_BG_AUTHORIZED_LEGACY_STOP: '2',
        NODE_BIN: process.execPath,
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('AIWORKER_BG_AUTHORIZED_LEGACY_STOP must be 0 or 1')
    expect(existsSync(join(runDir, 'router-state.json'))).toBe(false)
  })

  it('skips only the retirement projection check in authorized maintenance replacement mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-maintenance-replace-policy-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'maintenance-replace-policy.sh')
    const eventsFile = join(root, 'events')
    writeFileSync(harness, `${functionPrelude}
EVENTS_FILE="$1"
verify_active_director_projection_chain() {
  printf 'projection-check\\n' >> "$EVENTS_FILE"
  return 1
}
AUTHORIZED_LEGACY_STOP=0
if verify_retirement_projection_compatibility; then
  printf 'strict mode accepted a failed projection check\\n' >&2
  exit 9
fi
AUTHORIZED_LEGACY_STOP=1
verify_retirement_projection_compatibility
`)

    const result = spawnSync('bash', [harness, eventsFile], {
      env: { ...process.env, NODE_BIN: process.execPath },
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('current projection-chain source compatibility check skipped')
    expect(readFileSync(eventsFile, 'utf8').trim().split('\n')).toEqual(['projection-check'])
  })

  it('binds the unchanged product directory inside a prefixed repository tree', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-router-prefixed-cli-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = cleanDeployScriptFixture(root, true)
    const productRoot = join(root, 'repository', 'video-autoworker')
    const helper = join(productRoot, 'scripts/lib/git-source-layout.mjs')
    const bootstrap = join(productRoot, 'scripts/lib/git-source-layout.sh')
    const result = spawnSync(process.execPath, [helper, 'assert-clean', productRoot], {
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({
      gitRoot: join(root, 'repository'),
      productRoot,
      productPrefix: 'video-autoworker/',
    })
    const bootstrapResult = spawnSync('bash', [
      '-c', 'source "$1"; assert_git_source_layout_helper_bootstrap "$2" "$3"',
      'layout-bootstrap', bootstrap, productRoot, process.execPath,
    ], { encoding: 'utf8' })
    expect(bootstrapResult.status, bootstrapResult.stderr).toBe(0)
    expect(readFileSync(script, 'utf8')).toContain('assert_git_source_layout_helper_bootstrap')
  })

  it.each([
    ['self drift', 'scripts/deploy-blue-green.sh', false,
      'git_source_layout_verification_file_mismatch:scripts/deploy-blue-green.sh'],
    ['preinstall orchestrator drift', 'scripts/legacy-preinstall-orchestrator.mjs', false,
      'git_source_layout_verification_file_mismatch:scripts/legacy-preinstall-orchestrator.mjs'],
    ['private Gateway RPC helper drift', 'scripts/lib/openclaw-private-gateway-rpc.mjs', false,
      'git_source_layout_verification_file_mismatch:scripts/lib/openclaw-private-gateway-rpc.mjs'],
    ['managed Markdown renderer drift', 'scripts/lib/render-managed-markdown-section.mjs', false,
      'git_source_layout_verification_file_mismatch:scripts/lib/render-managed-markdown-section.mjs'],
    ['runtime tree manifest helper drift', 'scripts/lib/runtime-tree-manifest.mjs', false,
      'git_source_layout_verification_file_mismatch:scripts/lib/runtime-tree-manifest.mjs'],
    ['dirty worktree', 'scripts/standalone-router.mjs', false,
      'git_source_layout_worktree_not_clean'],
    ['dirty index', 'scripts/standalone-router.mjs', true,
      'git_source_layout_worktree_not_clean'],
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

  it('propagates one precedence-resolved OpenClaw scope to full readiness and slots without leaking other values', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-scope-precedence-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const project = join(root, 'project')
    const scripts = join(project, 'scripts')
    const platformEnv = join(root, 'custom-platform.env')
    const capture = join(root, 'readiness-scope.txt')
    mkdirSync(scripts, { recursive: true, mode: 0o700 })
    writeFileSync(join(project, '.env'), [
      'MC_AUTH_MODE=openclaw-loopback',
      'MC_OPENCLAW_TENANT_ID=11',
      'MC_OPENCLAW_WORKSPACE_ID=12',
      'SCOPE_FIXTURE_SECRET=base-must-not-leak',
      '',
    ].join('\n'), { mode: 0o600 })
    writeFileSync(join(project, '.env.local'), [
      'MC_OPENCLAW_WORKSPACE_ID=22',
      'SCOPE_FIXTURE_SECRET=local-must-not-leak',
      '',
    ].join('\n'), { mode: 0o600 })
    writeFileSync(platformEnv, [
      'MC_OPENCLAW_TENANT_ID=31',
      'SCOPE_FIXTURE_SECRET=platform-must-not-leak',
      '',
    ].join('\n'), { mode: 0o600 })
    const readiness = join(scripts, 'verify-director-video-release-readiness.mjs')
    writeFileSync(readiness, '// fixture path checked by the real deploy function\n', { mode: 0o600 })

    const deploySource = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const deployHarness = join(scripts, 'scope-full-harness.sh')
    writeFileSync(deployHarness, `${deploySource.slice(0, deploySource.indexOf('\ncommand="${1:-}"'))}
CAPTURE_PATH="$1"
scope_node() {
  if [[ "$1" == "$DIRECTOR_VIDEO_READINESS" ]]; then
    printf '%s\\t%s\\t%s\\n' "$MC_AUTH_MODE" "$MC_OPENCLAW_TENANT_ID" "$MC_OPENCLAW_WORKSPACE_ID" > "$CAPTURE_PATH"
    printf '{}'
    return 0
  fi
  [[ "$1" == - ]]
}
NODE_BIN=scope_node
verify_director_video_release_chain '${'a'.repeat(40)}-runtime' "$PROJECT_ROOT/release" head
`, { mode: 0o700 })
    chmodSync(deployHarness, 0o700)

    const slotSource = readFileSync(resolve(process.cwd(), 'scripts/start-standalone-slot.sh'), 'utf8')
    const slotHarness = join(scripts, 'scope-slot-harness.sh')
    writeFileSync(slotHarness, `${slotSource.slice(0, slotSource.indexOf('\nBINDING_FILE='))}
printf '%s\\t%s\\t%s\\n' "$MC_AUTH_MODE" "$MC_OPENCLAW_TENANT_ID" "$MC_OPENCLAW_WORKSPACE_ID"
`, { mode: 0o700 })
    chmodSync(slotHarness, 0o700)

    const environment = {
      ...process.env,
      HOME: root,
      AIWORKER_PLATFORM_ENV_FILE: platformEnv,
      MC_AUTH_MODE: '',
      MC_OPENCLAW_TENANT_ID: '',
      MC_OPENCLAW_WORKSPACE_ID: '',
      SCOPE_FIXTURE_SECRET: '',
    }
    const full = spawnSync('/bin/bash', [deployHarness, capture], {
      encoding: 'utf8', env: environment,
    })
    const slot = spawnSync('/bin/bash', [slotHarness, 'blue', 'probe'], {
      encoding: 'utf8', env: environment,
    })

    expect(full.status, full.stderr).toBe(0)
    expect(slot.status, slot.stderr).toBe(0)
    expect(readFileSync(capture, 'utf8')).toBe('openclaw-loopback\t31\t22\n')
    expect(slot.stdout).toBe('openclaw-loopback\t31\t22\n')
    const visible = `${full.stdout}\n${full.stderr}\n${slot.stdout}\n${slot.stderr}\n${readFileSync(capture, 'utf8')}`
    expect(visible).not.toContain('must-not-leak')
    expect(readFileSync(platformEnv, 'utf8')).toContain('platform-must-not-leak')
  })

  it('defaults full readiness and slot scope to OpenClaw loopback 1/1 when scope files are absent', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-scope-default-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const project = join(root, 'project')
    const scripts = join(project, 'scripts')
    const capture = join(root, 'readiness-scope.txt')
    const missingPlatform = join(root, 'missing-platform.env')
    mkdirSync(scripts, { recursive: true, mode: 0o700 })
    writeFileSync(join(scripts, 'verify-director-video-release-readiness.mjs'), '// fixture\n', { mode: 0o600 })

    const deploySource = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const deployHarness = join(scripts, 'scope-full-harness.sh')
    writeFileSync(deployHarness, `${deploySource.slice(0, deploySource.indexOf('\ncommand="${1:-}"'))}
CAPTURE_PATH="$1"
scope_node() {
  if [[ "$1" == "$DIRECTOR_VIDEO_READINESS" ]]; then
    printf '%s\\t%s\\t%s\\n' "$MC_AUTH_MODE" "$MC_OPENCLAW_TENANT_ID" "$MC_OPENCLAW_WORKSPACE_ID" > "$CAPTURE_PATH"
    printf '{}'
    return 0
  fi
  [[ "$1" == - ]]
}
NODE_BIN=scope_node
verify_director_video_release_chain '${'a'.repeat(40)}-runtime' "$PROJECT_ROOT/release" head
`, { mode: 0o700 })
    chmodSync(deployHarness, 0o700)
    const slotSource = readFileSync(resolve(process.cwd(), 'scripts/start-standalone-slot.sh'), 'utf8')
    const slotHarness = join(scripts, 'scope-slot-harness.sh')
    writeFileSync(slotHarness, `${slotSource.slice(0, slotSource.indexOf('\nBINDING_FILE='))}
printf '%s\\t%s\\t%s\\n' "$MC_AUTH_MODE" "$MC_OPENCLAW_TENANT_ID" "$MC_OPENCLAW_WORKSPACE_ID"
`, { mode: 0o700 })
    chmodSync(slotHarness, 0o700)
    const environment = {
      ...process.env,
      HOME: root,
      AIWORKER_PLATFORM_ENV_FILE: missingPlatform,
      MC_AUTH_MODE: '',
      MC_OPENCLAW_TENANT_ID: '',
      MC_OPENCLAW_WORKSPACE_ID: '',
    }

    const full = spawnSync('/bin/bash', [deployHarness, capture], { encoding: 'utf8', env: environment })
    const slot = spawnSync('/bin/bash', [slotHarness, 'green', 'probe'], { encoding: 'utf8', env: environment })
    expect(full.status, full.stderr).toBe(0)
    expect(slot.status, slot.stderr).toBe(0)
    expect(readFileSync(capture, 'utf8')).toBe('openclaw-loopback\t1\t1\n')
    expect(slot.stdout).toBe('openclaw-loopback\t1\t1\n')
    expect(existsSync(missingPlatform)).toBe(false)
  })

  it('preflights explicit managed data paths and rejects a missing database', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-runtime-paths-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const project = join(root, 'project')
    const scripts = join(project, 'scripts')
    const runtime = join(root, 'runtime')
    const database = join(runtime, 'mission-control.db')
    const tokens = join(runtime, 'tokens.json')
    const platform = join(root, 'platform.env')
    mkdirSync(scripts, { recursive: true, mode: 0o700 })
    mkdirSync(runtime, { mode: 0o700 })
    writeFileSync(database, 'sqlite-fixture\n', { mode: 0o600 })
    writeFileSync(tokens, '{}\n', { mode: 0o600 })
    writeFileSync(platform, [
      `MISSION_CONTROL_DATA_DIR=${runtime}`,
      `MISSION_CONTROL_DB_PATH=${database}`,
      `MISSION_CONTROL_TOKENS_PATH=${tokens}`,
      '',
    ].join('\n'), { mode: 0o600 })
    const source = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const harness = join(scripts, 'runtime-path-harness.sh')
    writeFileSync(harness, `${source.slice(0, source.indexOf('\ncommand="${1:-}"'))}
managed_runtime_paths
`, { mode: 0o700 })
    chmodSync(harness, 0o700)
    const environment = { ...process.env, AIWORKER_PLATFORM_ENV_FILE: platform,
      AIWORKER_BG_RELEASES_DIR: join(root, 'releases'), AIWORKER_BG_LIVE_DB_PATH: database,
      NODE_BIN: process.execPath }
    const valid = spawnSync('/bin/bash', [harness], { encoding: 'utf8', env: environment })
    expect(valid.status, valid.stderr).toBe(0)
    expect(valid.stdout).toBe(`${runtime}\n${database}\n${tokens}\n`)
    rmSync(database)
    const missing = spawnSync('/bin/bash', [harness], { encoding: 'utf8', env: environment })
    expect(missing.status).not.toBe(0)
    writeFileSync(database, 'sqlite-fixture\n', { mode: 0o600 })
    const linkedRuntime = join(root, 'linked-runtime')
    symlinkSync(runtime, linkedRuntime)
    writeFileSync(platform, [
      `MISSION_CONTROL_DATA_DIR=${linkedRuntime}`,
      `MISSION_CONTROL_DB_PATH=${join(linkedRuntime, 'mission-control.db')}`,
      `MISSION_CONTROL_TOKENS_PATH=${join(linkedRuntime, 'tokens.json')}`,
      '',
    ].join('\n'), { mode: 0o600 })
    const linked = spawnSync('/bin/bash', [harness], { encoding: 'utf8', env: environment })
    expect(linked.status).not.toBe(0)
  })

  it('suppresses sourced scope-file output while preserving its full-readiness assignments', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-scope-source-output-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const project = join(root, 'project')
    const scripts = join(project, 'scripts')
    const capture = join(root, 'readiness-scope.txt')
    const missingPlatform = join(root, 'missing-platform.env')
    const stdoutSecret = 'synthetic-scope-stdout-secret'
    const stderrSecret = 'synthetic-scope-stderr-secret'
    mkdirSync(scripts, { recursive: true, mode: 0o700 })
    writeFileSync(join(project, '.env'), [
      `printf '${stdoutSecret}\\n'`,
      `printf '${stderrSecret}\\n' >&2`,
      'MC_AUTH_MODE=openclaw-loopback',
      'MC_OPENCLAW_TENANT_ID=41',
      'MC_OPENCLAW_WORKSPACE_ID=42',
      '',
    ].join('\n'), { mode: 0o600 })
    writeFileSync(join(scripts, 'verify-director-video-release-readiness.mjs'), '// fixture\n', { mode: 0o600 })
    const deploySource = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const harness = join(scripts, 'scope-full-harness.sh')
    writeFileSync(harness, `${deploySource.slice(0, deploySource.indexOf('\ncommand="${1:-}"'))}
CAPTURE_PATH="$1"
scope_node() {
  if [[ "$1" == "$DIRECTOR_VIDEO_READINESS" ]]; then
    printf '%s\\t%s\\t%s\\n' "$MC_AUTH_MODE" "$MC_OPENCLAW_TENANT_ID" "$MC_OPENCLAW_WORKSPACE_ID" > "$CAPTURE_PATH"
    printf '{}'
    return 0
  fi
  [[ "$1" == - ]]
}
NODE_BIN=scope_node
verify_director_video_release_chain '${'a'.repeat(40)}-runtime' "$PROJECT_ROOT/release" head
`, { mode: 0o700 })
    chmodSync(harness, 0o700)

    const result = spawnSync('/bin/bash', [harness, capture], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        AIWORKER_PLATFORM_ENV_FILE: missingPlatform,
        MC_AUTH_MODE: '',
        MC_OPENCLAW_TENANT_ID: '',
        MC_OPENCLAW_WORKSPACE_ID: '',
      },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(capture, 'utf8')).toBe('openclaw-loopback\t41\t42\n')
    expect(`${result.stdout}\n${result.stderr}\n${readFileSync(capture, 'utf8')}`)
      .not.toMatch(/synthetic-scope-(?:stdout|stderr)-secret/u)
  })

  it.each([
    ['symlinked .env', '.env', 'symlink'],
    ['non-0600 .env', '.env', 'mode'],
    ['symlinked .env.local', '.env.local', 'symlink'],
    ['non-0600 .env.local', '.env.local', 'mode'],
    ['symlinked platform env', 'platform.env', 'symlink'],
    ['non-0600 platform env', 'platform.env', 'mode'],
  ] as const)('rejects %s before full readiness without exposing its contents', (_label, relative, kind) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-scope-unsafe-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const project = join(root, 'project')
    const scripts = join(project, 'scripts')
    const platformEnv = join(root, 'platform.env')
    const capture = join(root, 'must-not-exist.txt')
    mkdirSync(scripts, { recursive: true, mode: 0o700 })
    writeFileSync(join(scripts, 'verify-director-video-release-readiness.mjs'), '// fixture\n', { mode: 0o600 })
    const pathname = relative === 'platform.env' ? platformEnv : join(project, relative)
    const secret = 'scope-secret-must-not-be-exposed'
    if (kind === 'symlink') {
      const target = join(root, `${relative.replaceAll('.', '-')}-target`)
      writeFileSync(target, `SCOPE_FIXTURE_SECRET=${secret}\n`, { mode: 0o600 })
      symlinkSync(target, pathname)
    } else {
      writeFileSync(pathname, `SCOPE_FIXTURE_SECRET=${secret}\n`, { mode: 0o600 })
      chmodSync(pathname, 0o640)
    }
    const deploySource = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const harness = join(scripts, 'scope-full-harness.sh')
    writeFileSync(harness, `${deploySource.slice(0, deploySource.indexOf('\ncommand="${1:-}"'))}
CAPTURE_PATH="$1"
scope_node() { printf 'unexpected verifier call' > "$CAPTURE_PATH"; }
NODE_BIN=scope_node
verify_director_video_release_chain '${'a'.repeat(40)}-runtime' "$PROJECT_ROOT/release" head
`, { mode: 0o700 })
    chmodSync(harness, 0o700)

    const result = spawnSync('/bin/bash', [harness, capture], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: root,
        AIWORKER_PLATFORM_ENV_FILE: platformEnv,
        MC_AUTH_MODE: '',
        MC_OPENCLAW_TENANT_ID: '',
        MC_OPENCLAW_WORKSPACE_ID: '',
      },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(kind === 'symlink'
      ? 'scope environment file is unsafe'
      : 'scope environment file mode must be 0600')
    expect(`${result.stdout}\n${result.stderr}`).not.toContain(secret)
    expect(existsSync(capture)).toBe(false)
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

  it('uses the loopback release boundary without reading or forwarding credentials for all deploy HTTP clients', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'standalone-loopback-control-')))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(cleanDeployScriptFixture(root), 'utf8')
    const harness = join(root, 'repository/scripts/loopback-control.sh')
    const runDirectory = join(root, 'run')
    const requests: Array<{ path: string; method: string; authorization: string | undefined }> = []
    let mutation: unknown
    let lockWasDelegated = false
    const endpoint = await listen(createServer((request, response) => {
      requests.push({ path: request.url || '', method: request.method || '', authorization: request.headers.authorization })
      if (request.url === '/materials') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end('<html>materials</html>')
      } else if (request.url === '/api/scheduler') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(schedulerPayload('leader')))
      } else {
        let body = ''
        request.on('data', chunk => { body += String(chunk) })
        request.on('end', () => {
          const accepting = request.method === 'GET'
          if (!accepting) {
            mutation = JSON.parse(body)
            const owner = JSON.parse(readFileSync(join(runDirectory, '.deployment.lock/pid'), 'utf8'))
            lockWasDelegated = request.headers['x-aiworker-bootstrap-lock-owner-pid'] === String(owner.pid)
              && request.headers['x-aiworker-bootstrap-lock-nonce'] === owner.nonce
              && Object.keys(request.headers).filter(name => name.startsWith('x-aiworker-bootstrap')).length === 2
          }
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ control: {
            schema: 'video-autoworker-intake-control/v1', globalScope: true,
            accepting, mode: accepting ? 'accepting' : 'paused',
            revision: accepting ? 3 : 4, counts: { active: 0 },
          } }))
        })
      }
    }))
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    writeFileSync(harness, `${functionPrelude}
source "$SHARED_DEPLOYMENT_LOCK_SHELL"
DEPLOYMENT_RUN_DIR="$RUN_DIR"
DEPLOYMENT_LOCK_DIR="$RUN_DIR/.deployment.lock"
acquire_shared_deployment_lock
trap release_shared_deployment_lock EXIT
check_json_endpoint leader "http://127.0.0.1:${endpoint.port}/api/scheduler" 7
check_routed_readonly_endpoint /materials page
ensure_bootstrap_intake_paused 127.0.0.1 ${endpoint.port}
`)
    const result = await execFileAsync('bash', [harness], {
      env: {
        ...process.env,
        MC_AUTH_MODE: 'openclaw-loopback',
        AIWORKER_BG_RUN_DIR: runDirectory,
        AIWORKER_BG_ROUTER_HOST: '127.0.0.1',
        AIWORKER_BG_ROUTER_PORT: String(endpoint.port),
        // A missing file proves this mode does not even resolve credentials.
        AIWORKER_BG_CONTROL_TOKEN_FILE: join(root, 'must-not-be-read'),
        AIWORKER_BG_CONTROL_TOKEN: 'fixture-must-not-forward',
        API_KEY: 'fixture-must-not-forward',
        NODE_BIN: process.execPath,
      },
    })
    expect(requests.map(({ path, method }) => `${method} ${path}`)).toEqual([
      'GET /api/scheduler', 'GET /materials', 'GET /api/n8n/intake-control', 'POST /api/n8n/intake-control',
    ])
    expect(requests.every(request => request.authorization === undefined)).toBe(true)
    expect(lockWasDelegated).toBe(true)
    expect(existsSync(join(runDirectory, '.deployment.lock'))).toBe(false)
    expect(mutation).toEqual({ action: 'drain', reason: '首次蓝绿基线引导期间冻结入口', expectedRevision: 3 })
    expect(result.stdout).not.toContain('fixture-must-not-forward')
    expect(result.stderr).not.toContain('fixture-must-not-forward')
  })

  it.each(['', 'openclaw-loopback-typo'])(
    'keeps the control credential requirement outside the exact loopback mode (%s)',
    async mode => {
      const root = mkdtempSync(join(tmpdir(), 'standalone-control-required-'))
      cleanup.push(() => rmSync(root, { recursive: true, force: true }))
      const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
      const harness = join(root, 'token-harness.sh')
      writeFileSync(harness, `${script.slice(0, script.indexOf('\ncommand="${1:-}"'))}\nread_control_token\n`)
      const failure = await execFileAsync('bash', [harness], {
        env: { ...process.env, MC_AUTH_MODE: mode, AIWORKER_BG_CONTROL_TOKEN_FILE: '', AIWORKER_BG_CONTROL_TOKEN: '', API_KEY: '', NODE_BIN: process.execPath },
      }).then(() => null, error => error as Error & { stderr?: string })
      expect(failure?.stderr).toContain('AIWORKER_BG_CONTROL_TOKEN_FILE or AIWORKER_BG_CONTROL_TOKEN is required')
    },
  )

  it('refuses a non-loopback router in OpenClaw control mode before issuing a request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-control-host-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const harness = join(root, 'token-harness.sh')
    writeFileSync(harness, `${script.slice(0, script.indexOf('\ncommand="${1:-}"'))}\nread_control_token\n`)
    const failure = await execFileAsync('bash', [harness], {
      env: { ...process.env, MC_AUTH_MODE: 'openclaw-loopback', AIWORKER_BG_ROUTER_HOST: 'example.invalid', NODE_BIN: process.execPath },
    }).then(() => null, error => error as Error & { stderr?: string })
    expect(failure?.stderr).toContain('OpenClaw release control requires the fixed loopback router host')
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

  it('rejects an undeclared cross-contract switch even when both sides have no active work', async () => {
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
verify_director_video_release_chain() { return 1; }
update_state() { : > ${JSON.stringify(updateMarker)}; }
transition_with_verification green switch
`)

    const failure = await execFileAsync('bash', [harness], {
      env: { ...process.env, NODE_BIN: process.execPath },
    }).then(() => null, error => error as Error & { stderr?: string })
    expect(failure?.stderr).toContain('target director/video release chain is incompatible')
    expect(existsSync(updateMarker)).toBe(false)
  })

  it('allows only a declared forward cross-contract switch through the existing compensation path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-projection-contract-declared-switch-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = readFileSync(resolve(process.cwd(), 'scripts/deploy-blue-green.sh'), 'utf8')
    const functionPrelude = script.slice(0, script.indexOf('\ncommand="${1:-}"'))
    const harness = join(root, 'projection-declared-switch-harness.sh')
    const eventsFile = join(root, 'events')
    const sourceDigest = 'a'.repeat(64)
    const targetDigest = 'b'.repeat(64)
    writeFileSync(harness, `${functionPrelude}
EVENTS_FILE="$1"
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
    printf '3\\n1\\n%s\\n0\\n0\\n0\\n' '${sourceDigest}'
  else
    printf '3\\n1\\n%s\\n0\\n0\\n0\\n' '${targetDigest}'
  fi
}
verify_director_video_release_chain() {
  printf 'verify:%s:%s\\n' "$1" "$4" >> "$EVENTS_FILE"
  [[ "$4" == '${sourceDigest}' ]] || return 1
  printf '%s' '${targetDigest}'
}
capture_transition_release_evidence() { printf 'evidence-%s' "$1"; }
verify_captured_transition_release_evidence() { :; }
update_state() { printf 'update:%s:%s\\n' "$1" "$2" >> "$EVENTS_FILE"; }
transition_with_verification green switch
`)

    const result = await execFileAsync('bash', [harness, eventsFile], {
      env: { ...process.env, NODE_BIN: process.execPath },
    })
    expect(result.stdout).toContain('Switched router atomically')
    expect(readFileSync(eventsFile, 'utf8').trim().split('\n')).toEqual([
      `verify:release-green:${sourceDigest}`,
      'update:green:switch',
      `verify:release-green:${sourceDigest}`,
    ])
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
      '[[ "$source_projection_contract" != "$target_projection_contract" ]]',
    )
    expect(transitionBody).toContain('[[ "$mode" == switch ]]')
    expect(transitionBody).toContain('"$transition_from_projection_contract"')
    expect(retireBody.indexOf('wait_for_frozen_retirement_quiescence'))
      .toBeLessThan(retireBody.indexOf('verify_retirement_projection_compatibility'))
    expect(retireBody.indexOf('verify_retirement_projection_compatibility'))
      .toBeLessThan(retireBody.indexOf('"$manager" stop "$slot"'))
    expect(deployScript).not.toMatch(/\b(?:launchctl|n8n-stop|n8n-start)\b/u)
    expect(deployScript).toContain('source "$SHARED_DEPLOYMENT_LOCK_SHELL"')
    expect(deployScript).toContain('acquire_shared_deployment_lock')
    expect(deployScript).toContain('release_shared_deployment_lock')
    expect(deployScript).not.toContain('if ! mkdir "$LOCK_DIR"')
    expect(deployScript).toContain('critical deployment source batch verification failed')
    expect(deployScript).toContain('stage_release()')
    expect(deployScript).toContain('source standalone artifact failed verification')
    expect(deployScript).toContain('staged standalone artifact failed verification')
    expect(deployScript).toContain('release target appeared during staging')
    expect(launcher).toContain('ROLE="${2:-probe}"')
    expect(launcher).toContain('probe role requires absolute AIWORKER_BG_PROBE_DATA_DIR')
    expect(launcher).toContain('probe role requires a non-empty, non-symlink SQLite snapshot')
    expect(launcher).toContain('AIWORKER_DISABLE_SCHEDULER=1')
    expect(launcher).toContain('managed %s runtime requires explicit %s')
    expect(launcher).toContain('refusing checkout-local fallback data')
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
    expect(sourceGate).toContain('scripts/lib/blue-green-installed-manager.mjs')
    expect(sourceGate).toContain('ops/recovery/install-blue-green-execve-adapter.mjs')
    expect(sourceGate).toContain('scripts/check-sensitive-content.mjs')
    expect(sourceGate).toContain('scripts/lib/sensitive-value-scanner.mjs')
    expect(sourceGate).toContain('scripts/lib/openclaw-private-gateway-rpc.mjs')
    expect(sourceGate).toContain('scripts/lib/render-managed-markdown-section.mjs')
    expect(sourceGate).toContain('scripts/lib/runtime-tree-manifest.mjs')
    expect(sourceGate).toContain('scripts/lib/git-source-layout.mjs')
    expect(sourceGate).toContain('scripts/lib/git-source-layout.sh')
    expect(sourceGate).toContain('scripts/legacy-preinstall-orchestrator.mjs')
    expect(sourceGate).toContain('scripts/legacy-release-runner.mjs')
    expect(sourceGate).toContain('scripts/install-aiworker-task-flow-skill.sh')
    expect(sourceGate).toContain('scripts/install-aiworker-video-command-plugin.sh')
    expect(sourceGate).toContain('scripts/install-aiworker-director-brain.sh')
    expect(sourceGate).toContain('scripts/apply-openclaw-runtime-convergence.sh')
    expect(sourceGate).toContain('GIT_OPTIONAL_LOCKS=0')
    expect(sourceGate).toContain('"$GIT_SOURCE_LAYOUT" verify-files')
    expect(sourceGate).not.toContain('for relative in "${critical_paths[@]}"')
    const managerResolver = deployScript.slice(
      deployScript.indexOf('assert_normal_service_manager_installation()'),
      deployScript.indexOf('verify_director_video_release_chain()'),
    )
    expect(managerResolver).toContain('"$INSTALLED_MANAGER_RESOLVER" resolve')
    expect(managerResolver).toContain('"$NORMAL_SERVICE_MANAGER" preflight all')
    expect(managerResolver).toContain('assert_normal_service_manager_installation')
    expect(deployScript).toContain('! normal_service_manager status "$slot"')
    expect(retireBody).toContain('manager="normal_service_manager"')
    const managerTransitionBody = deployScript.slice(
      deployScript.indexOf('preflight_transition()'),
      deployScript.indexOf('transition_with_verification()'),
    )
    expect(managerTransitionBody).toContain('normal_service_manager status router')
    expect(managerTransitionBody).toContain('normal_service_manager start "$target"')
    expect(managerTransitionBody).not.toContain('$SCRIPT_DIR/manage-blue-green-services.sh')
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
    expect(retireBody).toContain('verify_retirement_projection_compatibility')
    expect(retireBody.indexOf('wait_for_frozen_retirement_quiescence'))
      .toBeLessThan(retireBody.indexOf('verify_retirement_projection_compatibility'))
    expect(retireBody.indexOf('verify_retirement_projection_compatibility'))
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
