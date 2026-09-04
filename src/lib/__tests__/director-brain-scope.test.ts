import { afterEach, describe, expect, it } from 'vitest'
import {
  assertDirectorBrainScope,
  getDirectorBrainScope,
  isDirectorBrainScope,
} from '@/lib/director-brain-scope'

describe('director brain fixed scope', () => {
  const originalTenantId = process.env.MC_OPENCLAW_TENANT_ID
  const originalWorkspaceId = process.env.MC_OPENCLAW_WORKSPACE_ID

  afterEach(() => {
    if (originalTenantId === undefined) delete process.env.MC_OPENCLAW_TENANT_ID
    else process.env.MC_OPENCLAW_TENANT_ID = originalTenantId
    if (originalWorkspaceId === undefined) delete process.env.MC_OPENCLAW_WORKSPACE_ID
    else process.env.MC_OPENCLAW_WORKSPACE_ID = originalWorkspaceId
  })

  it('reads the one explicit OpenClaw tenant and workspace', () => {
    process.env.MC_OPENCLAW_TENANT_ID = '3'
    process.env.MC_OPENCLAW_WORKSPACE_ID = '2'

    expect(getDirectorBrainScope()).toEqual({ tenantId: 3, workspaceId: 2 })
    expect(isDirectorBrainScope({ tenantId: 3, workspaceId: 2 })).toBe(true)
    expect(isDirectorBrainScope({ tenantId: 4, workspaceId: 2 })).toBe(false)
    expect(() => assertDirectorBrainScope({ tenantId: 3, workspaceId: 9 }))
      .toThrow('director_brain_scope_forbidden')
  })

  it.each([
    [undefined, '2'],
    ['3', undefined],
    ['', '2'],
    ['0', '2'],
    ['-1', '2'],
    ['1.5', '2'],
    ['1e2', '2'],
    ['9007199254740992', '2'],
  ])('fails closed when the configured scope is invalid', (tenantId, workspaceId) => {
    if (tenantId === undefined) delete process.env.MC_OPENCLAW_TENANT_ID
    else process.env.MC_OPENCLAW_TENANT_ID = tenantId
    if (workspaceId === undefined) delete process.env.MC_OPENCLAW_WORKSPACE_ID
    else process.env.MC_OPENCLAW_WORKSPACE_ID = workspaceId

    expect(() => getDirectorBrainScope()).toThrow('director_brain_scope_invalid')
  })
})
