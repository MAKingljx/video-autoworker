// @vitest-environment node
import Database from 'better-sqlite3'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { mediaChildIdentity } from '@/lib/n8n-media-workspace'
import { claimScopedN8nTaskRun, createN8nTaskRun, failN8nTaskRun, getScopedN8nTaskRunByTaskId,
  inspectScopedN8nVideoRecoveryState, inspectScopedN8nVideoSegmentRepairState,
  requeueScopedN8nVideoTaskRun, requeueScopedN8nVideoSegmentRepair } from '@/lib/n8n-task-runs'
import { buildVideoLearningResult } from '../../../openclaw-skills/aiworker-task-flow/lib/video-learning-result.mjs'
import { checkN8nCallbackAdmission } from '@/lib/n8n-runtime-affinity'
import { acquireBatchLock, acquireGlobalBatchLock, batchStatePath } from '../../../openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs'

const mocks = vi.hoisted(() => ({ evidence: vi.fn(), checkpoints: vi.fn(), webhook: vi.fn() }))
vi.mock('@/lib/n8n-prepared-evidence', () => ({ inspectPreparedRecoveryEvidence: mocks.evidence }))
vi.mock('@/lib/n8n-media-execution', () => ({ inspectN8nMediaCheckpointReuse: mocks.checkpoints }))
vi.mock('@/lib/n8n', async original => ({ ...await original<typeof import('@/lib/n8n')>(), triggerN8nWebhook: mocks.webhook }))
import { dispatchQueuedVideoSegmentRepair, inspectVideoRecovery, inspectVideoSegmentRepair,
  recoverVideoTask, repairVideoSegments } from '@/lib/n8n-video-recovery'

const scope = { tenantId: 3, workspaceId: 2 }
let db: Database.Database
let bindingId: number
let batchRoot: string
const taskId = 'recovery-parent'
const identity = 'recovery-original-idem'

beforeEach(() => {
  vi.clearAllMocks()
  db = new Database(':memory:')
  batchRoot = realpathSync(mkdtempSync(join(tmpdir(), 'video-segment-repair-')))
  vi.stubEnv('AIWORKER_VIDEO_BATCH_DIR', batchRoot)
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

afterEach(() => { db.close(); vi.unstubAllEnvs(); rmSync(batchRoot, { recursive: true, force: true }) })

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

function seedPartial(visionFailed = true) {
  vi.stubEnv('AIWORKER_SLOT', 'blue')
  vi.stubEnv('AIWORKER_RELEASE_ID', 'release-current')
  vi.stubEnv('PORT', '3317')
  vi.stubEnv('AIWORKER_N8N_CALLBACK_FREEZE_FILE', join(batchRoot, 'current.callbacks-frozen.json'))
  const learningResult = buildVideoLearningResult(3, [
    { index: 2, timeRange: '00:00:05-00:00:10', stage: visionFailed ? 'vision' : 'summary', errorCode: 'N8N_MEDIA_MODEL_OUTPUT_INVALID' },
    { index: 3, timeRange: '00:00:10-00:00:15', stage: 'summary', errorCode: 'N8N_MEDIA_MODEL_OUTPUT_INVALID' },
  ])
  const accepted = getScopedN8nTaskRunByTaskId(db, taskId, scope)!
  const originalRouting = { ...accepted.routing, callbackProtocol: 'slot-v1', runtimeSlot: 'green', runtimeReleaseId: 'release-retired',
    nodeCallbackUrl: 'http://127.0.0.1:3417/api/n8n/node-execute',
    mediaCallbackUrl: 'http://127.0.0.1:3417/api/n8n/media-execute', claimCallbackUrl: 'http://127.0.0.1:3417/api/n8n/claim',
    model: 'qwen38-27b-vl', config: { media: { segmentSeconds: 5 } } }
  db.prepare('UPDATE n8n_task_runs SET routing=? WHERE task_id=?').run(JSON.stringify(originalRouting), taskId)
  for (const stage of ['audio', 'vision', 'finalize'] as const) {
    const childId = mediaChildIdentity('task', taskId, stage)
    createN8nTaskRun(db, { taskId: childId, idempotencyKey: mediaChildIdentity('idem', identity, stage), bindingId,
      source: 'n8n-media-node', requestedBy: 'test', routing: { ...originalRouting, mediaStage: stage },
      taskInput: {}, delivery: { mode: 'none' }, maxAttempts: 2 }, scope)
    db.prepare(`UPDATE n8n_task_runs SET status='succeeded',attempt_count=2,output=? WHERE task_id=?`)
      .run(JSON.stringify(stage === 'finalize' ? { summary: '已有摘要', learningResult } : { stage, segments: [] }), childId)
  }
  db.prepare(`UPDATE n8n_task_runs SET status='succeeded',attempt_count=1,max_attempts=1,
    input=json_set(input,'$.batchId','repair-batch'),output=? WHERE task_id=?`)
    .run(JSON.stringify({ summary: '已有摘要', learningResult }), taskId)
  writeFileSync(batchStatePath('repair-batch', batchRoot), JSON.stringify({ schemaVersion: 2,
    batchId: 'repair-batch', requestFingerprint: 'f'.repeat(64), bindingId, status: 'completed_with_errors', error: null,
    items: [{ taskId, idempotencyKey: identity, status: 'succeeded', learningResult }] }), { mode: 0o600 })
  return learningResult
}

describe('same-task targeted segment repair', () => {
  it('binds a confirmed terminal repair to the current slot while preserving the retired receiver and rejecting its old actor', async () => {
    seedPartial()
    const original = getScopedN8nTaskRunByTaskId(db, taskId, scope)!
    const audioBefore = getScopedN8nTaskRunByTaskId(db, mediaChildIdentity('task', taskId, 'audio'), scope)
    expect(checkN8nCallbackAdmission(original.routing)).toMatchObject({ allowed: false, code: 'runtime_affinity_mismatch' })
    const inspection = await inspectVideoSegmentRepair(db, taskId, scope, 0, [2])
    expect(inspection).toMatchObject({ eligible: true, targetCallbackBinding: {
      callbackProtocol: 'slot-v1', runtimeSlot: 'blue', runtimeReleaseId: 'release-current', port: 3317,
    } })
    expect(Object.keys(inspection!.targetCallbackBinding!)).toHaveLength(4)
    await repairVideoSegments(db, { taskId, inspectionToken: inspection!.inspectionToken!, segmentIndexes: [2] }, scope, 0)
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.routing).toEqual(original.routing)
    const pathname = batchStatePath('repair-batch', batchRoot)
    const pending = JSON.parse(readFileSync(pathname, 'utf8')).items[0].learningRepairRequest
    expect(pending.targetCallbackBinding).toEqual(inspection!.targetCallbackBinding)
    const global = await acquireGlobalBatchLock(pathname)
    const batch = await acquireBatchLock(pathname)
    try {
      await dispatchQueuedVideoSegmentRepair(db, { taskId, requestId: pending.requestId, workerLease: global.lease! }, scope)
    } finally { await batch.release(); await global.release() }
    const repaired = getScopedN8nTaskRunByTaskId(db, taskId, scope)!
    expect(repaired).toMatchObject({ input: original.input, output: original.output, attemptCount: original.attemptCount,
      routing: { callbackProtocol: 'slot-v1', runtimeSlot: 'blue', runtimeReleaseId: 'release-current',
        nodeCallbackUrl: 'http://127.0.0.1:3317/api/n8n/node-execute',
        mediaCallbackUrl: 'http://127.0.0.1:3317/api/n8n/media-execute', claimCallbackUrl: 'http://127.0.0.1:3317/api/n8n/claim',
        model: original.routing.model, config: original.routing.config,
        learningRepair: { previousCallbackBinding: { runtimeSlot: 'green', runtimeReleaseId: 'release-retired', port: 3417 },
          targetCallbackBinding: inspection!.targetCallbackBinding } } })
    expect(checkN8nCallbackAdmission(repaired.routing).allowed).toBe(true)
    expect(getScopedN8nTaskRunByTaskId(db, mediaChildIdentity('task', taskId, 'audio'), scope)).toEqual(audioBefore)
    const beforeOldActor = db.prepare('SELECT * FROM n8n_task_runs ORDER BY id').all()
    expect(claimScopedN8nTaskRun(db, { taskId, idempotencyKey: identity, bindingId,
      executionOwner: 'n8n-execution:original' }, scope).outcome).toBe('rejected')
    expect(db.prepare('SELECT * FROM n8n_task_runs ORDER BY id').all()).toEqual(beforeOldActor)
    expect(mocks.webhook).toHaveBeenCalledOnce()
  })

  it('requires a new confirmation when the target release changes before queueing or dispatch', async () => {
    seedPartial()
    const inspection = await inspectVideoSegmentRepair(db, taskId, scope, 0)
    vi.stubEnv('AIWORKER_RELEASE_ID', 'release-next')
    await expect(repairVideoSegments(db, { taskId, inspectionToken: inspection!.inspectionToken! }, scope, 0)).rejects.toThrow('recovery_revision_changed')
    expect(JSON.parse(readFileSync(batchStatePath('repair-batch', batchRoot), 'utf8')).status).toBe('completed_with_errors')
    vi.stubEnv('AIWORKER_RELEASE_ID', 'release-current')
    await repairVideoSegments(db, { taskId, inspectionToken: inspection!.inspectionToken! }, scope, 0)
    const pathname = batchStatePath('repair-batch', batchRoot)
    const pending = JSON.parse(readFileSync(pathname, 'utf8')).items[0].learningRepairRequest
    const original = getScopedN8nTaskRunByTaskId(db, taskId, scope)!
    vi.stubEnv('AIWORKER_RELEASE_ID', 'release-next')
    const global = await acquireGlobalBatchLock(pathname)
    const batch = await acquireBatchLock(pathname)
    try {
      await expect(dispatchQueuedVideoSegmentRepair(db, { taskId, requestId: pending.requestId,
        workerLease: global.lease! }, scope)).rejects.toThrow('recovery_target_callback_binding_changed')
    } finally { await batch.release(); await global.release() }
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)).toEqual(original)
    expect(mocks.webhook).not.toHaveBeenCalled()
  })

  it('keeps current freeze and original lease protections when rebinding a retired terminal source', async () => {
    seedPartial()
    writeFileSync(join(batchRoot, 'current.callbacks-frozen.json'), '{}', { mode: 0o600 })
    expect(await inspectVideoSegmentRepair(db, taskId, scope, 0)).toMatchObject({ eligible: false,
      errorCode: 'recovery_target_callback_freeze_invalid', inspectionToken: null })
    unlinkSync(join(batchRoot, 'current.callbacks-frozen.json'))
    db.prepare(`INSERT INTO n8n_task_dispatch_leases (task_id,tenant_id,workspace_id,owner_token,lease_expires_at,revision)
      VALUES (?,3,2,?,1,1)`).run(taskId, 'b'.repeat(64))
    expect(await inspectVideoSegmentRepair(db, taskId, scope, 0)).toMatchObject({ eligible: false,
      errorCode: 'recovery_dispatch_in_progress', inspectionToken: null })
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.routing.runtimeSlot).toBe('green')
    expect(mocks.webhook).not.toHaveBeenCalled()
  })

  it('preserves successful outputs and counters while granting one explicit bounded repair round', () => {
    const previousLearningResult = seedPartial()
    const parentBefore = getScopedN8nTaskRunByTaskId(db, taskId, scope)!
    const preserved = ['prepare', 'audio'].map(stage => db.prepare('SELECT * FROM n8n_task_runs WHERE task_id=?')
      .get(mediaChildIdentity('task', taskId, stage)))
    const inspection = inspectScopedN8nVideoSegmentRepairState(db, taskId, scope, [2])
    expect(inspection).toMatchObject({ outcome: 'eligible', indexes: [2], stages: ['vision', 'finalize'], generation: 1 })
    const repaired = requeueScopedN8nVideoSegmentRepair(db, { taskId,
      expectedRevisionSha256: inspection.revisionSha256!, segmentIndexes: [2] }, scope)
    expect(repaired).toMatchObject({ outcome: 'queued', run: { taskId, idempotencyKey: identity,
      attemptCount: 1, maxAttempts: 2, output: parentBefore.output,
      routing: { learningRepair: { generation: 1, indexes: [2], previousAttempts: 1, attemptLimit: 2, previousLearningResult } } } })
    for (const [index, stage] of ['prepare', 'audio'].entries()) {
      expect(db.prepare('SELECT * FROM n8n_task_runs WHERE task_id=?').get(mediaChildIdentity('task', taskId, stage))).toEqual(preserved[index])
    }
    for (const stage of ['vision', 'finalize']) expect(getScopedN8nTaskRunByTaskId(db,
      mediaChildIdentity('task', taskId, stage), scope)).toMatchObject({ status: 'queued', attemptCount: 2, maxAttempts: 4 })
    expect(claimScopedN8nTaskRun(db, { taskId, idempotencyKey: identity, bindingId, executionOwner: 'n8n-execution:original' }, scope).outcome).toBe('rejected')
    expect(claimScopedN8nTaskRun(db, { taskId, idempotencyKey: identity, bindingId, executionOwner: 'n8n-execution:repair-1' }, scope).outcome).toBe('claimed')
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.attemptCount).toBe(2)
  })

  it('re-enters only synthesis for a summary-only failure and does not admit successful or cross-tenant indexes', () => {
    seedPartial(false)
    const vision = db.prepare('SELECT * FROM n8n_task_runs WHERE task_id=?').get(mediaChildIdentity('task', taskId, 'vision'))
    expect(inspectScopedN8nVideoSegmentRepairState(db, taskId, scope, [1]).errorCode).toBe('recovery_repair_segments_invalid')
    expect(inspectScopedN8nVideoSegmentRepairState(db, taskId, { ...scope, tenantId: 8 }).outcome).toBe('not_found')
    const inspection = inspectScopedN8nVideoSegmentRepairState(db, taskId, scope)
    expect(inspection.stages).toEqual(['finalize'])
    expect(requeueScopedN8nVideoSegmentRepair(db, { taskId, expectedRevisionSha256: inspection.revisionSha256! }, scope).outcome).toBe('queued')
    expect(db.prepare('SELECT * FROM n8n_task_runs WHERE task_id=?').get(mediaChildIdentity('task', taskId, 'vision'))).toEqual(vision)
  })

  it('rejects stale confirmations, exhausted rounds and unknown historical failures without changing rows', () => {
    expect(inspectScopedN8nVideoSegmentRepairState(db, taskId, scope).errorCode).toBe('recovery_partial_result_required')
    seedPartial()
    const inspection = inspectScopedN8nVideoSegmentRepairState(db, taskId, scope)
    db.prepare('UPDATE n8n_task_runs SET updated_at=updated_at+1 WHERE task_id=?').run(taskId)
    expect(requeueScopedN8nVideoSegmentRepair(db, { taskId, expectedRevisionSha256: inspection.revisionSha256! }, scope).outcome).toBe('conflict')
    const run = getScopedN8nTaskRunByTaskId(db, taskId, scope)!
    db.prepare('UPDATE n8n_task_runs SET routing=? WHERE task_id=?')
      .run(JSON.stringify({ ...run.routing, learningRepair: { generation: 3, indexes: [2] } }), taskId)
    expect(inspectScopedN8nVideoSegmentRepairState(db, taskId, scope).errorCode).toBe('recovery_repair_rounds_exhausted')
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('succeeded')
  })

  it('seals the selected failed indexes and queues the original task until its sole worker owns the lane', async () => {
    seedPartial()
    const inspection = await inspectVideoSegmentRepair(db, taskId, scope, 0, [2])
    expect(inspection).toMatchObject({ eligible: true, mode: 'repair-segments', segmentIndexes: [2],
      nextAction: 'confirm_failed_segment_repair' })
    expect(mocks.webhook).not.toHaveBeenCalled()
    await expect(repairVideoSegments(db, { taskId, inspectionToken: inspection!.inspectionToken!, segmentIndexes: [3] }, scope, 0)).rejects.toThrow()
    await expect(repairVideoSegments(db, { taskId, inspectionToken: inspection!.inspectionToken!, segmentIndexes: [2] }, scope, 99)).rejects.toThrow('recovery_confirmation_scope_mismatch')
    expect(mocks.webhook).not.toHaveBeenCalled()
    const result = await repairVideoSegments(db, { taskId, inspectionToken: inspection!.inspectionToken!, segmentIndexes: [2] }, scope, 0)
    expect(result.currentState).toBe('queued')
    expect(mocks.webhook).not.toHaveBeenCalled()
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('succeeded')
    const pathname = batchStatePath('repair-batch', batchRoot)
    const state = JSON.parse(readFileSync(pathname, 'utf8'))
    expect(state).toMatchObject({ status: 'queued', items: [{ taskId, status: 'queued',
      learningRepairRequest: { segmentIndexes: [2] } }] })
    const input = { taskId, requestId: state.items[0].learningRepairRequest.requestId }
    await expect(dispatchQueuedVideoSegmentRepair(db, { ...input,
      workerLease: { pid: process.pid, token: '00000000-0000-4000-8000-000000000000' } }, scope)).rejects.toThrow()
    expect(mocks.webhook).not.toHaveBeenCalled()
    const global = await acquireGlobalBatchLock(pathname)
    const batch = await acquireBatchLock(pathname)
    try {
      expect(global.acquired && batch.acquired).toBe(true)
      const dispatched = await dispatchQueuedVideoSegmentRepair(db, { ...input, workerLease: global.lease! }, scope)
      expect(dispatched.currentState).toBe('accepted')
      const duplicate = await dispatchQueuedVideoSegmentRepair(db, { ...input, workerLease: global.lease! }, scope)
      expect(duplicate.currentState).toBe('accepted')
    } finally { await batch.release(); await global.release() }
    expect(mocks.webhook).toHaveBeenCalledOnce()
    expect(mocks.webhook.mock.calls[0][1]).toMatchObject({ taskId, idempotencyKey: identity })
  })

  it('blocks an unsettled lease or missing trusted evidence before granting a repair token', async () => {
    seedPartial()
    mocks.checkpoints.mockResolvedValueOnce({ eligible: false, errorCode: 'recovery_checkpoint_identity_changed' })
    expect(await inspectVideoSegmentRepair(db, taskId, scope, 0)).toMatchObject({ eligible: false, inspectionToken: null })
    db.prepare(`INSERT INTO n8n_child_execution_leases (task_id,tenant_id,workspace_id,owner_instance_id,lease_token,
      lease_expires_at,heartbeat_at,revision,created_at,updated_at) VALUES (?,3,2,?,?,1,1,1,1,1)`)
      .run(mediaChildIdentity('task', taskId, 'vision'), 'e'.repeat(64), 'c'.repeat(64))
    expect(await inspectVideoSegmentRepair(db, taskId, scope, 0)).toMatchObject({ eligible: false,
      errorCode: 'recovery_child_lease_unsettled', inspectionToken: null })
    expect(mocks.webhook).not.toHaveBeenCalled()
  })

  it('requires the private original batch and never manufactures a parallel queue', async () => {
    seedPartial()
    const pathname = batchStatePath('repair-batch', batchRoot)
    chmodSync(pathname, 0o644)
    expect(await inspectVideoSegmentRepair(db, taskId, scope, 0)).toMatchObject({ eligible: false,
      errorCode: 'recovery_batch_file_invalid', inspectionToken: null })
    unlinkSync(pathname)
    expect(await inspectVideoSegmentRepair(db, taskId, scope, 0)).toMatchObject({ eligible: false, inspectionToken: null })
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('succeeded')
    expect(mocks.webhook).not.toHaveBeenCalled()
  })

  it('revalidates persisted confirmation against changed output before a queued worker can dispatch', async () => {
    seedPartial()
    const inspection = await inspectVideoSegmentRepair(db, taskId, scope, 0)
    await repairVideoSegments(db, { taskId, inspectionToken: inspection!.inspectionToken! }, scope, 0)
    const pathname = batchStatePath('repair-batch', batchRoot)
    const pending = JSON.parse(readFileSync(pathname, 'utf8')).items[0].learningRepairRequest
    db.prepare(`UPDATE n8n_task_runs SET output=json_set(output,'$.summary','changed') WHERE task_id=?`).run(taskId)
    const global = await acquireGlobalBatchLock(pathname)
    const batch = await acquireBatchLock(pathname)
    try {
      await expect(dispatchQueuedVideoSegmentRepair(db, { taskId, requestId: pending.requestId,
        workerLease: global.lease! }, scope)).rejects.toThrow('recovery_revision_changed')
    } finally { await batch.release(); await global.release() }
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('succeeded')
    expect(mocks.webhook).not.toHaveBeenCalled()
  })

  it('converges two overlapping dispatch requests after the first commits instead of rejecting the stale second snapshot', async () => {
    seedPartial()
    const inspection = await inspectVideoSegmentRepair(db, taskId, scope, 0)
    await repairVideoSegments(db, { taskId, inspectionToken: inspection!.inspectionToken! }, scope, 0)
    const pathname = batchStatePath('repair-batch', batchRoot)
    const pending = JSON.parse(readFileSync(pathname, 'utf8')).items[0].learningRepairRequest
    const global = await acquireGlobalBatchLock(pathname)
    const batch = await acquireBatchLock(pathname)
    const entered: Array<() => void> = []
    const release: Array<() => void> = []
    const seen = [0, 1].map(index => new Promise<void>(resolve => { entered[index] = resolve }))
    const gates = [0, 1].map(index => new Promise<void>(resolve => { release[index] = resolve }))
    let index = 0
    mocks.checkpoints.mockImplementation(async () => {
      const position = index++
      entered[position]()
      await gates[position]
      return { eligible: true, errorCode: null }
    })
    mocks.webhook.mockImplementation(async () => {
      const claimed = claimScopedN8nTaskRun(db, { taskId, idempotencyKey: identity, bindingId,
        executionOwner: 'n8n-execution:concurrent-repair' }, scope)
      expect(claimed.outcome).toBe('claimed')
      return { statusCode: 202, ok: true, latencyMs: 1 }
    })
    try {
      const input = { taskId, requestId: pending.requestId, workerLease: global.lease! }
      const first = dispatchQueuedVideoSegmentRepair(db, input, scope)
      await seen[0]
      const second = dispatchQueuedVideoSegmentRepair(db, input, scope)
      await seen[1]
      release[0]()
      expect(await first).toMatchObject({ currentState: 'running' })
      release[1]()
      expect(await second).toMatchObject({ currentState: 'running' })
      expect(mocks.webhook).toHaveBeenCalledOnce()
      expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.attemptCount).toBe(2)
      await expect(dispatchQueuedVideoSegmentRepair(db, { ...input,
        workerLease: { ...input.workerLease, token: '00000000-0000-4000-8000-000000000000' } }, scope)).rejects.toThrow()
    } finally { release.forEach(resolve => resolve()); await batch.release(); await global.release() }
  })
})
