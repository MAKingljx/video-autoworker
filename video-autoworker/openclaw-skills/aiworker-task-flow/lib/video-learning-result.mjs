export const VIDEO_LEARNING_RESULT_SCHEMA = 'aiworker-video-learning-result/v1'
const MAX_SEGMENTS = 100_000
const RESULT_KEYS = ['schema', 'status', 'totalSegments', 'completedSegments', 'failedSegments']
const FAILURE_KEYS = ['index', 'timeRange', 'stage', 'errorCode']
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, keys) => Object.keys(value).length === keys.length && keys.every(key => own(value, key))
const invalid = () => { throw new Error('video_learning_result_invalid') }

function failuresFor(totalSegments, failures) {
  if (!Number.isSafeInteger(totalSegments) || totalSegments < 1 || totalSegments > MAX_SEGMENTS
    || !Array.isArray(failures) || failures.length > totalSegments * 2) invalid()
  const seen = new Set()
  const rows = failures.map(value => {
    if (!record(value) || !exactKeys(value, FAILURE_KEYS)
      || !Number.isSafeInteger(value.index) || value.index < 1 || value.index > totalSegments
      || !['vision', 'summary'].includes(value.stage)
      || typeof value.timeRange !== 'string' || !value.timeRange.trim() || value.timeRange.length > 128
      || /[\u0000-\u001f\u007f]/u.test(value.timeRange)
      || typeof value.errorCode !== 'string' || !/^[A-Z][A-Z0-9_]{1,119}$/u.test(value.errorCode)) invalid()
    const key = `${value.index}:${value.stage}`
    if (seen.has(key)) invalid()
    seen.add(key)
    return { index: value.index, timeRange: value.timeRange, stage: value.stage, errorCode: value.errorCode }
  })
  return rows.sort((left, right) => left.index - right.index || left.stage.localeCompare(right.stage))
}

/** Processing may finish while a bounded set of original segment identities still needs repair. */
export function buildVideoLearningResult(totalSegments, failures) {
  const failedSegments = failuresFor(totalSegments, failures)
  return {
    schema: VIDEO_LEARNING_RESULT_SCHEMA,
    status: failedSegments.length ? 'partial' : 'complete',
    totalSegments,
    completedSegments: totalSegments - new Set(failedSegments.map(row => row.index)).size,
    failedSegments,
  }
}

/** Old outputs have no coverage contract. A present but malformed contract is never treated as complete. */
export function readVideoLearningResult(output) {
  if (!record(output) || !own(output, 'learningResult')) return null
  const value = output.learningResult
  if (!record(value) || !exactKeys(value, RESULT_KEYS) || value.schema !== VIDEO_LEARNING_RESULT_SCHEMA) invalid()
  const expected = buildVideoLearningResult(value.totalSegments, value.failedSegments)
  if (value.status !== expected.status || value.completedSegments !== expected.completedSegments) invalid()
  return expected
}

/** Fail closed for cleanup, evidence publication and success presentation. */
export function hasPartialVideoLearning(output) {
  try { return readVideoLearningResult(output)?.status === 'partial' } catch { return true }
}

export function videoLearningDisplayState(status, output) {
  if (status !== 'succeeded') return status
  try { return readVideoLearningResult(output)?.status === 'partial' ? 'partial' : status }
  catch { return 'learning_invalid' }
}

export function videoLearningSummary(output) {
  const value = readVideoLearningResult(output)
  if (!value) return null
  if (value.status === 'complete') return `学习已完成 ${value.completedSegments} / ${value.totalSegments} 段。`
  const indexes = [...new Set(value.failedSegments.map(row => row.index))]
  return `部分完成 ${value.completedSegments} / ${value.totalSegments} 段。待修复片段：${indexes.slice(0, 20).join('、')}${indexes.length > 20 ? `等 ${indexes.length} 段` : ''}。`
}
