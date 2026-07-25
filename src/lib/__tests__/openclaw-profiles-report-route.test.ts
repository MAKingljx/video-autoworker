import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  generateProfilesAcceptanceReport: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  requireRole: mocks.requireRole,
}))

vi.mock('@/lib/openclaw-profiles', () => ({
  generateProfilesAcceptanceReport: mocks.generateProfilesAcceptanceReport,
}))

import { GET } from '@/app/api/openclaw/profiles/report/route'

describe('OpenClaw profiles acceptance report route', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.MC_DESKTOP_MODE
    delete process.env.MC_OPENCLAW_PROFILES_NO_AUTH
    mocks.requireRole.mockReset()
    mocks.generateProfilesAcceptanceReport.mockReset()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('allows a loopback desktop request and disables response caching', async () => {
    process.env.MC_DESKTOP_MODE = '1'
    const report = { generatedAt: '2026-07-25T00:00:00.000Z', profiles: [] }
    mocks.generateProfilesAcceptanceReport.mockResolvedValue(report)

    const response = await GET(new NextRequest('http://127.0.0.1:3017/api/openclaw/profiles/report'))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ report })
    expect(mocks.requireRole).not.toHaveBeenCalled()
  })

  it('does not extend the desktop bypass to a non-loopback host', async () => {
    process.env.MC_OPENCLAW_PROFILES_NO_AUTH = '1'
    mocks.requireRole.mockReturnValue({ error: 'Authentication required', status: 401 })

    const response = await GET(new NextRequest('https://app.example.com/api/openclaw/profiles/report'))

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: 'Authentication required' })
    expect(mocks.requireRole).toHaveBeenCalledWith(expect.any(NextRequest), 'viewer')
    expect(mocks.generateProfilesAcceptanceReport).not.toHaveBeenCalled()
  })

  it('returns a gateway error when report generation fails', async () => {
    mocks.requireRole.mockReturnValue({ user: { username: 'viewer' } })
    mocks.generateProfilesAcceptanceReport.mockRejectedValue(new Error('远程验收命令失败'))

    const response = await GET(new NextRequest('https://app.example.com/api/openclaw/profiles/report'))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: '远程验收命令失败' })
  })
})
