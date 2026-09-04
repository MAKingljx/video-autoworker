import { describe, expect, it } from 'vitest'
import {
  compactDirectorLearningRecord,
  selectDirectorLearningContext,
} from '@/lib/director-extraction-learning'
import {
  directorExtractionDigest,
  parseDirectorLearningContextResult,
} from '@/lib/director-extraction-state'

function record(table: string, stableId: string, fields: Record<string, unknown> = {}) {
  return { table, stableId, state: '已确认', reviewed: true as const, fields }
}

function sourceContext(input: {
  activeIntent?: ReturnType<typeof record> | null
  people?: ReturnType<typeof record>[]
  stories?: ReturnType<typeof record>[]
  judgments?: ReturnType<typeof record>[]
  narratives?: ReturnType<typeof record>[]
  workCases?: ReturnType<typeof record>[]
  projectCases?: ReturnType<typeof record>[]
  techniques?: ReturnType<typeof record>[]
} = {}) {
  const work = {
    activeIntent: input.activeIntent || null,
    people_profiles: input.people || [],
    story_nodes: input.stories || [],
    story_relations: [],
    material_judgments: input.judgments || [],
    narrative_plans: input.narratives || [],
    director_cases: input.workCases || [],
  }
  const project = {
    director_cases: input.projectCases || [],
    skills_techniques: input.techniques || [],
  }
  const counts = {
    work: {
      activeIntent: work.activeIntent ? 1 : 0,
      people_profiles: work.people_profiles.length,
      story_nodes: work.story_nodes.length,
      story_relations: 0,
      material_judgments: work.material_judgments.length,
      narrative_plans: work.narrative_plans.length,
      director_cases: work.director_cases.length,
    },
    project: {
      director_cases: project.director_cases.length,
      skills_techniques: project.skills_techniques.length,
    },
    total: 0,
  }
  counts.total = Object.values(counts.work).reduce((sum, value) => sum + value, 0)
    + Object.values(counts.project).reduce((sum, value) => sum + value, 0)
  const snapshot = {
    schemaVersion: 1 as const,
    projectId: 'PROJ-VIDEO-AUTOWORKER' as const,
    workId: 'WORK-LEARNING-001',
    counts,
    work,
    project,
  }
  return parseDirectorLearningContextResult(snapshot.workId, {
    ok: true,
    action: 'learning_context',
    workId: snapshot.workId,
    snapshot,
    digest: directorExtractionDigest(snapshot),
  })
}

describe('director extraction phase learning selection', () => {
  it('deterministically reduces a large context below its byte budget', () => {
    const people = Array.from({ length: 80 }, (_, index) => record(
      'people_profiles',
      `PROFILE-${String(index).padStart(3, '0')}`,
      {
        '人物名称': `人物 ${index}`,
        '人物 ID': `PERSON-${index}`,
        '人物弧光': `普通背景 ${index} `.repeat(100),
        '更新时间': index,
      },
    ))
    people.push(record('people_profiles', 'PROFILE-OBJECTIVE', {
      '人物名称': '目标人物',
      '人物 ID': 'PERSON-OBJECTIVE',
      '人物弧光': '寻找失散家人，并在压力中改变决定。',
      '更新时间': 1,
    }))
    const source = sourceContext({ people })
    const first = selectDirectorLearningContext({
      source, phase: 'understanding', objective: '寻找失散家人', maxBytes: 24 * 1024,
    })
    const second = selectDirectorLearningContext({
      source, phase: 'understanding', objective: '寻找失散家人', maxBytes: 24 * 1024,
    })

    expect(first).toEqual(second)
    expect(first.learningContextTrace.byteLength).toBeLessThanOrEqual(24 * 1024)
    expect(first.learningContextTrace.sourceDigest).toBe(source.digest)
    expect(first.learningContext.snapshot.work.people_profiles.map(item => item.stableId))
      .toContain('PROFILE-OBJECTIVE')
    expect(first.learningContextTrace.omittedCounts.work.people_profiles).toBeGreaterThan(0)
  })

  it('keeps chain heads and the historical records needed by each phase', () => {
    const source = sourceContext({
      activeIntent: record('director_intents', 'INTENT-ACTIVE', { '核心主题': '人物选择' }),
      people: [
        record('people_profiles', 'PROFILE-OLD', { '人物 ID': 'PERSON-1' }),
        record('people_profiles', 'PROFILE-HEAD', {
          '人物 ID': 'PERSON-1', '上一版本 ID': 'PROFILE-OLD',
        }),
      ],
      stories: [record('story_nodes', 'STORY-SOURCE', {
        '节点名称': '关键选择', '节点内容': '人物改变决定。',
      })],
      techniques: [record('skills_techniques', 'TECHNIQUE-APPLIED', {
        '知识名称': '选择前后对照', '适用条件': '人物改变决定。',
      })],
    })
    const understanding = selectDirectorLearningContext({
      source, phase: 'understanding', objective: '人物改变决定', maxBytes: 64 * 1024,
    })
    const judgment = selectDirectorLearningContext({
      source, phase: 'judgment', objective: '人物改变决定', maxBytes: 64 * 1024,
    })

    expect(understanding.learningContext.snapshot.work.people_profiles.map(item => item.stableId))
      .toEqual(expect.arrayContaining(['PROFILE-OLD', 'PROFILE-HEAD']))
    expect(judgment.learningContext.snapshot.work.story_nodes.map(item => item.stableId))
      .toContain('STORY-SOURCE')
    expect(judgment.learningContext.snapshot.project.skills_techniques.map(item => item.stableId))
      .toContain('TECHNIQUE-APPLIED')
    expect(judgment.learningContext.snapshot.work.activeIntent?.stableId).toBe('INTENT-ACTIVE')
  })

  it('emits only allowlisted domain fields and rejects sensitive full context', () => {
    const compact = compactDirectorLearningRecord(record('people_profiles', 'PROFILE-SAFE', {
      '人物名称': '安全人物',
      '人物 ID': 'PERSON-SAFE',
      '审核人': '不发送给模型',
      '来源': '不发送给模型',
    }) as never)
    expect(compact.fields).toEqual({ '人物名称': '安全人物', '人物 ID': 'PERSON-SAFE' })

    const safe = sourceContext()
    const unsafeSnapshot = structuredClone(safe.snapshot) as typeof safe.snapshot
    unsafeSnapshot.work.people_profiles.push(record('people_profiles', 'PROFILE-UNSAFE', {
      '人物名称': '不安全人物', '人物 ID': 'PERSON-UNSAFE', '访问令牌': 'secret-value',
    }) as never)
    unsafeSnapshot.counts.work.people_profiles = 1
    unsafeSnapshot.counts.total = 1
    expect(() => parseDirectorLearningContextResult(safe.workId, {
      ok: true,
      action: 'learning_context',
      workId: safe.workId,
      snapshot: unsafeSnapshot,
      digest: directorExtractionDigest(unsafeSnapshot),
    })).toThrow(/candidate_sensitive/u)
  })

  it('fails closed when even the mandatory phase context cannot fit', () => {
    const source = sourceContext({
      activeIntent: record('director_intents', 'INTENT-REQUIRED', {
        '核心主题': '不可省略的导演意图',
      }),
    })
    expect(() => selectDirectorLearningContext({
      source, phase: 'judgment', objective: '主题', maxBytes: 32,
    })).toThrow('director_extraction_learning_context_budget_exceeded')
  })
})
