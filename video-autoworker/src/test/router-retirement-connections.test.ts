// @vitest-environment node
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createStandaloneRouter, writeRouterStateAtomic } from '../../scripts/standalone-router.mjs'
import { acquireSharedDeploymentLockSync } from '../../scripts/lib/shared-deployment-lock.mjs'
import { requestRouterConnectionDrain } from '../../scripts/lib/router-retirement-control.mjs'

const close: Array<() => void> = []
afterEach(() => { while (close.length) close.pop()?.() })
const exec = promisify(execFile)

async function listen(server: Server) {
  const sockets = new Set<Socket>()
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  close.push(() => { for (const socket of sockets) socket.destroy(); server.closeAllConnections(); server.close() })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test_listener_missing')
  return address.port
}

async function eventually(probe: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await probe()) return
    await new Promise(done => setTimeout(done, 10))
  }
  throw new Error('test_counter_not_settled')
}

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'router-retirement-')))
  close.push(() => rmSync(root, { recursive: true, force: true }))
  let download: ServerResponse | undefined
  const blueServer = createServer((request, response) => {
    if (request.url === '/events') {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      response.write('data: blue\n\n')
    } else if (request.url === '/download') {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.write('download-start')
      download = response
    } else response.end('blue')
  })
  blueServer.on('upgrade', (_request, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\nblue\n')
  })
  const blue = await listen(blueServer)
  const green = await listen(createServer((_request, response) => response.end('green')))
  const initial = { schema: 'video-autoworker-standalone-router/v1', generation: 1,
    active: 'blue', previous: null, slots: {
      blue: { host: '127.0.0.1', port: blue, releaseId: 'release-blue' },
      green: { host: '127.0.0.1', port: green, releaseId: 'release-green' },
    } }
  const stateFile = join(root, 'router-state.json')
  writeRouterStateAtomic(stateFile, initial)
  const port = await listen(createStandaloneRouter({ stateFile }))
  const url = `http://127.0.0.1:${port}`
  const lease = acquireSharedDeploymentLockSync({ runDirectory: root })
  if (!lease) throw new Error('test_deployment_lock_unavailable')
  close.push(() => lease.release())
  const switched = { ...initial, generation: 2, active: 'green', previous: 'blue' }
  const health = () => fetch(`${url}/__router/health`).then(response => response.json())
  const drain = { active: 0, untrackedCallbacks: 0, otherReleaseActive: 0, childExecutionLeases: 0,
    requiredQuietSeconds: 30, quietSeconds: 30 }
  const scheduler = { schedulerState: 'inactive', schedulerRouterGeneration: 2 }
  const request = (overrides: Record<string, unknown> = {}) => requestRouterConnectionDrain({
    stateFile, state: switched, routerPid: process.pid, routerUrl: `${url}/`, slot: 'blue',
    lease: lease.descriptor, drain, scheduler, ...overrides,
  })
  const script = readFileSync(resolve('scripts/deploy-blue-green.sh'), 'utf8')
  const functionStart = script.indexOf('check_json_endpoint()')
  const codeStart = script.indexOf("<<'NODE'\n", functionStart) + "<<'NODE'\n".length
  const codeEnd = script.indexOf('\nNODE\n}', codeStart)
  if (codeStart < 0 || codeEnd < codeStart) throw new Error('retirement_verifier_missing')
  const gatePath = join(root, 'retirement-gate.mjs')
  writeFileSync(gatePath, script.slice(codeStart, codeEnd))
  const gate = () => exec(process.execPath, [gatePath, 'retire-router', `${url}/__router/health`,
    'green', 'release-green', '2', 'blue'], { env: { ...process.env, AIWORKER_BG_REQUEST_TIMEOUT_MS: '3000' } })
  return { root, url, port, switched, stateFile, health, request, gate,
    switch: () => writeRouterStateAtomic(stateFile, switched),
    finishDownload: () => download?.end('-end') }
}

describe('scoped retirement of reconnectable router connections', () => {
  it('keeps old SSE through a switch, then closes only its SSE/upgrade and preserves an ordinary download', async () => {
    const f = await fixture()
    const sse = await fetch(`${f.url}/events`)
    const sseText = sse.text()
    const download = await fetch(`${f.url}/download`)
    const downloadText = download.text()
    const upgraded = connect(f.port, '127.0.0.1')
    close.push(() => upgraded.destroy())
    await new Promise<void>((done, reject) => {
      upgraded.once('error', reject)
      upgraded.once('connect', () => upgraded.write(`GET /socket HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nConnection: Upgrade\r\nUpgrade: test\r\n\r\n`))
      upgraded.once('data', () => done())
    })
    const upgradedClosed = new Promise<void>(done => upgraded.once('close', () => done()))
    f.switch()
    expect((await f.health()).counters.blue).toMatchObject({ activeRequests: 2, upgradedSockets: 1 })
    expect(await fetch(`${f.url}/next`).then(response => response.text())).toBe('green')
    await expect(f.gate()).rejects.toThrow()
    const result = await f.request()
    expect(result.closed).toEqual({ sse: 1, upgraded: 1 })
    await expect(sseText).resolves.toBe('data: blue\n\n')
    await upgradedClosed
    await eventually(async () => (await f.health()).counters.blue.activeRequests === 1)
    expect((await f.health()).counters.blue.upgradedSockets).toBe(0)
    await expect(f.gate()).rejects.toThrow() // A live download is still protected.
    expect(await fetch(`${f.url}/events`).then(response => response.text())).toBe('green')
    f.finishDownload()
    await expect(downloadText).resolves.toBe('download-start-end')
    await eventually(async () => (await f.health()).counters.blue.activeRequests === 0)
    await expect(f.gate()).resolves.toHaveProperty('stdout')
    const noCapability = await fetch(`${f.url}/__router/retire-connections`, { method: 'POST',
      headers: { 'x-aiworker-retire-slot': 'blue', 'x-aiworker-retire-request': 'a'.repeat(64) } })
    expect(noCapability.status).toBe(409)
  })

  it('rejects stale generation/PID, active-slot targets and non-owned or browser-origin requests', async () => {
    const f = await fixture()
    const sse = await fetch(`${f.url}/events`)
    const text = sse.text()
    f.switch()
    await expect(f.request({ state: { ...f.switched, generation: 3 },
      scheduler: { schedulerState: 'inactive', schedulerRouterGeneration: 3 } })).rejects.toThrow('response_invalid')
    await expect(f.request({ routerPid: process.pid + 1 })).rejects.toThrow('response_invalid')
    await expect(f.request({ slot: 'green' })).rejects.toThrow('scope_changed')
    await expect(f.request({ lease: { ...JSON.parse(readFileSync(join(f.root, '.deployment.lock/pid'), 'utf8')) } })).rejects.toThrow()
    expect((await fetch(`${f.url}/__router/retire-connections`, { method: 'POST',
      headers: { origin: 'http://localhost:3017' } })).status).toBe(403)
    expect((await f.health()).counters.blue.activeRequests).toBe(1)
    expect((await f.request()).closed.sse).toBe(1)
    await expect(text).resolves.toBe('data: blue\n\n')
  })
})
