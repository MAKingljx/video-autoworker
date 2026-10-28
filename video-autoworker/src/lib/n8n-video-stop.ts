import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { getN8nTaskRunByTaskId, getScopedN8nTaskRunByTaskId, n8nTaskIdentitySchema,
  readN8nMediaProviderExecutionRisk,
  type N8nChildExecutionLease, type N8nTaskScope } from '@/lib/n8n-task-runs'
import { mediaChildIdentity } from '@/lib/n8n-media-workspace'
import { observeN8nExecutionForStop, observeVideoTaskLocalProcesses } from '@/lib/n8n-video-stop-observation'
import { inspectScopedVideoBatchStopTarget, revalidateVideoBatchStopTarget, verifyScopedVideoBatchStopAck,
  revalidateScopedVideoBatchStopAck,
  type VideoBatchStopTargetSnapshot } from '@/lib/n8n-video-stop-batch'

const SHA = /^[a-f0-9]{64}$/u
const stages = ['prepare', 'audio', 'vision', 'finalize'] as const
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const clock = () => Math.floor(Date.now() / 1000)
const active = new Set(['queued', 'accepted', 'running'])
type ProviderCancellation = 'confirmed' | 'not_started' | 'provider_unconfirmed'
type StopState = 'requested' | 'stopping' | 'blocked' | 'stopped'
interface StopRow {
  request_id: string; task_id: string; tenant_id: number; workspace_id: number; requested_by_id: number
  target_kind: 'runtime' | 'batch_item'; binding_id: number
  state: StopState; snapshot_json: string; snapshot_sha256: string; child_task_ids_json: string
  owner_instance_id: string | null; lease_token: string | null; lease_expires_at: number; revision: number
  error_code: string | null; evidence_json: string | null; local_ack_json: string
  created_at: number; updated_at: number; completed_at: number | null
}
interface ChildLeaseRow {
  task_id: string; owner_instance_id: string; lease_token: string; revision: number
}
export interface N8nVideoStopLease {
  requestId: string; taskId: string; ownerInstanceId: string; leaseToken: string; revision: number
}
export interface N8nVideoStopProjection {
  taskId: string; requestId: string; currentState: StopState; errorCode: string | null
  targetKind: 'runtime' | 'batch_item'; bindingId: number; targetSha256: string
  requestedAt: number; updatedAt: number; completedAt: number | null; revision: number
  nextAction: 'wait_for_stop_executor' | 'wait_for_original_batch_owner' | 'inspect_stop_evidence' | 'stopped_relearn_as_new_task'
}
function project(row: StopRow): N8nVideoStopProjection {
  return { taskId: row.task_id, requestId: row.request_id, currentState: row.state, errorCode: row.error_code,
    targetKind: row.target_kind, bindingId: row.binding_id, targetSha256: row.snapshot_sha256,
    requestedAt: row.created_at, updatedAt: row.updated_at, completedAt: row.completed_at, revision: row.revision,
    nextAction: row.state === 'stopped' ? 'stopped_relearn_as_new_task'
      : row.state === 'blocked' ? 'inspect_stop_evidence'
        : row.target_kind === 'batch_item' ? 'wait_for_original_batch_owner' : 'wait_for_stop_executor' }
}
function rowFor(db: Database.Database, taskId: string, scope: N8nTaskScope): StopRow | undefined {
  return db.prepare(`SELECT * FROM n8n_video_stop_requests WHERE task_id=? AND tenant_id=? AND workspace_id=?`)
    .get(taskId, scope.tenantId, scope.workspaceId) as StopRow | undefined
}
function identity(run: NonNullable<ReturnType<typeof getScopedN8nTaskRunByTaskId>>) {
  return { taskId: run.taskId, idempotencyKey: run.idempotencyKey, bindingId: run.bindingId,
    tenantId: run.tenantId, workspaceId: run.workspaceId, inputSha256: digest(run.input), routingSha256: digest(run.routing),
    attemptCount: run.attemptCount, maxAttempts: run.maxAttempts }
}
function leaseIdentity(lease: ChildLeaseRow) {
  return { taskId: lease.task_id, ownerInstanceId: lease.owner_instance_id,
    leaseTokenSha256: digest(lease.lease_token), revision: lease.revision }
}
function authority(db: Database.Database, taskId: string, scope: N8nTaskScope) {
  const run = getScopedN8nTaskRunByTaskId(db, n8nTaskIdentitySchema.parse(taskId), scope)
  if (!run) return null
  const binding = db.prepare(`SELECT task_type,workflow_id FROM n8n_workflow_bindings WHERE id=? AND tenant_id=? AND workspace_id=?`)
    .get(run.bindingId, scope.tenantId, scope.workspaceId) as { task_type: string; workflow_id: string | null } | undefined
  if (!['openclaw', 'video-autoworker'].includes(run.source) || binding?.task_type !== 'video-analysis'
    || run.routing.taskType !== 'video-analysis') throw new Error('stop_task_unsupported')
  const children = stages.map(stage => {
    const childId = mediaChildIdentity('task', run.taskId, stage)
    const child = getScopedN8nTaskRunByTaskId(db, childId, scope)
    if (child && (child.bindingId !== run.bindingId || child.source !== 'n8n-media-node'
      || child.idempotencyKey !== mediaChildIdentity('idem', run.idempotencyKey, stage))) throw new Error('stop_child_identity_changed')
    return { childId, child }
  })
  const owner = db.prepare(`SELECT execution_owner FROM n8n_parent_execution_claims
    WHERE task_id=? AND tenant_id=? AND workspace_id=?`).get(taskId, scope.tenantId, scope.workspaceId) as { execution_owner: string } | undefined
  const leases = children.flatMap(({ childId }) => {
    const lease = db.prepare(`SELECT task_id,owner_instance_id,lease_token,revision FROM n8n_child_execution_leases
      WHERE task_id=? AND tenant_id=? AND workspace_id=?`).get(childId, scope.tenantId, scope.workspaceId) as ChildLeaseRow | undefined
    return lease ? [leaseIdentity(lease)] : []
  })
  const dispatchLeasePresent = Boolean(db.prepare(`SELECT 1 FROM n8n_task_dispatch_leases
    WHERE task_id=? AND tenant_id=? AND workspace_id=?`).get(taskId, scope.tenantId, scope.workspaceId))
  const dispatch = run.routing.dispatchIdentity as { workflowId?: unknown } | undefined
  const snapshot = { schema: 'aiworker-video-stop-snapshot/v1' as const,
    parent: identity(run), initialStatus: run.status,
    workflowId: typeof dispatch?.workflowId === 'string' ? dispatch.workflowId : binding.workflow_id || '',
    admissionControlVersion: run.routing.executionControlVersion || null,
    dispatchLeasePresent, executionOwner: owner?.execution_owner || null,
    childIds: children.map(value => value.childId), leases,
    executions: children.filter(value => value.child?.status === 'running').map(({ childId, child }) => ({
      childId, controlVersion: child!.routing.executionControlVersion || null,
    })),
    providerHistories: children.filter(value => value.child).map(({ childId, child }) => ({
      childId, ...readN8nMediaProviderExecutionRisk(child!),
    })),
    successfulChildren: Object.fromEntries(children.filter(value => value.child?.status === 'succeeded')
      .map(({ childId, child }) => [childId, digest(child)])) }
  return { run, children, snapshot, revisionSha256: digest({ snapshot, status: run.status, updatedAt: run.updatedAt,
    children: children.map(({ childId, child }) => ({ childId, status: child?.status || null, updatedAt: child?.updatedAt || null })) }) }
}

export function inspectScopedVideoStop(db: Database.Database, taskId: string, scope: N8nTaskScope) {
  const current = authority(db, taskId, scope)
  if (!current) return null
  const row = rowFor(db, taskId, scope)
  return { taskId, targetKind: 'runtime' as const, bindingId: current.run.bindingId,
    status: current.run.status, eligible: active.has(current.run.status),
    expectedRevision: current.revisionSha256, stop: row ? project(row) : null,
    preservedStages: current.children.filter(value => value.child?.status === 'succeeded')
      .map(value => stages[current.children.indexOf(value)]) }
}

function requireStopBinding(db: Database.Database, bindingId: number, scope: N8nTaskScope) {
  if (!Number.isSafeInteger(bindingId) || !db.prepare(`SELECT 1 FROM n8n_workflow_bindings WHERE id=?
    AND tenant_id=? AND workspace_id=? AND task_type='video-analysis'`).get(bindingId, scope.tenantId, scope.workspaceId)) {
    throw new Error('stop_binding_unavailable')
  }
}

/** Cheap worker polling; no source scan or model output is read. */
export function readScopedVideoStopIntent(db: Database.Database, taskId: string, bindingId: number, scope: N8nTaskScope) {
  n8nTaskIdentitySchema.parse(taskId)
  // A producer publishes its cleanup phase before this read. IMMEDIATE waits
  // for an in-flight stop CAS; a WAL read snapshot could otherwise miss it.
  return db.transaction(() => {
    requireStopBinding(db, bindingId, scope)
    const row = rowFor(db, taskId, scope)
    if (row && row.binding_id !== bindingId) throw new Error('stop_binding_changed')
    return { taskId, bindingId, stop: row ? project(row) : null }
  }).immediate()
}

export async function inspectScopedSingleVideoStop(db: Database.Database, taskId: string, scope: N8nTaskScope) {
  n8nTaskIdentitySchema.parse(taskId)
  const row = rowFor(db, taskId, scope)
  if (row) return { taskId, targetKind: row.target_kind, bindingId: row.binding_id,
    status: row.target_kind === 'runtime' ? getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status || 'unknown'
      : row.state === 'stopped' ? 'cancelled' : 'stopping', eligible: row.state !== 'stopped',
    expectedRevision: row.snapshot_sha256, stop: project(row), preservedStages: [] as string[] }
  const parent = getN8nTaskRunByTaskId(db, taskId)
  if (parent) {
    if (parent.tenantId !== scope.tenantId || parent.workspaceId !== scope.workspaceId) return null
    return inspectScopedVideoStop(db, taskId, scope)
  }
  const batch = await inspectScopedVideoBatchStopTarget(db, taskId, scope)
  return batch ? { taskId, targetKind: 'batch_item' as const, bindingId: batch.snapshot.bindingId,
    status: batch.snapshot.itemStatus, eligible: true, expectedRevision: batch.expectedRevision,
    stop: null, preservedStages: [] as string[] } : null
}

/** Only records intent. No process or model call occurs in this transaction. */
export function requestScopedVideoStop(db: Database.Database,
  input: { taskId: string; expectedRevision: string }, scope: N8nTaskScope, actorId: number,
) {
  if (!SHA.test(input.expectedRevision) || !Number.isSafeInteger(actorId) || actorId < 0) throw new Error('stop_request_invalid')
  return db.transaction(() => {
    const current = authority(db, input.taskId, scope)
    if (!current) throw new Error('stop_task_not_found')
    const existing = rowFor(db, input.taskId, scope)
    if (existing) {
      if (existing.target_kind !== 'runtime') throw new Error('stop_target_kind_changed')
      return { outcome: 'existing' as const, stop: project(existing), status: current.run.status }
    }
    if (!active.has(current.run.status)) return { outcome: 'already_terminal' as const, stop: null, status: current.run.status }
    if (current.revisionSha256 !== input.expectedRevision) throw new Error('stop_revision_changed')
    const requestId = randomBytes(32).toString('hex')
    db.prepare(`INSERT INTO n8n_video_stop_requests (request_id,task_id,binding_id,tenant_id,workspace_id,requested_by_id,state,
      snapshot_json,snapshot_sha256,child_task_ids_json) VALUES (?,?,?,?,?,?,'requested',?,?,?)`)
      .run(requestId, input.taskId, current.run.bindingId, scope.tenantId, scope.workspaceId, actorId, JSON.stringify(current.snapshot),
        digest(current.snapshot), JSON.stringify(current.snapshot.childIds))
    return { outcome: 'requested' as const, stop: project(rowFor(db, input.taskId, scope)!), status: current.run.status }
  }).immediate()
}

/** Both admission phases share this one durable intent. The DB transaction
 * decides which authority won; an unadmitted target never becomes a fake run. */
export async function requestScopedSingleVideoStop(db: Database.Database,
  input: { taskId: string; expectedRevision: string }, scope: N8nTaskScope, actorId: number) {
  if (!SHA.test(input.expectedRevision) || !Number.isSafeInteger(actorId) || actorId < 0) throw new Error('stop_request_invalid')
  const existing = rowFor(db, input.taskId, scope)
  if (existing) return { outcome: 'existing' as const, stop: project(existing),
    status: existing.target_kind === 'runtime' ? getScopedN8nTaskRunByTaskId(db, input.taskId, scope)?.status || 'unknown'
      : existing.state === 'stopped' ? 'cancelled' : 'stopping' }
  const beforeParent = getN8nTaskRunByTaskId(db, input.taskId)
  const batch = beforeParent ? null : await inspectScopedVideoBatchStopTarget(db, input.taskId, scope)
  return db.transaction(() => {
    const parent = getN8nTaskRunByTaskId(db, input.taskId)
    if (parent) {
      if (parent.tenantId !== scope.tenantId || parent.workspaceId !== scope.workspaceId) throw new Error('stop_task_not_found')
      return requestScopedVideoStop(db, input, scope, actorId)
    }
    const replay = rowFor(db, input.taskId, scope)
    if (replay) return { outcome: 'existing' as const, stop: project(replay), status: replay.state === 'stopped' ? 'cancelled' : 'stopping' }
    if (db.prepare('SELECT 1 FROM n8n_video_stop_requests WHERE task_id=?').get(input.taskId)) throw new Error('stop_task_not_found')
    if (!batch) throw new Error('stop_task_not_found')
    if (batch.expectedRevision !== input.expectedRevision) throw new Error('stop_revision_changed')
    const reservedChildren = stages.map(stage => mediaChildIdentity('task', input.taskId, stage))
    const collision = db.prepare(`SELECT tenant_id,workspace_id FROM n8n_task_runs WHERE task_id IN (?,?,?,?) LIMIT 1`)
      .get(...reservedChildren) as { tenant_id: number; workspace_id: number } | undefined
    if (collision) throw new Error(collision.tenant_id === scope.tenantId && collision.workspace_id === scope.workspaceId
      ? 'stop_phase_authority_changed' : 'stop_task_not_found')
    requireStopBinding(db, batch.snapshot.bindingId, scope)
    revalidateVideoBatchStopTarget(batch.snapshot)
    const requestId = randomBytes(32).toString('hex')
    db.prepare(`INSERT INTO n8n_video_stop_requests (request_id,task_id,target_kind,binding_id,tenant_id,workspace_id,
      requested_by_id,state,snapshot_json,snapshot_sha256,child_task_ids_json) VALUES (?,?,'batch_item',?,?,?,?,'requested',?,?,?)`)
      .run(requestId, input.taskId, batch.snapshot.bindingId, scope.tenantId, scope.workspaceId, actorId,
        JSON.stringify(batch.snapshot), batch.expectedRevision,
        JSON.stringify(reservedChildren))
    revalidateVideoBatchStopTarget(batch.snapshot)
    return { outcome: 'requested' as const, stop: project(rowFor(db, input.taskId, scope)!), status: batch.snapshot.itemStatus }
  }).immediate()
}

/** Only the original lane owner can acknowledge filesystem producer exit.
 * The browser supplies no receipt: the verifier reads it from the primary. */
export async function acknowledgeScopedVideoBatchStop(db: Database.Database,
  input: { taskId: string; requestId: string; workerLease: { pid: number; token: string } }, scope: N8nTaskScope) {
  const row = rowFor(db, input.taskId, scope)
  if (!row || row.request_id !== input.requestId) throw new Error('stop_request_not_found')
  if (row.target_kind !== 'batch_item') throw new Error('stop_target_kind_changed')
  if (row.state === 'stopped') return { stop: project(row) }
  const snapshot = JSON.parse(row.snapshot_json) as VideoBatchStopTargetSnapshot
  if (snapshot.schema !== 'aiworker-video-batch-stop-target/v1' || digest(snapshot) !== row.snapshot_sha256
    || snapshot.taskId !== row.task_id || snapshot.bindingId !== row.binding_id
    || snapshot.tenantId !== scope.tenantId || snapshot.workspaceId !== scope.workspaceId) throw new Error('stop_snapshot_invalid')
  const observed = await verifyScopedVideoBatchStopAck(snapshot, input.requestId, input.workerLease)
  if (Date.parse(observed.receipt.observedAt) < row.created_at * 1000) throw new Error('stop_batch_receipt_stale')
  const claimed = claimScopedVideoStop(db, input.taskId, input.requestId, randomBytes(32).toString('hex'), scope)
  if (!claimed.lease) return { stop: claimed.stop }
  try {
    return db.transaction(() => {
      const current = rowFor(db, input.taskId, scope)
      if (!owned(current, claimed.lease!)) throw new Error('stop_execution_lease_changed')
      if (current.target_kind !== 'batch_item' || current.snapshot_sha256 !== row.snapshot_sha256) throw new Error('stop_target_kind_changed')
      requireStopBinding(db, current.binding_id, scope)
      if (getN8nTaskRunByTaskId(db, input.taskId)) throw new Error('stop_phase_authority_changed')
      revalidateScopedVideoBatchStopAck(snapshot, input.requestId, observed.evidenceSha256)
      const changed = db.prepare(`UPDATE n8n_video_stop_requests SET state='stopped',error_code=NULL,evidence_json=?,
        owner_instance_id=NULL,lease_token=NULL,lease_expires_at=0,completed_at=unixepoch(),updated_at=unixepoch()
        WHERE request_id=? AND revision=? AND target_kind='batch_item'`)
        .run(JSON.stringify({ schema: 'aiworker-video-batch-stop-ack/v1', evidenceSha256: observed.evidenceSha256,
          receiptSha256: digest(observed.receipt), workerPid: input.workerLease.pid }), input.requestId, claimed.lease!.revision)
      if (changed.changes !== 1) throw new Error('stop_execution_lease_changed')
      return { stop: project(rowFor(db, input.taskId, scope)!) }
    }).immediate()
  } catch (error) {
    const code = error instanceof Error && /^stop_[a-z_]+$/u.test(error.message) ? error.message : 'stop_batch_ack_unconfirmed'
    try { blockScopedVideoStop(db, claimed.lease, scope, code) } catch { /* A successor or a completed acknowledgement wins. */ }
    throw error
  }
}

export function claimScopedVideoStop(db: Database.Database, taskId: string, requestId: string,
  ownerInstanceId: string, scope: N8nTaskScope, leaseSeconds = 120,
): { stop: N8nVideoStopProjection; lease: N8nVideoStopLease | null } {
  if (![requestId, ownerInstanceId].every(value => SHA.test(value))
    || !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 900) throw new Error('stop_execution_identity_invalid')
  return db.transaction(() => {
    const row = rowFor(db, taskId, scope)
    if (!row || row.request_id !== requestId) throw new Error('stop_request_not_found')
    if (row.state === 'stopped' || (row.owner_instance_id && row.lease_expires_at > clock())) return { stop: project(row), lease: null }
    const token = randomBytes(32).toString('hex')
    db.prepare(`UPDATE n8n_video_stop_requests SET state='stopping',owner_instance_id=?,lease_token=?,
      lease_expires_at=?,revision=revision+1,error_code=NULL,updated_at=unixepoch() WHERE request_id=? AND revision=?`)
      .run(ownerInstanceId, token, clock() + leaseSeconds, requestId, row.revision)
    const changed = rowFor(db, taskId, scope)!
    return { stop: project(changed), lease: { taskId, requestId, ownerInstanceId, leaseToken: token, revision: changed.revision } }
  }).immediate()
}
function owned(row: StopRow | undefined, lease: N8nVideoStopLease): row is StopRow {
  return Boolean(row && row.request_id === lease.requestId && row.owner_instance_id === lease.ownerInstanceId
    && row.lease_token === lease.leaseToken && row.revision === lease.revision && row.lease_expires_at > clock())
}

function recordChildStopObservation(db: Database.Database, lease: N8nChildExecutionLease,
  scope: N8nTaskScope, input: { providerCancellation: ProviderCancellation; localStopped: boolean; evidenceSha256?: string },
): boolean {
  if (!['confirmed', 'not_started', 'provider_unconfirmed'].includes(input.providerCancellation)
    || (input.evidenceSha256 !== undefined && !SHA.test(input.evidenceSha256))) throw new Error('stop_local_ack_invalid')
  return db.transaction(() => {
    const row = db.prepare(`SELECT * FROM n8n_video_stop_requests stop WHERE tenant_id=? AND workspace_id=?
      AND ? IN (SELECT value FROM json_each(stop.child_task_ids_json))`).get(scope.tenantId, scope.workspaceId, lease.taskId) as StopRow | undefined
    if (!row || row.target_kind !== 'runtime' || row.state === 'stopped') return false
    const snapshot = JSON.parse(row.snapshot_json) as NonNullable<ReturnType<typeof authority>>['snapshot']
    const expected = snapshot.leases.find(value => value.taskId === lease.taskId)
    if (!expected || expected.ownerInstanceId !== lease.ownerInstanceId || expected.leaseTokenSha256 !== digest(lease.leaseToken)
      || expected.revision !== lease.revision) return false
    const acknowledgments = JSON.parse(row.local_ack_json) as Record<string, unknown>
    acknowledgments[lease.taskId] = { ...expected, localStopped: input.localStopped, writersSettled: true,
      providerCancellation: input.providerCancellation, evidenceSha256: input.evidenceSha256 || null, observedAt: clock() }
    db.prepare(`UPDATE n8n_video_stop_requests SET local_ack_json=?,updated_at=unixepoch(),
      state=CASE WHEN ?=0 OR ?='provider_unconfirmed' THEN 'blocked' ELSE state END,
      error_code=CASE WHEN ?=0 THEN 'stop_local_execution_unconfirmed'
        WHEN ?='provider_unconfirmed' THEN 'stop_provider_unconfirmed' ELSE error_code END WHERE request_id=?`)
      .run(JSON.stringify(acknowledgments), Number(input.localStopped), input.providerCancellation,
        Number(input.localStopped), input.providerCancellation, row.request_id)
    return true
  }).immediate()
}

/** Called only after the local attempt's writers and owned subprocesses settle. */
export function recordScopedN8nVideoChildStopAck(db: Database.Database, lease: N8nChildExecutionLease,
  scope: N8nTaskScope, input: { providerCancellation: ProviderCancellation; evidenceSha256?: string },
): boolean {
  return recordChildStopObservation(db, lease, scope, { ...input, localStopped: true })
}

export function recordScopedN8nVideoChildStopUnconfirmed(db: Database.Database,
  lease: N8nChildExecutionLease, scope: N8nTaskScope): boolean {
  return recordChildStopObservation(db, lease, scope, { localStopped: false, providerCancellation: 'provider_unconfirmed' })
}

const proofSchema = z.object({ schema: z.literal('aiworker-video-stop-proof/v1'), requestId: z.string().regex(SHA),
  taskId: n8nTaskIdentitySchema, snapshotSha256: z.string().regex(SHA), observedAt: z.number().int().nonnegative(),
  local: z.object({ status: z.enum(['stopped', 'running', 'not_started', 'unconfirmed']), evidenceSha256: z.string().regex(SHA) }).strict(),
  provider: z.object({ status: z.enum(['confirmed', 'pending', 'not_started', 'unconfirmed']), evidenceSha256: z.string().regex(SHA) }).strict(),
  n8n: z.object({ status: z.enum(['stopped', 'running', 'not_started', 'unconfirmed']), executionOwner: z.string().nullable(),
    evidenceSha256: z.string().regex(SHA) }).strict(),
  evidenceSha256: z.string().regex(SHA),
}).strict()
export type N8nVideoStopProof = z.infer<typeof proofSchema>
const observedProofs = new WeakMap<object, string>()

export function readScopedVideoStopExecutionPlan(db: Database.Database, lease: N8nVideoStopLease, scope: N8nTaskScope) {
  const row = rowFor(db, lease.taskId, scope)
  if (!owned(row, lease)) throw new Error('stop_execution_lease_changed')
  if (row.target_kind !== 'runtime') throw new Error('stop_target_kind_changed')
  const snapshot = JSON.parse(row.snapshot_json) as NonNullable<ReturnType<typeof authority>>['snapshot']
  const current = authority(db, row.task_id, scope)
  if (snapshot.schema !== 'aiworker-video-stop-snapshot/v1' || !current
    || digest(snapshot) !== row.snapshot_sha256 || digest(identity(current.run)) !== digest(snapshot.parent)
    || digest(snapshot.childIds) !== digest(stages.map(stage => mediaChildIdentity('task', row.task_id, stage)))
    || digest(JSON.parse(row.child_task_ids_json)) !== digest(snapshot.childIds)
    || digest(current.snapshot.providerHistories) !== digest(snapshot.providerHistories)) throw new Error('stop_snapshot_invalid')
  return { taskId: row.task_id, requestId: row.request_id, snapshotSha256: row.snapshot_sha256,
    snapshot,
    localAcknowledgments: JSON.parse(row.local_ack_json) as Record<string, unknown> }
}

/** Only system observations can mint this in-process, non-serializable proof. */
export function observeScopedVideoStopProof(db: Database.Database, lease: N8nVideoStopLease, scope: N8nTaskScope): N8nVideoStopProof {
  const plan = readScopedVideoStopExecutionPlan(db, lease, scope)
  const acknowledgments = plan.localAcknowledgments as Record<string, {
    localStopped?: boolean; writersSettled?: boolean; ownerInstanceId?: string; leaseTokenSha256?: string
    revision?: number; providerCancellation?: string; evidenceSha256?: string | null
  }>
  let pending = false, unknown = false
  let providerConfirmed = plan.snapshot.providerHistories.some(value => value.status === 'confirmed')
  let providerUnknown = plan.snapshot.providerHistories.some(value => value.status === 'unconfirmed')
  for (const expected of plan.snapshot.leases) {
    const ack = acknowledgments[expected.taskId]
    const controlled = plan.snapshot.executions.find(value => value.childId === expected.taskId)?.controlVersion === 'durable-stop-v1'
    if (ack && ack.localStopped === false) { unknown = true; continue }
    if (!ack?.localStopped || !ack.writersSettled || ack.ownerInstanceId !== expected.ownerInstanceId
      || ack.leaseTokenSha256 !== expected.leaseTokenSha256 || ack.revision !== expected.revision
      || (!controlled && !SHA.test(ack.evidenceSha256 || ''))) {
      const currentLease = db.prepare(`SELECT lease_expires_at FROM n8n_child_execution_leases
        WHERE task_id=? AND tenant_id=? AND workspace_id=?`).get(expected.taskId, scope.tenantId, scope.workspaceId) as { lease_expires_at: number } | undefined
      if (controlled && currentLease && currentLease.lease_expires_at > clock()) pending = true
      else unknown = true
      continue
    }
    if (ack.providerCancellation === 'confirmed') providerConfirmed = true
    else if (ack.providerCancellation !== 'not_started') providerUnknown = true
  }
  const processes = observeVideoTaskLocalProcesses(plan.taskId)
  if (processes.status === 'unconfirmed' || (processes.status === 'running' && !pending)) unknown = true
  const allowNotStarted = plan.snapshot.initialStatus === 'queued' && !plan.snapshot.dispatchLeasePresent
    && plan.snapshot.admissionControlVersion === 'durable-stop-v1'
    && plan.snapshot.leases.length === 0 && plan.snapshot.executionOwner === null
  const n8n = observeN8nExecutionForStop(plan.snapshot.executionOwner, plan.snapshot.workflowId, allowNotStarted)
  const local: N8nVideoStopProof['local'] = { status: unknown ? 'unconfirmed' : pending ? 'running' : 'stopped',
    evidenceSha256: digest({ acknowledgments, processes }) }
  const provider: N8nVideoStopProof['provider'] = { status: unknown || providerUnknown ? 'unconfirmed'
    : pending ? 'pending' : providerConfirmed ? 'confirmed' : 'not_started', evidenceSha256: digest({ acknowledgments }) }
  const value: N8nVideoStopProof = { schema: 'aiworker-video-stop-proof/v1', taskId: plan.taskId,
    requestId: plan.requestId, snapshotSha256: plan.snapshotSha256, observedAt: clock(), local, provider, n8n,
    evidenceSha256: digest({ local, provider, n8n, snapshotSha256: plan.snapshotSha256 }) }
  observedProofs.set(value, digest(value))
  return value
}

export function renewScopedVideoStopLease(db: Database.Database, lease: N8nVideoStopLease,
  scope: N8nTaskScope, leaseSeconds = 120): boolean {
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 900) throw new Error('stop_execution_lease_invalid')
  return db.prepare(`UPDATE n8n_video_stop_requests SET lease_expires_at=?,updated_at=unixepoch()
    WHERE request_id=? AND task_id=? AND tenant_id=? AND workspace_id=? AND owner_instance_id=?
      AND lease_token=? AND revision=? AND lease_expires_at>unixepoch() AND state<>'stopped'`)
    .run(clock() + leaseSeconds, lease.requestId, lease.taskId, scope.tenantId, scope.workspaceId,
      lease.ownerInstanceId, lease.leaseToken, lease.revision).changes === 1
}

export function blockScopedVideoStop(db: Database.Database, lease: N8nVideoStopLease, scope: N8nTaskScope, code: string) {
  if (!/^stop_[a-z0-9_]{1,90}$/u.test(code)) throw new Error('stop_error_code_invalid')
  return db.transaction(() => {
    const row = rowFor(db, lease.taskId, scope)
    if (row && row.request_id !== lease.requestId) throw new Error('stop_execution_lease_changed')
    if (!owned(row, lease)) throw new Error('stop_execution_lease_changed')
    db.prepare(`UPDATE n8n_video_stop_requests SET state='blocked',error_code=?,owner_instance_id=NULL,
      lease_token=NULL,lease_expires_at=0,updated_at=unixepoch() WHERE request_id=? AND revision=?`)
      .run(code, row.request_id, row.revision)
    return project(rowFor(db, row.task_id, scope)!)
  }).immediate()
}

/** Internal adapter boundary; the public route never accepts proof or PIDs. */
export function settleScopedVideoStop(db: Database.Database, lease: N8nVideoStopLease, scope: N8nTaskScope,
  proofValue: N8nVideoStopProof,
): { outcome: 'stopped' | 'stopping' | 'blocked'; stop: N8nVideoStopProjection } {
  return db.transaction(() => {
    const row = rowFor(db, lease.taskId, scope)
    if (row && row.request_id !== lease.requestId) throw new Error('stop_execution_lease_changed')
    if (row && row.target_kind !== 'runtime') throw new Error('stop_target_kind_changed')
    if (row?.state === 'stopped') return { outcome: 'stopped' as const, stop: project(row) }
    if (!owned(row, lease)) throw new Error('stop_execution_lease_changed')
    const blocked = (code: string) => {
      db.prepare(`UPDATE n8n_video_stop_requests SET state='blocked',error_code=?,owner_instance_id=NULL,
        lease_token=NULL,lease_expires_at=0,updated_at=unixepoch() WHERE request_id=? AND revision=?`)
        .run(code, row.request_id, row.revision)
      return { outcome: 'blocked' as const, stop: project(rowFor(db, lease.taskId, scope)!) }
    }
    if (!proofValue || typeof proofValue !== 'object' || observedProofs.get(proofValue) !== digest(proofValue)) {
      return blocked('stop_proof_not_system_observed')
    }
    const parsed = proofSchema.safeParse(proofValue)
    if (!parsed.success) return blocked('stop_proof_invalid')
    const proof = parsed.data
    if (proof.requestId !== row.request_id || proof.taskId !== row.task_id || proof.snapshotSha256 !== row.snapshot_sha256
      || proof.observedAt < row.created_at || proof.observedAt > clock() + 5 || clock() - proof.observedAt > 30) return blocked('stop_proof_binding_changed')
    const snapshot = JSON.parse(row.snapshot_json) as NonNullable<ReturnType<typeof authority>>['snapshot']
    if (digest(snapshot) !== row.snapshot_sha256
      || digest(snapshot.childIds) !== digest(stages.map(stage => mediaChildIdentity('task', row.task_id, stage)))
      || digest(JSON.parse(row.child_task_ids_json)) !== digest(snapshot.childIds)) return blocked('stop_snapshot_invalid')
    if (proof.n8n.status === 'unconfirmed' || proof.n8n.executionOwner !== snapshot.executionOwner) return blocked('stop_n8n_execution_unconfirmed')
    if (proof.local.status === 'unconfirmed') {
      return blocked('stop_local_execution_unconfirmed')
    }
    if (proof.provider.status === 'unconfirmed') return blocked('stop_provider_unconfirmed')
    if (proof.n8n.status === 'running' || proof.local.status === 'running' || proof.provider.status === 'pending') {
      db.prepare(`UPDATE n8n_video_stop_requests SET state='stopping',error_code=NULL,owner_instance_id=NULL,
        lease_token=NULL,lease_expires_at=0,evidence_json=?,updated_at=unixepoch() WHERE request_id=? AND revision=?`)
        .run(JSON.stringify(proof), row.request_id, row.revision)
      return { outcome: 'stopping' as const, stop: project(rowFor(db, row.task_id, scope)!) }
    }
    if ((snapshot.executionOwner && proof.n8n.status !== 'stopped')
      || (snapshot.leases.length && proof.local.status !== 'stopped')) return blocked('stop_execution_unconfirmed')
    const current = authority(db, row.task_id, scope)
    if (!current || digest(identity(current.run)) !== digest(snapshot.parent)
      || !active.has(current.run.status)
      || digest(current.snapshot.providerHistories) !== digest(snapshot.providerHistories)) return blocked('stop_task_identity_changed')
    if (!snapshot.executionOwner && current.run.status !== 'queued') return blocked('stop_parent_owner_unconfirmed')
    if (!snapshot.executionOwner && db.prepare(`SELECT 1 FROM n8n_task_dispatch_leases WHERE task_id=?
      AND tenant_id=? AND workspace_id=?`).get(row.task_id, scope.tenantId, scope.workspaceId)) return blocked('stop_dispatch_outcome_unconfirmed')
    for (const [childId, expected] of Object.entries(snapshot.successfulChildren)) {
      if (digest(getScopedN8nTaskRunByTaskId(db, childId, scope)) !== expected) return blocked('stop_saved_success_changed')
    }
    const acknowledgments = JSON.parse(row.local_ack_json) as Record<string, { localStopped?: boolean; writersSettled?: boolean;
      providerCancellation?: string; ownerInstanceId?: string; leaseTokenSha256?: string; revision?: number }>
    for (const expected of snapshot.leases) {
      const ack = acknowledgments[expected.taskId]
      if (!ack?.localStopped || !ack.writersSettled || ack.ownerInstanceId !== expected.ownerInstanceId
        || ack.leaseTokenSha256 !== expected.leaseTokenSha256 || ack.revision !== expected.revision) return blocked('stop_local_execution_unconfirmed')
      if (!['confirmed', 'not_started'].includes(ack.providerCancellation || '')) return blocked('stop_provider_unconfirmed')
      if (ack.providerCancellation === 'confirmed' && proof.provider.status !== 'confirmed') return blocked('stop_provider_unconfirmed')
    }
    for (const { childId, child } of current.children) {
      const currentLease = db.prepare(`SELECT task_id,owner_instance_id,lease_token,revision FROM n8n_child_execution_leases
        WHERE task_id=? AND tenant_id=? AND workspace_id=?`).get(childId, scope.tenantId, scope.workspaceId) as ChildLeaseRow | undefined
      if (currentLease && !snapshot.leases.some(value => digest(value) === digest(leaseIdentity(currentLease)))) return blocked('stop_child_owner_changed')
      if (child?.status === 'running' && !snapshot.leases.some(value => value.taskId === childId)) return blocked('stop_child_lease_missing')
    }
    const owner = db.prepare(`SELECT execution_owner FROM n8n_parent_execution_claims WHERE task_id=? AND tenant_id=? AND workspace_id=?`)
      .get(row.task_id, scope.tenantId, scope.workspaceId) as { execution_owner: string } | undefined
    if (owner && owner.execution_owner !== snapshot.executionOwner) return blocked('stop_parent_owner_changed')
    const cancellation = '[N8N_VIDEO_STOPPED_BY_USER] 用户请求停止；原学习结果和恢复资料已保留'
    const cancelled = db.prepare(`UPDATE n8n_task_runs SET status='cancelled',error=?,completed_at=unixepoch(),updated_at=unixepoch()
      WHERE task_id=? AND tenant_id=? AND workspace_id=? AND status IN ('queued','accepted','running')`)
      .run(cancellation, row.task_id, scope.tenantId, scope.workspaceId)
    if (cancelled.changes !== 1) throw new Error('stop_task_revision_changed')
    for (const childId of snapshot.childIds) {
      db.prepare(`UPDATE n8n_task_runs SET status='cancelled',error=?,completed_at=unixepoch(),updated_at=unixepoch()
        WHERE task_id=? AND tenant_id=? AND workspace_id=? AND status IN ('queued','accepted','running')`)
        .run(cancellation, childId, scope.tenantId, scope.workspaceId)
      db.prepare(`DELETE FROM n8n_child_execution_leases WHERE task_id=? AND tenant_id=? AND workspace_id=?`)
        .run(childId, scope.tenantId, scope.workspaceId)
    }
    db.prepare(`DELETE FROM n8n_parent_execution_claims WHERE task_id=? AND tenant_id=? AND workspace_id=?`)
      .run(row.task_id, scope.tenantId, scope.workspaceId)
    db.prepare(`DELETE FROM n8n_task_dispatch_leases WHERE task_id=? AND tenant_id=? AND workspace_id=?`)
      .run(row.task_id, scope.tenantId, scope.workspaceId)
    const completed = db.prepare(`UPDATE n8n_video_stop_requests SET state='stopped',error_code=NULL,evidence_json=?,
      owner_instance_id=NULL,lease_token=NULL,lease_expires_at=0,completed_at=unixepoch(),updated_at=unixepoch()
      WHERE request_id=? AND revision=?`).run(JSON.stringify(proof), row.request_id, row.revision)
    if (completed.changes !== 1) throw new Error('stop_execution_lease_changed')
    return { outcome: 'stopped' as const, stop: project(rowFor(db, row.task_id, scope)!) }
  }).immediate()
}

/** One bounded observation step; no n8n writes or long-lived API credentials. */
export function advanceScopedVideoStop(db: Database.Database, taskId: string, requestId: string, scope: N8nTaskScope) {
  const target = rowFor(db, taskId, scope)
  if (!target || target.request_id !== requestId) throw new Error('stop_request_not_found')
  if (target.target_kind === 'batch_item') {
    if (target.state === 'requested') db.prepare(`UPDATE n8n_video_stop_requests SET state='stopping',
      updated_at=unixepoch() WHERE request_id=? AND state='requested'`).run(requestId)
    const latest = rowFor(db, taskId, scope)!
    return { outcome: latest.state, stop: project(latest), status: latest.state === 'stopped' ? 'cancelled' : 'stopping' }
  }
  const claimed = claimScopedVideoStop(db, taskId, requestId, randomBytes(32).toString('hex'), scope)
  if (!claimed.lease) return { outcome: claimed.stop.currentState, stop: claimed.stop,
    status: getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status || 'unknown' }
  try {
    const result = settleScopedVideoStop(db, claimed.lease, scope, observeScopedVideoStopProof(db, claimed.lease, scope))
    return { ...result, status: getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status || 'unknown' }
  } catch (error) {
    const code = error instanceof Error && /^stop_[a-z_]+$/u.test(error.message) ? error.message : 'stop_observation_unavailable'
    return { outcome: 'blocked' as const, stop: blockScopedVideoStop(db, claimed.lease, scope, code),
      status: getScopedN8nTaskRunByTaskId(db, taskId, scope)?.status || 'unknown' }
  }
}

/** Existing scheduler leader owns retries after restarts; this is no video queue. */
export function drainScopedVideoStops(db: Database.Database, options: { limit?: number } = {}) {
  const limit = options.limit ?? 10
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new TypeError('stop_drain_limit_invalid')
  const rows = db.prepare(`SELECT task_id,request_id,tenant_id,workspace_id FROM n8n_video_stop_requests
    WHERE target_kind='runtime' AND state IN ('requested','stopping','blocked')
      AND (owner_instance_id IS NULL OR lease_expires_at<=unixepoch())
    ORDER BY updated_at,request_id LIMIT ?`).all(limit) as Array<Pick<StopRow, 'task_id' | 'request_id' | 'tenant_id' | 'workspace_id'>>
  const counts = { scanned: rows.length, stopped: 0, stopping: 0, blocked: 0 }
  for (const row of rows) {
    try {
      const result = advanceScopedVideoStop(db, row.task_id, row.request_id, { tenantId: row.tenant_id, workspaceId: row.workspace_id })
      if (result.outcome === 'stopped') counts.stopped += 1
      else if (result.outcome === 'blocked') counts.blocked += 1
      else counts.stopping += 1
    } catch { counts.blocked += 1 }
  }
  return counts
}
