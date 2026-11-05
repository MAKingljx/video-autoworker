import { buildDirectorContextSummary } from './director-context-summary.js'
import {
  containsSensitiveNarrativeValue,
  redactSensitiveNarrativeValues,
} from './sensitive-narrative-text.js'

export const MAX_AIWORKER_TRANSCRIPT_PROJECTION_BYTES = 12 * 1024
export const MAX_AIWORKER_TRANSCRIPT_TOOL_CALL_BYTES = 64 * 1024

const BUSINESS_SUCCESS_STATUS = '完整结果保留在业务数据源中，需要时可由原工具重新读取。'
const BUSINESS_ERROR_STATUS = '本轮未得到完整结果；长期会话仅保留失败状态。'
const GENERIC_SUCCESS_STATUS = '工具执行已完成；长期会话仅保留本轮助手结论。'
const GENERIC_ERROR_STATUS = '工具执行未完成；长期会话仅保留失败状态。'
const EMPTY_ASSISTANT_STATUS = '本轮未生成可复用回复。'
const NARRATIVE_TOOLS = new Set(['aiworker_director_brain', 'aiworker_analyze_video'])
const IMAGE_SUBMIT_TOOLS = new Set([
  'aiworker_submit_creative_image',
  'aiworker_submit_designed_cover',
  'aiworker_submit_protected_cover',
])
const IMAGE_RECEIPT_TOOLS = new Set([...IMAGE_SUBMIT_TOOLS, 'aiworker_image_task'])
const IMAGE_STATES = new Set([
  'QUEUED', 'RUNNING', 'GENERATED_PENDING_REVIEW', 'FAILED', 'CANCELLED',
  'CANCEL_REQUESTED', 'RECONCILE_REQUIRED',
])
const IMAGE_JOB_ID = /^[0-9a-f]{32}$/u
const IMAGE_ERROR_CODE = /^[A-Z][A-Z0-9_]{2,127}$/u
const IMAGE_NEXT_ACTION = /^(?:[A-Z][A-Z0-9_]{2,127}|[a-z][a-z0-9_]{2,127})$/u
const MAX_ASSISTANT_TEXT_CHARS = 2_048
const REDACTED = '[已省略]'
const CREDENTIAL_QUOTE = String.raw`(?:\\?["']|&(?:quot|apos);|&#(?:34|39);|&#x(?:22|27);)`
const CREDENTIAL_VALUE = String.raw`(?:"[^"\r\n]{4,}"|'[^'\r\n]{4,}'|\\["'][^\\\r\n]{4,}?\\["']|(?:&quot;|&#34;|&#x22;)[^\r\n]{4,}?(?:&quot;|&#34;|&#x22;)|(?:&apos;|&#39;|&#x27;)[^\r\n]{4,}?(?:&apos;|&#39;|&#x27;)|[^\s,;，；。<>&]{4,})`
const CREDENTIAL_ASSIGNMENT = new RegExp(
  String.raw`${CREDENTIAL_QUOTE}?(?:app[_-]?secret|client[_-]?secret|secret|token|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)${CREDENTIAL_QUOTE}?\s*[:=]\s*${CREDENTIAL_VALUE}`,
  'giu',
)
const SENSITIVE_ASSISTANT_TEXT = Object.freeze([
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  /\bsk-[A-Za-z0-9_-]{12,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /-----BEGIN\s+(?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gu,
  /(?:postgres|postgresql|mysql|mongodb(?:\+srv)?|redis):\/\/\S+/giu,
  /https?:\/\/\S+/giu,
  /(?:^|\s)(?:~\/|\/(?:Users|private|tmp|var|opt|etc|home|Volumes)\/)\S*/gmu,
  /\b(?:task|run|record|table|work|source|candidate|checkpoint|session)[-_][A-Za-z0-9_-]{6,}\b/giu,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
  /\b[0-9a-f]{40,}\b/giu,
  /\bbascn[A-Za-z0-9_-]{12,}\b/giu,
  CREDENTIAL_ASSIGNMENT,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /(?<!\d)1[3-9]\d{9}(?!\d)/gu,
])

const SUMMARY_SECTION_BYTE_BUDGETS = Object.freeze({
  '## Decisions': 4_096,
  '## Open TODOs': 1_024,
  '## Constraints/Rules': 1_024,
  '## Pending user asks': 1_024,
  '## Exact identifiers': 64,
})

function compactSummaryBySection(summary) {
  const sections = new Map(Object.keys(SUMMARY_SECTION_BYTE_BUDGETS).map(heading => (
    [heading, []]
  )))
  let heading = null
  for (const line of summary.split(/\r?\n/u)) {
    if (sections.has(line)) {
      heading = line
      continue
    }
    if (!heading || !line.startsWith('- ')) continue
    const lines = sections.get(heading)
    const candidate = [...lines, line].join('\n')
    if (Buffer.byteLength(candidate, 'utf8') <= SUMMARY_SECTION_BYTE_BUDGETS[heading]) {
      lines.push(line)
    }
  }
  const empty = {
    '## Decisions': '暂无可安全复用的导演语义。',
    '## Open TODOs': '暂无已确认的未解决问题。',
    '## Constraints/Rules': '只保留可安全复用的导演语义。',
    '## Pending user asks': '暂无可安全保留的待处理请求。',
    '## Exact identifiers': 'None.',
  }
  return [...sections].map(([sectionHeading, lines]) => (
    `${sectionHeading}\n${lines.length > 0 ? lines.join('\n') : empty[sectionHeading]}`
  )).join('\n\n')
}

function buildProjectionNarrative(message) {
  try {
    const structured = buildDirectorContextSummary({ messages: [message] })
    const hasStructuredNarrative = /## Decisions\n- /u.test(structured)
    const containsStructuredPayload = Array.isArray(message?.content)
      && message.content.some(part => {
        if (typeof part?.text !== 'string') return false
        const text = part.text.trim()
        if (!text.startsWith('{') && !text.startsWith('[')) return false
        try {
          JSON.parse(text)
          return true
        } catch {
          return false
        }
      })
    const summary = hasStructuredNarrative || containsStructuredPayload
      ? structured
      : buildDirectorContextSummary({
          messages: [{ role: 'assistant', content: message.content }],
        })
    return compactSummaryBySection(summary)
  } catch {
    return buildDirectorContextSummary()
  }
}

function plainNarrative(summary) {
  const facts = summary.split(/\r?\n/u)
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2))
  return facts.join('\n')
}

function imageReceipt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const jobId = typeof value.jobId === 'string' && IMAGE_JOB_ID.test(value.jobId)
    ? value.jobId : undefined
  const currentState = typeof value.currentState === 'string' && IMAGE_STATES.has(value.currentState)
    ? value.currentState : undefined
  const errorCode = typeof value.errorCode === 'string' && IMAGE_ERROR_CODE.test(value.errorCode)
    ? value.errorCode : undefined
  const nextAction = typeof value.nextAction === 'string' && IMAGE_NEXT_ACTION.test(value.nextAction)
    ? value.nextAction : undefined
  if (!jobId && !currentState && !errorCode && !nextAction) return null
  return { ...(jobId ? { jobId } : {}), ...(currentState ? { currentState } : {}),
    ...(errorCode ? { errorCode } : {}), ...(nextAction ? { nextAction } : {}) }
}

function imageReceipts(details) {
  const direct = imageReceipt(details)
  if (direct) return [direct]
  if (!Array.isArray(details?.jobs) || details.jobs.length > 3) return []
  const receipts = details.jobs.map(imageReceipt)
  return receipts.every(Boolean) ? receipts : []
}

function imageReceiptText(receipt) {
  const fields = [
    receipt.jobId ? `jobId=${receipt.jobId}` : undefined,
    receipt.currentState ? `state=${receipt.currentState}` : undefined,
    receipt.errorCode ? `errorCode=${receipt.errorCode}` : undefined,
    receipt.nextAction ? `nextAction=${receipt.nextAction}` : undefined,
  ].filter(Boolean)
  return `图片工具回执：${fields.join('；')}。`
}

function projectImageToolResult(message, toolName) {
  const receipts = imageReceipts(message.details)
  if (receipts.length === 0) return null
  const failed = message.isError === true || receipts.some(receipt => receipt.errorCode)
  return {
    message: {
      role: 'toolResult',
      toolCallId: message.toolCallId,
      toolName,
      content: [{ type: 'text', text: receipts.map(imageReceiptText).join('\n') }],
      isError: failed,
    },
  }
}

export function projectAiworkerToolResultForTranscript(event = {}) {
  let fallbackToolCallId
  let fallbackToolName
  try {
    const message = event.message
    if (message?.role !== 'toolResult') return undefined
    fallbackToolCallId = typeof message.toolCallId === 'string' ? message.toolCallId : undefined
    const toolName = event.toolName || message.toolName
    fallbackToolName = typeof toolName === 'string' && toolName ? toolName : undefined

    // before_message_write does not carry a separate toolName. A malformed or
    // version-skewed tool result must still be reduced instead of leaking its
    // raw content into the transcript; keep the original pairing envelope
    // whenever OpenClaw supplied one and never invent an identifier.
    const isNarrativeTool = fallbackToolName
      ? NARRATIVE_TOOLS.has(fallbackToolName)
      : false
    const isImageTool = fallbackToolName
      ? IMAGE_RECEIPT_TOOLS.has(fallbackToolName)
      : false
    if (isImageTool) {
      const projected = projectImageToolResult(message, fallbackToolName)
      if (projected) return projected
    }
    const status = isNarrativeTool
      ? message.isError === true ? BUSINESS_ERROR_STATUS : BUSINESS_SUCCESS_STATUS
      : message.isError === true ? GENERIC_ERROR_STATUS : GENERIC_SUCCESS_STATUS
    const narrative = isNarrativeTool
      ? plainNarrative(buildProjectionNarrative(message))
      : ''
    let text = narrative ? `${narrative}\n${status}` : status
    if (Buffer.byteLength(text, 'utf8') > MAX_AIWORKER_TRANSCRIPT_PROJECTION_BYTES) text = status

    return {
      message: {
        role: 'toolResult',
        toolCallId: message.toolCallId,
        ...(fallbackToolName ? { toolName: fallbackToolName } : {}),
        content: [{ type: 'text', text }],
        isError: message.isError === true,
      },
    }
  } catch {
    return {
      message: {
        role: 'toolResult',
        ...(fallbackToolCallId ? { toolCallId: fallbackToolCallId } : {}),
        ...(fallbackToolName ? { toolName: fallbackToolName } : {}),
        content: [{ type: 'text', text: GENERIC_ERROR_STATUS }],
        isError: true,
      },
    }
  }
}

function truncateUnicodeSafe(value, maxChars) {
  if (value.length <= maxChars) return value
  let end = maxChars
  const last = value.charCodeAt(end - 1)
  if (last >= 0xD800 && last <= 0xDBFF) end -= 1
  return `${value.slice(0, end)}…`
}

function sanitizeAssistantText(value) {
  if (typeof value !== 'string') return ''
  let text = value.normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ' ')
  for (const pattern of SENSITIVE_ASSISTANT_TEXT) text = text.replace(pattern, REDACTED)
  text = redactSensitiveNarrativeValues(text, REDACTED)
  return truncateUnicodeSafe(text.replace(/[ \t]+/gu, ' ').trim(), MAX_ASSISTANT_TEXT_CHARS)
}

function redactAssistantTextPreservingSafeContent(value) {
  if (typeof value !== 'string') return ''
  let text = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ' ')
  for (const pattern of SENSITIVE_ASSISTANT_TEXT) text = text.replace(pattern, REDACTED)
  text = redactSensitiveNarrativeValues(text, REDACTED)
  return text
}

function assistantTextRequiresProjection(value) {
  if (typeof value !== 'string') return false
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)) return true
  if (containsSensitiveNarrativeValue(value)) return true
  return SENSITIVE_ASSISTANT_TEXT.some((pattern) => {
    pattern.lastIndex = 0
    const matched = pattern.test(value)
    pattern.lastIndex = 0
    return matched
  })
}

function safeAction(value) {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,40}$/u.test(value)
    ? value
    : undefined
}

function projectedToolCallPart(part) {
  const usesInput = Object.hasOwn(part, 'input') && !Object.hasOwn(part, 'arguments')
  const source = usesInput ? part.input : part.arguments
  const action = source && typeof source === 'object' ? safeAction(source.action) : undefined
  const jobId = source && typeof source === 'object' && typeof source.jobId === 'string'
    && IMAGE_JOB_ID.test(source.jobId) ? source.jobId : undefined
  const imageArguments = IMAGE_SUBMIT_TOOLS.has(part.name)
    ? {}
    : part.name === 'aiworker_image_task'
      ? { ...(action ? { action } : {}), ...(jobId ? { jobId } : {}) }
      : null
  return {
    type: 'toolCall',
    id: part.id,
    name: part.name,
    [usesInput ? 'input' : 'arguments']: imageArguments ?? (action ? { action } : {}),
  }
}

export function projectAiworkerToolCallForTranscript(event = {}) {
  const pairingFallback = []
  try {
    const message = event.message
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return undefined
    // Execution has already consumed the original message. Preserve visible
    // text order and every valid tool-call pairing envelope, but reconstruct
    // all parts so arguments, signatures, reasoning and auxiliary metadata can
    // never enter the persisted copy.
    const content = []
    let requiresStructuralProjection = false
    let containsSensitiveText = false
    for (const part of message.content) {
      try {
        if (part?.type === 'toolCall') {
          requiresStructuralProjection = true
          if (typeof part.id === 'string' && typeof part.name === 'string'
            && part.id && part.name) {
            const projectedCall = projectedToolCallPart(part)
            pairingFallback.push(projectedCall)
            content.push(projectedCall)
          }
        } else if (part?.type === 'thinking' || part?.type === 'reasoning') {
          requiresStructuralProjection = true
        } else if (part?.type === 'text') {
          if (assistantTextRequiresProjection(part.text)) containsSensitiveText = true
          const text = sanitizeAssistantText(part.text)
          if (text) content.push({ type: 'text', text })
        }
      } catch {
        requiresStructuralProjection = true
      }
    }
    if (!requiresStructuralProjection && !containsSensitiveText) return undefined
    if (!requiresStructuralProjection) {
      return {
        message: {
          role: 'assistant',
          content: message.content.flatMap((part) => {
            if (part?.type !== 'text') return []
            const text = redactAssistantTextPreservingSafeContent(part.text)
            return text ? [{ type: 'text', text }] : []
          }),
        },
      }
    }
    if (content.length === 0) content.push({ type: 'text', text: EMPTY_ASSISTANT_STATUS })
    let projected = { role: 'assistant', content }
    if (Buffer.byteLength(JSON.stringify(projected), 'utf8')
      > MAX_AIWORKER_TRANSCRIPT_TOOL_CALL_BYTES) {
      const pairingOnly = content.filter(part => part.type === 'toolCall')
      projected = {
        role: 'assistant',
        content: pairingOnly.length > 0
          ? pairingOnly
          : [{ type: 'text', text: EMPTY_ASSISTANT_STATUS }],
      }
    }
    return { message: projected }
  } catch {
    return {
      message: {
        role: 'assistant',
        content: pairingFallback.length > 0
          ? pairingFallback
          : [{ type: 'text', text: EMPTY_ASSISTANT_STATUS }],
      },
    }
  }
}

export function projectAiworkerMessageBeforeWrite(event = {}) {
  try {
    if (event.message?.role === 'toolResult') {
      return projectAiworkerToolResultForTranscript(event)
    }
  } catch {
    // The assistant projector is total and returns a metadata-free fallback
    // for malformed message objects. This keeps the host's synchronous hook
    // runner from fail-opening on an exception.
  }
  return projectAiworkerToolCallForTranscript(event)
}

function isMainOrChannelSessionKey(sessionKey, targetAgentId) {
  if (typeof sessionKey !== 'string'
    || sessionKey.length > 4_096
    || sessionKey !== sessionKey.trim()
    || /[\u0000-\u001F\u007F]/u.test(sessionKey)) return false
  const prefix = `agent:${targetAgentId}:`
  if (!sessionKey.startsWith(prefix)) return false
  const rest = sessionKey.slice(prefix.length)
  if (rest === 'main') return true
  if (/^(?:subagent|cron|acp):/u.test(rest)) return false

  // Mirrors OpenClaw 2026.7.1-2 parseSessionDeliveryRoute: channel routes are
  // either channel:<peer-kind>:<peer> or channel:<account>:direct|dm:<peer>.
  // Background ownership keys (subagent, cron, ACP, hooks, dashboards) cannot
  // satisfy either complete external-conversation shape.
  const parts = rest.split(':')
  if (parts.some(part => part.length === 0) || parts.length < 3) return false
  const deliveryKinds = new Set(['channel', 'direct', 'dm', 'group'])
  if (parts.length >= 4 && (parts[2] === 'direct' || parts[2] === 'dm')) {
    return parts[0].length > 0 && parts[1].length > 0 && parts.slice(3).join(':').length > 0
  }
  return parts[0] !== 'agent'
    && deliveryKinds.has(parts[1])
    && parts.slice(2).join(':').length > 0
}

function isTargetAgentContext(context, targetAgentId) {
  try {
    return typeof targetAgentId === 'string'
      && targetAgentId.length > 0
      && context?.agentId === targetAgentId
      && isMainOrChannelSessionKey(context?.sessionKey, targetAgentId)
  } catch {
    return false
  }
}

export function projectAiworkerToolResultForTargetAgent(event, context, targetAgentId) {
  if (!isTargetAgentContext(context, targetAgentId)) return undefined
  return projectAiworkerToolResultForTranscript(event)
}

export function projectAiworkerMessageForTargetAgent(event, context, targetAgentId) {
  if (!isTargetAgentContext(context, targetAgentId)) return undefined
  return projectAiworkerMessageBeforeWrite(event)
}
