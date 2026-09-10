import { describe, expect, it } from 'vitest'
import {
  deriveAgentLiveStatuses,
  summarizeRuntimeSessions,
  unavailableRuntimeSessionOverview,
} from '@/lib/runtime/sessions'
import type { RuntimeSessionSummary } from '@/lib/runtime/contracts'

function session(agent: string, updatedAt: number, channel: string): RuntimeSessionSummary {
  return {
    key: `agent:${agent}:main`,
    agent,
    sessionId: `session-${agent}`,
    updatedAt,
    chatType: 'direct',
    channel,
    model: 'model',
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    contextTokens: 0,
    active: false,
  }
}

describe('runtime session helpers', () => {
  it('keeps unavailable metrics distinct from a verified empty session list', () => {
    expect(unavailableRuntimeSessionOverview()).toEqual({
      available: false,
      total: null,
      active: null,
    })
    expect(summarizeRuntimeSessions([])).toEqual({
      available: true,
      total: 0,
      active: 0,
    })
  })

  it('derives one current live status per agent from provider-neutral sessions', () => {
    const now = Date.parse('2026-09-08T12:00:00.000Z')
    const statuses = deriveAgentLiveStatuses([
      session('main', now - 70 * 60_000, 'old'),
      session('main', now - 2 * 60_000, 'cli'),
      session('worker', now - 20 * 60_000, 'telegram'),
    ], now)

    expect(statuses.get('main')).toEqual({
      status: 'active',
      lastActivity: now - 2 * 60_000,
      channel: 'cli',
    })
    expect(statuses.get('worker')?.status).toBe('idle')
  })
})
