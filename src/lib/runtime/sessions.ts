import type { RuntimeSessionSummary } from './contracts'

export type RuntimeAgentLiveStatus = {
  status: 'active' | 'idle' | 'offline'
  lastActivity: number
  channel: string
}

export type RuntimeSessionOverview =
  | { available: true; total: number; active: number }
  | { available: false; total: null; active: null }

export function unavailableRuntimeSessionOverview(): RuntimeSessionOverview {
  return { available: false, total: null, active: null }
}

export function summarizeRuntimeSessions(
  sessions: RuntimeSessionSummary[],
): RuntimeSessionOverview {
  return {
    available: true,
    total: sessions.length,
    active: sessions.filter((session) => session.hasActiveRun === true).length,
  }
}

/** Derive application status from provider-neutral session metadata. */
export function deriveAgentLiveStatuses(
  sessions: RuntimeSessionSummary[],
  now = Date.now(),
): Map<string, RuntimeAgentLiveStatus> {
  const statuses = new Map<string, RuntimeAgentLiveStatus>()

  for (const session of sessions) {
    const existing = statuses.get(session.agent)
    if (existing && existing.lastActivity >= session.updatedAt) continue

    const age = now - session.updatedAt
    const status = age < 5 * 60 * 1000
      ? 'active'
      : age < 60 * 60 * 1000
        ? 'idle'
        : 'offline'
    statuses.set(session.agent, {
      status,
      lastActivity: session.updatedAt,
      channel: session.channel,
    })
  }

  return statuses
}
