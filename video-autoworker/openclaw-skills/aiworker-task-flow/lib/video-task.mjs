import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  discardStagedVideo,
  normalizeMaterialId,
  sameSourceIdentity,
  sha256FileHandle,
  StagedMediaCleanupError,
  stageVideoFile,
} from './media-ingest.mjs'
import { isN8nIntakeDrainingError } from './platform-client.mjs'
import { assertOptionalDirectorWork } from './director-work-policy.mjs'

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const VIDEO_KEY_PATTERN = new RegExp(`^${UUID_PATTERN}\\.(?:mp4|mov|mkv|webm|m4v)$`, 'u')
const OWNERSHIP_TOKEN_PATTERN = new RegExp(`^${UUID_PATTERN}$`, 'u')

export class VideoTriggerUnconfirmedError extends Error {
  constructor(cause) {
    super('video_trigger_unconfirmed', { cause })
    this.name = 'VideoTriggerUnconfirmedError'
  }
}

function isDefinitiveTriggerRejection(error) {
  return Number.isInteger(error?.status)
    && error.status >= 400
    && error.status < 500
    && ![401, 403, 408, 425, 429].includes(error.status)
    && !isN8nIntakeDrainingError(error)
}

function runVideoKey(run) {
  return typeof run?.input?.videoKey === 'string' && run.input.videoKey
    ? run.input.videoKey
    : null
}

const RUN_STATUSES = new Set(['queued', 'accepted', 'running', 'succeeded', 'failed', 'cancelled'])
const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

function triggerResponseValid(response, taskId) {
  return Boolean(
    response
    && typeof response === 'object'
    && !Array.isArray(response)
    && response.taskId === taskId
    && RUN_STATUSES.has(response.status)
    && (response.duplicate === undefined || typeof response.duplicate === 'boolean')
  )
}

function authoritativeRunValid(run, taskId) {
  return Boolean(run && run.taskId === taskId && RUN_STATUSES.has(run.status))
}

async function resolvePlatformMediaOwnership(client, taskId, staged, candidate = null) {
  let authoritative = candidate
  if (!runVideoKey(authoritative)) authoritative = await client.getRun(taskId)
  const authoritativeVideoKey = runVideoKey(authoritative)
  if (authoritativeVideoKey === staged.videoKey) return { ownership: 'same', run: authoritative }
  if (authoritativeVideoKey !== null) return { ownership: 'different', run: authoritative }
  return { ownership: 'unknown', run: authoritative }
}

function safeDisplayName(value) {
  const compacted = String(value || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  const segments = compacted.split(/[\\/]/).filter(Boolean)
  return String(segments.at(-1) || '未命名视频').slice(0, 160)
}

export function buildVideoTaskPayload({
  bindingId,
  taskId,
  idempotencyKey,
  prompt,
  videoKey,
  materialId,
  displayName,
  batchId,
  batchIndex,
  visionRoute,
  directorWork,
}) {
  const normalizedBatchId = String(batchId || '').trim().slice(0, 120)
  const normalizedBatchIndex = Number(batchIndex)
  return {
    bindingId,
    taskId,
    idempotencyKey,
    source: 'openclaw',
    ...(directorWork === undefined || directorWork === null ? {} : { directorWork }),
    input: {
      prompt: prompt.trim(),
      videoKey,
      materialId: normalizeMaterialId(materialId),
      displayName: safeDisplayName(displayName),
      ...(normalizedBatchId ? { batchId: normalizedBatchId } : {}),
      ...(Number.isInteger(normalizedBatchIndex) && normalizedBatchIndex > 0
        ? { batchIndex: normalizedBatchIndex }
        : {}),
    },
    ...(visionRoute ? {
      routing: { nodes: { vision: { routeId: visionRoute, fallbackRouteIds: [] } } },
    } : {}),
    delivery: { mode: 'none' },
  }
}

function validateVideoTaskRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('video_task_request_invalid')
  }
  if (Object.hasOwn(request, 'materialId')) throw new Error('untrusted_material_id_field')
  assertOptionalDirectorWork(request.directorWork)
  for (const [name, value] of [
    ['onStagingPrepared', request.onStagingPrepared],
    ['onSourceAnchorCreated', request.onSourceAnchorCreated],
    ['onSourceStaged', request.onSourceStaged],
    ['onStagingCompleted', request.onStagingCompleted],
    ['onTriggerStarted', request.onTriggerStarted],
    ['onLocalCleanupStarted', request.onLocalCleanupStarted],
    ['onMediaSettled', request.onMediaSettled],
  ]) {
    if (value !== null && value !== undefined && typeof value !== 'function') {
      throw new TypeError(`${name}_callback_invalid`)
    }
  }
}

async function triggerStagedVideoTask(request, staged) {
  const {
    client,
    bindingId,
    taskId,
    idempotencyKey,
    prompt,
    displayName = null,
    batchId = null,
    batchIndex = null,
    visionRoute = null,
    onTriggerStarted = null,
    onLocalCleanupStarted = null,
    onMediaSettled = null,
    recoverAfterTriggerError = true,
    directorWork = null,
  } = request
  let ownershipTransferred = false
  let localReleased = false
  try {
    let response
    try {
      await onTriggerStarted?.(staged)
      response = await client.trigger(buildVideoTaskPayload({
        bindingId,
        taskId,
        idempotencyKey,
        prompt,
        videoKey: staged.videoKey,
        materialId: staged.materialId,
        displayName: displayName || staged.sourcePath,
        batchId,
        batchIndex,
        visionRoute,
        directorWork,
      }))
    } catch (error) {
      if (isN8nIntakeDrainingError(error)) {
        // The platform rejected this top-level dispatch before creating a run.
        // Preserve the exact staged artifact and stable identity so the
        // persistent worker can resume it after intake reopens.
        ownershipTransferred = true
        throw error
      }
      if (!recoverAfterTriggerError) {
        // The trigger may have accepted the task before the connection failed.
        // Preserve its staged media, return control to the caller, and let a
        // later user-authorized status turn resolve the stable task ID.
        ownershipTransferred = true
        throw new VideoTriggerUnconfirmedError(error)
      }
      // A timeout may happen after the platform durably accepted the run. Query
      // the exact task before deciding whether the managed clone is still ours.
      let recovered
      try {
        recovered = await client.getRun(taskId)
      } catch {
        // The acceptance state is ambiguous while the loopback service is
        // unavailable. Keep the APFS clone for the platform or its bounded
        // stale-media cleanup, then pause and query the same task on resume.
        ownershipTransferred = true
        throw error
      }
      if (recovered && ['queued', 'accepted', 'running', 'succeeded', 'failed', 'cancelled'].includes(recovered.status)) {
        const resolved = await resolvePlatformMediaOwnership(client, taskId, staged, recovered)
        if (resolved.ownership === 'same') {
          ownershipTransferred = true
          if (TERMINAL_RUN_STATUSES.has(recovered.status)) {
            await onLocalCleanupStarted?.(staged)
            await discardStagedVideo(staged, error)
            localReleased = true
          }
        } else if (resolved.ownership === 'different') {
          await onLocalCleanupStarted?.(staged)
          await discardStagedVideo(staged, error)
          localReleased = true
        } else {
          ownershipTransferred = true
          throw error
        }
        if (localReleased) await onMediaSettled?.(staged)
        return {
          taskId: recovered.taskId,
          status: recovered.status,
          duplicate: true,
          recoveredAfterTriggerError: true,
          output: recovered.output,
          error: recovered.error,
        }
      }
      if (!isDefinitiveTriggerRejection(error)) {
        // A timeout, transport failure, retryable response, or read-side miss
        // is not proof that the idempotent trigger was rejected. Keep the same
        // task/video handoff for a later authoritative query or retry.
        ownershipTransferred = true
      }
      throw error
    }
    if (!triggerResponseValid(response, taskId)) {
      let resolved
      try {
        resolved = await resolvePlatformMediaOwnership(client, taskId, staged)
      } catch (error) {
        ownershipTransferred = true
        throw new VideoTriggerUnconfirmedError(error)
      }
      if (!authoritativeRunValid(resolved.run, taskId) || resolved.ownership === 'unknown') {
        ownershipTransferred = true
        throw new VideoTriggerUnconfirmedError(new Error('trigger_response_unconfirmed'))
      }
      if (resolved.ownership === 'same') {
        ownershipTransferred = true
        if (TERMINAL_RUN_STATUSES.has(resolved.run.status)) {
          await onLocalCleanupStarted?.(staged)
          await discardStagedVideo(staged)
          localReleased = true
        }
      } else {
        await onLocalCleanupStarted?.(staged)
        await discardStagedVideo(staged)
        localReleased = true
      }
      if (localReleased) await onMediaSettled?.(staged)
      return {
        ...resolved.run,
        duplicate: true,
        recoveredAfterMalformedResponse: true,
      }
    }
    if (response.duplicate === true) {
      let resolved
      try {
        resolved = await resolvePlatformMediaOwnership(client, taskId, staged, response)
      } catch (error) {
        ownershipTransferred = true
        throw error
      }
      if (resolved.ownership === 'same') {
        ownershipTransferred = true
        if (TERMINAL_RUN_STATUSES.has(resolved.run.status)) {
          await onLocalCleanupStarted?.(staged)
          await discardStagedVideo(staged)
          localReleased = true
        }
      } else if (resolved.ownership === 'different') {
        await onLocalCleanupStarted?.(staged)
        await discardStagedVideo(staged)
        localReleased = true
      } else {
        ownershipTransferred = true
        throw new VideoTriggerUnconfirmedError(new Error('duplicate_video_ownership_unconfirmed'))
      }
    } else {
      ownershipTransferred = true
      if (TERMINAL_RUN_STATUSES.has(response.status)) {
        await onLocalCleanupStarted?.(staged)
        await discardStagedVideo(staged)
        localReleased = true
      }
    }
    if (localReleased) await onMediaSettled?.(staged)
    return response
  } catch (error) {
    if (!ownershipTransferred && !localReleased && !(error instanceof StagedMediaCleanupError)) {
      await onLocalCleanupStarted?.(staged)
      await discardStagedVideo(staged, error)
      localReleased = true
      await onMediaSettled?.(staged)
    }
    throw error
  }
}

export async function submitStagedVideoTask(request, staged) {
  validateVideoTaskRequest(request)
  if (!staged || typeof staged !== 'object' || !staged.videoKey || !staged.stagedPath) {
    throw new TypeError('staged_video_task_invalid')
  }
  const expectedBinding = {
    taskId: String(request.taskId || ''),
    idempotencyKey: String(request.idempotencyKey || ''),
    batchId: String(request.batchId || ''),
  }
  const stagedIdentityValid = staged.stagedIdentity
    && typeof staged.stagedIdentity === 'object'
    && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs']
      .every(key => Number.isFinite(staged.stagedIdentity[key]))
  const inbox = resolve(staged.inbox || '')
  const expectedPath = join(inbox, staged.videoKey)
  if (
    !VIDEO_KEY_PATTERN.test(staged.videoKey)
    || staged.taskId !== expectedBinding.taskId
    || staged.idempotencyKey !== expectedBinding.idempotencyKey
    || staged.batchId !== expectedBinding.batchId
    || !OWNERSHIP_TOKEN_PATTERN.test(staged.ownershipToken)
    || !/^[a-f0-9]{64}$/u.test(staged.contentSha256)
    || !stagedIdentityValid
    || typeof staged.inbox !== 'string'
    || !staged.inbox
    || resolve(staged.inbox) !== staged.inbox
    || !Number.isSafeInteger(staged.sourceBytes)
    || staged.sourceBytes <= 0
    || staged.stagedIdentity.size !== staged.sourceBytes
    || resolve(staged.stagedPath) !== expectedPath
    || await realpath(dirname(staged.stagedPath)) !== await realpath(inbox)
  ) throw new Error('staged_video_task_binding_invalid')
  const details = await lstat(staged.stagedPath)
  let handle
  try {
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error('staged_video_task_identity_invalid')
    }
    handle = await open(staged.stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const handleStat = await handle.stat()
    if (
      handleStat.dev !== details.dev
      || handleStat.ino !== details.ino
      || !sameSourceIdentity(staged.stagedIdentity, handleStat)
    ) throw new Error('staged_video_task_identity_invalid')
    if (await sha256FileHandle(handle) !== staged.contentSha256) {
      throw new Error('staged_video_task_content_invalid')
    }
    if (!sameSourceIdentity(staged.stagedIdentity, await handle.stat())) {
      throw new Error('staged_video_task_identity_invalid')
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
  return triggerStagedVideoTask(request, staged)
}

export async function submitVideoTask(request) {
  validateVideoTaskRequest(request)
  const {
    videoFile,
    inboxRoot,
    maxBytes,
    expectedSourceIdentity = null,
    trustedExistingMaterialId = null,
    onHashProgress = null,
    onStagingPrepared = null,
    onSourceAnchorCreated = null,
    onSourceStaged = null,
    onStagingCompleted = null,
  } = request
  const staged = await stageVideoFile(videoFile, {
    inboxRoot,
    maxBytes,
    onHashProgress,
    ...(onStagingPrepared === null ? {} : { onStagingPrepared }),
    ...(onSourceAnchorCreated === null ? {} : { onSourceAnchorCreated }),
    ...(onStagingPrepared === null ? {} : {
      stagingBinding: {
        taskId: String(request.taskId || ''),
        idempotencyKey: String(request.idempotencyKey || ''),
        batchId: String(request.batchId || ''),
      },
    }),
    ...(onStagingCompleted === null ? {} : { onStagingCompleted }),
    ...(request.onLocalCleanupStarted === null || request.onLocalCleanupStarted === undefined
      ? {}
      : { onStagingCleanupStarted: request.onLocalCleanupStarted }),
    ...(request.onMediaSettled === null || request.onMediaSettled === undefined
      ? {}
      : { onStagingSettled: request.onMediaSettled }),
    ...(expectedSourceIdentity === null || expectedSourceIdentity === undefined
      ? {}
      : { expectedSourceIdentity }),
    ...(onSourceStaged === null ? {} : { onSourceIdentityFinalized: onSourceStaged }),
    ...(trustedExistingMaterialId === null || trustedExistingMaterialId === undefined
      ? {}
      : { trustedExistingMaterialId }),
  })
  return triggerStagedVideoTask(request, staged)
}
