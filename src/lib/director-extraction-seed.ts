import { createHash } from 'node:crypto'
import { DIRECTOR_EXTRACTION_PROJECT_ID } from '@/lib/director-extraction-state'
import { redactSensitiveValues } from '../../scripts/lib/sensitive-value-scanner.mjs'

export const DIRECTOR_EXTRACTION_SEED_SCHEMA_VERSION = 2 as const
export const DIRECTOR_EXTRACTION_MAX_SEED_BYTES = 256 * 1024

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const MAX_CHAPTERS = 64
const MAX_TIMELINE = 240

const visualPerceptionKeys = [
  'summary',
  'people',
  'locations',
  'actions',
  'objects',
  'environment',
  'ocr',
  'shotTypes',
  'cameraMovement',
  'composition',
  'emotion',
] as const
const soundPerceptionKeys = [
  'speechSummary',
  'ambientSound',
  'music',
  'emotion',
] as const
const directorPerceptionKeys = [...visualPerceptionKeys, 'sound'] as const

type UnknownObject = Record<string, unknown>

export interface DirectorExtractionVisualPerception {
  summary: string
  people: string[]
  locations: string[]
  actions: string[]
  objects: string[]
  environment: string[]
  ocr: string[]
  shotTypes: string[]
  cameraMovement: string[]
  composition: string[]
  emotion: string[]
}

export interface DirectorExtractionSoundPerception {
  speechSummary: string | null
  ambientSound: string | null
  music: string | null
  emotion: string | null
}

export interface DirectorExtractionDirectorPerception extends DirectorExtractionVisualPerception {
  sound: DirectorExtractionSoundPerception
}

export interface DirectorExtractionSeedChapter {
  index: number
  startTime: string | null
  endTime: string | null
  summary: string | null
  confidence: number | null
}

export interface DirectorExtractionSeedTimelineItem {
  index: number
  timeRange: string | null
  visualSummary: string | null
  perception: DirectorExtractionVisualPerception | null
  confidence: number | null
}

export interface DirectorExtractionHistorySeed extends Record<string, unknown> {
  schemaVersion: typeof DIRECTOR_EXTRACTION_SEED_SCHEMA_VERSION
  projectId: typeof DIRECTOR_EXTRACTION_PROJECT_ID
  workId: string
  sourceTaskId: string
  materialId: string
  sourceResultSha256: string
  analysisVersion: string
  mediaDurationSeconds: number
  summary: string
  directorPerception: DirectorExtractionDirectorPerception | null
  chapters: DirectorExtractionSeedChapter[]
  timeline: DirectorExtractionSeedTimelineItem[]
}

function objectValue(value: unknown, label: string): UnknownObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_must_be_object`)
  }
  return value as UnknownObject
}

function exactObject(
  value: unknown,
  label: string,
  keys: readonly string[],
): UnknownObject {
  const object = objectValue(value, `director_extraction_${label}`)
  const expected = new Set(keys)
  const missing = keys.filter(key => !Object.hasOwn(object, key))
  if (missing.length > 0) {
    throw new Error(`director_extraction_${label}_field_missing:${missing.join(',')}`)
  }
  const extra = Object.keys(object).filter(key => !expected.has(key))
  if (extra.length > 0) {
    throw new Error(`director_extraction_${label}_field_unexpected:${extra.join(',')}`)
  }
  return object
}

function redactSensitive(value: string): string {
  return redactSensitiveValues(value)
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/giu,
      '[credential]',
    )
    .replace(/(?:https?|wss?|ftp|file):\/\/[^\s，。；;、,]+/giu, '[link]')
    .replace(
      /(?:\/Users|\/home|\/private|\/var|\/tmp|\/Volumes|\/Library|\/Applications|\/opt|\/etc|\/usr|\/mnt|\/srv|\/data|\/media|\/root|\/run)\/[^\s，。；;、,]+/gu,
      '[path]',
    )
    .replace(/[A-Za-z]:\\[^\s，。；;、,]+/gu, '[path]')
    .replace(/\\\\[^\s\\]+\\[^\s，。；;、,]+/gu, '[path]')
}

function normalizedText(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
    .trim()
}

function stableId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(`director_extraction_${label}_invalid`)
  }
  return value
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`director_extraction_${label}_invalid`)
  }
  return value
}

function optionalBoundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null
  const normalized = normalizedText(value)
  if (!normalized) return null
  return redactSensitive(normalized).slice(0, maximum)
}

function governedText(
  value: unknown,
  label: string,
  maximum: number,
  options: { nullable?: boolean; collapseWhitespace?: boolean } = {},
): string | null {
  if (value === null && options.nullable === true) return null
  if (typeof value !== 'string') {
    throw new Error(`director_extraction_${label}_invalid`)
  }
  const normalized = normalizedText(value)
  if (!normalized) throw new Error(`director_extraction_${label}_invalid`)
  if (normalized.length > maximum) {
    throw new Error(`director_extraction_${label}_too_long`)
  }
  return redactSensitive(options.collapseWhitespace === true
    ? normalized.replace(/\s+/gu, ' ')
    : normalized)
}

function requiredGovernedText(
  value: unknown,
  label: string,
  maximum: number,
  options: { collapseWhitespace?: boolean } = {},
): string {
  const parsed = governedText(value, label, maximum, options)
  if (parsed === null) throw new Error(`director_extraction_${label}_invalid`)
  return parsed
}

function governedTextList(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumItemLength: number,
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`director_extraction_${label}_invalid`)
  }
  if (value.length > maximumItems) {
    throw new Error(`director_extraction_${label}_too_many`)
  }
  const items = value.map((item, offset) => requiredGovernedText(
    item,
    `${label}_${offset + 1}`,
    maximumItemLength,
    { collapseWhitespace: true },
  ))
  return [...new Set(items)]
}

function visualPerception(
  value: unknown,
  label: string,
): DirectorExtractionVisualPerception | null {
  if (value === undefined) return null
  const object = exactObject(value, label, visualPerceptionKeys)
  return {
    summary: requiredGovernedText(object.summary, `${label}_summary`, 4_000),
    people: governedTextList(object.people, `${label}_people`, 20, 160),
    locations: governedTextList(object.locations, `${label}_locations`, 12, 240),
    actions: governedTextList(object.actions, `${label}_actions`, 20, 240),
    objects: governedTextList(object.objects, `${label}_objects`, 20, 160),
    environment: governedTextList(object.environment, `${label}_environment`, 12, 240),
    ocr: governedTextList(object.ocr, `${label}_ocr`, 20, 500),
    shotTypes: governedTextList(object.shotTypes, `${label}_shotTypes`, 12, 120),
    cameraMovement: governedTextList(
      object.cameraMovement,
      `${label}_cameraMovement`,
      12,
      120,
    ),
    composition: governedTextList(object.composition, `${label}_composition`, 12, 160),
    emotion: governedTextList(object.emotion, `${label}_emotion`, 12, 160),
  }
}

function soundPerception(value: unknown, label: string): DirectorExtractionSoundPerception {
  const object = exactObject(value, label, soundPerceptionKeys)
  return {
    speechSummary: governedText(object.speechSummary, `${label}_speechSummary`, 1_000, {
      nullable: true,
    }),
    ambientSound: governedText(object.ambientSound, `${label}_ambientSound`, 1_000, {
      nullable: true,
    }),
    music: governedText(object.music, `${label}_music`, 1_000, { nullable: true }),
    emotion: governedText(object.emotion, `${label}_emotion`, 1_000, { nullable: true }),
  }
}

function directorPerception(
  value: unknown,
  summary: string,
): DirectorExtractionDirectorPerception | null {
  if (value === undefined) return null
  const object = exactObject(value, 'director_perception', directorPerceptionKeys)
  const perception = visualPerception(
    Object.fromEntries(visualPerceptionKeys.map(key => [key, object[key]])),
    'director_perception_visual',
  )
  if (!perception) throw new Error('director_extraction_director_perception_invalid')
  if (perception.summary !== summary) {
    throw new Error('director_extraction_director_perception_summary_mismatch')
  }
  return {
    ...perception,
    sound: soundPerception(object.sound, 'director_perception_sound'),
  }
}

function boundedNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || value < minimum || value > maximum) {
    throw new Error(`director_extraction_${label}_invalid`)
  }
  return value
}

function positiveIndex(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback
}

function chapterItems(output: UnknownObject): DirectorExtractionSeedChapter[] {
  if (!Array.isArray(output.chapters)) return []
  if (output.chapters.length > MAX_CHAPTERS) {
    throw new Error('director_extraction_chapters_too_many')
  }
  return output.chapters.map((raw, offset) => {
    const item = objectValue(raw, `director_extraction_chapter_${offset + 1}`)
    return {
      index: positiveIndex(item.index, offset + 1),
      startTime: optionalBoundedText(item.startTime, 32),
      endTime: optionalBoundedText(item.endTime, 32),
      summary: optionalBoundedText(item.summary, 4_000),
      confidence: item.confidence === undefined
        ? null
        : boundedNumber(item.confidence, 0, 1, `chapter_confidence_${offset + 1}`),
    }
  })
}

function timelineItems(output: UnknownObject): DirectorExtractionSeedTimelineItem[] {
  if (!Array.isArray(output.timeline)) return []
  if (output.timeline.length > MAX_TIMELINE) {
    throw new Error('director_extraction_timeline_too_many')
  }
  return output.timeline.map((raw, offset) => {
    const item = objectValue(raw, `director_extraction_timeline_${offset + 1}`)
    const visualSummary = item.visualAnalysis === undefined
      ? null
      : requiredGovernedText(
          item.visualAnalysis,
          `timeline_visual_summary_${offset + 1}`,
          4_000,
        )
    const perception = visualPerception(
      item.perception,
      `timeline_perception_${offset + 1}`,
    )
    if (perception && perception.summary !== visualSummary) {
      throw new Error(`director_extraction_timeline_perception_${offset + 1}_summary_mismatch`)
    }
    return {
      index: positiveIndex(item.index, offset + 1),
      timeRange: optionalBoundedText(item.timeRange, 64),
      // Full transcript and combinedText are deliberately never selected.
      visualSummary,
      perception,
      confidence: item.confidence === undefined
        ? null
        : boundedNumber(item.confidence, 0, 1, `timeline_confidence_${offset + 1}`),
    }
  })
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as UnknownObject
    return `{${Object.keys(object).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(object[key])}`
    )).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? 'null' : encoded
}

export function directorExtractionSeedDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

export function buildDirectorExtractionHistorySeed(value: unknown): DirectorExtractionHistorySeed {
  const source = objectValue(value, 'director_extraction_history_source')
  const output = objectValue(source.output, 'director_extraction_history_output')
  if (output.taskType !== 'video-analysis') {
    throw new Error('director_extraction_task_type_invalid')
  }
  // summary is the only governed whole-video report. combinedText may contain
  // the full transcript and must never be used as a fallback.
  const summary = optionalBoundedText(output.summary, 16_000)
  if (!summary) throw new Error('director_extraction_summary_missing')

  const seed: DirectorExtractionHistorySeed = {
    schemaVersion: DIRECTOR_EXTRACTION_SEED_SCHEMA_VERSION,
    projectId: DIRECTOR_EXTRACTION_PROJECT_ID,
    workId: stableId(source.workId, 'work_id'),
    sourceTaskId: stableId(source.sourceTaskId, 'source_task_id'),
    materialId: stableId(output.materialId, 'material_id'),
    sourceResultSha256: digest(source.sourceResultSha256, 'result_digest'),
    analysisVersion: stableId(output.analysisVersion, 'analysis_version'),
    mediaDurationSeconds: boundedNumber(
      output.mediaDurationSeconds,
      0.001,
      7 * 24 * 60 * 60,
      'media_duration',
    ),
    summary,
    directorPerception: directorPerception(output.directorPerception, summary),
    chapters: chapterItems(output),
    timeline: timelineItems(output),
  }
  if (seed.chapters.length === 0 && seed.timeline.length === 0) {
    throw new Error('director_extraction_evidence_missing')
  }
  if (Buffer.byteLength(JSON.stringify(seed), 'utf8') > DIRECTOR_EXTRACTION_MAX_SEED_BYTES) {
    throw new Error('director_extraction_seed_too_large')
  }
  return seed
}
