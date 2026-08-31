import {
  getDefaultWorkspaceContext,
  getLocalDesktopUserFromRequest,
  requireRole,
  type User,
} from '@/lib/auth'

type AuthError = { user?: never; error: string; status: 401 | 403 }
type GlobalReleaseAccess = { user: User; canManage: boolean; error?: never; status?: never }

/**
 * Authenticate a release-control reader and determine whether the identity may
 * operate process-wide n8n release controls.
 *
 * Tenant admins are deliberately not global admins. Only the trusted local
 * desktop, the global API key (id=0), or a normal admin in the default owner
 * tenant/workspace may inspect or mutate process-wide release state.
 */
export function getN8nGlobalReleaseAccess(
  request: Request,
): GlobalReleaseAccess | AuthError {
  const localDesktop = getLocalDesktopUserFromRequest(request)
  if (localDesktop) return { user: localDesktop, canManage: true }

  const auth = requireRole(request, 'viewer')
  if (auth.user === undefined) {
    return { error: auth.error, status: auth.status }
  }

  const { user } = auth
  if (user.id < 0) return { user, canManage: false }
  if (user.id === 0) return { user, canManage: true }

  const owner = getDefaultWorkspaceContext()
  return {
    user,
    canManage: user.role === 'admin'
      && user.workspace_id === owner.workspaceId
      && user.tenant_id === owner.tenantId,
  }
}

export function requireN8nGlobalReleaseManager(
  request: Request,
): { user: User; error?: never; status?: never } | AuthError {
  const access = getN8nGlobalReleaseAccess(request)
  if ('error' in access) return access
  if (!access.canManage) {
    return { error: 'Global release administrator required', status: 403 }
  }
  return { user: access.user }
}
