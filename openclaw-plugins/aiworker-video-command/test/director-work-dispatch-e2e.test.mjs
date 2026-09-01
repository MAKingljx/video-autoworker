import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

import { createQwenBeforeDispatchHandler } from '../lib/qwen-before-dispatch.js'
import { createQwenClassifier } from '../lib/qwen-video-classifier.js'
import { createSchedulerRunner } from '../lib/scheduler-runner.js'
import { readSingleVideoTaskState } from '../../../openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs'

const executeFile = promisify(execFile)
const submitTaskScript = new URL(
  '../../../openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs',
  import.meta.url,
).pathname
const sessionKey = 'agent:second-original:telegram:direct:123456'
const context = {
  channelId: 'telegram',
  sessionKey,
  senderId: 'telegram:123456',
  accountId: 'account',
  conversationId: 'conversation',
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function waitFor(read, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  let value
  do {
    value = await read()
    if (predicate(value)) return value
    await delay(25)
  } while (Date.now() < deadline)
  throw new Error('timed_out_waiting_for_director_work_dispatch')
}

async function stopWorker(batchRoot) {
  const lockPath = join(batchRoot, '.global-video-worker.lock')
  const ownership = await waitFor(
    async () => {
      try {
        return JSON.parse(await readFile(lockPath, 'utf8'))
      } catch {
        return null
      }
    },
    value => Number.isInteger(value?.pid) && value.pid > 0,
  )
  try {
    process.kill(ownership.pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  await waitFor(
    async () => {
      try {
        process.kill(ownership.pid, 0)
        return false
      } catch (error) {
        if (error?.code === 'ESRCH') return true
        throw error
      }
    },
    stopped => stopped,
  )
}

async function stopWorkerIfRunning(batchRoot) {
  let ownership
  try {
    ownership = JSON.parse(await readFile(join(batchRoot, '.global-video-worker.lock'), 'utf8'))
  } catch {
    return
  }
  if (!Number.isInteger(ownership?.pid) || ownership.pid <= 0) return
  try {
    process.kill(ownership.pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}

describe('director work natural-language dispatch integration', () => {
  const cleanups = []

  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()()
  })

  it('carries the verbatim work through the real scheduler and task-flow processes into the trigger POST', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiworker-director-dispatch-e2e-'))
    const batchRoot = join(root, 'batches')
    const inboxRoot = join(root, 'inbox')
    const videoPath = join(root, 'director-acceptance.mp4')
    await mkdir(batchRoot, { mode: 0o700 })
    await writeFile(videoPath, 'director-brain-acceptance-video')
    cleanups.push(async () => rm(root, { recursive: true, force: true }))

    let triggerBody = null
    const server = createServer(async (request, response) => {
      const url = new URL(request.url, 'http://127.0.0.1')
      response.setHeader('Content-Type', 'application/json')
      if (request.method === 'GET' && url.pathname === '/api/n8n/intake-control') {
        response.writeHead(200).end(JSON.stringify({ control: { accepting: true } }))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/n8n/workflows') {
        response.writeHead(200).end(JSON.stringify({
          bindings: [{ id: 7, enabled: true, taskType: 'video-analysis' }],
        }))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/n8n/runs') {
        response.writeHead(200).end(JSON.stringify({
          runs: triggerBody === null ? [] : [{
            taskId: triggerBody.taskId,
            status: 'succeeded',
            input: { videoKey: triggerBody.input.videoKey },
            output: { summary: 'accepted' },
          }],
        }))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/n8n/trigger') {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        triggerBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        response.writeHead(202).end(JSON.stringify({
          taskId: triggerBody.taskId,
          status: 'accepted',
          duplicate: false,
        }))
        return
      }
      response.writeHead(404).end(JSON.stringify({ error: 'not_found' }))
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    expect(address).toEqual(expect.objectContaining({ address: '127.0.0.1' }))
    cleanups.push(async () => {
      server.closeAllConnections?.()
      await new Promise(resolve => server.close(() => resolve()))
    })
    cleanups.push(() => stopWorkerIfRunning(batchRoot))

    const environment = {
      ...process.env,
      AIWORKER_PLATFORM_URL: `http://127.0.0.1:${address.port}`,
      AIWORKER_VIDEO_BATCH_DIR: batchRoot,
      AIWORKER_MEDIA_INGEST_DIR: inboxRoot,
      AIWORKER_VIDEO_RECOVERY_BACKOFF_MS: '1000',
    }
    const runner = createSchedulerRunner({
      scriptPath: submitTaskScript,
      nodePath: process.execPath,
      execute: async (file, arguments_, options) => executeFile(file, arguments_, {
        ...options,
        env: environment,
      }),
    })
    const classifier = createQwenClassifier({
      complete: async () => ({
        text: JSON.stringify({
          action: 'dispatch_single',
          value: videoPath,
          directorWork: '导演脑验收片',
        }),
        agentId: 'second-original',
      }),
      timeoutMs: 1_000,
    })
    const beforeDispatch = createQwenBeforeDispatchHandler({ classifier, runner })

    const result = await beforeDispatch({
      content: `请分析视频 ${videoPath} 并归入作品 导演脑验收片`,
      channel: 'telegram',
      isGroup: false,
      sessionKey,
      senderId: 'telegram:123456',
      timestamp: 1_788_192_000_000,
    }, context)
    const taskId = result.text.match(/video-natural-[a-f0-9]{64}/u)?.[0]
    expect(taskId).toBeTruthy()
    expect(result.text).toBe(`已提交，任务编号：${taskId}。结果请稍后查询。`)

    const durable = await readSingleVideoTaskState(taskId, batchRoot)
    expect(durable.state.directorWork).toBe('导演脑验收片')

    await waitFor(() => Promise.resolve(triggerBody), value => value !== null)
    expect(triggerBody).toEqual(expect.objectContaining({
      taskId,
      idempotencyKey: taskId,
      source: 'openclaw',
      directorWork: '导演脑验收片',
    }))
    expect(triggerBody.input).not.toHaveProperty('directorWork')
    await stopWorker(batchRoot)
  }, 30_000)
})
