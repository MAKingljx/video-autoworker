import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireRole = vi.fn()
const getDatabase = vi.fn()
const logActivity = vi.fn()
const createNotification = vi.fn()
const scanForInjection = vi.fn()
const resolveCoordinatorDeliveryTarget = vi.fn()
const getRuntimeProvider = vi.fn()
const eventBusBroadcast = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/db', () => ({
  getDatabase,
  db_helpers: {
    logActivity,
    createNotification,
  },
}))
vi.mock('@/lib/injection-guard', () => ({
  scanForInjection,
  sanitizeForPrompt: (v: string) => v,
}))
vi.mock('@/lib/coordinator-routing', () => ({ resolveCoordinatorDeliveryTarget }))
vi.mock('@/lib/runtime-provider', () => ({ getRuntimeProvider }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { broadcast: eventBusBroadcast } }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }))

function makeFakeDb() {
  let nextMessageId = 1
  const messages: Array<Record<string, any>> = []

  const prepare = vi.fn((sql: string) => {
    if (sql.includes('INSERT INTO messages')) {
      return {
        run: vi.fn(
          (
            conversation_id: string,
            from_agent: string,
            to_agent: string | null,
            content: string,
            message_type: string,
            metadata: string | null,
            workspace_id: number,
          ) => {
            const row = {
              id: nextMessageId++,
              conversation_id,
              from_agent,
              to_agent,
              content,
              message_type,
              metadata,
              workspace_id,
              read_at: null,
              created_at: Math.floor(Date.now() / 1000),
            }
            messages.push(row)
            return { lastInsertRowid: row.id }
          },
        ),
      }
    }

    if (sql.includes('SELECT * FROM messages WHERE id = ?')) {
      return {
        get: vi.fn((id: number, workspace_id: number) => {
          return messages.find((m) => m.id === id && m.workspace_id === workspace_id) || null
        }),
      }
    }

    if (sql.includes('SELECT * FROM agents WHERE lower(name) = lower(?)')) {
      return {
        get: vi.fn(() => ({ id: 7, name: 'worker', session_key: 'agent:worker:main', config: null })),
      }
    }

    if (sql.includes("SELECT value FROM settings WHERE key = 'chat.coordinator_target_agent'")) {
      return { get: vi.fn(() => ({ value: null })) }
    }

    if (sql.includes('SELECT name, session_key, config FROM agents')) {
      return { all: vi.fn(() => []) }
    }

    // Default safe fallbacks for statements we do not assert on in this test.
    return {
      run: vi.fn(() => ({ changes: 0 })),
      get: vi.fn(() => null),
      all: vi.fn(() => []),
    }
  })

  return { messages, prepare }
}

describe('/api/chat/messages runtime flow (forward -> send -> wait -> persistence)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()

    requireRole.mockReturnValue({
      user: {
        username: 'tester',
        display_name: 'Tester',
        workspace_id: 1,
        role: 'operator',
      },
    })

    scanForInjection.mockReturnValue({ safe: true, matches: [] })

    resolveCoordinatorDeliveryTarget.mockImplementation(({ to }: any) => ({
      deliveryName: String(to),
      sessionKey: null,
      runtimeAgentId: null,
      openclawAgentId: null,
    }))

    const fakeDb = makeFakeDb()
    getDatabase.mockReturnValue({ prepare: fakeDb.prepare })

    const listSessions = vi.fn().mockResolvedValue([
      {
        key: 'agent:worker:main',
        agent: 'worker',
        sessionId: 'sess-worker',
        updatedAt: Date.now(),
        chatType: 'chat',
        channel: 'cli',
        model: 'opus',
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        contextTokens: 0,
        active: true,
      },
    ])

    const sendMessage = vi.fn().mockResolvedValue({
      status: 'accepted',
      runId: 'run-1',
      session: 'agent:worker:main',
      raw: { status: 'accepted', runId: 'run-1', sessionKey: 'agent:worker:main' },
    })

    const waitForRun = vi.fn().mockResolvedValue({
      status: 'completed',
      raw: {
        status: 'completed',
        toolCalls: [{ name: 'search', input: 'x', output: 'y', status: 'ok' }],
        text: 'hello back',
      },
    })

    getRuntimeProvider.mockReturnValue({ listSessions, sendMessage, waitForRun })

    // Attach for assertions
    ;(globalThis as any).__mcFakeDb = fakeDb
    ;(globalThis as any).__mcProvider = { listSessions, sendMessage, waitForRun }
  })

  it('persists forwarded chat + best-effort runtime reply events in DB and SSE', async () => {
    const { POST } = await import('@/app/api/chat/messages/route')

    const req = new NextRequest('http://localhost/api/chat/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        to: 'worker',
        content: 'hi',
        message_type: 'text',
        conversation_id: 'conv-1',
        forward: true,
      }),
    })

    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body.forward).toEqual(
      expect.objectContaining({
        attempted: true,
        delivered: true,
        runId: 'run-1',
      }),
    )

    const provider = (globalThis as any).__mcProvider
    expect(provider.listSessions).toHaveBeenCalled()
    expect(provider.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: 'agent:worker:main',
        message: 'hi',
      }),
    )
    expect(provider.waitForRun).toHaveBeenCalledWith('run-1', 6000)

    const { messages } = (globalThis as any).__mcFakeDb
    expect(messages).toHaveLength(3)

    expect(messages[0]).toEqual(
      expect.objectContaining({
        conversation_id: 'conv-1',
        from_agent: 'Tester',
        to_agent: 'worker',
        content: 'hi',
        message_type: 'text',
      }),
    )

    expect(messages[1]).toEqual(
      expect.objectContaining({
        conversation_id: 'conv-1',
        from_agent: 'worker',
        to_agent: 'Tester',
        content: 'search',
        message_type: 'tool_call',
      }),
    )

    const toolMeta = JSON.parse(String(messages[1].metadata || '{}'))
    expect(toolMeta).toEqual(expect.objectContaining({ runId: 'run-1', toolName: 'search', status: 'ok' }))

    expect(messages[2]).toEqual(
      expect.objectContaining({
        conversation_id: 'conv-1',
        from_agent: 'worker',
        to_agent: 'Tester',
        content: 'hello back',
        message_type: 'text',
      }),
    )

    // One broadcast for initial message + 2 broadcasts for replies.
    expect(eventBusBroadcast).toHaveBeenCalledTimes(3)
  })
})
