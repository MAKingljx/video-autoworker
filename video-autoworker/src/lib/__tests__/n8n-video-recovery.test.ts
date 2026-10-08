// @vitest-environment node
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { mediaChildIdentity } from '@/lib/n8n-media-workspace'
import { claimScopedN8nTaskRun, createN8nTaskRun, failN8nTaskRun, getScopedN8nTaskRunByTaskId,
  inspectScopedN8nVideoRecoveryState, requeueScopedN8nVideoTaskRun } from '@/lib/n8n-task-runs'

const mocks = vi.hoisted(() => ({ evidence: vi.fn(), checkpoints: vi.fn(), webhook: vi.fn() }))
vi.mock('@/lib/n8n-prepared-evidence', () => ({ inspectPreparedRecoveryEvidence: mocks.evidence }))
vi.mock('@/lib/n8n-media-execution', () => ({ inspectN8nMediaCheckpointReuse: mocks.checkpoints }))
vi.mock('@/lib/n8n', async original => ({ ...await original<typeof import('@/lib/n8n')>(), triggerN8nWebhook: mocks.webhook }))
import { inspectVideoRecovery, recoverVideoTask } from '@/lib/n8n-video-recovery'

const scope = { tenantId: 3, workspaceId: 2 }
let db: Database.Database
let bindingId: number
const taskId = 'recovery-parent'
const identity = 'recovery-original-idem'

beforeEach(() => {
  vi.clearAllMocks()
  db = new Database(':memory:')
  runMigrations(db)
  bindingId = Number(db.prepare(`INSERT INTO n8n_workflow_bindings
    (name,task_type,workflow_id,webhook_path,agent_role,model,enabled,timeout_seconds,retry_count,config,workspace_id,tenant_id)
    VALUES ('video','video-analysis','wf-original','webhook/video','executor','model',1,30,2,'{}',2,3)`).run().lastInsertRowid)
  createN8nTaskRun(db, { taskId, idempotencyKey: identity, bindingId, source: 'openclaw', requestedBy: 'test',
    routing: { taskType: 'video-analysis', callbackProtocol: 'legacy-v1', timeoutSeconds: 30,
      dispatchIdentity: { workflowId: 'wf-original', webhookPath: 'webhook/video' } },
    taskInput: { videoKey: 'original.mp4' }, delivery: { mode: 'none' }, maxAttempts: 3 }, scope)
  claimScopedN8nTaskRun(db, { taskId, idempotencyKey: identity, bindingId, executionOwner: 'n8n-execution:original' }, scope)
  createN8nTaskRun(db, { taskId: mediaChildIdentity('task', taskId, 'prepare'),
    idempotencyKey: mediaChildIdentity('idem', identity, 'prepare'), bindingId, source: 'n8n-media-node', requestedBy: 'test',
    routing: { taskType: 'video-analysis', mediaStage: 'prepare' }, taskInput: {}, delivery: { mode: 'none' }, maxAttempts: 2 }, scope)
  db.prepare(`UPDATE n8n_task_runs SET status='succeeded',attempt_count=1,output=? WHERE task_id=?`)
    .run(JSON.stringify({ kind: 'prepared-video', segmentCount: 10 }), mediaChildIdentity('task', taskId, 'prepare'))
  failN8nTaskRun(db, taskId, 'vision: interrupted')
  mocks.evidence.mockResolvedValue({ eligible: true, revisionSha256: 'a'.repeat(64), missingResources: [], nextAction: 'confirm', errorCode: null })
  mocks.checkpoints.mockResolvedValue({ eligible: true, errorCode: null })
  mocks.webhook.mockResolvedValue({ statusCode: 202, ok: true, latencyMs: 1 })
})

afterEach(() => { db.close(); vi.unstubAllEnvs() })

describe('scoped original video recovery authority', () => {
  it('preserves original identity, successes and budgets, and fences the retired owner', () => {
    const before = db.prepare(`SELECT * FROM n8n_task_runs WHERE task_id=?`).get(mediaChildIdentity('task', taskId, 'prepare'))
    const inspected = inspectScopedN8nVideoRecoveryState(db, taskId, scope)
    expect(inspected).toMatchObject({ outcome: 'eligible', successfulStages: ['prepare'] })
    const changed = requeueScopedN8nVideoTaskRun(db, { taskId, expectedRevisionSha256: inspected.revisionSha256! }, scope)
    expect(changed).toMatchObject({ outcome: 'queued', run: { taskId, idempotencyKey: identity, attemptCount: 1, maxAttempts: 3 } })
    expect(db.prepare(`SELECT * FROM n8n_task_runs WHERE task_id=?`).get(mediaChildIdentity('task', taskId, 'prepare'))).toEqual(before)
    expect(claimScopedN8nTaskRun(db, { taskId, idempotencyKey: identity, bindingId, executionOwner: 'n8n-execution:original' }, scope).outcome).toBe('rejected')
    expect(claimScopedN8nTaskRun(db, { taskId, idempotencyKey: identity, bindingId, executionOwner: 'n8n-execution:new' }, scope).outcome).toBe('claimed')
    expect(db.prepare('SELECT COUNT(*) AS count FROM n8n_task_runs').get()).toEqual({ count: 2 })
  })

  it('rejects a stale snapshot and another tenant', () => {
    const inspected = inspectScopedN8nVideoRecoveryState(db, taskId, scope)
    db.prepare(`UPDATE n8n_task_runs SET error='different',updated_at=updated_at+1 WHERE task_id=?`).run(taskId)
    expect(requeueScopedN8nVideoTaskRun(db, { taskId, expectedRevisionSha256: inspected.revisionSha256! }, scope).outcome).toBe('conflict')
    expect(inspectScopedN8nVideoRecoveryState(db, taskId, { ...scope, tenantId: 8 }).outcome).toBe('not_found')
  })

  it('refuses active dispatch or unsettled child execution even after lease expiry', () => {
    db.prepare(`INSERT INTO n8n_task_dispatch_leases (task_id,tenant_id,workspace_id,owner_token,lease_expires_at,revision)
      VALUES (?,3,2,?,unixepoch()+30,1)`).run(taskId, 'b'.repeat(64))
    expect(inspectScopedN8nVideoRecoveryState(db, taskId, scope).errorCode).toBe('recovery_dispatch_in_progress')
    db.prepare('DELETE FROM n8n_task_dispatch_leases').run()
    db.prepare(`INSERT INTO n8n_child_execution_leases (task_id,tenant_id,workspace_id,owner_instance_id,lease_token,
      lease_expires_at,heartbeat_at,revision,created_at,updated_at) VALUES (?,3,2,?,?,1,1,1,1,1)`)
      .run(mediaChildIdentity('task', taskId, 'prepare'), 'e'.repeat(64), 'c'.repeat(64))
    expect(inspectScopedN8nVideoRecoveryState(db, taskId, scope).errorCode).toBe('recovery_child_lease_unsettled')
  })

  it('refuses changed dispatch identity and exhausted recovery generations', () => {
    db.prepare(`UPDATE n8n_workflow_bindings SET webhook_path='webhook/changed' WHERE id=?`).run(bindingId)
    expect(inspectScopedN8nVideoRecoveryState(db, taskId, scope).errorCode).toBe('recovery_dispatch_identity_changed')
    db.prepare(`UPDATE n8n_workflow_bindings SET webhook_path='webhook/video' WHERE id=?`).run(bindingId)
    const run = getScopedN8nTaskRunByTaskId(db, taskId, scope)!
    db.prepare('UPDATE n8n_task_runs SET routing=? WHERE task_id=?').run(JSON.stringify({ ...run.routing, recoveryGeneration: 2 }), taskId)
    expect(inspectScopedN8nVideoRecoveryState(db, taskId, scope).errorCode).toBe('recovery_attempt_budget_exhausted')
  })
})

describe('two-step recovery service', () => {
  it('keeps inspection read-only and dispatches exactly the original task after confirmation', async () => {
    const inspection = await inspectVideoRecovery(db, taskId, scope, 0)
    expect(inspection).toMatchObject({ eligible: true, preservedStages: ['prepare'] })
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('failed')
    expect(mocks.webhook).not.toHaveBeenCalled()
    const result = await recoverVideoTask(db, { taskId, inspectionToken: inspection!.inspectionToken! }, scope, 0)
    expect(result.currentState).toBe('accepted')
    expect(mocks.webhook).toHaveBeenCalledOnce()
    expect(mocks.webhook.mock.calls[0][1]).toMatchObject({ taskId, idempotencyKey: identity, input: { videoKey: 'original.mp4' } })
    await expect(recoverVideoTask(db, { taskId, inspectionToken: inspection!.inspectionToken! }, scope, 0)).rejects.toThrow()
    expect(mocks.webhook).toHaveBeenCalledOnce()
  })

  it('rejects another user, tenant, task or a tampered confirmation', async () => {
    const inspection = await inspectVideoRecovery(db, taskId, scope, 0)
    for (const args of [
      [{ taskId, inspectionToken: inspection!.inspectionToken! }, scope, 99],
      [{ taskId, inspectionToken: inspection!.inspectionToken! }, { ...scope, tenantId: 8 }, 0],
      [{ taskId: 'other', inspectionToken: inspection!.inspectionToken! }, scope, 0],
      [{ taskId, inspectionToken: `${inspection!.inspectionToken!}x` }, scope, 0],
    ] as const) {
      const [request, requestScope, actor] = args
      await expect(recoverVideoTask(db, request, requestScope, actor)).rejects.toThrow()
    }
    expect(mocks.webhook).not.toHaveBeenCalled()
  })

  it('never reads files for another tenant and blocks unverified checkpoints or changed evidence', async () => {
    expect(await inspectVideoRecovery(db, taskId, { ...scope, tenantId: 8 }, 0)).toBeNull()
    expect(mocks.evidence).not.toHaveBeenCalled()
    mocks.checkpoints.mockResolvedValueOnce({ eligible: false, errorCode: 'recovery_checkpoint_identity_changed' })
    expect(await inspectVideoRecovery(db, taskId, scope, 0)).toMatchObject({ eligible: false, inspectionToken: null })
    const inspection = await inspectVideoRecovery(db, taskId, scope, 0)
    mocks.evidence.mockResolvedValue({ eligible: true, revisionSha256: 'd'.repeat(64), missingResources: [] })
    await expect(recoverVideoTask(db, { taskId, inspectionToken: inspection!.inspectionToken! }, scope, 0)).rejects.toThrow('recovery_evidence_changed')
    expect(mocks.webhook).not.toHaveBeenCalled()
  })

  it('keeps original task and dispatch lease on an unknown webhook response', async () => {
    const inspection = await inspectVideoRecovery(db, taskId, scope, 0)
    mocks.webhook.mockRejectedValue(new Error('network response lost'))
    const result = await recoverVideoTask(db, { taskId, inspectionToken: inspection!.inspectionToken! }, scope, 0)
    expect(result).toMatchObject({ taskId, currentState: 'queued', errorCode: 'recovery_dispatch_outcome_unknown' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM n8n_task_runs').get()).toEqual({ count: 2 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM n8n_task_dispatch_leases').get()).toEqual({ count: 1 })
  })
})
