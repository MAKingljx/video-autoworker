import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import {
  directorBrainCommandPort,
  DIRECTOR_BRAIN_APPLICATION_PROTOCOL,
  executeDirectorBrainApplicationRequest,
  parseDirectorBrainApplicationRequest,
} from '@/lib/director-brain-application-port'
import {
  cancelDirectorReviewBatch,
  claimDirectorReviewBatch,
  prepareDirectorReviewBatch,
  recordDirectorReviewBatchItem,
} from '@/lib/director-review-batches'
import {
  completeDirectorExtractionSegment,
  ensureDirectorExtractionSegments,
  mergeDirectorExtractionSegments,
  splitDirectorExtractionPhaseInput,
} from '@/lib/director-extraction-segments'
import { DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES } from '@/lib/director-extraction-learning'
import { ensureDirectorMaintainabilitySchema } from '@/lib/director-maintainability-schema'
import { getN8nRollingDatabaseCompatibility } from '@/lib/n8n-runtime-affinity'

const scope = { tenantId: 1, workspaceId: 2 }
const targets = [0, 1].map(index => ({
  table: 'material_evidence',
  stableId: `EVIDENCE-${index + 1}`,
  workId: 'WORK-1',
  state: '候选',
  version: 'v0.2.0',
  targetStatuses: ['已核验'],
}))

describe('director maintainability contracts', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
  })

  afterEach(() => db.close())

  it('routes query, proposal, and review through one platform-neutral port', async () => {
    const runner = vi.fn(async (command, input) => ({ ok: true, action: input.action || command }))
    const port = directorBrainCommandPort(runner)
    for (const raw of [
      { command: 'operate', input: { action: 'get', table: 'works', stableId: 'WORK-1' } },
      { command: 'propose', input: { action: 'propose', table: 'works', fields: { name: '作品' } } },
      { command: 'review', input: { table: 'works', stableId: 'WORK-1' } },
    ]) {
      const request = parseDirectorBrainApplicationRequest(raw)
      expect(request).not.toBeNull()
      await executeDirectorBrainApplicationRequest(port, request!)
    }
    expect(runner.mock.calls.map(call => call[0])).toEqual(['operate', 'operate', 'review'])
    expect(parseDirectorBrainApplicationRequest({
      command: 'operate', input: { action: 'propose', table: 'works' },
    })?.command).toBe('propose')
    expect(parseDirectorBrainApplicationRequest({
      protocol: DIRECTOR_BRAIN_APPLICATION_PROTOCOL,
      command: 'operate', input: { action: 'get', table: 'works', stableId: 'WORK-1' },
    })?.protocol).toBe(DIRECTOR_BRAIN_APPLICATION_PROTOCOL)
    expect(parseDirectorBrainApplicationRequest({
      protocol: 'director-brain-application/v999',
      command: 'operate', input: { action: 'get', table: 'works', stableId: 'WORK-1' },
    })).toBeNull()
    expect(parseDirectorBrainApplicationRequest({
      protocol: DIRECTOR_BRAIN_APPLICATION_PROTOCOL,
      command: 'operate', input: { action: 'propose', table: 'works' },
    })).toBeNull()
  })

  it('installs optional tables without advancing the authoritative migration marker', () => {
    const migrationIds = db.prepare('SELECT id FROM schema_migrations ORDER BY id').pluck().all()
    expect(migrationIds.at(-1)).toBe('059_director_evidence_projection_receipts')
    expect(migrationIds).not.toContain('060_director_review_batches_and_extraction_segments')
    expect(getN8nRollingDatabaseCompatibility(db).latestMigration)
      .toBe('059_director_evidence_projection_receipts')
    for (const table of ['director_review_batches', 'director_review_batch_items',
      'director_extraction_segments']) {
      expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(table)).toBeTruthy()
    }
    ensureDirectorMaintainabilitySchema(db)
    expect(db.prepare(`SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'director_extraction_segments'`).get()).toBeTruthy()
    const drifted = new Database(':memory:')
    try {
      drifted.exec('CREATE TABLE director_review_batches (batch_id TEXT PRIMARY KEY)')
      expect(() => ensureDirectorMaintainabilitySchema(drifted))
        .toThrow('director_maintainability_schema_invalid')
    } finally { drifted.close() }
  })

  it('persists fixed review membership and resumes item outcomes idempotently', () => {
    const input = {
      actorKey: 'openclaw\0agent\0session', requestKey: 'tool-call-1',
      decision: 'approve' as const, targets, nowSeconds: 100, createCode: () => 'ABC123',
    }
    const prepared = prepareDirectorReviewBatch(db, scope, input)
    expect(prepareDirectorReviewBatch(db, scope, input)).toEqual(prepared)
    expect(prepared.targets).toEqual(targets)
    expect(() => prepareDirectorReviewBatch(db, scope, {
      ...input, targets: [{ ...targets[0], stableId: 'EVIDENCE-CHANGED' }],
    })).toThrow('director_review_batch_identity_conflict')
    expect(claimDirectorReviewBatch(db, scope, {
      actorKey: input.actorKey, confirmationCode: 'ABC123', count: 2, nowSeconds: 101,
      decision: 'approve',
    }).status).toBe('applying')
    let batch = recordDirectorReviewBatchItem(db, scope, {
      actorKey: input.actorKey, batchId: prepared.batchId, ordinal: 0,
      status: 'completed', resultVersion: 'v0.2.1', nowSeconds: 102,
    })
    expect(batch).toMatchObject({ completedCount: 1, unknownCount: 0, status: 'applying' })
    batch = recordDirectorReviewBatchItem(db, scope, {
      actorKey: input.actorKey, batchId: prepared.batchId, ordinal: 0,
      status: 'completed', resultVersion: 'v0.2.1', nowSeconds: 103,
    })
    expect(batch.completedCount).toBe(1)
    batch = recordDirectorReviewBatchItem(db, scope, {
      actorKey: input.actorKey, batchId: prepared.batchId, ordinal: 1,
      status: 'unknown', errorCode: 'response_lost', nowSeconds: 104,
    })
    expect(batch).toMatchObject({ completedCount: 1, unknownCount: 1 })
    batch = recordDirectorReviewBatchItem(db, scope, {
      actorKey: input.actorKey, batchId: prepared.batchId, ordinal: 1,
      status: 'completed', resultVersion: 'v0.2.1', nowSeconds: 105,
    })
    expect(batch).toMatchObject({ completedCount: 2, unknownCount: 0, status: 'completed' })
    expect(recordDirectorReviewBatchItem(db, scope, {
      actorKey: input.actorKey, batchId: prepared.batchId, ordinal: 1,
      status: 'completed', resultVersion: 'v0.2.1', nowSeconds: 106,
    })).toEqual(batch)
    expect(() => cancelDirectorReviewBatch(db, scope, {
      actorKey: input.actorKey, confirmationCode: 'ABC123', nowSeconds: 107,
    })).toThrow('director_review_batch_not_cancellable')
    expect(() => claimDirectorReviewBatch(db, { tenantId: 9, workspaceId: 9 }, {
      actorKey: input.actorKey, confirmationCode: 'ABC123', count: 2, nowSeconds: 105,
      decision: 'approve',
    })).toThrow('director_review_batch_not_found')
    const newer = prepareDirectorReviewBatch(db, scope, {
      ...input, requestKey: 'tool-call-2', targets: [...targets, {
        ...targets[0], stableId: 'EVIDENCE-3',
      }], createCode: () => 'DEF456',
    })
    expect(newer.targets).toHaveLength(3)
    expect(prepared.targets).toHaveLength(2)
    const rejected = prepareDirectorReviewBatch(db, scope, {
      ...input, decision: 'reject', createCode: () => 'GHI789',
    })
    expect(rejected.batchId).not.toBe(prepared.batchId)
    expect(rejected.decision).toBe('reject')
  })

  it('checkpoints segments independently and merges only a complete plan', () => {
    db.prepare(`INSERT INTO n8n_workflow_bindings
      (id, name, webhook_path, task_type, workspace_id, tenant_id)
      VALUES (1, 'director', 'webhook/director', 'video-analysis', 2, 1)`).run()
    db.prepare(`INSERT INTO n8n_task_runs
      (task_id, idempotency_key, binding_id, status, source, routing, input,
       delivery, workspace_id, tenant_id)
      VALUES ('phase-1', 'idem-1', 1, 'running', 'n8n-node', '{}', '{}',
        '{"mode":"none"}', 2, 1)`).run()
    const inputs = [{ evidence: { window: [0, 10] } }, { evidence: { window: [10, 20] } }]
    let segments = ensureDirectorExtractionSegments(db, 'phase-1', 'perception', inputs, 100)
    expect(segments.map(segment => segment.status)).toEqual(['pending', 'pending'])
    segments = completeDirectorExtractionSegment(db, 'phase-1', 'perception', 0, {
      schemaVersion: 1, phase: 'perception', candidates: [],
    }, 101)
    expect(() => mergeDirectorExtractionSegments('perception', segments))
      .toThrow('director_extraction_segments_incomplete')
    expect(ensureDirectorExtractionSegments(db, 'phase-1', 'perception', inputs, 102)[0].status)
      .toBe('completed')
    expect(() => ensureDirectorExtractionSegments(
      db, 'phase-1', 'perception', [{ evidence: { window: [0, 99] } }], 102,
    )).toThrow('director_extraction_segment_plan_conflict')
    segments = completeDirectorExtractionSegment(db, 'phase-1', 'perception', 1, {
      schemaVersion: 1, phase: 'perception', candidates: [],
    }, 103)
    expect(mergeDirectorExtractionSegments('perception', segments))
      .toEqual({ schemaVersion: 1, phase: 'perception', candidates: [] })

    const shared = {
      candidateKey: 'same-key', kind: 'story_node', title: '节点', summary: '内容',
      rationale: '变化', confidence: 0.8,
      evidenceRefs: [{ materialId: 'MAT-1', startSeconds: 0, endSeconds: 1 }],
      sourceCandidateKeys: [], sourceStableIds: [], appliedTechniqueStableIds: [],
      fields: { '节点名称': '节点', '节点类型': '事件', '人物 ID': '', '发生时间': '',
        '节点内容': '内容', '变化': '变化', '置信度': 0.8 },
    }
    expect(() => mergeDirectorExtractionSegments('understanding', [
      { index: 0, count: 2, status: 'completed', output: {
        schemaVersion: 1, phase: 'understanding', candidates: [shared],
      } },
      { index: 1, count: 2, status: 'completed', output: {
        schemaVersion: 1, phase: 'understanding', candidates: [{ ...shared, summary: '不同内容' }],
      } },
    ] as never)).toThrow('director_extraction_segment_candidate_conflict')
  })

  it('splits oversized evidence without dropping timeline units', () => {
    const timeline = [0, 1, 2].map(index => ({
      timeRange: `00:00:0${index}-00:00:0${index + 1}`,
      visualSummary: `${index}:${'证据'.repeat(10_000)}`,
    }))
    const segments = splitDirectorExtractionPhaseInput({
      phase: 'understanding',
      evidence: { materialId: 'MAT-1', mediaDurationSeconds: 3, summary: '完整摘要', timeline },
      reviewedEvidenceWindows: [{ startSeconds: 0, endSeconds: 3 }],
    })
    expect(segments.length).toBeGreaterThan(1)
    expect(segments.every(segment => (
      Buffer.byteLength(JSON.stringify(segment), 'utf8')
        <= DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES
    ))).toBe(true)
    expect(segments.flatMap(segment => (
      (segment.evidence as { timeline: unknown[] }).timeline
    ))).toEqual(timeline)
  })
})
