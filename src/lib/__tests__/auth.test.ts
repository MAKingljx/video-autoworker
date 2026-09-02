import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { safeCompare, requireRole } from '@/lib/auth'

// Mock dependencies that auth.ts imports
vi.mock('@/lib/db', () => ({
  getDatabase: vi.fn(),
}))

vi.mock('@/lib/password', () => ({
  hashPassword: vi.fn((p: string) => `hashed:${p}`),
  verifyPassword: vi.fn(() => false),
}))

// Prevent event-bus singleton side-effects
vi.mock('@/lib/event-bus', () => ({
  eventBus: { broadcast: vi.fn(), on: vi.fn(), emit: vi.fn() },
}))

describe('safeCompare', () => {
  it('returns true for matching strings', () => {
    expect(safeCompare('abc123', 'abc123')).toBe(true)
  })

  it('returns false for non-matching strings of same length', () => {
    expect(safeCompare('abc123', 'xyz789')).toBe(false)
  })

  it('returns false for different length strings', () => {
    expect(safeCompare('short', 'muchlonger')).toBe(false)
  })

  it('returns true for two empty strings', () => {
    expect(safeCompare('', '')).toBe(true)
  })

  it('returns false when one string is empty', () => {
    expect(safeCompare('', 'notempty')).toBe(false)
    expect(safeCompare('notempty', '')).toBe(false)
  })

  it('returns false for non-string inputs', () => {
    expect(safeCompare(null as any, 'a')).toBe(false)
    expect(safeCompare('a', undefined as any)).toBe(false)
  })
})

describe('requireRole', () => {
  const originalEnv = process.env

  beforeEach(() => {
    process.env = { ...originalEnv, API_KEY: 'test-api-key-secret' }
    delete process.env.MC_DESKTOP_MODE
    delete process.env.MC_AUTH_MODE
  })

  afterEach(() => {
    process.env = originalEnv
  })

  function makeRequest(headers: Record<string, string> = {}): Request {
    return new Request('http://localhost/api/test', {
      headers: new Headers(headers),
    })
  }

  it('returns 401 when no authentication is provided', () => {
    const result = requireRole(makeRequest(), 'viewer')
    expect(result.status).toBe(401)
    expect(result.error).toBe('Authentication required')
    expect(result.user).toBeUndefined()
  })

  it('treats the explicit loopback desktop identity as the local administrator', () => {
    process.env.MC_DESKTOP_MODE = '1'
    const result = requireRole(makeRequest(), 'admin')

    expect(result.user).toMatchObject({
      id: 0,
      username: 'local-desktop',
      role: 'admin',
    })
  })

  it('does not extend desktop identity to a non-loopback request', () => {
    process.env.MC_DESKTOP_MODE = '1'
    const result = requireRole(new Request('https://app.example.test/api/test'), 'viewer')

    expect(result).toMatchObject({ status: 401, error: 'Authentication required' })
  })

  it('returns 401 when API key is wrong', () => {
    const result = requireRole(
      makeRequest({ 'x-api-key': 'wrong-key' }),
      'viewer',
    )
    expect(result.status).toBe(401)
    expect(result.error).toBe('Authentication required')
  })

  it('returns user when API key is valid and role is sufficient', () => {
    const result = requireRole(
      makeRequest({ 'x-api-key': 'test-api-key-secret' }),
      'admin',
    )
    expect(result.status).toBeUndefined()
    expect(result.error).toBeUndefined()
    expect(result.user).toBeDefined()
    expect(result.user!.username).toBe('api')
    expect(result.user!.role).toBe('admin')
  })

  it('returns user for lower role requirement with API key (admin >= viewer)', () => {
    const result = requireRole(
      makeRequest({ 'x-api-key': 'test-api-key-secret' }),
      'viewer',
    )
    expect(result.user).toBeDefined()
    expect(result.user!.role).toBe('admin')
  })

  it('returns user for operator role requirement with API key (admin >= operator)', () => {
    const result = requireRole(
      makeRequest({ 'x-api-key': 'test-api-key-secret' }),
      'operator',
    )
    expect(result.user).toBeDefined()
  })

  it('accepts Authorization Bearer API key', () => {
    const result = requireRole(
      makeRequest({ authorization: 'Bearer test-api-key-secret' }),
      'admin',
    )
    expect(result.user).toBeDefined()
    expect(result.user!.username).toBe('api')
  })

  it('rejects API key auth when API_KEY is not configured', () => {
    process.env = { ...originalEnv, API_KEY: '' }
    const result = requireRole(
      makeRequest({ 'x-api-key': 'test-api-key-secret' }),
      'viewer',
    )
    expect(result.status).toBe(401)
    expect(result.user).toBeUndefined()
  })

  it('uses a fixed read-only identity and ignores every legacy credential in OpenClaw mode', () => {
    process.env.MC_AUTH_MODE = 'openclaw-loopback'
    process.env.MC_DESKTOP_MODE = '1'
    process.env.MC_PROXY_AUTH_HEADER = 'x-auth-user'
    process.env.MC_OPENCLAW_WORKSPACE_ID = '7'
    process.env.MC_OPENCLAW_TENANT_ID = '9'

    const request = makeRequest({
      'x-api-key': 'test-api-key-secret',
      'x-auth-user': 'administrator',
      cookie: '__Host-mc-session=legacy-session',
    })
    expect(requireRole(request, 'viewer').user).toMatchObject({
      username: 'openclaw-loopback',
      role: 'viewer',
      workspace_id: 7,
      tenant_id: 9,
    })
    expect(requireRole(request, 'admin')).toMatchObject({ status: 403 })
  })

  it('fails closed for non-loopback and HTTPS requests in OpenClaw mode', () => {
    process.env.MC_AUTH_MODE = 'openclaw-loopback'
    expect(requireRole(new Request('http://app.example.test/api/test', {
      headers: { 'x-api-key': 'test-api-key-secret' },
    }), 'viewer')).toMatchObject({ status: 401 })
    expect(requireRole(new Request('https://127.0.0.1/api/test'), 'viewer')).toMatchObject({ status: 401 })
  })
})
