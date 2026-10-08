import type Database from 'better-sqlite3'
import { createEditPlan, assertEditPlanIntegrity, type EditPlan } from './edit-plan'
import { operationPayloadSha256, resolveOperationId, resolveOperationPayload, type ResolveExecutorOperation } from './resolve-executor'
import {
  claimScopedN8nTaskRun,
  getScopedN8nTaskRunByTaskId,
  isScopedN8nParentExecutionOwner,
  n8nExecutionOwnerSchema,
  n8nTaskIdentitySchema,
  type N8nTaskScope,
} from '@/lib/n8n-task-runs'
import { createN8nTaskRunWithIntakeGate } from '@/lib/n8n-intake-control'
import { getN8nWorkflowBinding } from '@/lib/n8n-workflows'

type PlanRow = {
  plan_sha256: string
  plan_json: string
  status: 'validated' | 'approved'
  approved_by: string | null
  approval_source_sha256: string | null
  task_id: string | null
}

type OperationRow = {
  operation_id: string
  task_id: string
  plan_sha256: string
  phase: string
  step_id: string
  payload_sha256: string
  status: 'running' | 'unknown' | 'succeeded' | 'failed'
  executor_node_id: string
  execution_owner: string
  result_json: string | null
  evidence_sha256: string | null
  error_code: string | null
}

function readPlan(db: Database.Database, planId: string, revision: number, scope: N8nTaskScope): PlanRow | null {
  return db.prepare(`
    SELECT plan_sha256, plan_json, status, approved_by, approval_source_sha256, task_id
    FROM video_edit_plans
    WHERE plan_id = ? AND revision = ? AND tenant_id = ? AND workspace_id = ?
  `).get(planId, revision, scope.tenantId, scope.workspaceId) as PlanRow | undefined || null
}

function parseStoredPlan(row: PlanRow): EditPlan {
  const plan = assertEditPlanIntegrity(JSON.parse(row.plan_json))
  if (plan.planSha256 !== row.plan_sha256 || plan.status !== row.status) {
    throw new Error('video_edit_plan_receipt_mismatch')
  }
  return plan
}

/** Compact readback from the same task authority, without media or plan body. */
export function getEditPlanStatus(
  db: Database.Database, planId: string, revision: number, scope: N8nTaskScope,
) {
  const row = readPlan(db, planId, revision, scope)
  if (!row) return null
  const plan = parseStoredPlan(row)
  const run = row.task_id ? getScopedN8nTaskRunByTaskId(db, row.task_id, scope) : null
  if (row.task_id && (!run || run.routing.taskType !== 'video-edit'
    || run.input.planSha256 !== plan.planSha256)) {
    throw new Error('video_edit_task_plan_binding_mismatch')
  }
  const operations = row.task_id ? db.prepare(`
    SELECT operation_id, phase, step_id, status, evidence_sha256, error_code
    FROM video_edit_operations WHERE task_id = ? ORDER BY created_at, operation_id
  `).all(row.task_id) as Array<{
    operation_id: string; phase: string; step_id: string; status: string
    evidence_sha256: string | null; error_code: string | null
  }> : []
  return {
    planId: plan.planId, revision: plan.revision, planSha256: plan.planSha256,
    planStatus: plan.status, taskId: row.task_id, taskStatus: run?.status || null,
    operations: operations.map(operation => ({
      operationId: operation.operation_id, phase: operation.phase, stepId: operation.step_id,
      status: operation.status, evidenceSha256: operation.evidence_sha256,
      errorCode: operation.error_code,
    })),
  }
}

export function requireApprovedTask(db: Database.Database, taskId: string, scope: N8nTaskScope) {
  const run = getScopedN8nTaskRunByTaskId(db, taskId, scope)
  if (!run || run.routing.taskType !== 'video-edit') throw new Error('video_edit_task_not_found')
  const row = db.prepare(`
    SELECT plan_sha256, plan_json, status, approved_by, approval_source_sha256, task_id
    FROM video_edit_plans
    WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
  `).get(taskId, scope.tenantId, scope.workspaceId) as PlanRow | undefined
  if (!row || row.status !== 'approved' || row.task_id !== taskId) {
    throw new Error('video_edit_task_not_approved')
  }
  const plan = parseStoredPlan(row)
  if (run.input.planSha256 !== plan.planSha256 || run.input.planId !== plan.planId
    || run.input.revision !== plan.revision) throw new Error('video_edit_task_plan_binding_mismatch')
  return { run, plan }
}

/** Store candidate intent only. It is not a task and cannot hold a worker lease. */
export function saveValidatedEditPlan(db: Database.Database, value: unknown, scope: N8nTaskScope): EditPlan {
  const plan = assertEditPlanIntegrity(value)
  if (plan.status !== 'validated' || plan.scope.tenantId !== scope.tenantId
    || plan.scope.workspaceId !== scope.workspaceId || plan.clips.length === 0) {
    throw new Error('video_edit_plan_not_validated')
  }
  const save = db.transaction(() => {
    const existing = readPlan(db, plan.planId, plan.revision, scope)
    if (existing) {
      if (existing.plan_sha256 !== plan.planSha256 || existing.status !== 'validated') {
        throw new Error('video_edit_plan_conflict')
      }
      return parseStoredPlan(existing)
    }
    db.prepare(`
      INSERT INTO video_edit_plans (
        plan_id, revision, tenant_id, workspace_id, plan_sha256, plan_json, status
      ) VALUES (?, ?, ?, ?, ?, ?, 'validated')
    `).run(plan.planId, plan.revision, scope.tenantId, scope.workspaceId,
      plan.planSha256, JSON.stringify(plan))
    return plan
  })
  return save.immediate()
}

/** One approval atomically creates exactly one run in the existing task table. */
export function approveEditPlan(
  db: Database.Database,
  input: {
    planId: string; revision: number; expectedPlanSha256: string
    taskId: string; bindingId: number; approvedBy: string
  },
  scope: N8nTaskScope,
): { plan: EditPlan; taskId: string; duplicate: boolean } {
  const taskId = n8nTaskIdentitySchema.parse(input.taskId)
  const approvedBy = String(input.approvedBy || '').trim()
  if (!approvedBy || approvedBy.length > 120) throw new Error('video_edit_approver_invalid')
  const approve = db.transaction(() => {
    const row = readPlan(db, input.planId, input.revision, scope)
    if (!row) throw new Error('video_edit_plan_not_found')
    if (row.status === 'approved') {
      if (row.task_id !== taskId || row.approved_by !== approvedBy
        || row.approval_source_sha256 !== input.expectedPlanSha256) throw new Error('video_edit_approval_conflict')
      requireApprovedTask(db, taskId, scope)
      return { plan: parseStoredPlan(row), taskId, duplicate: true }
    }
    if (row.plan_sha256 !== input.expectedPlanSha256) throw new Error('video_edit_plan_version_conflict')
    const candidate = parseStoredPlan(row)
    if (candidate.clips.some(clip => clip.evidence.some(evidence => evidence.completeness !== 'complete'))) {
      throw new Error('video_edit_evidence_incomplete')
    }
    const binding = getN8nWorkflowBinding(db, input.bindingId, scope)
    if (!binding || !binding.enabled || binding.taskType !== 'video-edit') {
      throw new Error('video_edit_binding_unavailable')
    }
    const plan = createEditPlan({ ...candidate, status: 'approved', updatedAt: Math.floor(Date.now() / 1_000) })
    const admission = createN8nTaskRunWithIntakeGate(db, {
      taskId, idempotencyKey: taskId, bindingId: binding.id,
      source: 'openclaw', requestedBy: approvedBy,
      routing: { id: binding.id, name: binding.name, taskType: 'video-edit', agentRole: binding.agentRole },
      taskInput: { planId: plan.planId, revision: plan.revision, planSha256: plan.planSha256 },
      delivery: { mode: 'none' }, maxAttempts: 1,
    }, scope)
    if (admission.outcome === 'blocked') throw new Error('video_edit_intake_paused')
    if (admission.run.taskId !== taskId || admission.run.bindingId !== binding.id
      || admission.run.input.planSha256 !== plan.planSha256) {
      throw new Error('video_edit_task_identity_conflict')
    }
    const updated = db.prepare(`
      UPDATE video_edit_plans
      SET plan_sha256 = ?, plan_json = ?, status = 'approved',
          approved_by = ?, approval_source_sha256 = ?, task_id = ?, updated_at = unixepoch()
      WHERE plan_id = ? AND revision = ? AND tenant_id = ? AND workspace_id = ?
        AND status = 'validated' AND plan_sha256 = ?
    `).run(plan.planSha256, JSON.stringify(plan), approvedBy, candidate.planSha256, taskId,
      plan.planId, plan.revision, scope.tenantId, scope.workspaceId, candidate.planSha256)
    if (updated.changes !== 1) throw new Error('video_edit_plan_version_conflict')
    return { plan, taskId, duplicate: false }
  })
  return approve.immediate()
}

export function claimApprovedEditTask(
  db: Database.Database, taskId: string, executionOwner: string, scope: N8nTaskScope,
) {
  const owner = n8nExecutionOwnerSchema.parse(executionOwner)
  const { run } = requireApprovedTask(db, taskId, scope)
  return claimScopedN8nTaskRun(db, {
    taskId, idempotencyKey: run.idempotencyKey, bindingId: run.bindingId, executionOwner: owner,
  }, scope)
}

/** Commit a write intent before calling Resolve. Re-entry never grants a second write. */
export function beginEditOperation(
  db: Database.Database, operation: ResolveExecutorOperation,
  executionOwner: string, scope: N8nTaskScope,
): { outcome: 'write_granted' | 'reconcile_required' | 'cached' | 'terminal'; status: OperationRow['status'] } {
  const owner = n8nExecutionOwnerSchema.parse(executionOwner)
  const begin = db.transaction(() => {
    const { run, plan } = requireApprovedTask(db, operation.taskId, scope)
    if (run.status !== 'running' || !isScopedN8nParentExecutionOwner(db, run.taskId, owner, scope)) {
      throw new Error('video_edit_execution_owner_mismatch')
    }
    if (operation.planId !== plan.planId || operation.planRevision !== plan.revision
      || operation.executorNodeId !== plan.base.editorNodeId
      || operation.resolveVersion !== plan.base.resolveVersion
      || operation.operationId !== resolveOperationId(plan, run.taskId, operation.phase, operation.stepId)
      || operation.payloadSha256 !== operationPayloadSha256(resolveOperationPayload(plan, operation))) {
      throw new Error('video_edit_operation_binding_mismatch')
    }
    const existing = db.prepare(`SELECT * FROM video_edit_operations WHERE operation_id = ?`)
      .get(operation.operationId) as OperationRow | undefined
    if (existing) {
      if (existing.task_id !== run.taskId || existing.plan_sha256 !== plan.planSha256
        || existing.phase !== operation.phase || existing.step_id !== operation.stepId
        || existing.payload_sha256 !== operation.payloadSha256
        || existing.executor_node_id !== operation.executorNodeId
        || existing.execution_owner !== owner) throw new Error('video_edit_operation_conflict')
      return { outcome: existing.status === 'succeeded' ? 'cached' as const
        : existing.status === 'failed' ? 'terminal' as const : 'reconcile_required' as const,
        status: existing.status }
    }
    const active = db.prepare(`
      SELECT operation_id FROM video_edit_operations
      WHERE executor_node_id = ? AND status IN ('running', 'unknown')
    `).get(operation.executorNodeId) as { operation_id: string } | undefined
    if (active) throw new Error('video_edit_executor_busy')
    try {
      db.prepare(`
        INSERT INTO video_edit_operations (
          operation_id, task_id, plan_sha256, phase, step_id,
          payload_sha256, status, executor_node_id, execution_owner
        ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
      `).run(operation.operationId, run.taskId, plan.planSha256, operation.phase,
        operation.stepId, operation.payloadSha256, operation.executorNodeId, owner)
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed: video_edit_operations.executor_node_id')) {
        throw new Error('video_edit_executor_busy')
      }
      throw error
    }
    return { outcome: 'write_granted' as const, status: 'running' as const }
  })
  return begin.immediate()
}

/** A succeeded/failed outcome requires readback evidence; unknown stays fenced. */
export function settleEditOperation(
  db: Database.Database,
  input: {
    operationId: string; taskId: string; executionOwner: string
    status: 'running' | 'unknown' | 'succeeded' | 'failed'
    evidenceSha256?: string; result?: Record<string, unknown>; errorCode?: string
  },
  scope: N8nTaskScope,
): { status: OperationRow['status']; changed: boolean } {
  const owner = n8nExecutionOwnerSchema.parse(input.executionOwner)
  if (['succeeded', 'failed'].includes(input.status) && !/^[0-9a-f]{64}$/u.test(input.evidenceSha256 || '')) {
    throw new Error('video_edit_readback_evidence_required')
  }
  const settle = db.transaction(() => {
    const { run } = requireApprovedTask(db, input.taskId, scope)
    if (run.status !== 'running' || !isScopedN8nParentExecutionOwner(db, run.taskId, owner, scope)) {
      throw new Error('video_edit_execution_owner_mismatch')
    }
    const row = db.prepare(`SELECT * FROM video_edit_operations WHERE operation_id = ?`)
      .get(input.operationId) as OperationRow | undefined
    if (!row || row.task_id !== run.taskId || row.execution_owner !== owner) {
      throw new Error('video_edit_operation_not_found')
    }
    if (row.status === 'succeeded' || row.status === 'failed') {
      if (row.status !== input.status || row.evidence_sha256 !== (input.evidenceSha256 || null)) {
        throw new Error('video_edit_operation_terminal_conflict')
      }
      return { status: row.status, changed: false }
    }
    // A later uncertainty must never overwrite a verified readback.
    if (row.status === 'unknown' && input.status === 'unknown') return { status: row.status, changed: false }
    const update = db.prepare(`
      UPDATE video_edit_operations
      SET status = ?, evidence_sha256 = ?, result_json = ?, error_code = ?, updated_at = unixepoch()
      WHERE operation_id = ? AND task_id = ? AND execution_owner = ? AND status = ?
    `).run(input.status, input.evidenceSha256 || null,
      input.result ? JSON.stringify(input.result) : null, input.errorCode || null,
      input.operationId, run.taskId, owner, row.status)
    if (update.changes !== 1) throw new Error('video_edit_operation_state_conflict')
    return { status: input.status, changed: true }
  })
  return settle.immediate()
}

export function getEditPlanDetail(db: Database.Database, planId: string, revision: number, scope: N8nTaskScope) {
  const row = readPlan(db, planId, revision, scope)
  return row ? { ...getEditPlanStatus(db, planId, revision, scope), plan: parseStoredPlan(row) } : null
}

export function listEditPlans(db: Database.Database, scope: N8nTaskScope) {
  return (db.prepare(`SELECT plan_id,revision FROM video_edit_plans WHERE tenant_id=? AND workspace_id=?
    ORDER BY updated_at DESC,plan_id LIMIT 100`).all(scope.tenantId, scope.workspaceId) as Array<{ plan_id: string; revision: number }>)
    .map(row => {
      const detail = getEditPlanDetail(db, row.plan_id, row.revision, scope)!
      return { ...getEditPlanStatus(db, row.plan_id, row.revision, scope), objective: detail.plan.objective, clipCount: detail.plan.clips.length }
    })
}

export function cancelApprovedEditTask(db: Database.Database, taskId: string, expectedPlanSha256: string, scope: N8nTaskScope) {
  return db.transaction(() => {
    const { run, plan } = requireApprovedTask(db, taskId, scope)
    if (plan.planSha256 !== expectedPlanSha256) throw new Error('video_edit_plan_version_conflict')
    if (run.status === 'cancelled') return { status: 'cancelled', changed: false }
    if (['succeeded','failed'].includes(run.status)) throw new Error('video_edit_task_terminal')
    if (db.prepare("SELECT 1 FROM video_edit_operations WHERE task_id=? AND status IN ('running','unknown')").get(taskId)) {
      throw new Error('video_edit_inflight_cancel_requires_review')
    }
    const result = db.prepare(`UPDATE n8n_task_runs SET status='cancelled',completed_at=unixepoch(),updated_at=unixepoch()
      WHERE task_id=? AND tenant_id=? AND workspace_id=? AND status=?`).run(taskId, scope.tenantId, scope.workspaceId, run.status)
    if (result.changes !== 1) throw new Error('video_edit_task_state_conflict')
    return { status: 'cancelled', changed: true }
  }).immediate()
}
