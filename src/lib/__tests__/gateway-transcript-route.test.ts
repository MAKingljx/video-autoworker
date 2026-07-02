import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireRole = vi.fn()
const callOpenClawGateway = vi.fn()
const parseGatewayHistoryTranscript = vi.fn()
const parseJsonlTranscript = vi.fn()
const getGatewaySessionByKey = vi.fn()
const getGatewayTranscriptPath = vi.fn()
const loggerWarn = vi.fn()
const existsSync = vi.fn()
const readFileSync = vi.fn()

vi.mock('node:fs', () => ({
  default: { existsSync, readFileSync },
  existsSync,
  readFileSync,
}))
vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/openclaw-gateway', () => ({ callOpenClawGateway }))
vi.mock('@/lib/transcript-parser', () => ({ parseGatewayHistoryTranscript, parseJsonlTranscript }))
vi.mock('@/lib/openclaw-session-source', () => ({ getGatewaySessionByKey, getGatewayTranscriptPath }))
vi.mock('@/lib/logger', () => ({ logger: { warn: loggerWarn } }))

describe('/api/sessions/transcript/gateway route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    requireRole.mockReturnValue({ user: { id: 1, username: 'viewer', workspace_id: 1 } })
    callOpenClawGateway.mockRejectedValue(new Error('rpc unavailable'))
    parseGatewayHistoryTranscript.mockReturnValue([])
    parseJsonlTranscript.mockReturnValue([{ role: 'assistant', content: 'hi' }])
    getGatewaySessionByKey.mockReturnValue({
      key: 'agent:jarv:main',
      agent: 'jarv',
      sessionId: 'sess-123',
    })
    getGatewayTranscriptPath.mockReturnValue('/virtual/agents/jarv/sessions/sess-123.jsonl')
  })

  it('falls back to openclaw session source helpers for disk transcript lookup', async () => {
    existsSync.mockImplementation((target: any) => String(target) === '/virtual/agents/jarv/sessions/sess-123.jsonl')
    readFileSync.mockImplementation((target: any) => {
      if (String(target) === '/virtual/agents/jarv/sessions/sess-123.jsonl') return '{"type":"message"}\n'
      throw new Error(`Unexpected read: ${String(target)}`)
    })

    const { GET } = await import('@/app/api/sessions/transcript/gateway/route')
    const response = await GET(new NextRequest('http://localhost/api/sessions/transcript/gateway?key=agent:jarv:main&limit=50'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(getGatewaySessionByKey).toHaveBeenCalledWith('agent:jarv:main')
    expect(getGatewayTranscriptPath).toHaveBeenCalledWith(expect.objectContaining({ key: 'agent:jarv:main', agent: 'jarv' }))
    expect(parseJsonlTranscript).toHaveBeenCalledWith('{"type":"message"}\n', 50)
    expect(body).toEqual({ messages: [{ role: 'assistant', content: 'hi' }], source: 'gateway' })
  })

  it('returns session-not-found when source boundary cannot resolve the session key', async () => {
    getGatewaySessionByKey.mockReturnValue(null)

    const { GET } = await import('@/app/api/sessions/transcript/gateway/route')
    const response = await GET(new NextRequest('http://localhost/api/sessions/transcript/gateway?key=agent:missing:main'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({ messages: [], source: 'gateway', error: 'Session not found in sessions.json' })
    expect(getGatewayTranscriptPath).not.toHaveBeenCalled()
  })
})
