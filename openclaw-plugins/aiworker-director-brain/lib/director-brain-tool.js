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
  'skills_techniques',
])
const MAX_TOOL_RESULT_BYTES = 48 * 1024
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
      enum: ['health', 'resolve_work', 'get', 'search', 'assemble', 'workflow', 'propose'],
      description: 'health 检查连接；resolve_work 用作品名或别名解析唯一作品；get/search 读取作品知识；assemble 组装已审核上下文；workflow 返回六层就绪度与下一步；propose 写入候选。',
    },
    workId: {
      type: 'string',
      minLength: 1,
      maxLength: 160,
      description: 'resolve_work 之后得到的作品稳定业务 ID。八类作品业务表、all 检索、assemble 和非 works 候选必须提供；workflow 可提供 workId，或在用户只给片名时改传 query 由工具内部完成唯一解析。项目全局 system_blueprint 与 works 目录读操作不提供。',
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
      description: 'resolve_work 使用完整作品名或别名；workflow 在只有片名而没有 ID 时也使用该字段并由工具内部唯一解析；search 使用当前作品内的最小明确关键词。',
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
  if (value.action === 'resolve_work') {
    if (!hasExactKeys(value, ['action', 'query'])) return null
    const query = safeString(value.query, 256)
    return query ? { action: 'resolve_work', query } : null
  }
  if (value.action === 'get') {
    if (!hasExactKeys(value, ['action', 'table', 'stableId'], ['workId'])) return null
    const table = safeString(value.table, 64)
    const needsWork = table && WORK_SCOPED_TABLE_SET.has(table)
    const workId = value.workId === undefined ? undefined : safeString(value.workId, 160)
    const stableId = safeString(value.stableId, 160)
    return table
      && table !== 'all'
      && READ_TABLE_SET.has(table)
      && stableId
      && (needsWork ? Boolean(workId) : workId === undefined)
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
    const workId = value.workId === undefined ? undefined : safeString(value.workId, 160)
    const query = safeString(value.query, 256)
    const status = value.status === undefined ? undefined : safeString(value.status, 64)
    const limit = value.limit ?? 10
    if (
      !table
      || (table !== 'all' && !READ_TABLE_SET.has(table))
      || (needsWork ? !workId : workId !== undefined)
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
  if (value.action === 'propose') {
    if (!hasExactKeys(value, ['action', 'table', 'fields'], ['workId', 'references'])) return null
    const table = safeString(value.table, 64)
    const workId = value.workId === undefined ? undefined : safeString(value.workId, 160)
    const isWorkProposal = table === 'works'
    const emptyReferences = value.references === undefined
      || (value.references
        && typeof value.references === 'object'
        && !Array.isArray(value.references)
        && Object.keys(value.references).length === 0)
    const references = isWorkProposal
      ? (emptyReferences ? value.references : null)
      : normalizeProposalReferences(value.references)
    return table
      && PROPOSAL_TABLE_SET.has(table)
      && (isWorkProposal ? workId === undefined : Boolean(workId))
      && value.fields
      && typeof value.fields === 'object'
      && !Array.isArray(value.fields)
      && Object.keys(value.fields).length > 0
      && references !== null
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

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

function mapDirectorBrainError(error, action) {
  const code = error instanceof Error ? error.message : ''
  if (/work_resolution_ambiguous/iu.test(code)) {
    return '作品名称或别名不唯一，请提供更准确的完整名称。'
  }
  if (/work_(?:not_found|mismatch|inactive)|operation_work/iu.test(code)) {
    return '无法确认当前作品，请先按完整作品名或别名解析。'
  }
  if (/proposal_(?:conflict|stable_id)|duplicate_stable_id/iu.test(code)) {
    return '导演脑中存在同 ID 的不同记录，本次未写入。'
  }
  if (/proposal|secret|sensitive|unknown_record_field|forbidden/iu.test(code)) {
    return '候选内容不符合导演脑规则，本次未写入。'
  }
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

function withUserVisibleAnswer(value) {
  if (value.action !== 'workflow' || !value.readiness || typeof value.readiness !== 'object') {
    return value
  }
  const layerLines = WORKFLOW_LAYER_LABELS.map(([key, label]) => (
    `- ${label}：${value.readiness[key] === true ? '已就绪' : '未就绪'}`
  ))
  const nextSuggestion = typeof value.nextSuggestion === 'string'
    && value.nextSuggestion.trim().length > 0
    ? value.nextSuggestion.trim()
    : '导演脑未返回下一步建议。'
  return {
    ...value,
    responseContract: {
      mustQuoteUserVisibleAnswerExactly: true,
      doNotAddFacts: true,
      doNotExposeInternalIds: true,
      userVisibleAnswer: [
        '六层导演脑建设状态：',
        ...layerLines,
        '',
        `当前结论：${nextSuggestion}`,
      ].join('\n'),
    },
  }
}

async function executeResolvedRequest(executeOperation, request) {
  if (request.action !== 'workflow' || request.query === undefined) {
    return executeOperation(request)
  }
  const resolution = await executeOperation({
    action: 'resolve_work',
    query: request.query,
  })
  const workId = safeString(resolution?.work?.workId, 160)
  if (resolution?.ok !== true || resolution.found !== true || !workId) {
    return resolution
  }
  return executeOperation({
    action: 'workflow',
    workId,
    ...(request.objective === undefined ? {} : { objective: request.objective }),
  })
}

export function createDirectorBrainTool({
  context,
  releaseReady = true,
  targetAgentId = DEFAULT_TARGET_AGENT_ID,
  service,
} = {}) {
  if (context?.agentId !== targetAgentId) return null
  return {
    name: DIRECTOR_BRAIN_TOOL_NAME,
    label: 'AI-worker 导演脑',
    description: '完整导演脑的唯一 OpenClaw 工具。用户只说作品名或别名并查询六层状态时直接调用 workflow，把原片名放入 query，工具会在内部唯一解析，不要猜测或索取 ID；其他后续动作才先 resolve_work。解析出的内部 ID 只用于工具调用，绝不向用户展示。workflow 返回 responseContract 时，最终答复必须逐字使用其中 userVisibleAnswer，不增加任何文字或事实。其他回答也只能忠实复述当前工具实际返回的字段：readiness=true 只表示该层就绪，layerCoverage 只表示六层全局覆盖率，禁止改写成每层百分比；不得捏造准确率、测试次数、人物动机、故事变体或其他未返回事实。需要具体故事内容时继续 search 并用 assemble 校验最小已审核上下文，无法合法组装就明确依据不足。候选不是事实；素材证据与系统蓝图只读。不得批准、删除、创建任务链，或控制剪辑、DaVinci、剪辑时间线、渲染与导出。',
    parameters: TOOL_PARAMETERS,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      if (!releaseReady) return textResult('导演脑正在维护，请稍后再试。')
      const request = normalizeDirectorBrainToolRequest(params)
      if (!request) return textResult('导演脑请求参数无效。')
      try {
        const executeOperation = service || await loadInstalledDirectorBrainService()
        return textResult(serializeServiceResult(await executeResolvedRequest(executeOperation, request)))
      } catch (error) {
        return textResult(mapDirectorBrainError(error, request.action))
      }
    },
  }
}

export { TOOL_PARAMETERS }
