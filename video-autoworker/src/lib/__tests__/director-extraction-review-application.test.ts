import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import {
  cancelDirectorLearningReview,
  confirmDirectorLearningReview,
  listDirectorLearningReviews,
  prepareDirectorLearningReview,
  type DirectorLearningReviewSelection,
} from '@/lib/director-extraction-review-application'
import {
  claimNextDirectorExtractionJob,
  completeDirectorExtractionProjection,
  getDirectorExtractionCheckpoint,
  getDirectorExtractionJob,
  resumeDirectorExtractionAfterReview,
  stageDirectorExtractionCheckpoint,
} from '@/lib/director-extraction-runs'
import { prepareDirectorExtractionFromStoredEvidence } from '@/lib/director-extraction-service'
import { createDeterministicDirectorExtractionFixtureRunner } from '@/lib/__tests__/fixtures/director-extraction'
import {
  directorEvidenceFixtureItem,
  persistDirectorEvidenceFixtureReceipt,
} from '@/lib/__tests__/fixtures/director-evidence'
import {
  directorEvidenceBindingForResolvedWork,
  type DirectorCommandRunner,
} from '@/lib/director-evidence-delivery-core'
import {
  enqueueDirectorEvidenceOutbox,
  getDirectorEvidenceOutbox,
} from '@/lib/director-evidence-outbox'
import { getScopedN8nTaskRunByTaskId } from '@/lib/n8n-task-runs'
import type { DirectorExtractionProjectionReceipt } from '@/lib/director-extraction-state'

const scope = { tenantId: 83, workspaceId: 38 }
const workId = 'WORK-REVIEW-001'
const sourceTaskId = 'video-source-review-001'
const actorKey = 'platform-review-test-user'
const originalScope = {
  tenantId: process.env.MC_OPENCLAW_TENANT_ID,
  workspaceId: process.env.MC_OPENCLAW_WORKSPACE_ID,
}

type RemoteRecord = {
  table: string
  stableId: string
  state: string
  reviewed: boolean
  fields: Record<string, unknown>
}

function nextVersion(value: string): string {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(value)!
  return `v${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

function remoteRunner(records: Map<string, RemoteRecord>) {
  let reviewCalls = 0
  let loseNextReviewResponse = false
  let loseNextReadback = false
  let lostWritePendingReadback = false
  const runner: DirectorCommandRunner = async (command, input) => {
    if (command === 'operate' && input.action === 'get') {
      const record = records.get(`${input.table}:${input.stableId}`)
      return {
        ok: true,
        action: 'get',
        table: input.table,
        stableId: input.stableId,
        workId: input.table === 'works' || input.table === 'skills_techniques'
          ? null : input.workId,
        found: Boolean(record),
        record: record ? structuredClone(record) : null,
      }
    }
    if (command === 'operate' && input.action === 'get_many') {
      if (lostWritePendingReadback && loseNextReadback) {
        loseNextReadback = false
        lostWritePendingReadback = false
        throw new Error('simulated_readback_loss')
      }
      const stableIds = input.stableIds as string[]
      const found = stableIds.map(stableId => records.get(`${input.table}:${stableId}`)).filter(Boolean)
      return {
        ok: true,
        action: 'get_many',
        table: input.table,
        workId: input.table === 'skills_techniques' ? null : input.workId,
        records: structuredClone(found),
        missing: stableIds.filter(stableId => !records.has(`${input.table}:${stableId}`)),
      }
    }
    if (command === 'review' && input.action === 'review') {
      reviewCalls++
      const key = `${input.table}:${input.stableId}`
      const record = records.get(key)
      if (!record || record.fields['版本'] !== input.expectedVersion) {
        throw new Error('simulated_cas_conflict')
      }
      const previousStatus = record.state
      const previousVersion = String(record.fields['版本'])
      const version = nextVersion(previousVersion)
      record.state = String(input.targetStatus)
      record.fields['版本'] = version
      record.reviewed = new Set(['已核验', '已确认', '已批准', '已验证'])
        .has(record.state)
      const result = {
        ok: true,
        action: 'review',
        table: input.table,
        stableId: input.stableId,
        workId: input.table === 'skills_techniques' ? null : input.workId,
        previousStatus,
        targetStatus: input.targetStatus,
        previousVersion,
        version,
        record: structuredClone(record),
      }
      if (loseNextReviewResponse) {
        loseNextReviewResponse = false
        lostWritePendingReadback = true
        throw new Error('simulated_response_loss')
      }
      return result
    }
    throw new Error(`unexpected_command:${command}:${String(input.action)}`)
  }
  return {
    runner,
    reviewCalls: () => reviewCalls,
    loseResponseAndReadbackOnce: () => {
      loseNextReviewResponse = true
      loseNextReadback = true
    },
  }
}

function seedSource(db: Database.Database) {
  const binding = directorEvidenceBindingForResolvedWork(workId, '测试作品')
  db.prepare(`
    INSERT INTO n8n_workflow_bindings (
      id, name, webhook_path, task_type, workspace_id, tenant_id
    ) VALUES (83, '视频分析', 'webhook/review', 'video-analysis', ?, ?)
  `).run(scope.workspaceId, scope.tenantId)
  db.prepare(`
    INSERT INTO n8n_task_runs (
      task_id, idempotency_key, binding_id, status, source, requested_by,
      routing, input, delivery, output, attempt_count, max_attempts,
      workspace_id, tenant_id, completed_at, updated_at
    ) VALUES (?, 'review-idem', 83, 'succeeded', 'openclaw', 'review-test',
      '{"taskType":"video-analysis"}', ?, '{"mode":"none"}', ?, 1, 1, ?, ?, 10, 10)
  `).run(
    sourceTaskId,
    JSON.stringify({ directorEvidence: binding }),
    JSON.stringify({
      taskType: 'video-analysis', materialId: 'MAT-REVIEW-001',
      analysisVersion: 'video-analysis-v3', mediaDurationSeconds: 12,
      summary: '人物在环境变化后调整行动。',
      timeline: [{ index: 1, timeRange: '00:00:00-00:00:12', visualAnalysis: '人物进入空间。', confidence: 0.9 }],
    }),
    scope.workspaceId,
    scope.tenantId,
  )
  const source = getScopedN8nTaskRunByTaskId(db, sourceTaskId, scope)!
  expect(enqueueDirectorEvidenceOutbox(db, source, 100)).toBe('created')
  db.prepare(`UPDATE n8n_director_evidence_outbox
    SET status = 'delivered', delivered_at = 101, updated_at = 101 WHERE task_id = ?`)
    .run(sourceTaskId)
  const outbox = getDirectorEvidenceOutbox(db, sourceTaskId)!
  persistDirectorEvidenceFixtureReceipt(db, outbox, [directorEvidenceFixtureItem(1, {
    '任务 ID': sourceTaskId,
    '素材 ID': 'MAT-REVIEW-001',
  })], 101)
}

async function seedAwaitingUnderstanding(db: Database.Database) {
  seedSource(db)
  const perception = prepareDirectorExtractionFromStoredEvidence(db, sourceTaskId, scope, {
    nowSeconds: 110,
  })!
  const evidenceId = getDirectorExtractionCheckpoint(db, sourceTaskId, 'perception')!
    .projectionReceipt!.entries[0].stableId
  resumeDirectorExtractionAfterReview(db, sourceTaskId, scope, {
    material_evidence: [evidenceId],
  }, { nowSeconds: 111 })
  const job = claimNextDirectorExtractionJob(db, {
    nowSeconds: 112,
    ownerInstanceId: '1'.repeat(64),
    leaseToken: '2'.repeat(64),
  })!
  expect(perception.status).toBe('awaiting_evidence_review')
  expect(job.currentPhase).toBe('understanding')
  const phaseInput = {
    schemaVersion: 1,
    phase: 'understanding',
    evidence: { materialId: job.materialId, mediaDurationSeconds: 12 },
  }
  const candidateOutput = await createDeterministicDirectorExtractionFixtureRunner()(
    'understanding', phaseInput, job,
  )
  stageDirectorExtractionCheckpoint(db, job, phaseInput, candidateOutput, { nowSeconds: 112 })
  const receipt: DirectorExtractionProjectionReceipt = {
    schemaVersion: 1,
    phase: 'understanding',
    entries: [
      { candidateKey: 'fixture-person', kind: 'person_profile', table: 'people_profiles', stableId: 'PERSON-REVIEW-001' },
      { candidateKey: 'fixture-story-a', kind: 'story_node', table: 'story_nodes', stableId: 'STORY-REVIEW-A' },
      { candidateKey: 'fixture-story-b', kind: 'story_node', table: 'story_nodes', stableId: 'STORY-REVIEW-B' },
    ],
  }
  return completeDirectorExtractionProjection(db, job, receipt, { nowSeconds: 114 })
}

function candidateRecords() {
  return new Map<string, RemoteRecord>([
    ['works:WORK-REVIEW-001', {
      table: 'works', stableId: workId, state: '生效', reviewed: true,
      fields: { '作品名称': '测试作品', '版本': 'v1.0.0' },
    }],
    ['people_profiles:PERSON-REVIEW-001', {
      table: 'people_profiles', stableId: 'PERSON-REVIEW-001', state: '候选', reviewed: false,
      fields: { '作品 ID': workId, '版本': 'v1.0.0' },
    }],
    ['story_nodes:STORY-REVIEW-A', {
      table: 'story_nodes', stableId: 'STORY-REVIEW-A', state: '候选', reviewed: false,
      fields: { '作品 ID': workId, '版本': 'v1.0.0' },
    }],
    ['story_nodes:STORY-REVIEW-B', {
      table: 'story_nodes', stableId: 'STORY-REVIEW-B', state: '候选', reviewed: false,
      fields: { '作品 ID': workId, '版本': 'v1.0.0' },
    }],
    ['story_nodes:STORY-NOT-IN-RECEIPT', {
      table: 'story_nodes', stableId: 'STORY-NOT-IN-RECEIPT', state: '候选', reviewed: false,
      fields: { '作品 ID': workId, '版本': 'v1.0.0' },
    }],
  ])
}

async function prepareConfirmation(
  db: Database.Database,
  selection: DirectorLearningReviewSelection,
  commandRunner: DirectorCommandRunner,
) {
  const prepared = await prepareDirectorLearningReview(
    db, scope, actorKey, selection, { commandRunner },
  )
  return {
    ...selection,
    batchId: prepared.batchId,
    confirmationCode: prepared.confirmationCode,
    count: prepared.count,
  }
}

describe('platform-neutral director extraction review application', () => {
  let db: Database.Database

  beforeEach(async () => {
    process.env.MC_OPENCLAW_TENANT_ID = String(scope.tenantId)
    process.env.MC_OPENCLAW_WORKSPACE_ID = String(scope.workspaceId)
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    await seedAwaitingUnderstanding(db)
  })

  afterEach(() => {
    db.close()
    if (originalScope.tenantId === undefined) delete process.env.MC_OPENCLAW_TENANT_ID
    else process.env.MC_OPENCLAW_TENANT_ID = originalScope.tenantId
    if (originalScope.workspaceId === undefined) delete process.env.MC_OPENCLAW_WORKSPACE_ID
    else process.env.MC_OPENCLAW_WORKSPACE_ID = originalScope.workspaceId
  })

  it('lists only receipt-bound pending candidates without exposing internal ids', async () => {
    const remote = remoteRunner(candidateRecords())
    const reviews = await listDirectorLearningReviews(db, scope, { commandRunner: remote.runner })

    expect(reviews).toHaveLength(1)
    expect(reviews[0]).toMatchObject({
      workName: '测试作品',
      phase: 'understanding',
      progress: 40,
      progressKnown: true,
      pendingCount: 3,
    })
    expect(reviews[0].candidates.map(candidate => candidate.candidateId))
      .toEqual([expect.stringMatching(/^[a-f0-9]{64}$/u), expect.stringMatching(/^[a-f0-9]{64}$/u), expect.stringMatching(/^[a-f0-9]{64}$/u)])
    expect(reviews[0].candidates[0]).toMatchObject({
      kind: 'person_profile', confidence: 0.8,
    })
    const serialized = JSON.stringify(reviews)
    expect(serialized).not.toContain(sourceTaskId)
    expect(serialized).not.toContain(workId)
    expect(serialized).not.toContain('PERSON-REVIEW-001')
    expect(serialized).not.toContain('STORY-NOT-IN-RECEIPT')
    expect(serialized).not.toContain('fixture-story-a')
  })

  it('rejects a drifted Feishu state/version before any review write', async () => {
    const records = candidateRecords()
    const remote = remoteRunner(records)
    const [review] = await listDirectorLearningReviews(db, scope, { commandRunner: remote.runner })
    const candidateId = review.candidates.find(candidate => candidate.title === '进入环境')!.candidateId
    const confirmation = await prepareConfirmation(db, {
      requestId: 'request-drift-001',
      reviewId: review.reviewId,
      reviewRevision: review.reviewRevision,
      decision: 'approve',
      candidateIds: [candidateId],
    }, remote.runner)
    expect(remote.reviewCalls()).toBe(0)
    const changed = records.get('story_nodes:STORY-REVIEW-A')!
    changed.state = '待审核'
    changed.fields['版本'] = 'v1.0.1'

    expect((await confirmDirectorLearningReview(db, scope, actorKey, confirmation, {
      commandRunner: remote.runner,
    })).outcome).toBe('conflict')
    expect(remote.reviewCalls()).toBe(0)
  })

  it.each([
    ['approve', '已确认', true],
    ['reject', '失效', false],
  ] as const)('applies one %s decision through CAS and readback', async (decision, state, reviewed) => {
    const records = candidateRecords()
    const remote = remoteRunner(records)
    const [review] = await listDirectorLearningReviews(db, scope, { commandRunner: remote.runner })
    const candidateId = review.candidates.find(candidate => candidate.title === '进入环境')!.candidateId
    const confirmation = await prepareConfirmation(db, {
      requestId: `request-${decision}-001`,
      reviewId: review.reviewId,
      reviewRevision: review.reviewRevision,
      decision,
      candidateIds: [candidateId],
    }, remote.runner)
    expect(remote.reviewCalls()).toBe(0)
    const result = await confirmDirectorLearningReview(db, scope, actorKey, confirmation, {
      commandRunner: remote.runner,
    })

    expect(result.outcome).toBe('completed')
    expect(records.get('story_nodes:STORY-REVIEW-A')).toMatchObject({ state, reviewed })
    expect(remote.reviewCalls()).toBe(decision === 'approve' ? 2 : 1)
  })

  it('replays a completed request without issuing another review write', async () => {
    const records = candidateRecords()
    const remote = remoteRunner(records)
    const [review] = await listDirectorLearningReviews(db, scope, { commandRunner: remote.runner })
    const candidateId = review.candidates.find(candidate => candidate.title === '进入环境')!.candidateId
    const selection = {
      requestId: 'request-replay-001',
      reviewId: review.reviewId,
      reviewRevision: review.reviewRevision,
      decision: 'reject' as const,
      candidateIds: [candidateId],
    }
    const input = await prepareConfirmation(db, selection, remote.runner)
    expect((await confirmDirectorLearningReview(db, scope, actorKey, input, {
      commandRunner: remote.runner,
    })).outcome).toBe('completed')
    const writes = remote.reviewCalls()
    expect((await confirmDirectorLearningReview(db, scope, actorKey, input, {
      commandRunner: remote.runner,
    })).outcome).toBe('completed')
    expect(remote.reviewCalls()).toBe(writes)
  })

  it('applies the complete visible batch without advancing the extraction itself', async () => {
    const records = candidateRecords()
    const remote = remoteRunner(records)
    const [review] = await listDirectorLearningReviews(db, scope, { commandRunner: remote.runner })
    const confirmation = await prepareConfirmation(db, {
      requestId: 'request-all-001',
      reviewId: review.reviewId,
      reviewRevision: review.reviewRevision,
      decision: 'approve',
      candidateIds: review.candidates.map(candidate => candidate.candidateId),
    }, remote.runner)
    const result = await confirmDirectorLearningReview(db, scope, actorKey, confirmation, {
      commandRunner: remote.runner,
    })

    expect(result).toMatchObject({ outcome: 'completed', completedCount: 3, totalCount: 3 })
    expect(getDirectorExtractionJob(db, sourceTaskId, scope)?.status)
      .toBe('awaiting_understanding_review')
  })

  it('rejects a replay if the reviewed work was revoked after the first response', async () => {
    const records = candidateRecords()
    const remote = remoteRunner(records)
    const [review] = await listDirectorLearningReviews(db, scope, { commandRunner: remote.runner })
    const candidateId = review.candidates.find(candidate => candidate.title === '进入环境')!.candidateId
    const selection = {
      requestId: 'request-work-revoked-001',
      reviewId: review.reviewId,
      reviewRevision: review.reviewRevision,
      decision: 'reject' as const,
      candidateIds: [candidateId],
    }
    const input = await prepareConfirmation(db, selection, remote.runner)
    expect((await confirmDirectorLearningReview(db, scope, actorKey, input, {
      commandRunner: remote.runner,
    })).outcome).toBe('completed')
    const work = records.get(`works:${workId}`)!
    work.state = '草稿'
    work.reviewed = false
    work.fields['版本'] = 'v1.0.1'

    expect((await confirmDirectorLearningReview(db, scope, actorKey, input, {
      commandRunner: remote.runner,
    })).outcome).toBe('conflict')
  })

  it('recovers a persisted CAS after response and immediate readback are lost', async () => {
    const records = candidateRecords()
    const remote = remoteRunner(records)
    const [review] = await listDirectorLearningReviews(db, scope, { commandRunner: remote.runner })
    const candidateId = review.candidates.find(candidate => candidate.title === '进入环境')!.candidateId
    const selection = {
      requestId: 'request-recover-001',
      reviewId: review.reviewId,
      reviewRevision: review.reviewRevision,
      decision: 'approve' as const,
      candidateIds: [candidateId],
    }
    const input = await prepareConfirmation(db, selection, remote.runner)
    remote.loseResponseAndReadbackOnce()
    expect((await confirmDirectorLearningReview(db, scope, actorKey, input, {
      commandRunner: remote.runner,
    })).outcome).toBe('unknown')
    expect((await confirmDirectorLearningReview(db, scope, actorKey, input, {
      commandRunner: remote.runner,
    })).outcome).toBe('completed')
    expect(records.get('story_nodes:STORY-REVIEW-A')).toMatchObject({
      state: '已确认', reviewed: true,
    })
    expect(remote.reviewCalls()).toBe(2)
  })

  it('cancels only the same actor pending batch without a Feishu review', async () => {
    const remote = remoteRunner(candidateRecords())
    const [review] = await listDirectorLearningReviews(db, scope, { commandRunner: remote.runner })
    const candidateId = review.candidates.find(candidate => candidate.title === '进入环境')!.candidateId
    const confirmation = await prepareConfirmation(db, {
      requestId: 'request-cancel-001',
      reviewId: review.reviewId,
      reviewRevision: review.reviewRevision,
      decision: 'reject',
      candidateIds: [candidateId],
    }, remote.runner)

    expect(() => cancelDirectorLearningReview(db, scope, 'another-actor', confirmation))
      .toThrow('director_extraction_review_batch_not_found')
    expect(cancelDirectorLearningReview(db, scope, actorKey, confirmation)).toMatchObject({
      batchId: confirmation.batchId, count: 1, status: 'cancelled',
    })
    expect(remote.reviewCalls()).toBe(0)
  })

  it('rejects cross-scope and non-receipt selections', async () => {
    const remote = remoteRunner(candidateRecords())
    await expect(listDirectorLearningReviews(db, {
      tenantId: scope.tenantId + 1, workspaceId: scope.workspaceId,
    }, { commandRunner: remote.runner })).rejects.toThrow('director_brain_scope_forbidden')

    const [review] = await listDirectorLearningReviews(db, scope, { commandRunner: remote.runner })
    await expect(prepareDirectorLearningReview(db, scope, actorKey, {
      requestId: 'request-nonreceipt-001',
      reviewId: review.reviewId,
      reviewRevision: review.reviewRevision,
      decision: 'approve',
      candidateIds: ['d'.repeat(64)],
    }, { commandRunner: remote.runner })).rejects.toThrow('director_extraction_review_selection_invalid')
    expect(remote.reviewCalls()).toBe(0)
  })
})
