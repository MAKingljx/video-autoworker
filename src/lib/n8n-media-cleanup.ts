import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import { cleanupN8nMediaTask, mediaChildIdentity } from '@/lib/n8n-media-execution'
import { N8N_VIDEO_FINALIZE_LEASE_EXPIRED } from '@/lib/n8n-task-runs'

export interface N8nMediaCleanupDebt {
  taskId: string
  bindingId: number
  workspaceId: number
  tenantId: number
  workspaceDigest: string
  reason: 'finalize_succeeded' | 'finalize_lease_expired'
  attemptCount: number
  lastError: string | null
  nextAttemptAt: number
  createdAt: number
  updatedAt: number
}

interface CleanupDebtRow {
  task_id: string
  binding_id: number
  workspace_id: number
  tenant_id: number
  workspace_digest: string
  reason: N8nMediaCleanupDebt['reason']
  attempt_count: number
  last_error: string | null
  next_attempt_at: number
  created_at: number
  updated_at: number
}

export type N8nMediaCleanupAttemptOutcome = 'cleaned' | 'pending' | 'not_due' | 'not_found' | 'rejected'

function rowToDebt(row: CleanupDebtRow): N8nMediaCleanupDebt {
  return {
    taskId: row.task_id,
    bindingId: row.binding_id,
    workspaceId: row.workspace_id,
    tenantId: row.tenant_id,
    workspaceDigest: row.workspace_digest,
    reason: row.reason,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function getN8nMediaCleanupDebt(
  db: Database.Database,
  taskId: string,
): N8nMediaCleanupDebt | null {
  const row = db.prepare(`
    SELECT * FROM n8n_media_cleanup_debts WHERE task_id = ?
  `).get(taskId) as CleanupDebtRow | undefined
  return row ? rowToDebt(row) : null
}

export function listDueN8nMediaCleanupDebts(
  db: Database.Database,
  options: { nowSeconds?: number; limit?: number } = {},
): N8nMediaCleanupDebt[] {
  const nowSeconds = Number.isFinite(options.nowSeconds)
    ? Math.max(0, Math.floor(Number(options.nowSeconds)))
    : Math.floor(Date.now() / 1_000)
  const limit = Number.isFinite(options.limit)
    ? Math.max(1, Math.min(100, Math.floor(Number(options.limit))))
    : 20
  const rows = db.prepare(`
    SELECT *
    FROM n8n_media_cleanup_debts
    WHERE next_attempt_at <= ?
    ORDER BY next_attempt_at ASC, updated_at ASC, task_id ASC
    LIMIT ?
  `).all(nowSeconds, limit) as CleanupDebtRow[]
  return rows.map(rowToDebt)
}

function cleanupDebtBindingError(db: Database.Database, debt: N8nMediaCleanupDebt): string | null {
  const expectedDigest = createHash('sha256').update(debt.taskId).digest('hex')
  if (debt.workspaceDigest !== expectedDigest) return '媒体清理债务的工作区摘要不匹配'

  const parent = db.prepare(`
    SELECT run.status, run.error, run.output, binding.task_type
    FROM n8n_task_runs run
    JOIN n8n_workflow_bindings binding
      ON binding.id = run.binding_id
     AND binding.tenant_id = run.tenant_id
     AND binding.workspace_id = run.workspace_id
    WHERE run.task_id = ?
      AND run.binding_id = ?
      AND run.tenant_id = ?
      AND run.workspace_id = ?
  `).get(
    debt.taskId,
    debt.bindingId,
    debt.tenantId,
    debt.workspaceId,
  ) as { status: string; error: string | null; output: string | null; task_type: string } | undefined
  if (!parent || parent.task_type !== 'video-analysis') return '媒体清理债务与视频父任务不匹配'

  const child = db.prepare(`
    SELECT status, error, output
    FROM n8n_task_runs
    WHERE task_id = ?
      AND binding_id = ?
      AND tenant_id = ?
      AND workspace_id = ?
  `).get(
    mediaChildIdentity('task', debt.taskId, 'finalize'),
    debt.bindingId,
    debt.tenantId,
    debt.workspaceId,
  ) as { status: string; error: string | null; output: string | null } | undefined
  if (!child) return '媒体清理债务缺少绑定的最终节点'

  if (debt.reason === 'finalize_succeeded') {
    if (parent.status !== 'succeeded' || child.status !== 'succeeded' || !parent.output || !child.output) {
      return '媒体清理债务与成功终态不匹配'
    }
    return null
  }

  const leaseCode = `[${N8N_VIDEO_FINALIZE_LEASE_EXPIRED}]`
  if (
    parent.status !== 'failed'
    || child.status !== 'failed'
    || !String(parent.error || '').includes(leaseCode)
    || !String(child.error || '').includes(leaseCode)
  ) {
    return '媒体清理债务与最终节点硬超时终态不匹配'
  }
  return null
}

function retryDelaySeconds(attemptCount: number): number {
  return Math.min(6 * 60 * 60, 60 * (2 ** Math.min(8, Math.max(0, attemptCount - 1))))
}

function persistCleanupFailure(
  db: Database.Database,
  debt: N8nMediaCleanupDebt,
  error: string,
  nowSeconds: number,
): void {
  const nextAttemptCount = debt.attemptCount + 1
  db.prepare(`
    UPDATE n8n_media_cleanup_debts
    SET attempt_count = ?, last_error = ?, next_attempt_at = ?, updated_at = ?
    WHERE task_id = ?
      AND binding_id = ?
      AND tenant_id = ?
      AND workspace_id = ?
      AND workspace_digest = ?
  `).run(
    nextAttemptCount,
    error.slice(0, 1_000),
    nowSeconds + retryDelaySeconds(nextAttemptCount),
    nowSeconds,
    debt.taskId,
    debt.bindingId,
    debt.tenantId,
    debt.workspaceId,
    debt.workspaceDigest,
  )
}

export async function retryN8nMediaCleanupDebt(
  db: Database.Database,
  taskId: string,
  options: {
    nowSeconds?: number
    force?: boolean
    cleanup?: (taskId: string) => Promise<void>
  } = {},
): Promise<{ outcome: N8nMediaCleanupAttemptOutcome; debt: N8nMediaCleanupDebt | null; error: string | null }> {
  const nowSeconds = Number.isFinite(options.nowSeconds)
    ? Math.max(0, Math.floor(Number(options.nowSeconds)))
    : Math.floor(Date.now() / 1_000)
  const debt = getN8nMediaCleanupDebt(db, taskId)
  if (!debt) return { outcome: 'not_found', debt: null, error: null }
  if (!options.force && debt.nextAttemptAt > nowSeconds) {
    return { outcome: 'not_due', debt, error: null }
  }

  const bindingError = cleanupDebtBindingError(db, debt)
  if (bindingError) {
    persistCleanupFailure(db, debt, bindingError, nowSeconds)
    return { outcome: 'rejected', debt: getN8nMediaCleanupDebt(db, taskId), error: bindingError }
  }

  try {
    await (options.cleanup || cleanupN8nMediaTask)(debt.taskId)
  } catch (error) {
    const message = error instanceof Error ? error.message : '媒体任务工作区清理失败'
    persistCleanupFailure(db, debt, message, nowSeconds)
    return { outcome: 'pending', debt: getN8nMediaCleanupDebt(db, taskId), error: message }
  }

  const deleted = db.prepare(`
    DELETE FROM n8n_media_cleanup_debts
    WHERE task_id = ?
      AND binding_id = ?
      AND tenant_id = ?
      AND workspace_id = ?
      AND workspace_digest = ?
  `).run(
    debt.taskId,
    debt.bindingId,
    debt.tenantId,
    debt.workspaceId,
    debt.workspaceDigest,
  )
  if (deleted.changes === 1 || !getN8nMediaCleanupDebt(db, taskId)) {
    return { outcome: 'cleaned', debt: null, error: null }
  }
  const error = '媒体清理债务身份在清理期间发生变化'
  return { outcome: 'rejected', debt: getN8nMediaCleanupDebt(db, taskId), error }
}

export async function drainN8nMediaCleanupDebts(
  db: Database.Database,
  options: { nowSeconds?: number; limit?: number } = {},
): Promise<{ scanned: number; cleaned: number; pending: number; rejected: number }> {
  const debts = listDueN8nMediaCleanupDebts(db, options)
  const result = { scanned: debts.length, cleaned: 0, pending: 0, rejected: 0 }
  for (const debt of debts) {
    const attempt = await retryN8nMediaCleanupDebt(db, debt.taskId, {
      nowSeconds: options.nowSeconds,
    })
    if (attempt.outcome === 'cleaned') result.cleaned++
    else if (attempt.outcome === 'rejected') result.rejected++
    else result.pending++
  }
  return result
}
