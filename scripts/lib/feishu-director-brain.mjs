import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmod, lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const API_ROOT = 'https://open.feishu.cn/open-apis'
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const DEFAULT_SCHEMA_PATH = resolve(MODULE_ROOT, 'ops/feishu-director-brain/schema.json')
export const DEFAULT_CATALOG_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'Video AutoWorker',
  'director-brain',
  'test-catalog.json',
)
export const DEFAULT_CATALOG_ROOT = dirname(DEFAULT_CATALOG_PATH)

const TOKEN_EXPIRY_MARGIN_MS = 60_000
const FIELD_TYPES = new Set([1, 2, 3, 4, 5])
const DEFAULT_STARTER_FIELD_NAMES = new Set(['单选', '日期', '附件'])
const SECRET_FIELD_PATTERN = /(?:secret|token|password|密码|密钥|私钥)/iu
const SECRET_VALUE_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:app_secret|client_secret)\s*[:=]\s*\S+/iu,
]

const OPERATION_ACTIONS = new Set([
  'health', 'resolve_work', 'get', 'search', 'assemble', 'workflow', 'propose',
])
const PROPOSABLE_TABLES = new Set([
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
const HIDDEN_OUTPUT_FIELDS = new Set(['剪辑方案 ID', '时间线版本'])
const SERVICE_OWNED_FIELDS = new Set([
  '项目 ID', '作品 ID', '版本', '来源', '更新时间', '状态', '复核状态',
  '审核人', '审核时间', '审核原因',
])
const HUMAN_ONLY_FIELDS = new Set([
  '人工结论',
  '导演备注',
  '生效时间',
  '最终使用',
  '最终效果',
  '成片位置',
  '时间线版本',
])
const EDITING_FIELDS = new Set(['剪辑方案 ID', '成片位置', '时间线版本'])
const CANDIDATE_STATUS_BY_TABLE = Object.freeze({
  works: '草稿',
  director_intents: '草稿',
  people_profiles: '候选',
  story_nodes: '候选',
  story_relations: '候选',
  material_judgments: '候选',
  narrative_plans: '草稿',
  director_cases: '待复核',
  skills_techniques: '候选',
})
const PROPOSAL_REQUIRED_FIELDS = Object.freeze({
  works: ['作品名称', '作品类型'],
  director_intents: [
    '意图名称', '核心主题', '导演态度', '情绪风格', '叙事方式', '节奏', '观众体验',
  ],
  people_profiles: ['人物名称', '人物 ID', '置信度'],
  story_nodes: ['节点名称', '节点类型', '节点内容', '置信度'],
  story_relations: ['关系名称', '关系类型', '判断理由', '置信度'],
  material_judgments: [
    '判断名称', '故事价值', '人物价值', '情绪价值', '信息价值', '视觉价值', '稀缺性',
    '叙事价值', '使用理由', '置信度',
  ],
  narrative_plans: [
    '方案名称', '人物线', '事件线', '时间线', '地点线', '情绪线', '主题线', '冲突线',
    '结构说明', '故事脚本',
  ],
  director_cases: ['案例名称', '上下文', '导演动作', '判断原因'],
  skills_techniques: [
    '知识名称', '知识类型', '知识分类', '适用条件', '执行方法', '为什么有效', '置信度',
  ],
})
const PROPOSAL_REFERENCE_RULES = Object.freeze({
  works: {},
  director_intents: {
    optional: { previousIntentVersionId: ['director_intents', '上一版本 ID'] },
  },
  people_profiles: {
    optional: { previousProfileVersionId: ['people_profiles', '上一版本 ID'] },
    requiredMany: { evidenceIds: ['material_evidence', '证据 ID'] },
  },
  story_nodes: {
    optional: { previousStoryNodeId: ['story_nodes', '上一版本 ID'] },
    requiredMany: { evidenceIds: ['material_evidence', '证据 ID'] },
  },
  story_relations: {
    optional: { previousStoryRelationId: ['story_relations', '上一版本 ID'] },
    required: {
      sourceNodeId: ['story_nodes', '源节点 ID'],
      targetNodeId: ['story_nodes', '目标节点 ID'],
    },
    requiredMany: { evidenceIds: ['material_evidence', '证据 ID'] },
  },
  material_judgments: {
    required: { intentVersionId: ['director_intents', '意图版本 ID'] },
    optional: { previousJudgmentId: ['material_judgments', '上一版本 ID'] },
    requiredMany: { evidenceIds: ['material_evidence', '证据 ID'] },
  },
  narrative_plans: {
    required: { intentVersionId: ['director_intents', '意图版本 ID'] },
    optional: { previousNarrativePlanId: ['narrative_plans', '上一版本 ID'] },
    requiredMany: {
      nodeIds: ['story_nodes', '节点 ID'],
      evidenceIds: ['material_evidence', '证据 ID'],
    },
  },
  director_cases: {
    required: { judgmentId: ['material_judgments', '判断 ID'] },
    optional: { previousDirectorCaseId: ['director_cases', '上一版本 ID'] },
    requiredMany: { evidenceIds: ['material_evidence', '证据 ID'] },
  },
  skills_techniques: {
    optional: { previousSkillTechniqueId: ['skills_techniques', '上一版本 ID'] },
    requiredMany: { caseIds: ['director_cases', '案例 ID'] },
  },
})
const ASSEMBLY_REFERENCE_TABLES = Object.freeze({
  intentVersionId: ['director_intents', false],
  evidenceIds: ['material_evidence', true],
  peopleProfileIds: ['people_profiles', true],
  storyNodeIds: ['story_nodes', true],
  storyRelationIds: ['story_relations', true],
  materialJudgmentIds: ['material_judgments', true],
  narrativePlanIds: ['narrative_plans', true],
  directorCaseIds: ['director_cases', true],
  skillTechniqueIds: ['skills_techniques', true],
})
const REFERENCE_FIELD_NAMES = new Set([
  '上一版本 ID', '证据 ID', '源节点 ID', '目标节点 ID', '意图版本 ID', '节点 ID', '判断 ID', '案例 ID',
])
const MATERIAL_VALUE_FIELDS = new Set([
  '故事价值', '人物价值', '情绪价值', '信息价值', '视觉价值', '稀缺性', '叙事价值',
])
const CONFIDENCE_FIELDS = new Set(['置信度'])
const MAX_REFERENCE_IDS = 20
const REVIEWED_STATUSES_BY_TABLE = Object.freeze({
  system_blueprint: new Set(['生效']),
  works: new Set(['生效']),
  director_intents: new Set(['生效']),
  material_evidence: new Set(['已核验']),
  people_profiles: new Set(['已确认', '已合并']),
  story_nodes: new Set(['已确认', '已解决']),
  story_relations: new Set(['已确认']),
  material_judgments: new Set(['已确认']),
  narrative_plans: new Set(['已批准']),
  director_cases: new Set(['已确认']),
  skills_techniques: new Set(['已验证']),
})
const LEGAL_STATUS_TRANSITIONS = Object.freeze({
  system_blueprint: {
    草稿: new Set(['待审核', '废弃']), 待审核: new Set(['生效', '废弃']),
    生效: new Set(['废弃']), 废弃: new Set([]),
  },
  works: { 草稿: new Set(['生效']), 生效: new Set(['归档']), 归档: new Set(['生效']) },
  director_intents: {
    草稿: new Set(['待审核', '废弃']), 待审核: new Set(['生效', '废弃']),
    生效: new Set(['废弃']), 废弃: new Set([]),
  },
  material_evidence: { 候选: new Set(['已核验', '失效']), 已核验: new Set(['失效']), 失效: new Set([]) },
  people_profiles: {
    候选: new Set(['待审核', '失效']), 待审核: new Set(['已确认', '已合并', '失效']),
    已确认: new Set(['已合并', '失效']), 已合并: new Set(['失效']), 失效: new Set([]),
  },
  story_nodes: {
    候选: new Set(['待审核', '失效']), 待审核: new Set(['已确认', '失效']),
    已确认: new Set(['已解决', '失效']), 已解决: new Set(['失效']), 失效: new Set([]),
  },
  story_relations: {
    候选: new Set(['待审核', '失效']), 待审核: new Set(['已确认', '失效']),
    已确认: new Set(['失效']), 失效: new Set([]),
  },
  material_judgments: {
    候选: new Set(['待审核', '失效']), 待审核: new Set(['已确认', '失效']),
    已确认: new Set(['失效']), 失效: new Set([]),
  },
  narrative_plans: {
    草稿: new Set(['待审核', '废弃']), 待审核: new Set(['已批准', '废弃']),
    已批准: new Set(['废弃']), 废弃: new Set([]),
  },
  director_cases: {
    待复核: new Set(['已确认', '有争议', '失效']), 有争议: new Set(['已确认', '失效']),
    已确认: new Set(['失效']), 失效: new Set([]),
  },
  skills_techniques: {
    候选: new Set(['待审核', '废弃']), 待审核: new Set(['已验证', '废弃']),
    已验证: new Set(['废弃']), 废弃: new Set([]),
  },
})
const OPERATION_VERSION = 'v0.2.0'
const OPERATION_SOURCE = 'openclaw-director-brain'
const MAX_OPERATION_INPUT_BYTES = 32 * 1024
const MAX_EVIDENCE_PROJECTION_INPUT_BYTES = 256 * 1024
const MAX_EVIDENCE_PROJECTION_ITEMS = 50
const CREATE_LOCK_RETRY_MS = 50
const CREATE_LOCK_TIMEOUT_MS = 30_000
const CREATE_LOCK_LEASE_MS = 10 * 60_000
const CREATE_LOCK_INITIALIZATION_GRACE_MS = 5_000
const MAX_OPERATION_TEXT_LENGTH = 4_000
const MAX_SEARCH_QUERY_LENGTH = 240
const MAX_SEARCH_LIMIT = 20
const MAX_SEARCH_PAGES_PER_TABLE = 5
const SEARCH_PAGE_SIZE = 100
const SENSITIVE_KEY_PATTERN = /(?:secret|token|password|api.?key|credential|authorization|cookie|密码|密钥|私钥|访问令牌)/iu
const TASK_STATE_KEY_PATTERN = /(?:task.?status|queue.?status|execution.?status|任务状态(?:机)?|队列状态|执行状态)/iu
const TRANSCRIPT_KEY_PATTERN = /(?:full|raw)[_-]?transcript|(?:完整|原始)(?:语音|音频)?转写/iu
const TRANSCRIPT_VALUE_PATTERN = /(?:full|raw)\s+transcript|(?:完整|原始)(?:语音|音频)?转写/iu
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'(])(?:\/(?!\/)[^\s"')]+|[A-Za-z]:\\[^\s"')]+)/u
const FILE_OR_DATA_URL_PATTERN = /\b(?:file:\/\/|data:[^\s;,]+[;,])/iu
const MEDIA_URL_PATTERN = /https?:\/\/[^\s]+\.(?:mp4|mov|mkv|avi|webm|m4v|mp3|wav|aac|flac|jpg|jpeg|png|webp)(?:[?#][^\s]*)?/iu
const HTTP_URL_PATTERN = /https?:\/\/[^\s<>'"\])}]+/iu
const BASE64_BLOB_PATTERN = /(?:^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{160,}={0,2}(?:$|[^A-Za-z0-9+/=])/u
const FEISHU_RESOURCE_ID_CANDIDATE_PATTERN = /(?<![A-Za-z0-9_])(?:cli_[A-Za-z0-9]{10,64}|bascn[A-Za-z0-9]{10,64}|(?:tbl|rec|fld)[A-Za-z0-9]{10,32})(?![A-Za-z0-9_])/gu
const REVIEW_CONTRACT_VALID = Symbol('reviewContractValid')

let cachedToken = null

function containsFeishuResourceId(value) {
  const candidates = String(value || '').match(FEISHU_RESOURCE_ID_CANDIDATE_PATTERN) || []
  return candidates.some(candidate => {
    if (candidate.startsWith('cli_') || candidate.startsWith('bascn')) return true
    const suffix = candidate.slice(3)
    return /[A-Z]/u.test(suffix) && /[0-9]/u.test(suffix)
  })
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(label + '_must_be_object')
  }
  return value
}

function requireNonEmpty(value, label) {
  const text = String(value || '').trim()
  if (!text) throw new Error(label + '_required')
  return text
}

function stableUnique(values, label) {
  if (new Set(values).size !== values.length) throw new Error(label + '_must_be_unique')
}

export function validateDirectorBrainSchema(raw) {
  const schema = requireObject(raw, 'schema')
  if (Number(schema.schemaVersion) !== 2) throw new Error('schema_version_unsupported')
  requireNonEmpty(schema.brainName, 'brain_name')
  requireNonEmpty(schema.projectId, 'project_id')
  requireNonEmpty(schema.environment, 'environment')
  requireNonEmpty(schema.keychainService, 'keychain_service')
  if (!Array.isArray(schema.tables) || schema.tables.length !== 11) {
    throw new Error('director_brain_requires_exactly_eleven_tables')
  }

  const tableKeys = []
  const tableNames = []
  for (const tableValue of schema.tables) {
    const table = requireObject(tableValue, 'table')
    tableKeys.push(requireNonEmpty(table.key, 'table_key'))
    tableNames.push(requireNonEmpty(table.name, 'table_name'))
    const stableId = requireNonEmpty(table.stableId, 'stable_id')
    if (!Array.isArray(table.fields) || table.fields.length < 3 || table.fields.length > 100) {
      throw new Error('table_field_count_invalid:' + table.key)
    }
    const fieldNames = []
    let primaryCount = 0
    for (const fieldValue of table.fields) {
      const field = requireObject(fieldValue, 'field')
      const fieldName = requireNonEmpty(field.name, 'field_name')
      fieldNames.push(fieldName)
      if (!Number.isInteger(field.type) || !FIELD_TYPES.has(field.type)) {
        throw new Error('field_type_unsupported:' + table.key + ':' + fieldName)
      }
      if (field.primary === true) primaryCount += 1
      if ((Number(field.type) === 3 || Number(field.type) === 4)) {
        if (!Array.isArray(field.options) || field.options.length === 0) {
          throw new Error('select_options_required:' + table.key + ':' + fieldName)
        }
        stableUnique(field.options.map(String), 'select_options:' + table.key + ':' + fieldName)
      }
      if (SECRET_FIELD_PATTERN.test(fieldName)) {
        throw new Error('secret_field_forbidden:' + table.key + ':' + fieldName)
      }
    }
    stableUnique(fieldNames, 'field_names:' + table.key)
    if (primaryCount !== 1 || table.fields[0].primary !== true) {
      throw new Error('first_field_must_be_only_primary:' + table.key)
    }
    if (Number(table.fields[0].type) !== 1) {
      throw new Error('primary_field_must_be_text:' + table.key)
    }
    const stableIdField = table.fields.find(field => field.name === stableId)
    if (!stableIdField) {
      throw new Error('stable_id_field_missing:' + table.key)
    }
    if (Number(stableIdField.type) !== 1) {
      throw new Error('stable_id_field_must_be_text:' + table.key)
    }
  }
  stableUnique(tableKeys, 'table_keys')
  stableUnique(tableNames, 'table_names')
  return schema
}

export async function loadDirectorBrainSchema(pathname = DEFAULT_SCHEMA_PATH) {
  const raw = JSON.parse(await readFile(pathname, 'utf8'))
  return validateDirectorBrainSchema(raw)
}

function fieldPayload(field) {
  const payload = {
    field_name: field.name,
    type: Number(field.type),
  }
  if (field.type === 3 || field.type === 4) {
    payload.ui_type = field.type === 3 ? 'SingleSelect' : 'MultiSelect'
    payload.property = {
      options: field.options.map((name, index) => ({ name, color: index % 55 })),
    }
  } else if (field.type === 5) {
    payload.ui_type = 'DateTime'
    payload.property = { date_formatter: 'yyyy-MM-dd' }
  }
  return payload
}

function redactApiMessage(value) {
  return String(value || 'unknown_error')
    .replace(/(?:app_secret|client_secret|authorization)[^,}\n]*/giu, '[redacted]')
    .slice(0, 800)
}

async function requestJson(method, path, options = {}) {
  const url = new URL(API_ROOT + path)
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value))
    }
  }
  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...(options.accessToken ? { Authorization: 'Bearer ' + options.accessToken } : {}),
    },
    ...(options.payload === undefined ? {} : { body: JSON.stringify(options.payload) }),
    signal: AbortSignal.timeout(options.timeoutMs || 30_000),
  })
  const raw = await response.text()
  let payload = null
  try {
    payload = raw ? JSON.parse(raw) : {}
  } catch {
    throw new Error('feishu_response_invalid_json:' + response.status)
  }
  if (!response.ok) {
    throw new Error('feishu_http_error:' + response.status + ':' + redactApiMessage(payload?.msg || raw))
  }
  if (payload?.code !== 0) {
    throw new Error('feishu_api_error:' + String(payload?.code) + ':' + redactApiMessage(payload?.msg))
  }
  return payload
}

async function keychainSecret(appId, service) {
  const result = await execFileAsync('security', [
    'find-generic-password',
    '-a',
    appId,
    '-s',
    service,
    '-w',
  ], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  }).catch(error => {
    const stderr = String(error?.stderr || '')
    if (/could not be found|item not found|errSecItemNotFound|找不到/iu.test(stderr)) {
      throw new Error('director_brain_keychain_secret_missing')
    }
    throw new Error('director_brain_keychain_unavailable')
  })
  const secret = String(result.stdout || '').trim()
  if (!secret) throw new Error('director_brain_keychain_secret_missing')
  return secret
}

async function tenantAccessToken(appId, service) {
  const now = Date.now()
  if (cachedToken
    && cachedToken.appId === appId
    && cachedToken.service === service
    && cachedToken.expiresAt > now) {
    return cachedToken.value
  }
  const appSecret = await keychainSecret(appId, service)
  const response = await requestJson('POST', '/auth/v3/tenant_access_token/internal', {
    payload: { app_id: appId, app_secret: appSecret },
  })
  cachedToken = {
    appId,
    service,
    value: response.tenant_access_token,
    expiresAt: now + Math.max(1_000, Number(response.expire || 7200) * 1000 - TOKEN_EXPIRY_MARGIN_MS),
  }
  return cachedToken.value
}

export function validateDirectorBrainCatalogPath(pathname, catalogRoot = DEFAULT_CATALOG_ROOT) {
  if (!isAbsolute(pathname)) throw new Error('catalog_path_must_be_absolute')
  const root = resolve(catalogRoot)
  const target = resolve(pathname)
  if (dirname(target) !== root) throw new Error('catalog_path_outside_private_root')
  return target
}

async function pathStats(pathname) {
  try {
    return await lstat(pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function ensureCatalogRoot(root, create) {
  if (create) await mkdir(root, { recursive: true, mode: 0o700 })
  const stats = await pathStats(root)
  if (!stats) return false
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error('catalog_root_must_be_private_directory')
  }
  if (resolve(await realpath(root)) !== root) throw new Error('catalog_root_symlink_forbidden')
  if ((stats.mode & 0o077) !== 0) {
    if (!create) throw new Error('catalog_root_permissions_too_open')
    await chmod(root, 0o700)
  }
  return true
}

async function assertCatalogFileSafe(target) {
  const stats = await pathStats(target)
  if (!stats) return null
  if (stats.isSymbolicLink() || !stats.isFile()) throw new Error('catalog_file_must_be_regular')
  if ((stats.mode & 0o077) !== 0) throw new Error('catalog_file_permissions_too_open')
  return stats
}

async function readCatalog(pathname) {
  const target = validateDirectorBrainCatalogPath(pathname)
  const root = dirname(target)
  if (!await ensureCatalogRoot(root, false)) return null
  if (!await assertCatalogFileSafe(target)) return null
  return requireObject(JSON.parse(await readFile(target, 'utf8')), 'catalog')
}

async function prepareCatalogRoot(pathname) {
  const target = validateDirectorBrainCatalogPath(pathname)
  await ensureCatalogRoot(dirname(target), true)
}

async function writeCatalog(pathname, catalog) {
  const target = validateDirectorBrainCatalogPath(pathname)
  const root = dirname(target)
  await ensureCatalogRoot(root, true)
  await assertCatalogFileSafe(target)
  const temporary = target + '.tmp-' + process.pid + '-' + randomUUID()
  let temporaryCreated = false
  try {
    await writeFile(temporary, JSON.stringify(catalog, null, 2) + '\n', {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    })
    temporaryCreated = true
    await rename(temporary, target)
    temporaryCreated = false
  } finally {
    if (temporaryCreated) await unlink(temporary).catch(() => {})
  }
  await chmod(target, 0o600)
}

export function validateDirectorBrainCatalog(raw, schema, options = {}) {
  const catalog = requireObject(raw, 'catalog')
  const catalogVersion = Number(catalog.schemaVersion)
  const legacyV1 = catalogVersion === 1 && Number(schema.schemaVersion) === 2
  if (catalogVersion !== Number(schema.schemaVersion)
    && !(legacyV1 && options.allowLegacyV1 === true)) {
    throw new Error('catalog_schema_version_mismatch')
  }
  if (requireNonEmpty(catalog.brainName, 'catalog_brain_name') !== schema.brainName) {
    throw new Error('catalog_brain_name_mismatch')
  }
  if (requireNonEmpty(catalog.projectId, 'catalog_project_id') !== schema.projectId) {
    throw new Error('catalog_project_id_mismatch')
  }
  if (requireNonEmpty(catalog.environment, 'catalog_environment') !== schema.environment) {
    throw new Error('catalog_environment_mismatch')
  }
  if (requireNonEmpty(catalog.keychainService, 'catalog_keychain_service') !== schema.keychainService) {
    throw new Error('catalog_keychain_service_mismatch')
  }
  requireNonEmpty(catalog.appId, 'catalog_app_id')
  requireNonEmpty(catalog.appToken, 'catalog_app_token')
  requireObject(catalog.tables, 'catalog_tables')
  const expectedByKey = new Map(schema.tables.map(table => [table.key, table]))
  const catalogKeys = Object.keys(catalog.tables)
  if (legacyV1) {
    const legacyKeys = schema.tables.filter(table => table.key !== 'works').map(table => table.key)
    if (catalogKeys.length !== legacyKeys.length
      || legacyKeys.some(key => !catalogKeys.includes(key))) {
      throw new Error('legacy_catalog_table_set_invalid')
    }
  }
  for (const key of catalogKeys) {
    if (!expectedByKey.has(key)) throw new Error('catalog_table_key_unexpected:' + key)
  }
  if (!legacyV1 && options.allowPartialTables !== true
    && catalogKeys.length !== schema.tables.length) {
    throw new Error('catalog_table_count_mismatch')
  }
  for (const [key, refValue] of Object.entries(catalog.tables)) {
    const ref = requireObject(refValue, 'catalog_table:' + key)
    if (requireNonEmpty(ref.name, 'catalog_table_name:' + key) !== expectedByKey.get(key).name) {
      throw new Error('catalog_table_name_mismatch:' + key)
    }
    requireNonEmpty(ref.tableId, 'catalog_table_id:' + key)
  }
  stableUnique(
    Object.values(catalog.tables).map(ref => ref.tableId),
    'catalog_table_ids',
  )
  return catalog
}

function runtimeContext(schema, catalog, appIdOverride, options = {}) {
  const validatedCatalog = catalog
    ? validateDirectorBrainCatalog(catalog, schema, options)
    : null
  const appId = requireNonEmpty(appIdOverride || validatedCatalog?.appId, 'app_id')
  if (validatedCatalog?.appId && validatedCatalog.appId !== appId) {
    throw new Error('catalog_app_id_mismatch')
  }
  return {
    schema,
    catalog: validatedCatalog,
    appId,
    service: schema.keychainService,
  }
}

async function listPaged(accessToken, path, itemKey = 'items', extraQuery = {}) {
  const items = []
  let pageToken = null
  do {
    const response = await requestJson('GET', path, {
      accessToken,
      query: {
        page_size: 100,
        ...extraQuery,
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    })
    const data = response.data || {}
    items.push(...(Array.isArray(data[itemKey]) ? data[itemKey] : []))
    if (!data.has_more) break
    pageToken = data.page_token
    if (!pageToken) throw new Error('feishu_page_token_missing')
  } while (pageToken)
  return items
}

async function listTables(accessToken, appToken) {
  return listPaged(accessToken, '/bitable/v1/apps/' + appToken + '/tables')
}

async function listFields(accessToken, appToken, tableId) {
  return listPaged(
    accessToken,
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/fields',
  )
}

async function listRecords(accessToken, appToken, tableId, filter) {
  return listPaged(
    accessToken,
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records',
    'items',
    filter ? { filter } : {},
  )
}

async function createBitable(accessToken, name) {
  const response = await requestJson('POST', '/bitable/v1/apps', {
    accessToken,
    payload: { name, time_zone: 'Asia/Shanghai' },
  })
  return response.data.app
}

async function renameTable(accessToken, appToken, tableId, name) {
  await requestJson('PATCH', '/bitable/v1/apps/' + appToken + '/tables/' + tableId, {
    accessToken,
    payload: { name },
  })
}

async function createTable(accessToken, appToken, table) {
  const response = await requestJson('POST', '/bitable/v1/apps/' + appToken + '/tables', {
    accessToken,
    payload: {
      table: {
        name: table.name,
        default_view_name: '默认视图',
        fields: table.fields.map(fieldPayload),
      },
    },
  })
  return response.data.table_id
}

async function createField(accessToken, appToken, tableId, field) {
  await requestJson(
    'POST',
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/fields',
    { accessToken, payload: fieldPayload(field) },
  )
  await new Promise(resolvePromise => setTimeout(resolvePromise, 120))
}

async function updateField(accessToken, appToken, tableId, fieldId, payload) {
  await requestJson(
    'PUT',
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/fields/' + fieldId,
    { accessToken, payload },
  )
}

async function deleteField(accessToken, appToken, tableId, fieldId) {
  await requestJson(
    'DELETE',
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/fields/' + fieldId,
    { accessToken },
  )
}

async function ensureSelectOptions(accessToken, appToken, tableId, observed, expected) {
  const existing = Array.isArray(observed.property?.options) ? observed.property.options : []
  const existingNames = new Set(existing.map(option => option.name))
  const missing = expected.options.filter(name => !existingNames.has(name))
  if (!missing.length) return false
  await updateField(accessToken, appToken, tableId, observed.field_id, {
    field_name: observed.field_name,
    type: observed.type,
    property: {
      options: [
        ...existing,
        ...missing.map((name, index) => ({ name, color: (existing.length + index) % 55 })),
      ],
    },
  })
  return true
}

async function ensureTableFields(accessToken, appToken, tableId, table) {
  const observed = await listFields(accessToken, appToken, tableId)
  const byName = new Map(observed.map(field => [field.field_name, field]))
  const expectedPrimary = table.fields[0]
  const primaries = observed.filter(field => field.is_primary)
  if (primaries.length !== 1) throw new Error('director_brain_primary_count_invalid:' + table.key)
  let primary = primaries[0]
  const namedPrimary = byName.get(expectedPrimary.name)
  if (namedPrimary && !namedPrimary.is_primary) {
    throw new Error('director_brain_primary_field_unsafe:' + table.key)
  }
  if (!byName.has(expectedPrimary.name)) {
    if (Number(primary.type) !== Number(expectedPrimary.type)) {
      throw new Error('director_brain_primary_field_unsafe:' + table.key)
    }
    const renamePayload = {
      field_name: expectedPrimary.name,
      type: Number(primary.type),
      ...(primary.property ? { property: primary.property } : {}),
    }
    await updateField(accessToken, appToken, tableId, primary.field_id, renamePayload)
    primary = { ...primary, field_name: expectedPrimary.name }
    byName.set(expectedPrimary.name, primary)
  }
  if (primary.field_name !== expectedPrimary.name
    || Number(primary.type) !== Number(expectedPrimary.type)) {
    throw new Error('director_brain_primary_field_mismatch:' + table.key)
  }

  let created = 0
  let updated = 0
  for (const expected of table.fields) {
    const current = byName.get(expected.name)
    if (!current) {
      await createField(accessToken, appToken, tableId, expected)
      created += 1
      continue
    }
    if (Number(current.type) !== Number(expected.type)) {
      throw new Error('director_brain_field_type_mismatch:' + table.key + ':' + expected.name)
    }
    if ((expected.type === 3 || expected.type === 4)
      && await ensureSelectOptions(accessToken, appToken, tableId, current, expected)) {
      updated += 1
    }
  }
  return { created, updated }
}

function isBlankRecord(record) {
  const values = Object.values(record?.fields || {})
  return values.length === 0 || values.every(value => {
    if (value === null || value === undefined || value === '') return true
    if (Array.isArray(value)) return value.length === 0
    return false
  })
}

async function removeBlankStarterRecords(accessToken, appToken, tableId) {
  const records = await listRecords(accessToken, appToken, tableId)
  const blankRecords = records.filter(isBlankRecord)
  for (const record of blankRecords) {
    await deleteRecord(accessToken, appToken, tableId, record.record_id)
  }
  return blankRecords.length
}

async function removeUnusedStarterFields(accessToken, appToken, tableId) {
  const [fields, records] = await Promise.all([
    listFields(accessToken, appToken, tableId),
    listRecords(accessToken, appToken, tableId),
  ])
  const removable = fields.filter(field => !field.is_primary
    && DEFAULT_STARTER_FIELD_NAMES.has(field.field_name)
    && records.every(record => {
      const value = record.fields?.[field.field_name]
      return value === null || value === undefined || value === ''
        || (Array.isArray(value) && value.length === 0)
    }))
  for (const field of removable) {
    await deleteField(accessToken, appToken, tableId, field.field_id)
  }
  return removable.length
}

export function resolveBootstrapTableAssignments(schema, catalog, remoteTables) {
  if (!Array.isArray(remoteTables)) throw new Error('bootstrap_remote_tables_must_be_array')
  const remoteById = new Map()
  const remoteByName = new Map()
  for (const remoteValue of remoteTables) {
    const remote = requireObject(remoteValue, 'bootstrap_remote_table')
    const tableId = requireNonEmpty(remote.table_id, 'bootstrap_remote_table_id')
    const name = requireNonEmpty(remote.name, 'bootstrap_remote_table_name')
    if (remoteById.has(tableId)) throw new Error('bootstrap_remote_table_ids_must_be_unique')
    remoteById.set(tableId, remote)
    const named = remoteByName.get(name) || []
    named.push(remote)
    remoteByName.set(name, named)
  }

  const assignments = {}
  const assignedIds = new Set()
  for (let index = 0; index < schema.tables.length; index += 1) {
    const table = schema.tables[index]
    const catalogRef = catalog.tables?.[table.key]
    let remote = null
    if (catalogRef?.tableId) {
      remote = remoteById.get(catalogRef.tableId)
      if (!remote) throw new Error('catalog_table_missing:' + table.key)
      if (remote.name !== table.name) throw new Error('catalog_table_name_mismatch:' + table.key)
    } else {
      const named = remoteByName.get(table.name) || []
      if (named.length > 1) throw new Error('duplicate_remote_table_name:' + table.name)
      if (named.length === 1) remote = named[0]
    }
    if (!remote && index === 0 && catalog.defaultTableId) {
      remote = remoteById.get(catalog.defaultTableId) || null
    }
    if (!remote) continue
    if (assignedIds.has(remote.table_id)) {
      throw new Error('bootstrap_remote_table_assignment_conflict:' + table.key)
    }
    assignments[table.key] = remote.table_id
    assignedIds.add(remote.table_id)
  }

  const extra = remoteTables.filter(remote => !assignedIds.has(remote.table_id))
  if (extra.length) {
    throw new Error('bootstrap_unexpected_remote_table:' + extra.map(table => table.name).join(','))
  }
  return assignments
}

function recordFieldIsBlank(record, fieldName) {
  const value = record?.fields?.[fieldName]
  return value === null || value === undefined || value === ''
    || (Array.isArray(value) && value.length === 0)
}

export function validateBootstrapTablePreflight(table, fields, records = []) {
  if (!Array.isArray(fields)) throw new Error('bootstrap_remote_fields_must_be_array:' + table.key)
  if (!Array.isArray(records)) throw new Error('bootstrap_remote_records_must_be_array:' + table.key)
  const byName = new Map()
  for (const field of fields) {
    const name = requireNonEmpty(field?.field_name, 'bootstrap_remote_field_name:' + table.key)
    if (byName.has(name)) throw new Error('director_brain_field_name_not_unique:' + table.key)
    byName.set(name, field)
  }

  const expectedPrimary = table.fields[0]
  const primaries = fields.filter(field => field.is_primary)
  if (primaries.length !== 1) throw new Error('director_brain_primary_count_invalid:' + table.key)
  const primary = primaries[0]
  const namedPrimary = byName.get(expectedPrimary.name)
  if (namedPrimary && !namedPrimary.is_primary) {
    throw new Error('director_brain_primary_field_unsafe:' + table.key)
  }
  if (!namedPrimary && Number(primary.type) !== Number(expectedPrimary.type)) {
    throw new Error('director_brain_primary_field_unsafe:' + table.key)
  }
  if (namedPrimary && Number(namedPrimary.type) !== Number(expectedPrimary.type)) {
    throw new Error('director_brain_primary_field_mismatch:' + table.key)
  }

  for (const expected of table.fields) {
    const current = byName.get(expected.name)
    if (!current) continue
    if (Number(current.type) !== Number(expected.type)) {
      throw new Error('director_brain_field_type_mismatch:' + table.key + ':' + expected.name)
    }
    if (expected.type === 3 || expected.type === 4) {
      const options = Array.isArray(current.property?.options) ? current.property.options : []
      const names = options.map(option => option.name)
      if (new Set(names).size !== names.length
        || names.some(name => !expected.options.includes(name))) {
        throw new Error('director_brain_select_options_conflict:' + table.key + ':' + expected.name)
      }
    }
  }

  const expectedNames = new Set(table.fields.map(field => field.name))
  for (const field of fields) {
    if (expectedNames.has(field.field_name)) continue
    if (!namedPrimary && field === primary) continue
    if (DEFAULT_STARTER_FIELD_NAMES.has(field.field_name)
      && records.every(record => recordFieldIsBlank(record, field.field_name))) {
      continue
    }
    throw new Error('director_brain_unexpected_field_conflict:' + table.key + ':' + field.field_name)
  }
  return true
}

async function preflightBootstrapRemoteState(accessToken, appToken, schema, catalog, remoteTables) {
  const assignments = resolveBootstrapTableAssignments(schema, catalog, remoteTables)
  for (const table of schema.tables) {
    const tableId = assignments[table.key]
    if (!tableId) continue
    const [fields, records] = await Promise.all([
      listFields(accessToken, appToken, tableId),
      listRecords(accessToken, appToken, tableId),
    ])
    validateBootstrapTablePreflight(table, fields, records)
  }
  return assignments
}

export function planDirectorBrainMigration(catalogValue, schemaValue) {
  const schema = validateDirectorBrainSchema(schemaValue)
  const version = Number(catalogValue?.schemaVersion)
  if (version === 2) {
    validateDirectorBrainCatalog(catalogValue, schema)
    return { fromVersion: 2, toVersion: 2, required: false, addTables: [], addFields: {} }
  }
  const catalog = validateDirectorBrainCatalog(catalogValue, schema, { allowLegacyV1: true })
  const additiveFields = new Set([
    '作品 ID', '版本', '上一版本 ID', '审核人', '审核时间', '审核原因',
  ])
  const addFields = Object.fromEntries(schema.tables
    .filter(table => table.key !== 'system_blueprint' && table.key !== 'works')
    .map(table => [
      table.key,
      table.fields.map(field => field.name).filter(name => additiveFields.has(name)),
    ]))
  return {
    fromVersion: 1,
    toVersion: 2,
    required: true,
    addTables: catalog.tables.works ? [] : ['works'],
    addFields,
    destructiveChanges: [],
  }
}

async function writeMigrationBackup(accessToken, catalog, options = {}) {
  const backupRoot = resolve(options.backupRoot || join(DEFAULT_CATALOG_ROOT, 'migration-backups'))
  if (!isAbsolute(backupRoot)) throw new Error('migration_backup_root_must_be_absolute')
  if (backupRoot === MODULE_ROOT || backupRoot.startsWith(MODULE_ROOT + '/')) {
    throw new Error('migration_backup_inside_repository_forbidden')
  }
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  const rootStats = await lstat(backupRoot)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('migration_backup_root_invalid')
  }
  await chmod(backupRoot, 0o700)
  const backupDirectory = join(
    backupRoot,
    'v1-to-v2-' + new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID(),
  )
  await mkdir(backupDirectory, { mode: 0o700 })
  const tables = {}
  for (const [key, ref] of Object.entries(catalog.tables)) {
    const [fields, records] = await Promise.all([
      listFields(accessToken, catalog.appToken, ref.tableId),
      listRecords(accessToken, catalog.appToken, ref.tableId),
    ])
    tables[key] = { name: ref.name, tableId: ref.tableId, fields, records }
  }
  const backupPath = join(backupDirectory, 'director-brain-v1.json')
  await writeFile(backupPath, JSON.stringify({
    schemaVersion: 1,
    brainName: catalog.brainName,
    projectId: catalog.projectId,
    environment: catalog.environment,
    createdAt: new Date().toISOString(),
    tables,
  }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
  await chmod(backupPath, 0o600)
  return backupPath
}

export async function migrateDirectorBrain(options = {}) {
  const schema = await loadDirectorBrainSchema(options.schemaPath)
  const catalogPath = validateDirectorBrainCatalogPath(options.catalogPath || DEFAULT_CATALOG_PATH)
  const catalog = options.catalog || await readCatalog(catalogPath)
  if (!catalog) throw new Error('director_brain_catalog_missing')
  const plan = planDirectorBrainMigration(catalog, schema)
  if (options.dryRun === true || !plan.required) {
    return { ok: true, action: 'migrate', dryRun: true, ...plan }
  }
  const context = runtimeContext(schema, catalog, options.appId, { allowLegacyV1: true })
  const accessToken = await tenantAccessToken(context.appId, context.service)
  const backupPath = await writeMigrationBackup(accessToken, catalog, options)
  const result = await bootstrapDirectorBrain({
    ...options,
    catalogPath,
    migrationBackupVerified: true,
  })
  return {
    ok: true,
    action: 'migrate',
    dryRun: false,
    ...plan,
    backupPath,
    contractVerified: result.contractVerified,
  }
}

export async function bootstrapDirectorBrain(options = {}) {
  const schema = await loadDirectorBrainSchema(options.schemaPath)
  const catalogPath = validateDirectorBrainCatalogPath(options.catalogPath || DEFAULT_CATALOG_PATH)
  let catalog = await readCatalog(catalogPath)
  const context = runtimeContext(schema, catalog, options.appId, {
    allowPartialTables: true,
    allowLegacyV1: true,
  })
  const legacyV1 = Number(catalog?.schemaVersion) === 1
  if (legacyV1 && options.migrationBackupVerified !== true) {
    throw new Error('director_brain_migration_backup_required')
  }
  if (!catalog?.appToken) await prepareCatalogRoot(catalogPath)
  const accessToken = await tenantAccessToken(context.appId, context.service)
  const createdTables = []
  const reconciled = {}

  if (!catalog?.appToken) {
    const app = await createBitable(accessToken, schema.brainName)
    catalog = {
      schemaVersion: schema.schemaVersion,
      brainName: schema.brainName,
      projectId: schema.projectId,
      environment: schema.environment,
      keychainService: schema.keychainService,
      appId: context.appId,
      appToken: app.app_token,
      url: app.url,
      defaultTableId: app.default_table_id,
      tables: {},
    }
    if (!legacyV1) await writeCatalog(catalogPath, catalog)
  }

  const existing = await listTables(accessToken, catalog.appToken)
  await preflightBootstrapRemoteState(
    accessToken,
    catalog.appToken,
    schema,
    catalog,
    existing,
  )
  const existingById = new Map(existing.map(table => [table.table_id, table]))
  const existingByName = new Map()
  for (const remoteTable of existing) {
    const matches = existingByName.get(remoteTable.name) || []
    matches.push(remoteTable)
    existingByName.set(remoteTable.name, matches)
  }
  for (const table of schema.tables) {
    if ((existingByName.get(table.name) || []).length > 1) {
      throw new Error('duplicate_remote_table_name:' + table.name)
    }
  }

  for (let index = 0; index < schema.tables.length; index += 1) {
    const table = schema.tables[index]
    let tableId = catalog.tables?.[table.key]?.tableId
    if (tableId && !existingById.has(tableId)) throw new Error('catalog_table_missing:' + table.key)
    if (tableId && existingById.get(tableId)?.name !== table.name) {
      throw new Error('catalog_table_name_mismatch:' + table.key)
    }
    if (!tableId && existingByName.has(table.name)) {
      tableId = existingByName.get(table.name)[0].table_id
    }
    if (!tableId && index === 0 && catalog.defaultTableId && existingById.has(catalog.defaultTableId)) {
      tableId = catalog.defaultTableId
      await renameTable(accessToken, catalog.appToken, tableId, table.name)
      createdTables.push(table.key)
    }
    if (!tableId) {
      tableId = await createTable(accessToken, catalog.appToken, table)
      createdTables.push(table.key)
    }
    catalog.tables = catalog.tables || {}
    catalog.tables[table.key] = { name: table.name, tableId }
    const fieldResult = await ensureTableFields(
      accessToken,
      catalog.appToken,
      tableId,
      table,
    )
    reconciled[table.key] = {
      ...fieldResult,
      blankStarterRecordsRemoved: await removeBlankStarterRecords(
        accessToken,
        catalog.appToken,
        tableId,
      ),
      starterFieldsRemoved: await removeUnusedStarterFields(
        accessToken,
        catalog.appToken,
        tableId,
      ),
    }
    if (!legacyV1) await writeCatalog(catalogPath, catalog)
  }

  delete catalog.defaultTableId
  catalog.schemaVersion = schema.schemaVersion
  await writeCatalog(catalogPath, catalog)
  const contract = await checkDirectorBrain({ ...options, catalogPath })
  return {
    ok: true,
    brainName: schema.brainName,
    projectId: schema.projectId,
    environment: schema.environment,
    createdBitable: !context.catalog?.appToken,
    createdTables,
    reconciled,
    tableCount: schema.tables.length,
    contractVerified: contract.ok,
    catalogPath,
    url: catalog.url,
  }
}

function filterLiteral(value) {
  return String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
}

export function exactRecordFilter(fieldName, value) {
  if (String(fieldName).includes(']')) throw new Error('invalid_filter_field')
  return 'CurrentValue.[' + fieldName + ']="' + filterLiteral(value) + '"'
}

function assertNoSecrets(fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (SECRET_FIELD_PATTERN.test(name)) throw new Error('secret_field_forbidden:' + name)
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (SECRET_VALUE_PATTERNS.some(pattern => pattern.test(text))) {
      throw new Error('sensitive_value_forbidden:' + name)
    }
  }
}

function normalizeRecordFields(table, fields) {
  assertNoSecrets(fields)
  const types = new Map(table.fields.map(field => [field.name, field.type]))
  for (const name of Object.keys(fields)) {
    if (!types.has(name)) throw new Error('unknown_record_field:' + table.key + ':' + name)
  }
  return Object.fromEntries(Object.entries(fields).map(([name, value]) => {
    if (value !== null && types.get(name) === 5 && typeof value === 'string') {
      const timestamp = Date.parse(value)
      if (!Number.isFinite(timestamp)) throw new Error('invalid_record_date:' + name)
      return [name, timestamp]
    }
    return [name, value]
  }))
}

function assertSafeOperationContent(value, path = 'request') {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    if (value.length > MAX_OPERATION_TEXT_LENGTH) {
      throw new Error('operation_text_too_long:' + path)
    }
    if (SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value))) {
      throw new Error('sensitive_value_forbidden:' + path)
    }
    if (containsFeishuResourceId(value)) {
      throw new Error('feishu_resource_id_forbidden:' + path)
    }
    if (TRANSCRIPT_VALUE_PATTERN.test(value)) {
      throw new Error('full_transcript_forbidden:' + path)
    }
    if (ABSOLUTE_PATH_PATTERN.test(value)) {
      throw new Error('absolute_path_forbidden:' + path)
    }
    if (FILE_OR_DATA_URL_PATTERN.test(value)) {
      throw new Error('embedded_resource_forbidden:' + path)
    }
    if (MEDIA_URL_PATTERN.test(value)) {
      throw new Error('media_url_forbidden:' + path)
    }
    if (HTTP_URL_PATTERN.test(value)) {
      throw new Error('http_url_forbidden:' + path)
    }
    if (BASE64_BLOB_PATTERN.test(value)) {
      throw new Error('base64_blob_forbidden:' + path)
    }
    return
  }
  if (typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertSafeOperationContent(value[index], path + '[' + index + ']')
    }
    return
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) throw new Error('sensitive_key_forbidden:' + key)
    if (TASK_STATE_KEY_PATTERN.test(key)) throw new Error('task_state_forbidden:' + key)
    if (TRANSCRIPT_KEY_PATTERN.test(key)) throw new Error('full_transcript_forbidden:' + key)
    assertSafeOperationContent(nested, path + '.' + key)
  }
}

function assertSafeRemoteOutput(value, path = 'record', options = {}) {
  if (value === null || value === undefined) return
  if (typeof value === 'string') {
    if (value.length > MAX_OPERATION_TEXT_LENGTH) throw new Error('operation_text_too_long:' + path)
    if (SECRET_VALUE_PATTERNS.some(pattern => pattern.test(value))) {
      throw new Error('sensitive_value_forbidden:' + path)
    }
    if (containsFeishuResourceId(value)) {
      throw new Error('feishu_resource_id_forbidden:' + path)
    }
    if (!options.allowTranscriptPolicyText && TRANSCRIPT_VALUE_PATTERN.test(value)) {
      throw new Error('full_transcript_forbidden:' + path)
    }
    if (ABSOLUTE_PATH_PATTERN.test(value)) throw new Error('absolute_path_forbidden:' + path)
    if (FILE_OR_DATA_URL_PATTERN.test(value)) throw new Error('embedded_resource_forbidden:' + path)
    if (MEDIA_URL_PATTERN.test(value)) throw new Error('media_url_forbidden:' + path)
    if (HTTP_URL_PATTERN.test(value)) throw new Error('http_url_forbidden:' + path)
    if (BASE64_BLOB_PATTERN.test(value)) throw new Error('base64_blob_forbidden:' + path)
    return
  }
  if (typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      assertSafeRemoteOutput(value[index], path + '[' + index + ']', options)
    }
    return
  }
  for (const [key, nested] of Object.entries(value)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) throw new Error('sensitive_key_forbidden:' + key)
    if (TASK_STATE_KEY_PATTERN.test(key)) throw new Error('task_state_forbidden:' + key)
    assertSafeRemoteOutput(nested, path + '.' + key, options)
  }
}

function assertSerializedSize(value, maximumBytes, errorPrefix) {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error(errorPrefix + '_not_serializable')
  }
  if (typeof serialized !== 'string') throw new Error(errorPrefix + '_not_serializable')
  if (Buffer.byteLength(serialized, 'utf8') > maximumBytes) {
    throw new Error(errorPrefix + '_too_large')
  }
}

function assertOperationRequestSize(value) {
  assertSerializedSize(value, MAX_OPERATION_INPUT_BYTES, 'operation_request')
}

function normalizeOperationString(value, fieldName) {
  if (typeof value !== 'string') throw new Error('record_field_type_invalid:' + fieldName)
  const normalized = value.normalize('NFKC').replace(/\r\n?/gu, '\n').trim()
  if (!normalized) throw new Error('record_field_empty:' + fieldName)
  assertSafeOperationContent(normalized, 'fields.' + fieldName)
  return normalized
}

function normalizeOperationField(field, value) {
  if (Number(field.type) === 1) return normalizeOperationString(value, field.name)
  if (Number(field.type) === 2) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error('record_field_type_invalid:' + field.name)
    }
    if (CONFIDENCE_FIELDS.has(field.name) && (value < 0 || value > 1)) {
      throw new Error('record_number_out_of_range:' + field.name)
    }
    if (MATERIAL_VALUE_FIELDS.has(field.name) && (value < 0 || value > 100)) {
      throw new Error('record_number_out_of_range:' + field.name)
    }
    if (field.name === '验证次数' && (!Number.isSafeInteger(value) || value < 0)) {
      throw new Error('record_number_out_of_range:' + field.name)
    }
    return value
  }
  if (Number(field.type) === 3) {
    const normalized = normalizeOperationString(value, field.name)
    if (!field.options.includes(normalized)) {
      throw new Error('record_select_value_invalid:' + field.name)
    }
    return normalized
  }
  if (Number(field.type) === 4) {
    if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
      throw new Error('record_field_type_invalid:' + field.name)
    }
    const normalized = value.map(item => normalizeOperationString(item, field.name))
    if (new Set(normalized).size !== normalized.length
      || normalized.some(item => !field.options.includes(item))) {
      throw new Error('record_select_value_invalid:' + field.name)
    }
    return normalized
  }
  if (Number(field.type) === 5) {
    const timestamp = typeof value === 'string' ? Date.parse(value) : value
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error('record_field_type_invalid:' + field.name)
    }
    return timestamp
  }
  throw new Error('record_field_type_invalid:' + field.name)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => (
      JSON.stringify(key) + ':' + canonicalJson(value[key])
    )).join(',') + '}'
  }
  return JSON.stringify(value)
}

function normalizeProposalBusinessFields(table, rawFields) {
  const fields = requireObject(rawFields, 'operation_fields')
  const entries = Object.entries(fields)
  if (!entries.length) throw new Error('operation_fields_required')
  const definitions = new Map(table.fields.map(field => [field.name, field]))
  const normalized = {}
  for (const [name, value] of entries) {
    if (name === table.stableId) throw new Error('caller_stable_id_forbidden')
    if (SERVICE_OWNED_FIELDS.has(name)) throw new Error('service_owned_field_forbidden:' + name)
    if (REFERENCE_FIELD_NAMES.has(name)) throw new Error('reference_field_service_owned:' + name)
    if (HUMAN_ONLY_FIELDS.has(name)) throw new Error('human_confirmation_field_forbidden:' + name)
    if (EDITING_FIELDS.has(name) || /剪辑|davinci/iu.test(name)) {
      throw new Error('editing_field_forbidden:' + name)
    }
    if (TASK_STATE_KEY_PATTERN.test(name)) throw new Error('task_state_forbidden:' + name)
    if (TRANSCRIPT_KEY_PATTERN.test(name)) throw new Error('full_transcript_forbidden:' + name)
    const definition = definitions.get(name)
    if (!definition) throw new Error('unknown_record_field:' + table.key + ':' + name)
    normalized[name] = normalizeOperationField(definition, value)
  }
  const primaryName = table.fields[0].name
  if (!Object.hasOwn(normalized, primaryName)) {
    throw new Error('primary_record_field_required:' + primaryName)
  }
  for (const required of PROPOSAL_REQUIRED_FIELDS[table.key] || []) {
    if (!Object.hasOwn(normalized, required)) {
      throw new Error('proposal_required_field_missing:' + table.key + ':' + required)
    }
  }
  assertSafeOperationContent(normalized, 'fields')
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)))
}

function normalizeCompleteOperationFields(table, fields) {
  const definitions = new Map(table.fields.map(field => [field.name, field]))
  const normalized = {}
  for (const [name, value] of Object.entries(fields)) {
    const definition = definitions.get(name)
    if (!definition) throw new Error('unknown_record_field:' + table.key + ':' + name)
    normalized[name] = normalizeOperationField(definition, value)
  }
  return normalized
}

function assertOperationWriteReadback(table, rawRecord, writeFields, errorCode) {
  const observed = sanitizedRecordFields(table, rawRecord?.fields)
  const expected = normalizeCompleteOperationFields(table, writeFields)
  for (const [name, value] of Object.entries(expected)) {
    if (!Object.hasOwn(observed, name)
      || canonicalJson(observed[name]) !== canonicalJson(value)) {
      throw new Error(errorCode)
    }
  }
  return operationRecord(table, rawRecord)
}

function stableProposalId(tableKey, businessFields) {
  const digest = createHash('sha256')
    .update(canonicalJson({ table: tableKey, fields: businessFields }), 'utf8')
    .digest('hex')
  return 'DB-' + tableKey.toUpperCase().replace(/_/gu, '-') + '-' + digest
}

function validateOperationStableId(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 160) {
    throw new Error('stable_record_id_invalid')
  }
  if (/[\u0000-\u001f\u007f]/u.test(value)) throw new Error('stable_record_id_invalid')
  assertSafeOperationContent(value, 'stableId')
  return value
}

function normalizeReferenceList(value, name, required) {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REFERENCE_IDS) {
    throw new Error('reference_list_invalid:' + name)
  }
  const normalized = value.map(item => validateOperationStableId(item))
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('reference_list_duplicate:' + name)
  }
  return normalized
}

function normalizeProposalReferences(table, rawReferences) {
  const rule = PROPOSAL_REFERENCE_RULES[table.key]
  if (!rule) throw new Error('proposal_reference_rule_missing:' + table.key)
  const references = rawReferences === undefined ? {} : requireObject(rawReferences, 'operation_references')
  const allowed = new Set([
    ...Object.keys(rule.required || {}),
    ...Object.keys(rule.optional || {}),
    ...Object.keys(rule.requiredMany || {}),
    ...Object.keys(rule.optionalMany || {}),
  ])
  const extra = Object.keys(references).filter(key => !allowed.has(key))
  if (extra.length) throw new Error('reference_field_unexpected:' + extra.join(','))
  const normalized = {}
  for (const name of Object.keys(rule.required || {})) {
    normalized[name] = validateOperationStableId(references[name])
  }
  for (const name of Object.keys(rule.optional || {})) {
    if (references[name] !== undefined) normalized[name] = validateOperationStableId(references[name])
  }
  for (const name of Object.keys(rule.requiredMany || {})) {
    normalized[name] = normalizeReferenceList(references[name], name, true)
  }
  for (const name of Object.keys(rule.optionalMany || {})) {
    normalized[name] = normalizeReferenceList(references[name], name, false)
  }
  return normalized
}

function normalizeAssemblyReferences(rawReferences) {
  const references = requireObject(rawReferences, 'assembly_references')
  const allowed = new Set(Object.keys(ASSEMBLY_REFERENCE_TABLES))
  const extra = Object.keys(references).filter(key => !allowed.has(key))
  if (extra.length) throw new Error('reference_field_unexpected:' + extra.join(','))
  if (!Object.hasOwn(references, 'intentVersionId')) {
    throw new Error('assembly_intent_version_required')
  }
  if (!Object.hasOwn(references, 'evidenceIds')) {
    throw new Error('assembly_evidence_required')
  }
  const normalized = {}
  let total = 0
  for (const [name, [, many]] of Object.entries(ASSEMBLY_REFERENCE_TABLES)) {
    if (many) {
      normalized[name] = normalizeReferenceList(
        references[name],
        name,
        name === 'evidenceIds',
      )
      total += normalized[name].length
    } else {
      normalized[name] = validateOperationStableId(references[name])
      total += 1
    }
  }
  if (total > 60) throw new Error('assembly_reference_limit_exceeded')
  return normalized
}

function sanitizedRecordFields(table, rawFields) {
  const fields = requireObject(rawFields || {}, 'remote_record_fields')
  const safe = {}
  for (const field of table.fields) {
    if (HIDDEN_OUTPUT_FIELDS.has(field.name)) continue
    if (!Object.hasOwn(fields, field.name)) continue
    const value = fields[field.name]
    if (Number(field.type) === 2) {
      const numeric = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
      if (!Number.isFinite(numeric)) {
        throw new Error('remote_record_number_invalid:' + table.key + ':' + field.name)
      }
      safe[field.name] = numeric
    } else if (Number(field.type) === 5) {
      const timestamp = typeof value === 'string' && !/^\d+$/u.test(value)
        ? Date.parse(value)
        : Number(value)
      if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
        throw new Error('remote_record_timestamp_invalid:' + table.key + ':' + field.name)
      }
      safe[field.name] = timestamp
    } else {
      safe[field.name] = value
    }
  }
  assertSafeRemoteOutput(safe, 'record', {
    // Governance records must be able to state that full transcripts are forbidden.
    allowTranscriptPolicyText: table.key === 'system_blueprint',
  })
  return safe
}

function reviewedRecordContractValid(table, fields) {
  const definitions = new Map(table.fields.map(field => [field.name, field]))
  const required = new Set([
    ...requiredReviewFields(table),
    '版本',
    '来源',
    '更新时间',
    ...(table.key === 'system_blueprint' ? ['环境', '类型', '内容'] : []),
  ])
  const auditFields = ['审核人', '审核时间', '审核原因']
  if (auditFields.some(name => definitions.has(name))) {
    if (!auditFields.every(name => definitions.has(name))) return false
    for (const name of auditFields) required.add(name)
  }
  try {
    for (const name of required) {
      const value = fields[name]
      if (value === undefined || value === null
        || (typeof value === 'string' && !value.trim())) return false
      const definition = definitions.get(name)
      if (!definition) return false
      if (Number(definition.type) === 1 && typeof value !== 'string') return false
      if (Number(definition.type) === 2) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return false
        if (CONFIDENCE_FIELDS.has(name) && (value < 0 || value > 1)) return false
        if (MATERIAL_VALUE_FIELDS.has(name) && (value < 0 || value > 100)) return false
        if (name === '验证次数' && (!Number.isSafeInteger(value) || value < 0)) return false
      }
      if (Number(definition.type) === 3
        && (typeof value !== 'string' || !definition.options.includes(value))) return false
      if (Number(definition.type) === 4
        && (!Array.isArray(value) || !value.length
          || value.some(item => !definition.options.includes(item)))) return false
      if (Number(definition.type) === 5
        && (!Number.isSafeInteger(value) || value < 0)) return false
    }
    if (!/^v\d+\.\d+\.\d+$/u.test(String(fields['版本'] || ''))) return false
    if (definitions.has('审核时间') && Number(fields['审核时间']) <= 0) return false
    if (Number(fields['更新时间']) <= 0) return false
    if (table.key === 'material_evidence') {
      if (!/^[a-f0-9]{64}$/u.test(String(fields['校验摘要'] || ''))) return false
      assertEvidenceTimecode({ stableId: String(fields[table.stableId] || ''), fields })
    }
    return true
  } catch {
    return false
  }
}

function operationRecord(table, record) {
  const fields = sanitizedRecordFields(table, record?.fields)
  const stableId = String(fields[table.stableId] || '').trim()
  if (!stableId) throw new Error('remote_stable_record_id_missing:' + table.key)
  const stateField = statusFieldForTable(table)
  const state = stateField ? String(fields[stateField.name] || '').trim() || null : null
  const reviewContractValid = reviewedRecordContractValid(table, fields)
  const reviewed = state !== null
    && REVIEWED_STATUSES_BY_TABLE[table.key]?.has(state) === true
    && reviewContractValid
  if (table.key === 'director_cases' && !reviewed) delete fields['成片位置']
  const operationRecordValue = {
    table: table.key,
    stableId,
    state,
    reviewed,
    fields,
  }
  Object.defineProperty(operationRecordValue, REVIEW_CONTRACT_VALID, {
    value: reviewContractValid,
    enumerable: false,
  })
  return operationRecordValue
}

function assertUniqueOperationStableIds(table, records) {
  const stableIds = new Set()
  for (const record of records) {
    if (stableIds.has(record.stableId)) {
      throw new Error('duplicate_stable_record_id:' + table.key + ':' + record.stableId)
    }
    stableIds.add(record.stableId)
  }
}

function operationRecordWorkId(table, record) {
  return table.key === 'works'
    ? record.stableId
    : String(record.fields['作品 ID'] || '').trim()
}

function isHistoricallyReviewedRecord(record) {
  return record.reviewed
    || (['废弃', '失效', '已合并', '已解决', '归档'].includes(record.state)
      && record[REVIEW_CONTRACT_VALID] === true)
}

function assertOperationRecordScope(context, table, record, workId = null) {
  const observedProjectId = String(record.fields['项目 ID'] || '').trim()
  if (!observedProjectId) {
    throw new Error('record_project_missing:' + table.key + ':' + record.stableId)
  }
  if (observedProjectId !== context.schema.projectId) {
    throw new Error('record_project_mismatch:' + table.key + ':' + record.stableId)
  }
  if (table.key !== 'system_blueprint') {
    const observedWorkId = operationRecordWorkId(table, record)
    if (!observedWorkId) throw new Error('record_work_missing:' + table.key + ':' + record.stableId)
    if (workId && observedWorkId !== workId) {
      throw new Error('record_work_mismatch:' + table.key + ':' + record.stableId)
    }
  }
}

function parseEvidenceTimecode(value, fieldName) {
  if (typeof value !== 'string' || !/^\d{2,}:\d{2}:\d{2}(?:\.\d{1,3})?$/u.test(value)) {
    throw new Error('evidence_timecode_invalid:' + fieldName)
  }
  const [hours, minutes, seconds] = value.split(':')
  const numericHours = Number(hours)
  const numericMinutes = Number(minutes)
  const numericSeconds = Number(seconds)
  if (!Number.isSafeInteger(numericHours) || numericMinutes > 59 || numericSeconds >= 60) {
    throw new Error('evidence_timecode_invalid:' + fieldName)
  }
  return numericHours * 3600 + numericMinutes * 60 + numericSeconds
}

function assertEvidenceTimecode(record) {
  const start = parseEvidenceTimecode(record.fields['起始时间码'], '起始时间码')
  const end = parseEvidenceTimecode(record.fields['结束时间码'], '结束时间码')
  if (end <= start) throw new Error('evidence_timecode_range_invalid:' + record.stableId)
}

async function loadReviewedReference(context, dependencies, tableKey, stableId, workId = null) {
  const table = operationTable(context.schema, tableKey)
  const { tableId } = tableContext(context.schema, context.catalog, table.key)
  const records = await dependencies.findExact({ context, table, tableId, stableId })
  if (!Array.isArray(records)) throw new Error('operation_dependency_result_invalid')
  if (records.length !== 1) {
    throw new Error(records.length > 1
      ? 'duplicate_stable_record_id:' + table.key
      : 'reference_record_missing:' + table.key + ':' + stableId)
  }
  const record = operationRecord(table, records[0])
  assertOperationRecordScope(context, table, record, workId)
  if (table.key === 'material_evidence') assertEvidenceTimecode(record)
  if (!record.reviewed) throw new Error('reference_record_not_reviewed:' + table.key + ':' + stableId)
  return record
}

async function resolveProposalReferences(context, dependencies, table, rawReferences, workId) {
  const normalized = normalizeProposalReferences(table, rawReferences)
  const rule = PROPOSAL_REFERENCE_RULES[table.key]
  const fields = {}
  const records = {}
  for (const groupName of ['required', 'optional']) {
    for (const [name, [tableKey, fieldName]] of Object.entries(rule[groupName] || {})) {
      if (normalized[name] === undefined) continue
      records[name] = await loadReviewedReference(
        context, dependencies, tableKey, normalized[name], workId,
      )
      fields[fieldName] = normalized[name]
    }
  }
  for (const groupName of ['requiredMany', 'optionalMany']) {
    for (const [name, [tableKey, fieldName]] of Object.entries(rule[groupName] || {})) {
      const values = normalized[name] || []
      records[name] = []
      for (const stableId of values) {
        records[name].push(await loadReviewedReference(
          context, dependencies, tableKey, stableId, workId,
        ))
      }
      if (values.length) fields[fieldName] = values.join('\n')
    }
  }
  if (table.key === 'story_relations' && normalized.sourceNodeId === normalized.targetNodeId) {
    throw new Error('story_relation_self_reference_forbidden')
  }
  return { normalized, fields, records }
}

function splitStoredReferences(value) {
  if (typeof value !== 'string' || !value.trim()) return []
  return value.split('\n').map(item => item.trim()).filter(Boolean)
}

function assertReferenceSetIncluded(value, included, fieldName) {
  const values = splitStoredReferences(value)
  if (!values.length || values.some(stableId => !included.has(stableId))) {
    throw new Error('assembly_reference_incomplete:' + fieldName)
  }
}

function assertAssemblyIntegrity(grouped, references) {
  const evidenceIds = new Set(references.evidenceIds)
  const nodeIds = new Set(references.storyNodeIds)
  const judgmentIds = new Set(references.materialJudgmentIds)
  const caseIds = new Set(references.directorCaseIds)
  for (const record of grouped.peopleProfiles) {
    assertReferenceSetIncluded(record.fields['证据 ID'], evidenceIds, 'people_profiles.证据 ID')
  }
  for (const record of grouped.storyNodes) {
    assertReferenceSetIncluded(record.fields['证据 ID'], evidenceIds, 'story_nodes.证据 ID')
  }
  for (const record of grouped.storyRelations) {
    assertReferenceSetIncluded(record.fields['源节点 ID'], nodeIds, 'story_relations.源节点 ID')
    assertReferenceSetIncluded(record.fields['目标节点 ID'], nodeIds, 'story_relations.目标节点 ID')
    assertReferenceSetIncluded(record.fields['证据 ID'], evidenceIds, 'story_relations.证据 ID')
  }
  for (const record of grouped.materialJudgments) {
    if (record.fields['意图版本 ID'] !== references.intentVersionId) {
      throw new Error('assembly_intent_mismatch:material_judgments')
    }
    assertReferenceSetIncluded(record.fields['证据 ID'], evidenceIds, 'material_judgments.证据 ID')
  }
  for (const record of grouped.narrativePlans) {
    if (record.fields['意图版本 ID'] !== references.intentVersionId) {
      throw new Error('assembly_intent_mismatch:narrative_plans')
    }
    assertReferenceSetIncluded(record.fields['节点 ID'], nodeIds, 'narrative_plans.节点 ID')
    assertReferenceSetIncluded(record.fields['证据 ID'], evidenceIds, 'narrative_plans.证据 ID')
  }
  for (const record of grouped.directorCases) {
    assertReferenceSetIncluded(record.fields['判断 ID'], judgmentIds, 'director_cases.判断 ID')
    assertReferenceSetIncluded(record.fields['证据 ID'], evidenceIds, 'director_cases.证据 ID')
  }
  for (const record of grouped.skillsTechniques) {
    assertReferenceSetIncluded(record.fields['案例 ID'], caseIds, 'skills_techniques.案例 ID')
  }
}

function inspectWorkflowReferenceIntegrity(reviewed, allRecords = reviewed) {
  const indexes = Object.fromEntries(Object.entries(reviewed).map(([tableKey, records]) => [
    tableKey,
    new Set(records.map(record => record.stableId)),
  ]))
  const historicalIndexes = Object.fromEntries(Object.entries(allRecords).map(([tableKey, records]) => [
    tableKey,
    new Set(records.filter(isHistoricallyReviewedRecord).map(record => record.stableId)),
  ]))
  const issues = []
  const invalidRecords = new Set()
  const addIssue = (tableKey, record, fieldName, reason) => {
    invalidRecords.add(tableKey + ':' + record.stableId)
    issues.push({ table: tableKey, stableId: record.stableId, field: fieldName, reason })
  }
  let changed = true
  while (changed) {
    changed = false
    for (const [tableKey, records] of Object.entries(reviewed)) {
      const rule = tableKey === 'material_evidence'
        ? { optional: { previousEvidenceId: ['material_evidence', '上一版本 ID'] } }
        : (PROPOSAL_REFERENCE_RULES[tableKey] || {})
      for (const record of records) {
        if (invalidRecords.has(tableKey + ':' + record.stableId)) continue
        const recordIssues = []
        const recordIssue = (fieldName, reason) => recordIssues.push({ fieldName, reason })
      for (const groupName of ['required', 'optional']) {
        for (const [, [targetTable, fieldName]] of Object.entries(rule[groupName] || {})) {
          const stableId = String(record.fields[fieldName] || '').trim()
          if (!stableId) {
            if (groupName === 'required') recordIssue(fieldName, 'missing')
            continue
          }
          const targetIndex = fieldName === '上一版本 ID'
            ? historicalIndexes[targetTable]
            : indexes[targetTable]
          if (!targetIndex?.has(stableId)) {
            recordIssue(fieldName, 'not_reviewed_or_missing')
          }
        }
      }
      for (const groupName of ['requiredMany', 'optionalMany']) {
        for (const [, [targetTable, fieldName]] of Object.entries(rule[groupName] || {})) {
          const stableIds = splitStoredReferences(record.fields[fieldName])
          if (!stableIds.length && groupName === 'requiredMany') {
            recordIssue(fieldName, 'missing')
            continue
          }
          if (stableIds.some(stableId => !indexes[targetTable]?.has(stableId))) {
            recordIssue(fieldName, 'not_reviewed_or_missing')
          }
        }
      }
        if (recordIssues.length) {
          for (const issue of recordIssues) addIssue(
            tableKey, record, issue.fieldName, issue.reason,
          )
          indexes[tableKey]?.delete(record.stableId)
          changed = true
        }
      }
    }
  }
  return {
    valid: issues.length === 0,
    issues,
    validRecords: Object.fromEntries(Object.entries(reviewed).map(([tableKey, records]) => [
      tableKey,
      records.filter(record => !invalidRecords.has(tableKey + ':' + record.stableId)),
    ])),
  }
}

function businessFieldsMatch(table, record, businessFields) {
  const fields = record?.fields || {}
  const definitions = new Map(table.fields.map(field => [field.name, field]))
  try {
    return Object.entries(businessFields).every(([name, expected]) => (
      canonicalJson(normalizeOperationField(
        definitions.get(name),
        Number(definitions.get(name)?.type) === 2 && typeof fields[name] === 'string'
          ? Number(fields[name])
          : fields[name],
      ))
        === canonicalJson(expected)
    ))
  } catch {
    return false
  }
}

function statusFieldForTable(table) {
  return table.fields.find(field => field.name === '状态')
    || table.fields.find(field => field.name === '复核状态')
    || null
}

function recordMatchesSearch(table, fields, query, status, reviewed = null) {
  const statusField = statusFieldForTable(table)
  if (status) {
    if (!statusField || fields[statusField.name] !== status) return false
  } else {
    if (reviewed === false) return false
    if (reviewed === null) {
      const state = statusField ? String(fields[statusField.name] || '').trim() : ''
      if (!REVIEWED_STATUSES_BY_TABLE[table.key]?.has(state)) return false
    }
  }
  const normalizedQuery = query.normalize('NFKC').toLocaleLowerCase('zh-CN')
  return Object.values(fields).some(value => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return String(text || '').normalize('NFKC').toLocaleLowerCase('zh-CN').includes(normalizedQuery)
  })
}

async function createRecord(accessToken, appToken, tableId, fields) {
  const response = await requestJson(
    'POST',
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records',
    { accessToken, payload: { fields } },
  )
  return response.data.record
}

async function updateRecord(accessToken, appToken, tableId, recordId, fields) {
  const response = await requestJson(
    'PUT',
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records/' + recordId,
    { accessToken, payload: { fields } },
  )
  return response.data.record
}

async function deleteRecord(accessToken, appToken, tableId, recordId) {
  await requestJson(
    'DELETE',
    '/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records/' + recordId,
    { accessToken },
  )
}

function tableContext(schema, catalog, tableKey) {
  const table = schema.tables.find(item => item.key === tableKey)
  if (!table) throw new Error('unknown_table_key:' + tableKey)
  const ref = catalog.tables?.[tableKey]
  if (!ref?.tableId) throw new Error('table_not_bootstrapped:' + tableKey)
  return { table, tableId: ref.tableId }
}

async function connectedContext(options = {}) {
  const schema = await loadDirectorBrainSchema(options.schemaPath)
  const catalogPath = validateDirectorBrainCatalogPath(options.catalogPath || DEFAULT_CATALOG_PATH)
  const catalog = await readCatalog(catalogPath)
  if (!catalog?.appToken) throw new Error('director_brain_catalog_missing')
  const context = runtimeContext(schema, catalog, options.appId)
  const accessToken = await tenantAccessToken(context.appId, context.service)
  return { ...context, accessToken, catalogPath }
}

function recordFieldEquals(field, actual, expected) {
  if (Number(field.type) === 5) {
    const actualTime = typeof actual === 'string' && !/^\d+$/u.test(actual)
      ? Date.parse(actual)
      : Number(actual)
    const expectedTime = typeof expected === 'string' && !/^\d+$/u.test(expected)
      ? Date.parse(expected)
      : Number(expected)
    return Number.isFinite(actualTime) && actualTime === expectedTime
  }
  return JSON.stringify(actual) === JSON.stringify(expected)
}

async function createSeedRecordIfMissing(context, tableKey, fields) {
  const { table, tableId } = tableContext(context.schema, context.catalog, tableKey)
  const stableId = requireNonEmpty(fields[table.stableId], 'stable_record_id')
  const normalized = normalizeRecordFields(table, fields)
  const matches = await listRecords(
    context.accessToken,
    context.catalog.appToken,
    tableId,
    exactRecordFilter(table.stableId, stableId),
  )
  const exact = matches.filter(record => String(record.fields?.[table.stableId] || '').trim() === stableId)
  if (exact.length > 1) throw new Error('duplicate_stable_record_id:' + tableKey + ':' + stableId)
  if (exact.length === 1) {
    const fieldTypes = new Map(table.fields.map(field => [field.name, field]))
    const mismatched = Object.entries(normalized)
      .filter(([name, expected]) => !recordFieldEquals(
        fieldTypes.get(name),
        exact[0].fields?.[name],
        expected,
      ))
      .map(([name]) => name)
    if (mismatched.length) {
      throw new Error('seed_record_conflict:' + tableKey + ':' + stableId + ':' + mismatched.join(','))
    }
    return { action: 'unchanged', record: exact[0] }
  }
  const record = await createRecord(
    context.accessToken,
    context.catalog.appToken,
    tableId,
    normalized,
  )
  return { action: 'created', record }
}

export function initialDirectorBrainBlueprint(projectId = 'PROJ-VIDEO-AUTOWORKER') {
  const common = {
    '项目 ID': projectId,
    '环境': '测试',
    '状态': '生效',
    '版本': 'v0.1.0',
    '来源': '用户确认/2026-08-30',
    '更新时间': '2026-08-30T00:00:00+08:00',
  }
  return [
    {
      ...common,
      '标题': '导演脑项目定位',
      '规范 ID': 'DB-SPEC-CORE',
      '类型': '定位',
      '内容': '导演脑使用独立飞书测试账号、独立自建应用、独立多维表格和独立凭据服务，但仍属于 Video AutoWorker，不创建第二个项目。',
    },
    {
      ...common,
      '标题': '导演脑最终目标',
      '规范 ID': 'DB-GOAL-FINAL',
      '类型': '目标',
      '内容': '通过学习成片内容和导演判断案例建立技能与技法库，结合素材分析主动发现故事、撰写故事脚本，并在经过实机验证的剪辑软件接口支持下形成可执行剪辑方案。',
    },
    {
      ...common,
      '标题': '导演脑六层架构',
      '规范 ID': 'DB-ARCH-6L',
      '类型': '架构',
      '内容': '六层依次为素材感知、人物理解、故事发现、导演判断、叙事结构和导演意图；所有高层判断必须回链到素材证据与时间码。',
    },
    {
      ...common,
      '标题': '导演经验学习闭环',
      '规范 ID': 'DB-LOOP-CASE',
      '类型': '开发逻辑',
      '内容': '原始素材到导演判断，再记录判断原因、上下文、采用或拒绝、成片位置和最终效果，形成可复核案例并提炼技法；重点学习为什么这样判断。',
    },
    {
      ...common,
      '标题': '单链集成边界',
      '规范 ID': 'DB-INTEGRATION-SINGLE',
      '类型': '集成边界',
      '内容': '导演脑作为长期知识与决策子系统接入现有唯一视频任务链，不维护任务状态机、队列或影子派发链。',
    },
    {
      ...common,
      '标题': '导演脑数据边界',
      '规范 ID': 'DB-DATA-BOUNDARY',
      '类型': '数据边界',
      '内容': '飞书只保存导演意图、人物、故事、判断、叙事、案例、技法以及素材 ID、证据时间码和版本；原片、逐帧图片、完整原始转写、向量、运行日志和凭据留在受控本地系统。',
    },
    {
      ...common,
      '标题': '既有 ID 复用规则',
      '规范 ID': 'DB-ID-REUSE',
      '类型': '开发逻辑',
      '内容': '现有 taskId、batchId、materialId、sceneId 和 shotId 原样作为来源引用，不重新生成；只为人物、故事节点、关系、判断、意图、方案、案例和技法创建稳定领域 ID。',
    },
    {
      ...common,
      '标题': 'DaVinci 分阶段验收',
      '规范 ID': 'DB-DAVINCI-STAGED',
      '类型': '验收',
      '内容': '先生成可校验的 edit-plan，再以时间线副本验证 DaVinci 或其他剪辑软件的正式接口；复杂 AI 功能只有经过目标版本实机测试后才能声明可用。',
    },
    {
      ...common,
      '标题': '完整导演脑当前运行边界',
      '规范 ID': 'DB-SCOPE-NON-EDITING',
      '类型': '集成边界',
      '内容': '当前阶段建设完整导演脑，覆盖导演意图、受信素材证据、人物、故事节点与关系、七维素材判断、叙事方案与故事脚本、导演案例和技能技法；OpenClaw 可组装已审核上下文并提交候选草稿，但不得自动批准或伪造素材证据。DaVinci、剪辑执行、剪辑时间线、渲染和导出能力暂缓。',
    },
  ]
}

export async function seedDirectorBrain(options = {}) {
  const context = await connectedContext(options)
  const records = initialDirectorBrainBlueprint(context.schema.projectId)
  const actions = []
  for (const fields of records) {
    const result = await createSeedRecordIfMissing(context, 'system_blueprint', fields)
    actions.push({
      stableId: fields['规范 ID'],
      action: result.action,
    })
  }
  return { ok: true, seeded: actions.length, actions }
}

function blueprintRecordMatches(table, rawFields, expectedFields) {
  const observed = rawFields || {}
  const definitions = new Map(table.fields.map(field => [field.name, field]))
  return Object.entries(expectedFields).every(([name, expected]) => (
    recordFieldEquals(definitions.get(name), observed[name], expected)
  ))
}

export async function syncDirectorBrainBlueprint(options = {}) {
  const dependencies = operationDependencies(options)
  const context = await dependencies.connect(options)
  const { table, tableId } = tableContext(context.schema, context.catalog, 'system_blueprint')
  const expected = initialDirectorBrainBlueprint(context.schema.projectId).map(fields => ({
    stableId: fields[table.stableId],
    fields: normalizeRecordFields(table, fields),
  }))
  const prepared = []

  // Complete the identity preflight before the first write so one foreign or duplicate
  // record cannot leave an earlier managed blueprint partially updated.
  for (const item of expected) {
    const records = await dependencies.findExact({
      context,
      table,
      tableId,
      stableId: item.stableId,
    })
    if (!Array.isArray(records)) throw new Error('operation_dependency_result_invalid')
    if (records.length > 1) throw new Error('duplicate_stable_record_id:system_blueprint:' + item.stableId)
    const record = records[0] || null
    if (record) {
      if (!record.record_id || typeof record.record_id !== 'string') {
        throw new Error('blueprint_record_identity_missing:' + item.stableId)
      }
      if (record.fields?.[table.stableId] !== item.stableId
        || record.fields?.['项目 ID'] !== context.schema.projectId
        || record.fields?.['来源'] !== item.fields['来源']) {
        throw new Error('blueprint_managed_identity_mismatch:' + item.stableId)
      }
    }
    prepared.push({
      ...item,
      record,
      action: !record
        ? 'created'
        : blueprintRecordMatches(table, record.fields, item.fields) ? 'unchanged' : 'updated',
    })
  }

  for (const item of prepared) {
    if (item.action === 'created') {
      await dependencies.create({ context, table, tableId, fields: item.fields })
    } else if (item.action === 'updated') {
      await dependencies.update({
        context,
        table,
        tableId,
        recordId: item.record.record_id,
        fields: item.fields,
      })
    }
    const verified = await dependencies.findExact({
      context,
      table,
      tableId,
      stableId: item.stableId,
    })
    if (!Array.isArray(verified) || verified.length !== 1) {
      throw new Error('blueprint_sync_readback_count_invalid:' + item.stableId)
    }
    if (!blueprintRecordMatches(table, verified[0].fields, item.fields)) {
      throw new Error('blueprint_sync_readback_mismatch:' + item.stableId)
    }
  }

  const actions = prepared.map(item => ({ stableId: item.stableId, action: item.action }))
  return {
    ok: true,
    synced: actions.length,
    created: actions.filter(item => item.action === 'created').length,
    updated: actions.filter(item => item.action === 'updated').length,
    unchanged: actions.filter(item => item.action === 'unchanged').length,
    actions,
  }
}

export async function writeCheckDirectorBrain(options = {}) {
  const context = await connectedContext(options)
  const tableKey = options.tableKey || 'system_blueprint'
  const { table, tableId } = tableContext(context.schema, context.catalog, tableKey)
  const primaryName = table.fields[0].name
  const stableId = 'DB-WRITE-CHECK-' + randomUUID()
  const fields = normalizeRecordFields(table, {
    [primaryName]: 'API 临时写检查',
    [table.stableId]: stableId,
    ...(table.fields.some(field => field.name === '项目 ID')
      ? { '项目 ID': context.schema.projectId }
      : {}),
  })
  let record = null
  let created = false
  let updated = false
  let operationError = null
  try {
    record = await createRecord(
      context.accessToken,
      context.catalog.appToken,
      tableId,
      fields,
    )
    created = true
    await updateRecord(
      context.accessToken,
      context.catalog.appToken,
      tableId,
      record.record_id,
      { [primaryName]: 'API 临时写检查已更新' },
    )
    updated = true
  } catch (error) {
    operationError = error
  }
  if (record?.record_id) {
    try {
      await deleteRecord(
        context.accessToken,
        context.catalog.appToken,
        tableId,
        record.record_id,
      )
    } catch {
      // Fall through to stable-ID cleanup so a transient direct-delete failure cannot strand data.
    }
  }
  const cleanupDelays = [250, 750, 1_500]
  for (const delayMs of cleanupDelays) {
    try {
      const matches = await listRecords(
        context.accessToken,
        context.catalog.appToken,
        tableId,
        exactRecordFilter(table.stableId, stableId),
      )
      for (const match of matches) {
        try {
          await deleteRecord(
            context.accessToken,
            context.catalog.appToken,
            tableId,
            match.record_id,
          )
        } catch {
          // A later pass and the final residue check decide whether cleanup succeeded.
        }
      }
    } catch {
      // A later pass may succeed after a temporary API or consistency delay.
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, delayMs))
  }
  const residue = await listRecords(
    context.accessToken,
    context.catalog.appToken,
    tableId,
    exactRecordFilter(table.stableId, stableId),
  )
  if (residue.length) throw new Error('director_brain_write_check_cleanup_failed')
  if (operationError) throw operationError
  if (!created || !updated) throw new Error('director_brain_write_check_incomplete')
  return { ok: true, table: tableKey, created, updated, deleted: true, residue: 0 }
}

export async function checkDirectorBrain(options = {}) {
  const context = await connectedContext(options)
  const remoteTables = await listTables(context.accessToken, context.catalog.appToken)
  if (remoteTables.length !== context.schema.tables.length) {
    throw new Error('director_brain_remote_table_count_mismatch')
  }
  const remoteById = new Map(remoteTables.map(table => [table.table_id, table]))
  const expectedRemoteIds = new Set(
    context.schema.tables.map(table => context.catalog.tables[table.key].tableId),
  )
  if (expectedRemoteIds.size !== context.schema.tables.length
    || remoteTables.some(table => !expectedRemoteIds.has(table.table_id))) {
    throw new Error('director_brain_remote_table_set_mismatch')
  }
  const remoteNameCounts = new Map()
  for (const remoteTable of remoteTables) {
    remoteNameCounts.set(remoteTable.name, (remoteNameCounts.get(remoteTable.name) || 0) + 1)
  }
  const result = {}
  for (const table of context.schema.tables) {
    const ref = context.catalog.tables?.[table.key]
    if (!ref?.tableId || !remoteById.has(ref.tableId)) {
      throw new Error('director_brain_table_missing:' + table.key)
    }
    if (ref.name !== table.name || remoteById.get(ref.tableId).name !== table.name) {
      throw new Error('director_brain_table_name_mismatch:' + table.key)
    }
    if (remoteNameCounts.get(table.name) !== 1) {
      throw new Error('director_brain_table_name_not_unique:' + table.key)
    }
    const fields = await listFields(
      context.accessToken,
      context.catalog.appToken,
      ref.tableId,
    )
    const observed = new Map(fields.map(field => [field.field_name, field]))
    if (observed.size !== fields.length) {
      throw new Error('director_brain_field_name_not_unique:' + table.key)
    }
    const missing = table.fields
      .filter(field => Number(observed.get(field.name)?.type) !== Number(field.type))
      .map(field => field.name)
    if (missing.length) throw new Error('director_brain_schema_mismatch:' + table.key + ':' + missing.join(','))
    const expectedNames = new Set(table.fields.map(field => field.name))
    const extra = fields
      .filter(field => !expectedNames.has(field.field_name))
      .map(field => field.field_name)
    if (extra.length) throw new Error('director_brain_unexpected_fields:' + table.key + ':' + extra.join(','))
    const primaries = fields.filter(field => field.is_primary)
    if (primaries.length !== 1
      || primaries[0].field_name !== table.fields[0].name
      || Number(primaries[0].type) !== Number(table.fields[0].type)) {
      throw new Error('director_brain_primary_field_mismatch:' + table.key)
    }
    for (const expected of table.fields.filter(field => field.type === 3 || field.type === 4)) {
      const options = observed.get(expected.name)?.property?.options || []
      const optionNames = new Set(options.map(option => option.name))
      const expectedOptions = new Set(expected.options)
      if (optionNames.size !== options.length
        || optionNames.size !== expectedOptions.size
        || expected.options.some(option => !optionNames.has(option))) {
        throw new Error('director_brain_select_options_mismatch:' + table.key + ':' + expected.name)
      }
    }
    result[table.key] = {
      name: table.name,
      expectedFields: table.fields.length,
      observedFields: fields.length,
    }
  }
  return {
    ok: true,
    brainName: context.schema.brainName,
    projectId: context.schema.projectId,
    environment: context.schema.environment,
    tableCount: context.schema.tables.length,
    tables: result,
    url: context.catalog.url,
  }
}

export async function verifyDirectorBrain(options = {}) {
  const context = await connectedContext(options)
  const check = await checkDirectorBrain(options)
  const blueprint = tableContext(context.schema, context.catalog, 'system_blueprint')
  const expected = initialDirectorBrainBlueprint(context.schema.projectId)
  const stableIds = new Set()
  for (const item of expected) {
    assertNoSecrets(item)
    const id = item['规范 ID']
    if (stableIds.has(id)) throw new Error('duplicate_seed_id:' + id)
    stableIds.add(id)
    const records = await listRecords(
      context.accessToken,
      context.catalog.appToken,
      blueprint.tableId,
      exactRecordFilter('规范 ID', id),
    )
    const exact = records.filter(record => record.fields?.['规范 ID'] === id)
    if (exact.length !== 1) throw new Error('seed_record_count_invalid:' + id)
    assertNoSecrets(exact[0].fields || {})
    const normalized = normalizeRecordFields(blueprint.table, item)
    const fieldTypes = new Map(blueprint.table.fields.map(field => [field.name, field]))
    const mismatched = Object.entries(normalized)
      .filter(([name, value]) => !recordFieldEquals(
        fieldTypes.get(name),
        exact[0].fields?.[name],
        value,
      ))
      .map(([name]) => name)
    if (mismatched.length) {
      throw new Error('seed_record_content_mismatch:' + id + ':' + mismatched.join(','))
    }
  }
  return {
    ...check,
    seedCount: expected.length,
    stableIdsVerified: expected.length,
    seedRemoteContentVerified: true,
    seedRemoteSecretPatternScanPassed: true,
  }
}

function assertOperationKeys(request, allowed) {
  const extra = Object.keys(request).filter(key => !allowed.has(key))
  if (extra.length) throw new Error('operation_field_unexpected:' + extra.join(','))
}

function operationTable(schema, tableKey, allowAll = false) {
  if (allowAll && tableKey === 'all') return null
  if (typeof tableKey !== 'string') throw new Error('operation_table_required')
  const table = schema.tables.find(item => item.key === tableKey)
  if (!table) throw new Error('operation_table_not_allowed:' + tableKey)
  return table
}

async function findExactOperationRecords({ context, table, tableId, stableId }) {
  const exact = []
  let pageToken = null
  let pageCount = 0
  do {
    const response = await requestJson(
      'GET',
      '/bitable/v1/apps/' + context.catalog.appToken + '/tables/' + tableId + '/records',
      {
        accessToken: context.accessToken,
        query: {
          page_size: 20,
          filter: exactRecordFilter(table.stableId, stableId),
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      },
    )
    const data = response.data || {}
    const records = Array.isArray(data.items) ? data.items : []
    exact.push(...records.filter(record => (
      String(record.fields?.[table.stableId] || '').trim() === stableId
    )))
    if (exact.length > 1 || !data.has_more) break
    pageToken = data.page_token
    pageCount += 1
    if (!pageToken || pageCount >= 2) break
  } while (pageToken)
  return exact
}

async function searchOperationRecords({ context, table, tableId, query, status, limit, workId }) {
  const records = []
  const stableIds = new Set()
  let pageToken = null
  let pageCount = 0
  let remoteHasMore = false
  do {
    const response = await requestJson(
      'GET',
      '/bitable/v1/apps/' + context.catalog.appToken + '/tables/' + tableId + '/records',
      {
        accessToken: context.accessToken,
        query: {
          page_size: SEARCH_PAGE_SIZE,
          ...(pageToken ? { page_token: pageToken } : {}),
        },
      },
    )
    const data = response.data || {}
    const items = Array.isArray(data.items) ? data.items : []
    for (const rawRecord of items) {
      const normalizedRecord = operationRecord(table, rawRecord)
      assertOperationRecordScope(context, table, normalizedRecord)
      if (stableIds.has(normalizedRecord.stableId)) {
        throw new Error('duplicate_stable_record_id:' + table.key + ':' + normalizedRecord.stableId)
      }
      stableIds.add(normalizedRecord.stableId)
      if (table.key !== 'system_blueprint' && workId) {
        const observedWorkId = operationRecordWorkId(table, normalizedRecord)
        if (observedWorkId !== workId) continue
      }
      if (recordMatchesSearch(
        table,
        normalizedRecord.fields,
        query,
        status,
        normalizedRecord.reviewed,
      )) records.push(rawRecord)
      if (records.length > limit) break
    }
    remoteHasMore = data.has_more === true
    pageCount += 1
    if (records.length > limit || !remoteHasMore || pageCount >= MAX_SEARCH_PAGES_PER_TABLE) break
    pageToken = data.page_token
    if (!pageToken) throw new Error('feishu_page_token_missing')
  } while (pageToken)
  return {
    records: records.slice(0, limit),
    truncated: records.length > limit || (remoteHasMore && pageCount >= MAX_SEARCH_PAGES_PER_TABLE),
  }
}

async function findOperationRecordsByWork({ context, table, tableId, workId }) {
  const fieldName = table.key === 'works' ? table.stableId : '作品 ID'
  return listRecords(
    context.accessToken,
    context.catalog.appToken,
    tableId,
    exactRecordFilter(fieldName, workId),
  )
}

const WORK_TITLE_WRAPPERS = Object.freeze([
  ['《', '》'],
  ['“', '”'],
  ['‘', '’'],
  ['"', '"'],
  ["'", "'"],
])

function normalizeWorkTitle(value) {
  let normalized = String(value || '').normalize('NFKC').trim()
  let stripped = true
  while (normalized && stripped) {
    stripped = false
    for (const [opening, closing] of WORK_TITLE_WRAPPERS) {
      if (!normalized.startsWith(opening) || !normalized.endsWith(closing)) continue
      const inner = normalized.slice(opening.length, normalized.length - closing.length).trim()
      if (!inner) continue
      normalized = inner
      stripped = true
      break
    }
  }
  return normalized.toLocaleLowerCase('zh-CN')
}

function normalizedWorkNames(fields) {
  return [fields['作品名称'], ...String(fields['别名'] || '').split('\n')]
    .map(normalizeWorkTitle)
    .filter(Boolean)
}

async function resolveWorkRecords({ context, table, tableId, query }) {
  const records = await listRecords(
    context.accessToken,
    context.catalog.appToken,
    tableId,
  )
  const normalizedQuery = normalizeWorkTitle(query)
  return records.filter(record => {
    const normalizedRecord = operationRecord(table, record)
    assertOperationRecordScope(context, table, normalizedRecord, normalizedRecord.stableId)
    return normalizedRecord.reviewed
      && normalizedWorkNames(normalizedRecord.fields).includes(normalizedQuery)
  })
}

async function inspectOperationSchema({ context }) {
  const remoteTables = await listTables(context.accessToken, context.catalog.appToken)
  if (remoteTables.length !== context.schema.tables.length) {
    throw new Error('director_brain_remote_table_count_mismatch')
  }
  const remoteById = new Map(remoteTables.map(table => [table.table_id, table]))
  for (const table of context.schema.tables) {
    const ref = context.catalog.tables?.[table.key]
    if (!ref?.tableId || remoteById.get(ref.tableId)?.name !== table.name) {
      throw new Error('director_brain_runtime_table_mismatch:' + table.key)
    }
    const remoteFields = await listFields(
      context.accessToken,
      context.catalog.appToken,
      ref.tableId,
    )
    const byName = new Map(remoteFields.map(field => [field.field_name, field]))
    if (byName.size !== table.fields.length || remoteFields.length !== table.fields.length) {
      throw new Error('director_brain_runtime_field_count_mismatch:' + table.key)
    }
    for (let index = 0; index < table.fields.length; index += 1) {
      const expected = table.fields[index]
      const observed = byName.get(expected.name)
      if (!observed || Number(observed.type) !== Number(expected.type)
        || Boolean(observed.is_primary) !== (index === 0)) {
        throw new Error('director_brain_runtime_field_mismatch:' + table.key + ':' + expected.name)
      }
      if (expected.options) {
        const observedOptions = (observed.property?.options || []).map(option => option.name)
        if (canonicalJson([...observedOptions].sort()) !== canonicalJson([...expected.options].sort())) {
          throw new Error('director_brain_runtime_option_mismatch:' + table.key + ':' + expected.name)
        }
      }
    }
  }
  return {
    ok: true,
    tableCount: remoteTables.length,
    fingerprint: createHash('sha256')
      .update(canonicalJson(context.schema.tables), 'utf8')
      .digest('hex'),
  }
}

async function assertCreateLockPhysicalPath(pathname) {
  const physicalPath = await realpath(pathname)
  if (physicalPath !== resolve(pathname)) {
    throw new Error('stable_record_create_lock_symlink_forbidden')
  }
  let cursor = physicalPath
  while (true) {
    const stats = await lstat(cursor)
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error('stable_record_create_lock_symlink_forbidden')
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const rootStats = await lstat(physicalPath)
  if ((rootStats.mode & 0o077) !== 0) {
    throw new Error('stable_record_create_lock_permissions_invalid')
  }
}

function parseCreateLockOwner(value, expectedToken = null) {
  try {
    const owner = JSON.parse(value)
    if (!owner || typeof owner !== 'object' || Array.isArray(owner)
      || typeof owner.token !== 'string' || !/^[a-f0-9-]{36}$/u.test(owner.token)
      || (expectedToken !== null && owner.token !== expectedToken)
      || !Number.isSafeInteger(owner.createdAt) || owner.createdAt <= 0
      || !Number.isSafeInteger(owner.leaseUntil)
      || owner.leaseUntil !== owner.createdAt + CREATE_LOCK_LEASE_MS
      || owner.scope !== 'same-catalog-single-deployment') return null
    return owner
  } catch {
    return null
  }
}

async function removeClaimedCreateLock(lockDir, ownerName, expectedOwner, claimKind) {
  const claimName = `.${claimKind}.${randomUUID()}.json`
  const ownerPath = join(lockDir, ownerName)
  const claimPath = join(lockDir, claimName)
  try {
    await rename(ownerPath, claimPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
  const claimedText = await readFile(claimPath, 'utf8')
  const claimedOwner = parseCreateLockOwner(claimedText)
  if (!claimedOwner || claimedOwner.token !== expectedOwner.token
    || claimedOwner.createdAt !== expectedOwner.createdAt
    || claimedOwner.leaseUntil !== expectedOwner.leaseUntil) {
    try {
      await rename(claimPath, ownerPath)
    } catch (error) {
      throw new Error('stable_record_create_lock_manual_repair_required:' + error?.code)
    }
    return false
  }
  const entries = await readdir(lockDir)
  if (entries.length !== 1 || entries[0] !== claimName) {
    await rename(claimPath, ownerPath)
    throw new Error('stable_record_create_lock_manual_repair_required:unexpected_members')
  }
  await unlink(claimPath)
  await rmdir(lockDir)
  return true
}

async function repairEmptyCreateLock(lockDir) {
  const repairPath = join(lockDir, '.repair-claim')
  try {
    await writeFile(repairPath, String(process.pid), { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOENT') return false
    throw error
  }
  try {
    const entries = await readdir(lockDir)
    if (entries.length !== 1 || entries[0] !== '.repair-claim') return false
    await unlink(repairPath)
    await rmdir(lockDir)
    return true
  } finally {
    await unlink(repairPath).catch(error => {
      if (error?.code !== 'ENOENT') throw error
    })
  }
}

async function transientCreateLockClaimIsPending(lockDir, entries, lockStats) {
  if (entries.length !== 1) return null
  const name = entries[0]
  const claimPath = join(lockDir, name)
  const transitionAgeMs = Date.now() - lockStats.mtimeMs
  if (name === '.repair-claim') {
    const claim = await readFile(claimPath, 'utf8').catch(error => {
      if (error?.code === 'ENOENT') return null
      throw error
    })
    if (claim === null) return true
    if (!/^\d+$/u.test(claim)) {
      if (transitionAgeMs <= CREATE_LOCK_INITIALIZATION_GRACE_MS) return true
      throw new Error('stable_record_create_lock_manual_repair_required:repair_claim_invalid')
    }
    if (transitionAgeMs > CREATE_LOCK_TIMEOUT_MS) {
      throw new Error('stable_record_create_lock_manual_repair_required:repair_claim_stuck')
    }
    return true
  }
  const match = /^\.(release|expired)\.([a-f0-9-]{36})\.json$/u.exec(name)
  if (!match) return null
  const [, kind, token] = match
  const claim = await readFile(claimPath, 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (claim === null) return true
  const owner = parseCreateLockOwner(claim, token)
  if (!owner || (kind === 'expired' && Date.now() <= owner.leaseUntil)) {
    throw new Error('stable_record_create_lock_manual_repair_required:claim_invalid')
  }
  if (transitionAgeMs > CREATE_LOCK_TIMEOUT_MS) {
    throw new Error('stable_record_create_lock_manual_repair_required:claim_stuck')
  }
  return true
}

async function inspectAndRepairCreateLock(lockDir) {
  let entries
  let lockStats
  try {
    [entries, lockStats] = await Promise.all([readdir(lockDir), lstat(lockDir)])
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
  const ownerNames = entries.filter(name => /^owner\.[a-f0-9-]{36}\.json$/u.test(name))
  const ageMs = Date.now() - lockStats.mtimeMs
  if (ownerNames.length === 0) {
    if (await transientCreateLockClaimIsPending(lockDir, entries, lockStats)) return false
    if (entries.length !== 0) {
      throw new Error('stable_record_create_lock_manual_repair_required:unexpected_members')
    }
    if (ageMs <= CREATE_LOCK_INITIALIZATION_GRACE_MS) return false
    return repairEmptyCreateLock(lockDir)
  }
  if (ownerNames.length !== 1 || entries.length !== 1) {
    throw new Error('stable_record_create_lock_manual_repair_required:unexpected_members')
  }
  const ownerName = ownerNames[0]
  const ownerText = await readFile(join(lockDir, ownerName), 'utf8').catch(error => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  if (ownerText === null) return false
  const owner = parseCreateLockOwner(ownerText)
  if (!owner || ownerName !== `owner.${owner?.token}.json`) {
    if (ageMs <= CREATE_LOCK_INITIALIZATION_GRACE_MS) return false
    throw new Error('stable_record_create_lock_manual_repair_required:owner_invalid')
  }
  if (Date.now() <= owner.leaseUntil) return false
  return removeClaimedCreateLock(lockDir, ownerName, owner, 'expired')
}

async function releaseStableCreateLock(lockDir, token) {
  const ownerName = `owner.${token}.json`
  const ownerPath = join(lockDir, ownerName)
  const releaseName = `.release.${token}.json`
  const releasePath = join(lockDir, releaseName)
  try {
    await rename(ownerPath, releasePath)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('stable_record_create_lock_ownership_lost')
    }
    throw error
  }
  const releasedOwner = parseCreateLockOwner(await readFile(releasePath, 'utf8'), token)
  const entries = await readdir(lockDir)
  if (!releasedOwner || entries.length !== 1 || entries[0] !== releaseName) {
    throw new Error('stable_record_create_lock_manual_repair_required:release_invalid')
  }
  await unlink(releasePath)
  await rmdir(lockDir)
}

async function withStableCreateFileLock({ context, table, stableId }, action) {
  if (typeof action !== 'function') throw new TypeError('stable_create_lock_action_required')
  // This is a same-catalog, single-deployment coordination boundary. Writers
  // on another host or catalog do not share this filesystem lease; the
  // write-after-read checks below still detect their conflicts, but this is
  // deliberately not presented as a Feishu-wide atomic uniqueness guarantee.
  const catalogPath = typeof context.catalogPath === 'string' && context.catalogPath
    ? context.catalogPath
    : DEFAULT_CATALOG_PATH
  const physicalCatalogRoot = await realpath(dirname(catalogPath))
  const lockRoot = join(physicalCatalogRoot, '.director-brain-create-locks')
  await mkdir(lockRoot, { recursive: true, mode: 0o700 })
  await chmod(lockRoot, 0o700)
  await assertCreateLockPhysicalPath(lockRoot)
  const lockKey = createHash('sha256').update(canonicalJson({
    projectId: context.schema.projectId,
    table: table.key,
    stableId,
  }), 'utf8').digest('hex')
  const lockDir = join(lockRoot, lockKey + '.lock')
  const deadline = Date.now() + CREATE_LOCK_TIMEOUT_MS
  const token = randomUUID()
  const ownerName = `owner.${token}.json`
  const ownerPath = join(lockDir, ownerName)
  let acquired = false
  while (!acquired) {
    try {
      await mkdir(lockDir, { mode: 0o700 })
      await chmod(lockDir, 0o700)
      const createdAt = Date.now()
      await writeFile(ownerPath, JSON.stringify({
        token,
        createdAt,
        leaseUntil: createdAt + CREATE_LOCK_LEASE_MS,
        scope: 'same-catalog-single-deployment',
      }), { flag: 'wx', mode: 0o600 })
      const owner = parseCreateLockOwner(await readFile(ownerPath, 'utf8'), token)
      if (!owner) throw new Error('stable_record_create_lock_owner_write_failed')
      acquired = true
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        if (!acquired) await rmdir(lockDir).catch(() => undefined)
        throw error
      }
      if (await inspectAndRepairCreateLock(lockDir)) continue
      if (Date.now() >= deadline) throw new Error('stable_record_create_lock_timeout:' + table.key)
      await delay(CREATE_LOCK_RETRY_MS)
    }
  }
  let actionError = null
  try {
    return await action()
  } catch (error) {
    actionError = error
    throw error
  } finally {
    try {
      await releaseStableCreateLock(lockDir, token)
    } catch (releaseError) {
      if (actionError === null) throw releaseError
    }
  }
}

function operationDependencies(options) {
  const supplied = options.dependencies || {}
  return {
    connect: supplied.connect || connectedContext,
    findExact: supplied.findExact || findExactOperationRecords,
    search: supplied.search || searchOperationRecords,
    findByWork: supplied.findByWork || findOperationRecordsByWork,
    resolveWork: supplied.resolveWork || resolveWorkRecords,
    inspectSchema: supplied.inspectSchema || inspectOperationSchema,
    withStableCreateLock: supplied.withStableCreateLock || withStableCreateFileLock,
    create: supplied.create || (async ({ context, tableId, fields }) => createRecord(
      context.accessToken,
      context.catalog.appToken,
      tableId,
      fields,
    )),
    update: supplied.update || (async ({ context, tableId, recordId, fields }) => updateRecord(
      context.accessToken,
      context.catalog.appToken,
      tableId,
      recordId,
      fields,
    )),
  }
}

function normalizeSearchRequest(request, schema = null) {
  assertOperationKeys(request, new Set(['action', 'table', 'workId', 'query', 'status', 'limit']))
  if (typeof request.table !== 'string' || !request.table.trim()) {
    throw new Error('operation_table_required')
  }
  assertSafeRemoteOutput(request.table, 'table')
  if (schema) operationTable(schema, request.table, true)
  const needsWork = request.table !== 'system_blueprint' && request.table !== 'works'
  const workId = needsWork ? validateOperationStableId(request.workId) : null
  if (!needsWork && request.workId !== undefined) throw new Error('search_work_id_unexpected')
  if (typeof request.query !== 'string') throw new Error('record_field_type_invalid:query')
  const query = request.query.normalize('NFKC').replace(/\r\n?/gu, '\n').trim()
  if (!query) throw new Error('record_field_empty:query')
  if (query.length > MAX_SEARCH_QUERY_LENGTH) throw new Error('search_query_too_long')
  if (/[\u0000-\u001f\u007f]/u.test(query)) throw new Error('search_query_invalid')
  assertSafeRemoteOutput(query, 'query')
  const limit = request.limit === undefined ? 10 : request.limit
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
    throw new Error('search_limit_invalid')
  }
  let status = null
  if (request.status !== undefined) {
    status = normalizeOperationString(request.status, 'status')
    if (schema) {
      const tables = request.table === 'all'
        ? schema.tables
        : [operationTable(schema, request.table)]
      if (!tables.some(table => statusFieldForTable(table)?.options?.includes(status))) {
        throw new Error('search_status_invalid')
      }
    }
  }
  return { table: request.table, workId, query, status, limit }
}

function normalizeWorkQuery(value) {
  const query = normalizeOperationString(value, 'query')
  if (query.length > MAX_SEARCH_QUERY_LENGTH) throw new Error('work_query_too_long')
  return query
}

function normalizeWorkflowObjective(value) {
  if (value === undefined) return null
  const objective = normalizeOperationString(value, 'objective')
  if (objective.length > 500) throw new Error('workflow_objective_too_long')
  return objective
}

function incrementDirectorBrainVersion(value) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/u.exec(String(value || ''))
  if (!match) throw new Error('record_version_invalid')
  const patch = Number(match[3]) + 1
  if (!Number.isSafeInteger(patch)) throw new Error('record_version_invalid')
  return `v${match[1]}.${match[2]}.${patch}`
}

function requiredReviewFields(table) {
  const common = [
    table.fields[0].name, table.stableId, '项目 ID', '版本', '来源', '更新时间',
  ]
  if (table.key !== 'system_blueprint' && table.key !== 'works') common.push('作品 ID')
  if (table.key === 'material_evidence') {
    common.push(
      '任务 ID', '素材 ID', '场景 ID', '镜头 ID', '起始时间码', '结束时间码',
      '证据摘要', '校验摘要', '分析版本', '置信度',
    )
  }
  return [...new Set([...common, ...(PROPOSAL_REQUIRED_FIELDS[table.key] || [])])]
}

function assertReviewFieldsPresent(table, record) {
  for (const name of requiredReviewFields(table)) {
    const value = record.fields[name]
    if (value === undefined || value === null || value === '') {
      throw new Error('review_required_field_missing:' + table.key + ':' + name)
    }
  }
  normalizeCompleteOperationFields(table, record.fields)
  if (table.key === 'material_evidence') {
    assertEvidenceTimecode(record)
    if (!/^[a-f0-9]{64}$/u.test(String(record.fields['校验摘要'] || ''))) {
      throw new Error('evidence_checksum_invalid')
    }
  }
}

async function loadReviewedVersionReference(
  context, dependencies, tableKey, stableId, workId,
) {
  const table = operationTable(context.schema, tableKey)
  const { tableId } = tableContext(context.schema, context.catalog, table.key)
  const records = await dependencies.findExact({ context, table, tableId, stableId })
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error(records?.length > 1
      ? 'duplicate_stable_record_id:' + table.key
      : 'reference_record_missing:' + table.key + ':' + stableId)
  }
  const record = operationRecord(table, records[0])
  assertOperationRecordScope(context, table, record, workId)
  if (!isHistoricallyReviewedRecord(record)) {
    throw new Error('reference_record_not_reviewed:' + table.key + ':' + stableId)
  }
  return record
}

async function validateReviewReferences(context, dependencies, table, record, workId) {
  const rule = PROPOSAL_REFERENCE_RULES[table.key] || {}
  for (const groupName of ['required', 'optional']) {
    for (const [, [tableKey, fieldName]] of Object.entries(rule[groupName] || {})) {
      const stableId = String(record.fields[fieldName] || '').trim()
      if (!stableId) {
        if (groupName === 'required') {
          throw new Error('review_reference_missing:' + table.key + ':' + fieldName)
        }
        continue
      }
      if (fieldName === '上一版本 ID') {
        await loadReviewedVersionReference(context, dependencies, tableKey, stableId, workId)
      } else {
        await loadReviewedReference(context, dependencies, tableKey, stableId, workId)
      }
    }
  }
  for (const groupName of ['requiredMany', 'optionalMany']) {
    for (const [, [tableKey, fieldName]] of Object.entries(rule[groupName] || {})) {
      const stableIds = splitStoredReferences(record.fields[fieldName])
      if (!stableIds.length && groupName === 'requiredMany') {
        throw new Error('review_reference_missing:' + table.key + ':' + fieldName)
      }
      for (const stableId of stableIds) {
        await loadReviewedReference(context, dependencies, tableKey, stableId, workId)
      }
    }
  }
  if (table.key === 'material_evidence') {
    const previous = String(record.fields['上一版本 ID'] || '').trim()
    if (previous) {
      await loadReviewedVersionReference(context, dependencies, table.key, previous, workId)
    }
  }
}

function assertExactReviewSnapshot(
  table, records, stableId, expectedState, expectedVersion, expectedRecordId = null,
) {
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error('review_concurrent_change:' + stableId)
  }
  const record = operationRecord(table, records[0])
  if (!records[0]?.record_id || typeof records[0].record_id !== 'string'
    || record.stableId !== stableId
    || (expectedRecordId !== null && records[0].record_id !== expectedRecordId)
    || record.state !== expectedState
    || String(record.fields['版本'] || '') !== expectedVersion) {
    throw new Error('review_concurrent_change:' + stableId)
  }
  return { raw: records[0], record }
}

function assertReviewSnapshotUnchanged(stableId, initialRecord, latestRecord) {
  if (canonicalJson(initialRecord.fields) !== canonicalJson(latestRecord.fields)) {
    throw new Error('review_concurrent_change:' + stableId)
  }
}

const DIRECTOR_INTENT_CONVERGENCE_ROUNDS = 3

function directorIntentManualRepairError(reason, activeIds = []) {
  const suffix = activeIds.length ? ':' + activeIds.join(',') : ''
  return new Error('director_intent_manual_repair_required:' + reason + suffix)
}

function sortStableIds(left, right) {
  if (left.stableId === right.stableId) return 0
  return left.stableId < right.stableId ? -1 : 1
}

async function loadActiveDirectorIntents({
  context, dependencies, table, tableId, workId,
}) {
  const records = await dependencies.findByWork({ context, table, tableId, workId })
  if (!Array.isArray(records)) {
    throw directorIntentManualRepairError('active_set_unreadable')
  }
  const normalized = records.map(raw => ({ raw, record: operationRecord(table, raw) }))
  const stableIds = normalized.map(item => item.record.stableId)
  if (new Set(stableIds).size !== stableIds.length) {
    throw directorIntentManualRepairError('duplicate_stable_ids', stableIds.sort())
  }
  for (const item of normalized) {
    assertOperationRecordScope(context, table, item.record, workId)
  }
  return normalized.filter(item => item.record.state === '生效').sort((left, right) => (
    sortStableIds(left.record, right.record)
  ))
}

async function convergeActiveDirectorIntents({
  context,
  dependencies,
  table,
  tableId,
  workId,
  reviewer,
  reason,
  nowValue,
}) {
  let observedActiveIds = []
  for (let round = 0; round < DIRECTOR_INTENT_CONVERGENCE_ROUNDS; round += 1) {
    const active = await loadActiveDirectorIntents({
      context, dependencies, table, tableId, workId,
    })
    observedActiveIds = active.map(item => item.record.stableId)
    if (active.length === 1) return active[0].record
    if (active.length === 0) continue

    // Every concurrent reviewer uses the same total ordering, so overlapping
    // convergence attempts retire the same losers instead of preferring their
    // own target and oscillating the active version.
    const winner = active[0].record
    for (const loser of active.slice(1)) {
      const latestRecords = await dependencies.findExact({
        context, table, tableId, stableId: loser.record.stableId,
      })
      if (!Array.isArray(latestRecords) || latestRecords.length !== 1
        || latestRecords[0]?.record_id !== loser.raw.record_id) {
        throw directorIntentManualRepairError(
          'loser_snapshot_unverifiable',
          observedActiveIds,
        )
      }
      const latest = operationRecord(table, latestRecords[0])
      assertOperationRecordScope(context, table, latest, workId)
      if (latest.state !== '生效') continue
      const retiredFields = normalizeCompleteOperationFields(table, {
        ...latest.fields,
        '状态': '废弃',
        '版本': incrementDirectorBrainVersion(latest.fields['版本']),
        '审核人': reviewer,
        '审核时间': nowValue,
        '审核原因': `并发生效冲突，按稳定 ID 顺序保留 ${winner.stableId}: ${reason}`,
        '更新时间': nowValue,
      })
      await dependencies.update({
        context,
        table,
        tableId,
        recordId: latestRecords[0].record_id,
        fields: retiredFields,
      })
      const verified = await dependencies.findExact({
        context, table, tableId, stableId: loser.record.stableId,
      })
      if (!Array.isArray(verified) || verified.length !== 1
        || verified[0]?.record_id !== loser.raw.record_id) {
        throw directorIntentManualRepairError(
          'loser_write_unverifiable',
          observedActiveIds,
        )
      }
      const verifiedRecord = assertOperationWriteReadback(
        table,
        verified[0],
        retiredFields,
        directorIntentManualRepairError('loser_write_drift', observedActiveIds).message,
      )
      assertOperationRecordScope(context, table, verifiedRecord, workId)
    }
  }

  const finalActive = await loadActiveDirectorIntents({
    context, dependencies, table, tableId, workId,
  })
  const finalActiveIds = finalActive.map(item => item.record.stableId)
  if (finalActive.length !== 1) {
    throw directorIntentManualRepairError(
      `expected_one_active_found_${finalActive.length}`,
      finalActiveIds.length ? finalActiveIds : observedActiveIds,
    )
  }
  return finalActive[0].record
}

async function replaceActiveDirectorIntent({
  context,
  dependencies,
  table,
  tableId,
  targetRaw,
  target,
  targetFields,
  previousRaw,
  previous,
  reviewer,
  reason,
  nowValue,
  workId,
}) {
  const targetSnapshot = assertExactReviewSnapshot(
    table,
    await dependencies.findExact({ context, table, tableId, stableId: target.stableId }),
    target.stableId,
    target.state,
    String(target.fields['版本']),
    targetRaw.record_id,
  )
  assertReviewSnapshotUnchanged(target.stableId, target, targetSnapshot.record)
  assertOperationRecordScope(context, table, targetSnapshot.record, workId)
  const previousSnapshot = assertExactReviewSnapshot(
    table,
    await dependencies.findExact({ context, table, tableId, stableId: previous.stableId }),
    previous.stableId,
    '生效',
    String(previous.fields['版本']),
    previousRaw.record_id,
  )
  assertReviewSnapshotUnchanged(previous.stableId, previous, previousSnapshot.record)
  assertOperationRecordScope(context, table, previousSnapshot.record, workId)
  const targetOriginalFields = structuredClone(targetSnapshot.raw.fields)
  const previousOriginalFields = structuredClone(previousSnapshot.raw.fields)
  if (String(targetSnapshot.record.fields['上一版本 ID'] || '') !== previous.stableId) {
    throw new Error('director_intent_previous_not_current')
  }

  const previousFields = normalizeCompleteOperationFields(table, {
    ...previousSnapshot.record.fields,
    '状态': '废弃',
    '版本': incrementDirectorBrainVersion(previousSnapshot.record.fields['版本']),
    '审核人': reviewer,
    '审核时间': nowValue,
    '审核原因': `由 ${target.stableId} 接替: ${reason}`,
    '更新时间': nowValue,
  })
  let previousAttempted = false
  let targetAttempted = false
  try {
    previousAttempted = true
    await dependencies.update({
      context,
      table,
      tableId,
      recordId: previousSnapshot.raw.record_id,
      fields: previousFields,
    })
    const retiredPreviousSnapshot = assertExactReviewSnapshot(
      table,
      await dependencies.findExact({ context, table, tableId, stableId: previous.stableId }),
      previous.stableId,
      '废弃',
      String(previousFields['版本']),
    )
    const retiredPrevious = assertOperationWriteReadback(
      table,
      retiredPreviousSnapshot.raw,
      previousFields,
      'director_intent_replacement_write_readback_mismatch:' + previous.stableId,
    )
    const targetBeforeActivation = assertExactReviewSnapshot(
      table,
      await dependencies.findExact({ context, table, tableId, stableId: target.stableId }),
      target.stableId,
      target.state,
      String(target.fields['版本']),
      targetSnapshot.raw.record_id,
    )
    assertReviewSnapshotUnchanged(target.stableId, targetSnapshot.record, targetBeforeActivation.record)
    assertOperationRecordScope(context, table, targetBeforeActivation.record, workId)
    const activeBeforeActivation = await dependencies.findByWork({
      context, table, tableId, workId,
    })
    if (!Array.isArray(activeBeforeActivation)) throw new Error('operation_dependency_result_invalid')
    const activeBeforeActivationRecords = activeBeforeActivation
      .map(raw => operationRecord(table, raw))
    assertUniqueOperationStableIds(table, activeBeforeActivationRecords)
    for (const record of activeBeforeActivationRecords) {
      assertOperationRecordScope(context, table, record, workId)
    }
    if (activeBeforeActivationRecords.some(record => record.state === '生效')) {
      throw new Error('review_concurrent_change:' + previous.stableId)
    }
    const latestTarget = assertExactReviewSnapshot(
      table,
      await dependencies.findExact({ context, table, tableId, stableId: target.stableId }),
      target.stableId,
      target.state,
      String(target.fields['版本']),
      targetSnapshot.raw.record_id,
    )
    assertReviewSnapshotUnchanged(target.stableId, targetSnapshot.record, latestTarget.record)
    assertOperationRecordScope(context, table, latestTarget.record, workId)
    targetAttempted = true
    await dependencies.update({
      context,
      table,
      tableId,
      recordId: latestTarget.raw.record_id,
      fields: targetFields,
    })
    const verifiedTargetSnapshot = assertExactReviewSnapshot(
      table,
      await dependencies.findExact({ context, table, tableId, stableId: target.stableId }),
      target.stableId,
      '生效',
      String(targetFields['版本']),
    )
    const verifiedTarget = assertOperationWriteReadback(
      table,
      verifiedTargetSnapshot.raw,
      targetFields,
      'director_intent_replacement_write_readback_mismatch:' + target.stableId,
    )
    assertOperationRecordScope(context, table, verifiedTarget, workId)
    if (!verifiedTarget.reviewed) {
      throw new Error('review_record_verification_failed:' + table.key)
    }
    const convergedActive = await convergeActiveDirectorIntents({
      context,
      dependencies,
      table,
      tableId,
      workId,
      reviewer,
      reason,
      nowValue,
    })
    if (convergedActive.stableId !== target.stableId) {
      throw new Error(
        `director_intent_concurrent_activation_lost:${target.stableId}:${convergedActive.stableId}`,
      )
    }
    return { record: convergedActive, replaced: retiredPrevious }
  } catch (error) {
    const errorCode = error instanceof Error ? error.message : String(error)
    if (errorCode.startsWith('director_intent_concurrent_activation_lost:')
      || errorCode.startsWith('director_intent_manual_repair_required:')) {
      throw error
    }
    let rollbackFailed = false
    const rollbackSnapshot = async ({
      attempted,
      snapshot,
      updatedFields,
      originalFields,
      skipRestoreIfAnotherActive = false,
    }) => {
      if (!attempted) return 'not-attempted'
      const latestRecords = await dependencies.findExact({
        context, table, tableId, stableId: snapshot.record.stableId,
      })
      if (!Array.isArray(latestRecords) || latestRecords.length !== 1
        || latestRecords[0]?.record_id !== snapshot.raw.record_id) {
        throw new Error('review_concurrent_change:' + snapshot.record.stableId)
      }
      const latestRecord = operationRecord(table, latestRecords[0])
      assertOperationRecordScope(context, table, latestRecord, workId)
      if (canonicalJson(latestRecord.fields) === canonicalJson(snapshot.record.fields)) {
        return 'unchanged'
      }
      const expectedUpdated = operationRecord(table, {
        record_id: snapshot.raw.record_id,
        fields: updatedFields,
      })
      if (canonicalJson(latestRecord.fields) !== canonicalJson(expectedUpdated.fields)) {
        throw new Error('review_concurrent_change:' + snapshot.record.stableId)
      }
      if (skipRestoreIfAnotherActive) {
        const active = await loadActiveDirectorIntents({
          context, dependencies, table, tableId, workId,
        })
        if (active.some(item => item.record.stableId !== snapshot.record.stableId)) {
          return 'skipped-for-active-successor'
        }
      }
      await dependencies.update({
        context,
        table,
        tableId,
        recordId: snapshot.raw.record_id,
        fields: originalFields,
      })
      return 'restored'
    }
    let targetRollback = 'not-attempted'
    let previousRollback = 'not-attempted'
    await rollbackSnapshot({
      attempted: targetAttempted,
      snapshot: targetSnapshot,
      updatedFields: targetFields,
      originalFields: targetOriginalFields,
    }).then(result => { targetRollback = result }).catch(() => { rollbackFailed = true })
    await rollbackSnapshot({
      attempted: previousAttempted,
      snapshot: previousSnapshot,
      updatedFields: previousFields,
      originalFields: previousOriginalFields,
      skipRestoreIfAnotherActive: true,
    }).then(result => { previousRollback = result }).catch(() => { rollbackFailed = true })
    try {
      if (targetRollback === 'restored' || targetRollback === 'unchanged') {
        const restoredTarget = assertExactReviewSnapshot(
          table,
          await dependencies.findExact({ context, table, tableId, stableId: target.stableId }),
          target.stableId,
          target.state,
          String(target.fields['版本']),
          targetSnapshot.raw.record_id,
        )
        assertReviewSnapshotUnchanged(target.stableId, targetSnapshot.record, restoredTarget.record)
        assertOperationRecordScope(context, table, restoredTarget.record, workId)
      }
      if (previousRollback === 'restored' || previousRollback === 'unchanged') {
        const restoredPrevious = assertExactReviewSnapshot(
          table,
          await dependencies.findExact({ context, table, tableId, stableId: previous.stableId }),
          previous.stableId,
          '生效',
          String(previous.fields['版本']),
          previousSnapshot.raw.record_id,
        )
        assertReviewSnapshotUnchanged(
          previous.stableId, previousSnapshot.record, restoredPrevious.record,
        )
        assertOperationRecordScope(context, table, restoredPrevious.record, workId)
      }
      if (previousAttempted || targetAttempted) {
        await convergeActiveDirectorIntents({
          context,
          dependencies,
          table,
          tableId,
          workId,
          reviewer,
          reason,
          nowValue,
        })
      }
    } catch {
      rollbackFailed = true
    }
    if (rollbackFailed) {
      throw directorIntentManualRepairError('replacement_rollback_unverifiable')
    }
    throw error
  }
}

export async function reviewDirectorBrainRecord(requestValue, options = {}) {
  const request = requireObject(requestValue, 'review_request')
  assertSerializedSize(request, MAX_OPERATION_INPUT_BYTES, 'review_request')
  assertOperationKeys(request, new Set([
    'table', 'stableId', 'workId', 'expectedVersion', 'targetStatus', 'reviewer', 'reason',
  ]))
  if (typeof request.table !== 'string' || !request.table.trim()) {
    throw new Error('operation_table_required')
  }
  const stableId = validateOperationStableId(request.stableId)
  const expectedVersion = normalizeOperationString(request.expectedVersion, 'expectedVersion')
  const targetStatus = normalizeOperationString(request.targetStatus, 'targetStatus')
  const reviewer = normalizeOperationString(request.reviewer, 'reviewer')
  const reason = normalizeOperationString(request.reason, 'reason')
  const dependencies = operationDependencies(options)
  const context = await dependencies.connect(options)
  const table = operationTable(context.schema, request.table)
  if (table.key === 'system_blueprint') {
    throw new Error('review_table_not_allowed:system_blueprint')
  }
  const workId = table.key === 'system_blueprint' || table.key === 'works'
    ? null
    : validateOperationStableId(request.workId)
  if ((table.key === 'system_blueprint' || table.key === 'works')
    && request.workId !== undefined) {
    throw new Error('review_work_id_unexpected')
  }
  const { tableId } = tableContext(context.schema, context.catalog, table.key)
  const records = await dependencies.findExact({ context, table, tableId, stableId })
  if (!Array.isArray(records) || records.length !== 1) {
    throw new Error(records?.length > 1
      ? 'duplicate_stable_record_id:' + table.key
      : 'review_record_missing:' + table.key + ':' + stableId)
  }
  const current = operationRecord(table, records[0])
  assertOperationRecordScope(context, table, current, table.key === 'works' ? stableId : workId)
  if (String(current.fields['版本'] || '') !== expectedVersion) {
    throw new Error('review_expected_version_mismatch')
  }
  const transitions = LEGAL_STATUS_TRANSITIONS[table.key]?.[current.state]
  if (!transitions?.has(targetStatus)) throw new Error('review_status_transition_invalid')
  if (workId) await loadReviewedReference(context, dependencies, 'works', workId, workId)

  const becomesReviewed = REVIEWED_STATUSES_BY_TABLE[table.key]?.has(targetStatus) === true
  let intentReplacement = null
  if (becomesReviewed) {
    assertReviewFieldsPresent(table, current)
    await validateReviewReferences(context, dependencies, table, current, workId)
    if (table.key === 'director_intents' && targetStatus === '生效') {
      const active = await dependencies.findByWork({ context, table, tableId, workId })
      if (!Array.isArray(active)) throw new Error('operation_dependency_result_invalid')
      const activeIntents = []
      for (const raw of active) {
        const other = operationRecord(table, raw)
        assertOperationRecordScope(context, table, other, workId)
        if (other.stableId !== stableId && other.state === '生效') activeIntents.push({ raw, record: other })
      }
      const previousId = String(current.fields['上一版本 ID'] || '').trim()
      if (activeIntents.length === 0) {
        if (previousId) throw new Error('director_intent_previous_not_current')
      } else if (activeIntents.length === 1
        && previousId === activeIntents[0].record.stableId) {
        intentReplacement = activeIntents[0]
      } else if (activeIntents.length > 1) {
        throw new Error('active_director_intent_conflict')
      } else {
        throw new Error('director_intent_previous_not_current')
      }
    }
  }

  const nowValue = typeof options.now === 'function' ? options.now() : new Date().toISOString()
  const stateField = statusFieldForTable(table)
  if (!stateField?.options?.includes(targetStatus)) throw new Error('review_target_status_invalid')
  const fields = normalizeCompleteOperationFields(table, {
    ...current.fields,
    [stateField.name]: targetStatus,
    '版本': incrementDirectorBrainVersion(expectedVersion),
    '审核人': reviewer,
    '审核时间': nowValue,
    '审核原因': reason,
    '更新时间': nowValue,
  })
  if (intentReplacement) {
    const replacement = await replaceActiveDirectorIntent({
      context,
      dependencies,
      table,
      tableId,
      targetRaw: records[0],
      target: current,
      targetFields: fields,
      previousRaw: intentReplacement.raw,
      previous: intentReplacement.record,
      reviewer,
      reason,
      nowValue,
      workId,
    })
    return {
      ok: true,
      action: 'review',
      table: table.key,
      stableId,
      workId,
      previousStatus: current.state,
      targetStatus,
      previousVersion: expectedVersion,
      version: fields['版本'],
      replacedIntentId: intentReplacement.record.stableId,
      record: replacement.record,
    }
  }
  const latest = assertExactReviewSnapshot(
    table,
    await dependencies.findExact({ context, table, tableId, stableId }),
    stableId,
    current.state,
    expectedVersion,
    records[0].record_id,
  )
  assertReviewSnapshotUnchanged(stableId, current, latest.record)
  assertOperationRecordScope(
    context, table, latest.record, table.key === 'works' ? stableId : workId,
  )
  const writeFields = normalizeCompleteOperationFields(table, {
    ...latest.record.fields,
    [stateField.name]: targetStatus,
    '版本': fields['版本'],
    '审核人': reviewer,
    '审核时间': nowValue,
    '审核原因': reason,
    '更新时间': nowValue,
  })
  await dependencies.update({
    context,
    table,
    tableId,
    recordId: latest.raw.record_id,
    fields: writeFields,
  })
  const verified = await dependencies.findExact({ context, table, tableId, stableId })
  if (!Array.isArray(verified) || verified.length !== 1) {
    throw new Error('review_record_verification_failed:' + table.key)
  }
  const record = assertOperationWriteReadback(
    table,
    verified[0],
    writeFields,
    'review_record_verification_failed:' + table.key,
  )
  assertOperationRecordScope(context, table, record, table.key === 'works' ? stableId : workId)
  if (record.state !== targetStatus || record.fields['版本'] !== writeFields['版本']
    || (becomesReviewed && !record.reviewed)) {
    throw new Error('review_record_verification_failed:' + table.key)
  }
  return {
    ok: true,
    action: 'review',
    table: table.key,
    stableId,
    workId,
    previousStatus: current.state,
    targetStatus,
    previousVersion: expectedVersion,
    version: writeFields['版本'],
    record,
  }
}

export async function executeDirectorBrainOperation(requestValue, options = {}) {
  const request = requireObject(requestValue, 'operation_request')
  assertOperationRequestSize(request)
  if (!OPERATION_ACTIONS.has(request.action)) throw new Error('operation_action_invalid')
  const dependencies = operationDependencies(options)

  if (request.action === 'health') {
    assertOperationKeys(request, new Set(['action']))
    const context = await dependencies.connect(options)
    const inspection = await dependencies.inspectSchema({ context })
    if (!inspection?.ok || inspection.tableCount !== context.schema.tables.length
      || !/^[a-f0-9]{64}$/u.test(inspection.fingerprint || '')) {
      throw new Error('director_brain_runtime_contract_invalid')
    }
    return {
      ok: true,
      action: 'health',
      brainName: context.schema.brainName,
      projectId: context.schema.projectId,
      environment: context.schema.environment,
      tableCount: inspection.tableCount,
      remoteContractVerified: true,
      schemaFingerprint: inspection.fingerprint,
    }
  }

  let validatedStableId = null
  if (request.action === 'resolve_work') {
    assertOperationKeys(request, new Set(['action', 'query']))
    normalizeWorkQuery(request.query)
  } else if (request.action === 'get') {
    assertOperationKeys(request, new Set(['action', 'table', 'workId', 'stableId']))
    if (typeof request.table !== 'string' || !request.table.trim()) {
      throw new Error('operation_table_required')
    }
    assertSafeRemoteOutput(request.table, 'table')
    validatedStableId = validateOperationStableId(request.stableId)
  } else if (request.action === 'search') {
    normalizeSearchRequest(request)
  } else if (request.action === 'assemble') {
    assertSafeOperationContent(request, 'request')
    assertOperationKeys(request, new Set(['action', 'workId', 'references']))
    validateOperationStableId(request.workId)
    normalizeAssemblyReferences(request.references)
  } else if (request.action === 'workflow') {
    assertSafeOperationContent(request, 'request')
    assertOperationKeys(request, new Set(['action', 'workId', 'objective']))
    validateOperationStableId(request.workId)
    normalizeWorkflowObjective(request.objective)
  } else {
    assertSafeOperationContent(request, 'request')
    assertOperationKeys(request, new Set(['action', 'table', 'workId', 'fields', 'references']))
    if (typeof request.table !== 'string' || !request.table.trim()) {
      throw new Error('operation_table_required')
    }
    if (!PROPOSABLE_TABLES.has(request.table)) {
      throw new Error('operation_table_not_proposable:' + request.table)
    }
    if (request.table === 'works') {
      if (request.workId !== undefined) throw new Error('work_proposal_work_id_forbidden')
    } else {
      validateOperationStableId(request.workId)
    }
  }

  const context = await dependencies.connect(options)
  if (request.action === 'resolve_work') {
    const query = normalizeWorkQuery(request.query)
    const table = operationTable(context.schema, 'works')
    const { tableId } = tableContext(context.schema, context.catalog, table.key)
    const records = await dependencies.resolveWork({ context, table, tableId, query })
    if (!Array.isArray(records)) throw new Error('operation_dependency_result_invalid')
    const matches = records.map(record => operationRecord(table, record)).filter(record => {
      assertOperationRecordScope(context, table, record, record.stableId)
      return record.reviewed
        && normalizedWorkNames(record.fields).includes(
          normalizeWorkTitle(query),
        )
    })
    if (matches.length > 1) throw new Error('work_resolution_ambiguous')
    const match = matches[0] || null
    return {
      ok: true,
      action: 'resolve_work',
      query,
      found: Boolean(match),
      work: match ? {
        workId: match.stableId,
        name: match.fields['作品名称'],
        aliases: String(match.fields['别名'] || '').split('\n').filter(Boolean),
        state: match.state,
        version: match.fields['版本'],
      } : null,
    }
  }
  if (request.action === 'get') {
    const table = operationTable(context.schema, request.table)
    const workId = table.key === 'system_blueprint' || table.key === 'works'
      ? null
      : validateOperationStableId(request.workId)
    if ((table.key === 'system_blueprint' || table.key === 'works')
      && request.workId !== undefined) {
      throw new Error('get_work_id_unexpected')
    }
    const stableId = validatedStableId
    const { tableId } = tableContext(context.schema, context.catalog, table.key)
    const records = await dependencies.findExact({ context, table, tableId, stableId })
    if (!Array.isArray(records)) throw new Error('operation_dependency_result_invalid')
    if (records.length > 1) throw new Error('duplicate_stable_record_id:' + table.key)
    const record = records.length === 1 ? operationRecord(table, records[0]) : null
    if (record) assertOperationRecordScope(context, table, record, workId)
    return {
      ok: true,
      action: 'get',
      table: table.key,
      stableId,
      found: records.length === 1,
      workId,
      record,
    }
  }

  if (request.action === 'search') {
    const normalized = normalizeSearchRequest(request, context.schema)
    if (normalized.workId) {
      await loadReviewedReference(
        context, dependencies, 'works', normalized.workId, normalized.workId,
      )
    }
    const tables = normalized.table === 'all'
      ? context.schema.tables
      : [operationTable(context.schema, normalized.table)]
    const matches = []
    let truncated = false
    for (let index = 0; index < tables.length; index += 1) {
      const table = tables[index]
      const statusField = statusFieldForTable(table)
      if (normalized.status && !statusField?.options?.includes(normalized.status)) continue
      const remaining = normalized.limit - matches.length
      if (remaining <= 0) {
        truncated = true
        break
      }
      const { tableId } = tableContext(context.schema, context.catalog, table.key)
      const result = await dependencies.search({
        context,
        table,
        tableId,
        query: normalized.query,
        status: normalized.status,
        limit: remaining,
        workId: normalized.workId,
      })
      if (!result || !Array.isArray(result.records) || typeof result.truncated !== 'boolean') {
        throw new Error('operation_dependency_result_invalid')
      }
      const normalizedRecords = result.records.map(record => operationRecord(table, record))
      assertUniqueOperationStableIds(table, normalizedRecords)
      const verifiedMatches = normalizedRecords
        .filter(record => {
          assertOperationRecordScope(
            context,
            table,
            record,
            table.key === 'system_blueprint' || table.key === 'works'
              ? null
              : normalized.workId,
          )
          return true
        })
        .filter(record => recordMatchesSearch(
          table,
          record.fields,
          normalized.query,
          normalized.status,
          record.reviewed,
        ))
      matches.push(...verifiedMatches.slice(0, remaining))
      truncated = truncated || result.truncated || verifiedMatches.length > remaining
      if (matches.length >= normalized.limit && index < tables.length - 1) truncated = true
    }
    return {
      ok: true,
      action: 'search',
      table: normalized.table,
      workId: normalized.workId,
      query: normalized.query,
      status: normalized.status,
      limit: normalized.limit,
      count: matches.length,
      truncated,
      matches,
    }
  }

  if (request.action === 'assemble') {
    const workId = validateOperationStableId(request.workId)
    const work = await loadReviewedReference(context, dependencies, 'works', workId, workId)
    const references = normalizeAssemblyReferences(request.references)
    const grouped = {
      work,
      directorIntent: null,
      materialEvidence: [],
      peopleProfiles: [],
      storyNodes: [],
      storyRelations: [],
      materialJudgments: [],
      narrativePlans: [],
      directorCases: [],
      skillsTechniques: [],
    }
    const outputNames = {
      intentVersionId: 'directorIntent',
      evidenceIds: 'materialEvidence',
      peopleProfileIds: 'peopleProfiles',
      storyNodeIds: 'storyNodes',
      storyRelationIds: 'storyRelations',
      materialJudgmentIds: 'materialJudgments',
      narrativePlanIds: 'narrativePlans',
      directorCaseIds: 'directorCases',
      skillTechniqueIds: 'skillsTechniques',
    }
    for (const [name, [tableKey, many]] of Object.entries(ASSEMBLY_REFERENCE_TABLES)) {
      const outputName = outputNames[name]
      if (many) {
        for (const stableId of references[name]) {
          grouped[outputName].push(await loadReviewedReference(
            context,
            dependencies,
            tableKey,
            stableId,
            workId,
          ))
        }
      } else {
        grouped[outputName] = await loadReviewedReference(
          context,
          dependencies,
          tableKey,
          references[name],
          workId,
        )
      }
    }
    assertAssemblyIntegrity(grouped, references)
    return {
      ok: true,
      action: 'assemble',
      projectId: context.schema.projectId,
      workId,
      intentVersionId: references.intentVersionId,
      evidenceCount: grouped.materialEvidence.length,
      context: grouped,
    }
  }

  if (request.action === 'workflow') {
    const workId = validateOperationStableId(request.workId)
    const objective = normalizeWorkflowObjective(request.objective)
    await loadReviewedReference(context, dependencies, 'works', workId, workId)
    const counts = {}
    const reviewed = {}
    const allRecords = {}
    for (const table of context.schema.tables.filter(item => (
      item.key !== 'system_blueprint' && item.key !== 'works'
    ))) {
      const { tableId } = tableContext(context.schema, context.catalog, table.key)
      const records = await dependencies.findByWork({ context, table, tableId, workId })
      if (!Array.isArray(records)) throw new Error('operation_dependency_result_invalid')
      const normalizedRecords = records.map(record => operationRecord(table, record))
      assertUniqueOperationStableIds(table, normalizedRecords)
      for (const record of normalizedRecords) {
        assertOperationRecordScope(context, table, record, workId)
      }
      const safeRecords = normalizedRecords.filter(record => record.reviewed)
      counts[table.key] = records.length
      reviewed[table.key] = safeRecords
      allRecords[table.key] = normalizedRecords
    }
    const integrity = inspectWorkflowReferenceIntegrity(reviewed, allRecords)
    const valid = integrity.validRecords
    const layers = {
      perception: valid.material_evidence.length > 0,
      people: valid.people_profiles.length > 0,
      story: valid.story_nodes.length > 0 && valid.story_relations.length > 0,
      judgment: valid.material_judgments.length > 0,
      narrative: valid.narrative_plans.some(record => Boolean(record.fields['故事脚本'])),
      intent: valid.director_intents.length === 1,
    }
    const missingSuggestions = [
      ['perception', '先完成并人工核验该作品的素材证据。'],
      ['intent', '先确认该作品唯一生效的导演意图版本。'],
      ['people', '基于已核验证据建立并确认人物档案。'],
      ['story', '补齐已确认的故事节点和故事关系。'],
      ['judgment', '完成受导演意图约束的七维素材判断。'],
      ['narrative', '在已确认事实之上形成含故事脚本的叙事方案。'],
    ]
    const nextSuggestion = missingSuggestions.find(([key]) => !layers[key])?.[1]
      || '六层基础已就绪，可继续人工复核叙事方案与导演案例。'
    const readyLayers = Object.values(layers).filter(Boolean).length
    return {
      ok: true,
      action: 'workflow',
      workId,
      objective,
      readiness: layers,
      metrics: {
        readyLayers,
        totalLayers: 6,
        layerCoverage: readyLayers / 6,
        reviewedRecords: Object.values(reviewed).reduce((sum, records) => sum + records.length, 0),
        recordsByTable: counts,
        activeIntentCount: valid.director_intents.length,
        hasStoryScript: layers.narrative,
        referenceIntegrity: integrity.valid,
        referenceIssueCount: integrity.issues.length,
      },
      referenceIssues: integrity.issues.slice(0, 20),
      nextSuggestion,
    }
  }

  const table = operationTable(context.schema, request.table)
  if (!PROPOSABLE_TABLES.has(table.key)) {
    throw new Error('operation_table_not_proposable:' + table.key)
  }
  const workId = table.key === 'works' ? null : validateOperationStableId(request.workId)
  if (workId) await loadReviewedReference(context, dependencies, 'works', workId, workId)
  const proposalFields = normalizeProposalBusinessFields(table, request.fields)
  const proposalReferences = await resolveProposalReferences(
    context,
    dependencies,
    table,
    request.references,
    workId,
  )
  const businessFields = {
    ...proposalFields,
    ...proposalReferences.fields,
    ...(workId ? { '作品 ID': workId } : {}),
  }
  const stableId = stableProposalId(table.key, businessFields)
  const { tableId } = tableContext(context.schema, context.catalog, table.key)
  return dependencies.withStableCreateLock({ context, table, tableId, stableId }, async () => {
    const existing = await dependencies.findExact({ context, table, tableId, stableId })
    if (!Array.isArray(existing)) throw new Error('operation_dependency_result_invalid')
    if (existing.length > 1) throw new Error('duplicate_stable_record_id:' + table.key)
    if (existing.length === 1) {
      if (!businessFieldsMatch(table, existing[0], businessFields)) {
        throw new Error('stable_record_id_hash_collision:' + table.key)
      }
      const record = operationRecord(table, existing[0])
      assertOperationRecordScope(
        context,
        table,
        record,
        table.key === 'works' ? stableId : workId,
      )
      return {
        ok: true,
        action: 'propose',
        table: table.key,
        stableId,
        outcome: 'unchanged',
        record,
      }
    }

    const nowValue = typeof options.now === 'function' ? options.now() : new Date().toISOString()
    const fields = {
      ...businessFields,
      [table.stableId]: stableId,
      '项目 ID': context.schema.projectId,
      ...(workId ? { '作品 ID': workId } : {}),
      ...(table.fields.some(field => field.name === '版本') ? { '版本': OPERATION_VERSION } : {}),
      '来源': OPERATION_SOURCE,
      '更新时间': nowValue,
      [table.key === 'director_cases' ? '复核状态' : '状态']: CANDIDATE_STATUS_BY_TABLE[table.key],
    }
    const normalizedFields = normalizeCompleteOperationFields(table, fields)
    await dependencies.create({ context, table, tableId, fields: normalizedFields })
    const verified = await dependencies.findExact({ context, table, tableId, stableId })
    if (!Array.isArray(verified) || verified.length !== 1) {
      throw new Error(verified?.length > 1
        ? 'duplicate_stable_record_id:' + table.key
        : 'proposed_record_verification_failed:' + table.key)
    }
    if (!businessFieldsMatch(table, verified[0], normalizedFields)) {
      throw new Error('stable_record_id_hash_collision:' + table.key)
    }
    const record = operationRecord(table, verified[0])
    assertOperationRecordScope(
      context,
      table,
      record,
      table.key === 'works' ? stableId : workId,
    )
    return {
      ok: true,
      action: 'propose',
      table: table.key,
      stableId,
      outcome: 'created',
      record,
    }
  })
}

function normalizeProjectedEvidence(table, rawFields) {
  const fields = requireObject(rawFields, 'evidence_projection_item')
  const definitions = new Map(table.fields.map(field => [field.name, field]))
  const forbidden = new Set([
    table.stableId,
    '项目 ID',
    '状态',
    '版本',
    '上一版本 ID',
    '审核人',
    '审核时间',
    '审核原因',
    '来源',
    '更新时间',
  ])
  const normalized = {}
  for (const [name, value] of Object.entries(fields)) {
    if (forbidden.has(name)) throw new Error('evidence_projection_owned_field:' + name)
    if (TASK_STATE_KEY_PATTERN.test(name)) throw new Error('task_state_forbidden:' + name)
    if (TRANSCRIPT_KEY_PATTERN.test(name)) throw new Error('full_transcript_forbidden:' + name)
    const definition = definitions.get(name)
    if (!definition) throw new Error('unknown_record_field:material_evidence:' + name)
    normalized[name] = normalizeOperationField(definition, value)
  }
  for (const required of [
    '证据名称',
    '作品 ID',
    '任务 ID',
    '素材 ID',
    '场景 ID',
    '镜头 ID',
    '起始时间码',
    '结束时间码',
    '证据摘要',
    '校验摘要',
    '分析版本',
    '置信度',
  ]) {
    if (!Object.hasOwn(normalized, required)) {
      throw new Error('evidence_projection_required_field_missing:' + required)
    }
  }
  for (const referenceName of [
    '作品 ID', '任务 ID', '批次 ID', '素材 ID', '场景 ID', '镜头 ID',
  ]) {
    if (Object.hasOwn(normalized, referenceName)) {
      normalized[referenceName] = validateOperationStableId(normalized[referenceName])
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(normalized['校验摘要'])) {
    throw new Error('evidence_checksum_invalid')
  }
  const start = parseEvidenceTimecode(normalized['起始时间码'], '起始时间码')
  const end = parseEvidenceTimecode(normalized['结束时间码'], '结束时间码')
  if (end <= start) throw new Error('evidence_timecode_range_invalid')
  assertSafeOperationContent(normalized, 'evidence')
  return Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left.localeCompare(right)))
}

function stableEvidenceId(fields) {
  const identity = Object.fromEntries([
    '作品 ID',
    '任务 ID',
    '批次 ID',
    '素材 ID',
    '场景 ID',
    '镜头 ID',
    '起始时间码',
    '结束时间码',
    '分析版本',
    '校验摘要',
  ].filter(name => Object.hasOwn(fields, name)).map(name => [name, fields[name]]))
  return 'DB-EVIDENCE-' + createHash('sha256')
    .update(canonicalJson(identity), 'utf8')
    .digest('hex')
}

export async function projectDirectorBrainEvidence(inputValue, options = {}) {
  assertSerializedSize(
    inputValue,
    MAX_EVIDENCE_PROJECTION_INPUT_BYTES,
    'evidence_projection_request',
  )
  const input = requireObject(inputValue, 'evidence_projection_request')
  assertOperationKeys(input, new Set(['workId', 'items']))
  const workId = validateOperationStableId(input.workId)
  const itemsValue = input.items
  if (!Array.isArray(itemsValue)
    || itemsValue.length === 0
    || itemsValue.length > MAX_EVIDENCE_PROJECTION_ITEMS) {
    throw new Error('evidence_projection_batch_invalid')
  }
  assertSafeOperationContent(inputValue, 'evidence_projection')
  for (const item of itemsValue) {
    const fields = requireObject(item, 'evidence_projection_item')
    for (const name of [
      '证据 ID', '项目 ID', '作品 ID', '状态', '版本', '上一版本 ID',
      '审核人', '审核时间', '审核原因', '来源', '更新时间',
    ]) {
      if (Object.hasOwn(fields, name)) throw new Error('evidence_projection_owned_field:' + name)
    }
  }
  const dependencies = operationDependencies(options)
  const context = await dependencies.connect(options)
  const table = operationTable(context.schema, 'material_evidence')
  const { tableId } = tableContext(context.schema, context.catalog, table.key)
  const nowValue = typeof options.now === 'function' ? options.now() : new Date().toISOString()
  const prepared = itemsValue.map(item => {
    const businessFields = normalizeProjectedEvidence(table, { ...item, '作品 ID': workId })
    return {
      businessFields,
      stableId: stableEvidenceId(businessFields),
    }
  })
  if (new Set(prepared.map(item => item.stableId)).size !== prepared.length) {
    throw new Error('evidence_projection_duplicate_identity')
  }

  await loadReviewedReference(context, dependencies, 'works', workId, workId)

  for (const item of prepared) {
    const existing = await dependencies.findExact({
      context,
      table,
      tableId,
      stableId: item.stableId,
    })
    if (!Array.isArray(existing)) throw new Error('operation_dependency_result_invalid')
    if (existing.length > 1) throw new Error('duplicate_stable_record_id:material_evidence')
    if (existing.length === 1 && !businessFieldsMatch(table, existing[0], item.businessFields)) {
      throw new Error('evidence_projection_conflict:' + item.stableId)
    }
    if (existing.length === 1) {
      assertOperationRecordScope(
        context,
        table,
        operationRecord(table, existing[0]),
        item.businessFields['作品 ID'],
      )
    }
  }

  const results = []
  for (const item of prepared) {
    const result = await dependencies.withStableCreateLock({
      context, table, tableId, stableId: item.stableId,
    }, async () => {
      const existing = await dependencies.findExact({
        context,
        table,
        tableId,
        stableId: item.stableId,
      })
      if (!Array.isArray(existing)) throw new Error('operation_dependency_result_invalid')
      if (existing.length > 1) throw new Error('duplicate_stable_record_id:material_evidence')
      if (existing.length === 1 && !businessFieldsMatch(table, existing[0], item.businessFields)) {
        throw new Error('evidence_projection_conflict:' + item.stableId)
      }
      const created = existing.length === 0
      let fields = null
      if (created) {
        fields = normalizeCompleteOperationFields(table, {
          ...item.businessFields,
          [table.stableId]: item.stableId,
          '项目 ID': context.schema.projectId,
          '版本': OPERATION_VERSION,
          '状态': '候选',
          '来源': 'trusted-analysis-projection',
          '更新时间': nowValue,
        })
        await dependencies.create({ context, table, tableId, fields })
      }
      const verified = await dependencies.findExact({
        context,
        table,
        tableId,
        stableId: item.stableId,
      })
      if (!Array.isArray(verified) || verified.length !== 1) {
        throw new Error(verified?.length > 1
          ? 'duplicate_stable_record_id:material_evidence'
          : 'evidence_projection_verification_failed:' + item.stableId)
      }
      if (!businessFieldsMatch(table, verified[0], fields || item.businessFields)) {
        throw new Error('evidence_projection_conflict:' + item.stableId)
      }
      const record = operationRecord(table, verified[0])
      assertOperationRecordScope(
        context,
        table,
        record,
        item.businessFields['作品 ID'],
      )
      return {
        stableId: item.stableId,
        outcome: created ? 'created' : 'unchanged',
        record,
      }
    })
    results.push(result)
  }
  return {
    ok: true,
    action: 'project-evidence',
    projectId: context.schema.projectId,
    workId,
    count: results.length,
    created: results.filter(result => result.outcome === 'created').length,
    unchanged: results.filter(result => result.outcome === 'unchanged').length,
    results,
  }
}

function parseStdinJson(value, label, maximumBytes) {
  if (typeof value !== 'string') throw new Error(label + '_stdin_required')
  if (Buffer.byteLength(value, 'utf8') > maximumBytes) {
    throw new Error(label + '_stdin_too_large')
  }
  const text = value.trim()
  if (!text) throw new Error(label + '_stdin_required')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(label + '_stdin_invalid_json')
  }
}

function parseOperationInput(value) {
  return parseStdinJson(value, 'operate', MAX_OPERATION_INPUT_BYTES)
}

function parseEvidenceProjectionInput(value) {
  return parseStdinJson(value, 'project_evidence', MAX_EVIDENCE_PROJECTION_INPUT_BYTES)
}

function parseReviewInput(value) {
  return parseStdinJson(value, 'review', MAX_OPERATION_INPUT_BYTES)
}

export function directorBrainStdinSpec(command) {
  if (command === 'operate') {
    return { label: 'operate', maximumBytes: MAX_OPERATION_INPUT_BYTES }
  }
  if (command === 'project-evidence') {
    return { label: 'project_evidence', maximumBytes: MAX_EVIDENCE_PROJECTION_INPUT_BYTES }
  }
  if (command === 'review') {
    return { label: 'review', maximumBytes: MAX_OPERATION_INPUT_BYTES }
  }
  return null
}

export function parseDirectorBrainArgs(argv) {
  const args = {
    command: argv[0] || '',
    schemaPath: DEFAULT_SCHEMA_PATH,
    catalogPath: DEFAULT_CATALOG_PATH,
    appId: null,
    tableKey: null,
    dryRun: false,
  }
  if (['operate', 'project-evidence', 'review'].includes(args.command) && argv.length !== 1) {
    throw new Error(args.command.replace(/-/gu, '_') + '_accepts_stdin_only')
  }
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--dry-run') {
      if (args.command !== 'migrate') throw new Error('unknown_option:' + flag)
      args.dryRun = true
      continue
    }
    const value = argv[index + 1]
    if (flag === '--schema' || flag === '--catalog' || flag === '--app-id' || flag === '--table') {
      if (!value) throw new Error('missing_option_value:' + flag)
      if (flag === '--schema') args.schemaPath = resolve(value)
      if (flag === '--catalog') args.catalogPath = value
      if (flag === '--app-id') args.appId = value
      if (flag === '--table') args.tableKey = value
      index += 1
      continue
    }
    throw new Error('unknown_option:' + flag)
  }
  if (![
    'bootstrap',
    'check',
    'write-check',
    'seed',
    'sync-blueprint',
    'verify',
    'schema',
    'operate',
    'project-evidence',
    'review',
    'migrate',
  ].includes(args.command)) {
    throw new Error('director_brain_command_invalid')
  }
  return args
}

export async function runDirectorBrainCli(argv, options = {}) {
  const args = parseDirectorBrainArgs(argv)
  if (args.command === 'operate') {
    return executeDirectorBrainOperation(parseOperationInput(options.stdin), options)
  }
  if (args.command === 'project-evidence') {
    return projectDirectorBrainEvidence(parseEvidenceProjectionInput(options.stdin), options)
  }
  if (args.command === 'review') {
    return reviewDirectorBrainRecord(parseReviewInput(options.stdin), options)
  }
  if (args.command === 'migrate') return migrateDirectorBrain(args)
  if (args.command === 'schema') {
    const schema = await loadDirectorBrainSchema(args.schemaPath)
    return {
      ok: true,
      brainName: schema.brainName,
      projectId: schema.projectId,
      environment: schema.environment,
      tableCount: schema.tables.length,
      tables: schema.tables.map(table => ({
        key: table.key,
        name: table.name,
        stableId: table.stableId,
        fields: table.fields.length,
      })),
    }
  }
  if (args.command === 'bootstrap') return bootstrapDirectorBrain(args)
  if (args.command === 'check') return checkDirectorBrain(args)
  if (args.command === 'write-check') return writeCheckDirectorBrain(args)
  if (args.command === 'seed') return seedDirectorBrain(args)
  if (args.command === 'sync-blueprint') return syncDirectorBrainBlueprint({ ...options, ...args })
  return verifyDirectorBrain(args)
}
