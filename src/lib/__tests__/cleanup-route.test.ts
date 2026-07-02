import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const requireRole = vi.fn()
const heavyLimiter = vi.fn()
const getDatabase = vi.fn()
const logAuditEvent = vi.fn()
const countStaleGatewaySessions = vi.fn()
const pruneGatewaySessionsOlderThan = vi.fn()

vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/rate-limit', () => ({ heavyLimiter }))
vi.mock('@/lib/db', () => ({ getDatabase, logAuditEvent }))
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
vi.mock('@/lib/openclaw-session-source', () => ({ countStaleGatewaySessions, pruneGatewaySessionsOlderThan }))

describe('/api/cleanup route', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    requireRole.mockReturnValue({ user: { id: 1, username: 'admin', workspace_id: 1 } })
    heavyLimiter.mockReturnValue(null)
    countStaleGatewaySessions.mockReturnValue(2)
    pruneGatewaySessionsOlderThan.mockReturnValue({ deleted: 4, filesTouched: 1 })

    const prepare = vi.fn((sql: string) => {
      if (sql.includes('SELECT COUNT(*) as c')) {
        return { get: vi.fn(() => ({ c: 0 })) }
      }
      if (sql.startsWith('DELETE FROM')) {
        return { run: vi.fn(() => ({ changes: 0 })) }
      }
      throw new Error(`Unexpected SQL: ${sql}`)
    })

    getDatabase.mockReturnValue({ prepare })
  })

  it('GET previews gateway session cleanup through openclaw session source boundary', async () => {
    const { GET } = await import('@/app/api/cleanup/route')
    const request = new NextRequest('http://localhost/api/cleanup', { method: 'GET' })

    const response = await GET(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(countStaleGatewaySessions).toHaveBeenCalledWith(10)
    expect(body.preview).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'Gateway Session Store',
          retention_days: 10,
          stale_count: 2,
        }),
      ]),
    )
  })

  it('POST prunes gateway sessions through openclaw session source boundary', async () => {
    const { POST } = await import('@/app/api/cleanup/route')
    const request = new NextRequest('http://localhost/api/cleanup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dry_run: false }),
    })

    const response = await POST(request)
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(pruneGatewaySessionsOlderThan).toHaveBeenCalledWith(10)
    expect(body.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'Gateway Session Store',
          deleted: 4,
          retention_days: 10,
        }),
      ]),
    )
    expect(logAuditEvent).toHaveBeenCalled()
  })
})
