import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const DIRECTOR_BRAIN_TOOL_NAME = 'aiworker_director_brain'
export const DEFAULT_TARGET_AGENT_ID = 'second-original'

export const DIRECTOR_BRAIN_TABLES = Object.freeze([
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

export const DIRECTOR_BRAIN_PROPOSAL_TABLES = Object.freeze([
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

const READ_TABLE_SET = new Set(DIRECTOR_BRAIN_TABLES)
const PROPOSAL_TABLE_SET = new Set(DIRECTOR_BRAIN_PROPOSAL_TABLES)
const WORK_SCOPED_TABLE_SET = new Set([
  'director_intents',
  'material_evidence',
  'people_profiles',
  'story_nodes',
  'story_relations',
  'material_judgments',
  'narrative_plans',
  'director_cases',
])
const GLOBAL_KNOWLEDGE_TABLE_SET = new Set(['skills_techniques'])
const MAX_TOOL_RESULT_BYTES = 48 * 1024
const MAX_USER_VISIBLE_ANSWER_CHARS = 160
const MAX_USER_VISIBLE_DETAIL_CHARS = 160
const MAX_WORKFLOW_SUGGESTION_CHARS = 96
const EXTRACTION_HTTP_TIMEOUT_MS = 15_000
export const DIRECTOR_BRAIN_EXTRACTION_SERVICE_URL =
  'http://127.0.0.1:3017/api/n8n/director-extraction'
const EXTRACTION_ACTIONS = new Set([
  'start_extraction',
  'extraction_status',
  'backfill_extraction',
])
const BLUEPRINT_TOPIC_STABLE_IDS = new Map([
  ['architecture', 'DB-ARCH-6L'],
  ['technique_learning', 'DB-LOOP-CASE'],
  ['final_goal', 'DB-GOAL-FINAL'],
  ['integration_boundary', 'DB-INTEGRATION-SINGLE'],
  ['data_boundary', 'DB-DATA-BOUNDARY'],
  ['current_scope', 'DB-SCOPE-NON-EDITING'],
])
const EXTRACTION_STATES = new Set([
  'awaiting_registration',
  'pending',
  'running',
  'awaiting_evidence_projection',
  'awaiting_intent_review',
  'awaiting_evidence_review',
  'awaiting_understanding_review',
  'awaiting_judgment_review',
  'awaiting_case_review',
  'awaiting_technique_review',
  'completed',
  'failed',
  'conflict',
])
const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_RUNTIME_SERVICE_PATH = resolve(
  MODULE_ROOT,
  'runtime',
  'scripts',
  'lib',
  'feishu-director-brain.mjs',
)

const TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: [
        'health',
        'explain',
        'resolve_work',
        'get',
        'search',
        'assemble',
        'workflow',
        'propose',
        'start_extraction',
        'extraction_status',
        'backfill_extraction',
      ],
      description: 'health 检查连接；explain 直接读取已生效系统蓝图并回答架构、技法学习逻辑、最终目标、集成边界、数据边界或当前范围；resolve_work 用作品名或别名解析唯一作品；get/search 读取作品知识；assemble 组装已审核上下文；workflow 返回六层就绪度、案例与技法成熟度；propose 写入候选；start_extraction/extraction_status/backfill_extraction 通过共享应用服务启动、查询或补齐导演知识提炼。',
    },
    topic: {
      type: 'string',
      enum: [...BLUEPRINT_TOPIC_STABLE_IDS.keys()],
      description: 'explain 专用主题。系统原理问题不要把“导演脑”误当作品名，也不要先 resolve_work。',
    },
    workId: {
      type: 'string',
      minLength: 1,
      maxLength: 160,
      description: 'resolve_work 之后得到的作品稳定业务 ID。七类作品业务表、all 检索和 assemble 必须提供；workflow 可提供 workId，或在用户只给片名时改传 query 由工具内部完成唯一解析。全局 skills_techniques 读取时可选传入来源作品过滤，候选来源则由已确认案例推导。system_blueprint 与 works 目录读操作不提供。',
    },
    table: {
      type: 'string',
      enum: ['all', ...DIRECTOR_BRAIN_TABLES],
      description: 'get 使用具体表；search 可使用 all；propose 只允许候选表。作品发现优先使用 resolve_work。',
    },
    stableId: {
      type: 'string',
      minLength: 1,
      maxLength: 160,
      description: 'get 使用的稳定业务 ID，不是飞书 record ID。',
    },
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'resolve_work 使用完整作品名或别名；workflow 和三类 extraction 动作也使用该字段并由工具内部唯一解析；search 使用当前作品内的最小明确关键词。',
    },
    sourceQuery: {
      type: 'string',
      minLength: 1,
      maxLength: 120,
      description: '仅 start_extraction 可选：明确视频标题、文件名或季集信息；同作品存在多个来源时必须提供。backfill_extraction 会补齐该作品全部已成功来源，不接受此字段。',
    },
    status: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      description: 'search 可选的精确审核状态；省略时只返回已审核知识。',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 20,
      description: 'search 返回上限，默认 10，最大 20。',
    },
    objective: {
      type: 'string',
      minLength: 1,
      maxLength: 500,
      description: 'workflow 可选的当前导演目标，用于生成六层就绪度、质量门槛和下一步建议。',
    },
    fields: {
      type: 'object',
      additionalProperties: true,
      description: 'propose 的业务字段，包含目标表主字段和必填内容；不要提供稳定 ID、项目、作品 ID、版本、状态、来源、更新时间或引用字段，这些由领域服务生成或解析。works 根候选必须含作品名称和作品类型，可选换行分隔的别名。',
    },
    references: {
      type: 'object',
      additionalProperties: false,
      description: '已审核记录的稳定业务 ID，不是飞书 record ID。assemble 必须提供 intentVersionId 和 evidenceIds；propose 的具体必填引用由目标表决定。',
      properties: {
        previousIntentVersionId: { type: 'string', minLength: 1, maxLength: 160 },
        previousProfileVersionId: { type: 'string', minLength: 1, maxLength: 160 },
        previousStoryNodeId: { type: 'string', minLength: 1, maxLength: 160 },
        previousStoryRelationId: { type: 'string', minLength: 1, maxLength: 160 },
        previousJudgmentId: { type: 'string', minLength: 1, maxLength: 160 },
        previousNarrativePlanId: { type: 'string', minLength: 1, maxLength: 160 },
        previousDirectorCaseId: { type: 'string', minLength: 1, maxLength: 160 },
        previousSkillTechniqueId: { type: 'string', minLength: 1, maxLength: 160 },
        evidenceIds: {
          type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
        sourceNodeId: { type: 'string', minLength: 1, maxLength: 160 },
        targetNodeId: { type: 'string', minLength: 1, maxLength: 160 },
        intentVersionId: { type: 'string', minLength: 1, maxLength: 160 },
        nodeIds: {
          type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
        judgmentId: { type: 'string', minLength: 1, maxLength: 160 },
        caseIds: {
          type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
        peopleProfileIds: {
          type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
        storyNodeIds: {
          type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
        storyRelationIds: {
          type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
        materialJudgmentIds: {
          type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
        narrativePlanIds: {
          type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
        directorCaseIds: {
          type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
        skillTechniqueIds: {
          type: 'array', minItems: 1, maxItems: 20, uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: 160 },
        },
      },
    },
  },
})

function safeString(value, maximum) {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : null
}

function hasExactKeys(value, required, optional = []) {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key))
    && keys.every(key => allowed.has(key))
}

const REFERENCE_STRING_KEYS = new Set([
  'previousIntentVersionId',
  'previousProfileVersionId',
  'previousStoryNodeId',
  'previousStoryRelationId',
  'previousJudgmentId',
  'previousNarrativePlanId',
  'previousDirectorCaseId',
  'previousSkillTechniqueId',
  'sourceNodeId',
  'targetNodeId',
  'intentVersionId',
  'judgmentId',
])
const REFERENCE_LIST_KEYS = new Set(['evidenceIds', 'nodeIds', 'caseIds'])
const ASSEMBLY_REFERENCE_LIST_KEYS = new Set([
  'evidenceIds',
  'peopleProfileIds',
  'storyNodeIds',
  'storyRelationIds',
  'materialJudgmentIds',
  'narrativePlanIds',
  'directorCaseIds',
  'skillTechniqueIds',
])

function normalizeReferences(value, { stringKeys, listKeys }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entries = Object.entries(value)
  if (entries.length === 0) return null
  const normalized = {}
  for (const [key, raw] of entries) {
    if (stringKeys.has(key)) {
      const stableId = safeString(raw, 160)
      if (!stableId) return null
      normalized[key] = stableId
      continue
    }
    if (listKeys.has(key)) {
      if (!Array.isArray(raw) || raw.length < 1 || raw.length > 20) return null
      const stableIds = raw.map(item => safeString(item, 160))
      if (stableIds.some(item => item === null) || new Set(stableIds).size !== stableIds.length) {
        return null
      }
      normalized[key] = stableIds
      continue
    }
    return null
  }
  return normalized
}

function normalizeProposalReferences(value) {
  if (value === undefined) return undefined
  return normalizeReferences(value, {
    stringKeys: REFERENCE_STRING_KEYS,
    listKeys: REFERENCE_LIST_KEYS,
  })
}

function normalizeAssemblyReferences(value) {
  const normalized = normalizeReferences(value, {
    stringKeys: new Set(['intentVersionId']),
    listKeys: ASSEMBLY_REFERENCE_LIST_KEYS,
  })
  return normalized
    && Object.hasOwn(normalized, 'intentVersionId')
    && Object.hasOwn(normalized, 'evidenceIds')
    ? normalized
    : null
}

export function normalizeDirectorBrainToolRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (value.action === 'health') {
    return hasExactKeys(value, ['action']) ? { action: 'health' } : null
  }
  if (value.action === 'explain') {
    if (!hasExactKeys(value, ['action', 'topic'])) return null
    const topic = safeString(value.topic, 64)
    return topic && BLUEPRINT_TOPIC_STABLE_IDS.has(topic)
      ? { action: 'explain', topic }
      : null
  }
  if (value.action === 'resolve_work') {
    if (!hasExactKeys(value, ['action', 'query'])) return null
    const query = safeString(value.query, 256)
    return query ? { action: 'resolve_work', query } : null
  }
  if (value.action === 'get') {
    if (!hasExactKeys(value, ['action', 'table', 'stableId'], ['workId'])) return null
    const table = safeString(value.table, 64)
    const needsWork = table && WORK_SCOPED_TABLE_SET.has(table)
    const globalKnowledge = table && GLOBAL_KNOWLEDGE_TABLE_SET.has(table)
    const workId = value.workId === undefined ? undefined : safeString(value.workId, 160)
    const stableId = safeString(value.stableId, 160)
    return table
      && table !== 'all'
      && READ_TABLE_SET.has(table)
      && stableId
      && (needsWork
        ? Boolean(workId)
        : globalKnowledge
          ? value.workId === undefined || Boolean(workId)
          : workId === undefined)
      ? {
          action: 'get',
          ...(workId === undefined ? {} : { workId }),
          table,
          stableId,
        }
      : null
  }
  if (value.action === 'search') {
    if (!hasExactKeys(value, ['action', 'table', 'query'], ['workId', 'status', 'limit'])) return null
    const table = safeString(value.table, 64)
    const needsWork = table === 'all' || (table && WORK_SCOPED_TABLE_SET.has(table))
    const globalKnowledge = table && GLOBAL_KNOWLEDGE_TABLE_SET.has(table)
    const workId = value.workId === undefined ? undefined : safeString(value.workId, 160)
    const query = safeString(value.query, 256)
    const status = value.status === undefined ? undefined : safeString(value.status, 64)
    const limit = value.limit ?? 10
    if (
      !table
      || (table !== 'all' && !READ_TABLE_SET.has(table))
      || (needsWork
        ? !workId
        : globalKnowledge
          ? value.workId !== undefined && !workId
          : workId !== undefined)
      || !query
      || (value.status !== undefined && !status)
      || !Number.isInteger(limit)
      || limit < 1
      || limit > 20
    ) return null
    return {
      action: 'search',
      ...(workId === undefined ? {} : { workId }),
      table,
      query,
      ...(status === undefined ? {} : { status }),
      limit,
    }
  }
  if (value.action === 'assemble') {
    if (!hasExactKeys(value, ['action', 'workId', 'references'])) return null
    const workId = safeString(value.workId, 160)
    const references = normalizeAssemblyReferences(value.references)
    return workId && references ? { action: 'assemble', workId, references } : null
  }
  if (value.action === 'workflow') {
    if (!hasExactKeys(value, ['action'], ['workId', 'query', 'objective'])) return null
    const workId = value.workId === undefined ? undefined : safeString(value.workId, 160)
    const query = value.query === undefined ? undefined : safeString(value.query, 256)
    const objective = value.objective === undefined ? undefined : safeString(value.objective, 500)
    return Boolean(workId) !== Boolean(query)
      && (value.workId === undefined || workId)
      && (value.query === undefined || query)
      && (value.objective === undefined || objective)
      ? {
          action: 'workflow',
          ...(workId === undefined ? { query } : { workId }),
          ...(objective === undefined ? {} : { objective }),
        }
      : null
  }
  if (value.action === 'extraction_status') {
    if (!hasExactKeys(value, ['action', 'query'])) return null
    const query = safeString(value.query, 256)
    return query ? { action: 'extraction_status', query } : null
  }
  if (value.action === 'backfill_extraction') {
    if (!hasExactKeys(value, ['action', 'query'])) return null
    const query = safeString(value.query, 256)
    return query ? { action: 'backfill_extraction', query } : null
  }
  if (value.action === 'start_extraction') {
    if (!hasExactKeys(value, ['action', 'query'], ['sourceQuery', 'objective'])) return null
    const query = safeString(value.query, 256)
    const sourceQuery = value.sourceQuery === undefined
      ? undefined
      : safeString(value.sourceQuery, 120)
    const objective = value.objective === undefined
      ? undefined
      : safeString(value.objective, 500)
    return query
      && (value.sourceQuery === undefined || sourceQuery)
      && (value.objective === undefined || objective)
      ? {
          action: value.action,
          query,
          ...(sourceQuery === undefined ? {} : { sourceQuery }),
          ...(objective === undefined ? {} : { objective }),
        }
      : null
  }
  if (value.action === 'propose') {
    if (!hasExactKeys(value, ['action', 'table', 'fields'], ['workId', 'references'])) return null
    const table = safeString(value.table, 64)
    const workId = value.workId === undefined ? undefined : safeString(value.workId, 160)
    const isWorkProposal = table === 'works'
    const isGlobalKnowledgeProposal = table && GLOBAL_KNOWLEDGE_TABLE_SET.has(table)
    const emptyReferences = value.references === undefined
      || (value.references
        && typeof value.references === 'object'
        && !Array.isArray(value.references)
        && Object.keys(value.references).length === 0)
    const references = isWorkProposal
      ? (emptyReferences ? value.references : null)
      : normalizeProposalReferences(value.references)
    const hasRequiredTechniqueCases = !isGlobalKnowledgeProposal
      || (references && Array.isArray(references.caseIds) && references.caseIds.length > 0)
    return table
      && PROPOSAL_TABLE_SET.has(table)
      && (isWorkProposal
        ? workId === undefined
        : isGlobalKnowledgeProposal
          ? value.workId === undefined || Boolean(workId)
          : Boolean(workId))
      && value.fields
      && typeof value.fields === 'object'
      && !Array.isArray(value.fields)
      && Object.keys(value.fields).length > 0
      && references !== null
      && hasRequiredTechniqueCases
      ? {
          action: 'propose',
          ...(workId === undefined ? {} : { workId }),
          table,
          fields: value.fields,
          ...(references === undefined ? {} : { references }),
        }
      : null
  }
  return null
}

export async function loadInstalledDirectorBrainService(
  servicePath = DEFAULT_RUNTIME_SERVICE_PATH,
) {
  const runtimeModule = await import(pathToFileURL(servicePath).href)
  if (typeof runtimeModule.executeDirectorBrainOperation !== 'function') {
    throw new Error('director_brain_runtime_service_invalid')
  }
  return operation => runtimeModule.executeDirectorBrainOperation(operation)
}

async function readBoundedResponseText(response) {
  const declaredLength = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TOOL_RESULT_BYTES) {
    throw new Error('director_brain_runtime_result_too_large')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let totalBytes = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    totalBytes += value.byteLength
    if (totalBytes > MAX_TOOL_RESULT_BYTES) {
      await reader.cancel()
      throw new Error('director_brain_runtime_result_too_large')
    }
    text += decoder.decode(value, { stream: true })
  }
  return text + decoder.decode()
}

export function createDirectorBrainExtractionService({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('director_brain_extraction_service_invalid')
  }
  return async operation => {
    const response = await fetchImpl(DIRECTOR_BRAIN_EXTRACTION_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(operation),
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(EXTRACTION_HTTP_TIMEOUT_MS),
    })
    const responseText = await readBoundedResponseText(response)
    let result
    try {
      result = JSON.parse(responseText)
    } catch {
      throw new Error('director_brain_extraction_response_invalid')
    }
    if (!response.ok || result?.ok !== true) {
      const code = safeString(result?.code, 160)
      throw new Error(code || `director_brain_extraction_http_${response.status}`)
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || result.action !== operation.action) {
      throw new Error('director_brain_extraction_response_invalid')
    }
    return result
  }
}

export async function loadInstalledDirectorBrainExtractionService() {
  return createDirectorBrainExtractionService()
}

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

function mapDirectorBrainError(error, action) {
  const code = error instanceof Error ? error.message : ''
  if (/director_extraction_source_not_found/iu.test(code)) {
    return '没有找到已完成的视频分析。请告诉我更准确的视频标题或季集。'
  }
  if (/director_extraction_source_ambiguous/iu.test(code)) {
    return '匹配到多个视频分析。请告诉我更准确的视频标题或季集。'
  }
  if (/director_extraction_(?:work_not_reviewed|review_references_invalid|reference_not_reviewed)/iu.test(code)) {
    return '上一步内容还没有确认，暂时不能继续整理。'
  }
  if (/director_extraction_(?:work_binding_conflict|source_conflict|review_conflict)/iu.test(code)) {
    return '视频和作品的关系发生了变化，已停止整理，请先检查。'
  }
  if (/director_extraction_objective_conflict/iu.test(code)) {
    return '这次整理目标与已经开始的整理不一致，未重复启动。'
  }
  if (/work_resolution_ambiguous/iu.test(code)) {
    return '作品名称或别名不唯一，请提供更准确的完整名称。'
  }
  if (/work_(?:not_found|mismatch|inactive)|operation_work/iu.test(code)) {
    return '无法确认当前作品，请先按完整作品名或别名解析。'
  }
  if (/proposal_(?:conflict|stable_id)|duplicate_stable_id|stable_record_id_hash_collision/iu.test(code)) {
    return '导演脑中存在同 ID 的不同记录，本次未写入。'
  }
  if (/proposal|secret|sensitive|unknown_record_field|forbidden/iu.test(code)) {
    return '候选内容不符合导演脑规则，本次未写入。'
  }
  if (action === 'start_extraction' || action === 'backfill_extraction') {
    return '导演知识暂时无法开始整理，请稍后再试。'
  }
  if (action === 'extraction_status') return '导演知识进度暂时无法查询，请稍后再试。'
  return action === 'propose'
    ? '导演脑暂时无法保存候选，本次未写入。'
    : '导演脑暂时无法读取，请稍后再试。'
}

function serializeServiceResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.ok !== true) {
    throw new Error('director_brain_runtime_result_invalid')
  }
  const text = JSON.stringify(withUserVisibleAnswer(value))
  if (Buffer.byteLength(text, 'utf8') > MAX_TOOL_RESULT_BYTES) {
    throw new Error('director_brain_runtime_result_too_large')
  }
  return text
}

const WORKFLOW_LAYER_LABELS = Object.freeze([
  ['perception', '素材感知层'],
  ['people', '人物理解层'],
  ['story', '故事发现层'],
  ['judgment', '导演判断层'],
  ['narrative', '叙事结构层'],
  ['intent', '导演意图层'],
])

const USER_VISIBLE_CONTEXT = Symbol('director-brain-user-visible-context')
const TRUSTED_HANDLED_ANSWER = Symbol('director-brain-trusted-handled-answer')
export const DIRECTOR_BRAIN_UNAVAILABLE_MESSAGE = '导演脑暂时无法读取，请稍后再试。'

const USER_VISIBLE_SENSITIVE_PATTERNS = Object.freeze([
  /\b(?:workId|taskId|recordId|tableId|runId|extractionId|candidateId|sourceTaskId|work_id|task_id|record_id|table_id|run_id|extraction_id|candidate_id|source_task_id)\b/iu,
  /\b(?:WORK|TASK|REC|RUN|EXTRACTION|CANDIDATE|SOURCE|PERSON|NODE|JUDGMENT|NARRATIVE|CASE|SKILL|EVIDENCE|INTENT|MATERIAL|SCENE|SHOT|BATCH)-[A-Z0-9][A-Z0-9_-]*\b/u,
  /(?:作品|任务|记录|运行|提炼|候选)\s*(?:ID|id|编号)/u,
  /\b(?:awaiting_[a-z_]+|in_progress|not_started|pending|running|completed|failed|conflict)\b/iu,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu,
  /\b[0-9a-f]{7,64}\b/iu,
  /\b(?:rec|tbl)[A-Za-z0-9]{8,24}\b/u,
  /(?:\/Users\/|\/home\/|\/private\/|\/var\/|\/tmp\/|[A-Za-z]:\\)/u,
  /\b[a-z0-9_]*(?:token|secret|key|pass(?:word)?)[a-z0-9_]*\s*[:=]\s*\S+/iu,
])

function safeUserVisibleText(value, maximum = MAX_USER_VISIBLE_ANSWER_CHARS) {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  if (!normalized || normalized.length > maximum) return null
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) return null
  if (normalized.split(/[。！？!?]+/u).filter(Boolean).length > 3) return null
  return USER_VISIBLE_SENSITIVE_PATTERNS.some(pattern => pattern.test(normalized))
    ? null
    : normalized
}

function safeWorkName(...candidates) {
  for (const candidate of candidates) {
    const normalized = safeString(candidate, 48)
    if (normalized && safeUserVisibleText(normalized, 48)) return normalized
  }
  return '这个作品'
}

function displayedWorkName(value) {
  const normalized = safeUserVisibleText(value, 120)
  if (!normalized || normalized === '这个作品') return ''
  return normalized.startsWith('《') && normalized.endsWith('》')
    ? normalized
    : `《${normalized}》`
}

function singleSentenceText(value, maximum) {
  const normalized = safeUserVisibleText(value, maximum)
  if (!normalized) return null
  return normalized
    .replace(/\s+/gu, ' ')
    .split(/[。！？!?]/u, 1)[0]
    .trim()
}

function exactResponseContract(userVisibleAnswer, { noFallback = false } = {}) {
  const safeAnswer = safeUserVisibleText(userVisibleAnswer)
  return {
    mustQuoteUserVisibleAnswerExactly: true,
    doNotAddFacts: true,
    doNotExposeInternalIds: true,
    ...(noFallback
      ? {
          handled: true,
          stopAfterReply: true,
          doNotUseFallbackSources: true,
        }
      : {}),
    userVisibleAnswer: safeAnswer || DIRECTOR_BRAIN_UNAVAILABLE_MESSAGE,
  }
}

function handledAnswer(action, outcome, userVisibleAnswer) {
  return {
    ok: true,
    action,
    handled: true,
    outcome,
    responseContract: exactResponseContract(userVisibleAnswer, { noFallback: true }),
    [TRUSTED_HANDLED_ANSWER]: true,
  }
}

function resolutionBlocked(action, outcome) {
  return handledAnswer(
    action,
    outcome,
    outcome === 'ambiguous'
      ? '这个名称对应多个作品。请告诉我更准确的完整作品名。'
      : '我没有找到这个作品。请告诉我更准确的完整作品名。',
  )
}

function resolutionOutcome(value) {
  const code = [value?.outcome, value?.reason, value?.code, value?.status]
    .filter(item => typeof item === 'string')
    .join(' ')
  if (
    value?.ambiguous === true
    || (Array.isArray(value?.matches) && value.matches.length > 1)
    || /ambiguous|multiple_matches|not_unique/iu.test(code)
  ) return 'ambiguous'
  return 'not_found'
}

function maturityEntry(source, keys) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined
  for (const key of keys) {
    if (Object.hasOwn(source, key)) return source[key]
  }
  return undefined
}

function maturityText(entry, kind) {
  if (entry === true) return '已形成'
  if (entry === false) return '尚未形成'
  if (typeof entry === 'number' && Number.isFinite(entry) && entry >= 0) {
    return entry === 0 ? '尚未形成' : `已形成 ${Math.floor(entry)} 条`
  }
  const detail = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : null
  const rawStatus = typeof entry === 'string'
    ? entry
    : detail?.status ?? detail?.state ?? detail?.maturity
  const normalizedStatus = typeof rawStatus === 'string'
    ? rawStatus.trim().toLowerCase().replace(/[\s-]+/gu, '_')
    : ''
  const statusMap = {
    ready: '已形成',
    mature: '已成熟',
    completed: '已形成',
    available: '已形成',
    reviewed: '已确认',
    awaiting_review: '待确认',
    awaiting_case_review: kind === 'technique' ? '等待案例确认' : '待确认',
    waiting_case_review: kind === 'technique' ? '等待案例确认' : '待确认',
    blocked_by_case_review: '等待案例确认',
    in_progress: '整理中',
    running: '整理中',
    extracting: '整理中',
    building: '积累中',
    not_started: '尚未形成',
    missing: '尚未形成',
    empty: '尚未形成',
    unavailable: '尚未形成',
  }
  let text = statusMap[normalizedStatus]
    || (typeof rawStatus === 'string' && /[\u3400-\u9fff]/u.test(rawStatus)
      ? rawStatus.trim()
      : '')
  const reviewed = detail?.reviewedCount ?? detail?.confirmedCount
  const total = detail?.totalCount ?? detail?.total
  if (Number.isInteger(reviewed) && reviewed >= 0 && Number.isInteger(total) && total >= reviewed) {
    text = `${text || '积累中'}（已确认 ${reviewed}/${total}）`
  }
  return safeUserVisibleText(text, 48)
}

function workflowLearningSummary(value) {
  const source = value.learningReadiness ?? value.maturity
  const caseEntry = maturityEntry(source, [
    'case', 'cases', 'directorCase', 'directorCases', 'caseStatus', 'caseReady',
  ])
  const techniqueEntry = maturityEntry(source, [
    'technique', 'techniques', 'skillTechnique', 'skillTechniques',
    'techniqueStatus', 'techniqueReady',
  ])
  const caseText = maturityText(caseEntry, 'case')
  const techniqueText = maturityText(techniqueEntry, 'technique')
  return [
    ...(caseText ? [`导演案例：${caseText}`] : []),
    ...(techniqueText ? [`技法沉淀：${techniqueText}`] : []),
  ].join('；')
}

function extractionState(value) {
  const raw = value?.state ?? value?.status ?? value?.extractionStatus
  return typeof raw === 'string'
    ? raw.trim().toLowerCase().replace(/[\s-]+/gu, '_')
    : ''
}

function extractionAggregateSummary(value, workName) {
  const sourceCount = value?.sourceCount
  const counts = value?.counts
  if (!Number.isSafeInteger(sourceCount) || sourceCount < 2
    || !counts || typeof counts !== 'object' || Array.isArray(counts)) return ''
  const completed = counts.completed
  const active = counts.active
  const failed = counts.failed
  const waitingReview = counts.waitingReview
  if (![completed, active, failed, waitingReview]
    .every(count => Number.isSafeInteger(count) && count >= 0)
    || completed + active + failed + waitingReview !== sourceCount) return ''
  return `《${workName}》共 ${sourceCount} 个素材来源：完成 ${completed}，处理中 ${active}，待确认 ${waitingReview}，失败 ${failed}。`
}

function assertExtractionResult(value, action) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.ok !== true || value.action !== action) {
    throw new Error('director_brain_extraction_response_invalid')
  }
  const state = extractionState(value)
  if (action === 'extraction_status' && value.found === false) {
    if (state) throw new Error('director_brain_extraction_response_invalid')
    return value
  }
  if (!EXTRACTION_STATES.has(state)) {
    throw new Error('director_brain_extraction_response_invalid')
  }
  return value
}

function extractionUserVisibleAnswer(value) {
  const context = value[USER_VISIBLE_CONTEXT] || {}
  const workName = safeWorkName(context.workName)
  const state = extractionState(value)
  if (value.action === 'start_extraction') {
    if (/conflict/iu.test(state)) return `《${workName}》的视频和作品关系发生了变化，已停止整理，请先检查。`
    if (/awaiting_registration/iu.test(state)) return `《${workName}》还需要先完成作品登记，确认后才能继续整理。`
    if (/awaiting_|complete|succeeded|done/iu.test(state)) {
      return `《${workName}》已经有整理进度，可以直接问我当前状态。`
    }
    if (/already|active|running/iu.test(state)) return `《${workName}》已经在整理中，不会重复启动。`
    if (/fail|error|reject/iu.test(state)) return `《${workName}》暂时无法开始整理，请稍后再试。`
    return `已开始整理《${workName}》的导演知识。稍后直接问我进度就行。`
  }
  if (value.action === 'backfill_extraction') {
    if (Number.isSafeInteger(value.rejected) && value.rejected > 0) {
      const registered = Number.isSafeInteger(value.registered) ? value.registered : 0
      const existing = Number.isSafeInteger(value.existing) ? value.existing : 0
      return `《${workName}》素材补齐：新增 ${registered}，已有 ${existing}，未通过校验 ${value.rejected}。`
    }
    if (Number.isSafeInteger(value.registered) && value.registered > 0) {
      return `已为《${workName}》补齐登记 ${value.registered} 个素材来源。稍后直接问我进度就行。`
    }
    if (Number.isSafeInteger(value.existing) && value.existing > 0 && value.rejected === 0) {
      return `《${workName}》的全部素材来源都已登记，不会重复补齐。`
    }
    if (/conflict/iu.test(state)) return `《${workName}》的视频和作品关系发生了变化，已停止整理，请先检查。`
    if (/awaiting_registration/iu.test(state)) return `《${workName}》还需要先完成作品登记，确认后才能继续补齐。`
    if (/awaiting_|complete|succeeded|done/iu.test(state)) {
      return `《${workName}》已经有补齐进度，可以直接问我当前状态。`
    }
    if (/already|active|running/iu.test(state)) return `《${workName}》已经在补齐中，不会重复启动。`
    if (/fail|error|reject/iu.test(state)) return `《${workName}》暂时无法开始补齐，请稍后再试。`
    return `已开始补齐《${workName}》缺少的导演知识。稍后直接问我进度就行。`
  }
  if (value.found === false) return `《${workName}》还没有开始整理导演知识。`
  const aggregate = extractionAggregateSummary(value, workName)
  if (aggregate) return aggregate
  if (/awaiting_registration/iu.test(state)) {
    return `《${workName}》还需要先完成作品登记，确认后才能继续整理。`
  }
  if (/awaiting_evidence_projection/iu.test(state)) {
    return `《${workName}》的素材证据正在写入导演脑，完成后会自动继续。`
  }
  if (/awaiting_intent_review/iu.test(state)) {
    return `《${workName}》需要先确认导演意图，确认后会自动继续判断。`
  }
  if (/awaiting_evidence_review/iu.test(state)) {
    return `《${workName}》的素材证据已经整理好，正在等你确认。确认后会继续理解人物和故事。`
  }
  if (/awaiting_understanding_review/iu.test(state)) {
    return `《${workName}》的人物和故事理解已经整理好，正在等你确认。`
  }
  if (/awaiting_judgment_review/iu.test(state)) {
    return `《${workName}》的导演判断已经整理好，正在等你确认。`
  }
  if (/awaiting_case_review|waiting_case_review/iu.test(state)) {
    return `《${workName}》的导演案例已经整理好，正在等你确认。确认后才会继续沉淀技法。`
  }
  if (/awaiting_technique_review/iu.test(state)) {
    return `《${workName}》的导演技法已经整理成候选，正在等你确认。`
  }
  if (/complete|completed|succeeded|done/iu.test(state)) return `《${workName}》的导演知识已经整理完成。`
  if (/conflict/iu.test(state)) return `《${workName}》的视频和作品关系发生了变化，已停止整理，请先检查。`
  if (/fail|failed|error/iu.test(state)) return `《${workName}》的导演知识没有整理完成，可以稍后重试。`
  if (/queue|queued|pending/iu.test(state)) return `《${workName}》已经排队，正在等待开始。`
  if (/running|in_progress|extracting|backfill/iu.test(state)) return `《${workName}》正在整理导演知识。`
  if (/not_started|missing|none/iu.test(state)) return `《${workName}》还没有开始整理导演知识。`
  return `《${workName}》的导演知识状态暂时无法确认，请稍后再试。`
}

function withUserVisibleAnswer(value) {
  if (value[TRUSTED_HANDLED_ANSWER] === true) return value
  // Extraction responses always pass through the local projection below.  Never
  // trust a downstream response contract or return its internal identifiers.
  if (EXTRACTION_ACTIONS.has(value.action)) {
    return {
      ok: true,
      action: value.action,
      handled: true,
      responseContract: exactResponseContract(extractionUserVisibleAnswer(value), {
        noFallback: true,
      }),
    }
  }
  if (value.action === 'resolve_work' && value.found !== true) {
    return resolutionBlocked('resolve_work', resolutionOutcome(value))
  }
  if (value.action === 'workflow' && value.readiness
    && typeof value.readiness === 'object' && !Array.isArray(value.readiness)) {
    const readyLayers = WORKFLOW_LAYER_LABELS
      .filter(([key]) => value.readiness[key] === true)
      .length
    const missingLayers = WORKFLOW_LAYER_LABELS
      .filter(([key]) => value.readiness[key] !== true)
      .map(([, label]) => label.replace(/层$/u, ''))
    const learningSummary = workflowLearningSummary(value)
    const statusSummary = [
      missingLayers.length === 0
        ? '六层均已就绪'
        : `未就绪：${missingLayers.join('、')}`,
      ...(learningSummary ? [learningSummary] : []),
    ].join('；')
    const nextSuggestion = singleSentenceText(
      value.nextSuggestion,
      MAX_WORKFLOW_SUGGESTION_CHARS,
    ) || '请先补齐当前未就绪层所需的已确认内容。'
    const workName = displayedWorkName(value[USER_VISIBLE_CONTEXT]?.workName)
    return {
      ok: true,
      action: 'workflow',
      handled: true,
      responseContract: exactResponseContract(
        `${workName ? `${workName}的` : ''}导演脑：${readyLayers}/6 层就绪。`
        + `${statusSummary}。下一步：${nextSuggestion.replace(/[。！？!?]+$/u, '')}。`,
        { noFallback: true },
      ),
    }
  }
  if (value.responseContract?.mustQuoteUserVisibleAnswerExactly === true) {
    const answer = safeUserVisibleText(
      value.responseContract.userVisibleAnswer,
      MAX_USER_VISIBLE_DETAIL_CHARS,
    )
    return answer
      ? {
          ok: true,
          action: value.action,
          handled: true,
          responseContract: exactResponseContract(answer, { noFallback: true }),
        }
      : handledAnswer(
          value.action,
          'temporarily_unavailable',
          value.action === 'propose'
            ? '导演脑暂时无法保存候选，本次未写入。'
            : '导演脑暂时无法读取，请稍后再试。',
        )
  }
  return value
}

async function executeResolvedRequest(executeOperation, getExtractionService, request) {
  if (request.action === 'explain') {
    const stableId = BLUEPRINT_TOPIC_STABLE_IDS.get(request.topic)
    const result = await executeOperation({
      action: 'get',
      table: 'system_blueprint',
      stableId,
    })
    const answer = safeUserVisibleText(
      result?.record?.fields?.['内容'],
      MAX_USER_VISIBLE_ANSWER_CHARS,
    )
    if (result?.ok !== true
      || result.action !== 'get'
      || result.table !== 'system_blueprint'
      || result.found !== true
      || result.record?.reviewed !== true
      || !answer) {
      throw new Error('director_brain_blueprint_result_invalid')
    }
    return handledAnswer('explain', 'answered', answer)
  }
  const needsResolution = request.query !== undefined
    && (request.action === 'workflow' || EXTRACTION_ACTIONS.has(request.action))
  if (!needsResolution) {
    const result = await executeOperation(request)
    if (request.action === 'workflow' && result?.action !== 'workflow') {
      throw new Error('director_brain_runtime_result_invalid')
    }
    return result
  }
  const resolution = await executeOperation({
    action: 'resolve_work',
    query: request.query,
  })
  const workId = safeString(resolution?.work?.workId, 160)
  if (resolution?.ok !== true || resolution.action !== 'resolve_work') {
    throw new Error('director_brain_runtime_result_invalid')
  }
  if (resolution.found !== true || !workId) {
    return resolutionBlocked(request.action, resolutionOutcome(resolution))
  }
  if (request.action === 'workflow') {
    const result = await executeOperation({
      action: 'workflow',
      workId,
      ...(request.objective === undefined ? {} : { objective: request.objective }),
    })
    if (result?.action !== 'workflow') throw new Error('director_brain_runtime_result_invalid')
    return {
      ...result,
      [USER_VISIBLE_CONTEXT]: {
        workName: safeWorkName(resolution?.work?.name, request.query),
      },
    }
  }
  const executeExtraction = typeof getExtractionService === 'function'
    ? await getExtractionService()
    : null
  if (typeof executeExtraction !== 'function') {
    throw new Error('director_brain_extraction_service_invalid')
  }
  const operation = {
    action: request.action,
    workId,
    ...(request.sourceQuery === undefined ? {} : { sourceQuery: request.sourceQuery }),
    ...(request.objective === undefined ? {} : { objective: request.objective }),
  }
  const result = assertExtractionResult(await executeExtraction(operation), request.action)
  return {
    ...result,
    [USER_VISIBLE_CONTEXT]: {
      workName: safeWorkName(resolution?.work?.name, request.query),
    },
  }
}

export async function readDirectorBrainSystemAnswer(topic, { service } = {}) {
  const request = normalizeDirectorBrainToolRequest({ action: 'explain', topic })
  if (!request) throw new Error('director_brain_system_topic_invalid')
  const executeOperation = service || await loadInstalledDirectorBrainService()
  const result = await executeResolvedRequest(executeOperation, null, request)
  const answer = safeUserVisibleText(
    result?.responseContract?.userVisibleAnswer,
    MAX_USER_VISIBLE_ANSWER_CHARS,
  )
  if (!answer) throw new Error('director_brain_system_answer_invalid')
  return answer
}

export function createDirectorBrainTool({
  context,
  releaseReady = true,
  targetAgentId = DEFAULT_TARGET_AGENT_ID,
  service,
  extractionService,
} = {}) {
  if (context?.agentId !== targetAgentId) return null
  return {
    name: DIRECTOR_BRAIN_TOOL_NAME,
    label: 'AI-worker 导演脑',
    description: '完整导演脑的唯一 OpenClaw 工具。询问导演脑架构、技法学习底层逻辑、最终目标、集成边界、数据边界或当前范围时，直接调用 explain 并选择 topic；这是系统问题，不得把“导演脑”当作品名，不得先 resolve_work，也不得回退通用工具。作品上下文必须严格隔离；skills_techniques 是由已确认案例支撑的跨作品全局技法库，可直接读取或按来源作品过滤。用户只说作品名或别名并查询六层状态时直接调用 workflow，把原片名放入 query，工具会在内部唯一解析，不要猜测或索取 ID；启动、查询或补齐导演知识时分别调用 start_extraction、extraction_status、backfill_extraction，同样只传作品名 query。解析出的内部 ID 只用于工具调用，绝不向用户展示。作品未找到或名称不唯一时，responseContract 已经给出本轮完整短答；必须逐字回复并立刻结束，不得回退到 read、exec、memory、聊天记录、SQLite、n8n、媒体目录或旧素材库。explain、workflow 和 extraction 动作返回 responseContract 时，最终答复必须逐字使用其中 userVisibleAnswer，不增加任何文字或事实。其他回答也只能忠实复述当前工具实际返回的字段：readiness=true 只表示该层就绪，layerCoverage 只表示六层全局覆盖率，禁止改写成每层百分比；不得捏造准确率、测试次数、人物动机、故事变体或其他未返回事实。需要具体故事内容时继续 search 并用 assemble 校验最小已审核上下文，无法合法组装就明确依据不足。候选不是事实；素材证据与系统蓝图只读。不得批准、删除、创建第二条任务链，或控制剪辑、DaVinci、剪辑时间线、渲染与导出。',
    parameters: TOOL_PARAMETERS,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      if (!releaseReady) return textResult('导演脑正在维护，请稍后再试。')
      const request = normalizeDirectorBrainToolRequest(params)
      if (!request) return textResult('导演脑请求参数无效。')
      try {
        const executeOperation = service || await loadInstalledDirectorBrainService()
        const getExtractionService = EXTRACTION_ACTIONS.has(request.action)
          ? async () => extractionService || await loadInstalledDirectorBrainExtractionService()
          : null
        return textResult(serializeServiceResult(
          await executeResolvedRequest(executeOperation, getExtractionService, request),
        ))
      } catch (error) {
        const code = error instanceof Error ? error.message : ''
        if (/work_resolution_ambiguous/iu.test(code)) {
          return textResult(serializeServiceResult(resolutionBlocked(request.action, 'ambiguous')))
        }
        if (/work_(?:not_found|mismatch|inactive)|operation_work/iu.test(code)) {
          return textResult(serializeServiceResult(resolutionBlocked(request.action, 'not_found')))
        }
        if (EXTRACTION_ACTIONS.has(request.action)) {
          return textResult(serializeServiceResult(handledAnswer(
            request.action,
            'temporarily_unavailable',
            mapDirectorBrainError(error, request.action),
          )))
        }
        return textResult(serializeServiceResult(handledAnswer(
          request.action,
          'temporarily_unavailable',
          mapDirectorBrainError(error, request.action),
        )))
      }
    },
  }
}

export { TOOL_PARAMETERS }
