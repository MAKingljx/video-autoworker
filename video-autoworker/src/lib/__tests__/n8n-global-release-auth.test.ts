import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getDefaultWorkspaceContext: vi.fn(),
  getLocalDesktopUserFromRequest: vi.fn(),
  getOpenClawN8nGlobalReleaseUser: vi.fn(),
  isOpenClawLoopbackAuthMode: vi.fn(),
  requireRole: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  getDefaultWorkspaceContext: mocks.getDefaultWorkspaceContext,
  getLocalDesktopUserFromRequest: mocks.getLocalDesktopUserFromRequest,
  getOpenClawN8nGlobalReleaseUser: mocks.getOpenClawN8nGlobalReleaseUser,
  requireRole: mocks.requireRole,
}))

vi.mock('@/lib/openclaw-loopback-auth', () => ({
  isOpenClawLoopbackAuthMode: mocks.isOpenClawLoopbackAuthMode,
}))

import {
  getN8nGlobalReleaseAccess,
  requireN8nGlobalReleaseManager,
} from '@/lib/n8n-global-release-auth'

const request = new Request('http://127.0.0.1:3017/api/n8n/intake-control')

function identity(overrides: Record<string, unknown> = {}) {
  return {
    id: 10, username: 'user', display_name: 'User', role: 'admin',
    workspace_id: 1, tenant_id: 1, created_at: 0, updated_at: 0,
    last_login_at: null, ...overrides,
  }
}

describe('n8n global release authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isOpenClawLoopbackAuthMode.mockReturnValue(false)
    mocks.getDefaultWorkspaceContext.mockReturnValue({ workspaceId: 1, tenantId: 1 })
    mocks.getLocalDesktopUserFromRequest.mockReturnValue(null)
    mocks.getOpenClawN8nGlobalReleaseUser.mockReturnValue(null)
    mocks.requireRole.mockReturnValue({ user: identity() })
  })

  it.each([
    ['viewer', false], ['operator', false], ['admin', true],
  ] as const)('preserves legacy owner-scope access for %s with canManage=%s', (role, canManage) => {
    const user = identity({ role })
    mocks.requireRole.mockReturnValue({ user })
    expect(getN8nGlobalReleaseAccess(request)).toEqual({ user, canManage })
    expect(mocks.requireRole).toHaveBeenCalledWith(request, 'viewer')
  })

  it('does not let a tenant admin or agent key manage a legacy global release', () => {
    const tenantAdmin = identity({ workspace_id: 9, tenant_id: 7 })
    mocks.requireRole.mockReturnValueOnce({ user: tenantAdmin })
    expect(getN8nGlobalReleaseAccess(request)).toEqual({ user: tenantAdmin, canManage: false })

    const agent = identity({ id: -7 })
    mocks.requireRole.mockReturnValueOnce({ user: agent })
    expect(getN8nGlobalReleaseAccess(request)).toEqual({ user: agent, canManage: false })
  })

  it('keeps legacy desktop and global-key identities as global managers', () => {
    const desktop = identity({ id: 0, username: 'local-desktop' })
    mocks.getLocalDesktopUserFromRequest.mockReturnValueOnce(desktop)
    expect(getN8nGlobalReleaseAccess(request)).toEqual({ user: desktop, canManage: true })

    const globalKey = identity({ id: 0, username: 'api' })
    mocks.requireRole.mockReturnValueOnce({ user: globalKey })
    expect(requireN8nGlobalReleaseManager(request)).toEqual({ user: globalKey })
  })

  it('uses only the exact controlled OpenClaw loopback release identity in production mode', () => {
    const internal = identity({ id: 0, username: 'openclaw-loopback:n8n-global-release' })
    mocks.isOpenClawLoopbackAuthMode.mockReturnValue(true)
    mocks.getOpenClawN8nGlobalReleaseUser.mockReturnValue(internal)
    expect(requireN8nGlobalReleaseManager(request)).toEqual({ user: internal })
    expect(mocks.requireRole).not.toHaveBeenCalled()
  })

  it('fails closed when production mode is not on an exact release-control route', () => {
    mocks.isOpenClawLoopbackAuthMode.mockReturnValue(true)
    expect(getN8nGlobalReleaseAccess(request)).toEqual({
      error: 'OpenClaw loopback release control required', status: 403,
    })
    expect(mocks.requireRole).not.toHaveBeenCalled()
  })

  it('preserves authentication failures and legacy manager denials', () => {
    mocks.requireRole.mockReturnValueOnce({ error: 'Authentication required', status: 401 })
    expect(getN8nGlobalReleaseAccess(request)).toEqual({ error: 'Authentication required', status: 401 })

    mocks.requireRole.mockReturnValueOnce({ user: identity({ role: 'viewer' }) })
    expect(requireN8nGlobalReleaseManager(request)).toEqual({
      error: 'Global release administrator required', status: 403,
    })
  })
})
