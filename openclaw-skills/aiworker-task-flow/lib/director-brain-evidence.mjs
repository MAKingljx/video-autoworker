import { createHash } from 'node:crypto'

export const DIRECTOR_EVIDENCE_SCHEMA_VERSION = 1
export const DIRECTOR_EVIDENCE_PROJECT_ID = 'PROJ-VIDEO-AUTOWORKER'
export const DIRECTOR_EVIDENCE_SOURCE_AUTHORITY = 'video-autoworker-final-result-v1'

const MAX_INPUT_BYTES = 2 * 1024 * 1024
const MAX_SEGMENTS = 240
const MAX_TEXT_LENGTH = 4_000
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/u
const ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'projectId',
  'workId',
  'taskId',
  'materialId',
  'mediaDurationSeconds',
  'analysisVersion',
  'status',
  'taskType',
  'sourceAuthority',
  'output',
])

function plainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_must_be_object`)
  }
  return value
}

function assertSerializedSize(value) {
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error('director_evidence_envelope_not_serializable')
  }
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_INPUT_BYTES) {
    throw new Error('director_evidence_envelope_too_large')
  }
}

function exactEnvelope(value) {
  const envelope = plainObject(value, 'director_evidence_envelope')
  const keys = Object.keys(envelope)
  const missing = [...ENVELOPE_KEYS].filter(key => !Object.hasOwn(envelope, key))
  if (missing.length) throw new Error(`director_evidence_field_missing:${missing.join(',')}`)
  const extra = keys.filter(key => !ENVELOPE_KEYS.has(key))
  if (extra.length) throw new Error(`director_evidence_field_unexpected:${extra.join(',')}`)
  return envelope
}

function identifier(value, label, maximum = 160) {
  if (typeof value !== 'string'
    || value !== value.trim()
    || !value
    || value.length > maximum
    || !IDENTIFIER_PATTERN.test(value)) {
    throw new Error(`director_evidence_${label}_invalid`)
  }
  return value
}

function normalizedText(value, label, { required = false, maximum = MAX_TEXT_LENGTH } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`director_evidence_${label}_missing`)
    return null
  }
  if (typeof value !== 'string') throw new Error(`director_evidence_${label}_invalid`)
  const text = value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()
  if (!text) {
    if (required) throw new Error(`director_evidence_${label}_missing`)
    return null
  }
  return text.slice(0, maximum)
}

function positiveFinite(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`director_evidence_${label}_invalid`)
  }
  return value
}

function confidence(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`director_evidence_${label}_invalid`)
  }
  return value
}

function parseClock(value, label) {
  if (typeof value !== 'string') throw new Error(`director_evidence_${label}_invalid`)
  const match = /^(\d{2,}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/u.exec(value.trim())
  if (!match) throw new Error(`director_evidence_${label}_invalid`)
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const milliseconds = Number(String(match[4] || '').padEnd(3, '0') || 0)
  if (!Number.isSafeInteger(hours) || minutes > 59 || seconds > 59) {
    throw new Error(`director_evidence_${label}_invalid`)
  }
  return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000
}

function formatClock(value) {
  const milliseconds = Math.round(value * 1000)
  const hours = Math.floor(milliseconds / 3_600_000)
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
  const seconds = Math.floor((milliseconds % 60_000) / 1000)
  const remainder = milliseconds % 1000
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(remainder).padStart(3, '0')}`
}

function timeRange(value, label, durationSeconds) {
  if (typeof value !== 'string') throw new Error(`director_evidence_${label}_invalid`)
  const match = /^(\d{2,}:\d{2}:\d{2}(?:\.\d{1,3})?)-(\d{2,}:\d{2}:\d{2}(?:\.\d{1,3})?)$/u.exec(value.trim())
  if (!match) throw new Error(`director_evidence_${label}_invalid`)
  return boundedRange(
    parseClock(match[1], `${label}_start`),
    parseClock(match[2], `${label}_end`),
    label,
    durationSeconds,
  )
}

function boundedRange(startSeconds, endSeconds, label, durationSeconds) {
  if (startSeconds < 0 || endSeconds <= startSeconds) {
    throw new Error(`director_evidence_${label}_range_invalid`)
  }
  if (endSeconds > durationSeconds + 0.001) {
    throw new Error(`director_evidence_${label}_exceeds_media_duration`)
  }
  return { startSeconds, endSeconds }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function sourceIndex(value, offset, label) {
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new Error(`director_evidence_${label}_index_invalid:${offset + 1}`)
  }
  return index
}

function stableSegmentId(kind, identity) {
  return `DB-${kind}-${sha256(identity)}`
}

function selectedReport(output) {
  const summary = normalizedText(output.summary, 'output_summary')
  if (summary) return { source: 'summary', text: summary }
  throw new Error('director_evidence_final_report_missing')
}

function timelineSources(output, durationSeconds) {
  if (!Array.isArray(output.timeline) || output.timeline.length === 0) return null
  if (output.timeline.length > MAX_SEGMENTS) throw new Error('director_evidence_timeline_too_large')
  return output.timeline.map((raw, offset) => {
    const segment = plainObject(raw, `director_evidence_timeline_${offset + 1}`)
    const index = sourceIndex(segment.index, offset, 'timeline')
    const range = timeRange(segment.timeRange, `timeline_time_range:${index}`, durationSeconds)
    // Validate upstream transcript shape without projecting raw speech into Feishu.
    // A future sound field must come from a separately governed structured summary.
    normalizedText(segment.transcript, `timeline_transcript:${index}`)
    const picture = normalizedText(
      segment.visualAnalysis,
      `timeline_visual_analysis:${index}`,
    )
    return {
      kind: 'timeline',
      index,
      ...range,
      confidence: confidence(segment.confidence, `timeline_confidence:${index}`),
      picture,
      summary: picture,
      summarySource: 'timeline.visualAnalysis',
      sceneId: segment.sceneId === undefined ? null : identifier(segment.sceneId, `timeline_scene_id:${index}`),
      shotId: segment.shotId === undefined ? null : identifier(segment.shotId, `timeline_shot_id:${index}`),
    }
  })
}

function chapterSources(output, durationSeconds) {
  if (!Array.isArray(output.chapters) || output.chapters.length === 0) return null
  if (output.chapters.length > MAX_SEGMENTS) throw new Error('director_evidence_chapters_too_large')
  return output.chapters.map((raw, offset) => {
    const chapter = plainObject(raw, `director_evidence_chapter_${offset + 1}`)
    const index = sourceIndex(chapter.index, offset, 'chapter')
    const range = boundedRange(
      parseClock(chapter.startTime, `chapter_start_time:${index}`),
      parseClock(chapter.endTime, `chapter_end_time:${index}`),
      `chapter_time_range:${index}`,
      durationSeconds,
    )
    return {
      kind: 'chapter',
      index,
      ...range,
      confidence: confidence(chapter.confidence, `chapter_confidence:${index}`),
      picture: null,
      summary: null,
      summarySource: null,
      sceneId: chapter.sceneId === undefined ? null : identifier(chapter.sceneId, `chapter_scene_id:${index}`),
      shotId: chapter.shotId === undefined ? null : identifier(chapter.shotId, `chapter_shot_id:${index}`),
    }
  })
}

function uniqueIndexes(sources) {
  const indexes = sources.map(source => source.index)
  if (new Set(indexes).size !== indexes.length) {
    throw new Error('director_evidence_segment_indexes_duplicate')
  }
}

function globalSummarySource(report, sources, durationSeconds) {
  return {
    kind: 'global',
    index: 0,
    startSeconds: 0,
    endSeconds: durationSeconds,
    confidence: Math.min(...sources.map(source => source.confidence)),
    picture: null,
    summary: report.text,
    summarySource: 'output.summary',
    sceneId: null,
    shotId: null,
  }
}

function evidenceItem(envelope, source) {
  const segmentIdentity = {
    projectId: envelope.projectId,
    workId: envelope.workId,
    taskId: envelope.taskId,
    materialId: envelope.materialId,
    analysisVersion: envelope.analysisVersion,
    sourceKind: source.kind,
    sourceIndex: source.index,
    startSeconds: source.startSeconds,
    endSeconds: source.endSeconds,
  }
  const sceneId = source.sceneId || stableSegmentId('SCENE', segmentIdentity)
  const shotId = source.shotId || stableSegmentId('SHOT', { ...segmentIdentity, sceneId })
  const sourceName = source.kind === 'global'
    ? '全片摘要'
    : `${source.kind === 'timeline' ? '时间片段' : '章节'} ${source.index}`
  const fields = {
    '证据名称': `${envelope.workId} ${sourceName}`,
    '任务 ID': envelope.taskId,
    '素材 ID': envelope.materialId,
    '场景 ID': sceneId,
    '镜头 ID': shotId,
    '起始时间码': formatClock(source.startSeconds),
    '结束时间码': formatClock(source.endSeconds),
    '时间信息': source.kind === 'global' ? 'global:summary' : `${source.kind}:${source.index}`,
    ...(source.picture ? { '画面信息': source.picture } : {}),
    '证据摘要': source.summary,
    '分析版本': envelope.analysisVersion,
    '置信度': source.confidence,
  }
  fields['校验摘要'] = sha256({
    sourceAuthority: envelope.sourceAuthority,
    summarySource: source.summarySource,
    fields,
  })
  return fields
}

export function stableDirectorEvidenceId(workIdValue, itemValue) {
  const workId = identifier(workIdValue, 'work_id')
  const item = plainObject(itemValue, 'director_evidence_item')
  const required = [
    '任务 ID', '素材 ID', '场景 ID', '镜头 ID', '起始时间码', '结束时间码',
    '分析版本', '校验摘要',
  ]
  for (const name of required) {
    if (!Object.hasOwn(item, name)) throw new Error(`director_evidence_identity_field_missing:${name}`)
  }
  const identity = {
    '作品 ID': workId,
    ...Object.fromEntries(required.map(name => [name, item[name]])),
  }
  return `DB-EVIDENCE-${sha256(identity)}`
}

export function buildDirectorBrainEvidenceProjection(value) {
  assertSerializedSize(value)
  const rawEnvelope = exactEnvelope(value)
  if (rawEnvelope.schemaVersion !== DIRECTOR_EVIDENCE_SCHEMA_VERSION) {
    throw new Error('director_evidence_schema_version_invalid')
  }
  if (rawEnvelope.projectId !== DIRECTOR_EVIDENCE_PROJECT_ID) {
    throw new Error('director_evidence_project_id_invalid')
  }
  if (rawEnvelope.status !== 'succeeded') throw new Error('director_evidence_task_not_succeeded')
  if (rawEnvelope.taskType !== 'video-analysis') throw new Error('director_evidence_task_type_invalid')
  if (rawEnvelope.sourceAuthority !== DIRECTOR_EVIDENCE_SOURCE_AUTHORITY) {
    throw new Error('director_evidence_source_authority_invalid')
  }
  const envelope = {
    ...rawEnvelope,
    workId: identifier(rawEnvelope.workId, 'work_id'),
    taskId: identifier(rawEnvelope.taskId, 'task_id', 120),
    materialId: identifier(rawEnvelope.materialId, 'material_id'),
    analysisVersion: identifier(rawEnvelope.analysisVersion, 'analysis_version', 120),
    mediaDurationSeconds: positiveFinite(
      rawEnvelope.mediaDurationSeconds,
      'media_duration_seconds',
    ),
    output: plainObject(rawEnvelope.output, 'director_evidence_output'),
  }

  const report = selectedReport(envelope.output)
  const sources = timelineSources(envelope.output, envelope.mediaDurationSeconds)
    || chapterSources(envelope.output, envelope.mediaDurationSeconds)
  if (!sources?.length) throw new Error('director_evidence_timeline_or_chapters_missing')
  uniqueIndexes(sources)
  const evidenceSources = [
    globalSummarySource(report, sources, envelope.mediaDurationSeconds),
    ...sources.filter(source => source.summary),
  ]
  const items = evidenceSources.map(source => evidenceItem(envelope, source))
  const evidenceIds = items.map(item => stableDirectorEvidenceId(envelope.workId, item))
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error('director_evidence_identity_duplicate')
  }
  return { workId: envelope.workId, items }
}

export function buildDirectorBrainEvidenceProjectionFromTaskRun(workId, runValue) {
  const run = plainObject(runValue, 'director_evidence_task_run')
  const output = plainObject(run.output, 'director_evidence_task_output')
  return buildDirectorBrainEvidenceProjection({
    schemaVersion: DIRECTOR_EVIDENCE_SCHEMA_VERSION,
    projectId: DIRECTOR_EVIDENCE_PROJECT_ID,
    workId,
    taskId: run.taskId,
    materialId: output.materialId,
    mediaDurationSeconds: output.mediaDurationSeconds,
    analysisVersion: output.analysisVersion,
    status: run.status,
    taskType: output.taskType,
    sourceAuthority: DIRECTOR_EVIDENCE_SOURCE_AUTHORITY,
    output,
  })
}
