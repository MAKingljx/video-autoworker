// @vitest-environment node

import { execFile, execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'

// The production entrypoint is plain ESM JavaScript so it can run without a
// package install. Vitest loads that exact file to exercise the real router.
import { createStandaloneRouter, writeRouterStateAtomic } from '../../scripts/standalone-router.mjs'

type RunningServer = { server: HttpServer; port: number }
const cleanup: Array<() => void> = []
const execFileAsync = promisify(execFile)

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
        latestMigration: '056_n8n_parent_execution_claims',
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
    const root = mkdtempSync(join(tmpdir(), 'standalone-router-cli-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = resolve(process.cwd(), 'scripts/deploy-blue-green.sh')
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

  it('refuses to switch to a probe runtime even when its attestation matches the slot binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'standalone-switch-probe-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = resolve(process.cwd(), 'scripts/deploy-blue-green.sh')
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
    const root = mkdtempSync(join(tmpdir(), 'standalone-switch-wrong-db-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = resolve(process.cwd(), 'scripts/deploy-blue-green.sh')
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
    const root = mkdtempSync(join(tmpdir(), 'standalone-rebind-without-retirement-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = resolve(process.cwd(), 'scripts/deploy-blue-green.sh')
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
    const root = mkdtempSync(join(tmpdir(), 'standalone-init-not-bootstrap-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const script = resolve(process.cwd(), 'scripts/deploy-blue-green.sh')
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
}

preflight_transition() {
  transition_committed=0
  record_event "preflight:$1:$2:$3"
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
      printf '3\\n1\\n'
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
      .toBeLessThan(transitionBody.indexOf('verify_routed_release "$target"'))
    expect(transitionBody).toContain('attempting automatic rollback')
    expect(transitionBody).toContain('update_state "$source" rollback')
    expect(transitionBody).toContain('"$intake_revision" "$source_epoch"')
    expect(deployScript).not.toMatch(/\b(?:launchctl|n8n-stop|n8n-start)\b/u)
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
    expect(deployScript).toContain('video-autoworker-blue-green-baseline/v2')
    expect(deployScript).toContain('video-autoworker-legacy-freeze-evidence/v2')
    expect(deployScript).toContain('supervisorQuiesced !== true')
    expect(deployScript).toContain('bootstrap retry requires fresh zero-work evidence while the legacy PID is still alive')
    expect(deployScript).toContain('legacy PID is not using AIWORKER_BG_LIVE_DB_PATH as its authoritative SQLite database')
    expect(deployScript).toContain('legacy release ID is not bound to its physical cwd')
    expect(deployScript).toContain('evidenced n8n PID is not using AIWORKER_BG_N8N_DB_PATH')
    expect(deployScript).toContain('check_legacy_databases_quiescent "$live_db" "$n8n_db"')
    expect(deployScript).toContain('delete actual[field]')
    expect(deployScript).toContain('manage-blue-green-services.sh')
    expect(deployScript).toContain('check_routed_readonly_endpoint /materials page')
    expect(deployScript).toContain('check_routed_readonly_endpoint /api/tasks api')
    expect(retireBody).toContain('$DRAIN_PATH')
    expect(retireBody).toContain('$SCHEDULER_PATH')
    expect(retireBody).not.toContain('$READINESS_PATH')
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
