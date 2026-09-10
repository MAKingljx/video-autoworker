import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { enqueueDirectorEvidenceOutbox } from '@/lib/director-evidence-outbox'

export const n8nTaskIdentitySchema = z.string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/, '任务标识只能包含字母、数字、点、下划线、冒号和连字符')

export const n8nExecutionOwnerSchema = z.string()
  .trim()
  .min(15)
  .max(120)
  .regex(/^n8n-execution:[A-Za-z0-9._:-]{1,100}$/u, 'n8n execution owner 格式无效')

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

export const N8N_VIDEO_CALLBACK_LEASE_SECONDS = 15 * 60
export const N8N_VIDEO_CALLBACK_LEASE_EXPIRED = 'VIDEO_CALLBACK_LEASE_EXPIRED'
export const N8N_VIDEO_FINALIZE_LEASE_SECONDS = 24 * 60 * 60
export const N8N_VIDEO_FINALIZE_LEASE_EXPIRED = 'VIDEO_FINALIZE_LEASE_EXPIRED'
export const N8N_CHILD_EXECUTION_LEASE_SECONDS = 15 * 60
export const N8N_CHILD_EXECUTION_HEARTBEAT_SECONDS = 60

export type N8nVideoTaskClaimOutcome = 'claimed' | 'running' | 'terminal' | 'rejected' | 'not_found'
export type N8nParentTaskClaimOutcome = 'claimed' | 'owned' | 'running' | 'terminal' | 'rejected' | 'not_found'
export type N8nVideoTaskReconcileOutcome = 'reconciled' | 'active' | 'terminal' | 'ineligible' | 'not_found'
export type N8nMediaChildCreateOutcome = 'created' | 'existing' | 'terminal' | 'rejected' | 'not_found'
export type N8nFinalizeOutcome = 'completed' | 'cached' | 'terminal' | 'rejected' | 'not_found'
export type N8nMediaCleanupReason = 'finalize_succeeded' | 'finalize_lease_expired'
export type N8nChildExecutionOutcome =
  | 'claimed'
  | 'running'
  | 'succeeded'
  | 'terminal'
  | 'exhausted'
  | 'rejected'
  | 'not_found'

export interface N8nChildExecutionLease {
  taskId: string
  ownerInstanceId: string
  leaseToken: string
  leaseExpiresAt: number
  revision: number
}

export type N8nChildExecutionResult = {
  outcome: N8nChildExecutionOutcome
  parent: N8nTaskRun | null
  child: N8nTaskRun | null
  lease: N8nChildExecutionLease | null
}

export type N8nChildParentMode = 'running_execution' | 'succeeded_postprocess'

export interface N8nChildRunInput {
  parentTaskId: string
  parentIdempotencyKey: string
  bindingId: number
  childTaskId: string
  childIdempotencyKey: string
  source: 'n8n-node' | 'n8n-media-node'
  routing: Record<string, unknown>
  taskInput: Record<string, unknown>
  delivery: N8nTaskDelivery
  maxAttempts: number
  parentMode?: N8nChildParentMode
}

/**
 * Keep one callback request open while another request owns the child. This
 * turns an n8n HTTP retry into a durable poll: only a cached success or a newly
 * acquired lease returns to the execution path; a still-running result remains
 * non-2xx after the bounded wait.
 */
export async function pollN8nChildExecutionResult(
  attempt: () => N8nChildExecutionResult,
  initial: N8nChildExecutionResult,
  options: { waitSeconds: number; pollMilliseconds?: number },
): Promise<N8nChildExecutionResult> {
  if (!Number.isSafeInteger(options.waitSeconds) || options.waitSeconds < 1 || options.waitSeconds > 4 * 60 * 60) {
    throw new TypeError('n8n 子任务轮询时长无效')
  }
  const pollMilliseconds = options.pollMilliseconds ?? 1_000
  if (!Number.isSafeInteger(pollMilliseconds) || pollMilliseconds < 10 || pollMilliseconds > 10_000) {
    throw new TypeError('n8n 子任务轮询周期无效')
  }
  const deadline = Date.now() + options.waitSeconds * 1_000
  let current = initial
  while (current.outcome === 'running') {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMilliseconds, remaining)))
    current = attempt()
  }
  return current
}

export class N8nChildExecutionLeaseLostError extends Error {
  constructor() {
    super('n8n 子任务执行租约已失效')
    this.name = 'N8nChildExecutionLeaseLostError'
  }
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

interface N8nChildExecutionLeaseRow {
  owner_instance_id: string
  lease_token: string
  lease_expires_at: number
  revision: number
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

/**
 * Claim the parent of the canonical video-analysis workflow.
 *
 * This is intentionally scoped and compare-and-swap based: an authenticated
 * n8n callback may race another delivery, but it must never claim a task from
 * another workspace, revive a terminal task, or attach itself to a different
 * binding/idempotency identity.
 */
export function claimScopedN8nVideoTaskRun(
  db: Database.Database,
  input: { taskId: string; idempotencyKey: string; bindingId: number },
  scope: N8nTaskScope,
): { outcome: N8nVideoTaskClaimOutcome; run: N8nTaskRun | null } {
  const result = db.prepare(`
    UPDATE n8n_task_runs
    SET status = 'running',
        accepted_at = COALESCE(accepted_at, unixepoch()),
        started_at = COALESCE(started_at, unixepoch()),
        completed_at = NULL,
        attempt_count = attempt_count + 1,
        updated_at = unixepoch(),
        error = NULL
    WHERE task_id = ?
      AND idempotency_key = ?
      AND binding_id = ?
      AND tenant_id = ?
      AND workspace_id = ?
      AND status IN ('queued', 'accepted')
      AND attempt_count < max_attempts
      AND EXISTS (
        SELECT 1
        FROM n8n_workflow_bindings binding
        WHERE binding.id = n8n_task_runs.binding_id
          AND binding.tenant_id = n8n_task_runs.tenant_id
          AND binding.workspace_id = n8n_task_runs.workspace_id
          AND binding.task_type = 'video-analysis'
      )
  `).run(
    input.taskId,
    input.idempotencyKey,
    input.bindingId,
    scope.tenantId,
    scope.workspaceId,
  )

  const run = getScopedN8nTaskRunByTaskId(db, input.taskId, scope)
  if (result.changes === 1) return { outcome: 'claimed', run }
  if (!run) return { outcome: 'not_found', run: null }
  if (run.idempotencyKey !== input.idempotencyKey || run.bindingId !== input.bindingId) {
    return { outcome: 'rejected', run }
  }
  const videoBinding = db.prepare(`
    SELECT 1
    FROM n8n_workflow_bindings
    WHERE id = ? AND tenant_id = ? AND workspace_id = ? AND task_type = 'video-analysis'
  `).get(run.bindingId, scope.tenantId, scope.workspaceId)
  if (!videoBinding) return { outcome: 'rejected', run }
  if (run.status === 'running') return { outcome: 'running', run }
  if (['succeeded', 'failed', 'cancelled'].includes(run.status)) return { outcome: 'terminal', run }
  return { outcome: 'rejected', run }
}

/** Claim any registered top-level n8n run and retire its outbound dispatch lease atomically. */
export function claimScopedN8nTaskRun(
  db: Database.Database,
  input: { taskId: string; idempotencyKey: string; bindingId: number; executionOwner: string },
  scope: N8nTaskScope,
): { outcome: N8nParentTaskClaimOutcome; run: N8nTaskRun | null } {
  const executionOwner = n8nExecutionOwnerSchema.parse(input.executionOwner)
  const claim = db.transaction((): { outcome: N8nParentTaskClaimOutcome; run: N8nTaskRun | null } => {
    const run = getScopedN8nTaskRunByTaskId(db, input.taskId, scope)
    if (!run) return { outcome: 'not_found', run: null }
    if (run.idempotencyKey !== input.idempotencyKey || run.bindingId !== input.bindingId
      || !TOP_LEVEL_TASK_SOURCES.includes(run.source as typeof TOP_LEVEL_TASK_SOURCES[number])) {
      return { outcome: 'rejected', run }
    }
    const binding = db.prepare(`
      SELECT 1 FROM n8n_workflow_bindings
      WHERE id = ? AND tenant_id = ? AND workspace_id = ?
    `).get(run.bindingId, scope.tenantId, scope.workspaceId)
    if (!binding) return { outcome: 'rejected', run }
    if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      return { outcome: 'terminal', run }
    }
    const ownership = db.prepare(`
      SELECT execution_owner
      FROM n8n_parent_execution_claims
      WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
    `).get(input.taskId, scope.tenantId, scope.workspaceId) as { execution_owner: string } | undefined
    if (run.status === 'running') {
      if (!ownership) return { outcome: 'rejected', run }
      return { outcome: ownership.execution_owner === executionOwner ? 'owned' : 'running', run }
    }
    if (!['queued', 'accepted'].includes(run.status) || ownership) {
      return { outcome: 'rejected', run }
    }

    const result = db.prepare(`
      UPDATE n8n_task_runs
      SET status = 'running',
          accepted_at = COALESCE(accepted_at, unixepoch()),
          started_at = COALESCE(started_at, unixepoch()),
          completed_at = NULL,
          attempt_count = attempt_count + 1,
          updated_at = unixepoch(),
          error = NULL
      WHERE task_id = ?
        AND idempotency_key = ?
        AND binding_id = ?
        AND tenant_id = ?
        AND workspace_id = ?
        AND source IN ('video-autoworker', 'openclaw')
        AND status IN ('queued', 'accepted')
        AND attempt_count < max_attempts
        AND EXISTS (
          SELECT 1 FROM n8n_workflow_bindings binding
          WHERE binding.id = n8n_task_runs.binding_id
            AND binding.tenant_id = n8n_task_runs.tenant_id
            AND binding.workspace_id = n8n_task_runs.workspace_id
        )
    `).run(
      input.taskId,
      input.idempotencyKey,
      input.bindingId,
      scope.tenantId,
      scope.workspaceId,
    )
    if (result.changes !== 1) return { outcome: 'rejected', run }
    db.prepare(`
      INSERT INTO n8n_parent_execution_claims (
        task_id, tenant_id, workspace_id, execution_owner, created_at, updated_at
      ) VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
    `).run(input.taskId, scope.tenantId, scope.workspaceId, executionOwner)
    db.prepare(`
      DELETE FROM n8n_task_dispatch_leases
      WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
    `).run(input.taskId, scope.tenantId, scope.workspaceId)
    return {
      outcome: 'claimed',
      run: getScopedN8nTaskRunByTaskId(db, input.taskId, scope),
    }
  })
  return claim.immediate()
}

export function isScopedN8nParentExecutionOwner(
  db: Database.Database,
  taskId: string,
  executionOwner: string,
  scope: N8nTaskScope,
): boolean {
  const owner = n8nExecutionOwnerSchema.parse(executionOwner)
  const row = db.prepare(`
    SELECT 1
    FROM n8n_parent_execution_claims claim
    JOIN n8n_task_runs run ON run.task_id = claim.task_id
    WHERE claim.task_id = ?
      AND claim.tenant_id = ? AND claim.workspace_id = ?
      AND claim.execution_owner = ?
      AND run.tenant_id = claim.tenant_id
      AND run.workspace_id = claim.workspace_id
      AND run.source IN ('video-autoworker', 'openclaw')
  `).get(taskId, scope.tenantId, scope.workspaceId, owner)
  return Boolean(row)
}

function assertChildLeaseIdentity(ownerInstanceId: string, leaseToken?: string): void {
  if (!/^[0-9a-f]{64}$/u.test(ownerInstanceId)
    || (leaseToken !== undefined && !/^[0-9a-f]{64}$/u.test(leaseToken))) {
    throw new TypeError('n8n 子任务执行租约身份无效')
  }
}

function childLeaseClock(nowSeconds?: number): number {
  const now = nowSeconds ?? Math.floor(Date.now() / 1_000)
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('n8n 子任务执行租约时钟无效')
  return now
}

function childLeaseFromRow(taskId: string, row: N8nChildExecutionLeaseRow): N8nChildExecutionLease {
  return {
    taskId,
    ownerInstanceId: row.owner_instance_id,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    revision: row.revision,
  }
}

function validChildParent(
  db: Database.Database,
  parent: N8nTaskRun,
  input: N8nChildRunInput & { executionOwner?: string },
  scope: N8nTaskScope,
): boolean {
  const mode = input.parentMode ?? 'running_execution'
  if (mode === 'succeeded_postprocess') return parent.status === 'succeeded'
  if (parent.status !== 'running' || !input.executionOwner) return false
  return isScopedN8nParentExecutionOwner(db, parent.taskId, input.executionOwner, scope)
}

/**
 * Persist a deterministic queued child without acquiring an execution lease.
 * This is the registration primitive for post-processing an already-successful
 * parent; execution ownership is acquired only when a worker is ready to run.
 */
export function ensureN8nChildRunFromParent(
  db: Database.Database,
  input: N8nChildRunInput & { executionOwner?: string },
  scope: N8nTaskScope,
  options: { nowSeconds?: number } = {},
): { outcome: 'created' | 'existing' | 'terminal' | 'rejected' | 'not_found'; parent: N8nTaskRun | null; child: N8nTaskRun | null } {
  const now = childLeaseClock(options.nowSeconds)
  if (input.parentMode !== 'succeeded_postprocess') {
    if (!input.executionOwner) throw new TypeError('n8n 父执行身份无效')
    n8nExecutionOwnerSchema.parse(input.executionOwner)
  }
  return db.transaction(() => {
    const parent = getScopedN8nTaskRunByTaskId(db, input.parentTaskId, scope)
    if (!parent) return { outcome: 'not_found' as const, parent: null, child: null }
    if (parent.idempotencyKey !== input.parentIdempotencyKey
      || parent.bindingId !== input.bindingId
      || !validChildParent(db, parent, input, scope)) {
      const terminal = ['succeeded', 'failed', 'cancelled'].includes(parent.status)
        && input.parentMode !== 'succeeded_postprocess'
      return { outcome: terminal ? 'terminal' as const : 'rejected' as const, parent, child: null }
    }
    let child = getScopedN8nTaskRunByTaskId(db, input.childTaskId, scope)
    if (child) {
      const valid = child.idempotencyKey === input.childIdempotencyKey
        && child.bindingId === input.bindingId && child.source === input.source
      return { outcome: valid ? 'existing' as const : 'rejected' as const, parent, child }
    }
    const idempotent = getN8nTaskRunByIdempotencyKey(db, input.childIdempotencyKey, scope)
    if (idempotent) return { outcome: 'rejected' as const, parent, child: idempotent }
    db.prepare(`
      INSERT INTO n8n_task_runs (
        task_id, idempotency_key, binding_id, status, source, requested_by,
        routing, input, delivery, attempt_count, max_attempts,
        workspace_id, tenant_id, accepted_at, updated_at
      ) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(
      input.childTaskId, input.childIdempotencyKey, input.bindingId, input.source,
      parent.requestedBy, JSON.stringify(input.routing), JSON.stringify(input.taskInput),
      JSON.stringify(input.delivery), Math.max(1, Math.min(11, Math.floor(input.maxAttempts))),
      scope.workspaceId, scope.tenantId, now, now,
    )
    child = getScopedN8nTaskRunByTaskId(db, input.childTaskId, scope)
    return { outcome: 'created' as const, parent, child }
  }).immediate()
}

/**
 * Create and claim a deterministic n8n child in one IMMEDIATE transaction.
 * A different process instance may fence a running owner only after the
 * durable lease expires. Same-instance duplicates can never self-takeover,
 * even after expiry.
 */
export function createAndClaimN8nChildRunFromParent(
  db: Database.Database,
  input: N8nChildRunInput & {
    ownerInstanceId: string
    executionOwner?: string
  },
  scope: N8nTaskScope,
  options: {
    nowSeconds?: number
    leaseSeconds?: number
    leaseToken?: string
    initialLeaseRevision?: number
  } = {},
): N8nChildExecutionResult {
  assertChildLeaseIdentity(input.ownerInstanceId, options.leaseToken)
  if (input.parentMode !== 'succeeded_postprocess') {
    if (!input.executionOwner) throw new TypeError('n8n 父执行身份无效')
    n8nExecutionOwnerSchema.parse(input.executionOwner)
  }
  const now = childLeaseClock(options.nowSeconds)
  const leaseSeconds = options.leaseSeconds ?? N8N_CHILD_EXECUTION_LEASE_SECONDS
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 60 * 60) {
    throw new TypeError('n8n 子任务执行租约时长无效')
  }
  const token = options.leaseToken ?? randomBytes(32).toString('hex')
  const leaseExpiresAt = now + leaseSeconds
  const initialLeaseRevision = options.initialLeaseRevision ?? 1
  if (!Number.isSafeInteger(initialLeaseRevision) || initialLeaseRevision < 1) {
    throw new TypeError('n8n 子任务执行租约版本无效')
  }

  const execute = db.transaction((): N8nChildExecutionResult => {
    const parent = getScopedN8nTaskRunByTaskId(db, input.parentTaskId, scope)
    if (!parent) return { outcome: 'not_found', parent: null, child: null, lease: null }
    if (parent.idempotencyKey !== input.parentIdempotencyKey
      || parent.bindingId !== input.bindingId
      || !validChildParent(db, parent, input, scope)) {
      const outcome = ['succeeded', 'failed', 'cancelled'].includes(parent.status) ? 'terminal' : 'rejected'
      return { outcome, parent, child: null, lease: null }
    }

    let child = getScopedN8nTaskRunByTaskId(db, input.childTaskId, scope)
    if (!child) {
      const idempotent = getN8nTaskRunByIdempotencyKey(db, input.childIdempotencyKey, scope)
      if (idempotent) return { outcome: 'rejected', parent, child: idempotent, lease: null }
      db.prepare(`
        INSERT INTO n8n_task_runs (
          task_id, idempotency_key, binding_id, status, source, requested_by,
          routing, input, delivery, attempt_count, max_attempts,
          workspace_id, tenant_id, accepted_at, started_at, updated_at
        ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      `).run(
        input.childTaskId,
        input.childIdempotencyKey,
        input.bindingId,
        input.source,
        parent.requestedBy,
        JSON.stringify(input.routing),
        JSON.stringify(input.taskInput),
        JSON.stringify(input.delivery),
        Math.max(1, Math.min(11, Math.floor(input.maxAttempts))),
        scope.workspaceId,
        scope.tenantId,
        now,
        now,
        now,
      )
      db.prepare(`
        INSERT INTO n8n_child_execution_leases (
          task_id, tenant_id, workspace_id, owner_instance_id, lease_token,
          lease_expires_at, heartbeat_at, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.childTaskId, scope.tenantId, scope.workspaceId,
        input.ownerInstanceId, token, leaseExpiresAt, now, initialLeaseRevision, now, now,
      )
      child = getScopedN8nTaskRunByTaskId(db, input.childTaskId, scope)!
      return {
        outcome: 'claimed', parent, child,
        lease: { taskId: child.taskId, ownerInstanceId: input.ownerInstanceId, leaseToken: token, leaseExpiresAt, revision: initialLeaseRevision },
      }
    }

    if (child.idempotencyKey !== input.childIdempotencyKey
      || child.bindingId !== input.bindingId
      || child.source !== input.source) {
      return { outcome: 'rejected', parent, child, lease: null }
    }
    if (child.status === 'succeeded') return { outcome: 'succeeded', parent, child, lease: null }
    if (child.status === 'cancelled') return { outcome: 'terminal', parent, child, lease: null }
    if (child.attemptCount >= child.maxAttempts && child.status !== 'running') {
      return { outcome: 'exhausted', parent, child, lease: null }
    }

    const current = db.prepare(`
      SELECT owner_instance_id, lease_token, lease_expires_at, revision
      FROM n8n_child_execution_leases
      WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
    `).get(child.taskId, scope.tenantId, scope.workspaceId) as N8nChildExecutionLeaseRow | undefined

    if (child.status === 'queued') {
      if (current) return { outcome: 'rejected', parent, child, lease: null }
      const claimed = db.prepare(`
        UPDATE n8n_task_runs
        SET status = 'running', attempt_count = attempt_count + 1,
            started_at = ?, completed_at = NULL, error = NULL, updated_at = ?
        WHERE task_id = ? AND tenant_id = ? AND workspace_id = ? AND status = 'queued'
      `).run(now, now, child.taskId, scope.tenantId, scope.workspaceId)
      if (claimed.changes !== 1) return { outcome: 'running', parent, child, lease: null }
      db.prepare(`
        INSERT INTO n8n_child_execution_leases (
          task_id, tenant_id, workspace_id, owner_instance_id, lease_token,
          lease_expires_at, heartbeat_at, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        child.taskId, scope.tenantId, scope.workspaceId,
        input.ownerInstanceId, token, leaseExpiresAt, now, initialLeaseRevision, now, now,
      )
      child = getScopedN8nTaskRunByTaskId(db, child.taskId, scope)!
      return {
        outcome: 'claimed', parent, child,
        lease: { taskId: child.taskId, ownerInstanceId: input.ownerInstanceId, leaseToken: token, leaseExpiresAt, revision: initialLeaseRevision },
      }
    }

    if (child.status === 'running') {
      if (!current) return { outcome: 'rejected', parent, child, lease: null }
      if (current.owner_instance_id === input.ownerInstanceId) {
        return { outcome: 'running', parent, child, lease: childLeaseFromRow(child.taskId, current) }
      }
      if (current.lease_expires_at > now) {
        return { outcome: 'running', parent, child, lease: childLeaseFromRow(child.taskId, current) }
      }
      if (child.attemptCount >= child.maxAttempts) {
        db.prepare(`
          UPDATE n8n_task_runs
          SET status = 'failed', error = 'director_extraction_attempts_exhausted',
              completed_at = ?, updated_at = ?
          WHERE task_id = ? AND tenant_id = ? AND workspace_id = ? AND status = 'running'
        `).run(now, now, child.taskId, scope.tenantId, scope.workspaceId)
        db.prepare(`
          DELETE FROM n8n_child_execution_leases
          WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
        `).run(child.taskId, scope.tenantId, scope.workspaceId)
        return { outcome: 'exhausted', parent, child, lease: null }
      }
      const takeover = db.prepare(`
        UPDATE n8n_child_execution_leases
        SET owner_instance_id = ?, lease_token = ?, lease_expires_at = ?, heartbeat_at = ?,
            revision = revision + 1, updated_at = ?
        WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
          AND owner_instance_id = ? AND lease_token = ? AND revision = ?
          AND lease_expires_at <= ?
      `).run(
        input.ownerInstanceId, token, leaseExpiresAt, now, now,
        child.taskId, scope.tenantId, scope.workspaceId,
        current.owner_instance_id, current.lease_token, current.revision, now,
      )
      if (takeover.changes !== 1) return { outcome: 'running', parent, child, lease: null }
      db.prepare(`
        UPDATE n8n_task_runs
        SET attempt_count = attempt_count + 1, started_at = ?, completed_at = NULL,
            error = NULL, updated_at = ?
        WHERE task_id = ? AND tenant_id = ? AND workspace_id = ? AND status = 'running'
      `).run(now, now, child.taskId, scope.tenantId, scope.workspaceId)
      child = getScopedN8nTaskRunByTaskId(db, child.taskId, scope)!
      return {
        outcome: 'claimed', parent, child,
        lease: {
          taskId: child.taskId,
          ownerInstanceId: input.ownerInstanceId,
          leaseToken: token,
          leaseExpiresAt,
          revision: current.revision + 1,
        },
      }
    }

    if (child.status !== 'failed' || current) {
      return { outcome: 'terminal', parent, child, lease: null }
    }
    const retry = db.prepare(`
      UPDATE n8n_task_runs
      SET status = 'running', attempt_count = attempt_count + 1, started_at = ?,
          completed_at = NULL, error = NULL, updated_at = ?
      WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
        AND status = 'failed' AND attempt_count < max_attempts
    `).run(now, now, child.taskId, scope.tenantId, scope.workspaceId)
    if (retry.changes !== 1) return { outcome: 'exhausted', parent, child, lease: null }
    db.prepare(`
      INSERT INTO n8n_child_execution_leases (
        task_id, tenant_id, workspace_id, owner_instance_id, lease_token,
        lease_expires_at, heartbeat_at, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      child.taskId, scope.tenantId, scope.workspaceId,
      input.ownerInstanceId, token, leaseExpiresAt, now, initialLeaseRevision, now, now,
    )
    child = getScopedN8nTaskRunByTaskId(db, child.taskId, scope)!
    return {
      outcome: 'claimed', parent, child,
      lease: { taskId: child.taskId, ownerInstanceId: input.ownerInstanceId, leaseToken: token, leaseExpiresAt, revision: initialLeaseRevision },
    }
  })
  return execute.immediate()
}

export function renewN8nChildExecutionLease(
  db: Database.Database,
  lease: N8nChildExecutionLease,
  scope: N8nTaskScope,
  options: { nowSeconds?: number; leaseSeconds?: number } = {},
): N8nChildExecutionLease | null {
  assertChildLeaseIdentity(lease.ownerInstanceId, lease.leaseToken)
  const now = childLeaseClock(options.nowSeconds)
  const leaseSeconds = options.leaseSeconds ?? N8N_CHILD_EXECUTION_LEASE_SECONDS
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 60 * 60) {
    throw new TypeError('n8n 子任务执行租约时长无效')
  }
  const leaseExpiresAt = now + leaseSeconds
  const renewed = db.prepare(`
    UPDATE n8n_child_execution_leases
    SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ?
    WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
      AND owner_instance_id = ? AND lease_token = ? AND revision = ?
      AND lease_expires_at > ?
      AND EXISTS (
        SELECT 1 FROM n8n_task_runs
        WHERE task_id = ? AND tenant_id = ? AND workspace_id = ? AND status = 'running'
      )
  `).run(
    leaseExpiresAt, now, now,
    lease.taskId, scope.tenantId, scope.workspaceId,
    lease.ownerInstanceId, lease.leaseToken, lease.revision, now,
    lease.taskId, scope.tenantId, scope.workspaceId,
  )
  return renewed.changes === 1 ? { ...lease, leaseExpiresAt } : null
}

export async function runWithN8nChildExecutionHeartbeat<T>(
  db: Database.Database,
  lease: N8nChildExecutionLease,
  scope: N8nTaskScope,
  operation: () => Promise<T>,
  options: { heartbeatSeconds?: number; leaseSeconds?: number } = {},
): Promise<T> {
  const heartbeatSeconds = options.heartbeatSeconds ?? N8N_CHILD_EXECUTION_HEARTBEAT_SECONDS
  if (!Number.isSafeInteger(heartbeatSeconds) || heartbeatSeconds < 1) {
    throw new TypeError('n8n 子任务执行心跳周期无效')
  }
  let lost = false
  const timer = setInterval(() => {
    try {
      if (!renewN8nChildExecutionLease(db, lease, scope, { leaseSeconds: options.leaseSeconds })) lost = true
    } catch {
      lost = true
    }
  }, heartbeatSeconds * 1_000)
  timer.unref()
  try {
    const result = await operation()
    if (lost || !renewN8nChildExecutionLease(db, lease, scope, { leaseSeconds: options.leaseSeconds })) {
      throw new N8nChildExecutionLeaseLostError()
    }
    return result
  } finally {
    clearInterval(timer)
  }
}

function settleN8nChildExecution(
  db: Database.Database,
  lease: N8nChildExecutionLease,
  scope: N8nTaskScope,
  kind: 'complete' | 'fail',
  value: Record<string, unknown> | string,
  options: { nowSeconds?: number; parentTaskId?: string } = {},
): { settled: boolean; run: N8nTaskRun | null; parent: N8nTaskRun | null } {
  assertChildLeaseIdentity(lease.ownerInstanceId, lease.leaseToken)
  const now = childLeaseClock(options.nowSeconds)
  const settle = db.transaction(() => {
    const serialized = kind === 'complete' ? JSON.stringify(value) : String(value).slice(0, 2_000)
    const result = kind === 'complete'
      ? db.prepare(`
          UPDATE n8n_task_runs
          SET status = 'succeeded', output = ?, error = NULL, completed_at = ?, updated_at = ?
          WHERE task_id = ? AND tenant_id = ? AND workspace_id = ? AND status = 'running'
            AND EXISTS (
              SELECT 1 FROM n8n_child_execution_leases lease
              WHERE lease.task_id = n8n_task_runs.task_id
                AND lease.owner_instance_id = ? AND lease.lease_token = ?
                AND lease.revision = ? AND lease.lease_expires_at > ?
            )
        `).run(
          serialized, now, now, lease.taskId, scope.tenantId, scope.workspaceId,
          lease.ownerInstanceId, lease.leaseToken, lease.revision, now,
        )
      : db.prepare(`
          UPDATE n8n_task_runs
          SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
          WHERE task_id = ? AND tenant_id = ? AND workspace_id = ? AND status = 'running'
            AND EXISTS (
              SELECT 1 FROM n8n_child_execution_leases lease
              WHERE lease.task_id = n8n_task_runs.task_id
                AND lease.owner_instance_id = ? AND lease.lease_token = ?
                AND lease.revision = ? AND lease.lease_expires_at > ?
            )
        `).run(
          serialized, now, now, lease.taskId, scope.tenantId, scope.workspaceId,
          lease.ownerInstanceId, lease.leaseToken, lease.revision, now,
        )
    if (result.changes !== 1) {
      return {
        settled: false,
        run: getScopedN8nTaskRunByTaskId(db, lease.taskId, scope),
        parent: options.parentTaskId ? getScopedN8nTaskRunByTaskId(db, options.parentTaskId, scope) : null,
      }
    }
    if (kind === 'complete' && options.parentTaskId) {
      const parentResult = db.prepare(`
        UPDATE n8n_task_runs
        SET status = 'succeeded', output = ?, error = NULL, completed_at = ?, updated_at = ?
        WHERE task_id = ? AND tenant_id = ? AND workspace_id = ? AND status = 'running'
      `).run(serialized, now, now, options.parentTaskId, scope.tenantId, scope.workspaceId)
      const parent = getScopedN8nTaskRunByTaskId(db, options.parentTaskId, scope)
      if (parentResult.changes !== 1 && parent?.status !== 'succeeded') {
        throw new Error('最终节点完成，但父任务状态无法提交')
      }
    }
    db.prepare(`
      DELETE FROM n8n_child_execution_leases
      WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
        AND owner_instance_id = ? AND lease_token = ? AND revision = ?
    `).run(
      lease.taskId, scope.tenantId, scope.workspaceId,
      lease.ownerInstanceId, lease.leaseToken, lease.revision,
    )
    return {
      settled: true,
      run: getScopedN8nTaskRunByTaskId(db, lease.taskId, scope),
      parent: options.parentTaskId ? getScopedN8nTaskRunByTaskId(db, options.parentTaskId, scope) : null,
    }
  })
  return settle.immediate()
}

export function completeN8nChildExecution(
  db: Database.Database,
  lease: N8nChildExecutionLease,
  output: Record<string, unknown>,
  scope: N8nTaskScope,
  options: { nowSeconds?: number; parentTaskId?: string } = {},
) {
  return settleN8nChildExecution(db, lease, scope, 'complete', output, options)
}

export function failN8nChildExecution(
  db: Database.Database,
  lease: N8nChildExecutionLease,
  error: string,
  scope: N8nTaskScope,
  options: { nowSeconds?: number } = {},
) {
  return settleN8nChildExecution(db, lease, scope, 'fail', error, options)
}

/**
 * Re-read a video parent and persist a deterministic media child while holding
 * an IMMEDIATE SQLite transaction. This closes the race with orphan
 * reconciliation: either the child exists before reconciliation checks, or
 * the callback observes the reconciled terminal parent and cannot revive it.
 */
export function createN8nMediaChildRunFromParent(
  db: Database.Database,
  input: {
    parentTaskId: string
    parentIdempotencyKey: string
    stage: typeof MEDIA_STAGES[number]
    taskInput: Record<string, unknown>
  },
): {
  outcome: N8nMediaChildCreateOutcome
  parent: N8nTaskRun | null
  child: N8nTaskRun | null
} {
  const execute = db.transaction(() => {
    const parent = getN8nTaskRunByTaskId(db, input.parentTaskId)
    if (!parent) return { outcome: 'not_found' as const, parent: null, child: null }
    if (parent.idempotencyKey !== input.parentIdempotencyKey) {
      return { outcome: 'rejected' as const, parent, child: null }
    }
    if (['succeeded', 'failed', 'cancelled'].includes(parent.status)) {
      return { outcome: 'terminal' as const, parent, child: null }
    }
    if (
      !['queued', 'accepted', 'running'].includes(parent.status)
      || String(parent.routing.taskType || '') !== 'video-analysis'
    ) {
      return { outcome: 'rejected' as const, parent, child: null }
    }

    const childTaskId = mediaChildTaskId(parent.taskId, input.stage)
    const childIdempotencyKey = mediaChildIdentity('idem', parent.idempotencyKey, input.stage)
    const created = createN8nTaskRun(db, {
      taskId: childTaskId,
      idempotencyKey: childIdempotencyKey,
      bindingId: parent.bindingId,
      source: 'n8n-media-node',
      requestedBy: parent.requestedBy,
      routing: {
        ...parent.routing,
        mediaStage: input.stage,
        memoryMode: 'none',
      },
      taskInput: input.taskInput,
      delivery: { mode: 'none' },
      maxAttempts: 2,
    }, { workspaceId: parent.workspaceId, tenantId: parent.tenantId })
    return {
      outcome: created.created ? 'created' as const : 'existing' as const,
      parent,
      child: created.run,
    }
  })
  return execute.immediate()
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

/** Fail dispatch only while no authenticated worker has claimed the run. */
export function failScopedUnclaimedN8nTaskRun(
  db: Database.Database,
  taskId: string,
  error: string,
  scope: N8nTaskScope,
): { failed: boolean; run: N8nTaskRun | null } {
  const result = db.prepare(`
    UPDATE n8n_task_runs
    SET status = 'failed', error = ?, completed_at = unixepoch(), updated_at = unixepoch()
    WHERE task_id = ?
      AND tenant_id = ?
      AND workspace_id = ?
      AND status IN ('queued', 'accepted')
  `).run(error.slice(0, 2_000), taskId, scope.tenantId, scope.workspaceId)
  return {
    failed: result.changes === 1,
    run: getScopedN8nTaskRunByTaskId(db, taskId, scope),
  }
}

function insertN8nMediaCleanupDebt(
  db: Database.Database,
  parent: N8nTaskRun,
  reason: N8nMediaCleanupReason,
): void {
  const workspaceDigest = createHash('sha256').update(parent.taskId).digest('hex')
  db.prepare(`
    INSERT INTO n8n_media_cleanup_debts (
      task_id, binding_id, workspace_id, tenant_id, workspace_digest, reason,
      attempt_count, last_error, next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 0, NULL, unixepoch(), unixepoch(), unixepoch())
    ON CONFLICT(task_id) DO NOTHING
  `).run(
    parent.taskId,
    parent.bindingId,
    parent.workspaceId,
    parent.tenantId,
    workspaceDigest,
    reason,
  )
}

/**
 * Backfill a durable cleanup obligation for a terminal video run created by an
 * older runtime. The finalize child, binding, scope, terminal state, and reason
 * must all agree; ambiguous or tampered rows fail closed.
 */
export function ensureN8nMediaCleanupDebt(
  db: Database.Database,
  taskId: string,
  scope?: N8nTaskScope,
): { scheduled: boolean; reason: N8nMediaCleanupReason | null } {
  const parent = scope
    ? getScopedN8nTaskRunByTaskId(db, taskId, scope)
    : getN8nTaskRunByTaskId(db, taskId)
  if (!parent) return { scheduled: false, reason: null }
  const binding = db.prepare(`
    SELECT 1
    FROM n8n_workflow_bindings
    WHERE id = ? AND tenant_id = ? AND workspace_id = ? AND task_type = 'video-analysis'
  `).get(parent.bindingId, parent.tenantId, parent.workspaceId)
  if (!binding) return { scheduled: false, reason: null }

  const child = getN8nTaskRunByTaskId(db, mediaChildTaskId(parent.taskId, 'finalize'))
  if (
    !child
    || child.bindingId !== parent.bindingId
    || child.tenantId !== parent.tenantId
    || child.workspaceId !== parent.workspaceId
  ) {
    return { scheduled: false, reason: null }
  }

  let reason: N8nMediaCleanupReason | null = null
  if (parent.status === 'succeeded' && child.status === 'succeeded' && parent.output && child.output) {
    reason = 'finalize_succeeded'
  } else if (
    parent.status === 'failed'
    && child.status === 'failed'
    && String(parent.error || '').includes(`[${N8N_VIDEO_FINALIZE_LEASE_EXPIRED}]`)
    && String(child.error || '').includes(`[${N8N_VIDEO_FINALIZE_LEASE_EXPIRED}]`)
  ) {
    reason = 'finalize_lease_expired'
  }
  if (!reason) return { scheduled: false, reason: null }
  insertN8nMediaCleanupDebt(db, parent, reason)
  return { scheduled: true, reason }
}

/**
 * Persist the finalize child and its parent in one transaction. Repeating the
 * call repairs an already-succeeded finalize child whose parent update was
 * interrupted by an older runtime.
 */
export function completeN8nFinalizeRun(
  db: Database.Database,
  input: {
    parentTaskId: string
    childTaskId: string
    output?: Record<string, unknown> | null
    executionLease?: N8nChildExecutionLease
    nowSeconds?: number
  },
): {
  outcome: N8nFinalizeOutcome
  parent: N8nTaskRun | null
  child: N8nTaskRun | null
  output: Record<string, unknown> | null
} {
  const execute = db.transaction(() => {
    const now = childLeaseClock(input.nowSeconds)
    let parent = getN8nTaskRunByTaskId(db, input.parentTaskId)
    let child = getN8nTaskRunByTaskId(db, input.childTaskId)
    if (!parent || !child) {
      return { outcome: 'not_found' as const, parent, child, output: null }
    }
    const expectedChildTaskId = mediaChildTaskId(parent.taskId, 'finalize')
    if (
      child.taskId !== expectedChildTaskId
      || child.bindingId !== parent.bindingId
      || child.workspaceId !== parent.workspaceId
      || child.tenantId !== parent.tenantId
    ) {
      return { outcome: 'rejected' as const, parent, child, output: null }
    }
    if (['failed', 'cancelled'].includes(parent.status)) {
      return { outcome: 'terminal' as const, parent, child, output: null }
    }

    let output = input.output || child.output
    if (!output) return { outcome: 'rejected' as const, parent, child, output: null }
    if (child.status === 'running') {
      if (input.executionLease) {
        assertChildLeaseIdentity(input.executionLease.ownerInstanceId, input.executionLease.leaseToken)
        if (input.executionLease.taskId !== child.taskId) {
          return { outcome: 'rejected' as const, parent, child, output: null }
        }
      }
      const childUpdate = db.prepare(`
        UPDATE n8n_task_runs
        SET status = 'succeeded', output = ?, error = NULL,
            completed_at = ?, updated_at = ?
        WHERE task_id = ? AND status = 'running'
          AND (? = 0 OR EXISTS (
            SELECT 1 FROM n8n_child_execution_leases lease
            WHERE lease.task_id = n8n_task_runs.task_id
              AND lease.owner_instance_id = ? AND lease.lease_token = ?
              AND lease.revision = ? AND lease.lease_expires_at > ?
          ))
      `).run(
        JSON.stringify(output), now, now, child.taskId,
        input.executionLease ? 1 : 0,
        input.executionLease?.ownerInstanceId || '',
        input.executionLease?.leaseToken || '',
        input.executionLease?.revision || 0,
        now,
      )
      if (childUpdate.changes !== 1) {
        return { outcome: 'rejected' as const, parent, child, output: null }
      }
      child = getN8nTaskRunByTaskId(db, child.taskId)!
    } else if (child.status === 'succeeded' && child.output) {
      output = child.output
    } else {
      return { outcome: 'rejected' as const, parent, child, output: null }
    }

    if (parent.status === 'succeeded') {
      if (input.executionLease) {
        db.prepare(`DELETE FROM n8n_child_execution_leases WHERE task_id = ? AND lease_token = ?`)
          .run(child.taskId, input.executionLease.leaseToken)
      }
      insertN8nMediaCleanupDebt(db, parent, 'finalize_succeeded')
      enqueueDirectorEvidenceOutbox(db, parent, now)
      return { outcome: 'cached' as const, parent, child, output: parent.output || output }
    }
    const completed = db.prepare(`
      UPDATE n8n_task_runs
      SET status = 'succeeded', output = ?, error = NULL,
          completed_at = unixepoch(), updated_at = unixepoch()
      WHERE task_id = ? AND status IN ('queued', 'accepted', 'running')
    `).run(JSON.stringify(output), parent.taskId)
    parent = getN8nTaskRunByTaskId(db, parent.taskId)!
    if (completed.changes !== 1) {
      return { outcome: 'rejected' as const, parent, child, output: null }
    }
    if (input.executionLease) {
      const released = db.prepare(`
        DELETE FROM n8n_child_execution_leases
        WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
          AND owner_instance_id = ? AND lease_token = ? AND revision = ?
      `).run(
        child.taskId, child.tenantId, child.workspaceId,
        input.executionLease.ownerInstanceId,
        input.executionLease.leaseToken,
        input.executionLease.revision,
      )
      if (released.changes !== 1) throw new Error('最终媒体节点执行租约无法原子释放')
    }
    insertN8nMediaCleanupDebt(db, parent, 'finalize_succeeded')
    enqueueDirectorEvidenceOutbox(db, parent, now)
    return { outcome: 'completed' as const, parent, child, output }
  })
  return execute.immediate()
}

/**
 * Fail a video parent only when its callback lease expired before any
 * deterministic media child was created. A long-running prepare/audio/vision
 * child therefore protects its parent regardless of the video's duration.
 * A finalize child is the bounded exception: after its separate hard lease it
 * and the parent are failed in one transaction, fencing any late completion.
 */
export function reconcileScopedN8nVideoTaskRun(
  db: Database.Database,
  taskId: string,
  scope: N8nTaskScope,
  options: { nowSeconds?: number; leaseSeconds?: number; finalizeLeaseSeconds?: number } = {},
): { outcome: N8nVideoTaskReconcileOutcome; run: N8nTaskRun | null; code: string | null } {
  const nowSeconds = Number.isFinite(options.nowSeconds)
    ? Math.max(0, Math.floor(Number(options.nowSeconds)))
    : Math.floor(Date.now() / 1_000)
  const leaseSeconds = Number.isFinite(options.leaseSeconds)
    ? Math.max(1, Math.min(24 * 60 * 60, Math.floor(Number(options.leaseSeconds))))
    : N8N_VIDEO_CALLBACK_LEASE_SECONDS
  const finalizeLeaseSeconds = Number.isFinite(options.finalizeLeaseSeconds)
    ? Math.max(60, Math.min(7 * 24 * 60 * 60, Math.floor(Number(options.finalizeLeaseSeconds))))
    : N8N_VIDEO_FINALIZE_LEASE_SECONDS
  const cutoff = nowSeconds - leaseSeconds
  const finalizeCutoff = nowSeconds - finalizeLeaseSeconds
  const childTaskIds = (['prepare', 'audio', 'vision', 'finalize'] as const)
    .map(stage => mediaChildTaskId(taskId, stage))
  const error = `[${N8N_VIDEO_CALLBACK_LEASE_EXPIRED}] n8n 视频任务已受理，但在 ${leaseSeconds} 秒内未建立媒体处理阶段`

  const result = db.prepare(`
    UPDATE n8n_task_runs
    SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
    WHERE task_id = ?
      AND tenant_id = ?
      AND workspace_id = ?
      AND status IN ('accepted', 'running')
      AND COALESCE(started_at, accepted_at, updated_at) <= ?
      AND EXISTS (
        SELECT 1
        FROM n8n_workflow_bindings binding
        WHERE binding.id = n8n_task_runs.binding_id
          AND binding.tenant_id = n8n_task_runs.tenant_id
          AND binding.workspace_id = n8n_task_runs.workspace_id
          AND binding.task_type = 'video-analysis'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM n8n_task_runs child
        WHERE child.tenant_id = n8n_task_runs.tenant_id
          AND child.workspace_id = n8n_task_runs.workspace_id
          AND child.task_id IN (?, ?, ?, ?)
      )
  `).run(
    error,
    nowSeconds,
    nowSeconds,
    taskId,
    scope.tenantId,
    scope.workspaceId,
    cutoff,
    ...childTaskIds,
  )

  if (result.changes === 1) {
    const run = getScopedN8nTaskRunByTaskId(db, taskId, scope)
    return { outcome: 'reconciled', run, code: N8N_VIDEO_CALLBACK_LEASE_EXPIRED }
  }

  const finalizeChildTaskId = childTaskIds[3]
  const finalizeError = `[${N8N_VIDEO_FINALIZE_LEASE_EXPIRED}] 视频最终合并节点运行超过 ${finalizeLeaseSeconds} 秒，已原子终止父子任务以避免永久占用队列`
  const reconcileFinalize = db.transaction(() => {
    const parent = getScopedN8nTaskRunByTaskId(db, taskId, scope)
    if (!parent || !['accepted', 'running'].includes(parent.status)) return false
    const videoBinding = db.prepare(`
      SELECT 1
      FROM n8n_workflow_bindings
      WHERE id = ? AND tenant_id = ? AND workspace_id = ? AND task_type = 'video-analysis'
    `).get(parent.bindingId, scope.tenantId, scope.workspaceId)
    if (!videoBinding) return false

    const childResult = db.prepare(`
      UPDATE n8n_task_runs
      SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
      WHERE task_id = ?
        AND binding_id = ?
        AND tenant_id = ?
        AND workspace_id = ?
        AND status = 'running'
        AND COALESCE(started_at, updated_at) <= ?
    `).run(
      finalizeError,
      nowSeconds,
      nowSeconds,
      finalizeChildTaskId,
      parent.bindingId,
      scope.tenantId,
      scope.workspaceId,
      finalizeCutoff,
    )
    if (childResult.changes !== 1) return false

    const parentResult = db.prepare(`
      UPDATE n8n_task_runs
      SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
      WHERE task_id = ?
        AND binding_id = ?
        AND tenant_id = ?
        AND workspace_id = ?
        AND status IN ('accepted', 'running')
    `).run(
      finalizeError,
      nowSeconds,
      nowSeconds,
      parent.taskId,
      parent.bindingId,
      scope.tenantId,
      scope.workspaceId,
    )
    if (parentResult.changes !== 1) {
      throw new Error('视频最终节点超时收敛未能原子更新父任务')
    }
    const terminalParent = getScopedN8nTaskRunByTaskId(db, parent.taskId, scope)
    if (!terminalParent) throw new Error('视频最终节点超时收敛后无法读取父任务')
    insertN8nMediaCleanupDebt(db, terminalParent, 'finalize_lease_expired')
    return true
  })
  if (reconcileFinalize.immediate()) {
    const run = getScopedN8nTaskRunByTaskId(db, taskId, scope)
    return { outcome: 'reconciled', run, code: N8N_VIDEO_FINALIZE_LEASE_EXPIRED }
  }

  const run = getScopedN8nTaskRunByTaskId(db, taskId, scope)
  if (!run) return { outcome: 'not_found', run: null, code: null }
  if (['succeeded', 'failed', 'cancelled'].includes(run.status)) {
    return { outcome: 'terminal', run, code: null }
  }
  if (['accepted', 'running'].includes(run.status)) {
    const videoBinding = db.prepare(`
      SELECT 1
      FROM n8n_workflow_bindings
      WHERE id = ? AND tenant_id = ? AND workspace_id = ? AND task_type = 'video-analysis'
    `).get(run.bindingId, scope.tenantId, scope.workspaceId)
    return { outcome: videoBinding ? 'active' : 'ineligible', run, code: null }
  }
  return { outcome: 'ineligible', run, code: null }
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

function mediaChildIdentity(
  prefix: 'task' | 'idem',
  taskId: string,
  stage: typeof MEDIA_STAGES[number],
): string {
  const digest = createHash('sha256').update(`${taskId}:${stage}`).digest('hex').slice(0, 24)
  return `media-${prefix}:${taskId.slice(0, 70)}:${stage}:${digest}`.slice(0, 120)
}

function mediaChildTaskId(taskId: string, stage: typeof MEDIA_STAGES[number]): string {
  return mediaChildIdentity('task', taskId, stage)
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
  constraints: { directorEvidenceWorkId?: string } = {},
): N8nVideoSearchResult {
  const query = compactString(rawQuery, 120) || ''
  const terms = normalizedSearchTerms(query)
  const limit = Math.max(1, Math.min(200, Math.floor(requestedLimit || 80)))
  if (!terms.length) {
    return { query, hits: [], total: 0, videoCount: 0, segmentCount: 0, limit, truncated: false }
  }

  const { whereSql, params } = videoResultWhere(scope, { status: 'succeeded' })
  const directorWorkId = compactString(constraints.directorEvidenceWorkId, 160)
  if (constraints.directorEvidenceWorkId !== undefined && !directorWorkId) {
    throw new TypeError('director evidence work id invalid')
  }
  const directorWorkWhere = directorWorkId
    ? `AND json_valid(r.input) = 1
      AND json_extract(r.input, '$.directorEvidence.workId') = ?`
    : ''
  if (directorWorkId) params.push(directorWorkId)
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
      ${directorWorkWhere}
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
