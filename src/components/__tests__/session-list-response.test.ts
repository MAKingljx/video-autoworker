import { describe, expect, it } from 'vitest'
import {
  parseSessionListResponse,
  SESSION_READ_UNAVAILABLE_MESSAGE,
} from '@/components/session-list-response'

describe('session list UI response contract', () => {
  it('accepts only the explicit process-runtime success envelope', () => {
    const sessions = [{ id: 'session-a' }]
    expect(parseSessionListResponse({ available: true, sessions })).toEqual({ available: true, sessions })
    expect(parseSessionListResponse({ sessions })).toEqual({
      available: false,
      message: SESSION_READ_UNAVAILABLE_MESSAGE,
    })
  })

  it('keeps unavailable and malformed responses distinct from an empty list', () => {
    for (const value of [
      { available: false, sessions: null, error: 'runtime_unavailable' },
      { available: true, sessions: null },
      null,
    ]) {
      expect(parseSessionListResponse(value)).toEqual({
        available: false,
        message: SESSION_READ_UNAVAILABLE_MESSAGE,
      })
    }
    expect(parseSessionListResponse({ available: true, sessions: [] })).toEqual({
      available: true,
      sessions: [],
    })
  })
})
