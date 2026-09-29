import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { createN8nWorkflowBinding, n8nWorkflowBindingInputSchema } from '@/lib/n8n-workflows'
import { getScopedN8nTaskRunByTaskId } from '@/lib/n8n-task-runs'
import { createEditPlan } from '@/lib/editing/edit-plan'
import { operationPayloadSha256, resolveOperationId } from '@/lib/editing/resolve-executor'
import {
  approveEditPlan, beginEditOperation, claimApprovedEditTask, getEditPlanStatus,
  saveValidatedEditPlan, settleEditOperation,
} from '@/lib/editing/edit-task-service'

const scope = { tenantId: 1, workspaceId: 1 }
const digest = 'a'.repeat(64)
const owner = 'n8n-execution:resolve-task-001'

function candidate() {
  return createEditPlan({
    schemaVersion: 1, planId: 'plan-001', revision: 1, status: 'validated', scope,
    sourceTaskIds: ['source-task-001'], objective: '粗剪',
    sourceFrameRate: { numerator: 25, denominator: 1 },
    timelineFrameRate: { numerator: 25, denominator: 1 },
    base: { editorNodeId: 'mac-resolve-local', resolveVersion: '21.1',
      projectUniqueId: 'project-001', timelineUniqueId: 'source-timeline',
      timelineName: 'Source', projectFingerprint: digest, timelineFingerprint: digest },
    clips: [{ itemId: 'clip-001',
      asset: { assetId: 'asset-001', contentSha256: digest, revision: 'rev-1',
        resolveMediaPoolItemUniqueId: 'media-001' },
      evidence: [{ evidenceId: 'evidence-001', assetId: 'asset-001', revision: 'rev-1',
        source: 'saved-summary', completeness: 'complete' }],
      sourceRange: { start: 0, endExclusive: 50 }, timelineStartFrame: 0,
      trackIndex: 1, mediaType: 'av', rationale: '故事开头' }],
    output: { preview: true }, capabilitiesRequired: ['timeline.duplicate'],
    createdAt: 1_700_000_000, updatedAt: 1_700_000_000,
  })
}

function fixture() {
  const db = new Database(':memory:')
  runMigrations(db)
  const binding = createN8nWorkflowBinding(db, n8nWorkflowBindingInputSchema.parse({
    name: '剪辑任务链', webhookPath: 'webhook/video-edit', taskType: 'video-edit', enabled: true,
  }), 'tester', scope)
  return { db, binding }
}

function totalChanges(db: Database.Database): number {
  return (db.prepare('SELECT total_changes() AS count').get() as { count: number }).count
}

describe('single-chain edit task receipts', () => {
  it('atomically approves into the existing run, then fences ambiguous Resolve writes', () => {
    const { db, binding } = fixture()
    try {
      const plan = candidate()
      expect(saveValidatedEditPlan(db, plan, scope).planSha256).toBe(plan.planSha256)
      expect(getScopedN8nTaskRunByTaskId(db, 'edit-task-001', scope)).toBeNull()
      const beforeRead = totalChanges(db)
      expect(getEditPlanStatus(db, plan.planId, plan.revision, scope)).toMatchObject({
        planStatus: 'validated', taskStatus: null, operations: [],
      })
      expect(totalChanges(db)).toBe(beforeRead)
      expect(() => saveValidatedEditPlan(db, plan, { tenantId: 2, workspaceId: 1 }))
        .toThrow('video_edit_plan_not_validated')

      const approval = {
        planId: plan.planId, revision: plan.revision, expectedPlanSha256: plan.planSha256,
        taskId: 'edit-task-001', bindingId: binding.id, approvedBy: 'operator-001',
      }
      const approved = approveEditPlan(db, approval, scope)
      expect(approved.duplicate).toBe(false)
      expect(approveEditPlan(db, approval, scope).duplicate).toBe(true)
      expect(getScopedN8nTaskRunByTaskId(db, approval.taskId, scope)).toMatchObject({
        status: 'queued', routing: { taskType: 'video-edit' },
      })
      expect(claimApprovedEditTask(db, approval.taskId, owner, scope).outcome).toBe('claimed')
      expect(claimApprovedEditTask(db, approval.taskId, owner, scope).outcome).toBe('owned')

      const operation = {
        operationId: resolveOperationId(approved.plan, approval.taskId, 'duplicate_timeline', 'copy'),
        taskId: approval.taskId, planId: approved.plan.planId, planRevision: approved.plan.revision,
        phase: 'duplicate_timeline' as const, stepId: 'copy',
        payloadSha256: operationPayloadSha256(approved.plan.base), status: 'pending' as const,
        executorNodeId: approved.plan.base.editorNodeId, resolveVersion: approved.plan.base.resolveVersion,
      }
      expect(beginEditOperation(db, operation, owner, scope).outcome).toBe('write_granted')
      expect(beginEditOperation(db, operation, owner, scope).outcome).toBe('reconcile_required')
      const otherPlan = saveValidatedEditPlan(db, createEditPlan({ ...candidate(), planId: 'plan-002' }), scope)
      const otherApproval = approveEditPlan(db, {
        planId: otherPlan.planId, revision: otherPlan.revision,
        expectedPlanSha256: otherPlan.planSha256, taskId: 'edit-task-002',
        bindingId: binding.id, approvedBy: 'operator-001',
      }, scope)
      const otherOwner = 'n8n-execution:resolve-task-002'
      claimApprovedEditTask(db, 'edit-task-002', otherOwner, scope)
      const otherOperation = {
        ...operation, taskId: 'edit-task-002', planId: otherPlan.planId,
        operationId: resolveOperationId(otherApproval.plan, 'edit-task-002', 'duplicate_timeline', 'copy'),
        payloadSha256: operationPayloadSha256(otherApproval.plan.base),
      }
      expect(() => beginEditOperation(db, otherOperation, otherOwner, scope))
        .toThrow('video_edit_executor_busy')
      expect(() => settleEditOperation(db, {
        operationId: operation.operationId, taskId: operation.taskId, executionOwner: owner,
        status: 'succeeded', result: { timelineUniqueId: 'copy-001' },
      }, scope)).toThrow('video_edit_readback_evidence_required')
      expect(settleEditOperation(db, {
        operationId: operation.operationId, taskId: operation.taskId, executionOwner: owner,
        status: 'unknown', errorCode: 'resolve_transport_connection_lost',
      }, scope)).toEqual({ status: 'unknown', changed: true })
      expect(beginEditOperation(db, operation, owner, scope).outcome).toBe('reconcile_required')
      expect(settleEditOperation(db, {
        operationId: operation.operationId, taskId: operation.taskId, executionOwner: owner,
        status: 'succeeded', evidenceSha256: digest, result: { timelineUniqueId: 'copy-001' },
      }, scope)).toEqual({ status: 'succeeded', changed: true })
      expect(beginEditOperation(db, operation, owner, scope).outcome).toBe('cached')
      expect(beginEditOperation(db, otherOperation, otherOwner, scope).outcome).toBe('write_granted')
      const beforeFinalRead = totalChanges(db)
      expect(getEditPlanStatus(db, plan.planId, plan.revision, scope)).toMatchObject({
        planStatus: 'approved', taskStatus: 'running',
        operations: [{ operationId: operation.operationId, status: 'succeeded', evidenceSha256: digest }],
      })
      expect(totalChanges(db)).toBe(beforeFinalRead)
    } finally { db.close() }
  })

  it('rejects competing scope, owner, and payload before any new write intent', () => {
    const { db, binding } = fixture()
    try {
      const plan = saveValidatedEditPlan(db, candidate(), scope)
      expect(() => approveEditPlan(db, {
        planId: plan.planId, revision: plan.revision, expectedPlanSha256: plan.planSha256,
        taskId: 'edit-task-001', bindingId: 999, approvedBy: 'operator-001',
      }, scope)).toThrow('video_edit_binding_unavailable')
      expect(getScopedN8nTaskRunByTaskId(db, 'edit-task-001', scope)).toBeNull()
      const approved = approveEditPlan(db, {
        planId: plan.planId, revision: plan.revision, expectedPlanSha256: plan.planSha256,
        taskId: 'edit-task-001', bindingId: binding.id, approvedBy: 'operator-001',
      }, scope)
      expect(() => claimApprovedEditTask(db, 'edit-task-001', owner, { tenantId: 2, workspaceId: 1 }))
        .toThrow('video_edit_task_not_found')
      const operation = {
        operationId: resolveOperationId(approved.plan, 'edit-task-001', 'duplicate_timeline', 'copy'),
        taskId: 'edit-task-001', planId: approved.plan.planId, planRevision: approved.plan.revision,
        phase: 'duplicate_timeline' as const, stepId: 'copy',
        payloadSha256: 'b'.repeat(64), status: 'pending' as const,
        executorNodeId: approved.plan.base.editorNodeId, resolveVersion: approved.plan.base.resolveVersion,
      }
      expect(() => beginEditOperation(db, operation, owner, scope))
        .toThrow('video_edit_execution_owner_mismatch')
      claimApprovedEditTask(db, 'edit-task-001', owner, scope)
      expect(() => beginEditOperation(db, operation, owner, scope))
        .toThrow('video_edit_operation_binding_mismatch')
      expect(db.prepare('SELECT COUNT(*) AS count FROM video_edit_operations').get()).toMatchObject({ count: 0 })
    } finally { db.close() }
  })

  it('keeps the first approval when two database clients race with different task IDs', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aiworker-edit-approval-'))
    const path = join(directory, 'isolated.sqlite')
    const first = new Database(path)
    const second = new Database(path)
    try {
      runMigrations(first)
      const binding = createN8nWorkflowBinding(first, n8nWorkflowBindingInputSchema.parse({
        name: '剪辑任务链', webhookPath: 'webhook/video-edit', taskType: 'video-edit', enabled: true,
      }), 'tester', scope)
      const plan = saveValidatedEditPlan(first, candidate(), scope)
      const input = { planId: plan.planId, revision: plan.revision,
        expectedPlanSha256: plan.planSha256, bindingId: binding.id, approvedBy: 'operator-001' }
      expect(approveEditPlan(first, { ...input, taskId: 'edit-task-a' }, scope).duplicate).toBe(false)
      expect(() => approveEditPlan(second, { ...input, taskId: 'edit-task-b' }, scope))
        .toThrow('video_edit_approval_conflict')
      expect(getScopedN8nTaskRunByTaskId(second, 'edit-task-b', scope)).toBeNull()
      expect(getEditPlanStatus(second, plan.planId, plan.revision, scope)).toMatchObject({ taskId: 'edit-task-a' })
    } finally {
      second.close()
      first.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
