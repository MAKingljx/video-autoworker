import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import { DIRECTOR_BRAIN_PROPOSAL_TABLES } from '../lib/director-brain-tool.js'

const servicePath = resolve(process.cwd(), 'scripts/lib/feishu-director-brain.mjs')
const serviceModule = await import(pathToFileURL(servicePath).href)
const schema = await serviceModule.loadDirectorBrainSchema()
const catalog = {
  tables: Object.fromEntries(schema.tables.map(table => [
    table.key,
    { name: table.name, tableId: `table-${table.key}` },
  ])),
}
const context = {
  schema,
  catalog,
  accessToken: 'not-returned',
}

function activeWork() {
  return {
    record_id: 'must-not-leak-work',
    fields: {
      '作品名称': '冰原纪事',
      '作品 ID': 'WORK-ICE-001',
      '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
      '别名': '冰原\n冰雪纪事',
      '作品类型': '纪录片',
      '状态': '生效',
      '版本': 'v0.2.0',
      '审核人': '测试导演',
      '审核时间': Date.parse('2026-08-30T10:00:00+08:00'),
      '审核原因': '作品已人工核验',
      '来源': 'test-fixture',
      '更新时间': Date.parse('2026-08-30T10:00:00+08:00'),
    },
  }
}

describe('plugin and director service contract', () => {
  it('aligns project-global and work-scoped request shapes with the service', async () => {
    const connectionReached = { dependencies: {
      connect: async () => { throw new Error('contract_connect_reached') },
    } }
    for (const request of [
      { action: 'get', table: 'system_blueprint', stableId: 'BLUEPRINT-1' },
      { action: 'get', table: 'works', stableId: 'WORK-ICE-001' },
      { action: 'search', table: 'system_blueprint', query: '数据边界' },
      { action: 'search', table: 'works', query: '冰原纪事' },
    ]) {
      await expect(serviceModule.executeDirectorBrainOperation(request, connectionReached))
        .rejects.toThrow('contract_connect_reached')
    }
    await expect(serviceModule.executeDirectorBrainOperation({
      action: 'search', table: 'people_profiles', query: '主角',
    }, connectionReached)).rejects.toThrow('stable_record_id_invalid')
    await expect(serviceModule.executeDirectorBrainOperation({
      action: 'search', table: 'all', query: '主角',
    }, connectionReached)).rejects.toThrow('stable_record_id_invalid')
  })

  it('resolves an active work by title without leaking remote record IDs', async () => {
    const result = await serviceModule.executeDirectorBrainOperation({
      action: 'resolve_work', query: '冰原纪事',
    }, {
      dependencies: {
        connect: async () => context,
        resolveWork: async () => [activeWork()],
      },
    })

    expect(result).toEqual({
      ok: true,
      action: 'resolve_work',
      query: '冰原纪事',
      found: true,
      work: {
        workId: 'WORK-ICE-001',
        name: '冰原纪事',
        aliases: ['冰原', '冰雪纪事'],
        state: '生效',
        version: 'v0.2.0',
      },
    })
    expect(JSON.stringify(result)).not.toContain('record_id')
  })

  it('accepts the plugin assemble shape before opening the director connection', async () => {
    await expect(serviceModule.executeDirectorBrainOperation({
      action: 'assemble',
      workId: 'WORK-ICE-001',
      references: {
        intentVersionId: 'INTENT-REVIEWED-001',
        evidenceIds: ['EVIDENCE-REVIEWED-001'],
        peopleProfileIds: ['PERSON-REVIEWED-001'],
      },
    }, {
      dependencies: { connect: async () => { throw new Error('contract_connect_reached') } },
    })).rejects.toThrow('contract_connect_reached')
  })

  it('keeps the plugin proposal allowlist aligned with the service', async () => {
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
    for (const table of DIRECTOR_BRAIN_PROPOSAL_TABLES) {
      await expect(serviceModule.executeDirectorBrainOperation({
        action: 'propose',
        ...(table === 'works' ? {} : { workId: 'WORK-ICE-001' }),
        table,
        fields: { '最小候选': '契约探针' },
      }, {
        dependencies: { connect: async () => { throw new Error('contract_connect_reached') } },
      })).rejects.toThrow('contract_connect_reached')
    }
    for (const table of ['system_blueprint', 'material_evidence']) {
      await expect(serviceModule.executeDirectorBrainOperation({
        action: 'propose', table, fields: { '只读内容': '不应写入' },
      }, {
        dependencies: { connect: async () => context },
      })).rejects.toThrow('operation_table_not_proposable')
    }
  })

  it('generates the intent stable ID and returns only sanitized domain data', async () => {
    let stored = null
    const findExact = vi.fn(async ({ table }) => {
      if (table.key === 'works') return [activeWork()]
      return stored ? [{
        record_id: 'must-not-leak',
        fields: stored,
        url: 'https://must-not-leak.invalid',
      }] : []
    })
    const create = vi.fn(async ({ fields }) => {
      stored = fields
      return { record_id: 'must-not-leak', fields }
    })

    const result = await serviceModule.executeDirectorBrainOperation({
      action: 'propose',
      workId: 'WORK-ICE-001',
      table: 'director_intents',
      fields: {
        '意图名称': '冰原上的互助',
        '核心主题': '困境中的合作',
        '导演态度': '克制观察',
        '情绪风格': '冷静而紧张',
        '叙事方式': '由人物选择推进',
        '节奏': '前缓后紧',
        '观众体验': '理解困境并感受选择压力',
      },
    }, {
      now: () => '2026-08-30T12:00:00.000Z',
      dependencies: {
        connect: async () => context,
        findExact,
        create,
      },
    })

    expect(result).toMatchObject({
      ok: true,
      action: 'propose',
      table: 'director_intents',
      outcome: 'created',
      record: {
        table: 'director_intents',
        fields: {
          '意图名称': '冰原上的互助',
          '核心主题': '困境中的合作',
          '作品 ID': 'WORK-ICE-001',
          '状态': '草稿',
        },
      },
    })
    expect(result.stableId).toMatch(/^DB-DIRECTOR-INTENTS-[a-f0-9]{64}$/u)
    expect(JSON.stringify(result)).not.toMatch(/record_id|must-not-leak|accessToken|"tableId"/iu)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('accepts the plugin search shape and keeps remote record identifiers out', async () => {
    const result = await serviceModule.executeDirectorBrainOperation({
      action: 'search',
      workId: 'WORK-ICE-001',
      table: 'people_profiles',
      query: '主角',
      status: '候选',
      limit: 10,
    }, {
      dependencies: {
        connect: async () => context,
        findExact: async ({ table }) => table.key === 'works' ? [activeWork()] : [],
        search: async () => ({
          records: [{
            record_id: 'must-not-leak',
            fields: {
              '人物名称': '主角甲',
              '人物版本 ID': 'PERSON-A-v1',
              '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
              '作品 ID': 'WORK-ICE-001',
              '状态': '候选',
            },
          }],
          truncated: false,
        }),
      },
    })

    expect(result).toMatchObject({
      ok: true,
      action: 'search',
      table: 'people_profiles',
      count: 1,
      matches: [{
        table: 'people_profiles',
        stableId: 'PERSON-A-v1',
        reviewed: false,
        fields: { '状态': '候选' },
      }],
    })
    expect(JSON.stringify(result)).not.toContain('record_id')
    expect(JSON.stringify(result)).not.toContain('must-not-leak')
  })

  it('returns a read-only six-layer workflow projection for the selected work', async () => {
    const result = await serviceModule.executeDirectorBrainOperation({
      action: 'workflow',
      workId: 'WORK-ICE-001',
      objective: '判断下一步应补齐哪层导演知识',
    }, {
      dependencies: {
        connect: async () => context,
        findExact: async ({ table }) => table.key === 'works' ? [activeWork()] : [],
        findByWork: async () => [],
      },
    })

    expect(result).toMatchObject({
      ok: true,
      action: 'workflow',
      workId: 'WORK-ICE-001',
      objective: '判断下一步应补齐哪层导演知识',
      readiness: {
        perception: false,
        people: false,
        story: false,
        judgment: false,
        narrative: false,
        intent: false,
      },
      metrics: { readyLayers: 0, totalLayers: 6, referenceIntegrity: true },
    })
    expect(result.nextSuggestion).toContain('素材证据')
  })
})
