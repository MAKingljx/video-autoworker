import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/config', () => ({
  config: {
    openclawStateDir: '/mock/openclaw',
  },
}))

describe('session resolution helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('prefers explicit session key when present', async () => {
    const { resolveActiveGatewaySession } = await import('@/lib/sessions')

    const resolved = resolveActiveGatewaySession(
      [
        {
          key: 'agent:worker:main',
          agent: 'worker',
          sessionId: 'sess-worker',
          updatedAt: 100,
          chatType: 'chat',
          channel: 'cli',
          model: 'opus',
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: 0,
          active: true,
        },
      ],
      ['other'],
      { preferredSessionKey: 'agent:worker:main' },
    )

    expect(resolved?.key).toBe('agent:worker:main')
  })

  it('resolves the freshest matching agent session by candidate names', async () => {
    const { resolveActiveGatewaySession } = await import('@/lib/sessions')

    const resolved = resolveActiveGatewaySession(
      [
        {
          key: 'agent:worker:main',
          agent: 'worker',
          sessionId: 'sess-1',
          updatedAt: 100,
          chatType: 'chat',
          channel: 'cli',
          model: 'opus',
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: 0,
          active: true,
        },
        {
          key: 'agent:worker:secondary',
          agent: 'worker',
          sessionId: 'sess-2',
          updatedAt: 200,
          chatType: 'chat',
          channel: 'cli',
          model: 'opus',
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: 0,
          active: true,
        },
      ],
      ['worker'],
    )

    expect(resolved?.sessionId).toBe('sess-2')
  })

  it('can fall back to configured session key or main session', async () => {
    const { resolveActiveGatewaySession } = await import('@/lib/sessions')

    const sessions = [
      {
        key: 'agent:main:main',
        agent: 'main',
        sessionId: 'main-sess',
        updatedAt: 10,
        chatType: 'chat',
        channel: 'cli',
        model: 'opus',
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        contextTokens: 0,
        active: true,
      },
    ]

    expect(resolveActiveGatewaySession(sessions, ['missing'], { fallbackSessionKey: 'agent:main:main' })?.sessionId).toBe('main-sess')
    expect(resolveActiveGatewaySession(sessions, ['missing'], { fallbackToMain: true })?.sessionId).toBe('main-sess')
  })
})
