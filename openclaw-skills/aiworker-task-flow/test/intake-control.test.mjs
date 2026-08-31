import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import {
  createPlatformClient,
  isN8nIntakeDrainingError,
  isRetryablePlatformError,
} from '../lib/platform-client.mjs'
import {
  createSingleVideoState,
  readBatchState,
} from '../lib/video-batch-state.mjs'

const execute = promisify(execFile)
const submitScript = new URL('../scripts/submit-task.mjs', import.meta.url)
const workerScript = new URL('../scripts/run-video-batch.mjs', import.meta.url)

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

test('platform client validates intake state and classifies only the canonical draining response as retryable', async () => {
  await withPlatform((request, response) => {
    assert.equal(request.url, '/api/n8n/intake-control')
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ control: { accepting: false } }))
  }, async baseUrl => {
    const client = createPlatformClient(baseUrl)
    assert.deepEqual(await client.getIntakeControl(), { accepting: false })
    await assert.rejects(client.assertIntakeAccepting(), error => {
      assert.equal(isN8nIntakeDrainingError(error), true)
      assert.equal(isRetryablePlatformError(error), true)
      assert.equal(error.status, 423)
      return true
    })
  })
})

test('new single-video and directory requests stop before durable state creation while intake is closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-intake-preflight-'))
  const batchRoot = join(root, 'batches')
  const video = join(root, 'video.mp4')
  const directory = join(root, 'directory')
  const taskId = `video-command-${'a'.repeat(64)}`
  const batchId = `video-batch-${'b'.repeat(64)}`
  await writeFile(video, 'closed-intake-video')
  await mkdir(directory)
  await writeFile(join(directory, 'episode.mp4'), 'closed-intake-directory-video')

  try {
    let requests = 0
    await withPlatform((request, response) => {
      requests += 1
      assert.equal(request.method, 'GET')
      assert.equal(request.url, '/api/n8n/intake-control')
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ control: { accepting: false } }))
    }, async baseUrl => {
      const env = {
        ...process.env,
        AIWORKER_VIDEO_BATCH_DIR: batchRoot,
        AIWORKER_MEDIA_INGEST_DIR: join(root, 'inbox'),
      }
      const single = await execute(process.execPath, [
        submitScript.pathname,
        '--video-file', video,
        '--task-id', taskId,
        '--idempotency-key', taskId,
        '--base-url', baseUrl,
        '--delivery', 'none',
        '--wait-seconds', '0',
        '--no-trigger-recovery',
      ], { env })
      assert.deepEqual(JSON.parse(single.stdout), {
        taskId,
        status: 'maintenance',
        duplicate: false,
        intakePaused: true,
      })

      const batch = await execute(process.execPath, [
        submitScript.pathname,
        '--video-dir', directory,
        '--batch-id', batchId,
        '--base-url', baseUrl,
        '--delivery', 'none',
      ], { env })
      assert.deepEqual(JSON.parse(batch.stdout), {
        batchId,
        status: 'maintenance',
        duplicate: false,
        intakePaused: true,
      })
    })
    assert.equal(requests, 2)
    await assert.rejects(access(batchRoot), { code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('worker parks an intake race with staged media and resumes the same task after intake reopens', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-intake-race-'))
  const batchRoot = join(root, 'batches')
  const inboxRoot = join(root, 'inbox')
  const video = join(root, 'video.mp4')
  const taskId = `video-command-${'c'.repeat(64)}`
  await writeFile(video, 'park-and-resume-video')

  let accepting = false
  let acceptedVideoKey = null
  const dispatchedTaskIds = []
  try {
    await withPlatform(async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/api/n8n/runs') {
        response.writeHead(200, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({
          runs: acceptedVideoKey === null ? [] : [{
            taskId,
            status: 'succeeded',
            input: { videoKey: acceptedVideoKey },
            output: { summary: 'done' },
          }],
        }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/n8n/trigger') {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        dispatchedTaskIds.push(body.taskId)
        if (!accepting) {
          response.writeHead(423, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ code: 'N8N_INTAKE_DRAINING', error: 'draining' }))
          return
        }
        acceptedVideoKey = body.input.videoKey
        response.writeHead(202, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ taskId, status: 'accepted', duplicate: false }))
        return
      }
      response.writeHead(404).end()
    }, async baseUrl => {
      const created = await createSingleVideoState({
        taskId,
        idempotencyKey: taskId,
        baseUrl,
        bindingId: 1,
        prompt: '分析视频',
        videoFile: video,
        inboxRoot,
        batchRoot,
      })
      const env = {
        ...process.env,
        AIWORKER_VIDEO_BATCH_DIR: batchRoot,
        AIWORKER_MEDIA_INGEST_DIR: inboxRoot,
      }

      await execute(process.execPath, [workerScript.pathname, '--state-file', created.statePath], { env })
      const parked = await readBatchState(created.statePath)
      assert.equal(parked.status, 'recovering')
      assert.equal(parked.items[0].taskId, taskId)
      assert.equal(parked.items[0].status, 'staging')
      assert.equal(parked.items[0].stagingRecovery.phase, 'triggering')
      assert.deepEqual(await readdir(inboxRoot), [parked.items[0].stagingRecovery.videoKey])

      accepting = true
      await execute(process.execPath, [workerScript.pathname, '--state-file', created.statePath], { env })
      const completed = await readBatchState(created.statePath)
      assert.equal(completed.status, 'succeeded')
      assert.equal(completed.items[0].taskId, taskId)
      assert.equal(completed.items[0].status, 'succeeded')
      assert.equal(Object.hasOwn(completed.items[0], 'stagingRecovery'), false)
      assert.deepEqual(await readdir(inboxRoot), [])
    })
    assert.deepEqual(dispatchedTaskIds, [taskId, taskId])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
