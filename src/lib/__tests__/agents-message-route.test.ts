import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireRole = vi.fn()
const mutationLimiter = vi.fn()
const validateBody = vi.fn()
const getDatabase = vi.fn()
const createNotification = vi.fn()
const logActivity = vi.fn()
const scanForInjection = vi.fn()
const scanForSecrets = vi.fn()
const logSecurityEvent = vi.fn()
const logger = { error: vi.fn(), warn: vi.fn() }
const getRuntimeProvider = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/validation', () => ({ validateBody, createMessageSchema: {} }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter }))
vi.mock('@/lib/logger', () => ({ logger }))
vi.mock('@/lib/injection-guard', () => ({ scanForInjection }))
vi.mock('@/lib/secret-scanner', () => ({ scanForSecrets }))
vi.mock('@/lib/security-events', () => ({ logSecurityEvent }))
vi.mock('@/lib/runtime-provider', () => ({ getRuntimeProvider }))
vi.mock('@/lib/db', () => ({
  getDatabase,
  db_helpers: { createNotification, logActivity },
}))

describe('/api/agents/message route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    requireRole.mockReturnValue({ user: { username: 'tester', display_name: 'Tester', workspace_id: 1, role: 'operator' } })
    mutationLimiter.mockReturnValue(null)
    validateBody.mockResolvedValue({ data: { to: 'worker', message: 'hello there' } })
    scanForInjection.mockReturnValue({ safe: true, matches: [] })
    scanForSecrets.mockReturnValue([])
    getDatabase.mockReturnValue({
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT * FROM agents')) {
          return { get: vi.fn(() => ({ id: 7, name: 'worker', session_key: 'agent:worker:main' })) }
        }
        return { get: vi.fn(() => null) }
      }),
    })
  })

  it('uses runtime provider session listing + sendMessage boundary', async () => {
    const listSessions = vi.fn().mockResolvedValue([
      {
        key: 'agent:worker:main',
        agent: 'worker',
        sessionId: 'sess-worker',
        updatedAt: 123,
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
    const sendMessage = vi.fn().mockResolvedValue({ status: 'accepted', runId: 'run-1', session: 'agent:worker:main', raw: {} })
    getRuntimeProvider.mockReturnValue({ listSessions, sendMessage })

    const { POST } = await import('@/app/api/agents/message/route')
    const req = new NextRequest('http://localhost/api/agents/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'worker', message: 'hello there' }),
    })

    const response = await POST(req)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(listSessions).toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledWith({
      sessionKey: 'agent:worker:main',
      message: 'Message from Tester: hello there',
      idempotencyKey: expect.stringMatching(/^direct-message-/),
      deliver: false,
    })
    expect(body.success).toBe(true)
  })

  it('falls back to live main session when the agent session key is stale', async () => {
    // validateBody is mocked in beforeEach and ignores the real request body.
    // Override it here so the assertion matches this scenario.
    validateBody.mockResolvedValueOnce({ data: { to: 'worker', message: 'fallback ping' } })

    const listSessions = vi.fn().mockResolvedValue([
      {
        key: 'agent:main:main',
        agent: 'main',
        sessionId: 'sess-main',
        updatedAt: 456,
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
    const sendMessage = vi.fn().mockResolvedValue({ status: 'accepted', runId: 'run-2', session: 'agent:main:main', raw: {} })
    getRuntimeProvider.mockReturnValue({ listSessions, sendMessage })

    const { POST } = await import('@/app/api/agents/message/route')
    const req = new NextRequest('http://localhost/api/agents/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ to: 'worker', message: 'fallback ping' }),
    })

    const response = await POST(req)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(sendMessage).toHaveBeenCalledWith({
      sessionKey: 'agent:main:main',
      message: 'Message from Tester: fallback ping',
      idempotencyKey: expect.stringMatching(/^direct-message-/),
      deliver: false,
    })
    expect(body.success).toBe(true)
  })
})
