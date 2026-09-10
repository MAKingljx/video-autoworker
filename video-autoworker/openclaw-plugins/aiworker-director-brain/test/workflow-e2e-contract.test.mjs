import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { createDirectorBrainTool } from '../lib/director-brain-tool.js'

const servicePath = resolve(process.cwd(), 'scripts/lib/feishu-director-brain.mjs')
const directorService = await import(pathToFileURL(servicePath).href)
const schema = await directorService.loadDirectorBrainSchema()
const workId = 'WORK-ICE-001'
const reviewed = {
  '版本': 'v0.2.0',
  '来源': 'contract-fixture',
  '更新时间': Date.parse('2026-09-04T08:00:00+08:00'),
  '审核人': '测试导演',
  '审核时间': Date.parse('2026-09-04T08:00:00+08:00'),
  '审核原因': '契约测试已确认',
}

function record(recordId, fields) {
  return { record_id: recordId, fields: { ...fields, ...reviewed } }
}

function completeSixLayerRecords() {
  return {
    works: [record('recWorkMustStayHidden', {
      '作品名称': '冰原纪事', '作品 ID': workId,
      '项目 ID': schema.projectId, '作品类型': '纪录片', '状态': '生效',
    })],
    director_intents: [record('recIntentMustStayHidden', {
      '意图名称': '风险中的共同选择', '意图版本 ID': 'INTENT-REVIEWED-001',
      '项目 ID': schema.projectId, '作品 ID': workId,
      '核心主题': '共同判断风险', '导演态度': '克制观察',
      '情绪风格': '平静转为紧张', '叙事方式': '以人物选择推进',
      '节奏': '前缓后紧', '观众体验': '理解人物为何改变决定', '状态': '生效',
    })],
    material_evidence: [record('recEvidenceMustStayHidden', {
      '证据名称': '裂缝前停顿', '证据 ID': 'EVIDENCE-REVIEWED-001',
      '项目 ID': schema.projectId, '作品 ID': workId,
      '任务 ID': 'TASK-HIDDEN', '素材 ID': 'MATERIAL-HIDDEN',
      '场景 ID': 'SCENE-HIDDEN', '镜头 ID': 'SHOT-HIDDEN',
      '起始时间码': '00:00:10.000', '结束时间码': '00:00:14.000',
      '证据摘要': '人物发现裂缝后停下并示意同伴靠近',
      '校验摘要': 'a'.repeat(64), '分析版本': 'analysis-v1',
      '置信度': 0.95, '状态': '已核验',
    })],
    people_profiles: [record('recPeopleMustStayHidden', {
      '人物名称': '向导阿明', '人物版本 ID': 'PEOPLE-REVIEWED-001',
      '人物 ID': 'PERSON-AMING', '项目 ID': schema.projectId, '作品 ID': workId,
      '证据 ID': 'EVIDENCE-REVIEWED-001', '置信度': 0.92, '状态': '已确认',
    })],
    story_nodes: [
      record('recStoryOneMustStayHidden', {
        '节点名称': '发现裂缝', '节点 ID': 'STORY-REVIEWED-001',
        '项目 ID': schema.projectId, '作品 ID': workId, '节点类型': '转折',
        '节点内容': '人物发现风险并停下', '证据 ID': 'EVIDENCE-REVIEWED-001',
        '置信度': 0.93, '状态': '已确认',
      }),
      record('recStoryTwoMustStayHidden', {
        '节点名称': '共同绕行', '节点 ID': 'STORY-REVIEWED-002',
        '项目 ID': schema.projectId, '作品 ID': workId, '节点类型': '事件',
        '节点内容': '两人共同选择安全路线', '证据 ID': 'EVIDENCE-REVIEWED-001',
        '置信度': 0.91, '状态': '已确认',
      }),
    ],
    story_relations: [record('recRelationMustStayHidden', {
      '关系名称': '裂缝促成绕行', '关系 ID': 'RELATION-REVIEWED-001',
      '项目 ID': schema.projectId, '作品 ID': workId,
      '源节点 ID': 'STORY-REVIEWED-001', '目标节点 ID': 'STORY-REVIEWED-002',
      '证据 ID': 'EVIDENCE-REVIEWED-001', '关系类型': '因果',
      '判断理由': '风险让人物改变路线', '置信度': 0.9, '状态': '已确认',
    })],
    material_judgments: [record('recJudgmentMustStayHidden', {
      '判断名称': '停顿镜头价值', '判断 ID': 'JUDGMENT-REVIEWED-001',
      '项目 ID': schema.projectId, '作品 ID': workId,
      '证据 ID': 'EVIDENCE-REVIEWED-001', '意图版本 ID': 'INTENT-REVIEWED-001',
      '故事价值': 92, '人物价值': 90, '情绪价值': 87, '信息价值': 84,
      '视觉价值': 88, '稀缺性': 81, '叙事价值': 94,
      '使用理由': '停顿把风险变成人物选择', '置信度': 0.93, '状态': '已确认',
    })],
    narrative_plans: [record('recNarrativeMustStayHidden', {
      '方案名称': '裂缝叙事方案', '方案 ID': 'NARRATIVE-REVIEWED-001',
      '项目 ID': schema.projectId, '作品 ID': workId,
      '意图版本 ID': 'INTENT-REVIEWED-001',
      '节点 ID': 'STORY-REVIEWED-001\nSTORY-REVIEWED-002',
      '证据 ID': 'EVIDENCE-REVIEWED-001',
      '人物线': '从独自判断到共同决定', '事件线': '发现裂缝后绕行',
      '时间线': '发现、停顿、协商、绕行', '地点线': '冰面裂缝前后',
      '情绪线': '平静、紧张、缓和', '主题线': '风险中的共同选择',
      '冲突线': '速度与安全', '结构说明': '用裂缝连接人物和主题',
      '故事脚本': '向导停下，示意同伴靠近，最终共同选择绕行。', '状态': '已批准',
    })],
  }
}

function serviceHarness(initial = completeSixLayerRecords()) {
  const records = new Map(schema.tables.map(table => [
    table.key, structuredClone(initial[table.key] || []),
  ]))
  const createCalls = []
  const context = {
    schema,
    catalog: {
      tables: Object.fromEntries(schema.tables.map(table => [
        table.key, { name: table.name, tableId: `table-${table.key}` },
      ])),
    },
    accessToken: 'never-returned',
  }
  const dependencies = {
    connect: async () => context,
    resolveWork: async () => records.get('works'),
    findExact: async ({ table, stableId }) => (records.get(table.key) || []).filter(item => (
      item.fields[table.stableId] === stableId
    )),
    findByWork: async ({ table, workId: selectedWorkId }) => (
      (records.get(table.key) || []).filter(item => item.fields['作品 ID'] === selectedWorkId)
    ),
    findGlobalBySourceWork: async () => [],
    withStableCreateLock: async (_scope, action) => action(),
    create: async ({ table, fields }) => {
      const created = record(`recCreated${createCalls.length + 1}`, fields)
      created.fields = structuredClone(fields)
      createCalls.push(created)
      records.get(table.key).push(created)
      return created
    },
  }
  const execute = vi.fn(operation => directorService.executeDirectorBrainOperation(
    operation,
    { dependencies, now: () => '2026-09-04T09:00:00+08:00' },
  ))
  return { createCalls, execute, records }
}

function resultJson(result) {
  return JSON.parse(result.content[0].text)
}

describe('director brain non-editing end-to-end contract', () => {
  it('projects the real six-layer domain workflow as one short natural answer', async () => {
    const harness = serviceHarness()
    const tool = createDirectorBrainTool({
      context: { agentId: 'second-original' }, service: harness.execute,
    })

    const result = resultJson(await tool.execute('six-layer-e2e', {
      action: 'workflow', query: '冰原纪事', objective: '判断导演知识是否完整',
    }))
    const answer = result.responseContract.userVisibleAnswer

    expect(answer).toContain('《冰原纪事》的导演脑：6/6 层就绪')
    expect(answer).toContain('导演案例：尚未形成；技法沉淀：尚未形成')
    expect(answer.length).toBeLessThanOrEqual(360)
    expect(answer.split(/[。！？!?]/u).filter(Boolean)).toHaveLength(3)
    expect(result.responseContract).toMatchObject({
      mustQuoteUserVisibleAnswerExactly: true,
      stopAfterReply: true,
      doNotUseFallbackSources: true,
    })
    expect(JSON.stringify(result)).not.toMatch(
      /WORK-|TASK-|PERSON-|STORY-|JUDGMENT-|NARRATIVE-|EVIDENCE-|rec[A-Za-z0-9]+|\b[0-9a-f]{7,64}\b/u,
    )
    expect(harness.createCalls).toHaveLength(0)
  })

  it('preserves the same six-layer meaning when prior conversation state is discarded', async () => {
    const harness = serviceHarness()
    const tool = createDirectorBrainTool({
      context: { agentId: 'second-original' }, service: harness.execute,
    })
    const request = { action: 'workflow', query: '冰原纪事' }

    const beforeCompaction = resultJson(await tool.execute('before-compaction', request))
    // A compacted turn has no remembered work ID; the title-only contract must
    // resolve the work again and retain the same user-visible semantics.
    const afterCompaction = resultJson(await tool.execute('after-compaction', request))

    expect(afterCompaction.responseContract.userVisibleAnswer)
      .toBe(beforeCompaction.responseContract.userVisibleAnswer)
    expect(harness.execute.mock.calls.map(([operation]) => operation.action)).toEqual([
      'resolve_work', 'workflow', 'resolve_work', 'workflow',
    ])
  })

  it('keeps an identical intent proposal idempotent in the real domain service', async () => {
    const initial = completeSixLayerRecords()
    initial.director_intents = []
    const harness = serviceHarness(initial)
    const request = {
      action: 'propose', table: 'director_intents', workId,
      fields: {
        '意图名称': '风险中的共同选择', '核心主题': '共同判断风险',
        '导演态度': '克制观察', '情绪风格': '平静转为紧张',
        '叙事方式': '以人物选择推进', '节奏': '前缓后紧',
        '观众体验': '理解人物为何改变决定',
      },
    }

    const first = await harness.execute(request)
    const replay = await harness.execute(request)

    expect(first).toMatchObject({ action: 'propose', outcome: 'created' })
    expect(replay).toMatchObject({
      action: 'propose', outcome: 'unchanged', stableId: first.stableId,
    })
    expect(harness.createCalls).toHaveLength(1)
  })

  it('does not create a second candidate when the model fails after the tool result and retries', async () => {
    const initial = completeSixLayerRecords()
    initial.director_intents = []
    const harness = serviceHarness(initial)
    const tool = createDirectorBrainTool({
      context: { agentId: 'second-original' }, service: harness.execute,
    })
    const request = {
      action: 'propose', table: 'director_intents', workId,
      fields: {
        '意图名称': '风险中的共同选择', '核心主题': '共同判断风险',
        '导演态度': '克制观察', '情绪风格': '平静转为紧张',
        '叙事方式': '以人物选择推进', '节奏': '前缓后紧',
        '观众体验': '理解人物为何改变决定',
      },
    }

    // The first tool result is deliberately ignored to model a main-model
    // timeout after the write completed but before a user-visible reply.
    const ignoredAfterModelFailure = resultJson(await tool.execute('proposal-before-timeout', request))
    const retried = resultJson(await tool.execute('proposal-after-timeout', request))

    expect(harness.createCalls).toHaveLength(1)
    expect(ignoredAfterModelFailure).toMatchObject({ action: 'propose', outcome: 'created' })
    expect(retried).toMatchObject({
      action: 'propose', outcome: 'unchanged', stableId: ignoredAfterModelFailure.stableId,
    })
  })

  it('turns a same-ID different-value proposal replay into an explicit conflict', async () => {
    const initial = completeSixLayerRecords()
    initial.director_intents = []
    const harness = serviceHarness(initial)
    const tool = createDirectorBrainTool({
      context: { agentId: 'second-original' }, service: harness.execute,
    })
    const request = {
      action: 'propose', table: 'director_intents', workId,
      fields: {
        '意图名称': '风险中的共同选择', '核心主题': '共同判断风险',
        '导演态度': '克制观察', '情绪风格': '平静转为紧张',
        '叙事方式': '以人物选择推进', '节奏': '前缓后紧',
        '观众体验': '理解人物为何改变决定',
      },
    }
    await tool.execute('proposal-before-conflict', request)
    harness.records.get('director_intents')[0].fields['核心主题'] = '异值重放'

    const conflicted = resultJson(await tool.execute('proposal-after-conflict', request))

    expect(harness.createCalls).toHaveLength(1)
    expect(conflicted.responseContract.userVisibleAnswer)
      .toBe('导演脑中存在同 ID 的不同记录，本次未写入。')
    expect(conflicted.responseContract).toMatchObject({
      mustQuoteUserVisibleAnswerExactly: true,
      stopAfterReply: true,
      doNotExposeInternalIds: true,
    })
  })
})
