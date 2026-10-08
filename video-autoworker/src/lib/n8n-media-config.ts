import { z } from 'zod'

export const VIDEO_LEARNING_SEGMENT_SECONDS = 5
export const VIDEO_LEARNING_SEGMENT_MIN_SECONDS = 1
export const VIDEO_LEARNING_SEGMENT_MAX_SECONDS = 300

// Accept number-input strings, but never silently turn an empty value, null or
// a boolean into a learning window. The same schema is used by UI and server.
const learningWindowSchema = z.preprocess(
  value => typeof value === 'string' && value.trim() ? Number(value) : value,
  z.number().int().min(VIDEO_LEARNING_SEGMENT_MIN_SECONDS).max(VIDEO_LEARNING_SEGMENT_MAX_SECONDS),
)

export const n8nMediaConfigSchema = z.object({
  audioResourceId: z.string().trim().min(1).max(80).default('whisper-large-v3-turbo'),
  language: z.string().trim().min(2).max(20).default('zh'),
  maxDurationSeconds: z.coerce.number().int().min(1).max(7_200).default(7_200),
  segmentSeconds: learningWindowSchema.default(VIDEO_LEARNING_SEGMENT_SECONDS),
  segmentOverlapSeconds: z.coerce.number().int().min(0).max(5).default(0),
  maxKeyframesPerSegment: z.coerce.number().int().min(1).max(6).default(3),
  maxFrames: z.coerce.number().int().min(1).max(12).default(4),
  frameWidth: z.coerce.number().int().min(320).max(2_048).default(960),
  maxTranscriptCharsPerSegment: z.coerce.number().int().min(500).max(12_000).default(6_000),
  maxTranscriptChars: z.coerce.number().int().min(500).max(100_000).default(100_000),
}).strict().superRefine((settings, ctx) => {
  if (settings.segmentOverlapSeconds >= settings.segmentSeconds) {
    ctx.addIssue({ code: 'custom', path: ['segmentOverlapSeconds'], message: '分段重叠必须小于学习窗口' })
  }
})

export function parseN8nMediaConfig(config: Record<string, unknown>) {
  const media = config.media
  // File-size admission belongs to host capacity; retain the established
  // removal of this obsolete per-binding cap without accepting other typos.
  const value = media && typeof media === 'object' && !Array.isArray(media)
    ? { ...media as Record<string, unknown> }
    : media === undefined ? {} : media
  if (value && typeof value === 'object' && !Array.isArray(value)) delete (value as Record<string, unknown>).maxFileBytes
  return n8nMediaConfigSchema.parse(value)
}

export function normalizeN8nMediaConfig(config: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...config, media: parseN8nMediaConfig(config) }
  // config.media is the sole authority. Old top-level aliases were ignored by
  // execution; remove them only when saving or snapshotting a new video task.
  delete normalized.segmentSeconds
  delete normalized.segmentOverlapSeconds
  return normalized
}

export function setN8nLearningWindow(config: Record<string, unknown>, seconds: unknown) {
  const segmentSeconds = learningWindowSchema.parse(seconds)
  const media = config.media === undefined ? {} : config.media
  if (!media || typeof media !== 'object' || Array.isArray(media)) {
    // A malformed media object must not be discarded while editing one field.
    parseN8nMediaConfig(config)
  }
  return normalizeN8nMediaConfig({ ...config, media: { ...media as Record<string, unknown>, segmentSeconds } })
}

export function snapshotN8nMediaRouting(routing: Record<string, unknown>): Record<string, unknown> {
  if (routing.taskType !== 'video-analysis') return routing
  const config = routing.config && typeof routing.config === 'object' && !Array.isArray(routing.config)
    ? routing.config as Record<string, unknown> : {}
  return { ...routing, config: normalizeN8nMediaConfig(config) }
}
