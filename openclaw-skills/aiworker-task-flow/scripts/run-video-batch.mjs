#!/usr/bin/env node

import { rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import {
  createPlatformClient,
  isN8nIntakeDrainingError,
  isRetryablePlatformError,
} from '../lib/platform-client.mjs'
import { isTerminalTaskStatus } from '../lib/task-status-authority.mjs'
import { submitStagedVideoTask, submitVideoTask } from '../lib/video-task.mjs'
import {
  acquireBatchLock,
  acquireGlobalBatchLock,
  batchItemDisplayName,
  cleanupBatchItemStagedMedia,
  listBatchStatePaths,
  loadBatchItemStagedMedia,
  prepareBatchStateForExecution,
  readBatchState,
  recoverBatchItemStaging,
  sourceFingerprintFromIdentity,
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
const batchTerminal = status => ['succeeded', 'completed_with_errors'].includes(status)
const recoveryRunnable = status => ['queued', 'running', 'recovering'].includes(status)
const activeParent = status => ['accepted', 'running'].includes(status)
const cleanupPhase = phase => ['discarding_prepared', 'discarding'].includes(phase)
const handoffPhase = phase => ['staged', 'triggering'].includes(phase)
const HEARTBEAT_INTERVAL_MS = Math.max(1_000, Math.min(30_000,
  Number(process.env.AIWORKER_VIDEO_WORKER_HEARTBEAT_MS || 10_000)))
const configuredReconcileInterval = Number(process.env.AIWORKER_VIDEO_RECONCILE_INTERVAL_MS || 60_000)
const RECONCILE_INTERVAL_MS = Number.isFinite(configuredReconcileInterval)
  && configuredReconcileInterval >= 1_000
  && configuredReconcileInterval <= 5 * 60_000
  ? configuredReconcileInterval
  : 60_000
const RECOVERY_BACKOFF_MS = Math.max(1_000, Math.min(5 * 60_000,
  Number(process.env.AIWORKER_VIDEO_RECOVERY_BACKOFF_MS || 30_000)))

async function persist(statePath, state) {
  state.worker = { pid: process.pid, heartbeatAt: new Date().toISOString() }
  return writeBatchState(statePath, state)
}

function recoveryBinding(state, item) {
  return {
    taskId: item.taskId,
    idempotencyKey: item.idempotencyKey,
    batchId: state.batchId,
  }
}

function authoritativeVideoKey(run) {
  return typeof run?.input?.videoKey === 'string' && run.input.videoKey
    ? run.input.videoKey
    : null
}

async function waitForTask(client, statePath, state, item, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1_000
  let lastStatus = item.status
  let lastHeartbeatAt = 0
  let nextReconcileAt = Date.now() + RECONCILE_INTERVAL_MS
  while (Date.now() <= deadline) {
    const run = await client.getRun(item.taskId)
    if (run) {
      item.status = run.status
      item.error = run.error || null
      if (item.status !== lastStatus || isTerminalTaskStatus(item.status) || Date.now() - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
        lastStatus = item.status
        lastHeartbeatAt = Date.now()
        state = await persist(statePath, state)
      }
      if (isTerminalTaskStatus(item.status)) {
        item.completedAt = new Date().toISOString()
        state = await persist(statePath, state)
        return { state, terminal: true }
      }
      if (activeParent(item.status) && Date.now() >= nextReconcileAt) {
        const reconciled = await client.request('/api/n8n/runs/reconcile', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: item.taskId }),
        })
        nextReconcileAt = Date.now() + RECONCILE_INTERVAL_MS
        if (reconciled?.taskId === item.taskId && typeof reconciled.status === 'string') {
          item.status = reconciled.status
          item.error = typeof reconciled.error === 'string' ? reconciled.error : null
          lastStatus = item.status
          lastHeartbeatAt = Date.now()
          if (isTerminalTaskStatus(item.status)) item.completedAt = new Date().toISOString()
          state = await persist(statePath, state)
          if (isTerminalTaskStatus(item.status)) return { state, terminal: true }
        }
      } else if (!activeParent(item.status) && Date.now() >= nextReconcileAt) {
        nextReconcileAt = Date.now() + RECONCILE_INTERVAL_MS
      }
    } else {
      state = await persist(statePath, state)
      if (Date.now() >= nextReconcileAt) {
        nextReconcileAt = Date.now() + RECONCILE_INTERVAL_MS
      }
    }
    await sleep(Math.min(5_000, Math.max(1, nextReconcileAt - Date.now())))
  }
  item.status = 'waiting'
  item.error = `等待任务 ${item.taskId} 超时；队列将保留同一任务编号并由恢复控制器继续查询`
  state.status = 'recovering'
  state = await persist(statePath, state)
  return { state, terminal: false }
}

async function runBatch(statePath) {
  let state = await prepareBatchStateForExecution(statePath)
  const entryStatus = state.status
  const entryError = state.error || null
  const reconciliationOnly = entryStatus === 'paused' || batchTerminal(entryStatus)
  const journalPendingAtEntry = state.items.some(item => item?.stagingRecovery)
  if (reconciliationOnly && !journalPendingAtEntry) return state
  const client = createPlatformClient(state.baseUrl)
  const timeoutSeconds = Math.max(3_600, Math.min(86_400,
    Number(process.env.AIWORKER_VIDEO_BATCH_ITEM_TIMEOUT_SECONDS || 28_800)))
  if (!reconciliationOnly) {
    state.status = 'running'
    state.error = null
    state = await persist(statePath, state)
  }

  for (const item of state.items) {
    const binding = recoveryBinding(state, item)
    const applyRecoveredSourceIdentity = recovered => {
      if (!recovered?.sourceIdentity) return
      item.sourceIdentity = recovered.sourceIdentity
      item.sourceFingerprint = sourceFingerprintFromIdentity(item.sourcePath, recovered.sourceIdentity)
    }
    const finishJournalCleanup = async () => {
      try {
        const recovered = await cleanupBatchItemStagedMedia(item, {
          inboxRoot: state.inboxRoot,
          binding,
        })
        applyRecoveredSourceIdentity(recovered)
        delete item.stagingRecovery
        state = await persist(statePath, state)
        return true
      } catch (error) {
        const cleanupError = `${batchItemDisplayName(item)}：${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000)
        if (!isTerminalTaskStatus(item.status)) {
          item.status = 'recovering'
          item.error = cleanupError
          delete item.completedAt
        }
        state.status = 'recovering'
        state.error = cleanupError
        state = await persist(statePath, state)
        return false
      }
    }
    const finalizeTerminalJournal = async () => {
      if (!handoffPhase(item.stagingRecovery?.phase)) return true
      item.stagingRecovery = { ...item.stagingRecovery, phase: 'discarding' }
      state = await persist(statePath, state)
      return finishJournalCleanup()
    }

    try {
      // Attention items are explicitly quarantined: keep their journal and
      // media untouched while allowing the rest of this batch to advance.
      if (item.status === 'attention') continue

      // A journal that already committed to local discard must finish that
      // discard before platform or terminal-state shortcuts are considered.
      if (cleanupPhase(item.stagingRecovery?.phase) && !await finishJournalCleanup()) {
        return state
      }

      if (item.stagingRecovery && !handoffPhase(item.stagingRecovery.phase)) {
        const recoveredStaging = await recoverBatchItemStaging(item, {
            inboxRoot: state.inboxRoot,
            binding,
            onCheckpoint: async recovery => {
              item.stagingRecovery = recovery
              state = await persist(statePath, state)
            },
          })
        applyRecoveredSourceIdentity(recoveredStaging)
        delete item.stagingRecovery
        state = await persist(statePath, state)
      }

      if (isTerminalTaskStatus(item.status) && !item.stagingRecovery) continue

      if (reconciliationOnly && !handoffPhase(item.stagingRecovery?.phase)) continue

      let existing = await client.getRun(item.taskId)
      if (existing && handoffPhase(item.stagingRecovery?.phase)) {
        const existingVideoKey = authoritativeVideoKey(existing)
        if (existingVideoKey === item.stagingRecovery.videoKey) {
          if (isTerminalTaskStatus(existing.status)) {
            // Once the exact task is terminal, the platform can no longer be
            // reading the handoff. Remove any exact-identity residue before
            // releasing the journal, including failed and cancelled runs.
            if (!await finalizeTerminalJournal()) return state
          } else if (existing.status === 'queued') {
            // A DB row may exist before downstream dispatch. Re-submit the
            // same idempotency key and exact video key to resume that bounded
            // handoff instead of waiting forever on an inert queued record.
            existing = null
          }
        } else if (existingVideoKey !== null) {
          // The stable task belongs to another artifact. This journal's clone
          // is redundant and remains locally owned until durable cleanup.
          item.stagingRecovery = { ...item.stagingRecovery, phase: 'discarding' }
          state = await persist(statePath, state)
          if (!await finishJournalCleanup()) return state
        } else {
          item.status = 'attention'
          item.error = `${batchItemDisplayName(item)}：平台记录未提供可验证的视频标识，保留本地暂存等待复核`.slice(0, 2_000)
          item.completedAt = new Date().toISOString()
          state = await persist(statePath, state)
          continue
        }
      }

      // A paused or terminal batch may reconcile journal ownership and local
      // cleanup, but it must not resume submissions or waiting work.
      if (reconciliationOnly) continue

      if (existing) {
        item.status = existing.status
        item.error = existing.error || null
        if (isTerminalTaskStatus(existing.status)) {
          item.completedAt = item.completedAt || new Date().toISOString()
          state = await persist(statePath, state)
          continue
        }
        state = await persist(statePath, state)
        const waited = await waitForTask(client, statePath, state, item, timeoutSeconds)
        state = waited.state
        if (!waited.terminal) return state
        if (!await finalizeTerminalJournal()) return state
        continue
      }

      item.status = 'staging'
      item.error = null
      delete item.completedAt
      state = await persist(statePath, state)
      const lifecycleCallbacks = {
        onTriggerStarted: async () => {
          item.stagingRecovery = { ...item.stagingRecovery, phase: 'triggering' }
          state = await persist(statePath, state)
        },
        onLocalCleanupStarted: async () => {
          const phase = item.stagingRecovery?.materialId === null
            ? 'discarding_prepared'
            : 'discarding'
          item.stagingRecovery = { ...item.stagingRecovery, phase }
          state = await persist(statePath, state)
        },
        onMediaSettled: async () => {
          delete item.stagingRecovery
          state = await persist(statePath, state)
        },
      }
      let response
      if (handoffPhase(item.stagingRecovery?.phase)) {
        const staged = await loadBatchItemStagedMedia(item, {
          inboxRoot: state.inboxRoot,
          binding,
        })
        response = await submitStagedVideoTask({
          client,
          bindingId: state.bindingId,
          taskId: item.taskId,
          idempotencyKey: item.idempotencyKey,
          prompt: state.prompt,
          displayName: item.name,
          batchId: state.batchId,
          batchIndex: item.index,
          visionRoute: state.visionRoute,
          ...lifecycleCallbacks,
        }, staged)
      } else {
        const admittedSource = await verifyBatchItemSource(item, { inboxRoot: state.inboxRoot })
        response = await submitVideoTask({
        client,
        bindingId: state.bindingId,
        taskId: item.taskId,
        idempotencyKey: item.idempotencyKey,
        prompt: state.prompt,
        videoFile: item.sourcePath,
        expectedSourceIdentity: admittedSource.sourceIdentity,
        ...(item.trustedExistingMaterialId === undefined
          ? {}
          : { trustedExistingMaterialId: item.trustedExistingMaterialId }),
        displayName: item.name,
        batchId: state.batchId,
        batchIndex: item.index,
        visionRoute: state.visionRoute,
        inboxRoot: state.inboxRoot,
        onHashProgress: async () => {
          // Keep the durable worker heartbeat fresh while a large source is
          // hashed. No filename, path, size, or digest is emitted.
          state = await persist(statePath, state)
        },
        onStagingPrepared: async recovery => {
          item.stagingRecovery = recovery
          state = await persist(statePath, state)
        },
        onSourceAnchorCreated: async anchoredIdentity => {
          // Keep the admission identity immutable. The separate checkpoint is
          // written immediately after link(2), so producer recovery can prove
          // that exact ctime and reject any later chmod/chown while the anchor
          // is still present.
          item.stagingRecovery = {
            ...item.stagingRecovery,
            phase: 'anchor_observed',
            anchoredIdentity,
          }
          state = await persist(statePath, state)
        },
        onSourceStaged: async (sourceIdentity, artifact) => {
          // Hard-link anchoring intentionally changes source ctime. Persist the
          // descriptor-verified post-anchor identity so a retry does not treat
          // our own safe staging operation as external source drift.
          item.sourceFingerprint = sourceFingerprintFromIdentity(item.sourcePath, sourceIdentity)
          item.sourceIdentity = sourceIdentity
          item.stagingRecovery = {
            ...item.stagingRecovery,
            phase: 'source_finalized',
            sourceIdentity,
            incomingIdentity: artifact?.incomingIdentity || null,
          }
          state = await persist(statePath, state)
        },
        onStagingCompleted: async staged => {
          item.stagingRecovery = {
            ...item.stagingRecovery,
            phase: 'staged',
            sourceIdentity: staged.sourceIdentity,
            materialId: staged.materialId,
            stagedIdentity: staged.stagedIdentity,
            contentSha256: staged.contentSha256,
            ownershipToken: staged.ownershipToken,
          }
          state = await persist(statePath, state)
        },
        ...lifecycleCallbacks,
        })
      }
      if (response.status === 'queued' && handoffPhase(item.stagingRecovery?.phase)) {
        const queuedStaged = await loadBatchItemStagedMedia(item, {
          inboxRoot: state.inboxRoot,
          binding,
        })
        response = await submitStagedVideoTask({
          client,
          bindingId: state.bindingId,
          taskId: item.taskId,
          idempotencyKey: item.idempotencyKey,
          prompt: state.prompt,
          displayName: item.name,
          batchId: state.batchId,
          batchIndex: item.index,
          visionRoute: state.visionRoute,
          ...lifecycleCallbacks,
        }, queuedStaged)
        if (response.status === 'queued') {
          item.status = 'recovering'
          item.error = `${batchItemDisplayName(item)}：平台任务仍停留在 queued；已保留同一幂等交接供下轮有界续派`.slice(0, 2_000)
          delete item.completedAt
          state.status = 'recovering'
          state.error = item.error
          return persist(statePath, state)
        }
      }
      item.status = response.status || 'accepted'
      item.submittedAt = item.submittedAt || new Date().toISOString()
      item.error = response.error || null
      state = await persist(statePath, state)
      if (!isTerminalTaskStatus(item.status)) {
        const waited = await waitForTask(client, statePath, state, item, timeoutSeconds)
        state = waited.state
        if (!waited.terminal) return state
        if (!await finalizeTerminalJournal()) return state
      } else if (!await finalizeTerminalJournal()) {
        return state
      }
    } catch (error) {
      if (isN8nIntakeDrainingError(error)) {
        // Intake can close after the submit-side preflight. Park the batch
        // without changing item order/identity or discarding staged media;
        // the persistent worker will retry this exact handoff after reopen.
        state.status = 'recovering'
        state.error = `${batchItemDisplayName(item)}：${error.message}`.slice(0, 2_000)
        return persist(statePath, state)
      }
      if (isRetryablePlatformError(error)) throw error
      if (item.stagingRecovery) {
        item.status = 'recovering'
        item.error = `${batchItemDisplayName(item)}：${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000)
        delete item.completedAt
        state.status = 'recovering'
        return persist(statePath, state)
      }
      item.status = 'failed'
      item.error = `${batchItemDisplayName(item)}：${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000)
      item.completedAt = new Date().toISOString()
      state = await persist(statePath, state)
    }
  }

  if (reconciliationOnly) {
    state.status = entryStatus
    state.error = entryError
    return persist(statePath, state)
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
      const journalPending = state.items.some(item => item?.stagingRecovery && item.status !== 'attention')
      if ((batchTerminal(state.status) || !recoveryRunnable(state.status)) && !journalPending) continue
      pending = true
      const lock = await acquireBatchLock(statePath)
      if (!lock.acquired) continue
      try {
        const nextState = await runBatch(statePath)
        if (!batchTerminal(nextState.status)) {
          const remainingJournal = nextState.items.some(
            item => item?.stagingRecovery && item.status !== 'attention',
          )
          if (nextState.status === 'paused' && !remainingJournal) {
            progressed = true
            continue
          }
          return
        }
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
  // The launch marker only protects the short parent-to-worker handoff. Clear
  // it before acquiring the long-lived lane lock so startup failures cannot
  // strand future submissions behind a stale semaphore.
  await rm(resolve(dirname(statePath), '.worker-launch.lock'), { force: true }).catch(() => undefined)
  const lock = await acquireGlobalBatchLock(statePath)
  // One current worker already owns the global lane and will discover every
  // persisted queued job. Exit instead of accumulating detached waiters.
  if (!lock.acquired) return
  try {
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
