import { IMAGE_PLUGIN_TOOL_NAMES } from './image-command-tool.js'

const TOOL_NAMES = new Set(IMAGE_PLUGIN_TOOL_NAMES)
const JOB_ID = /^[0-9a-f]{32}$/u
const STATE = new Set([
  'QUEUED',
  'RUNNING',
  'GENERATED_PENDING_REVIEW',
  'FAILED',
  'CANCELLED',
  'CANCEL_REQUESTED',
  'RECONCILE_REQUIRED',
])
const SAFE_CODE = /^[A-Z][A-Z0-9_:-]{1,127}$/u
const SAFE_SESSION_KEY = /^[^\u0000-\u001f\u007f]{1,4096}$/u
const SAFE_CALL_ID = /^[^\u0000-\u001f\u007f]{1,4096}$/u

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function toolName(event) {
  const name = event?.toolName || event?.message?.toolName
  return typeof name === 'string' && TOOL_NAMES.has(name) ? name : null
}

function receipt(details) {
  if (!plainObject(details)) return null
  const safe = {}
  if (typeof details.jobId === 'string' && JOB_ID.test(details.jobId)) safe.jobId = details.jobId
  if (typeof details.currentState === 'string' && STATE.has(details.currentState)) safe.currentState = details.currentState
  for (const key of ['errorCode', 'nextAction']) {
    if (typeof details[key] === 'string' && SAFE_CODE.test(details[key])) safe[key] = details[key]
  }
  return Object.keys(safe).length > 0 ? safe : null
}

function key(sessionKey, toolCallId) {
  return `${sessionKey}\0${toolCallId}`
}

function receiptText(value) {
  const fields = []
  if (value.jobId) fields.push(`jobId=${value.jobId}`)
  if (value.currentState) fields.push(`currentState=${value.currentState}`)
  if (value.errorCode) fields.push(`errorCode=${value.errorCode}`)
  if (value.nextAction) fields.push(`nextAction=${value.nextAction}`)
  return `图片工具回执：${fields.join('；')}。`
}

function videoCoverFailureReply(receipt) {
  if (receipt?.errorCode === 'VIDEO_COVER_WORKFLOW_REQUEST_INVALID') {
    return '这次封面提交信息不完整，未创建图片任务。请重新发起一次封面生成。'
  }
  return '这次封面未创建成功，因此没有可查询的图片任务。请重新发起一次封面生成。'
}

function isVideoCoverFailure(receipt) {
  return typeof receipt?.errorCode === 'string'
    && (receipt.errorCode.startsWith('VIDEO_COVER_') || receipt.nextAction === 'REPORT_WORKFLOW_FAILURE')
}

// The director-brain projector intentionally removes arbitrary tool details
// from long transcripts. Image commands need only four safe receipt fields to
// continue without repeating a submission, so keep an in-memory bridge for
// the current profile process. It never stores raw prompts, paths, media or
// arbitrary output, and its bounded map is not persisted.
export function createImageTranscriptReceiptBridge({ maxEntries = 512, isEligible = () => true } = {}) {
  const entries = new Map()
  const finalFailures = new Map()
  function prune() {
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
    while (finalFailures.size > maxEntries) finalFailures.delete(finalFailures.keys().next().value)
  }
  function capture(event, context) {
    const name = toolName(event)
    const message = event?.message
    const sessionKey = context?.sessionKey
    const toolCallId = message?.toolCallId
    const safe = receipt(message?.details)
    if (!isEligible(context) || !name || !safe || typeof sessionKey !== 'string' || !SAFE_SESSION_KEY.test(sessionKey)
      || typeof toolCallId !== 'string' || !SAFE_CALL_ID.test(toolCallId)) return undefined
    entries.set(key(sessionKey, toolCallId), {
      toolName: name,
      receipt: safe,
      isError: message.isError === true || Boolean(safe.errorCode),
    })
    if (isVideoCoverFailure(safe)) finalFailures.set(sessionKey, safe)
    prune()
    return undefined
  }
  function project(event, context) {
    const message = event?.message
    const sessionKey = context?.sessionKey
    const toolCallId = message?.toolCallId
    if (!isEligible(context) || message?.role !== 'toolResult' || typeof sessionKey !== 'string' || !SAFE_SESSION_KEY.test(sessionKey)
      || typeof toolCallId !== 'string' || !SAFE_CALL_ID.test(toolCallId)) return undefined
    const stored = entries.get(key(sessionKey, toolCallId))
    if (!stored) return undefined
    return {
      message: {
        role: 'toolResult',
        toolCallId,
        toolName: stored.toolName,
        content: [{ type: 'text', text: receiptText(stored.receipt) }],
        isError: stored.isError,
      },
    }
  }
  function projectUserVisibleFailure(event, context) {
    const message = event?.message
    const sessionKey = context?.sessionKey
    if (!isEligible(context) || message?.role !== 'assistant'
      || typeof sessionKey !== 'string' || !SAFE_SESSION_KEY.test(sessionKey)) return undefined
    const failure = finalFailures.get(sessionKey)
    if (!failure) return undefined
    finalFailures.delete(sessionKey)
    return {
      message: {
        ...message,
        content: [{ type: 'text', text: videoCoverFailureReply(failure) }],
      },
    }
  }
  return Object.freeze({ capture, project, projectUserVisibleFailure })
}
