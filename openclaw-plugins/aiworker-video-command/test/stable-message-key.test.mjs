import { describe, expect, it } from 'vitest'

import { deriveStableDispatchKey } from '../lib/stable-message-key.js'

describe('deriveStableDispatchKey', () => {
  it('is stable, scoped, and contains no plaintext content or identity fields', () => {
    const fields = {
      channel: 'telegram',
      accountId: 'account-private',
      conversationId: 'conversation-private',
      sessionKey: 'session-private',
      senderId: 'sender-private',
      timestamp: 1_786_240_000_123,
      content: '分析视频 /Users/Shared/private-video.mp4',
    }
    const first = deriveStableDispatchKey(fields)
    expect(deriveStableDispatchKey(fields)).toBe(first)
    expect(deriveStableDispatchKey({ ...fields, timestamp: fields.timestamp + 1 })).not.toBe(first)
    expect(deriveStableDispatchKey({ ...fields, content: '分析视频 /tmp/other.mp4' })).not.toBe(first)
    expect(first).toMatch(/^video-command-[a-f0-9]{64}$/u)
    for (const value of Object.values(fields).map(String)) expect(first).not.toContain(value)
  })

  it('requires exact content and a finite timestamp', () => {
    expect(() => deriveStableDispatchKey({ content: '分析视频 /tmp/demo.mp4' }))
      .toThrow('finite timestamp is required')
    expect(() => deriveStableDispatchKey({ timestamp: 123 }))
      .toThrow('content is required')
  })
})
