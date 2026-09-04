import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import {
  claimNextDirectorExtractionJob,
  completeDirectorExtractionProjection,
  directorExtractionPhaseTaskIdentity,
  failDirectorExtractionPhase,
  failDirectorExtractionReview,
  getDirectorExtractionCheckpoint,
  getDirectorExtractionJob,
  listDirectorExtractionJobsByStatuses,
  listDirectorExtractionJobsForWork,
  registerDirectorExtractionJob,
  retryExhaustedDirectorExtractionJob,
  renewDirectorExtractionLease,
  resumeDirectorExtractionAfterIntent,
  resumeDirectorExtractionAfterReview,
  stageDirectorExtractionCheckpoint,
} from '@/lib/director-extraction-runs'
import {
  directorEvidenceBindingForResolvedWork,
  directorEvidenceDigest,
} from '@/lib/director-evidence-delivery-core'
import { directorEvidenceProjectionContractDigest } from '@/lib/director-evidence-outbox'
import {
  backfillDirectorExtractionForWork,
  getDirectorExtractionStatusForWork,
  resolveDirectorExtractionSourceTaskId,
  startDirectorExtractionForWork,
} from '@/lib/director-extraction-application'
import { createDeterministicDirectorExtractionFixtureRunner } from '@/lib/__tests__/fixtures/director-extraction'
import type { DirectorExtractionProjectionReceipt } from '@/lib/director-extraction-state'

const scope = { tenantId: 73, workspaceId: 37 }
const binding = directorEvidenceBindingForResolvedWork('WORK-SINGLE-CHAIN-001', '单链测试')
const originalScope = {
  tenantId: process.env.MC_OPENCLAW_TENANT_ID,
  workspaceId: process.env.MC_OPENCLAW_WORKSPACE_ID,
}

function videoOutput(materialId: string) {
  return {
    taskType: 'video-analysis', materialId, analysisVersion: 'video-analysis-v3',
    mediaDurationSeconds: 12, summary: '人物在环境变化后调整行动。',
    timeline: [{ index: 1, timeRange: '00:00:00-00:00:12', visualAnalysis: '人物进入空间。', confidence: 0.9 }],
  }
}

function seedSource(
  db: Database.Database,
  taskId = 'video-source-single-chain',
  workBinding = binding,
  source = 'openclaw',
) {
  db.prepare(`
    INSERT OR IGNORE INTO n8n_workflow_bindings (
      id, name, webhook_path, task_type, workspace_id, tenant_id
    ) VALUES (73, '视频分析', 'webhook/single-chain', 'video-analysis', ?, ?)
  `).run(scope.workspaceId, scope.tenantId)
  db.prepare(`
    INSERT INTO n8n_task_runs (
      task_id, idempotency_key, binding_id, status, source, requested_by,
      routing, input, delivery, output, attempt_count, max_attempts,
      workspace_id, tenant_id, completed_at, updated_at
    ) VALUES (?, ?, 73, 'succeeded', ?, 'single-chain-test',
      '{"taskType":"video-analysis"}', ?, '{"mode":"none"}', ?, 1, 1, ?, ?, 10, 10)
  `).run(
    taskId, `${taskId}-idem`, source, JSON.stringify({ directorEvidence: workBinding }),
    JSON.stringify(videoOutput(`MAT-${taskId}`)), scope.workspaceId, scope.tenantId,
  )
  return taskId
}

function receipt(
  phase: 'perception' | 'understanding' | 'judgment' | 'case' | 'technique',
): DirectorExtractionProjectionReceipt {
  const entries: DirectorExtractionProjectionReceipt['entries'] = phase === 'perception'
    ? [{ candidateKey: 'evidence-001', kind: 'material_observation', table: 'material_evidence', stableId: 'EVIDENCE-001', startSeconds: 0, endSeconds: 12 }]
    : phase === 'understanding'
      ? [{ candidateKey: 'story-001', kind: 'story_node', table: 'story_nodes', stableId: 'STORY-001' }]
      : phase === 'judgment'
        ? [
            { candidateKey: 'relation-001', kind: 'story_relation', table: 'story_relations', stableId: 'RELATION-001' },
            { candidateKey: 'judgment-001', kind: 'material_judgment', table: 'material_judgments', stableId: 'JUDGMENT-001' },
            { candidateKey: 'narrative-001', kind: 'narrative_proposal', table: 'narrative_plans', stableId: 'NARRATIVE-001' },
          ]
        : phase === 'case'
          ? [{ candidateKey: 'case-001', kind: 'director_case', table: 'director_cases', stableId: 'CASE-001' }]
          : [{ candidateKey: 'technique-001', kind: 'technique', table: 'skills_techniques', stableId: 'TECHNIQUE-001' }]
  return { schemaVersion: 1 as const, phase, entries }
}

async function completeCurrent(db: Database.Database, now: number) {
  const job = claimNextDirectorExtractionJob(db, {
    nowSeconds: now, ownerInstanceId: '1'.repeat(64), leaseToken: `${now}`.padStart(64, '0'),
  })!
  db.prepare(`
    INSERT OR IGNORE INTO n8n_director_evidence_outbox (
      task_id, binding_id, tenant_id, workspace_id, work_id, query_digest,
      projection_contract_digest, idempotency_key, result_sha256, status, delivered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', ?)
  `).run(
    job.sourceTaskId,
    job.sourceBindingId,
    job.tenantId,
    job.workspaceId,
    job.workId,
    job.workQueryDigest,
    directorEvidenceProjectionContractDigest(),
    directorEvidenceDigest({ taskId: job.sourceTaskId, projection: 'runs-test' }),
    job.sourceResultSha256,
    now,
  )
  if (job.currentPhase === 'complete') throw new Error('test_director_extraction_phase_complete')
  if (job.currentPhase !== 'perception') {
    const phaseInput = {
      schemaVersion: 1,
      phase: job.currentPhase,
      evidence: { materialId: job.materialId, mediaDurationSeconds: 12 },
    }
    const candidateOutput = await createDeterministicDirectorExtractionFixtureRunner()(
      job.currentPhase, phaseInput, job,
    )
    stageDirectorExtractionCheckpoint(
      db, job, phaseInput, candidateOutput,
      { nowSeconds: now },
    )
  }
  return completeDirectorExtractionProjection(db, job, receipt(job.currentPhase), { nowSeconds: now + 1 })
}

describe('director extraction source-child task chain', () => {
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

  it('keeps the successful video task as the only root and registers one deterministic queued child', () => {
    const sourceTaskId = seedSource(db)
    const before = db.prepare('SELECT input, output FROM n8n_task_runs WHERE task_id = ?').get(sourceTaskId)
    const result = registerDirectorExtractionJob(db, sourceTaskId, scope, { objective: '提炼人物变化' })
    const child = db.prepare('SELECT source, status, routing, input FROM n8n_task_runs WHERE task_id = ?')
      .get(result.job.phaseTaskId) as Record<string, unknown>

    expect(result.created).toBe(true)
    expect(result.job).not.toHaveProperty('extractionTaskId')
    expect(child).toMatchObject({ source: 'n8n-node', status: 'queued' })
    expect(JSON.parse(String(child.routing))).toMatchObject({
      taskType: 'video-analysis', childKind: 'director-extraction',
      directorPhase: 'perception', parentTaskId: sourceTaskId,
    })
    expect(JSON.parse(String(child.input))).toMatchObject({
      taskType: 'video-analysis', childKind: 'director-extraction',
      directorPhase: 'perception', parentTaskId: sourceTaskId,
    })
    expect(db.prepare(`SELECT COUNT(*) FROM n8n_task_runs WHERE source = 'director-extraction-root'`).pluck().get()).toBe(0)
    expect(db.prepare('SELECT input, output FROM n8n_task_runs WHERE task_id = ?').get(sourceTaskId)).toEqual(before)
  })

  it('replays registration idempotently and rejects objective drift', () => {
    const sourceTaskId = seedSource(db)
    const first = registerDirectorExtractionJob(db, sourceTaskId, scope, { objective: '人物变化' })
    expect(registerDirectorExtractionJob(db, sourceTaskId, scope, { objective: '人物变化' }).created).toBe(false)
    expect(() => registerDirectorExtractionJob(db, sourceTaskId, scope, { objective: '空间关系' }))
      .toThrow('director_extraction_objective_conflict')
    expect(db.prepare('SELECT COUNT(*) FROM n8n_task_runs WHERE task_id = ?').pluck().get(first.job.phaseTaskId)).toBe(1)
  })

  it('refuses a guarded perception claim before evidence is ready', () => {
    const sourceTaskId = seedSource(db, 'guarded-evidence-source')
    registerDirectorExtractionJob(db, sourceTaskId, scope)

    expect(claimNextDirectorExtractionJob(db, {
      nowSeconds: 100,
      requirePerceptionEvidenceReady: true,
    })).toBeNull()
    expect(db.prepare(`
      SELECT status, attempt_count FROM n8n_task_runs
      WHERE source = 'n8n-node' AND json_extract(input, '$.parentTaskId') = ?
    `).get(sourceTaskId)).toEqual({ status: 'queued', attempt_count: 0 })
    expect(db.prepare('SELECT COUNT(*) FROM n8n_child_execution_leases').pluck().get()).toBe(0)
  })

  it('rechecks evidence readiness inside the claim transaction across connections', () => {
    db.close()
    const directory = mkdtempSync(join(tmpdir(), 'director-evidence-claim-'))
    const pathname = join(directory, 'runs.sqlite')
    const first = new Database(pathname)
    const second = new Database(pathname)
    try {
      for (const connection of [first, second]) {
        connection.pragma('foreign_keys = ON')
        connection.pragma('journal_mode = WAL')
        connection.pragma('busy_timeout = 5000')
      }
      runMigrations(first)
      const sourceTaskId = seedSource(first, 'cross-connection-evidence-source')
      registerDirectorExtractionJob(first, sourceTaskId, scope)

      expect(claimNextDirectorExtractionJob(second, {
        nowSeconds: 100,
        requirePerceptionEvidenceReady: true,
      })).toBeNull()
      expect(second.prepare(`
        SELECT status, attempt_count FROM n8n_task_runs
        WHERE source = 'n8n-node' AND json_extract(input, '$.parentTaskId') = ?
      `).get(sourceTaskId)).toEqual({ status: 'queued', attempt_count: 0 })
      expect(second.prepare('SELECT COUNT(*) FROM n8n_child_execution_leases').pluck().get()).toBe(0)
    } finally {
      first.close()
      second.close()
      rmSync(directory, { recursive: true, force: true })
      db = new Database(':memory:')
    }
  })

  it('keeps the perception identity authoritative after the successful parent is rewritten', async () => {
    const sourceTaskId = seedSource(db, 'source-identity-rewrite')
    registerDirectorExtractionJob(db, sourceTaskId, scope)
    expect((await completeCurrent(db, 100)).status).toBe('awaiting_evidence_review')
    resumeDirectorExtractionAfterReview(db, sourceTaskId, scope, {
      material_evidence: ['EVIDENCE-001'],
    }, { nowSeconds: 102 })

    db.prepare(`
      UPDATE n8n_task_runs SET output = ?, updated_at = ? WHERE task_id = ?
    `).run(JSON.stringify(videoOutput('MAT-REBOUND')), 103, sourceTaskId)

    expect(getDirectorExtractionJob(db, sourceTaskId, scope)).toMatchObject({
      workId: binding.workId,
      materialId: `MAT-${sourceTaskId}`,
      status: 'conflict',
      lastErrorCode: 'director_extraction_source_conflict',
    })
    expect(claimNextDirectorExtractionJob(db, { nowSeconds: 104 })).toBeNull()
  })

  it('aggregates multiple sources for one work instead of treating status as ambiguous', () => {
    for (const taskId of ['source-a', 'source-b']) {
      seedSource(db, taskId)
      registerDirectorExtractionJob(db, taskId, scope)
    }
    expect(listDirectorExtractionJobsForWork(db, binding.workId, scope)).toHaveLength(2)
    expect(getDirectorExtractionStatusForWork(db, scope, binding.workId)).toMatchObject({
      sourceCount: 2,
      counts: { completed: 0, active: 2, failed: 0, waitingReview: 0 },
    })
  })

  it('resolves the same source query only inside the requested work', () => {
    const neighboringBinding = directorEvidenceBindingForResolvedWork(
      'WORK-SINGLE-CHAIN-NEIGHBOR',
      '邻近作品',
    )
    seedSource(db, 'shared-title-current', binding)
    seedSource(db, 'shared-title-neighbor', neighboringBinding)

    expect(resolveDirectorExtractionSourceTaskId(
      db, scope, binding.workId, 'shared-title',
    )).toBe('shared-title-current')
    expect(resolveDirectorExtractionSourceTaskId(
      db, scope, neighboringBinding.workId, 'shared-title',
    )).toBe('shared-title-neighbor')
  })

  it('never treats an n8n-node child with a root-shaped payload as an extraction source', async () => {
    seedSource(db, 'trusted-root')
    seedSource(db, 'root-shaped-child', binding, 'n8n-node')

    expect(resolveDirectorExtractionSourceTaskId(db, scope, binding.workId))
      .toBe('trusted-root')
    expect(() => registerDirectorExtractionJob(db, 'root-shaped-child', scope))
      .toThrow('director_extraction_source_not_ready')
    await expect(backfillDirectorExtractionForWork(db, scope, { workId: binding.workId }, {
      workVerifier: async workId => ({ workId }),
    })).resolves.toMatchObject({ scanned: 1, registered: 1, rejected: 0 })
    expect(getDirectorExtractionJob(db, 'root-shaped-child', scope)).toBeNull()
  })

  it('backfills each source with its original trusted query digest', async () => {
    const firstBinding = directorEvidenceBindingForResolvedWork(binding.workId, '作品原始别名 A')
    const secondBinding = directorEvidenceBindingForResolvedWork(binding.workId, '作品原始别名 B')
    seedSource(db, 'backfill-original-a', firstBinding)
    seedSource(db, 'backfill-original-b', secondBinding)

    await expect(backfillDirectorExtractionForWork(db, scope, { workId: binding.workId }, {
      workVerifier: async workId => ({ workId }),
    })).resolves.toMatchObject({
      scanned: 2,
      registered: 2,
      existing: 0,
      rejected: 0,
      rejectionCounts: { missingBinding: 0, bindingConflict: 0, registrationError: 0 },
    })
    expect(getDirectorExtractionJob(db, 'backfill-original-a', scope)?.workQueryDigest)
      .toBe(firstBinding.queryDigest)
    expect(getDirectorExtractionJob(db, 'backfill-original-b', scope)?.workQueryDigest)
      .toBe(secondBinding.queryDigest)
  })

  it('reports an invalid historical source binding without forging a digest', async () => {
    seedSource(db, 'backfill-valid')
    seedSource(db, 'backfill-invalid')
    db.prepare(`
      UPDATE n8n_task_runs
      SET input = json_set(input, '$.directorEvidence.queryDigest', 'invalid')
      WHERE task_id = 'backfill-invalid'
    `).run()

    await expect(backfillDirectorExtractionForWork(db, scope, { workId: binding.workId }, {
      workVerifier: async workId => ({ workId }),
    })).resolves.toMatchObject({
      scanned: 2,
      registered: 1,
      existing: 0,
      rejected: 1,
      rejectionCounts: { missingBinding: 1, bindingConflict: 0, registrationError: 0 },
    })
    expect(getDirectorExtractionJob(db, 'backfill-invalid', scope)).toBeNull()
  })

  it('refuses to start from an untrusted source binding before remote work verification', async () => {
    seedSource(db, 'start-invalid-binding')
    db.prepare(`
      UPDATE n8n_task_runs
      SET input = json_set(input, '$.directorEvidence.queryDigest', 'invalid')
      WHERE task_id = 'start-invalid-binding'
    `).run()
    let verifierCalls = 0

    await expect(startDirectorExtractionForWork(db, scope, { workId: binding.workId }, {
      workVerifier: async workId => {
        verifierCalls++
        return { workId }
      },
    })).rejects.toThrow('director_extraction_work_not_registered')
    expect(verifierCalls).toBe(0)
  })

  it('uses the common child lease and fences an expired owner across connections', () => {
    db.close()
    const directory = mkdtempSync(join(tmpdir(), 'director-single-chain-'))
    const pathname = join(directory, 'runs.sqlite')
    const first = new Database(pathname)
    const second = new Database(pathname)
    try {
      for (const connection of [first, second]) {
        connection.pragma('foreign_keys = ON')
        connection.pragma('journal_mode = WAL')
        connection.pragma('busy_timeout = 5000')
      }
      runMigrations(first)
      const sourceTaskId = seedSource(first)
      registerDirectorExtractionJob(first, sourceTaskId, scope)
      const old = claimNextDirectorExtractionJob(first, {
        nowSeconds: 100, ownerInstanceId: '1'.repeat(64), leaseToken: '2'.repeat(64),
      })!
      expect(claimNextDirectorExtractionJob(second, {
        nowSeconds: 100, ownerInstanceId: '3'.repeat(64), leaseToken: '4'.repeat(64),
      })).toBeNull()
      const replacement = claimNextDirectorExtractionJob(second, {
        nowSeconds: 1_000, ownerInstanceId: '3'.repeat(64), leaseToken: '4'.repeat(64),
      })!
      expect(replacement.revision).toBe(old.revision + 1)
      expect(() => renewDirectorExtractionLease(first, old, { nowSeconds: 101 }))
        .toThrow('director_extraction_lease_lost')
    } finally {
      first.close()
      second.close()
      rmSync(directory, { recursive: true, force: true })
      db = new Database(':memory:')
    }
  })

  it('keeps three sources for one work serial across rotating minute windows', () => {
    for (const taskId of ['serial-source-a', 'serial-source-b', 'serial-source-c']) {
      seedSource(db, taskId)
      registerDirectorExtractionJob(db, taskId, scope, { maxAttempts: 1 })
    }
    expect(listDirectorExtractionJobsByStatuses(
      db, ['pending'], 200, { nowSeconds: 60, scanMultiplier: 1 },
    ).map(job => job.sourceTaskId)).toEqual([
      'serial-source-a', 'serial-source-b', 'serial-source-c',
    ])
    const active = claimNextDirectorExtractionJob(db, {
      nowSeconds: 0,
      ownerInstanceId: '9'.repeat(64),
      leaseToken: 'a'.repeat(64),
    })!
    expect(active.status).toBe('running')

    // scanLimit=200 and total=3 rotates the next minute to a different source;
    // the work-level active query must still block every pending sibling.
    expect(claimNextDirectorExtractionJob(db, {
      nowSeconds: 60,
      ownerInstanceId: 'b'.repeat(64),
      leaseToken: 'c'.repeat(64),
    })).toBeNull()
    expect(db.prepare(`
      SELECT COUNT(*) FROM n8n_task_runs
      WHERE source = 'n8n-node' AND status = 'running'
        AND json_extract(input, '$.childKind') = 'director-extraction'
    `).pluck().get()).toBe(1)

    failDirectorExtractionPhase(db, active, 'expected_test_failure', { nowSeconds: 61 })
    expect(claimNextDirectorExtractionJob(db, {
      nowSeconds: 60,
      ownerInstanceId: 'd'.repeat(64),
      leaseToken: 'e'.repeat(64),
    })?.sourceTaskId).toBe('serial-source-b')
  })

  it('keeps an active lease and work listing bound to immutable perception identity', () => {
    const rebound = directorEvidenceBindingForResolvedWork(
      'WORK-SINGLE-CHAIN-REBOUND',
      '改绑作品',
    )
    for (const taskId of ['immutable-lease-a', 'immutable-lease-b']) {
      seedSource(db, taskId)
      registerDirectorExtractionJob(db, taskId, scope)
    }
    const active = claimNextDirectorExtractionJob(db, {
      nowSeconds: 100,
      ownerInstanceId: '1'.repeat(64),
      leaseToken: '2'.repeat(64),
    })!
    expect(active.sourceTaskId).toBe('immutable-lease-a')
    db.prepare('UPDATE n8n_task_runs SET input = ?, updated_at = ? WHERE task_id = ?')
      .run(JSON.stringify({ directorEvidence: rebound }), 101, active.sourceTaskId)

    const originalWork = listDirectorExtractionJobsForWork(db, binding.workId, scope)
    expect(originalWork.map(job => job.sourceTaskId)).toEqual([
      'immutable-lease-a', 'immutable-lease-b',
    ])
    expect(originalWork.every(job => job.workId === binding.workId)).toBe(true)
    expect(listDirectorExtractionJobsForWork(db, rebound.workId, scope)).toEqual([])
    expect(claimNextDirectorExtractionJob(db, {
      nowSeconds: 102,
      ownerInstanceId: '3'.repeat(64),
      leaseToken: '4'.repeat(64),
    })).toBeNull()
    expect(() => registerDirectorExtractionJob(db, active.sourceTaskId, scope, {
      binding: rebound,
    })).toThrow('director_extraction_work_binding_conflict')
  })

  it('requeues an exhausted transient failure once across two connections', () => {
    db.close()
    const directory = mkdtempSync(join(tmpdir(), 'director-retry-cas-'))
    const pathname = join(directory, 'runs.sqlite')
    const first = new Database(pathname)
    const second = new Database(pathname)
    try {
      for (const connection of [first, second]) {
        connection.pragma('foreign_keys = ON')
        connection.pragma('journal_mode = WAL')
        connection.pragma('busy_timeout = 5000')
      }
      runMigrations(first)
      const sourceTaskId = seedSource(first, 'retry-exhausted-source')
      registerDirectorExtractionJob(first, sourceTaskId, scope, { maxAttempts: 1 })
      const claimed = claimNextDirectorExtractionJob(first, {
        nowSeconds: 100, ownerInstanceId: '5'.repeat(64), leaseToken: '6'.repeat(64),
      })!
      expect(failDirectorExtractionPhase(
        first, claimed, 'director_extraction_transient_failure', { nowSeconds: 101 },
      )).toMatchObject({ status: 'failed', attemptCount: 1, maxAttempts: 1 })

      const firstRetry = retryExhaustedDirectorExtractionJob(
        first, sourceTaskId, scope, { nowSeconds: 102 },
      )
      const replayedRetry = retryExhaustedDirectorExtractionJob(
        second, sourceTaskId, scope, { nowSeconds: 103 },
      )
      expect(firstRetry).toMatchObject({ status: 'pending', attemptCount: 0, revision: 2 })
      expect(replayedRetry).toMatchObject({ status: 'pending', attemptCount: 0, revision: 2 })
      expect(getDirectorExtractionCheckpoint(first, sourceTaskId, 'perception')).not.toBeNull()

      expect(claimNextDirectorExtractionJob(second, {
        nowSeconds: 104, ownerInstanceId: '7'.repeat(64), leaseToken: '8'.repeat(64),
      })).toMatchObject({ status: 'running', attemptCount: 1, revision: 2 })
    } finally {
      first.close()
      second.close()
      rmSync(directory, { recursive: true, force: true })
      db = new Database(':memory:')
    }
  })

  it('creates each later phase only after append-only review and intent receipts', async () => {
    const sourceTaskId = seedSource(db)
    registerDirectorExtractionJob(db, sourceTaskId, scope)

    expect((await completeCurrent(db, 100)).status).toBe('awaiting_evidence_review')
    expect(resumeDirectorExtractionAfterReview(db, sourceTaskId, scope, { material_evidence: ['EVIDENCE-001'] }).currentPhase)
      .toBe('understanding')
    expect((await completeCurrent(db, 200)).status).toBe('awaiting_understanding_review')
    expect(resumeDirectorExtractionAfterReview(db, sourceTaskId, scope, { story_nodes: ['STORY-001'] }).status)
      .toBe('awaiting_intent_review')
    expect(db.prepare('SELECT COUNT(*) FROM n8n_task_runs WHERE task_id = ?').pluck().get(
      directorExtractionPhaseTaskIdentity('task', sourceTaskId, 'judgment'),
    )).toBe(0)
    expect(resumeDirectorExtractionAfterIntent(db, sourceTaskId, scope, 'INTENT-001').currentPhase)
      .toBe('judgment')
    expect(db.prepare(`
      SELECT COUNT(*) FROM director_extraction_review_receipts
      WHERE receipt_type IN ('candidate_review', 'intent_review')
    `).pluck().get()).toBe(3)
  })

  it('records rejection append-only without rewriting the succeeded child', async () => {
    const sourceTaskId = seedSource(db)
    registerDirectorExtractionJob(db, sourceTaskId, scope)
    const waiting = await completeCurrent(db, 100)
    expect(failDirectorExtractionReview(db, waiting, 'director_extraction_review_rejected:test').status)
      .toBe('conflict')
    expect(db.prepare('SELECT status FROM n8n_task_runs WHERE task_id = ?').pluck().get(waiting.phaseTaskId))
      .toBe('succeeded')
  })

  it('keeps checkpoints attached to phase children, never to the source root', () => {
    const sourceTaskId = seedSource(db)
    registerDirectorExtractionJob(db, sourceTaskId, scope)
    const checkpoint = getDirectorExtractionCheckpoint(db, sourceTaskId, 'perception')!
    expect(checkpoint.phaseTaskId).toBe(directorExtractionPhaseTaskIdentity('task', sourceTaskId, 'perception'))
    expect(checkpoint.sourceTaskId).toBe(sourceTaskId)
    expect(db.prepare('SELECT COUNT(*) FROM director_extraction_checkpoints WHERE phase_task_id = ?').pluck().get(sourceTaskId))
      .toBe(0)
    expect(getDirectorExtractionJob(db, sourceTaskId, scope)).not.toBeNull()
  })
})
