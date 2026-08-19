#!/usr/bin/env node

import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createPlatformClient, isRetryablePlatformError } from '../lib/platform-client.mjs'
import { submitVideoTask } from '../lib/video-task.mjs'
import {
  acquireBatchLock,
  acquireGlobalBatchLock,
  batchItemDisplayName,
  listBatchStatePaths,
  prepareBatchStateForExecution,
  readBatchState,
  verifyBatchItemSource,
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
const terminal = status => ['succeeded', 'failed', 'cancelled'].includes(status)
const batchTerminal = status => ['succeeded', 'completed_with_errors'].includes(status)
const recoveryRunnable = status => ['queued', 'running', 'recovering'].includes(status)
const HEARTBEAT_INTERVAL_MS = Math.max(1_000, Math.min(30_000,
  Number(process.env.AIWORKER_VIDEO_WORKER_HEARTBEAT_MS || 10_000)))
const RECOVERY_BACKOFF_MS = Math.max(1_000, Math.min(5 * 60_000,
  Number(process.env.AIWORKER_VIDEO_RECOVERY_BACKOFF_MS || 30_000)))

async function persist(statePath, state) {
  state.worker = { pid: process.pid, heartbeatAt: new Date().toISOString() }
  return writeBatchState(statePath, state)
}

async function waitForTask(client, statePath, state, item, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1_000
  let lastStatus = item.status
  let lastHeartbeatAt = 0
  while (Date.now() <= deadline) {
    const run = await client.getRun(item.taskId)
    if (run) {
      item.status = run.status
      item.error = run.error || null
      if (item.status !== lastStatus || terminal(item.status) || Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
        lastStatus = item.status
        lastHeartbeatAt = Date.now()
        state = await persist(statePath, state)
      }
      if (terminal(item.status)) {
        item.completedAt = new Date().toISOString()
        state = await persist(statePath, state)
        return { state, terminal: true }
      }
    } else {
      state = await persist(statePath, state)
    }
    await sleep(5_000)
  }
  item.status = 'waiting'
  item.error = `等待任务 ${item.taskId} 超时；队列将保留同一任务编号并由恢复控制器继续查询`
  state.status = 'recovering'
  state = await persist(statePath, state)
  return { state, terminal: false }
}

async function runBatch(statePath) {
  let state = await prepareBatchStateForExecution(statePath)
  if (state.status === 'paused') return state
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
      await verifyBatchItemSource(item)
      const response = await submitVideoTask({
        client,
        bindingId: state.bindingId,
        taskId: item.taskId,
        idempotencyKey: item.idempotencyKey,
        prompt: state.prompt,
        videoFile: item.sourcePath,
        displayName: item.name,
        batchId: state.batchId,
        batchIndex: item.index,
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

  const failed = state.items.filter(item => item.status !== 'succeeded').length
  state.status = failed ? 'completed_with_errors' : 'succeeded'
  state.error = failed ? `${failed} 个视频失败；其余视频已完成` : null
  return persist(statePath, state)
}

async function drainQueue(anchorStatePath) {
  while (true) {
    const statePaths = await listBatchStatePaths(anchorStatePath, {
      onWarning: warning => process.stderr.write(`${warning}\n`),
    })
    let pending = false
    let progressed = false
    for (const statePath of statePaths) {
      const state = await readBatchState(statePath)
      if (batchTerminal(state.status) || !recoveryRunnable(state.status)) continue
      pending = true
      const lock = await acquireBatchLock(statePath)
      if (!lock.acquired) continue
      try {
        const nextState = await runBatch(statePath)
        if (!batchTerminal(nextState.status)) return
        progressed = true
      } catch (error) {
        const failedState = await readBatchState(statePath).catch(() => null)
        if (failedState) {
          failedState.status = isRetryablePlatformError(error) ? 'recovering' : 'paused'
          failedState.error = (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
          await writeBatchState(statePath, failedState).catch(() => undefined)
        }
        if (isRetryablePlatformError(error)) return
        throw error
      } finally {
        await lock.release()
      }
    }
    if (!pending) return
    if (progressed) continue
    // Paused batches are deliberately skipped and require explicit resume.
    return
  }
}

async function main() {
  const serve = args.includes('--serve')
  const serveRoot = option('--serve-root')
  const validRootMode = serveRoot && args.length === 2 && args[0] === '--serve-root'
  const validStateMode = !serveRoot && ((serve && args.length === 3 && args[0] === '--state-file' && args[2] === '--serve')
    || (!serve && args.length === 2 && args[0] === '--state-file'))
  if (!validRootMode && !validStateMode) {
    throw new Error('批次 worker 只接受 --state-file <path> [--serve] 或 --serve-root <batch-root>')
  }
  const statePath = serveRoot
    ? resolve(serveRoot, '.serve-root-anchor')
    : option('--state-file')
  const persistent = Boolean(serveRoot || serve)
  const lock = await acquireGlobalBatchLock(statePath)
  // One current worker already owns the global lane and will discover every
  // persisted queued job. Exit instead of accumulating detached waiters.
  if (!lock.acquired) return
  try {
    // The launch semaphore covers only the handoff window: a concurrent submit
    // that observed an existing launcher can now rely on this worker's scan.
    await rm(resolve(dirname(statePath), '.worker-launch.lock'), { force: true }).catch(() => undefined)
    do {
      await drainQueue(statePath)
      if (!persistent) break
      await sleep(RECOVERY_BACKOFF_MS)
    } while (true)
  } finally {
    await lock.release()
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
