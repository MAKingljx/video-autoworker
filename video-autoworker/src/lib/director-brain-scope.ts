export type DirectorBrainScope = {
  tenantId: number
  workspaceId: number
}

function requiredPositiveInteger(name: string): number {
  const raw = process.env[name]
  if (!raw || !/^[1-9]\d*$/u.test(raw)) throw new Error('director_brain_scope_invalid')
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) throw new Error('director_brain_scope_invalid')
  return value
}

export function getDirectorBrainScope(): DirectorBrainScope {
  return {
    tenantId: requiredPositiveInteger('MC_OPENCLAW_TENANT_ID'),
    workspaceId: requiredPositiveInteger('MC_OPENCLAW_WORKSPACE_ID'),
  }
}

export function isDirectorBrainScope(scope: DirectorBrainScope): boolean {
  const configured = getDirectorBrainScope()
  return scope.tenantId === configured.tenantId
    && scope.workspaceId === configured.workspaceId
}

export function assertDirectorBrainScope(scope: DirectorBrainScope): void {
  if (!isDirectorBrainScope(scope)) throw new Error('director_brain_scope_forbidden')
}
