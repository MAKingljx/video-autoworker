import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  listSessions: vi.fn(),
  readFile: vi.fn(),
  rows: vi.fn(),
}))
vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }))
vi.mock('@/lib/runtime-provider', () => ({ getRuntimeProvider: () => ({ listSessions: mocks.listSessions }) }))
vi.mock('@/lib/config', () => ({ config: { tokensPath: '/synthetic/token-usage.json' }, ensureDirExists: vi.fn() }))
vi.mock('fs/promises', () => {
  const filesystem = { readFile: mocks.readFile, access: vi.fn(), writeFile: vi.fn() }
  return { ...filesystem, default: filesystem }
})
vi.mock('@/lib/db', () => ({ getDatabase: () => ({ prepare: () => ({ all: mocks.rows }) }) }))
vi.mock('@/lib/provider-subscriptions', () => ({
  getProviderSubscriptionFlags: () => ({}),
  getProviderFromModel: () => 'unknown',
}))
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }))

import { GET } from '@/app/api/tokens/route'

describe('recorded token usage during runtime outages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireRole.mockReturnValue({ user: { workspace_id: 1 } })
    mocks.rows.mockReturnValue([{ id: 1, model: 'synthetic-model', session_id: 'recorded:task', input_tokens: 20, output_tokens: 30, created_at: 1_788_854_000, workspace_id: 1 }])
    mocks.readFile.mockResolvedValue(JSON.stringify([{ id: 'file-1', model: 'synthetic-model', sessionId: 'file:task', inputTokens: 70, outputTokens: 30, totalTokens: 100, timestamp: 1_788_854_000_000, workspaceId: 1 }]))
    mocks.listSessions.mockRejectedValue(new Error('private runtime failure detail'))
  })

  it('preserves database and file usage and marks missing runtime usage explicitly', async () => {
    const response = await GET(new NextRequest('http://localhost/api/tokens?action=stats'))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({ runtimeSessionsAvailable: false, summary: { totalTokens: 150, requestCount: 2 } })
    expect(body.agents.recorded.totalTokens).toBe(50)
    expect(body.agents.file.totalTokens).toBe(100)
    expect(JSON.stringify(body)).not.toContain('private runtime failure detail')
  })

  it('merges normalized runtime usage when the selected provider is available', async () => {
    mocks.listSessions.mockResolvedValue([{ key: 'opaque-reference', agent: 'runtime', chatType: 'direct', model: 'synthetic-model', inputTokens: 10, outputTokens: 15, updatedAt: 1_788_854_000_000 }])
    const response = await GET(new NextRequest('http://localhost/api/tokens?action=stats'))
    expect(await response.json()).toMatchObject({ runtimeSessionsAvailable: true, summary: { totalTokens: 175, requestCount: 3 }, agents: { runtime: { totalTokens: 25 } } })
  })

  it.each(['json', 'csv'])('labels a %s export that lacks runtime usage', async (format) => {
    const response = await GET(new NextRequest(`http://localhost/api/tokens?action=export&format=${format}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('x-mc-runtime-sessions-available')).toBe('false')
    expect(response.headers.get('content-disposition')).toContain(`-partial.${format}`)
    if (format === 'json') expect(await response.json()).toMatchObject({ runtimeSessionsAvailable: false, summary: { totalTokens: 150 } })
    else expect(await response.text()).toContain('recorded:task')
  })

  it('rejects unauthenticated callers before reading the provider', async () => {
    mocks.requireRole.mockReturnValue({ error: 'Unauthorized', status: 401 })
    const response = await GET(new NextRequest('http://localhost/api/tokens?action=stats'))
    expect(response.status).toBe(401)
    expect(mocks.listSessions).not.toHaveBeenCalled()
  })
})
