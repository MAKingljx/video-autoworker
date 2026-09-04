import type Database from 'better-sqlite3'
import {
  isDirectorExtractionDeterministicConflict,
  safeDirectorExtractionErrorCode,
} from '@/lib/director-extraction-errors'
import { buildDirectorExtractionHistorySeed } from '@/lib/director-extraction-seed'
import {
  DIRECTOR_EXTRACTION_LEARNING_CONTEXT_MAX_BYTES,
  DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES,
  compactDirectorLearningRecord,
  selectDirectorLearningContext,
  type DirectorLearningRecord,
} from '@/lib/director-extraction-learning'
import {
  directorEvidenceProjectionContractDigest,
  enqueueDirectorEvidenceOutbox,
  getDirectorEvidenceOutbox,
  runDirectorCommand,
} from '@/lib/director-evidence-outbox'
import {
  DIRECTOR_COMMAND_LIMITS,
  directorEvidenceSourceIdentityDigest,
  getDirectorEvidenceProjectionReceiptCore,
  persistRecoveredDirectorEvidenceProjectionReceiptCore,
  type DirectorCommandRunner,
  type DirectorEvidenceOutbox,
} from '@/lib/director-evidence-delivery-core'
import {
  directorEvidenceExpectedReceiptEntries,
  directorEvidenceProjectionBatches,
  directorEvidenceTransformEnvelope,
  directorEvidenceVerifiedReadReceipt,
  type DirectorEvidenceDeliveryReceipt,
} from '@/lib/director-evidence-projection-semantics'
import {
  DIRECTOR_EXTRACTION_CLAIM_SCAN_LIMIT,
  claimNextDirectorExtractionJob,
  completeDirectorExtractionProjection,
  failDirectorExtractionPhase,
  failDirectorExtractionReview,
  getDirectorExtractionCheckpoint,
  getDirectorExtractionSourceOutput,
  listDirectorExtractionJobsByStatuses,
  listDirectorExtractionCheckpoints,
  pauseDirectorExtractionForEvidence,
  renewDirectorExtractionLease,
  resumeDirectorExtractionAfterReview,
  resumeDirectorExtractionAfterIntent,
  resumeDirectorExtractionEvidenceProjection,
  stageDirectorExtractionCheckpoint,
  type DirectorExtractionJob,
} from '@/lib/director-extraction-runs'
import {
  DIRECTOR_EXTRACTION_CONTRACT,
  DIRECTOR_EXTRACTION_DEFAULT_MODEL_IDENTITY,
  DIRECTOR_EXTRACTION_MAX_OUTPUT_BYTES,
  DIRECTOR_EXTRACTION_PHASE_INSTRUCTIONS,
  DIRECTOR_EXTRACTION_PROJECT_ID,
  DIRECTOR_EXTRACTION_PROMPT_VERSION,
  DIRECTOR_EXTRACTION_PREVIOUS_TABLE_BY_KIND,
  DIRECTOR_EXTRACTION_PROJECTION_BOUNDARY,
  DIRECTOR_EXTRACTION_PROJECTION_VERSION,
  DIRECTOR_EXTRACTION_REVIEW_PHASE_BY_STATUS,
  DIRECTOR_EXTRACTION_SOURCE_TABLE_BY_KIND,
  DIRECTOR_EXTRACTION_TABLE_BY_KIND,
  DIRECTOR_EXTRACTION_WAITING_STATUSES,
  buildDirectorExtractionOutputContract,
  buildDirectorPerceptionCheckpointInput,
  directorExtractionContractDigest,
  directorExtractionDigest,
  directorExtractionProjectionReceiptSchema,
  parseDirectorLearningContextResult,
  parseDirectorExtractionOutput,
  reviewedDirectorReferencesSchema,
  type DirectorLearningContextResult,
  type DirectorExtractionCandidate,
  type DirectorExtractionCandidateOutput,
  type DirectorExtractionPhase,
  type DirectorExtractionProjectionEntry,
  type DirectorExtractionProjectionReceipt,
  type DirectorStoryNodeReference,
  type ReviewedDirectorReferences,
} from '@/lib/director-extraction-state'
import { runWithN8nChildExecutionHeartbeat } from '@/lib/n8n-task-runs'
import { executeN8nModelRoute } from '@/lib/n8n-model-execution'
import { loadN8nModelRegistry, publicN8nModelRoute } from '@/lib/n8n-model-routing'
import {
  getScopedN8nTaskRunByTaskId,
} from '@/lib/n8n-task-runs'

export type DirectorExtractionPhaseRunner = (
  phase: DirectorExtractionPhase,
  input: Record<string, unknown>,
  job: DirectorExtractionJob,
) => Promise<Record<string, unknown>>

function parseClock(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{2,}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u.exec(value.trim())
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return null
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
    + Number(String(match[4] || '').padEnd(3, '0') || 0) / 1000
}

function parseRange(value: unknown): { startSeconds: number; endSeconds: number } | null {
  if (typeof value !== 'string') return null
  const match = /^(\d{2,}:\d{2}:\d{2}(?:\.\d{1,3})?)-(\d{2,}:\d{2}:\d{2}(?:\.\d{1,3})?)$/u.exec(value.trim())
  if (!match) return null
  const startSeconds = parseClock(match[1])
  const endSeconds = parseClock(match[2])
  return startSeconds !== null && endSeconds !== null && endSeconds > startSeconds
    ? { startSeconds, endSeconds }
    : null
}

function overlap(left: { startSeconds: number; endSeconds: number }, right: { startSeconds: number; endSeconds: number }): boolean {
  return left.startSeconds < right.endSeconds && right.startSeconds < left.endSeconds
}

function containsRange(
  outer: { startSeconds: number; endSeconds: number },
  inner: { startSeconds: number; endSeconds: number },
): boolean {
  return inner.startSeconds >= outer.startSeconds - 0.001
    && inner.endSeconds <= outer.endSeconds + 0.001
}

function mergeReviewedEvidenceWindows(
  windows: Array<{ startSeconds: number; endSeconds: number }>,
): Array<{ startSeconds: number; endSeconds: number }> {
  const merged: Array<{ startSeconds: number; endSeconds: number }> = []
  for (const window of [...windows].sort((left, right) => (
    left.startSeconds - right.startSeconds || left.endSeconds - right.endSeconds
  ))) {
    const previous = merged.at(-1)
    if (previous && window.startSeconds <= previous.endSeconds + 0.001) {
      previous.endSeconds = Math.max(previous.endSeconds, window.endSeconds)
    } else {
      merged.push({ ...window })
    }
  }
  return merged
}

function filterEvidenceToReviewedWindows(
  evidenceValue: Record<string, unknown>,
  windows: Array<{ startSeconds: number; endSeconds: number }>,
): Record<string, unknown> {
  const evidence = structuredClone(evidenceValue)
  const filterItems = (items: unknown, rangeOf: (item: Record<string, unknown>) => { startSeconds: number; endSeconds: number } | null) => (
    Array.isArray(items)
      ? items.filter(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item)) return false
          const range = rangeOf(item as Record<string, unknown>)
          return range !== null && windows.some(window => overlap(range, window))
        })
      : []
  )
  evidence.timeline = filterItems(evidence.timeline, item => parseRange(item.timeRange))
  evidence.chapters = filterItems(evidence.chapters, item => {
    const startSeconds = parseClock(item.startTime)
    const endSeconds = parseClock(item.endTime)
    return startSeconds !== null && endSeconds !== null && endSeconds > startSeconds
      ? { startSeconds, endSeconds }
      : null
  })
  if (!windows.some(window => window.startSeconds <= 0.001
    && window.endSeconds >= Number(evidence.mediaDurationSeconds) - 0.001)) {
    delete evidence.directorPerception
    const summaries = (evidence.timeline as Array<Record<string, unknown>>)
      .map(item => String(item.visualSummary || '')).filter(Boolean)
    evidence.summary = summaries.join('\n').slice(0, 16_000)
  }
  if (!String(evidence.summary || '').trim()) {
    throw new Error('director_extraction_reviewed_evidence_empty')
  }
  return evidence
}

function acceptedProjectionEntries(
  db: Database.Database,
  job: DirectorExtractionJob,
): DirectorExtractionProjectionEntry[] {
  const accepted = new Set(Object.entries(job.reviewedReferences).flatMap(([table, ids]) => (
    (ids || []).map(stableId => `${table}:${stableId}`)
  )))
  return listDirectorExtractionCheckpoints(db, job.sourceTaskId)
    .flatMap(checkpoint => checkpoint.projectionReceipt?.entries || [])
    .filter(entry => accepted.has(`${entry.table}:${entry.stableId}`))
}

function normalizedReviewedReferenceRecord(record: Record<string, unknown>) {
  return {
    table: String(record.table || ''),
    stableId: String(record.stableId || ''),
    state: record.state === null ? null : String(record.state || ''),
    reviewed: record.reviewed === true,
    fields: record.fields && typeof record.fields === 'object' && !Array.isArray(record.fields)
      ? record.fields
      : {},
  }
}

function reviewedReferenceDigests(
  records: Record<string, Array<Record<string, unknown>>>,
): Record<string, Array<{ stableId: string; digest: string }>> {
  return Object.fromEntries(Object.entries(records).sort(([left], [right]) => left.localeCompare(right))
    .map(([table, values]) => [table, values.map(record => {
      const normalized = normalizedReviewedReferenceRecord(record)
      return {
        stableId: normalized.stableId,
        digest: directorExtractionDigest(normalized),
      }
    }).sort((left, right) => left.stableId.localeCompare(right.stableId))]))
}

function reviewedCandidatesForInput(
  acceptedEntries: DirectorExtractionProjectionEntry[],
  reviewedRecords: Record<string, Array<Record<string, unknown>>>,
) {
  return acceptedEntries.map(entry => {
    const record = (reviewedRecords[entry.table] || [])
      .find(candidate => candidate.stableId === entry.stableId)
    if (!record) throw new Error('director_extraction_reference_not_reviewed')
    return {
      candidateKey: entry.candidateKey,
      kind: entry.kind,
      table: entry.table,
      stableId: entry.stableId,
      fields: normalizedReviewedReferenceRecord(record).fields,
    }
  })
}

function assertLockedActiveDirectorIntent(
  job: DirectorExtractionJob,
  context: Readonly<DirectorLearningContextResult>,
): void {
  if (job.currentPhase !== 'judgment') return
  const lockedIntentIds = job.reviewedReferences.director_intents || []
  const activeIntent = context.snapshot.work.activeIntent
  if (lockedIntentIds.length !== 1 || !activeIntent
    || activeIntent.stableId !== lockedIntentIds[0]) {
    throw new Error('director_extraction_learning_reference_intent_mismatch')
  }
}

function directorLearningContextRequest(
  job: DirectorExtractionJob,
  objective: string,
): Record<string, unknown> {
  if (!job.workId || job.currentPhase === 'complete') {
    throw new Error('director_extraction_work_not_registered')
  }
  return {
    action: 'learning_context',
    workId: job.workId,
    phase: job.currentPhase,
    objective,
  }
}

async function buildPhaseInput(
  db: Database.Database,
  job: DirectorExtractionJob,
  commandRunner: DirectorCommandRunner,
): Promise<Record<string, unknown>> {
  if (!job.workId || job.currentPhase === 'complete') {
    throw new Error('director_extraction_work_not_registered')
  }
  const extractionContractDigest = directorExtractionContractDigest(
    DIRECTOR_EXTRACTION_DEFAULT_MODEL_IDENTITY,
  )
  if (job.extractionContractDigest !== extractionContractDigest) {
    throw new Error('director_extraction_contract_mismatch')
  }
  const output = getDirectorExtractionSourceOutput(db, job)
  let evidence = buildDirectorExtractionHistorySeed({
    workId: job.workId,
    sourceTaskId: job.sourceTaskId,
    sourceResultSha256: job.sourceResultSha256,
    output,
  }) as Record<string, unknown>
  const acceptedEntries = acceptedProjectionEntries(db, job)
  const windows = mergeReviewedEvidenceWindows(acceptedEntries.flatMap(entry => (
    entry.table === 'material_evidence'
      && entry.startSeconds !== undefined && entry.endSeconds !== undefined
      ? [{ startSeconds: entry.startSeconds, endSeconds: entry.endSeconds }]
      : []
  )))
  if (job.currentPhase !== 'perception') {
    if (!windows.length) throw new Error('director_extraction_reviewed_evidence_missing')
    evidence = filterEvidenceToReviewedWindows(evidence, windows)
  }
  const cumulativeReferences = job.reviewedReferences
  const reviewedRecords = Object.keys(cumulativeReferences).length
    ? await loadReviewedDirectorReferences(job.workId, cumulativeReferences, commandRunner)
    : {}
  const reviewedCandidates = reviewedCandidatesForInput(acceptedEntries, reviewedRecords)
  const objective = job.objective || '提炼可复核的导演知识候选'
  const fullLearningContext = parseDirectorLearningContextResult(
    job.workId,
    await commandRunner('operate', directorLearningContextRequest(job, objective)),
  )
  assertLockedActiveDirectorIntent(job, fullLearningContext)
  const baseInput = {
    schemaVersion: 2,
    contract: DIRECTOR_EXTRACTION_CONTRACT,
    extractionContractDigest,
    promptVersion: DIRECTOR_EXTRACTION_PROMPT_VERSION,
    projectionVersion: DIRECTOR_EXTRACTION_PROJECTION_VERSION,
    phase: job.currentPhase,
    projectId: DIRECTOR_EXTRACTION_PROJECT_ID,
    workId: job.workId,
    sourceResultSha256: job.sourceResultSha256,
    modelIdentity: DIRECTOR_EXTRACTION_DEFAULT_MODEL_IDENTITY,
    objective,
    evidence,
    reviewedEvidenceWindows: windows,
    reviewedCandidates,
    reviewedReferenceDigests: reviewedReferenceDigests(reviewedRecords),
    outputContract: buildDirectorExtractionOutputContract(job.currentPhase),
  }
  const baseBytes = Buffer.byteLength(JSON.stringify({
    ...baseInput,
    learningContext: null,
    learningContextTrace: null,
  }), 'utf8')
  const learningBudget = Math.min(
    DIRECTOR_EXTRACTION_LEARNING_CONTEXT_MAX_BYTES,
    DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES - baseBytes,
  )
  if (learningBudget <= 0) {
    throw new Error('director_extraction_phase_input_too_large')
  }
  const selectedLearning = selectDirectorLearningContext({
    source: fullLearningContext,
    phase: job.currentPhase,
    objective,
    maxBytes: learningBudget,
  })
  const input = { ...baseInput, ...selectedLearning }
  if (Buffer.byteLength(JSON.stringify(input), 'utf8')
    > DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES) {
    throw new Error('director_extraction_phase_input_too_large')
  }
  return input
}

function validateEvidenceReferences(
  output: DirectorExtractionCandidateOutput,
  input: Record<string, unknown>,
): void {
  const evidence = input.evidence as Record<string, unknown>
  const materialId = String(evidence.materialId || '')
  const duration = Number(evidence.mediaDurationSeconds)
  const reviewedWindows = Array.isArray(input.reviewedEvidenceWindows)
    ? input.reviewedEvidenceWindows as Array<{ startSeconds: number; endSeconds: number }>
    : []
  for (const candidate of output.candidates) {
    for (const reference of candidate.evidenceRefs) {
      if (reference.materialId !== materialId || reference.endSeconds > duration + 0.001
        || !reviewedWindows.some(window => containsRange(window, reference))) {
        throw new Error('director_extraction_evidence_reference_invalid')
      }
    }
  }
}

function safeErrorCode(error: unknown): string {
  return safeDirectorExtractionErrorCode(error, 'director_extraction_phase_failed')
}

function deterministicConflict(code: string): boolean {
  return isDirectorExtractionDeterministicConflict(code)
}

function directorRecordBelongsToWork(
  table: string,
  fields: Record<string, unknown>,
  workId: string,
): boolean {
  if (table !== 'skills_techniques') {
    return String(fields['作品 ID'] || '').trim() === workId
  }
  return String(fields['来源作品 ID'] || '')
    .split(/\r?\n/u)
    .some(sourceWorkId => sourceWorkId.trim() === workId)
}

export async function loadReviewedDirectorReferences(
  workId: string,
  references: ReviewedDirectorReferences,
  commandRunner: DirectorCommandRunner = runDirectorCommand,
): Promise<Record<string, Array<Record<string, unknown>>>> {
  const validated = reviewedDirectorReferencesSchema.parse(references)
  const records: Record<string, Array<Record<string, unknown>>> = {}
  for (const [table, stableIds] of Object.entries(validated)) {
    records[table] = []
    const ids = stableIds || []
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = ids.slice(offset, offset + 20)
      const globalTechnique = table === 'skills_techniques'
      const result = await commandRunner('operate', {
        action: 'get_many', table, stableIds: batch,
        ...(globalTechnique ? {} : { workId }),
      })
      if (result.ok !== true || result.action !== 'get_many'
        || result.table !== table || !Array.isArray(result.records)
        || !Array.isArray(result.missing) || result.missing.length > 0
        || (!globalTechnique && result.workId !== workId)) {
        throw new Error('director_extraction_reference_not_reviewed')
      }
      const observed = new Set<string>()
      for (const record of result.records as Array<Record<string, unknown>>) {
        const stableId = String(record.stableId || '')
        const fields = record.fields
        if (!batch.includes(stableId)
          || record.table !== table
          || record.reviewed !== true
          || observed.has(stableId)
          || !fields || typeof fields !== 'object' || Array.isArray(fields)
          || !directorRecordBelongsToWork(
            table,
            fields as Record<string, unknown>,
            workId,
          )) {
          throw new Error('director_extraction_reference_not_reviewed')
        }
        observed.add(stableId)
        records[table].push(record)
      }
      if (observed.size !== batch.length) throw new Error('director_extraction_reference_not_reviewed')
    }
  }
  return records
}

async function revalidateStagedDependencies(
  db: Database.Database,
  job: DirectorExtractionJob,
  output: DirectorExtractionCandidateOutput,
  stagedInput: Record<string, unknown>,
  commandRunner: DirectorCommandRunner,
): Promise<void> {
  if (!job.workId) throw new Error('director_extraction_work_not_registered')
  const reviewedRecords = Object.keys(job.reviewedReferences).length
    ? await loadReviewedDirectorReferences(job.workId, job.reviewedReferences, commandRunner)
    : {}
  if (directorExtractionDigest(reviewedReferenceDigests(reviewedRecords))
    !== directorExtractionDigest(stagedInput.reviewedReferenceDigests || {})) {
    throw new Error('director_extraction_reviewed_reference_changed')
  }
  const currentReviewedCandidates = reviewedCandidatesForInput(
    acceptedProjectionEntries(db, job),
    reviewedRecords,
  )
  if (directorExtractionDigest(currentReviewedCandidates)
    !== directorExtractionDigest(stagedInput.reviewedCandidates || [])) {
    throw new Error('director_extraction_reviewed_candidate_changed')
  }
  const learningContext = parseDirectorLearningContextResult(
    job.workId,
    await commandRunner('operate', directorLearningContextRequest(
      job,
      String(stagedInput.objective || job.objective || '提炼可复核的导演知识候选'),
    )),
  )
  assertLockedActiveDirectorIntent(job, learningContext)
  const frozenCatalog = learningRecordCatalog(job, stagedInput)
  const catalog = learningRecordCatalog(job, { learningContext })
  const requireUnchangedLearningRecord = (table: string, stableId: string): void => {
    const frozen = frozenCatalog.get(`${table}:${stableId}`)
    const current = catalog.get(`${table}:${stableId}`)
    if (!frozen || !current) throw new Error('director_extraction_learning_reference_invalid')
    if (directorExtractionDigest(frozen)
      !== directorExtractionDigest(compactDirectorLearningRecord(
        current as DirectorLearningRecord,
      ))) {
      throw new Error('director_extraction_learning_reference_changed')
    }
  }
  if (job.currentPhase === 'judgment') {
    const [intentId] = job.reviewedReferences.director_intents || []
    if (!intentId) throw new Error('director_extraction_learning_reference_intent_mismatch')
    requireUnchangedLearningRecord('director_intents', intentId)
  }
  for (const candidate of output.candidates) {
    const sourceTable = DIRECTOR_EXTRACTION_SOURCE_TABLE_BY_KIND[
      candidate.kind as keyof typeof DIRECTOR_EXTRACTION_SOURCE_TABLE_BY_KIND
    ]
    if (!sourceTable) {
      throw new Error('director_extraction_candidate_lineage_invalid')
    }
    for (const stableId of candidate.sourceStableIds || []) {
      requireUnchangedLearningRecord(sourceTable, stableId)
    }
    if (candidate.kind === 'story_relation') {
      for (const reference of [candidate.sourceNode, candidate.targetNode]) {
        if (reference?.type === 'reviewed') {
          requireUnchangedLearningRecord('story_nodes', reference.stableId)
        }
      }
    }
    if (candidate.previousVersionStableId) {
      const previousTable = DIRECTOR_EXTRACTION_PREVIOUS_TABLE_BY_KIND[
        candidate.kind as keyof typeof DIRECTOR_EXTRACTION_PREVIOUS_TABLE_BY_KIND
      ]
      if (!previousTable) {
        throw new Error('director_extraction_previous_version_invalid')
      }
      requireUnchangedLearningRecord(previousTable, candidate.previousVersionStableId)
    }
    for (const stableId of candidate.appliedTechniqueStableIds || []) {
      requireUnchangedLearningRecord('skills_techniques', stableId)
    }
  }
}

export type DirectorExtractionProposalItem = {
  candidate: DirectorExtractionCandidate
  table: DirectorExtractionProjectionEntry['table']
  fields: Record<string, unknown>
  references: Record<string, unknown>
}

export function directorExtractionProposalRequest(
  workId: string,
  table: DirectorExtractionProjectionEntry['table'],
  items: DirectorExtractionProposalItem[],
): Record<string, unknown> {
  return {
    action: 'propose_batch',
    table,
    ...(table === 'skills_techniques' ? {} : { workId }),
    items: items.map(item => ({ fields: item.fields, references: item.references })),
  }
}

function proposalRequestBytes(value: Record<string, unknown>): number {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`, 'utf8')
}

export function directorExtractionProposalBatches(
  workId: string,
  table: DirectorExtractionProjectionEntry['table'],
  items: DirectorExtractionProposalItem[],
): DirectorExtractionProposalItem[][] {
  const batches: DirectorExtractionProposalItem[][] = []
  let current: DirectorExtractionProposalItem[] = []
  for (const item of items) {
    const candidate = [...current, item]
    const bytes = proposalRequestBytes(directorExtractionProposalRequest(workId, table, candidate))
    if (current.length > 0 && (
      candidate.length > DIRECTOR_EXTRACTION_PROJECTION_BOUNDARY.maximumBatchItems
      || bytes > DIRECTOR_EXTRACTION_PROJECTION_BOUNDARY.targetBatchBytes
    )) {
      batches.push(current)
      current = [item]
    } else {
      current = candidate
    }
    if (proposalRequestBytes(directorExtractionProposalRequest(workId, table, current))
      > DIRECTOR_COMMAND_LIMITS['propose-batch'].maxInputBytes) {
      throw new Error('director_extraction_projection_input_too_large')
    }
  }
  if (current.length) batches.push(current)
  return batches
}

function candidateCatalog(
  db: Database.Database,
  job: DirectorExtractionJob,
): Map<string, DirectorExtractionProjectionEntry> {
  const accepted = new Set(Object.entries(job.reviewedReferences).flatMap(([table, ids]) => (
    (ids || []).map(stableId => `${table}:${stableId}`)
  )))
  const catalog = new Map<string, DirectorExtractionProjectionEntry>()
  for (const checkpoint of listDirectorExtractionCheckpoints(db, job.sourceTaskId)) {
    for (const entry of checkpoint.projectionReceipt?.entries || []) {
      if (!accepted.has(`${entry.table}:${entry.stableId}`)) continue
      if (catalog.has(entry.candidateKey)) {
        throw new Error('director_extraction_candidate_lineage_conflict')
      }
      catalog.set(entry.candidateKey, entry)
    }
  }
  return catalog
}

function assertCandidateKeysAvailable(
  db: Database.Database,
  job: DirectorExtractionJob,
  output: DirectorExtractionCandidateOutput,
): void {
  const historicalKeys = new Set(
    listDirectorExtractionCheckpoints(db, job.sourceTaskId)
      .filter(checkpoint => checkpoint.phase !== job.currentPhase)
      .flatMap(checkpoint => (
        checkpoint.projectionReceipt?.entries.map(entry => entry.candidateKey) || []
      )),
  )
  if (output.candidates.some(candidate => historicalKeys.has(candidate.candidateKey))) {
    throw new Error('director_extraction_candidate_lineage_conflict')
  }
}

function learningRecordCatalog(
  job: DirectorExtractionJob,
  input: Record<string, unknown>,
): Map<string, Record<string, unknown>> {
  if (!job.workId) throw new Error('director_extraction_work_not_registered')
  const context = parseDirectorLearningContextResult(job.workId, input.learningContext)
  const records = [
    ...(context.snapshot.work.activeIntent ? [context.snapshot.work.activeIntent] : []),
    ...context.snapshot.work.people_profiles,
    ...context.snapshot.work.story_nodes,
    ...context.snapshot.work.story_relations,
    ...context.snapshot.work.material_judgments,
    ...context.snapshot.work.narrative_plans,
    ...context.snapshot.work.director_cases,
    ...context.snapshot.project.director_cases,
    ...context.snapshot.project.skills_techniques,
  ]
  const catalog = new Map<string, Record<string, unknown>>()
  for (const record of records) {
    const identity = `${record.table}:${record.stableId}`
    const existing = catalog.get(identity)
    if (existing && directorExtractionDigest(existing) !== directorExtractionDigest(record)) {
      throw new Error('director_learning_context_duplicate_conflict')
    }
    catalog.set(identity, record)
  }
  return catalog
}

function evidenceIdsForCandidate(
  candidate: DirectorExtractionCandidate,
  catalog: Map<string, DirectorExtractionProjectionEntry>,
): string[] {
  const evidence = [...catalog.values()].filter(entry => (
    entry.table === 'material_evidence'
      && entry.startSeconds !== undefined && entry.endSeconds !== undefined
      && candidate.evidenceRefs.some(reference => overlap(
        { startSeconds: entry.startSeconds!, endSeconds: entry.endSeconds! },
        reference,
      ))
  ))
  const ids = [...new Set(evidence.map(entry => entry.stableId))].sort()
  if (!ids.length || ids.length > 20) {
    throw new Error('director_extraction_evidence_reference_invalid')
  }
  return ids
}

function sourceIds(
  candidate: DirectorExtractionCandidate,
  catalog: Map<string, DirectorExtractionProjectionEntry>,
  table: DirectorExtractionProjectionEntry['table'],
  learningCatalog: Map<string, Record<string, unknown>>,
): string[] {
  const expectedTable = DIRECTOR_EXTRACTION_SOURCE_TABLE_BY_KIND[
    candidate.kind as keyof typeof DIRECTOR_EXTRACTION_SOURCE_TABLE_BY_KIND
  ]
  if (expectedTable !== table) {
    throw new Error('director_extraction_candidate_lineage_invalid')
  }
  const currentIds = candidate.sourceCandidateKeys.map(key => {
    const entry = catalog.get(key)
    if (!entry || entry.table !== table) {
      throw new Error('director_extraction_candidate_lineage_invalid')
    }
    return entry.stableId
  })
  const historicalIds = (candidate.sourceStableIds || []).map(stableId => {
    if (!learningCatalog.has(`${table}:${stableId}`)) {
      throw new Error('director_extraction_candidate_lineage_invalid')
    }
    return stableId
  })
  const ids = [...currentIds, ...historicalIds]
  if (new Set(ids).size !== ids.length) {
    throw new Error('director_extraction_candidate_lineage_invalid')
  }
  return ids
}

function storyNodeId(
  reference: DirectorStoryNodeReference,
  catalog: Map<string, DirectorExtractionProjectionEntry>,
  learningCatalog: Map<string, Record<string, unknown>>,
): string {
  if (reference.type === 'candidate') {
    const entry = catalog.get(reference.candidateKey)
    if (!entry || entry.table !== 'story_nodes') {
      throw new Error('director_extraction_candidate_lineage_invalid')
    }
    return entry.stableId
  }
  if (!learningCatalog.has(`story_nodes:${reference.stableId}`)) {
    throw new Error('director_extraction_candidate_lineage_invalid')
  }
  return reference.stableId
}

const PREVIOUS_REFERENCE_BY_KIND = {
  person_profile: 'previousProfileVersionId',
  story_node: 'previousStoryNodeId',
  story_relation: 'previousStoryRelationId',
  material_judgment: 'previousJudgmentId',
  narrative_proposal: 'previousNarrativePlanId',
  director_case: 'previousDirectorCaseId',
  technique: 'previousSkillTechniqueId',
} as const

function previousVersionReference(
  candidate: DirectorExtractionCandidate,
  learningCatalog: Map<string, Record<string, unknown>>,
): Record<string, string> {
  const inferFromSource = ['person_profile', 'story_node', 'material_judgment']
    .includes(candidate.kind)
  const inferred = inferFromSource ? candidate.sourceStableIds?.[0] : undefined
  if (candidate.previousVersionStableId && inferred
    && candidate.previousVersionStableId !== inferred) {
    throw new Error('director_extraction_previous_version_conflict')
  }
  const stableId = candidate.previousVersionStableId || inferred
  if (!stableId) return {}
  const table = DIRECTOR_EXTRACTION_PREVIOUS_TABLE_BY_KIND[
    candidate.kind as keyof typeof DIRECTOR_EXTRACTION_PREVIOUS_TABLE_BY_KIND
  ]
  const referenceName = PREVIOUS_REFERENCE_BY_KIND[
    candidate.kind as keyof typeof PREVIOUS_REFERENCE_BY_KIND
  ]
  const previous = table ? learningCatalog.get(`${table}:${stableId}`) : null
  if (!table || !referenceName || !previous) {
    throw new Error('director_extraction_previous_version_invalid')
  }
  const previousFields = previous.fields
  if (!previousFields || typeof previousFields !== 'object' || Array.isArray(previousFields)) {
    throw new Error('director_extraction_previous_version_invalid')
  }
  if (candidate.kind === 'person_profile'
    && String((previousFields as Record<string, unknown>)['人物 ID'] || '')
      !== String(candidate.fields['人物 ID'] || '')) {
    throw new Error('director_extraction_previous_entity_mismatch')
  }
  if (candidate.kind === 'story_node') {
    const previousPersonId = String((previousFields as Record<string, unknown>)['人物 ID'] || '')
    const currentPersonId = String(candidate.fields['人物 ID'] || '')
    if (previousPersonId && currentPersonId && previousPersonId !== currentPersonId) {
      throw new Error('director_extraction_previous_entity_mismatch')
    }
  }
  return { [referenceName]: stableId }
}

function appliedTechniqueReferences(
  candidate: DirectorExtractionCandidate,
  learningCatalog: Map<string, Record<string, unknown>>,
): Record<string, string[]> {
  const stableIds = candidate.appliedTechniqueStableIds || []
  if (!stableIds.length) return {}
  if (!['material_judgment', 'narrative_proposal'].includes(candidate.kind)
    || stableIds.some(stableId => !learningCatalog.has(`skills_techniques:${stableId}`))) {
    throw new Error('director_extraction_technique_reference_invalid')
  }
  return { techniqueIds: stableIds }
}

function proposalItems(
  db: Database.Database,
  job: DirectorExtractionJob,
  output: DirectorExtractionCandidateOutput,
  input: Record<string, unknown>,
): DirectorExtractionProposalItem[] {
  if (!job.workId) throw new Error('director_extraction_work_not_registered')
  const catalog = candidateCatalog(db, job)
  const learningCatalog = learningRecordCatalog(job, input)
  const intentIds = job.reviewedReferences.director_intents || []
  return output.candidates.map(candidate => {
    const table = DIRECTOR_EXTRACTION_TABLE_BY_KIND[
      candidate.kind as keyof typeof DIRECTOR_EXTRACTION_TABLE_BY_KIND
    ]
    if (!table) throw new Error('director_extraction_candidate_kind_invalid')
    const evidenceIds = evidenceIdsForCandidate(candidate, catalog)
    const previous = previousVersionReference(candidate, learningCatalog)
    const techniques = appliedTechniqueReferences(candidate, learningCatalog)
    let references: Record<string, unknown>
    if (candidate.kind === 'person_profile' || candidate.kind === 'story_node') {
      sourceIds(candidate, catalog, table, learningCatalog)
      references = { evidenceIds, ...previous }
    } else if (candidate.kind === 'story_relation') {
      if (!candidate.sourceNode || !candidate.targetNode) {
        throw new Error('director_extraction_relation_sources_invalid')
      }
      const sourceNodeId = storyNodeId(candidate.sourceNode, catalog, learningCatalog)
      const targetNodeId = storyNodeId(candidate.targetNode, catalog, learningCatalog)
      if (sourceNodeId === targetNodeId) {
        throw new Error('director_extraction_relation_sources_invalid')
      }
      references = { sourceNodeId, targetNodeId, evidenceIds, ...previous }
    } else if (candidate.kind === 'material_judgment') {
      if (intentIds.length !== 1) throw new Error('director_extraction_intent_not_reviewed')
      sourceIds(candidate, catalog, table, learningCatalog)
      references = { intentVersionId: intentIds[0], evidenceIds, ...previous, ...techniques }
    } else if (candidate.kind === 'narrative_proposal') {
      if (intentIds.length !== 1) throw new Error('director_extraction_intent_not_reviewed')
      const nodeIds = sourceIds(candidate, catalog, 'story_nodes', learningCatalog)
      references = {
        intentVersionId: intentIds[0], nodeIds, evidenceIds, ...previous, ...techniques,
      }
    } else if (candidate.kind === 'director_case') {
      const [judgmentId] = sourceIds(
        candidate, catalog, 'material_judgments', learningCatalog,
      )
      references = { judgmentId, evidenceIds, ...previous }
    } else {
      const caseIds = sourceIds(candidate, catalog, 'director_cases', learningCatalog)
      references = { caseIds, ...previous }
    }
    return { candidate, table, fields: candidate.fields, references }
  })
}

function normalizedProjectionField(key: string, value: unknown): unknown {
  if (key !== '观察日期') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return value
}

function recordContainsProjectionFields(
  record: Record<string, unknown>,
  expectedFields: Record<string, unknown>,
): boolean {
  const fields = record.fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return false
  const actualFields = fields as Record<string, unknown>
  return Object.entries(expectedFields).every(([key, expected]) => (
    Object.hasOwn(actualFields, key)
      && directorExtractionDigest(normalizedProjectionField(key, actualFields[key]))
        === directorExtractionDigest(normalizedProjectionField(key, expected))
  ))
}

function validateProposalBatchResult(
  result: Record<string, unknown>,
  table: string,
  items: DirectorExtractionProposalItem[],
  workId: string,
): DirectorExtractionProjectionEntry[] {
  const expectedWorkId = table === 'skills_techniques' ? null : workId
  if (result.ok !== true || result.action !== 'propose_batch' || result.table !== table
    || result.workId !== expectedWorkId
    || result.count !== items.length
    || typeof result.created !== 'number' || !Number.isSafeInteger(result.created)
    || typeof result.unchanged !== 'number' || !Number.isSafeInteger(result.unchanged)
    || result.created < 0 || result.unchanged < 0
    || result.created + result.unchanged !== items.length
    || !Array.isArray(result.results)
    || result.results.length !== items.length) {
    throw new Error('director_extraction_proposal_result_invalid')
  }
  const observedStableIds = new Set<string>()
  let created = 0
  let unchanged = 0
  const entries = result.results.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('director_extraction_proposal_result_invalid')
    }
    const item = items[index]
    const value = raw as Record<string, unknown>
    const stableId = String(value.stableId || '')
    const outcome = value.outcome
    const record = value.record
    if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(stableId)
      || observedStableIds.has(stableId)
      || value.action !== 'propose'
      || value.table !== table
      || value.ok !== true
      || (outcome !== 'created' && outcome !== 'unchanged')
      || !record || typeof record !== 'object' || Array.isArray(record)
      || (record as Record<string, unknown>).table !== table
      || (record as Record<string, unknown>).stableId !== stableId
      || !recordContainsProjectionFields(record as Record<string, unknown>, item.fields)) {
      throw new Error('director_extraction_proposal_result_invalid')
    }
    observedStableIds.add(stableId)
    if (outcome === 'created') created++
    else unchanged++
    return {
      candidateKey: item.candidate.candidateKey,
      kind: item.candidate.kind,
      table: item.table,
      stableId,
    }
  })
  if (created !== result.created || unchanged !== result.unchanged) {
    throw new Error('director_extraction_proposal_result_invalid')
  }
  return entries
}

async function projectCandidateOutput(
  db: Database.Database,
  job: DirectorExtractionJob,
  output: DirectorExtractionCandidateOutput,
  input: Record<string, unknown>,
  commandRunner: DirectorCommandRunner,
): Promise<DirectorExtractionProjectionReceipt> {
  if (!job.workId) throw new Error('director_extraction_work_not_registered')
  const items = proposalItems(db, job, output, input)
  const entries: DirectorExtractionProjectionEntry[] = []
  const tables = [...new Set(items.map(item => item.table))].sort()
  for (const table of tables) {
    const tableItems = items.filter(item => item.table === table)
    for (const batch of directorExtractionProposalBatches(job.workId, table, tableItems)) {
      const result = await commandRunner(
        'propose-batch',
        directorExtractionProposalRequest(job.workId, table, batch),
      )
      entries.push(...validateProposalBatchResult(result, table, batch, job.workId))
    }
  }
  return directorExtractionProjectionReceiptSchema.parse({
    schemaVersion: 1,
    phase: output.phase,
    entries,
  })
}

const LEGACY_EVIDENCE_RECEIPT_RECOVERY_CONTRACT_DIGESTS = new Set([
  'ac621bcb61dfa4de840647a312d67445c22d5baa834b45818bb3ac89c4a58c1a',
])

function extractionReceiptFromEvidenceReceipt(
  receipt: DirectorEvidenceDeliveryReceipt,
): DirectorExtractionProjectionReceipt {
  return directorExtractionProjectionReceiptSchema.parse({
    schemaVersion: 1,
    phase: 'perception',
    entries: receipt.entries.map((entry, index) => ({
      candidateKey: `evidence-${String(index + 1).padStart(3, '0')}`,
      kind: 'material_observation',
      table: 'material_evidence',
      stableId: entry.stableId,
      startSeconds: entry.startSeconds,
      endSeconds: entry.endSeconds,
    })),
  })
}

async function recoverLegacyEvidenceReceipt(
  db: Database.Database,
  job: DirectorExtractionJob,
  outbox: DirectorEvidenceOutbox,
  commandRunner: DirectorCommandRunner,
  nowSeconds?: number,
): Promise<DirectorEvidenceDeliveryReceipt> {
  const output = getDirectorExtractionSourceOutput(db, job)
  const projection = await commandRunner(
    'transform',
    directorEvidenceTransformEnvelope({ taskId: job.sourceTaskId, workId: job.workId! }, output),
  )
  const batches = directorEvidenceProjectionBatches(projection, job.workId!)
  const stableIds = directorEvidenceExpectedReceiptEntries(batches).map(entry => entry.stableId)
  const records: Record<string, unknown>[] = []
  for (let offset = 0; offset < stableIds.length; offset += 20) {
    const requested = stableIds.slice(offset, offset + 20)
    const result = await commandRunner('operate', {
      action: 'get_many',
      table: 'material_evidence',
      workId: job.workId,
      stableIds: requested,
    })
    if (result.ok !== true || result.action !== 'get_many'
      || result.table !== 'material_evidence' || result.workId !== job.workId
      || result.count !== requested.length
      || !Array.isArray(result.missing) || result.missing.length !== 0
      || !Array.isArray(result.records) || result.records.length !== requested.length) {
      throw new Error('director_extraction_evidence_projection_recovery_conflict')
    }
    records.push(...result.records as Record<string, unknown>[])
  }
  let receipt: DirectorEvidenceDeliveryReceipt
  try {
    receipt = directorEvidenceVerifiedReadReceipt(
      batches,
      records,
      directorEvidenceSourceIdentityDigest(outbox),
    )
  } catch {
    throw new Error('director_extraction_evidence_projection_recovery_conflict')
  }
  return persistRecoveredDirectorEvidenceProjectionReceiptCore(
    db,
    outbox,
    receipt,
    Number.isSafeInteger(nowSeconds)
      ? Math.max(0, Number(nowSeconds))
      : Math.max(0, Math.floor(Date.now() / 1_000)),
  ).receipt
}

async function projectPerceptionEvidence(
  db: Database.Database,
  job: DirectorExtractionJob,
  commandRunner: DirectorCommandRunner,
  nowSeconds?: number,
): Promise<DirectorExtractionProjectionReceipt | null> {
  const outbox = getDirectorEvidenceOutbox(db, job.sourceTaskId)
  if (!outbox) return null
  assertEvidenceOutboxAuthority(job, outbox)
  if (outbox?.status === 'conflict') {
    throw new Error('director_extraction_evidence_authority_conflict')
  }
  if (outbox?.status === 'pending') return null
  // Revalidate the canonical parent before trusting even a valid stored
  // receipt; the receipt binds the original digest, not a later row rewrite.
  getDirectorExtractionSourceOutput(db, job)
  const stored = getDirectorEvidenceProjectionReceiptCore(db, outbox)
  const receipt = stored?.receipt
    || await recoverLegacyEvidenceReceipt(db, job, outbox, commandRunner, nowSeconds)
  return extractionReceiptFromEvidenceReceipt(receipt)
}

function assertEvidenceOutboxAuthority(
  job: DirectorExtractionJob,
  outbox: ReturnType<typeof getDirectorEvidenceOutbox>,
): void {
  if (!outbox) return
  if (!job.workId || !job.workQueryDigest
    || outbox.taskId !== job.sourceTaskId
    || outbox.bindingId !== job.sourceBindingId
    || outbox.tenantId !== job.tenantId
    || outbox.workspaceId !== job.workspaceId
    || outbox.workId !== job.workId
    || outbox.queryDigest !== job.workQueryDigest
    || outbox.resultSha256 !== job.sourceResultSha256
    || (outbox.projectionContractDigest !== directorEvidenceProjectionContractDigest()
      && !LEGACY_EVIDENCE_RECEIPT_RECOVERY_CONTRACT_DIGESTS
        .has(outbox.projectionContractDigest))) {
    throw new Error('director_extraction_evidence_authority_conflict')
  }
}

function ensureDirectorEvidenceOutboxForExtraction(
  db: Database.Database,
  job: DirectorExtractionJob,
  nowSeconds?: number,
): ReturnType<typeof getDirectorEvidenceOutbox> {
  let outbox = getDirectorEvidenceOutbox(db, job.sourceTaskId)
  if (!outbox) {
    if (!job.workId || !job.workQueryDigest) {
      throw new Error('director_extraction_work_not_registered')
    }
    const parent = getScopedN8nTaskRunByTaskId(db, job.sourceTaskId, {
      tenantId: job.tenantId,
      workspaceId: job.workspaceId,
    })
    if (!parent) throw new Error('director_extraction_source_conflict')
    const outcome = enqueueDirectorEvidenceOutbox(
      db,
      parent,
      nowSeconds ?? Math.floor(Date.now() / 1_000),
    )
    if (outcome === 'conflict') {
      throw new Error('director_extraction_evidence_authority_conflict')
    }
    outbox = getDirectorEvidenceOutbox(db, job.sourceTaskId)
    if (!outbox) throw new Error('director_extraction_evidence_outbox_missing')
  }
  assertEvidenceOutboxAuthority(job, outbox)
  return outbox
}

const NEGATIVE_TERMINAL_STATES: Record<string, Set<string>> = {
  material_evidence: new Set(['失效']),
  people_profiles: new Set(['失效']),
  story_nodes: new Set(['失效']),
  story_relations: new Set(['失效']),
  material_judgments: new Set(['失效']),
  narrative_plans: new Set(['废弃']),
  director_cases: new Set(['失效']),
  skills_techniques: new Set(['废弃']),
}

const REQUIRED_REVIEW_TABLES: Record<DirectorExtractionPhase, readonly string[]> = {
  perception: ['material_evidence'],
  understanding: ['story_nodes'],
  judgment: ['story_relations', 'material_judgments', 'narrative_plans'],
  case: ['director_cases'],
  technique: ['skills_techniques'],
}

async function loadProjectionRecords(
  workId: string,
  entries: DirectorExtractionProjectionEntry[],
  commandRunner: DirectorCommandRunner,
): Promise<Map<string, Record<string, unknown>>> {
  const records = new Map<string, Record<string, unknown>>()
  const tables = [...new Set(entries.map(entry => entry.table))]
  for (const table of tables) {
    const ids = entries.filter(entry => entry.table === table).map(entry => entry.stableId)
    for (let offset = 0; offset < ids.length; offset += 20) {
      const batch = ids.slice(offset, offset + 20)
      const globalTechnique = table === 'skills_techniques'
      const result = await commandRunner('operate', {
        action: 'get_many', table, stableIds: batch,
        ...(globalTechnique ? {} : { workId }),
      })
      if (result.ok !== true || result.action !== 'get_many'
        || result.table !== table || !Array.isArray(result.records)
        || (!globalTechnique && result.workId !== workId)
        || (globalTechnique && result.workId != null)
        || !Array.isArray(result.missing) || result.missing.length > 0) {
        throw new Error('director_extraction_review_read_invalid')
      }
      for (const record of result.records as Array<Record<string, unknown>>) {
        const stableId = String(record.stableId || '')
        const fields = record.fields
        if (record.table !== table
          || !fields || typeof fields !== 'object' || Array.isArray(fields)
          || !directorRecordBelongsToWork(
            table,
            fields as Record<string, unknown>,
            workId,
          )
          || !batch.includes(stableId) || records.has(`${table}:${stableId}`)) {
          throw new Error('director_extraction_review_read_invalid')
        }
        records.set(`${table}:${stableId}`, record)
      }
      if (batch.some(stableId => !records.has(`${table}:${stableId}`))) {
        throw new Error('director_extraction_review_read_invalid')
      }
    }
  }
  return records
}

async function activeDirectorIntent(
  workId: string,
  commandRunner: DirectorCommandRunner,
): Promise<{ stableId: string; record: Record<string, unknown> } | null> {
  const workflow = await commandRunner('operate', { action: 'workflow', workId })
  if (workflow.ok !== true || workflow.action !== 'workflow') {
    throw new Error('director_extraction_intent_read_invalid')
  }
  const stableId = typeof workflow.activeIntentId === 'string' ? workflow.activeIntentId : ''
  if (!stableId) return null
  const result = await commandRunner('operate', {
    action: 'get', table: 'director_intents', workId, stableId,
  })
  const record = result.record
  const fields = record && typeof record === 'object' && !Array.isArray(record)
    ? (record as Record<string, unknown>).fields
    : null
  if (result.ok !== true || result.action !== 'get' || result.found !== true
    || !record || typeof record !== 'object' || Array.isArray(record)
    || (record as Record<string, unknown>).table !== 'director_intents'
    || (record as Record<string, unknown>).stableId !== stableId
    || (record as Record<string, unknown>).reviewed !== true
    || !fields || typeof fields !== 'object' || Array.isArray(fields)
    || String((fields as Record<string, unknown>)['作品 ID'] || '').trim() !== workId) {
    throw new Error('director_extraction_intent_read_invalid')
  }
  return { stableId, record: record as Record<string, unknown> }
}

async function reconcileReviewJob(
  db: Database.Database,
  job: DirectorExtractionJob,
  commandRunner: DirectorCommandRunner,
  nowSeconds?: number,
): Promise<'waiting' | 'resumed' | 'completed'> {
  if (!job.workId) throw new Error('director_extraction_work_not_registered')
  const phase = DIRECTOR_EXTRACTION_REVIEW_PHASE_BY_STATUS[job.status]
  const checkpoint = phase ? getDirectorExtractionCheckpoint(db, job.sourceTaskId, phase) : null
  if (!phase || !checkpoint?.projectionReceipt) {
    throw new Error('director_extraction_projection_receipt_missing')
  }
  const records = await loadProjectionRecords(job.workId, checkpoint.projectionReceipt.entries, commandRunner)
  const reviewed: Record<string, string[]> = {}
  let unresolved = false
  for (const entry of checkpoint.projectionReceipt.entries) {
    const record = records.get(`${entry.table}:${entry.stableId}`)!
    if (record.reviewed === true) {
      ;(reviewed[entry.table] ||= []).push(entry.stableId)
      continue
    }
    const state = String(record.state || '')
    if (!NEGATIVE_TERMINAL_STATES[entry.table]?.has(state)) unresolved = true
  }
  if (unresolved) return 'waiting'
  for (const table of REQUIRED_REVIEW_TABLES[phase]) {
    if (!(reviewed[table] || []).length) {
      throw new Error(`director_extraction_review_rejected:${table}`)
    }
  }
  const references = reviewedDirectorReferencesSchema.parse(reviewed)
  const intent = phase === 'understanding'
    ? await activeDirectorIntent(job.workId, commandRunner)
    : null
  let next = resumeDirectorExtractionAfterReview(db, job.sourceTaskId, {
    tenantId: job.tenantId, workspaceId: job.workspaceId,
  }, references, { nowSeconds })
  if (phase === 'understanding' && intent) {
    next = resumeDirectorExtractionAfterIntent(db, job.sourceTaskId, {
      tenantId: job.tenantId, workspaceId: job.workspaceId,
    }, intent.stableId, { nowSeconds })
  }
  return next.status === 'completed' ? 'completed' : 'resumed'
}

async function reconcileWaitingJobs(
  db: Database.Database,
  commandRunner: DirectorCommandRunner,
  limit: number,
  nowSeconds?: number,
): Promise<{ reviewed: number; resumed: number; completed: number; failed: number }> {
  const result = { reviewed: 0, resumed: 0, completed: 0, failed: 0 }
  const jobs = listDirectorExtractionJobsByStatuses(
    db,
    DIRECTOR_EXTRACTION_WAITING_STATUSES,
    limit,
    { nowSeconds },
  )
  for (const job of jobs) {
    try {
      if (job.status === 'awaiting_evidence_projection') {
        const outbox = ensureDirectorEvidenceOutboxForExtraction(db, job, nowSeconds)
        if (outbox?.status === 'delivered') {
          resumeDirectorExtractionEvidenceProjection(db, job.sourceTaskId, {
            tenantId: job.tenantId, workspaceId: job.workspaceId,
          }, { nowSeconds })
          result.resumed++
        } else if (outbox?.status === 'conflict') {
          resumeDirectorExtractionEvidenceProjection(db, job.sourceTaskId, {
            tenantId: job.tenantId, workspaceId: job.workspaceId,
          }, { conflictCode: 'director_extraction_evidence_authority_conflict', nowSeconds })
          result.failed++
        }
        continue
      }
      if (job.status === 'awaiting_intent_review') {
        const intent = await activeDirectorIntent(job.workId!, commandRunner)
        if (intent) {
          resumeDirectorExtractionAfterIntent(db, job.sourceTaskId, {
            tenantId: job.tenantId, workspaceId: job.workspaceId,
          }, intent.stableId, { nowSeconds })
          result.resumed++
        }
        continue
      }
      result.reviewed++
      const outcome = await reconcileReviewJob(db, job, commandRunner, nowSeconds)
      if (outcome === 'resumed') result.resumed++
      else if (outcome === 'completed') result.completed++
    } catch (error) {
      // Review reads are deliberately fail-closed. A transient Feishu error is
      // retried on the next scheduler tick; deterministic rejection remains
      // visible in the remote candidate states and never auto-approves data.
      const code = safeErrorCode(error)
      if (job.status === 'awaiting_evidence_projection'
        && code === 'director_extraction_evidence_authority_conflict') {
        resumeDirectorExtractionEvidenceProjection(db, job.sourceTaskId, {
          tenantId: job.tenantId,
          workspaceId: job.workspaceId,
        }, { conflictCode: code, nowSeconds })
        result.failed++
      } else if (code.startsWith('director_extraction_review_rejected:')
        || deterministicConflict(code)) {
        failDirectorExtractionReview(db, job, code, { nowSeconds })
        result.failed++
      }
    }
  }
  return result
}

type DirectorExtractionLeaseGuard = {
  commandRunner: DirectorCommandRunner
  run<T>(operation: () => Promise<T>): Promise<T>
  stop(): void
}

function createDirectorExtractionLeaseGuard(
  db: Database.Database,
  job: DirectorExtractionJob,
  commandRunner: DirectorCommandRunner,
  nowSeconds?: number,
): DirectorExtractionLeaseGuard {
  if (!job.phaseTaskId || !job.ownerInstanceId || !job.leaseToken
    || job.leaseExpiresAt === null) throw new Error('director_extraction_lease_lost')
  const lease = {
    taskId: job.phaseTaskId,
    ownerInstanceId: job.ownerInstanceId,
    leaseToken: job.leaseToken,
    leaseExpiresAt: job.leaseExpiresAt,
    revision: job.revision,
  }
  const scope = { tenantId: job.tenantId, workspaceId: job.workspaceId }
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (nowSeconds !== undefined) {
      renewDirectorExtractionLease(db, job, { nowSeconds })
      const result = await operation()
      renewDirectorExtractionLease(db, job, { nowSeconds })
      return result
    }
    return runWithN8nChildExecutionHeartbeat(db, lease, scope, operation)
  }
  return {
    commandRunner: (command, input) => run(() => commandRunner(command, input)),
    run,
    stop: () => {},
  }
}

function parseModelJson(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string' || !text.trim()) throw new Error('director_extraction_model_empty')
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  if (Buffer.byteLength(trimmed, 'utf8') > DIRECTOR_EXTRACTION_MAX_OUTPUT_BYTES) {
    throw new Error('director_extraction_output_too_large')
  }
  try {
    const parsed = JSON.parse(trimmed)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error()
    return parsed as Record<string, unknown>
  } catch {
    throw new Error('director_extraction_model_json_invalid')
  }
}

export const defaultDirectorExtractionPhaseRunner: DirectorExtractionPhaseRunner = async (
  phase,
  input,
  job,
) => {
  const identity = DIRECTOR_EXTRACTION_DEFAULT_MODEL_IDENTITY
  const expectedContractDigest = directorExtractionContractDigest(identity)
  if (job.extractionContractDigest !== expectedContractDigest
    || input.extractionContractDigest !== expectedContractDigest
    || input.phase !== phase
    || directorExtractionDigest(input.modelIdentity) !== directorExtractionDigest(identity)) {
    throw new Error('director_extraction_contract_mismatch')
  }
  const registry = loadN8nModelRegistry()
  if (registry.errors.length) throw new Error('director_extraction_model_registry_invalid')
  const route = registry.routes.find(candidate => candidate.id === identity.routeId)
  if (!route || route.transport !== 'openai-compatible'
    || route.model !== identity.model
    || !publicN8nModelRoute(route).available
    || !route.capabilities.includes('text')
    || !route.capabilities.includes('structured-output')) {
    throw new Error('director_extraction_model_route_unavailable')
  }
  const result = await executeN8nModelRoute(route, {
    nodeKey: `director-${phase}`,
    instruction: DIRECTOR_EXTRACTION_PHASE_INSTRUCTIONS[phase],
    input,
    sessionKey: `director-extraction:${job.sourceResultSha256.slice(0, 24)}:${phase}`,
    delivery: { mode: 'none' },
    timeoutSeconds: Math.max(30, Math.min(600, route.timeoutSeconds)),
  })
  return parseModelJson(result.text)
}

export async function runNextDirectorExtractionPhase(
  db: Database.Database,
  options: {
    runner?: DirectorExtractionPhaseRunner
    commandRunner?: DirectorCommandRunner
    nowSeconds?: number
  } = {},
): Promise<{ outcome: 'idle' | 'awaiting_review' | 'waiting_evidence' | 'failed'; job: DirectorExtractionJob | null }> {
  for (const pending of listDirectorExtractionJobsByStatuses(
    db,
    ['pending'],
    DIRECTOR_EXTRACTION_CLAIM_SCAN_LIMIT,
    { nowSeconds: options.nowSeconds, scanMultiplier: 1 },
  )) {
    if (pending.currentPhase === 'perception') {
      ensureDirectorEvidenceOutboxForExtraction(db, pending, options.nowSeconds)
    }
  }
  const job = claimNextDirectorExtractionJob(db, {
    nowSeconds: options.nowSeconds,
    requirePerceptionEvidenceReady: true,
  })
  if (!job) return { outcome: 'idle', job: null }
  let leaseGuard: DirectorExtractionLeaseGuard | null = null
  try {
    if (job.extractionContractDigest !== directorExtractionContractDigest(
      DIRECTOR_EXTRACTION_DEFAULT_MODEL_IDENTITY,
    )) {
      throw new Error('director_extraction_contract_mismatch')
    }
    leaseGuard = createDirectorExtractionLeaseGuard(
      db,
      job,
      options.commandRunner || runDirectorCommand,
      options.nowSeconds,
    )
    const commandRunner = leaseGuard.commandRunner
    const phase = job.currentPhase
    if (phase === 'complete') throw new Error('director_extraction_phase_invalid')
    if (phase === 'judgment' && job.reviewedReferences.director_intents?.length !== 1) {
      throw new Error('director_extraction_learning_reference_intent_mismatch')
    }
    const staged = getDirectorExtractionCheckpoint(db, job.sourceTaskId, phase)
    let output: DirectorExtractionCandidateOutput
    let input: Record<string, unknown>
    if (phase === 'perception') {
      const outbox = ensureDirectorEvidenceOutboxForExtraction(db, job, options.nowSeconds)
      if (outbox?.status === 'pending') {
        return {
          outcome: 'waiting_evidence',
          job: pauseDirectorExtractionForEvidence(db, job, { nowSeconds: options.nowSeconds }),
        }
      }
      input = buildDirectorPerceptionCheckpointInput({
        sourceTaskId: job.sourceTaskId,
        sourceBindingId: job.sourceBindingId,
        tenantId: job.tenantId,
        workspaceId: job.workspaceId,
        workId: job.workId,
        workQueryDigest: job.workQueryDigest,
        materialId: job.materialId,
        sourceResultSha256: job.sourceResultSha256,
        extractionContractDigest: job.extractionContractDigest,
      })
      if (!staged) throw new Error('director_extraction_checkpoint_missing')
      if (staged.inputSha256 !== directorExtractionDigest(input)) {
        throw new Error('director_extraction_checkpoint_conflict')
      }
      output = parseDirectorExtractionOutput(phase, staged.candidateOutput)
      const receipt = await projectPerceptionEvidence(
        db,
        job,
        commandRunner,
        options.nowSeconds,
      )
      if (!receipt) {
        return {
          outcome: 'waiting_evidence',
          job: pauseDirectorExtractionForEvidence(db, job, { nowSeconds: options.nowSeconds }),
        }
      }
      const next = completeDirectorExtractionProjection(db, job, receipt, {
        nowSeconds: options.nowSeconds,
      })
      return { outcome: 'awaiting_review', job: next }
    }

    if (staged) {
      if (staged.projectionState === 'delivered') {
        throw new Error('director_extraction_checkpoint_state_invalid')
      }
      output = parseDirectorExtractionOutput(phase, staged.candidateOutput)
      assertCandidateKeysAvailable(db, job, output)
      input = staged.phaseInput
      await revalidateStagedDependencies(db, job, output, input, commandRunner)
    } else {
      input = await buildPhaseInput(db, job, commandRunner)
      const phaseRunner = options.runner || defaultDirectorExtractionPhaseRunner
      const rawOutput = await leaseGuard.run(() => phaseRunner(phase, input, job))
      output = parseDirectorExtractionOutput(phase, rawOutput)
      assertCandidateKeysAvailable(db, job, output)
      validateEvidenceReferences(output, input)
      await revalidateStagedDependencies(db, job, output, input, commandRunner)
      stageDirectorExtractionCheckpoint(db, job, input, output, { nowSeconds: options.nowSeconds })
    }
    validateEvidenceReferences(output, input)
    await revalidateStagedDependencies(db, job, output, input, commandRunner)
    const receipt = await projectCandidateOutput(db, job, output, input, commandRunner)
    const next = completeDirectorExtractionProjection(db, job, receipt, {
      nowSeconds: options.nowSeconds,
    })
    return { outcome: 'awaiting_review', job: next }
  } catch (error) {
    const code = safeErrorCode(error)
    const next = failDirectorExtractionPhase(db, job, code, {
      nowSeconds: options.nowSeconds,
      conflict: deterministicConflict(code),
    })
    return { outcome: 'failed', job: next }
  } finally {
    leaseGuard?.stop()
  }
}

export async function drainDirectorExtractionJobs(
  db: Database.Database,
  options: {
    runner?: DirectorExtractionPhaseRunner
    commandRunner?: DirectorCommandRunner
    limit?: number
    nowSeconds?: number
  } = {},
): Promise<{
  processed: number
  awaitingReview: number
  waitingEvidence: number
  reviewsChecked: number
  resumed: number
  completed: number
  failed: number
}> {
  const limit = Math.max(1, Math.min(20, Math.floor(options.limit || 5)))
  const reconciled = await reconcileWaitingJobs(
    db,
    options.commandRunner || runDirectorCommand,
    limit,
    options.nowSeconds,
  )
  const result = {
    processed: 0,
    awaitingReview: 0,
    waitingEvidence: 0,
    reviewsChecked: reconciled.reviewed,
    resumed: reconciled.resumed,
    completed: reconciled.completed,
    failed: reconciled.failed,
  }
  for (let index = 0; index < limit; index++) {
    const attempt = await runNextDirectorExtractionPhase(db, options)
    if (attempt.outcome === 'idle') break
    result.processed++
    if (attempt.outcome === 'awaiting_review') result.awaitingReview++
    else if (attempt.outcome === 'waiting_evidence') result.waitingEvidence++
    else result.failed++
  }
  return result
}
