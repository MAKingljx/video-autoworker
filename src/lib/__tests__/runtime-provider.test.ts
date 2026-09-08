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
    vi.spyOn(Date, 'now').mockReturnValue(10_000)
    callOpenClawGateway
      .mockResolvedValueOnce({
        sessions: [{
          key: 'agent:main:main',
          agentId: 'main',
          sessionId: 'sess-1',
          updatedAt: 9_000,
          kind: 'direct',
          channel: 'cli',
          model: 'opus',
          totalTokens: 3,
          inputTokens: 2,
          outputTokens: 1,
          contextTokens: 1000,
          hasActiveRun: true,
        }],
        hasMore: true,
        nextOffset: 1,
      })
      .mockResolvedValueOnce({
        sessions: [{
          key: 'agent:worker:main',
          sessionId: 'sess-2',
          updatedAt: 1_000,
          chatType: 'chat',
        }],
        hasMore: false,
      })
    const { OpenClawRuntimeProvider } = await import('@/lib/runtime-provider')

    const provider = new OpenClawRuntimeProvider()
    await expect(provider.listSessions({ activeWithinMs: 5_000 })).resolves.toEqual([
      expect.objectContaining({
        key: 'agent:main:main',
        agent: 'main',
        chatType: 'direct',
        active: true,
        hasActiveRun: true,
      }),
      expect.objectContaining({
        key: 'agent:worker:main',
        agent: 'worker',
        active: false,
        hasActiveRun: false,
      }),
    ])
    expect(callOpenClawGateway).toHaveBeenNthCalledWith(
      1,
      'sessions.list',
      { limit: 200, offset: 0, configuredAgentsOnly: true },
      15_000,
    )
    expect(callOpenClawGateway).toHaveBeenNthCalledWith(
      2,
      'sessions.list',
      { limit: 200, offset: 1, configuredAgentsOnly: true },
      15_000,
    )
    await provider.listSessions()
    expect(callOpenClawGateway).toHaveBeenCalledTimes(2)
  })

  it('fails closed when sessions.list pagination skips or stalls', async () => {
    callOpenClawGateway.mockResolvedValue({
      sessions: [{ key: 'agent:main:main', sessionId: 'sess-1', updatedAt: 1 }],
      hasMore: true,
      nextOffset: 3,
    })
    const { OpenClawRuntimeProvider } = await import('@/lib/runtime-provider')

    const provider = new OpenClawRuntimeProvider()
    await expect(provider.listSessions()).rejects.toThrow('Invalid sessions.list pagination')

    callOpenClawGateway.mockReset()
    callOpenClawGateway.mockResolvedValue({ sessions: [], hasMore: true, nextOffset: 0 })
    const stalledProvider = new OpenClawRuntimeProvider()
    await expect(stalledProvider.listSessions()).rejects.toThrow('Invalid sessions.list pagination')
  })

  it('normalizes official and legacy tool history inside the OpenClaw adapter', async () => {
    callOpenClawGateway.mockResolvedValue({
      messages: [
        {
          role: 'assistant',
          timestamp: 1_000,
          content: [
            { type: 'toolCall', id: 'call-1', name: 'status', arguments: { concise: true } },
            { type: 'tool_use', id: 'call-legacy', name: 'legacy', input: { ok: true } },
          ],
        },
        {
          role: 'toolResult',
          timestamp: 2_000,
          toolCallId: 'call-1',
          toolName: 'fixture-result',
          isError: true,
          content: [{
            type: 'toolResult',
            id: 'result-1',
            name: 'fixture-result',
            content: '',
            text: 'ready',
            toolCallId: 'call-1',
            toolName: 'fixture-result',
            toolUseId: 'call-1',
            tool_use_id: 'call-1',
          }],
        },
      ],
    })
    const { OpenClawRuntimeProvider } = await import('@/lib/runtime-provider')

    const provider = new OpenClawRuntimeProvider()
    await expect(provider.getSessionHistory('agent:main:main', { limit: 25 })).resolves.toEqual({
      messages: [
        {
          role: 'assistant',
          parts: [
            { type: 'tool_use', id: 'call-1', name: 'status', input: '{"concise":true}' },
            { type: 'tool_use', id: 'call-legacy', name: 'legacy', input: '{"ok":true}' },
          ],
          timestamp: 1_000,
        },
        {
          role: 'tool',
          parts: [{ type: 'tool_result', toolUseId: 'call-1', content: 'ready', isError: true }],
          timestamp: 2_000,
        },
      ],
    })
    expect(callOpenClawGateway).toHaveBeenCalledWith(
      'chat.history',
      { sessionKey: 'agent:main:main', limit: 25 },
      15_000,
    )
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
    callOpenClawGateway
      .mockResolvedValueOnce({
        sessions: [{
          key: 'agent:worker:task',
          agentId: 'worker',
          sessionId: 'sess-z',
          updatedAt: 1,
        }],
        hasMore: false,
      })
      .mockResolvedValueOnce({ ok: true })
    const { OpenClawRuntimeProvider } = await import('@/lib/runtime-provider')

    const provider = new OpenClawRuntimeProvider()
    await provider.deleteSession('agent:worker:task')

    expect(callOpenClawGateway).toHaveBeenNthCalledWith(2, 'sessions.delete', {
      key: 'agent:worker:task',
      agentId: 'worker',
      expectedSessionId: 'sess-z',
      deleteTranscript: true,
    }, 15_000)
  })

  it('controls session through provider boundary', async () => {
    callOpenClawGateway
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        sessions: [{
          key: 'agent:worker:task',
          agentId: 'worker',
          sessionId: 'sess-a',
          updatedAt: 1,
        }],
        hasMore: false,
      })
      .mockResolvedValueOnce({ ok: true })
    const { OpenClawRuntimeProvider } = await import('@/lib/runtime-provider')

    const provider = new OpenClawRuntimeProvider()
    await provider.controlSession('agent:worker:task', 'monitor')
    await provider.controlSession('agent:worker:task', 'terminate')

    expect(callOpenClawGateway).toHaveBeenNthCalledWith(1, 'sessions_send', {
      sessionKey: 'agent:worker:task',
      message: { type: 'control', action: 'monitor' },
    }, 10_000)
    expect(callOpenClawGateway).toHaveBeenNthCalledWith(3, 'sessions.delete', {
      key: 'agent:worker:task',
      agentId: 'worker',
      expectedSessionId: 'sess-a',
      deleteTranscript: true,
    }, 15_000)
  })
})
