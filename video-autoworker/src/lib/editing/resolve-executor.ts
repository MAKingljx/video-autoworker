import { createHash } from 'node:crypto'
import type { EditPlan, EditPlanPreflight, ResolveCapabilitySnapshot } from './edit-plan'
import { assertEditPlanIntegrity, preflightEditPlan, editPlanIdempotencyKey } from './edit-plan'

export type ResolveOperationStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'cancelled'

export type ResolveExecutorOperation = {
  operationId: string
  taskId: string
  planId: string
  planRevision: number
  phase: 'inspect' | 'duplicate_timeline' | 'edit' | 'preview' | 'render' | 'verify'
  stepId: string
  payloadSha256: string
  status: ResolveOperationStatus
  executorNodeId: string
  resolveVersion: string
  timelineUniqueId?: string
  result?: Record<string, unknown>
  errorCode?: string
}

export type ResolveExecutorSnapshot = ResolveCapabilitySnapshot & {
  processIdentity: string
  currentProjectFingerprint?: string
  currentTimelineFingerprint?: string
  activeOperationId?: string
}

export type ResolveExecutorResult = {
  status: Exclude<ResolveOperationStatus, 'pending' | 'running'>
  operationId: string
  result?: Record<string, unknown>
  errorCode?: string
}

export type ResolveExecutorTransport = {
  inspect(): Promise<ResolveExecutorSnapshot>
  apply(operation: ResolveExecutorOperation, plan: EditPlan): Promise<{ result: Record<string, unknown> }>
  cancel(operation: ResolveExecutorOperation): Promise<void>
}

export function resolveOperationId(
  plan: Pick<EditPlan, 'planId' | 'revision'>,
  taskId: string,
  phase: ResolveExecutorOperation['phase'],
  stepId: string,
): string {
  const key = editPlanIdempotencyKey(plan, phase, taskId + ':' + stepId)
  return key.replace('resolve-edit:', 'resolve-operation:')
}

export function operationPayloadSha256(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export function preflightResolveExecutor(planValue: unknown, snapshot: ResolveExecutorSnapshot): EditPlanPreflight {
  const plan = assertEditPlanIntegrity(planValue)
  const result = preflightEditPlan(plan, snapshot)
  if (!result.ok) return result
  if (snapshot.processIdentity !== snapshot.nodeId + ':resolve:' + snapshot.resolveVersion) {
    return { ok: false, code: 'resolve_process_identity_mismatch', warnings: result.warnings, requiredCapabilities: [] }
  }
  if (snapshot.currentProjectFingerprint && snapshot.currentProjectFingerprint !== plan.base.projectFingerprint) {
    return { ok: false, code: 'resolve_project_changed', warnings: result.warnings, requiredCapabilities: [] }
  }
  if (snapshot.currentTimelineFingerprint && plan.base.timelineFingerprint
    && snapshot.currentTimelineFingerprint !== plan.base.timelineFingerprint) {
    return { ok: false, code: 'resolve_timeline_changed', warnings: result.warnings, requiredCapabilities: [] }
  }
  return result
}

export async function executeResolveOperation(
  planValue: unknown,
  operation: ResolveExecutorOperation,
  transport: ResolveExecutorTransport,
): Promise<ResolveExecutorResult> {
  const plan = assertEditPlanIntegrity(planValue)
  if (operation.planId !== plan.planId || operation.planRevision !== plan.revision) {
    return { status: 'failed', operationId: operation.operationId, errorCode: 'edit_plan_revision_mismatch' }
  }
  const snapshot = await transport.inspect()
  const preflight = preflightResolveExecutor(plan, snapshot)
  if (!preflight.ok) return { status: 'failed', operationId: operation.operationId, errorCode: preflight.code || 'resolve_preflight_failed' }
  if (snapshot.activeOperationId && snapshot.activeOperationId !== operation.operationId) {
    return { status: 'unknown', operationId: operation.operationId, errorCode: 'resolve_executor_busy' }
  }
  try {
    const applied = await transport.apply({ ...operation, status: 'running' }, plan)
    return { status: 'succeeded', operationId: operation.operationId, result: applied.result }
  } catch (error) {
    return {
      status: 'unknown',
      operationId: operation.operationId,
      errorCode: error instanceof Error && error.message ? error.message : 'resolve_operation_outcome_unknown',
    }
  }
}
