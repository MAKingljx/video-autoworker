import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'

export const n8nTaskIdentitySchema = z.string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/, '任务标识只能包含字母、数字、点、下划线、冒号和连字符')

const deliveryChannelSchema = z.enum([
  'last', 'telegram', 'whatsapp', 'discord', 'irc', 'googlechat', 'slack',
  'signal', 'imessage', 'feishu', 'nostr', 'msteams', 'mattermost',
  'nextcloud-talk', 'matrix', 'raft', 'line', 'zalo', 'clickclack',
  'zalouser', 'sms', 'synology-chat', 'tlon', 'qa-channel', 'qqbot', 'twitch',
])

export const n8nTaskDeliverySchema = z.object({
  mode: z.enum(['none', 'reply']).default('none'),
  sessionKey: z.string().trim().max(240).optional(),
  channel: deliveryChannelSchema.optional(),
  target: z.string().trim().max(240).optional(),
  accountId: z.string().trim().max(240).optional(),
}).default({ mode: 'none' }).superRefine((delivery, ctx) => {
  if (delivery.mode !== 'reply') return
  if (delivery.sessionKey || (delivery.channel && delivery.target)) return
  ctx.addIssue({
    code: 'custom',
    message: '回投任务必须提供 sessionKey，或同时提供 channel 和 target',
  })
})

export type N8nTaskDelivery = z.infer<typeof n8nTaskDeliverySchema>

export const n8nTaskRunListStatusSchema = z.enum([
  'queued',
  'accepted',
  'running',
  'succeeded',
  'failed',
  'cancelled',
])

export type N8nTaskRunListStatus = z.infer<typeof n8nTaskRunListStatusSchema>

export interface N8nTaskScope {
  workspaceId: number
  tenantId: number
}

export interface N8nTaskRun {
  id: number
  taskId: string
  idempotencyKey: string
  bindingId: number
  status: string
  source: string
  requestedBy: string
  routing: Record<string, unknown>
  input: Record<string, unknown>
  delivery: N8nTaskDelivery
  output: Record<string, unknown> | null
  error: string | null
  attemptCount: number
  maxAttempts: number
  workspaceId: number
  tenantId: number
  createdAt: number
  acceptedAt: number | null
  startedAt: number | null
  completedAt: number | null
  updatedAt: number
}

interface N8nTaskRunRow {
  id: number
  task_id: string
  idempotency_key: string
  binding_id: number
  status: string
  source: string
  requested_by: string
  routing: string
  input: string
  delivery: string
  output: string | null
  error: string | null
  attempt_count: number
  max_attempts: number
  workspace_id: number
  tenant_id: number
  created_at: number
  accepted_at: number | null
  started_at: number | null
  completed_at: number | null
  updated_at: number
}

interface N8nTaskRunSummaryRow {
  task_id: string
  status: string
  source: string
  routing: string
  input: string
  error: string | null
  attempt_count: number
  max_attempts: number
  created_at: number
  accepted_at: number | null
  started_at: number | null
  completed_at: number | null
  updated_at: number
  workflow_name: string | null
  binding_task_type: string | null
  result_available: number
}

interface N8nVideoResultRow extends N8nTaskRunRow {
  workflow_name: string | null
  binding_task_type: string | null
}

interface N8nVideoResultListRow extends N8nTaskRunSummaryRow {
  result_summary: string | null
  chapter_count: number
  timeline_count: number
}

export interface N8nTaskRunListItem {
  taskId: string
  title: string
  taskType: string
  workflowName: string
  status: string
  source: string
  attemptCount: number
  maxAttempts: number
  createdAt: number
  acceptedAt: number | null
  startedAt: number | null
  processingStartedAt: number | null
  completedAt: number | null
  updatedAt: number
  error: string | null
  resultAvailable: boolean
  batchId: string | null
  batchIndex: number | null
}

export interface N8nTaskRunListResult {
  runs: N8nTaskRunListItem[]
  total: number
  limit: number
  offset: number
}

export interface N8nVideoResultListItem {
  taskId: string
  title: string
  status: string
  source: string
  createdAt: number
  completedAt: number | null
  updatedAt: number
  batchId: string | null
  batchIndex: number | null
  summary: string | null
  chapterCount: number
  timelineCount: number
  resultAvailable: boolean
}

export interface N8nVideoResultChapter {
  index: number
  startTime: string | null
  endTime: string | null
  startSeconds: number | null
  endSeconds: number | null
  summary: string | null
}

export interface N8nVideoResultTimelineItem {
  index: number
  timeRange: string | null
  startSeconds: number | null
  endSeconds: number | null
  transcript: string | null
  visualAnalysis: string | null
}

export interface N8nVideoResultDetail extends N8nVideoResultListItem {
  summary: string | null
  chapters: N8nVideoResultChapter[]
  timeline: N8nVideoResultTimelineItem[]
  transcript: string | null
  visualAnalysis: string | null
  fullReport: string | null
}

export interface N8nVideoResultListResult {
  results: N8nVideoResultListItem[]
  total: number
  limit: number
  offset: number
}

export type N8nVideoSearchHitKind = 'timeline' | 'chapter' | 'title' | 'summary' | 'transcript' | 'visual' | 'report'

export interface N8nVideoSearchHit {
  id: string
  taskId: string
  title: string
  status: string
  completedAt: number | null
  kind: N8nVideoSearchHitKind
  label: string
  snippet: string
  matchedFields: string[]
  timeRange: string | null
  startSeconds: number | null
  endSeconds: number | null
  score: number
}

export interface N8nVideoSearchResult {
  query: string
  hits: N8nVideoSearchHit[]
  total: number
  videoCount: number
  segmentCount: number
  limit: number
  truncated: boolean
}

interface N8nTaskRunListProjection {
  taskId: string
  status: string
  source: string
  routing: Record<string, unknown>
  input: Record<string, unknown>
  error: string | null
  attemptCount: number
  maxAttempts: number
  createdAt: number
  acceptedAt: number | null
  startedAt: number | null
  processingStartedAt?: number | null
  completedAt: number | null
  updatedAt: number
  workflowName: string | null
  bindingTaskType: string | null
  resultAvailable: boolean
}

const TOP_LEVEL_TASK_SOURCES = ['video-autoworker', 'openclaw'] as const
const MEDIA_STAGES = ['prepare', 'audio', 'vision', 'finalize'] as const
const TASK_STATUS_QUERY_CHUNK_SIZE = 400

function compactString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const compacted = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return compacted ? compacted.slice(0, maxLength) : null
}

function safeMultilineText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, ' ')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim()
  const redacted = cleaned
    .replace(/(?:\/Users|\/home|\/private|\/var|\/tmp)\/[^\s，。；;]+/g, '[路径]')
    .replace(/[A-Za-z]:\\[^\s，。；;]+/g, '[路径]')
  return redacted ? redacted.slice(0, maxLength) : null
}

function safeModelResultText(value: unknown, maxLength: number): string | null {
  const text = safeMultilineText(value, maxLength)
  if (!text) return null
  const withoutClosedReasoning = text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
    .trim()
  if (!withoutClosedReasoning || /^<(?:think|analysis)>/i.test(withoutClosedReasoning)) return null

  const opening = withoutClosedReasoning.slice(0, 900)
  const startsLikePlanning = /^(?:我们需要(?:回答|回复|基于|整合|分析)|需要回答用户|we need to (?:answer|respond|analy[sz]e)|the user (?:asks|wants|provided))/i.test(opening)
  const containsPromptMeta = /(?:用户(?:的)?(?:中文)?(?:请求|要求|给了|提供)|业务要求|只输出(?:最终|报告|章节)|不要输出思考过程|提供的分段结果|需要生成(?:最终|报告|章节))/i.test(opening)
  return startsLikePlanning && containsPromptMeta ? null : withoutClosedReasoning
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function clockSeconds(value: string): number | null {
  const parts = value.trim().split(':').map(Number)
  if (!parts.length || parts.length > 3 || parts.some(part => !Number.isFinite(part) || part < 0)) return null
  const seconds = parts.reduce((total, part) => total * 60 + part, 0)
  return Number.isFinite(seconds) ? seconds : null
}

function timeRangeSeconds(value: string | null): { startSeconds: number | null; endSeconds: number | null } {
  if (!value) return { startSeconds: null, endSeconds: null }
  const match = value.match(/^\s*([0-9:.]+)\s*-\s*([0-9:.]+)\s*$/)
  if (!match) return { startSeconds: null, endSeconds: null }
  return { startSeconds: clockSeconds(match[1]), endSeconds: clockSeconds(match[2]) }
}

function safeDisplayName(value: unknown): string | null {
  const compacted = compactString(value, 500)
  if (!compacted) return null
  const segments = compacted.split(/[\\/]/).filter(Boolean)
  return compactString(segments.at(-1) || compacted, 160)
}

function shortTaskId(taskId: string): string {
  if (taskId.length <= 22) return taskId
  return `${taskId.slice(0, 12)}…${taskId.slice(-6)}`
}

function sanitizeRunError(error: string | null): string | null {
  const compacted = compactString(error, 2_000)
  if (!compacted) return null
  return compacted
    .replace(/https?:\/\/\S+/gi, '[链接]')
    .replace(/(?:\/Users|\/home|\/private|\/var|\/tmp)\/[^\s，。；;]+/g, '[路径]')
    .replace(/[A-Za-z]:\\[^\s，。；;]+/g, '[路径]')
    .slice(0, 240)
}

function parseBatchIdentity(
  taskId: string,
  input: Record<string, unknown>,
): { batchId: string | null; batchIndex: number | null } {
  const explicitBatchId = compactString(input.batchId, 120)
  const explicitIndex = Number(input.batchIndex)
  if (explicitBatchId) {
    return {
      batchId: explicitBatchId,
      batchIndex: Number.isInteger(explicitIndex) && explicitIndex > 0 ? explicitIndex : null,
    }
  }
  const match = taskId.match(/^(.+):video:(\d+)(?::[a-f0-9]{12})?$/i)
  if (!match) return { batchId: null, batchIndex: null }
  return { batchId: match[1], batchIndex: Number(match[2]) }
}

export function projectN8nTaskRunListItem(
  run: N8nTaskRunListProjection,
): N8nTaskRunListItem {
  const workflowName = compactString(run.workflowName, 120)
    || compactString(run.routing.name, 120)
    || '未命名任务链'
  const taskType = compactString(run.bindingTaskType, 80)
    || compactString(run.routing.taskType, 80)
    || 'general'
  const displayName = safeDisplayName(
    run.input.displayName ?? run.input.videoName ?? run.input.fileName,
  )
  const batch = parseBatchIdentity(run.taskId, run.input)
  return {
    taskId: run.taskId,
    title: displayName || `${workflowName} · ${shortTaskId(run.taskId)}`,
    taskType,
    workflowName,
    status: run.status,
    source: run.source,
    attemptCount: run.attemptCount,
    maxAttempts: run.maxAttempts,
    createdAt: run.createdAt,
    acceptedAt: run.acceptedAt,
    startedAt: run.startedAt,
    processingStartedAt: run.processingStartedAt === undefined
      ? run.startedAt
      : run.processingStartedAt,
    completedAt: run.completedAt,
    updatedAt: run.updatedAt,
    error: sanitizeRunError(run.error),
    resultAvailable: run.resultAvailable,
    batchId: batch.batchId,
    batchIndex: batch.batchIndex,
  }
}

interface N8nVideoResultProjection extends N8nTaskRunListProjection {
  output: Record<string, unknown> | null
}

function videoResultSummary(output: Record<string, unknown> | null, maxLength: number): string | null {
  if (!output) return null
  return safeModelResultText(output.summary, maxLength)
    || safeModelResultText(output.combinedText, maxLength)
}

export function projectN8nVideoResultListItem(
  run: N8nVideoResultProjection,
): N8nVideoResultListItem {
  const base = projectN8nTaskRunListItem(run)
  return {
    taskId: base.taskId,
    title: base.title,
    status: base.status,
    source: base.source,
    createdAt: base.createdAt,
    completedAt: base.completedAt,
    updatedAt: base.updatedAt,
    batchId: base.batchId,
    batchIndex: base.batchIndex,
    summary: videoResultSummary(run.output, 320),
    chapterCount: arrayValue(run.output?.chapters).length,
    timelineCount: arrayValue(run.output?.timeline).length,
    resultAvailable: run.output !== null,
  }
}

export function projectN8nVideoResultDetail(
  run: N8nVideoResultProjection,
): N8nVideoResultDetail {
  const listItem = projectN8nVideoResultListItem(run)
  const output = objectValue(run.output)
  const audio = objectValue(output.audio)
  const vision = objectValue(output.vision)
  const chapters = arrayValue(output.chapters).slice(0, 64).map((value, offset) => {
    const chapter = objectValue(value)
    const summary = safeModelResultText(chapter.summary, 8_000)
    const index = Number(chapter.index)
    return {
      index: Number.isInteger(index) && index > 0 ? index : offset + 1,
      startTime: compactString(chapter.startTime, 32),
      endTime: compactString(chapter.endTime, 32),
      startSeconds: clockSeconds(compactString(chapter.startTime, 32) || ''),
      endSeconds: clockSeconds(compactString(chapter.endTime, 32) || ''),
      summary,
    }
  })
  const timeline = arrayValue(output.timeline).slice(0, 240).map((value, offset) => {
    const segment = objectValue(value)
    const timeRange = compactString(segment.timeRange, 64)
    const seconds = timeRangeSeconds(timeRange)
    const index = Number(segment.index)
    return {
      index: Number.isInteger(index) && index > 0 ? index : offset + 1,
      timeRange,
      ...seconds,
      transcript: safeMultilineText(segment.transcript, 4_000),
      visualAnalysis: safeMultilineText(segment.visualAnalysis, 6_000),
    }
  })
  return {
    ...listItem,
    summary: safeModelResultText(output.summary, 16_000)
      || safeModelResultText(output.combinedText, 16_000),
    chapters,
    timeline,
    transcript: safeMultilineText(audio.transcript, 100_000),
    visualAnalysis: safeMultilineText(vision.analysis, 100_000),
    fullReport: safeModelResultText(output.combinedText, 180_000)
      || safeModelResultText(output.summary, 180_000),
  }
}

function parseObject(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function rowToTaskRun(row: N8nTaskRunRow): N8nTaskRun {
  const delivery = n8nTaskDeliverySchema.safeParse(parseObject(row.delivery) || { mode: 'none' })
  return {
    id: row.id,
    taskId: row.task_id,
    idempotencyKey: row.idempotency_key,
    bindingId: row.binding_id,
    status: row.status,
    source: row.source,
    requestedBy: row.requested_by,
    routing: parseObject(row.routing) || {},
    input: parseObject(row.input) || {},
    delivery: delivery.success ? delivery.data : { mode: 'none' },
    output: parseObject(row.output),
    error: row.error,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  }
}

export function getN8nTaskRunByTaskId(
  db: Database.Database,
  taskId: string,
): N8nTaskRun | null {
  const row = db.prepare('SELECT * FROM n8n_task_runs WHERE task_id = ?')
    .get(taskId) as N8nTaskRunRow | undefined
  return row ? rowToTaskRun(row) : null
}

export function getScopedN8nTaskRunByTaskId(
  db: Database.Database,
  taskId: string,
  scope: N8nTaskScope,
): N8nTaskRun | null {
  const row = db.prepare(`
    SELECT * FROM n8n_task_runs
    WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
  `).get(taskId, scope.tenantId, scope.workspaceId) as N8nTaskRunRow | undefined
  return row ? rowToTaskRun(row) : null
}

export function getN8nTaskRunByIdempotencyKey(
  db: Database.Database,
  idempotencyKey: string,
  scope: N8nTaskScope,
): N8nTaskRun | null {
  const row = db.prepare(`
    SELECT * FROM n8n_task_runs
    WHERE idempotency_key = ? AND tenant_id = ? AND workspace_id = ?
  `).get(idempotencyKey, scope.tenantId, scope.workspaceId) as N8nTaskRunRow | undefined
  return row ? rowToTaskRun(row) : null
}

export function createN8nTaskRun(
  db: Database.Database,
  input: {
    taskId: string
    idempotencyKey: string
    bindingId: number
    source: string
    requestedBy: string
    routing: Record<string, unknown>
    taskInput: Record<string, unknown>
    delivery: N8nTaskDelivery
    maxAttempts: number
  },
  scope: N8nTaskScope,
): { run: N8nTaskRun; created: boolean } {
  const existing = getN8nTaskRunByIdempotencyKey(db, input.idempotencyKey, scope)
  if (existing) return { run: existing, created: false }

  try {
    db.prepare(`
      INSERT INTO n8n_task_runs (
        task_id, idempotency_key, binding_id, status, source, requested_by,
        routing, input, delivery, max_attempts, workspace_id, tenant_id
      ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.taskId,
      input.idempotencyKey,
      input.bindingId,
      input.source,
      input.requestedBy,
      JSON.stringify(input.routing),
      JSON.stringify(input.taskInput),
      JSON.stringify(input.delivery),
      Math.max(1, Math.min(11, Math.floor(input.maxAttempts))),
      scope.workspaceId,
      scope.tenantId,
    )
  } catch (error) {
    const raced = getN8nTaskRunByIdempotencyKey(db, input.idempotencyKey, scope)
    if (raced) return { run: raced, created: false }
    throw error
  }

  return { run: getN8nTaskRunByTaskId(db, input.taskId)!, created: true }
}

export function markN8nTaskAccepted(db: Database.Database, taskId: string): N8nTaskRun | null {
  db.prepare(`
    UPDATE n8n_task_runs
    SET status = 'accepted', accepted_at = COALESCE(accepted_at, unixepoch()),
        updated_at = unixepoch(), error = NULL
    WHERE task_id = ? AND status = 'queued'
  `).run(taskId)
  return getN8nTaskRunByTaskId(db, taskId)
}

export function claimN8nTaskRun(
  db: Database.Database,
  taskId: string,
): { run: N8nTaskRun | null; claimed: boolean } {
  const result = db.prepare(`
    UPDATE n8n_task_runs
    SET status = 'running', started_at = unixepoch(), completed_at = NULL,
        attempt_count = attempt_count + 1, updated_at = unixepoch(), error = NULL
    WHERE task_id = ?
      AND status IN ('queued', 'accepted', 'failed')
      AND attempt_count < max_attempts
  `).run(taskId)
  return { run: getN8nTaskRunByTaskId(db, taskId), claimed: result.changes === 1 }
}

export function completeN8nTaskRun(
  db: Database.Database,
  taskId: string,
  output: Record<string, unknown>,
): N8nTaskRun | null {
  db.prepare(`
    UPDATE n8n_task_runs
    SET status = 'succeeded', output = ?, error = NULL,
        completed_at = unixepoch(), updated_at = unixepoch()
    WHERE task_id = ? AND status = 'running'
  `).run(JSON.stringify(output), taskId)
  return getN8nTaskRunByTaskId(db, taskId)
}

export function failN8nTaskRun(
  db: Database.Database,
  taskId: string,
  error: string,
): N8nTaskRun | null {
  db.prepare(`
    UPDATE n8n_task_runs
    SET status = 'failed', error = ?, completed_at = unixepoch(), updated_at = unixepoch()
    WHERE task_id = ? AND status IN ('queued', 'accepted', 'running')
  `).run(error.slice(0, 2_000), taskId)
  return getN8nTaskRunByTaskId(db, taskId)
}

export function listN8nTaskRuns(
  db: Database.Database,
  scope: N8nTaskScope,
  limit = 50,
): N8nTaskRun[] {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)))
  const rows = db.prepare(`
    SELECT * FROM n8n_task_runs
    WHERE tenant_id = ? AND workspace_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT ?
  `).all(scope.tenantId, scope.workspaceId, safeLimit) as N8nTaskRunRow[]
  return rows.map(rowToTaskRun)
}

function mediaChildTaskId(taskId: string, stage: typeof MEDIA_STAGES[number]): string {
  const digest = createHash('sha256').update(`${taskId}:${stage}`).digest('hex').slice(0, 24)
  return `media-task:${taskId.slice(0, 70)}:${stage}:${digest}`.slice(0, 120)
}

function videoProcessingStartTimes(
  db: Database.Database,
  scope: N8nTaskScope,
  rows: N8nTaskRunSummaryRow[],
): Map<string, number | null> {
  const childToParent = new Map<string, string>()
  const processingStarts = new Map<string, number | null>()
  for (const row of rows) {
    const routing = parseObject(row.routing) || {}
    const isVideo = row.binding_task_type === 'video-analysis'
      || compactString(routing.taskType, 80) === 'video-analysis'
    if (!isVideo) continue
    processingStarts.set(row.task_id, null)
    for (const stage of MEDIA_STAGES) {
      childToParent.set(mediaChildTaskId(row.task_id, stage), row.task_id)
    }
  }
  const childIds = [...childToParent.keys()]
  if (!childIds.length) return processingStarts
  const chunkSize = 500
  for (let offset = 0; offset < childIds.length; offset += chunkSize) {
    const chunk = childIds.slice(offset, offset + chunkSize)
    const placeholders = chunk.map(() => '?').join(', ')
    const childRows = db.prepare(`
      SELECT task_id, started_at
      FROM n8n_task_runs
      WHERE tenant_id = ? AND workspace_id = ?
        AND task_id IN (${placeholders})
        AND started_at IS NOT NULL
    `).all(scope.tenantId, scope.workspaceId, ...chunk) as Array<{
      task_id: string
      started_at: number
    }>
    for (const child of childRows) {
      const parentId = childToParent.get(child.task_id)
      if (!parentId || !Number.isFinite(child.started_at)) continue
      const previous = processingStarts.get(parentId)
      if (previous === null || previous === undefined || child.started_at < previous) {
        processingStarts.set(parentId, child.started_at)
      }
    }
  }
  return processingStarts
}

function projectN8nTaskRunSummaryRows(
  db: Database.Database,
  scope: N8nTaskScope,
  rows: N8nTaskRunSummaryRow[],
): N8nTaskRunListItem[] {
  const processingStarts = videoProcessingStartTimes(db, scope, rows)
  return rows.map(row => projectN8nTaskRunListItem({
    taskId: row.task_id,
    status: row.status,
    source: row.source,
    routing: parseObject(row.routing) || {},
    input: parseObject(row.input) || {},
    error: row.error,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    processingStartedAt: processingStarts.has(row.task_id)
      ? processingStarts.get(row.task_id) || null
      : row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    workflowName: row.workflow_name,
    bindingTaskType: row.binding_task_type,
    resultAvailable: row.result_available === 1,
  }))
}

export function listN8nTaskRunSummaries(
  db: Database.Database,
  scope: N8nTaskScope,
  options: {
    limit?: number
    offset?: number
    status?: N8nTaskRunListStatus
    query?: string
  } = {},
): N8nTaskRunListResult {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 50)))
  const offset = Math.max(0, Math.min(100_000, Math.floor(options.offset || 0)))
  const where = [
    'r.tenant_id = ?',
    'r.workspace_id = ?',
    `r.source IN (${TOP_LEVEL_TASK_SOURCES.map(() => '?').join(', ')})`,
  ]
  const params: Array<string | number> = [
    scope.tenantId,
    scope.workspaceId,
    ...TOP_LEVEL_TASK_SOURCES,
  ]

  if (options.status) {
    where.push('r.status = ?')
    params.push(options.status)
  }

  const query = compactString(options.query, 120)?.toLowerCase()
  if (query) {
    const escaped = `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`
    where.push(`(
      lower(r.task_id) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(b.name, '')) LIKE ? ESCAPE '\\'
      OR lower(r.input) LIKE ? ESCAPE '\\'
    )`)
    params.push(escaped, escaped, escaped)
  }

  const whereSql = where.join('\n      AND ')
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM n8n_task_runs r
    LEFT JOIN n8n_workflow_bindings b
      ON b.id = r.binding_id
      AND b.tenant_id = r.tenant_id
      AND b.workspace_id = r.workspace_id
    WHERE ${whereSql}
  `).get(...params) as { total: number }

  const rows = db.prepare(`
    SELECT
      r.task_id,
      r.status,
      r.source,
      r.routing,
      r.input,
      r.error,
      r.attempt_count,
      r.max_attempts,
      r.created_at,
      r.accepted_at,
      r.started_at,
      r.completed_at,
      r.updated_at,
      b.name AS workflow_name,
      b.task_type AS binding_task_type,
      CASE WHEN r.output IS NULL THEN 0 ELSE 1 END AS result_available
    FROM n8n_task_runs r
    LEFT JOIN n8n_workflow_bindings b
      ON b.id = r.binding_id
      AND b.tenant_id = r.tenant_id
      AND b.workspace_id = r.workspace_id
    WHERE ${whereSql}
    ORDER BY r.updated_at DESC, r.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as N8nTaskRunSummaryRow[]

  return {
    runs: projectN8nTaskRunSummaryRows(db, scope, rows),
    total: totalRow.total,
    limit,
    offset,
  }
}

export function listN8nActiveTaskRunSummaries(
  db: Database.Database,
  scope: N8nTaskScope,
): N8nTaskRunListItem[] {
  const rows = db.prepare(`
    SELECT
      r.task_id,
      r.status,
      r.source,
      r.routing,
      r.input,
      r.error,
      r.attempt_count,
      r.max_attempts,
      r.created_at,
      r.accepted_at,
      r.started_at,
      r.completed_at,
      r.updated_at,
      b.name AS workflow_name,
      b.task_type AS binding_task_type,
      CASE WHEN r.output IS NULL THEN 0 ELSE 1 END AS result_available
    FROM n8n_task_runs r
    LEFT JOIN n8n_workflow_bindings b
      ON b.id = r.binding_id
      AND b.tenant_id = r.tenant_id
      AND b.workspace_id = r.workspace_id
    WHERE r.tenant_id = ?
      AND r.workspace_id = ?
      AND r.source IN (${TOP_LEVEL_TASK_SOURCES.map(() => '?').join(', ')})
      AND r.status IN ('queued', 'accepted', 'running')
    ORDER BY r.created_at ASC, r.id ASC
  `).all(
    scope.tenantId,
    scope.workspaceId,
    ...TOP_LEVEL_TASK_SOURCES,
  ) as N8nTaskRunSummaryRow[]
  return projectN8nTaskRunSummaryRows(db, scope, rows)
}

export function listScopedN8nTaskRunStatusSummaries(
  db: Database.Database,
  scope: N8nTaskScope,
  taskIds: readonly string[],
): N8nTaskRunListItem[] {
  const orderedTaskIds = [...new Set(taskIds
    .map(taskId => n8nTaskIdentitySchema.safeParse(taskId))
    .flatMap(result => result.success ? [result.data] : []))]
  if (!orderedTaskIds.length) return []

  const rows: N8nTaskRunSummaryRow[] = []
  for (let offset = 0; offset < orderedTaskIds.length; offset += TASK_STATUS_QUERY_CHUNK_SIZE) {
    const chunk = orderedTaskIds.slice(offset, offset + TASK_STATUS_QUERY_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(', ')
    rows.push(...db.prepare(`
      SELECT
        r.task_id,
        r.status,
        r.source,
        r.routing,
        r.input,
        r.error,
        r.attempt_count,
        r.max_attempts,
        r.created_at,
        r.accepted_at,
        r.started_at,
        r.completed_at,
        r.updated_at,
        b.name AS workflow_name,
        b.task_type AS binding_task_type,
        CASE WHEN r.output IS NULL THEN 0 ELSE 1 END AS result_available
      FROM n8n_task_runs r
      LEFT JOIN n8n_workflow_bindings b
        ON b.id = r.binding_id
        AND b.tenant_id = r.tenant_id
        AND b.workspace_id = r.workspace_id
      WHERE r.tenant_id = ?
        AND r.workspace_id = ?
        AND r.source IN (${TOP_LEVEL_TASK_SOURCES.map(() => '?').join(', ')})
        AND r.task_id IN (${placeholders})
    `).all(
      scope.tenantId,
      scope.workspaceId,
      ...TOP_LEVEL_TASK_SOURCES,
      ...chunk,
    ) as N8nTaskRunSummaryRow[])
  }

  const byTaskId = new Map(
    projectN8nTaskRunSummaryRows(db, scope, rows).map(run => [run.taskId, run]),
  )
  return orderedTaskIds
    .map(taskId => byTaskId.get(taskId))
    .filter((run): run is N8nTaskRunListItem => Boolean(run))
}

function videoResultWhere(
  scope: N8nTaskScope,
  options: { status?: N8nTaskRunListStatus; query?: string } = {},
) {
  const where = [
    'r.tenant_id = ?',
    'r.workspace_id = ?',
    `r.source IN (${TOP_LEVEL_TASK_SOURCES.map(() => '?').join(', ')})`,
    `(b.task_type = 'video-analysis' OR (
      json_valid(r.routing) = 1
      AND json_extract(r.routing, '$.taskType') = 'video-analysis'
    ))`,
  ]
  const params: Array<string | number> = [
    scope.tenantId,
    scope.workspaceId,
    ...TOP_LEVEL_TASK_SOURCES,
  ]
  if (options.status) {
    where.push('r.status = ?')
    params.push(options.status)
  }
  const query = compactString(options.query, 120)?.toLowerCase()
  if (query) {
    const escaped = `%${query.replace(/[\\%_]/g, value => `\\${value}`)}%`
    where.push(`(
      lower(r.task_id) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(b.name, '')) LIKE ? ESCAPE '\\'
      OR lower(r.input) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(r.output, '')) LIKE ? ESCAPE '\\'
    )`)
    params.push(escaped, escaped, escaped, escaped)
  }
  return { whereSql: where.join('\n      AND '), params }
}

function projectVideoResultRow(row: N8nVideoResultRow): N8nVideoResultProjection {
  const run = rowToTaskRun(row)
  return {
    taskId: run.taskId,
    status: run.status,
    source: run.source,
    routing: run.routing,
    input: run.input,
    output: run.output,
    error: run.error,
    attemptCount: run.attemptCount,
    maxAttempts: run.maxAttempts,
    createdAt: run.createdAt,
    acceptedAt: run.acceptedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    updatedAt: run.updatedAt,
    workflowName: row.workflow_name,
    bindingTaskType: row.binding_task_type,
    resultAvailable: run.output !== null,
  }
}

function projectVideoResultListRow(row: N8nVideoResultListRow): N8nVideoResultListItem {
  const base = projectN8nTaskRunListItem({
    taskId: row.task_id,
    status: row.status,
    source: row.source,
    routing: parseObject(row.routing) || {},
    input: parseObject(row.input) || {},
    error: row.error,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
    workflowName: row.workflow_name,
    bindingTaskType: row.binding_task_type,
    resultAvailable: row.result_available === 1,
  })
  return {
    taskId: base.taskId,
    title: base.title,
    status: base.status,
    source: base.source,
    createdAt: base.createdAt,
    completedAt: base.completedAt,
    updatedAt: base.updatedAt,
    batchId: base.batchId,
    batchIndex: base.batchIndex,
    summary: safeModelResultText(row.result_summary, 320),
    chapterCount: Math.max(0, Number(row.chapter_count) || 0),
    timelineCount: Math.max(0, Number(row.timeline_count) || 0),
    resultAvailable: base.resultAvailable,
  }
}

export function listN8nVideoResults(
  db: Database.Database,
  scope: N8nTaskScope,
  options: {
    limit?: number
    offset?: number
    status?: N8nTaskRunListStatus
    query?: string
  } = {},
): N8nVideoResultListResult {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit || 25)))
  const offset = Math.max(0, Math.min(100_000, Math.floor(options.offset || 0)))
  const { whereSql, params } = videoResultWhere(scope, options)
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM n8n_task_runs r
    LEFT JOIN n8n_workflow_bindings b
      ON b.id = r.binding_id
      AND b.tenant_id = r.tenant_id
      AND b.workspace_id = r.workspace_id
    WHERE ${whereSql}
  `).get(...params) as { total: number }
  const rows = db.prepare(`
    SELECT
      r.task_id,
      r.status,
      r.source,
      r.routing,
      r.input,
      r.error,
      r.attempt_count,
      r.max_attempts,
      r.created_at,
      r.accepted_at,
      r.started_at,
      r.completed_at,
      r.updated_at,
      b.name AS workflow_name,
      b.task_type AS binding_task_type,
      CASE WHEN r.output IS NULL THEN 0 ELSE 1 END AS result_available,
      CASE
        WHEN json_valid(r.output) = 1 AND json_type(r.output, '$.summary') = 'text'
          THEN substr(json_extract(r.output, '$.summary'), 1, 320)
        WHEN json_valid(r.output) = 1 AND json_type(r.output, '$.combinedText') = 'text'
          THEN substr(json_extract(r.output, '$.combinedText'), 1, 320)
        ELSE NULL
      END AS result_summary,
      CASE
        WHEN json_valid(r.output) = 1 AND json_type(r.output, '$.chapters') = 'array'
          THEN json_array_length(r.output, '$.chapters')
        ELSE 0
      END AS chapter_count,
      CASE
        WHEN json_valid(r.output) = 1 AND json_type(r.output, '$.timeline') = 'array'
          THEN json_array_length(r.output, '$.timeline')
        ELSE 0
      END AS timeline_count
    FROM n8n_task_runs r
    LEFT JOIN n8n_workflow_bindings b
      ON b.id = r.binding_id
      AND b.tenant_id = r.tenant_id
      AND b.workspace_id = r.workspace_id
    WHERE ${whereSql}
    ORDER BY COALESCE(r.completed_at, r.updated_at) DESC, r.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as N8nVideoResultListRow[]
  return {
    results: rows.map(projectVideoResultListRow),
    total: totalRow.total,
    limit,
    offset,
  }
}

export function getN8nVideoResultDetail(
  db: Database.Database,
  taskId: string,
  scope: N8nTaskScope,
): N8nVideoResultDetail | null {
  const { whereSql, params } = videoResultWhere(scope)
  const row = db.prepare(`
    SELECT r.*, b.name AS workflow_name, b.task_type AS binding_task_type
    FROM n8n_task_runs r
    LEFT JOIN n8n_workflow_bindings b
      ON b.id = r.binding_id
      AND b.tenant_id = r.tenant_id
      AND b.workspace_id = r.workspace_id
    WHERE ${whereSql} AND r.task_id = ?
    LIMIT 1
  `).get(...params, taskId) as N8nVideoResultRow | undefined
  return row ? projectN8nVideoResultDetail(projectVideoResultRow(row)) : null
}

function normalizedSearchTerms(value: string): string[] {
  const compacted = compactString(value, 120)
  if (!compacted) return []
  return [...new Set(compacted
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8))]
}

function normalizedSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('zh-CN')
}

function matchesSearchTerms(value: string, terms: string[]): boolean {
  const normalized = normalizedSearchText(value)
  return terms.every(term => normalized.includes(term))
}

function searchSnippet(values: Array<string | null>, terms: string[], maxLength = 300): string {
  const candidates = values
    .map(value => safeMultilineText(value, 180_000)?.replace(/\s+/g, ' ').trim() || '')
    .filter(Boolean)
  const matched = candidates.find(value => matchesSearchTerms(value, terms)) || candidates[0] || ''
  if (!matched) return ''
  const normalized = normalizedSearchText(matched)
  const positions = terms.map(term => normalized.indexOf(term)).filter(position => position >= 0)
  const first = positions.length ? Math.min(...positions) : 0
  const start = Math.max(0, first - Math.floor(maxLength * 0.28))
  const end = Math.min(matched.length, start + maxLength)
  return `${start > 0 ? '…' : ''}${matched.slice(start, end)}${end < matched.length ? '…' : ''}`
}

function buildVideoSearchHits(detail: N8nVideoResultDetail, terms: string[]): N8nVideoSearchHit[] {
  const hits: N8nVideoSearchHit[] = []
  const push = (
    kind: N8nVideoSearchHitKind,
    label: string,
    values: Array<{ field: string; text: string | null }>,
    timing: { timeRange?: string | null; startSeconds?: number | null; endSeconds?: number | null } = {},
    score = 40,
    suffix: string = kind,
  ) => {
    const combined = values.map(value => value.text || '').join('\n')
    if (!combined || !matchesSearchTerms(combined, terms)) return false
    const matchedFields = values
      .filter(value => value.text && terms.some(term => normalizedSearchText(value.text!).includes(term)))
      .map(value => value.field)
    hits.push({
      id: `${detail.taskId}:${suffix}`,
      taskId: detail.taskId,
      title: detail.title,
      status: detail.status,
      completedAt: detail.completedAt,
      kind,
      label,
      snippet: searchSnippet(values.map(value => value.text), terms),
      matchedFields,
      timeRange: timing.timeRange || null,
      startSeconds: timing.startSeconds ?? null,
      endSeconds: timing.endSeconds ?? null,
      score: score + matchedFields.length * 2,
    })
    return true
  }

  push('title', '视频标题', [{ field: '标题', text: detail.title }], {}, 72, 'title')
  push('summary', '成片摘要', [{ field: '摘要', text: detail.summary }], {}, 66, 'summary')
  for (const chapter of detail.chapters) {
    push('chapter', `第 ${chapter.index} 章`, [{ field: '章节', text: chapter.summary }], {
      timeRange: chapter.startTime && chapter.endTime ? `${chapter.startTime}-${chapter.endTime}` : null,
      startSeconds: chapter.startSeconds,
      endSeconds: chapter.endSeconds,
    }, 82, `chapter:${chapter.index}`)
  }
  let transcriptSegmentMatched = false
  let visualSegmentMatched = false
  for (const segment of detail.timeline) {
    const transcriptMatches = Boolean(segment.transcript && matchesSearchTerms(segment.transcript, terms))
    const visualMatches = Boolean(segment.visualAnalysis && matchesSearchTerms(segment.visualAnalysis, terms))
    if (!transcriptMatches && !visualMatches) continue
    transcriptSegmentMatched ||= transcriptMatches
    visualSegmentMatched ||= visualMatches
    push('timeline', segment.timeRange || `片段 ${segment.index}`, [
      { field: '语音', text: segment.transcript },
      { field: '画面', text: segment.visualAnalysis },
    ], {
      timeRange: segment.timeRange,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
    }, 100, `timeline:${segment.index}`)
  }
  if (!transcriptSegmentMatched) {
    push('transcript', '成片语音转写', [{ field: '语音', text: detail.transcript }], {}, 58, 'transcript')
  }
  if (!visualSegmentMatched) {
    push('visual', '成片画面分析', [{ field: '画面', text: detail.visualAnalysis }], {}, 58, 'visual')
  }
  if (!hits.some(hit => !['title'].includes(hit.kind))) {
    push('report', '完整分析报告', [{ field: '报告', text: detail.fullReport }], {}, 48, 'report')
  }
  return hits
}

export function searchN8nVideoResults(
  db: Database.Database,
  scope: N8nTaskScope,
  rawQuery: string,
  requestedLimit = 80,
): N8nVideoSearchResult {
  const query = compactString(rawQuery, 120) || ''
  const terms = normalizedSearchTerms(query)
  const limit = Math.max(1, Math.min(200, Math.floor(requestedLimit || 80)))
  if (!terms.length) {
    return { query, hits: [], total: 0, videoCount: 0, segmentCount: 0, limit, truncated: false }
  }

  const { whereSql, params } = videoResultWhere(scope, { status: 'succeeded' })
  const searchWhere: string[] = []
  for (const term of terms) {
    const escaped = `%${term.replace(/[\\%_]/g, value => `\\${value}`)}%`
    searchWhere.push(`(
      lower(r.task_id) LIKE ? ESCAPE '\\'
      OR lower(r.input) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(r.output, '')) LIKE ? ESCAPE '\\'
    )`)
    params.push(escaped, escaped, escaped)
  }
  const candidateLimit = 200
  const rows = db.prepare(`
    SELECT r.*, b.name AS workflow_name, b.task_type AS binding_task_type
    FROM n8n_task_runs r
    LEFT JOIN n8n_workflow_bindings b
      ON b.id = r.binding_id
      AND b.tenant_id = r.tenant_id
      AND b.workspace_id = r.workspace_id
    WHERE ${whereSql}
      AND ${searchWhere.join('\n      AND ')}
    ORDER BY COALESCE(r.completed_at, r.updated_at) DESC, r.id DESC
    LIMIT ?
  `).all(...params, candidateLimit) as N8nVideoResultRow[]

  const allHits = rows.flatMap(row => buildVideoSearchHits(
    projectN8nVideoResultDetail(projectVideoResultRow(row)),
    terms,
  )).sort((left, right) => (
    right.score - left.score
    || (right.completedAt || 0) - (left.completedAt || 0)
    || (left.startSeconds || 0) - (right.startSeconds || 0)
  ))
  const videoCount = new Set(allHits.map(hit => hit.taskId)).size
  const segmentCount = allHits.filter(hit => hit.startSeconds !== null).length
  return {
    query,
    hits: allHits.slice(0, limit),
    total: allHits.length,
    videoCount,
    segmentCount,
    limit,
    truncated: allHits.length > limit || rows.length >= candidateLimit,
  }
}
