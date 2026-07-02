import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireRole = vi.fn()
const mutationLimiter = vi.fn()
const syncClaudeSessions = vi.fn()
const scanCodexSessions = vi.fn()
const scanHermesSessions = vi.fn()
const getDatabase = vi.fn()
const logActivity = vi.fn()
const getRuntimeProvider = vi.fn()
const logger = { error: vi.fn(), warn: vi.fn() }

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter }))
vi.mock('@/lib/claude-sessions', () => ({ syncClaudeSessions }))
vi.mock('@/lib/codex-sessions', () => ({ scanCodexSessions }))
vi.mock('@/lib/hermes-sessions', () => ({ scanHermesSessions }))
vi.mock('@/lib/db', () => ({
  getDatabase,
  db_helpers: { logActivity },
}))
vi.mock('@/lib/runtime-provider', () => ({ getRuntimeProvider }))
vi.mock('@/lib/logger', () => ({ logger }))

describe('/api/sessions route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    requireRole.mockReturnValue({ user: { username: 'tester', role: 'operator', workspace_id: 1 } })
    mutationLimiter.mockReturnValue(null)
    syncClaudeSessions.mockResolvedValue(undefined)
    scanCodexSessions.mockReturnValue([])
    scanHermesSessions.mockReturnValue([])
    getRuntimeProvider.mockReturnValue({
      listSessions: vi.fn().mockResolvedValue([]),
      updateSessionConfig: vi.fn(),
      deleteSession: vi.fn(),
    })
    getDatabase.mockReturnValue({
      prepare: vi.fn(() => ({ all: vi.fn(() => []) })),
    })
  })

  it('POST delegates set-thinking to runtime provider config boundary', async () => {
    const updateSessionConfig = vi.fn().mockResolvedValue({ ok: true })
    getRuntimeProvider.mockReturnValue({ listSessions: vi.fn().mockResolvedValue([]), updateSessionConfig, deleteSession: vi.fn() })
    const { POST } = await import('@/app/api/sessions/route')

    const request = new NextRequest('http://localhost/api/sessions?action=set-thinking', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionKey: 'agent:main:main', level: 'high' }),
    })

    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(updateSessionConfig).toHaveBeenCalledWith('agent:main:main', { thinking: 'high' })
    expect(logActivity).toHaveBeenCalledWith(
      'session_control',
      'session',
      0,
      'tester',
      'Set thinking=high on agent:main:main',
      { session_key: 'agent:main:main', action: 'set-thinking' },
    )
    expect(body.success).toBe(true)
  })

  it('POST delegates set-label to runtime provider config boundary', async () => {
    const updateSessionConfig = vi.fn().mockResolvedValue({ ok: true })
    getRuntimeProvider.mockReturnValue({ listSessions: vi.fn().mockResolvedValue([]), updateSessionConfig, deleteSession: vi.fn() })
    const { POST } = await import('@/app/api/sessions/route')

    const request = new NextRequest('http://localhost/api/sessions?action=set-label', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionKey: 'agent:main:main', label: 'focus-room' }),
    })

    const response = await POST(request)

    expect(response.status).toBe(200)
    expect(updateSessionConfig).toHaveBeenCalledWith('agent:main:main', { label: 'focus-room' })
  })

  it('DELETE delegates session removal to runtime provider boundary', async () => {
    const deleteSession = vi.fn().mockResolvedValue({ ok: true })
    getRuntimeProvider.mockReturnValue({ updateSessionConfig: vi.fn(), deleteSession })
    const { DELETE } = await import('@/app/api/sessions/route')

    const request = new NextRequest('http://localhost/api/sessions', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionKey: 'agent:main:main' }),
    })

    const response = await DELETE(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(deleteSession).toHaveBeenCalledWith('agent:main:main')
    expect(body.success).toBe(true)
  })

  it('GET returns OpenClaw gateway sessions without exposing legacy local runtimes', async () => {
    getRuntimeProvider.mockReturnValue({
      listSessions: vi.fn().mockResolvedValue([
        {
          key: 'agent:main:main',
          agent: 'main',
          sessionId: 'sess-1',
          updatedAt: 1_000,
          chatType: 'chat',
          channel: 'cli',
          model: 'opus',
          totalTokens: 100,
          inputTokens: 40,
          outputTokens: 60,
          contextTokens: 1000,
          active: true,
        },
      ]),
      updateSessionConfig: vi.fn(),
      deleteSession: vi.fn(),
    })

    getDatabase.mockReturnValue({
      prepare: vi.fn(() => ({
        all: vi.fn(() => [
          {
            session_id: 'claude-1',
            project_slug: 'workspace-a',
            last_message_at: new Date(2_000).toISOString(),
            first_message_at: new Date(500).toISOString(),
            input_tokens: 10,
            output_tokens: 20,
            is_active: 0,
            model: 'claude-3',
            user_messages: 1,
            assistant_messages: 1,
            tool_uses: 0,
            estimated_cost: 0,
            last_user_prompt: 'hello',
            project_path: '/tmp/workspace-a',
          },
        ]),
      })),
    })
    const { GET } = await import('@/app/api/sessions/route')

    const request = new NextRequest('http://localhost/api/sessions', { method: 'GET' })
    const response = await GET(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.sessions).toHaveLength(1)
    expect(body.sessions[0]).toHaveProperty('source')
    expect(body.sessions.map((s: any) => s.id)).toEqual(['sess-1'])
    expect(syncClaudeSessions).not.toHaveBeenCalled()
  })
})
