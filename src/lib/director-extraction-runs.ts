import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { DirectorEvidenceBinding } from '@/lib/director-evidence-delivery-core'
import {
  directorEvidenceBindingFromInput,
  directorEvidenceDigest,
  getDirectorEvidenceOutboxCore,
} from '@/lib/director-evidence-delivery-core'
import {
  DIRECTOR_EXTRACTION_REVIEW_STATUS_BY_PHASE,
  buildDirectorPerceptionCheckpointInput,
  directorExtractionContractDigest,
  directorExtractionDigest,
  directorExtractionIdentitySchema,
  directorExtractionProjectionReceiptSchema,
  directorExtractionProgress,
  directorExtractionPhases,
  parseDirectorExtractionOutput,
  reviewedDirectorReferencesSchema,
  type DirectorExtractionCandidateOutput,
  type DirectorExtractionCurrentPhase,
  type DirectorExtractionIdentity,
  type DirectorExtractionPhase,
  type DirectorExtractionProjectionReceipt,
  type DirectorExtractionStatus,
  type ReviewedDirectorReferences,
} from '@/lib/director-extraction-state'
import {
  completeN8nChildExecution,
  createAndClaimN8nChildRunFromParent,
  ensureN8nChildRunFromParent,
  failN8nChildExecution,
  getScopedN8nTaskRunByTaskId,
  renewN8nChildExecutionLease,
  type N8nChildExecutionLease,
  type N8nTaskRun,
  type N8nTaskScope,
} from '@/lib/n8n-task-runs'
import { assertDirectorBrainScope, getDirectorBrainScope } from '@/lib/director-brain-scope'
import { isDirectorExtractionDeterministicConflict } from '@/lib/director-extraction-errors'

const CHILD_KIND = 'director-extraction'
const DEFAULT_OWNER_INSTANCE_ID = randomBytes(32).toString('hex')
export const DIRECTOR_EXTRACTION_WAITING_SCAN_MULTIPLIER = 20
export const DIRECTOR_EXTRACTION_WAITING_MAX_SCAN = 2_000
export const DIRECTOR_EXTRACTION_CLAIM_SCAN_LIMIT = 200

type CheckpointRow = {
  phase_task_id: string
  phase: DirectorExtractionPhase
  input_sha256: string
  phase_input: string
  output_sha256: string
  candidate_output: string
  created_at: number
}
type ProjectionRow = {
  phase_task_id: string
  receipt_json: string
  receipt_sha256: string
  created_at: number
}
type ReviewRow = {
  phase_task_id: string
  receipt_type: 'candidate_review' | 'intent_review' | 'candidate_rejection'
  reviewed_references: string
  error_code: string | null
  receipt_sha256: string
  created_at: number
}

export interface DirectorExtractionJob extends DirectorExtractionIdentity {
  phaseTaskId: string | null
  objective: string
  status: DirectorExtractionStatus
  currentPhase: DirectorExtractionCurrentPhase
  reviewedReferences: ReviewedDirectorReferences
  attemptCount: number
  maxAttempts: number
  ownerInstanceId: string | null
  leaseToken: string | null
  leaseExpiresAt: number | null
  revision: number
  lastErrorCode: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

export interface DirectorExtractionCheckpoint {
  sourceTaskId: string
  phaseTaskId: string
  phase: DirectorExtractionPhase
  inputSha256: string
  phaseInput: Record<string, unknown>
  outputSha256: string
  candidateOutput: DirectorExtractionCandidateOutput
  projectionState: 'pending' | 'delivered'
  projectionReceipt: DirectorExtractionProjectionReceipt | null
  projectedAt: number | null
  createdAt: number
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw)
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown> : null
  } catch { return null }
}

function safeObjective(value: unknown): string {
  const result = String(value || '').replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim()
  if (result.length > 500) throw new Error('director_extraction_objective_invalid')
  return result
}

/** @deprecated The successful video-analysis task is now the only extraction root. */
export function directorExtractionTaskIdentity(_kind: 'task' | 'idem', sourceTaskId: string): string {
  return sourceTaskId
}

export function directorExtractionPhaseTaskIdentity(
  kind: 'task' | 'idem', sourceTaskId: string, phase: DirectorExtractionPhase,
): string {
  const digest = createHash('sha256')
    .update(`${CHILD_KIND}:${kind}:${sourceTaskId}:${phase}`, 'utf8').digest('hex').slice(0, 24)
  return `director-${kind}:${phase}:${sourceTaskId.slice(0, 51)}:${digest}`.slice(0, 120)
}

function sourceRun(db: Database.Database, taskId: string, scope: N8nTaskScope): N8nTaskRun | null {
  const run = getScopedN8nTaskRunByTaskId(db, taskId, scope)
  if (!run) return null
  const binding = db.prepare(`
    SELECT task_type FROM n8n_workflow_bindings
    WHERE id = ? AND tenant_id = ? AND workspace_id = ?
  `).get(run.bindingId, scope.tenantId, scope.workspaceId) as { task_type: string } | undefined
  if (!['video-autoworker', 'openclaw'].includes(run.source)
    || run.status !== 'succeeded' || binding?.task_type !== 'video-analysis' || !run.output
    || run.output.taskType !== 'video-analysis') return null
  return run
}

function phaseInput(
  source: N8nTaskRun,
  phase: DirectorExtractionPhase,
  objective: string,
  reviewedReferences: ReviewedDirectorReferences,
): Record<string, unknown> {
  return {
    schemaVersion: 2,
    taskType: 'video-analysis',
    childKind: CHILD_KIND,
    directorPhase: phase,
    parentTaskId: source.taskId,
    objective,
    extractionContractDigest: directorExtractionContractDigest(),
    dependencyDigest: directorExtractionDigest({
      sourceTaskId: source.taskId,
      sourceResultSha256: directorEvidenceDigest(source.output),
      phase,
      reviewedReferences,
    }),
  }
}

function phaseRun(
  db: Database.Database,
  source: N8nTaskRun,
  phase: DirectorExtractionPhase,
): N8nTaskRun | null {
  const taskId = directorExtractionPhaseTaskIdentity('task', source.taskId, phase)
  const run = getScopedN8nTaskRunByTaskId(db, taskId, {
    tenantId: source.tenantId, workspaceId: source.workspaceId,
  })
  if (!run) return null
  if (run.source !== 'n8n-node' || run.bindingId !== source.bindingId
    || run.idempotencyKey !== directorExtractionPhaseTaskIdentity('idem', source.taskId, phase)
    || run.routing.taskType !== 'video-analysis'
    || run.routing.childKind !== CHILD_KIND
    || run.routing.directorPhase !== phase
    || run.routing.parentTaskId !== source.taskId
    || run.input.taskType !== 'video-analysis'
    || run.input.childKind !== CHILD_KIND
    || run.input.directorPhase !== phase
    || run.input.parentTaskId !== source.taskId
    || typeof run.input.objective !== 'string'
    || run.input.extractionContractDigest !== directorExtractionContractDigest()) {
    throw new Error('director_extraction_phase_task_invalid')
  }
  return run
}

function identityFromSource(source: N8nTaskRun): DirectorExtractionIdentity {
  const binding = directorEvidenceBindingFromInput(source.input)
  if (!binding) throw new Error('director_extraction_work_not_registered')
  return directorExtractionIdentitySchema.parse({
    sourceTaskId: source.taskId,
    sourceBindingId: source.bindingId,
    tenantId: source.tenantId,
    workspaceId: source.workspaceId,
    workId: binding.workId,
    workQueryDigest: binding.queryDigest,
    materialId: source.output?.materialId,
    sourceResultSha256: directorEvidenceDigest(source.output),
    extractionContractDigest: directorExtractionContractDigest(),
  })
}

function lockedIdentityFromPerceptionCheckpoint(
  db: Database.Database,
  source: N8nTaskRun,
  perception: N8nTaskRun,
): DirectorExtractionIdentity | null {
  const row = db.prepare(`
    SELECT phase, input_sha256, phase_input
    FROM director_extraction_checkpoints
    WHERE phase_task_id = ?
  `).get(perception.taskId) as Pick<CheckpointRow,
    'phase' | 'input_sha256' | 'phase_input'> | undefined
  if (!row) return null
  const phaseInputValue = parseObject(row.phase_input)
  if (row.phase !== 'perception' || !phaseInputValue
    || row.input_sha256 !== directorExtractionDigest(phaseInputValue)) {
    throw new Error('director_extraction_checkpoint_invalid')
  }
  const identity = directorExtractionIdentitySchema.parse({
    sourceTaskId: phaseInputValue.sourceTaskId,
    sourceBindingId: phaseInputValue.sourceBindingId,
    tenantId: phaseInputValue.tenantId,
    workspaceId: phaseInputValue.workspaceId,
    workId: phaseInputValue.workId,
    workQueryDigest: phaseInputValue.workQueryDigest,
    materialId: phaseInputValue.materialId,
    sourceResultSha256: phaseInputValue.sourceResultSha256,
    extractionContractDigest: phaseInputValue.extractionContractDigest,
  })
  if (identity.sourceTaskId !== source.taskId
    || row.input_sha256 !== directorExtractionDigest(
      buildDirectorPerceptionCheckpointInput(identity),
    )) {
    throw new Error('director_extraction_checkpoint_invalid')
  }
  return identity
}

function sameExtractionIdentity(
  left: DirectorExtractionIdentity,
  right: DirectorExtractionIdentity,
): boolean {
  return directorExtractionDigest(left) === directorExtractionDigest(right)
}

function outboxMatchesExtractionIdentity(
  db: Database.Database,
  identity: DirectorExtractionIdentity,
): boolean {
  const outbox = getDirectorEvidenceOutboxCore(db, identity.sourceTaskId)
  return !outbox || (
    outbox.taskId === identity.sourceTaskId
    && outbox.bindingId === identity.sourceBindingId
    && outbox.tenantId === identity.tenantId
    && outbox.workspaceId === identity.workspaceId
    && outbox.workId === identity.workId
    && outbox.queryDigest === identity.workQueryDigest
    && outbox.resultSha256 === identity.sourceResultSha256
  )
}

function reviewsForSource(db: Database.Database, sourceTaskId: string): ReviewRow[] {
  return db.prepare(`
    SELECT receipt.* FROM director_extraction_review_receipts receipt
    JOIN n8n_task_runs phase ON phase.task_id = receipt.phase_task_id
    WHERE phase.source = 'n8n-node' AND json_valid(phase.input) = 1
      AND json_extract(phase.input, '$.childKind') = ?
      AND json_extract(phase.input, '$.parentTaskId') = ?
  `).all(CHILD_KIND, sourceTaskId) as ReviewRow[]
}

function parseReviewed(raw: string): ReviewedDirectorReferences {
  const value = parseObject(raw)
  if (!value) throw new Error('director_extraction_review_references_invalid')
  return Object.keys(value).length ? reviewedDirectorReferencesSchema.parse(value) : {}
}

function mergeReviewed(rows: ReviewRow[]): ReviewedDirectorReferences {
  const merged: Record<string, string[]> = {}
  for (const row of rows) {
    if (row.receipt_type === 'candidate_rejection') continue
    for (const [table, ids] of Object.entries(parseReviewed(row.reviewed_references))) {
      merged[table] = [...new Set([...(merged[table] || []), ...(ids || [])])].sort()
    }
  }
  return Object.keys(merged).length ? reviewedDirectorReferencesSchema.parse(merged) : {}
}

function leaseForRun(db: Database.Database, run: N8nTaskRun): N8nChildExecutionLease | null {
  const row = db.prepare(`
    SELECT owner_instance_id, lease_token, lease_expires_at, revision
    FROM n8n_child_execution_leases
    WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
  `).get(run.taskId, run.tenantId, run.workspaceId) as {
    owner_instance_id: string; lease_token: string; lease_expires_at: number; revision: number
  } | undefined
  return row ? {
    taskId: run.taskId,
    ownerInstanceId: row.owner_instance_id,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    revision: row.revision,
  } : null
}

function retryRevision(run: N8nTaskRun | null): number {
  const value = run?.routing.retryRevision
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0
}

function deriveJob(db: Database.Database, source: N8nTaskRun): DirectorExtractionJob {
  const perception = phaseRun(db, source, 'perception')
  if (!perception) throw new Error('director_extraction_not_registered')
  const lockedIdentity = lockedIdentityFromPerceptionCheckpoint(db, source, perception)
  let currentIdentity: DirectorExtractionIdentity | null = null
  try {
    currentIdentity = identityFromSource(source)
  } catch {
    // A registered chain keeps using its immutable perception identity. A
    // later malformed parent is a conflict, never a replacement identity.
    if (!lockedIdentity) throw new Error('director_extraction_source_conflict')
  }
  const identity = lockedIdentity || currentIdentity!
  const sourceIdentityConflict = Boolean(
    lockedIdentity
      && (!currentIdentity || !sameExtractionIdentity(lockedIdentity, currentIdentity)),
  ) || !outboxMatchesExtractionIdentity(db, identity)
  const reviews = reviewsForSource(db, source.taskId)
  const reviewMap = new Map(reviews.map(row => [`${row.phase_task_id}:${row.receipt_type}`, row]))
  const reviewedReferences = mergeReviewed(reviews)
  const objective = safeObjective(perception.input.objective)
  let status: DirectorExtractionStatus = 'pending'
  let currentPhase: DirectorExtractionCurrentPhase = 'perception'
  let currentRun: N8nTaskRun | null = perception
  for (const phase of directorExtractionPhases) {
    currentPhase = phase
    const run = phaseRun(db, source, phase)
    currentRun = run
    if (!run) { status = 'pending'; break }
    if (run.status === 'queued') {
      const outbox = phase === 'perception' ? getDirectorEvidenceOutboxCore(db, source.taskId) : null
      status = outbox && outbox.status !== 'delivered'
        ? outbox.status === 'conflict' ? 'conflict' : 'awaiting_evidence_projection'
        : 'pending'
      break
    }
    if (run.status === 'running') { status = 'running'; break }
    if (run.status === 'failed') {
      status = run.error && isDirectorExtractionDeterministicConflict(run.error)
        ? 'conflict' : 'failed'
      break
    }
    if (run.status === 'cancelled') { status = 'conflict'; break }
    if (run.status !== 'succeeded') { status = 'failed'; break }
    const rejection = reviewMap.get(`${run.taskId}:candidate_rejection`)
    if (rejection) { status = 'conflict'; break }
    if (!reviewMap.has(`${run.taskId}:candidate_review`)) {
      status = DIRECTOR_EXTRACTION_REVIEW_STATUS_BY_PHASE[phase]
      break
    }
    if (phase === 'understanding' && !reviewMap.has(`${run.taskId}:intent_review`)) {
      status = 'awaiting_intent_review'
      break
    }
    if (phase === 'technique') {
      status = 'completed'
      currentPhase = 'complete'
      break
    }
  }
  if (sourceIdentityConflict) status = 'conflict'
  const lease = currentRun ? leaseForRun(db, currentRun) : null
  return {
    ...identity,
    phaseTaskId: currentRun?.taskId || null,
    objective,
    status,
    currentPhase,
    reviewedReferences,
    attemptCount: currentRun?.attemptCount || 0,
    maxAttempts: currentRun?.maxAttempts || perception.maxAttempts,
    ownerInstanceId: lease?.ownerInstanceId || null,
    leaseToken: lease?.leaseToken || null,
    leaseExpiresAt: lease?.leaseExpiresAt || null,
    revision: lease?.revision || retryRevision(currentRun) + 1,
    lastErrorCode: sourceIdentityConflict ? 'director_extraction_source_conflict'
      : currentRun?.error
      || (currentRun ? reviewMap.get(`${currentRun.taskId}:candidate_rejection`)?.error_code : null)
      || null,
    createdAt: perception.createdAt,
    updatedAt: currentRun?.updatedAt || perception.updatedAt,
    completedAt: status === 'completed' ? currentRun?.completedAt || null : null,
  }
}

function ensurePhase(
  db: Database.Database,
  source: N8nTaskRun,
  phase: DirectorExtractionPhase,
  objective: string,
  reviewedReferences: ReviewedDirectorReferences,
  maxAttempts: number,
  nowSeconds?: number,
): N8nTaskRun {
  const input = phaseInput(source, phase, objective, reviewedReferences)
  const scope = { tenantId: source.tenantId, workspaceId: source.workspaceId }
  const result = ensureN8nChildRunFromParent(db, {
    parentTaskId: source.taskId,
    parentIdempotencyKey: source.idempotencyKey,
    bindingId: source.bindingId,
    childTaskId: directorExtractionPhaseTaskIdentity('task', source.taskId, phase),
    childIdempotencyKey: directorExtractionPhaseTaskIdentity('idem', source.taskId, phase),
    source: 'n8n-node',
    routing: {
      taskType: 'video-analysis', childKind: CHILD_KIND,
      directorPhase: phase, parentTaskId: source.taskId, memoryMode: 'none',
    },
    taskInput: input,
    delivery: { mode: 'none' },
    maxAttempts,
    parentMode: 'succeeded_postprocess',
  }, scope, { nowSeconds })
  if ((result.outcome !== 'created' && result.outcome !== 'existing') || !result.child) {
    throw new Error('director_extraction_phase_task_conflict')
  }
  return phaseRun(db, source, phase)!
}

function createPerceptionCheckpoint(
  db: Database.Database,
  source: N8nTaskRun,
  identity: DirectorExtractionIdentity,
  now: number,
): void {
  const taskId = directorExtractionPhaseTaskIdentity('task', source.taskId, 'perception')
  const input = buildDirectorPerceptionCheckpointInput(identity)
  const output = parseDirectorExtractionOutput('perception', {
    schemaVersion: 1, phase: 'perception', candidates: [],
  })
  const existing = db.prepare(`
    SELECT input_sha256, output_sha256 FROM director_extraction_checkpoints WHERE phase_task_id = ?
  `).get(taskId) as { input_sha256: string; output_sha256: string } | undefined
  if (existing) {
    if (existing.input_sha256 !== directorExtractionDigest(input)
      || existing.output_sha256 !== directorExtractionDigest(output)) {
      throw new Error('director_extraction_checkpoint_conflict')
    }
    return
  }
  db.prepare(`
    INSERT INTO director_extraction_checkpoints (
      phase_task_id, phase, input_sha256, phase_input,
      output_sha256, candidate_output, created_at
    ) VALUES (?, 'perception', ?, ?, ?, ?, ?)
  `).run(
    taskId, directorExtractionDigest(input), JSON.stringify(input),
    directorExtractionDigest(output), JSON.stringify(output), now,
  )
}

export function getDirectorExtractionJob(
  db: Database.Database,
  sourceTaskId: string,
  scope?: N8nTaskScope,
): DirectorExtractionJob | null {
  const effectiveScope = scope || getDirectorBrainScope()
  const source = sourceRun(db, sourceTaskId, effectiveScope)
  if (!source || !phaseRun(db, source, 'perception')) return null
  return deriveJob(db, source)
}

export function listDirectorExtractionJobsForWork(
  db: Database.Database,
  workId: string,
  scope: N8nTaskScope,
): DirectorExtractionJob[] {
  const rows = db.prepare(`
    SELECT DISTINCT source.task_id
    FROM n8n_task_runs source
    JOIN n8n_task_runs perception
      ON json_valid(perception.input) = 1
     AND json_extract(perception.input, '$.parentTaskId') = source.task_id
     AND perception.tenant_id = source.tenant_id
     AND perception.workspace_id = source.workspace_id
    JOIN director_extraction_checkpoints checkpoint
      ON checkpoint.phase_task_id = perception.task_id
     AND checkpoint.phase = 'perception'
     AND json_valid(checkpoint.phase_input) = 1
    WHERE source.tenant_id = ? AND source.workspace_id = ?
      AND source.source IN ('video-autoworker', 'openclaw')
      AND source.status = 'succeeded'
      AND perception.source = 'n8n-node'
      AND json_extract(perception.input, '$.childKind') = ?
      AND json_extract(perception.input, '$.directorPhase') = 'perception'
      AND json_extract(checkpoint.phase_input, '$.workId') = ?
    ORDER BY COALESCE(source.completed_at, source.updated_at), source.id, source.task_id
  `).all(scope.tenantId, scope.workspaceId, CHILD_KIND, workId) as Array<{ task_id: string }>
  return rows.map(row => getDirectorExtractionJob(db, row.task_id, scope))
    .filter((job): job is DirectorExtractionJob => job !== null && job.workId === workId)
}

export function findDirectorExtractionJobForWork(
  db: Database.Database,
  workId: string,
  scope: N8nTaskScope,
): { job: DirectorExtractionJob | null; ambiguous: boolean } {
  const jobs = listDirectorExtractionJobsForWork(db, workId, scope)
  return jobs.length > 1 ? { job: null, ambiguous: true } : { job: jobs[0] || null, ambiguous: false }
}

export function registerDirectorExtractionJob(
  db: Database.Database,
  sourceTaskId: string,
  scope: N8nTaskScope = getDirectorBrainScope(),
  options: { binding?: DirectorEvidenceBinding; objective?: string; maxAttempts?: number; nowSeconds?: number } = {},
): { created: boolean; job: DirectorExtractionJob } {
  assertDirectorBrainScope(scope)
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  const source = sourceRun(db, sourceTaskId, scope)
  if (!source) throw new Error('director_extraction_source_not_ready')
  const sourceBinding = directorEvidenceBindingFromInput(source.input)
  if (!sourceBinding) throw new Error('director_extraction_work_not_registered')
  if (options.binding && (options.binding.workId !== sourceBinding.workId
    || options.binding.queryDigest !== sourceBinding.queryDigest)) {
    throw new Error('director_extraction_work_binding_conflict')
  }
  const objective = safeObjective(options.objective)
  const maxAttempts = Math.max(1, Math.min(11, Math.floor(options.maxAttempts || 3)))
  const existing = getDirectorExtractionJob(db, sourceTaskId, scope)
  if (existing) {
    if (existing.workId !== sourceBinding.workId
      || existing.sourceBindingId !== source.bindingId
      || existing.workQueryDigest !== sourceBinding.queryDigest) {
      throw new Error('director_extraction_work_binding_conflict')
    }
    if (existing.objective !== objective) throw new Error('director_extraction_objective_conflict')
    return { created: false, job: existing }
  }
  return db.transaction(() => {
    const identity = identityFromSource(source)
    ensurePhase(db, source, 'perception', objective, {}, maxAttempts, now)
    createPerceptionCheckpoint(db, source, identity, now)
    return { created: true, job: getDirectorExtractionJob(db, sourceTaskId, scope)! }
  }).immediate()
}

export function getDirectorExtractionCheckpoint(
  db: Database.Database,
  sourceTaskId: string,
  phase: DirectorExtractionPhase,
): DirectorExtractionCheckpoint | null {
  const job = getDirectorExtractionJob(db, sourceTaskId)
  if (!job) return null
  const phaseTaskId = directorExtractionPhaseTaskIdentity('task', sourceTaskId, phase)
  const row = db.prepare(`SELECT * FROM director_extraction_checkpoints WHERE phase_task_id = ?`)
    .get(phaseTaskId) as CheckpointRow | undefined
  if (!row || row.phase !== phase) return null
  const phaseInputValue = parseObject(row.phase_input)
  const candidateValue = parseObject(row.candidate_output)
  if (!phaseInputValue || !candidateValue
    || row.input_sha256 !== directorExtractionDigest(phaseInputValue)
    || row.output_sha256 !== directorExtractionDigest(candidateValue)) {
    throw new Error('director_extraction_checkpoint_invalid')
  }
  const candidateOutput = parseDirectorExtractionOutput(phase, candidateValue)
  const projection = db.prepare(`
    SELECT * FROM director_extraction_projection_receipts WHERE phase_task_id = ?
  `).get(phaseTaskId) as ProjectionRow | undefined
  let projectionReceipt: DirectorExtractionProjectionReceipt | null = null
  if (projection) {
    const value = parseObject(projection.receipt_json)
    projectionReceipt = directorExtractionProjectionReceiptSchema.parse(value)
    if (projection.receipt_sha256 !== directorExtractionDigest(projectionReceipt)) {
      throw new Error('director_extraction_projection_receipt_invalid')
    }
  }
  return {
    sourceTaskId, phaseTaskId, phase,
    inputSha256: row.input_sha256,
    phaseInput: phaseInputValue,
    outputSha256: row.output_sha256,
    candidateOutput,
    projectionState: projectionReceipt ? 'delivered' : 'pending',
    projectionReceipt,
    projectedAt: projection?.created_at || null,
    createdAt: row.created_at,
  }
}

export function listDirectorExtractionCheckpoints(
  db: Database.Database,
  sourceTaskId: string,
): DirectorExtractionCheckpoint[] {
  return directorExtractionPhases
    .map(phase => getDirectorExtractionCheckpoint(db, sourceTaskId, phase))
    .filter((item): item is DirectorExtractionCheckpoint => Boolean(item))
}

export function getDirectorExtractionSourceOutput(
  db: Database.Database,
  job: DirectorExtractionJob,
): Record<string, unknown> {
  const source = sourceRun(db, job.sourceTaskId, {
    tenantId: job.tenantId, workspaceId: job.workspaceId,
  })
  if (!source?.output || directorEvidenceDigest(source.output) !== job.sourceResultSha256) {
    throw new Error('director_extraction_source_conflict')
  }
  return source.output
}

export function listDirectorExtractionJobsByStatuses(
  db: Database.Database,
  statuses: readonly DirectorExtractionStatus[],
  limit = 20,
  options: { nowSeconds?: number; scanMultiplier?: number } = {},
): DirectorExtractionJob[] {
  const scope = getDirectorBrainScope()
  const scanLimit = Math.min(
    DIRECTOR_EXTRACTION_WAITING_MAX_SCAN,
    Math.max(limit, limit * (options.scanMultiplier || DIRECTOR_EXTRACTION_WAITING_SCAN_MULTIPLIER)),
  )
  const total = Number((db.prepare(`
    SELECT COUNT(DISTINCT json_extract(phase.input, '$.parentTaskId'))
    FROM n8n_task_runs phase
    JOIN n8n_task_runs source
      ON source.task_id = json_extract(phase.input, '$.parentTaskId')
     AND source.tenant_id = phase.tenant_id AND source.workspace_id = phase.workspace_id
    WHERE phase.tenant_id = ? AND phase.workspace_id = ? AND phase.source = 'n8n-node'
      AND source.source IN ('video-autoworker', 'openclaw')
      AND json_valid(phase.input) = 1 AND json_extract(phase.input, '$.childKind') = ?
  `).pluck().get(scope.tenantId, scope.workspaceId, CHILD_KIND) as number) || 0)
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  const effectiveScanLimit = Math.min(scanLimit, total)
  const offset = total > 0
    ? (Math.floor(nowSeconds / 60) * scanLimit) % total
    : 0
  const select = (rowOffset: number, rowLimit: number) => db.prepare(`
    SELECT DISTINCT source.task_id AS source_task_id,
      COALESCE(source.completed_at, source.updated_at) AS source_order
    FROM n8n_task_runs phase
    JOIN n8n_task_runs source
      ON source.task_id = json_extract(phase.input, '$.parentTaskId')
     AND source.tenant_id = phase.tenant_id AND source.workspace_id = phase.workspace_id
    WHERE phase.tenant_id = ? AND phase.workspace_id = ? AND phase.source = 'n8n-node'
      AND source.source IN ('video-autoworker', 'openclaw')
      AND json_valid(phase.input) = 1 AND json_extract(phase.input, '$.childKind') = ?
    ORDER BY source_order, source.task_id
    LIMIT ? OFFSET ?
  `).all(
    scope.tenantId, scope.workspaceId, CHILD_KIND, rowLimit, rowOffset,
  ) as Array<{ source_task_id: string; source_order: number }>
  const tail = select(offset, effectiveScanLimit)
  const wrapped = offset > 0 && tail.length < effectiveScanLimit
    ? select(0, effectiveScanLimit - tail.length)
    : []
  const rows = [...new Map(
    [...tail, ...wrapped].map(row => [row.source_task_id, row]),
  ).values()]
  const sourceOrder = new Map(rows.map(row => [row.source_task_id, row.source_order]))
  const workGroups = new Map<string, DirectorExtractionJob[]>()
  for (const row of rows) {
    const job = getDirectorExtractionJob(db, row.source_task_id, scope)
    if (!job) continue
    const groupKey = job.workId ? `work:${job.workId}` : `source:${job.sourceTaskId}`
    const group = workGroups.get(groupKey) || []
    group.push(job)
    workGroups.set(groupKey, group)
  }
  return [...workGroups.values()].flatMap(group => group.sort((left, right) => (
    Number(sourceOrder.get(left.sourceTaskId)) - Number(sourceOrder.get(right.sourceTaskId))
      || left.sourceTaskId.localeCompare(right.sourceTaskId)
  )))
    .filter(job => statuses.includes(job.status))
    .slice(0, limit)
}

function hasActiveDirectorExtractionWorkLease(
  db: Database.Database,
  scope: N8nTaskScope,
  workId: string,
  nowSeconds: number,
): boolean {
  const rows = db.prepare(`
    SELECT DISTINCT json_extract(phase.input, '$.parentTaskId') AS source_task_id
    FROM n8n_child_execution_leases lease
    JOIN n8n_task_runs phase
      ON phase.task_id = lease.task_id
     AND phase.tenant_id = lease.tenant_id AND phase.workspace_id = lease.workspace_id
    JOIN n8n_task_runs source
      ON source.task_id = json_extract(phase.input, '$.parentTaskId')
     AND source.tenant_id = phase.tenant_id AND source.workspace_id = phase.workspace_id
    WHERE lease.tenant_id = ? AND lease.workspace_id = ? AND lease.lease_expires_at > ?
      AND phase.source = 'n8n-node' AND phase.status = 'running'
      AND json_valid(phase.input) = 1 AND json_extract(phase.input, '$.childKind') = ?
      AND source.source IN ('video-autoworker', 'openclaw')
  `).all(scope.tenantId, scope.workspaceId, nowSeconds, CHILD_KIND) as Array<{
    source_task_id: string
  }>
  for (const row of rows) {
    // deriveJob resolves the immutable identity from the perception checkpoint.
    // A mutable parent input must never reassign an in-flight lease to another
    // work or make that lease disappear from work-level exclusion.
    const active = getDirectorExtractionJob(db, row.source_task_id, scope)
    if (!active) throw new Error('director_extraction_active_lease_identity_invalid')
    if (active.workId === workId) return true
  }
  return false
}

function childClaimInput(source: N8nTaskRun, run: N8nTaskRun, ownerInstanceId: string) {
  return {
    parentTaskId: source.taskId,
    parentIdempotencyKey: source.idempotencyKey,
    bindingId: source.bindingId,
    childTaskId: run.taskId,
    childIdempotencyKey: run.idempotencyKey,
    source: 'n8n-node' as const,
    routing: run.routing,
    taskInput: run.input,
    delivery: run.delivery,
    maxAttempts: run.maxAttempts,
    ownerInstanceId,
    parentMode: 'succeeded_postprocess' as const,
  }
}

export function claimNextDirectorExtractionJob(
  db: Database.Database,
  options: {
    nowSeconds?: number
    ownerInstanceId?: string
    leaseToken?: string
    requirePerceptionEvidenceReady?: boolean
  } = {},
): DirectorExtractionJob | null {
  const scope = getDirectorBrainScope()
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  const candidates = listDirectorExtractionJobsByStatuses(
    db, ['pending', 'failed', 'running'], DIRECTOR_EXTRACTION_CLAIM_SCAN_LIMIT,
    { nowSeconds, scanMultiplier: 1 },
  )
  const firstRunnableSourceByWork = new Map<string, string | null>()
  const claimCandidate = db.transaction((candidate: DirectorExtractionJob) => {
    if (candidate.currentPhase === 'complete' || !candidate.phaseTaskId) return null
    // This work-level exclusion and the child claim must share one IMMEDIATE
    // transaction. Keeping the read outside lets two processes both observe
    // an empty work and then claim different sources after their writes
    // serialize.
    if (candidate.workId
      && hasActiveDirectorExtractionWorkLease(db, scope, candidate.workId, nowSeconds)) {
      return null
    }
    if (candidate.workId) {
      if (!firstRunnableSourceByWork.has(candidate.workId)) {
        const firstRunnable = listDirectorExtractionJobsForWork(db, candidate.workId, scope)
          .find(job => (
            ['pending', 'failed', 'running'].includes(job.status)
            && !(job.status === 'failed' && job.attemptCount >= job.maxAttempts)
            && job.currentPhase !== 'complete'
            && Boolean(job.phaseTaskId)
          ))
        firstRunnableSourceByWork.set(candidate.workId, firstRunnable?.sourceTaskId || null)
      }
      if (firstRunnableSourceByWork.get(candidate.workId) !== candidate.sourceTaskId) return null
    }
    const source = sourceRun(db, candidate.sourceTaskId, scope)
    const run = source && phaseRun(db, source, candidate.currentPhase)
    if (!source || !run) return null
    if (options.requirePerceptionEvidenceReady && candidate.currentPhase === 'perception') {
      const outbox = getDirectorEvidenceOutboxCore(db, candidate.sourceTaskId)
      if (!outbox || outbox.status !== 'delivered') return null
    }
    const result = createAndClaimN8nChildRunFromParent(
      db,
      childClaimInput(source, run, options.ownerInstanceId || DEFAULT_OWNER_INSTANCE_ID),
      scope,
      {
        nowSeconds,
        leaseToken: options.leaseToken,
        initialLeaseRevision: candidate.revision,
      },
    )
    return result.outcome === 'claimed' && result.lease
      ? getDirectorExtractionJob(db, candidate.sourceTaskId, scope)
      : null
  })
  for (const candidate of candidates) {
    if (candidate.status === 'failed' && candidate.attemptCount >= candidate.maxAttempts) continue
    if (candidate.currentPhase === 'complete' || !candidate.phaseTaskId) continue
    const claimed = claimCandidate.immediate(candidate)
    if (claimed) return claimed
  }
  return null
}

function jobLease(job: DirectorExtractionJob): N8nChildExecutionLease {
  if (!job.phaseTaskId || !job.ownerInstanceId || !job.leaseToken
    || job.leaseExpiresAt === null) throw new Error('director_extraction_lease_lost')
  return {
    taskId: job.phaseTaskId,
    ownerInstanceId: job.ownerInstanceId,
    leaseToken: job.leaseToken,
    leaseExpiresAt: job.leaseExpiresAt,
    revision: job.revision,
  }
}

export function renewDirectorExtractionLease(
  db: Database.Database,
  job: DirectorExtractionJob,
  options: { nowSeconds?: number } = {},
): DirectorExtractionJob {
  const lease = renewN8nChildExecutionLease(
    db, jobLease(job), { tenantId: job.tenantId, workspaceId: job.workspaceId },
    { nowSeconds: options.nowSeconds },
  )
  if (!lease) throw new Error('director_extraction_lease_lost')
  const current = getDirectorExtractionJob(db, job.sourceTaskId, job)
  if (!current || (current.status === 'conflict'
    && current.lastErrorCode === 'director_extraction_source_conflict')) {
    throw new Error('director_extraction_source_conflict')
  }
  return current
}

export function stageDirectorExtractionCheckpoint(
  db: Database.Database,
  job: DirectorExtractionJob,
  phaseInputValue: Record<string, unknown>,
  candidateValue: unknown,
  options: { nowSeconds?: number } = {},
): DirectorExtractionCheckpoint {
  if (job.currentPhase === 'complete' || !job.phaseTaskId) {
    throw new Error('director_extraction_phase_invalid')
  }
  renewDirectorExtractionLease(db, job, options)
  const output = parseDirectorExtractionOutput(job.currentPhase, candidateValue)
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  const inputSha = directorExtractionDigest(phaseInputValue)
  const outputSha = directorExtractionDigest(output)
  const existing = getDirectorExtractionCheckpoint(db, job.sourceTaskId, job.currentPhase)
  if (existing) {
    if (existing.inputSha256 !== inputSha || existing.outputSha256 !== outputSha) {
      throw new Error('director_extraction_checkpoint_conflict')
    }
    return existing
  }
  db.prepare(`
    INSERT INTO director_extraction_checkpoints (
      phase_task_id, phase, input_sha256, phase_input,
      output_sha256, candidate_output, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.phaseTaskId, job.currentPhase, inputSha, JSON.stringify(phaseInputValue),
    outputSha, JSON.stringify(output), now,
  )
  return getDirectorExtractionCheckpoint(db, job.sourceTaskId, job.currentPhase)!
}

export function completeDirectorExtractionProjection(
  db: Database.Database,
  job: DirectorExtractionJob,
  receiptValue: DirectorExtractionProjectionReceipt,
  options: { nowSeconds?: number } = {},
): DirectorExtractionJob {
  if (job.currentPhase === 'complete' || !job.phaseTaskId) {
    throw new Error('director_extraction_phase_invalid')
  }
  const phase = job.currentPhase
  const receipt = directorExtractionProjectionReceiptSchema.parse(receiptValue)
  if (receipt.phase !== phase) throw new Error('director_extraction_projection_phase_mismatch')
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  return db.transaction(() => {
    const current = getDirectorExtractionJob(db, job.sourceTaskId, job)
    const outbox = getDirectorEvidenceOutboxCore(db, job.sourceTaskId)
    if (!current || !sameExtractionIdentity(current, job)
      || (current.status === 'conflict'
        && current.lastErrorCode === 'director_extraction_source_conflict')
      || !outbox || !outboxMatchesExtractionIdentity(db, job)) {
      throw new Error('director_extraction_source_conflict')
    }
    const existing = db.prepare(`
      SELECT receipt_sha256 FROM director_extraction_projection_receipts WHERE phase_task_id = ?
    `).get(job.phaseTaskId) as { receipt_sha256: string } | undefined
    if (existing) {
      if (existing.receipt_sha256 !== directorExtractionDigest(receipt)) {
        throw new Error('director_extraction_projection_conflict')
      }
      return current
    }
    const checkpoint = getDirectorExtractionCheckpoint(db, job.sourceTaskId, phase)
    if (!checkpoint) throw new Error('director_extraction_checkpoint_missing')
    db.prepare(`
      INSERT INTO director_extraction_projection_receipts (
        phase_task_id, receipt_json, receipt_sha256, created_at
      ) VALUES (?, ?, ?, ?)
    `).run(job.phaseTaskId, JSON.stringify(receipt), directorExtractionDigest(receipt), now)
    const settled = completeN8nChildExecution(
      db, jobLease(job), {
        schemaVersion: 1,
        childKind: CHILD_KIND,
        directorPhase: phase,
        checkpointSha256: checkpoint.outputSha256,
        projectionReceiptSha256: directorExtractionDigest(receipt),
      },
      { tenantId: job.tenantId, workspaceId: job.workspaceId },
      { nowSeconds: now },
    )
    if (!settled.settled) throw new Error('director_extraction_lease_lost')
    return getDirectorExtractionJob(db, job.sourceTaskId, job)!
  }).immediate()
}

export function pauseDirectorExtractionForEvidence(
  db: Database.Database,
  job: DirectorExtractionJob,
  _options: { nowSeconds?: number } = {},
): DirectorExtractionJob {
  const current = getDirectorExtractionJob(db, job.sourceTaskId, job)
  if (!current) throw new Error('director_extraction_source_conflict')
  if (current.status === 'awaiting_evidence_projection') return current
  throw new Error('director_extraction_evidence_projection_state_invalid')
}

export function failDirectorExtractionPhase(
  db: Database.Database,
  job: DirectorExtractionJob,
  errorCode: string,
  options: { nowSeconds?: number; conflict?: boolean } = {},
): DirectorExtractionJob {
  const current = getDirectorExtractionJob(db, job.sourceTaskId, job)
  if (!current) throw new Error('director_extraction_source_conflict')
  if (current.status === 'failed') return current
  if (current.status === 'conflict'
    && current.lastErrorCode !== 'director_extraction_source_conflict') return current
  const settled = failN8nChildExecution(
    db, jobLease(job), String(errorCode).slice(0, 200),
    { tenantId: job.tenantId, workspaceId: job.workspaceId },
    { nowSeconds: options.nowSeconds },
  )
  if (!settled.settled) throw new Error('director_extraction_lease_lost')
  return getDirectorExtractionJob(db, job.sourceTaskId, job)!
}

export function retryExhaustedDirectorExtractionJob(
  db: Database.Database,
  sourceTaskId: string,
  scope: N8nTaskScope,
  options: { nowSeconds?: number } = {},
): DirectorExtractionJob {
  const job = getDirectorExtractionJob(db, sourceTaskId, scope)
  if (!job) throw new Error('director_extraction_source_not_found')
  if (job.status !== 'failed' || job.attemptCount < job.maxAttempts) return job
  if (!job.phaseTaskId || job.lastErrorCode === null
    || isDirectorExtractionDeterministicConflict(job.lastErrorCode)) return job
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  const retried = db.transaction(() => db.prepare(`
    UPDATE n8n_task_runs AS phase
    SET status = 'queued', attempt_count = 0, error = NULL,
        started_at = NULL, completed_at = NULL, updated_at = ?,
        routing = json_set(routing, '$.retryRevision',
          COALESCE(json_extract(routing, '$.retryRevision'), 0) + 1)
    WHERE phase.task_id = ? AND phase.tenant_id = ? AND phase.workspace_id = ?
      AND phase.source = 'n8n-node' AND phase.status = 'failed'
      AND phase.attempt_count >= phase.max_attempts AND phase.error = ?
      AND json_valid(phase.input) = 1
      AND json_extract(phase.input, '$.childKind') = ?
      AND json_extract(phase.input, '$.parentTaskId') = ?
      AND NOT EXISTS (
        SELECT 1 FROM n8n_child_execution_leases lease
        WHERE lease.task_id = phase.task_id
          AND lease.tenant_id = phase.tenant_id
          AND lease.workspace_id = phase.workspace_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM director_extraction_projection_receipts projection
        WHERE projection.phase_task_id = phase.task_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM director_extraction_review_receipts review
        WHERE review.phase_task_id = phase.task_id
          AND review.receipt_type = 'candidate_rejection'
      )
      AND NOT EXISTS (
        SELECT 1 FROM n8n_director_evidence_outbox outbox
        WHERE outbox.task_id = ? AND outbox.status = 'conflict'
      )
  `).run(
    now,
    job.phaseTaskId,
    scope.tenantId,
    scope.workspaceId,
    job.lastErrorCode,
    CHILD_KIND,
    job.sourceTaskId,
    job.sourceTaskId,
  ).changes).immediate()
  const current = getDirectorExtractionJob(db, sourceTaskId, scope)
  if (!current) throw new Error('director_extraction_source_not_found')
  if (retried === 1 || current.status !== 'failed'
    || current.attemptCount < current.maxAttempts) return current
  throw new Error('director_extraction_retry_conflict')
}

function insertReview(
  db: Database.Database,
  phaseTaskId: string,
  type: ReviewRow['receipt_type'],
  references: ReviewedDirectorReferences,
  errorCode: string | null,
  now: number,
): void {
  const payload = type === 'candidate_rejection' && Object.keys(references).length === 0
    ? {} as ReviewedDirectorReferences
    : reviewedDirectorReferencesSchema.parse(references)
  const digest = directorExtractionDigest({
    phaseTaskId,
    receiptType: type,
    reviewedReferences: payload,
    errorCode,
  })
  const existing = db.prepare(`
    SELECT receipt_sha256 FROM director_extraction_review_receipts
    WHERE phase_task_id = ? AND receipt_type = ?
  `).get(phaseTaskId, type) as { receipt_sha256: string } | undefined
  if (existing) {
    if (existing.receipt_sha256 !== digest) throw new Error('director_extraction_review_conflict')
    return
  }
  db.prepare(`
    INSERT INTO director_extraction_review_receipts (
      phase_task_id, receipt_type, reviewed_references,
      error_code, receipt_sha256, created_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(phaseTaskId, type, JSON.stringify(payload), errorCode, digest, now)
}

function replayedReviewMatches(
  db: Database.Database,
  sourceTaskId: string,
  type: ReviewRow['receipt_type'],
  references: ReviewedDirectorReferences,
  errorCode: string | null = null,
): boolean {
  return reviewsForSource(db, sourceTaskId)
    .some(row => row.receipt_type === type && row.receipt_sha256 === directorExtractionDigest({
      phaseTaskId: row.phase_task_id,
      receiptType: type,
      reviewedReferences: references,
      errorCode,
    }))
}

export function resumeDirectorExtractionAfterReview(
  db: Database.Database,
  sourceTaskId: string,
  scope: N8nTaskScope,
  referencesValue: ReviewedDirectorReferences,
  options: { nowSeconds?: number } = {},
): DirectorExtractionJob {
  const references = reviewedDirectorReferencesSchema.parse(referencesValue)
  const job = getDirectorExtractionJob(db, sourceTaskId, scope)
  if (!job) throw new Error('director_extraction_source_not_found')
  if (!job.status.startsWith('awaiting_') || !job.status.endsWith('_review')
    || job.status === 'awaiting_intent_review' || !job.phaseTaskId
    || job.currentPhase === 'complete') {
    const prior = reviewsForSource(db, sourceTaskId)
      .find(row => row.receipt_type === 'candidate_review')
    if (replayedReviewMatches(db, sourceTaskId, 'candidate_review', references)) return job
    if (prior) throw new Error('director_extraction_review_conflict')
    throw new Error('director_extraction_review_not_expected')
  }
  const checkpoint = getDirectorExtractionCheckpoint(db, sourceTaskId, job.currentPhase)
  const allowed = new Set(checkpoint?.projectionReceipt?.entries.map(entry => (
    `${entry.table}:${entry.stableId}`
  )) || [])
  for (const [table, ids] of Object.entries(references)) {
    for (const id of ids || []) {
      if (!allowed.has(`${table}:${id}`)) throw new Error('director_extraction_review_references_invalid')
    }
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  return db.transaction(() => {
    insertReview(db, job.phaseTaskId!, 'candidate_review', references, null, now)
    if (job.currentPhase !== 'understanding') {
      const index = directorExtractionPhases.indexOf(job.currentPhase as DirectorExtractionPhase)
      const next = directorExtractionPhases[index + 1]
      if (next) {
        const source = sourceRun(db, sourceTaskId, scope)!
        ensurePhase(db, source, next, job.objective, mergeReviewed(reviewsForSource(db, sourceTaskId)), job.maxAttempts, now)
      }
    }
    return getDirectorExtractionJob(db, sourceTaskId, scope)!
  }).immediate()
}

export function resumeDirectorExtractionAfterIntent(
  db: Database.Database,
  sourceTaskId: string,
  scope: N8nTaskScope,
  intentStableId: string,
  options: { nowSeconds?: number } = {},
): DirectorExtractionJob {
  const references = reviewedDirectorReferencesSchema.parse({ director_intents: [intentStableId] })
  const job = getDirectorExtractionJob(db, sourceTaskId, scope)
  if (!job) throw new Error('director_extraction_source_not_found')
  const phaseTaskId = directorExtractionPhaseTaskIdentity('task', sourceTaskId, 'understanding')
  if (job.status !== 'awaiting_intent_review') {
    const prior = reviewsForSource(db, sourceTaskId)
      .find(row => row.receipt_type === 'intent_review')
    if (replayedReviewMatches(db, sourceTaskId, 'intent_review', references)) return job
    if (prior) throw new Error('director_extraction_review_conflict')
    throw new Error('director_extraction_intent_not_expected')
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  return db.transaction(() => {
    insertReview(db, phaseTaskId, 'intent_review', references, null, now)
    const source = sourceRun(db, sourceTaskId, scope)!
    ensurePhase(db, source, 'judgment', job.objective, mergeReviewed(reviewsForSource(db, sourceTaskId)), job.maxAttempts, now)
    return getDirectorExtractionJob(db, sourceTaskId, scope)!
  }).immediate()
}

export function resumeDirectorExtractionEvidenceProjection(
  db: Database.Database,
  sourceTaskId: string,
  scope: N8nTaskScope,
  options: { nowSeconds?: number; conflictCode?: string } = {},
): DirectorExtractionJob {
  const job = getDirectorExtractionJob(db, sourceTaskId, scope)
  if (!job) throw new Error('director_extraction_source_not_found')
  if (options.conflictCode) {
    const phaseTaskId = directorExtractionPhaseTaskIdentity('task', sourceTaskId, 'perception')
    insertReview(db, phaseTaskId, 'candidate_rejection', {}, options.conflictCode,
      options.nowSeconds ?? Math.floor(Date.now() / 1_000))
  }
  return getDirectorExtractionJob(db, sourceTaskId, scope)!
}

export function failDirectorExtractionReview(
  db: Database.Database,
  job: DirectorExtractionJob,
  errorCode: string,
  options: { nowSeconds?: number } = {},
): DirectorExtractionJob {
  if (!job.phaseTaskId) throw new Error('director_extraction_review_not_expected')
  insertReview(
    db, job.phaseTaskId, 'candidate_rejection', {}, String(errorCode).slice(0, 200),
    options.nowSeconds ?? Math.floor(Date.now() / 1_000),
  )
  return getDirectorExtractionJob(db, job.sourceTaskId, job)!
}

export function checkpointDirectorExtractionPhase(
  db: Database.Database,
  job: DirectorExtractionJob,
  phaseInputValue: Record<string, unknown>,
  candidateValue: unknown,
  receipt: DirectorExtractionProjectionReceipt,
  options: { nowSeconds?: number } = {},
): DirectorExtractionJob {
  stageDirectorExtractionCheckpoint(db, job, phaseInputValue, candidateValue, options)
  return completeDirectorExtractionProjection(db, job, receipt, options)
}

export function projectDirectorExtractionStatus(
  db: Database.Database,
  job: DirectorExtractionJob,
): Record<string, unknown> {
  const checkpoints = listDirectorExtractionCheckpoints(db, job.sourceTaskId)
  return {
    status: job.status,
    phase: job.currentPhase,
    progress: directorExtractionProgress(job.currentPhase),
    completedPhases: checkpoints.filter(item => item.projectionState === 'delivered').map(item => item.phase),
    candidateCount: checkpoints.reduce((sum, item) => sum + item.candidateOutput.candidates.length, 0),
    message: job.status === 'awaiting_evidence_projection' ? '素材证据正在写入导演脑，完成后会自动继续'
      : job.status === 'awaiting_intent_review' ? '需要先确认唯一生效的导演意图，确认后会自动继续'
        : job.status === 'completed' ? '导演知识链已完成复核'
          : job.status === 'conflict' ? '来源或作品绑定发生冲突，已停止'
            : job.status.startsWith('awaiting_') ? '导演知识候选等待复核'
              : job.status === 'failed' ? '提炼失败，需要检查后重试' : '导演知识正在分阶段提炼',
  }
}
