import type Database from 'better-sqlite3'
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { inspectScopedN8nVideoRecoveryState, inspectScopedN8nVideoSegmentRepairState,
  requeueScopedN8nVideoTaskRun, requeueScopedN8nVideoSegmentRepair, type N8nTaskRun, type N8nTaskScope } from '@/lib/n8n-task-runs'
import { inspectPreparedRecoveryEvidence } from '@/lib/n8n-prepared-evidence'
import { checkN8nCallbackAdmission } from '@/lib/n8n-runtime-affinity'
import { getN8nIntakeControl } from '@/lib/n8n-intake-control'
import { acquireN8nTaskDispatchOwnership, settleN8nTaskDispatchFailure, settleN8nTaskDispatchSuccess } from '@/lib/n8n-task-dispatch'
import { triggerN8nWebhook, isN8nWebhookDispatchError } from '@/lib/n8n'
import { n8nTaskWebhookPayload } from '@/lib/n8n-task-webhook-payload'
import { inspectN8nMediaCheckpointReuse } from '@/lib/n8n-media-execution'
import { getScopedN8nTaskRunByTaskId } from '@/lib/n8n-task-runs'
import { mediaChildIdentity } from '@/lib/n8n-media-workspace'
import { enqueueOriginalVideoRepair, locateOriginalVideoRepairBatch, readOwnedQueuedVideoRepair } from '@/lib/n8n-video-repair-queue'
import { assertCurrentVideoRepairCallbackBinding, currentVideoRepairCallbackBinding,
  type VideoRepairCallbackBinding } from '@/lib/n8n-video-repair-affinity'

const registryKey = Symbol.for('aiworker.video-recovery.confirmation/v1')
const globals = globalThis as typeof globalThis & { [registryKey]?: Buffer }
// This short-lived seal protects confirmation/CAS consistency, not user auth.
const confirmationKey = globals[registryKey] ??= randomBytes(32)
const tokenSchema = z.object({ taskId: z.string().min(1).max(120), tenantId: z.number().int().positive(),
  workspaceId: z.number().int().positive(), revisionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/u), expiresAt: z.number().int().positive(), actorId: z.number().int(),
  mode: z.literal('repair-segments').optional(),
  indexesSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  targetCallbackBindingSha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
}).strict()

function seal(data: z.infer<typeof tokenSchema>) {
  const encoded = Buffer.from(JSON.stringify(data)).toString('base64url')
  return `${encoded}.${createHmac('sha256', confirmationKey).update(encoded).digest('base64url')}`
}

function verify(token: string) {
  if (typeof token !== 'string' || token.length > 4096) throw new Error('recovery_confirmation_invalid')
  const parts = token.split('.')
  if (parts.length !== 2) throw new Error('recovery_confirmation_invalid')
  const expected = createHmac('sha256', confirmationKey).update(parts[0]).digest()
  const signature = Buffer.from(parts[1], 'base64url')
  if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) throw new Error('recovery_confirmation_invalid')
  const parsed = tokenSchema.safeParse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')))
  if (!parsed.success || parsed.data.expiresAt < Date.now()) throw new Error('recovery_confirmation_expired')
  return parsed.data
}

export interface VideoRecoveryInspection {
  taskId: string
  eligible: boolean
  currentState: string
  errorCode: string | null
  nextAction: string
  missingResources: string[]
  preservedStages: string[]
  expectedRevision: string | null
  inspectionToken: string | null
  mode?: 'repair-segments'
  segmentIndexes?: number[]
  targetCallbackBinding?: VideoRepairCallbackBinding
}

export async function inspectVideoRecovery(db: Database.Database, taskId: string, scope: N8nTaskScope, actorId: number): Promise<VideoRecoveryInspection | null> {
  const authority = inspectScopedN8nVideoRecoveryState(db, taskId, scope)
  if (authority.outcome === 'not_found' || !authority.run) return null
  const base: VideoRecoveryInspection = { taskId, eligible: false, currentState: authority.run.status,
    errorCode: authority.errorCode, nextAction: 'inspect_task_state', missingResources: [],
    preservedStages: authority.successfulStages, expectedRevision: authority.revisionSha256, inspectionToken: null }
  if (authority.outcome !== 'eligible' || !authority.revisionSha256) return base
  const admission = checkN8nCallbackAdmission(authority.run.routing)
  if (!admission.allowed) return { ...base, errorCode: admission.code, nextAction: 'inspect_runtime_affinity' }
  if (!getN8nIntakeControl(db).accepting) return { ...base, errorCode: 'recovery_intake_paused', nextAction: 'wait_for_intake' }
  // Authority/scope is settled before reading any prepared files or resources.
  const evidence = await inspectPreparedRecoveryEvidence(taskId, authority.run.routing, authority.run.input, authority.successfulStages)
  if (!evidence.eligible || !evidence.revisionSha256) return { ...base, errorCode: evidence.errorCode,
    nextAction: evidence.nextAction, missingResources: evidence.missingResources }
  const audio = getScopedN8nTaskRunByTaskId(db, mediaChildIdentity('task', taskId, 'audio'), scope)
  const vision = getScopedN8nTaskRunByTaskId(db, mediaChildIdentity('task', taskId, 'vision'), scope)
  const checkpoints = await inspectN8nMediaCheckpointReuse(taskId, authority.run.routing, authority.run.input,
    { audio: audio?.output || null, vision: vision?.output || null })
  if (!checkpoints.eligible) return { ...base, errorCode: checkpoints.errorCode, nextAction: 'inspect_checkpoint_identity' }
  return { ...base, eligible: true, errorCode: null, nextAction: 'confirm_same_task_recovery',
    inspectionToken: seal({ taskId, ...scope, actorId, revisionSha256: authority.revisionSha256,
      evidenceSha256: evidence.revisionSha256, expiresAt: Date.now() + 5 * 60_000 }) }
}

export async function recoverVideoTask(db: Database.Database,
  input: { taskId: string; inspectionToken: string }, scope: N8nTaskScope, actorId: number,
): Promise<{ taskId: string; currentState: string; errorCode: string | null; nextAction: string }> {
  const confirmed = verify(input.inspectionToken)
  if (confirmed.mode) throw new Error('recovery_confirmation_scope_mismatch')
  if (confirmed.taskId !== input.taskId || confirmed.tenantId !== scope.tenantId || confirmed.workspaceId !== scope.workspaceId
    || confirmed.actorId !== actorId) {
    throw new Error('recovery_confirmation_scope_mismatch')
  }
  const current = await inspectVideoRecovery(db, input.taskId, scope, actorId)
  if (!current?.eligible || current.expectedRevision !== confirmed.revisionSha256 || !current.inspectionToken) {
    throw new Error(current?.errorCode || 'recovery_revision_changed')
  }
  const evidence = verify(current.inspectionToken)
  if (evidence.evidenceSha256 !== confirmed.evidenceSha256) throw new Error('recovery_evidence_changed')
  const transition = requeueScopedN8nVideoTaskRun(db, { taskId: input.taskId, expectedRevisionSha256: confirmed.revisionSha256 }, scope)
  if (transition.outcome !== 'queued' || !transition.run) throw new Error(transition.errorCode || 'recovery_revision_changed')
  return dispatchOriginalTask(db, transition.run, scope)
}

async function dispatchOriginalTask(db: Database.Database, run: N8nTaskRun, scope: N8nTaskScope) {
  const dispatchIdentity = run.routing.dispatchIdentity as { webhookPath: string }
  const dispatch = acquireN8nTaskDispatchOwnership(db, run.taskId, scope)
  if (dispatch.outcome !== 'acquired') return { taskId: run.taskId, currentState: dispatch.run?.status || 'queued',
    errorCode: null, nextAction: 'query_original_task' }
  try {
    await triggerN8nWebhook(dispatchIdentity.webhookPath, n8nTaskWebhookPayload(run), {
      timeoutMs: Math.min(Math.max(Number(run.routing.timeoutSeconds) || 30, 5) * 1000, 120_000), idempotencyKey: run.idempotencyKey,
    })
    const settled = settleN8nTaskDispatchSuccess(db, run.taskId, dispatch.token, scope)
    return { taskId: run.taskId, currentState: settled.run?.status || 'accepted', errorCode: null, nextAction: 'query_original_task' }
  } catch (error) {
    if (isN8nWebhookDispatchError(error) && error.outcome === 'rejected') {
      const settled = settleN8nTaskDispatchFailure(db, run.taskId, dispatch.token, 'recovery_webhook_rejected', scope)
      return { taskId: run.taskId, currentState: settled.run?.status || 'failed',
        errorCode: 'recovery_webhook_rejected', nextAction: 'inspect_dispatch' }
    }
    // Acceptance may already exist. Keep the original lease and task identity;
    // do not submit another task or reinterpret an unknown outcome as failure.
    return { taskId: run.taskId, currentState: getScopedN8nTaskRunByTaskId(db, run.taskId, scope)?.status || 'queued',
      errorCode: 'recovery_dispatch_outcome_unknown', nextAction: 'query_original_task' }
  }
}

const indexesDigest = (indexes: readonly number[]) => createHash('sha256').update(JSON.stringify(indexes)).digest('hex')
const targetBindingDigest = (binding: VideoRepairCallbackBinding) => createHash('sha256').update(JSON.stringify(binding)).digest('hex')

export async function inspectVideoSegmentRepair(db: Database.Database, taskId: string, scope: N8nTaskScope,
  actorId: number, segmentIndexes?: readonly number[],
): Promise<VideoRecoveryInspection | null> {
  const authority = inspectScopedN8nVideoSegmentRepairState(db, taskId, scope, segmentIndexes)
  if (authority.outcome === 'not_found' || !authority.run) return null
  const base: VideoRecoveryInspection = { taskId, eligible: false, currentState: authority.run.status,
    errorCode: authority.errorCode, nextAction: 'inspect_failed_segments', missingResources: [],
    preservedStages: authority.successfulStages, expectedRevision: authority.revisionSha256, inspectionToken: null,
    mode: 'repair-segments', segmentIndexes: authority.indexes }
  if (authority.outcome !== 'eligible' || !authority.revisionSha256) return base
  let targetCallbackBinding: VideoRepairCallbackBinding
  try { targetCallbackBinding = currentVideoRepairCallbackBinding() } catch (error) {
    return { ...base, errorCode: error instanceof Error ? error.message : 'recovery_target_runtime_identity_invalid',
      nextAction: 'inspect_runtime_affinity' }
  }
  if (!getN8nIntakeControl(db).accepting) return { ...base, errorCode: 'recovery_intake_paused', nextAction: 'wait_for_intake' }
  const evidence = await inspectPreparedRecoveryEvidence(taskId, authority.run.routing, authority.run.input, authority.successfulStages)
  if (!evidence.eligible || !evidence.revisionSha256) return { ...base, errorCode: evidence.errorCode,
    nextAction: evidence.nextAction, missingResources: evidence.missingResources }
  const audio = getScopedN8nTaskRunByTaskId(db, mediaChildIdentity('task', taskId, 'audio'), scope)
  const vision = getScopedN8nTaskRunByTaskId(db, mediaChildIdentity('task', taskId, 'vision'), scope)
  const checkpoints = await inspectN8nMediaCheckpointReuse(taskId, authority.run.routing, authority.run.input,
    { audio: audio?.output || null, vision: vision?.output || null, result: authority.run.output })
  if (!checkpoints.eligible) return { ...base, errorCode: checkpoints.errorCode, nextAction: 'inspect_checkpoint_identity' }
  try { await locateOriginalVideoRepairBatch(authority.run) } catch (error) {
    const code = error instanceof Error && /^recovery_[a-z_]+$/u.test(error.message) ? error.message : 'recovery_original_batch_missing'
    return { ...base, errorCode: code, nextAction: 'inspect_original_batch' }
  }
  return { ...base, eligible: true, errorCode: null, nextAction: 'confirm_failed_segment_repair', targetCallbackBinding,
    inspectionToken: seal({ taskId, ...scope, actorId, mode: 'repair-segments',
      indexesSha256: indexesDigest(authority.indexes), revisionSha256: authority.revisionSha256,
      targetCallbackBindingSha256: targetBindingDigest(targetCallbackBinding),
      evidenceSha256: evidence.revisionSha256, expiresAt: Date.now() + 5 * 60_000 }) }
}

export async function repairVideoSegments(db: Database.Database,
  input: { taskId: string; inspectionToken: string; segmentIndexes?: readonly number[] }, scope: N8nTaskScope, actorId: number,
): Promise<{ taskId: string; currentState: string; errorCode: string | null; nextAction: string }> {
  const confirmed = verify(input.inspectionToken)
  if (confirmed.mode !== 'repair-segments' || confirmed.taskId !== input.taskId
    || confirmed.tenantId !== scope.tenantId || confirmed.workspaceId !== scope.workspaceId || confirmed.actorId !== actorId) {
    throw new Error('recovery_confirmation_scope_mismatch')
  }
  const current = await inspectVideoSegmentRepair(db, input.taskId, scope, actorId, input.segmentIndexes)
  if (!current?.eligible || !current.inspectionToken || current.expectedRevision !== confirmed.revisionSha256
    || !current.segmentIndexes || indexesDigest(current.segmentIndexes) !== confirmed.indexesSha256
    || !current.targetCallbackBinding || targetBindingDigest(current.targetCallbackBinding) !== confirmed.targetCallbackBindingSha256) {
    throw new Error(current?.errorCode || 'recovery_revision_changed')
  }
  if (verify(current.inspectionToken).evidenceSha256 !== confirmed.evidenceSha256) throw new Error('recovery_evidence_changed')
  const authority = inspectScopedN8nVideoSegmentRepairState(db, input.taskId, scope, current.segmentIndexes)
  if (authority.outcome !== 'eligible' || !authority.run || !authority.outputSha256
    || authority.revisionSha256 !== confirmed.revisionSha256) throw new Error('recovery_revision_changed')
  await enqueueOriginalVideoRepair(authority.run, { actorId,
    segmentIndexes: current.segmentIndexes, outputSha256: authority.outputSha256,
    revisionSha256: confirmed.revisionSha256, evidenceSha256: confirmed.evidenceSha256, generation: authority.generation,
    targetCallbackBinding: current.targetCallbackBinding,
  }, () => {
    const latest = inspectScopedN8nVideoSegmentRepairState(db, input.taskId, scope, current.segmentIndexes)
    if (latest.outcome !== 'eligible' || latest.revisionSha256 !== confirmed.revisionSha256) throw new Error('recovery_revision_changed')
    assertCurrentVideoRepairCallbackBinding(current.targetCallbackBinding)
  })
  return { taskId: input.taskId, currentState: 'queued', errorCode: null, nextAction: 'wait_for_original_video_worker' }
}

/** The persistent worker calls this only while holding the original global and batch locks. */
export async function dispatchQueuedVideoSegmentRepair(db: Database.Database,
  input: { taskId: string; requestId: string; workerLease: { pid: number; token: string } }, scope: N8nTaskScope,
) {
  const run = getScopedN8nTaskRunByTaskId(db, input.taskId, scope)
  if (!run) throw new Error('recovery_task_not_found')
  const queued = await readOwnedQueuedVideoRepair(run, scope, input)
  const convergeClaimedRequest = async () => {
    // Another HTTP request may have committed this exact repair after the
    // first read. Ownership is checked again; an unrelated worker never gains
    // authority merely because the task now exists.
    const current = getScopedN8nTaskRunByTaskId(db, input.taskId, scope)
    const active = current?.routing.learningRepair as { queueRequestId?: string } | undefined
    if (!current || active?.queueRequestId !== queued.requestId) return null
    await readOwnedQueuedVideoRepair(current, scope, input)
    if (current.status === 'queued') {
      assertCurrentVideoRepairCallbackBinding(queued.targetCallbackBinding)
      return dispatchOriginalTask(db, current, scope)
    }
    return { taskId: current.taskId, currentState: current.status, errorCode: null, nextAction: 'query_original_task' }
  }
  const claimed = await convergeClaimedRequest()
  if (claimed) return claimed
  try {
    assertCurrentVideoRepairCallbackBinding(queued.targetCallbackBinding)
    const inspection = await inspectVideoSegmentRepair(db, input.taskId, scope, queued.actorId, queued.segmentIndexes)
    if (!inspection?.eligible || !inspection.inspectionToken || inspection.expectedRevision !== queued.revisionSha256) {
      throw new Error(inspection?.errorCode || 'recovery_revision_changed')
    }
    const fresh = verify(inspection.inspectionToken)
    if (fresh.evidenceSha256 !== queued.evidenceSha256) throw new Error('recovery_evidence_changed')
    if (fresh.targetCallbackBindingSha256 !== targetBindingDigest(queued.targetCallbackBinding)) {
      throw new Error('recovery_target_callback_binding_changed')
    }
    const authority = inspectScopedN8nVideoSegmentRepairState(db, run.taskId, scope, queued.segmentIndexes)
    if (authority.outputSha256 !== queued.outputSha256 || authority.generation !== queued.generation) throw new Error('recovery_revision_changed')
    // Resource inspection can take time. Recheck the existing lane ownership
    // immediately before granting the new execution round.
    await readOwnedQueuedVideoRepair(run, scope, input)
    const transition = requeueScopedN8nVideoSegmentRepair(db, { taskId: run.taskId,
      expectedRevisionSha256: queued.revisionSha256, segmentIndexes: queued.segmentIndexes, queueRequestId: queued.requestId,
      targetCallbackBinding: queued.targetCallbackBinding }, scope)
    if (transition.outcome !== 'queued' || !transition.run) throw new Error(transition.errorCode || 'recovery_revision_changed')
    return dispatchOriginalTask(db, transition.run, scope)
  } catch (error) {
    const settled = await convergeClaimedRequest()
    if (settled) return settled
    throw error
  }
}
