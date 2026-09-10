import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireGlobalReleaseManager: vi.fn(),
  getDatabase: vi.fn(),
  resolveIdentity: vi.fn(),
  getDrainStatus: vi.fn(),
}))

vi.mock('@/lib/n8n-global-release-auth', () => ({
  requireN8nGlobalReleaseManager: mocks.requireGlobalReleaseManager,
}))
vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n-runtime-affinity', () => ({
  resolveN8nRuntimeIdentity: mocks.resolveIdentity,
  getN8nRuntimeDrainStatus: mocks.getDrainStatus,
}))

import { GET } from '@/app/api/n8n/drain-status/route'

const runtime = {
  callbackProtocol: 'slot-v1',
  runtimeSlot: 'blue',
  runtimeReleaseId: 'release-a',
  port: 3317,
  startedAt: 800,
}

function request() {
  return new NextRequest('http://127.0.0.1:3317/api/n8n/drain-status')
}

describe('n8n runtime drain status route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireGlobalReleaseManager.mockReturnValue({
      user: { id: 8, username: 'owner-admin', workspace_id: 1, tenant_id: 1 },
    })
    mocks.getDatabase.mockReturnValue({})
    mocks.resolveIdentity.mockReturnValue(runtime)
    mocks.getDrainStatus.mockReturnValue({
      schema: 'video-autoworker-runtime-drain/v1',
      globalScope: true,
      runtime,
      counts: { active: 0 },
      safeToRetire: true,
    })
  })

  it('returns the administrator-only process-wide retirement summary', async () => {
    const response = await GET(request())
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.requireGlobalReleaseManager).toHaveBeenCalledWith(expect.any(NextRequest))
    expect(mocks.getDrainStatus).toHaveBeenCalledWith({}, runtime)
    expect(await response.json()).toMatchObject({
      drain: {
        schema: 'video-autoworker-runtime-drain/v1',
        globalScope: true,
        safeToRetire: true,
      },
    })
  })

  it('rejects a tenant administrator before resolving runtime identity or reading the database', async () => {
    mocks.requireGlobalReleaseManager.mockReturnValue({ error: 'Global release administrator required', status: 403 })
    const response = await GET(request())
    expect(response.status).toBe(403)
    expect(mocks.resolveIdentity).not.toHaveBeenCalled()
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.getDrainStatus).not.toHaveBeenCalled()
  })

  it('rejects legacy single-process runtimes instead of guessing ownership', async () => {
    mocks.resolveIdentity.mockReturnValue(null)
    const response = await GET(request())
    expect(response.status).toBe(409)
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.getDrainStatus).not.toHaveBeenCalled()
  })

  it('fails closed for a malformed slot identity', async () => {
    mocks.resolveIdentity.mockImplementation(() => { throw new Error('release invalid') })
    const response = await GET(request())
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ error: 'release invalid' })
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })

  it('maps database and aggregation failures to a non-cacheable unavailable response', async () => {
    mocks.getDrainStatus.mockImplementation(() => { throw new Error('sensitive database detail') })
    const response = await GET(request())
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ error: '无法读取当前运行版本的退役状态' })
  })
})
