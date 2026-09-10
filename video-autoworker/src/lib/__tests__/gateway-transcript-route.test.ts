import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireRole = vi.fn()
const getRuntimeProvider = vi.fn()
const getSessionHistory = vi.fn()
const loggerWarn = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/runtime-provider', () => ({ getRuntimeProvider }))
vi.mock('@/lib/logger', () => ({ logger: { warn: loggerWarn } }))

describe('/api/sessions/transcript/gateway route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    requireRole.mockReturnValue({ user: { id: 1, username: 'viewer', workspace_id: 1 } })
    getRuntimeProvider.mockReturnValue({ getSessionHistory })
  })

  it('reads normalized history through the selected runtime provider', async () => {
    getSessionHistory.mockResolvedValue({
      messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'ready' }] }],
    })

    const { GET } = await import('@/app/api/sessions/transcript/gateway/route')
    const response = await GET(new NextRequest('http://localhost/api/sessions/transcript/gateway?key=agent:jarv:main&limit=50'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(getSessionHistory).toHaveBeenCalledWith('agent:jarv:main', { limit: 50 })
    expect(body).toEqual({
      messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'ready' }] }],
      source: 'runtime',
    })
  })

  it('returns a clear unavailable error without reading a platform store', async () => {
    getSessionHistory.mockRejectedValue(new Error('gateway unavailable'))

    const { GET } = await import('@/app/api/sessions/transcript/gateway/route')
    const response = await GET(new NextRequest('http://localhost/api/sessions/transcript/gateway?key=agent:missing:main'))
    const body = await response.json()

    expect(response.status).toBe(503)
    expect(body).toEqual({
      messages: [],
      source: 'runtime',
      error: 'Runtime session history unavailable',
    })
  })
})
