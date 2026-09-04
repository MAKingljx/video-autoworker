import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import {
  DIRECTOR_EXTRACTION_LEARNING_CONTEXT_MAX_BYTES,
  DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES,
  selectDirectorLearningContext,
  type DirectorLearningRecord,
} from '@/lib/director-extraction-learning'
import {
  canonicalDirectorExtractionJson,
  directorExtractionDigest,
  parseDirectorExtractionOutput,
  parseDirectorLearningContextResult,
  type DirectorExtractionCandidate,
  type DirectorExtractionPhase,
  type DirectorLearningContextResult,
} from '@/lib/director-extraction-state'
import {
  claimNextDirectorExtractionJob,
  directorExtractionPhaseTaskIdentity,
  failDirectorExtractionPhase,
  getDirectorExtractionCheckpoint,
  getDirectorExtractionJob,
  listDirectorExtractionJobsByStatuses,
  registerDirectorExtractionJob,
  resumeDirectorExtractionAfterIntent,
  resumeDirectorExtractionAfterReview,
} from '@/lib/director-extraction-runs'
import {
  directorExtractionProposalBatches,
  directorExtractionProposalRequest,
  drainDirectorExtractionJobs,
  loadReviewedDirectorReferences,
  runNextDirectorExtractionPhase,
  type DirectorExtractionProposalItem,
  type DirectorExtractionPhaseRunner,
} from '@/lib/director-extraction-service'
import { isDirectorExtractionDeterministicConflict } from '@/lib/director-extraction-errors'
import {
  directorEvidenceBindingForResolvedWork,
  directorEvidenceDigest,
  serializeDirectorCommandInput,
  type DirectorCommandRunner,
} from '@/lib/director-evidence-delivery-core'
import {
  directorEvidenceProjectionContractDigest,
  getDirectorEvidenceOutbox,
} from '@/lib/director-evidence-outbox'
import {
  directorEvidenceFixtureItem,
  persistDirectorEvidenceFixtureReceipt,
} from '@/lib/__tests__/fixtures/director-evidence'
import { createDeterministicDirectorExtractionFixtureRunner } from '@/lib/__tests__/fixtures/director-extraction'

const scope = { tenantId: 73, workspaceId: 83 }
const workId = 'WORK-RESILIENCE-001'
const openDatabases: Database.Database[] = []
const originalScope = {
  tenantId: process.env.MC_OPENCLAW_TENANT_ID,
  workspaceId: process.env.MC_OPENCLAW_WORKSPACE_ID,
}

beforeEach(() => {
  process.env.MC_OPENCLAW_TENANT_ID = String(scope.tenantId)
  process.env.MC_OPENCLAW_WORKSPACE_ID = String(scope.workspaceId)
})

function database(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  openDatabases.push(db)
  return db
}

afterEach(() => {
  while (openDatabases.length) openDatabases.pop()!.close()
  if (originalScope.tenantId === undefined) delete process.env.MC_OPENCLAW_TENANT_ID
  else process.env.MC_OPENCLAW_TENANT_ID = originalScope.tenantId
  if (originalScope.workspaceId === undefined) delete process.env.MC_OPENCLAW_WORKSPACE_ID
  else process.env.MC_OPENCLAW_WORKSPACE_ID = originalScope.workspaceId
})

function learningRecord(
  table: DirectorLearningRecord['table'],
  stableId: string,
  fields: Record<string, unknown> = {},
): DirectorLearningRecord {
  return { table, stableId, state: '已确认', reviewed: true, fields }
}

function learningContext(input: {
  workId?: string
  activeIntent?: DirectorLearningRecord | null
  people?: DirectorLearningRecord[]
  stories?: DirectorLearningRecord[]
  techniques?: DirectorLearningRecord[]
} = {}): DirectorLearningContextResult {
  const selectedWorkId = input.workId || workId
  const work = {
    activeIntent: input.activeIntent || null,
    people_profiles: input.people || [],
    story_nodes: input.stories || [],
    story_relations: [],
    material_judgments: [],
    narrative_plans: [],
    director_cases: [],
  }
  const project = { director_cases: [], skills_techniques: input.techniques || [] }
  const counts = {
    work: {
      activeIntent: work.activeIntent ? 1 : 0,
      people_profiles: work.people_profiles.length,
      story_nodes: work.story_nodes.length,
      story_relations: 0,
      material_judgments: 0,
      narrative_plans: 0,
      director_cases: 0,
    },
    project: {
      director_cases: 0,
      skills_techniques: project.skills_techniques.length,
    },
    total: 0,
  }
  counts.total = Object.values(counts.work).reduce((sum, count) => sum + count, 0)
    + Object.values(counts.project).reduce((sum, count) => sum + count, 0)
  const snapshot = {
    schemaVersion: 1 as const,
    projectId: 'PROJ-VIDEO-AUTOWORKER' as const,
    workId: selectedWorkId,
    counts,
    work,
    project,
  }
  return parseDirectorLearningContextResult(selectedWorkId, {
    ok: true,
    action: 'learning_context',
    workId: selectedWorkId,
    snapshot,
    digest: directorExtractionDigest(snapshot),
  })
}

function candidate(overrides: Partial<DirectorExtractionCandidate> = {}): DirectorExtractionCandidate {
  const base: DirectorExtractionCandidate = {
    candidateKey: 'story-resilience-001',
    kind: 'story_node',
    title: '人物改变判断',
    summary: '人物在现场证据出现后改变原有判断。',
    rationale: '变化前后均有可核验的画面证据。',
    confidence: 0.8,
    evidenceRefs: [{ materialId: 'MAT-RESILIENCE-001', startSeconds: 0, endSeconds: 1 }],
    sourceCandidateKeys: [],
    fields: {
      '节点名称': '重新判断',
      '节点类型': '人物变化',
      '节点内容': '人物改变原有判断。',
      '置信度': 0.8,
    },
  }
  const value = { ...base, ...overrides }
  const semanticKeys = {
    person_profile: ['人物名称', '人物弧光', '矛盾'],
    story_node: ['节点名称', '节点内容', '变化'],
    story_relation: ['关系名称', '判断理由', '判断理由'],
    material_judgment: ['判断名称', '使用理由', '使用理由'],
    narrative_proposal: ['方案名称', '结构说明', '结构说明'],
    director_case: ['案例名称', '上下文', '判断原因'],
    technique: ['知识名称', '执行方法', '为什么有效'],
  } as const
  const [titleKey, summaryKey, rationaleKey] = semanticKeys[
    value.kind as keyof typeof semanticKeys
  ]
  const fields = { ...value.fields }
  if (overrides.title === undefined) value.title = String(fields[titleKey] || value.title)
  else fields[titleKey] = value.title
  if (overrides.summary === undefined) value.summary = String(fields[summaryKey] || value.summary)
  else fields[summaryKey] = value.summary
  if (overrides.rationale === undefined) value.rationale = String(fields[rationaleKey] || value.rationale)
  else fields[rationaleKey] = value.rationale
  if (fields[titleKey] === undefined) fields[titleKey] = value.title
  if (fields[summaryKey] === undefined) fields[summaryKey] = value.summary
  if (fields[rationaleKey] === undefined) fields[rationaleKey] = value.rationale
  return { ...value, fields }
}

function output(phase: DirectorExtractionPhase, candidates: DirectorExtractionCandidate[]) {
  return { schemaVersion: 1 as const, phase, candidates }
}

function visualPayload(totalCharacters: number, itemCount = 40): Array<Record<string, unknown>> {
  if (totalCharacters < itemCount || totalCharacters > itemCount * 4_000) {
    throw new Error('test_visual_payload_out_of_range')
  }
  const base = Math.floor(totalCharacters / itemCount)
  const remainder = totalCharacters % itemCount
  return Array.from({ length: itemCount }, (_, index) => ({
    index: index + 1,
    timeRange: '00:00:00-00:00:01',
    visualAnalysis: 'x'.repeat(base + (index < remainder ? 1 : 0)),
    confidence: 0.9,
  }))
}

function seedSource(
  db: Database.Database,
  input: {
    taskId: string
    selectedWorkId?: string
    completedAt?: number
    timeline?: Array<Record<string, unknown>>
    maxAttempts?: number
    register?: boolean
  },
): void {
  const selectedWorkId = input.selectedWorkId || workId
  const outputValue = {
    taskType: 'video-analysis',
    materialId: `MAT-${input.taskId}`,
    analysisVersion: 'video-analysis-v3',
    mediaDurationSeconds: 60,
    summary: '人物进入环境后改变了判断。',
    chapters: [{
      index: 1,
      startTime: '00:00:00',
      endTime: '00:01:00',
      summary: '人物进入环境。',
      confidence: 0.9,
    }],
    timeline: input.timeline || [{
      index: 1,
      timeRange: '00:00:00-00:00:01',
      visualAnalysis: '人物进入环境。',
      confidence: 0.9,
    }],
  }
  const binding = directorEvidenceBindingForResolvedWork(selectedWorkId, selectedWorkId)
  db.prepare(`
    INSERT OR IGNORE INTO n8n_workflow_bindings (
      id, name, webhook_path, task_type, workspace_id, tenant_id
    ) VALUES (173, '视频分析', 'webhook/resilience', 'video-analysis', ?, ?)
  `).run(scope.workspaceId, scope.tenantId)
  db.prepare(`
    INSERT INTO n8n_task_runs (
      task_id, idempotency_key, binding_id, status, source, requested_by,
      routing, input, delivery, output, attempt_count, max_attempts,
      workspace_id, tenant_id, completed_at, updated_at
    ) VALUES (?, ?, 173, 'succeeded', 'openclaw', 'second-original',
      '{}', ?, '{"mode":"none"}', ?, 1, 1, ?, ?, ?, ?)
  `).run(
    input.taskId,
    `${input.taskId}-idem`,
    JSON.stringify({ directorEvidence: binding }),
    JSON.stringify(outputValue),
    scope.workspaceId,
    scope.tenantId,
    input.completedAt || 100,
    input.completedAt || 100,
  )
  if (input.register === false) return
  const registered = registerDirectorExtractionJob(db, input.taskId, scope, {
    maxAttempts: input.maxAttempts,
  })
  if (!registered.job.workId || !registered.job.workQueryDigest) {
    throw new Error('test_director_work_binding_missing')
  }
  db.prepare(`
    INSERT INTO n8n_director_evidence_outbox (
      task_id, binding_id, tenant_id, workspace_id, work_id, query_digest,
      projection_contract_digest, idempotency_key, result_sha256, status, delivered_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'delivered', 100)
  `).run(
    registered.job.sourceTaskId,
    registered.job.sourceBindingId,
    registered.job.tenantId,
    registered.job.workspaceId,
    registered.job.workId,
    registered.job.workQueryDigest,
    directorEvidenceProjectionContractDigest(),
    directorEvidenceDigest({ taskId: input.taskId, projection: 'resilience' }),
    registered.job.sourceResultSha256,
  )
  persistDirectorEvidenceFixtureReceipt(
    db,
    getDirectorEvidenceOutbox(db, registered.job.sourceTaskId)!,
    [directorEvidenceFixtureItem(1, {
      '任务 ID': input.taskId,
      '素材 ID': String(outputValue.materialId),
    })],
    input.completedAt || 100,
  )
}

type BrainHarness = {
  commandRunner: DirectorCommandRunner
  proposalWrites: () => number
  setLearningContext: (context: DirectorLearningContextResult) => void
  failNextProposal: () => void
}

function brainHarness(initialContext = learningContext()): BrainHarness {
  let context = initialContext
  let proposalWrites = 0
  let shouldFailProposal = false
  let sequence = 0
  const commandRunner: DirectorCommandRunner = async (command, input) => {
    if (command === 'transform') {
      return {
        workId: input.workId,
        items: [{
          '证据 ID': 'EVIDENCE-RESILIENCE-001',
          '起始时间码': '00:00:00',
          '结束时间码': '00:01:00',
          '观察摘要': '人物进入环境后改变了判断。',
        }],
      }
    }
    if (command === 'project-evidence') {
      const items = input.items as Array<Record<string, unknown>>
      return {
        ok: true,
        action: 'project-evidence',
        workId: input.workId,
        count: items.length,
        created: items.length,
        unchanged: 0,
        results: items.map(item => ({
          stableId: String(item['证据 ID']),
          outcome: 'created',
          record: {
            table: 'material_evidence',
            stableId: String(item['证据 ID']),
            state: '候选',
            reviewed: false,
            fields: item,
          },
        })),
      }
    }
    if (input.action === 'get_many') {
      const stableIds = input.stableIds as string[]
      return {
        ok: true,
        action: 'get_many',
        table: input.table,
        workId: input.workId,
        missing: [],
        records: stableIds.map(stableId => ({
          table: input.table,
          stableId,
          state: '已确认',
          reviewed: true,
          fields: input.table === 'skills_techniques'
            ? { '来源作品 ID': context.snapshot.workId }
            : { '作品 ID': input.workId },
        })),
      }
    }
    if (input.action === 'workflow') {
      return {
        ok: true,
        action: 'workflow',
        workId: input.workId,
        activeIntentId: context.snapshot.work.activeIntent?.stableId || null,
      }
    }
    if (input.action === 'get' && input.table === 'director_intents') {
      const activeIntent = context.snapshot.work.activeIntent
      const found = activeIntent?.stableId === input.stableId
      return {
        ok: true,
        action: 'get',
        table: 'director_intents',
        workId: input.workId,
        stableId: input.stableId,
        found,
        record: found ? activeIntent : null,
      }
    }
    if (input.action === 'learning_context') return context
    if (input.action === 'propose_batch') {
      proposalWrites++
      if (shouldFailProposal) {
        shouldFailProposal = false
        throw new Error('remote_outcome_unknown')
      }
      const table = String(input.table)
      const items = input.items as Array<{ fields: Record<string, unknown> }>
      const results = items.map(item => {
        const stableId = `${table.toUpperCase()}-${String(++sequence).padStart(3, '0')}`
        return {
          ok: true,
          action: 'propose',
          table,
          stableId,
          outcome: 'created',
          record: { table, stableId, state: '候选', reviewed: false, fields: item.fields },
        }
      })
      return {
        ok: true,
        action: 'propose_batch',
        table,
        workId: table === 'skills_techniques' ? null : input.workId,
        count: results.length,
        created: results.length,
        unchanged: 0,
        results,
      }
    }
    throw new Error(`unexpected_director_command:${command}:${String(input.action || '')}`)
  }
  return {
    commandRunner,
    proposalWrites: () => proposalWrites,
    setLearningContext: next => { context = next },
    failNextProposal: () => { shouldFailProposal = true },
  }
}

async function advanceToUnderstanding(
  db: Database.Database,
  taskId: string,
  brain: BrainHarness,
): Promise<void> {
  const perception = await runNextDirectorExtractionPhase(db, {
    commandRunner: brain.commandRunner,
    nowSeconds: 1_000,
  })
  expect(perception).toMatchObject({ outcome: 'awaiting_review' })
  const evidenceId = getDirectorExtractionCheckpoint(db, taskId, 'perception')!
    .projectionReceipt!.entries[0]!.stableId
  resumeDirectorExtractionAfterReview(db, taskId, scope, {
    material_evidence: [evidenceId],
  }, { nowSeconds: 1_001 })
}

function understandingRunner(
  onInput?: (input: Record<string, unknown>) => void,
  previousVersionStableId?: string,
): DirectorExtractionPhaseRunner {
  return async (phase, input, job) => {
    onInput?.(input)
    const next = previousVersionStableId
      ? candidate({
          candidateKey: 'person-resilience-001',
          kind: 'person_profile',
          title: '人物档案更新',
          evidenceRefs: [{ materialId: job.materialId, startSeconds: 0, endSeconds: 1 }],
          previousVersionStableId,
          fields: {
            '人物名称': '被引用人物',
            '人物 ID': 'PERSON-STABLE-001',
            '身份': '新增观察',
            '置信度': 0.8,
          },
        })
      : candidate({
          evidenceRefs: [{ materialId: job.materialId, startSeconds: 0, endSeconds: 1 }],
        })
    return output(phase, [next])
  }
}

async function runSizedUnderstanding(totalCharacters: number) {
  const db = database()
  const taskId = `sized-${totalCharacters}`
  seedSource(db, { taskId, timeline: visualPayload(totalCharacters) })
  const brain = brainHarness()
  await advanceToUnderstanding(db, taskId, brain)
  const writesBefore = brain.proposalWrites()
  let phaseInputBytes: number | null = null
  const runner = vi.fn<DirectorExtractionPhaseRunner>(understandingRunner(input => {
    phaseInputBytes = Buffer.byteLength(JSON.stringify(input), 'utf8')
  }))
  const result = await runNextDirectorExtractionPhase(db, {
    commandRunner: brain.commandRunner,
    runner,
    nowSeconds: 1_002,
  })
  return {
    result,
    phaseInputBytes,
    modelCalls: runner.mock.calls.length,
    proposalWrites: brain.proposalWrites() - writesBefore,
  }
}

async function advanceToUnderstandingReview(
  db: Database.Database,
  taskId: string,
  brain: BrainHarness,
): Promise<void> {
  seedSource(db, { taskId })
  await expect(runNextDirectorExtractionPhase(db, {
    commandRunner: brain.commandRunner,
    nowSeconds: 900,
  })).resolves.toMatchObject({ outcome: 'awaiting_review' })
  await expect(drainDirectorExtractionJobs(db, {
    commandRunner: brain.commandRunner,
    runner: createDeterministicDirectorExtractionFixtureRunner(),
    limit: 1,
    nowSeconds: 901,
  })).resolves.toMatchObject({ resumed: 1, awaitingReview: 1 })
  expect(getDirectorExtractionJob(db, taskId, scope)).toMatchObject({
    status: 'awaiting_understanding_review',
    currentPhase: 'understanding',
  })
}

describe('director extraction deterministic and candidate boundaries', () => {
  it('splits proposal batches by actual UTF-8 wire bytes and projects one legal large candidate', () => {
    const narrativeCandidate = candidate({
      candidateKey: 'narrative-wire-boundary',
      kind: 'narrative_proposal',
      sourceStableIds: ['STORY-001'],
      fields: {
        '方案名称': '人物选择',
        '人物线': '人'.repeat(4_000),
        '事件线': '事'.repeat(4_000),
        '时间线': '时'.repeat(4_000),
        '地点线': '地'.repeat(4_000),
        '情绪线': '情'.repeat(4_000),
        '主题线': '主'.repeat(4_000),
        '冲突线': '冲'.repeat(4_000),
        '结构说明': '结'.repeat(8_000),
        '故事脚本': '剧'.repeat(8_000),
      },
    })
    const item: DirectorExtractionProposalItem = {
      candidate: narrativeCandidate,
      table: 'narrative_plans',
      fields: narrativeCandidate.fields,
      references: {
        intentVersionId: 'INTENT-001',
        nodeIds: ['STORY-001'],
        evidenceIds: ['EVIDENCE-001'],
      },
    }
    const first = directorExtractionProposalBatches(workId, 'narrative_plans', [item])
    const replay = directorExtractionProposalBatches(workId, 'narrative_plans', [item])
    expect(first).toEqual(replay)
    expect(first).toHaveLength(1)
    const projectedFields = first[0]![0]!.fields
    expect(projectedFields).toEqual(item.fields)
    expect(projectedFields['结构说明']).toBe('结'.repeat(8_000))
    expect(projectedFields['故事脚本']).toBe('剧'.repeat(8_000))
    expect(JSON.stringify(projectedFields)).not.toContain('飞书候选投影已缩写')
    expect(() => serializeDirectorCommandInput(
      'propose-batch', directorExtractionProposalRequest(workId, 'narrative_plans', first[0]!),
    )).not.toThrow()

    const storyItems = Array.from({ length: 8 }, (_, index): DirectorExtractionProposalItem => {
      const story = candidate({
        candidateKey: `story-wire-${index}`,
        fields: {
          '节点名称': `节点 ${index}`,
          '节点类型': '事件',
          '节点内容': '叙'.repeat(3_000),
          '变化': '变'.repeat(1_000),
          '置信度': 0.8,
        },
      })
      return {
        candidate: story,
        table: 'story_nodes',
        fields: story.fields,
        references: { evidenceIds: ['EVIDENCE-001'] },
      }
    })
    const batches = directorExtractionProposalBatches(workId, 'story_nodes', storyItems)
    expect(batches.length).toBeGreaterThan(0)
    expect(batches.flat()).toHaveLength(storyItems.length)
    expect(batches.flat().map(entry => entry.fields)).toEqual(storyItems.map(entry => entry.fields))
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(8)
      expect(() => serializeDirectorCommandInput(
        'propose-batch', directorExtractionProposalRequest(workId, 'story_nodes', batch),
      )).not.toThrow()
    }
  })

  it('stops deterministic size failures without classifying transient transport failures as conflicts', () => {
    for (const code of [
      'director_extraction_learning_context_budget_exceeded',
      'director_extraction_output_too_large',
      'director_extraction_phase_input_too_large',
      'director_extraction_seed_too_large',
      'learning_context_output_too_large',
      'learning_context_request_budget_exceeded',
    ]) {
      expect(isDirectorExtractionDeterministicConflict(code)).toBe(true)
    }
    expect(isDirectorExtractionDeterministicConflict('director_extraction_model_timeout')).toBe(false)
    expect(isDirectorExtractionDeterministicConflict('remote_outcome_unknown')).toBe(false)
  })

  it('canonicalizes equivalent objects deterministically and repeats identical parsing', () => {
    const left = { z: 3, nested: { b: true, a: ['一', 2] }, a: null }
    const right = { a: null, nested: { a: ['一', 2], b: true }, z: 3 }

    expect(canonicalDirectorExtractionJson(left)).toBe(canonicalDirectorExtractionJson(right))
    expect(directorExtractionDigest(left)).toBe(directorExtractionDigest(right))

    const raw = output('understanding', [candidate({
      title: '  人物改变判断  ',
      summary: '第一行\r\n第二行',
    })])
    const first = parseDirectorExtractionOutput('understanding', structuredClone(raw))
    const second = parseDirectorExtractionOutput('understanding', structuredClone(raw))
    expect(first).toEqual(second)
    expect(directorExtractionDigest(first)).toBe(directorExtractionDigest(second))
    expect(first.candidates[0]!.title).toBe('人物改变判断')
    expect(first.candidates[0]!.summary).toBe('第一行\n第二行')
  })

  it('rejects oversized, over-deep, and sensitive candidates before projection', () => {
    expect(() => parseDirectorExtractionOutput('understanding', output('understanding', [
      candidate({ summary: '摘'.repeat(4_001) }),
    ]))).toThrow()

    let nested: unknown = 'leaf'
    for (let depth = 0; depth < 10; depth++) nested = { child: nested }
    expect(() => parseDirectorExtractionOutput('understanding', output('understanding', [
      candidate({ fields: { ...candidate().fields, '变化': nested } }),
    ]))).toThrow('director_extraction_candidate_too_deep')

    expect(() => parseDirectorExtractionOutput('understanding', output('understanding', [
      candidate({ fields: { ...candidate().fields, '访问令牌': 'plain-secret' } }),
    ]))).toThrow('director_extraction_candidate_sensitive')

    expect(() => parseDirectorExtractionOutput('understanding', output('understanding', [
      candidate({ fields: { ...candidate().fields, '变化': Array.from({ length: 129 }, () => '值') } }),
    ]))).toThrow('director_extraction_candidate_too_large')

    expect(() => parseDirectorExtractionOutput('understanding', output(
      'understanding',
      Array.from({ length: 65 }, (_, index) => candidate({ candidateKey: `story-${index}` })),
    ))).toThrow()
  })
})

describe('director extraction learning-context resilience', () => {
  it('is deterministic under the 80 KiB cap and enforces the exact serialized boundary', () => {
    const source = learningContext({
      activeIntent: learningRecord('director_intents', 'INTENT-ACTIVE-001', {
        '核心主题': '人物如何改变判断',
      }),
      people: Array.from({ length: 120 }, (_, index) => learningRecord(
        'people_profiles',
        `PROFILE-${String(index).padStart(3, '0')}`,
        {
          '人物名称': `人物 ${index}`,
          '人物 ID': `PERSON-${index}`,
          '人物弧光': `人物如何改变判断 ${index} ${'背景'.repeat(300)}`,
        },
      )),
      stories: Array.from({ length: 120 }, (_, index) => learningRecord(
        'story_nodes',
        `STORY-${String(index).padStart(3, '0')}`,
        { '节点名称': `节点 ${index}`, '节点内容': `变化 ${'证据'.repeat(300)}` },
      )),
    })
    const first = selectDirectorLearningContext({
      source,
      phase: 'judgment',
      objective: '人物如何改变判断',
      maxBytes: DIRECTOR_EXTRACTION_LEARNING_CONTEXT_MAX_BYTES,
    })
    const second = selectDirectorLearningContext({
      source,
      phase: 'judgment',
      objective: '人物如何改变判断',
      maxBytes: DIRECTOR_EXTRACTION_LEARNING_CONTEXT_MAX_BYTES,
    })
    expect(first).toEqual(second)
    expect(first.learningContextTrace.byteLength)
      .toBeLessThanOrEqual(DIRECTOR_EXTRACTION_LEARNING_CONTEXT_MAX_BYTES)
    expect(DIRECTOR_EXTRACTION_LEARNING_CONTEXT_MAX_BYTES
      - first.learningContextTrace.byteLength).toBeLessThan(2_500)
    expect(first.learningContextTrace.omittedCounts.work.people_profiles).toBeGreaterThan(0)

    const mandatoryOnly = learningContext({
      activeIntent: learningRecord('director_intents', 'INTENT-BOUNDARY-001', {
        '核心主题': '不可省略的导演意图',
      }),
    })
    const exact = selectDirectorLearningContext({
      source: mandatoryOnly,
      phase: 'judgment',
      objective: '导演意图',
      maxBytes: DIRECTOR_EXTRACTION_LEARNING_CONTEXT_MAX_BYTES,
    })
    expect(selectDirectorLearningContext({
      source: mandatoryOnly,
      phase: 'judgment',
      objective: '导演意图',
      maxBytes: exact.learningContextTrace.byteLength,
    })).toEqual(exact)
    expect(() => selectDirectorLearningContext({
      source: mandatoryOnly,
      phase: 'judgment',
      objective: '导演意图',
      maxBytes: exact.learningContextTrace.byteLength - 1,
    })).toThrow('director_extraction_learning_context_budget_exceeded')
  })

  it('keeps cross-work techniques reusable only in the project bucket', () => {
    const source = learningContext({
      workId: 'WORK-TARGET-001',
      people: [learningRecord('people_profiles', 'PROFILE-TARGET-001', {
        '人物名称': '目标作品人物',
        '人物 ID': 'PERSON-TARGET-001',
      })],
      techniques: [learningRecord('skills_techniques', 'TECHNIQUE-FROM-OTHER-WORK', {
        '知识名称': '压力前后对照',
        '适用条件': '人物受压力后改变决定',
        '来源作品 ID': 'WORK-OTHER-999',
      })],
    })
    const selected = selectDirectorLearningContext({
      source,
      phase: 'judgment',
      objective: '压力前后对照',
      maxBytes: DIRECTOR_EXTRACTION_LEARNING_CONTEXT_MAX_BYTES,
    })
    expect(selected.learningContext.workId).toBe('WORK-TARGET-001')
    expect(selected.learningContext.snapshot.project.skills_techniques)
      .toEqual([expect.objectContaining({ stableId: 'TECHNIQUE-FROM-OTHER-WORK' })])
    expect(Object.values(selected.learningContext.snapshot.work).flatMap(value => (
      Array.isArray(value) ? value.map(record => record.stableId) : value ? [value.stableId] : []
    ))).not.toContain('TECHNIQUE-FROM-OTHER-WORK')
  })
})

describe('director extraction queue and service resilience', () => {
  it('does not discover or register unrequested historical sources while draining', async () => {
    const db = database()
    seedSource(db, {
      taskId: 'historical-source-without-explicit-backfill',
      register: false,
    })
    const brain = brainHarness()

    await expect(drainDirectorExtractionJobs(db, {
      commandRunner: brain.commandRunner,
      runner: createDeterministicDirectorExtractionFixtureRunner(),
      limit: 5,
      nowSeconds: 700,
    })).resolves.toMatchObject({ processed: 0, resumed: 0, completed: 0, failed: 0 })
    expect(getDirectorExtractionJob(
      db, 'historical-source-without-explicit-backfill', scope,
    )).toBeNull()
    expect(db.prepare(`
      SELECT COUNT(*) FROM n8n_task_runs
      WHERE source = 'n8n-node'
        AND json_extract(input, '$.childKind') = 'director-extraction'
    `).pluck().get()).toBe(0)
  })

  it('opens the judgment phase when an active intent already exists at understanding review', async () => {
    const db = database()
    const taskId = 'intent-already-active'
    const intent = learningRecord('director_intents', 'INTENT-ALREADY-ACTIVE', {
      '作品 ID': workId,
      '核心主题': '人物如何改变判断',
    })
    const brain = brainHarness(learningContext({ activeIntent: intent }))
    await advanceToUnderstandingReview(db, taskId, brain)

    await expect(drainDirectorExtractionJobs(db, {
      commandRunner: brain.commandRunner,
      runner: createDeterministicDirectorExtractionFixtureRunner(),
      limit: 1,
      nowSeconds: 902,
    })).resolves.toMatchObject({ resumed: 1, awaitingReview: 1 })
    expect(getDirectorExtractionJob(db, taskId, scope)).toMatchObject({
      status: 'awaiting_judgment_review',
      currentPhase: 'judgment',
      reviewedReferences: { director_intents: ['INTENT-ALREADY-ACTIVE'] },
    })
    const rootId = getDirectorExtractionJob(db, taskId, scope)!.sourceTaskId
    const understandingId = directorExtractionPhaseTaskIdentity('task', rootId, 'understanding')
    expect(db.prepare(`
      SELECT COUNT(*) FROM director_extraction_review_receipts
      WHERE phase_task_id = ? AND receipt_type = 'intent_review'
    `).pluck().get(understandingId)).toBe(1)
  })

  it('waits without judgment until intent arrives, then creates judgment exactly once', async () => {
    const db = database()
    const taskId = 'intent-arrives-later'
    const brain = brainHarness(learningContext())
    await advanceToUnderstandingReview(db, taskId, brain)

    await expect(drainDirectorExtractionJobs(db, {
      commandRunner: brain.commandRunner,
      runner: createDeterministicDirectorExtractionFixtureRunner(),
      limit: 1,
      nowSeconds: 902,
    })).resolves.toMatchObject({ resumed: 1, processed: 0 })
    expect(getDirectorExtractionJob(db, taskId, scope)).toMatchObject({
      status: 'awaiting_intent_review',
      currentPhase: 'understanding',
    })
    expect(db.prepare(`
      SELECT COUNT(*) FROM n8n_task_runs
      WHERE source = 'n8n-node'
        AND json_extract(input, '$.childKind') = 'director-extraction'
        AND json_extract(input, '$.directorPhase') = 'judgment'
    `).pluck().get()).toBe(0)

    brain.setLearningContext(learningContext({
      activeIntent: learningRecord('director_intents', 'INTENT-LATE', {
        '作品 ID': workId,
        '核心主题': '后到的导演意图',
      }),
    }))
    await expect(drainDirectorExtractionJobs(db, {
      commandRunner: brain.commandRunner,
      runner: createDeterministicDirectorExtractionFixtureRunner(),
      limit: 1,
      nowSeconds: 903,
    })).resolves.toMatchObject({ resumed: 1, awaitingReview: 1 })
    expect(db.prepare(`
      SELECT COUNT(*) FROM n8n_task_runs
      WHERE source = 'n8n-node'
        AND json_extract(input, '$.childKind') = 'director-extraction'
        AND json_extract(input, '$.directorPhase') = 'judgment'
    `).pluck().get()).toBe(1)
  })

  it('fails closed before judgment for a cross-work intent and for active-intent drift', async () => {
    const crossWorkDb = database()
    const crossWorkTaskId = 'intent-cross-work'
    const crossWorkBrain = brainHarness(learningContext({
      activeIntent: learningRecord('director_intents', 'INTENT-CROSS-WORK', {
        '作品 ID': 'WORK-OTHER-999',
        '核心主题': '其他作品意图',
      }),
    }))
    await advanceToUnderstandingReview(crossWorkDb, crossWorkTaskId, crossWorkBrain)
    await expect(drainDirectorExtractionJobs(crossWorkDb, {
      commandRunner: crossWorkBrain.commandRunner,
      runner: createDeterministicDirectorExtractionFixtureRunner(),
      limit: 1,
      nowSeconds: 902,
    })).resolves.toMatchObject({ resumed: 0, processed: 0 })
    expect(getDirectorExtractionJob(crossWorkDb, crossWorkTaskId, scope)).toMatchObject({
      status: 'awaiting_understanding_review',
      currentPhase: 'understanding',
    })
    expect(crossWorkDb.prepare(`
      SELECT COUNT(*) FROM n8n_task_runs
      WHERE source = 'n8n-node'
        AND json_extract(input, '$.childKind') = 'director-extraction'
        AND json_extract(input, '$.directorPhase') = 'judgment'
    `).pluck().get()).toBe(0)

    const driftDb = database()
    const driftTaskId = 'intent-drift'
    const driftBrain = brainHarness(learningContext())
    await advanceToUnderstandingReview(driftDb, driftTaskId, driftBrain)
    const understanding = getDirectorExtractionCheckpoint(driftDb, driftTaskId, 'understanding')!
    const storyIds = understanding.projectionReceipt!.entries
      .filter(entry => entry.table === 'story_nodes')
      .map(entry => entry.stableId)
    const waiting = resumeDirectorExtractionAfterReview(
      driftDb, driftTaskId, scope, { story_nodes: storyIds }, { nowSeconds: 902 },
    )
    expect(waiting.status).toBe('awaiting_intent_review')
    resumeDirectorExtractionAfterIntent(
      driftDb, driftTaskId, scope, 'INTENT-LOCKED', { nowSeconds: 903 },
    )
    driftBrain.setLearningContext(learningContext({
      activeIntent: learningRecord('director_intents', 'INTENT-DRIFTED', {
        '作品 ID': workId,
        '核心主题': '已经漂移的导演意图',
      }),
    }))
    const runner = vi.fn<DirectorExtractionPhaseRunner>(
      createDeterministicDirectorExtractionFixtureRunner(),
    )
    await expect(runNextDirectorExtractionPhase(driftDb, {
      commandRunner: driftBrain.commandRunner,
      runner,
      nowSeconds: 904,
    })).resolves.toMatchObject({
      outcome: 'failed',
      job: {
        status: 'conflict',
        currentPhase: 'judgment',
        lastErrorCode: 'director_extraction_learning_reference_intent_mismatch',
      },
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('reaches a reviewed later root after five earlier roots remain pending review', async () => {
    const db = database()
    const brain = brainHarness()
    const taskIds = Array.from({ length: 6 }, (_, index) => `fair-waiting-${index}`)
    for (const [index, taskId] of taskIds.entries()) {
      seedSource(db, { taskId, selectedWorkId: `WORK-FAIR-${index}` })
    }
    for (let index = 0; index < taskIds.length; index++) {
      await expect(runNextDirectorExtractionPhase(db, {
        commandRunner: brain.commandRunner,
        nowSeconds: 1_000 + index,
      })).resolves.toMatchObject({ outcome: 'awaiting_review' })
    }
    const firstWindow = listDirectorExtractionJobsByStatuses(
      db, ['awaiting_evidence_review'], 5, { nowSeconds: 0 },
    )
    const ready = taskIds.map(taskId => getDirectorExtractionJob(db, taskId, scope)!)
      .find(job => !firstWindow.some(first => first.sourceTaskId === job.sourceTaskId))!
    const commandRunner: DirectorCommandRunner = async (command, input) => {
      if (command === 'operate' && input.action === 'learning_context') {
        return learningContext({ workId: String(input.workId) })
      }
      if (command === 'operate' && input.action === 'get_many') {
        const reviewed = input.workId === ready.workId
        return {
          ok: true,
          action: 'get_many',
          table: input.table,
          workId: input.workId,
          missing: [],
          records: (input.stableIds as string[]).map(stableId => ({
            table: input.table,
            stableId,
            state: reviewed ? '已确认' : '候选',
            reviewed,
            fields: { '作品 ID': String(input.workId) },
          })),
        }
      }
      return brain.commandRunner(command, input)
    }
    const options = {
      commandRunner,
      runner: understandingRunner(),
      limit: 5,
    }

    await expect(drainDirectorExtractionJobs(db, { ...options, nowSeconds: 0 }))
      .resolves.toMatchObject({ reviewsChecked: 5, resumed: 0, processed: 0 })
    await expect(drainDirectorExtractionJobs(db, { ...options, nowSeconds: 0 }))
      .resolves.toMatchObject({ reviewsChecked: 5, resumed: 0, processed: 0 })
    const advanced = await drainDirectorExtractionJobs(db, { ...options, nowSeconds: 60 })
    expect(advanced).toMatchObject({ reviewsChecked: 5, resumed: 1 })
    expect(getDirectorExtractionJob(db, ready.sourceTaskId, scope)).toMatchObject({
      status: 'awaiting_understanding_review',
      lastErrorCode: null,
    })
  })

  it('fails closed when review records are rebound to another table or work', async () => {
    for (const defect of ['response-work', 'record-table', 'record-work'] as const) {
      const db = database()
      const taskId = `review-binding-${defect}`
      seedSource(db, { taskId })
      const brain = brainHarness()
      await expect(runNextDirectorExtractionPhase(db, {
        commandRunner: brain.commandRunner,
        nowSeconds: 1_200,
      })).resolves.toMatchObject({ outcome: 'awaiting_review' })

      const commandRunner: DirectorCommandRunner = async (command, input) => {
        const result = await brain.commandRunner(command, input)
        if (command !== 'operate' || input.action !== 'get_many') return result
        const invalid = structuredClone(result) as Record<string, unknown>
        if (defect === 'response-work') invalid.workId = 'WORK-OTHER-RESPONSE'
        const records = invalid.records as Array<Record<string, unknown>>
        if (defect === 'record-table') records[0]!.table = 'story_nodes'
        if (defect === 'record-work') {
          records[0]!.fields = { '作品 ID': 'WORK-OTHER-RECORD' }
        }
        return invalid
      }
      await expect(drainDirectorExtractionJobs(db, {
        commandRunner,
        runner: createDeterministicDirectorExtractionFixtureRunner(),
        limit: 1,
        nowSeconds: 1_201,
      })).resolves.toMatchObject({ reviewsChecked: 1, resumed: 0, processed: 0 })
      expect(getDirectorExtractionJob(db, taskId, scope)).toMatchObject({
        status: 'awaiting_evidence_review',
        currentPhase: 'perception',
      })
    }
  })

  it.each([
    ['record-table', 'story_nodes', workId],
    ['record-work', 'material_evidence', 'WORK-OTHER-RECORD'],
  ] as const)(
    'rejects a reviewed dependency rebound through %s before it reaches phase input',
    async (_defect, recordTable, recordWorkId) => {
      const commandRunner: DirectorCommandRunner = async (_command, input) => ({
        ok: true,
        action: 'get_many',
        table: input.table,
        workId: input.workId,
        missing: [],
        records: [{
          table: recordTable,
          stableId: 'EVIDENCE-BOUND-001',
          state: '已确认',
          reviewed: true,
          fields: { '作品 ID': recordWorkId },
        }],
      })
      await expect(loadReviewedDirectorReferences(workId, {
        material_evidence: ['EVIDENCE-BOUND-001'],
      }, commandRunner)).rejects.toThrow('director_extraction_reference_not_reviewed')
    },
  )

  it('rejects a reviewed technique whose source works exclude the current work', async () => {
    const commandRunner: DirectorCommandRunner = async (_command, input) => ({
      ok: true,
      action: 'get_many',
      table: input.table,
      workId: null,
      missing: [],
      records: [{
        table: 'skills_techniques',
        stableId: 'TECHNIQUE-OTHER-WORK-001',
        state: '已确认',
        reviewed: true,
        fields: { '来源作品 ID': 'WORK-OTHER-001\r\nWORK-OTHER-002' },
      }],
    })
    await expect(loadReviewedDirectorReferences(workId, {
      skills_techniques: ['TECHNIQUE-OTHER-WORK-001'],
    }, commandRunner)).rejects.toThrow('director_extraction_reference_not_reviewed')
  })

  it('rejects a cross-phase candidate key before any later-phase projection write', async () => {
    const db = database()
    const taskId = 'candidate-key-cross-phase'
    const intent = learningRecord('director_intents', 'INTENT-CANDIDATE-KEY', {
      '作品 ID': workId,
      '核心主题': '人物变化',
    })
    const brain = brainHarness(learningContext({ activeIntent: intent }))
    await advanceToUnderstandingReview(db, taskId, brain)
    const historicalKey = getDirectorExtractionCheckpoint(
      db, taskId, 'understanding',
    )!.candidateOutput.candidates[0]!.candidateKey
    const baseRunner = createDeterministicDirectorExtractionFixtureRunner()
    const runner = vi.fn<DirectorExtractionPhaseRunner>(async (phase, input, job) => {
      const result = parseDirectorExtractionOutput(
        phase,
        await baseRunner(phase, input, job),
      )
      if (phase === 'judgment') result.candidates[0]!.candidateKey = historicalKey
      return { ...result }
    })
    const writesBefore = brain.proposalWrites()

    await expect(drainDirectorExtractionJobs(db, {
      commandRunner: brain.commandRunner,
      runner,
      limit: 1,
      nowSeconds: 902,
    })).resolves.toMatchObject({ processed: 1, failed: 1 })
    expect(getDirectorExtractionJob(db, taskId, scope)).toMatchObject({
      status: 'conflict',
      currentPhase: 'judgment',
      lastErrorCode: 'director_extraction_candidate_lineage_conflict',
    })
    expect(brain.proposalWrites()).toBe(writesBefore)
  })

  it('terminates an oversized immutable seed on its first claim', async () => {
    const db = database()
    const taskId = 'oversized-seed'
    seedSource(db, {
      taskId,
      timeline: visualPayload(300_000, 100),
      maxAttempts: 3,
    })
    const brain = brainHarness()
    await advanceToUnderstanding(db, taskId, brain)
    const runner = vi.fn<DirectorExtractionPhaseRunner>()

    await expect(runNextDirectorExtractionPhase(db, {
      commandRunner: brain.commandRunner,
      runner,
      nowSeconds: 1_002,
    })).resolves.toMatchObject({
      outcome: 'failed',
      job: {
        status: 'conflict',
        attemptCount: 1,
        maxAttempts: 3,
        lastErrorCode: 'director_extraction_seed_too_large',
      },
    })
    await expect(runNextDirectorExtractionPhase(db, {
      commandRunner: brain.commandRunner,
      runner,
      nowSeconds: 1_003,
    })).resolves.toEqual({ outcome: 'idle', job: null })
    expect(runner).not.toHaveBeenCalled()
  })

  it('terminates oversized model output on its first claim', async () => {
    const db = database()
    const taskId = 'oversized-output'
    seedSource(db, { taskId, maxAttempts: 3 })
    const brain = brainHarness()
    await advanceToUnderstanding(db, taskId, brain)
    const runner = vi.fn<DirectorExtractionPhaseRunner>(async (phase, _input, job) => output(
      phase,
      Array.from({ length: 40 }, (_, index) => candidate({
        candidateKey: `oversized-output-${index}`,
        summary: '摘'.repeat(4_000),
        evidenceRefs: [{ materialId: job.materialId, startSeconds: 0, endSeconds: 1 }],
      })),
    ))

    await expect(runNextDirectorExtractionPhase(db, {
      commandRunner: brain.commandRunner,
      runner,
      nowSeconds: 1_002,
    })).resolves.toMatchObject({
      outcome: 'failed',
      job: {
        status: 'conflict',
        attemptCount: 1,
        maxAttempts: 3,
        lastErrorCode: 'director_extraction_output_too_large',
      },
    })
    await expect(runNextDirectorExtractionPhase(db, {
      commandRunner: brain.commandRunner,
      runner,
      nowSeconds: 1_003,
    })).resolves.toEqual({ outcome: 'idle', job: null })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('serializes same-work jobs by source completion order even when IDs and registration disagree', () => {
    const db = database()
    seedSource(db, { taskId: 'a-newer-source', completedAt: 200, maxAttempts: 1 })
    seedSource(db, { taskId: 'z-older-source', completedAt: 100, maxAttempts: 1 })

    const older = claimNextDirectorExtractionJob(db, { nowSeconds: 1_000 })!
    expect(older.sourceTaskId).toBe('z-older-source')
    expect(claimNextDirectorExtractionJob(db, { nowSeconds: 1_000 })).toBeNull()

    failDirectorExtractionPhase(db, older, 'expected_test_failure', { nowSeconds: 1_001 })
    expect(claimNextDirectorExtractionJob(db, { nowSeconds: 1_002 })?.sourceTaskId)
      .toBe('a-newer-source')
  })

  it.each([
    ['withdrawn', null, 'director_extraction_learning_reference_invalid'],
    ['rewritten', '改变后的身份', 'director_extraction_learning_reference_changed'],
  ] as const)(
    'stops a checkpoint retry when a referenced stable ID is %s',
    async (_label, changedIdentity, expectedError) => {
      const db = database()
      const taskId = `reference-${expectedError}`
      const initialContext = learningContext({
        people: [learningRecord('people_profiles', 'PROFILE-STABLE-001', {
          '人物名称': '被引用人物',
          '人物 ID': 'PERSON-STABLE-001',
          '身份': '最初身份',
        })],
      })
      seedSource(db, { taskId })
      const brain = brainHarness(initialContext)
      await advanceToUnderstanding(db, taskId, brain)
      brain.failNextProposal()
      const runner = vi.fn<DirectorExtractionPhaseRunner>(
        understandingRunner(undefined, 'PROFILE-STABLE-001'),
      )
      await expect(runNextDirectorExtractionPhase(db, {
        commandRunner: brain.commandRunner,
        runner,
        nowSeconds: 1_002,
      })).resolves.toMatchObject({ outcome: 'failed' })
      const writesBeforeRetry = brain.proposalWrites()

      brain.setLearningContext(learningContext({
        people: changedIdentity === null ? [] : [learningRecord(
          'people_profiles',
          'PROFILE-STABLE-001',
          {
            '人物名称': '被引用人物',
            '人物 ID': 'PERSON-STABLE-001',
            '身份': changedIdentity,
          },
        )],
      }))
      await expect(runNextDirectorExtractionPhase(db, {
        commandRunner: brain.commandRunner,
        runner,
        nowSeconds: 1_003,
      })).resolves.toMatchObject({
        outcome: 'failed',
        job: { status: 'conflict', lastErrorCode: expectedError },
      })
      expect(runner).toHaveBeenCalledTimes(1)
      expect(brain.proposalWrites()).toBe(writesBeforeRetry)
    },
  )

  it('enforces the 128 KiB phase gate with zero model or Feishu writes past the boundary', async () => {
    const attempts = new Map<number, Awaited<ReturnType<typeof runSizedUnderstanding>>>()
    const attempt = async (characters: number) => {
      const cached = attempts.get(characters)
      if (cached) return cached
      const result = await runSizedUnderstanding(characters)
      attempts.set(characters, result)
      return result
    }
    let acceptedCharacters = 100_000
    let rejectedCharacters = 150_000
    expect((await attempt(acceptedCharacters)).result)
      .toMatchObject({ outcome: 'awaiting_review' })
    expect((await attempt(rejectedCharacters)).modelCalls).toBe(0)
    while (rejectedCharacters - acceptedCharacters > 1) {
      const middle = Math.floor((acceptedCharacters + rejectedCharacters) / 2)
      const result = await attempt(middle)
      if (result.modelCalls === 1) acceptedCharacters = middle
      else rejectedCharacters = middle
    }

    const accepted = await attempt(acceptedCharacters)
    expect(accepted.result).toMatchObject({ outcome: 'awaiting_review' })
    expect(accepted.phaseInputBytes).not.toBeNull()
    expect(accepted.phaseInputBytes!).toBeLessThanOrEqual(
      DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES,
    )
    expect(DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES - accepted.phaseInputBytes!)
      .toBeLessThan(2 * 1024)
    expect(accepted.modelCalls).toBe(1)
    expect(accepted.proposalWrites).toBe(1)

    const over = await attempt(rejectedCharacters)
    expect(over.result).toMatchObject({
      outcome: 'failed',
      job: {
        status: 'conflict',
        attemptCount: 1,
        lastErrorCode: expect.stringMatching(
          /^director_extraction_(?:learning_context_budget_exceeded|phase_input_too_large)$/u,
        ),
      },
    })
    expect(rejectedCharacters).toBe(acceptedCharacters + 1)
    expect(over.phaseInputBytes).toBeNull()
    expect(over.modelCalls).toBe(0)
    expect(over.proposalWrites).toBe(0)
  })
})
