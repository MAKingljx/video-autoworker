import { isVideoTaskId } from './video-task-id.js'

const ALLOWED_STATUSES = new Set([
  'queued',
  'accepted',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])
const MAX_SUMMARY_CHARS = 120

function optionalNonNegativeInteger(value) {
  return value === undefined || (Number.isInteger(value) && value >= 0)
}

function optionalUpdatedAt(value) {
  return value === undefined
    || (typeof value === 'string' && value.trim().length > 0)
    || (Number.isFinite(value) && value >= 0)
}

function safeSummary(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null
  if (typeof output.summary !== 'string') return null
  const normalized = output.summary
    .replace(/^\s*#{1,6}\s*/gmu, '')
    .replace(/\*\*|__|`/gu, '')
    .replace(/\[([^\]]+)\]\([^\s)]+\)/gu, '$1')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!normalized) return null
  return normalized.length > MAX_SUMMARY_CHARS
    ? `${normalized.slice(0, MAX_SUMMARY_CHARS)}…`
    : normalized
}

export function normalizeVideoStatusResult(value, expectedTaskId) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !isVideoTaskId(expectedTaskId)
    || value.taskId !== expectedTaskId
    || !ALLOWED_STATUSES.has(value.status)
    || !optionalNonNegativeInteger(value.attemptCount)
    || !optionalNonNegativeInteger(value.maxAttempts)
    || !optionalUpdatedAt(value.updatedAt)
    || (value.error !== undefined && value.error !== null && typeof value.error !== 'string')
  ) {
    throw new Error('invalid_video_status_result')
  }
  return {
    taskId: expectedTaskId,
    status: value.status,
    summary: value.status === 'succeeded' ? safeSummary(value.output) : null,
  }
}

export function formatVideoStatusReply(result, expectedTaskId) {
  const keys = result && typeof result === 'object' && !Array.isArray(result)
    ? Object.keys(result)
    : []
  const suppliedSummary = result?.summary ?? null
  if (
    !result
    || typeof result !== 'object'
    || Array.isArray(result)
    || keys.some(key => !['taskId', 'status', 'summary'].includes(key))
    || result.taskId !== expectedTaskId
    || !isVideoTaskId(expectedTaskId)
    || !ALLOWED_STATUSES.has(result.status)
    || (suppliedSummary !== null && typeof suppliedSummary !== 'string')
    || (suppliedSummary !== null && safeSummary({ summary: suppliedSummary }) !== suppliedSummary)
    || (result.status !== 'succeeded' && suppliedSummary !== null)
  ) {
    throw new Error('invalid_normalized_video_status_result')
  }
  const normalized = {
    taskId: expectedTaskId,
    status: result.status,
    summary: suppliedSummary,
  }
  if (normalized.status === 'queued' || normalized.status === 'accepted') {
    return '任务已受理，正在等待处理。'
  }
  if (normalized.status === 'running') return '任务正在处理中。'
  if (normalized.status === 'failed' || normalized.status === 'cancelled') {
    return '任务处理失败。'
  }
  return normalized.summary
    ? `任务已完成。摘要：${normalized.summary}`
    : '任务已完成。'
}
