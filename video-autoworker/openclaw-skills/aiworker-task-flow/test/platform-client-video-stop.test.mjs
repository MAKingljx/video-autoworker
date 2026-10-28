import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createPlatformClient, isRetryablePlatformError, N8N_VIDEO_STOP_CONTROL_UNCONFIRMED } from '../lib/platform-client.mjs'

const taskId = 'video-command:original'
const bindingId = 7
const requestId = 'a'.repeat(64)
const workerLease = { pid: process.pid, token: '12345678-1234-4234-8234-123456789abc' }
function stop(values = {}) {
  return { taskId, bindingId, requestId, targetKind: 'batch_item', targetSha256: 'b'.repeat(64),
    currentState: 'requested', errorCode: null, requestedAt: 10, updatedAt: 10, completedAt: null, revision: 1,
    nextAction: 'wait_for_original_batch_owner', ...values }
}
function unknown(error) {
  assert.equal(error.code, N8N_VIDEO_STOP_CONTROL_UNCONFIRMED)
  assert.equal(isRetryablePlatformError(error), true)
  assert.equal(JSON.stringify(error).includes(workerLease.token), false)
  return true
}
async function withPlatform(handler, callback) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  try { return await callback(createPlatformClient(`http://127.0.0.1:${server.address().port}`)) }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
}
function json(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body))
}

test('reads the exact scoped stop projection and treats only explicit null as no stop', async () => {
  let calls = 0
  await withPlatform((request, response) => {
    assert.equal(request.method, 'GET')
    assert.equal(request.url, `/api/n8n/runs/stop?taskId=video-command%3Aoriginal&view=request&bindingId=7`)
    json(response, { inspection: { taskId, bindingId, stop: calls++ === 0 ? null : stop() } })
  }, async client => {
    assert.equal(await client.getVideoStopRequest(taskId, bindingId), null)
    assert.deepEqual(await client.getVideoStopRequest(taskId, bindingId), stop())
  })
})

for (const [name, body] of [
  ['missing-inspection', {}],
  ['wrong-task', { inspection: { taskId: 'other', bindingId, stop: null } }],
  ['wrong-binding', { inspection: { taskId, bindingId: 8, stop: null } }],
  ['missing-stop', { inspection: { taskId, bindingId } }],
  ['wrong-stop-task', { inspection: { taskId, bindingId, stop: stop({ taskId: 'other' }) } }],
  ['wrong-stop-binding', { inspection: { taskId, bindingId, stop: stop({ bindingId: 8 }) } }],
  ['invalid-request', { inspection: { taskId, bindingId, stop: stop({ requestId: 'invalid' }) } }],
  ['invalid-target', { inspection: { taskId, bindingId, stop: stop({ targetSha256: 'invalid' }) } }],
  ['unknown-state', { inspection: { taskId, bindingId, stop: stop({ currentState: 'almost-stopped' }) } }],
  ['private-field', { inspection: { taskId, bindingId, stop: stop({ leaseToken: workerLease.token }) } }],
  ['false-terminal', { inspection: { taskId, bindingId, stop: stop({ currentState: 'stopped' }) } }],
]) test(`does not convert malformed scoped control ${name} into no stop`, async () => {
  await withPlatform((_request, response) => json(response, body), async client => {
    await assert.rejects(client.getVideoStopRequest(taskId, bindingId), unknown)
  })
})

for (const status of [202, 204, 404, 409, 500]) test(`requires HTTP 200 for a stop read (${status})`, async () => {
  await withPlatform((_request, response) => json(response, { inspection: { taskId, bindingId, stop: null }, error: workerLease.token }, status), async client => {
    await assert.rejects(client.getVideoStopRequest(taskId, bindingId), unknown)
  })
})

test('does not follow redirects or infer a stop state from a lost response', async () => {
  let calls = 0
  await withPlatform((request, response) => {
    if (calls++ === 0) { response.writeHead(302, { Location: '/redirected' }); response.end() }
    else request.socket.destroy()
  }, async client => {
    await assert.rejects(client.getVideoStopRequest(taskId, bindingId), unknown)
    assert.equal(calls, 1)
    await assert.rejects(client.getVideoStopRequest(taskId, bindingId), unknown)
  })
})

for (const status of [200, 202]) test(`posts only the original task/request and worker lease (${status})`, async () => {
  const expected = stop({ currentState: 'stopped', completedAt: 20, updatedAt: 20, nextAction: 'stopped_relearn_as_new_task' })
  await withPlatform(async (request, response) => {
    assert.equal(request.method, 'POST'); assert.equal(request.url, '/api/n8n/runs/stop/batch-ack')
    assert.equal(request.headers['content-type'], 'application/json')
    let body = ''; for await (const part of request) body += part
    assert.deepEqual(JSON.parse(body), { taskId, requestId, workerLease })
    json(response, { taskId, stop: expected }, status)
  }, async client => {
    assert.deepEqual(await client.ackVideoBatchStop({ taskId, requestId, workerLease }), expected)
  })
})

for (const [name, body] of [
  ['wrong-outer-task', { taskId: 'other', stop: stop() }],
  ['wrong-request', { taskId, stop: stop({ requestId: 'c'.repeat(64) }) }],
  ['runtime-target', { taskId, stop: stop({ targetKind: 'runtime' }) }],
  ['missing-stop', { taskId }],
]) test(`never acknowledges an unrelated stop (${name})`, async () => {
  await withPlatform((_request, response) => json(response, body), async client => {
    await assert.rejects(client.ackVideoBatchStop({ taskId, requestId, workerLease }), unknown)
  })
})

test('redacts an ACK refusal including an echoed worker credential', async () => {
  await withPlatform((_request, response) => json(response, { error: `refused ${workerLease.token}`, payload: { workerLease } }, 409), async client => {
    await assert.rejects(client.ackVideoBatchStop({ taskId, requestId, workerLease }), error => {
      unknown(error); assert.equal(error.status, 409); assert.equal(error.body, null)
      assert.equal(error.message.includes(workerLease.token), false); return true
    })
  })
})

test('rejects caller paths, malformed identities or extra ACK fields before network I/O', async () => {
  let calls = 0
  await withPlatform((_request, response) => { calls++; json(response, {}) }, async client => {
    await assert.rejects(client.getVideoStopRequest('../untrusted', bindingId), unknown)
    await assert.rejects(client.getVideoStopRequest(taskId, '7'), unknown)
    await assert.rejects(client.ackVideoBatchStop({ taskId, requestId, workerLease, path: '/tmp/untrusted' }), unknown)
    await assert.rejects(client.ackVideoBatchStop({ taskId, requestId, workerLease: { ...workerLease, token: null } }), unknown)
    assert.equal(calls, 0)
  })
})
