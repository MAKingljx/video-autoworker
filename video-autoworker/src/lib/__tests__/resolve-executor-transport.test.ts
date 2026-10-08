// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createServer, type Server } from 'node:net'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { requestResolveExecutor } from '../editing/resolve-executor-transport'

let root = ''
let server: Server | undefined
const request = () => ({ schemaVersion: 1 as const, requestId: randomUUID(), operationId: 'resolve-operation:' + 'a'.repeat(64), action: 'inspect' as const, payload: {} })
async function fixture(handler: (value: ReturnType<typeof request>) => Record<string, unknown>) {
  root = await realpath(await mkdtemp(join(tmpdir(), 'resolve-')))
  await chmod(root, 0o700)
  const path = join(root, 'executor.sock')
  server = createServer(socket => {
    socket.once('data', data => {
      const value = JSON.parse(data.toString())
      socket.end(JSON.stringify(handler(value)) + '\n')
    })
  })
  await new Promise<void>(done => server!.listen(path, done))
  await chmod(path, 0o600)
  return path
}
afterEach(async () => {
  if (server) await new Promise<void>(done => server!.close(() => done()))
  server = undefined
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
})
describe('managed Resolve Unix transport', () => {
  it('round trips structured identities over a real private Unix socket', async () => {
    const path = await fixture(value => ({ schemaVersion: 1, requestId: value.requestId, operationId: value.operationId, status: 'succeeded', result: { connected: true } }))
    await expect(requestResolveExecutor(path, request())).resolves.toMatchObject({ status: 'succeeded', result: { connected: true } })
  })
  it('rejects a response for another request or operation', async () => {
    const path = await fixture(value => ({ schemaVersion: 1, requestId: randomUUID(), operationId: value.operationId, status: 'succeeded' }))
    await expect(requestResolveExecutor(path, request())).rejects.toThrow('resolve_response_identity_mismatch')
  })
  it('rejects publicly writable socket permissions before connecting', async () => {
    const path = await fixture(value => ({ ...value, status: 'succeeded' }))
    await chmod(path, 0o666)
    await expect(requestResolveExecutor(path, request())).rejects.toThrow('resolve_socket_permissions')
  })
  it('supports explicit abort without pretending the remote write was cancelled', async () => {
    const path = await fixture(value => ({ ...value, status: 'succeeded' }))
    const controller = new AbortController()
    controller.abort()
    await expect(requestResolveExecutor(path, request(), controller.signal)).rejects.toThrow('resolve_request_cancelled')
  })
})
