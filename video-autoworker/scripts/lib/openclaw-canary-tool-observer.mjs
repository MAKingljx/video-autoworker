import { createHash } from 'node:crypto'

export function canaryToolCallDigest(id) {
  return typeof id === 'string' && id.length > 0
    ? createHash('sha256').update(id).digest('hex')
    : null
}

// Isolated QA only: observe execution before the normal transcript projection.
// Never retain arbitrary arguments, business results, or caller identifiers.
export function observeCanaryTool(tool, record) {
  if (!tool) return tool
  return {
    ...tool,
    async execute(id, parameters, ...rest) {
      const exactCanonicalArguments = parameters !== null && typeof parameters === 'object'
        && !Array.isArray(parameters)
        && Object.keys(parameters).sort().join(',') === 'action,topic'
        && parameters.action === 'explain' && parameters.topic === 'technique_learning'
      let canonicalResult = false
      try {
        const result = await tool.execute(id, parameters, ...rest)
        const text = Array.isArray(result?.content)
          ? result.content.map(part => part?.type === 'text' ? part.text : '').join('\n')
          : ''
        try {
          const value = JSON.parse(text)
          canonicalResult = result.isError !== true && value?.ok === true
            && value.action === 'explain' && value.outcome === 'answered'
            && value.responseContract?.mustQuoteUserVisibleAnswerExactly === true
        } catch { /* An unstructured or error reply is not canonical success. */ }
        return result
      } finally {
        record({ callIdSha256: canaryToolCallDigest(id), exactCanonicalArguments, canonicalResult })
      }
    },
  }
}

export function observedCanonicalRouteVerified(route, observations) {
  const call = route?.calls?.[0]
  const result = route?.results?.[0]
  const observed = observations?.[0]
  return route?.foundPrompt === true && route.calls.length === 1
    && call.name === 'aiworker_director_brain'
    && JSON.stringify(call.arguments) === '{"action":"explain"}'
    && route.results.length === 1 && route.completedPairs === 1
    && result.name === call.name && result.matchedCall === true
    && result.isError === false && result.explicitSuccess === true
    && result.persistedSuccessStatus === true
    && observations.length === 1 && typeof call.callIdSha256 === 'string'
    && observed.callIdSha256 === call.callIdSha256
    && observed.exactCanonicalArguments === true && observed.canonicalResult === true
}
