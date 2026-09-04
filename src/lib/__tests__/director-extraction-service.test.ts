import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import {
  drainDirectorEvidenceOutbox,
  getDirectorEvidenceOutbox,
} from '@/lib/director-evidence-outbox'
import {
  directorEvidenceBindingForResolvedWork,
  type DirectorCommandRunner,
} from '@/lib/director-evidence-delivery-core'
import {
  directorEvidenceFixtureItem,
  directorEvidenceFixtureProjectionResult,
} from '@/lib/__tests__/fixtures/director-evidence'
import {
  getDirectorExtractionCheckpoint,
  getDirectorExtractionJob,
  registerDirectorExtractionJob,
} from '@/lib/director-extraction-runs'
import { runNextDirectorExtractionPhase } from '@/lib/director-extraction-service'

const scope = { tenantId: 31, workspaceId: 41 }
const binding = directorEvidenceBindingForResolvedWork('WORK-SERVICE-001', 'service root chain')
const originalScope = {
  tenantId: process.env.MC_OPENCLAW_TENANT_ID,
  workspaceId: process.env.MC_OPENCLAW_WORKSPACE_ID,
}

function seed(db: Database.Database, taskId = 'service-source') {
  const output = {
    taskType: 'video-analysis',
    materialId: `MAT-${taskId}`,
    analysisVersion: 'video-analysis-v3',
    mediaDurationSeconds: 1,
    summary: '人物走进房间。',
    timeline: [{
      index: 1,
      timeRange: '00:00:00-00:00:01',
      visualAnalysis: '人物走进房间。',
      confidence: 0.9,
    }],
  }
  db.prepare(`
    INSERT INTO n8n_workflow_bindings (
      id, name, webhook_path, task_type, workspace_id, tenant_id
    ) VALUES (31, '视频分析', 'webhook/service-root', 'video-analysis', ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(scope.workspaceId, scope.tenantId)
  db.prepare(`
    INSERT INTO n8n_task_runs (
      task_id, idempotency_key, binding_id, status, source, requested_by,
      routing, input, delivery, output, attempt_count, max_attempts,
      workspace_id, tenant_id, completed_at, updated_at
    ) VALUES (?, ?, 31, 'succeeded', 'openclaw',
      'service-test', '{"taskType":"video-analysis"}', ?, '{"mode":"none"}',
      ?, 1, 1, ?, ?, 10, 10)
  `).run(
    taskId,
    `${taskId}-idem`,
    JSON.stringify({ directorEvidence: binding }),
    JSON.stringify(output),
    scope.workspaceId,
    scope.tenantId,
  )
  return registerDirectorExtractionJob(db, taskId, scope, { binding }).job
}

function evidenceRunner(
  beforeWrite?: () => void,
): DirectorCommandRunner {
  return async (command, input) => {
    if (command === 'transform') {
      return {
        workId: input.workId,
        items: [directorEvidenceFixtureItem(1, {
          '任务 ID': input.taskId,
          '素材 ID': input.materialId,
        })],
      }
    }
    if (command === 'project-evidence') {
      beforeWrite?.()
      return directorEvidenceFixtureProjectionResult(input)
    }
    throw new Error('unexpected_command')
  }
}

describe('director extraction service task-run chain', () => {
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

  it('keeps perception lease-free while the source evidence outbox is pending', async () => {
    const registered = seed(db)
    const result = await runNextDirectorExtractionPhase(db, { nowSeconds: 100 })
    expect(result).toEqual({ outcome: 'idle', job: null })
    expect(getDirectorExtractionJob(db, registered.sourceTaskId, scope)).toMatchObject({
      status: 'awaiting_evidence_projection', currentPhase: 'perception',
    })
    expect(getDirectorEvidenceOutbox(db, registered.sourceTaskId)).toMatchObject({
      taskId: registered.sourceTaskId,
      status: 'pending',
    })
    expect(db.prepare('SELECT COUNT(*) FROM n8n_child_execution_leases').pluck().get()).toBe(0)
    expect(db.prepare(`
      SELECT COUNT(*) FROM n8n_task_runs
      WHERE source = 'n8n-node' AND json_extract(input, '$.childKind') = 'director-extraction'
        AND status = 'running'
    `).pluck().get()).toBe(0)
  })

  it('prepares the complete claim window before selecting the twenty-first job', async () => {
    const jobs = Array.from({ length: 21 }, (_, index) => (
      seed(db, `service-window-${String(index + 1).padStart(2, '0')}`)
    ))

    await expect(runNextDirectorExtractionPhase(db, { nowSeconds: 100 }))
      .resolves.toEqual({ outcome: 'idle', job: null })
    expect(db.prepare('SELECT COUNT(*) FROM n8n_director_evidence_outbox').pluck().get())
      .toBe(21)
    expect(db.prepare(`
      SELECT COUNT(*) FROM n8n_task_runs
      WHERE source = 'n8n-node' AND json_extract(input, '$.childKind') = 'director-extraction'
        AND (status = 'failed' OR attempt_count <> 0)
    `).pluck().get()).toBe(0)
    expect(db.prepare('SELECT COUNT(*) FROM n8n_child_execution_leases').pluck().get()).toBe(0)
    expect(jobs.map(job => getDirectorExtractionJob(db, job.sourceTaskId, scope)?.status))
      .toEqual(Array(21).fill('awaiting_evidence_projection'))
  })

  it('replays a completed start tool without duplicating root, queue, or outbox side effects', async () => {
    const registered = seed(db)
    const firstServicePass = await runNextDirectorExtractionPhase(db, { nowSeconds: 100 })
    expect(firstServicePass.outcome).toBe('idle')

    // Model failure happens after the start tool returned. The same user turn is
    // replayed against the durable service instead of trusting transcript state.
    const replay = registerDirectorExtractionJob(db, 'service-source', scope, { binding })
    expect(replay.created).toBe(false)
    expect(replay.job.sourceTaskId).toBe(registered.sourceTaskId)
    const secondServicePass = await runNextDirectorExtractionPhase(db, { nowSeconds: 101 })
    expect(secondServicePass.outcome).toBe('idle')

    expect(db.prepare(`
      SELECT COUNT(*) FROM n8n_task_runs WHERE source = 'director-extraction-root'
    `).pluck().get()).toBe(0)
    expect(db.prepare(`
      SELECT COUNT(*) FROM n8n_task_runs
      WHERE source = 'n8n-node' AND json_extract(input, '$.childKind') = 'director-extraction'
    `).pluck().get()).toBe(1)
    expect(db.prepare('SELECT COUNT(*) FROM n8n_director_evidence_outbox').pluck().get()).toBe(1)

    expect(() => registerDirectorExtractionJob(db, 'service-source', scope, {
      binding,
      objective: '改为提炼空间结构',
    })).toThrow('director_extraction_objective_conflict')
    expect(db.prepare(`
      SELECT COUNT(*) FROM n8n_task_runs WHERE source = 'director-extraction-root'
    `).pluck().get()).toBe(0)
    expect(db.prepare(`
      SELECT COUNT(*) FROM n8n_task_runs
      WHERE source = 'n8n-node' AND json_extract(input, '$.childKind') = 'director-extraction'
    `).pluck().get()).toBe(1)
    expect(db.prepare('SELECT COUNT(*) FROM n8n_director_evidence_outbox').pluck().get()).toBe(1)
  })

  it('requires the immutable perception checkpoint before evidence write and derives review wait from receipts', async () => {
    const registered = seed(db)
    await runNextDirectorExtractionPhase(db, { nowSeconds: 100 })
    let checkpointObserved = false
    expect(await drainDirectorEvidenceOutbox(db, {
      nowSeconds: 101,
      runner: evidenceRunner(() => {
        const checkpoint = getDirectorExtractionCheckpoint(db, registered.sourceTaskId, 'perception')
        checkpointObserved = Boolean(checkpoint && checkpoint.projectionState === 'pending')
      }),
    })).toEqual({ scanned: 1, delivered: 1, pending: 0, conflict: 0 })
    expect(checkpointObserved).toBe(true)

    const result = await runNextDirectorExtractionPhase(db, { nowSeconds: 102 })
    expect(result).toMatchObject({
      outcome: 'awaiting_review',
      job: { status: 'awaiting_evidence_review', currentPhase: 'perception' },
    })
    expect(getDirectorExtractionCheckpoint(db, registered.sourceTaskId, 'perception'))
      .toMatchObject({ projectionState: 'delivered' })
    expect(getDirectorExtractionJob(db, registered.sourceTaskId, scope)).toMatchObject({
      status: 'awaiting_evidence_review',
    })
    expect(db.prepare('SELECT COUNT(*) FROM n8n_child_execution_leases').pluck().get()).toBe(0)
  })
})
