import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import {
  drainN8nMediaCleanupDebts,
  getN8nMediaCleanupDebt,
  listDueN8nMediaCleanupDebts,
  retryN8nMediaCleanupDebt,
} from '@/lib/n8n-media-cleanup'
import { mediaTaskWorkspace } from '@/lib/n8n-media-execution'
import {
  claimN8nTaskRun,
  completeN8nFinalizeRun,
  createN8nMediaChildRunFromParent,
  createN8nTaskRun,
  getN8nTaskRunByTaskId,
  markN8nTaskAccepted,
  reconcileScopedN8nVideoTaskRun,
} from '@/lib/n8n-task-runs'
import {
  createN8nWorkflowBinding,
  n8nWorkflowBindingInputSchema,
} from '@/lib/n8n-workflows'

describe('durable n8n media cleanup debts', () => {
  let db: Database.Database
  let root: string
  const scope = { workspaceId: 2, tenantId: 3 }
  let bindingId = 0

  beforeEach(async () => {
    db = new Database(':memory:')
    runMigrations(db)
    bindingId = createN8nWorkflowBinding(db, n8nWorkflowBindingInputSchema.parse({
      name: '媒体清理债务测试链',
      webhookPath: 'webhook/media-cleanup-debt-test',
      taskType: 'video-analysis',
    }), 'tester', scope).id
    root = await mkdtemp(join(tmpdir(), 'aiworker-media-cleanup-debt-'))
    process.env.AIWORKER_MEDIA_WORK_DIR = join(root, 'work')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    db.close()
    delete process.env.AIWORKER_MEDIA_WORK_DIR
    await rm(root, { recursive: true, force: true })
  })

  function createFinalizePair(taskId: string) {
    const idempotencyKey = `${taskId}-idem`
    createN8nTaskRun(db, {
      taskId,
      idempotencyKey,
      bindingId,
      source: 'openclaw',
      requestedBy: 'tester',
      routing: { taskType: 'video-analysis' },
      taskInput: {},
      delivery: { mode: 'none' },
      maxAttempts: 2,
    }, scope)
    markN8nTaskAccepted(db, taskId)
    const child = createN8nMediaChildRunFromParent(db, {
      parentTaskId: taskId,
      parentIdempotencyKey: idempotencyKey,
      stage: 'finalize',
      taskInput: {},
    }).child!
    markN8nTaskAccepted(db, child.taskId)
    claimN8nTaskRun(db, child.taskId)
    return child.taskId
  }

  async function createBoundWorkspace(taskId: string) {
    const workspace = mediaTaskWorkspace(taskId)
    await mkdir(workspace, { recursive: true, mode: 0o700 })
    await writeFile(join(workspace, 'metadata.json'), JSON.stringify({
      taskId,
      kind: 'prepared-video',
    }), { mode: 0o600 })
    await writeFile(join(workspace, 'payload.tmp'), 'temporary-media-data')
    return workspace
  }

  it('creates cleanup debt atomically with a successful finalize and clears it only after deletion', async () => {
    const taskId = 'video-cleanup-success'
    const childTaskId = createFinalizePair(taskId)
    const workspace = await createBoundWorkspace(taskId)

    expect(completeN8nFinalizeRun(db, {
      parentTaskId: taskId,
      childTaskId,
      output: { summary: 'durable result' },
    })).toMatchObject({ outcome: 'completed', parent: { status: 'succeeded' } })
    expect(getN8nMediaCleanupDebt(db, taskId)).toMatchObject({
      taskId,
      bindingId,
      workspaceId: scope.workspaceId,
      tenantId: scope.tenantId,
      reason: 'finalize_succeeded',
      attemptCount: 0,
    })

    await expect(retryN8nMediaCleanupDebt(db, taskId, { force: true }))
      .resolves.toMatchObject({ outcome: 'cleaned', debt: null })
    await expect(stat(workspace)).rejects.toThrow()
    expect(getN8nMediaCleanupDebt(db, taskId)).toBeNull()
    expect(getN8nTaskRunByTaskId(db, taskId)).toMatchObject({
      status: 'succeeded', output: { summary: 'durable result' },
    })
  })

  it('does not commit a successful finalize when its durable cleanup obligation cannot be recorded', () => {
    const taskId = 'video-cleanup-atomic-debt'
    const childTaskId = createFinalizePair(taskId)
    db.exec('DROP TABLE n8n_media_cleanup_debts')

    expect(() => completeN8nFinalizeRun(db, {
      parentTaskId: taskId,
      childTaskId,
      output: { summary: 'must remain uncommitted' },
    })).toThrow(/n8n_media_cleanup_debts/)
    expect(getN8nTaskRunByTaskId(db, taskId)?.status).toBe('accepted')
    expect(getN8nTaskRunByTaskId(db, childTaskId)?.status).toBe('running')
  })

  it('persists consecutive cleanup failures and lets the due-debt janitor clear them later', async () => {
    const taskId = 'video-cleanup-retry'
    const childTaskId = createFinalizePair(taskId)
    const workspace = await createBoundWorkspace(taskId)
    completeN8nFinalizeRun(db, {
      parentTaskId: taskId,
      childTaskId,
      output: { summary: 'keep success' },
    })
    const failingCleanup = vi.fn().mockRejectedValue(new Error('filesystem busy'))

    await expect(retryN8nMediaCleanupDebt(db, taskId, {
      force: true, nowSeconds: 100, cleanup: failingCleanup,
    })).resolves.toMatchObject({ outcome: 'pending', debt: { attemptCount: 1 } })
    await expect(retryN8nMediaCleanupDebt(db, taskId, {
      force: true, nowSeconds: 200, cleanup: failingCleanup,
    })).resolves.toMatchObject({ outcome: 'pending', debt: { attemptCount: 2 } })
    expect(getN8nMediaCleanupDebt(db, taskId)).toMatchObject({
      attemptCount: 2,
      lastError: 'filesystem busy',
      nextAttemptAt: 320,
    })
    expect(getN8nTaskRunByTaskId(db, taskId)?.status).toBe('succeeded')
    await expect(readFile(join(workspace, 'payload.tmp'), 'utf8')).resolves.toBe('temporary-media-data')

    expect(listDueN8nMediaCleanupDebts(db, { nowSeconds: 319 })).toEqual([])
    await expect(drainN8nMediaCleanupDebts(db, { nowSeconds: 320 }))
      .resolves.toEqual({ scanned: 1, cleaned: 1, pending: 0, rejected: 0 })
    expect(getN8nMediaCleanupDebt(db, taskId)).toBeNull()
    await expect(stat(workspace)).rejects.toThrow()
    expect(getN8nTaskRunByTaskId(db, taskId)?.status).toBe('succeeded')
  })

  it('creates a hard-lease cleanup debt, cleans it, and fences a late finalize callback', async () => {
    const taskId = 'video-cleanup-hard-lease'
    const childTaskId = createFinalizePair(taskId)
    const workspace = await createBoundWorkspace(taskId)
    db.prepare(`UPDATE n8n_task_runs SET started_at = 100, updated_at = 100 WHERE task_id = ?`)
      .run(childTaskId)

    expect(reconcileScopedN8nVideoTaskRun(db, taskId, scope, {
      nowSeconds: 1_000,
      finalizeLeaseSeconds: 900,
    })).toMatchObject({
      outcome: 'reconciled',
      code: 'VIDEO_FINALIZE_LEASE_EXPIRED',
      run: { status: 'failed' },
    })
    expect(getN8nMediaCleanupDebt(db, taskId)).toMatchObject({
      reason: 'finalize_lease_expired', attemptCount: 0,
    })
    expect(completeN8nFinalizeRun(db, {
      parentTaskId: taskId,
      childTaskId,
      output: { summary: 'late result' },
    })).toMatchObject({ outcome: 'terminal', parent: { status: 'failed' } })
    expect(getN8nMediaCleanupDebt(db, taskId)).toMatchObject({ reason: 'finalize_lease_expired' })

    await expect(retryN8nMediaCleanupDebt(db, taskId, { force: true }))
      .resolves.toMatchObject({ outcome: 'cleaned' })
    await expect(stat(workspace)).rejects.toThrow()
    expect(getN8nTaskRunByTaskId(db, taskId)).toMatchObject({
      status: 'failed', error: expect.stringContaining('VIDEO_FINALIZE_LEASE_EXPIRED'),
    })
  })

  it('rejects a tampered digest or wrong binding without invoking filesystem cleanup', async () => {
    const taskId = 'video-cleanup-tampered'
    const childTaskId = createFinalizePair(taskId)
    completeN8nFinalizeRun(db, {
      parentTaskId: taskId,
      childTaskId,
      output: { summary: 'durable result' },
    })
    const cleanup = vi.fn().mockResolvedValue(undefined)

    db.prepare(`UPDATE n8n_media_cleanup_debts SET workspace_digest = ? WHERE task_id = ?`)
      .run('0'.repeat(64), taskId)
    await expect(retryN8nMediaCleanupDebt(db, taskId, {
      force: true, nowSeconds: 100, cleanup,
    })).resolves.toMatchObject({
      outcome: 'rejected',
      error: expect.stringContaining('摘要不匹配'),
      debt: { attemptCount: 1 },
    })
    expect(cleanup).not.toHaveBeenCalled()

    db.prepare(`
      UPDATE n8n_media_cleanup_debts
      SET workspace_digest = ?, binding_id = ?, next_attempt_at = 0
      WHERE task_id = ?
    `).run(createHash('sha256').update(taskId).digest('hex'), bindingId + 999, taskId)
    await expect(retryN8nMediaCleanupDebt(db, taskId, {
      force: true, nowSeconds: 200, cleanup,
    })).resolves.toMatchObject({
      outcome: 'rejected',
      error: expect.stringContaining('父任务不匹配'),
      debt: { attemptCount: 2 },
    })
    expect(cleanup).not.toHaveBeenCalled()
    expect(getN8nTaskRunByTaskId(db, taskId)?.status).toBe('succeeded')
  })
})
