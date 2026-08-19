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
  completedAt: number | null
  updatedAt: number
  workflowName: string | null
  bindingTaskType: string | null
  resultAvailable: boolean
}

const TOP_LEVEL_TASK_SOURCES = ['video-autoworker', 'openclaw'] as const

function compactString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const compacted = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return compacted ? compacted.slice(0, maxLength) : null
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
    completedAt: run.completedAt,
    updatedAt: run.updatedAt,
    error: sanitizeRunError(run.error),
    resultAvailable: run.resultAvailable,
    batchId: batch.batchId,
    batchIndex: batch.batchIndex,
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
    runs: rows.map(row => projectN8nTaskRunListItem({
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
    })),
    total: totalRow.total,
    limit,
    offset,
  }
}
