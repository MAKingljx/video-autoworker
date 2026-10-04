import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join } from 'node:path'

import { createImageJobClient } from './image-job-client.js'
import { IMAGE_AGENT_ID, imageReceipt, imageSessionScope } from './image-command-tool.js'

const SCHEMA = 'aiworker-image-notifications/v1'
const JOB_ID = /^[0-9a-f]{32}$/u
const TERMINAL_NOTICE = new Set(['GENERATED_PENDING_REVIEW', 'FAILED', 'CANCELLED', 'RECONCILE_REQUIRED'])
const MAX_SUBSCRIPTIONS = 256
const MAX_PENDING = 1000
const MAX_NOTIFIED = 64
const FILE_BYTES_LIMIT = 1024 * 1024

function validateSubscription(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['scope', 'sessionKey', 'pendingJobIds', 'notified'].includes(key))
    || typeof value.scope !== 'string' || !/^[0-9a-f]{64}$/u.test(value.scope)
    || imageSessionScope({ agentId: IMAGE_AGENT_ID, sessionKey: value.sessionKey }) !== value.scope
    || !Array.isArray(value.pendingJobIds) || value.pendingJobIds.length > MAX_PENDING
    || value.pendingJobIds.some(id => typeof id !== 'string' || !JOB_ID.test(id))
    || new Set(value.pendingJobIds).size !== value.pendingJobIds.length
    || !value.notified || typeof value.notified !== 'object' || Array.isArray(value.notified)
    || Object.keys(value.notified).length > MAX_PENDING + MAX_NOTIFIED
    || Object.entries(value.notified).some(([id, marker]) => !JOB_ID.test(id)
      || typeof marker !== 'string' || !/^[A-Z_]+:[0-9TZ:+. -]{0,64}$/u.test(marker))) {
    throw new Error('image_notification_subscription_invalid')
  }
  return { scope: value.scope, sessionKey: value.sessionKey,
    pendingJobIds: [...value.pendingJobIds], notified: { ...value.notified } }
}

async function readStore(path) {
  let file
  try {
    const parent = await lstat(dirname(path))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('image_notification_store_invalid')
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > FILE_BYTES_LIMIT || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('image_notification_store_invalid')
    }
    const data = JSON.parse(await file.readFile('utf8'))
    if (data?.schema !== SCHEMA || !Array.isArray(data.subscriptions)
      || data.subscriptions.length > MAX_SUBSCRIPTIONS) throw new Error('image_notification_store_invalid')
    const rows = data.subscriptions.map(validateSubscription)
    if (new Set(rows.map(row => row.scope)).size !== rows.length) throw new Error('image_notification_store_invalid')
    return new Map(rows.map(row => [row.scope, row]))
  } finally { await file.close() }
}

async function writeStore(path, subscriptions) {
  const content = JSON.stringify({ schema: SCHEMA, subscriptions: [...subscriptions.values()] })
  if (Buffer.byteLength(content) > FILE_BYTES_LIMIT) throw new Error('image_notification_limit')
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  if (!(await lstat(parent)).isDirectory() || (await lstat(parent)).isSymbolicLink()) {
    throw new Error('image_notification_store_invalid')
  }
  await chmod(parent, 0o700)
  const temporary = `${path}.${randomUUID()}.tmp`
  let file
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    await file.writeFile(content)
    await file.sync()
    await file.close()
    file = null
    await rename(temporary, path)
  } finally {
    await file?.close()
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
  }
}

function noticeText(r) {
  if (r.currentState === 'GENERATED_PENDING_REVIEW') {
    return `H1 图片任务 ${r.jobId} 已生成候选图片。请调用 aiworker_generate_image 的 result 读取并展示图片，提醒检查中文与画面；不得重新生成、叠字、采用或发布。`
  }
  const states = { FAILED: '生成失败', CANCELLED: '已取消', RECONCILE_REQUIRED: '状态需要核对' }
  return `H1 图片任务 ${r.jobId} ${states[r.currentState]}。请调用 aiworker_generate_image 的 status 核对收据并如实告知；不要自行重新提交或重试生成。`
}

// This store owns delivery subscriptions only. A notified marker means that
// an event was queued in this process, never that a channel delivered it.
// Job truth, scheduling, cancellation and recovery stay in the application.
export function createImageNotifications({ client = createImageJobClient(), system, pollIntervalMs = 5000 } = {}) {
  let subscriptions = new Map()
  let storagePath
  let controller
  let timer
  let stopped = true
  let running
  let saveQueue = Promise.resolve()
  let logger
  const warnedScopes = new Set()

  function save() {
    saveQueue = saveQueue.catch(() => {}).then(() => writeStore(storagePath, subscriptions))
    return saveQueue
  }

  async function poll() {
    if (stopped || running) return running
    running = (async () => {
      for (const subscription of subscriptions.values()) {
        const awaitingQueue = subscription.pendingJobIds.filter(id => !subscription.notified[id])
        if (stopped || !awaitingQueue.length) continue
        try {
          const listed = await client.list(subscription.scope, controller.signal)
          if (!Array.isArray(listed.jobs) || listed.jobs.length > 20) throw new Error('image_notification_receipt_invalid')
          const recent = new Map(listed.jobs.map(data => {
            const r = imageReceipt(data)
            return [r.jobId, r]
          }))
          for (const jobId of awaitingQueue) {
            if (stopped) break
            // A bounded recent list may omit an older pending delivery. Read
            // that exact owned job instead of creating a second job registry.
            const r = recent.get(jobId)
              || imageReceipt(await client.status(jobId, subscription.scope, controller.signal), jobId)
            if (!TERMINAL_NOTICE.has(r.currentState)) continue
            const marker = `${r.currentState}:${r.updatedAt || ''}`
            if (subscription.notified[jobId] !== marker) {
              system.enqueueSystemEvent(noticeText(r), {
                sessionKey: subscription.sessionKey,
                contextKey: `aiworker-image:${jobId}:${marker}`,
              })
              // The configured profile controls delivery. There is no model-
              // supplied chat target and no direct Feishu outbound call.
              system.requestHeartbeatNow({ agentId: IMAGE_AGENT_ID,
                sessionKey: subscription.sessionKey, reason: `aiworker-image:${jobId}` })
              subscription.notified[jobId] = marker
            }
            // Keep the delivery intent until the trusted session reads the
            // result/error. OpenClaw system events can be lost on a crash.
            await save()
          }
          warnedScopes.delete(subscription.scope)
        } catch {
          if (!stopped && !warnedScopes.has(subscription.scope)) {
            warnedScopes.add(subscription.scope)
            logger?.warn?.('Image completion notification is pending; application status will be queried again.')
          }
        }
      }
    })()
    try { await running } finally { running = null }
  }

  function schedule() {
    if (stopped) return
    timer = setTimeout(async () => { await poll(); schedule() }, pollIntervalMs)
    timer.unref?.()
  }

  return {
    id: 'aiworker-image-notifications',
    async start(context) {
      if (!stopped) return
      if (typeof context?.stateDir !== 'string' || !isAbsolute(context.stateDir)
        || /[\u0000-\u001f\u007f]/u.test(context.stateDir)) throw new Error('image_notification_state_dir_invalid')
      if (typeof system?.enqueueSystemEvent !== 'function' || typeof system?.requestHeartbeatNow !== 'function') {
        throw new Error('image_notification_runtime_unavailable')
      }
      storagePath = join(context.stateDir, 'aiworker-image-command', 'notifications.json')
      subscriptions = await readStore(storagePath)
      // Requeue unacknowledged events after a restart. The backend is reread;
      // the persisted marker is not a task state or a delivery receipt.
      for (const row of subscriptions.values()) {
        for (const jobId of row.pendingJobIds) delete row.notified[jobId]
      }
      logger = context.logger
      controller = new AbortController()
      stopped = false
      schedule()
    },
    async stop() {
      stopped = true
      clearTimeout(timer)
      controller?.abort()
      await running
      await saveQueue.catch(() => {})
    },
    async subscribe({ jobId, scope, sessionKey }) {
      if (stopped || !storagePath || typeof jobId !== 'string' || !JOB_ID.test(jobId)
        || typeof scope !== 'string' || !/^[0-9a-f]{64}$/u.test(scope)
        || imageSessionScope({ agentId: IMAGE_AGENT_ID, sessionKey }) !== scope) {
        throw new Error('image_notification_subscription_invalid')
      }
      let subscription = subscriptions.get(scope)
      if (!subscription) {
        if (subscriptions.size >= MAX_SUBSCRIPTIONS) throw new Error('image_notification_limit')
        subscription = { scope, sessionKey, pendingJobIds: [], notified: {} }
        subscriptions.set(scope, subscription)
      }
      if (subscription.notified[jobId] || subscription.pendingJobIds.includes(jobId)) return
      if (subscription.pendingJobIds.length >= MAX_PENDING) throw new Error('image_notification_limit')
      subscription.pendingJobIds.push(jobId)
      await save()
    },
    async acknowledge({ jobId, scope, sessionKey }) {
      if (stopped || typeof scope !== 'string' || !/^[0-9a-f]{64}$/u.test(scope)
        || imageSessionScope({ agentId: IMAGE_AGENT_ID, sessionKey }) !== scope
        || typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new Error('image_notification_subscription_invalid')
      const subscription = subscriptions.get(scope)
      if (!subscription?.pendingJobIds.includes(jobId)) return
      subscription.pendingJobIds = subscription.pendingJobIds.filter(id => id !== jobId)
      subscription.notified[jobId] = 'READ:'
      const acknowledged = Object.keys(subscription.notified).filter(id => !subscription.pendingJobIds.includes(id))
      for (const id of acknowledged.slice(0, Math.max(0, acknowledged.length - MAX_NOTIFIED))) delete subscription.notified[id]
      await save()
    },
    // Exposed for deterministic service tests; there is no OpenClaw tool for it.
    poll,
  }
}
