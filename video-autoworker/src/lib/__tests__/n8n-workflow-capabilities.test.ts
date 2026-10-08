// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { isOpenClawN8nOperatorRequest } from '@/lib/openclaw-loopback-auth'

const auth = vi.hoisted(() => ({ role: vi.fn() }))
vi.mock('@/lib/n8n', () => ({ requireN8nRole: auth.role }))
import { n8nWorkflowCapabilities } from '@/lib/n8n-workflow-capabilities'

const scope = { tenantId: 3, workspaceId: 2 }
beforeEach(() => {
  vi.stubEnv('MC_AUTH_MODE', 'openclaw-loopback')
  auth.role.mockImplementation((request: Request, minimum: string) => minimum === 'operator' && isOpenClawN8nOperatorRequest(request)
    ? { user: { id: 0, tenant_id: 3, workspace_id: 2 } } : { error: 'permission_denied', status: 403 })
})
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

it('declares exact narrow loopback actions without inventing broad CRUD permission', () => {
  const result = n8nWorkflowCapabilities(new Request('http://127.0.0.1:3017/api/n8n/workflows'), scope)
  expect(result.capabilities).toEqual({ create: false, update: false, delete: false, trigger: true, saveLearningWindow: true })
  expect(result.allowedActions).toEqual(['trigger', 'saveLearningWindow'])
})

it('retains forwarding/host safety and denies a different scope', () => {
  const forwarded = n8nWorkflowCapabilities(new Request('http://127.0.0.1:3017/api/n8n/workflows', {
    headers: { 'x-forwarded-host': 'outside.example' },
  }), scope)
  expect(Object.values(forwarded.capabilities).some(Boolean)).toBe(false)
  expect(n8nWorkflowCapabilities(new Request('http://127.0.0.1:3017/api/n8n/workflows'), { ...scope, tenantId: 99 }).allowedActions).toEqual([])
})

it('derives broad operator rights only from the existing role authority', () => {
  auth.role.mockReturnValue({ user: { id: 4, tenant_id: 3, workspace_id: 2 } })
  expect(n8nWorkflowCapabilities(new Request('https://app.example/api/n8n/workflows'), scope).capabilities)
    .toEqual({ create: true, update: true, delete: true, trigger: true, saveLearningWindow: true })
})
