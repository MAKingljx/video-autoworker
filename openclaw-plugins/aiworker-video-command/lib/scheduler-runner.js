import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

import { executeFile, parseSingleLineJson } from './json-command.js'

export const INSTALLED_TASK_FLOW_SCRIPT = resolve(
  homedir(),
  'AI-worker-second-original-workspace',
  'skills',
  'aiworker-task-flow',
  'scripts',
  'submit-task.mjs',
)

const DISPATCH_TIMEOUT_MS = 25_000
const STATUS_TIMEOUT_MS = 15_000
const STATUS_SEARCH_TIMEOUT_MS = 15_000
const TASK_ID_PATTERN = /^(?:video-command|video-natural)-[a-f0-9]{64}$/u
const BATCH_ID_PATTERN = /^video-batch-[a-f0-9]{64}$/u
const DISPATCH_STATUSES = new Set([
  'queued', 'accepted', 'running', 'succeeded', 'failed', 'cancelled',
  'completed_with_errors',
])
const TASK_STATUSES = new Set(['queued', 'accepted', 'running', 'succeeded', 'failed', 'cancelled'])
const BATCH_STATUSES = new Set([
  'queued', 'running', 'recovering', 'paused', 'succeeded', 'completed_with_errors',
  'not_registered', 'unavailable',
])
const SEARCH_ITEM_STATUSES = new Set([
  'staging', 'queued', 'submitted', 'accepted', 'running', 'waiting', 'succeeded', 'failed',
  'cancelled', 'unknown',
])
const SEARCH_BATCH_STATUSES = new Set([
  ...BATCH_STATUSES,
  ...SEARCH_ITEM_STATUSES,
])
const MAX_SEARCH_QUERY_LENGTH = 512
const MAX_SEARCH_MATCHES = 32
const MAX_RESULT_OFFSET = 16 * 1024 * 1024
const MAX_RESULT_PAGE_BYTES = 24 * 1024
const BATCH_ITEM_TASK_ID_PATTERN = /^video-batch-[a-f0-9]{64}:video:\d{3}:[a-f0-9]{12}$/u
const MATERIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const MEDIA_HANDOFF_SCHEMA_VERSION = 1
const MEDIA_HANDOFF_OUTBOX_SCHEMA_VERSION = 1
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export function isSchedulerTaskId(value) {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value)
}

export function isSchedulerBatchId(value) {
  return typeof value === 'string' && BATCH_ID_PATTERN.test(value)
}

export function normalizeTrustedExistingMaterialId(value) {
  if (value === undefined) return undefined
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || !MATERIAL_ID_PATTERN.test(value)
  ) throw new Error('invalid_material_id')
  return value
}

export function defaultMediaHandoffRoot() {
  return resolve(process.env.AIWORKER_MEDIA_HANDOFF_DIR
    || join(homedir(), 'ai-worker/state/video-autoworker/media-handoffs'))
}

async function assertPrivateHandoffRoot(root) {
  const details = await lstat(root)
  if (!details.isDirectory() || details.isSymbolicLink()) throw new Error('unsafe_media_handoff_root')
  if ((details.mode & 0o777) !== 0o700) throw new Error('unsafe_media_handoff_root')
  if (typeof process.getuid === 'function' && details.uid !== process.getuid()) {
    throw new Error('unsafe_media_handoff_root')
  }
}

async function syncDirectory(path) {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    if (!['EISDIR', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function writeDurablePrivateText(path, text) {
  const tempPath = `${path}.tmp-${process.pid}-${randomUUID()}`
  let handle
  try {
    handle = await open(
      tempPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    await handle.chmod(0o600)
    await handle.writeFile(text, { encoding: 'utf8' })
    await handle.sync()
    await handle.close()
    handle = null
    await rename(tempPath, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw error
  }
}

function outboxPathForTask(taskId, root) {
  const digest = createHash('sha256').update(taskId).digest('hex')
  return join(root, `media-handoff-outbox-${digest}.json`)
}

function sourceIdentityMatches(expected, current) {
  return current.isFile()
    && current.dev === expected.dev
    && current.ino === expected.ino
    && current.size === expected.size
    && current.mtimeMs === expected.mtimeMs
    && current.ctimeMs === expected.ctimeMs
}

function stableSourceIdentityMatches(expected, current) {
  return current.isFile()
    && current.dev === expected.dev
    && current.ino === expected.ino
    && current.size === expected.size
    && current.mtimeMs === expected.mtimeMs
}

function storedSourceIdentityValid(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'ctimeMs,dev,ino,mtimeMs,size'
    && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => Number.isFinite(value[key]))
    && value.size > 0
  )
}

function storedSourceIdentityMatches(expected, current) {
  return storedSourceIdentityValid(expected)
    && sourceIdentityMatches(expected, { ...current, isFile: () => true })
}

function defaultVideoBatchRoot() {
  return resolve(process.env.AIWORKER_VIDEO_BATCH_DIR
    || join(homedir(), 'ai-worker/state/video-autoworker/video-batches'))
}

function singleVideoStatePath(taskId, root) {
  const taskDigest = createHash('sha256').update(taskId).digest('hex').slice(0, 32)
  const batchId = `single:${taskDigest}`
  return join(resolve(root), `${createHash('sha256').update(batchId).digest('hex')}.json`)
}

async function assertPrivateDirectory(path) {
  const requested = resolve(path)
  const details = await lstat(requested)
  if (
    !details.isDirectory()
    || details.isSymbolicLink()
    || (details.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && details.uid !== process.getuid())
  ) throw new Error('unsafe_media_handoff_state')
  const physical = await realpath(requested)
  const physicalDetails = await lstat(physical)
  if (
    !physicalDetails.isDirectory()
    || physicalDetails.isSymbolicLink()
    || physicalDetails.dev !== details.dev
    || physicalDetails.ino !== details.ino
    || (physicalDetails.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && physicalDetails.uid !== process.getuid())
  ) throw new Error('unsafe_media_handoff_state')
  return physical
}

function parseSingleStateProof(text, { taskId, videoPath, materialId }) {
  let state
  try {
    state = JSON.parse(text)
  } catch (error) {
    throw new Error('invalid_media_handoff_state', { cause: error })
  }
  const item = state?.items?.[0]
  const taskDigest = createHash('sha256').update(taskId).digest('hex').slice(0, 32)
  if (
    !state
    || typeof state !== 'object'
    || Array.isArray(state)
    || state.schemaVersion !== 2
    || state.kind !== 'single'
    || state.batchId !== `single:${taskDigest}`
    || typeof state.requestFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(state.requestFingerprint)
    || typeof state.inboxRoot !== 'string'
    || !isAbsolute(state.inboxRoot)
    || resolve(state.inboxRoot) !== state.inboxRoot
    || !Array.isArray(state.items)
    || state.items.length !== 1
    || !item
    || typeof item !== 'object'
    || Array.isArray(item)
    || item.taskId !== taskId
    || item.idempotencyKey !== taskId
    || item.sourcePath !== videoPath
    || item.trustedExistingMaterialId !== materialId
    || Object.hasOwn(item, 'materialId')
    || !storedSourceIdentityValid(item.sourceIdentity)
  ) throw new Error('invalid_media_handoff_state')
  return { state, item }
}

async function readPrivateSingleStateCandidate(path, context) {
  const details = await lstat(path)
  if (
    !details.isFile()
    || details.isSymbolicLink()
    || details.nlink !== 1
    || (details.mode & 0o777) !== 0o600
    || details.size < 2
    || details.size > 256 * 1024
    || (typeof process.getuid === 'function' && details.uid !== process.getuid())
  ) throw new Error('unsafe_media_handoff_state')
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (opened.dev !== details.dev || opened.ino !== details.ino) {
      throw new Error('changed_media_handoff_state')
    }
    return parseSingleStateProof(await handle.readFile({ encoding: 'utf8' }), context)
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function readSingleStateProof(context, batchRoot) {
  const root = await assertPrivateDirectory(batchRoot)
  const primary = singleVideoStatePath(context.taskId, root)
  try {
    return await readPrivateSingleStateCandidate(primary, context)
  } catch (primaryError) {
    if (!['ENOENT', 'invalid_media_handoff_state'].includes(primaryError?.code || primaryError?.message)) {
      throw primaryError
    }
  }
  return readPrivateSingleStateCandidate(`${primary}.bak`, context)
}

async function verifiedAnchorCheckpoint(outbox, current, proof) {
  const recovery = proof.item.stagingRecovery
  if (
    !recovery
    || typeof recovery !== 'object'
    || Array.isArray(recovery)
    || recovery.phase !== 'anchor_observed'
  ) return false
  const anchorMatch = /^\.source-anchor-(\d+)-([0-9a-f-]{36})$/u.exec(recovery.anchorName || '')
  if (
    !anchorMatch
    || !UUID_PATTERN.test(anchorMatch[2])
    || recovery.ownershipToken !== anchorMatch[2]
    || recovery.taskId !== outbox.taskId
    || recovery.idempotencyKey !== outbox.taskId
    || recovery.batchId !== proof.state.batchId
    || !storedSourceIdentityMatches(outbox.sourceIdentity, recovery.sourceIdentity)
    || !storedSourceIdentityMatches(recovery.anchoredIdentity, current)
  ) return false
  const inbox = await assertPrivateDirectory(proof.state.inboxRoot)
  const anchorPath = join(inbox, recovery.anchorName)
  if (dirname(anchorPath) !== inbox || basename(anchorPath) !== recovery.anchorName) return false
  const anchor = await lstat(anchorPath).catch(error => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  return Boolean(
    anchor
    && anchor.isFile()
    && !anchor.isSymbolicLink()
    && anchor.nlink >= 2
    && current.nlink >= 2
    && sourceIdentityMatches({
      dev: current.dev,
      ino: current.ino,
      size: current.size,
      mtimeMs: current.mtimeMs,
      ctimeMs: current.ctimeMs,
    }, anchor)
  )
}

async function verifiedWorkerCtimeDrift(outbox, current, { batchRoot }) {
  if (!stableSourceIdentityMatches(outbox.sourceIdentity, current)) return false
  let proof
  try {
    proof = await readSingleStateProof({
      taskId: outbox.taskId,
      videoPath: outbox.videoPath,
      materialId: outbox.materialId,
    }, batchRoot)
  } catch {
    return false
  }
  const recoveryPhase = proof.item.stagingRecovery?.phase
  if (recoveryPhase === 'anchor_observed') {
    return verifiedAnchorCheckpoint(outbox, current, proof)
  }
  // prepared/copy_observed precede a durable post-link or post-unlink source
  // identity checkpoint. They cannot distinguish link-induced ctime from a
  // later chmod/chown, so only finalized/later states (or a settled item with
  // no staging journal) may authorize an outbox identity advance.
  return storedSourceIdentityMatches(proof.item.sourceIdentity, current)
    && (recoveryPhase === undefined || [
    'source_finalized', 'staged', 'triggering', 'discarding_prepared', 'discarding',
    ].includes(recoveryPhase))
}

function parseOutbox(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error('invalid_media_handoff_outbox', { cause: error })
  }
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'createdAt,materialId,nonce,schemaVersion,sourceIdentity,taskId,videoPath'
    || value.schemaVersion !== MEDIA_HANDOFF_OUTBOX_SCHEMA_VERSION
    || !isSchedulerTaskId(value.taskId)
    || normalizeTrustedExistingMaterialId(value.materialId) !== value.materialId
    || typeof value.videoPath !== 'string'
    || typeof value.nonce !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.nonce)
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))
    || !value.sourceIdentity
    || typeof value.sourceIdentity !== 'object'
    || Array.isArray(value.sourceIdentity)
    || Object.keys(value.sourceIdentity).sort().join(',') !== 'ctimeMs,dev,ino,mtimeMs,size'
    || !['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => Number.isFinite(value.sourceIdentity[key]))
    || value.sourceIdentity.size <= 0
  ) throw new Error('invalid_media_handoff_outbox')
  return value
}

async function readPrivateFile(path, parser, { optional = false } = {}) {
  let details
  try {
    details = await lstat(path)
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null
    throw error
  }
  if (
    !details.isFile()
    || details.isSymbolicLink()
    || details.nlink !== 1
    || (details.mode & 0o777) !== 0o600
    || details.size < 2
    || details.size > 4_096
    || (typeof process.getuid === 'function' && details.uid !== process.getuid())
  ) throw new Error('unsafe_media_handoff_file')
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (opened.dev !== details.dev || opened.ino !== details.ino) {
      throw new Error('changed_media_handoff_file')
    }
    return parser(await handle.readFile({ encoding: 'utf8' }))
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function handoffPayload(outbox) {
  return {
    schemaVersion: MEDIA_HANDOFF_SCHEMA_VERSION,
    taskId: outbox.taskId,
    videoPath: outbox.videoPath,
    sourceIdentity: outbox.sourceIdentity,
    materialId: outbox.materialId,
    nonce: outbox.nonce,
  }
}

function parseHandoff(text) {
  let value
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error('invalid_media_handoff', { cause: error })
  }
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'materialId,nonce,schemaVersion,sourceIdentity,taskId,videoPath'
  ) throw new Error('invalid_media_handoff')
  return value
}

function sameJsonValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function ensureDeliveryCredential(outbox, root) {
  const path = join(root, `media-handoff-${outbox.nonce}.json`)
  const expected = handoffPayload(outbox)
  const existing = await readPrivateFile(path, parseHandoff, { optional: true })
  if (existing) {
    if (!sameJsonValue(existing, expected)) throw new Error('media_handoff_credential_conflict')
    return path
  }
  await writeDurablePrivateText(path, `${JSON.stringify(expected)}\n`)
  const persisted = await readPrivateFile(path, parseHandoff)
  if (!sameJsonValue(persisted, expected)) throw new Error('media_handoff_credential_conflict')
  return path
}

async function advanceOutboxSourceIdentity(previous, currentIdentity, outboxPath, root) {
  const next = { ...previous, sourceIdentity: currentIdentity }
  const handoffPath = join(root, `media-handoff-${previous.nonce}.json`)
  const existingHandoff = await readPrivateFile(handoffPath, parseHandoff, { optional: true })
  const previousPayload = handoffPayload(previous)
  const nextPayload = handoffPayload(next)
  if (existingHandoff && !sameJsonValue(existingHandoff, previousPayload)
    && !sameJsonValue(existingHandoff, nextPayload)) {
    throw new Error('media_handoff_credential_conflict')
  }
  // Advance the transport credential before the outbox. If the process dies
  // between these writes, the next retry can recognize either exact payload
  // and finish the same task/nonce transition without widening identity checks.
  if (!sameJsonValue(existingHandoff, nextPayload)) {
    await writeDurablePrivateText(handoffPath, `${JSON.stringify(nextPayload)}\n`)
    const persistedHandoff = await readPrivateFile(handoffPath, parseHandoff)
    if (!sameJsonValue(persistedHandoff, nextPayload)) {
      throw new Error('media_handoff_credential_conflict')
    }
  }
  await writeDurablePrivateText(outboxPath, `${JSON.stringify(next)}\n`)
  const persistedOutbox = await readPrivateFile(outboxPath, parseOutbox)
  if (!sameJsonValue(persistedOutbox, next)) throw new Error('media_handoff_outbox_conflict')
  return next
}

async function acquireOutboxLock(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const token = randomUUID()
    let handle
    try {
      handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      )
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`, { encoding: 'utf8' })
      await handle.sync()
      return {
        async release() {
          await handle.close().catch(() => undefined)
          const current = await readFile(path, 'utf8').catch(() => '')
          let currentToken = null
          try { currentToken = JSON.parse(current).token } catch { currentToken = null }
          if (currentToken === token) {
            await rm(path, { force: true })
            await syncDirectory(dirname(path))
          }
        },
      }
    } catch (error) {
      await handle?.close().catch(() => undefined)
      if (handle) await rm(path, { force: true }).catch(() => undefined)
      if (error?.code !== 'EEXIST') throw error
      const details = await lstat(path)
      if (
        !details.isFile()
        || details.isSymbolicLink()
        || details.nlink !== 1
        || (details.mode & 0o777) !== 0o600
        || (typeof process.getuid === 'function' && details.uid !== process.getuid())
      ) throw new Error('unsafe_media_handoff_outbox_lock')
      let pid = null
      try { pid = JSON.parse(await readFile(path, 'utf8')).pid } catch { pid = null }
      let alive = false
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0)
          alive = true
        } catch { alive = false }
      }
      const validOwnerPid = Number.isInteger(pid) && pid > 0
      if ((!alive && validOwnerPid) || (!validOwnerPid && Date.now() - details.mtimeMs >= 30_000)) {
        await rm(path)
        continue
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
    }
  }
  throw new Error('media_handoff_outbox_busy')
}

export async function createMediaHandoff({
  taskId,
  videoPath,
  materialId,
  root = defaultMediaHandoffRoot(),
  batchRoot = defaultVideoBatchRoot(),
}) {
  if (!isSchedulerTaskId(taskId)) throw new Error('invalid_task_id')
  const normalizedMaterialId = normalizeTrustedExistingMaterialId(materialId)
  if (normalizedMaterialId === undefined) throw new Error('invalid_material_id')
  const requestedRoot = resolve(root)
  await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
  await assertPrivateHandoffRoot(requestedRoot)
  const physicalRoot = await realpath(requestedRoot)
  await assertPrivateHandoffRoot(physicalRoot)
  const canonicalVideoPath = await realpath(resolve(videoPath))
  let videoStat = await stat(canonicalVideoPath)
  if (!videoStat.isFile() || videoStat.size <= 0) throw new Error('invalid_media_handoff_source')
  let sourceIdentity = {
    dev: videoStat.dev,
    ino: videoStat.ino,
    size: videoStat.size,
    mtimeMs: videoStat.mtimeMs,
    ctimeMs: videoStat.ctimeMs,
  }
  const outboxPath = outboxPathForTask(taskId, physicalRoot)
  const lock = await acquireOutboxLock(`${outboxPath}.lock`)
  let outbox
  let handoffPath
  try {
    outbox = await readPrivateFile(outboxPath, parseOutbox, { optional: true })
    if (outbox) {
      if (
        outbox.taskId !== taskId
        || outbox.videoPath !== canonicalVideoPath
        || outbox.materialId !== normalizedMaterialId
      ) throw new Error('media_handoff_outbox_conflict')
      if (!sourceIdentityMatches(outbox.sourceIdentity, videoStat)) {
        let verified = false
        for (let attempt = 0; attempt < 2 && !verified; attempt += 1) {
          if (!await verifiedWorkerCtimeDrift(outbox, videoStat, { batchRoot })) break
          const afterProof = await stat(canonicalVideoPath)
          if (sourceIdentityMatches(sourceIdentity, afterProof)) {
            verified = true
            break
          }
          videoStat = afterProof
          sourceIdentity = {
            dev: videoStat.dev,
            ino: videoStat.ino,
            size: videoStat.size,
            mtimeMs: videoStat.mtimeMs,
            ctimeMs: videoStat.ctimeMs,
          }
        }
        if (!verified) throw new Error('media_handoff_outbox_conflict')
        outbox = await advanceOutboxSourceIdentity(outbox, sourceIdentity, outboxPath, physicalRoot)
      }
    } else {
      outbox = {
        schemaVersion: MEDIA_HANDOFF_OUTBOX_SCHEMA_VERSION,
        taskId,
        videoPath: canonicalVideoPath,
        sourceIdentity,
        materialId: normalizedMaterialId,
        nonce: randomUUID(),
        createdAt: new Date().toISOString(),
      }
      await writeDurablePrivateText(outboxPath, `${JSON.stringify(outbox)}\n`)
      const persisted = await readPrivateFile(outboxPath, parseOutbox)
      if (!sameJsonValue(persisted, outbox)) throw new Error('media_handoff_outbox_conflict')
    }
    handoffPath = await ensureDeliveryCredential(outbox, physicalRoot)
  } finally {
    await lock.release()
  }
  return {
    path: handoffPath,
    videoPath: canonicalVideoPath,
    nonce: outbox.nonce,
    async cleanup({ disposition } = {}) {
      if (!['not_started', 'consumption_unknown', 'persisted_ack'].includes(disposition)) {
        throw new Error('invalid_media_handoff_cleanup_disposition')
      }
      if (disposition !== 'persisted_ack') return { retained: true, disposition }
      const cleanupLock = await acquireOutboxLock(`${outboxPath}.lock`)
      try {
        const currentOutbox = await readPrivateFile(outboxPath, parseOutbox, { optional: true })
        if (!currentOutbox) return { retained: false, disposition }
        if (!sameJsonValue(currentOutbox, outbox)) throw new Error('media_handoff_outbox_conflict')
        const currentHandoff = await readPrivateFile(handoffPath, parseHandoff, { optional: true })
        if (currentHandoff && !sameJsonValue(currentHandoff, handoffPayload(outbox))) {
          throw new Error('media_handoff_credential_conflict')
        }
        if (currentHandoff) await rm(handoffPath)
        await rm(outboxPath)
        await syncDirectory(physicalRoot)
        return { retained: false, disposition }
      } finally {
        await cleanupLock.release()
      }
    },
  }
}

function normalizeSearchQuery(value) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || !value
    || value.length > MAX_SEARCH_QUERY_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error('invalid_search_query')
  return value
}

function normalizeResultOffset(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RESULT_OFFSET) {
    throw new Error('invalid_result_offset')
  }
  return value
}

function normalizeDispatchResult(value, expectedId, kind) {
  const idKey = kind === 'batch' ? 'batchId' : 'taskId'
  if (value?.confirmationRequired === true) {
    if (
      value[idKey] !== expectedId
      || value.status !== 'confirmation_required'
      || value.duplicate !== false
      || !Number.isInteger(value.duplicateCount)
      || value.duplicateCount < 1
      || !Array.isArray(value.duplicateNames)
      || value.duplicateNames.length < 1
      || value.duplicateNames.length > 10
      || typeof value.truncated !== 'boolean'
    ) throw new Error('invalid_dispatch_confirmation')
    return {
      kind,
      id: expectedId,
      status: value.status,
      duplicate: false,
      confirmationRequired: true,
      duplicateCount: value.duplicateCount,
      duplicateNames: value.duplicateNames.map(normalizeSearchName),
      truncated: value.truncated,
    }
  }
  if (
    !value
    || value[idKey] !== expectedId
    || !DISPATCH_STATUSES.has(value.status)
    || typeof value.duplicate !== 'boolean'
  ) {
    throw new Error('invalid_dispatch_result')
  }
  if (!value.duplicate && value.status !== 'queued') {
    throw new Error('invalid_fresh_dispatch_status')
  }
  return {
    kind,
    id: expectedId,
    status: value.status,
    duplicate: value.duplicate,
  }
}

function safeSummary(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null
  if (typeof output.summary !== 'string') return null
  const text = output.summary
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!text) return null
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

function normalizeTaskStatus(value, expectedTaskId) {
  if (
    !value
    || value.taskId !== expectedTaskId
    || !TASK_STATUSES.has(value.status)
  ) {
    throw new Error('invalid_task_status_result')
  }
  return {
    kind: 'task',
    id: expectedTaskId,
    status: value.status,
    summary: value.status === 'succeeded' ? safeSummary(value.output) : null,
  }
}

function normalizeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

function normalizeBatchItem(value, total) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !Number.isInteger(value.index)
    || value.index < 1
    || value.index > total
    || !SEARCH_ITEM_STATUSES.has(value.status)
  ) throw new Error('invalid_batch_status_result')
  return {
    index: value.index,
    name: normalizeSearchName(value.name),
    status: value.status,
  }
}

function normalizeBatchStatus(value, expectedBatchId) {
  if (
    !value
    || value.batchId !== expectedBatchId
    || !BATCH_STATUSES.has(value.status)
    || normalizeCount(value.total) === undefined
  ) {
    throw new Error('invalid_batch_status_result')
  }
  if (value.status === 'not_registered' || value.status === 'unavailable') {
    const emptyCounts = value.counts
      && typeof value.counts === 'object'
      && !Array.isArray(value.counts)
      && Object.keys(value.counts).length === 0
    if (
      value.stateAvailable !== false
      || value.total !== 0
      || !emptyCounts
      || !Array.isArray(value.items)
      || value.items.length > 0
    ) throw new Error('invalid_batch_status_result')
    return {
      kind: 'batch',
      id: expectedBatchId,
      status: value.status,
      total: 0,
      counts: {},
      items: [],
      stateAvailable: false,
    }
  }
  const counts = value.counts && typeof value.counts === 'object' && !Array.isArray(value.counts)
    ? Object.fromEntries(Object.entries(value.counts)
      .filter(([, count]) => normalizeCount(count) !== undefined))
    : {}
  const items = Array.isArray(value.items)
    ? value.items.map(item => normalizeBatchItem(item, value.total))
    : []
  if (items.length && items.length !== value.total) throw new Error('invalid_batch_status_result')
  if (new Set(items.map(item => item.index)).size !== items.length) {
    throw new Error('invalid_batch_status_result')
  }
  return {
    kind: 'batch',
    id: expectedBatchId,
    status: value.status,
    total: value.total,
    counts,
    items,
  }
}

function normalizeSearchName(value) {
  if (typeof value !== 'string') throw new Error('invalid_search_result')
  const name = value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!name || name.length > 180) throw new Error('invalid_search_result')
  return name
}

function normalizeSearchMatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_search_result')
  if (value.kind === 'task') {
    if (
      !isSchedulerTaskId(value.taskId)
      || !SEARCH_ITEM_STATUSES.has(value.status)
      || !SEARCH_BATCH_STATUSES.has(value.batchStatus)
    ) throw new Error('invalid_search_result')
    return {
      kind: 'task',
      taskId: value.taskId,
      name: normalizeSearchName(value.name),
      status: value.status,
    }
  }
  if (value.kind === 'batch') {
    if (
      !isSchedulerBatchId(value.batchId)
      || !Number.isInteger(value.index)
      || value.index < 1
      || value.index > 100
      || !SEARCH_ITEM_STATUSES.has(value.status)
      || !SEARCH_BATCH_STATUSES.has(value.batchStatus)
    ) throw new Error('invalid_search_result')
    return {
      kind: 'batch',
      batchId: value.batchId,
      index: value.index,
      name: normalizeSearchName(value.name),
      status: value.status,
    }
  }
  throw new Error('invalid_search_result')
}

function normalizeSearchResult(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !Array.isArray(value.matches)
    || value.matches.length > MAX_SEARCH_MATCHES
    || !Number.isInteger(value.total)
    || value.total < value.matches.length
    || typeof value.truncated !== 'boolean'
    || (value.truncated !== (value.total > value.matches.length))
  ) throw new Error('invalid_search_result')
  const matches = value.matches.map(normalizeSearchMatch)
  const seen = new Set()
  for (const match of matches) {
    const key = match.kind === 'task'
      ? `${match.kind}:${match.taskId}`
      : `${match.kind}:${match.batchId}:${match.index}`
    if (seen.has(key)) throw new Error('invalid_search_result')
    seen.add(key)
  }
  return { matches, total: value.total, truncated: value.truncated }
}

function isResultTaskId(value) {
  return isSchedulerTaskId(value) || (typeof value === 'string' && BATCH_ITEM_TASK_ID_PATTERN.test(value))
}

function normalizeResultName(value) {
  if (value === null) return null
  return normalizeSearchName(value)
}

function normalizeResultTimestamp(value) {
  if (value === null) return null
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || !value
    || value.length > 64
    || !Number.isFinite(Date.parse(value))
  ) throw new Error('invalid_task_result')
  return value
}

function normalizeResultMatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_task_result')
  }
  const base = {
    name: normalizeSearchName(value.name),
    status: SEARCH_ITEM_STATUSES.has(value.status) ? value.status : null,
    completedAt: normalizeResultTimestamp(value.completedAt),
    updatedAt: normalizeResultTimestamp(value.updatedAt),
  }
  if (!base.status) throw new Error('invalid_task_result')
  if (value.kind === 'task') {
    if (!isSchedulerTaskId(value.taskId) || value.batchId !== null || value.index !== null) {
      throw new Error('invalid_task_result')
    }
    return { kind: 'task', taskId: value.taskId, batchId: null, index: null, ...base }
  }
  if (value.kind === 'batch') {
    if (
      typeof value.taskId !== 'string'
      || !BATCH_ITEM_TASK_ID_PATTERN.test(value.taskId)
      || !isSchedulerBatchId(value.batchId)
      || !Number.isInteger(value.index)
      || value.index < 1
      || value.index > 100
    ) throw new Error('invalid_task_result')
    return {
      kind: 'batch',
      taskId: value.taskId,
      batchId: value.batchId,
      index: value.index,
      ...base,
    }
  }
  throw new Error('invalid_task_result')
}

function normalizeResultReport(value) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_result_report')
  if (!['summary', 'combinedText'].includes(value.source) || typeof value.text !== 'string') {
    throw new Error('invalid_result_report')
  }
  if (Buffer.byteLength(value.text, 'utf8') > MAX_RESULT_PAGE_BYTES) {
    throw new Error('invalid_result_report')
  }
  if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > MAX_RESULT_OFFSET) {
    throw new Error('invalid_result_report')
  }
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes < Buffer.byteLength(value.text, 'utf8')) {
    throw new Error('invalid_result_report')
  }
  if (value.nextOffset !== null
    && (!Number.isSafeInteger(value.nextOffset)
      || value.nextOffset <= value.offset
      || value.nextOffset > value.totalBytes)) {
    throw new Error('invalid_result_report')
  }
  return {
    source: value.source,
    text: value.text,
    offset: value.offset,
    nextOffset: value.nextOffset,
    totalBytes: value.totalBytes,
  }
}

function normalizeTaskResult(value, expectedOffset) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_task_result')
  if (value.kind === 'matches') {
    if (
      !Array.isArray(value.matches)
      || value.matches.length > MAX_SEARCH_MATCHES
      || !Number.isInteger(value.total)
      || value.total < value.matches.length
      || typeof value.truncated !== 'boolean'
      || value.truncated !== (value.total > value.matches.length)
    ) throw new Error('invalid_task_result')
    return {
      kind: 'matches',
      matches: value.matches.map(normalizeResultMatch),
      total: value.total,
      truncated: value.truncated,
    }
  }
  if (
    value.kind !== 'report'
    || !isResultTaskId(value.taskId)
    || !SEARCH_ITEM_STATUSES.has(value.status)
  ) throw new Error('invalid_task_result')
  const report = normalizeResultReport(value.report)
  if (report && report.offset !== expectedOffset) throw new Error('invalid_task_result')
  if (value.status !== 'succeeded' && report !== null) throw new Error('invalid_task_result')
  return {
    kind: 'report',
    taskId: value.taskId,
    name: normalizeResultName(value.name),
    status: value.status,
    report,
  }
}

export function createSchedulerRunner({
  execute = executeFile,
  scriptPath = INSTALLED_TASK_FLOW_SCRIPT,
  nodePath = process.execPath,
  createHandoff = createMediaHandoff,
} = {}) {
  if (!isAbsolute(scriptPath) || !isAbsolute(nodePath)) {
    throw new TypeError('runner paths must be absolute')
  }

  async function call(args, timeout) {
    const result = await execute(nodePath, [scriptPath, ...args], {
      timeout,
    })
    return parseSingleLineJson(result.stdout)
  }

  return {
    // trustedExistingMaterialId is an internal adapter-to-CLI channel. It must
    // never be populated from model-visible aiworker_analyze_video arguments.
    async dispatchVideo(options) {
      if (Object.hasOwn(options || {}, 'materialId')) throw new Error('untrusted_material_id_field')
      const {
        videoPath,
        taskId,
        trustedExistingMaterialId,
        confirmDuplicate = false,
      } = options || {}
      if (!isSchedulerTaskId(taskId)) throw new Error('invalid_task_id')
      if (typeof confirmDuplicate !== 'boolean') throw new Error('invalid_confirmation')
      const normalizedMaterialId = normalizeTrustedExistingMaterialId(trustedExistingMaterialId)
      const handoff = normalizedMaterialId === undefined
        ? null
        : await createHandoff({ taskId, videoPath, materialId: normalizedMaterialId })
      let cleanupDisposition = 'not_started'
      try {
        cleanupDisposition = 'consumption_unknown'
        let value
        try {
          value = await call([
            '--video-file', handoff?.videoPath || videoPath,
            '--task-id', taskId,
            '--idempotency-key', taskId,
            ...(handoff === null ? [] : ['--media-handoff', handoff.path]),
            '--delivery', 'none',
            '--wait-seconds', '0',
            '--no-trigger-recovery',
            ...(confirmDuplicate ? ['--confirm-duplicate'] : []),
          ], DISPATCH_TIMEOUT_MS)
        } catch (error) {
          if (error?.childStarted === false) cleanupDisposition = 'not_started'
          throw error
        }
        const normalized = normalizeDispatchResult(value, taskId, 'task')
        if (handoff) {
          if (normalized.confirmationRequired === true) return normalized
          if (value.materialHandoffPersisted !== true) {
            throw new Error('material_handoff_not_persisted')
          }
          cleanupDisposition = 'persisted_ack'
        }
        return normalized
      } finally {
        await handoff?.cleanup({ disposition: cleanupDisposition })
      }
    },

    async dispatchDirectory({ videoDirectory, batchId, confirmDuplicate = false }) {
      if (!isSchedulerBatchId(batchId)) throw new Error('invalid_batch_id')
      if (typeof confirmDuplicate !== 'boolean') throw new Error('invalid_confirmation')
      const value = await call([
        '--video-dir', videoDirectory,
        '--batch-id', batchId,
        '--delivery', 'none',
        ...(confirmDuplicate ? ['--confirm-duplicate'] : []),
      ], DISPATCH_TIMEOUT_MS)
      return normalizeDispatchResult(value, batchId, 'batch')
    },

    async taskStatus({ taskId }) {
      if (!isSchedulerTaskId(taskId)) throw new Error('invalid_task_id')
      return normalizeTaskStatus(
        await call(['--status-brief', taskId], STATUS_TIMEOUT_MS),
        taskId,
      )
    },

    async batchStatus({ batchId }) {
      if (!isSchedulerBatchId(batchId)) throw new Error('invalid_batch_id')
      return normalizeBatchStatus(
        await call(['--batch-status', batchId], STATUS_TIMEOUT_MS),
        batchId,
      )
    },

    async batchItemStatus({ batchId, index }) {
      if (!isSchedulerBatchId(batchId) || !Number.isInteger(index) || index < 1 || index > 100) {
        throw new Error('invalid_batch_item')
      }
      const batch = normalizeBatchStatus(
        await call(['--batch-status', batchId], STATUS_TIMEOUT_MS),
        batchId,
      )
      const item = batch.items.find(candidate => candidate.index === index)
      if (!item) throw new Error('batch_item_not_found')
      return {
        kind: 'batch_item',
        id: batchId,
        index,
        name: item.name,
        status: item.status,
        batchStatus: batch.status,
        total: batch.total,
        counts: batch.counts,
      }
    },

    async searchStatus({ query }) {
      const safeQuery = normalizeSearchQuery(query)
      return normalizeSearchResult(
        await call(['--search-status', safeQuery], STATUS_SEARCH_TIMEOUT_MS),
      )
    },

    async taskResult({ query, offset = 0 }) {
      const safeQuery = normalizeSearchQuery(query)
      const safeOffset = normalizeResultOffset(offset)
      return normalizeTaskResult(
        await call(['--result', safeQuery, '--result-offset', String(safeOffset)], STATUS_TIMEOUT_MS),
        safeOffset,
      )
    },
  }
}

export const schedulerRunner = createSchedulerRunner()
