import { discardStagedVideo, stageVideoFile } from './media-ingest.mjs'

export class VideoTriggerUnconfirmedError extends Error {
  constructor(cause) {
    super('video_trigger_unconfirmed', { cause })
    this.name = 'VideoTriggerUnconfirmedError'
  }
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
  displayName,
  batchId,
  batchIndex,
  visionRoute,
}) {
  const normalizedBatchId = String(batchId || '').trim().slice(0, 120)
  const normalizedBatchIndex = Number(batchIndex)
  return {
    bindingId,
    taskId,
    idempotencyKey,
    source: 'openclaw',
    input: {
      prompt: prompt.trim(),
      videoKey,
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

export async function submitVideoTask({
  client,
  bindingId,
  taskId,
  idempotencyKey,
  prompt,
  videoFile,
  displayName = null,
  batchId = null,
  batchIndex = null,
  visionRoute = null,
  inboxRoot,
  maxBytes,
  recoverAfterTriggerError = true,
}) {
  const staged = await stageVideoFile(videoFile, { inboxRoot, maxBytes })
  let ownershipTransferred = false
  try {
    let response
    try {
      response = await client.trigger(buildVideoTaskPayload({
        bindingId,
        taskId,
        idempotencyKey,
        prompt,
        videoKey: staged.videoKey,
        displayName: displayName || staged.sourcePath,
        batchId,
        batchIndex,
        visionRoute,
      }))
    } catch (error) {
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
      if (recovered && ['queued', 'accepted', 'running', 'succeeded'].includes(recovered.status)) {
        ownershipTransferred = !['succeeded'].includes(recovered.status)
        if (!ownershipTransferred) await discardStagedVideo(staged)
        return {
          taskId: recovered.taskId,
          status: recovered.status,
          duplicate: true,
          recoveredAfterTriggerError: true,
          output: recovered.output,
          error: recovered.error,
        }
      }
      throw error
    }
    if (response.duplicate) {
      await discardStagedVideo(staged)
    } else {
      ownershipTransferred = true
    }
    return response
  } catch (error) {
    if (!ownershipTransferred) await discardStagedVideo(staged)
    throw error
  }
}
