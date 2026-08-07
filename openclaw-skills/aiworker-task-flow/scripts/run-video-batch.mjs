#!/usr/bin/env node

import { createPlatformClient, isRetryablePlatformError } from '../lib/platform-client.mjs'
import { submitVideoTask } from '../lib/video-task.mjs'
import {
  acquireBatchLock,
  batchItemDisplayName,
  readBatchState,
  writeBatchState,
} from '../lib/video-batch-state.mjs'

const args = process.argv.slice(2)

function option(name) {
  const index = args.indexOf(name)
  if (index < 0) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`)
  return value
}

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const terminal = status => ['succeeded', 'failed'].includes(status)

async function persist(statePath, state) {
  return writeBatchState(statePath, state)
}

async function waitForTask(client, statePath, state, item, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1_000
  let lastStatus = item.status
  while (Date.now() <= deadline) {
    const run = await client.getRun(item.taskId)
    if (run) {
      item.status = run.status
      item.error = run.error || null
      if (item.status !== lastStatus || terminal(item.status)) {
        lastStatus = item.status
        state = await persist(statePath, state)
      }
      if (terminal(item.status)) {
        item.completedAt = new Date().toISOString()
        state = await persist(statePath, state)
        return { state, terminal: true }
      }
    }
    await sleep(5_000)
  }
  item.status = 'waiting'
  item.error = `等待任务 ${item.taskId} 超时；批次已暂停，可安全续跑并查询同一任务`
  state.status = 'paused'
  state = await persist(statePath, state)
  return { state, terminal: false }
}

async function runBatch(statePath) {
  let state = await readBatchState(statePath)
  const client = createPlatformClient(state.baseUrl)
  const timeoutSeconds = Math.max(3_600, Math.min(86_400,
    Number(process.env.AIWORKER_VIDEO_BATCH_ITEM_TIMEOUT_SECONDS || 28_800)))
  state.status = 'running'
  state.error = null
  state = await persist(statePath, state)

  for (const item of state.items) {
    if (terminal(item.status)) continue
    const existing = await client.getRun(item.taskId)
    if (existing) {
      item.status = existing.status
      item.error = existing.error || null
      if (terminal(existing.status)) {
        item.completedAt = item.completedAt || new Date().toISOString()
        state = await persist(statePath, state)
        continue
      }
      state = await persist(statePath, state)
      const waited = await waitForTask(client, statePath, state, item, timeoutSeconds)
      state = waited.state
      if (!waited.terminal) return state
      continue
    }

    item.status = 'staging'
    item.error = null
    state = await persist(statePath, state)
    try {
      const response = await submitVideoTask({
        client,
        bindingId: state.bindingId,
        taskId: item.taskId,
        idempotencyKey: item.idempotencyKey,
        prompt: state.prompt,
        videoFile: item.sourcePath,
        visionRoute: state.visionRoute,
        inboxRoot: state.inboxRoot,
      })
      item.status = response.status || 'accepted'
      item.submittedAt = item.submittedAt || new Date().toISOString()
      item.error = response.error || null
      state = await persist(statePath, state)
      if (!terminal(item.status)) {
        const waited = await waitForTask(client, statePath, state, item, timeoutSeconds)
        state = waited.state
        if (!waited.terminal) return state
      }
    } catch (error) {
      if (isRetryablePlatformError(error)) throw error
      item.status = 'failed'
      item.error = `${batchItemDisplayName(item)}：${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000)
      item.completedAt = new Date().toISOString()
      state = await persist(statePath, state)
    }
  }

  const failed = state.items.filter(item => item.status === 'failed').length
  state.status = failed ? 'completed_with_errors' : 'succeeded'
  state.error = failed ? `${failed} 个视频失败；其余视频已完成` : null
  return persist(statePath, state)
}

async function main() {
  const statePath = option('--state-file')
  if (!statePath) throw new Error('缺少 --state-file')
  const lock = await acquireBatchLock(statePath)
  if (!lock.acquired) return
  try {
    await runBatch(statePath)
  } catch (error) {
    const state = await readBatchState(statePath).catch(() => null)
    if (state) {
      state.status = 'paused'
      state.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
      await writeBatchState(statePath, state).catch(() => undefined)
    }
    throw error
  } finally {
    await lock.release()
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
