import { requireN8nRole } from '@/lib/n8n'

export interface N8nWorkflowCapabilities {
  create: boolean
  update: boolean
  delete: boolean
  trigger: boolean
  saveLearningWindow: boolean
}

function allowed(request: Request, role: 'operator' | 'admin', expected: { workspaceId: number; tenantId: number }) {
  const result = requireN8nRole(request, role)
  return !('error' in result) && result.user.workspace_id === expected.workspaceId && result.user.tenant_id === expected.tenantId
}

export function n8nWorkflowCapabilities(request: Request, scope: { workspaceId: number; tenantId: number }) {
  const operator = allowed(request, 'operator', scope)
  // Probe the exact existing authority with the same host/forwarding headers.
  // This only asks permission; it never invokes a mutation or creates identity.
  const probe = (path: string, method: string) => new Request(new URL(path, request.url), {
    method, headers: request.headers,
  })
  const capabilities: N8nWorkflowCapabilities = {
    create: operator, update: operator, delete: allowed(request, 'admin', scope),
    trigger: allowed(probe('/api/n8n/trigger', 'POST'), 'operator', scope),
    saveLearningWindow: allowed(probe('/api/n8n/workflows/learning-window', 'PUT'), 'operator', scope),
  }
  return { capabilities, allowedActions: Object.entries(capabilities).filter(([, value]) => value).map(([key]) => key) }
}
