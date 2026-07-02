import { beforeEach, describe, expect, it, vi } from 'vitest'

const callOpenClawGateway = vi.fn()
const runOpenClaw = vi.fn()

vi.mock('@/lib/openclaw-gateway', () => ({
  callOpenClawGateway,
  parseGatewayJsonOutput: (raw: string) => {
    const trimmed = String(raw || '').trim()
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start < 0 || end < start) return null
    return JSON.parse(trimmed.slice(start, end + 1))
  },
}))

vi.mock('@/lib/command', () => ({
  runOpenClaw,
}))

describe('OpenClawRuntimeProvider', () => {
  beforeEach(() => {
    vi.resetModules()
    callOpenClawGateway.mockReset()
    runOpenClaw.mockReset()
  })

  it('sends chat messages through sessionKey boundary', async () => {
    callOpenClawGateway.mockResolvedValue({ status: 'started', runId: 'run-1', sessionKey: 'sess-1' })
    const { OpenClawRuntimeProvider } = await import('@/lib/runtime-provider')

    const provider = new OpenClawRuntimeProvider()
    const result = await provider.sendMessage({
      sessionKey: 'sess-1',
      message: 'hello',
      idempotencyKey: 'idem-1',
      deliver: false,
    })

    expect(callOpenClawGateway).toHaveBeenCalledWith(
      'chat.send',
      {
        sessionKey: 'sess-1',
        message: 'hello',
        idempotencyKey: 'idem-1',
        deliver: false,
        attachments: undefined,
      },
      12_000,
    )
    expect(result).toEqual({
      status: 'started',
      runId: 'run-1',
      session: 'sess-1',
      raw: { status: 'started', runId: 'run-1', sessionKey: 'sess-1' },
    })
  })

  it('sends agent messages through agentId boundary', async () => {
    runOpenClaw.mockResolvedValue({ stdout: '{"status":"accepted","runId":"run-2"}', stderr: '', code: 0 })
    const { OpenClawRuntimeProvider } = await import('@/lib/runtime-provider')

    const provider = new OpenClawRuntimeProvider()
    const result = await provider.sendMessage({
      agentId: 'agent-1',
      message: 'hello agent',
      idempotencyKey: 'idem-2',
    })

    expect(runOpenClaw).toHaveBeenCalledWith(
      [
        'gateway',
        'call',
        'agent',
        '--timeout',
        '10000',
        '--params',
        JSON.stringify({
          agentId: 'agent-1',
          message: 'hello agent',
          idempotencyKey: 'idem-2',
          deliver: false,
        }),
        '--json',
      ],
      { timeoutMs: 12_000 },
    )
    expect(result).toEqual({
      status: 'accepted',
      runId: 'run-2',
      session: 'agent-1',
      raw: { status: 'accepted', runId: 'run-2' },
    })
  })

  it('waits for run through provider boundary', async () => {
    callOpenClawGateway.mockResolvedValue({ status: 'completed', text: 'done' })
    const { OpenClawRuntimeProvider } = await import('@/lib/runtime-provider')

    const provider = new OpenClawRuntimeProvider()
    const result = await provider.waitForRun('run-3', 6000)

    expect(callOpenClawGateway).toHaveBeenCalledWith('agent.wait', { runId: 'run-3', timeoutMs: 6000 }, 8_000)
    expect(result).toEqual({
      status: 'completed',
      raw: { status: 'completed', text: 'done' },
    })
  })

  it('spawns session with compatibility fallback when tools profile is unsupported', async () => {
    callOpenClawGateway
      .mockRejectedValueOnce(new Error('unknown field tools.profile'))
      .mockResolvedValueOnce({ status: 'started', sessionId: 'sess-9' })
    const { OpenClawRuntimeProvider } = await import('@/lib/runtime-provider')

    const provider = new OpenClawRuntimeProvider()
    const result = await provider.spawnSession({
      task: 'do thing',
      label: 'demo',
      runTimeoutSeconds: 30,
      tools: { profile: 'coding' },
    })

    expect(callOpenClawGateway).toHaveBeenNthCalledWith(1, 'sessions_spawn', {
      task: 'do thing',
      label: 'demo',
      runTimeoutSeconds: 30,
      tools: { profile: 'coding' },
    }, 15_000)
    expect(callOpenClawGateway).toHaveBeenNthCalledWith(2, 'sessions_spawn', {
      task: 'do thing',
      label: 'demo',
      runTimeoutSeconds: 30,
    }, 15_000)
    expect(result).toEqual({
      status: 'started',
      sessionId: 'sess-9',
      __compatibilityFallbackUsed: true,
    })
  })

  it('lists sessions through provider boundary', async () => {
    const listed = [{ key: 'agent:main:main', agent: 'main', sessionId: 'sess-1', updatedAt: 123, chatType: 'chat', channel: 'cli', model: 'opus', totalTokens: 1, inputTokens: 1, outputTokens: 0, contextTokens: 1000, active: true }]
    vi.doMock('@/lib/openclaw-session-source', () => ({ getAllGatewaySessions: vi.fn(() => listed) }))
    const { OpenClawRuntimeProvider } = await import('@/lib/runtime-provider')

    const provider = new OpenClawRuntimeProvider()
    await expect(provider.listSessions()).resolves.toEqual(listed)
  })

  it('updates session config through gateway session boundary', async () => {
    callOpenClawGateway.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true })
    const { OpenClawRuntimeProvider } = await import('@/lib/runtime-provider')

    const provider = new OpenClawRuntimeProvider()
    await provider.updateSessionConfig('sess-a', { thinking: 'medium' })
    await provider.updateSessionConfig('sess-a', { label: 'ops-room' })

    expect(callOpenClawGateway).toHaveBeenNthCalledWith(1, 'session_setThinking', {
      sessionKey: 'sess-a',
      level: 'medium',
    }, 10_000)
    expect(callOpenClawGateway).toHaveBeenNthCalledWith(2, 'session_setLabel', {
      sessionKey: 'sess-a',
      label: 'ops-room',
    }, 10_000)
  })

  it('deletes session through gateway session boundary', async () => {
    callOpenClawGateway.mockResolvedValue({ ok: true })
    const { OpenClawRuntimeProvider } = await import('@/lib/runtime-provider')

    const provider = new OpenClawRuntimeProvider()
    await provider.deleteSession('sess-z')

    expect(callOpenClawGateway).toHaveBeenCalledWith('session_delete', { sessionKey: 'sess-z' }, 10_000)
  })

  it('controls session through provider boundary', async () => {
    callOpenClawGateway.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({ ok: true })
    const { OpenClawRuntimeProvider } = await import('@/lib/runtime-provider')

    const provider = new OpenClawRuntimeProvider()
    await provider.controlSession('sess-a', 'monitor')
    await provider.controlSession('sess-a', 'terminate')

    expect(callOpenClawGateway).toHaveBeenNthCalledWith(1, 'sessions_send', {
      sessionKey: 'sess-a',
      message: { type: 'control', action: 'monitor' },
    }, 10_000)
    expect(callOpenClawGateway).toHaveBeenNthCalledWith(2, 'session_delete', { sessionKey: 'sess-a' }, 10_000)
  })
})
