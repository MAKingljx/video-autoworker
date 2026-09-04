import type Database from 'better-sqlite3'
import {
  directorEvidenceBindingFromInput,
} from '@/lib/director-evidence-delivery-core'
import { runDirectorCommand } from '@/lib/director-evidence-outbox'
import {
  listDirectorExtractionJobsForWork,
  projectDirectorExtractionStatus,
  registerDirectorExtractionJob,
  retryExhaustedDirectorExtractionJob,
  type DirectorExtractionJob,
} from '@/lib/director-extraction-runs'
import {
  getScopedN8nTaskRunByTaskId,
  searchN8nVideoResults,
  type N8nTaskScope,
} from '@/lib/n8n-task-runs'
import { assertDirectorBrainScope } from '@/lib/director-brain-scope'

const DIRECTOR_EXTRACTION_BACKFILL_MAX_SOURCES = 2_000
const DIRECTOR_EXTRACTION_STATUS_SOURCE_LIMIT = 20

export type ReviewedDirectorWorkVerifier = (
  workId: string,
) => Promise<{ workId: string }>

export async function verifyReviewedDirectorWork(
  workId: string,
): Promise<{ workId: string }> {
  const result = await runDirectorCommand('operate', {
    action: 'get',
    table: 'works',
    stableId: workId,
  })
  const record = result.record
  if (result.ok !== true || result.action !== 'get' || result.found !== true
    || result.stableId !== workId
    || !record || typeof record !== 'object' || Array.isArray(record)
    || (record as Record<string, unknown>).table !== 'works'
    || (record as Record<string, unknown>).stableId !== workId
    || (record as Record<string, unknown>).reviewed !== true) {
    throw new Error('director_extraction_work_not_reviewed')
  }
  return { workId }
}

export function resolveDirectorExtractionSourceTaskId(
  db: Database.Database,
  scope: N8nTaskScope,
  workId: string,
  sourceQuery?: string,
): string {
  const query = String(sourceQuery || '').trim()
  if (query) {
    // Restrict the candidate set to the already-resolved work before applying
    // the human source query. A busy neighboring work must never cause a false
    // ambiguity or hide this work's source behind the global candidate cap.
    const search = searchN8nVideoResults(db, scope, query, 200, {
      directorEvidenceWorkId: workId,
    })
    const taskIds = [...new Set(search.hits.map(hit => hit.taskId))]
    if (taskIds.length > 1 || search.truncated) {
      throw new Error('director_extraction_source_ambiguous')
    }
    if (taskIds.length === 1) return taskIds[0]
    throw new Error('director_extraction_source_not_found')
  }

  const rows = db.prepare(`
    SELECT run.task_id
    FROM n8n_task_runs run
    JOIN n8n_workflow_bindings binding
      ON binding.id = run.binding_id
     AND binding.tenant_id = run.tenant_id
     AND binding.workspace_id = run.workspace_id
    WHERE run.tenant_id = ? AND run.workspace_id = ?
      AND run.source IN ('video-autoworker', 'openclaw')
      AND run.status = 'succeeded' AND binding.task_type = 'video-analysis'
      AND json_valid(run.input) = 1
      AND json_extract(run.input, '$.directorEvidence.workId') = ?
    ORDER BY COALESCE(run.completed_at, run.updated_at) DESC, run.id DESC
    LIMIT 2
  `).all(scope.tenantId, scope.workspaceId, workId) as Array<{ task_id: string }>
  if (rows.length > 1) throw new Error('director_extraction_source_ambiguous')
  if (rows.length === 1) return rows[0].task_id
  throw new Error('director_extraction_source_not_found')
}

export async function startDirectorExtractionForWork(
  db: Database.Database,
  scope: N8nTaskScope,
  input: {
    workId: string
    sourceQuery?: string
    objective?: string
  },
  options: {
    workVerifier?: ReviewedDirectorWorkVerifier
  } = {},
): Promise<DirectorExtractionJob> {
  assertDirectorBrainScope(scope)
  const sourceTaskId = resolveDirectorExtractionSourceTaskId(
    db,
    scope,
    input.workId,
    input.sourceQuery,
  )
  const source = getScopedN8nTaskRunByTaskId(db, sourceTaskId, scope)
  if (!source) throw new Error('director_extraction_source_not_found')
  const sourceBinding = directorEvidenceBindingFromInput(source.input)
  if (!sourceBinding) throw new Error('director_extraction_work_not_registered')
  if (sourceBinding.workId !== input.workId) {
    throw new Error('director_extraction_work_binding_conflict')
  }
  const verifiedBinding = await (options.workVerifier || verifyReviewedDirectorWork)(input.workId)
  if (verifiedBinding.workId !== input.workId) {
    throw new Error('director_extraction_work_binding_conflict')
  }
  const job = registerDirectorExtractionJob(db, sourceTaskId, scope, {
    binding: sourceBinding,
    objective: input.objective,
  }).job
  return retryExhaustedDirectorExtractionJob(db, job.sourceTaskId, scope)
}

export function getDirectorExtractionStatusForWork(
  db: Database.Database,
  scope: N8nTaskScope,
  workId: string,
): Record<string, unknown> | null {
  assertDirectorBrainScope(scope)
  const jobs = listDirectorExtractionJobsForWork(db, workId, scope)
  if (!jobs.length) return null
  return projectDirectorExtractionWorkStatus(db, jobs)
}

function isWaitingForReview(job: DirectorExtractionJob): boolean {
  return job.status.startsWith('awaiting_') && job.status.endsWith('_review')
}

function statusPriority(job: DirectorExtractionJob): number {
  if (job.status === 'running') return 0
  if (job.status === 'pending') return 1
  if (job.status === 'awaiting_evidence_projection') return 2
  if (isWaitingForReview(job)) return 3
  if (job.status === 'failed') return 4
  if (job.status === 'conflict') return 5
  return 6
}

export function projectDirectorExtractionWorkStatus(
  db: Database.Database,
  jobs: DirectorExtractionJob[],
): Record<string, unknown> {
  if (!jobs.length) throw new Error('director_extraction_source_not_found')
  const projected = jobs.map(job => projectDirectorExtractionStatus(db, job))
  const completed = jobs.filter(job => job.status === 'completed').length
  const failed = jobs.filter(job => job.status === 'failed' || job.status === 'conflict').length
  const waitingReview = jobs.filter(isWaitingForReview).length
  const active = jobs.length - completed - failed - waitingReview
  const representative = jobs
    .map((job, index) => ({ job, index }))
    .sort((left, right) => statusPriority(left.job) - statusPriority(right.job)
      || Number(projected[left.index]?.progress || 0) - Number(projected[right.index]?.progress || 0)
      || left.job.createdAt - right.job.createdAt)[0]!
  const status = completed === jobs.length ? 'completed' : representative.job.status
  const progress = Math.round(projected.reduce(
    (sum, item) => sum + Number(item.progress || 0), 0,
  ) / jobs.length)
  const candidateCount = projected.reduce(
    (sum, item) => sum + Number(item.candidateCount || 0), 0,
  )
  const visibleSources = projected.slice(0, DIRECTOR_EXTRACTION_STATUS_SOURCE_LIMIT)
  return {
    status,
    phase: representative.job.currentPhase,
    progress,
    candidateCount,
    sourceCount: jobs.length,
    counts: { completed, active, failed, waitingReview },
    sources: visibleSources,
    sourcesTruncated: projected.length > visibleSources.length,
    message: completed === jobs.length
      ? `全部 ${jobs.length} 个素材来源的导演知识链已完成复核`
      : `共 ${jobs.length} 个素材来源：完成 ${completed}，处理中 ${active}，待复核 ${waitingReview}，失败 ${failed}`,
  }
}

export async function backfillDirectorExtractionForWork(
  db: Database.Database,
  scope: N8nTaskScope,
  input: { workId: string },
  options: { workVerifier?: ReviewedDirectorWorkVerifier } = {},
): Promise<Record<string, unknown>> {
  assertDirectorBrainScope(scope)
  const verifiedBinding = await (options.workVerifier || verifyReviewedDirectorWork)(input.workId)
  if (verifiedBinding.workId !== input.workId) {
    throw new Error('director_extraction_work_binding_conflict')
  }
  const sources = db.prepare(`
    SELECT run.task_id
    FROM n8n_task_runs run
    JOIN n8n_workflow_bindings binding
      ON binding.id = run.binding_id
     AND binding.tenant_id = run.tenant_id
     AND binding.workspace_id = run.workspace_id
    WHERE run.tenant_id = ? AND run.workspace_id = ?
      AND run.source IN ('video-autoworker', 'openclaw')
      AND run.status = 'succeeded' AND binding.task_type = 'video-analysis'
      AND json_valid(run.input) = 1
      AND json_extract(run.input, '$.directorEvidence.workId') = ?
    ORDER BY COALESCE(run.completed_at, run.updated_at) ASC, run.id ASC
    LIMIT ?
  `).all(
    scope.tenantId,
    scope.workspaceId,
    input.workId,
    DIRECTOR_EXTRACTION_BACKFILL_MAX_SOURCES + 1,
  ) as Array<{ task_id: string }>
  if (!sources.length) throw new Error('director_extraction_source_not_found')
  if (sources.length > DIRECTOR_EXTRACTION_BACKFILL_MAX_SOURCES) {
    throw new Error('director_extraction_backfill_scope_too_large')
  }

  const existing = new Set(
    listDirectorExtractionJobsForWork(db, input.workId, scope).map(job => job.sourceTaskId),
  )
  let registered = 0
  const rejectionCounts = {
    missingBinding: 0,
    bindingConflict: 0,
    registrationError: 0,
  }
  for (const source of sources) {
    if (existing.has(source.task_id)) continue
    try {
      const sourceRun = getScopedN8nTaskRunByTaskId(db, source.task_id, scope)
      const sourceBinding = sourceRun
        ? directorEvidenceBindingFromInput(sourceRun.input)
        : null
      if (!sourceBinding) {
        rejectionCounts.missingBinding++
        continue
      }
      if (sourceBinding.workId !== verifiedBinding.workId) {
        rejectionCounts.bindingConflict++
        continue
      }
      const result = registerDirectorExtractionJob(db, source.task_id, scope, {
        binding: sourceBinding,
      })
      if (result.created) registered++
      existing.add(source.task_id)
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith('director_extraction_')) {
        throw error
      }
      rejectionCounts.registrationError++
    }
  }
  const rejected = Object.values(rejectionCounts).reduce((sum, count) => sum + count, 0)
  const jobs = listDirectorExtractionJobsForWork(db, input.workId, scope)
  const status = jobs.length ? projectDirectorExtractionWorkStatus(db, jobs) : {
    status: 'not_started',
    phase: null,
    progress: 0,
    candidateCount: 0,
    sourceCount: 0,
    counts: { completed: 0, active: 0, failed: 0, waitingReview: 0 },
    sources: [],
    sourcesTruncated: false,
    message: '素材来源未通过导演作品绑定校验',
  }
  return {
    scanned: sources.length,
    registered,
    existing: sources.length - registered - rejected,
    rejected,
    rejectionCounts,
    ...status,
  }
}
