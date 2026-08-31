// @vitest-environment node

import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { createN8nTaskRun, getScopedN8nTaskRunByTaskId } from '@/lib/n8n-task-runs'
import {
  acquireN8nTaskDispatchOwnership,
  settleN8nTaskDispatchFailure,
  settleN8nTaskDispatchSuccess,
} from '@/lib/n8n-task-dispatch'

const scope = { tenantId: 3, workspaceId: 2 }
const cleanup: Array<() => void> = []

function databasePair(): [Database.Database, Database.Database] {
  const root = mkdtempSync(join(tmpdir(), 'n8n-task-dispatch-'))
  const path = join(root, 'mission-control.db')
  const first = new Database(path)
  first.pragma('journal_mode = WAL')
  first.pragma('foreign_keys = ON')
  first.pragma('busy_timeout = 1000')
  runMigrations(first)
  const second = new Database(path)
  second.pragma('journal_mode = WAL')
  second.pragma('foreign_keys = ON')
  second.pragma('busy_timeout = 1000')
  cleanup.push(() => {
    second.close()
    first.close()
    rmSync(root, { recursive: true, force: true })
  })
  return [first, second]
}

function createQueuedRun(db: Database.Database, taskId: string): void {
  createN8nTaskRun(db, {
    taskId,
    idempotencyKey: taskId,
    bindingId: 1,
    source: 'openclaw',
    requestedBy: 'operator',
    routing: { taskType: 'video-analysis' },
    taskInput: { prompt: 'test' },
    delivery: { mode: 'none' },
    maxAttempts: 2,
  }, scope)
}

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.()
})

describe('n8n task webhook dispatch ownership', () => {
  it('creates the additive dispatch lease schema through migration 054', () => {
    const [db] = databasePair()
    expect(db.prepare(`
      SELECT id FROM schema_migrations WHERE id = '054_n8n_task_dispatch_leases'
    `).get()).toEqual({ id: '054_n8n_task_dispatch_leases' })
  })

  it('allows only one of two database connections to own the same queued dispatch', () => {
    const [first, second] = databasePair()
    createQueuedRun(first, 'dispatch-concurrent')
    const firstToken = 'a'.repeat(64)

    expect(acquireN8nTaskDispatchOwnership(first, 'dispatch-concurrent', scope, {
      token: firstToken,
      nowSeconds: 1_000,
    })).toMatchObject({ outcome: 'acquired', token: firstToken, revision: 1 })
    expect(acquireN8nTaskDispatchOwnership(second, 'dispatch-concurrent', scope, {
      token: 'b'.repeat(64),
      nowSeconds: 1_001,
    })).toMatchObject({
      outcome: 'in_progress', token: null, revision: 1, leaseExpiresAt: 1_180,
    })
    expect(second.prepare(`
      SELECT owner_token, revision FROM n8n_task_dispatch_leases WHERE task_id = ?
    `).get('dispatch-concurrent')).toEqual({ owner_token: firstToken, revision: 1 })
  })

  it('fences a late failed owner after expiry takeover and lets only the new owner accept', () => {
    const [first, second] = databasePair()
    createQueuedRun(first, 'dispatch-takeover')
    const oldToken = 'c'.repeat(64)
    const newToken = 'd'.repeat(64)
    acquireN8nTaskDispatchOwnership(first, 'dispatch-takeover', scope, {
      token: oldToken,
      nowSeconds: 2_000,
    })
    expect(acquireN8nTaskDispatchOwnership(second, 'dispatch-takeover', scope, {
      token: newToken,
      nowSeconds: 2_180,
    })).toMatchObject({ outcome: 'acquired', token: newToken, revision: 2 })

    expect(settleN8nTaskDispatchFailure(
      first, 'dispatch-takeover', oldToken, 'late failure', scope, { nowSeconds: 2_181 },
    )).toMatchObject({ outcome: 'stale', run: { status: 'queued' } })
    expect(getScopedN8nTaskRunByTaskId(second, 'dispatch-takeover', scope)?.status).toBe('queued')

    expect(settleN8nTaskDispatchSuccess(
      second, 'dispatch-takeover', newToken, scope, { nowSeconds: 2_182 },
    )).toMatchObject({ outcome: 'accepted', run: { status: 'accepted' } })
    expect(first.prepare(`
      SELECT COUNT(*) AS count FROM n8n_task_dispatch_leases WHERE task_id = ?
    `).get('dispatch-takeover')).toEqual({ count: 0 })
  })

  it('fences a late successful owner while the replacement owner records failure', () => {
    const [first, second] = databasePair()
    createQueuedRun(first, 'dispatch-success-late')
    const oldToken = '1'.repeat(64)
    const newToken = '2'.repeat(64)
    acquireN8nTaskDispatchOwnership(first, 'dispatch-success-late', scope, {
      token: oldToken,
      nowSeconds: 2_500,
    })
    acquireN8nTaskDispatchOwnership(second, 'dispatch-success-late', scope, {
      token: newToken,
      nowSeconds: 2_680,
    })

    expect(settleN8nTaskDispatchSuccess(
      first, 'dispatch-success-late', oldToken, scope, { nowSeconds: 2_681 },
    )).toMatchObject({ outcome: 'stale', run: { status: 'queued' } })
    expect(settleN8nTaskDispatchFailure(
      second, 'dispatch-success-late', newToken, 'replacement rejected', scope,
      { nowSeconds: 2_682 },
    )).toMatchObject({
      outcome: 'failed',
      run: { status: 'failed', error: 'replacement rejected' },
    })
  })

  it('never fails a task that the n8n claim callback has already moved to running', () => {
    const [first, second] = databasePair()
    createQueuedRun(first, 'dispatch-claimed')
    const token = 'e'.repeat(64)
    acquireN8nTaskDispatchOwnership(first, 'dispatch-claimed', scope, {
      token,
      nowSeconds: 3_000,
    })
    second.prepare(`
      UPDATE n8n_task_runs
      SET status = 'running', started_at = 3001, updated_at = 3001
      WHERE task_id = ? AND tenant_id = ? AND workspace_id = ? AND status = 'queued'
    `).run('dispatch-claimed', scope.tenantId, scope.workspaceId)

    expect(settleN8nTaskDispatchFailure(
      first, 'dispatch-claimed', token, 'response lost', scope, { nowSeconds: 3_002 },
    )).toMatchObject({ outcome: 'claimed', run: { status: 'running' } })
    expect(first.prepare(`
      SELECT COUNT(*) AS count FROM n8n_task_dispatch_leases WHERE task_id = ?
    `).get('dispatch-claimed')).toEqual({ count: 0 })
  })
})
