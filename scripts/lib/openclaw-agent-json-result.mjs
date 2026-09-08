const SILENT_VISIBLE_TEXT = new Set(['NO_REPLY'])

function fail(code) {
  throw new Error(`openclaw_agent_json_result:${code}`)
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function visiblePayloadText(payloads) {
  return payloads
    .filter(payload => {
      const item = record(payload)
      return item && item.visible !== false && item.isError !== true
        && item.isReasoning !== true && item.isCommentary !== true
        && nonEmpty(item.text)
    })
    .map(payload => nonEmpty(payload.text))
    .filter(Boolean)
    .join('\n')
}

function assertNonDeliveringAgentInvocation(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')
    || argv.filter(value => value === 'agent').length !== 1
    || !argv.includes('--json')
    || argv.some(value => value === '--deliver' || value.startsWith('--deliver='))) {
    fail('invocation_not_non_delivering_agent_json')
  }
}

function hasExplicitDeliveryEvidence(value) {
  return value.deliverySucceeded === true
    || value.didSendViaMessagingTool === true
    || (Array.isArray(value.messagingToolSentTargets) && value.messagingToolSentTargets.length > 0)
    || (Array.isArray(value.messagingToolSentTexts) && value.messagingToolSentTexts.length > 0)
    || (Array.isArray(value.messagingToolSentMediaUrls) && value.messagingToolSentMediaUrls.length > 0)
    || Object.hasOwn(value, 'deliveryStatus')
}

/**
 * Parse the public OpenClaw 2026.9 agent --json envelope without accepting
 * historical nested result/output shapes. The caller owns and must clear the
 * returned visible text after deriving bounded evidence from it.
 */
export function parseOpenClawAgentJsonResult(value, { argv, expectedModel } = {}) {
  assertNonDeliveringAgentInvocation(argv)
  const envelope = record(value)
  if (!envelope || !Array.isArray(envelope.payloads)) fail('envelope_invalid')
  const meta = record(envelope.meta)
  const agentMeta = record(meta?.agentMeta)
  if (!meta || !agentMeta) fail('agent_meta_missing')
  if (hasExplicitDeliveryEvidence(envelope)) fail('unexpected_delivery_evidence')

  const provider = nonEmpty(agentMeta.provider)
  const model = nonEmpty(agentMeta.model)
  if (!provider || !model) fail('model_identity_missing')
  if (typeof expectedModel !== 'string' || !expectedModel.trim()) fail('expected_model_invalid')
  const expectedRef = expectedModel.trim()
  const separator = expectedRef.indexOf('/')
  if (separator <= 0 || separator === expectedRef.length - 1) fail('expected_model_invalid')
  const expectedProvider = expectedRef.slice(0, separator)
  const expectedModelId = expectedRef.slice(separator + 1)
  const modelRef = model.includes('/') ? model : `${provider}/${model}`

  const metaText = nonEmpty(meta.finalAssistantVisibleText)
  const payloadText = visiblePayloadText(envelope.payloads)
  const selectedText = metaText ?? payloadText
  const visibleText = selectedText && !SILENT_VISIBLE_TEXT.has(selectedText) ? selectedText : ''
  const durationMs = Number.isFinite(meta.durationMs) ? meta.durationMs : null
  const usage = record(agentMeta.usage)
  const totalTokens = Number.isFinite(usage?.total) ? usage.total : null

  return Object.freeze({
    visibleText,
    provider,
    model,
    modelRef,
    modelMatched: provider === expectedProvider
      && (model === expectedModelId || model === expectedRef),
    durationMs,
    totalTokens,
    externalDelivery: false,
    deliveryEvidence: 'agent-cli-without-deliver-and-no-explicit-delivery-evidence',
  })
}
