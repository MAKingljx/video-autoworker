import { discardStagedVideo, stageVideoFile } from './media-ingest.mjs'

export function buildVideoTaskPayload({ bindingId, taskId, idempotencyKey, prompt, videoKey, visionRoute }) {
  return {
    bindingId,
    taskId,
    idempotencyKey,
    source: 'openclaw',
    input: { prompt: prompt.trim(), videoKey },
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
  visionRoute = null,
  inboxRoot,
  maxBytes,
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
        visionRoute,
      }))
    } catch (error) {
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
