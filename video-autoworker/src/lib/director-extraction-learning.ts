import {
  directorExtractionDigest,
  type DirectorExtractionPhase,
  type DirectorLearningContextResult,
} from '@/lib/director-extraction-state'

export const DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES = 128 * 1024
export const DIRECTOR_EXTRACTION_LEARNING_CONTEXT_MAX_BYTES = 80 * 1024

export type DirectorLearningRecord =
  DirectorLearningContextResult['snapshot']['work']['people_profiles'][number]
type LearningRecord = DirectorLearningRecord

const DOMAIN_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  director_intents: [
    '核心主题', '导演态度', '核心人物 ID', '情绪风格', '叙事方式', '节奏', '观众体验',
    '上一版本 ID', '版本',
  ],
  people_profiles: [
    '人物名称', '人物 ID', '别名', '身份', '目标', '欲望', '恐惧', '性格', '关系 ID',
    '矛盾', '情绪变化', '人物弧光', '观察日期', '置信度', '上一版本 ID', '版本',
  ],
  story_nodes: [
    '节点名称', '节点类型', '人物 ID', '发生时间', '节点内容', '变化', '置信度',
    '上一版本 ID', '版本',
  ],
  story_relations: [
    '关系名称', '关系类型', '源节点 ID', '目标节点 ID', '证据 ID', '判断理由', '置信度',
    '上一版本 ID', '版本',
  ],
  material_judgments: [
    '判断名称', '故事价值', '人物价值', '情绪价值', '信息价值', '视觉价值', '稀缺性',
    '叙事价值', '使用理由', '建议位置', '不同位置效果', '意图版本 ID', '技法 ID',
    '置信度', '上一版本 ID', '版本',
  ],
  narrative_plans: [
    '方案名称', '人物线', '事件线', '时间线', '地点线', '情绪线', '主题线', '冲突线',
    '结构说明', '故事脚本', '意图版本 ID', '节点 ID', '技法 ID', '上一版本 ID', '版本',
  ],
  director_cases: [
    '案例名称', '上下文', '导演动作', '判断原因', '最终使用', '成片位置', '最终效果',
    '判断 ID', '上一版本 ID', '版本',
  ],
  skills_techniques: [
    '知识名称', '知识类型', '知识分类', '适用条件', '执行方法', '为什么有效', '例外情况',
    '案例 ID', '来源作品 ID', '验证次数', '置信度', '上一版本 ID', '版本',
  ],
})

const PHASE_TABLES: Readonly<Record<DirectorExtractionPhase, Readonly<{
  work: readonly string[]
  project: readonly string[]
}>>> = Object.freeze({
  perception: { work: [], project: [] },
  understanding: { work: ['people_profiles', 'story_nodes'], project: [] },
  judgment: {
    work: [
      'people_profiles', 'story_nodes', 'story_relations', 'material_judgments', 'narrative_plans',
    ],
    project: ['skills_techniques'],
  },
  case: {
    work: ['story_relations', 'material_judgments', 'narrative_plans', 'director_cases'],
    project: [],
  },
  technique: {
    work: ['director_cases'],
    project: ['director_cases', 'skills_techniques'],
  },
})

function compactFields(table: string, fields: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries((DOMAIN_FIELDS[table] || [])
    .filter(name => Object.hasOwn(fields, name))
    .map(name => [name, fields[name]]))
}

export function compactDirectorLearningRecord(record: LearningRecord): LearningRecord {
  return {
    table: record.table,
    stableId: record.stableId,
    state: record.state,
    reviewed: true,
    fields: compactFields(record.table, record.fields),
  }
}

function terms(value: string): string[] {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('zh-CN').trim()
  if (!normalized) return []
  return [...new Set([
    normalized,
    ...(normalized.match(/[\p{L}\p{N}]{2,}/gu) || []),
  ])].sort()
}

function relevance(record: LearningRecord, objectiveTerms: readonly string[]): number {
  if (!objectiveTerms.length) return 0
  const value = JSON.stringify(record.fields).normalize('NFKC').toLocaleLowerCase('zh-CN')
  return objectiveTerms.reduce((score, term) => score + (value.includes(term) ? term.length : 0), 0)
}

function rankedRecords(records: readonly LearningRecord[], objective: string) {
  const objectiveTerms = terms(objective)
  const previousIds = new Set(records.map(record => String(record.fields['上一版本 ID'] || ''))
    .filter(Boolean))
  return records.map(record => ({
    record,
    head: !previousIds.has(record.stableId),
    relevance: relevance(record, objectiveTerms),
    updatedAt: Number(record.fields['更新时间'] || 0),
  }))
}

type SelectionCounts = {
  work: Record<string, number>
  project: Record<string, number>
}

export type DirectorLearningSelectionTrace = {
  schemaVersion: 1
  phase: DirectorExtractionPhase
  sourceDigest: string
  selectionDigest: string
  selectedCounts: SelectionCounts
  omittedCounts: SelectionCounts
  byteLength: number
}

function emptyBuckets() {
  return {
    work: {
      activeIntent: null as LearningRecord | null,
      people_profiles: [] as LearningRecord[],
      story_nodes: [] as LearningRecord[],
      story_relations: [] as LearningRecord[],
      material_judgments: [] as LearningRecord[],
      narrative_plans: [] as LearningRecord[],
      director_cases: [] as LearningRecord[],
    },
    project: {
      director_cases: [] as LearningRecord[],
      skills_techniques: [] as LearningRecord[],
    },
  }
}

function countsOf(buckets: ReturnType<typeof emptyBuckets>): SelectionCounts {
  return {
    work: Object.fromEntries(Object.entries(buckets.work).map(([key, value]) => (
      [key, Array.isArray(value) ? value.length : value ? 1 : 0]
    ))),
    project: Object.fromEntries(Object.entries(buckets.project).map(([key, value]) => (
      [key, value.length]
    ))),
  }
}

function subtractCounts(total: SelectionCounts, selected: SelectionCounts): SelectionCounts {
  return {
    work: Object.fromEntries(Object.entries(total.work).map(([key, value]) => (
      [key, value - (selected.work[key] || 0)]
    ))),
    project: Object.fromEntries(Object.entries(total.project).map(([key, value]) => (
      [key, value - (selected.project[key] || 0)]
    ))),
  }
}

function buildSelection(
  source: DirectorLearningContextResult,
  phase: DirectorExtractionPhase,
  buckets: ReturnType<typeof emptyBuckets>,
) {
  const selectedCounts = countsOf(buckets)
  const sourceCounts: SelectionCounts = {
    work: source.snapshot.counts.work,
    project: source.snapshot.counts.project,
  }
  const snapshot = {
    schemaVersion: 1 as const,
    projectId: source.snapshot.projectId,
    workId: source.snapshot.workId,
    counts: {
      work: selectedCounts.work,
      project: selectedCounts.project,
      total: Object.values(selectedCounts.work).reduce((sum, count) => sum + count, 0)
        + Object.values(selectedCounts.project).reduce((sum, count) => sum + count, 0),
    },
    work: buckets.work,
    project: buckets.project,
  }
  const digest = directorExtractionDigest(snapshot)
  const learningContext = {
    ok: true as const,
    action: 'learning_context' as const,
    workId: source.workId,
    snapshot,
    digest,
  }
  const trace: DirectorLearningSelectionTrace = {
    schemaVersion: 1,
    phase,
    sourceDigest: source.digest,
    selectionDigest: digest,
    selectedCounts,
    omittedCounts: subtractCounts(sourceCounts, selectedCounts),
    byteLength: 0,
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const byteLength = Buffer.byteLength(JSON.stringify({
      learningContext,
      learningContextTrace: trace,
    }))
    if (trace.byteLength === byteLength) break
    trace.byteLength = byteLength
  }
  return { learningContext, learningContextTrace: trace }
}

export function selectDirectorLearningContext(input: {
  source: DirectorLearningContextResult
  phase: DirectorExtractionPhase
  objective: string
  maxBytes: number
}): ReturnType<typeof buildSelection> {
  const { source, phase, objective } = input
  if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes <= 0) {
    throw new Error('director_extraction_learning_context_budget_invalid')
  }
  const buckets = emptyBuckets()
  if (phase === 'judgment' && source.snapshot.work.activeIntent) {
    buckets.work.activeIntent = compactDirectorLearningRecord(source.snapshot.work.activeIntent)
  }
  let selection = buildSelection(source, phase, buckets)
  if (selection.learningContextTrace.byteLength > input.maxBytes) {
    throw new Error('director_extraction_learning_context_budget_exceeded')
  }

  const tablePlan = PHASE_TABLES[phase]
  const candidates: Array<{
    scope: 'work' | 'project'
    table: string
    record: LearningRecord
    head: boolean
    relevance: number
    updatedAt: number
  }> = []
  for (const table of tablePlan.work) {
    const records = source.snapshot.work[table as keyof typeof source.snapshot.work]
    if (!Array.isArray(records)) continue
    candidates.push(...rankedRecords(records, objective).map(item => ({
      scope: 'work' as const,
      table,
      ...item,
      record: compactDirectorLearningRecord(item.record),
    })))
  }
  for (const table of tablePlan.project) {
    const records = source.snapshot.project[table as keyof typeof source.snapshot.project]
    candidates.push(...rankedRecords(records, objective).map(item => ({
      scope: 'project' as const,
      table,
      ...item,
      record: compactDirectorLearningRecord(item.record),
    })))
  }
  candidates.sort((left, right) => (
    Number(right.head) - Number(left.head)
    || right.relevance - left.relevance
    || right.updatedAt - left.updatedAt
    || left.scope.localeCompare(right.scope)
    || left.table.localeCompare(right.table)
    || left.record.stableId.localeCompare(right.record.stableId)
  ))

  for (const candidate of candidates) {
    const target = buckets[candidate.scope][candidate.table as never] as LearningRecord[]
    target.push(candidate.record)
    const next = buildSelection(source, phase, buckets)
    if (next.learningContextTrace.byteLength <= input.maxBytes) selection = next
    else target.pop()
  }
  return selection
}
