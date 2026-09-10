import { createHash } from 'node:crypto'
import { z } from 'zod'
import { containsSensitiveValue } from '../../scripts/lib/sensitive-value-scanner.mjs'

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  return Object.freeze(value)
}

export const DIRECTOR_EXTRACTION_PROJECT_ID = 'PROJ-VIDEO-AUTOWORKER'
export const DIRECTOR_EXTRACTION_CONTRACT = 'director-extraction-v3'
export const DIRECTOR_EXTRACTION_PROMPT_VERSION = 'director-extraction-prompts-v3'
export const DIRECTOR_EXTRACTION_PROJECTION_VERSION = 'feishu-candidate-projection-v2'
export const DIRECTOR_EXTRACTION_CANDIDATE_SCHEMA_VERSION = 'director-candidate-fields-v3'
export const DIRECTOR_EXTRACTION_MAX_OUTPUT_BYTES = 128 * 1024
export const DIRECTOR_EXTRACTION_LEASE_SECONDS = 15 * 60
export const DIRECTOR_EXTRACTION_PROJECTION_BOUNDARY = deepFreeze({
  proposeBatchMaxInputBytes: 256 * 1024,
  targetBatchBytes: 192 * 1024,
  maximumBatchItems: 8,
  oversizedTextStrategy: 'lossless-utf8-batches',
})

export const directorExtractionPhases = [
  'perception',
  'understanding',
  'judgment',
  'case',
  'technique',
] as const

export type DirectorExtractionPhase = typeof directorExtractionPhases[number]
export type DirectorExtractionCurrentPhase = DirectorExtractionPhase | 'complete'
export type DirectorExtractionStatus =
  | 'awaiting_registration'
  | 'pending'
  | 'running'
  | 'awaiting_evidence_projection'
  | 'awaiting_intent_review'
  | 'awaiting_evidence_review'
  | 'awaiting_understanding_review'
  | 'awaiting_judgment_review'
  | 'awaiting_case_review'
  | 'awaiting_technique_review'
  | 'completed'
  | 'failed'
  | 'conflict'

type DirectorExtractionPhaseReviewStatus = Exclude<
  Extract<DirectorExtractionStatus, `awaiting_${string}_review`>,
  'awaiting_intent_review'
>

export const DIRECTOR_EXTRACTION_REVIEW_STATUS_BY_PHASE: Readonly<
  Record<DirectorExtractionPhase, DirectorExtractionPhaseReviewStatus>
> = deepFreeze({
  perception: 'awaiting_evidence_review',
  understanding: 'awaiting_understanding_review',
  judgment: 'awaiting_judgment_review',
  case: 'awaiting_case_review',
  technique: 'awaiting_technique_review',
})

export const DIRECTOR_EXTRACTION_REVIEW_PHASE_BY_STATUS: Readonly<
  Partial<Record<DirectorExtractionStatus, DirectorExtractionPhase>>
> = deepFreeze(Object.fromEntries(
  Object.entries(DIRECTOR_EXTRACTION_REVIEW_STATUS_BY_PHASE)
    .map(([phase, status]) => [status, phase]),
) as Partial<Record<DirectorExtractionStatus, DirectorExtractionPhase>>)

export const DIRECTOR_EXTRACTION_WAITING_STATUSES: readonly DirectorExtractionStatus[] = deepFreeze([
  'awaiting_evidence_projection',
  'awaiting_intent_review',
  ...Object.values(DIRECTOR_EXTRACTION_REVIEW_STATUS_BY_PHASE),
])

export function isDirectorExtractionAcceptedStatus(status: DirectorExtractionStatus): boolean {
  return status === 'pending' || status === 'running'
}

export function isDirectorExtractionTerminalStatus(status: DirectorExtractionStatus): boolean {
  return status === 'completed' || status === 'conflict'
}

export const DIRECTOR_EXTRACTION_KINDS_BY_PHASE: Readonly<
  Record<DirectorExtractionPhase, readonly string[]>
> = deepFreeze({
  perception: [],
  understanding: ['person_profile', 'story_node'],
  // Story relations are intentionally generated only after their source and
  // target nodes have been reviewed.  This keeps Feishu's reference checks
  // from depending on candidates created in the same batch.
  judgment: ['story_relation', 'material_judgment', 'narrative_proposal'],
  case: ['director_case'],
  technique: ['technique'],
})

export const DIRECTOR_EXTRACTION_PHASE_INSTRUCTIONS: Readonly<
  Record<DirectorExtractionPhase, string>
> = deepFreeze({
  perception: [
    '只根据给定的受控视频摘要与时间码，提取可核验的素材观察候选。',
    '不得补写未出现的事实，不得输出原始转写、路径、链接、凭据或解释性前言。',
    '只输出符合输入中 outputContract 的 JSON 对象。',
  ].join(''),
  understanding: [
    '基于已核验素材观察，只生成候选人物档案和故事节点。',
    '人物推断必须保留证据时间码和不确定性；本阶段不生成故事关系。',
    '只输出符合输入中 outputContract 的 JSON 对象。',
  ].join(''),
  judgment: [
    '只基于已核验证据、已确认故事节点和唯一生效的导演意图，生成故事关系、七维素材判断和叙事方案。',
    '可以使用 learning_context 中适用的已审核技法作为方法先验，但不得把技法当成素材事实；使用时必须写入 appliedTechniqueStableIds。',
    '必须说明为什么值得使用并引用证据，不得触发剪辑、渲染或其他工具。',
    '只输出符合输入中 outputContract 的 JSON 对象。',
  ].join(''),
  case: [
    '基于已有判断生成导演案例候选，记录上下文、判断原因和待导演复核的问题。',
    '案例仍是候选，不能宣称已采用、已审核或已经形成技法。',
    '只输出符合输入中 outputContract 的 JSON 对象。',
  ].join(''),
  technique: [
    '只根据输入中真实回读且已审核的导演案例提炼技法候选。',
    '写明适用条件、方法、为什么有效和例外；不得使用未审核案例候选。',
    '只输出符合输入中 outputContract 的 JSON 对象。',
  ].join(''),
})

export const DIRECTOR_EXTRACTION_TABLE_BY_KIND = deepFreeze({
  material_observation: 'material_evidence',
  person_profile: 'people_profiles',
  story_node: 'story_nodes',
  story_relation: 'story_relations',
  material_judgment: 'material_judgments',
  narrative_proposal: 'narrative_plans',
  director_case: 'director_cases',
  technique: 'skills_techniques',
} as const)

export const DIRECTOR_EXTRACTION_SOURCE_TABLE_BY_KIND = deepFreeze({
  person_profile: 'people_profiles',
  story_node: 'story_nodes',
  story_relation: 'story_nodes',
  material_judgment: 'material_judgments',
  narrative_proposal: 'story_nodes',
  director_case: 'material_judgments',
  technique: 'director_cases',
} as const)

export const DIRECTOR_EXTRACTION_PREVIOUS_TABLE_BY_KIND = deepFreeze({
  person_profile: 'people_profiles',
  story_node: 'story_nodes',
  story_relation: 'story_relations',
  material_judgment: 'material_judgments',
  narrative_proposal: 'narrative_plans',
  director_case: 'director_cases',
  technique: 'skills_techniques',
} as const)

export const DIRECTOR_EXTRACTION_PROJECTION_FIELDS_BY_KIND = deepFreeze({
  person_profile: [
    '人物名称', '人物 ID', '别名', '身份', '目标', '欲望', '恐惧', '性格', '关系 ID', '矛盾',
    '情绪变化', '人物弧光', '观察日期', '置信度',
  ],
  story_node: [
    '节点名称', '节点类型', '人物 ID', '发生时间', '节点内容', '变化', '置信度',
  ],
  story_relation: ['关系名称', '关系类型', '判断理由', '置信度'],
  material_judgment: [
    '判断名称', '故事价值', '人物价值', '情绪价值', '信息价值', '视觉价值', '稀缺性', '叙事价值',
    '使用理由', '建议位置', '不同位置效果', '置信度',
  ],
  narrative_proposal: [
    '方案名称', '人物线', '事件线', '时间线', '地点线', '情绪线', '主题线', '冲突线', '结构说明', '故事脚本',
  ],
  director_case: ['案例名称', '上下文', '导演动作', '判断原因'],
  technique: [
    '知识名称', '知识类型', '知识分类', '适用条件', '执行方法', '为什么有效', '例外情况', '验证次数', '置信度',
  ],
} as const)

/**
 * Model-facing title, summary, and rationale are durable semantics, not
 * disposable display metadata. Every value has an explicit governed-field
 * destination before a candidate can be projected to Feishu.
 */
export const DIRECTOR_EXTRACTION_SEMANTIC_FIELDS_BY_KIND = deepFreeze({
  person_profile: {
    title: '人物名称', summary: '人物弧光', rationale: '矛盾',
  },
  story_node: {
    title: '节点名称', summary: '节点内容', rationale: '变化',
  },
  story_relation: {
    title: '关系名称', summary: '判断理由', rationale: '判断理由',
  },
  material_judgment: {
    title: '判断名称', summary: '使用理由', rationale: '使用理由',
  },
  narrative_proposal: {
    title: '方案名称', summary: '结构说明', rationale: '结构说明',
  },
  director_case: {
    title: '案例名称', summary: '上下文', rationale: '判断原因',
  },
  technique: {
    title: '知识名称', summary: '执行方法', rationale: '为什么有效',
  },
} as const)

export const DIRECTOR_EXTRACTION_OUTPUT_FIELDS_BY_KIND = deepFreeze({
  person_profile: {
    '人物名称': '人物名称',
    '人物 ID': 'PERSON-stable-name',
    '别名': '可选',
    '身份': '可选',
    '目标': '可选',
    '欲望': '可选',
    '恐惧': '可选',
    '性格': '可选',
    '关系 ID': '可选',
    '矛盾': '可选',
    '情绪变化': '可选',
    '人物弧光': '可选',
    '观察日期': '可选；ISO 8601 或 Unix 毫秒',
    '置信度': 0.8,
  },
  story_node: {
    '节点名称': '节点名称',
    '节点类型': '事件|冲突|转折|悬念|人物变化|未解决问题',
    '人物 ID': '可选',
    '发生时间': '可选',
    '节点内容': '可核验内容',
    '变化': '可选',
    '置信度': 0.8,
  },
  story_relation: {
    '关系名称': '关系名称',
    '关系类型': '因果|时间|对照|升级|呼应|解决',
    '判断理由': '不把相关性写成确定因果',
    '置信度': 0.8,
  },
  material_judgment: {
    '判断名称': '判断名称',
    '故事价值': 0,
    '人物价值': 0,
    '情绪价值': 0,
    '信息价值': 0,
    '视觉价值': 0,
    '稀缺性': 0,
    '叙事价值': 0,
    '使用理由': '为什么值得使用',
    '建议位置': '可选',
    '不同位置效果': '可选',
    '置信度': 0.8,
  },
  narrative_proposal: {
    '方案名称': '方案名称',
    '人物线': '内容',
    '事件线': '内容',
    '时间线': '内容',
    '地点线': '内容',
    '情绪线': '内容',
    '主题线': '内容',
    '冲突线': '内容',
    '结构说明': '叙事结构',
    '故事脚本': '不含剪辑指令的故事脚本',
  },
  director_case: {
    '案例名称': '案例名称',
    '上下文': '当时语境',
    '导演动作': '采用|修改|拒绝|调序|待定',
    '判断原因': '为什么这样判断',
  },
  technique: {
    '知识名称': '技法名称',
    '知识类型': '技能|技法',
    '知识分类': '分类',
    '适用条件': '何时适用',
    '执行方法': '可执行方法',
    '为什么有效': '原理',
    '例外情况': '可选',
    '验证次数': 0,
    '置信度': 0.8,
  },
} as const)

export function buildDirectorExtractionOutputContract(phase: DirectorExtractionPhase) {
  const sourceCandidateKeys: Partial<Record<string, readonly string[]>> = {
    narrative_proposal: ['一个或多个已确认 story_node candidateKey'],
    director_case: ['一个已确认 material_judgment candidateKey'],
    technique: ['一个或多个已确认 director_case candidateKey'],
  }
  const sourceStableIds: Partial<Record<string, readonly string[]>> = {
    person_profile: ['可选：最多一个已审核 people_profiles stable ID'],
    story_node: ['可选：最多一个已审核 story_nodes stable ID'],
    material_judgment: ['可选：最多一个已审核 material_judgments stable ID'],
    narrative_proposal: ['可与 candidateKey 混合，二者合计至少一个已审核 story_nodes stable ID 来源'],
    director_case: ['可与 candidateKey 二选一，合计恰好一个已审核 material_judgments stable ID 来源'],
    technique: ['可与 candidateKey 混合，二者合计至少一个已审核 director_cases stable ID 来源'],
  }
  return deepFreeze({
    schemaVersion: 1 as const,
    phase,
    candidates: phase === 'perception'
      ? []
      : DIRECTOR_EXTRACTION_KINDS_BY_PHASE[phase].map(kind => ({
          candidateKey: `unique-${kind}-key`,
          kind,
          title: '1-160 字',
          summary: '1-4000 字',
          rationale: '只写可核验判断理由',
          confidence: '0..1',
          evidenceRefs: [{
            materialId: '仅使用输入 materialId',
            startSeconds: 0,
            endSeconds: 1,
          }],
          sourceCandidateKeys: sourceCandidateKeys[kind] || [],
          sourceStableIds: sourceStableIds[kind] || [],
          ...(kind === 'story_relation' ? {
            sourceNode: {
              type: 'candidate|reviewed',
              candidateKey: 'type=candidate 时填写已确认源节点 candidateKey',
              stableId: 'type=reviewed 时填写已审核源节点 stable ID',
            },
            targetNode: {
              type: 'candidate|reviewed',
              candidateKey: 'type=candidate 时填写已确认目标节点 candidateKey',
              stableId: 'type=reviewed 时填写已审核目标节点 stable ID',
            },
          } : {}),
          appliedTechniqueStableIds: ['material_judgment', 'narrative_proposal'].includes(kind)
            ? ['可选；仅引用 learning_context.project.skills_techniques 中实际采用的已审核技法 stable ID']
            : [],
          previousVersionStableId: `可选；仅引用 learning_context 中已审核的${DIRECTOR_EXTRACTION_PREVIOUS_TABLE_BY_KIND[
            kind as keyof typeof DIRECTOR_EXTRACTION_PREVIOUS_TABLE_BY_KIND
          ]}历史版本`,
          sourceLineageRule: kind === 'story_relation'
            ? '故事关系必须用 sourceNode 和 targetNode 明确方向；每端分别使用 candidateKey 或 stableId，禁止依赖数组顺序。'
            : 'sourceCandidateKeys 引用当前提炼链候选；sourceStableIds 引用 learning_context 中真实回读且已审核的历史记录。两者按本候选类型合并计数。',
          semanticFieldRule: DIRECTOR_EXTRACTION_SEMANTIC_FIELDS_BY_KIND[
            kind as keyof typeof DIRECTOR_EXTRACTION_SEMANTIC_FIELDS_BY_KIND
          ],
          fields: DIRECTOR_EXTRACTION_OUTPUT_FIELDS_BY_KIND[
            kind as keyof typeof DIRECTOR_EXTRACTION_OUTPUT_FIELDS_BY_KIND
          ],
        })),
  })
}

export interface DirectorExtractionModelIdentity {
  routeId: string
  model: string
  modelVersion: string
}

export const DIRECTOR_EXTRACTION_DEFAULT_MODEL_IDENTITY = deepFreeze({
  routeId: 'local-qwen36-direct',
  model: 'default_model',
  modelVersion: 'qwen-3.6',
}) satisfies Readonly<DirectorExtractionModelIdentity>

const stableIdSchema = z.string().trim().min(1).max(160)
  .regex(/^[A-Za-z0-9._:-]+$/u)
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u)
const safeTextSchema = (maximum: number) => z.string()
  .transform(value => value.normalize('NFKC').replace(/\r\n?/gu, '\n').trim())
  .pipe(z.string().min(1).max(maximum))
  .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value))
const candidateKeySchema = z.string().trim().min(1).max(120)
  .regex(/^[A-Za-z0-9._:-]+$/u)

const referenceListSchema = (maximum: number) => z.array(stableIdSchema).min(1).max(maximum)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'director_extraction_reference_duplicate' })
    }
  })
  .transform(values => [...values].sort())

export const reviewedDirectorReferencesSchema = z.object({
  material_evidence: referenceListSchema(256).optional(),
  director_intents: referenceListSchema(1).optional(),
  people_profiles: referenceListSchema(64).optional(),
  story_nodes: referenceListSchema(64).optional(),
  story_relations: referenceListSchema(64).optional(),
  material_judgments: referenceListSchema(64).optional(),
  narrative_plans: referenceListSchema(64).optional(),
  director_cases: referenceListSchema(64).optional(),
  skills_techniques: referenceListSchema(64).optional(),
}).strict().refine(value => Object.keys(value).length > 0)

export type ReviewedDirectorReferences = z.infer<typeof reviewedDirectorReferencesSchema>

const evidenceReferenceSchema = z.object({
  materialId: stableIdSchema,
  startSeconds: z.number().finite().min(0).max(7 * 24 * 60 * 60),
  endSeconds: z.number().finite().positive().max(7 * 24 * 60 * 60),
}).strict().refine(value => value.endSeconds > value.startSeconds, {
  message: 'director_extraction_evidence_range_invalid',
})

const uniqueCandidateKeysSchema = z.array(candidateKeySchema).max(20)
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'director_extraction_lineage_key_duplicate' })
    }
  })

const uniqueSourceStableIdsSchema = z.array(stableIdSchema)
  .max(20, { message: 'director_extraction_lineage_id_too_many' })
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'director_extraction_lineage_id_duplicate' })
    }
  })
  .transform(values => [...values].sort())

const uniqueAppliedTechniqueIdsSchema = z.array(stableIdSchema)
  .max(20, { message: 'director_extraction_technique_reference_too_many' })
  .superRefine((values, context) => {
    if (new Set(values).size !== values.length) {
      context.addIssue({ code: 'custom', message: 'director_extraction_technique_reference_duplicate' })
    }
  })
  .transform(values => [...values].sort())

const uniqueEvidenceReferencesSchema = z.array(evidenceReferenceSchema).min(1).max(32)
  .superRefine((values, context) => {
    const identities = values.map(value => (
      `${value.materialId}:${value.startSeconds}:${value.endSeconds}`
    ))
    if (new Set(identities).size !== identities.length) {
      context.addIssue({ code: 'custom', message: 'director_extraction_evidence_duplicate' })
    }
  })

const storyNodeReferenceSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('candidate'),
    candidateKey: candidateKeySchema,
  }).strict(),
  z.object({
    type: z.literal('reviewed'),
    stableId: stableIdSchema,
  }).strict(),
])

export type DirectorStoryNodeReference = z.infer<typeof storyNodeReferenceSchema>

const candidateSchema = z.object({
  candidateKey: candidateKeySchema,
  kind: z.string().trim().min(1).max(60),
  title: safeTextSchema(160),
  summary: safeTextSchema(4_000),
  rationale: safeTextSchema(4_000),
  confidence: z.number().finite().min(0).max(1),
  evidenceRefs: uniqueEvidenceReferencesSchema,
  sourceCandidateKeys: uniqueCandidateKeysSchema.default([]),
  sourceStableIds: uniqueSourceStableIdsSchema.default([]),
  sourceNode: storyNodeReferenceSchema.optional(),
  targetNode: storyNodeReferenceSchema.optional(),
  appliedTechniqueStableIds: uniqueAppliedTechniqueIdsSchema.default([]),
  previousVersionStableId: stableIdSchema.optional(),
  fields: z.record(z.string(), z.unknown()).default({}),
}).strict()

type ParsedDirectorExtractionCandidate = z.infer<typeof candidateSchema>
export type DirectorExtractionCandidate = Omit<
  ParsedDirectorExtractionCandidate,
  'sourceStableIds' | 'appliedTechniqueStableIds'
> & {
  // Optional in caller-authored fixtures and model values; parsing always
  // materializes the field as a sorted array for downstream code.
  sourceStableIds?: string[]
  appliedTechniqueStableIds?: string[]
}

const forbiddenKey = /(?:secret|token|password|api.?key|credential|authorization|cookie|(?:full|raw)[_-]?transcript|path|url|uri|密码|密钥|私钥|访问令牌|(?:完整|原始)(?:语音|音频)?转写|路径|链接)/iu
const forbiddenValues = [
  /(?:full|raw)\s+transcript|(?:完整|原始)(?:语音|音频)?转写/iu,
  /(?:^|[\s"'(])(?:\/(?!\/)[^\s"')]+|[A-Za-z]:\\[^\s"')]+)/u,
  /\b(?:file:\/\/|data:[^\s;,]+[;,])/iu,
  /https?:\/\/[^\s<>'"\])}]+/iu,
  /(?:^|[^A-Za-z0-9+/])[A-Za-z0-9+/]{160,}={0,2}(?:$|[^A-Za-z0-9+/=])/u,
  /(?<![A-Za-z0-9_])(?:cli_[A-Za-z0-9]{10,64}|bascn[A-Za-z0-9]{10,64}|(?:tbl|rec|fld)(?=[A-Za-z0-9]{10,32}(?![A-Za-z0-9_]))(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{10,32})/u,
]

function assertSafeCandidateValue(value: unknown, depth = 0): void {
  if (depth > 8) throw new Error('director_extraction_candidate_too_deep')
  if (typeof value === 'string') {
    if (value.length > 8_000
      || containsSensitiveValue(value)
      || forbiddenValues.some(pattern => pattern.test(value))) {
      throw new Error('director_extraction_candidate_sensitive')
    }
    return
  }
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('director_extraction_candidate_invalid')
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 128) throw new Error('director_extraction_candidate_too_large')
    value.forEach(item => assertSafeCandidateValue(item, depth + 1))
    return
  }
  if (!value || typeof value !== 'object') {
    throw new Error('director_extraction_candidate_invalid')
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > 128) throw new Error('director_extraction_candidate_too_large')
  for (const [key, child] of entries) {
    if (!key || key.length > 120 || forbiddenKey.test(key)) {
      throw new Error('director_extraction_candidate_sensitive')
    }
    assertSafeCandidateValue(child, depth + 1)
  }
}

const directorLearningRecordSchema = z.object({
  table: z.enum([
    'director_intents', 'people_profiles', 'story_nodes', 'story_relations',
    'material_judgments', 'narrative_plans', 'director_cases', 'skills_techniques',
  ]),
  stableId: stableIdSchema,
  state: safeTextSchema(160).nullable(),
  reviewed: z.literal(true),
  fields: z.record(z.string().min(1).max(120), z.unknown()),
}).strict()

const directorLearningRecordListSchema = z.array(directorLearningRecordSchema).max(512)

const directorLearningWorkSchema = z.object({
  activeIntent: directorLearningRecordSchema.nullable(),
  people_profiles: directorLearningRecordListSchema,
  story_nodes: directorLearningRecordListSchema,
  story_relations: directorLearningRecordListSchema,
  material_judgments: directorLearningRecordListSchema,
  narrative_plans: directorLearningRecordListSchema,
  director_cases: directorLearningRecordListSchema,
}).strict()

const directorLearningProjectSchema = z.object({
  director_cases: directorLearningRecordListSchema,
  skills_techniques: directorLearningRecordListSchema,
}).strict()

const countSchema = z.number().int().nonnegative()
const directorLearningCountsSchema = z.object({
  work: z.object({
    activeIntent: countSchema,
    people_profiles: countSchema,
    story_nodes: countSchema,
    story_relations: countSchema,
    material_judgments: countSchema,
    narrative_plans: countSchema,
    director_cases: countSchema,
  }).strict(),
  project: z.object({
    director_cases: countSchema,
    skills_techniques: countSchema,
  }).strict(),
  total: countSchema,
}).strict()

export const directorLearningContextResultSchema = z.object({
  ok: z.literal(true),
  action: z.literal('learning_context'),
  workId: stableIdSchema,
  snapshot: z.object({
    schemaVersion: z.literal(1),
    projectId: z.literal(DIRECTOR_EXTRACTION_PROJECT_ID),
    workId: stableIdSchema,
    counts: directorLearningCountsSchema,
    work: directorLearningWorkSchema,
    project: directorLearningProjectSchema,
  }).strict(),
  digest: sha256Schema,
}).strict().superRefine((value, context) => {
  if (value.workId !== value.snapshot.workId) {
    context.addIssue({ code: 'custom', message: 'director_learning_context_work_mismatch' })
  }
  const expectedTables: Record<string, string> = {
    activeIntent: 'director_intents',
    people_profiles: 'people_profiles',
    story_nodes: 'story_nodes',
    story_relations: 'story_relations',
    material_judgments: 'material_judgments',
    narrative_plans: 'narrative_plans',
    director_cases: 'director_cases',
    skills_techniques: 'skills_techniques',
  }
  const lists: Array<[string, z.infer<typeof directorLearningRecordSchema>[]]> = [
    ...Object.entries(value.snapshot.work)
      .filter((entry): entry is [string, z.infer<typeof directorLearningRecordSchema>[]] => Array.isArray(entry[1])),
    ...Object.entries(value.snapshot.project),
  ]
  if (value.snapshot.work.activeIntent
    && value.snapshot.work.activeIntent.table !== 'director_intents') {
    context.addIssue({ code: 'custom', message: 'director_learning_context_table_mismatch' })
  }
  for (const [bucket, records] of lists) {
    const identities = new Set<string>()
    for (const record of records) {
      if (record.table !== expectedTables[bucket]) {
        context.addIssue({ code: 'custom', message: 'director_learning_context_table_mismatch' })
      }
      if (identities.has(record.stableId)) {
        context.addIssue({ code: 'custom', message: 'director_learning_context_duplicate' })
      }
      identities.add(record.stableId)
    }
  }
  const expectedWorkCounts = {
    activeIntent: value.snapshot.work.activeIntent ? 1 : 0,
    people_profiles: value.snapshot.work.people_profiles.length,
    story_nodes: value.snapshot.work.story_nodes.length,
    story_relations: value.snapshot.work.story_relations.length,
    material_judgments: value.snapshot.work.material_judgments.length,
    narrative_plans: value.snapshot.work.narrative_plans.length,
    director_cases: value.snapshot.work.director_cases.length,
  }
  const expectedProjectCounts = {
    director_cases: value.snapshot.project.director_cases.length,
    skills_techniques: value.snapshot.project.skills_techniques.length,
  }
  if (directorExtractionDigest(value.snapshot.counts.work) !== directorExtractionDigest(expectedWorkCounts)
    || directorExtractionDigest(value.snapshot.counts.project) !== directorExtractionDigest(expectedProjectCounts)
    || value.snapshot.counts.total !== Object.values(expectedWorkCounts).reduce((sum, count) => sum + count, 0)
      + Object.values(expectedProjectCounts).reduce((sum, count) => sum + count, 0)) {
    context.addIssue({ code: 'custom', message: 'director_learning_context_count_mismatch' })
  }
})

export type DirectorLearningContextResult = z.infer<typeof directorLearningContextResultSchema>

export function parseDirectorLearningContextResult(
  workId: string,
  value: unknown,
): Readonly<DirectorLearningContextResult> {
  const parsed = directorLearningContextResultSchema.parse(value)
  if (parsed.workId !== workId || parsed.snapshot.workId !== workId) {
    throw new Error('director_learning_context_work_mismatch')
  }
  if (parsed.digest !== directorExtractionDigest(parsed.snapshot)) {
    throw new Error('director_learning_context_digest_mismatch')
  }
  assertSafeCandidateValue(parsed.snapshot)
  return deepFreeze(parsed)
}

const optionalDomainText = (maximum = 4_000) => safeTextSchema(maximum).optional()
const scoreSchema = z.number().finite().min(0).max(100)
const directorDateSchema = z.union([
  z.number().int().nonnegative().safe(),
  safeTextSchema(64).refine(value => Number.isFinite(Date.parse(value)), {
    message: 'director_extraction_date_invalid',
  }),
])

const candidateFieldSchemas: Record<string, z.ZodType<Record<string, unknown>>> = {
  person_profile: z.object({
    '人物名称': safeTextSchema(160),
    '人物 ID': stableIdSchema,
    '别名': optionalDomainText(1_000),
    '身份': optionalDomainText(),
    '目标': optionalDomainText(),
    '欲望': optionalDomainText(),
    '恐惧': optionalDomainText(),
    '性格': optionalDomainText(),
    '关系 ID': optionalDomainText(1_000),
    '矛盾': optionalDomainText(),
    '情绪变化': optionalDomainText(),
    '人物弧光': optionalDomainText(),
    '观察日期': directorDateSchema.optional(),
    '置信度': z.number().finite().min(0).max(1),
  }).strict(),
  story_node: z.object({
    '节点名称': safeTextSchema(160),
    '节点类型': z.enum(['事件', '冲突', '转折', '悬念', '人物变化', '未解决问题']),
    '人物 ID': optionalDomainText(1_000),
    '发生时间': optionalDomainText(160),
    '节点内容': safeTextSchema(4_000),
    '变化': optionalDomainText(),
    '置信度': z.number().finite().min(0).max(1),
  }).strict(),
  story_relation: z.object({
    '关系名称': safeTextSchema(160),
    '关系类型': z.enum(['因果', '时间', '对照', '升级', '呼应', '解决']),
    '判断理由': safeTextSchema(4_000),
    '置信度': z.number().finite().min(0).max(1),
  }).strict(),
  material_judgment: z.object({
    '判断名称': safeTextSchema(160),
    '故事价值': scoreSchema,
    '人物价值': scoreSchema,
    '情绪价值': scoreSchema,
    '信息价值': scoreSchema,
    '视觉价值': scoreSchema,
    '稀缺性': scoreSchema,
    '叙事价值': scoreSchema,
    '使用理由': safeTextSchema(4_000),
    '建议位置': optionalDomainText(1_000),
    '不同位置效果': optionalDomainText(4_000),
    '置信度': z.number().finite().min(0).max(1),
  }).strict(),
  narrative_proposal: z.object({
    '方案名称': safeTextSchema(160),
    '人物线': safeTextSchema(4_000),
    '事件线': safeTextSchema(4_000),
    '时间线': safeTextSchema(4_000),
    '地点线': safeTextSchema(4_000),
    '情绪线': safeTextSchema(4_000),
    '主题线': safeTextSchema(4_000),
    '冲突线': safeTextSchema(4_000),
    '结构说明': safeTextSchema(8_000),
    '故事脚本': safeTextSchema(8_000),
  }).strict(),
  director_case: z.object({
    '案例名称': safeTextSchema(160),
    '上下文': safeTextSchema(4_000),
    '导演动作': z.enum(['采用', '修改', '拒绝', '调序', '待定']),
    '判断原因': safeTextSchema(4_000),
  }).strict(),
  technique: z.object({
    '知识名称': safeTextSchema(160),
    '知识类型': z.enum(['技能', '技法']),
    '知识分类': safeTextSchema(500),
    '适用条件': safeTextSchema(4_000),
    '执行方法': safeTextSchema(8_000),
    '为什么有效': safeTextSchema(4_000),
    '例外情况': optionalDomainText(4_000),
    '验证次数': z.number().int().nonnegative().optional(),
    '置信度': z.number().finite().min(0).max(1),
  }).strict(),
}

function assertCandidateLineage(candidate: DirectorExtractionCandidate): void {
  const candidateKeyCount = candidate.sourceCandidateKeys.length
  const stableIdCount = candidate.sourceStableIds?.length || 0
  const count = candidateKeyCount + stableIdCount
  if (count > 20) throw new Error('director_extraction_candidate_sources_too_many')
  const appliedTechniqueCount = candidate.appliedTechniqueStableIds?.length || 0
  if (!['material_judgment', 'narrative_proposal'].includes(candidate.kind)
    && appliedTechniqueCount > 0) {
    throw new Error('director_extraction_technique_reference_forbidden')
  }
  if (['person_profile', 'story_node', 'material_judgment'].includes(candidate.kind)
    && (candidateKeyCount > 0 || stableIdCount > 1)) {
    throw new Error('director_extraction_candidate_sources_invalid')
  }
  if (candidate.kind === 'story_relation') {
    if (count !== 0 || !candidate.sourceNode || !candidate.targetNode
      || directorExtractionDigest(candidate.sourceNode)
        === directorExtractionDigest(candidate.targetNode)) {
      throw new Error('director_extraction_relation_sources_invalid')
    }
  } else if (candidate.sourceNode || candidate.targetNode) {
    throw new Error('director_extraction_relation_sources_forbidden')
  }
  if (candidate.kind === 'narrative_proposal' && count < 1) {
    throw new Error('director_extraction_narrative_sources_invalid')
  }
  if (candidate.kind === 'director_case' && count !== 1) {
    throw new Error('director_extraction_case_sources_invalid')
  }
  if (candidate.kind === 'technique' && count < 1) {
    throw new Error('director_extraction_technique_sources_invalid')
  }
}

export interface DirectorExtractionCandidateOutput {
  schemaVersion: 1
  phase: DirectorExtractionPhase
  candidates: DirectorExtractionCandidate[]
}

export const directorExtractionProjectionEntrySchema = z.object({
  candidateKey: candidateKeySchema,
  kind: z.string().trim().min(1).max(60),
  table: z.enum([
    'material_evidence', 'people_profiles', 'story_nodes', 'story_relations',
    'material_judgments', 'narrative_plans', 'director_cases', 'skills_techniques',
  ]),
  stableId: stableIdSchema,
  startSeconds: z.number().finite().min(0).optional(),
  endSeconds: z.number().finite().positive().optional(),
}).strict().refine(value => (
  (value.startSeconds === undefined && value.endSeconds === undefined)
  || (value.startSeconds !== undefined && value.endSeconds !== undefined
    && value.endSeconds > value.startSeconds)
), { message: 'director_extraction_projection_range_invalid' })

function compareProjectionEntries(
  left: z.infer<typeof directorExtractionProjectionEntrySchema>,
  right: z.infer<typeof directorExtractionProjectionEntrySchema>,
): number {
  for (const [leftValue, rightValue] of [
    [left.candidateKey, right.candidateKey],
    [left.table, right.table],
    [left.stableId, right.stableId],
  ]) {
    if (leftValue < rightValue) return -1
    if (leftValue > rightValue) return 1
  }
  return 0
}

export const directorExtractionProjectionReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  phase: z.enum(directorExtractionPhases),
  entries: z.array(directorExtractionProjectionEntrySchema).min(1).max(256),
}).strict().superRefine((value, context) => {
  const keys = new Set<string>()
  const ids = new Set<string>()
  const allowedKinds = value.phase === 'perception'
    ? new Set(['material_observation'])
    : new Set(DIRECTOR_EXTRACTION_KINDS_BY_PHASE[value.phase])
  for (const entry of value.entries) {
    if (keys.has(entry.candidateKey)) {
      context.addIssue({ code: 'custom', message: 'director_extraction_projection_key_duplicate' })
    }
    keys.add(entry.candidateKey)
    const identity = `${entry.table}:${entry.stableId}`
    if (ids.has(identity)) {
      context.addIssue({ code: 'custom', message: 'director_extraction_projection_id_duplicate' })
    }
    ids.add(identity)
    if (!allowedKinds.has(entry.kind)) {
      context.addIssue({ code: 'custom', message: 'director_extraction_projection_kind_invalid' })
    }
    const expectedTable = DIRECTOR_EXTRACTION_TABLE_BY_KIND[
      entry.kind as keyof typeof DIRECTOR_EXTRACTION_TABLE_BY_KIND
    ]
    if (!expectedTable || entry.table !== expectedTable) {
      context.addIssue({ code: 'custom', message: 'director_extraction_projection_table_invalid' })
    }
    if (entry.kind === 'material_observation'
      && (entry.startSeconds === undefined || entry.endSeconds === undefined)) {
      context.addIssue({ code: 'custom', message: 'director_extraction_projection_range_required' })
    }
    if (entry.kind !== 'material_observation'
      && (entry.startSeconds !== undefined || entry.endSeconds !== undefined)) {
      context.addIssue({ code: 'custom', message: 'director_extraction_projection_range_forbidden' })
    }
  }
}).transform(value => deepFreeze({
  ...value,
  entries: [...value.entries].sort(compareProjectionEntries),
}))

export type DirectorExtractionProjectionReceipt = z.infer<
  typeof directorExtractionProjectionReceiptSchema
>
export type DirectorExtractionProjectionEntry = z.infer<
  typeof directorExtractionProjectionEntrySchema
>

export function canonicalDirectorExtractionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDirectorExtractionJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalDirectorExtractionJson(object[key])}`
    )).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? 'null' : encoded
}

export function directorExtractionDigest(value: unknown): string {
  return createHash('sha256')
    .update(canonicalDirectorExtractionJson(value), 'utf8')
    .digest('hex')
}

const directorExtractionModelIdentitySchema = z.object({
  routeId: stableIdSchema,
  model: z.string().trim().min(1).max(180),
  modelVersion: z.string().trim().min(1).max(120),
}).strict()

export function directorExtractionContractManifest(
  modelIdentity: DirectorExtractionModelIdentity = DIRECTOR_EXTRACTION_DEFAULT_MODEL_IDENTITY,
): Readonly<Record<string, unknown>> {
  const model = directorExtractionModelIdentitySchema.parse(modelIdentity)
  return deepFreeze({
    contract: DIRECTOR_EXTRACTION_CONTRACT,
    projectId: DIRECTOR_EXTRACTION_PROJECT_ID,
    phases: directorExtractionPhases,
    promptVersion: DIRECTOR_EXTRACTION_PROMPT_VERSION,
    phaseInstructions: DIRECTOR_EXTRACTION_PHASE_INSTRUCTIONS,
    projectionVersion: DIRECTOR_EXTRACTION_PROJECTION_VERSION,
    projectionBoundary: DIRECTOR_EXTRACTION_PROJECTION_BOUNDARY,
    candidateSchemaVersion: DIRECTOR_EXTRACTION_CANDIDATE_SCHEMA_VERSION,
    kindsByPhase: DIRECTOR_EXTRACTION_KINDS_BY_PHASE,
    outputContractsByPhase: Object.fromEntries(directorExtractionPhases.map(phase => (
      [phase, buildDirectorExtractionOutputContract(phase)]
    ))),
    tableByKind: DIRECTOR_EXTRACTION_TABLE_BY_KIND,
    sourceTableByKind: DIRECTOR_EXTRACTION_SOURCE_TABLE_BY_KIND,
    previousTableByKind: DIRECTOR_EXTRACTION_PREVIOUS_TABLE_BY_KIND,
    projectionFieldsByKind: DIRECTOR_EXTRACTION_PROJECTION_FIELDS_BY_KIND,
    semanticFieldsByKind: DIRECTOR_EXTRACTION_SEMANTIC_FIELDS_BY_KIND,
    model,
    directorIntentRequiredBeforeJudgment: true,
    checkpointBeforeExternalWrite: true,
    reviewGateAfterEveryPhase: true,
    maxOutputBytes: DIRECTOR_EXTRACTION_MAX_OUTPUT_BYTES,
  })
}

export function directorExtractionContractDigest(
  modelIdentity?: DirectorExtractionModelIdentity,
): string {
  return directorExtractionDigest(directorExtractionContractManifest(modelIdentity))
}

export function parseDirectorExtractionOutput(
  phase: DirectorExtractionPhase,
  value: unknown,
): DirectorExtractionCandidateOutput {
  const baseSchema = z.object({
    schemaVersion: z.literal(1),
    phase: z.literal(phase),
    candidates: phase === 'perception'
      ? z.array(candidateSchema).length(0)
      : z.array(candidateSchema).min(1).max(64),
  }).strict()
  const parsed = baseSchema.parse(value) as DirectorExtractionCandidateOutput
  const allowedKinds = new Set(DIRECTOR_EXTRACTION_KINDS_BY_PHASE[phase])
  const candidateKeys = new Set<string>()
  for (const candidate of parsed.candidates) {
    if (!allowedKinds.has(candidate.kind)) {
      throw new Error('director_extraction_candidate_kind_invalid')
    }
    if (candidateKeys.has(candidate.candidateKey)) {
      throw new Error('director_extraction_candidate_key_duplicate')
    }
    candidateKeys.add(candidate.candidateKey)
    assertSafeCandidateValue(candidate.title)
    assertSafeCandidateValue(candidate.summary)
    assertSafeCandidateValue(candidate.rationale)
    assertSafeCandidateValue(candidate.fields)
    const fields = candidateFieldSchemas[candidate.kind]
    if (!fields) throw new Error('director_extraction_candidate_kind_invalid')
    candidate.fields = fields.parse(candidate.fields)
    assertSafeCandidateValue(candidate.fields)
    const semanticFields = DIRECTOR_EXTRACTION_SEMANTIC_FIELDS_BY_KIND[
      candidate.kind as keyof typeof DIRECTOR_EXTRACTION_SEMANTIC_FIELDS_BY_KIND
    ]
    if (!semanticFields) throw new Error('director_extraction_candidate_kind_invalid')
    for (const semantic of ['title', 'summary', 'rationale'] as const) {
      const fieldValue = String(candidate.fields[semanticFields[semantic]] || '').trim()
      const expected = candidate[semantic].trim()
      const present = semantic === 'title'
        ? fieldValue === expected
        : fieldValue.includes(expected)
      if (!present) {
        throw new Error(
          `director_extraction_candidate_semantics_missing:${candidate.kind}:${semantic}`,
        )
      }
    }
    const fieldConfidence = candidate.fields['置信度']
    if (typeof fieldConfidence === 'number' && fieldConfidence !== candidate.confidence) {
      throw new Error('director_extraction_confidence_mismatch')
    }
    assertCandidateLineage(candidate)
  }
  const serialized = JSON.stringify(parsed)
  if (Buffer.byteLength(serialized, 'utf8') > DIRECTOR_EXTRACTION_MAX_OUTPUT_BYTES) {
    throw new Error('director_extraction_output_too_large')
  }
  return parsed
}

export function nextDirectorExtractionPhase(
  phase: DirectorExtractionPhase,
): DirectorExtractionCurrentPhase {
  const index = directorExtractionPhases.indexOf(phase)
  return directorExtractionPhases[index + 1] || 'complete'
}

export function directorExtractionProgress(phase: DirectorExtractionCurrentPhase): number {
  if (phase === 'complete') return 100
  return directorExtractionPhases.indexOf(phase) * 20
}

export const directorExtractionIdentitySchema = z.object({
  sourceTaskId: stableIdSchema,
  sourceBindingId: z.number().int().positive(),
  tenantId: z.number().int().positive(),
  workspaceId: z.number().int().positive(),
  workId: stableIdSchema.nullable(),
  workQueryDigest: sha256Schema.nullable(),
  materialId: stableIdSchema,
  sourceResultSha256: sha256Schema,
  extractionContractDigest: sha256Schema,
}).strict().superRefine((value, context) => {
  if ((value.workId === null) !== (value.workQueryDigest === null)) {
    context.addIssue({ code: 'custom', message: 'director_extraction_work_identity_incomplete' })
  }
})

export type DirectorExtractionIdentity = z.infer<typeof directorExtractionIdentitySchema>

export interface DirectorPerceptionCheckpointInput {
  schemaVersion: 2
  contract: typeof DIRECTOR_EXTRACTION_CONTRACT
  extractionContractDigest: string
  promptVersion: typeof DIRECTOR_EXTRACTION_PROMPT_VERSION
  projectionVersion: typeof DIRECTOR_EXTRACTION_PROJECTION_VERSION
  phase: 'perception'
  projectId: typeof DIRECTOR_EXTRACTION_PROJECT_ID
  workId: string
  workQueryDigest: string
  sourceTaskId: string
  sourceBindingId: number
  tenantId: number
  workspaceId: number
  materialId: string
  sourceResultSha256: string
}

/**
 * Builds the non-sensitive immutable identity checkpoint that must exist before
 * perception evidence is written to Feishu. It deliberately contains no media
 * path, transcript, model output, remote record ID, credential, or runtime log.
 */
export function buildDirectorPerceptionCheckpointInput(
  identityValue: DirectorExtractionIdentity,
  modelIdentity: DirectorExtractionModelIdentity = DIRECTOR_EXTRACTION_DEFAULT_MODEL_IDENTITY,
): Readonly<DirectorPerceptionCheckpointInput> {
  // Callers may hold a richer job object. Pick only the immutable identity
  // before applying the strict schema so runtime state can never enter the
  // checkpoint while legitimate structural subtypes remain accepted.
  const identity = directorExtractionIdentitySchema.parse({
    sourceTaskId: identityValue.sourceTaskId,
    sourceBindingId: identityValue.sourceBindingId,
    tenantId: identityValue.tenantId,
    workspaceId: identityValue.workspaceId,
    workId: identityValue.workId,
    workQueryDigest: identityValue.workQueryDigest,
    materialId: identityValue.materialId,
    sourceResultSha256: identityValue.sourceResultSha256,
    extractionContractDigest: identityValue.extractionContractDigest,
  })
  if (!identity.workId || !identity.workQueryDigest) {
    throw new Error('director_extraction_work_not_registered')
  }
  const expectedDigest = directorExtractionContractDigest(modelIdentity)
  if (identity.extractionContractDigest !== expectedDigest) {
    throw new Error('director_extraction_contract_mismatch')
  }
  return deepFreeze({
    schemaVersion: 2,
    contract: DIRECTOR_EXTRACTION_CONTRACT,
    extractionContractDigest: identity.extractionContractDigest,
    promptVersion: DIRECTOR_EXTRACTION_PROMPT_VERSION,
    projectionVersion: DIRECTOR_EXTRACTION_PROJECTION_VERSION,
    phase: 'perception',
    projectId: DIRECTOR_EXTRACTION_PROJECT_ID,
    workId: identity.workId,
    workQueryDigest: identity.workQueryDigest,
    sourceTaskId: identity.sourceTaskId,
    sourceBindingId: identity.sourceBindingId,
    tenantId: identity.tenantId,
    workspaceId: identity.workspaceId,
    materialId: identity.materialId,
    sourceResultSha256: identity.sourceResultSha256,
  })
}
