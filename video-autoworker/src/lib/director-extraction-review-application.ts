import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { runDirectorCommand } from '@/lib/director-evidence-outbox'
import type { DirectorCommandRunner } from '@/lib/director-evidence-delivery-core'
import {
  getDirectorExtractionCheckpoint,
  getDirectorExtractionJob,
  listDirectorExtractionJobsByStatuses,
  projectDirectorExtractionStatus,
  type DirectorExtractionCheckpoint,
  type DirectorExtractionJob,
} from '@/lib/director-extraction-runs'
import {
  DIRECTOR_EXTRACTION_REVIEW_PHASE_BY_STATUS,
  DIRECTOR_EXTRACTION_REVIEW_STATUS_BY_PHASE,
  directorExtractionDigest,
  type DirectorExtractionCandidate,
  type DirectorExtractionPhase,
  type DirectorExtractionProjectionEntry,
} from '@/lib/director-extraction-state'
import { loadDirectorExtractionProjectionRecords } from '@/lib/director-extraction-service'
import {
  cancelDirectorReviewBatch,
  claimDirectorReviewBatch,
  getDirectorReviewBatch,
  getDirectorReviewBatchByRequest,
  prepareDirectorReviewBatch,
  recordDirectorReviewBatchItem,
  type DirectorReviewBatch,
  type DirectorReviewBatchTarget,
} from '@/lib/director-review-batches'
import { assertDirectorBrainScope } from '@/lib/director-brain-scope'
import type { N8nTaskScope } from '@/lib/n8n-task-runs'

type ReviewDecision = 'approve' | 'reject'
type ReviewOutcome = 'completed' | 'conflict' | 'unknown'

const REVIEW_REQUEST_ID = /^[A-Za-z0-9._:-]{8,160}$/u
const REVIEW_ID = /^[a-f0-9]{64}$/u
const VERSION = /^v(\d+)\.(\d+)\.(\d+)$/u
const MAX_REVIEW_TARGETS = 50
const REVIEW_REQUEST_NAMESPACE = 'director-extraction-platform-review/v1'

const PHASE_LABELS: Readonly<Record<DirectorExtractionPhase, string>> = Object.freeze({
  perception: '素材感知',
  understanding: '人物与故事理解',
  judgment: '导演判断',
  case: '导演案例',
  technique: '技法提炼',
})

const KIND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  material_observation: '素材证据',
  person_profile: '人物档案',
  story_node: '故事节点',
  story_relation: '故事关系',
  material_judgment: '素材判断',
  narrative_proposal: '叙事方案',
  director_case: '导演案例',
  technique: '导演技法',
})

const REVIEW_TRANSITIONS: Readonly<Record<string, Readonly<{
  approve: Readonly<Record<string, readonly string[]>>
  reject: Readonly<Record<string, readonly string[]>>
}>>> = Object.freeze({
  material_evidence: {
    approve: { 候选: ['已核验'] }, reject: { 候选: ['失效'] },
  },
  people_profiles: {
    approve: { 候选: ['待审核', '已确认'], 待审核: ['已确认'] },
    reject: { 候选: ['失效'], 待审核: ['失效'] },
  },
  story_nodes: {
    approve: { 候选: ['待审核', '已确认'], 待审核: ['已确认'] },
    reject: { 候选: ['失效'], 待审核: ['失效'] },
  },
  story_relations: {
    approve: { 候选: ['待审核', '已确认'], 待审核: ['已确认'] },
    reject: { 候选: ['失效'], 待审核: ['失效'] },
  },
  material_judgments: {
    approve: { 候选: ['待审核', '已确认'], 待审核: ['已确认'] },
    reject: { 候选: ['失效'], 待审核: ['失效'] },
  },
  narrative_plans: {
    approve: { 草稿: ['待审核', '已批准'], 待审核: ['已批准'] },
    reject: { 草稿: ['废弃'], 待审核: ['废弃'] },
  },
  director_cases: {
    approve: { 待复核: ['已确认'], 有争议: ['已确认'] },
    reject: { 待复核: ['失效'], 有争议: ['失效'] },
  },
  skills_techniques: {
    approve: { 候选: ['待审核', '已验证'], 待审核: ['已验证'] },
    reject: { 候选: ['废弃'], 待审核: ['废弃'] },
  },
})

export interface DirectorLearningReviewCandidate {
  candidateId: string
  kind: string
  title: string
  summary: string
  rationale: string
  confidence: number
  decision: 'pending'
}

export interface DirectorLearningReview {
  reviewId: string
  reviewRevision: number
  workName: string
  phase: DirectorExtractionPhase
  phaseLabel: string
  progress: number | null
  progressKnown: boolean
  pendingCount: number
  candidates: DirectorLearningReviewCandidate[]
}

type InternalCandidate = DirectorLearningReviewCandidate & {
  candidateKey: string
  kindLabel: string
  state: string
  version: string
  table: DirectorExtractionProjectionEntry['table']
  stableId: string
  workId: string
  sourceTaskId: string
}

type InternalReview = Omit<DirectorLearningReview, 'candidates'> & {
  sourceTaskId: string
  workId: string
  workVersion: string
  checkpoint: DirectorExtractionCheckpoint
  candidates: InternalCandidate[]
}

export interface DirectorLearningReviewSelection {
  requestId: string
  reviewId: string
  reviewRevision: number
  decision: ReviewDecision
  candidateIds: string[]
}

export interface DirectorLearningReviewPrepareResult {
  requestId: string
  reviewId: string
  reviewRevision: number
  decision: ReviewDecision
  batchId: string
  confirmationCode: string
  count: number
  status: DirectorReviewBatch['status']
  message: string
}

export interface DirectorLearningReviewConfirmInput extends DirectorLearningReviewSelection {
  batchId: string
  confirmationCode: string
  count: number
}

export interface DirectorLearningReviewConfirmResult {
  outcome: ReviewOutcome
  requestId: string
  reviewId: string
  reviewRevision: number
  decision: ReviewDecision
  completedCount: number
  totalCount: number
  message: string
}

export interface DirectorLearningReviewCancelResult {
  batchId: string
  count: number
  status: 'cancelled'
  message: string
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function safeString(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').replace(/\r\n?/gu, '\n').trim()
  return normalized && normalized.length <= maximum
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
    ? normalized : null
}

function recordFields(record: Record<string, unknown>): Record<string, unknown> {
  const fields = record.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('director_extraction_review_read_invalid')
  }
  return fields as Record<string, unknown>
}

function recordVersion(record: Record<string, unknown>): string {
  const version = safeString(recordFields(record)['版本'], 32)
  if (!version || !VERSION.test(version)) {
    throw new Error('director_extraction_review_read_invalid')
  }
  return version
}

function nextVersion(value: string): string {
  const match = VERSION.exec(value)
  if (!match) throw new Error('director_extraction_review_version_invalid')
  const patch = Number(match[3]) + 1
  if (!Number.isSafeInteger(patch)) throw new Error('director_extraction_review_version_invalid')
  return `v${match[1]}.${match[2]}.${patch}`
}

function advanceVersion(value: string, count: number): string {
  let current = value
  for (let index = 0; index < count; index++) current = nextVersion(current)
  return current
}

function transitionsFor(
  table: string,
  decision: ReviewDecision,
  state: string,
): readonly string[] | null {
  return REVIEW_TRANSITIONS[table]?.[decision]?.[state] || null
}

function isPendingReviewRecord(table: string, record: Record<string, unknown>): boolean {
  if (record.reviewed !== false) return false
  const state = safeString(record.state, 32)
  if (!state) throw new Error('director_extraction_review_read_invalid')
  return Boolean(transitionsFor(table, 'approve', state)
    && transitionsFor(table, 'reject', state))
}

async function readWorkName(
  workId: string,
  commandRunner: DirectorCommandRunner,
): Promise<{ name: string; state: string; version: string }> {
  const result = await commandRunner('operate', {
    action: 'get', table: 'works', stableId: workId,
  })
  const record = result.record
  if (result.ok !== true || result.action !== 'get' || result.found !== true
    || result.table !== 'works' || result.stableId !== workId
    || !record || typeof record !== 'object' || Array.isArray(record)
    || (record as Record<string, unknown>).table !== 'works'
    || (record as Record<string, unknown>).stableId !== workId
    || (record as Record<string, unknown>).reviewed !== true) {
    throw new Error('director_extraction_review_work_invalid')
  }
  const typed = record as Record<string, unknown>
  const fields = recordFields(typed)
  const name = safeString(fields['作品名称'], 240)
  const state = safeString(typed.state, 32)
  const version = recordVersion(typed)
  if (!name || state !== '生效') throw new Error('director_extraction_review_work_invalid')
  return { name, state, version }
}

function candidatePresentation(
  checkpoint: DirectorExtractionCheckpoint,
  entry: DirectorExtractionProjectionEntry,
  record: Record<string, unknown>,
): Pick<DirectorLearningReviewCandidate, 'title' | 'summary' | 'rationale' | 'confidence'> {
  if (entry.kind !== 'material_observation') {
    const candidate = checkpoint.candidateOutput.candidates.find(item => (
      item.candidateKey === entry.candidateKey && item.kind === entry.kind
    )) as DirectorExtractionCandidate | undefined
    if (!candidate) throw new Error('director_extraction_review_projection_invalid')
    return {
      title: candidate.title,
      summary: candidate.summary,
      rationale: candidate.rationale,
      confidence: candidate.confidence,
    }
  }
  const fields = recordFields(record)
  const title = safeString(fields['证据名称'], 240)
  const summary = safeString(fields['证据摘要'], 4_000)
  const rationale = safeString(fields['判断理由'], 4_000) || summary
  const confidence = Number(fields['置信度'])
  if (!title || !summary || !rationale || !Number.isFinite(confidence)
    || confidence < 0 || confidence > 1) {
    throw new Error('director_extraction_review_projection_invalid')
  }
  return { title, summary, rationale, confidence }
}

function publicReview(value: InternalReview): DirectorLearningReview {
  return {
    reviewId: value.reviewId,
    reviewRevision: value.reviewRevision,
    workName: value.workName,
    phase: value.phase,
    phaseLabel: value.phaseLabel,
    progress: value.progress,
    progressKnown: value.progressKnown,
    pendingCount: value.pendingCount,
    candidates: value.candidates.map(candidate => ({
      candidateId: candidate.candidateId,
      kind: candidate.kind,
      title: candidate.title,
      summary: candidate.summary,
      rationale: candidate.rationale,
      confidence: candidate.confidence,
      decision: 'pending',
    })),
  }
}

async function resolveInternalReview(
  db: Database.Database,
  job: DirectorExtractionJob,
  commandRunner: DirectorCommandRunner,
): Promise<InternalReview | null> {
  if (!job.workId) throw new Error('director_extraction_work_not_registered')
  const phase = DIRECTOR_EXTRACTION_REVIEW_PHASE_BY_STATUS[job.status]
  if (!phase) return null
  const checkpoint = getDirectorExtractionCheckpoint(db, job.sourceTaskId, phase)
  if (!checkpoint?.projectionReceipt || checkpoint.projectionReceipt.phase !== phase) return null
  const work = await readWorkName(job.workId, commandRunner)
  const reviewIdentity = {
    schema: 'director-extraction-platform-review/v1',
    tenantId: job.tenantId,
    workspaceId: job.workspaceId,
    sourceTaskId: job.sourceTaskId,
    workId: job.workId,
    phase,
    checkpointSha256: checkpoint.outputSha256,
    projectionReceiptSha256: directorExtractionDigest(checkpoint.projectionReceipt),
  }
  const reviewId = digest(JSON.stringify(reviewIdentity))
  const records = await loadDirectorExtractionProjectionRecords(
    job.workId, checkpoint.projectionReceipt.entries, commandRunner,
  )
  const remoteSnapshot: Array<Record<string, unknown>> = []
  const candidates: InternalCandidate[] = []
  for (const entry of checkpoint.projectionReceipt.entries) {
    const record = records.get(`${entry.table}:${entry.stableId}`)
    if (!record || typeof record.reviewed !== 'boolean') {
      throw new Error('director_extraction_review_read_invalid')
    }
    const state = safeString(record.state, 32)
    const version = recordVersion(record)
    if (!state) throw new Error('director_extraction_review_read_invalid')
    remoteSnapshot.push({
      candidateKey: entry.candidateKey,
      kind: entry.kind,
      table: entry.table,
      stableId: entry.stableId,
      state,
      version,
      reviewed: record.reviewed,
    })
    if (!isPendingReviewRecord(entry.table, record)) continue
    const presentation = candidatePresentation(checkpoint, entry, record)
    candidates.push({
      candidateId: digest(`${reviewId}\0${entry.candidateKey}`),
      candidateKey: entry.candidateKey,
      kind: entry.kind,
      kindLabel: KIND_LABELS[entry.kind] || '导演知识候选',
      ...presentation,
      state,
      version,
      decision: 'pending',
      table: entry.table,
      stableId: entry.stableId,
      workId: job.workId,
      sourceTaskId: job.sourceTaskId,
    })
  }
  if (candidates.length === 0) return null
  candidates.sort((left, right) => left.candidateKey.localeCompare(right.candidateKey))
  remoteSnapshot.sort((left, right) => String(left.candidateKey).localeCompare(String(right.candidateKey)))
  const revisionDigest = digest(JSON.stringify({
    ...reviewIdentity,
    jobRevision: job.revision,
    jobStatus: job.status,
    work,
    records: remoteSnapshot,
  }))
  const status = projectDirectorExtractionStatus(db, job)
  return {
    reviewId,
    reviewRevision: Number.parseInt(revisionDigest.slice(0, 13), 16),
    workName: work.name,
    phase,
    phaseLabel: PHASE_LABELS[phase],
    progress: typeof status.progress === 'number' ? status.progress : null,
    progressKnown: status.progressKnown === true,
    pendingCount: candidates.length,
    candidates,
    sourceTaskId: job.sourceTaskId,
    workId: job.workId,
    workVersion: work.version,
    checkpoint,
  }
}

async function listInternalReviews(
  db: Database.Database,
  scope: N8nTaskScope,
  commandRunner: DirectorCommandRunner,
): Promise<InternalReview[]> {
  assertDirectorBrainScope(scope)
  const statuses = Object.values(DIRECTOR_EXTRACTION_REVIEW_STATUS_BY_PHASE)
  const jobs = listDirectorExtractionJobsByStatuses(db, statuses, 20)
    .filter(job => job.tenantId === scope.tenantId && job.workspaceId === scope.workspaceId)
  const reviews: InternalReview[] = []
  for (const job of jobs) {
    const review = await resolveInternalReview(db, job, commandRunner)
    if (review) reviews.push(review)
  }
  return reviews.sort((left, right) => left.workName.localeCompare(right.workName, 'zh-CN')
    || left.phase.localeCompare(right.phase) || left.reviewId.localeCompare(right.reviewId))
}

export async function listDirectorLearningReviews(
  db: Database.Database,
  scope: N8nTaskScope,
  options: { commandRunner?: DirectorCommandRunner } = {},
): Promise<DirectorLearningReview[]> {
  return (await listInternalReviews(db, scope, options.commandRunner || runDirectorCommand))
    .map(publicReview)
}

function validateSelection(input: DirectorLearningReviewSelection): DirectorLearningReviewSelection {
  if (!REVIEW_REQUEST_ID.test(input.requestId) || !REVIEW_ID.test(input.reviewId)
    || !Number.isSafeInteger(input.reviewRevision) || input.reviewRevision < 0
    || !['approve', 'reject'].includes(input.decision)
    || !Array.isArray(input.candidateIds) || input.candidateIds.length < 1
    || input.candidateIds.length > MAX_REVIEW_TARGETS
    || input.candidateIds.some(value => !/^[a-f0-9]{64}$/u.test(value))
    || new Set(input.candidateIds).size !== input.candidateIds.length) {
    throw new Error('director_extraction_review_request_invalid')
  }
  return { ...input, candidateIds: [...input.candidateIds].sort() }
}

function requestKey(requestId: string): string {
  return `${REVIEW_REQUEST_NAMESPACE}:${requestId}`
}

function assertStoredRequest(
  batch: DirectorReviewBatch,
  input: DirectorLearningReviewSelection,
): void {
  const targets = batch.targets
  const ids = targets.map(target => target.reviewId && target.candidateKey
    ? digest(`${target.reviewId}\0${target.candidateKey}`) : '').sort()
  if (targets.some(target => target.reviewId !== input.reviewId
    || target.reviewRevision !== input.reviewRevision
    || !target.sourceTaskId || !target.workId || !target.workVersion
    || !target.kind || !target.candidateKey)
    || JSON.stringify(ids) !== JSON.stringify(input.candidateIds)) {
    throw new Error('director_extraction_review_request_conflict')
  }
}

function publicApplyResult(
  batch: DirectorReviewBatch,
  input: DirectorLearningReviewSelection,
  outcome: ReviewOutcome,
): DirectorLearningReviewConfirmResult {
  return {
    outcome,
    requestId: input.requestId,
    reviewId: input.reviewId,
    reviewRevision: input.reviewRevision,
    decision: input.decision,
    completedCount: batch.completedCount,
    totalCount: batch.targets.length,
    message: outcome === 'completed'
      ? `已${input.decision === 'approve' ? '批准' : '驳回'} ${batch.targets.length} 条候选，并完成回读。`
      : outcome === 'conflict'
        ? '候选已发生变化，本次已停止。请刷新后重新审核。'
        : '审核结果暂时无法确认。请先刷新回读，不要重复提交。',
  }
}

function projectionEntryFromTarget(target: DirectorReviewBatchTarget): DirectorExtractionProjectionEntry {
  if (!target.candidateKey || !target.kind) {
    throw new Error('director_extraction_review_batch_invalid')
  }
  return {
    candidateKey: target.candidateKey,
    kind: target.kind,
    table: target.table as DirectorExtractionProjectionEntry['table'],
    stableId: target.stableId,
  }
}

async function readTargetRecord(
  target: DirectorReviewBatchTarget,
  commandRunner: DirectorCommandRunner,
): Promise<Record<string, unknown>> {
  if (!target.workId) throw new Error('director_extraction_review_batch_invalid')
  const entry = projectionEntryFromTarget(target)
  const records = await loadDirectorExtractionProjectionRecords(
    target.workId, [entry], commandRunner,
  )
  const record = records.get(`${target.table}:${target.stableId}`)
  if (!record || typeof record.reviewed !== 'boolean') {
    throw new Error('director_extraction_review_read_invalid')
  }
  recordVersion(record)
  if (!safeString(record.state, 32)) throw new Error('director_extraction_review_read_invalid')
  return record
}

function targetRecordPosition(
  batch: DirectorReviewBatch,
  target: DirectorReviewBatchTarget,
  record: Record<string, unknown>,
): number | null {
  const states = [target.state, ...target.targetStatuses]
  const state = String(record.state || '')
  const version = recordVersion(record)
  for (let index = 0; index < states.length; index++) {
    const expectedReviewed = index === states.length - 1 && batch.decision === 'approve'
    if (state === states[index] && version === advanceVersion(target.version, index)
      && record.reviewed === expectedReviewed) return index
  }
  return null
}

function assertBatchProjectionCurrent(
  db: Database.Database,
  scope: N8nTaskScope,
  batch: DirectorReviewBatch,
): void {
  const sourceIds = new Set(batch.targets.map(target => target.sourceTaskId))
  if (sourceIds.size !== 1 || sourceIds.has(undefined)) {
    throw new Error('director_extraction_review_batch_invalid')
  }
  const sourceTaskId = batch.targets[0].sourceTaskId!
  const job = getDirectorExtractionJob(db, sourceTaskId, scope)
  const phase = job && DIRECTOR_EXTRACTION_REVIEW_PHASE_BY_STATUS[job.status]
  const checkpoint = phase && getDirectorExtractionCheckpoint(db, sourceTaskId, phase)
  if (!job || !phase || !checkpoint?.projectionReceipt) {
    throw new Error('director_extraction_review_revision_stale')
  }
  const entries = new Set(checkpoint.projectionReceipt.entries.map(entry => (
    `${entry.candidateKey}\0${entry.kind}\0${entry.table}\0${entry.stableId}`
  )))
  for (const target of batch.targets) {
    const entry = projectionEntryFromTarget(target)
    if (target.workId !== job.workId || target.reviewId !== batch.targets[0].reviewId
      || target.reviewRevision !== batch.targets[0].reviewRevision
      || !entries.has(`${entry.candidateKey}\0${entry.kind}\0${entry.table}\0${entry.stableId}`)) {
      throw new Error('director_extraction_review_revision_stale')
    }
  }
}

function reviewResultMatches(
  result: Record<string, unknown>,
  target: DirectorReviewBatchTarget,
  previousState: string,
  targetState: string,
  previousVersion: string,
  version: string,
  reviewed: boolean,
): boolean {
  const record = result.record
  const expectedWorkId = target.table === 'skills_techniques' ? null : target.workId
  return Boolean(result.ok === true && result.action === 'review'
    && result.table === target.table && result.stableId === target.stableId
    && result.workId === expectedWorkId
    && result.previousStatus === previousState && result.targetStatus === targetState
    && result.previousVersion === previousVersion && result.version === version
    && record && typeof record === 'object' && !Array.isArray(record)
    && (record as Record<string, unknown>).table === target.table
    && (record as Record<string, unknown>).stableId === target.stableId
    && (record as Record<string, unknown>).state === targetState
    && recordVersion(record as Record<string, unknown>) === version
    && (record as Record<string, unknown>).reviewed === reviewed)
}

async function recordItem(
  db: Database.Database,
  scope: N8nTaskScope,
  actorKey: string,
  batch: DirectorReviewBatch,
  ordinal: number,
  status: 'completed' | 'unknown' | 'stale',
  details: { resultVersion?: string; errorCode?: string } = {},
): Promise<DirectorReviewBatch> {
  return recordDirectorReviewBatchItem(db, scope, {
    actorKey, batchId: batch.batchId, ordinal, status, ...details,
  })
}

async function applyBatch(
  db: Database.Database,
  scope: N8nTaskScope,
  actorKey: string,
  initialBatch: DirectorReviewBatch,
  input: DirectorLearningReviewSelection,
  commandRunner: DirectorCommandRunner,
): Promise<DirectorLearningReviewConfirmResult> {
  const firstConfirmation = initialBatch.status === 'pending'
  let batch = claimDirectorReviewBatch(db, scope, {
    actorKey,
    confirmationCode: initialBatch.confirmationCode,
    decision: input.decision,
    count: initialBatch.targets.length,
  })
  const workTarget = batch.targets[0]
  try {
    const work = await readWorkName(workTarget.workId || '', commandRunner)
    if (work.version !== workTarget.workVersion || work.name !== workTarget.workName) {
      return publicApplyResult(batch, input, 'conflict')
    }
  } catch (error) {
    return publicApplyResult(
      batch,
      input,
      error instanceof Error && error.message === 'director_extraction_review_work_invalid'
        ? 'conflict' : 'unknown',
    )
  }
  if (batch.status === 'completed') return publicApplyResult(batch, input, 'completed')
  const records = new Map<number, Record<string, unknown>>()
  for (let ordinal = 0; ordinal < batch.targets.length; ordinal++) {
    if (batch.itemStatuses[ordinal] === 'completed') continue
    const target = batch.targets[ordinal]
    let record: Record<string, unknown>
    try {
      record = await readTargetRecord(target, commandRunner)
    } catch {
      batch = await recordItem(db, scope, actorKey, batch, ordinal, 'unknown', {
        errorCode: 'review_read_outcome_unknown',
      })
      return publicApplyResult(batch, input, 'unknown')
    }
    const position = targetRecordPosition(batch, target, record)
    if (firstConfirmation && batch.itemStatuses[ordinal] === 'pending' && position !== 0) {
      batch = await recordItem(db, scope, actorKey, batch, ordinal, 'stale', {
        errorCode: 'review_candidate_stale',
      })
      return publicApplyResult(batch, input, 'conflict')
    }
    if (position === target.targetStatuses.length) {
      batch = await recordItem(db, scope, actorKey, batch, ordinal, 'completed', {
        resultVersion: recordVersion(record),
      })
      continue
    }
    if (position === null) {
      batch = await recordItem(db, scope, actorKey, batch, ordinal, 'stale', {
        errorCode: 'review_candidate_stale',
      })
      return publicApplyResult(batch, input, 'conflict')
    }
    records.set(ordinal, record)
  }
  if (batch.status === 'completed') return publicApplyResult(batch, input, 'completed')
  try {
    assertBatchProjectionCurrent(db, scope, batch)
  } catch {
    return publicApplyResult(batch, input, 'conflict')
  }

  for (let ordinal = 0; ordinal < batch.targets.length; ordinal++) {
    if (batch.itemStatuses[ordinal] === 'completed') continue
    const target = batch.targets[ordinal]
    let current = records.get(ordinal)!
    let position = targetRecordPosition(batch, target, current)
    if (position === null) return publicApplyResult(batch, input, 'conflict')
    while (position < target.targetStatuses.length) {
      const previousState = position === 0 ? target.state : target.targetStatuses[position - 1]
      const targetState = target.targetStatuses[position]
      const previousVersion = advanceVersion(target.version, position)
      const version = nextVersion(previousVersion)
      const reviewed = batch.decision === 'approve'
        && position === target.targetStatuses.length - 1
      let result: Record<string, unknown> | null = null
      try {
        result = await commandRunner('review', {
          action: 'review',
          table: target.table,
          stableId: target.stableId,
          ...(target.table === 'skills_techniques' ? {} : { workId: target.workId }),
          expectedVersion: previousVersion,
          targetStatus: targetState,
          reviewer: '可视化平台用户',
          reason: `用户在可视化平台二次确认${batch.decision === 'approve' ? '批准' : '驳回'}候选`,
        })
      } catch {
        // A transport failure does not prove whether Feishu committed the CAS.
      }
      let readback: Record<string, unknown>
      try {
        readback = await readTargetRecord(target, commandRunner)
      } catch {
        batch = await recordItem(db, scope, actorKey, batch, ordinal, 'unknown', {
          errorCode: 'review_outcome_unknown',
        })
        return publicApplyResult(batch, input, 'unknown')
      }
      const readbackPosition = targetRecordPosition(batch, target, readback)
      if (readbackPosition !== position + 1) {
        batch = await recordItem(db, scope, actorKey, batch, ordinal, 'stale', {
          errorCode: result ? 'review_write_readback_conflict' : 'review_cas_conflict',
        })
        return publicApplyResult(batch, input, 'conflict')
      }
      if (result && !reviewResultMatches(
        result, target, previousState, targetState, previousVersion, version, reviewed,
      )) {
        batch = await recordItem(db, scope, actorKey, batch, ordinal, 'stale', {
          errorCode: 'review_result_invalid',
        })
        return publicApplyResult(batch, input, 'conflict')
      }
      current = readback
      position = readbackPosition
    }
    batch = await recordItem(db, scope, actorKey, batch, ordinal, 'completed', {
      resultVersion: recordVersion(current),
    })
  }
  return publicApplyResult(batch, input, batch.status === 'completed' ? 'completed' : 'unknown')
}

function publicPrepareResult(
  batch: DirectorReviewBatch,
  input: DirectorLearningReviewSelection,
): DirectorLearningReviewPrepareResult {
  return {
    requestId: input.requestId,
    reviewId: input.reviewId,
    reviewRevision: input.reviewRevision,
    decision: input.decision,
    batchId: batch.batchId,
    confirmationCode: batch.confirmationCode,
    count: batch.targets.length,
    status: batch.status,
    message: batch.status === 'pending'
      ? `已固定 ${batch.targets.length} 条待审核候选，请再次确认后提交。`
      : '该审核批次已经处理，请刷新当前状态。',
  }
}

function assertConfirmation(
  batch: DirectorReviewBatch,
  input: DirectorLearningReviewConfirmInput,
): void {
  assertStoredRequest(batch, input)
  if (batch.batchId !== input.batchId
    || batch.confirmationCode !== input.confirmationCode
    || batch.targets.length !== input.count) {
    throw new Error('director_extraction_review_confirmation_mismatch')
  }
}

export async function prepareDirectorLearningReview(
  db: Database.Database,
  scope: N8nTaskScope,
  actorKey: string,
  inputValue: DirectorLearningReviewSelection,
  options: { commandRunner?: DirectorCommandRunner } = {},
): Promise<DirectorLearningReviewPrepareResult> {
  assertDirectorBrainScope(scope)
  const input = validateSelection(inputValue)
  const commandRunner = options.commandRunner || runDirectorCommand
  const key = requestKey(input.requestId)
  const conflicting = getDirectorReviewBatchByRequest(db, scope, {
    actorKey, requestKey: key, decision: input.decision === 'approve' ? 'reject' : 'approve',
  })
  if (conflicting) throw new Error('director_extraction_review_request_conflict')
  let batch = getDirectorReviewBatchByRequest(db, scope, {
    actorKey, requestKey: key, decision: input.decision,
  })
  if (batch) {
    assertStoredRequest(batch, input)
    return publicPrepareResult(batch, input)
  }

  const reviews = await listInternalReviews(db, scope, commandRunner)
  const review = reviews.find(item => item.reviewId === input.reviewId)
  if (!review || review.reviewRevision !== input.reviewRevision) {
    throw new Error('director_extraction_review_revision_stale')
  }
  const selected = input.candidateIds.map(candidateId => (
    review.candidates.find(candidate => candidate.candidateId === candidateId)
  ))
  if (selected.some(candidate => !candidate)) {
    throw new Error('director_extraction_review_selection_invalid')
  }
  const targets: DirectorReviewBatchTarget[] = selected.map(candidate => {
    const value = candidate!
    const targetStatuses = transitionsFor(value.table, input.decision, value.state)
    if (!targetStatuses) throw new Error('director_extraction_review_selection_invalid')
    return {
      table: value.table,
      stableId: value.stableId,
      workId: value.workId,
      sourceTaskId: value.sourceTaskId,
      workVersion: review.workVersion,
      candidateKey: value.candidateKey,
      kind: value.kind,
      reviewId: input.reviewId,
      reviewRevision: input.reviewRevision,
      state: value.state,
      version: value.version,
      targetStatuses: [...targetStatuses],
      name: value.title,
      workName: review.workName,
      summary: value.summary,
    }
  })
  batch = prepareDirectorReviewBatch(db, scope, {
    actorKey,
    requestKey: key,
    decision: input.decision,
    targets,
  })
  return publicPrepareResult(batch, input)
}

export async function confirmDirectorLearningReview(
  db: Database.Database,
  scope: N8nTaskScope,
  actorKey: string,
  inputValue: DirectorLearningReviewConfirmInput,
  options: { commandRunner?: DirectorCommandRunner } = {},
): Promise<DirectorLearningReviewConfirmResult> {
  assertDirectorBrainScope(scope)
  const input = {
    ...validateSelection(inputValue),
    batchId: inputValue.batchId,
    confirmationCode: inputValue.confirmationCode,
    count: inputValue.count,
  }
  if (!/^DRB-[a-f0-9]{32}$/u.test(input.batchId)
    || !/^[A-Z0-9]{6,12}$/u.test(input.confirmationCode)
    || !Number.isSafeInteger(input.count) || input.count < 1 || input.count > MAX_REVIEW_TARGETS) {
    throw new Error('director_extraction_review_request_invalid')
  }
  const key = requestKey(input.requestId)
  const conflicting = getDirectorReviewBatchByRequest(db, scope, {
    actorKey, requestKey: key, decision: input.decision === 'approve' ? 'reject' : 'approve',
  })
  if (conflicting) throw new Error('director_extraction_review_request_conflict')
  const batch = getDirectorReviewBatchByRequest(db, scope, {
    actorKey, requestKey: key, decision: input.decision,
  })
  if (!batch) throw new Error('director_extraction_review_batch_not_found')
  assertConfirmation(batch, input)
  return await applyBatch(
    db, scope, actorKey, batch, input, options.commandRunner || runDirectorCommand,
  )
}

export function cancelDirectorLearningReview(
  db: Database.Database,
  scope: N8nTaskScope,
  actorKey: string,
  input: { batchId: string; confirmationCode: string },
): DirectorLearningReviewCancelResult {
  assertDirectorBrainScope(scope)
  if (!/^DRB-[a-f0-9]{32}$/u.test(input.batchId)
    || !/^[A-Z0-9]{6,12}$/u.test(input.confirmationCode)) {
    throw new Error('director_extraction_review_request_invalid')
  }
  const batch = getDirectorReviewBatch(db, scope, actorKey, input.batchId)
  if (!batch) throw new Error('director_extraction_review_batch_not_found')
  if (batch.confirmationCode !== input.confirmationCode) {
    throw new Error('director_extraction_review_confirmation_mismatch')
  }
  if (batch.status !== 'pending') {
    throw new Error('director_extraction_review_batch_not_cancellable')
  }
  const cancelled = cancelDirectorReviewBatch(db, scope, {
    actorKey, confirmationCode: input.confirmationCode,
  })
  return {
    batchId: cancelled.batchId,
    count: cancelled.targets.length,
    status: 'cancelled',
    message: `已取消 ${cancelled.targets.length} 条候选的待确认批次，没有更改导演脑记录。`,
  }
}
