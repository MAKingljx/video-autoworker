import type Database from 'better-sqlite3'
import { getN8nVideoResultDetail, listN8nVideoResults, type N8nTaskScope } from '@/lib/n8n-task-runs'

const MAX_QUERY_LENGTH = 120
const MAX_SEGMENT_DIRECTORY_ITEMS = 10_000
const MAX_SEGMENT_DIRECTORY_PREVIEW_BYTES = 24 * 1024

export interface N8nVideoCoverWorkflowServices {
  listResults(db: Database.Database, scope: N8nTaskScope, options: { query: string; status: 'succeeded'; limit: number }): {
    results: Array<{ taskId: string; title: string }>
    total: number
  }
  getResultDetail(db: Database.Database, taskId: string, scope: N8nTaskScope): null | {
    taskId: string
    title: string
    status: string
    resultAvailable: boolean
    learningResultInvalid?: boolean
    learningResult?: { status: string; totalSegments: number; failedSegments: Array<{ index: number }> } | null
    chapters: Array<{
      index: number
      startTime: string | null
      endTime: string | null
      startSeconds: number | null
      endSeconds: number | null
      summary: string | null
    }>
  }
}

export interface N8nVideoCoverDirectoryItem {
  index: number
  timeRange: string
  summary: string
  available: boolean
}

const defaultServices: N8nVideoCoverWorkflowServices = {
  listResults: listN8nVideoResults,
  getResultDetail: getN8nVideoResultDetail,
}

function compactText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum)
}

function truncateUtf8(value: string, maximum: number): string {
  let bytes = 0
  let result = ''
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maximum) break
    result += character
    bytes += size
  }
  return result
}

function validQuery(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && value.length > 0
    && value.length <= MAX_QUERY_LENGTH && Buffer.byteLength(value, 'utf8') <= 480
}

function compactPreviews(items: N8nVideoCoverDirectoryItem[]): { items: N8nVideoCoverDirectoryItem[]; compacted: boolean } {
  if (items.length === 0) return { items, compacted: false }
  const previewBudget = Math.floor(MAX_SEGMENT_DIRECTORY_PREVIEW_BYTES / items.length)
  let compacted = false
  return {
    items: items.map(item => {
      const summary = truncateUtf8(item.summary, previewBudget)
      if (summary !== item.summary) compacted = true
      return summary === item.summary ? item : { ...item, summary }
    }),
    compacted,
  }
}

/**
 * Return the authoritative saved-summary directory for the cover workflow.
 * This is deliberately an application service rather than a second OpenClaw
 * tool path: the caller never receives task IDs, source paths, or media paths.
 */
export function readN8nVideoCoverDirectory(
  db: Database.Database,
  scope: N8nTaskScope,
  input: { query: string },
  services: N8nVideoCoverWorkflowServices = defaultServices,
): { videoName: string; totalSegments: number; items: N8nVideoCoverDirectoryItem[]; directoryPreviewCompacted: boolean } {
  if (!validQuery(input?.query)) throw new Error('cover_workflow_request_invalid')
  const matches = services.listResults(db, scope, { query: input.query, status: 'succeeded', limit: 100 })
  if (matches.total !== 1 || matches.results.length !== 1) {
    throw new Error(matches.total > 1 ? 'cover_workflow_video_ambiguous' : 'cover_workflow_video_not_found')
  }
  const selected = matches.results[0]
  const detail = services.getResultDetail(db, selected.taskId, scope)
  if (!detail || detail.taskId !== selected.taskId || detail.title !== input.query || detail.status !== 'succeeded'
    || !detail.resultAvailable || detail.learningResultInvalid || !detail.learningResult) {
    throw new Error('cover_workflow_learning_result_unavailable')
  }
  const learningResult = detail.learningResult
  if (!['complete', 'partial'].includes(learningResult.status)
    || !Number.isSafeInteger(learningResult.totalSegments) || learningResult.totalSegments < 1
    || learningResult.totalSegments > MAX_SEGMENT_DIRECTORY_ITEMS
    || !Array.isArray(learningResult.failedSegments)
    || !Array.isArray(detail.chapters) || detail.chapters.length > learningResult.totalSegments) {
    throw new Error('cover_workflow_learning_result_unavailable')
  }

  if (learningResult.failedSegments.some(segment => !segment || !Number.isSafeInteger(segment.index) || segment.index < 1
    || segment.index > learningResult.totalSegments)) {
    throw new Error('cover_workflow_learning_result_unavailable')
  }
  const failed = new Set(learningResult.failedSegments.map(segment => segment.index))
  const seen = new Set<number>()
  const items: N8nVideoCoverDirectoryItem[] = []
  for (const chapter of detail.chapters) {
    if (!chapter || typeof chapter !== 'object' || !Number.isSafeInteger(chapter.index)
      || chapter.index < 1 || chapter.index > learningResult.totalSegments
      || seen.has(chapter.index)) throw new Error('cover_workflow_learning_result_unavailable')
    seen.add(chapter.index)
    const start = Number(chapter.startSeconds)
    const end = Number(chapter.endSeconds)
    const available = !failed.has(chapter.index) && Number.isFinite(start) && Number.isFinite(end)
      && start >= 0 && end > start
    items.push({
      index: chapter.index,
      timeRange: compactText(`${chapter.startTime || ''}-${chapter.endTime || ''}`, 128),
      summary: compactText(chapter.summary, 8_192),
      available,
    })
  }
  const compacted = compactPreviews(items.toSorted((left, right) => left.index - right.index))
  return {
    videoName: detail.title,
    totalSegments: learningResult.totalSegments,
    items: compacted.items,
    directoryPreviewCompacted: compacted.compacted,
  }
}
