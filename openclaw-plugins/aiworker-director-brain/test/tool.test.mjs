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
      'health', 'resolve_work', 'get', 'search', 'assemble', 'workflow', 'propose',
    ])
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
      userVisibleAnswer: [
        '六层导演脑建设状态：',
        '- 素材感知层：已就绪',
        '- 人物理解层：已就绪',
        '- 故事发现层：未就绪',
        '- 导演判断层：未就绪',
        '- 叙事结构层：未就绪',
        '- 导演意图层：已就绪',
        '',
        '当前结论：先补齐故事证据。',
      ].join('\n'),
    })
    expect(result.responseContract.userVisibleAnswer).not.toContain('50%')
    expect(result.responseContract.userVisibleAnswer).not.toContain('WORK-1')
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
    expect(result.responseContract.userVisibleAnswer).toContain('导演判断层：未就绪')
    expect(result.responseContract.userVisibleAnswer).not.toContain('WORK-1')
  })

  it('normalizes the seven allowed actions and rejects extra or privileged operations', () => {
    expect(normalizeDirectorBrainToolRequest({ action: 'health' })).toEqual({ action: 'health' })
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

    for (const table of DIRECTOR_BRAIN_PROPOSAL_TABLES.filter(value => value !== 'works')) {
      expect(normalizeDirectorBrainToolRequest({
        action: 'propose', workId: 'WORK-1', table, fields: { '主字段': '候选内容' },
      })).toEqual({
        action: 'propose', workId: 'WORK-1', table, fields: { '主字段': '候选内容' },
      })
    }

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
      action: 'propose', table: 'story_nodes', fields: { '节点名称': '无作品' },
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
    expect(resultText(oversized)).toBe('导演脑暂时无法读取，请稍后再试。')
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
    expect(resultText(failed)).toBe('导演脑暂时无法读取，请稍后再试。')
    expect(resultText(failed)).not.toContain('bascn-private-resource')
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
