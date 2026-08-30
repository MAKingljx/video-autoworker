import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

interface DirectorBrainModule {
  DEFAULT_CATALOG_PATH: string
  DEFAULT_CATALOG_ROOT: string
  exactRecordFilter: (fieldName: string, value: string) => string
  initialDirectorBrainBlueprint: (projectId?: string) => Array<Record<string, unknown>>
  loadDirectorBrainSchema: (pathname?: string) => Promise<{
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
  validateDirectorBrainCatalog: (value: unknown, schema: unknown) => unknown
  validateDirectorBrainCatalogPath: (pathname: string, catalogRoot?: string) => string
  validateBootstrapTablePreflight: (
    table: unknown,
    fields: Array<Record<string, unknown>>,
    records?: Array<Record<string, unknown>>,
  ) => boolean
  validateDirectorBrainSchema: (value: unknown) => unknown
}

async function loadModule(): Promise<DirectorBrainModule> {
  const path = resolve(process.cwd(), 'scripts/lib/feishu-director-brain.mjs')
  return await import(/* @vite-ignore */ pathToFileURL(path).href) as DirectorBrainModule
}

describe('Feishu director brain contract', () => {
  it('keeps an isolated ten-table schema under the existing Video AutoWorker project', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()

    expect(schema.brainName).toBe('导演脑')
    expect(schema.projectId).toBe('PROJ-VIDEO-AUTOWORKER')
    expect(schema.keychainService).toBe('com.openai.codex.video-autoworker-director-brain.test')
    expect(schema.tables).toHaveLength(10)
    expect(new Set(schema.tables.map(table => table.key)).size).toBe(10)
    expect(schema.tables.map(table => table.name)).toEqual([
      '系统蓝图',
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

    expect(records).toHaveLength(8)
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
    ]))
    expect(records.find(record => record['规范 ID'] === 'DB-LOOP-CASE')?.内容)
      .toContain('为什么这样判断')
    expect(records.every(record => record['项目 ID'] === 'PROJ-VIDEO-AUTOWORKER')).toBe(true)
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
      schemaVersion: 1,
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
      schemaVersion: 1,
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
      tableCount: 10,
    })
  })

  it('fails a standalone artifact that contains private routing or credential files', async () => {
    const modulePath = resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs')
    const artifactAudit = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
      findForbiddenStandaloneMembers: (root: string) => Promise<string[]>
    }
    const root = await mkdtemp(join(tmpdir(), 'video-autoworker-standalone-audit-'))
    try {
      await mkdir(join(root, 'nested'), { recursive: true })
      await writeFile(join(root, 'server.js'), 'export {}\n')
      await writeFile(join(root, '.PhoenixBrain'), '{}\n')
      await writeFile(join(root, '.ENV'), 'SECRET=redacted\n')
      await writeFile(join(root, '.npmrc'), '//registry.example/:_authToken=redacted\n')
      await writeFile(join(root, 'nested', '.env.production'), 'SECRET=redacted\n')
      await writeFile(join(root, 'nested', '.envrc'), 'export SECRET=redacted\n')
      await writeFile(join(root, 'nested', 'id_ed25519'), 'redacted\n')
      await writeFile(join(root, 'nested', 'test-catalog.json'), '{}\n')

      await expect(artifactAudit.findForbiddenStandaloneMembers(root)).resolves.toEqual([
        '.ENV',
        '.PhoenixBrain',
        '.npmrc',
        'nested/.env.production',
        'nested/.envrc',
        'nested/id_ed25519',
        'nested/test-catalog.json',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
