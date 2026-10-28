// @vitest-environment node
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { claimScopedN8nTaskRun, completeN8nChildExecution, completeN8nTaskRun,
  createAndClaimN8nChildRunFromParent, createN8nTaskRun, getScopedN8nTaskRunByTaskId,
  failN8nChildExecution, hasScopedN8nVideoStopRequest, readN8nMediaProviderExecutionRisk,
  runWithN8nChildExecutionHeartbeat } from '@/lib/n8n-task-runs'
import { captureMediaProviderObservation, mediaProviderRequestStarted, mediaProviderRequestFinished,
  type N8nMediaExecutionControl } from '@/lib/n8n-media-control'
import { mediaChildIdentity } from '@/lib/n8n-media-workspace'
import { acquireN8nTaskDispatchOwnership } from '@/lib/n8n-task-dispatch'
import { claimScopedVideoStop, drainScopedVideoStops, inspectScopedVideoStop, observeScopedVideoStopProof,
  recordScopedN8nVideoChildStopAck, requestScopedVideoStop, settleScopedVideoStop,
  recordScopedN8nVideoChildStopUnconfirmed,
  type N8nVideoStopLease, type N8nVideoStopProof } from '@/lib/n8n-video-stop'

const scope = { tenantId: 3, workspaceId: 2 }
const taskId = 'video-stop-original'
const identity = 'video-stop-original-idem'
const executionOwner = 'n8n-execution:original-workflow:381'
const audioId = mediaChildIdentity('task', taskId, 'audio')
const prepareId = mediaChildIdentity('task', taskId, 'prepare')
let db: Database.Database
let bindingId: number
let n8nRoot: string
let n8nPath: string
let audioLease: NonNullable<ReturnType<typeof createAndClaimN8nChildRunFromParent>['lease']>
const idleControl = (): N8nMediaExecutionControl => ({ signal: new AbortController().signal, assertActive() {} })
function seed() {
  bindingId = Number(db.prepare(`INSERT INTO n8n_workflow_bindings
    (name,task_type,workflow_id,webhook_path,agent_role,model,enabled,timeout_seconds,retry_count,config,workspace_id,tenant_id)
    VALUES ('video','video-analysis','original-workflow','webhook/video','executor','model',1,30,2,'{}',2,3)`).run().lastInsertRowid)
  createN8nTaskRun(db, { taskId, idempotencyKey: identity, bindingId, source: 'openclaw', requestedBy: 'test',
    routing: { taskType: 'video-analysis', callbackProtocol: 'legacy-v1',
      dispatchIdentity: { workflowId: 'original-workflow', webhookPath: 'webhook/video' } },
    taskInput: { videoKey: 'original.mp4' }, delivery: { mode: 'none' }, maxAttempts: 3 }, scope)
  claimScopedN8nTaskRun(db, { taskId, idempotencyKey: identity, bindingId, executionOwner }, scope)
  const prepared = createAndClaimN8nChildRunFromParent(db, { parentTaskId: taskId, parentIdempotencyKey: identity,
    childTaskId: prepareId, childIdempotencyKey: mediaChildIdentity('idem', identity, 'prepare'), bindingId,
    source: 'n8n-media-node', routing: { mediaStage: 'prepare' }, taskInput: {}, delivery: { mode: 'none' },
    maxAttempts: 2, ownerInstanceId: 'e'.repeat(64), executionOwner }, scope)
  completeN8nChildExecution(db, prepared.lease!, { saved: 'prepare-success' }, scope, {
    providerObservation: captureMediaProviderObservation(idleControl()),
  })
  audioLease = createAndClaimN8nChildRunFromParent(db, { parentTaskId: taskId,
    parentIdempotencyKey: identity, bindingId, childTaskId: audioId,
    childIdempotencyKey: mediaChildIdentity('idem', identity, 'audio'), source: 'n8n-media-node',
    routing: { mediaStage: 'audio' }, taskInput: {}, delivery: { mode: 'none' }, maxAttempts: 2,
    ownerInstanceId: 'a'.repeat(64), executionOwner }, scope).lease!
}
function request() {
  const inspection = inspectScopedVideoStop(db, taskId, scope)!
  return requestScopedVideoStop(db, { taskId, expectedRevision: inspection.expectedRevision }, scope, 0)
}
function claim() {
  const intent = request().stop!
  return claimScopedVideoStop(db, taskId, intent.requestId, 'b'.repeat(64), scope).lease!
}
function proof(lease: N8nVideoStopLease): N8nVideoStopProof {
  return observeScopedVideoStopProof(db, lease, scope)
}
function execution(status: string, stoppedAt: string | null) {
  const external = new Database(n8nPath)
  external.prepare('UPDATE execution_entity SET status=?,stoppedAt=? WHERE id=381').run(status, stoppedAt)
  external.close()
}
beforeEach(() => {
  db = new Database(':memory:'); runMigrations(db); seed()
  n8nRoot = realpathSync(mkdtempSync(join(tmpdir(), 'stop-n8n-observation-')))
  n8nPath = join(n8nRoot, 'database.sqlite')
  const external = new Database(n8nPath)
  external.exec('CREATE TABLE execution_entity(id INTEGER PRIMARY KEY,workflowId TEXT,status TEXT,stoppedAt TEXT)')
  external.prepare('INSERT INTO execution_entity VALUES (381,?,?,?)').run('original-workflow', 'error', new Date().toISOString())
  external.close(); chmodSync(n8nPath, 0o600)
  vi.stubEnv('AIWORKER_VIDEO_STOP_TEST_MODE', '1'); vi.stubEnv('AIWORKER_TEST_N8N_DB_PATH', n8nPath)
})
afterEach(() => { db.close(); rmSync(n8nRoot, { recursive: true, force: true }); vi.unstubAllEnvs() })

describe('durable scoped video stop authority', () => {
  it('keeps inspection read-only and intent idempotent without changing the running task or successes', () => {
    const saved = db.prepare('SELECT * FROM n8n_task_runs WHERE task_id=?').get(prepareId)
    const parent = getScopedN8nTaskRunByTaskId(db, taskId, scope)
    const inspection = inspectScopedVideoStop(db, taskId, scope)!
    expect(inspection).toMatchObject({ eligible: true, status: 'running', preservedStages: ['prepare'], stop: null })
    expect(db.prepare('SELECT COUNT(*) count FROM n8n_video_stop_requests').get()).toEqual({ count: 0 })
    const first = request()
    const replay = requestScopedVideoStop(db, { taskId, expectedRevision: 'f'.repeat(64) }, scope, 1)
    expect(first.outcome).toBe('requested')
    expect(replay).toMatchObject({ outcome: 'existing', stop: { requestId: first.stop!.requestId, currentState: 'requested' } })
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)).toEqual(parent)
    expect(db.prepare('SELECT * FROM n8n_task_runs WHERE task_id=?').get(prepareId)).toEqual(saved)
    expect(JSON.stringify(first.stop)).not.toMatch(/leaseToken|snapshot_json|executionOwner|ownerInstance/)
  })

  it('rejects wrong scope and stale CAS without adding an intent', () => {
    const inspection = inspectScopedVideoStop(db, taskId, scope)!
    expect(() => requestScopedVideoStop(db, { taskId, expectedRevision: inspection.expectedRevision },
      { ...scope, tenantId: 7 }, 0)).toThrow('stop_task_not_found')
    db.prepare('UPDATE n8n_task_runs SET updated_at=updated_at+1 WHERE task_id=?').run(taskId)
    expect(() => requestScopedVideoStop(db, { taskId, expectedRevision: inspection.expectedRevision }, scope, 0)).toThrow('stop_revision_changed')
    expect(db.prepare('SELECT COUNT(*) count FROM n8n_video_stop_requests').get()).toEqual({ count: 0 })
  })

  it('lets a natural completion win first and creates no stop request', () => {
    completeN8nChildExecution(db, audioLease, { saved: 'audio' }, scope)
    completeN8nTaskRun(db, taskId, { saved: 'finished' })
    expect(request()).toMatchObject({ outcome: 'already_terminal', status: 'succeeded', stop: null })
    expect(db.prepare('SELECT COUNT(*) count FROM n8n_video_stop_requests').get()).toEqual({ count: 0 })
  })

  it('fences old SQL writers and future children while leaving another task unchanged', () => {
    request()
    expect(() => db.prepare(`UPDATE n8n_task_runs SET status='succeeded',output='{}' WHERE task_id=?`).run(audioId))
      .toThrow('N8N_VIDEO_STOP_REQUESTED')
    expect(() => db.prepare(`UPDATE n8n_task_runs SET output='{}' WHERE task_id=?`).run(prepareId)).toThrow('N8N_VIDEO_STOP_REQUESTED')
    expect(() => db.prepare(`UPDATE n8n_child_execution_leases SET heartbeat_at=heartbeat_at+1 WHERE task_id=?`).run(audioId))
      .toThrow('N8N_VIDEO_STOP_REQUESTED')
    expect(() => createN8nTaskRun(db, { taskId: mediaChildIdentity('task', taskId, 'vision'),
      idempotencyKey: mediaChildIdentity('idem', identity, 'vision'), bindingId, source: 'n8n-media-node', requestedBy: 'late-old-callback',
      routing: { mediaStage: 'vision' }, taskInput: {}, delivery: { mode: 'none' }, maxAttempts: 2 }, scope))
      .toThrow('N8N_VIDEO_STOP_REQUESTED')
    expect(claimScopedN8nTaskRun(db, { taskId, idempotencyKey: identity, bindingId, executionOwner }, scope).outcome).toBe('rejected')
    expect(acquireN8nTaskDispatchOwnership(db, taskId, scope).outcome).toBe('ineligible')
    expect(hasScopedN8nVideoStopRequest(db, audioId, scope)).toBe(true)
    createN8nTaskRun(db, { taskId: 'unrelated', idempotencyKey: 'unrelated-idem', bindingId, source: 'openclaw', requestedBy: 'test',
      routing: { taskType: 'video-analysis' }, taskInput: {}, delivery: { mode: 'none' }, maxAttempts: 2 }, scope)
    expect(claimScopedN8nTaskRun(db, { taskId: 'unrelated', idempotencyKey: 'unrelated-idem', bindingId,
      executionOwner: 'n8n-execution:other:999' }, scope).outcome).toBe('claimed')
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('running')
  })

  it('serializes stop executors and rejects a stale owner after lease takeover', () => {
    const first = claim()
    expect(claimScopedVideoStop(db, taskId, first.requestId, 'e'.repeat(64), scope).lease).toBeNull()
    db.prepare('UPDATE n8n_video_stop_requests SET lease_expires_at=0').run()
    const next = claimScopedVideoStop(db, taskId, first.requestId, 'e'.repeat(64), scope).lease!
    expect(next.revision).toBeGreaterThan(first.revision)
    expect(() => settleScopedVideoStop(db, first, scope, proof(next))).toThrow('stop_execution_lease_changed')
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('running')
  })

  it.each(['local-global-unknown', 'provider-unknown', 'provider-global-unknown', 'n8n-unknown', 'proof-binding'])(
    'keeps an unknown actual termination blocked: %s', kind => {
      if (kind === 'local-global-unknown') db.prepare(`UPDATE n8n_task_runs SET routing=json_remove(routing,'$.executionControlVersion') WHERE task_id=?`).run(audioId)
      const lease = claim()
      recordScopedN8nVideoChildStopAck(db, audioLease, scope, {
        providerCancellation: kind === 'provider-unknown' ? 'provider_unconfirmed' : 'confirmed',
      })
      if (kind === 'n8n-unknown') execution('unknown', null)
      if (kind === 'provider-global-unknown') {
        const row = db.prepare('SELECT local_ack_json FROM n8n_video_stop_requests').get() as { local_ack_json: string }
        const value = JSON.parse(row.local_ack_json); value[audioId].providerCancellation = 'invalid'
        db.prepare('UPDATE n8n_video_stop_requests SET local_ack_json=?').run(JSON.stringify(value))
      }
      const observed = proof(lease)
      const evidence = kind === 'proof-binding' ? { ...observed, snapshotSha256: 'f'.repeat(64) } : observed
      expect(settleScopedVideoStop(db, lease, scope, evidence)).toMatchObject({ outcome: 'blocked', stop: { currentState: 'blocked' } })
      expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('running')
      expect(getScopedN8nTaskRunByTaskId(db, audioId, scope)?.status).toBe('running')
      expect(db.prepare('SELECT COUNT(*) count FROM n8n_child_execution_leases').get()).toEqual({ count: 1 })
    })

  it('keeps controlled pending execution stopping and lets the existing drain finish after real n8n terminal observation', () => {
    execution('running', null)
    request()
    expect(drainScopedVideoStops(db)).toMatchObject({ scanned: 1, stopping: 1, stopped: 0 })
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('running')
    recordScopedN8nVideoChildStopAck(db, audioLease, scope, { providerCancellation: 'confirmed' })
    expect(drainScopedVideoStops(db)).toMatchObject({ stopping: 1, stopped: 0 })
    execution('error', new Date().toISOString())
    expect(drainScopedVideoStops(db)).toMatchObject({ stopped: 1, blocked: 0 })
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('cancelled')
  })

  it('does not starve runtime stop settlement behind ten older batch-owner acknowledgements', () => {
    for (let index = 0; index < 10; index += 1) {
      const pendingId = `batch-stop-${index}`
      db.prepare(`INSERT INTO n8n_video_stop_requests(request_id,task_id,target_kind,binding_id,tenant_id,workspace_id,
        requested_by_id,state,snapshot_json,snapshot_sha256,child_task_ids_json,updated_at)
        VALUES (?,?,'batch_item',?,3,2,0,'stopping','{}',?,?,1)`)
        .run(index.toString(16).padStart(64, '0'), pendingId, bindingId, 'a'.repeat(64),
          JSON.stringify(['prepare', 'audio', 'vision', 'finalize'].map(stage => mediaChildIdentity('task', pendingId, stage))))
    }
    request()
    recordScopedN8nVideoChildStopAck(db, audioLease, scope, { providerCancellation: 'confirmed' })
    expect(drainScopedVideoStops(db)).toMatchObject({ scanned: 1, stopped: 1 })
    expect(db.prepare(`SELECT COUNT(*) count FROM n8n_video_stop_requests WHERE target_kind='batch_item'
      AND state='stopping' AND updated_at=1`).get()).toEqual({ count: 10 })
  })

  it('rejects copied caller JSON even when it repeats valid system observations', () => {
    const lease = claim()
    recordScopedN8nVideoChildStopAck(db, audioLease, scope, { providerCancellation: 'confirmed' })
    expect(settleScopedVideoStop(db, lease, scope, { ...proof(lease) }).stop)
      .toMatchObject({ currentState: 'blocked', errorCode: 'stop_proof_not_system_observed' })
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('running')
  })

  it.each([true, false])('only certifies a queued task as undispatched with its server admission proof (current=%s)', current => {
    createN8nTaskRun(db, { taskId: 'queued-stop', idempotencyKey: 'queued-stop-idem', bindingId,
      source: 'openclaw', requestedBy: 'test', routing: { taskType: 'video-analysis' }, taskInput: {},
      delivery: { mode: 'none' }, maxAttempts: 2 }, scope)
    if (!current) db.prepare(`UPDATE n8n_task_runs SET routing=json_remove(routing,'$.executionControlVersion') WHERE task_id='queued-stop'`).run()
    const inspection = inspectScopedVideoStop(db, 'queued-stop', scope)!
    requestScopedVideoStop(db, { taskId: 'queued-stop', expectedRevision: inspection.expectedRevision }, scope, 0)
    expect(drainScopedVideoStops(db)).toMatchObject(current ? { stopped: 1 } : { blocked: 1, stopped: 0 })
    expect(getScopedN8nTaskRunByTaskId(db, 'queued-stop', scope)?.status).toBe(current ? 'cancelled' : 'queued')
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('running')
  })

  it('cancels only after actual local/provider/n8n proofs and preserves every successful row', () => {
    const saved = db.prepare('SELECT * FROM n8n_task_runs WHERE task_id=?').get(prepareId)
    const lease = claim()
    expect(recordScopedN8nVideoChildStopAck(db, audioLease, scope, { providerCancellation: 'confirmed' })).toBe(true)
    const evidence = proof(lease)
    expect(settleScopedVideoStop(db, lease, scope, evidence)).toMatchObject({ outcome: 'stopped', stop: { currentState: 'stopped' } })
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('cancelled')
    expect(getScopedN8nTaskRunByTaskId(db, audioId, scope)?.status).toBe('cancelled')
    expect(db.prepare('SELECT * FROM n8n_task_runs WHERE task_id=?').get(prepareId)).toEqual(saved)
    expect(db.prepare('SELECT COUNT(*) count FROM n8n_child_execution_leases').get()).toEqual({ count: 0 })
    expect(db.prepare('SELECT COUNT(*) count FROM n8n_parent_execution_claims').get()).toEqual({ count: 0 })
    expect(settleScopedVideoStop(db, lease, scope, evidence).outcome).toBe('stopped')
    expect(request().outcome).toBe('existing')
  })

  it('observes the accepted original workflow after its binding is retargeted by an upgrade', () => {
    db.prepare(`UPDATE n8n_workflow_bindings SET workflow_id='next-workflow' WHERE id=?`).run(bindingId)
    request()
    recordScopedN8nVideoChildStopAck(db, audioLease, scope, { providerCancellation: 'confirmed' })
    expect(drainScopedVideoStops(db)).toMatchObject({ stopped: 1, blocked: 0 })
    expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('cancelled')
  })

  it('persists a failed provider attempt before deleting its lease and never clears it after a successful retry', () => {
    const first = idleControl()
    mediaProviderRequestStarted(first)
    expect(failN8nChildExecution(db, audioLease, 'provider timeout', scope, {
      providerObservation: captureMediaProviderObservation(first),
    }).settled).toBe(true)
    const retry = createAndClaimN8nChildRunFromParent(db, { parentTaskId: taskId, parentIdempotencyKey: identity,
      bindingId, childTaskId: audioId, childIdempotencyKey: mediaChildIdentity('idem', identity, 'audio'),
      source: 'n8n-media-node', routing: { mediaStage: 'audio' }, taskInput: {}, delivery: { mode: 'none' },
      maxAttempts: 2, ownerInstanceId: 'f'.repeat(64), executionOwner }, scope)
    expect(completeN8nChildExecution(db, retry.lease!, { transcript: 'retry succeeded' }, scope, {
      providerObservation: captureMediaProviderObservation(idleControl()),
    }).settled).toBe(true)
    const result = getScopedN8nTaskRunByTaskId(db, audioId, scope)!
    expect((result.routing.providerExecutionReceipts as Array<{ status: string }>).map(value => value.status))
      .toEqual(['unconfirmed', 'not_started'])
    expect(readN8nMediaProviderExecutionRisk(result).status).toBe('unconfirmed')
    expect(db.prepare('SELECT COUNT(*) count FROM n8n_child_execution_leases').get()).toEqual({ count: 0 })
    request()
    expect(drainScopedVideoStops(db)).toMatchObject({ blocked: 1, stopped: 0 })
  })

  it('keeps timeout-then-fallback success risk across database restart and a later finalize stop', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'provider-stop-restart-')))
    const pathname = join(root, 'mission.sqlite')
    try {
      db.close(); db = new Database(pathname); runMigrations(db); seed()
      completeN8nChildExecution(db, audioLease, { transcript: 'complete' }, scope,
        { providerObservation: captureMediaProviderObservation(idleControl()) })
      const visionId = mediaChildIdentity('task', taskId, 'vision')
      const vision = createAndClaimN8nChildRunFromParent(db, { parentTaskId: taskId, parentIdempotencyKey: identity,
        bindingId, childTaskId: visionId, childIdempotencyKey: mediaChildIdentity('idem', identity, 'vision'),
        source: 'n8n-media-node', routing: { mediaStage: 'vision' }, taskInput: {}, delivery: { mode: 'none' },
        maxAttempts: 2, ownerInstanceId: 'c'.repeat(64), executionOwner }, scope)
      const control = idleControl()
      mediaProviderRequestStarted(control) // The first request timed out without provider confirmation.
      mediaProviderRequestStarted(control); mediaProviderRequestFinished(control) // Only the fallback returned 2xx.
      completeN8nChildExecution(db, vision.lease!, { visualAnalysis: 'fallback output' }, scope,
        { providerObservation: captureMediaProviderObservation(control) })
      expect(db.prepare('SELECT COUNT(*) count FROM n8n_child_execution_leases').get()).toEqual({ count: 0 })
      db.close(); db = new Database(pathname); runMigrations(db)
      expect(readN8nMediaProviderExecutionRisk(getScopedN8nTaskRunByTaskId(db, visionId, scope)!).status).toBe('unconfirmed')
      const finalId = mediaChildIdentity('task', taskId, 'finalize')
      const final = createAndClaimN8nChildRunFromParent(db, { parentTaskId: taskId, parentIdempotencyKey: identity,
        bindingId, childTaskId: finalId, childIdempotencyKey: mediaChildIdentity('idem', identity, 'finalize'),
        source: 'n8n-media-node', routing: { mediaStage: 'finalize' }, taskInput: {}, delivery: { mode: 'none' },
        maxAttempts: 2, ownerInstanceId: 'd'.repeat(64), executionOwner }, scope)
      request()
      recordScopedN8nVideoChildStopAck(db, final.lease!, scope, { providerCancellation: 'not_started' })
      expect(drainScopedVideoStops(db)).toMatchObject({ blocked: 1, stopped: 0 })
      expect(inspectScopedVideoStop(db, taskId, scope)?.stop?.errorCode).toBe('stop_provider_unconfirmed')
    } finally { db.close(); db = new Database(':memory:'); rmSync(root, { recursive: true, force: true }) }
  })

  it('does not persist provider receipts across tenant boundaries or trust a copied observation', () => {
    const real = captureMediaProviderObservation(idleControl())
    expect(completeN8nChildExecution(db, audioLease, { transcript: 'foreign' }, { ...scope, tenantId: 7 },
      { providerObservation: real }).settled).toBe(false)
    expect(getScopedN8nTaskRunByTaskId(db, audioId, scope)!.routing).not.toHaveProperty('providerExecutionReceipts')
    completeN8nChildExecution(db, audioLease, { transcript: 'untrusted metadata' }, scope,
      { providerObservation: { ...real } })
    expect(readN8nMediaProviderExecutionRisk(getScopedN8nTaskRunByTaskId(db, audioId, scope)!).status).toBe('unconfirmed')
  })

  it('rejects oversized provider history instead of pruning an old risk or resetting the attempt budget', () => {
    const row = getScopedN8nTaskRunByTaskId(db, audioId, scope)!
    db.prepare('UPDATE n8n_task_runs SET routing=? WHERE task_id=?').run(JSON.stringify({ ...row.routing,
      providerExecutionReceipts: Array.from({ length: 12 }, () => ({})) }), audioId)
    expect(() => completeN8nChildExecution(db, audioLease, { transcript: 'do not overwrite history' }, scope,
      { providerObservation: captureMediaProviderObservation(idleControl()) })).toThrow('N8N_MEDIA_PROVIDER_RECEIPT_CONFLICT')
    expect(getScopedN8nTaskRunByTaskId(db, audioId, scope)).toMatchObject({ status: 'running', attemptCount: 1 })
    expect(db.prepare('SELECT COUNT(*) count FROM n8n_child_execution_leases').get()).toEqual({ count: 1 })
  })

  it('aborts the live execution control from durable intent without consuming a model retry', async () => {
    const running = runWithN8nChildExecutionHeartbeat(db, audioLease, scope, async control =>
      new Promise((_resolve, reject) => control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true })),
    { stopPollMilliseconds: 5 })
    const timer = setTimeout(() => request(), 10)
    try { await expect(running).rejects.toMatchObject({ code: 'N8N_VIDEO_STOP_REQUESTED' }) }
    finally { clearTimeout(timer) }
    expect(getScopedN8nTaskRunByTaskId(db, audioId, scope)).toMatchObject({ status: 'running', attemptCount: 1, error: null })
  })

  it('preserves an uncertain process termination instead of converting it into a positive stop acknowledgement', async () => {
    const uncertain = Object.assign(new Error('exit is not proven'), { code: 'N8N_MEDIA_TERMINATION_UNCONFIRMED' })
    await expect(runWithN8nChildExecutionHeartbeat(db, audioLease, scope, async () => {
      request()
      throw uncertain
    })).rejects.toBe(uncertain)
    expect(recordScopedN8nVideoChildStopUnconfirmed(db, audioLease, scope)).toBe(true)
    expect(drainScopedVideoStops(db)).toMatchObject({ blocked: 1, stopped: 0 })
    expect(inspectScopedVideoStop(db, taskId, scope)?.stop?.errorCode).toBe('stop_local_execution_unconfirmed')
  })

  it.each(['stop-first', 'lease-lost'])('keeps the old checkpoint when %s wins before the publication fence', async mode => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stop-publication-fence-')))
    const pathname = join(root, 'mission.sqlite')
    const target = join(root, 'checkpoint.json'), temporary = join(root, 'checkpoint.tmp')
    try {
      db.close(); db = new Database(pathname); runMigrations(db); seed()
      writeFileSync(target, 'saved-before-stop'); writeFileSync(temporary, 'new-value')
      const publish = vi.fn(() => renameSync(temporary, target))
      await expect(runWithN8nChildExecutionHeartbeat(db, audioLease, scope, async control => {
        const other = new Database(pathname)
        try {
          if (mode === 'stop-first') {
            const inspection = inspectScopedVideoStop(other, taskId, scope)!
            requestScopedVideoStop(other, { taskId, expectedRevision: inspection.expectedRevision }, scope, 0)
          } else other.prepare('DELETE FROM n8n_child_execution_leases WHERE task_id=?').run(audioId)
        } finally { other.close() }
        control.commitIfActive!(publish)
      })).rejects.toMatchObject({ code: mode === 'stop-first' ? 'N8N_VIDEO_STOP_REQUESTED' : 'N8N_CHILD_LEASE_LOST' })
      expect(publish).not.toHaveBeenCalled()
      expect(readFileSync(target, 'utf8')).toBe('saved-before-stop')
    } finally { db.close(); db = new Database(':memory:'); rmSync(root, { recursive: true, force: true }) }
  })

  it('serializes a real competing process stop insertion after synchronous publication', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'stop-publish-process-race-')))
    const pathname = join(root, 'mission.sqlite')
    const ready = join(root, 'child-ready'), start = join(root, 'publish-locked'), attempted = join(root, 'stop-attempted')
    const target = join(root, 'checkpoint.json'), temporary = join(root, 'checkpoint.tmp')
    db.close(); db = new Database(pathname); runMigrations(db); seed()
    writeFileSync(target, 'old'); writeFileSync(temporary, 'published-before-stop')
    // This fixture is only the competing intent writer, never a termination proof.
    const insertion = "INSERT INTO n8n_video_stop_requests(request_id,task_id,binding_id,tenant_id,workspace_id,requested_by_id,state,snapshot_json,snapshot_sha256,child_task_ids_json) VALUES(?,?,?,3,2,0,'requested','{}',?,?)"
    const code = `const D=require('better-sqlite3'),fs=require('node:fs');const db=new D(${JSON.stringify(pathname)});db.pragma('busy_timeout=4000');fs.writeFileSync(${JSON.stringify(ready)},'1');function step(){if(!fs.existsSync(${JSON.stringify(start)})){setTimeout(step,2);return}fs.writeFileSync(${JSON.stringify(attempted)},'1');db.exec('BEGIN IMMEDIATE');db.prepare(${JSON.stringify(insertion)}).run('${'9'.repeat(64)}',${JSON.stringify(taskId)},${JSON.stringify(bindingId)},'${'a'.repeat(64)}',${JSON.stringify(JSON.stringify(['prepare', 'audio', 'vision', 'finalize'].map(stage => mediaChildIdentity('task', taskId, stage))))});db.exec('COMMIT');db.close()}step()`
    const child = spawn(process.execPath, ['-e', code], { cwd: process.cwd(), stdio: 'pipe' })
    let childError = ''
    child.stderr.on('data', value => { childError += String(value) })
    const finished = new Promise<number | null>(resolve => { child.once('close', resolve); child.once('error', () => resolve(null)) })
    try {
      let deadline = Date.now() + 3000
      while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
      expect({ ready: existsSync(ready), childError }).toEqual({ ready: true, childError: '' })
      await expect(runWithN8nChildExecutionHeartbeat(db, audioLease, scope, async control => {
        control.commitIfActive!(() => {
          writeFileSync(start, '1')
          deadline = Date.now() + 3000
          while (!existsSync(attempted) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2)
          expect(existsSync(attempted)).toBe(true)
          expect(db.prepare('SELECT COUNT(*) count FROM n8n_video_stop_requests').get()).toEqual({ count: 0 })
          renameSync(temporary, target)
        })
        expect(await finished).toBe(0)
        control.assertActive()
      })).rejects.toMatchObject({ code: 'N8N_VIDEO_STOP_REQUESTED' })
      expect(readFileSync(target, 'utf8')).toBe('published-before-stop')
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await finished
      db.close(); db = new Database(':memory:'); rmSync(root, { recursive: true, force: true })
    }
  }, 10_000)

  it('retains the same stop intent and old-writer fence after a same-database restart', () => {
    const root = mkdtempSync(join(tmpdir(), 'video-stop-restart-'))
    try {
      db.close(); db = new Database(join(root, 'test.sqlite')); runMigrations(db); seed()
      const original = request().stop!
      recordScopedN8nVideoChildStopAck(db, audioLease, scope, { providerCancellation: 'confirmed' })
      db.close(); db = new Database(join(root, 'test.sqlite')); runMigrations(db)
      expect(inspectScopedVideoStop(db, taskId, scope)?.stop?.requestId).toBe(original.requestId)
      expect(() => db.prepare(`UPDATE n8n_task_runs SET status='failed' WHERE task_id=?`).run(taskId)).toThrow('N8N_VIDEO_STOP_REQUESTED')
      expect(drainScopedVideoStops(db)).toMatchObject({ scanned: 1, stopped: 1 })
      expect(getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status).toBe('cancelled')
    } finally { db.close(); db = new Database(':memory:'); rmSync(root, { recursive: true, force: true }) }
  })
})
