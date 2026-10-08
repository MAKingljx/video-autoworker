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
  phase: 'inspect' | 'create_timeline' | 'duplicate_timeline' | 'edit' | 'verify' | 'subtitles' | 'import_media' | 'queue_render' | 'start_render'
  stepId: string
  payloadSha256: string
  status: ResolveOperationStatus
  executorNodeId: string
  resolveVersion: string
  timelineUniqueId?: string
  timelineFingerprint?: string
  executorProcessIdentity?: string
  result?: Record<string, unknown>
  errorCode?: string
}

export type ResolveExecutorSnapshot = ResolveCapabilitySnapshot & {
  processIdentity: string
  currentProjectFingerprint?: string
  currentTimelineFingerprint?: string
  activeOperationId?: string
  timelineName?: string
  projectName?: string
  timelineSettings?: Record<string, unknown>
  timelineContent?: Record<string, unknown>
  renderPresets?: string[]
  projectSettings?: Record<string, unknown>
}

export type ResolveExecutorResult = {
  status: Exclude<ResolveOperationStatus, 'pending'>
  operationId: string
  result?: Record<string, unknown>
  errorCode?: string
}

export type ResolveExecutorTransport = {
  inspect(): Promise<ResolveExecutorSnapshot>
  apply(operation: ResolveExecutorOperation, plan: EditPlan): Promise<{ result: Record<string, unknown>; status?: 'succeeded' | 'running' | 'unknown' }>
  /** Read Resolve state for this exact operation. Never performs a write. */
  reconcile(operation: ResolveExecutorOperation, plan: EditPlan): Promise<ResolveExecutorResult>
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
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>
      return '{' + Object.keys(record).sort().map(key => JSON.stringify(key) + ':' + canonical(record[key])).join(',') + '}'
    }
    return JSON.stringify(value) ?? 'null'
  }
  return createHash('sha256').update(canonical(payload)).digest('hex')
}

/** Single payload contract shared by task admission and device execution. */
export function resolveOperationPayload(plan: EditPlan, operation: Pick<ResolveExecutorOperation, 'phase' | 'stepId'>) {
  if (operation.phase === 'duplicate_timeline' || operation.phase === 'create_timeline') return plan.base
  if (['queue_render', 'start_render', 'verify', 'subtitles'].includes(operation.phase)) return plan.output
  if (operation.phase === 'edit') {
    const clips = plan.clips.filter(clip => clip.itemId === operation.stepId)
    if (clips.length !== 1) throw new Error('resolve_clip_reference_ambiguous')
    return clips[0]
  }
  if (operation.phase === 'import_media') {
    const refs = plan.clips.filter(clip => clip.asset.assetId === operation.stepId).map(clip => clip.asset)
    if (!refs.length || refs.some(asset => operationPayloadSha256(asset) !== operationPayloadSha256(refs[0]))) {
      throw new Error('resolve_asset_reference_ambiguous')
    }
    return refs[0]
  }
  throw new Error('resolve_operation_unsupported')
}

export function preflightResolveExecutor(planValue: unknown, snapshot: ResolveExecutorSnapshot): EditPlanPreflight {
  const plan = assertEditPlanIntegrity(planValue)
  const result = preflightEditPlan(plan, snapshot)
  if (!result.ok) return result
  if (!snapshot.processIdentity.startsWith(snapshot.nodeId + ':resolve:') || !/:[0-9a-f]{64}$/u.test(snapshot.processIdentity)) {
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
  if (plan.status !== 'approved') {
    return { status: 'failed', operationId: operation.operationId, errorCode: 'edit_plan_not_approved' }
  }
  if (operation.planId !== plan.planId || operation.planRevision !== plan.revision) {
    return { status: 'failed', operationId: operation.operationId, errorCode: 'edit_plan_revision_mismatch' }
  }
  if (operation.operationId !== resolveOperationId(plan, operation.taskId, operation.phase, operation.stepId)
    || operation.executorNodeId !== plan.base.editorNodeId
    || operation.resolveVersion !== plan.base.resolveVersion) {
    return { status: 'failed', operationId: operation.operationId, errorCode: 'resolve_operation_identity_mismatch' }
  }
  let payload: ReturnType<typeof resolveOperationPayload>
  try {
    payload = resolveOperationPayload(plan, operation)
  } catch (error) {
    return { status: 'failed', operationId: operation.operationId,
      errorCode: error instanceof Error ? error.message : 'resolve_operation_unsupported' }
  }
  if (operation.payloadSha256 !== operationPayloadSha256(payload)) {
    return { status: 'failed', operationId: operation.operationId, errorCode: 'resolve_operation_payload_mismatch' }
  }
  if (operation.status === 'succeeded' || operation.status === 'failed' || operation.status === 'cancelled') {
    return { status: operation.status, operationId: operation.operationId, result: operation.result, errorCode: operation.errorCode }
  }
  // A previous call may have written to Resolve before losing its response.
  // Only readback can settle it; an unknown/running operation must not be replayed.
  if (operation.status === 'unknown' || operation.status === 'running') {
    return reconcileResolveOperation(operation, plan, transport)
  }
  // A name alone is not ownership. The device adapter also verifies its
  // duplicate receipt and the unchanged source before any copy mutation.
  if (!['duplicate_timeline', 'create_timeline'].includes(operation.phase) && (!operation.timelineUniqueId
    || operation.timelineUniqueId === plan.base.timelineUniqueId || !operation.timelineFingerprint)) {
    return { status: 'failed', operationId: operation.operationId, errorCode: 'resolve_copy_binding_required' }
  }
  let snapshot: ResolveExecutorSnapshot
  try {
    snapshot = await transport.inspect()
  } catch (error) {
    const code = error instanceof Error && /^resolve_[a-z0-9_]+$/u.test(error.message) ? error.message : 'resolve_inspect_unavailable'
    return { status: 'unknown', operationId: operation.operationId, errorCode: code }
  }
  const preflight = operation.phase === 'duplicate_timeline'
    ? preflightResolveExecutor(plan, snapshot)
    : preflightResolveExecutor(plan, { ...snapshot, timelineUniqueId: plan.base.timelineUniqueId, currentTimelineFingerprint: undefined })
  if (!preflight.ok) return { status: 'failed', operationId: operation.operationId, errorCode: preflight.code || 'resolve_preflight_failed' }
  if (snapshot.activeOperationId === operation.operationId) {
    return reconcileResolveOperation(operation, plan, transport)
  }
  if (snapshot.activeOperationId) {
    return { status: 'unknown', operationId: operation.operationId, errorCode: 'resolve_executor_busy' }
  }
  try {
    const applied = await transport.apply({ ...operation, status: 'running', executorProcessIdentity: snapshot.processIdentity }, plan)
    return { status: applied.status || 'succeeded', operationId: operation.operationId, result: applied.result }
  } catch (error) {
    return {
      status: error instanceof ResolveExecutorRejected ? 'failed' : 'unknown',
      operationId: operation.operationId,
      errorCode: error instanceof Error && error.message ? error.message : 'resolve_operation_outcome_unknown',
    }
  }
}

async function reconcileResolveOperation(
  operation: ResolveExecutorOperation,
  plan: EditPlan,
  transport: ResolveExecutorTransport,
): Promise<ResolveExecutorResult> {
  try {
    const readback = await transport.reconcile(operation, plan)
    if (readback.operationId !== operation.operationId) {
      return { status: 'unknown', operationId: operation.operationId, errorCode: 'resolve_reconcile_identity_mismatch' }
    }
    return readback
  } catch {
    return { status: 'unknown', operationId: operation.operationId, errorCode: 'resolve_reconcile_unavailable' }
  }
}

/** The adapter rejected the request before crossing a write boundary. */
export class ResolveExecutorRejected extends Error {}
