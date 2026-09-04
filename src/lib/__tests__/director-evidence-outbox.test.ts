import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import {
  directorEvidenceProjectionContractDigest,
  directorCommandTimeoutMs,
  drainDirectorEvidenceOutbox,
  enqueueDirectorEvidenceOutbox,
  getDirectorEvidenceOutbox,
} from '@/lib/director-evidence-outbox'
import {
  directorEvidenceBindingForResolvedWork,
  directorEvidenceDigest,
  getDirectorEvidenceProjectionReceiptCore,
  type DirectorCommandRunner,
} from '@/lib/director-evidence-delivery-core'
import {
  directorEvidenceFixtureItem,
  directorEvidenceFixtureProjectionResult,
  persistDirectorEvidenceFixtureReceipt,
}
  from '@/lib/__tests__/fixtures/director-evidence'
import { registerDirectorExtractionJob } from '@/lib/director-extraction-runs'
import { getN8nTaskRunByTaskId } from '@/lib/n8n-task-runs'

const scope = { tenantId: 22, workspaceId: 33 }
const binding = directorEvidenceBindingForResolvedWork('WORK-OUTBOX-001', 'root outbox')
const originalScope = {
  tenantId: process.env.MC_OPENCLAW_TENANT_ID,
  workspaceId: process.env.MC_OPENCLAW_WORKSPACE_ID,
}

function output(summary = '人物进入空间。') {
  return {
    taskType: 'video-analysis',
    materialId: 'MAT-OUTBOX-001',
    analysisVersion: 'video-analysis-v3',
    mediaDurationSeconds: 1,
    summary,
    timeline: [{
      index: 1,
      timeRange: '00:00:00-00:00:01',
      visualAnalysis: summary,
      confidence: 0.9,
    }],
  }
}

function seedRoot(db: Database.Database) {
  db.prepare(`
    INSERT INTO n8n_workflow_bindings (
      id, name, webhook_path, task_type, workspace_id, tenant_id
    ) VALUES (22, '视频分析', 'webhook/outbox', 'video-analysis', ?, ?)
  `).run(scope.workspaceId, scope.tenantId)
  db.prepare(`
    INSERT INTO n8n_task_runs (
      task_id, idempotency_key, binding_id, status, source, requested_by,
      routing, input, delivery, output, attempt_count, max_attempts,
      workspace_id, tenant_id, completed_at, updated_at
    ) VALUES ('video-outbox-source', 'video-outbox-source-idem', 22, 'succeeded',
      'openclaw', 'outbox-test', '{"taskType":"video-analysis"}', ?,
      '{"mode":"none"}', ?, 1, 1, ?, ?, 10, 10)
  `).run(JSON.stringify({ directorEvidence: binding }), JSON.stringify(output()), scope.workspaceId, scope.tenantId)
  const registered = registerDirectorExtractionJob(
    db, 'video-outbox-source', scope, { binding },
  )
  return {
    root: getN8nTaskRunByTaskId(db, registered.job.sourceTaskId)!,
    sourceTaskId: registered.job.sourceTaskId,
  }
}

function runner(calls: Array<{ command: string; input: Record<string, unknown> }>): DirectorCommandRunner {
  return async (command, input) => {
    calls.push({ command, input })
    if (command === 'transform') {
      return {
        workId: input.workId,
        items: [directorEvidenceFixtureItem(1, {
          '任务 ID': input.taskId,
          '素材 ID': input.materialId,
        })],
      }
    }
    if (command === 'project-evidence') return directorEvidenceFixtureProjectionResult(input)
    throw new Error('unexpected_command')
  }
}

describe('director evidence root outbox', () => {
  let db: Database.Database

  beforeEach(() => {
    process.env.MC_OPENCLAW_TENANT_ID = String(scope.tenantId)
    process.env.MC_OPENCLAW_WORKSPACE_ID = String(scope.workspaceId)
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
    if (originalScope.tenantId === undefined) delete process.env.MC_OPENCLAW_TENANT_ID
    else process.env.MC_OPENCLAW_TENANT_ID = originalScope.tenantId
    if (originalScope.workspaceId === undefined) delete process.env.MC_OPENCLAW_WORKSPACE_ID
    else process.env.MC_OPENCLAW_WORKSPACE_ID = originalScope.workspaceId
  })

  it('scales only bounded propose batches beyond the default operate timeout', () => {
    expect(directorCommandTimeoutMs('operate', { action: 'get', table: 'works' }))
      .toBe(30_000)
    expect(directorCommandTimeoutMs('propose-batch', {
      action: 'propose_batch',
      items: Array.from({ length: 8 }, () => ({})),
    })).toBe(150_000)
    expect(directorCommandTimeoutMs('propose-batch', {
      action: 'propose_batch',
      items: Array.from({ length: 50 }, () => ({})),
    })).toBe(180_000)
  })

  it('uses the successful video task directly as the immutable outbox authority', async () => {
    const { root, sourceTaskId } = seedRoot(db)
    expect(enqueueDirectorEvidenceOutbox(db, root, 100)).toBe('created')
    expect(enqueueDirectorEvidenceOutbox(db, root, 101)).toBe('existing')
    const item = getDirectorEvidenceOutbox(db, root.taskId)!
    expect(item).toMatchObject({
      taskId: root.taskId,
      bindingId: root.bindingId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      workId: binding.workId,
      queryDigest: binding.queryDigest,
      resultSha256: directorEvidenceDigest(output()),
      projectionContractDigest: directorEvidenceProjectionContractDigest(),
      status: 'pending',
    })
    expect(getDirectorEvidenceOutbox(db, sourceTaskId)).toMatchObject({ taskId: sourceTaskId })
    expect(db.prepare(`
      SELECT binding_id, tenant_id, workspace_id, work_id, query_digest
      FROM n8n_director_evidence_outbox WHERE task_id = ?
    `).get(root.taskId)).toEqual({
      binding_id: root.bindingId,
      tenant_id: scope.tenantId,
      workspace_id: scope.workspaceId,
      work_id: binding.workId,
      query_digest: binding.queryDigest,
    })

    const calls: Array<{ command: string; input: Record<string, unknown> }> = []
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 101, runner: runner(calls) }))
      .toEqual({ scanned: 1, delivered: 1, pending: 0, conflict: 0 })
    expect(calls[0]).toMatchObject({ command: 'transform', input: { taskId: sourceTaskId } })
    const delivered = getDirectorEvidenceOutbox(db, root.taskId)!
    expect(delivered.status).toBe('delivered')
    expect(getDirectorEvidenceProjectionReceiptCore(db, delivered)?.receipt.workId)
      .toBe(binding.workId)
  })

  it('fails closed without external writes when the source output drifts', async () => {
    const { root, sourceTaskId } = seedRoot(db)
    enqueueDirectorEvidenceOutbox(db, root, 100)
    db.prepare('UPDATE n8n_task_runs SET output = ? WHERE task_id = ?')
      .run(JSON.stringify(output('被篡改的结果')), sourceTaskId)
    const calls: Array<{ command: string; input: Record<string, unknown> }> = []
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 101, runner: runner(calls) }))
      .toEqual({ scanned: 1, delivered: 0, pending: 0, conflict: 1 })
    expect(calls).toHaveLength(0)
    expect(getDirectorEvidenceOutbox(db, root.taskId)).toMatchObject({
      status: 'conflict',
      lastErrorCode: 'director_evidence_authority_conflict',
    })
  })

  it('idempotently accepts the successful video task as the only outbox owner', () => {
    const { root, sourceTaskId } = seedRoot(db)
    const source = getN8nTaskRunByTaskId(db, sourceTaskId)!
    expect(enqueueDirectorEvidenceOutbox(db, source, 100)).toBe('created')
    expect(enqueueDirectorEvidenceOutbox(db, source, 101)).toBe('existing')
    expect(getDirectorEvidenceOutbox(db, root.taskId)).toMatchObject({ taskId: sourceTaskId })
  })

  it('settles concurrent delivery replays once without leaking a unique-key error', async () => {
    db.close()
    const directory = mkdtempSync(join(tmpdir(), 'director-outbox-'))
    const pathname = join(directory, 'outbox.sqlite')
    const first = new Database(pathname)
    const second = new Database(pathname)
    try {
      for (const connection of [first, second]) {
        connection.pragma('foreign_keys = ON')
        connection.pragma('journal_mode = WAL')
        connection.pragma('busy_timeout = 5000')
      }
      runMigrations(first)
      const { root } = seedRoot(first)
      enqueueDirectorEvidenceOutbox(first, root, 100)
      let transforms = 0
      let releaseTransforms: (() => void) | undefined
      const bothSelected = new Promise<void>(resolve => { releaseTransforms = resolve })
      const concurrentRunner: DirectorCommandRunner = async (command, input) => {
        if (command === 'transform') {
          transforms++
          if (transforms === 2) releaseTransforms?.()
          await bothSelected
          return {
            workId: input.workId,
            items: [directorEvidenceFixtureItem(1, {
              '任务 ID': input.taskId,
              '素材 ID': input.materialId,
            })],
          }
        }
        if (command === 'project-evidence') return directorEvidenceFixtureProjectionResult(input)
        throw new Error('unexpected_command')
      }
      const outcomes = await Promise.all([
        drainDirectorEvidenceOutbox(first, { nowSeconds: 101, runner: concurrentRunner }),
        drainDirectorEvidenceOutbox(second, { nowSeconds: 101, runner: concurrentRunner }),
      ])
      expect(outcomes).toEqual([
        { scanned: 1, delivered: 1, pending: 0, conflict: 0 },
        { scanned: 1, delivered: 1, pending: 0, conflict: 0 },
      ])
      expect(getDirectorEvidenceOutbox(first, root.taskId)?.status).toBe('delivered')
      expect(first.prepare(`
        SELECT COUNT(*) FROM n8n_director_evidence_projection_receipts WHERE task_id = ?
      `).pluck().get(root.taskId)).toBe(1)
    } finally {
      first.close()
      second.close()
      rmSync(directory, { recursive: true, force: true })
      db = new Database(':memory:')
    }
  })

  it('makes recovered delivered receipts idempotent and rejects a different receipt', () => {
    const { root, sourceTaskId } = seedRoot(db)
    enqueueDirectorEvidenceOutbox(db, root, 100)
    db.prepare(`
      UPDATE n8n_director_evidence_outbox
      SET status = 'delivered', delivered_at = 101, updated_at = 101
      WHERE task_id = ?
    `).run(root.taskId)
    const item = getDirectorEvidenceOutbox(db, root.taskId)!
    const evidence = [directorEvidenceFixtureItem(1, {
      '任务 ID': sourceTaskId,
      '素材 ID': output().materialId,
    })]
    const first = persistDirectorEvidenceFixtureReceipt(db, item, evidence, 102)
    const replay = persistDirectorEvidenceFixtureReceipt(db, item, evidence, 103)
    expect(replay.receiptSha256).toBe(first.receiptSha256)
    expect(() => persistDirectorEvidenceFixtureReceipt(db, item, [
      directorEvidenceFixtureItem(2, {
        '任务 ID': sourceTaskId,
        '素材 ID': output().materialId,
      }),
    ], 104)).toThrow('director_evidence_projection_receipt_conflict')
  })
})
