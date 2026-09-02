import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  allQueue: [] as unknown[][],
  credentialStatus: vi.fn(),
  exec: vi.fn(),
  gateway: undefined as Record<string, unknown> | undefined,
  prepare: vi.fn(),
  runs: [] as Array<{ sql: string; args: unknown[] }>,
}))

vi.mock('@/lib/auth', () => ({
  requireRole: vi.fn(() => ({ user: {
    id: 0, username: 'test', role: 'admin', workspace_id: 1, tenant_id: 1,
  } })),
}))

vi.mock('@/lib/gateway-runtime', () => ({
  getDetectedGatewayPort: vi.fn(() => 18789),
  getDetectedGatewayCredentialStatus: mocks.credentialStatus,
}))

vi.mock('@/lib/tailscale-serve', () => ({
  isTailscaleServe: vi.fn(() => false),
  refreshTailscaleCache: vi.fn(),
  getCachedTailscaleWeb: vi.fn(() => null),
  hasGwPathHandler: vi.fn(() => false),
  findTailscaleServePort: vi.fn(() => null),
}))

vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(() => ({ exec: mocks.exec, prepare: mocks.prepare })),
}))

import { GET } from '@/app/api/gateways/route'
import { POST as connectGateway } from '@/app/api/gateways/connect/route'

function gateway(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, name: 'primary', host: '127.0.0.1', port: 18789,
    token: '', is_primary: 1, status: 'unknown', last_seen: null,
    latency: null, sessions_count: 0, agents_count: 0,
    created_at: 1, updated_at: 1, ...overrides,
  }
}

describe('gateway credential boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.allQueue = []
    mocks.gateway = undefined
    mocks.runs = []
    mocks.credentialStatus.mockReturnValue({ configured: true, source: 'exec-reference' })
    mocks.prepare.mockImplementation((sql: string) => ({
      all: () => mocks.allQueue.shift() || [],
      get: () => mocks.gateway,
      run: (...args: unknown[]) => {
        mocks.runs.push({ sql, args })
        return { changes: 1, lastInsertRowid: 1 }
      },
    }))
  })

  it('seeds the primary gateway without persisting the detected credential', async () => {
    mocks.allQueue = [[], [gateway()]]
    const response = await GET(new NextRequest('http://127.0.0.1:3017/api/gateways'))
    const body = await response.json()

    const insert = mocks.runs.find(entry => entry.sql.includes('INSERT INTO gateways'))
    expect(insert?.args).toEqual(['primary', '127.0.0.1', 18789, ''])
    expect(body.gateways[0]).toMatchObject({
      token_set: true, credential_source: 'exec-reference', server_managed: true,
    })
    expect(body.gateways[0]).not.toHaveProperty('token')
    expect(JSON.stringify(body)).not.toContain('a'.repeat(64))
  })

  it('redacts a stale primary SQLite token without making GET mutate the database', async () => {
    const stale = 's'.repeat(64)
    mocks.allQueue = [[gateway({ token: stale })]]
    const response = await GET(new NextRequest('http://127.0.0.1:3017/api/gateways'))
    const body = await response.json()

    expect(mocks.runs).toEqual([])
    expect(mocks.prepare.mock.calls
      .map(([sql]) => String(sql))
      .filter(sql => /^SELECT\s/iu.test(sql.trim()))
      .every(sql => !/\btoken\b/iu.test(sql))).toBe(true)
    expect(JSON.stringify(body)).not.toContain(stale)
    expect(body.gateways[0]).not.toHaveProperty('token')
  })

  it('never returns or rewrites the primary credential from connect', async () => {
    const stale = 'z'.repeat(64)
    mocks.gateway = gateway({ token: stale })
    const response = await connectGateway(new NextRequest(
      'http://127.0.0.1:3017/api/gateways/connect', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 1 }),
      },
    ))
    const body = await response.json()

    expect(body).toMatchObject({
      id: 1, token_set: true, credential_source: 'exec-reference', server_managed: true,
    })
    expect(body).not.toHaveProperty('token')
    expect(JSON.stringify(body)).not.toContain(stale)
    expect(mocks.runs).toEqual([])
    expect(mocks.prepare.mock.calls
      .map(([sql]) => String(sql))
      .filter(sql => /^SELECT\s/iu.test(sql.trim()))
      .every(sql => !/\btoken\b/iu.test(sql))).toBe(true)
  })

  it('strips credentials from an explicitly configured browser URL', async () => {
    const previous = process.env.NEXT_PUBLIC_GATEWAY_URL
    process.env.NEXT_PUBLIC_GATEWAY_URL = 'wss://gateway.example.com/gateway-ws?token=browser-secret&foo=bar'
    try {
      mocks.gateway = gateway()
      const response = await connectGateway(new NextRequest(
        'http://127.0.0.1:3017/api/gateways/connect', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: 1 }),
        },
      ))
      const body = await response.json()
      expect(body.ws_url).toBe('wss://gateway.example.com/gateway-ws')
      expect(JSON.stringify(body)).not.toContain('browser-secret')
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_GATEWAY_URL
      else process.env.NEXT_PUBLIC_GATEWAY_URL = previous
    }
  })
})
