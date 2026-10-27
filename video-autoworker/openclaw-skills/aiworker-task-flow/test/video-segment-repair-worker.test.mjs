import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { assertVideoRepairWorkerLease, batchStatePath, readBatchState, writeBatchState } from '../lib/video-batch-state.mjs'
import { buildVideoLearningResult } from '../lib/video-learning-result.mjs'

const execute = promisify(execFile)
const script = new URL('../scripts/run-video-batch.mjs', import.meta.url)
const partial = buildVideoLearningResult(3, [{ index: 2, stage: 'vision',
  timeRange: '00:00:05-00:00:10', errorCode: 'N8N_MEDIA_MODEL_OUTPUT_INVALID' }])
const complete = buildVideoLearningResult(3, [])
function state(root, baseUrl, batchId, taskId, repair = false) {
  return { schemaVersion: 2, batchId, requestFingerprint: 'f'.repeat(64), bindingId: 2,
    baseUrl, createdAt: repair ? '2026-02-01T00:00:00Z' : '2026-01-01T00:00:00Z',
    status: 'queued', error: null, inboxRoot: join(root, 'inbox'), items: [{ index: 1, taskId,
      idempotencyKey: taskId, name: `${taskId}.mp4`, sourcePath: join(root, `${taskId}.mp4`), status: repair ? 'queued' : 'running',
      ...(repair ? { learningResult: partial, learningRepairRequest: {
        schema: 'aiworker-video-segment-repair-request/v1', requestId: 'a'.repeat(64), taskId, bindingId: 2,
        tenantId: 1, workspaceId: 1, actorId: 0, segmentIndexes: [2], outputSha256: 'b'.repeat(64),
        revisionSha256: 'c'.repeat(64), evidenceSha256: 'd'.repeat(64), generation: 1,
        previousStatus: 'succeeded', createdAt: '2026-02-01T00:00:00Z',
      } } : {}),
    }] }
}

async function scenario(run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'video-repair-worker-')))
  let handler
  const server = createServer((request, response) => Promise.resolve(handler(request, response)).catch(error => {
    response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }))
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const reply = (response, body) => response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  const worker = path => execute(process.execPath, [script.pathname, '--state-file', path], {
    env: { ...process.env, AIWORKER_VIDEO_BATCH_DIR: root, AIWORKER_VIDEO_RECONCILE_INTERVAL_MS: '1000' }, timeout: 15000,
  })
  try { await run({ root, baseUrl, reply, worker, setHandler: value => { handler = value } }) }
  finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
}

test('queued segment repair waits for the original global lane and uses the same task without staging a new video', async () => {
  await scenario(async ({ root, baseUrl, reply, worker, setHandler }) => {
    const firstPath = batchStatePath('first-batch', root)
    const repairPath = batchStatePath('repair-batch', root)
    await writeBatchState(firstPath, state(root, baseUrl, 'first-batch', 'first-video'))
    await writeBatchState(repairPath, state(root, baseUrl, 'repair-batch', 'repair-video', true))
    let firstReads = 0
    let firstDone = false
    const calls = []
    setHandler(async (request, response) => {
      const url = new URL(request.url, baseUrl)
      if (request.method === 'GET' && url.pathname === '/api/n8n/runs') {
        const taskId = url.searchParams.get('taskId')
        calls.push(`read:${taskId}`)
        if (taskId === 'first-video') {
          firstDone = ++firstReads >= 2
          return reply(response, { runs: [{ taskId, status: firstDone ? 'succeeded' : 'running', output: { learningResult: complete } }] })
        }
        return reply(response, { runs: [{ taskId, status: 'succeeded', output: { learningResult: complete } }] })
      }
      assert.equal(request.url, '/api/n8n/runs/recovery')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(body.action, 'dispatch-repair')
      assert.equal(body.taskId, 'repair-video')
      assert.equal(firstDone, true)
      assert.notEqual(body.workerLease.pid, process.pid)
      await assertVideoRepairWorkerLease(repairPath, body.workerLease)
      calls.push('repair')
      return reply(response, { taskId: body.taskId, currentState: 'accepted', errorCode: null })
    })
    await worker(firstPath)
    assert.equal(calls.filter(call => call === 'repair').length, 1)
    assert.deepEqual(calls.slice(0, 3), ['read:first-video', 'read:first-video', 'repair'])
    const repaired = await readBatchState(repairPath)
    assert.equal(repaired.status, 'succeeded')
    assert.equal(repaired.items[0].taskId, 'repair-video')
    assert.equal(repaired.items[0].learningRepairRequest, undefined)
    assert.deepEqual(repaired.items[0].learningResult, complete)
  })
})

test('an unconfirmed repair dispatch remains durable and the next original worker resumes the same request', async () => {
  await scenario(async ({ root, baseUrl, reply, worker, setHandler }) => {
    const repairPath = batchStatePath('repair-batch', root)
    await writeBatchState(repairPath, state(root, baseUrl, 'repair-batch', 'repair-video', true))
    const requestIds = []
    setHandler(async (request, response) => {
      if (request.method === 'GET') return reply(response, { runs: [{ taskId: 'repair-video', status: 'succeeded', output: { learningResult: complete } }] })
      assert.equal(request.url, '/api/n8n/runs/recovery')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      await assertVideoRepairWorkerLease(repairPath, body.workerLease)
      requestIds.push(body.requestId)
      return reply(response, { taskId: body.taskId, currentState: requestIds.length === 1 ? 'queued' : 'accepted',
        errorCode: requestIds.length === 1 ? 'recovery_dispatch_outcome_unknown' : null })
    })
    await worker(repairPath)
    const retained = await readBatchState(repairPath)
    assert.equal(retained.status, 'recovering')
    assert.equal(retained.items[0].learningRepairRequest.requestId, 'a'.repeat(64))
    await worker(repairPath)
    assert.deepEqual(requestIds, ['a'.repeat(64), 'a'.repeat(64)])
    const finished = await readBatchState(repairPath)
    assert.equal(finished.status, 'succeeded')
    assert.equal(finished.items[0].learningRepairRequest, undefined)
    await assert.rejects(readFile(join(root, '.global-video-worker.lock')), { code: 'ENOENT' })
  })
})

test('a late repair conflict rechecks the running original task before releasing the lane to another video', async () => {
  await scenario(async ({ root, baseUrl, reply, worker, setHandler }) => {
    const repairPath = batchStatePath('repair-batch', root)
    const nextPath = batchStatePath('next-batch', root)
    const next = state(root, baseUrl, 'next-batch', 'next-video')
    next.createdAt = '2026-03-01T00:00:00Z'
    await writeBatchState(repairPath, state(root, baseUrl, 'repair-batch', 'repair-video', true))
    await writeBatchState(nextPath, next)
    const events = []
    let repairReads = 0
    let repairDone = false
    setHandler(async (request, response) => {
      const url = new URL(request.url, baseUrl)
      if (request.method === 'GET') {
        const taskId = url.searchParams.get('taskId')
        events.push(`read:${taskId}`)
        if (taskId === 'repair-video') {
          repairDone = ++repairReads >= 2
          return reply(response, { runs: [{ taskId, status: repairDone ? 'succeeded' : 'running',
            routing: { learningRepair: { queueRequestId: 'a'.repeat(64) } },
            output: { learningResult: repairDone ? complete : partial } }] })
        }
        assert.equal(taskId, 'next-video')
        assert.equal(repairDone, true)
        return reply(response, { runs: [{ taskId, status: 'succeeded', output: { learningResult: complete } }] })
      }
      assert.equal(request.url, '/api/n8n/runs/recovery')
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      await assertVideoRepairWorkerLease(repairPath, body.workerLease)
      events.push('late-conflict')
      response.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        code: 'recovery_revision_changed', error: 'first dispatch already committed',
      }))
    })
    await worker(repairPath)
    assert.deepEqual(events, ['late-conflict', 'read:repair-video', 'read:repair-video', 'read:next-video'])
    const repaired = await readBatchState(repairPath)
    assert.equal(repaired.items[0].learningRepairRequest, undefined)
    assert.equal(repaired.items[0].learningRepairRejected, undefined)
    assert.deepEqual(repaired.items[0].learningResult, complete)
  })
})

test('an unknown task state after a repair conflict retains the request and never advances the queue', async () => {
  await scenario(async ({ root, baseUrl, worker, setHandler }) => {
    const repairPath = batchStatePath('repair-batch', root)
    const nextPath = batchStatePath('next-batch', root)
    const next = state(root, baseUrl, 'next-batch', 'next-video')
    next.createdAt = '2026-03-01T00:00:00Z'
    await writeBatchState(repairPath, state(root, baseUrl, 'repair-batch', 'repair-video', true))
    await writeBatchState(nextPath, next)
    let reads = 0
    setHandler(async (request, response) => {
      const url = new URL(request.url, baseUrl)
      if (request.method === 'GET') {
        assert.equal(url.searchParams.get('taskId'), 'repair-video')
        reads++
        return response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'unconfirmed' }))
      }
      return response.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 'recovery_revision_changed' }))
    })
    await worker(repairPath)
    const repaired = await readBatchState(repairPath)
    assert.equal(reads, 1)
    assert.equal(repaired.status, 'recovering')
    assert.equal(repaired.items[0].learningRepairRequest.requestId, 'a'.repeat(64))
    assert.equal((await readBatchState(nextPath)).items[0].status, 'running')
  })
})

test('a real lane-ownership rejection stops the worker instead of treating a running task as new dispatch authority', async () => {
  await scenario(async ({ root, baseUrl, worker, setHandler }) => {
    const repairPath = batchStatePath('repair-batch', root)
    const nextPath = batchStatePath('next-batch', root)
    const next = state(root, baseUrl, 'next-batch', 'next-video')
    next.createdAt = '2026-03-01T00:00:00Z'
    await writeBatchState(repairPath, state(root, baseUrl, 'repair-batch', 'repair-video', true))
    await writeBatchState(nextPath, next)
    let calls = 0
    setHandler(async (request, response) => {
      calls++
      assert.equal(request.method, 'POST')
      response.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        code: 'recovery_worker_lease_invalid', error: 'worker no longer owns the lane',
      }))
    })
    await assert.rejects(worker(repairPath))
    assert.equal(calls, 1)
    const retained = await readBatchState(repairPath)
    assert.equal(retained.status, 'paused')
    assert.equal(retained.items[0].learningRepairRequest.requestId, 'a'.repeat(64))
    assert.equal((await readBatchState(nextPath)).items[0].status, 'running')
  })
})
