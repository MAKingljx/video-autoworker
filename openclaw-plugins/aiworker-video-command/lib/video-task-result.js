const DUPLICATE_STATUSES = new Set(['queued', 'accepted', 'running', 'succeeded'])

export function normalizeVideoTaskResult(value, expectedTaskId) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || value.taskId !== expectedTaskId
    || typeof value.status !== 'string'
    || typeof value.duplicate !== 'boolean'
  ) {
    throw new Error('invalid_video_task_result')
  }
  if (
    (!value.duplicate && value.status !== 'accepted')
    || (value.duplicate && !DUPLICATE_STATUSES.has(value.status))
  ) {
    throw new Error('invalid_video_task_status')
  }
  return {
    taskId: expectedTaskId,
    status: value.status,
    duplicate: value.duplicate,
  }
}
