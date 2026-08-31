import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getLocalDesktopUserFromRequest: vi.fn(),
  requireRole: vi.fn(),
  getDefaultWorkspaceContext: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({
  getLocalDesktopUserFromRequest: mocks.getLocalDesktopUserFromRequest,
  requireRole: mocks.requireRole,
  getDefaultWorkspaceContext: mocks.getDefaultWorkspaceContext,
}))

import {
  getN8nGlobalReleaseAccess,
  requireN8nGlobalReleaseManager,
} from '@/lib/n8n-global-release-auth'

const request = new Request('http://127.0.0.1:3017/api/n8n/intake-control')

function identity(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    username: 'user',
    display_name: 'User',
    role: 'admin',
    workspace_id: 1,
    tenant_id: 1,
    created_at: 0,
    updated_at: 0,
    last_login_at: null,
    ...overrides,
  }
}

describe('n8n global release authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getLocalDesktopUserFromRequest.mockReturnValue(null)
    mocks.getDefaultWorkspaceContext.mockReturnValue({ workspaceId: 1, tenantId: 1 })
    mocks.requireRole.mockReturnValue({ user: identity() })
  })

  it('allows the trusted local desktop without consulting normal role auth', () => {
    const desktop = identity({ id: 0, username: 'local-desktop', role: 'viewer' })
    mocks.getLocalDesktopUserFromRequest.mockReturnValue(desktop)
    expect(getN8nGlobalReleaseAccess(request)).toEqual({ user: desktop, canManage: true })
    expect(mocks.requireRole).not.toHaveBeenCalled()
  })

  it('allows the id=0 global API key identity', () => {
    const api = identity({ id: 0, username: 'api', role: 'admin' })
    mocks.requireRole.mockReturnValue({ user: api })
    expect(getN8nGlobalReleaseAccess(request)).toEqual({ user: api, canManage: true })
  })

  it('allows a normal admin only in the default owner tenant and workspace', () => {
    const ownerAdmin = identity({ id: 12, role: 'admin', workspace_id: 1, tenant_id: 1 })
    mocks.requireRole.mockReturnValue({ user: ownerAdmin })
    expect(requireN8nGlobalReleaseManager(request)).toEqual({ user: ownerAdmin })

    for (const tenantAdmin of [
      identity({ id: 13, role: 'admin', workspace_id: 2, tenant_id: 1 }),
      identity({ id: 14, role: 'admin', workspace_id: 1, tenant_id: 2 }),
    ]) {
      mocks.requireRole.mockReturnValue({ user: tenantAdmin })
      expect(getN8nGlobalReleaseAccess(request)).toEqual({ user: tenantAdmin, canManage: false })
      expect(requireN8nGlobalReleaseManager(request)).toEqual({
        error: 'Global release administrator required',
        status: 403,
      })
    }
  })

  it('rejects negative agent-scoped admins before considering owner scope', () => {
    const agentAdmin = identity({ id: -7, role: 'admin', workspace_id: 1, tenant_id: 1 })
    mocks.requireRole.mockReturnValue({ user: agentAdmin })
    expect(getN8nGlobalReleaseAccess(request)).toEqual({ user: agentAdmin, canManage: false })
    expect(requireN8nGlobalReleaseManager(request)).toEqual({
      error: 'Global release administrator required',
      status: 403,
    })
  })

  it.each(['viewer', 'operator'] as const)('keeps an owner-scope %s read-only', role => {
    const user = identity({ id: 15, role })
    mocks.requireRole.mockReturnValue({ user })
    expect(getN8nGlobalReleaseAccess(request)).toEqual({ user, canManage: false })
  })

  it('preserves authentication failures', () => {
    mocks.requireRole.mockReturnValue({ error: 'Authentication required', status: 401 })
    expect(getN8nGlobalReleaseAccess(request)).toEqual({
      error: 'Authentication required',
      status: 401,
    })
  })
})
