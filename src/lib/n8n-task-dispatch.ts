import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  getScopedN8nTaskRunByTaskId,
  type N8nTaskRun,
  type N8nTaskScope,
} from '@/lib/n8n-task-runs'

export const N8N_TASK_DISPATCH_LEASE_SECONDS = 180

interface DispatchLeaseRow {
  owner_token: string
  lease_expires_at: number
  revision: number
}

type DispatchClockOptions = {
  nowSeconds?: number
}

type DispatchAcquireOptions = DispatchClockOptions & {
  leaseSeconds?: number
  token?: string
}

export type N8nTaskDispatchOwnership =
  | {
      outcome: 'acquired'
      token: string
      leaseExpiresAt: number
      revision: number
      run: N8nTaskRun
    }
  | {
      outcome: 'in_progress'
      token: null
      leaseExpiresAt: number
      revision: number
      run: N8nTaskRun
    }
  | {
      outcome: 'ineligible'
      token: null
      leaseExpiresAt: null
      revision: null
      run: N8nTaskRun | null
    }

export type N8nTaskDispatchSettlement = {
  outcome: 'accepted' | 'failed' | 'claimed' | 'terminal' | 'stale'
  run: N8nTaskRun | null
}

function assertScope(scope: N8nTaskScope): void {
  if (
    !Number.isSafeInteger(scope.tenantId)
    || scope.tenantId <= 0
    || !Number.isSafeInteger(scope.workspaceId)
    || scope.workspaceId <= 0
  ) throw new TypeError('n8n dispatch scope is invalid')
}

function assertToken(token: string): void {
  if (!/^[0-9a-f]{64}$/u.test(token)) throw new TypeError('n8n dispatch token is invalid')
}

function resolveClock(options: DispatchClockOptions): number {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('n8n dispatch clock is invalid')
  return now
}

function classifySettledRun(run: N8nTaskRun | null): 'claimed' | 'terminal' | 'stale' {
  if (run?.status === 'running') return 'claimed'
  if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) return 'terminal'
  return 'stale'
}

/**
 * Atomically owns one queued task's outbound webhook delivery. The lease is
 * deliberately longer than the route's maximum 120-second webhook timeout.
 */
export function acquireN8nTaskDispatchOwnership(
  db: Database.Database,
  taskId: string,
  scope: N8nTaskScope,
  options: DispatchAcquireOptions = {},
): N8nTaskDispatchOwnership {
  assertScope(scope)
  const token = options.token ?? randomBytes(32).toString('hex')
  assertToken(token)
  const now = resolveClock(options)
  const leaseSeconds = options.leaseSeconds ?? N8N_TASK_DISPATCH_LEASE_SECONDS
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 125 || leaseSeconds > 900) {
    throw new TypeError('n8n dispatch lease is invalid')
  }
  const leaseExpiresAt = now + leaseSeconds
  if (!Number.isSafeInteger(leaseExpiresAt)) throw new TypeError('n8n dispatch clock is invalid')

  const acquire = db.transaction((): N8nTaskDispatchOwnership => {
    const run = getScopedN8nTaskRunByTaskId(db, taskId, scope)
    if (!run || run.status !== 'queued') {
      return {
        outcome: 'ineligible', token: null, leaseExpiresAt: null, revision: null, run,
      }
    }

    const current = db.prepare(`
      SELECT owner_token, lease_expires_at, revision
      FROM n8n_task_dispatch_leases
      WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
    `).get(taskId, scope.tenantId, scope.workspaceId) as DispatchLeaseRow | undefined

    if (!current) {
      db.prepare(`
        INSERT INTO n8n_task_dispatch_leases (
          task_id, tenant_id, workspace_id, owner_token,
          lease_expires_at, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        taskId, scope.tenantId, scope.workspaceId, token,
        leaseExpiresAt, now, now,
      )
      return { outcome: 'acquired', token, leaseExpiresAt, revision: 1, run }
    }

    if (current.lease_expires_at > now) {
      return {
        outcome: 'in_progress',
        token: null,
        leaseExpiresAt: current.lease_expires_at,
        revision: current.revision,
        run,
      }
    }

    const takeover = db.prepare(`
      UPDATE n8n_task_dispatch_leases
      SET owner_token = ?, lease_expires_at = ?, revision = revision + 1, updated_at = ?
      WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
        AND owner_token = ? AND revision = ? AND lease_expires_at <= ?
        AND EXISTS (
          SELECT 1 FROM n8n_task_runs
          WHERE task_id = ? AND tenant_id = ? AND workspace_id = ? AND status = 'queued'
        )
    `).run(
      token,
      leaseExpiresAt,
      now,
      taskId,
      scope.tenantId,
      scope.workspaceId,
      current.owner_token,
      current.revision,
      now,
      taskId,
      scope.tenantId,
      scope.workspaceId,
    )
    if (takeover.changes === 1) {
      return {
        outcome: 'acquired',
        token,
        leaseExpiresAt,
        revision: current.revision + 1,
        run,
      }
    }

    const latestRun = getScopedN8nTaskRunByTaskId(db, taskId, scope)
    return {
      outcome: 'ineligible', token: null, leaseExpiresAt: null, revision: null, run: latestRun,
    }
  })
  return acquire.immediate()
}

function settleN8nTaskDispatch(
  db: Database.Database,
  taskId: string,
  token: string,
  scope: N8nTaskScope,
  kind: 'success' | 'failure',
  error: string | null,
  options: DispatchClockOptions,
): N8nTaskDispatchSettlement {
  assertScope(scope)
  assertToken(token)
  const now = resolveClock(options)
  const settle = db.transaction((): N8nTaskDispatchSettlement => {
    const lease = db.prepare(`
      SELECT owner_token, lease_expires_at, revision
      FROM n8n_task_dispatch_leases
      WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
    `).get(taskId, scope.tenantId, scope.workspaceId) as DispatchLeaseRow | undefined
    if (!lease || lease.owner_token !== token || lease.lease_expires_at <= now) {
      return {
        outcome: 'stale',
        run: getScopedN8nTaskRunByTaskId(db, taskId, scope),
      }
    }

    const update = kind === 'success'
      ? db.prepare(`
          UPDATE n8n_task_runs
          SET status = 'accepted', accepted_at = COALESCE(accepted_at, ?),
              updated_at = ?, error = NULL
          WHERE task_id = ? AND tenant_id = ? AND workspace_id = ? AND status = 'queued'
            AND EXISTS (
              SELECT 1 FROM n8n_task_dispatch_leases
              WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
                AND owner_token = ? AND lease_expires_at > ?
            )
        `).run(
          now, now, taskId, scope.tenantId, scope.workspaceId,
          taskId, scope.tenantId, scope.workspaceId, token, now,
        )
      : db.prepare(`
          UPDATE n8n_task_runs
          SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
          WHERE task_id = ? AND tenant_id = ? AND workspace_id = ? AND status = 'queued'
            AND EXISTS (
              SELECT 1 FROM n8n_task_dispatch_leases
              WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
                AND owner_token = ? AND lease_expires_at > ?
            )
        `).run(
          String(error || 'n8n 任务执行失败').slice(0, 2_000), now, now,
          taskId, scope.tenantId, scope.workspaceId,
          taskId, scope.tenantId, scope.workspaceId, token, now,
        )

    db.prepare(`
      DELETE FROM n8n_task_dispatch_leases
      WHERE task_id = ? AND tenant_id = ? AND workspace_id = ?
        AND owner_token = ? AND lease_expires_at > ?
    `).run(taskId, scope.tenantId, scope.workspaceId, token, now)

    const run = getScopedN8nTaskRunByTaskId(db, taskId, scope)
    if (update.changes === 1) {
      return { outcome: kind === 'success' ? 'accepted' : 'failed', run }
    }
    return { outcome: classifySettledRun(run), run }
  })
  return settle.immediate()
}

export function settleN8nTaskDispatchSuccess(
  db: Database.Database,
  taskId: string,
  token: string,
  scope: N8nTaskScope,
  options: DispatchClockOptions = {},
): N8nTaskDispatchSettlement {
  return settleN8nTaskDispatch(db, taskId, token, scope, 'success', null, options)
}

export function settleN8nTaskDispatchFailure(
  db: Database.Database,
  taskId: string,
  token: string,
  error: string,
  scope: N8nTaskScope,
  options: DispatchClockOptions = {},
): N8nTaskDispatchSettlement {
  return settleN8nTaskDispatch(db, taskId, token, scope, 'failure', error, options)
}
