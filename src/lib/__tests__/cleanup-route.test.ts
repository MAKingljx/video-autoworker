import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireRole = vi.fn()
const heavyLimiter = vi.fn()
const getDatabase = vi.fn()
const logAuditEvent = vi.fn()
const getRuntimeProvider = vi.fn()
const countSessionsOlderThan = vi.fn()
const pruneSessionsOlderThan = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/rate-limit', () => ({ heavyLimiter }))
vi.mock('@/lib/db', () => ({ getDatabase, logAuditEvent }))
vi.mock('@/lib/runtime-provider', () => ({ getRuntimeProvider }))
vi.mock('@/lib/config', () => ({
  config: {
    retention: {
      activities: 7,
      auditLog: 30,
      notifications: 14,
      pipelineRuns: 3,
      tokenUsage: 0,
      gatewaySessions: 10,
    },
    tokensPath: '/tmp/tokens.json',
  },
}))

describe('/api/cleanup route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    requireRole.mockReturnValue({ user: { id: 1, username: 'admin', workspace_id: 1 } })
    heavyLimiter.mockReturnValue(null)
    getRuntimeProvider.mockReturnValue({
      sessionCapabilities: { bulkPrune: false },
      countSessionsOlderThan,
      pruneSessionsOlderThan,
    })
    getDatabase.mockReturnValue({
      prepare: vi.fn(() => ({
        get: vi.fn(() => ({ c: 0 })),
        run: vi.fn(() => ({ changes: 0 })),
      })),
    })
  })

  it('GET reports unsupported runtime session cleanup without reading storage', async () => {
    const { GET } = await import('@/app/api/cleanup/route')
    const response = await GET(new NextRequest('http://localhost/api/cleanup'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.preview).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table: 'Runtime Sessions',
        retention_days: 10,
        stale_count: null,
        note: 'Selected runtime does not support safe bulk session pruning',
      }),
    ]))
    expect(countSessionsOlderThan).not.toHaveBeenCalled()
  })

  it('POST fails closed before other cleanup when runtime bulk pruning is unavailable', async () => {
    const { POST } = await import('@/app/api/cleanup/route')
    const response = await POST(new NextRequest('http://localhost/api/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: false }),
    }))
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body.error).toMatch(/does not support safe bulk session pruning/u)
    expect(pruneSessionsOlderThan).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})
