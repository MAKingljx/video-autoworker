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
