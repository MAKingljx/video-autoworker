import { canaryToolCallDigest } from './openclaw-canary-tool-observer.mjs'

export const RICH_CANARY_CONTRACT = Object.freeze({
  recentTurnsPreserve: 4,
  keepRecentTokens: 4_096,
  maxActiveTranscriptBytes: 131_072,
  turns: 2,
  minimumToolPairs: 19,
  midTurnPrecheckEnabled: false,
  canonicalSourceMode: 'fixture',
  canonicalTechniqueTopic: 'technique_learning',
  canonicalExplainPrompt:
    '请重新读取权威导演脑后回答：导演脑提炼技法的底层逻辑是什么？请用两句以内回答。',
  persistedBusinessToolStatus:
    '完整结果保留在业务数据源中，需要时可由原工具重新读取。',
  resolutionNotFoundAnswer: '我没有找到这个作品。请告诉我更准确的完整作品名。',
  compactionSafetyInstructions: [
    'Retain safe user goals, facts, decisions, constraints, unresolved questions, and task continuity across every topic, including ordinary programming, operations plans, general questions, long-form summaries, and director work.',
    'Exclude tool-call and tool-result structures, metadata fields, identifiers, locations, links, filenames, commands, credential-bearing details, and operational internals.',
    'Never copy, quote, list, transform, describe, or mention excluded material.',
    'Preserve the safe semantic anchors needed to answer later user questions.',
    'A compressed answer is never authority for a later director-brain question; preserve the requirement to call the current director-brain tool again and use that turn\'s result.',
  ].join(' '),
})

const INVALID_CANONICAL_FACT_RELATIONSHIPS = Object.freeze([
  /(?:无需|不必|不需要|不依赖|绕过|跳过)[^。！？!?；;]{0,24}(?:审核|证据|导演意图|人工确认)/u,
  /(?:未审核|未经审核)[^。！？!?；;]{0,24}(?:即可|也可|可以|能够)[^。！？!?；;]{0,16}(?:形成|提炼|复用|采用)/u,
  /(?:复用|应用|采用)[^。！？!?；;]{0,24}(?:不受|无需|不必|绕过|跳过)[^。！？!?；;]{0,20}(?:导演意图|人工审核|人工确认)/u,
])

const CANONICAL_TECHNIQUE_FACTS = Object.freeze([
  Object.freeze({
    id: 'reviewed-evidence-forms-case',
    patterns: Object.freeze([
      /(?:已审核|审核通过|已经确认)[^。！？!?；;]{0,28}(?:素材|证据)[^。！？!?；;]{0,48}(?:导演判断|判断)[^。！？!?；;]{0,48}(?:形成|沉淀|记录|归纳)[^。！？!?；;]{0,16}案例/u,
      /(?:形成|沉淀|记录|归纳)[^。！？!?；;]{0,16}案例[^。！？!?；;]{0,48}(?:已审核|审核通过|已经确认)[^。！？!?；;]{0,28}(?:素材|证据)[^。！？!?；;]{0,48}(?:导演判断|判断)/u,
      /(?:从|由|基于|结合|依据)[^。！？!?；;]{0,24}(?:已审核|审核通过|已经确认)[^。！？!?；;]{0,20}(?:素材|证据)[^。！？!?；;]{0,48}(?:导演判断|判断)[^。！？!?；;]{0,36}案例/u,
    ]),
  }),
  Object.freeze({
    id: 'case-yields-technique-logic',
    patterns: Object.freeze([
      /案例[^。！？!?；;]{0,40}(?:提炼|抽取|沉淀|归纳)[^。！？!?；;]{0,40}(?:适用条件|适用范围)[^。！？!?；;]{0,32}(?:执行方法|执行方式|做法)[^。！？!?；;]{0,32}(?:原理|为什么有效|有效原因)/u,
      /(?:提炼|抽取|沉淀|归纳)[^。！？!?；;]{0,24}案例[^。！？!?；;]{0,40}(?:适用条件|适用范围)[^。！？!?；;]{0,32}(?:执行方法|执行方式|做法)[^。！？!?；;]{0,32}(?:原理|为什么有效|有效原因)/u,
    ]),
  }),
  Object.freeze({
    id: 'reuse-governed-by-intent-and-review',
    patterns: Object.freeze([
      /(?:复用|应用|采用|执行)[^。！？!?；;]{0,40}(?:导演意图)[^。！？!?；;]{0,32}(?:人工审核|人工确认|人工复核)[^。！？!?；;]{0,24}(?:约束|限制|把关|前提|确认)/u,
      /(?:导演意图)[^。！？!?；;]{0,24}(?:人工审核|人工确认|人工复核)[^。！？!?；;]{0,40}(?:约束|限制|把关|前提|确认)[^。！？!?；;]{0,24}(?:复用|应用|采用|执行)/u,
      /(?:复用|应用|采用|执行)[^。！？!?；;]{0,28}(?:受|遵循|服从)[^。！？!?；;]{0,24}(?:导演意图)[^。！？!?；;]{0,24}(?:以及|和|及|与)[^。！？!?；;]{0,16}(?:人工审核|人工确认|人工复核)/u,
    ]),
  }),
])

function normalizeText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\t ]+/gu, ' ').trim()
    : ''
}

export function missingCanonicalTechniqueFactAnchors(value) {
  const text = normalizeText(value)
  if (!text) return CANONICAL_TECHNIQUE_FACTS.map(fact => fact.id)
  if (INVALID_CANONICAL_FACT_RELATIONSHIPS.some(pattern => pattern.test(text))) {
    return ['canonical-technique-fact-reversed']
  }
  return CANONICAL_TECHNIQUE_FACTS
    .filter(fact => !fact.patterns.some(pattern => pattern.test(text)))
    .map(fact => fact.id)
}

export function validatesCanonicalTechniqueFacts(value) {
  return missingCanonicalTechniqueFactAnchors(value).length === 0
}

function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : [message?.content]
  return content.flatMap(item => {
    if (typeof item === 'string') return [item]
    return typeof item?.text === 'string' ? [item.text] : []
  }).join('\n')
}

function parsedToolArguments(part) {
  const source = Object.hasOwn(part, 'input') ? part.input : part.arguments
  if (source && typeof source === 'object' && !Array.isArray(source)) return source
  if (typeof source !== 'string') return {}
  try {
    const parsed = JSON.parse(source)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function inspectCurrentTurnToolRoute(rows, prompt, { includeCallDigests = false } = {}) {
  if (!Array.isArray(rows)) return { foundPrompt: false, calls: [], results: [], completedPairs: 0 }
  let promptIndex = -1
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index]?.message?.role === 'user' && messageText(rows[index].message).includes(prompt)) {
      promptIndex = index
      break
    }
  }
  if (promptIndex < 0) return { foundPrompt: false, calls: [], results: [], completedPairs: 0 }

  const callIds = new Map()
  const calls = []
  const results = []
  for (const row of rows.slice(promptIndex + 1)) {
    const message = row?.message
    if (message?.role === 'user') break
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part?.type !== 'toolCall' || typeof part.name !== 'string') continue
        const entry = { name: part.name, arguments: parsedToolArguments(part) }
        if (includeCallDigests) entry.callIdSha256 = canaryToolCallDigest(part.id)
        calls.push(entry)
        if (typeof part.id === 'string') callIds.set(part.id, entry)
      }
      continue
    }
    if (message?.role !== 'toolResult' || typeof message.toolCallId !== 'string') continue
    const call = callIds.get(message.toolCallId)
    const text = Array.isArray(message.content)
      ? message.content.map(part => typeof part?.text === 'string' ? part.text : '').join('\n')
      : ''
    let structured = null
    try {
      const parsed = JSON.parse(text.trim())
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) structured = parsed
    } catch {
      // Projected results are intentionally plain bounded text.
    }
    const errorFlagPresent = Object.hasOwn(message, 'isError')
    results.push({
      name: typeof message.toolName === 'string' ? message.toolName : null,
      matchedCall: Boolean(call) && message.toolName === call.name,
      errorFlagPresent,
      isError: message.isError === true,
      explicitSuccess: errorFlagPresent && message.isError === false,
      structuredOk: structured?.ok === true,
      structuredAction: typeof structured?.action === 'string' ? structured.action : null,
      structuredOutcome: typeof structured?.outcome === 'string' ? structured.outcome : null,
      structuredHandled: structured?.handled === true,
      structuredFound: typeof structured?.found === 'boolean' ? structured.found : null,
      responseContractPresent:
        structured?.responseContract?.mustQuoteUserVisibleAnswerExactly === true
        && typeof structured.responseContract.userVisibleAnswer === 'string'
        && structured.responseContract.userVisibleAnswer.length > 0,
      resolutionNotFound:
        (structured?.ok === true
          && structured?.action === 'resolve_work'
          && structured?.handled === true
          && structured?.outcome === 'not_found'
          && structured?.responseContract?.mustQuoteUserVisibleAnswerExactly === true
          && structured?.responseContract?.stopAfterReply === true
          && structured.responseContract.userVisibleAnswer
            === RICH_CANARY_CONTRACT.resolutionNotFoundAnswer)
        || (errorFlagPresent
          && message.isError === false
          && text === `${RICH_CANARY_CONTRACT.resolutionNotFoundAnswer}\n${
            RICH_CANARY_CONTRACT.persistedBusinessToolStatus
          }`),
      persistedSuccessStatus:
        text.endsWith(RICH_CANARY_CONTRACT.persistedBusinessToolStatus),
    })
  }
  return {
    foundPrompt: true,
    calls,
    results,
    completedPairs: results.filter(result => (
      result.matchedCall
      && !result.isError
      && (result.explicitSuccess || result.structuredOk)
    )).length,
  }
}

function normalizedJson(value) {
  if (Array.isArray(value)) return value.map(normalizedJson)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).toSorted().map(key => [key, normalizedJson(value[key])]))
}

export function exactSuccessfulToolRouteVerified(route, expectedCall, {
  requireProjectedStatus = false,
  requireStructuredOk = false,
  expectedResultEvidence = null,
} = {}) {
  const actualCall = route?.calls?.[0]
  const result = route?.results?.[0]
  return route?.foundPrompt === true
    && route.calls?.length === 1
    && actualCall?.name === expectedCall?.name
    && JSON.stringify(normalizedJson(actualCall?.arguments))
      === JSON.stringify(normalizedJson(expectedCall?.arguments))
    && route.results?.length === 1
    && route.completedPairs === 1
    && result?.name === expectedCall?.name
    && result?.matchedCall === true
    && result?.isError === false
    && (result?.explicitSuccess === true || result?.structuredOk === true)
    && (!requireProjectedStatus || result?.persistedSuccessStatus === true)
    && (!requireStructuredOk || result?.structuredOk === true)
    && (!expectedResultEvidence || Object.entries(expectedResultEvidence)
      .every(([key, value]) => result?.[key] === value))
}

export function canonicalTechniqueToolRouteVerified(route) {
  return exactSuccessfulToolRouteVerified(
    route,
    {
      name: 'aiworker_director_brain',
      arguments: {
        action: 'explain',
        topic: RICH_CANARY_CONTRACT.canonicalTechniqueTopic,
      },
    },
    { requireProjectedStatus: true },
  )
}
