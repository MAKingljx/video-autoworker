import {
  getDefaultWorkspaceContext,
  getLocalDesktopUserFromRequest,
  getOpenClawN8nGlobalReleaseUser,
  requireRole,
  type User,
} from '@/lib/auth'
import { isOpenClawLoopbackAuthMode } from '@/lib/openclaw-loopback-auth'

type AuthError = { user?: never; error: string; status: 401 | 403 }
type GlobalReleaseAccess = { user: User; canManage: boolean; error?: never; status?: never }

/**
 * Authenticate a release-control reader and determine whether the identity may
 * operate process-wide n8n release controls.
 *
 * OpenClaw-only production permits only the exact loopback release-control
 * routes. Legacy deployments retain the original owner-workspace boundary.
 */
export function getN8nGlobalReleaseAccess(
  request: Request,
): GlobalReleaseAccess | AuthError {
  if (isOpenClawLoopbackAuthMode()) {
    const internal = getOpenClawN8nGlobalReleaseUser(request)
    if (!internal) return { error: 'OpenClaw loopback release control required', status: 403 }
    return { user: internal, canManage: true }
  }

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
