import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { assertVideoRepairWorkerLease, createBatchState, readBatchState, writeBatchState } from '../lib/video-batch-state.mjs'
import { sourceIdentity, stageVideoFile, VideoTaskStopRequestedError } from '../lib/media-ingest.mjs'

const execute = promisify(execFile), script = new URL('../scripts/run-video-batch.mjs', import.meta.url)
const requestId = 'a'.repeat(64), targetSha256 = 'b'.repeat(64), chunkBytes = 8 * 1024 * 1024
function projection(taskId, currentState = 'requested') {
  return { taskId, requestId, targetKind: 'batch_item', bindingId: 2, targetSha256, currentState,
    errorCode: null, requestedAt: 1, updatedAt: 2, completedAt: currentState === 'stopped' ? 2 : null,
    revision: 1, nextAction: currentState === 'stopped' ? 'stopped_relearn_as_new_task' : 'wait_for_original_batch_owner' }
}
async function scenario(options, run) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'batch-single-stop-worker-')))
  const batchRoot = join(root, 'batch'), inboxRoot = join(root, 'inbox'), videoDir = join(root, 'source')
  await mkdir(videoDir, { mode: 0o700 }); await mkdir(inboxRoot, { mode: 0o700 })
  const source = join(videoDir, '01-first.mp4')
  if (options.large) {
    const writer = await open(source, 'wx', 0o600)
    try { for (const value of [1, 2, 3]) await writer.write(Buffer.alloc(chunkBytes, value)); await writer.sync() }
    finally { await writer.close() }
  } else await writeFile(source, 'first owned source', { mode: 0o600 })
  await writeFile(join(videoDir, '02-second.mp4'), 'second independent source', { mode: 0o600 })
  let stopRead, ack, created
  const calls = { triggers: 0, reads: [], acknowledgments: [] }
  const reply = (response, body, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body))
  const server = createServer((request, response) => { void (async () => {
    const url = new URL(request.url, 'http://127.0.0.1'), taskId = url.searchParams.get('taskId')
    if (url.pathname === '/api/n8n/runs/stop' && request.method === 'GET') {
      const result = await stopRead(taskId)
      return reply(response, result.body ?? { inspection: { taskId, bindingId: 2, stop: result.stop ?? null } }, result.status ?? 200)
    }
    if (url.pathname === '/api/n8n/runs/stop/batch-ack' && request.method === 'POST') {
      const chunks = []; for await (const chunk of request) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.deepEqual(Object.keys(body).sort(), ['requestId', 'taskId', 'workerLease'])
      await assertVideoRepairWorkerLease(created.statePath, body.workerLease)
      assert.notEqual(body.workerLease.pid, process.pid)
      const state = await readBatchState(created.statePath), item = state.items.find(value => value.taskId === body.taskId)
      assert.equal(item.status, 'cancelled'); assert.equal(item.stopAckPending, true); assert.equal(item.stopRequestId, requestId)
      const receipt = item.stopReceipt
      assert.deepEqual(Object.keys(receipt).sort(), ['batchId', 'bindingId', 'idempotencyKey', 'observedAt', 'quiescent', 'requestId', 'resources', 'schema', 'targetSha256', 'taskId'])
      assert.equal(receipt.schema, 'aiworker-video-batch-stop-local/v1'); assert.equal(receipt.targetSha256, targetSha256)
      assert.deepEqual(receipt.quiescent, { copy: true, hash: true, submission: true, writers: true })
      for (const resource of Object.values(receipt.resources)) if (resource) assert.deepEqual(resource.identity, sourceIdentity(await stat(resource.path)))
      calls.acknowledgments.push({ body, receipt })
      const result = await ack(body, receipt)
      return reply(response, { taskId: body.taskId, stop: projection(body.taskId, result.state ?? 'stopped') }, result.status ?? 200)
    }
    if (url.pathname === '/api/n8n/runs' && request.method === 'GET') {
      calls.reads.push(taskId)
      const second = created.state.items[1].taskId === taskId
      return reply(response, { runs: second ? [{ taskId, status: 'succeeded', output: { summary: 'second retained' } }] : [] })
    }
    if (url.pathname === '/api/n8n/trigger') { calls.triggers++; return reply(response, { error: 'unexpected trigger' }, 500) }
    return reply(response, { error: 'unexpected request' }, 500)
  })().catch(error => { if (!response.headersSent) reply(response, { error: error.message }, 500); else response.destroy(error) }) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  created = await createBatchState({ batchId: 'original-batch', baseUrl, bindingId: 2, prompt: 'original story',
    visionRoute: null, videoDir, inboxRoot, batchRoot })
  const first = created.state.items[0], original = sourceIdentity(await stat(source))
  stopRead = async taskId => ({ stop: taskId === first.taskId ? projection(taskId) : null })
  ack = async () => ({})
  const worker = () => execute(process.execPath, [script.pathname, '--state-file', created.statePath], {
    env: { ...process.env, AIWORKER_VIDEO_BATCH_DIR: batchRoot }, timeout: 15_000, maxBuffer: 64 * 1024,
  })
  try { await run({ root, batchRoot, inboxRoot, created, first, source, original, calls, worker,
    setStopRead: handler => { stopRead = handler }, setAck: handler => { ack = handler } }) }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }) }
}

test('queued stop uses the original worker locks and only cancels its target', async () => {
  await scenario({}, async ({ created, first, source, original, calls, worker, inboxRoot }) => {
    await worker()
    const state = await readBatchState(created.statePath)
    assert.equal(state.items[0].status, 'cancelled'); assert.equal(state.items[0].stopAckPending, undefined)
    assert.equal(state.items[0].taskId, first.taskId); assert.equal(state.items[1].status, 'succeeded')
    assert.equal(state.error, '1 个视频已停止')
    assert.deepEqual(state.items[0].stopReceipt.resources, { source: { path: source, identity: original }, incoming: null, staged: null, anchor: null })
    assert.equal(calls.acknowledgments.length, 1); assert.equal(calls.triggers, 0); assert.deepEqual(await readdir(inboxRoot), [])
    assert.deepEqual(sourceIdentity(await stat(source)), original)
  })
})

test('a live 8 MiB staging stop preserves its partial and journal before the worker sends ACK', async () => {
  await scenario({ large: true }, async ({ created, first, source, original, calls, worker, inboxRoot, setStopRead }) => {
    setStopRead(async taskId => {
      if (taskId !== first.taskId) return {}
      const item = (await readBatchState(created.statePath)).items[0]
      const incoming = item.stagingRecovery && await stat(join(inboxRoot, item.stagingRecovery.incomingName)).catch(() => null)
      return { stop: incoming?.size >= chunkBytes ? projection(taskId) : null }
    })
    await worker()
    const item = (await readBatchState(created.statePath)).items[0], receipt = item.stopReceipt
    assert.equal(item.status, 'cancelled', item.stopControlErrorCode); assert.equal(item.stagingRecovery.phase, 'prepared')
    assert.equal(receipt.resources.incoming.identity.size, chunkBytes); assert.equal(receipt.resources.staged, null)
    assert.equal((await stat(receipt.resources.incoming.path)).size, chunkBytes)
    assert.deepEqual(sourceIdentity(await stat(source)), original); assert.equal(calls.triggers, 0)
    assert.equal(calls.acknowledgments.length, 1)
  })
})

test('control loss during real staging retains the partial and parks without a terminal status or ACK', async () => {
  await scenario({ large: true }, async ({ created, first, source, original, calls, worker, inboxRoot, setStopRead }) => {
    setStopRead(async taskId => {
      if (taskId !== first.taskId) return {}
      const item = (await readBatchState(created.statePath)).items[0]
      const incoming = item.stagingRecovery && await stat(join(inboxRoot, item.stagingRecovery.incomingName)).catch(() => null)
      return incoming?.size >= chunkBytes ? { status: 503, body: { error: 'control unavailable' } } : {}
    })
    await worker()
    const state = await readBatchState(created.statePath), item = state.items[0]
    assert.equal(item.status, 'recovering'); assert.equal(item.stopReceipt, undefined); assert.equal(item.stopAckPending, undefined)
    assert.equal((await stat(join(inboxRoot, item.stagingRecovery.incomingName))).size, chunkBytes)
    assert.equal(state.items[1].status, 'queued'); assert.deepEqual(sourceIdentity(await stat(source)), original)
    assert.equal(calls.acknowledgments.length, 0); assert.equal(calls.triggers, 0)
    // A manual batch closure must not turn an unavailable control read into
    // a tight same-turn recovery/cleanup loop over this retained journal.
    state.status = 'completed_with_errors'; await writeBatchState(created.statePath, state)
    await worker()
    const closed = await readBatchState(created.statePath)
    assert.equal(closed.status, 'completed_with_errors'); assert.equal(closed.items[0].status, 'recovering')
    assert.equal((await stat(join(inboxRoot, item.stagingRecovery.incomingName))).size, chunkBytes)
    assert.equal(calls.acknowledgments.length, 0); assert.equal(calls.triggers, 0)
  })
})

for (const failure of ['503', 'accepted']) test(`ACK ${failure} retains the original receipt and is retried by the next original worker`, async () => {
  await scenario({}, async ({ created, calls, worker, setAck }) => {
    setAck(async () => calls.acknowledgments.length === 1 ? { status: failure === '503' ? 503 : 202, state: 'stopping' } : {})
    await worker()
    const pending = await readBatchState(created.statePath), receipt = pending.items[0].stopReceipt
    assert.equal(pending.items[0].stopAckPending, true); assert.equal(pending.items[1].status, 'queued')
    assert.equal(calls.triggers, 0); assert.equal(calls.acknowledgments.length, 1)
    await worker()
    const completed = await readBatchState(created.statePath)
    assert.equal(completed.items[0].stopAckPending, undefined); assert.deepEqual(completed.items[0].stopReceipt, receipt)
    assert.equal(completed.items[1].status, 'succeeded'); assert.equal(calls.acknowledgments.length, 2)
    assert.notEqual(calls.acknowledgments[0].body.workerLease.pid, calls.acknowledgments[1].body.workerLease.pid)
    assert.equal(calls.triggers, 0)
  })
})

test('a manually closed batch with a pending ACK retries once and never spins or advances another item', async () => {
  await scenario({}, async ({ created, calls, worker, setAck }) => {
    setAck(async () => ({ status: 503, state: 'stopping' }))
    await worker()
    const state = await readBatchState(created.statePath)
    state.status = 'completed_with_errors'
    await writeBatchState(created.statePath, state)
    await worker()
    const retained = await readBatchState(created.statePath)
    assert.equal(calls.acknowledgments.length, 2)
    assert.equal(retained.status, 'completed_with_errors'); assert.equal(retained.items[0].stopAckPending, true)
    assert.equal(retained.items[1].status, 'queued'); assert.equal(calls.triggers, 0)
  })
})

for (const mode of ['503', 'wrong-binding']) test(`unknown stop control ${mode} parks the original item without failing it or advancing the batch`, async () => {
  await scenario({}, async ({ created, source, original, calls, worker, setStopRead, inboxRoot }) => {
    setStopRead(async taskId => mode === '503' ? { status: 503, body: { error: 'unavailable' } }
      : { body: { inspection: { taskId, bindingId: 99, stop: null } } })
    await worker()
    const state = await readBatchState(created.statePath)
    assert.equal(state.status, 'recovering'); assert.equal(state.items[0].status, 'recovering')
    assert.equal(state.items[0].stopReceipt, undefined); assert.equal(state.items[1].status, 'queued')
    assert.equal(calls.triggers, 0); assert.equal(calls.acknowledgments.length, 0); assert.deepEqual(await readdir(inboxRoot), [])
    assert.deepEqual(sourceIdentity(await stat(source)), original)
  })
})

for (const hasStop of [true, false]) test(`paused batch performs stop-only reconciliation without resuming other items (stop=${hasStop})`, async () => {
  await scenario({}, async ({ created, calls, worker, setStopRead }) => {
    const paused = { ...created.state, status: 'paused', error: 'user pause' }
    await writeBatchState(created.statePath, paused)
    const before = await readFile(created.statePath), second = structuredClone(paused.items[1])
    if (!hasStop) setStopRead(async () => ({}))
    await worker()
    const after = await readBatchState(created.statePath)
    assert.equal(after.status, 'paused'); assert.equal(after.error, 'user pause'); assert.deepEqual(after.items[1], second)
    assert.equal(calls.triggers, 0); assert.equal(calls.reads.length, 0)
    if (hasStop) { assert.equal(after.items[0].status, 'cancelled'); assert.equal(calls.acknowledgments.length, 1) }
    else { assert.deepEqual(await readFile(created.statePath), before); assert.equal(calls.acknowledgments.length, 0) }
  })
})

test('a paused control failure followed by a healthy no-stop query never resumes dispatch', async () => {
  await scenario({}, async ({ created, calls, worker, setStopRead }) => {
    const paused = { ...created.state, status: 'paused', error: 'explicit user pause' }, second = structuredClone(created.state.items[1])
    await writeBatchState(created.statePath, paused)
    setStopRead(async () => ({ status: 503, body: { error: 'control unavailable' } }))
    await worker()
    let state = await readBatchState(created.statePath)
    assert.equal(state.status, 'paused'); assert.equal(state.error, 'explicit user pause')
    assert.equal(state.items[0].status, 'queued'); assert.deepEqual(state.items[1], second)
    setStopRead(async () => ({}))
    await worker()
    state = await readBatchState(created.statePath)
    assert.equal(state.status, 'paused'); assert.equal(state.error, 'explicit user pause')
    assert.equal(state.items[0].status, 'queued'); assert.deepEqual(state.items[1], second)
    assert.equal(calls.triggers, 0); assert.equal(calls.reads.length, 0); assert.equal(calls.acknowledgments.length, 0)
  })
})

test('a lost original worker lease causes zero subsequent state writes and no ACK', async () => {
  await scenario({}, async ({ batchRoot, created, calls, worker, setStopRead }) => {
    let stateBeforeLoss
    setStopRead(async () => {
      stateBeforeLoss = await readFile(created.statePath)
      const lockPath = join(batchRoot, '.global-video-worker.lock'), lock = JSON.parse(await readFile(lockPath, 'utf8'))
      await writeFile(lockPath, JSON.stringify({ ...lock, token: randomUUID() }), { mode: 0o600 })
      return {}
    })
    await assert.rejects(worker())
    assert.deepEqual(await readFile(created.statePath), stateBeforeLoss)
    assert.equal(calls.acknowledgments.length, 0); assert.equal(calls.triggers, 0)
  })
})

test('an earlier stop wins the cleanup publication fence and retains the same partial inode', async () => {
  await scenario({ large: true }, async ({ created, first, inboxRoot, calls, worker, setStopRead }) => {
    let state = created.state, recovery
    const reason = new VideoTaskStopRequestedError(requestId)
    await assert.rejects(stageVideoFile(first.sourcePath, { inboxRoot, expectedSourceIdentity: first.sourceIdentity,
      stagingBinding: { taskId: first.taskId, idempotencyKey: first.idempotencyKey, batchId: state.batchId },
      async onStagingPrepared(value) { recovery = value; state.items[0].stagingRecovery = value; state.items[0].status = 'recovering'; state = await writeBatchState(created.statePath, state) },
      control: { async assertActive() { if (recovery && (await stat(join(inboxRoot, recovery.incomingName))).size >= chunkBytes) throw reason } },
    }), error => error === reason)
    const incomingPath = join(inboxRoot, recovery.incomingName), before = await readFile(incomingPath), originalInode = (await stat(incomingPath)).ino
    let release, entered
    const fence = new Promise(resolve => { release = resolve }), atFence = new Promise(resolve => { entered = resolve })
    setStopRead(async taskId => {
      if (taskId !== first.taskId) return {}
      const item = (await readBatchState(created.statePath)).items[0]
      if (!item.stagingRecovery?.phase.startsWith('discarding')) return {}
      entered(); await fence
      return { stop: projection(taskId) }
    })
    const running = worker()
    try { await Promise.race([atFence, running.then(() => { throw new Error('worker finished before the cleanup fence') })]); assert.deepEqual(await readFile(incomingPath), before); release(); await running }
    finally { release(); await running }
    const stopped = (await readBatchState(created.statePath)).items[0]
    assert.equal(stopped.status, 'cancelled', stopped.stopControlErrorCode); assert.equal(stopped.stagingRecovery.phase, 'discarding_prepared')
    assert.equal((await stat(incomingPath)).ino, originalInode); assert.deepEqual(await readFile(incomingPath), before)
    assert.equal(calls.acknowledgments.length, 1); assert.equal(calls.triggers, 0)
    assert.equal((await readdir(inboxRoot)).some(name => name.startsWith('.cleanup-claim-')), false)
  })
})
