import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { batchStatePath, singleVideoStatePath } from '../lib/video-batch-state.mjs'

const execute = promisify(execFile)
const script = new URL('../scripts/submit-task.mjs', import.meta.url)

async function writeDurableState(root, taskId, status) {
  const statePath = singleVideoStatePath(taskId, root)
  await mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
  await writeFile(statePath, `${JSON.stringify({
    schemaVersion: 1,
    kind: 'single',
    status,
    updatedAt: '2026-08-21T12:00:00.000Z',
    items: [{ taskId, status, error: null }],
  })}\n`, { mode: 0o600 })
}

async function withPlatform(handler, callback) {
  const server = createServer(handler)
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', resolvePromise)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  try {
    return await callback(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise((resolvePromise, rejectPromise) => {
      server.close(error => error ? rejectPromise(error) : resolvePromise())
    })
  }
}

async function queryStatus(root, taskId, baseUrl) {
  const { stdout } = await execute(process.execPath, [
    script.pathname,
    '--status-brief', taskId,
    '--base-url', baseUrl,
  ], {
    env: { ...process.env, AIWORKER_VIDEO_BATCH_DIR: root },
  })
  return JSON.parse(stdout)
}

async function queryBatchStatus(root, batchId) {
  const { stdout, stderr } = await execute(process.execPath, [
    script.pathname,
    '--batch-status', batchId,
  ], {
    env: { ...process.env, AIWORKER_VIDEO_BATCH_DIR: root },
  })
  assert.equal(stderr, '')
  return JSON.parse(stdout)
}

test('status CLI asks the platform before a non-terminal durable record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-status-platform-first-'))
  const taskId = `video-command-${'a'.repeat(64)}`
  try {
    await writeDurableState(root, taskId, 'accepted')
    let requests = 0
    const result = await withPlatform((request, response) => {
      requests += 1
      assert.equal(new URL(request.url, 'http://127.0.0.1').searchParams.get('taskId'), taskId)
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ runs: [{
        taskId,
        status: 'failed',
        attemptCount: 2,
        maxAttempts: 2,
        output: null,
        error: 'vision: fetch failed',
        updatedAt: 200,
      }] }))
    }, baseUrl => queryStatus(root, taskId, baseUrl))

    assert.equal(requests, 1)
    assert.equal(result.status, 'failed')
    assert.equal(result.error, 'vision: fetch failed')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('status CLI falls back to the durable record on temporary platform failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-status-fallback-'))
  const taskId = `video-command-${'b'.repeat(64)}`
  try {
    await writeDurableState(root, taskId, 'waiting')
    const result = await withPlatform((_request, response) => {
      response.writeHead(503, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: 'temporary unavailable' }))
    }, baseUrl => queryStatus(root, taskId, baseUrl))

    assert.equal(result.status, 'running')
    assert.equal(result.updatedAt, '2026-08-21T12:00:00.000Z')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('batch status returns a structured not-registered state instead of leaking ENOENT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-batch-status-missing-'))
  try {
    const result = await queryBatchStatus(root, 'missing-batch')
    assert.deepEqual(result, {
      batchId: 'missing-batch',
      status: 'not_registered',
      stateAvailable: false,
      total: 0,
      counts: {},
      current: null,
      items: [],
      error: '批次状态未登记，无法验证进度；未执行恢复或提交。',
      updatedAt: null,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('batch status returns unavailable when both primary and backup state are damaged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-batch-status-damaged-'))
  try {
    const statePath = batchStatePath('damaged-batch', root)
    await mkdir(dirname(statePath), { recursive: true, mode: 0o700 })
    await writeFile(statePath, '{broken')
    await writeFile(`${statePath}.bak`, '{also-broken')
    const result = await queryBatchStatus(root, 'damaged-batch')
    assert.deepEqual(result, {
      batchId: 'damaged-batch',
      status: 'unavailable',
      stateAvailable: false,
      total: 0,
      counts: {},
      current: null,
      items: [],
      error: '批次状态文件损坏且备份不可用，无法验证进度；未执行恢复或提交。',
      updatedAt: null,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
