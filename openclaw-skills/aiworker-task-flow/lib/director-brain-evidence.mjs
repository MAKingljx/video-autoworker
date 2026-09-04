import { createHash } from 'node:crypto'

export const DIRECTOR_EVIDENCE_SCHEMA_VERSION = 1
export const DIRECTOR_EVIDENCE_PROJECT_ID = 'PROJ-VIDEO-AUTOWORKER'
export const DIRECTOR_EVIDENCE_SOURCE_AUTHORITY = 'video-autoworker-final-result-v1'

const MAX_INPUT_BYTES = 2 * 1024 * 1024
const MAX_SEGMENTS = 240
const MAX_TEXT_LENGTH = 4_000
const IDENTIFIER_PATTERN = /^[A-Za-z0-9._:-]+$/u
const VISUAL_PERCEPTION_KEYS = Object.freeze([
  'summary', 'people', 'locations', 'actions', 'objects', 'environment', 'ocr',
  'shotTypes', 'cameraMovement', 'composition', 'emotion',
])
const SOUND_PERCEPTION_KEYS = Object.freeze([
  'speechSummary', 'ambientSound', 'music', 'emotion',
])
const DIRECTOR_PERCEPTION_KEYS = Object.freeze([
  ...VISUAL_PERCEPTION_KEYS,
  'sound',
])
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

function exactObject(value, label, keys) {
  const object = plainObject(value, label)
  const expected = new Set(keys)
  const missing = keys.filter(key => !Object.hasOwn(object, key))
  if (missing.length) throw new Error(`director_evidence_${label}_field_missing:${missing.join(',')}`)
  const extra = Object.keys(object).filter(key => !expected.has(key))
  if (extra.length) throw new Error(`director_evidence_${label}_field_unexpected:${extra.join(',')}`)
  return object
}

function normalizedTextList(value, label, { maximumItems, maximumItemLength }) {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`director_evidence_${label}_invalid`)
  }
  const items = value.map((item, index) => normalizedText(
    item,
    `${label}:${index + 1}`,
    { required: true, maximum: maximumItemLength },
  ))
  const unique = [...new Set(items)]
  if (unique.length !== items.length) throw new Error(`director_evidence_${label}_duplicate`)
  return unique
}

function visualPerception(value, label, picture) {
  if (value === undefined) return null
  const object = exactObject(value, label, VISUAL_PERCEPTION_KEYS)
  const perception = {
    summary: normalizedText(object.summary, `${label}_summary`, { required: true }),
    people: normalizedTextList(object.people, `${label}_people`, { maximumItems: 20, maximumItemLength: 160 }),
    locations: normalizedTextList(object.locations, `${label}_locations`, { maximumItems: 12, maximumItemLength: 240 }),
    actions: normalizedTextList(object.actions, `${label}_actions`, { maximumItems: 20, maximumItemLength: 240 }),
    objects: normalizedTextList(object.objects, `${label}_objects`, { maximumItems: 20, maximumItemLength: 160 }),
    environment: normalizedTextList(object.environment, `${label}_environment`, { maximumItems: 12, maximumItemLength: 240 }),
    ocr: normalizedTextList(object.ocr, `${label}_ocr`, { maximumItems: 20, maximumItemLength: 500 }),
    shotTypes: normalizedTextList(object.shotTypes, `${label}_shot_types`, { maximumItems: 12, maximumItemLength: 120 }),
    cameraMovement: normalizedTextList(object.cameraMovement, `${label}_camera_movement`, { maximumItems: 12, maximumItemLength: 120 }),
    composition: normalizedTextList(object.composition, `${label}_composition`, { maximumItems: 12, maximumItemLength: 160 }),
    emotion: normalizedTextList(object.emotion, `${label}_emotion`, { maximumItems: 12, maximumItemLength: 160 }),
  }
  if (picture && perception.summary !== picture) {
    throw new Error(`director_evidence_${label}_summary_mismatch`)
  }
  return perception
}

function soundPerception(value, label) {
  if (value === undefined) return null
  const object = exactObject(value, label, SOUND_PERCEPTION_KEYS)
  const sound = Object.fromEntries(SOUND_PERCEPTION_KEYS.map(key => [
    key,
    normalizedText(object[key], `${label}_${key}`, { maximum: 1_000 }),
  ]))
  return Object.values(sound).some(Boolean) ? sound : null
}

function directorPerception(value, label, summary) {
  if (value === undefined) return { perception: null, sound: null }
  const object = exactObject(value, label, DIRECTOR_PERCEPTION_KEYS)
  const perception = visualPerception(
    Object.fromEntries(VISUAL_PERCEPTION_KEYS.map(key => [key, object[key]])),
    `${label}_visual`,
    summary,
  )
  return {
    perception,
    sound: soundPerception(object.sound, `${label}_sound`),
  }
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
    const perception = visualPerception(
      segment.perception,
      `timeline_perception:${index}`,
      picture,
    )
    const sound = soundPerception(segment.sound, `timeline_sound:${index}`)
    return {
      kind: 'timeline',
      index,
      ...range,
      confidence: confidence(segment.confidence, `timeline_confidence:${index}`),
      picture,
      perception,
      sound,
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
      perception: null,
      sound: null,
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

function globalSummarySource(report, sources, durationSeconds, output) {
  const structured = directorPerception(
    output.directorPerception,
    'output_director_perception',
    report.text,
  )
  return {
    kind: 'global',
    index: 0,
    startSeconds: 0,
    endSeconds: durationSeconds,
    confidence: Math.min(...sources.map(source => source.confidence)),
    picture: null,
    perception: structured.perception,
    sound: structured.sound,
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
  const perception = source.perception
  const sound = source.sound
  const shotLanguage = perception
    ? [
        ...perception.shotTypes.map(value => `景别：${value}`),
        ...perception.cameraMovement.map(value => `运镜：${value}`),
        ...perception.composition.map(value => `构图：${value}`),
      ].join('\n')
    : ''
  const soundInformation = sound
    ? [
        sound.speechSummary ? `对白/旁白：${sound.speechSummary}` : '',
        sound.ambientSound ? `环境声：${sound.ambientSound}` : '',
        sound.music ? `音乐：${sound.music}` : '',
        sound.emotion ? `声音情绪：${sound.emotion}` : '',
      ].filter(Boolean).join('\n')
    : ''
  const fields = {
    '证据名称': `${envelope.workId} ${sourceName}`,
    '任务 ID': envelope.taskId,
    '素材 ID': envelope.materialId,
    '场景 ID': sceneId,
    '镜头 ID': shotId,
    '起始时间码': formatClock(source.startSeconds),
    '结束时间码': formatClock(source.endSeconds),
    '时间信息': source.kind === 'global' ? 'global:summary' : `${source.kind}:${source.index}`,
    ...(perception?.people.length ? { '人物信息': perception.people.join('\n') } : {}),
    ...(perception?.locations.length ? { '地点': perception.locations.join('\n') } : {}),
    ...(perception?.actions.length ? { '行为': perception.actions.join('\n') } : {}),
    ...(perception?.objects.length ? { '物体信息': perception.objects.join('\n') } : {}),
    ...(perception?.environment.length ? { '环境信息': perception.environment.join('\n') } : {}),
    ...(perception?.ocr.length ? { 'OCR 信息': perception.ocr.join('\n') } : {}),
    ...(shotLanguage ? { '镜头语言': shotLanguage } : {}),
    ...(perception?.emotion.length ? { '情绪信息': perception.emotion.join('\n') } : {}),
    ...(soundInformation ? { '声音信息': soundInformation } : {}),
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
    globalSummarySource(report, sources, envelope.mediaDurationSeconds, envelope.output),
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
