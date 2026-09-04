import { describe, expect, it, vi } from 'vitest'

import {
  createDirectorBrainTool,
  DEFAULT_RUNTIME_SERVICE_PATH,
  DIRECTOR_BRAIN_PROPOSAL_TABLES,
  DIRECTOR_BRAIN_TABLES,
  normalizeDirectorBrainToolRequest,
  TOOL_PARAMETERS,
} from '../lib/director-brain-tool.js'

const targetContext = { agentId: 'second-original' }

function resultText(result) {
  return result.content[0].text
}

describe('director brain tool contract', () => {
  it('uses the installed runtime service without accepting runtime paths from tool input', () => {
    expect(DEFAULT_RUNTIME_SERVICE_PATH).toMatch(
      /aiworker-director-brain\/runtime\/scripts\/lib\/feishu-director-brain\.mjs$/u,
    )
    expect(DIRECTOR_BRAIN_TABLES).toEqual([
      'system_blueprint',
      'works',
      'director_intents',
      'material_evidence',
      'people_profiles',
      'story_nodes',
      'story_relations',
      'material_judgments',
      'narrative_plans',
      'director_cases',
      'skills_techniques',
    ])
    expect(DIRECTOR_BRAIN_PROPOSAL_TABLES).toEqual([
      'works',
      'director_intents',
      'people_profiles',
      'story_nodes',
      'story_relations',
      'material_judgments',
      'narrative_plans',
      'director_cases',
      'skills_techniques',
    ])
    expect(TOOL_PARAMETERS.properties.action.enum).toEqual([
      'health', 'explain', 'resolve_work', 'get', 'search', 'assemble', 'workflow', 'propose',
      'start_extraction', 'extraction_status', 'backfill_extraction',
    ])
    expect(TOOL_PARAMETERS.properties.references.properties.techniqueIds).toEqual({
      type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
      items: { type: 'string', minLength: 1, maxLength: 160 },
    })
  })

  it('grounds natural-language answers in returned fields and keeps internal IDs hidden', () => {
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: vi.fn(),
    })

    expect(tool.description).toContain('workflow，把原片名放入 query')
    expect(tool.description).toContain('内部唯一解析')
    expect(tool.description).toContain('绝不向用户展示')
    expect(tool.description).toContain('layerCoverage 只表示六层全局覆盖率')
    expect(tool.description).toContain('禁止改写成每层百分比')
    expect(tool.description).toContain('不得捏造准确率')
    expect(tool.description).toContain('无法合法组装就明确依据不足')
    expect(tool.description).toContain('必须逐字使用其中 userVisibleAnswer')
    expect(tool.description).toContain('不得回退到 read、exec、memory')
    expect(tool.description).toContain('start_extraction、extraction_status、backfill_extraction')
    expect(tool.description).toContain('skills_techniques 是由已确认案例支撑的跨作品全局技法库')
    expect(TOOL_PARAMETERS.properties.workId.description).toContain('全局 skills_techniques')
    expect(TOOL_PARAMETERS.properties.workId.description).toContain('来源作品过滤')
  })

  it('returns a deterministic user-visible workflow answer derived only from service fields', async () => {
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: vi.fn().mockResolvedValue({
        ok: true,
        action: 'workflow',
        readiness: {
          perception: true,
          people: true,
          story: false,
          judgment: false,
          narrative: false,
          intent: true,
        },
        metrics: { layerCoverage: 0.5 },
        nextSuggestion: '先补齐故事证据。',
        debug: 'x'.repeat(80 * 1024),
      }),
    })

    const result = JSON.parse(resultText(await tool.execute('call-1', {
      action: 'workflow',
      workId: 'WORK-1',
    })))

    expect(result.responseContract).toEqual({
      mustQuoteUserVisibleAnswerExactly: true,
      doNotAddFacts: true,
      doNotExposeInternalIds: true,
      handled: true,
      stopAfterReply: true,
      doNotUseFallbackSources: true,
      userVisibleAnswer: '导演脑：3/6 层就绪。未就绪：故事发现、导演判断、叙事结构。下一步：先补齐故事证据。',
    })
    expect(result.responseContract.userVisibleAnswer).not.toContain('50%')
    expect(result.responseContract.userVisibleAnswer).not.toContain('WORK-1')
    expect(Object.keys(result).sort()).toEqual(['action', 'handled', 'ok', 'responseContract'])
    expect(JSON.stringify(result)).not.toContain('debug')
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(1024)
  })

  it('resolves a workflow query internally before requesting the six-layer workflow', async () => {
    const service = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        action: 'resolve_work',
        found: true,
        work: { workId: 'WORK-1', name: '冰原纪事' },
      })
      .mockResolvedValueOnce({
        ok: true,
        action: 'workflow',
        readiness: {
          perception: true,
          people: true,
          story: true,
          judgment: false,
          narrative: false,
          intent: true,
        },
        nextSuggestion: '补充导演判断后再建立叙事结构。',
      })
    const tool = createDirectorBrainTool({ context: targetContext, service })

    const result = JSON.parse(resultText(await tool.execute('call-workflow-query', {
      action: 'workflow',
      query: '《冰原纪事》',
      objective: '判断当前六层建设状态',
    })))

    expect(service).toHaveBeenCalledTimes(2)
    expect(service).toHaveBeenNthCalledWith(1, {
      action: 'resolve_work',
      query: '《冰原纪事》',
    })
    expect(service).toHaveBeenNthCalledWith(2, {
      action: 'workflow',
      workId: 'WORK-1',
      objective: '判断当前六层建设状态',
    })
    expect(result.responseContract.userVisibleAnswer).toBe(
      '《冰原纪事》的导演脑：4/6 层就绪。未就绪：导演判断、叙事结构。下一步：补充导演判断后再建立叙事结构。',
    )
    expect(result.responseContract.userVisibleAnswer).not.toContain('WORK-1')
  })

  it('shows case and technique maturity from both supported workflow field names', async () => {
    for (const maturityField of ['maturity', 'learningReadiness']) {
      const tool = createDirectorBrainTool({
        context: targetContext,
        service: vi.fn().mockResolvedValue({
          ok: true,
          action: 'workflow',
          workId: 'WORK-MUST-STAY-HIDDEN',
          readiness: {
            perception: true,
            people: true,
            story: true,
            judgment: true,
            narrative: true,
            intent: true,
          },
          [maturityField]: {
            cases: { status: 'awaiting_review', reviewedCount: 2, totalCount: 3 },
            techniques: { status: 'blocked_by_case_review' },
          },
          nextSuggestion: '先确认导演案例。',
        }),
      })

      const result = JSON.parse(resultText(await tool.execute('call-maturity', {
        action: 'workflow', workId: 'WORK-MUST-STAY-HIDDEN',
      })))
      expect(result.responseContract.userVisibleAnswer).toBe(
        '导演脑：6/6 层就绪。六层均已就绪；导演案例：待确认（已确认 2/3）；技法沉淀：等待案例确认。下一步：先确认导演案例。',
      )
      expect(JSON.stringify(result)).not.toContain('WORK-MUST-STAY-HIDDEN')
    }
  })

  it('resolves by work name and delegates extraction through the injected shared service', async () => {
    const service = vi.fn().mockResolvedValue({
      ok: true,
      action: 'resolve_work',
      found: true,
      work: { workId: 'WORK-PRIVATE-1', name: '冰原纪事' },
    })
    const extractionService = vi.fn().mockResolvedValue({
      ok: true,
      action: 'start_extraction',
      state: 'pending',
      extractionId: 'EXTRACTION-MUST-STAY-HIDDEN',
      debug: 'x'.repeat(80 * 1024),
    })
    const tool = createDirectorBrainTool({ context: targetContext, service, extractionService })

    const result = JSON.parse(resultText(await tool.execute('call-extraction', {
      action: 'start_extraction',
      query: '《冰原纪事》',
      sourceQuery: '第三季第二集.mov',
      objective: '发现人物变化',
    })))

    expect(service).toHaveBeenCalledTimes(1)
    expect(service).toHaveBeenCalledWith({ action: 'resolve_work', query: '《冰原纪事》' })
    expect(extractionService).toHaveBeenCalledTimes(1)
    expect(extractionService).toHaveBeenCalledWith({
      action: 'start_extraction',
      workId: 'WORK-PRIVATE-1',
      sourceQuery: '第三季第二集.mov',
      objective: '发现人物变化',
    })
    expect(result).toEqual({
      ok: true,
      action: 'start_extraction',
      handled: true,
      responseContract: {
        mustQuoteUserVisibleAnswerExactly: true,
        doNotAddFacts: true,
        doNotExposeInternalIds: true,
        handled: true,
        stopAfterReply: true,
        doNotUseFallbackSources: true,
        userVisibleAnswer: '已开始整理《冰原纪事》的导演知识。稍后直接问我进度就行。',
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/WORK-PRIVATE|EXTRACTION-MUST|debug/iu)
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThan(48 * 1024)
  })

  it('stops after a missing or ambiguous work and never reaches the extraction service', async () => {
    for (const scenario of [
      {
        service: vi.fn().mockResolvedValue({
          ok: true, action: 'resolve_work', found: false,
        }),
        expected: '我没有找到这个作品。请告诉我更准确的完整作品名。',
      },
      {
        service: vi.fn().mockRejectedValue(new Error('work_resolution_ambiguous')),
        expected: '这个名称对应多个作品。请告诉我更准确的完整作品名。',
      },
    ]) {
      const extractionService = vi.fn()
      const tool = createDirectorBrainTool({
        context: targetContext,
        service: scenario.service,
        extractionService,
      })
      const result = JSON.parse(resultText(await tool.execute('call-no-fallback', {
        action: 'backfill_extraction', query: '冰原',
      })))

      expect(extractionService).not.toHaveBeenCalled()
      expect(result.handled).toBe(true)
      expect(result.responseContract).toMatchObject({
        mustQuoteUserVisibleAnswerExactly: true,
        stopAfterReply: true,
        doNotUseFallbackSources: true,
        userVisibleAnswer: scenario.expected,
      })
      expect(JSON.stringify(result)).not.toMatch(/workId|recordId|candidate/iu)
    }
  })

  it('marks a direct unresolved work lookup as handled with no fallback', async () => {
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: vi.fn().mockResolvedValue({
        ok: true,
        action: 'resolve_work',
        found: false,
        query: '不存在的作品',
        matches: [],
      }),
    })
    const result = JSON.parse(resultText(await tool.execute('call-resolve-missing', {
      action: 'resolve_work', query: '不存在的作品',
    })))

    expect(result).toMatchObject({
      ok: true,
      action: 'resolve_work',
      handled: true,
      outcome: 'not_found',
      responseContract: {
        stopAfterReply: true,
        doNotUseFallbackSources: true,
        userVisibleAnswer: '我没有找到这个作品。请告诉我更准确的完整作品名。',
      },
    })
    expect(JSON.stringify(result)).not.toContain('不存在的作品')
  })

  it.each([
    ['awaiting_evidence_review', '素材证据已经整理好，正在等你确认'],
    ['awaiting_understanding_review', '人物和故事理解已经整理好，正在等你确认'],
    ['awaiting_judgment_review', '导演判断已经整理好，正在等你确认'],
    ['awaiting_case_review', '导演案例已经整理好，正在等你确认。确认后才会继续沉淀技法'],
    ['awaiting_technique_review', '导演技法已经整理成候选，正在等你确认'],
  ])('explains the %s review gate without exposing IDs', async (state, expected) => {
    const tool = createDirectorBrainTool({
      context: targetContext,
      service: vi.fn().mockResolvedValue({
        ok: true,
        action: 'resolve_work',
        found: true,
        work: { workId: 'WORK-HIDDEN', name: '冰原纪事' },
      }),
      extractionService: vi.fn().mockResolvedValue({
        ok: true, action: 'extraction_status', state, runId: 'RUN-HIDDEN',
      }),
    })
    const result = JSON.parse(resultText(await tool.execute('call-status', {
      action: 'extraction_status', query: '冰原纪事',
    })))

    expect(result.responseContract.userVisibleAnswer).toContain(expected)
    expect(JSON.stringify(result)).not.toMatch(/WORK-HIDDEN|RUN-HIDDEN/iu)
  })

  it('normalizes the eleven allowed actions and rejects extra or privileged operations', () => {
    expect(normalizeDirectorBrainToolRequest({ action: 'health' })).toEqual({ action: 'health' })
    expect(normalizeDirectorBrainToolRequest({
      action: 'explain', topic: 'technique_learning',
    })).toEqual({ action: 'explain', topic: 'technique_learning' })
    expect(normalizeDirectorBrainToolRequest({
      action: 'resolve_work', query: '冰原纪事',
    })).toEqual({ action: 'resolve_work', query: '冰原纪事' })
    expect(normalizeDirectorBrainToolRequest({
      action: 'get', workId: 'WORK-1', table: 'people_profiles', stableId: 'PERSON-v1',
    })).toEqual({
      action: 'get', workId: 'WORK-1', table: 'people_profiles', stableId: 'PERSON-v1',
    })
    expect(normalizeDirectorBrainToolRequest({
      action: 'get', table: 'works', stableId: 'WORK-1',
    })).toEqual({ action: 'get', table: 'works', stableId: 'WORK-1' })
    expect(normalizeDirectorBrainToolRequest({
      action: 'get', table: 'system_blueprint', stableId: 'BLUEPRINT-1',
    })).toEqual({ action: 'get', table: 'system_blueprint', stableId: 'BLUEPRINT-1' })
    expect(normalizeDirectorBrainToolRequest({
      action: 'search', table: 'system_blueprint', query: '数据边界',
    })).toEqual({
      action: 'search', table: 'system_blueprint', query: '数据边界', limit: 10,
    })
    expect(normalizeDirectorBrainToolRequest({
      action: 'search', table: 'works', query: '冰原',
    })).toEqual({ action: 'search', table: 'works', query: '冰原', limit: 10 })
    expect(normalizeDirectorBrainToolRequest({
      action: 'search', workId: 'WORK-1', table: 'all', query: '主角', limit: 20,
    })).toEqual({
      action: 'search', workId: 'WORK-1', table: 'all', query: '主角', limit: 20,
    })
    expect(normalizeDirectorBrainToolRequest({
      action: 'get', table: 'skills_techniques', stableId: 'SKILL-1',
    })).toEqual({ action: 'get', table: 'skills_techniques', stableId: 'SKILL-1' })
    expect(normalizeDirectorBrainToolRequest({
      action: 'get', workId: 'WORK-1', table: 'skills_techniques', stableId: 'SKILL-1',
    })).toEqual({
      action: 'get', workId: 'WORK-1', table: 'skills_techniques', stableId: 'SKILL-1',
    })
    expect(normalizeDirectorBrainToolRequest({
      action: 'search', table: 'skills_techniques', query: '停顿',
    })).toEqual({
      action: 'search', table: 'skills_techniques', query: '停顿', limit: 10,
    })
    expect(normalizeDirectorBrainToolRequest({
      action: 'search', workId: 'WORK-1', table: 'skills_techniques', query: '停顿',
    })).toEqual({
      action: 'search', workId: 'WORK-1', table: 'skills_techniques', query: '停顿', limit: 10,
    })
    expect(normalizeDirectorBrainToolRequest({
      action: 'assemble',
      workId: 'WORK-1',
      references: {
        intentVersionId: 'INTENT-1',
        evidenceIds: ['EVIDENCE-1'],
        peopleProfileIds: ['PERSON-1'],
        storyNodeIds: ['NODE-1'],
        storyRelationIds: ['RELATION-1'],
        materialJudgmentIds: ['JUDGMENT-1'],
        narrativePlanIds: ['PLAN-1'],
        directorCaseIds: ['CASE-1'],
        skillTechniqueIds: ['SKILL-1'],
      },
    })).toEqual({
      action: 'assemble',
      workId: 'WORK-1',
      references: {
        intentVersionId: 'INTENT-1',
        evidenceIds: ['EVIDENCE-1'],
        peopleProfileIds: ['PERSON-1'],
        storyNodeIds: ['NODE-1'],
        storyRelationIds: ['RELATION-1'],
        materialJudgmentIds: ['JUDGMENT-1'],
        narrativePlanIds: ['PLAN-1'],
        directorCaseIds: ['CASE-1'],
        skillTechniqueIds: ['SKILL-1'],
      },
    })
    expect(normalizeDirectorBrainToolRequest({
      action: 'workflow', workId: 'WORK-1', objective: '判断当前最优的故事推进方向',
    })).toEqual({
      action: 'workflow', workId: 'WORK-1', objective: '判断当前最优的故事推进方向',
    })
    expect(normalizeDirectorBrainToolRequest({
      action: 'workflow', query: '《冰原纪事》', objective: '判断六层状态',
    })).toEqual({
      action: 'workflow', query: '《冰原纪事》', objective: '判断六层状态',
    })
    expect(normalizeDirectorBrainToolRequest({
      action: 'start_extraction', query: '《冰原纪事》', objective: '发现人物变化',
    })).toEqual({
      action: 'start_extraction',
      query: '《冰原纪事》',
      objective: '发现人物变化',
    })
    expect(normalizeDirectorBrainToolRequest({
      action: 'backfill_extraction',
      query: '《冰原纪事》',
      sourceQuery: '第三季第二集.mov',
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'extraction_status', query: '《冰原纪事》',
    })).toEqual({ action: 'extraction_status', query: '《冰原纪事》' })
    expect(normalizeDirectorBrainToolRequest({
      action: 'propose',
      workId: 'WORK-1',
      table: 'story_relations',
      fields: { '关系名称': '危机推动选择', '关系类型': '因果' },
      references: {
        sourceNodeId: 'NODE-1',
        targetNodeId: 'NODE-2',
        evidenceIds: ['EVIDENCE-1'],
        previousStoryRelationId: 'RELATION-0',
      },
    })).toEqual({
      action: 'propose',
      workId: 'WORK-1',
      table: 'story_relations',
      fields: { '关系名称': '危机推动选择', '关系类型': '因果' },
      references: {
        sourceNodeId: 'NODE-1',
        targetNodeId: 'NODE-2',
        evidenceIds: ['EVIDENCE-1'],
        previousStoryRelationId: 'RELATION-0',
      },
    })

    expect(normalizeDirectorBrainToolRequest({
      action: 'propose',
      table: 'works',
      fields: { '作品名称': '冰原纪事', '作品类型': '纪录片' },
      references: {},
    })).toEqual({
      action: 'propose',
      table: 'works',
      fields: { '作品名称': '冰原纪事', '作品类型': '纪录片' },
      references: {},
    })

    for (const table of DIRECTOR_BRAIN_PROPOSAL_TABLES.filter(
      value => value !== 'works' && value !== 'skills_techniques',
    )) {
      expect(normalizeDirectorBrainToolRequest({
        action: 'propose', workId: 'WORK-1', table, fields: { '主字段': '候选内容' },
      })).toEqual({
        action: 'propose', workId: 'WORK-1', table, fields: { '主字段': '候选内容' },
      })
    }
    expect(normalizeDirectorBrainToolRequest({
      action: 'propose',
      table: 'skills_techniques',
      fields: { '知识名称': '在决定前保留停顿' },
      references: { caseIds: ['CASE-1', 'CASE-2'] },
    })).toEqual({
      action: 'propose',
      table: 'skills_techniques',
      fields: { '知识名称': '在决定前保留停顿' },
      references: { caseIds: ['CASE-1', 'CASE-2'] },
    })
    expect(normalizeDirectorBrainToolRequest({
      action: 'propose',
      workId: 'WORK-1',
      table: 'material_judgments',
      fields: { '判断名称': '保留风险前的停顿' },
      references: {
        intentVersionId: 'INTENT-1',
        evidenceIds: ['EVIDENCE-1'],
        techniqueIds: ['SKILL-1'],
      },
    })).toEqual({
      action: 'propose',
      workId: 'WORK-1',
      table: 'material_judgments',
      fields: { '判断名称': '保留风险前的停顿' },
      references: {
        intentVersionId: 'INTENT-1',
        evidenceIds: ['EVIDENCE-1'],
        techniqueIds: ['SKILL-1'],
      },
    })
    expect(normalizeDirectorBrainToolRequest({
      action: 'propose',
      workId: 'WORK-1',
      table: 'skills_techniques',
      fields: { '知识名称': '在决定前保留停顿' },
      references: { caseIds: ['CASE-1'] },
    })).toEqual({
      action: 'propose',
      workId: 'WORK-1',
      table: 'skills_techniques',
      fields: { '知识名称': '在决定前保留停顿' },
      references: { caseIds: ['CASE-1'] },
    })

    expect(normalizeDirectorBrainToolRequest({ action: 'approve' })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({ action: 'delete' })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'propose', table: 'system_blueprint', fields: { title: 'bad' },
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'propose',
      workId: 'WORK-1',
      table: 'material_evidence',
      fields: { '证据名称': '禁止直写', '证据 ID': 'EVIDENCE-1' },
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'propose',
      workId: 'WORK-1',
      table: 'story_nodes',
      fields: { '节点名称': '重复引用' },
      references: { evidenceIds: ['EVIDENCE-1', 'EVIDENCE-1'] },
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'propose',
      workId: 'WORK-1',
      table: 'story_nodes',
      fields: { '节点名称': '非法引用' },
      references: { recordId: 'rec-private' },
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'get', workId: 'WORK-1', table: 'people_profiles', stableId: 'P1', catalog: '/tmp/catalog',
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'search', workId: 'WORK-1', table: 'all', query: 'x', limit: 21,
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'assemble', workId: 'WORK-1', references: { evidenceIds: ['EVIDENCE-1'] },
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'assemble', workId: 'WORK-1',
      references: { intentVersionId: 'INTENT-1', evidenceIds: [] },
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'assemble',
      workId: 'WORK-1',
      references: {
        intentVersionId: 'INTENT-1',
        evidenceIds: ['EVIDENCE-1'],
        recordIds: ['rec-private'],
      },
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'get', table: 'story_nodes', stableId: 'NODE-1',
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'get', workId: 'WORK-1', table: 'works', stableId: 'WORK-2',
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'search', workId: 'WORK-1', table: 'system_blueprint', query: '边界',
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'workflow', workId: 'WORK-1', objective: 'x'.repeat(501),
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'workflow', workId: 'WORK-1', query: '冰原纪事',
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'extraction_status', query: '冰原纪事', workId: 'WORK-1',
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'start_extraction', query: '冰原纪事', sourceQuery: 'x'.repeat(121),
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'start_extraction', query: '长'.repeat(257),
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'propose', table: 'story_nodes', fields: { '节点名称': '无作品' },
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'propose', table: 'skills_techniques', fields: { '知识名称': '无案例技法' },
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'propose', table: 'skills_techniques', fields: { '知识名称': '错误引用' },
      references: { evidenceIds: ['EVIDENCE-1'] },
    })).toBeNull()
    expect(normalizeDirectorBrainToolRequest({
      action: 'propose', workId: 'WORK-1', table: 'works',
      fields: { '作品名称': '不应带 workId' },
    })).toBeNull()
  })

  it('is unavailable to non-target agents', () => {
    expect(createDirectorBrainTool({
      context: { agentId: 'main' },
      targetAgentId: 'second-original',
      service: vi.fn(),
    })).toBeNull()
  })

  it('passes only the normalized request to an injected service', async () => {
    const service = vi.fn(async request => ({
      ok: true,
      kind: 'search',
      records: [{ table: request.table, stableId: 'PERSON-1', reviewed: true }],
      count: 1,
      truncated: false,
    }))
    const tool = createDirectorBrainTool({ context: targetContext, service })
    const result = await tool.execute('call-1', {
      action: 'search', workId: 'WORK-1', table: 'people_profiles', query: '主角',
    })

    expect(service).toHaveBeenCalledTimes(1)
    expect(service).toHaveBeenCalledWith({
      action: 'search', workId: 'WORK-1', table: 'people_profiles', query: '主角', limit: 10,
    })
    expect(JSON.parse(resultText(result))).toEqual({
      ok: true,
      kind: 'search',
      records: [{ table: 'people_profiles', stableId: 'PERSON-1', reviewed: true }],
      count: 1,
      truncated: false,
    })
  })

  it('passes global techniques without a work ID and keeps reviewed case provenance', async () => {
    const service = vi.fn().mockResolvedValue({
      ok: true,
      action: 'propose',
      table: 'skills_techniques',
      outcome: 'created',
    })
    const tool = createDirectorBrainTool({ context: targetContext, service })

    await tool.execute('call-global-technique', {
      action: 'propose',
      table: 'skills_techniques',
      fields: { '知识名称': '风险决定前保留停顿' },
      references: { caseIds: ['CASE-ICE-1', 'CASE-DESERT-1'] },
    })

    expect(service).toHaveBeenCalledWith({
      action: 'propose',
      table: 'skills_techniques',
      fields: { '知识名称': '风险决定前保留停顿' },
      references: { caseIds: ['CASE-ICE-1', 'CASE-DESERT-1'] },
    })
  })

  it('passes a normalized assemble request and keeps the 48 KiB result boundary', async () => {
    const references = {
      intentVersionId: 'INTENT-1',
      evidenceIds: ['EVIDENCE-1'],
      storyNodeIds: ['NODE-1'],
    }
    const service = vi.fn(async () => ({ ok: true, action: 'assemble', context: {} }))
    const tool = createDirectorBrainTool({ context: targetContext, service })
    const result = await tool.execute('call-assemble', {
      action: 'assemble', workId: 'WORK-1', references,
    })

    expect(service).toHaveBeenCalledWith({ action: 'assemble', workId: 'WORK-1', references })
    expect(JSON.parse(resultText(result))).toEqual({
      ok: true,
      action: 'assemble',
      context: {},
    })

    const oversizedTool = createDirectorBrainTool({
      context: targetContext,
      service: async () => ({
        ok: true,
        action: 'assemble',
        context: { text: 'x'.repeat(49 * 1024) },
      }),
    })
    const oversized = await oversizedTool.execute('call-oversized', {
      action: 'assemble',
      workId: 'WORK-1',
      references,
    })
    expect(JSON.parse(resultText(oversized))).toMatchObject({
      handled: true,
      responseContract: {
        stopAfterReply: true,
        doNotUseFallbackSources: true,
        userVisibleAnswer: '导演脑暂时无法读取，请稍后再试。',
      },
    })
  })

  it('fails closed without echoing rejected input or service details', async () => {
    const invalidTool = createDirectorBrainTool({ context: targetContext, service: vi.fn() })
    const invalid = await invalidTool.execute('call-2', {
      action: 'get', workId: 'WORK-1', table: 'people_profiles',
      stableId: '/Users/private/secret', appId: 'hidden',
    })
    expect(resultText(invalid)).toBe('导演脑请求参数无效。')
    expect(resultText(invalid)).not.toContain('private')
    expect(resultText(invalid)).not.toContain('hidden')

    const service = vi.fn(async () => {
      throw new Error('feishu_http_error:500:appToken=bascn-private-resource')
    })
    const tool = createDirectorBrainTool({ context: targetContext, service })
    const failed = await tool.execute('call-3', {
      action: 'get', workId: 'WORK-1', table: 'people_profiles', stableId: 'PERSON-1',
    })
    expect(JSON.parse(resultText(failed))).toMatchObject({
      handled: true,
      responseContract: {
        stopAfterReply: true,
        doNotUseFallbackSources: true,
        userVisibleAnswer: '导演脑暂时无法读取，请稍后再试。',
      },
    })
    expect(resultText(failed)).not.toContain('bascn-private-resource')

    const wrongWorkflow = createDirectorBrainTool({
      context: targetContext,
      service: vi.fn().mockResolvedValue({
        ok: true,
        action: 'search',
        workId: 'WORK-MUST-NOT-LEAK',
      }),
    })
    const wrongResult = await wrongWorkflow.execute('call-wrong-workflow', {
      action: 'workflow', workId: 'WORK-1',
    })
    expect(JSON.parse(resultText(wrongResult))).toMatchObject({
      handled: true,
      responseContract: {
        stopAfterReply: true,
        doNotUseFallbackSources: true,
        userVisibleAnswer: '导演脑暂时无法读取，请稍后再试。',
      },
    })
    expect(resultText(wrongResult)).not.toContain('WORK-MUST-NOT-LEAK')
  })

  it('does not call the service when the release gate is closed', async () => {
    const service = vi.fn()
    const tool = createDirectorBrainTool({
      context: targetContext,
      releaseReady: false,
      service,
    })
    const result = await tool.execute('call-4', { action: 'health' })
    expect(resultText(result)).toBe('导演脑正在维护，请稍后再试。')
    expect(service).not.toHaveBeenCalled()
  })
})
