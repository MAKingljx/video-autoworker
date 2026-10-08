import type Database from 'better-sqlite3'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { inspectScopedN8nVideoRecoveryState, requeueScopedN8nVideoTaskRun, type N8nTaskScope } from '@/lib/n8n-task-runs'
import { inspectPreparedRecoveryEvidence } from '@/lib/n8n-prepared-evidence'
import { checkN8nCallbackAdmission } from '@/lib/n8n-runtime-affinity'
import { getN8nIntakeControl } from '@/lib/n8n-intake-control'
import { acquireN8nTaskDispatchOwnership, settleN8nTaskDispatchFailure, settleN8nTaskDispatchSuccess } from '@/lib/n8n-task-dispatch'
import { triggerN8nWebhook, isN8nWebhookDispatchError } from '@/lib/n8n'
import { n8nTaskWebhookPayload } from '@/lib/n8n-task-webhook-payload'
import { inspectN8nMediaCheckpointReuse } from '@/lib/n8n-media-execution'
import { getScopedN8nTaskRunByTaskId } from '@/lib/n8n-task-runs'
import { mediaChildIdentity } from '@/lib/n8n-media-workspace'

const registryKey = Symbol.for('aiworker.video-recovery.confirmation/v1')
const globals = globalThis as typeof globalThis & { [registryKey]?: Buffer }
// This short-lived seal protects confirmation/CAS consistency, not user auth.
const confirmationKey = globals[registryKey] ??= randomBytes(32)
const tokenSchema = z.object({ taskId: z.string().min(1).max(120), tenantId: z.number().int().positive(),
  workspaceId: z.number().int().positive(), revisionSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/u), expiresAt: z.number().int().positive(), actorId: z.number().int(),
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
  const run = transition.run
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
