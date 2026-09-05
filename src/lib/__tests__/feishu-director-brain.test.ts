import { execFile, spawn, spawnSync } from 'node:child_process'
import {
  access, chmod, lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, rmdir, stat, symlink, utimes,
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
  learningContextCandidateFilter: (input: Record<string, unknown>) => string
  queryLearningCandidates: (
    input: Record<string, unknown>,
    requester: (...args: unknown[]) => Promise<Record<string, unknown>>,
  ) => Promise<Record<string, unknown>>
  findManyOperationRecords: (
    input: Record<string, unknown>,
    requester: (...args: unknown[]) => Promise<Record<string, unknown>>,
  ) => Promise<Record<string, unknown>>
  executeDirectorBrainOperation: (
    request: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  executeDirectorBrainProposalBatch: (
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
    environment: string
    keychainService: string
    tables: Array<{
      key: string
      name: string
      stableId: string
      fields: Array<{
        name: string
        type: number
        primary?: boolean
        options?: string[]
        sinceVersion?: number
      }>
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
  writeMigrationBackup: (
    accessToken: string,
    catalogArtifact: Record<string, unknown>,
    schema: unknown,
    plan: unknown,
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  verifyMigrationBackupFile: (
    receiptFile: string,
    expectedSha256: string,
  ) => Promise<Record<string, unknown>>
  verifyMigrationRemoteSnapshot: (
    accessToken: string,
    catalog: Record<string, unknown>,
    receipt: Record<string, unknown>,
    dependencies: Record<string, unknown>,
  ) => Promise<boolean>
  withDirectorBrainMigrationLock: (
    options: Record<string, unknown>,
    action: (context: Record<string, unknown>) => Promise<unknown>,
  ) => Promise<unknown>
  migrateDirectorBrain: (
    options?: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>
  validateDirectorBrainCatalogPath: (pathname: string, catalogRoot?: string) => string
  validateBootstrapTablePreflight: (
    table: unknown,
    fields: Array<Record<string, unknown>>,
    records?: Array<Record<string, unknown>>,
  ) => boolean
  validateDirectorBrainSchema: (value: unknown) => unknown
  parseDirectorBrainArgs: (argv: string[]) => Record<string, unknown>
  normalizeDirectorWorkTitle: (value: unknown) => string
  deriveDirectorWorkNames: (
    fields: Record<string, unknown>,
    worksById?: Map<string, Record<string, unknown>>,
  ) => string[]
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
    'openclaw-plugins/aiworker-director-brain/lib/director-context-summary.js': 'export {}\n',
    'openclaw-plugins/aiworker-director-brain/lib/director-system-question-router.js': 'export {}\n',
    'openclaw-plugins/aiworker-director-brain/lib/sensitive-narrative-text.js': 'export {}\n',
    'openclaw-plugins/aiworker-director-brain/lib/transcript-tool-result-projection.js': 'export {}\n',
    'openclaw-plugins/aiworker-director-brain/openclaw.plugin.json': '{}\n',
    'openclaw-plugins/aiworker-director-brain/package.json': '{}\n',
    'openclaw-plugins/aiworker-video-command/index.js': 'export default {}\n',
    'openclaw-plugins/aiworker-video-command/lib/director-work-policy.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/dispatch-identity.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/duplicate-confirmation-store.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/json-command.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/qwen-before-dispatch.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/qwen-video-classifier.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/scheduler-runner.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/stable-message-key.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/task-chain-tool.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/lib/video-path-policy.js': 'export {}\n',
    'openclaw-plugins/aiworker-video-command/openclaw.plugin.json': '{}\n',
    'openclaw-plugins/aiworker-video-command/package.json': '{}\n',
    'openclaw-plugins/aiworker-video-command/scripts/validate-runtime-inspection.mjs': 'export {}\n',
    'openclaw-skills/aiworker-director-brain/SKILL.md': 'runtime\n',
    'openclaw-skills/aiworker-task-flow/SKILL.md': 'runtime\n',
    'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_MEMORY.md': 'runtime\n',
    'openclaw-skills/aiworker-task-flow/WORKSPACE_VIDEO_RULES.md': 'runtime\n',
    'openclaw-skills/aiworker-task-flow/lib/director-brain-evidence.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/director-work-policy.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/media-ingest.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/media-policy.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/platform-client.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/task-status-authority.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/video-result-page.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/video-task.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/lib/worker-launch-authorization.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/scripts/project-director-evidence.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/scripts/run-video-batch.mjs': 'export {}\n',
    'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs': 'export {}\n',
    'ops/feishu-director-brain/schema.json': '{}\n',
    'ops/openclaw/qwen-current-runtime-convergence.manifest.json': '{}\n',
    'package.json': '{}\n',
    'public/favicon.ico': 'fixture\n',
    'runtime/schema.sql': 'CREATE TABLE tasks (id TEXT, title TEXT, status TEXT);\n',
    'scripts/feishu-director-brain.mjs': 'export {}\n',
    'scripts/apply-openclaw-runtime-convergence.sh': '#!/bin/sh\n',
    'scripts/install-aiworker-task-flow-skill.sh': '#!/bin/sh\n',
    'scripts/install-aiworker-video-command-plugin.sh': '#!/bin/sh\n',
    'scripts/install-aiworker-director-brain.sh': '#!/bin/sh\n',
    'scripts/check-standalone-artifact.mjs': 'export {}\n',
    'scripts/check-sensitive-content.mjs': 'export {}\n',
    'scripts/verify-director-video-release-readiness.mjs': 'export {}\n',
    'scripts/verify-shared-runtime-install-gate.mjs': 'export {}\n',
    'scripts/legacy-preinstall-orchestrator.mjs': 'export {}\n',
    'scripts/legacy-preinstall-controller.mjs': 'export {}\n',
    'scripts/legacy-bootstrap-controller.mjs': 'export {}\n',
    'scripts/verify-n8n-blue-green-workflows.mjs': 'export {}\n',
    'scripts/generate-legacy-freeze-evidence.mjs': 'export {}\n',
    'scripts/generate-legacy-bootstrap-rollback-proof.mjs': 'export {}\n',
    'scripts/legacy-freeze-guard.mjs': 'export {}\n',
    'scripts/n8n-workflow-transition-anchor.mjs': 'export {}\n',
    'scripts/lib/feishu-director-brain.mjs': 'export {}\n',
    'scripts/lib/runtime-safe-offline-queue.mjs': 'export {}\n',
    'scripts/lib/openclaw-secret-reference.mjs': 'export {}\n',
    'scripts/lib/openclaw-private-gateway-rpc.mjs': 'export {}\n',
    'scripts/lib/openclaw-runtime-convergence.mjs': 'export {}\n',
    'scripts/lib/openclaw-tool-capability-fingerprint.mjs': 'export {}\n',
    'scripts/lib/render-managed-markdown-section.mjs': 'export {}\n',
    'scripts/lib/runtime-tree-manifest.mjs': 'export {}\n',
    'scripts/lib/director-extraction-release-provenance.mjs': 'export {}\n',
    'scripts/lib/sensitive-value-scanner.mjs': 'export {}\n',
    'scripts/lib/shared-deployment-lock.mjs': 'export {}\n',
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
  const learningQueryCalls: Array<Record<string, unknown>> = []
  const learningFindManyCalls: Array<Record<string, unknown>> = []
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
    findMany: async ({ table, stableIds }: {
      table: LoadedSchema['tables'][number]
      stableIds: string[]
    }) => {
      learningFindManyCalls.push({ table: table.key, stableIds: [...stableIds] })
      const requested = new Set(stableIds)
      return {
        records: (records.get(table.key) || []).filter(record => requested.has(String(
          (record.fields as Record<string, unknown> | undefined)?.[table.stableId] || '',
        ))),
        requestCount: Math.max(1, Math.ceil(stableIds.length / 20)),
      }
    },
    queryLearning: async ({ table, workId, terms }: {
      table: LoadedSchema['tables'][number]
      workId: string | null
      terms: string[]
    }) => {
      learningQueryCalls.push({ table: table.key, workId, terms: [...terms] })
      const found = (records.get(table.key) || []).filter(record => {
        const fields = record.fields as Record<string, unknown>
        if (fields['项目 ID'] !== schema.projectId) return false
        if (workId) {
          const observed = table.key === 'works' ? fields[table.stableId] : fields['作品 ID']
          if (observed !== workId) return false
        }
        if (terms.length) {
          const text = JSON.stringify(fields).normalize('NFKC').toLocaleLowerCase('zh-CN')
          if (!terms.some(term => text.includes(term))) return false
        }
        return true
      }).sort((left, right) => Number(
        (right.fields as Record<string, unknown>)['更新时间'] || 0,
      ) - Number((left.fields as Record<string, unknown>)['更新时间'] || 0))
      const recordsInWindow = found.slice(0, 100)
      return {
        records: recordsInWindow,
        truncated: found.length > recordsInWindow.length,
        requestCount: found.length > 50 ? 2 : 1,
      }
    },
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
      if (table.key === 'skills_techniques') {
        return String(fields['来源作品 ID'] || fields['作品 ID'] || '')
          .split('\n')
          .includes(workId)
      }
      return (table.key === 'works' ? fields[table.stableId] : fields['作品 ID']) === workId
    }),
    listAll: async ({ table }: {
      table: LoadedSchema['tables'][number]
    }) => records.get(table.key) || [],
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
    learningQueryCalls,
    learningFindManyCalls,
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

function completeDirectorCaseOutcomeFields(overrides: Record<string, unknown> = {}) {
  return {
    '最终使用': '是',
    '成片位置': '第二幕人物作出选择前',
    '最终效果': '让外部风险转化为可见的人物选择',
    ...overrides,
  }
}

async function migrationHarness(directorBrain: DirectorBrainModule) {
  const schema = await directorBrain.loadDirectorBrainSchema()
  const root = await realpath(await mkdtemp(join(tmpdir(), 'director-brain-migration-v3-')))
  await chmod(root, 0o700)
  const catalogPath = join(root, 'catalog.json')
  const receiptFile = join(root, 'migration.receipt.json')
  const catalog = {
    schemaVersion: 2,
    brainName: schema.brainName,
    projectId: schema.projectId,
    environment: schema.environment,
    keychainService: schema.keychainService,
    appId: 'cli_test',
    appToken: 'bascn_private_fixture',
    url: 'https://example.invalid/private',
    tables: Object.fromEntries(schema.tables.map(table => [table.key, {
      name: table.name,
      tableId: `table_${table.key}`,
    }])),
  }
  const originalCatalogBytes = Buffer.from(JSON.stringify(catalog, null, 4) + '\n', 'utf8')
  await writeFile(catalogPath, originalCatalogBytes, { mode: 0o600 })
  await chmod(catalogPath, 0o600)
  const remoteTables = schema.tables.map((table, index) => ({
    table_id: `table_${table.key}`,
    name: table.name,
    revision: 100 + index,
  }))
  const remoteFields = new Map(schema.tables.map(table => [
    table.key,
    table.fields.filter(field => Number(field.sinceVersion || 1) <= 2).map((field, index) => ({
      field_id: `field_${table.key}_${index}`,
      field_name: field.name,
      type: field.type,
      is_primary: field.primary === true,
      ...((field.type === 3 || field.type === 4) ? {
        property: { options: (field.options || []).map((name, optionIndex) => ({
          name, color: optionIndex,
        })) },
      } : {}),
    })),
  ]))
  const remoteRecords = new Map(schema.tables.map(table => [table.key, [
    { record_id: `blank_${table.key}`, fields: {} },
    {
      record_id: `record_${table.key}`,
      fields: { [table.fields[0].name]: `${table.name}既有记录` },
    },
  ]]))
  const createdFields: Array<{ tableKey: string; fieldName: string }> = []
  const createFieldDependency: (
    token: string,
    appToken: string,
    tableId: string,
    field: LoadedSchema['tables'][number]['fields'][number],
  ) => Promise<Record<string, unknown> | null> = async (
    _token,
    _appToken,
    tableId,
    field,
  ) => {
    const key = tableId.replace(/^table_/u, '')
    const fields = remoteFields.get(key)
    if (!fields) throw new Error('fixture_table_missing')
    const createdField = {
      field_id: `created_${key}_${createdFields.length}`,
      field_name: field.name,
      type: field.type,
      is_primary: false,
      ...((field.type === 3 || field.type === 4) ? {
        property: { options: (field.options || []).map((name, optionIndex) => ({
          name, color: optionIndex,
        })) },
      } : {}),
    }
    fields.push(createdField)
    const remoteTable = remoteTables.find(item => item.table_id === tableId)
    if (!remoteTable) throw new Error('fixture_remote_table_missing')
    remoteTable.revision += 1
    createdFields.push({ tableKey: key, fieldName: field.name })
    return structuredClone(createdField)
  }
  const dependencies = {
    accessToken: async () => 'tenant_access_token_fixture',
    listTables: async () => structuredClone(remoteTables),
    listFields: async (_token: string, _appToken: string, tableId: string) => {
      const key = tableId.replace(/^table_/u, '')
      return structuredClone(remoteFields.get(key) || [])
    },
    listRecords: async (_token: string, _appToken: string, tableId: string) => {
      const key = tableId.replace(/^table_/u, '')
      return structuredClone(remoteRecords.get(key) || [])
    },
    createField: createFieldDependency,
  }
  const options = {
    catalogPath,
    catalogRoot: root,
    receiptFile,
    migrationDependencies: dependencies,
  }
  const addField = (tableKey: string, fieldName: string, fieldId: string) => {
    const table = schema.tables.find(item => item.key === tableKey)
    const field = table?.fields.find(item => item.name === fieldName)
    if (!field) throw new Error('fixture_field_missing')
    remoteFields.get(tableKey)?.push({
      field_id: fieldId,
      field_name: field.name,
      type: field.type,
      is_primary: false,
      ...((field.type === 3 || field.type === 4) ? {
        property: { options: (field.options || []).map((name, optionIndex) => ({
          name, color: optionIndex,
        })) },
      } : {}),
    })
    const remoteTable = remoteTables.find(item => item.table_id === `table_${tableKey}`)
    if (!remoteTable) throw new Error('fixture_remote_table_missing')
    remoteTable.revision += 1
  }
  return {
    schema,
    root,
    catalog,
    catalogPath,
    receiptFile,
    originalCatalogBytes,
    remoteTables,
    remoteFields,
    remoteRecords,
    createdFields,
    dependencies,
    options,
    addField,
  }
}

type FoundationTable = 'works' | 'director_intents' | 'material_evidence'
  | 'story_nodes' | 'material_judgments' | 'director_cases'
type LearningContextTable = 'people_profiles' | 'story_relations'
  | 'narrative_plans' | 'skills_techniques'

interface FoundationRecord extends Record<string, unknown> {
  record_id: string
  fields: Record<string, unknown>
}

type FoundationFixture = Record<FoundationTable, FoundationRecord[]>
  & Partial<Record<LearningContextTable, FoundationRecord[]>>

function reviewedFoundation(): FoundationFixture {
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
        ...completeDirectorCaseOutcomeFields(),
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
      schemaVersion: schema.schemaVersion,
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
      schemaVersion: schema.schemaVersion,
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

  it('accepts controlled legacy catalogs for an additive, backed-up v3 migration plan', async () => {
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
      toVersion: 3,
      required: true,
      addTables: ['works'],
      destructiveChanges: [],
      addFields: {
        director_intents: expect.arrayContaining(['作品 ID', '审核人', '审核时间', '审核原因']),
        material_evidence: expect.arrayContaining([
          '作品 ID', '版本', '上一版本 ID', '人物信息', '物体信息', '环境信息', '情绪信息',
        ]),
        material_judgments: expect.arrayContaining(['技法 ID']),
        narrative_plans: expect.arrayContaining(['技法 ID']),
        works: expect.arrayContaining(['作品层级', '父作品 ID', '系列 ID', '季 ID']),
        skills_techniques: expect.arrayContaining(['作用域', '来源作品 ID']),
      },
      rollback: {
        required: true,
        strategy: 'verified-private-backup-manual-recovery',
        catalogVersion: 1,
        automaticRestoreAvailable: false,
      },
    })
    const invalid = structuredClone(legacyCatalog)
    delete invalid.tables.story_nodes
    expect(() => directorBrain.validateDirectorBrainCatalog(
      invalid, schema, { allowLegacyV1: true },
    )).toThrow('legacy_catalog_table_set_invalid')
  })

  it('preflights the deployed v2 catalog as an additive and reversible v3 migration', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const catalog = {
      schemaVersion: 2,
      brainName: schema.brainName,
      projectId: schema.projectId,
      environment: schema.environment,
      keychainService: schema.keychainService,
      appId: 'cli_test',
      appToken: 'bascn_test',
      tables: Object.fromEntries(schema.tables.map(table => [table.key, {
        name: table.name,
        tableId: `table_${table.key}`,
      }])),
    }

    expect(() => directorBrain.validateDirectorBrainCatalog(catalog, schema))
      .toThrow('catalog_schema_version_mismatch')
    expect(directorBrain.validateDirectorBrainCatalog(
      catalog, schema, { allowLegacyV2: true },
    )).toBe(catalog)
    expect(directorBrain.planDirectorBrainMigration(catalog, schema)).toMatchObject({
      fromVersion: 2,
      toVersion: 3,
      required: true,
      addTables: [],
      destructiveChanges: [],
      rollback: {
        required: true,
        strategy: 'verified-private-backup-manual-recovery',
        catalogVersion: 2,
        automaticRestoreAvailable: false,
      },
      addFields: {
        works: ['作品层级', '父作品 ID', '系列 ID', '季 ID', '季序号', '集序号'],
        material_evidence: ['人物信息', '物体信息', '环境信息', '情绪信息'],
        material_judgments: ['技法 ID'],
        narrative_plans: ['技法 ID'],
        skills_techniques: ['作用域', '来源作品 ID'],
      },
    })
    expect(() => directorBrain.parseDirectorBrainArgs(['restore-private-backup']))
      .toThrow('director_brain_command_invalid')
  })

  it('prepares and independently verifies a cross-process private v2 receipt with exact recovery bytes', async () => {
    const directorBrain = await loadModule()
    const fixture = await migrationHarness(directorBrain)
    try {
      await expect(directorBrain.migrateDirectorBrain({
        ...fixture.options,
        dryRun: true,
      })).resolves.toMatchObject({
        mode: 'dry-run',
        scope: 'local-catalog-and-schema-only',
        remoteVerified: false,
      })
      const prepared = await directorBrain.migrateDirectorBrain({
        ...fixture.options,
        prepare: true,
      })
      expect(prepared).toMatchObject({
        ok: true,
        mode: 'prepare',
        remoteVerified: true,
        fromVersion: 2,
        toVersion: 3,
        receiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        originalCatalogSha256: createHash('sha256')
          .update(fixture.originalCatalogBytes).digest('hex'),
        originalCatalogBytes: fixture.originalCatalogBytes.length,
        tableCount: fixture.schema.tables.length,
        recordCount: fixture.schema.tables.length * 2,
      })
      const addFields = prepared.addFields as Record<string, string[]>
      expect(Object.values(addFields).flat()).toHaveLength(14)
      expect(addFields).toEqual({
        works: ['作品层级', '父作品 ID', '系列 ID', '季 ID', '季序号', '集序号'],
        material_evidence: ['人物信息', '物体信息', '环境信息', '情绪信息'],
        material_judgments: ['技法 ID'],
        narrative_plans: ['技法 ID'],
        skills_techniques: ['作用域', '来源作品 ID'],
      })
      const receipt = JSON.parse(await readFile(fixture.receiptFile, 'utf8'))
      expect(receipt.originalCatalog).toMatchObject({
        path: fixture.catalogPath,
        physicalPath: fixture.catalogPath,
        sha256: prepared.originalCatalogSha256,
        bytes: fixture.originalCatalogBytes.length,
        mode: 0o600,
        uid: expect.any(Number),
        gid: expect.any(Number),
        nlink: 1,
      })
      expect(receipt.snapshot).toMatchObject({
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        bytes: expect.any(Number),
        mode: 0o600,
        uid: expect.any(Number),
        gid: expect.any(Number),
        nlink: 1,
      })
      const snapshot = JSON.parse(await readFile(receipt.snapshot.path, 'utf8'))
      expect(Buffer.from(snapshot.originalCatalogBase64, 'base64'))
        .toEqual(fixture.originalCatalogBytes)
      expect(snapshot.remoteSnapshot.tables.works.records).toEqual(
        fixture.remoteRecords.get('works'),
      )

      const child = await execFileAsync(process.execPath, [
        resolve(process.cwd(), 'scripts/feishu-director-brain.mjs'),
        'migration-backup',
        'verify',
        '--receipt-file',
        fixture.receiptFile,
        '--expected-sha',
        prepared.receiptSha256 as string,
      ])
      const childResult = JSON.parse(child.stdout)
      expect(childResult).toMatchObject({
        ok: true,
        verified: true,
        receiptSha256: prepared.receiptSha256,
      })
      expect(child.stdout).not.toMatch(/bascn_private_fixture|tenant_access_token_fixture/u)
      await expect(directorBrain.verifyMigrationBackupFile(
        fixture.receiptFile, '0'.repeat(64),
      )).rejects.toThrow('migration_receipt_sha256_mismatch')
      await expect(directorBrain.verifyMigrationBackupFile(
        fixture.receiptFile, undefined as unknown as string,
      )).rejects.toThrow('migration_expected_sha256_invalid')
      expect(directorBrain.parseDirectorBrainArgs([
        'migrate', '--prepare', '--receipt-file', fixture.receiptFile,
      ])).toMatchObject({ prepare: true, receiptFile: fixture.receiptFile })
      expect(directorBrain.parseDirectorBrainArgs([
        'migration-backup', 'verify', '--receipt-file', fixture.receiptFile,
        '--expected-sha', prepared.receiptSha256 as string,
      ])).toMatchObject({
        backupAction: 'verify', receiptFile: fixture.receiptFile,
        expectedSha256: prepared.receiptSha256,
      })
      expect(() => directorBrain.parseDirectorBrainArgs(['migrate']))
        .toThrow('migration_mode_required')
      expect(() => directorBrain.parseDirectorBrainArgs([
        'migration-backup', 'verify', '--receipt-file', fixture.receiptFile,
      ])).toThrow('migration_expected_sha256_required')
      expect(() => directorBrain.parseDirectorBrainArgs([
        'migrate', '--rollback-dry-run', '--receipt-file', fixture.receiptFile,
      ])).toThrow('migration_expected_sha256_required')
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('applies only the 14 missing fields, safely continues partial work, and never deletes blank records', async () => {
    const directorBrain = await loadModule()
    const fixture = await migrationHarness(directorBrain)
    try {
      const blankRecordsBefore = structuredClone(Object.fromEntries(fixture.remoteRecords))
      const prepared = await directorBrain.migrateDirectorBrain({
        ...fixture.options,
        prepare: true,
      })
      const createField = fixture.dependencies.createField
      let createAttempts = 0
      fixture.dependencies.createField = async (...args: Parameters<typeof createField>) => {
        if (createAttempts === 2) throw new Error('fixture_create_field_interrupted')
        createAttempts += 1
        return createField(...args)
      }
      await expect(directorBrain.migrateDirectorBrain({
        ...fixture.options,
        apply: true,
        expectedSha256: prepared.receiptSha256,
      })).rejects.toThrow('fixture_create_field_interrupted')
      expect(fixture.createdFields).toHaveLength(2)
      expect(JSON.parse(await readFile(fixture.catalogPath, 'utf8')).schemaVersion).toBe(2)
      fixture.dependencies.createField = createField
      const applied = await directorBrain.migrateDirectorBrain({
        ...fixture.options,
        apply: true,
        expectedSha256: prepared.receiptSha256,
      })
      expect(applied).toMatchObject({
        ok: true,
        mode: 'apply',
        alreadyApplied: false,
        fieldsCreatedThisRun: 12,
        fieldsAdded: 14,
        fieldsOwned: 14,
      })
      expect(fixture.createdFields).toHaveLength(14)
      expect(Object.fromEntries(fixture.remoteRecords)).toEqual(blankRecordsBefore)
      expect(JSON.parse(await readFile(fixture.catalogPath, 'utf8')).schemaVersion).toBe(3)

      const reapplied = await directorBrain.migrateDirectorBrain({
        ...fixture.options,
        apply: true,
        expectedSha256: prepared.receiptSha256,
      })
      expect(reapplied).toMatchObject({ alreadyApplied: true, fieldsAdded: 14 })
      expect(fixture.createdFields).toHaveLength(14)

      await expect(directorBrain.migrateDirectorBrain({
        ...fixture.options,
        rollbackDryRun: true,
        expectedSha256: prepared.receiptSha256,
      })).resolves.toMatchObject({
        eligibleForManualRollback: true,
        destructiveActionPerformed: false,
        fieldsChecked: 14,
        originalCatalogRecovery: {
          sha256: createHash('sha256').update(fixture.originalCatalogBytes).digest('hex'),
          bytes: fixture.originalCatalogBytes.length,
        },
      })
      expect(Object.fromEntries(fixture.remoteRecords)).toEqual(blankRecordsBefore)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('never claims an ambiguously created or concurrent same-name field as rollback-owned', async () => {
    const directorBrain = await loadModule()
    const fixture = await migrationHarness(directorBrain)
    try {
      const prepared = await directorBrain.migrateDirectorBrain({
        ...fixture.options,
        prepare: true,
      })
      const createField = fixture.dependencies.createField
      fixture.dependencies.createField = async (...args: Parameters<typeof createField>) => {
        await createField(...args)
        return null
      }
      await expect(directorBrain.migrateDirectorBrain({
        ...fixture.options,
        apply: true,
        expectedSha256: prepared.receiptSha256,
      })).rejects.toThrow('migration_create_field_response_missing')
      fixture.dependencies.createField = createField
      await expect(directorBrain.migrateDirectorBrain({
        ...fixture.options,
        apply: true,
        expectedSha256: prepared.receiptSha256,
      })).rejects.toThrow('director_brain_migration_remote_revision_changed:works')
      expect(JSON.parse(await readFile(fixture.catalogPath, 'utf8')).schemaVersion).toBe(2)
      await expect(access(fixture.receiptFile + '.applied.json')).rejects.toThrow()
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('fails closed on catalog or remote drift before migration writes', async () => {
    const directorBrain = await loadModule()
    const catalogFixture = await migrationHarness(directorBrain)
    const remoteFixture = await migrationHarness(directorBrain)
    const revisionFixture = await migrationHarness(directorBrain)
    try {
      const catalogPrepared = await directorBrain.migrateDirectorBrain({
        ...catalogFixture.options,
        prepare: true,
      })
      await writeFile(
        catalogFixture.catalogPath,
        Buffer.concat([catalogFixture.originalCatalogBytes, Buffer.from(' ')]),
        { mode: 0o600 },
      )
      await expect(directorBrain.migrateDirectorBrain({
        ...catalogFixture.options,
        apply: true,
        expectedSha256: catalogPrepared.receiptSha256,
      })).rejects.toThrow('director_brain_migration_catalog_changed')
      expect(catalogFixture.createdFields).toHaveLength(0)

      const remotePrepared = await directorBrain.migrateDirectorBrain({
        ...remoteFixture.options,
        prepare: true,
      })
      remoteFixture.remoteRecords.get('works')?.push({
        record_id: 'concurrent_record', fields: { 作品名称: '并发写入' },
      })
      await expect(directorBrain.migrateDirectorBrain({
        ...remoteFixture.options,
        apply: true,
        expectedSha256: remotePrepared.receiptSha256,
      })).rejects.toThrow('director_brain_migration_remote_records_changed:works')
      expect(remoteFixture.createdFields).toHaveLength(0)

      const revisionPrepared = await directorBrain.migrateDirectorBrain({
        ...revisionFixture.options,
        prepare: true,
      })
      revisionFixture.remoteTables[0].revision += 1
      await expect(directorBrain.migrateDirectorBrain({
        ...revisionFixture.options,
        apply: true,
        expectedSha256: revisionPrepared.receiptSha256,
      })).rejects.toThrow('director_brain_migration_remote_revision_changed:system_blueprint')
      expect(revisionFixture.createdFields).toHaveLength(0)
    } finally {
      await rm(catalogFixture.root, { recursive: true, force: true })
      await rm(remoteFixture.root, { recursive: true, force: true })
      await rm(revisionFixture.root, { recursive: true, force: true })
    }
  })

  it('refuses rollback dry-run after field use, business writes, or field identity drift', async () => {
    const directorBrain = await loadModule()
    const valueFixture = await migrationHarness(directorBrain)
    const writeFixture = await migrationHarness(directorBrain)
    const driftFixture = await migrationHarness(directorBrain)
    const apply = async (fixture: Awaited<ReturnType<typeof migrationHarness>>) => {
      const prepared = await directorBrain.migrateDirectorBrain({
        ...fixture.options, prepare: true,
      })
      await directorBrain.migrateDirectorBrain({
        ...fixture.options, apply: true, expectedSha256: prepared.receiptSha256,
      })
      return prepared.receiptSha256 as string
    }
    try {
      const valueReceiptSha = await apply(valueFixture)
      const valueRecord = valueFixture.remoteRecords.get('works')?.[0]
      if (valueRecord) valueRecord.fields['父作品 ID'] = 'WORK-PARENT-001'
      await expect(directorBrain.migrateDirectorBrain({
        ...valueFixture.options, rollbackDryRun: true, expectedSha256: valueReceiptSha,
      })).rejects.toThrow('migration_rollback_field_has_values:works:父作品 ID')

      const writeReceiptSha = await apply(writeFixture)
      writeFixture.remoteRecords.get('works')?.push({
        record_id: 'post_migration_business_write', fields: { 作品名称: '新作品' },
      })
      await expect(directorBrain.migrateDirectorBrain({
        ...writeFixture.options, rollbackDryRun: true, expectedSha256: writeReceiptSha,
      })).rejects.toThrow('migration_rollback_business_writes_detected:works')

      const driftReceiptSha = await apply(driftFixture)
      const field = driftFixture.remoteFields.get('works')
        ?.find(item => item.field_name === '父作品 ID')
      if (field) field.field_id = 'field_identity_drifted'
      await expect(directorBrain.migrateDirectorBrain({
        ...driftFixture.options, rollbackDryRun: true, expectedSha256: driftReceiptSha,
      })).rejects.toThrow('director_brain_migration_owned_field_missing')
    } finally {
      await rm(valueFixture.root, { recursive: true, force: true })
      await rm(writeFixture.root, { recursive: true, force: true })
      await rm(driftFixture.root, { recursive: true, force: true })
    }
  })

  it('reenters only with its internal migration context and rejects another process', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const root = await mkdtemp(join(tmpdir(), 'director-brain-migration-lock-'))
    const catalogPath = join(root, 'catalog.json')
    const catalog = {
      schemaVersion: 2,
      brainName: schema.brainName,
      projectId: schema.projectId,
      environment: schema.environment,
      keychainService: schema.keychainService,
      appId: 'cli_test',
      appToken: 'bascn_test',
      tables: {},
    }
    const lockOptions = {
      catalogPath,
      catalog,
      fromVersion: 2,
      toVersion: 3,
      receiptSha256: 'a'.repeat(64),
    }
    let release: (() => void) | undefined
    let entered: (() => void) | undefined
    const held = new Promise<void>(resolvePromise => { release = resolvePromise })
    const acquired = new Promise<void>(resolvePromise => { entered = resolvePromise })

    try {
      const first = directorBrain.withDirectorBrainMigrationLock(
        lockOptions,
        async context => {
          await expect(directorBrain.withDirectorBrainMigrationLock(
            { ...lockOptions, lockContext: context },
            async () => 'nested-ok',
          )).resolves.toBe('nested-ok')
          entered?.()
          await held
          return 'outer-ok'
        },
      )
      await acquired

      const moduleUrl = pathToFileURL(
        resolve(process.cwd(), 'scripts/lib/feishu-director-brain.mjs'),
      ).href
      const childScript = `
        const [moduleUrl, catalogPath, catalogJson] = process.argv.slice(1)
        const directorBrain = await import(moduleUrl)
        try {
          await directorBrain.withDirectorBrainMigrationLock({
            catalogPath,
            catalog: JSON.parse(catalogJson),
            fromVersion: 2,
            toVersion: 3,
            receiptSha256: 'a'.repeat(64),
          }, async () => 'unexpected')
          process.stdout.write('unexpected-success')
        } catch (error) {
          process.stdout.write(error.message)
        }
      `
      const child = await execFileAsync(process.execPath, [
        '--input-type=module',
        '-e',
        childScript,
        moduleUrl,
        catalogPath,
        JSON.stringify(catalog),
      ])
      expect(child.stdout).toBe('director_brain_migration_lock_contended')
      release?.()
      await expect(first).resolves.toBe('outer-ok')
      expect(await readdir(join(root, '.director-brain-migration-locks'))).toEqual([])
    } finally {
      release?.()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers only a receipt-bound lock whose recorded process incarnation died', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const root = await realpath(await mkdtemp(join(tmpdir(), 'director-brain-dead-lock-')))
    await chmod(root, 0o700)
    const catalogPath = join(root, 'catalog.json')
    const lockOptions = {
      catalogPath,
      catalog: {
        schemaVersion: 2,
        brainName: schema.brainName,
        projectId: schema.projectId,
        environment: schema.environment,
        appToken: 'bascn_lock_fixture',
      },
      fromVersion: 2,
      toVersion: 3,
      receiptSha256: 'b'.repeat(64),
    }
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), 'scripts/lib/feishu-director-brain.mjs'),
    ).href
    const childScript = `
      const [moduleUrl, optionsJson] = process.argv.slice(1)
      const directorBrain = await import(moduleUrl)
      await directorBrain.withDirectorBrainMigrationLock(
        JSON.parse(optionsJson),
        async () => {
          process.stdout.write('locked\\n')
          await new Promise(resolvePromise => setTimeout(resolvePromise, 60_000))
        },
      )
    `
    const child = spawn(process.execPath, [
      '--input-type=module', '-e', childScript, moduleUrl, JSON.stringify(lockOptions),
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => rejectPromise(new Error('child_lock_timeout')), 5_000)
        child.once('error', rejectPromise)
        child.stdout.once('data', chunk => {
          clearTimeout(timeout)
          if (String(chunk) !== 'locked\n') rejectPromise(new Error('child_lock_output_invalid'))
          else resolvePromise()
        })
      })
      child.kill('SIGKILL')
      await new Promise<void>(resolvePromise => child.once('exit', () => resolvePromise()))
      await expect(directorBrain.withDirectorBrainMigrationLock(
        lockOptions,
        async () => 'recovered',
      )).resolves.toBe('recovered')
      const lockRoot = join(root, '.director-brain-migration-locks')
      expect((await readdir(lockRoot)).sort()).toEqual(['.recovered-stale'])
      const recovered = await readdir(join(lockRoot, '.recovered-stale'))
      expect(recovered).toHaveLength(1)
      const recoveredLock = join(lockRoot, '.recovered-stale', recovered[0])
      const ownerFiles = await readdir(recoveredLock)
      expect(ownerFiles).toHaveLength(1)
      const owner = JSON.parse(await readFile(join(recoveredLock, ownerFiles[0]), 'utf8'))
      expect(owner).toMatchObject({ uid: process.getuid?.() })
      expect(owner.processIncarnation).not.toContain('bascn_lock_fixture')
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps a live migration owner locked across caller timezone and locale differences', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const root = await realpath(await mkdtemp(join(tmpdir(), 'director-brain-live-lock-locale-')))
    await chmod(root, 0o700)
    const lockOptions = {
      catalogPath: join(root, 'catalog.json'),
      catalog: {
        schemaVersion: 2,
        brainName: schema.brainName,
        projectId: schema.projectId,
        environment: schema.environment,
        appToken: 'bascn_live_locale_fixture',
      },
      fromVersion: 2,
      toVersion: 3,
      receiptSha256: 'd'.repeat(64),
    }
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), 'scripts/lib/feishu-director-brain.mjs'),
    ).href
    const ownerScript = `
      const [moduleUrl, optionsJson] = process.argv.slice(1)
      const directorBrain = await import(moduleUrl)
      await directorBrain.withDirectorBrainMigrationLock(
        JSON.parse(optionsJson),
        async () => {
          process.stdout.write('locked\\n')
          await new Promise(resolvePromise => setTimeout(resolvePromise, 60_000))
        },
      )
    `
    const contenderScript = `
      const [moduleUrl, optionsJson] = process.argv.slice(1)
      const directorBrain = await import(moduleUrl)
      try {
        await directorBrain.withDirectorBrainMigrationLock(
          JSON.parse(optionsJson), async () => 'unexpected',
        )
        process.stdout.write('unexpected-success')
      } catch (error) {
        process.stdout.write(error.message)
      }
    `
    const owner = spawn(process.execPath, [
      '--input-type=module', '-e', ownerScript, moduleUrl, JSON.stringify(lockOptions),
    ], {
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => rejectPromise(new Error('child_lock_timeout')), 5_000)
        owner.once('error', rejectPromise)
        owner.stdout.once('data', chunk => {
          clearTimeout(timeout)
          if (String(chunk) !== 'locked\n') rejectPromise(new Error('child_lock_output_invalid'))
          else resolvePromise()
        })
      })
      const contender = await execFileAsync(process.execPath, [
        '--input-type=module', '-e', contenderScript, moduleUrl, JSON.stringify(lockOptions),
      ], {
        env: { ...process.env, LC_ALL: 'zh_CN.UTF-8', TZ: 'America/New_York' },
      })
      expect(contender.stdout).toBe('director_brain_migration_lock_contended')
      const otherReceipt = await execFileAsync(process.execPath, [
        '--input-type=module', '-e', contenderScript, moduleUrl,
        JSON.stringify({ ...lockOptions, receiptSha256: 'f'.repeat(64) }),
      ])
      expect(otherReceipt.stdout).toBe('director_brain_migration_lock_contended')
      expect(owner.exitCode).toBeNull()
    } finally {
      if (owner.exitCode === null) owner.kill('SIGKILL')
      await new Promise<void>(resolvePromise => {
        if (owner.exitCode !== null) resolvePromise()
        else owner.once('exit', () => resolvePromise())
      })
      await rm(root, { recursive: true, force: true })
    }
  })

  it('serializes high-contention stale recovery without moving a successor lock', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const root = await realpath(await mkdtemp(join(tmpdir(), 'director-brain-recovery-race-')))
    await chmod(root, 0o700)
    const markerPath = join(root, 'critical.marker')
    const lockOptions = {
      catalogPath: join(root, 'catalog.json'),
      catalog: {
        schemaVersion: 2,
        brainName: schema.brainName,
        projectId: schema.projectId,
        environment: schema.environment,
        appToken: 'bascn_recovery_race_fixture',
      },
      fromVersion: 2,
      toVersion: 3,
      receiptSha256: 'e'.repeat(64),
    }
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), 'scripts/lib/feishu-director-brain.mjs'),
    ).href
    const ownerScript = `
      const [moduleUrl, optionsJson] = process.argv.slice(1)
      const directorBrain = await import(moduleUrl)
      await directorBrain.withDirectorBrainMigrationLock(
        JSON.parse(optionsJson), async () => {
          process.stdout.write('locked\\n')
          await new Promise(resolvePromise => setTimeout(resolvePromise, 60_000))
        },
      )
    `
    const contenderScript = `
      const [moduleUrl, optionsJson, markerPath, contenderId, startAt] = process.argv.slice(1)
      const { writeFile, unlink } = await import('node:fs/promises')
      const directorBrain = await import(moduleUrl)
      while (Date.now() < Number(startAt)) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 2))
      }
      try {
        await directorBrain.withDirectorBrainMigrationLock(
          JSON.parse(optionsJson), async () => {
            try {
              await writeFile(markerPath, contenderId, { flag: 'wx' })
            } catch (error) {
              if (error.code === 'EEXIST') {
                process.stdout.write('overlap:' + contenderId)
                return
              }
              throw error
            }
            await new Promise(resolvePromise => setTimeout(resolvePromise, 200))
            await unlink(markerPath)
            process.stdout.write('entered:' + contenderId)
          },
        )
      } catch (error) {
        process.stdout.write('error:' + error.message)
      }
    `
    const owner = spawn(process.execPath, [
      '--input-type=module', '-e', ownerScript, moduleUrl, JSON.stringify(lockOptions),
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    try {
      await new Promise<void>((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => rejectPromise(new Error('child_lock_timeout')), 5_000)
        owner.once('error', rejectPromise)
        owner.stdout.once('data', chunk => {
          clearTimeout(timeout)
          if (String(chunk) !== 'locked\n') rejectPromise(new Error('child_lock_output_invalid'))
          else resolvePromise()
        })
      })
      owner.kill('SIGKILL')
      await new Promise<void>(resolvePromise => owner.once('exit', () => resolvePromise()))
      const startAt = Date.now() + 250
      const contenders = Array.from({ length: 12 }, (_, index) => spawn(process.execPath, [
        '--input-type=module', '-e', contenderScript, moduleUrl,
        JSON.stringify(lockOptions), markerPath, String(index), String(startAt),
      ], { stdio: ['ignore', 'pipe', 'pipe'] }))
      const outputs = await Promise.all(contenders.map(async child => {
        const exited = new Promise<void>((resolvePromise, rejectPromise) => {
          child.once('error', rejectPromise)
          child.once('close', () => resolvePromise())
        })
        let output = ''
        for await (const chunk of child.stdout) output += String(chunk)
        await exited
        return output
      }))
      expect(outputs.some(output => output.startsWith('entered:'))).toBe(true)
      expect(outputs.some(output => output.startsWith('overlap:'))).toBe(false)
      expect(outputs.every(output => (
        output.startsWith('entered:')
        || output === 'error:director_brain_migration_lock_contended'
      ))).toBe(true)
      const recoveryRoot = join(root, '.director-brain-migration-locks', '.recovered-stale')
      expect(await readdir(recoveryRoot)).toHaveLength(1)
    } finally {
      if (owner.exitCode === null) owner.kill('SIGKILL')
      await rm(root, { recursive: true, force: true })
    }
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
      writeStandaloneReleaseAttestations: (root: string) => Promise<unknown>
    }
    const root = await mkdtemp(join(tmpdir(), 'video-autoworker-standalone-minimal-'))
    try {
      await prepareRequiredStandaloneFixture(root)
      await mkdir(join(root, '.next', 'server', 'app', 'api', 'webhooks', 'test'), { recursive: true })
      await mkdir(join(root, '.next', 'server', 'app', 'docs'), { recursive: true })
      await mkdir(join(root, 'node_modules', 'legal-package', 'test'), { recursive: true })
      await writeFile(join(root, 'node_modules', 'legal-package', 'test', 'fixture.db'), 'fixture\n')
      await writeFile(join(root, 'node_modules', 'legal-package', 'debug.log'), 'fixture\n')
      await artifactAudit.writeStandaloneReleaseAttestations(root)

      await expect(artifactAudit.findForbiddenStandaloneMembers(root)).resolves.toEqual([])
      await expect(artifactAudit.auditStandaloneArtifact(root)).resolves.toMatchObject({
        ok: true,
        root,
        forbiddenMembers: 0,
        importClosure: { dynamicDependencies: 28 },
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('declares shared security helpers in the standalone include and contract lists', async () => {
    const nextConfig = await readFile(resolve(process.cwd(), 'next.config.js'), 'utf8')
    const artifactChecker = await readFile(resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs'), 'utf8')
    for (const helper of [
      'scripts/lib/openclaw-secret-reference.mjs',
      'scripts/lib/openclaw-private-gateway-rpc.mjs',
      'scripts/lib/openclaw-runtime-convergence.mjs',
      'scripts/lib/render-managed-markdown-section.mjs',
      'scripts/lib/runtime-tree-manifest.mjs',
      'scripts/lib/sensitive-value-scanner.mjs',
    ]) {
      expect(nextConfig).toContain(`'./${helper}'`)
      expect(artifactChecker.split(helper).length - 1).toBeGreaterThanOrEqual(2)
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
      await expect(artifactAudit.auditStandaloneArtifact(root)).resolves.toMatchObject({
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
      writeStandaloneReleaseAttestations: (root: string) => Promise<unknown>
    }
    const root = await mkdtemp(join(tmpdir(), 'video-autoworker-standalone-manifest-'))
    const incomplete = await mkdtemp(join(tmpdir(), 'video-autoworker-standalone-incomplete-'))
    try {
      await writeFile(join(incomplete, 'server.js'), 'export {}\n')
      await expect(artifactAudit.auditStandaloneArtifact(incomplete))
        .rejects.toThrow('standalone_required_file_missing:.next/BUILD_ID')

      await prepareRequiredStandaloneFixture(root)
      await artifactAudit.writeStandaloneReleaseAttestations(root)
      await expect(artifactAudit.auditStandaloneArtifact(root)).resolves.toMatchObject({ ok: true })

      const favicon = join(root, 'public', 'favicon.ico')
      const originalMode = (await stat(favicon)).mode & 0o777
      await chmod(favicon, originalMode === 0o600 ? 0o644 : 0o600)
      await expect(artifactAudit.verifyStandaloneReleaseManifest(root))
        .rejects.toThrow('standalone_release_provenance_artifact_mismatch')

      await writeFile(join(root, 'public', 'favicon.ico'), 'changed after build\n')
      await expect(artifactAudit.writeStandaloneReleaseManifest(root))
        .rejects.toThrow('standalone_release_provenance_artifact_mismatch')
      await expect(artifactAudit.verifyStandaloneReleaseManifest(root))
        .rejects.toThrow('standalone_release_provenance_artifact_mismatch')
    } finally {
      await rm(root, { recursive: true, force: true })
      await rm(incomplete, { recursive: true, force: true })
    }
  })

  it('fails closed when the standalone sensitive narrative filter is missing or drifts', async () => {
    const modulePath = resolve(process.cwd(), 'scripts/check-standalone-artifact.mjs')
    const artifactAudit = await import(/* @vite-ignore */ pathToFileURL(modulePath).href) as {
      auditStandaloneArtifact: (root: string) => Promise<unknown>
      verifyStandaloneReleaseManifest: (root: string) => Promise<unknown>
      writeStandaloneReleaseAttestations: (root: string) => Promise<unknown>
    }
    const root = await mkdtemp(join(tmpdir(), 'video-autoworker-sensitive-narrative-'))
    const member = join(
      root,
      'openclaw-plugins/aiworker-director-brain/lib/sensitive-narrative-text.js',
    )
    try {
      await prepareRequiredStandaloneFixture(root)
      await rm(member)
      await expect(artifactAudit.auditStandaloneArtifact(root))
        .rejects.toThrow(
          'standalone_required_file_missing:openclaw-plugins/aiworker-director-brain/lib/sensitive-narrative-text.js',
        )

      await prepareRequiredStandaloneFixture(root)
      await artifactAudit.writeStandaloneReleaseAttestations(root)
      await writeFile(member, 'export const containsSensitiveNarrativeValue = () => false\n')
      await expect(artifactAudit.verifyStandaloneReleaseManifest(root))
        .rejects.toThrow('standalone_release_provenance_artifact_mismatch')
    } finally {
      await rm(root, { recursive: true, force: true })
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

  it('builds server-side learning filters and follows only the bounded page-token window', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const table = schema.tables.find(item => item.key === 'people_profiles')!
    const filter = directorBrain.learningContextCandidateFilter({
      table,
      projectId: schema.projectId,
      workId: 'WORK-ICE-001',
      terms: ['风险', '选择'],
    })
    expect(filter).toContain('CurrentValue.[项目 ID]="PROJ-VIDEO-AUTOWORKER"')
    expect(filter).toContain('CurrentValue.[作品 ID]="WORK-ICE-001"')
    expect(filter).toContain('CurrentValue.[状态]="已确认"')
    expect(filter).toContain('SEARCH("风险",CurrentValue.[人物名称])>0')
    const escaped = directorBrain.learningContextCandidateFilter({
      table,
      projectId: schema.projectId,
      workId: 'WORK-ICE-001',
      terms: ['风"险\\测试'],
    })
    expect(escaped).toContain('SEARCH("风\\"险\\\\测试",CurrentValue.[人物名称])>0')
    const unfiltered = directorBrain.learningContextCandidateFilter({
      table,
      projectId: schema.projectId,
      workId: 'WORK-ICE-001',
      terms: [],
    })
    expect(unfiltered).not.toContain('SEARCH(')
    expect(filter).not.toContain('CurrentValue.[置信度]')

    const requester = vi.fn(async (_method: unknown, _path: unknown, options: any) => (
      options.query.page_token
        ? { data: { items: [{ record_id: 'rec_51', fields: {} }], has_more: true, page_token: '<fixture-page-3>' } }
        : {
            data: {
              items: Array.from({ length: 50 }, (_, index) => ({
                record_id: `rec_${index + 1}`, fields: {},
              })),
              has_more: true,
              page_token: '<fixture-page-2>',
            },
          }
    ))
    const result = await directorBrain.queryLearningCandidates({
      context: {
        schema,
        catalog: { appToken: 'environment', tables: { people_profiles: { tableId: 'table' } } },
        accessToken: 'token',
      },
      table,
      tableId: 'table',
      workId: 'WORK-ICE-001',
      terms: ['风险'],
      limit: 8,
    }, requester)
    expect(result).toMatchObject({ requestCount: 2, truncated: true })
    expect(result.records).toHaveLength(51)
    expect(requester).toHaveBeenCalledTimes(2)
    expect((requester.mock.calls[1][2] as any).query.page_token).toBe('<fixture-page-2>')
    expect((requester.mock.calls[0][2] as any).query.sort).toBe('["更新时间 DESC"]')
  })

  it('batches stable-ID closure reads without one request per reference', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const table = schema.tables.find(item => item.key === 'material_evidence')!
    const requester = vi.fn(async () => ({ data: { items: [], has_more: false } }))
    const result = await directorBrain.findManyOperationRecords({
      context: { catalog: { appToken: 'environment' }, accessToken: 'token' },
      table,
      tableId: 'table',
      stableIds: Array.from({ length: 45 }, (_, index) => `EVIDENCE-${index}`),
    }, requester)
    expect(result).toEqual({ records: [], requestCount: 3 })
    expect(requester).toHaveBeenCalledTimes(3)
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

  it('resolves controlled series-season-episode names and still fails closed on alias collision', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const works = [
      {
        record_id: 'rec_series_earth',
        fields: {
          '作品名称': '地球之极', '作品 ID': 'WORK-EARTH',
          '项目 ID': schema.projectId, '别名': '地球极境', '作品类型': '纪录片',
          '作品层级': '系列', '系列 ID': 'WORK-EARTH', '状态': '生效',
          ...reviewedMetadata(),
        },
      },
      {
        record_id: 'rec_season_earth_1',
        fields: {
          '作品名称': '第一季', '作品 ID': 'WORK-EARTH-S01',
          '项目 ID': schema.projectId, '别名': 'S01', '作品类型': '纪录片季',
          '作品层级': '季', '父作品 ID': 'WORK-EARTH', '系列 ID': 'WORK-EARTH',
          '季序号': 1, '状态': '生效', ...reviewedMetadata(),
        },
      },
      {
        record_id: 'rec_episode_earth_1',
        fields: {
          '作品名称': '高原生命', '作品 ID': 'WORK-EARTH-S01E01',
          '项目 ID': schema.projectId, '别名': '首集', '作品类型': '纪录片单集',
          '作品层级': '集', '父作品 ID': 'WORK-EARTH-S01',
          '系列 ID': 'WORK-EARTH', '季 ID': 'WORK-EARTH-S01', '集序号': 1,
          '状态': '生效', ...reviewedMetadata(),
        },
      },
    ]
    const harness = operationHarness(schema, { works })

    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'resolve_work', query: '地球之极 第一季 第一集',
    }, harness.options)).resolves.toMatchObject({
      found: true,
      work: {
        workId: 'WORK-EARTH-S01E01',
        hierarchy: {
          level: '集', parentWorkId: 'WORK-EARTH-S01',
          seriesId: 'WORK-EARTH', seasonId: 'WORK-EARTH-S01', episodeNumber: 1,
        },
      },
    })
    expect(directorBrain.normalizeDirectorWorkTitle('地球之极 S01E01'))
      .toBe(directorBrain.normalizeDirectorWorkTitle('地球之极 第一季 第一集'))

    harness.records.get('works')?.push({
      record_id: 'rec_episode_alias_collision',
      fields: {
        '作品名称': '另一集', '作品 ID': 'WORK-EARTH-COLLISION',
        '项目 ID': schema.projectId, '别名': '地球之极 第一季 第一集',
        '作品类型': '纪录片单集', '作品层级': '独立作品', '状态': '生效',
        ...reviewedMetadata(),
      },
    })
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'resolve_work', query: '地球之极第一季第一集',
    }, harness.options)).rejects.toThrow('work_resolution_ambiguous')
  })

  it('creates hierarchy links from reviewed parents without trusting caller-owned IDs', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const series = {
      record_id: 'rec_series_parent',
      fields: {
        '作品名称': '地球之极', '作品 ID': 'WORK-EARTH', '项目 ID': schema.projectId,
        '作品类型': '纪录片系列', '作品层级': '系列', '系列 ID': 'WORK-EARTH',
        '状态': '生效', ...reviewedMetadata(),
      },
    }
    const harness = operationHarness(schema, { works: [series] })
    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'propose', table: 'works',
      fields: {
        '作品名称': '地球之极 第一季', '别名': '《地球之极 第一季》\n地球之极 S01',
        '作品类型': '纪录片季', '作品层级': '季', '季序号': 1,
      },
      references: { parentWorkId: 'WORK-EARTH' },
    }, harness.options)

    expect(result).toMatchObject({
      outcome: 'created',
      record: { fields: {
        '作品层级': '季', '父作品 ID': 'WORK-EARTH', '系列 ID': 'WORK-EARTH',
        '季序号': 1, '别名': '地球之极 第一季\n地球之极 S01',
      } },
    })
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose', table: 'works',
      fields: {
        '作品名称': '错误单集', '作品类型': '纪录片单集', '作品层级': '集', '集序号': 1,
      },
      references: { parentWorkId: 'WORK-EARTH' },
    }, harness.options)).rejects.toThrow('work_parent_level_invalid:集')
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
      learningReadiness: { cases: true, techniques: false, complete: false },
      caseCount: { total: 1, reviewed: 1, candidates: 0 },
      techniqueCount: { total: 0, reviewed: 0, candidates: 0 },
      stageCounts: {
        perception: { total: 1, reviewed: 1, candidates: 0 },
        cases: { total: 1, reviewed: 1, candidates: 0 },
        techniques: { total: 0, reviewed: 0, candidates: 0 },
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

  it('builds one deterministic learning context from isolated work history and reviewed project knowledge', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const initial = reviewedFoundation()
    initial.people_profiles = [
      {
        record_id: 'rec_person_reviewed',
        fields: {
          '人物名称': '阿明', '人物版本 ID': 'PEOPLE-REVIEWED-001', '人物 ID': 'PERSON-AMING',
          '项目 ID': schema.projectId, '作品 ID': 'WORK-ICE-001',
          '证据 ID': 'EVIDENCE-REVIEWED-001', '置信度': 0.92, '状态': '已确认',
          ...reviewedMetadata(),
        },
      },
      {
        record_id: 'rec_person_candidate',
        fields: {
          '人物名称': '未审核人物', '人物版本 ID': 'PEOPLE-CANDIDATE-001', '人物 ID': 'PERSON-DRAFT',
          '项目 ID': schema.projectId, '作品 ID': 'WORK-ICE-001',
          '证据 ID': 'EVIDENCE-REVIEWED-001', '置信度': 0.5, '状态': '候选',
          ...reviewedMetadata(),
        },
      },
      {
        record_id: 'rec_person_other_work',
        fields: {
          '人物名称': '另一作品人物', '人物版本 ID': 'PEOPLE-OTHER-001', '人物 ID': 'PERSON-OTHER',
          '项目 ID': schema.projectId, '作品 ID': 'WORK-DESERT-001',
          '证据 ID': 'EVIDENCE-DESERT-001', '置信度': 0.9, '状态': '已确认',
          ...reviewedMetadata(),
        },
      },
    ]
    initial.story_relations = [{
      record_id: 'rec_relation_reviewed',
      fields: {
        '关系名称': '裂缝促成绕行', '关系 ID': 'RELATION-REVIEWED-001',
        '项目 ID': schema.projectId, '作品 ID': 'WORK-ICE-001',
        '源节点 ID': 'STORY-REVIEWED-001', '目标节点 ID': 'STORY-REVIEWED-002',
        '证据 ID': 'EVIDENCE-REVIEWED-001', '关系类型': '因果',
        '判断理由': '发现裂缝后人物决定绕行', '置信度': 0.9, '状态': '已确认',
        ...reviewedMetadata(),
      },
    }]
    initial.narrative_plans = [{
      record_id: 'rec_plan_reviewed',
      fields: {
        '方案名称': '裂缝叙事方案', '方案 ID': 'PLAN-REVIEWED-001',
        '项目 ID': schema.projectId, '作品 ID': 'WORK-ICE-001',
        '意图版本 ID': 'INTENT-REVIEWED-001',
        '节点 ID': 'STORY-REVIEWED-001\nSTORY-REVIEWED-002',
        '证据 ID': 'EVIDENCE-REVIEWED-001',
        '人物线': '阿明从独断到协作', '事件线': '发现裂缝后共同绕行',
        '时间线': '发现、停顿、决定', '地点线': '冰面裂缝前后',
        '情绪线': '平静转为紧张', '主题线': '风险中的共同选择',
        '冲突线': '继续前进与安全绕行', '结构说明': '以裂缝事件形成转折',
        '故事脚本': '人物发现裂缝后停下，并与同伴选择绕行。',
        '状态': '已批准', ...reviewedMetadata(),
      },
    }]
    initial.works.push({
      record_id: 'rec_work_desert',
      fields: {
        '作品名称': '荒漠纪事', '作品 ID': 'WORK-DESERT-001',
        '项目 ID': schema.projectId, '作品类型': '纪录片', '状态': '生效',
        ...reviewedMetadata(),
      },
    })
    initial.director_intents.push({
      record_id: 'rec_intent_desert',
      fields: {
        ...completeIntentFields({ '意图名称': '荒漠风险意图' }),
        '意图版本 ID': 'INTENT-DESERT-001', '项目 ID': schema.projectId,
        '作品 ID': 'WORK-DESERT-001', '状态': '生效', ...reviewedMetadata(),
      },
    })
    initial.material_evidence.push({
      record_id: 'rec_evidence_desert',
      fields: {
        '证据名称': '沙暴前停顿', '证据 ID': 'EVIDENCE-DESERT-001',
        '项目 ID': schema.projectId, '作品 ID': 'WORK-DESERT-001',
        '任务 ID': 'TASK-DESERT', '素材 ID': 'MATERIAL-DESERT',
        '场景 ID': 'SCENE-DESERT', '镜头 ID': 'SHOT-DESERT',
        '起始时间码': '00:00:05.000', '结束时间码': '00:00:09.000',
        '证据摘要': '人物在沙暴来临前停止前进', '校验摘要': 'b'.repeat(64),
        '分析版本': 'analysis-v1', '置信度': 0.9, '状态': '已核验',
        ...reviewedMetadata(),
      },
    })
    initial.material_judgments.push({
      record_id: 'rec_judgment_desert',
      fields: {
        '判断名称': '沙暴停顿价值', '判断 ID': 'JUDGMENT-DESERT-001',
        '项目 ID': schema.projectId, '作品 ID': 'WORK-DESERT-001',
        '证据 ID': 'EVIDENCE-DESERT-001', '意图版本 ID': 'INTENT-DESERT-001',
        '故事价值': 88, '人物价值': 87, '情绪价值': 86, '信息价值': 80,
        '视觉价值': 85, '稀缺性': 83, '叙事价值': 89,
        '使用理由': '停顿显出人物面对风险的选择', '置信度': 0.9,
        '状态': '已确认', ...reviewedMetadata(),
      },
    })
    initial.director_cases.push(
      {
        record_id: 'rec_case_desert',
        fields: {
          '案例名称': '沙暴前停顿案例', '案例 ID': 'CASE-DESERT-001',
          '项目 ID': schema.projectId, '作品 ID': 'WORK-DESERT-001',
          '判断 ID': 'JUDGMENT-DESERT-001', '证据 ID': 'EVIDENCE-DESERT-001',
          '上下文': '沙暴将至且人物尚未决定路线', '导演动作': '采用',
          '判断原因': '停顿把风险转成可见的人物选择',
          ...completeDirectorCaseOutcomeFields({ '成片位置': '沙暴来临前' }),
          '复核状态': '已确认',
          ...reviewedMetadata(),
        },
      },
      {
        record_id: 'rec_case_candidate',
        fields: {
          '案例名称': '未审核案例', '案例 ID': 'CASE-CANDIDATE-001',
          '项目 ID': schema.projectId, '作品 ID': 'WORK-ICE-001',
          '判断 ID': 'JUDGMENT-REVIEWED-001', '证据 ID': 'EVIDENCE-REVIEWED-001',
          '上下文': '尚未复核', '导演动作': '待定', '判断原因': '尚未复核',
          '复核状态': '待复核', ...reviewedMetadata(),
        },
      },
    )
    initial.skills_techniques = [{
      record_id: 'rec_skill_reviewed',
      fields: {
        '知识名称': '风险决定前保留停顿', '知识 ID': 'SKILL-REVIEWED-001',
        '项目 ID': schema.projectId, '作用域': '跨作品',
        '来源作品 ID': 'WORK-DESERT-001\nWORK-ICE-001',
        '案例 ID': 'CASE-DESERT-001\nCASE-REVIEWED-001',
        '知识类型': '技法', '知识分类': '人物选择',
        '适用条件': '人物面对风险并即将决定路线', '执行方法': '保留观察和停顿',
        '为什么有效': '让环境压力转化为人物选择', '置信度': 0.91,
        '状态': '已验证', ...reviewedMetadata(),
      },
    }]
    const harness = operationHarness(schema, initial)

    const first = await directorBrain.executeDirectorBrainOperation({
      action: 'learning_context', workId: 'WORK-ICE-001', phase: 'judgment', objective: '风险选择',
    }, harness.options)
    expect(first).toMatchObject({
      ok: true,
      action: 'learning_context',
      workId: 'WORK-ICE-001',
      digest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      snapshot: {
        work: {
          activeIntent: { stableId: 'INTENT-REVIEWED-001', reviewed: true },
          people_profiles: [{ stableId: 'PEOPLE-REVIEWED-001' }],
          story_nodes: [{ stableId: 'STORY-REVIEWED-001' }, { stableId: 'STORY-REVIEWED-002' }],
          story_relations: [{ stableId: 'RELATION-REVIEWED-001' }],
          narrative_plans: [{ stableId: 'PLAN-REVIEWED-001' }],
        },
        project: {
          director_cases: [],
          skills_techniques: [{ stableId: 'SKILL-REVIEWED-001' }],
        },
      },
    })
    expect(JSON.stringify(first)).not.toMatch(
      /"record_id"|PEOPLE-OTHER-001|PEOPLE-CANDIDATE-001|CASE-CANDIDATE-001|"appToken"|"tableId"|"catalogPath"/u,
    )
    for (const records of harness.records.values()) records.reverse()
    const second = await directorBrain.executeDirectorBrainOperation({
      action: 'learning_context', workId: 'WORK-ICE-001', phase: 'judgment', objective: '风险选择',
    }, harness.options)
    expect(second).toEqual(first)
    expect(harness.createCalls).toHaveLength(0)
    expect(harness.updateCalls).toHaveLength(0)
  })

  it('excludes historical confirmed cases with incomplete human outcomes from technique learning', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const initial = reviewedFoundation()
    delete initial.director_cases[0].fields['最终效果']
    initial.skills_techniques = [{
      record_id: 'rec_skill_incomplete_case',
      fields: {
        '知识名称': '不应学习的不完整案例技法',
        '知识 ID': 'SKILL-INCOMPLETE-CASE-001',
        '项目 ID': schema.projectId,
        '作用域': '跨作品',
        '来源作品 ID': 'WORK-ICE-001',
        '案例 ID': 'CASE-REVIEWED-001',
        '知识类型': '技法',
        '知识分类': '人物选择',
        '适用条件': '人物面对风险',
        '执行方法': '保留停顿',
        '为什么有效': '让选择可见',
        '置信度': 0.9,
        '状态': '已验证',
        ...reviewedMetadata(),
      },
    }]

    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'learning_context', workId: 'WORK-ICE-001',
      phase: 'judgment', objective: '风险选择',
    }, operationHarness(schema, initial).options)

    expect(result).toMatchObject({
      snapshot: {
        work: { director_cases: [] },
        project: { director_cases: [], skills_techniques: [] },
      },
    })
  })

  it('excludes historical confirmed cases whose final-use decision is still pending', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const initial = reviewedFoundation()
    initial.director_cases[0].fields['最终使用'] = '待确认'
    initial.skills_techniques = [{
      record_id: 'rec_skill_pending_case',
      fields: {
        '知识名称': '不应学习的待确认案例技法',
        '知识 ID': 'SKILL-PENDING-CASE-001',
        '项目 ID': schema.projectId,
        '作用域': '跨作品',
        '来源作品 ID': 'WORK-ICE-001',
        '案例 ID': 'CASE-REVIEWED-001',
        '知识类型': '技法',
        '知识分类': '人物选择',
        '适用条件': '人物面对风险',
        '执行方法': '保留停顿',
        '为什么有效': '让选择可见',
        '置信度': 0.9,
        '状态': '已验证',
        ...reviewedMetadata(),
      },
    }]

    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'learning_context', workId: 'WORK-ICE-001',
      phase: 'judgment', objective: '风险选择',
    }, operationHarness(schema, initial).options)

    expect(result).toMatchObject({
      snapshot: {
        work: { director_cases: [] },
        project: { director_cases: [], skills_techniques: [] },
      },
    })
  })

  it('selects relevant heads from a mature case library with bounded queries and one batched closure', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const initial = reviewedFoundation()
    const baseCase = structuredClone(initial.director_cases[0])
    initial.director_cases.push(...Array.from({ length: 300 }, (_, index) => ({
      ...structuredClone(baseCase),
      record_id: `rec_mature_case_${index}`,
      fields: {
        ...structuredClone(baseCase.fields),
        '案例名称': `无关的日常观察案例 ${index}`,
        '案例 ID': `CASE-MATURE-${String(index).padStart(3, '0')}`,
        '上下文': '与当前风险选择主题无关的日常观察',
        '判断原因': '仅用于成熟案例库分页测试',
      },
    })))
    initial.skills_techniques = [{
      record_id: 'rec_skill_relevant',
      fields: {
        '知识名称': '风险选择前保留停顿', '知识 ID': 'SKILL-RISK-001',
        '项目 ID': schema.projectId, '作用域': '跨作品', '来源作品 ID': 'WORK-ICE-001',
        '案例 ID': 'CASE-REVIEWED-001', '知识类型': '技法', '知识分类': '人物选择',
        '适用条件': '人物面对风险并即将选择', '执行方法': '保留停顿',
        '为什么有效': '让风险成为可见的选择', '置信度': 0.91,
        '状态': '已验证', ...reviewedMetadata(),
      },
    }, ...Array.from({ length: 300 }, (_, index) => ({
      record_id: `rec_mature_skill_${index}`,
      fields: {
        '知识名称': `${index < 20 ? '风险' : ''}日常观察技法 ${index}`,
        '知识 ID': `SKILL-MATURE-${String(index).padStart(3, '0')}`,
        '项目 ID': schema.projectId, '作用域': '跨作品', '来源作品 ID': 'WORK-ICE-001',
        '案例 ID': 'CASE-REVIEWED-001', '知识类型': '技法', '知识分类': '日常',
        '适用条件': '平静的生活场景', '执行方法': '保持观察',
        '为什么有效': '保留生活质感', '置信度': 0.8,
        '状态': '已验证', ...reviewedMetadata({
          '更新时间': index < 20 ? REVIEWED_AT + 1_000 : REVIEWED_AT,
        }),
      },
    }))]
    const harness = operationHarness(schema, initial)
    harness.options.dependencies.listAll = async () => { throw new Error('list_all_forbidden') }
    harness.options.dependencies.findExact = async () => { throw new Error('n_plus_one_forbidden') }

    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'learning_context',
      workId: 'WORK-ICE-001',
      phase: 'judgment',
      objective: '寻找人物面对风险时的选择',
    }, harness.options)

    const selectedTechniques = (result.snapshot as any).project.skills_techniques
    expect(selectedTechniques).toHaveLength(8)
    expect(selectedTechniques.map((record: any) => record.stableId)).toContain('SKILL-RISK-001')
    expect(harness.learningQueryCalls.length).toBeLessThanOrEqual(14)
    expect(harness.learningFindManyCalls.length).toBeLessThanOrEqual(8)
    expect(harness.learningFindManyCalls.some(call => (
      call.table === 'director_cases'
        && Array.isArray(call.stableIds)
        && call.stableIds.includes('CASE-REVIEWED-001')
    ))).toBe(true)
  })

  it('excludes reviewed learning records whose source chain is broken', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const initial = reviewedFoundation()
    initial.material_judgments[0].fields['证据 ID'] = 'EVIDENCE-MISSING-001'
    initial.skills_techniques = [{
      record_id: 'rec_skill_broken',
      fields: {
        '知识名称': '断链技法', '知识 ID': 'SKILL-BROKEN-001',
        '项目 ID': schema.projectId, '作用域': '跨作品', '来源作品 ID': 'WORK-ICE-001',
        '案例 ID': 'CASE-REVIEWED-001', '知识类型': '技法', '知识分类': '测试',
        '适用条件': '测试', '执行方法': '测试', '为什么有效': '测试', '置信度': 0.8,
        '状态': '已验证', ...reviewedMetadata(),
      },
    }]
    const harness = operationHarness(schema, initial)
    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'learning_context', workId: 'WORK-ICE-001', phase: 'judgment', objective: '风险选择',
    }, harness.options)
    expect(result).toMatchObject({
      snapshot: {
        work: { material_judgments: [], director_cases: [] },
        project: { director_cases: [], skills_techniques: [] },
      },
    })
  })

  it('excludes a work-scoped learning record whose reference crosses into another work', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const initial = reviewedFoundation()
    initial.material_evidence.push({
      ...structuredClone(initial.material_evidence[0]),
      record_id: 'rec_evidence_other_work',
      fields: {
        ...structuredClone(initial.material_evidence[0].fields),
        '证据名称': '其他作品的风险证据',
        '证据 ID': 'EVIDENCE-OTHER-WORK-001',
        '作品 ID': 'WORK-OTHER-001',
      },
    })
    initial.story_nodes[0].fields['证据 ID'] = 'EVIDENCE-OTHER-WORK-001'
    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'learning_context',
      workId: 'WORK-ICE-001',
      phase: 'understanding',
      objective: '风险选择',
    }, operationHarness(schema, initial).options)

    expect(result).toMatchObject({
      snapshot: {
        work: {
          story_nodes: [{ stableId: 'STORY-REVIEWED-002' }],
        },
      },
    })
  })

  it('does not scan or fail on more than 200 evidence rows and rejects extra request fields', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const tooMany = reviewedFoundation()
    tooMany.material_evidence.push(...Array.from({ length: 240 }, (_, index) => ({
      ...structuredClone(tooMany.material_evidence[0]),
      record_id: `rec_long_video_evidence_${index}`,
      fields: {
        ...structuredClone(tooMany.material_evidence[0].fields),
        '证据 ID': `EVIDENCE-LONG-${String(index).padStart(3, '0')}`,
      },
    })))
    const longVideoHarness = operationHarness(schema, tooMany)
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'learning_context', workId: 'WORK-ICE-001', phase: 'judgment', objective: '风险选择',
    }, longVideoHarness.options)).resolves.toMatchObject({ ok: true })
    expect(longVideoHarness.learningQueryCalls.some(call => call.table === 'material_evidence')).toBe(false)
    expect(longVideoHarness.learningFindManyCalls
      .filter(call => call.table === 'material_evidence')
      .flatMap(call => call.stableIds)).toEqual(['EVIDENCE-REVIEWED-001'])

    const wrongProject = reviewedFoundation()
    wrongProject.director_cases.push({
      ...structuredClone(wrongProject.director_cases[0]),
      record_id: 'rec_case_wrong_project',
      fields: {
        ...structuredClone(wrongProject.director_cases[0].fields),
        '案例 ID': 'CASE-WRONG-PROJECT-001', '项目 ID': 'PROJ-OTHER',
      },
    })
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'learning_context', workId: 'WORK-ICE-001', phase: 'judgment', objective: '风险选择',
    }, operationHarness(schema, wrongProject).options)).resolves.not.toMatchObject({
      snapshot: { project: { director_cases: [{ stableId: 'CASE-WRONG-PROJECT-001' }] } },
    })

    const connect = vi.fn()
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'learning_context', workId: 'WORK-ICE-001', phase: 'judgment', objective: '风险选择', extra: true,
    }, { dependencies: { connect } })).rejects.toThrow('operation_field_unexpected:extra')
    expect(connect).not.toHaveBeenCalled()
  })

  it('fails before remote closure reads when a malformed reference fan-out exceeds the request budget', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const initial = reviewedFoundation()
    initial.material_judgments[0].fields['判断名称'] = '风险选择判断'
    initial.material_judgments[0].fields['证据 ID'] = Array.from(
      { length: 720 },
      (_, index) => `E${index}`,
    ).join('\n')
    const harness = operationHarness(schema, initial)
    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'learning_context',
      workId: 'WORK-ICE-001',
      phase: 'judgment',
      objective: '风险',
    }, harness.options)).rejects.toThrow('learning_context_request_budget_exceeded')
    expect(harness.learningFindManyCalls).toHaveLength(0)
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

  it('stores reusable technique candidates globally while preserving reviewed source chains', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const initial = reviewedFoundation()
    initial.works.push({
      record_id: 'rec_work_desert',
      fields: {
        '作品名称': '荒漠纪事', '作品 ID': 'WORK-DESERT-001',
        '项目 ID': schema.projectId, '作品类型': '纪录片', '状态': '生效',
        ...reviewedMetadata(),
      },
    })
    initial.director_intents.push({
      record_id: 'rec_intent_desert',
      fields: {
        ...completeIntentFields({ '意图名称': '荒漠风险意图' }),
        '意图版本 ID': 'INTENT-DESERT-001', '项目 ID': schema.projectId,
        '作品 ID': 'WORK-DESERT-001', '状态': '生效', ...reviewedMetadata(),
      },
    })
    initial.material_evidence.push({
      record_id: 'rec_evidence_desert',
      fields: {
        '证据名称': '沙暴前停顿', '证据 ID': 'EVIDENCE-DESERT-001',
        '项目 ID': schema.projectId, '作品 ID': 'WORK-DESERT-001',
        '任务 ID': 'TASK-DESERT', '素材 ID': 'MATERIAL-DESERT',
        '场景 ID': 'SCENE-DESERT', '镜头 ID': 'SHOT-DESERT',
        '起始时间码': '00:00:05.000', '结束时间码': '00:00:09.000',
        '证据摘要': '人物在沙暴来临前停止前进', '校验摘要': 'b'.repeat(64),
        '分析版本': 'analysis-v1', '置信度': 0.9, '状态': '已核验',
        ...reviewedMetadata(),
      },
    })
    initial.material_judgments.push({
      record_id: 'rec_judgment_desert',
      fields: {
        '判断名称': '沙暴停顿价值', '判断 ID': 'JUDGMENT-DESERT-001',
        '项目 ID': schema.projectId, '作品 ID': 'WORK-DESERT-001',
        '证据 ID': 'EVIDENCE-DESERT-001', '意图版本 ID': 'INTENT-DESERT-001',
        '故事价值': 88, '人物价值': 87, '情绪价值': 86, '信息价值': 80,
        '视觉价值': 85, '稀缺性': 83, '叙事价值': 89,
        '使用理由': '停顿显出人物面对风险的选择', '置信度': 0.9,
        '状态': '已确认', ...reviewedMetadata(),
      },
    })
    initial.director_cases.push({
      record_id: 'rec_case_desert',
      fields: {
        '案例名称': '沙暴前停顿案例', '案例 ID': 'CASE-DESERT-001',
        '项目 ID': schema.projectId, '作品 ID': 'WORK-DESERT-001',
        '判断 ID': 'JUDGMENT-DESERT-001', '证据 ID': 'EVIDENCE-DESERT-001',
        '上下文': '沙暴将至且人物尚未决定路线', '导演动作': '采用',
        '判断原因': '停顿把风险转成可见的人物选择',
        ...completeDirectorCaseOutcomeFields({ '成片位置': '沙暴来临前' }),
        '复核状态': '已确认',
        ...reviewedMetadata(),
      },
    })
    const harness = operationHarness(schema, initial)

    const result = await directorBrain.executeDirectorBrainOperation({
      action: 'propose', table: 'skills_techniques',
      fields: {
        '知识名称': '风险决定前保留停顿', '知识类型': '技法', '知识分类': '人物选择',
        '适用条件': '人物面对风险并即将决定路线', '执行方法': '保留观察和停顿的连续动作',
        '为什么有效': '让环境压力转化为人物选择', '置信度': 0.91,
      },
      references: { caseIds: ['CASE-REVIEWED-001', 'CASE-DESERT-001'] },
    }, harness.options)

    expect(result).toMatchObject({
      outcome: 'created',
      record: { fields: {
        '作用域': '跨作品',
        '来源作品 ID': 'WORK-DESERT-001\nWORK-ICE-001',
        '案例 ID': 'CASE-REVIEWED-001\nCASE-DESERT-001',
        '状态': '候选',
      } },
    })
    expect((result.record as { fields: Record<string, unknown> }).fields)
      .not.toHaveProperty('作品 ID')
  })

  it('rejects a technique when a nominally reviewed case has a broken evidence chain', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const initial = reviewedFoundation()
    initial.material_judgments[0].fields['证据 ID'] = 'EVIDENCE-MISSING'
    const harness = operationHarness(schema, initial)

    await expect(directorBrain.executeDirectorBrainOperation({
      action: 'propose', table: 'skills_techniques',
      fields: {
        '知识名称': '不可建立的技法', '知识类型': '技法', '知识分类': '人物选择',
        '适用条件': '测试', '执行方法': '测试', '为什么有效': '测试', '置信度': 0.8,
      },
      references: { caseIds: ['CASE-REVIEWED-001'] },
    }, harness.options)).rejects.toThrow('technique_case_chain_incomplete')
    expect(harness.createCalls).toHaveLength(0)
  })

  it('preflights and idempotently writes one candidate stage as a batch, then reads it in bulk', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, reviewedFoundation())
    const request = {
      action: 'propose_batch', table: 'director_cases', workId: 'WORK-ICE-001',
      items: [
        {
          fields: {
            '案例名称': '保留观察停顿', '上下文': '发现裂缝但尚未决定路线',
            '导演动作': '采用', '判断原因': '停顿让风险判断可见',
          },
          references: {
            judgmentId: 'JUDGMENT-REVIEWED-001', evidenceIds: ['EVIDENCE-REVIEWED-001'],
          },
        },
        {
          fields: {
            '案例名称': '保留同伴靠近', '上下文': '主角停下后同伴进入画面',
            '导演动作': '采用', '判断原因': '靠近动作把个人风险转化为关系变化',
          },
          references: {
            judgmentId: 'JUDGMENT-REVIEWED-001', evidenceIds: ['EVIDENCE-REVIEWED-001'],
          },
        },
      ],
    }
    const created = await directorBrain.executeDirectorBrainOperation(request, harness.options)
    const replayed = await directorBrain.executeDirectorBrainOperation(request, harness.options)
    const stableIds = (created.results as Array<Record<string, unknown>>).map(result => result.stableId)
    const readback = await directorBrain.executeDirectorBrainOperation({
      action: 'get_many', table: 'director_cases', workId: 'WORK-ICE-001', stableIds,
    }, harness.options)

    expect(created).toMatchObject({ count: 2, created: 2, unchanged: 0 })
    expect(replayed).toMatchObject({ count: 2, created: 0, unchanged: 2 })
    expect(readback).toMatchObject({ count: 2, missing: [] })
    expect(harness.createCalls).toHaveLength(2)
    await expect(directorBrain.executeDirectorBrainOperation({
      ...request,
      items: [request.items[0], structuredClone(request.items[0])],
    }, harness.options)).rejects.toThrow('operation_batch_duplicate_identity:items')
  })

  it('projects legal 8K director fields losslessly only through the bounded proposal batch command', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const harness = operationHarness(schema, reviewedFoundation())
    const structure = '结构'.repeat(4_000)
    const script = '故事'.repeat(4_000)
    const request = {
      action: 'propose_batch', table: 'narrative_plans', workId: 'WORK-ICE-001',
      items: [{
        fields: {
          '方案名称': '无损长叙事',
          '人物线': '人物面对风险作出选择', '事件线': '发现裂缝后绕行',
          '时间线': '当天', '地点线': '冰原', '情绪线': '平静转紧张',
          '主题线': '判断与责任', '冲突线': '前进与安全',
          '结构说明': structure, '故事脚本': script,
        },
        references: {
          intentVersionId: 'INTENT-REVIEWED-001',
          nodeIds: ['STORY-REVIEWED-001'],
          evidenceIds: ['EVIDENCE-REVIEWED-001'],
        },
      }],
    }

    await expect(directorBrain.executeDirectorBrainOperation(request, harness.options))
      .rejects.toThrow('operation_request_too_large')
    const result = await directorBrain.runDirectorBrainCli(['propose-batch'], {
      ...harness.options,
      stdin: JSON.stringify(request),
    })
    const first = (result.results as Array<Record<string, unknown>>)[0]!
    const fields = (first.record as { fields: Record<string, unknown> }).fields
    expect(fields['结构说明']).toBe(structure)
    expect(fields['故事脚本']).toBe(script)
    expect(JSON.stringify(fields)).not.toContain('缩写')
    expect(() => directorBrain.parseDirectorBrainArgs(['propose-batch', '--table', 'narrative_plans']))
      .toThrow('propose_batch_accepts_stdin_only')
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
    for (const sensitiveValue of [
      'Bearer bearer_value_12345',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature_value_123',
      `ghu_${'U'.repeat(24)}`,
      `ghr_${'R'.repeat(24)}`,
      `github_pat_${'P'.repeat(24)}`,
      ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-'),
      'api_key=assigned-secret-12345',
      'token: assigned-token-12345',
    ]) {
      await expect(propose({ '意图名称': '敏感值', '核心主题': sensitiveValue }))
        .rejects.toThrow('sensitive_value_forbidden')
    }
    await expect(propose({
      '意图名称': '普通安全术语',
      '核心主题': '讨论 token 预算与故事的 key moment。',
    })).resolves.toMatchObject({ ok: true })
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
    await runOversized('propose-batch', 256 * 1024 + 1, 'propose_batch_stdin_too_large')
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

  it('requires all human outcome fields before confirming a director case', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    const caseFields = {
      '案例名称': '裂缝前停顿案例',
      '项目 ID': schema.projectId,
      '作品 ID': 'WORK-ICE-001',
      '判断 ID': 'JUDGMENT-REVIEWED-001',
      '证据 ID': 'EVIDENCE-REVIEWED-001',
      '上下文': '人物发现裂缝后尚未作出决定',
      '导演动作': '采用',
      '判断原因': '停顿把风险转化为人物选择',
      '复核状态': '待复核',
      ...reviewedMetadata({ '版本': 'v0.2.1' }),
    }
    const missingOutcomeCases = ['最终使用', '成片位置', '最终效果'].map((field, index) => {
      const outcomes = completeDirectorCaseOutcomeFields()
      delete (outcomes as Record<string, unknown>)[field]
      return {
        record_id: `rec_case_outcome_missing_${index}`,
        fields: {
          ...caseFields,
          '案例 ID': `CASE-OUTCOME-MISSING-${index}`,
          ...outcomes,
        },
      }
    })
    foundation.director_cases = [
      ...missingOutcomeCases,
      {
        record_id: 'rec_case_outcome_complete',
        fields: {
          ...caseFields,
          '案例 ID': 'CASE-OUTCOME-COMPLETE',
          ...completeDirectorCaseOutcomeFields(),
        },
      },
    ]
    const harness = operationHarness(schema, foundation)

    for (const [index, field] of ['最终使用', '成片位置', '最终效果'].entries()) {
      await expect(directorBrain.reviewDirectorBrainRecord({
        table: 'director_cases', stableId: `CASE-OUTCOME-MISSING-${index}`,
        workId: 'WORK-ICE-001', expectedVersion: 'v0.2.1', targetStatus: '已确认',
        reviewer: '测试导演', reason: `尝试确认缺少${field}的案例`,
      }, harness.options)).rejects.toThrow(
        `review_required_field_missing:director_cases:${field}`,
      )
    }

    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'director_cases', stableId: 'CASE-OUTCOME-COMPLETE',
      workId: 'WORK-ICE-001', expectedVersion: 'v0.2.1', targetStatus: '已确认',
      reviewer: '测试导演', reason: '人工结果完整且引用有效',
    }, harness.options)).resolves.toMatchObject({
      targetStatus: '已确认',
      record: {
        reviewed: true,
        fields: completeDirectorCaseOutcomeFields(),
      },
    })
    expect(harness.updateCalls).toHaveLength(1)
  })

  it('rejects a director case whose final-use decision is still pending', async () => {
    const directorBrain = await loadModule()
    const schema = await directorBrain.loadDirectorBrainSchema()
    const foundation = reviewedFoundation()
    foundation.director_cases = [{
      record_id: 'rec_case_outcome_pending',
      fields: {
        ...foundation.director_cases[0].fields,
        '案例 ID': 'CASE-OUTCOME-PENDING-001',
        '复核状态': '待复核',
        '最终使用': '待确认',
        '版本': 'v0.2.1',
      },
    }]
    const harness = operationHarness(schema, foundation)

    await expect(directorBrain.reviewDirectorBrainRecord({
      table: 'director_cases', stableId: 'CASE-OUTCOME-PENDING-001',
      workId: 'WORK-ICE-001', expectedVersion: 'v0.2.1', targetStatus: '已确认',
      reviewer: '测试导演', reason: '最终采用结果尚未确认',
    }, harness.options)).rejects.toThrow('review_director_case_final_use_invalid')
    expect(harness.updateCalls).toHaveLength(0)
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
