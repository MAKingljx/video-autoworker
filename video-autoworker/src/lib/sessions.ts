export type { RuntimeSessionSummary as GatewaySession } from './runtime/contracts'
export { deriveAgentLiveStatuses as getAgentLiveStatuses } from './runtime/sessions'

export type GatewaySessionMatchOptions = {
  preferredSessionKey?: string | null
  fallbackSessionKey?: string | null
  fallbackToMain?: boolean
}

import type { RuntimeSessionSummary as GatewaySession } from './runtime/contracts'

export function resolveActiveGatewaySession(
  sessions: GatewaySession[],
  agentNames: Array<string | null | undefined>,
  options: GatewaySessionMatchOptions = {},
): GatewaySession | null {
  const normalizedCandidates = agentNames
    .map((name) => String(name || '').trim().toLowerCase())
    .filter(Boolean)

  if (options.preferredSessionKey) {
    const direct = sessions.find(
      (session) => session.key === options.preferredSessionKey || session.sessionId === options.preferredSessionKey,
    )
    if (direct) return direct
  }

  const candidateMatches = sessions.filter((session) => normalizedCandidates.includes(String(session.agent || '').trim().toLowerCase()))
  if (candidateMatches.length > 0) {
    return candidateMatches.sort((a, b) => b.updatedAt - a.updatedAt)[0]
  }

  if (options.fallbackSessionKey) {
    const fallback = sessions.find(
      (session) => session.key === options.fallbackSessionKey || session.sessionId === options.fallbackSessionKey,
    )
    if (fallback) return fallback
  }

  if (options.fallbackToMain) {
    const main = sessions.find((session) => /agent:main:main$/i.test(String(session.key || '')))
    if (main) return main
  }

  return null
}
