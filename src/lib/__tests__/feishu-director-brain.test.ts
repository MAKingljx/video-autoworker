import { execFile, spawn, spawnSync } from 'node:child_process'
import {
  access, lstat, mkdtemp, mkdir, readFile, readdir, readlink, rm, rmdir, stat, symlink, utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

import { describe, expect, it, vi } from 'vitest'

const execFileAsync = promisify(execFile)

interface DirectorBrainModule {
  DEFAULT_CATALOG_PATH: string
  DEFAULT_CATALOG_ROOT: string
  DEFAULT_LOGIN_KEYCHAIN_PATH: string
  validateDirectorBrainLoginKeychainPath: (pathname?: string) => string
  readDirectorBrainKeychainSecret: (
    appId: string,
    service: string,
    options?: Record<string, unknown>,
  ) => Promise<string>
  exactRecordFilter: (fieldName: string, value: string) => string
  executeDirectorBrainOperation: (
    request: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  projectDirectorBrainEvidence: (
    input: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  reviewDirectorBrainRecord: (
    request: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  syncDirectorBrainBlueprint: (
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  initialDirectorBrainBlueprint: (projectId?: string) => Array<Record<string, unknown>>
  loadDirectorBrainSchema: (pathname?: string) => Promise<{
    schemaVersion: number
    brainName: string
    projectId: string
    keychainService: string
    tables: Array<{
      key: string
      name: string
      stableId: string
      fields: Array<{ name: string; type: number; primary?: boolean; options?: string[] }>
    }>
  }>
  resolveBootstrapTableAssignments: (
    schema: unknown,
    catalog: unknown,
    remoteTables: Array<Record<string, unknown>>,
  ) => Record<string, string>
  validateDirectorBrainCatalog: (
    value: unknown,
    schema: unknown,
    options?: Record<string, unknown>,
  ) => unknown
  planDirectorBrainMigration: (
    catalog: unknown,
    schema: unknown,
  ) => Record<string, unknown>
  validateDirectorBrainCatalogPath: (pathname: string, catalogRoot?: string) => string
  validateBootstrapTablePreflight: (
    table: unknown,
    fields: Array<Record<string, unknown>>,
    records?: Array<Record<string, unknown>>,
  ) => boolean
  validateDirectorBrainSchema: (value: unknown) => unknown
  parseDirectorBrainArgs: (argv: string[]) => Record<string, unknown>
  runDirectorBrainCli: (
    argv: string[],
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
}

async function loadModule(): Promise<DirectorBrainModule> {
  const path = resolve(process.cwd(), 'scripts/lib/feishu-director-brain.mjs')
  return await import(/* @vite-ignore */ pathToFileURL(path).href) as DirectorBrainModule
}

type LoadedSchema = Awaited<ReturnType<DirectorBrainModule['loadDirectorBrainSchema']>>

const REVIEWED_AT = Date.parse('2026-08-30T10:00:00+08:00')

function reviewedMetadata(overrides: Record<string, unknown> = {}) {
  return {
    '版本': 'v0.2.0',
    '审核人': '测试导演',
    '审核时间': REVIEWED_AT,
    '审核原因': '测试记录已人工核验',
    '来源': 'test-fixture',
    '更新时间': REVIEWED_AT,
    ...overrides,
  }
}

async function prepareRequiredStandaloneFixture(
  root: string,
  serverConfig: Record<string, unknown> = {},
) {
  const files: Record<string, string> = {
    '.next/BUILD_ID': 'fixture-build\n',
    '.next/package.json': '{"type":"commonjs"}\n',
    '.next/required-server-files.json': `${JSON.stringify({
      version: 1,
      config: serverConfig,
      appDir: serverConfig.outputFileTracingRoot || '.',
      relativeAppDir: '',
      files: [],
      ignore: [],
    })}\n`,
    '.next/server/app.js': 'module.exports = {}\n',
    '.next/static/runtime.css': 'body {}\n',
    'messages/zh-CN.json': '{}\n',
    'node_modules/.pnpm/store-version': 'fixture\n',
    'openapi.json': '{}\n',
    'openclaw-plugins/aiworker-director-brain/index.js': 'export default {}\n',
    'openclaw-plugins/aiworker-director-brain/lib/director-brain-tool.js': 'export {}\n',
    'openclaw-plugins/aiworker-director-brain/openclaw.plugin.json': '{}\n',
    'openclaw-plugins/aiworker-director-brain/package.json': '{}\n',
    'openclaw-skills/aiworker-director-brain/SKILL.md': 'runtime\n',
    'openclaw-skills/aiworker-task-flow/SKILL.md': 'runtime\n',
    'ops/feishu-director-brain/schema.json': '{}\n',
    'package.json': '{}\n',
    'public/favicon.ico': 'fixture\n',
    'runtime/schema.sql': 'CREATE TABLE tasks (id TEXT, title TEXT, status TEXT);\n',
    'scripts/feishu-director-brain.mjs': 'export {}\n',
    'scripts/install-aiworker-director-brain.sh': '#!/bin/sh\n',
    'scripts/verify-shared-runtime-install-gate.mjs': 'export {}\n',
    'scripts/lib/feishu-director-brain.mjs': 'export {}\n',
    'scripts/lib/runtime-safe-offline-queue.mjs': 'export {}\n',
    'scripts/lib/shared-deployment-lock.sh': '#!/bin/sh\n',
  }
  for (const [member, content] of Object.entries(files)) {
    const pathname = join(root, member)
    await mkdir(dirname(pathname), { recursive: true })
    await writeFile(pathname, content)
  }
  await writeFile(
    join(root, 'server.js'),
    `const nextConfig = ${JSON.stringify(serverConfig)}\n\nprocess.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(nextConfig)\n`,
  )
}

function operationHarness(schema: LoadedSchema, initial: Record<string, Array<Record<string, unknown>>> = {}) {
  const defaultWork = [{
    record_id: 'rec_work_default',
    fields: {
      '作品名称': '冰原纪事',
      '作品 ID': 'WORK-ICE-001',
      '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
      '别名': '冰原',
      '作品类型': '纪录片',
      '状态': '生效',
      ...reviewedMetadata(),
    },
  }]
  const records = new Map<string, Array<Record<string, unknown>>>(
    schema.tables.map(table => [
      table.key,
      [...(initial[table.key] || (table.key === 'works' ? defaultWork : []))],
    ]),
  )
  const createCalls: Array<Record<string, unknown>> = []
  const updateCalls: Array<Record<string, unknown>> = []
  const createLockTails = new Map<string, Promise<void>>()
  const context = {
    schema,
    catalog: {
      appId: 'cli_test',
      appToken: 'bascn_private',
      url: 'https://example.invalid/private',
      tables: Object.fromEntries(schema.tables.map(table => [table.key, {
        name: table.name,
        tableId: `table_${table.key}`,
      }])),
    },
    accessToken: 'tenant_private',
    catalogPath: '/private/test-catalog.json',
  }
  const dependencies = {
    connect: async () => context,
    inspectSchema: async () => ({
      ok: true,
      tableCount: schema.tables.length,
      fingerprint: createHash('sha256').update(JSON.stringify(schema.tables)).digest('hex'),
    }),
    withStableCreateLock: async <T>({ table, stableId }: {
      table: LoadedSchema['tables'][number]
      stableId: string
    }, action: () => Promise<T>) => {
      const key = `${table.key}:${stableId}`
      const previous = createLockTails.get(key) || Promise.resolve()
      let release = () => {}
      const current = new Promise<void>(resolveLock => { release = resolveLock })
      const tail = previous.then(() => current)
      createLockTails.set(key, tail)
      await previous
      try {
        return await action()
      } finally {
        release()
        if (createLockTails.get(key) === tail) createLockTails.delete(key)
      }
    },
    findExact: async ({ table, stableId }: {
      table: LoadedSchema['tables'][number]
      stableId: string
    }) => (records.get(table.key) || []).filter(record => (
      (record.fields as Record<string, unknown> | undefined)?.[table.stableId] === stableId
    )),
    search: async ({ table, query, status, limit, workId }: {
      table: LoadedSchema['tables'][number]
      query: string
      status: string | null
      limit: number
      workId?: string | null
    }) => {
      const found = (records.get(table.key) || []).filter(record => {
        const fields = record.fields as Record<string, unknown>
        if (workId && table.key !== 'system_blueprint') {
          const observedWorkId = table.key === 'works'
            ? fields[table.stableId]
            : fields['作品 ID']
          if (observedWorkId !== workId) return false
        }
        if (status && fields['状态'] !== status && fields['复核状态'] !== status) return false
        return Object.values(fields).some(value => String(value).includes(query))
      })
      return { records: found.slice(0, limit), truncated: found.length > limit }
    },
    findByWork: async ({ table, workId }: {
      table: LoadedSchema['tables'][number]
      workId: string
    }) => (records.get(table.key) || []).filter(record => {
      const fields = record.fields as Record<string, unknown>
      return (table.key === 'works' ? fields[table.stableId] : fields['作品 ID']) === workId
    }),
    resolveWork: async () => (
      (records.get('works') || []).filter(record => {
        const fields = record.fields as Record<string, unknown>
        return fields['项目 ID'] === schema.projectId
          && fields['状态'] === '生效'
      })
    ),
    create: async ({ table, fields }: {
      table: LoadedSchema['tables'][number]
      fields: Record<string, unknown>
    }) => {
      const record = { record_id: `rec_${createCalls.length + 1}`, fields: structuredClone(fields) }
      createCalls.push(record)
      records.get(table.key)?.push(record)
      return record
    },
    update: async ({ table, recordId, fields }: {
      table: LoadedSchema['tables'][number]
      recordId: string
      fields: Record<string, unknown>
    }) => {
      const record = (records.get(table.key) || []).find(item => item.record_id === recordId)
      if (!record) throw new Error('test_update_record_missing')
      record.fields = structuredClone(fields)
      updateCalls.push({ recordId, fields: structuredClone(fields) })
      return record
    },
  }
  return {
    context,
    records,
    createCalls,
    updateCalls,
    options: {
      dependencies,
      now: () => '2026-08-30T12:00:00+08:00',
    },
  }
}

function stableCreateLockPath(
  catalogRoot: string,
  projectId: string,
  table: string,
  stableId: string,
) {
  const identity = JSON.stringify({ projectId, stableId, table })
  const lockKey = createHash('sha256').update(identity, 'utf8').digest('hex')
  return join(catalogRoot, '.director-brain-create-locks', `${lockKey}.lock`)
}

function completeIntentFields(overrides: Record<string, unknown> = {}) {
  return {
    '意图名称': '冰面裂缝叙事意图',
    '核心主题': '面对风险时如何作出选择',
    '导演态度': '克制观察但不回避危险',
    '情绪风格': '冷静中逐步积累紧张',
    '叙事方式': '从平静观察逐步进入危机',
    '节奏': '前缓后紧',
    '观众体验': '先理解人物，再感受选择压力',
    ...overrides,
  }
}

type FoundationTable = 'works' | 'director_intents' | 'material_evidence'
  | 'story_nodes' | 'material_judgments' | 'director_cases'

interface FoundationRecord extends Record<string, unknown> {
  record_id: string
  fields: Record<string, unknown>
}

function reviewedFoundation(): Record<FoundationTable, FoundationRecord[]> {
  return {
    works: [{
      record_id: 'rec_work_reviewed',
      fields: {
        '作品名称': '冰原纪事',
        '作品 ID': 'WORK-ICE-001',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
        '别名': '冰原',
        '作品类型': '纪录片',
        '状态': '生效',
        ...reviewedMetadata(),
      },
    }],
    director_intents: [{
      record_id: 'rec_intent_reviewed',
      fields: {
        ...completeIntentFields({ '意图名称': '已生效导演意图' }),
        '意图版本 ID': 'INTENT-REVIEWED-001',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
        '作品 ID': 'WORK-ICE-001',
        '状态': '生效',
        ...reviewedMetadata(),
      },
    }],
    material_evidence: [{
      record_id: 'rec_evidence_reviewed',
      fields: {
        '证据名称': '冰面裂缝证据',
        '证据 ID': 'EVIDENCE-REVIEWED-001',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
        '作品 ID': 'WORK-ICE-001',
        '任务 ID': 'TASK-001',
        '素材 ID': 'MATERIAL-001',
        '场景 ID': 'SCENE-001',
        '镜头 ID': 'SHOT-001',
        '起始时间码': '00:00:10.000',
        '结束时间码': '00:00:14.500',
        '证据摘要': '人物发现冰面裂缝并停下脚步',
        '校验摘要': 'a'.repeat(64),
        '分析版本': 'analysis-v1',
        '置信度': 0.94,
        '状态': '已核验',
        ...reviewedMetadata(),
      },
    }],
    story_nodes: [
      {
        record_id: 'rec_story_reviewed_1',
        fields: {
          '节点名称': '发现裂缝',
          '节点 ID': 'STORY-REVIEWED-001',
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
          '作品 ID': 'WORK-ICE-001',
          '节点类型': '转折',
          '节点内容': '人物发现裂缝后改变前进方向',
          '证据 ID': 'EVIDENCE-REVIEWED-001',
          '置信度': 0.93,
          '状态': '已确认',
          ...reviewedMetadata(),
        },
      },
      {
        record_id: 'rec_story_reviewed_2',
        fields: {
          '节点名称': '共同绕行',
          '节点 ID': 'STORY-REVIEWED-002',
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
          '作品 ID': 'WORK-ICE-001',
          '节点类型': '事件',
          '节点内容': '两人协作寻找安全路线',
          '证据 ID': 'EVIDENCE-REVIEWED-001',
          '置信度': 0.91,
          '状态': '已确认',
          ...reviewedMetadata(),
        },
      },
    ],
    material_judgments: [{
      record_id: 'rec_judgment_reviewed',
      fields: {
        '判断名称': '裂缝镜头价值',
        '判断 ID': 'JUDGMENT-REVIEWED-001',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
        '作品 ID': 'WORK-ICE-001',
        '证据 ID': 'EVIDENCE-REVIEWED-001',
        '意图版本 ID': 'INTENT-REVIEWED-001',
        '故事价值': 90,
        '人物价值': 88,
        '情绪价值': 86,
        '信息价值': 84,
        '视觉价值': 89,
        '稀缺性': 82,
        '叙事价值': 92,
        '使用理由': '人物选择与核心主题形成直接呼应',
        '置信度': 0.92,
        '状态': '已确认',
        ...reviewedMetadata(),
      },
    }],
    director_cases: [{
      record_id: 'rec_case_reviewed',
      fields: {
        '案例名称': '保留停顿的判断案例',
        '案例 ID': 'CASE-REVIEWED-001',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
        '作品 ID': 'WORK-ICE-001',
        '判断 ID': 'JUDGMENT-REVIEWED-001',
        '证据 ID': 'EVIDENCE-REVIEWED-001',
        '上下文': '人物在冰面裂缝前停下并观察同伴',
        '导演动作': '采用',
        '判断原因': '停顿让风险判断和人物关系同时可见',
        '复核状态': '已确认',
        ...reviewedMetadata(),
      },
    }],
  }
}

function projectedEvidence(overrides: Record<string, unknown> = {}) {
  return {
    '证据名称': '裂缝前的停顿',
    '任务 ID': 'TASK-PROJECTION-001',
    '批次 ID': 'BATCH-PROJECTION-001',
    '素材 ID': 'MATERIAL-PROJECTION-001',
    '场景 ID': 'SCENE-PROJECTION-001',
    '镜头 ID': 'SHOT-PROJECTION-001',
    '起始时间码': '00:01:02.120',
    '结束时间码': '00:01:08.640',
    '人物 ID': 'PERSON-AMING',
    '行为': '停下并观察冰面裂缝',
    '证据摘要': '人物发现风险后停止前进并示意同伴靠近',
    '校验摘要': 'a'.repeat(64),
    '分析版本': 'analysis-v2',
    '置信度': 0.96,
    ...overrides,
  }
}

function evidenceProjectionRequest(items: Array<Record<string, unknown>>) {
  return { workId: 'WORK-ICE-001', items }
}

describe('Feishu director brain contract', () => {
  it('keeps an isolated eleven-table schema under the existing Video AutoWorker project', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()

    expect(schema.brainName).toBe('导演脑')
    expect(schema.projectId).toBe('PROJ-VIDEO-AUTOWORKER')
    expect(schema.keychainService).toBe('com.openai.codex.video-autoworker-director-brain.test')
    expect(schema.tables).toHaveLength(11)
    expect(new Set(schema.tables.map(table => table.key)).size).toBe(11)
    expect(schema.tables.map(table => table.name)).toEqual([
      '系统蓝图',
      '作品',
      '导演意图',
      '素材证据',
      '人物档案',
      '故事节点',
      '故事关系',
      '素材判断',
      '叙事方案',
      '导演案例',
      '技能技法库',
    ])
    expect(directorBrain.DEFAULT_CATALOG_PATH).not.toContain(process.cwd())
  })

  it('reads the credential from an explicit login keychain without relying on PATH or search lists', async () => {
    const directorBrain = await loadModule()
    const keychainPath = '/Users/runtime-user/Library/Keychains/login.keychain-db'
    const execute = vi.fn(async () => ({ stdout: 'fixture-credential-value\n', stderr: '' }))

    const value = await directorBrain.readDirectorBrainKeychainSecret(
      'fixture-app',
      'fixture-service',
      { keychainPath, execFileAsync: execute },
    )

    expect(value).toBe('fixture-credential-value')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith('/usr/bin/security', [
      'find-generic-password',
      '-a',
      'fixture-app',
      '-s',
      'fixture-service',
      '-w',
      keychainPath,
    ], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    })
    expect(directorBrain.DEFAULT_LOGIN_KEYCHAIN_PATH).toMatch(
      /\/Library\/Keychains\/login\.keychain-db$/u,
    )
  })

  it('rejects non-login keychain paths and preserves missing-item error mapping', async () => {
    const directorBrain = await loadModule()
    await expect(directorBrain.readDirectorBrainKeychainSecret(
      'fixture-app',
      'fixture-service',
      { keychainPath: '/tmp/other.keychain-db', execFileAsync: vi.fn() },
    )).rejects.toThrow('director_brain_login_keychain_path_invalid')

    const missing = vi.fn(async () => {
      throw Object.assign(new Error('fixture missing'), { code: 44, stderr: '' })
    })
    await expect(directorBrain.readDirectorBrainKeychainSecret(
      'fixture-app',
      'fixture-service',
      {
        keychainPath: '/Users/runtime-user/Library/Keychains/login.keychain-db',
        execFileAsync: missing,
      },
    )).rejects.toThrow('director_brain_keychain_secret_missing')
  })

  it('uses stable domain IDs instead of Feishu record IDs or duplicate source IDs', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()

    for (const table of schema.tables) {
      const names = table.fields.map(field => field.name)
      expect(names).toContain(table.stableId)
      expect(names).not.toContain('飞书记录 ID')
      expect(table.fields.filter(field => field.primary)).toHaveLength(1)
      expect(table.fields[0].primary).toBe(true)
    }

    const evidence = schema.tables.find(table => table.key === 'material_evidence')
    expect(evidence?.fields.map(field => field.name)).toEqual(expect.arrayContaining([
      '任务 ID',
      '批次 ID',
      '素材 ID',
      '场景 ID',
      '镜头 ID',
      '起始时间码',
      '结束时间码',
      '人物 ID',
      '地点',
      '行为',
      '时间信息',
      '声音信息',
      '镜头语言',
      '画面信息',
      'OCR 信息',
    ]))

    const people = schema.tables.find(table => table.key === 'people_profiles')
    expect(people?.stableId).toBe('人物版本 ID')
    expect(people?.fields.map(field => field.name)).toEqual(expect.arrayContaining([
      '人物 ID',
      '作品 ID',
      '观察日期',
      '上一版本 ID',
      '生效时间',
    ]))

    const knowledge = schema.tables.find(table => table.key === 'skills_techniques')
    expect(knowledge?.stableId).toBe('知识 ID')
    expect(knowledge?.fields.map(field => field.name)).toEqual(expect.arrayContaining([
      '知识名称',
      '知识 ID',
      '知识类型',
      '知识分类',
    ]))
  })

  it('stores references and summaries, not original media, credentials, or task state', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const fieldNames = schema.tables.flatMap(table => table.fields.map(field => field.name))

    expect(fieldNames).not.toEqual(expect.arrayContaining([
      '原始视频',
      '逐帧图片',
      '完整原始转写',
      '向量',
      '运行日志',
      'App Secret',
      '访问令牌',
      '任务状态机',
    ]))
    expect(fieldNames).toEqual(expect.arrayContaining([
      '证据摘要',
      '证据 ID',
      '分析版本',
      '置信度',
    ]))
  })

  it('seeds only confirmed architecture facts and preserves the why-learning loop', async () => {
    const directorBrain = await loadModule()
    const records = directorBrain.initialDirectorBrainBlueprint()
    const ids = records.map(record => record['规范 ID'])

    expect(records).toHaveLength(9)
    expect(new Set(ids).size).toBe(records.length)
    expect(ids).toEqual(expect.arrayContaining([
      'DB-SPEC-CORE',
      'DB-GOAL-FINAL',
      'DB-ARCH-6L',
      'DB-LOOP-CASE',
      'DB-INTEGRATION-SINGLE',
      'DB-DATA-BOUNDARY',
      'DB-ID-REUSE',
      'DB-DAVINCI-STAGED',
      'DB-SCOPE-NON-EDITING',
    ]))
    expect(records.find(record => record['规范 ID'] === 'DB-LOOP-CASE')?.内容)
      .toContain('为什么这样判断')
    expect(records.find(record => record['规范 ID'] === 'DB-SCOPE-NON-EDITING')?.内容)
      .toContain('人物、故事节点与关系、七维素材判断、叙事方案与故事脚本、导演案例和技能技法')
    expect(records.find(record => record['规范 ID'] === 'DB-SCOPE-NON-EDITING')?.内容)
      .toContain('不得自动批准或伪造素材证据')
    expect(records.find(record => record['规范 ID'] === 'DB-SCOPE-NON-EDITING')?.内容)
      .toContain('DaVinci、剪辑执行、剪辑时间线、渲染和导出能力暂缓')
    expect(records.every(record => record['项目 ID'] === 'PROJ-VIDEO-AUTOWORKER')).toBe(true)
  })

  it('synchronizes only managed blueprints and reports created, updated, and unchanged', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const expected = directorBrain.initialDirectorBrainBlueprint()
    const initial = expected.slice(1).map((fields, index) => ({
      record_id: `rec_blueprint_${index + 1}`,
      fields: structuredClone(fields),
    }))
    const scope = initial.find(record => record.fields['规范 ID'] === 'DB-SCOPE-NON-EDITING')
    if (!scope) throw new Error('scope_blueprint_fixture_missing')
    scope.fields['标题'] = '当前非剪辑运行边界'
    scope.fields['内容'] = '旧的最小能力边界'
    const harness = operationHarness(schema, { system_blueprint: initial })

    const result = await directorBrain.syncDirectorBrainBlueprint(harness.options)
    expect(result).toMatchObject({
      ok: true,
      synced: 9,
      created: 1,
      updated: 1,
      unchanged: 7,
    })
    expect(harness.createCalls).toHaveLength(1)
    expect(harness.updateCalls).toHaveLength(1)
    expect(harness.records.get('system_blueprint')).toHaveLength(9)
    await expect(directorBrain.runDirectorBrainCli(['sync-blueprint'], harness.options))
      .resolves.toMatchObject({ created: 0, updated: 0, unchanged: 9 })
  })

  it.each([
    ['项目 ID', 'PROJ-FOREIGN'],
    ['来源', 'foreign-owner'],
  ])('rejects a blueprint whose managed %s identity does not match', async (field, value) => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const expected = directorBrain.initialDirectorBrainBlueprint()
    const initial = expected.map((fields, index) => ({
      record_id: `rec_blueprint_${index + 1}`,
      fields: structuredClone(fields),
    }))
    initial[0].fields[field] = value
    const harness = operationHarness(schema, { system_blueprint: initial })

    await expect(directorBrain.syncDirectorBrainBlueprint(harness.options))
      .rejects.toThrow('blueprint_managed_identity_mismatch')
    expect(harness.createCalls).toHaveLength(0)
    expect(harness.updateCalls).toHaveLength(0)
  })

  it('rejects duplicate blueprint stable IDs before any write', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const expected = directorBrain.initialDirectorBrainBlueprint()
    const initial = expected.map((fields, index) => ({
      record_id: `rec_blueprint_${index + 1}`,
      fields: structuredClone(fields),
    }))
    initial.push({ record_id: 'rec_duplicate', fields: structuredClone(expected[0]) })
    const harness = operationHarness(schema, { system_blueprint: initial })

    await expect(directorBrain.syncDirectorBrainBlueprint(harness.options))
      .rejects.toThrow('duplicate_stable_record_id:system_blueprint')
    expect(harness.createCalls).toHaveLength(0)
    expect(harness.updateCalls).toHaveLength(0)
  })

  it('fails when an updated blueprint cannot be read back exactly', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const expected = directorBrain.initialDirectorBrainBlueprint()
    const initial = expected.map((fields, index) => ({
      record_id: `rec_blueprint_${index + 1}`,
      fields: structuredClone(fields),
    }))
    initial[0].fields['标题'] = '待更新旧标题'
    const harness = operationHarness(schema, { system_blueprint: initial })
    harness.options.dependencies.update = vi.fn(async () => ({ record_id: 'ignored' }))

    await expect(directorBrain.syncDirectorBrainBlueprint(harness.options))
      .rejects.toThrow('blueprint_sync_readback_mismatch')
  })

  it('escapes exact stable-ID filters and rejects unsafe field names', async () => {
    const directorBrain = await loadModule()

    expect(directorBrain.exactRecordFilter('规范 ID', 'A"B\\C'))
      .toBe('CurrentValue.[规范 ID]="A\\"B\\\\C"')
    expect(() => directorBrain.exactRecordFilter('坏]字段', 'value')).toThrow('invalid_filter_field')
  })

  it('rejects a schema that introduces a secret field', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const mutated = structuredClone(schema)
    mutated.tables[0].fields.push({ name: 'App Secret', type: 1 })

    expect(() => directorBrain.validateDirectorBrainSchema(mutated)).toThrow('secret_field_forbidden')
  })

  it('requires text primary and stable-ID fields', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const badPrimary = structuredClone(schema)
    badPrimary.tables[0].fields[0].type = 2
    expect(() => directorBrain.validateDirectorBrainSchema(badPrimary))
      .toThrow('primary_field_must_be_text')

    const badStableId = structuredClone(schema)
    const stable = badStableId.tables[0].fields.find(
      field => field.name === badStableId.tables[0].stableId,
    )
    if (!stable) throw new Error('test_fixture_stable_id_missing')
    stable.type = 2
    expect(() => directorBrain.validateDirectorBrainSchema(badStableId))
      .toThrow('stable_id_field_must_be_text')

    const stringType = structuredClone(schema)
    stringType.tables[0].fields[1].type = '1' as unknown as number
    expect(() => directorBrain.validateDirectorBrainSchema(stringType))
      .toThrow('field_type_unsupported')
  })

  it('fails closed when a local catalog is missing isolated-brain identity', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const catalog = {
      schemaVersion: 2,
      brainName: '导演脑',
      projectId: 'PROJ-VIDEO-AUTOWORKER',
      environment: 'test',
      appId: 'cli_test',
      appToken: 'bascn_test',
      tables: {},
    }

    expect(() => directorBrain.validateDirectorBrainCatalog(catalog, schema))
      .toThrow('catalog_keychain_service_required')
    expect(() => directorBrain.validateDirectorBrainCatalog({
      ...catalog,
      keychainService: schema.keychainService,
      brainName: '其他大脑',
    }, schema)).toThrow('catalog_brain_name_mismatch')
  })

  it('keeps every catalog override directly inside the private user-level root', async () => {
    const directorBrain = await loadModule()

    expect(directorBrain.validateDirectorBrainCatalogPath(directorBrain.DEFAULT_CATALOG_PATH))
      .toBe(directorBrain.DEFAULT_CATALOG_PATH)
    expect(() => directorBrain.validateDirectorBrainCatalogPath('test-catalog.json'))
      .toThrow('catalog_path_must_be_absolute')
    expect(() => directorBrain.validateDirectorBrainCatalogPath(
      resolve(process.cwd(), 'test-catalog.json'),
    )).toThrow('catalog_path_outside_private_root')
    expect(() => directorBrain.validateDirectorBrainCatalogPath(
      resolve(directorBrain.DEFAULT_CATALOG_ROOT, 'nested', 'test-catalog.json'),
    )).toThrow('catalog_path_outside_private_root')
  })

  it('requires the catalog to describe the exact schema table set', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const catalog = {
      schemaVersion: 2,
      brainName: schema.brainName,
      projectId: schema.projectId,
      environment: 'test',
      keychainService: schema.keychainService,
      appId: 'cli_test',
      appToken: 'bascn_test',
      tables: Object.fromEntries(schema.tables.map(table => [table.key, {
        name: table.name,
        tableId: `table_${table.key}`,
      }])),
    }

    expect(directorBrain.validateDirectorBrainCatalog(catalog, schema)).toBe(catalog)

    const missing = structuredClone(catalog)
    delete missing.tables.story_relations
    expect(() => directorBrain.validateDirectorBrainCatalog(missing, schema))
      .toThrow('catalog_table_count_mismatch')

    const extra = structuredClone(catalog)
    extra.tables.extra = { name: '额外表', tableId: 'table_extra' }
    expect(() => directorBrain.validateDirectorBrainCatalog(extra, schema))
      .toThrow('catalog_table_key_unexpected')

    const duplicate = structuredClone(catalog)
    duplicate.tables.story_relations.tableId = duplicate.tables.story_nodes.tableId
    expect(() => directorBrain.validateDirectorBrainCatalog(duplicate, schema))
      .toThrow('catalog_table_ids_must_be_unique')
  })

  it('accepts only the controlled v1 catalog shape for an additive v2 migration plan', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const legacyCatalog = {
      schemaVersion: 1,
      brainName: schema.brainName,
      projectId: schema.projectId,
      environment: 'test',
      keychainService: schema.keychainService,
      appId: 'cli_test',
      appToken: 'bascn_test',
      tables: Object.fromEntries(schema.tables
        .filter(table => table.key !== 'works')
        .map(table => [table.key, { name: table.name, tableId: `table_${table.key}` }])),
    }
    expect(() => directorBrain.validateDirectorBrainCatalog(legacyCatalog, schema))
      .toThrow('catalog_schema_version_mismatch')
    expect(directorBrain.validateDirectorBrainCatalog(
      legacyCatalog, schema, { allowLegacyV1: true },
    )).toBe(legacyCatalog)
    expect(directorBrain.planDirectorBrainMigration(legacyCatalog, schema)).toMatchObject({
      fromVersion: 1,
      toVersion: 2,
      required: true,
      addTables: ['works'],
      destructiveChanges: [],
      addFields: {
        director_intents: expect.arrayContaining(['作品 ID', '审核人', '审核时间', '审核原因']),
        material_evidence: expect.arrayContaining(['作品 ID', '版本', '上一版本 ID']),
      },
    })
    const invalid = structuredClone(legacyCatalog)
    delete invalid.tables.story_nodes
    expect(() => directorBrain.validateDirectorBrainCatalog(
      invalid, schema, { allowLegacyV1: true },
    )).toThrow('legacy_catalog_table_set_invalid')
  })

  it('rejects unexpected remote tables before bootstrap reconciliation', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const catalog = {
      tables: {
        system_blueprint: { name: '系统蓝图', tableId: 'table_blueprint' },
      },
    }
    const expectedOnly = [{ table_id: 'table_blueprint', name: '系统蓝图' }]

    expect(directorBrain.resolveBootstrapTableAssignments(schema, catalog, expectedOnly))
      .toMatchObject({ system_blueprint: 'table_blueprint' })
    expect(() => directorBrain.resolveBootstrapTableAssignments(schema, catalog, [
      ...expectedOnly,
      { table_id: 'table_extra', name: '额外表' },
    ])).toThrow('bootstrap_unexpected_remote_table')
  })

  it('allows only missing schema data and empty starter fields during bootstrap preflight', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const table = schema.tables[0]
    const expectedFields = table.fields.slice(0, 3).map((field, index) => ({
      field_id: `field_${index}`,
      field_name: field.name,
      type: field.type,
      is_primary: index === 0,
      ...(field.options ? { property: { options: field.options.map(name => ({ name })) } } : {}),
    }))

    expect(directorBrain.validateBootstrapTablePreflight(table, expectedFields)).toBe(true)
    expect(directorBrain.validateBootstrapTablePreflight(table, [
      ...expectedFields,
      { field_id: 'starter', field_name: '附件', type: 17, is_primary: false },
    ], [{ fields: { 附件: [] } }])).toBe(true)
    expect(() => directorBrain.validateBootstrapTablePreflight(table, [
      ...expectedFields,
      { field_id: 'extra', field_name: '未授权字段', type: 1, is_primary: false },
    ])).toThrow('director_brain_unexpected_field_conflict')

    const selectTable = schema.tables[0]
    const selectField = selectTable.fields.find(field => field.options)
    if (!selectField) throw new Error('test_fixture_select_field_missing')
    const fieldsWithUnexpectedOption = selectTable.fields.map((field, index) => ({
      field_id: `full_field_${index}`,
      field_name: field.name,
      type: field.type,
      is_primary: index === 0,
      ...(field.options ? {
        property: {
          options: [...field.options, '越权选项'].map(name => ({ name })),
        },
      } : {}),
    }))
    expect(() => directorBrain.validateBootstrapTablePreflight(
      selectTable,
      fieldsWithUnexpectedOption,
    )).toThrow(`director_brain_select_options_conflict:${selectTable.key}:${selectField.name}`)
  })

  it('offers a credential-free schema inspection command', async () => {
    const cli = resolve(process.cwd(), 'scripts/feishu-director-brain.mjs')
    const result = await execFileAsync(process.execPath, [cli, 'schema'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    })
    const payload = JSON.parse(result.stdout)

    expect(payload).toMatchObject({
      ok: true,
      brainName: '导演脑',
      projectId: 'PROJ-VIDEO-AUTOWORKER',
      environment: 'test',
      tableCount: 11,
    })
  })

  it('accepts the minimal runtime artifact without rejecting legal package fixtures', async () => {
    const modulePath = resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs')
    const artifactAudit = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
      auditStandaloneArtifact: (root: string) => Promise<{ ok: boolean, forbiddenMembers: number }>
      findForbiddenStandaloneMembers: (root: string) => Promise<string[]>
      writeStandaloneReleaseManifest: (root: string) => Promise<unknown>
    }
    const root = await mkdtemp(join(tmpdir(), 'video-autoworker-standalone-minimal-'))
    try {
      await prepareRequiredStandaloneFixture(root)
      await mkdir(join(root, '.next', 'server', 'app', 'api', 'webhooks', 'test'), { recursive: true })
      await mkdir(join(root, '.next', 'server', 'app', 'docs'), { recursive: true })
      await mkdir(join(root, 'node_modules', 'legal-package', 'test'), { recursive: true })
      await writeFile(join(root, 'node_modules', 'legal-package', 'test', 'fixture.db'), 'fixture\n')
      await writeFile(join(root, 'node_modules', 'legal-package', 'debug.log'), 'fixture\n')
      await artifactAudit.writeStandaloneReleaseManifest(root)

      await expect(artifactAudit.findForbiddenStandaloneMembers(root)).resolves.toEqual([])
      await expect(artifactAudit.auditStandaloneArtifact(root)).resolves.toEqual({
        ok: true,
        root,
        forbiddenMembers: 0,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('fails a standalone artifact containing private, development, or runtime files', async () => {
    const modulePath = resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs')
    const artifactAudit = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
      findForbiddenStandaloneMembers: (root: string) => Promise<string[]>
    }
    const root = await mkdtemp(join(tmpdir(), 'video-autoworker-standalone-audit-'))
    try {
      await mkdir(join(root, 'public', 'nested'), { recursive: true })
      await mkdir(join(root, '.next'), { recursive: true })
      await mkdir(join(root, 'node_modules', 'source-package'), { recursive: true })
      await mkdir(join(root, 'openclaw-plugins', 'aiworker-director-brain', 'lib'), { recursive: true })
      await writeFile(join(root, 'server.js'), 'export {}\n')
      await writeFile(join(root, '.PhoenixBrain'), '{}\n')
      await writeFile(join(root, '.ENV'), 'SECRET=redacted\n')
      await writeFile(join(root, '.npmrc'), '//registry.example/:_authToken=redacted\n')
      await writeFile(join(root, 'public', 'nested', '.env.production'), 'SECRET=redacted\n')
      await writeFile(join(root, 'public', 'nested', '.envrc'), 'export SECRET=redacted\n')
      await writeFile(join(root, 'public', 'nested', 'id_ed25519'), 'redacted\n')
      await writeFile(join(root, 'public', 'nested', 'test-catalog.json'), '{}\n')
      await writeFile(join(root, '.next', 'private-source.ts'), 'export {}\n')
      await writeFile(join(root, '.next', 'route.nft.json'), '{"files":["../../src/private.ts"]}\n')
      await writeFile(join(root, 'node_modules', 'source-package', 'private.ts'), 'export {}\n')
      await writeFile(join(root, 'node_modules', 'source-package', 'private.js.map'), '{}\n')
      await writeFile(join(root, 'openclaw-plugins', 'aiworker-director-brain', 'lib', 'private.ts'), 'export {}\n')
      for (const directory of ['.tmp', 'output', 'tests', 'src', 'src-tauri', 'docs', 'wiki']) {
        await mkdir(join(root, directory), { recursive: true })
      }
      await writeFile(join(root, '.tmp', 'ignored.db'), 'runtime\n')
      await writeFile(join(root, 'output', 'ignored.log'), 'runtime\n')
      await writeFile(join(root, 'runtime.db'), 'runtime\n')
      await writeFile(join(root, 'runtime.db-shm'), 'runtime\n')
      await writeFile(join(root, 'runtime.db-wal'), 'runtime\n')
      await writeFile(join(root, 'runtime.log'), 'runtime\n')
      await writeFile(join(root, 'runtime.pid'), '123\n')

      await expect(artifactAudit.findForbiddenStandaloneMembers(root)).resolves.toEqual([
        '.ENV',
        '.PhoenixBrain',
        '.npmrc',
        '.tmp',
        '.next/private-source.ts',
        '.next/route.nft.json',
        'docs',
        'node_modules/source-package/private.js.map',
        'node_modules/source-package/private.ts',
        'openclaw-plugins/aiworker-director-brain/lib/private.ts',
        'public/nested/.env.production',
        'public/nested/.envrc',
        'public/nested/id_ed25519',
        'public/nested/test-catalog.json',
        'output',
        'runtime.db',
        'runtime.db-shm',
        'runtime.db-wal',
        'runtime.log',
        'runtime.pid',
        'src',
        'src-tauri',
        'tests',
        'wiki',
      ].sort())
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('sanitizes only forbidden generated members and audits the final artifact', async () => {
    const modulePath = resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs')
    const artifactAudit = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
      auditStandaloneArtifact: (root: string) => Promise<{ ok: boolean, forbiddenMembers: number }>
      sanitizeStandaloneArtifact: (root: string) => Promise<{
        ok: boolean
        removedMembers: string[]
      }>
    }
    const projectRoot = await mkdtemp(join(tmpdir(), 'video-autoworker-standalone-sanitize-'))
    const root = join(projectRoot, '.next', 'standalone')
    try {
      await prepareRequiredStandaloneFixture(root, {
        outputFileTracingRoot: projectRoot,
        outputFileTracingIncludes: { '/*': ['./src/**/*'] },
        turbopack: { root: projectRoot },
      })
      await mkdir(join(root, 'src', 'app'), { recursive: true })
      await mkdir(join(root, 'node_modules', 'legal-package', 'test'), { recursive: true })
      await mkdir(join(projectRoot, 'node_modules', '.pnpm'), { recursive: true })
      await mkdir(join(projectRoot, '.next', 'server', 'chunks'), { recursive: true })
      await mkdir(join(projectRoot, '.next', 'static', 'chunks'), { recursive: true })
      await mkdir(join(projectRoot, 'public'), { recursive: true })
      await mkdir(join(projectRoot, 'messages'), { recursive: true })
      await mkdir(join(projectRoot, 'src', 'lib'), { recursive: true })
      await writeFile(join(root, 'src', 'app', 'route.ts'), 'export {}\n')
      await writeFile(join(root, 'runtime.db'), 'runtime\n')
      await writeFile(join(root, 'node_modules', 'legal-package', 'test', 'fixture.db'), 'fixture\n')
      await writeFile(join(projectRoot, '.next', 'server', 'chunks', 'runtime.js'), 'export {}\n')
      await writeFile(join(projectRoot, '.next', 'server', 'chunks', 'runtime.js.map'), '{"sourcesContent":["private source"]}\n')
      await writeFile(join(projectRoot, '.next', 'static', 'chunks', 'runtime.css'), 'body {}\n')
      await writeFile(join(projectRoot, '.next', 'static', 'chunks', 'runtime.css.map'), '{"sourcesContent":["private source"]}\n')
      await writeFile(join(projectRoot, 'public', 'favicon.ico'), 'fixture\n')
      await writeFile(join(projectRoot, 'messages', 'zh.json'), '{}\n')
      await writeFile(join(projectRoot, 'src', 'lib', 'schema.sql'), 'CREATE TABLE test (id INTEGER);\n')

      await expect(artifactAudit.sanitizeStandaloneArtifact(root)).resolves.toMatchObject({
        ok: true,
        copiedServerChunks: 1,
        copiedStaticAssets: 1,
        copiedPublicAssets: 1,
        copiedMessages: 1,
        copiedRuntimeSchema: 'runtime/schema.sql',
        removedMembers: ['runtime.db', 'src'],
      })
      await expect(access(join(root, 'src'))).rejects.toThrow()
      await expect(access(join(root, 'runtime.db'))).rejects.toThrow()
      await expect(access(join(root, 'node_modules', 'legal-package', 'test', 'fixture.db'))).resolves.toBeUndefined()
      await expect(access(join(root, '.next', 'server', 'chunks', 'runtime.js'))).resolves.toBeUndefined()
      await expect(access(join(root, '.next', 'server', 'chunks', 'runtime.js.map'))).rejects.toThrow()
      await expect(access(join(root, '.next', 'static', 'chunks', 'runtime.css'))).resolves.toBeUndefined()
      await expect(access(join(root, '.next', 'static', 'chunks', 'runtime.css.map'))).rejects.toThrow()
      await expect(access(join(root, 'public', 'favicon.ico'))).resolves.toBeUndefined()
      await expect(access(join(root, 'messages', 'zh.json'))).resolves.toBeUndefined()
      await expect(access(join(root, 'runtime', 'schema.sql'))).resolves.toBeUndefined()
      await expect(artifactAudit.auditStandaloneArtifact(root)).resolves.toEqual({
        ok: true,
        root,
        forbiddenMembers: 0,
      })
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('rejects an ancestor symlink before the sanitizer can mutate outside the artifact', async () => {
    const modulePath = resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs')
    const artifactAudit = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
      sanitizeStandaloneArtifact: (root: string) => Promise<unknown>
    }
    const projectRoot = await mkdtemp(join(tmpdir(), 'video-autoworker-standalone-link-boundary-'))
    const root = join(projectRoot, '.next', 'standalone')
    const outside = join(projectRoot, 'outside')
    const sentinel = join(outside, 'sentinel.txt')
    try {
      await mkdir(root, { recursive: true })
      await mkdir(outside, { recursive: true })
      await writeFile(sentinel, 'must survive\n')
      await symlink(outside, join(root, '.next'))

      await expect(artifactAudit.sanitizeStandaloneArtifact(root))
        .rejects.toThrow('standalone_unsafe_links:.next')
      await expect(access(sentinel)).resolves.toBeUndefined()
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('requires a complete release and detects any post-build drift', async () => {
    const modulePath = resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs')
    const artifactAudit = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
      auditStandaloneArtifact: (root: string) => Promise<unknown>
      verifyStandaloneReleaseManifest: (root: string) => Promise<unknown>
      writeStandaloneReleaseManifest: (root: string) => Promise<unknown>
    }
    const root = await mkdtemp(join(tmpdir(), 'video-autoworker-standalone-manifest-'))
    const incomplete = await mkdtemp(join(tmpdir(), 'video-autoworker-standalone-incomplete-'))
    try {
      await writeFile(join(incomplete, 'server.js'), 'export {}\n')
      await expect(artifactAudit.auditStandaloneArtifact(incomplete))
        .rejects.toThrow('standalone_required_file_missing:.next/BUILD_ID')

      await prepareRequiredStandaloneFixture(root)
      await artifactAudit.writeStandaloneReleaseManifest(root)
      await expect(artifactAudit.auditStandaloneArtifact(root)).resolves.toMatchObject({ ok: true })

      await writeFile(join(root, 'public', 'favicon.ico'), 'changed after build\n')
      await expect(artifactAudit.verifyStandaloneReleaseManifest(root))
        .rejects.toThrow('standalone_release_manifest_mismatch')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(incomplete, { recursive: true, force: true })
    }
  })

  it('repairs pnpm package links that standalone tracing expanded into directories', async () => {
    const modulePath = resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs')
    const artifactAudit = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
      repairStandalonePnpmLinks: (root: string, projectRoot: string) => Promise<string[]>
    }
    const projectRoot = await mkdtemp(join(tmpdir(), 'video-autoworker-standalone-pnpm-links-'))
    const root = join(projectRoot, '.next', 'standalone')
    const linkTarget = '../../dependency@1.0.0/node_modules/dependency'
    const sourceLink = join(
      projectRoot,
      'node_modules',
      '.pnpm',
      'consumer@1.0.0',
      'node_modules',
      'dependency',
    )
    const outputLink = join(
      root,
      'node_modules',
      '.pnpm',
      'consumer@1.0.0',
      'node_modules',
      'dependency',
    )
    try {
      await mkdir(join(sourceLink, '..'), { recursive: true })
      await mkdir(join(
        projectRoot,
        'node_modules',
        '.pnpm',
        'dependency@1.0.0',
        'node_modules',
        'dependency',
      ), { recursive: true })
      await symlink(linkTarget, sourceLink)

      // Next tracing may materialize a pnpm dependency link as a partial
      // directory. The sanitizer must restore the original relative link.
      await mkdir(outputLink, { recursive: true })
      await writeFile(join(outputLink, 'partial.js'), 'export {}\n')
      await mkdir(join(
        root,
        'node_modules',
        '.pnpm',
        'dependency@1.0.0',
        'node_modules',
        'dependency',
      ), { recursive: true })
      await writeFile(join(
        root,
        'node_modules',
        '.pnpm',
        'dependency@1.0.0',
        'node_modules',
        'dependency',
        'package.json',
      ), '{"main":"index.cjs"}\n')
      await writeFile(join(
        root,
        'node_modules',
        '.pnpm',
        'dependency@1.0.0',
        'node_modules',
        'dependency',
        'index.cjs',
      ), 'module.exports = "loaded"\n')

      await expect(artifactAudit.repairStandalonePnpmLinks(root, projectRoot)).resolves.toEqual([
        'node_modules/.pnpm/consumer@1.0.0/node_modules/dependency',
      ])
      await expect(lstat(outputLink).then(stat => stat.isSymbolicLink())).resolves.toBe(true)
      await expect(readlink(outputLink)).resolves.toBe(linkTarget)
      const requireFromConsumer = createRequire(join(outputLink, '..', 'consumer-entry.cjs'))
      expect(requireFromConsumer('dependency')).toBe('loaded')
      await expect(artifactAudit.repairStandalonePnpmLinks(root, projectRoot)).resolves.toEqual([])
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('fails closed when a traced pnpm package is missing a dependency target', async () => {
    const modulePath = resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs')
    const artifactAudit = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
      repairStandalonePnpmLinks: (root: string, projectRoot: string) => Promise<string[]>
    }
    const projectRoot = await mkdtemp(join(tmpdir(), 'video-autoworker-standalone-pnpm-missing-'))
    const root = join(projectRoot, '.next', 'standalone')
    const sourcePackageModules = join(
      projectRoot,
      'node_modules',
      '.pnpm',
      'consumer@1.0.0',
      'node_modules',
    )
    try {
      await mkdir(sourcePackageModules, { recursive: true })
      await mkdir(join(root, 'node_modules', '.pnpm', 'consumer@1.0.0', 'node_modules'), { recursive: true })
      await mkdir(join(
        projectRoot,
        'node_modules',
        '.pnpm',
        'dependency@1.0.0',
        'node_modules',
        'dependency',
      ), { recursive: true })
      await symlink('../../dependency@1.0.0/node_modules/dependency', join(sourcePackageModules, 'dependency'))

      await expect(artifactAudit.repairStandalonePnpmLinks(root, projectRoot))
        .rejects.toThrow('standalone_pnpm_output_target_missing')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })

  it('fails closed when the source pnpm store is unavailable', async () => {
    const modulePath = resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs')
    const artifactAudit = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
      repairStandalonePnpmLinks: (root: string, projectRoot: string) => Promise<string[]>
    }
    const projectRoot = await mkdtemp(join(tmpdir(), 'video-autoworker-standalone-pnpm-store-'))
    const root = join(projectRoot, '.next', 'standalone')
    try {
      await mkdir(join(root, 'node_modules', '.pnpm', 'consumer@1.0.0', 'node_modules'), { recursive: true })
      await expect(artifactAudit.repairStandalonePnpmLinks(root, projectRoot))
        .rejects.toThrow('standalone_pnpm_source_store_missing')
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
    }
  })
})

describe('Feishu director brain OpenClaw operation service', () => {
  it('returns a bounded health projection without private connection metadata', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema)

    const result = await directorBrain.executeDirectorBrainOperation(
      { action: 'health' },
      harness.options,
    )

    expect(result).toEqual({
      ok: true,
      action: 'health',
      brainName: '导演脑',
      projectId: 'PROJ-VIDEO-AUTOWORKER',
      environment: 'test',
      tableCount: 11,
      remoteContractVerified: true,
      schemaFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    expect(JSON.stringify(result)).not.toMatch(/record_id|appToken|tableId|catalogPath|example\.invalid/u)
  })

  it('resolves one active work by exact title or alias and rejects ambiguity', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, reviewedFoundation())
    const byName = await directorBrain.executeDirectorBrainOperation({
      action: 'resolve_work', query: '冰原纪事',
    }, harness.options)
    const byAlias = await directorBrain.executeDirectorBrainOperation({
      action: 'resolve_work', query: '冰原',
    }, harness.options)
    expect(byName).toMatchObject({
      found: true,
      work: { workId: 'WORK-ICE-001', name: '冰原纪事', aliases: ['冰原'], state: '生效' },
    })
    expect(byAlias).toMatchObject({ work: { workId: 'WORK-ICE-001' } })
    harness.records.get('works')?.push({
      record_id: 'rec_work_ambiguous',
      fields: {
        '作品名称': '另一部作品', '作品 ID': 'WORK-ICE-002',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '别名': '冰原',
        '作品类型': '纪录片', '状态': '生效', ...reviewedMetadata(),
      },
    })
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'resolve_work', query: '冰原',
    }, harness.options)).rejects.toThrow('work_resolution_ambiguous')
  })

  it('safely strips repeated paired outer title punctuation without changing inner punctuation', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const works = [
      {
        record_id: 'rec_director_acceptance',
        fields: {
          '作品名称': '导演脑验收片', '作品 ID': 'WORK-DIRECTOR-ACCEPTANCE',
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '别名': '测试导演片',
          '作品类型': '纪录片', '状态': '生效', ...reviewedMetadata(),
        },
      },
      {
        record_id: 'rec_inner_punctuation',
        fields: {
          '作品名称': '导演《脑》验收片', '作品 ID': 'WORK-INNER-PUNCTUATION',
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '别名': '',
          '作品类型': '纪录片', '状态': '生效', ...reviewedMetadata(),
        },
      },
    ]
    const harness = operationHarness(schema, { works })
    for (const query of [
      '《导演脑验收片》',
      '“《导演脑验收片》”',
      '‘导演脑验收片’',
      '"导演脑验收片"',
      "'导演脑验收片'",
      '＂导演脑验收片＂',
      '＇导演脑验收片＇',
    ]) {
      await expect(directorBrain.executeDirectorBrainOperation({
        action: 'resolve_work', query,
      }, harness.options)).resolves.toMatchObject({
        found: true, work: { workId: 'WORK-DIRECTOR-ACCEPTANCE' },
      })
    }
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'resolve_work', query: '《测试导演片》',
    }, harness.options)).resolves.toMatchObject({
      found: true, work: { workId: 'WORK-DIRECTOR-ACCEPTANCE' },
    })
    for (const query of ['《导演脑验收片', '导演脑验收片》']) {
      await expect(directorBrain.executeDirectorBrainOperation({
        action: 'resolve_work', query,
      }, harness.options)).resolves.toMatchObject({ found: false, work: null })
    }
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'resolve_work', query: '导演《脑》验收片',
    }, harness.options)).resolves.toMatchObject({
      found: true, work: { workId: 'WORK-INNER-PUNCTUATION' },
    })

    harness.records.get('works')?.push({
      record_id: 'rec_wrapped_alias_collision',
      fields: {
        '作品名称': '另一验收片', '作品 ID': 'WORK-WRAPPED-ALIAS',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '别名': '《导演脑验收片》',
        '作品类型': '纪录片', '状态': '生效', ...reviewedMetadata(),
      },
    })
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'resolve_work', query: '《导演脑验收片》',
    }, harness.options)).rejects.toThrow('work_resolution_ambiguous')
  })

  it('reports six-layer readiness without editing or execution side effects', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, reviewedFoundation())
    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'workflow', workId: 'WORK-ICE-001', objective: '判断当前故事建设缺口',
    }, harness.options)
    expect(result).toMatchObject({
      action: 'workflow', workId: 'WORK-ICE-001',
      readiness: {
        perception: true, people: false, story: false,
        judgment: true, narrative: false, intent: true,
      },
      metrics: {
        readyLayers: 3, totalLayers: 6, activeIntentCount: 1,
        referenceIntegrity: true, referenceIssueCount: 0,
      },
      referenceIssues: [],
      nextSuggestion: '基于已核验证据建立并确认人物档案。',
    })
    expect(harness.createCalls).toHaveLength(0)
    expect(harness.updateCalls).toHaveLength(0)
  })

  it('does not mark a layer ready when its reviewed record has a broken reference', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const initial = reviewedFoundation()
    if (!initial.material_judgments?.[0]?.fields) throw new Error('judgment_fixture_missing')
    initial.material_judgments[0].fields['证据 ID'] = 'EVIDENCE-MISSING-001'
    const harness = operationHarness(schema, initial)

    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'workflow', workId: 'WORK-ICE-001',
    }, harness.options)

    expect((result.readiness as Record<string, unknown>).judgment).toBe(false)
    expect(result.metrics).toMatchObject({ referenceIntegrity: false, referenceIssueCount: 2 })
    expect(result.referenceIssues).toEqual(expect.arrayContaining([
      {
        table: 'material_judgments',
        stableId: 'JUDGMENT-REVIEWED-001',
        field: '证据 ID',
        reason: 'not_reviewed_or_missing',
      },
      {
        table: 'director_cases',
        stableId: 'CASE-REVIEWED-001',
        field: '判断 ID',
        reason: 'not_reviewed_or_missing',
      },
    ]))
  })

  it('validates material-evidence version ancestry and accepts an audited superseded version', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const initial = reviewedFoundation()
    const currentEvidence = initial.material_evidence[0]
    currentEvidence.fields['上一版本 ID'] = 'EVIDENCE-OLD-001'
    const missingHarness = operationHarness(schema, initial)
    const missing = await directorBrain.executeDirectorBrainOperation({
      action: 'workflow', workId: 'WORK-ICE-001',
    }, missingHarness.options)
    expect((missing.readiness as Record<string, unknown>).perception).toBe(false)
    expect(missing.referenceIssues).toEqual(expect.arrayContaining([{
      table: 'material_evidence', stableId: 'EVIDENCE-REVIEWED-001',
      field: '上一版本 ID', reason: 'not_reviewed_or_missing',
    }]))

    initial.material_evidence.push({
      record_id: 'rec_evidence_old',
      fields: {
        ...structuredClone(currentEvidence.fields),
        '证据名称': '旧版裂缝证据', '证据 ID': 'EVIDENCE-OLD-001',
        '上一版本 ID': '', '状态': '失效', '版本': 'v0.2.1',
        '审核人': '测试导演',
        '审核时间': Date.parse('2026-08-29T12:00:00+08:00'),
        '审核原因': '已由新版证据接替',
      },
    })
    const validHarness = operationHarness(schema, initial)
    const valid = await directorBrain.executeDirectorBrainOperation({
      action: 'workflow', workId: 'WORK-ICE-001',
    }, validHarness.options)
    expect((valid.readiness as Record<string, unknown>).perception).toBe(true)
    expect(valid.referenceIssues).not.toEqual(expect.arrayContaining([expect.objectContaining({
      table: 'material_evidence', stableId: 'EVIDENCE-REVIEWED-001',
    })]))
  })

  it('does not report intent readiness for an active intent with an invalid version chain', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const initial = reviewedFoundation()
    initial.director_intents[0].fields['上一版本 ID'] = 'INTENT-MISSING-001'
    const harness = operationHarness(schema, initial)
    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'workflow', workId: 'WORK-ICE-001',
    }, harness.options)
    expect((result.readiness as Record<string, unknown>).intent).toBe(false)
    expect(result.metrics).toMatchObject({ activeIntentCount: 0, referenceIntegrity: false })
    expect(result.referenceIssues).toEqual(expect.arrayContaining([{
      table: 'director_intents', stableId: 'INTENT-REVIEWED-001',
      field: '上一版本 ID', reason: 'not_reviewed_or_missing',
    }]))
  })

  it('fails closed when a business record belongs to another work', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, {
      story_nodes: [{
        record_id: 'rec_cross_work',
        fields: {
          '节点名称': '另一作品节点', '节点 ID': 'STORY-CROSS-001',
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-OTHER-001',
          '状态': '已确认',
        },
      }],
    })
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'get', table: 'story_nodes', workId: 'WORK-ICE-001', stableId: 'STORY-CROSS-001',
    }, harness.options)).rejects.toThrow('record_work_mismatch')
  })

  it('fails closed when project or work identity is missing from a scoped record', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const missingProject = structuredClone(reviewedFoundation().works[0])
    missingProject.fields['作品 ID'] = 'WORK-MISSING-PROJECT'
    delete missingProject.fields['项目 ID']
    const missingWork = structuredClone(reviewedFoundation().story_nodes[0])
    missingWork.fields['节点 ID'] = 'STORY-MISSING-WORK'
    delete missingWork.fields['作品 ID']
    const harness = operationHarness(schema, {
      works: [missingProject],
      story_nodes: [missingWork],
    })

    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'get', table: 'works', stableId: 'WORK-MISSING-PROJECT',
    }, harness.options)).rejects.toThrow('record_project_missing:works')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'get', table: 'story_nodes', workId: 'WORK-ICE-001',
      stableId: 'STORY-MISSING-WORK',
    }, harness.options)).rejects.toThrow('record_work_missing:story_nodes')
  })

  it('does not trust reviewed states with missing domain, audit, or valid version fields', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const baseIntent = reviewedFoundation().director_intents[0]
    const variants = [
      ['INTENT-MISSING-DOMAIN', '核心主题'],
      ['INTENT-MISSING-AUDIT', '审核人'],
      ['INTENT-FAKE-VERSION', '版本'],
    ] as const

    for (const [stableId, field] of variants) {
      const malformed = structuredClone(baseIntent)
      malformed.fields['意图版本 ID'] = stableId
      if (field === '版本') malformed.fields[field] = 'manual-approved'
      else delete malformed.fields[field]
      const foundation = reviewedFoundation()
      foundation.director_intents = [malformed]
      const harness = operationHarness(schema, foundation)

      await expect(directorBrain.executeDirectorBrainOperation({
        action: 'get', table: 'director_intents', workId: 'WORK-ICE-001', stableId,
      }, harness.options)).resolves.toMatchObject({ record: { reviewed: false } })
      await expect(directorBrain.executeDirectorBrainOperation({
        action: 'search', table: 'director_intents', workId: 'WORK-ICE-001',
        query: '已生效导演意图', limit: 5,
      }, harness.options)).resolves.toMatchObject({ count: 0, matches: [] })
      const workflow = await directorBrain.executeDirectorBrainOperation({
        action: 'workflow', workId: 'WORK-ICE-001',
      }, harness.options)
      expect((workflow.readiness as Record<string, unknown>).intent).toBe(false)
      expect(workflow.metrics).toMatchObject({ activeIntentCount: 0 })
      await expect(directorBrain.executeDirectorBrainOperation({
        action: 'assemble', workId: 'WORK-ICE-001',
        references: {
          intentVersionId: stableId,
          evidenceIds: ['EVIDENCE-REVIEWED-001'],
        },
      }, harness.options)).rejects.toThrow('reference_record_not_reviewed:director_intents')
    }
  })

  it('requires audit metadata for active works and verified evidence but not blueprint schema', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    const workWithoutAudit = structuredClone(foundation.works[0])
    delete workWithoutAudit.fields['审核原因']
    const evidenceWithoutAudit = structuredClone(foundation.material_evidence[0])
    delete evidenceWithoutAudit.fields['审核时间']
    const harness = operationHarness(schema, {
      ...foundation,
      works: [workWithoutAudit],
      material_evidence: [evidenceWithoutAudit],
    })

    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'resolve_work', query: '冰原纪事',
    }, harness.options)).resolves.toMatchObject({ found: false, work: null })
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'get', table: 'material_evidence', workId: 'WORK-ICE-001',
      stableId: 'EVIDENCE-REVIEWED-001',
    }, harness.options)).resolves.toMatchObject({ record: { reviewed: false } })

    const blueprintHarness = operationHarness(schema, {
      system_blueprint: [{
        record_id: 'rec_blueprint_schema_difference',
        fields: {
          '标题': '系统边界', '规范 ID': 'BLUEPRINT-SCHEMA-DIFFERENCE',
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '环境': '测试', '类型': '数据边界',
          '内容': '系统蓝图按自身 schema 生效。', '状态': '生效', '版本': 'v0.1.0',
          '来源': 'test-fixture', '更新时间': REVIEWED_AT,
        },
      }],
    })
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'get', table: 'system_blueprint', stableId: 'BLUEPRINT-SCHEMA-DIFFERENCE',
    }, blueprintHarness.options)).resolves.toMatchObject({ record: { reviewed: true } })
  })

  it('rejects duplicate stable IDs returned by search or workflow dependencies', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const candidate = {
      record_id: 'rec_duplicate_candidate_1',
      fields: {
        '节点名称': '重复候选节点', '节点 ID': 'STORY-DUPLICATE-001',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
        '状态': '候选',
      },
    }
    const duplicate = structuredClone(candidate)
    duplicate.record_id = 'rec_duplicate_candidate_2'
    const harness = operationHarness(schema, {
      ...reviewedFoundation(),
      story_nodes: [candidate, duplicate],
    })

    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'search', table: 'story_nodes', workId: 'WORK-ICE-001',
      query: '重复候选节点', status: '候选', limit: 5,
    }, harness.options)).rejects.toThrow('duplicate_stable_record_id:story_nodes:STORY-DUPLICATE-001')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'workflow', workId: 'WORK-ICE-001',
    }, harness.options)).rejects.toThrow('duplicate_stable_record_id:story_nodes:STORY-DUPLICATE-001')
  })

  it('gets an exact stable ID from every schema table and hides editing metadata', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const initial = Object.fromEntries(schema.tables.map(table => [table.key, [{
      record_id: `rec_${table.key}`,
      fields: {
        [table.fields[0].name]: `${table.name}命中`,
        [table.stableId]: `stable-${table.key}`,
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
        ...(!['system_blueprint', 'works'].includes(table.key) ? {
          '作品 ID': 'WORK-ICE-001',
        } : {}),
        '时间线': '先平静，后进入暴风雪，再返回港口',
        '剪辑方案 ID': 'edit-plan-private',
        '成片位置': '00:10',
        '时间线版本': 'timeline-private',
        ...(table.key === 'director_cases' ? { '复核状态': '已确认' } : {}),
      },
    }]]))
    const harness = operationHarness(schema, initial)

    for (const table of schema.tables) {
      const result = await directorBrain.executeDirectorBrainOperation({
        action: 'get', table: table.key, stableId: `stable-${table.key}`,
        ...(!['system_blueprint', 'works'].includes(table.key)
          ? { workId: 'WORK-ICE-001' }
          : {}),
      }, harness.options)
      expect(result).toMatchObject({
        ok: true,
        action: 'get',
        table: table.key,
        found: true,
        record: { table: table.key, stableId: `stable-${table.key}` },
      })
      expect(JSON.stringify(result)).not.toMatch(
        /"record_id"|"appToken"|"tableId"|"catalogPath"|剪辑方案 ID|时间线版本/u,
      )
      if (table.key === 'narrative_plans') {
        expect(result).toMatchObject({
          record: { fields: { '时间线': '先平静，后进入暴风雪，再返回港口' } },
        })
      }
      expect(JSON.stringify(result)).not.toContain('成片位置')
    }
  })

  it('returns a final-film position only for a confirmed director case', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, {
      director_cases: [{
        record_id: 'rec_case_candidate_position',
        fields: {
          '案例名称': '待复核案例',
          '案例 ID': 'CASE-CANDIDATE-POSITION',
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
          '作品 ID': 'WORK-ICE-001',
          '成片位置': '00:22',
          '复核状态': '待复核',
        },
      }],
    })

    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'get', table: 'director_cases', workId: 'WORK-ICE-001',
      stableId: 'CASE-CANDIDATE-POSITION',
    }, harness.options)
    expect(result).toMatchObject({ record: { state: '待复核', reviewed: false } })
    expect(JSON.stringify(result)).not.toContain('成片位置')
  })

  it('searches natural language across all tables with status and a hard result limit', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, {
      ...reviewedFoundation(),
      story_nodes: [
        {
          record_id: 'rec_story_1',
          fields: {
            '节点名称': '暴风雪中的决定',
            '节点 ID': 'story-1',
            '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
            '作品 ID': 'WORK-ICE-001',
            '节点内容': '船长在暴风雪中决定继续前进',
            '状态': '候选',
          },
        },
        {
          record_id: 'rec_story_2',
          fields: {
            '节点名称': '港口等待',
            '节点 ID': 'story-2',
            '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
            '作品 ID': 'WORK-ICE-001',
            '节点类型': '事件',
            '节点内容': '暴风雪后在港口等待',
            '置信度': 0.88,
            '状态': '已确认',
            ...reviewedMetadata(),
          },
        },
      ],
    })

    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'search', table: 'all', workId: 'WORK-ICE-001',
      query: '暴风雪', status: '候选', limit: 1,
    }, harness.options)

    expect(result).toMatchObject({
      ok: true,
      action: 'search',
      table: 'all',
      query: '暴风雪',
      status: '候选',
      limit: 1,
      count: 1,
      matches: [{ table: 'story_nodes', stableId: 'story-1', reviewed: false }],
    })
    const reviewedOnly = await directorBrain.executeDirectorBrainOperation({
      action: 'search', table: 'all', workId: 'WORK-ICE-001', query: '暴风雪', limit: 20,
    }, harness.options)
    expect(reviewedOnly).toMatchObject({
      count: 1,
      matches: [{ table: 'story_nodes', stableId: 'story-2', state: '已确认', reviewed: true }],
    })
    const exactReviewed = await directorBrain.executeDirectorBrainOperation({
      action: 'get', table: 'story_nodes', workId: 'WORK-ICE-001', stableId: 'story-2',
    }, harness.options)
    expect(exactReviewed).toMatchObject({
      record: { state: '已确认', reviewed: true },
    })
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'search', table: 'all', workId: 'WORK-ICE-001', query: '暴风雪', limit: 21,
    }, harness.options)).rejects.toThrow('search_limit_invalid')
  })

  it('derives a deterministic stable ID and changes create into unchanged on replay', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, reviewedFoundation())
    const firstFields = completeIntentFields()

    const created = await directorBrain.executeDirectorBrainOperation({
      action: 'propose', table: 'director_intents', workId: 'WORK-ICE-001', fields: firstFields,
    }, harness.options)
    const replayed = await directorBrain.executeDirectorBrainOperation({
      action: 'propose',
      table: 'director_intents',
      workId: 'WORK-ICE-001',
      fields: completeIntentFields({
        '叙事方式': '从平静观察逐步进入危机',
        '核心主题': '面对风险时如何作出选择',
        '意图名称': '冰面裂缝叙事意图',
      }),
    }, harness.options)

    expect(created).toMatchObject({
      outcome: 'created',
      stableId: expect.stringMatching(/^DB-DIRECTOR-INTENTS-[a-f0-9]{64}$/u),
      record: {
        fields: {
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
          '作品 ID': 'WORK-ICE-001',
          '状态': '草稿',
          '版本': 'v0.2.0',
          '来源': 'openclaw-director-brain',
          '更新时间': Date.parse('2026-08-30T12:00:00+08:00'),
        },
      },
    })
    expect(replayed).toMatchObject({ outcome: 'unchanged', stableId: created.stableId })
    expect(harness.createCalls).toHaveLength(1)
  })

  it('serializes concurrent candidate creation for the same stable ID with the file lock', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, reviewedFoundation())
    const lockRoot = await mkdtemp(join(tmpdir(), 'director-brain-create-lock-'))
    harness.context.catalogPath = join(lockRoot, 'catalog.json')
    delete (harness.options.dependencies as unknown as Record<string, unknown>).withStableCreateLock
    const create = harness.options.dependencies.create
    harness.options.dependencies.create = async (input: Parameters<typeof create>[0]) => {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
      return create(input)
    }
    const request = {
      action: 'propose',
      table: 'director_intents',
      workId: 'WORK-ICE-001',
      fields: completeIntentFields({ '意图名称': '并发候选只创建一次' }),
    }

    try {
      const results = await Promise.all([
        directorBrain.executeDirectorBrainOperation(structuredClone(request), harness.options),
        directorBrain.executeDirectorBrainOperation(structuredClone(request), harness.options),
      ])
      expect(results.map(result => result.outcome).sort()).toEqual(['created', 'unchanged'])
      expect(harness.createCalls).toHaveLength(1)
      const stableId = results[0].stableId
      expect((harness.records.get('director_intents') || []).filter(record => (
        (record.fields as Record<string, unknown>)['意图版本 ID'] === stableId
      ))).toHaveLength(1)
    } finally {
      await rm(lockRoot, { recursive: true, force: true })
    }
  })

  it('claims an expired lease without an ABA delete and still creates only once', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, reviewedFoundation())
    const root = await mkdtemp(join(tmpdir(), 'director-brain-expired-lock-'))
    const request = {
      action: 'propose', table: 'director_intents', workId: 'WORK-ICE-001',
      fields: completeIntentFields({ '意图名称': '过期租约并发候选' }),
    }
    const seed = await directorBrain.executeDirectorBrainOperation(
      structuredClone(request), harness.options,
    )
    const stableId = String(seed.stableId)
    const intents = harness.records.get('director_intents') || []
    intents.splice(intents.findIndex(record => (
      (record.fields as Record<string, unknown>)['意图版本 ID'] === stableId
    )), 1)
    harness.createCalls.length = 0
    harness.context.catalogPath = join(root, 'catalog.json')
    delete (harness.options.dependencies as unknown as Record<string, unknown>).withStableCreateLock
    const lockDir = stableCreateLockPath(root, schema.projectId, 'director_intents', stableId)
    const lockRoot = dirname(lockDir)
    const token = '11111111-1111-4111-8111-111111111111'
    const createdAt = Date.now() - 20 * 60_000
    await mkdir(lockDir, { recursive: true, mode: 0o700 })
    await writeFile(join(lockDir, `owner.${token}.json`), JSON.stringify({
      pid: process.pid,
      token,
      createdAt,
      leaseUntil: createdAt + 10 * 60_000,
      scope: 'same-catalog-single-deployment',
    }), { mode: 0o600 })

    try {
      const results = await Promise.all([
        directorBrain.executeDirectorBrainOperation(structuredClone(request), harness.options),
        directorBrain.executeDirectorBrainOperation(structuredClone(request), harness.options),
      ])
      expect(results.map(result => result.outcome).sort()).toEqual(['created', 'unchanged'])
      expect(harness.createCalls).toHaveLength(1)
      expect(await readdir(lockRoot)).toEqual([])
      expect((await stat(lockRoot)).mode & 0o777).toBe(0o700)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each(['release', 'expired'])(
    'waits while another owner is processing a legitimate %s claim',
    async (kind) => {
      const directorBrain = await loadModule()
      const schema = await directorBrain.loadDirectorBrainSchema()
      const harness = operationHarness(schema, reviewedFoundation())
      const root = await mkdtemp(join(tmpdir(), `director-brain-${kind}-claim-`))
      const request = {
        action: 'propose', table: 'director_intents', workId: 'WORK-ICE-001',
        fields: completeIntentFields({ '意图名称': `${kind} claim 并发观察` }),
      }
      const seed = await directorBrain.executeDirectorBrainOperation(
        structuredClone(request), harness.options,
      )
      const stableId = String(seed.stableId)
      const intents = harness.records.get('director_intents') || []
      intents.splice(intents.findIndex(record => (
        (record.fields as Record<string, unknown>)['意图版本 ID'] === stableId
      )), 1)
      harness.createCalls.length = 0
      harness.context.catalogPath = join(root, 'catalog.json')
      delete (harness.options.dependencies as unknown as Record<string, unknown>).withStableCreateLock
      const lockDir = stableCreateLockPath(root, schema.projectId, 'director_intents', stableId)
      const token = kind === 'release'
        ? '33333333-3333-4333-8333-333333333333'
        : '44444444-4444-4444-8444-444444444444'
      const createdAt = kind === 'release' ? Date.now() : Date.now() - 20 * 60_000
      const claimPath = join(lockDir, `.${kind}.${token}.json`)
      await mkdir(lockDir, { recursive: true, mode: 0o700 })
      await writeFile(claimPath, JSON.stringify({
        token,
        createdAt,
        leaseUntil: createdAt + 10 * 60_000,
        scope: 'same-catalog-single-deployment',
      }), { mode: 0o600 })

      try {
        const attempt = directorBrain.executeDirectorBrainOperation(
          structuredClone(request), harness.options,
        )
        await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
        await rm(claimPath)
        await rmdir(lockDir)
        await expect(attempt).resolves.toMatchObject({ outcome: 'created', stableId })
        expect(harness.createCalls).toHaveLength(1)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('fails closed on an aged damaged owner instead of deleting an unknown lock', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, reviewedFoundation())
    const root = await mkdtemp(join(tmpdir(), 'director-brain-damaged-lock-'))
    const request = {
      action: 'propose', table: 'director_intents', workId: 'WORK-ICE-001',
      fields: completeIntentFields({ '意图名称': '损坏锁候选' }),
    }
    const seed = await directorBrain.executeDirectorBrainOperation(
      structuredClone(request), harness.options,
    )
    const stableId = String(seed.stableId)
    const intents = harness.records.get('director_intents') || []
    intents.splice(intents.findIndex(record => (
      (record.fields as Record<string, unknown>)['意图版本 ID'] === stableId
    )), 1)
    harness.createCalls.length = 0
    harness.context.catalogPath = join(root, 'catalog.json')
    delete (harness.options.dependencies as unknown as Record<string, unknown>).withStableCreateLock
    const lockDir = stableCreateLockPath(root, schema.projectId, 'director_intents', stableId)
    const token = '22222222-2222-4222-8222-222222222222'
    await mkdir(lockDir, { recursive: true, mode: 0o700 })
    const ownerPath = join(lockDir, `owner.${token}.json`)
    await writeFile(ownerPath, '{damaged', { mode: 0o600 })
    const past = new Date(Date.now() - 60_000)
    await utimes(lockDir, past, past)

    try {
      await expect(directorBrain.executeDirectorBrainOperation(
        structuredClone(request), harness.options,
      )).rejects.toThrow('stable_record_create_lock_manual_repair_required:owner_invalid')
      expect(await readFile(ownerPath, 'utf8')).toBe('{damaged')
      expect(harness.createCalls).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a symlinked create-lock root before entering the create section', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, reviewedFoundation())
    const root = await mkdtemp(join(tmpdir(), 'director-brain-symlink-lock-'))
    const target = join(root, 'redirected-locks')
    await mkdir(target, { mode: 0o700 })
    await symlink(target, join(root, '.director-brain-create-locks'))
    harness.context.catalogPath = join(root, 'catalog.json')
    delete (harness.options.dependencies as unknown as Record<string, unknown>).withStableCreateLock

    try {
      await expect(directorBrain.executeDirectorBrainOperation({
        action: 'propose', table: 'director_intents', workId: 'WORK-ICE-001',
        fields: completeIntentFields({ '意图名称': '拒绝符号链接锁根' }),
      }, harness.options)).rejects.toThrow('stable_record_create_lock_symlink_forbidden')
      expect(harness.createCalls).toHaveLength(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('never updates an existing record and fails closed on a stable-ID content mismatch', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, reviewedFoundation())
    const originalFind = harness.options.dependencies.findExact
    harness.options.dependencies.findExact = async (params: Parameters<typeof originalFind>[0]) => {
      const found = await originalFind(params)
      if (found.length) return found
      return [{
        record_id: 'rec_collision',
        fields: {
          '意图名称': '不同内容',
          '意图版本 ID': params.stableId,
          '核心主题': '这不是请求中的候选内容',
        },
      }]
    }

    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose',
      table: 'director_intents',
      workId: 'WORK-ICE-001',
      fields: completeIntentFields({
        '意图名称': '原始内容',
        '核心主题': '请求中的候选内容',
      }),
    }, harness.options)).rejects.toThrow('stable_record_id_hash_collision')
    expect(harness.createCalls).toHaveLength(0)
  })

  it('keeps system blueprints and material evidence projection-only and blocks owned fields', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema)

    for (const table of [
      'system_blueprint',
      'material_evidence',
    ]) {
      await expect(directorBrain.executeDirectorBrainOperation({
        action: 'propose', table, fields: { 任意: '值' },
      }, harness.options)).rejects.toThrow('operation_table_not_proposable')
    }
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose',
      table: 'director_intents',
      workId: 'WORK-ICE-001',
      fields: completeIntentFields({ '意图名称': '候选意图', '人工结论': '接受' }),
    }, harness.options)).rejects.toThrow('human_confirmation_field_forbidden')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose',
      table: 'director_intents',
      workId: 'WORK-ICE-001',
      fields: completeIntentFields({ '意图名称': '候选意图', '剪辑方案 ID': 'plan-1' }),
    }, harness.options)).rejects.toThrow('editing_field_forbidden')

    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose',
      table: 'director_intents',
      workId: 'WORK-ICE-001',
      fields: completeIntentFields({
        '意图名称': '候选意图',
        '生效时间': '2026-08-30T12:00:00+08:00',
      }),
    }, harness.options)).rejects.toThrow('human_confirmation_field_forbidden')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose',
      table: 'director_intents',
      workId: 'WORK-ICE-001',
      fields: completeIntentFields({
        '意图名称': '候选意图',
        '意图版本 ID': 'caller-controlled-id',
      }),
    }, harness.options)).rejects.toThrow('caller_stable_id_forbidden')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose',
      table: 'director_intents',
      workId: 'WORK-ICE-001',
      fields: completeIntentFields({ '意图名称': '候选意图', '来源': 'caller-controlled-source' }),
    }, harness.options)).rejects.toThrow('service_owned_field_forbidden')

    const intent = await directorBrain.executeDirectorBrainOperation({
      action: 'propose',
      table: 'director_intents',
      workId: 'WORK-ICE-001',
      fields: completeIntentFields({ '意图名称': '风暴意图', '核心主题': '人与自然的边界' }),
    }, harness.options)
    expect(intent).toMatchObject({
      record: { fields: { '状态': '草稿' } },
    })
  })

  it('creates idempotent candidates for every director domain with reviewed references', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, reviewedFoundation())
    const proposals = [
      {
        table: 'people_profiles',
        fields: {
          '人物名称': '向导阿明', '人物 ID': 'PERSON-AMING',
          '身份': '冰原向导', '目标': '带领队伍安全穿越', '置信度': 0.91,
        },
        references: { evidenceIds: ['EVIDENCE-REVIEWED-001'] },
        stateField: '状态',
        state: '候选',
      },
      {
        table: 'story_nodes',
        fields: {
          '节点名称': '选择绕行', '节点类型': '转折',
          '节点内容': '发现裂缝后放弃原路线', '置信度': 0.9,
        },
        references: { evidenceIds: ['EVIDENCE-REVIEWED-001'] },
        stateField: '状态',
        state: '候选',
      },
      {
        table: 'story_relations',
        fields: {
          '关系名称': '发现推动绕行', '关系类型': '因果',
          '判断理由': '裂缝直接导致路线改变', '置信度': 0.88,
        },
        references: {
          sourceNodeId: 'STORY-REVIEWED-001',
          targetNodeId: 'STORY-REVIEWED-002',
          evidenceIds: ['EVIDENCE-REVIEWED-001'],
        },
        stateField: '状态',
        state: '候选',
      },
      {
        table: 'material_judgments',
        fields: {
          '判断名称': '裂缝停顿的七维价值',
          '故事价值': 92, '人物价值': 86, '情绪价值': 89, '信息价值': 78,
          '视觉价值': 83, '稀缺性': 76, '叙事价值': 94,
          '使用理由': '同时形成风险信息、人物选择和叙事转折', '置信度': 0.93,
        },
        references: {
          intentVersionId: 'INTENT-REVIEWED-001',
          evidenceIds: ['EVIDENCE-REVIEWED-001'],
        },
        stateField: '状态',
        state: '候选',
      },
      {
        table: 'narrative_plans',
        fields: {
          '方案名称': '裂缝与互助段落', '人物线': '向导从独自判断转为共同决策',
          '事件线': '发现裂缝并绕行', '时间线': '发现、停顿、商议、绕行',
          '地点线': '冰原裂缝区域', '情绪线': '平静、紧张、缓和',
          '主题线': '困境中的互助', '冲突线': '速度与安全的冲突',
          '结构说明': '以裂缝作为转折连接人物与主题',
          '故事脚本': '向导先停下，其他人随后围拢，最终共同选择绕行。',
        },
        references: {
          intentVersionId: 'INTENT-REVIEWED-001',
          nodeIds: ['STORY-REVIEWED-001', 'STORY-REVIEWED-002'],
          evidenceIds: ['EVIDENCE-REVIEWED-001'],
        },
        stateField: '状态',
        state: '草稿',
      },
      {
        table: 'director_cases',
        fields: {
          '案例名称': '保留危险前停顿', '上下文': '人物刚发现裂缝，团队尚未作出决定',
          '导演动作': '采用', '判断原因': '停顿把外部风险转化为人物选择',
        },
        references: {
          judgmentId: 'JUDGMENT-REVIEWED-001',
          evidenceIds: ['EVIDENCE-REVIEWED-001'],
        },
        stateField: '复核状态',
        state: '待复核',
      },
      {
        table: 'skills_techniques',
        fields: {
          '知识名称': '在决定前保留停顿', '知识类型': '技法', '知识分类': '人物选择',
          '适用条件': '人物即将作出影响故事方向的决定',
          '执行方法': '保留动作停止、观察和他人靠近的连续信息',
          '为什么有效': '让观众先感受压力，再理解决定', '置信度': 0.84,
        },
        references: { caseIds: ['CASE-REVIEWED-001'] },
        stateField: '状态',
        state: '候选',
      },
    ]

    for (const proposal of proposals) {
      const first = await directorBrain.executeDirectorBrainOperation({
        action: 'propose',
        table: proposal.table,
        workId: 'WORK-ICE-001',
        fields: proposal.fields,
        references: proposal.references,
      }, harness.options)
      const replay = await directorBrain.executeDirectorBrainOperation({
        action: 'propose',
        table: proposal.table,
        workId: 'WORK-ICE-001',
        fields: proposal.fields,
        references: proposal.references,
      }, harness.options)
      expect(first).toMatchObject({
        outcome: 'created',
        stableId: expect.stringMatching(/^DB-[A-Z-]+-[a-f0-9]{64}$/u),
        record: { fields: { [proposal.stateField]: proposal.state } },
      })
      expect(replay).toMatchObject({ outcome: 'unchanged', stableId: first.stableId })
    }
    expect(harness.createCalls).toHaveLength(proposals.length)
  })

  it('assembles only a complete reviewed context and validates its reference graph', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    const harness = operationHarness(schema, {
      ...foundation,
      people_profiles: [{
        record_id: 'rec_people_reviewed',
        fields: {
          '人物名称': '向导阿明', '人物版本 ID': 'PEOPLE-REVIEWED-001',
          '人物 ID': 'PERSON-AMING',
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
          '证据 ID': 'EVIDENCE-REVIEWED-001',
          '置信度': 0.91,
          '状态': '已确认',
          ...reviewedMetadata(),
        },
      }],
      story_relations: [{
        record_id: 'rec_relation_reviewed',
        fields: {
          '关系名称': '裂缝导致绕行', '关系 ID': 'RELATION-REVIEWED-001',
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
          '源节点 ID': 'STORY-REVIEWED-001',
          '目标节点 ID': 'STORY-REVIEWED-002', '证据 ID': 'EVIDENCE-REVIEWED-001',
          '关系类型': '因果', '判断理由': '发现裂缝直接触发共同绕行', '置信度': 0.9,
          '状态': '已确认',
          ...reviewedMetadata(),
        },
      }],
      narrative_plans: [{
        record_id: 'rec_plan_reviewed',
        fields: {
          '方案名称': '裂缝叙事方案', '方案 ID': 'PLAN-REVIEWED-001',
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
          '意图版本 ID': 'INTENT-REVIEWED-001',
          '节点 ID': 'STORY-REVIEWED-001\nSTORY-REVIEWED-002',
          '证据 ID': 'EVIDENCE-REVIEWED-001',
          '人物线': '向导从独自判断到协同决策',
          '事件线': '发现裂缝后共同绕行',
          '时间线': '发现、停顿、协商、绕行',
          '地点线': '冰面裂缝前后',
          '情绪线': '平静转为紧张再缓和',
          '主题线': '面对风险时共同作出选择',
          '冲突线': '继续前进与安全绕行的冲突',
          '结构说明': '用裂缝事件串联人物选择',
          '故事脚本': '人物发现裂缝后停下，并与同伴共同选择绕行。',
          '状态': '已批准',
          ...reviewedMetadata(),
        },
      }],
      skills_techniques: [{
        record_id: 'rec_skill_reviewed',
        fields: {
          '知识名称': '决定前停顿', '知识 ID': 'SKILL-REVIEWED-001',
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
          '案例 ID': 'CASE-REVIEWED-001',
          '知识类型': '技法', '知识分类': '人物决策',
          '适用条件': '人物面对风险并需要作出选择',
          '执行方法': '保留动作前的观察和停顿',
          '为什么有效': '让观众读懂人物判断过程',
          '置信度': 0.9,
          '状态': '已验证',
          ...reviewedMetadata(),
        },
      }],
    })
    const references = {
      intentVersionId: 'INTENT-REVIEWED-001',
      evidenceIds: ['EVIDENCE-REVIEWED-001'],
      peopleProfileIds: ['PEOPLE-REVIEWED-001'],
      storyNodeIds: ['STORY-REVIEWED-001', 'STORY-REVIEWED-002'],
      storyRelationIds: ['RELATION-REVIEWED-001'],
      materialJudgmentIds: ['JUDGMENT-REVIEWED-001'],
      narrativePlanIds: ['PLAN-REVIEWED-001'],
      directorCaseIds: ['CASE-REVIEWED-001'],
      skillTechniqueIds: ['SKILL-REVIEWED-001'],
    }

    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'assemble', workId: 'WORK-ICE-001', references,
    }, harness.options)
    expect(result).toMatchObject({
      ok: true,
      action: 'assemble',
      intentVersionId: 'INTENT-REVIEWED-001',
      evidenceCount: 1,
      context: {
        directorIntent: { stableId: 'INTENT-REVIEWED-001', reviewed: true },
        materialEvidence: [{ stableId: 'EVIDENCE-REVIEWED-001', reviewed: true }],
        narrativePlans: [{ fields: { '故事脚本': '人物发现裂缝后停下，并与同伴共同选择绕行。' } }],
      },
    })
    expect(JSON.stringify(result)).not.toMatch(/"record_id"|"appToken"|"tableId"|catalogPath/u)

    const incomplete = { ...references, storyNodeIds: ['STORY-REVIEWED-001'] }
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'assemble', workId: 'WORK-ICE-001', references: incomplete,
    }, harness.options)).rejects.toThrow('assembly_reference_incomplete')
  })

  it('rejects unreviewed or malformed evidence, caller-owned references, and invalid scores', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    const unsafeEvidence = structuredClone(foundation.material_evidence[0])
    unsafeEvidence.fields['证据 ID'] = 'EVIDENCE-UNSAFE-001'
    unsafeEvidence.fields['结束时间码'] = '00:00:09.000'
    const draftEvidence = structuredClone(foundation.material_evidence[0])
    draftEvidence.fields['证据 ID'] = 'EVIDENCE-DRAFT-001'
    draftEvidence.fields['状态'] = '候选'
    const harness = operationHarness(schema, {
      ...foundation,
      material_evidence: [...foundation.material_evidence, unsafeEvidence, draftEvidence],
    })
    const personFields = {
      '人物名称': '向导阿明', '人物 ID': 'PERSON-AMING',
      '身份': '冰原向导', '置信度': 0.91,
    }

    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose', table: 'people_profiles', workId: 'WORK-ICE-001', fields: personFields,
      references: { evidenceIds: ['EVIDENCE-UNSAFE-001'] },
    }, harness.options)).rejects.toThrow('evidence_timecode_range_invalid')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose', table: 'people_profiles', workId: 'WORK-ICE-001', fields: personFields,
      references: { evidenceIds: ['EVIDENCE-DRAFT-001'] },
    }, harness.options)).rejects.toThrow('reference_record_not_reviewed')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose', table: 'people_profiles',
      workId: 'WORK-ICE-001',
      fields: { ...personFields, '证据 ID': 'EVIDENCE-REVIEWED-001' },
      references: { evidenceIds: ['EVIDENCE-REVIEWED-001'] },
    }, harness.options)).rejects.toThrow('reference_field_service_owned')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose', table: 'material_judgments',
      workId: 'WORK-ICE-001',
      fields: {
        '判断名称': '越界分值', '故事价值': 101, '人物价值': 80, '情绪价值': 80,
        '信息价值': 80, '视觉价值': 80, '稀缺性': 80, '叙事价值': 80,
        '使用理由': '测试范围', '置信度': 0.9,
      },
      references: {
        intentVersionId: 'INTENT-REVIEWED-001',
        evidenceIds: ['EVIDENCE-REVIEWED-001'],
      },
    }, harness.options)).rejects.toThrow('record_number_out_of_range:故事价值')
  })

  it('strictly validates types, select values, secrets, media, paths, transcripts, and task state', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema)
    const propose = (overrides: Record<string, unknown>) => directorBrain.executeDirectorBrainOperation({
      action: 'propose', table: 'director_intents', workId: 'WORK-ICE-001',
      fields: completeIntentFields(overrides),
    }, harness.options)

    await expect(propose({ '意图名称': '错误类型', '核心主题': 0.8 }))
      .rejects.toThrow('record_field_type_invalid:核心主题')
    await expect(propose({ '意图名称': '路径', '核心主题': '/Users/example/raw/video.mp4' }))
      .rejects.toThrow('absolute_path_forbidden')
    await expect(propose({ '意图名称': '媒体', '核心主题': 'https://example.com/raw/video.mp4' }))
      .rejects.toThrow('media_url_forbidden')
    await expect(propose({ '意图名称': '内嵌', '核心主题': 'data:video/mp4;base64,AAAA' }))
      .rejects.toThrow('embedded_resource_forbidden')
    await expect(propose({ '意图名称': '转写', '核心主题': '这里保存完整原始转写' }))
      .rejects.toThrow('full_transcript_forbidden')
    await expect(propose({ '意图名称': '内嵌块', '核心主题': 'A'.repeat(200) }))
      .rejects.toThrow('base64_blob_forbidden')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose',
      table: 'director_intents',
      workId: 'WORK-ICE-001',
      fields: completeIntentFields({ '意图名称': '敏感', '核心主题': { token: 'hidden' } }),
    }, harness.options)).rejects.toThrow('sensitive_key_forbidden')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose',
      table: 'director_intents',
      workId: 'WORK-ICE-001',
      taskStatus: 'running',
      fields: completeIntentFields({ '意图名称': '状态' }),
    }, harness.options)).rejects.toThrow('task_state_forbidden')

    const invalidSelectSchema = structuredClone(schema)
    const intentTable = invalidSelectSchema.tables.find(table => table.key === 'director_intents')
    const statusField = intentTable?.fields.find(field => field.name === '状态')
    if (!statusField?.options) throw new Error('test_fixture_status_options_missing')
    statusField.options = statusField.options.filter(option => option !== '草稿')
    const invalidSelectHarness = operationHarness(invalidSelectSchema)
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose',
      table: 'director_intents',
      workId: 'WORK-ICE-001',
      fields: completeIntentFields({ '意图名称': '状态选项保护' }),
    }, invalidSelectHarness.options)).rejects.toThrow('record_select_value_invalid:状态')
  })

  it('accepts exactly one operate request from stdin and rejects operation argv payloads', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema)

    await expect(directorBrain.runDirectorBrainCli(['operate'], {
      ...harness.options,
      stdin: '{"action":"health"}\n',
    })).resolves.toMatchObject({ ok: true, action: 'health' })
    expect(() => directorBrain.parseDirectorBrainArgs(['operate', '--table', 'story_nodes']))
      .toThrow('operate_accepts_stdin_only')
    await expect(directorBrain.runDirectorBrainCli(['operate'], {
      ...harness.options,
      stdin: '{"action":"health"}\n{"action":"health"}',
    })).rejects.toThrow('operate_stdin_invalid_json')
  })

  it('reads operate input from the real process stdin on Node 22', () => {
    const entry = resolve(process.cwd(), 'scripts/feishu-director-brain.mjs')
    const result = spawnSync(process.execPath, [entry, 'operate'], {
      encoding: 'utf8',
      input: '{not-json}',
    })

    expect(result.status).toBe(1)
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: 'operate_stdin_invalid_json',
    })
    expect(result.stderr).not.toContain('path')
  })

  it('stops streaming stdin as soon as each command byte limit is exceeded', async () => {
    const entry = resolve(process.cwd(), 'scripts/feishu-director-brain.mjs')
    const runOversized = async (command: string, bytes: number, expectedError: string) => {
      const child = spawn(process.execPath, [entry, command], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stderr = ''
      child.stdout.resume()
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { stderr += chunk })
      child.stdin.on('error', () => {})
      const exited = new Promise<number | null>((resolveExit, rejectExit) => {
        child.once('error', rejectExit)
        child.once('exit', code => resolveExit(code))
      })
      child.stdin.write(Buffer.alloc(bytes, 0x78))
      let timeout: ReturnType<typeof setTimeout> | null = null
      try {
        const code = await Promise.race([
          exited,
          new Promise<never>((_, rejectTimeout) => {
            timeout = setTimeout(() => rejectTimeout(new Error('stdin_limit_exit_timeout')), 3_000)
          }),
        ])
        expect(code).toBe(1)
        expect(JSON.parse(stderr)).toEqual({ ok: false, error: expectedError })
      } finally {
        if (timeout) clearTimeout(timeout)
        child.stdin.destroy()
        if (child.exitCode === null) child.kill('SIGKILL')
      }
    }

    await runOversized('operate', 32 * 1024 + 1, 'operate_stdin_too_large')
    await runOversized('project-evidence', 256 * 1024 + 1, 'project_evidence_stdin_too_large')
  })

  it('rejects unsafe health, get, and search inputs before opening any external connection', async () => {
    const directorBrain = await loadModule()
    const connect = vi.fn(async () => {
      throw new Error('external_connection_must_not_run')
    })
    const options = { dependencies: { connect } }

    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'health', token: 'must-not-connect',
    }, options)).rejects.toThrow('operation_field_unexpected')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'get', table: 'story_nodes', workId: 'WORK-ICE-001',
      stableId: '/Users/example/private-id',
    }, options)).rejects.toThrow('absolute_path_forbidden')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'search', table: 'all', workId: 'WORK-ICE-001',
      query: '/Users/example/video.mp4', limit: 10,
    }, options)).rejects.toThrow('absolute_path_forbidden')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'search', table: 'all', query: '超大请求', padding: 'x'.repeat(33 * 1024),
    }, options)).rejects.toThrow('operation_request_too_large')
    for (const stableId of [
      'cli_FakeApp123456',
      'bascnFakeAppToken123456',
      'tblFakeTable12345',
      'recFakeRecord12345',
      'fldFakeField12345',
    ]) {
      await expect(directorBrain.executeDirectorBrainOperation({
        action: 'get', table: 'story_nodes', workId: 'WORK-ICE-001', stableId,
      }, options)).rejects.toThrow('feishu_resource_id_forbidden')
    }
    expect(connect).not.toHaveBeenCalled()
  })

  it('fails closed instead of returning a remote record containing a full transcript marker', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, {
      people_profiles: [{
        record_id: 'rec_unsafe_transcript',
        fields: {
          '人物名称': '不安全远端记录',
          '人物版本 ID': 'unsafe-transcript',
          '身份': '这里包含完整原始转写，不得返回给调用方',
          '状态': '已确认',
        },
      }],
    })

    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'get', table: 'people_profiles', workId: 'WORK-ICE-001',
      stableId: 'unsafe-transcript',
    }, harness.options)).rejects.toThrow('full_transcript_forbidden')
  })

  it('rejects HTTP URLs in requests and remote output without rejecting ordinary HTTP text', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const unsafeStory = structuredClone(reviewedFoundation().story_nodes[0])
    unsafeStory.fields['节点 ID'] = 'STORY-UNSAFE-FEISHU-URL'
    unsafeStory.fields['节点内容'] = '外部资源 https://open.feishu.cn/base/private-resource'
    const harness = operationHarness(schema, {
      ...reviewedFoundation(),
      story_nodes: [unsafeStory],
    })

    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'get', table: 'story_nodes', workId: 'WORK-ICE-001',
      stableId: 'STORY-UNSAFE-FEISHU-URL',
    }, harness.options)).rejects.toThrow('http_url_forbidden')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'search', table: 'all', workId: 'WORK-ICE-001',
      query: 'https://example.com/private', limit: 5,
    }, harness.options)).rejects.toThrow('http_url_forbidden')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'search', table: 'all', workId: 'WORK-ICE-001',
      query: 'HTTP 协议说明', limit: 5,
    }, harness.options)).resolves.toMatchObject({ ok: true, count: 0 })
  })

  it('rejects Feishu internal resource IDs in remote text without blocking domain IDs', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const unsafeStory = structuredClone(reviewedFoundation().story_nodes[0])
    unsafeStory.fields['节点 ID'] = 'STORY-INTERNAL-ID-001'
    unsafeStory.fields['节点内容'] = '内部字段标识 fldFakeField12345 不得外泄'
    const harness = operationHarness(schema, {
      ...reviewedFoundation(), story_nodes: [unsafeStory],
    })

    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'get', table: 'story_nodes', workId: 'WORK-ICE-001',
      stableId: 'STORY-INTERNAL-ID-001',
    }, harness.options)).rejects.toThrow('feishu_resource_id_forbidden')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'get', table: 'works', stableId: 'WORK-ICE-001',
    }, harness.options)).resolves.toMatchObject({ record: { stableId: 'WORK-ICE-001' } })

    const internalStableIdHarness = operationHarness(schema, {
      ...reviewedFoundation(),
      story_nodes: [{
        record_id: 'rec_remote_internal_stable_id_fixture',
        fields: {
          '节点名称': '远端内部稳定标识', '节点 ID': 'recFakeRecord12345',
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
          '节点内容': '这是明显虚构的内部标识测试记录', '状态': '候选',
        },
      }],
    })
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'search', table: 'story_nodes', workId: 'WORK-ICE-001',
      query: '远端内部稳定标识', status: '候选', limit: 5,
    }, internalStableIdHarness.options)).rejects.toThrow('feishu_resource_id_forbidden')
  })

  it('allows a reviewed governance record to describe the full-transcript prohibition', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, {
      system_blueprint: [{
        record_id: 'rec_transcript_policy',
        fields: {
          '标题': '数据边界',
          '规范 ID': 'transcript-policy',
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
          '环境': '测试',
          '类型': '数据边界',
          '内容': '完整原始转写不得进入导演脑。',
          '状态': '生效',
          '版本': 'v0.1.0',
          '来源': 'test-fixture',
          '更新时间': REVIEWED_AT,
        },
      }],
    })

    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'search', table: 'system_blueprint', query: '数据边界', limit: 5,
    }, harness.options)
    expect(result).toMatchObject({
      count: 1,
      matches: [{ stableId: 'transcript-policy', reviewed: true }],
    })
  })
})

describe('Feishu director brain administrator review lifecycle', () => {
  it('enforces optimistic versions, legal transitions, and audit fields', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const stableId = 'INTENT-DRAFT-001'
    const harness = operationHarness(schema, {
      director_intents: [{
        record_id: 'rec_intent_draft',
        fields: {
          ...completeIntentFields(),
          '意图版本 ID': stableId,
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
          '作品 ID': 'WORK-ICE-001',
          '状态': '草稿',
          '版本': 'v0.2.0',
          '来源': 'openclaw-director-brain',
          '更新时间': Date.parse('2026-08-30T11:00:00+08:00'),
        },
      }],
    })
    const reviewed = await directorBrain.reviewDirectorBrainRecord({
      table: 'director_intents', stableId, workId: 'WORK-ICE-001',
      expectedVersion: 'v0.2.0', targetStatus: '待审核',
      reviewer: '测试导演', reason: '字段完整，进入审核。',
    }, harness.options)
    expect(reviewed).toMatchObject({
      action: 'review', previousStatus: '草稿', targetStatus: '待审核',
      previousVersion: 'v0.2.0', version: 'v0.2.1',
      record: { fields: {
        '审核人': '测试导演',
        '审核原因': '字段完整,进入审核。',
        '审核时间': Date.parse('2026-08-30T12:00:00+08:00'),
      } },
    })
    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'director_intents', stableId, workId: 'WORK-ICE-001',
      expectedVersion: 'v0.2.0', targetStatus: '生效',
      reviewer: '测试导演', reason: '使用过期版本审核。',
    }, harness.options)).rejects.toThrow('review_expected_version_mismatch')
    const active = await directorBrain.reviewDirectorBrainRecord({
      table: 'director_intents', stableId, workId: 'WORK-ICE-001',
      expectedVersion: 'v0.2.1', targetStatus: '生效',
      reviewer: '测试导演', reason: '确认作为唯一生效意图。',
    }, harness.options)
    expect(active).toMatchObject({ targetStatus: '生效', version: 'v0.2.2' })
    expect(harness.updateCalls).toHaveLength(2)
  })

  it('rechecks every ordinary review target after reference validation before updating', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    foundation.story_nodes.push({
      record_id: 'rec_story_review_cas',
      fields: {
        '节点名称': '等待审核的风险决定', '节点 ID': 'STORY-REVIEW-CAS-001',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
        '节点类型': '转折', '节点内容': '人物发现风险后决定绕行',
        '证据 ID': 'EVIDENCE-REVIEWED-001', '置信度': 0.9,
        '状态': '待审核', ...reviewedMetadata({ '版本': 'v0.2.1' }),
      },
    })
    const harness = operationHarness(schema, foundation)
    const findExact = harness.options.dependencies.findExact
    let targetReads = 0
    harness.options.dependencies.findExact = async (input: Parameters<typeof findExact>[0]) => {
      const found = await findExact(input)
      if (input.stableId === 'STORY-REVIEW-CAS-001' && ++targetReads === 2) {
        const changed = structuredClone(found)
        ;(changed[0].fields as Record<string, unknown>)['节点内容'] = '引用校验期间发生并发修改'
        return changed
      }
      return found
    }

    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'story_nodes', stableId: 'STORY-REVIEW-CAS-001', workId: 'WORK-ICE-001',
      expectedVersion: 'v0.2.1', targetStatus: '已确认',
      reviewer: '测试导演', reason: '引用完整且事实成立',
    }, harness.options)).rejects.toThrow('review_concurrent_change:STORY-REVIEW-CAS-001')
    expect(harness.updateCalls).toHaveLength(0)
  })

  it('fails closed when a non-status business field drifts in ordinary review readback', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    foundation.story_nodes.push({
      record_id: 'rec_story_review_readback_drift',
      fields: {
        '节点名称': '写后回读漂移节点', '节点 ID': 'STORY-READBACK-DRIFT-001',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
        '节点类型': '转折', '节点内容': '审核写入时保持不变的业务内容',
        '证据 ID': 'EVIDENCE-REVIEWED-001', '置信度': 0.9,
        '状态': '待审核', ...reviewedMetadata({ '版本': 'v0.2.1' }),
      },
    })
    const harness = operationHarness(schema, foundation)
    const update = harness.options.dependencies.update
    harness.options.dependencies.update = async (input: Parameters<typeof update>[0]) => {
      const record = await update(input)
      if (input.recordId === 'rec_story_review_readback_drift') {
        ;(record.fields as Record<string, unknown>)['节点内容'] = '并发写入覆盖了业务内容'
      }
      return record
    }

    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'story_nodes', stableId: 'STORY-READBACK-DRIFT-001', workId: 'WORK-ICE-001',
      expectedVersion: 'v0.2.1', targetStatus: '已确认',
      reviewer: '测试导演', reason: '写后必须核对全部规范化字段',
    }, harness.options)).rejects.toThrow('review_record_verification_failed:story_nodes')
  })

  it('atomically replaces the current active intent through the declared previous version', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    const candidateId = 'INTENT-SUCCESSOR-001'
    foundation.director_intents.push({
      record_id: 'rec_intent_successor',
      fields: {
        ...completeIntentFields({ '意图名称': '接替意图' }),
        '意图版本 ID': candidateId,
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
        '上一版本 ID': 'INTENT-REVIEWED-001',
        '状态': '待审核', ...reviewedMetadata({ '版本': 'v0.2.1' }),
      },
    })
    const harness = operationHarness(schema, foundation)
    const result = await directorBrain.reviewDirectorBrainRecord({
      table: 'director_intents', stableId: candidateId, workId: 'WORK-ICE-001',
      expectedVersion: 'v0.2.1', targetStatus: '生效',
      reviewer: '测试导演', reason: '新版意图更符合当前叙事目标',
    }, harness.options)

    expect(result).toMatchObject({
      targetStatus: '生效', version: 'v0.2.2',
      replacedIntentId: 'INTENT-REVIEWED-001',
      record: { state: '生效', fields: { '上一版本 ID': 'INTENT-REVIEWED-001' } },
    })
    const intents = harness.records.get('director_intents') || []
    const previous = intents.find(record => (
      (record.fields as Record<string, unknown>)['意图版本 ID'] === 'INTENT-REVIEWED-001'
    ))
    const successor = intents.find(record => (
      (record.fields as Record<string, unknown>)['意图版本 ID'] === candidateId
    ))
    expect(previous?.fields).toMatchObject({
      '状态': '废弃', '版本': 'v0.2.1', '审核人': '测试导演',
    })
    expect(successor?.fields).toMatchObject({ '状态': '生效', '版本': 'v0.2.2' })
    expect(intents.filter(record => (
      (record.fields as Record<string, unknown>)['状态'] === '生效'
    ))).toHaveLength(1)

    const workflow = await directorBrain.executeDirectorBrainOperation({
      action: 'workflow', workId: 'WORK-ICE-001',
    }, harness.options)
    expect((workflow.readiness as Record<string, unknown>).intent).toBe(true)
    expect(workflow.metrics).toMatchObject({ activeIntentCount: 1 })
  })

  it('requires manual repair when intent replacement readback drifts outside status and version', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    const candidateId = 'INTENT-READBACK-DRIFT-001'
    foundation.director_intents.push({
      record_id: 'rec_intent_readback_drift',
      fields: {
        ...completeIntentFields({ '意图名称': '替换回读漂移意图' }),
        '意图版本 ID': candidateId,
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
        '上一版本 ID': 'INTENT-REVIEWED-001',
        '状态': '待审核', ...reviewedMetadata({ '版本': 'v0.2.1' }),
      },
    })
    const harness = operationHarness(schema, foundation)
    const update = harness.options.dependencies.update
    harness.options.dependencies.update = async (input: Parameters<typeof update>[0]) => {
      const record = await update(input)
      if (input.recordId === 'rec_intent_reviewed' && input.fields['状态'] === '废弃') {
        ;(record.fields as Record<string, unknown>)['核心主题'] = '并发改写后的核心主题'
      }
      return record
    }

    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'director_intents', stableId: candidateId, workId: 'WORK-ICE-001',
      expectedVersion: 'v0.2.1', targetStatus: '生效',
      reviewer: '测试导演', reason: '替换写后必须核对全部规范化字段',
    }, harness.options)).rejects.toThrow(
      'director_intent_manual_repair_required:replacement_rollback_unverifiable',
    )
    expect(harness.records.get('director_intents')?.find(record => (
      record.record_id === 'rec_intent_readback_drift'
    ))?.fields).toMatchObject({ '状态': '待审核', '版本': 'v0.2.1' })
  })

  it('rejects a successor whose previous version is not the current active intent', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    foundation.director_intents.push({
      record_id: 'rec_intent_historical',
      fields: {
        ...completeIntentFields({ '意图名称': '历史意图' }),
        '意图版本 ID': 'INTENT-HISTORICAL-001',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
        '状态': '废弃',
        ...reviewedMetadata({
          '版本': 'v0.1.1',
          '审核时间': Date.parse('2026-08-28T12:00:00+08:00'),
          '审核原因': '历史版本已废弃',
        }),
      },
    }, {
      record_id: 'rec_intent_wrong_previous',
      fields: {
        ...completeIntentFields({ '意图名称': '错误承接意图' }),
        '意图版本 ID': 'INTENT-WRONG-PREVIOUS-001',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
        '上一版本 ID': 'INTENT-HISTORICAL-001',
        '状态': '待审核', ...reviewedMetadata({ '版本': 'v0.2.1' }),
      },
    })
    const harness = operationHarness(schema, foundation)
    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'director_intents', stableId: 'INTENT-WRONG-PREVIOUS-001',
      workId: 'WORK-ICE-001', expectedVersion: 'v0.2.1', targetStatus: '生效',
      reviewer: '测试导演', reason: '错误承接不应通过',
    }, harness.options)).rejects.toThrow('director_intent_previous_not_current')
    expect(harness.updateCalls).toHaveLength(0)
  })

  it('detects a concurrent intent-version change before replacement writes', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    foundation.director_intents.push({
      record_id: 'rec_intent_concurrent_successor',
      fields: {
        ...completeIntentFields({ '意图名称': '并发接替意图' }),
        '意图版本 ID': 'INTENT-CONCURRENT-001',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
        '上一版本 ID': 'INTENT-REVIEWED-001',
        '状态': '待审核', ...reviewedMetadata({ '版本': 'v0.2.1' }),
      },
    })
    const harness = operationHarness(schema, foundation)
    const findExact = harness.options.dependencies.findExact
    let previousReads = 0
    harness.options.dependencies.findExact = async (input: Parameters<typeof findExact>[0]) => {
      const found = await findExact(input)
      if (input.stableId === 'INTENT-REVIEWED-001' && ++previousReads === 2) {
        const concurrent = structuredClone(found)
        ;(concurrent[0].fields as Record<string, unknown>)['版本'] = 'v9.9.9'
        return concurrent
      }
      return found
    }
    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'director_intents', stableId: 'INTENT-CONCURRENT-001',
      workId: 'WORK-ICE-001', expectedVersion: 'v0.2.1', targetStatus: '生效',
      reviewer: '测试导演', reason: '并发版本必须停止',
    }, harness.options)).rejects.toThrow('review_concurrent_change')
    expect(harness.updateCalls).toHaveLength(0)
  })

  it('rolls the old intent back when activating the successor fails', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    foundation.director_intents.push({
      record_id: 'rec_intent_rollback_successor',
      fields: {
        ...completeIntentFields({ '意图名称': '回滚接替意图' }),
        '意图版本 ID': 'INTENT-ROLLBACK-001',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
        '上一版本 ID': 'INTENT-REVIEWED-001',
        '状态': '待审核', ...reviewedMetadata({ '版本': 'v0.2.1' }),
      },
    })
    const harness = operationHarness(schema, foundation)
    const update = harness.options.dependencies.update
    harness.options.dependencies.update = async (input: Parameters<typeof update>[0]) => {
      if (input.recordId === 'rec_intent_rollback_successor'
        && input.fields['状态'] === '生效') {
        throw new Error('synthetic_successor_activation_failure')
      }
      return update(input)
    }
    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'director_intents', stableId: 'INTENT-ROLLBACK-001',
      workId: 'WORK-ICE-001', expectedVersion: 'v0.2.1', targetStatus: '生效',
      reviewer: '测试导演', reason: '失败时必须完整回滚',
    }, harness.options)).rejects.toThrow('synthetic_successor_activation_failure')
    const intents = harness.records.get('director_intents') || []
    expect(intents.find(record => record.record_id === 'rec_intent_reviewed')?.fields)
      .toMatchObject({ '状态': '生效', '版本': 'v0.2.0' })
    expect(intents.find(record => record.record_id === 'rec_intent_rollback_successor')?.fields)
      .toMatchObject({ '状态': '待审核', '版本': 'v0.2.1' })
    expect(intents.filter(record => (
      (record.fields as Record<string, unknown>)['状态'] === '生效'
    ))).toHaveLength(1)
  })

  it('does not restore the old intent when a concurrent successor is already active', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    const candidateId = 'INTENT-ROLLBACK-CONFLICT-001'
    foundation.director_intents.push({
      record_id: 'rec_intent_rollback_conflict',
      fields: {
        ...completeIntentFields({ '意图名称': '触发回滚冲突的意图' }),
        '意图版本 ID': candidateId,
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
        '上一版本 ID': 'INTENT-REVIEWED-001',
        '状态': '待审核', ...reviewedMetadata({ '版本': 'v0.2.1' }),
      },
    })
    const harness = operationHarness(schema, foundation)
    const update = harness.options.dependencies.update
    harness.options.dependencies.update = async (input: Parameters<typeof update>[0]) => {
      if (input.recordId === 'rec_intent_rollback_conflict'
        && input.fields['状态'] === '生效') {
        harness.records.get('director_intents')?.push({
          record_id: 'rec_intent_concurrent_winner',
          fields: {
            ...completeIntentFields({ '意图名称': '并发生效的其他意图' }),
            '意图版本 ID': 'INTENT-CONCURRENT-WINNER-001',
            '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
            '上一版本 ID': 'INTENT-REVIEWED-001',
            '状态': '生效', ...reviewedMetadata({ '版本': 'v0.2.2' }),
          },
        })
        throw new Error('synthetic_successor_activation_failure')
      }
      return update(input)
    }

    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'director_intents', stableId: candidateId, workId: 'WORK-ICE-001',
      expectedVersion: 'v0.2.1', targetStatus: '生效',
      reviewer: '测试导演', reason: '模拟激活期间出现其他生效版本',
    }, harness.options)).rejects.toThrow('synthetic_successor_activation_failure')

    const intents = harness.records.get('director_intents') || []
    expect(intents.find(record => record.record_id === 'rec_intent_reviewed')?.fields)
      .toMatchObject({ '状态': '废弃', '版本': 'v0.2.1' })
    expect(intents.find(record => record.record_id === 'rec_intent_concurrent_winner')?.fields)
      .toMatchObject({ '状态': '生效', '版本': 'v0.2.2' })
    expect(intents.filter(record => (
      (record.fields as Record<string, unknown>)['状态'] === '生效'
    ))).toHaveLength(1)
  })

  it('converges interleaved successor activations to the same stable-ID winner', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    const candidateIds = ['INTENT-CONCURRENT-A-001', 'INTENT-CONCURRENT-B-001']
    for (const [index, candidateId] of candidateIds.entries()) {
      foundation.director_intents.push({
        record_id: `rec_intent_interleaved_${index + 1}`,
        fields: {
          ...completeIntentFields({ '意图名称': `交错并发意图 ${index + 1}` }),
          '意图版本 ID': candidateId,
          '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
          '上一版本 ID': 'INTENT-REVIEWED-001',
          '状态': '待审核', ...reviewedMetadata({ '版本': 'v0.2.1' }),
        },
      })
    }
    const harness = operationHarness(schema, foundation)
    const update = harness.options.dependencies.update
    harness.options.dependencies.update = async (input: Parameters<typeof update>[0]) => {
      const result = await update(input)
      if (input.recordId === 'rec_intent_interleaved_1' && input.fields['状态'] === '生效') {
        const competitor = (harness.records.get('director_intents') || []).find(record => (
          record.record_id === 'rec_intent_interleaved_2'
        ))
        if (competitor) {
          competitor.fields = {
            ...(competitor.fields as Record<string, unknown>),
            '状态': '生效',
            '版本': 'v0.2.2',
          }
        }
      }
      return result
    }

    const result = await directorBrain.reviewDirectorBrainRecord({
      table: 'director_intents', stableId: candidateIds[0], workId: 'WORK-ICE-001',
      expectedVersion: 'v0.2.1', targetStatus: '生效',
      reviewer: '测试导演', reason: '模拟写后复读前另一个后继并发生效',
    }, harness.options)

    expect(result).toMatchObject({ stableId: candidateIds[0], targetStatus: '生效' })
    const intents = harness.records.get('director_intents') || []
    expect(intents.filter(record => (
      (record.fields as Record<string, unknown>)['状态'] === '生效'
    )).map(record => (
      (record.fields as Record<string, unknown>)['意图版本 ID']
    ))).toEqual([candidateIds[0]])
    expect(intents.find(record => (
      (record.fields as Record<string, unknown>)['意图版本 ID'] === candidateIds[1]
    ))?.fields).toMatchObject({ '状态': '废弃', '版本': 'v0.2.3' })
  })

  it('requires manual repair when duplicate active intents cannot be retired and verified', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    const candidateId = 'INTENT-UNCONVERGED-Z-001'
    foundation.director_intents.push({
      record_id: 'rec_intent_unconverged_target',
      fields: {
        ...completeIntentFields({ '意图名称': '无法收敛的目标意图' }),
        '意图版本 ID': candidateId,
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
        '上一版本 ID': 'INTENT-REVIEWED-001',
        '状态': '待审核', ...reviewedMetadata({ '版本': 'v0.2.1' }),
      },
    })
    const harness = operationHarness(schema, foundation)
    const findByWork = harness.options.dependencies.findByWork
    let findByWorkCalls = 0
    harness.options.dependencies.findByWork = async (input: Parameters<typeof findByWork>[0]) => {
      findByWorkCalls += 1
      if (findByWorkCalls === 3) {
        harness.records.get('director_intents')?.push({
          record_id: 'rec_intent_unconverged_competitor',
          fields: {
            ...completeIntentFields({ '意图名称': '无法收敛的竞争意图' }),
            '意图版本 ID': 'INTENT-UNCONVERGED-A-001',
            '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
            '上一版本 ID': 'INTENT-REVIEWED-001',
            '状态': '生效', ...reviewedMetadata({ '版本': 'v0.2.2' }),
          },
        })
      }
      return findByWork(input)
    }
    const update = harness.options.dependencies.update
    harness.options.dependencies.update = async (input: Parameters<typeof update>[0]) => {
      if (input.recordId === 'rec_intent_unconverged_target'
        && input.fields['状态'] === '废弃') {
        const unchanged = (harness.records.get('director_intents') || []).find(record => (
          record.record_id === input.recordId
        ))
        if (!unchanged) throw new Error('synthetic_target_missing')
        return unchanged
      }
      return update(input)
    }

    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'director_intents', stableId: candidateId, workId: 'WORK-ICE-001',
      expectedVersion: 'v0.2.1', targetStatus: '生效',
      reviewer: '测试导演', reason: '模拟飞书更新无法消除重复生效记录',
    }, harness.options)).rejects.toThrow(
      'director_intent_manual_repair_required:loser_write_drift:'
      + 'INTENT-UNCONVERGED-A-001,INTENT-UNCONVERGED-Z-001',
    )
  })

  it('rejects illegal transitions and a second active intent for the same work', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const candidate = {
      record_id: 'rec_intent_candidate',
      fields: {
        ...completeIntentFields({ '意图名称': '候选二号' }),
        '意图版本 ID': 'INTENT-CANDIDATE-002',
        '项目 ID': 'PROJ-VIDEO-AUTOWORKER', '作品 ID': 'WORK-ICE-001',
        '状态': '待审核', ...reviewedMetadata({ '版本': 'v0.2.1' }),
      },
    }
    const harness = operationHarness(schema, {
      ...reviewedFoundation(),
      director_intents: [reviewedFoundation().director_intents[0], candidate],
    })
    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'director_intents', stableId: 'INTENT-CANDIDATE-002', workId: 'WORK-ICE-001',
      expectedVersion: 'v0.2.1', targetStatus: '草稿',
      reviewer: '测试导演', reason: '尝试非法回退。',
    }, harness.options)).rejects.toThrow('review_status_transition_invalid')
    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'director_intents', stableId: 'INTENT-CANDIDATE-002', workId: 'WORK-ICE-001',
      expectedVersion: 'v0.2.1', targetStatus: '生效',
      reviewer: '测试导演', reason: '不能覆盖既有生效意图。',
    }, harness.options)).rejects.toThrow('director_intent_previous_not_current')
    expect(harness.updateCalls).toHaveLength(0)
  })

  it('keeps review out of the OpenClaw action surface and accepts stdin only', async () => {
    const directorBrain = await loadModule()
    expect(() => directorBrain.parseDirectorBrainArgs(['review', '--table', 'director_intents']))
      .toThrow('review_accepts_stdin_only')
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'review', table: 'director_intents', stableId: 'INTENT-DRAFT-001',
    })).rejects.toThrow('operation_action_invalid')
  })
})

describe('Feishu director brain trusted evidence projection', () => {
  it('creates a candidate with a server-owned stable ID and is idempotent on replay', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema)

    const created = await directorBrain.projectDirectorBrainEvidence(
      evidenceProjectionRequest([projectedEvidence()]),
      harness.options,
    )
    const replayed = await directorBrain.projectDirectorBrainEvidence(
      evidenceProjectionRequest([projectedEvidence()]),
      harness.options,
    )

    expect(created).toMatchObject({
      ok: true,
      action: 'project-evidence',
      projectId: 'PROJ-VIDEO-AUTOWORKER',
      count: 1,
      created: 1,
      unchanged: 0,
      results: [{
        stableId: expect.stringMatching(/^DB-EVIDENCE-[a-f0-9]{64}$/u),
        outcome: 'created',
        record: {
          reviewed: false,
          fields: {
            '项目 ID': 'PROJ-VIDEO-AUTOWORKER',
            '状态': '候选',
            '来源': 'trusted-analysis-projection',
            '更新时间': Date.parse('2026-08-30T12:00:00+08:00'),
          },
        },
      }],
    })
    expect(replayed).toMatchObject({
      created: 0,
      unchanged: 1,
      results: [{
        outcome: 'unchanged',
        stableId: expect.stringMatching(/^DB-EVIDENCE-[a-f0-9]{64}$/u),
      }],
    })
    expect(harness.createCalls).toHaveLength(1)
    expect(JSON.stringify(created)).not.toMatch(/"record_id"|"appToken"|"tableId"|catalogPath/u)
  })

  it('serializes concurrent evidence projection for the same stable ID with the file lock', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema)
    const lockRoot = await mkdtemp(join(tmpdir(), 'director-brain-evidence-lock-'))
    harness.context.catalogPath = join(lockRoot, 'catalog.json')
    delete (harness.options.dependencies as unknown as Record<string, unknown>).withStableCreateLock
    const create = harness.options.dependencies.create
    harness.options.dependencies.create = async (input: Parameters<typeof create>[0]) => {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
      return create(input)
    }
    const request = evidenceProjectionRequest([projectedEvidence({
      '证据名称': '并发投影只创建一次',
    })])

    try {
      const results = await Promise.all([
        directorBrain.projectDirectorBrainEvidence(structuredClone(request), harness.options),
        directorBrain.projectDirectorBrainEvidence(structuredClone(request), harness.options),
      ])
      expect(results.map(result => result.created).sort()).toEqual([0, 1])
      expect(results.map(result => result.unchanged).sort()).toEqual([0, 1])
      expect(harness.createCalls).toHaveLength(1)
      const projected = harness.records.get('material_evidence') || []
      expect(projected).toHaveLength(1)
    } finally {
      await rm(lockRoot, { recursive: true, force: true })
    }
  })

  it('preflights a full batch, detects conflicts, and rejects duplicate identities', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema)
    const first = projectedEvidence()
    const second = projectedEvidence({
      '镜头 ID': 'SHOT-PROJECTION-002',
      '起始时间码': '00:01:09.000',
      '结束时间码': '00:01:12.000',
      '校验摘要': 'b'.repeat(64),
    })

    await directorBrain.projectDirectorBrainEvidence(
      evidenceProjectionRequest([first, second]), harness.options,
    )
    const records = harness.records.get('material_evidence')
    if (!records?.[0]?.fields) throw new Error('projected_evidence_fixture_missing')
    ;(records[0].fields as Record<string, unknown>)['证据摘要'] = '同一身份下被篡改的摘要'

    await expect(directorBrain.projectDirectorBrainEvidence(
      evidenceProjectionRequest([first]),
      harness.options,
    )).rejects.toThrow('evidence_projection_conflict')
    await expect(directorBrain.projectDirectorBrainEvidence(
      evidenceProjectionRequest([second, structuredClone(second)]),
      harness.options,
    )).rejects.toThrow('evidence_projection_duplicate_identity')
  })

  it('accepts Feishu numeric strings on evidence readback and returns normalized numbers', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema)
    const create = harness.options.dependencies.create
    harness.options.dependencies.create = async (input: Parameters<typeof create>[0]) => {
      const record = await create(input)
      const fields = record.fields as Record<string, unknown>
      if (input.table.key === 'material_evidence') {
        fields['置信度'] = String(fields['置信度'])
      }
      return record
    }

    const result = await directorBrain.projectDirectorBrainEvidence(
      evidenceProjectionRequest([projectedEvidence()]),
      harness.options,
    )

    const results = result.results as Array<{ record: { fields: Record<string, unknown> } }>
    expect(results[0].record.fields['置信度']).toBe(0.96)
    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'material_evidence',
      stableId: results[0].record.fields['证据 ID'],
      workId: 'WORK-ICE-001',
      expectedVersion: 'v0.2.0',
      targetStatus: '已核验',
      reviewer: '审核员',
      reason: '真实数值字符串回读验收',
    }, harness.options)).resolves.toMatchObject({ targetStatus: '已核验' })
  })

  it('enforces trusted references, timecodes, checksums, confidence, and safe content', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema)

    await expect(directorBrain.projectDirectorBrainEvidence(evidenceProjectionRequest([
      projectedEvidence({ '任务 ID': '' }),
    ]), harness.options)).rejects.toThrow('record_field_empty:任务 ID')
    await expect(directorBrain.projectDirectorBrainEvidence(evidenceProjectionRequest([
      projectedEvidence({ '结束时间码': '00:00:59.000' }),
    ]), harness.options)).rejects.toThrow('evidence_timecode_range_invalid')
    await expect(directorBrain.projectDirectorBrainEvidence(evidenceProjectionRequest([
      projectedEvidence({ '起始时间码': '62.120' }),
    ]), harness.options)).rejects.toThrow('evidence_timecode_invalid')
    await expect(directorBrain.projectDirectorBrainEvidence(evidenceProjectionRequest([
      projectedEvidence({ '校验摘要': 'not-a-sha256' }),
    ]), harness.options)).rejects.toThrow('evidence_checksum_invalid')
    await expect(directorBrain.projectDirectorBrainEvidence(evidenceProjectionRequest([
      projectedEvidence({ '置信度': 1.01 }),
    ]), harness.options)).rejects.toThrow('record_number_out_of_range:置信度')
    await expect(directorBrain.projectDirectorBrainEvidence(evidenceProjectionRequest([
      projectedEvidence({ '证据 ID': 'caller-controlled' }),
    ]), harness.options)).rejects.toThrow('evidence_projection_owned_field:证据 ID')
    for (const field of ['版本', '上一版本 ID', '审核人', '审核时间', '审核原因']) {
      await expect(directorBrain.projectDirectorBrainEvidence(evidenceProjectionRequest([
        projectedEvidence({ [field]: field === '审核时间' ? Date.now() : 'caller-controlled' }),
      ]), harness.options)).rejects.toThrow('evidence_projection_owned_field:' + field)
    }
    await expect(directorBrain.projectDirectorBrainEvidence(evidenceProjectionRequest([
      projectedEvidence({ taskStatus: 'running' }),
    ]), harness.options)).rejects.toThrow('task_state_forbidden')
    await expect(directorBrain.projectDirectorBrainEvidence(evidenceProjectionRequest([
      projectedEvidence({ '证据摘要': '/Users/example/raw/video.mp4' }),
    ]), harness.options)).rejects.toThrow('absolute_path_forbidden')
    await expect(directorBrain.projectDirectorBrainEvidence(evidenceProjectionRequest([
      projectedEvidence({ '证据摘要': '这里保存完整原始转写' }),
    ]), harness.options)).rejects.toThrow('full_transcript_forbidden')
  })

  it('is available only as a stdin CLI command, not as an OpenClaw operation action', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema)

    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'project-evidence',
      items: [projectedEvidence()],
    }, harness.options)).rejects.toThrow('operation_action_invalid')
    await expect(directorBrain.runDirectorBrainCli(['project-evidence'], {
      ...harness.options,
      stdin: JSON.stringify(evidenceProjectionRequest([projectedEvidence()])),
    })).resolves.toMatchObject({ action: 'project-evidence', created: 1 })
    expect(() => directorBrain.parseDirectorBrainArgs(['project-evidence', '--table', 'material_evidence']))
      .toThrow('project_evidence_accepts_stdin_only')
  })

  it('rejects unsafe projection content before opening an external connection', async () => {
    const directorBrain = await loadModule()
    const connect = vi.fn(async () => {
      throw new Error('external_connection_must_not_run')
    })

    await expect(directorBrain.projectDirectorBrainEvidence(evidenceProjectionRequest([
      projectedEvidence({ taskStatus: 'running' }),
    ]), { dependencies: { connect } })).rejects.toThrow('task_state_forbidden')
    expect(connect).not.toHaveBeenCalled()
  })
})
