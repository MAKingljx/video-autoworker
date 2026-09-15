import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { config } from '@/lib/config'
import {
  loadN8nModelRegistry,
  publicN8nModelRoute,
  resolveN8nNodeRoute,
  type AuxiliaryModelResource,
  type N8nModelRoute,
} from '@/lib/n8n-model-routing'
import {
  logSafeOperationError,
  projectSafeOperationError,
  SafeOperationError,
  sanitizeOperationalDiagnostic,
} from '@/lib/operational-errors'
import { assertMediaCapacity } from '../../openclaw-skills/aiworker-task-flow/lib/media-policy.mjs'

const videoKeySchema = z.string().trim().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:mp4|mov|mkv|webm|m4v)$/i,
  'videoKey 必须是受控收件箱生成的视频标识',
)

const mediaConfigSchema = z.object({
  audioResourceId: z.string().trim().min(1).max(80).default('whisper-large-v3-turbo'),
  language: z.string().trim().min(2).max(20).default('zh'),
  maxDurationSeconds: z.coerce.number().int().min(1).max(7_200).default(7_200),
  segmentSeconds: z.coerce.number().int().min(30).max(300).default(60),
  segmentOverlapSeconds: z.coerce.number().int().min(0).max(5).default(1),
  maxKeyframesPerSegment: z.coerce.number().int().min(1).max(6).default(3),
  maxFrames: z.coerce.number().int().min(1).max(12).default(4),
  frameWidth: z.coerce.number().int().min(320).max(2_048).default(960),
  maxTranscriptCharsPerSegment: z.coerce.number().int().min(500).max(12_000).default(6_000),
  maxTranscriptChars: z.coerce.number().int().min(500).max(100_000).default(100_000),
}).strict().superRefine((settings, ctx) => {
  if (settings.segmentOverlapSeconds >= settings.segmentSeconds) {
    ctx.addIssue({ code: 'custom', path: ['segmentOverlapSeconds'], message: '分段重叠必须小于分段时长' })
  }
})

export type N8nMediaStage = 'prepare' | 'audio' | 'vision' | 'finalize'
export type N8nVideoModelPhase = 'vision' | 'chapter' | 'final'
export type N8nVideoReasoningEffort = 'off' | 'low' | 'medium' | 'xhigh'

export interface N8nVideoGenerationProfile {
  phase: N8nVideoModelPhase
  reasoningEffort: N8nVideoReasoningEffort
  maxTokens: number
}

export interface N8nVisualPerception {
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

export interface N8nDirectorPerception extends N8nVisualPerception {
  sound: {
    speechSummary: string | null
    ambientSound: string | null
    music: string | null
    emotion: string | null
  }
}

export interface PreparedMedia extends Record<string, unknown> {
  kind: 'prepared-video'
  durationSeconds: number
  sourceBytes: number
  audioAvailable: boolean
  frameCount: number
  segmentCount: number
  segmentSeconds: number
  memoryMode: 'none'
}

interface MediaSegment {
  index: number
  startSeconds: number
  durationSeconds: number
  audioFile: string | null
  frameFiles: string[]
}

export interface MediaSegmentWindow {
  index: number
  startSeconds: number
  durationSeconds: number
}

interface CommandResult {
  stdout: string
  stderr: string
}

interface MediaMetadata extends PreparedMedia {
  taskId: string
  preparedAt: string
  segments: MediaSegment[]
}

type CliAudioResource = Omit<AuxiliaryModelResource, 'runtime'> & {
  runtime: Extract<AuxiliaryModelResource['runtime'], { type: 'cli' }>
}

const visualPerceptionSchema = z.object({
  summary: z.string().trim().min(1).max(4_000),
  people: z.array(z.string().trim().min(1).max(160)).max(20),
  locations: z.array(z.string().trim().min(1).max(240)).max(12),
  actions: z.array(z.string().trim().min(1).max(240)).max(20),
  objects: z.array(z.string().trim().min(1).max(160)).max(20),
  environment: z.array(z.string().trim().min(1).max(240)).max(12),
  ocr: z.array(z.string().trim().min(1).max(500)).max(20),
  shotTypes: z.array(z.string().trim().min(1).max(120)).max(12),
  cameraMovement: z.array(z.string().trim().min(1).max(120)).max(12),
  composition: z.array(z.string().trim().min(1).max(160)).max(12),
  emotion: z.array(z.string().trim().min(1).max(160)).max(12),
}).strict()

const directorPerceptionSchema = visualPerceptionSchema.extend({
  // The final report carries the whole-video narrative, while a per-segment
  // visual observation stays capped at 4,000 characters.
  summary: z.string().trim().min(1).max(16_000),
  sound: z.object({
    speechSummary: z.string().trim().min(1).max(1_000).nullable(),
    ambientSound: z.string().trim().min(1).max(1_000).nullable(),
    music: z.string().trim().min(1).max(1_000).nullable(),
    emotion: z.string().trim().min(1).max(1_000).nullable(),
  }).strict(),
}).strict()

const FINAL_SUMMARY_CHECKPOINT_SCHEMA = 'video-autoworker-final-summary-checkpoint'
const FINAL_SUMMARY_CHECKPOINT_VERSION = 1

const finalSummaryCheckpointSchema = z.object({
  schema: z.literal(FINAL_SUMMARY_CHECKPOINT_SCHEMA),
  version: z.literal(FINAL_SUMMARY_CHECKPOINT_VERSION),
  summary: z.string().trim().min(1).max(16_000),
  directorPerception: directorPerceptionSchema,
}).strict().superRefine((value, context) => {
  if (value.summary !== value.directorPerception.summary) {
    context.addIssue({
      code: 'custom',
      path: ['summary'],
      message: 'final_summary_checkpoint_summary_mismatch',
    })
  }
})


function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function expandHome(value: string): string {
  return resolve(value.replace(/^~(?=\/)/, homedir()))
}

function mediaConfig(routing: Record<string, unknown>) {
  const configValue = objectValue(routing.config)
  const mediaValue = objectValue(configValue.media)
  // File admission is a host capability, not a per-binding policy. Ignore the
  // old field so existing n8n bindings cannot reintroduce a second 10 GiB cap.
  const currentMediaValue = { ...mediaValue }
  delete currentMediaValue.maxFileBytes
  return mediaConfigSchema.parse(currentMediaValue)
}

function boundedIntegerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)))
}

const VIDEO_GENERATION_DEFAULTS: Record<N8nVideoModelPhase, {
  reasoningEffort: N8nVideoReasoningEffort
  maxTokens: number
}> = {
  // Per-minute visual extraction is factual perception, not final editorial
  // reasoning. Skipping private reasoning preserves the visible evidence while
  // avoiding dozens of dense-model reasoning passes for one video.
  vision: { reasoningEffort: 'off', maxTokens: 1_536 },
  // Segment summaries reconcile one segment of audio and visual evidence.
  chapter: { reasoningEffort: 'low', maxTokens: 1_024 },
  // Legacy final profile remains available to old callers; segment synthesis never invokes it.
  final: { reasoningEffort: 'medium', maxTokens: 1_536 },
}

const VIDEO_REASONING_ENV: Record<N8nVideoModelPhase, string> = {
  vision: 'AIWORKER_VIDEO_VISION_REASONING_EFFORT',
  chapter: 'AIWORKER_VIDEO_CHAPTER_REASONING_EFFORT',
  final: 'AIWORKER_VIDEO_FINAL_REASONING_EFFORT',
}

const VIDEO_MAX_TOKENS_ENV: Record<N8nVideoModelPhase, string> = {
  vision: 'AIWORKER_VIDEO_VISION_MAX_TOKENS',
  chapter: 'AIWORKER_VIDEO_CHAPTER_MAX_TOKENS',
  final: 'AIWORKER_VIDEO_FINAL_MAX_TOKENS',
}

export function videoModelGenerationProfile(
  phase: N8nVideoModelPhase,
  environment: Record<string, string | undefined> = process.env,
): N8nVideoGenerationProfile {
  const defaults = VIDEO_GENERATION_DEFAULTS[phase]
  const configuredReasoning = String(environment[VIDEO_REASONING_ENV[phase]] || defaults.reasoningEffort)
    .trim()
    .toLowerCase()
  if (!['off', 'low', 'medium', 'xhigh'].includes(configuredReasoning)) {
    throw new Error(`${VIDEO_REASONING_ENV[phase]} 必须是 off、low、medium 或 xhigh`)
  }

  const legacySynthesisTokens = phase === 'vision'
    ? undefined
    : environment.AIWORKER_VIDEO_SYNTHESIS_MAX_TOKENS
  const configuredTokens = Number(
    environment[VIDEO_MAX_TOKENS_ENV[phase]] || legacySynthesisTokens || defaults.maxTokens,
  )
  const maxTokens = Number.isFinite(configuredTokens)
    ? Math.min(4_096, Math.max(256, Math.trunc(configuredTokens)))
    : defaults.maxTokens

  return {
    phase,
    reasoningEffort: configuredReasoning as N8nVideoReasoningEffort,
    maxTokens,
  }
}

export function compatibleReasoningPayload(
  reasoningEffort: N8nVideoReasoningEffort,
): { enable_thinking: boolean; reasoning_effort?: Exclude<N8nVideoReasoningEffort, 'off'> } {
  if (reasoningEffort === 'off') return { enable_thinking: false }
  return { enable_thinking: true, reasoning_effort: reasoningEffort }
}

export function mediaInboxRoot(): string {
  return resolve(String(process.env.AIWORKER_MEDIA_INGEST_DIR || '').trim()
    || join(homedir(), 'ai-worker/state/video-autoworker/media-inbox'))
}

export function mediaWorkRoot(): string {
  return resolve(String(process.env.AIWORKER_MEDIA_WORK_DIR || '').trim()
    || join(config.dataDir, 'media-tasks'))
}

export function mediaTaskWorkspace(taskId: string): string {
  const digest = createHash('sha256').update(taskId).digest('hex')
  return join(mediaWorkRoot(), digest)
}

export function mediaChildIdentity(prefix: 'task' | 'idem', taskId: string, stage: N8nMediaStage): string {
  const digest = createHash('sha256').update(`${taskId}:${stage}`).digest('hex').slice(0, 24)
  return `media-${prefix}:${taskId.slice(0, 70)}:${stage}:${digest}`.slice(0, 120)
}

function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxBuffer?: number },
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer || 2 * 1024 * 1024,
      encoding: 'utf8',
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const failure = error as Error & { stdout?: string; stderr?: string }
        failure.stdout = String(stdout || '')
        failure.stderr = String(stderr || '')
        reject(failure)
        return
      }
      resolvePromise({ stdout: String(stdout || ''), stderr: String(stderr || '') })
    })
  })
}

function commandFailure(error: unknown, fallback: string): Error {
  return new SafeOperationError('N8N_MEDIA_COMMAND_FAILED', {
    operation: fallback,
    failure: sanitizeOperationalDiagnostic(error),
  })
}

function ffmpegCommand(): string {
  const configured = String(process.env.AIWORKER_FFMPEG_BIN || '').trim()
  if (configured) return expandHome(configured)
  return join(homedir(), 'ai-worker/bin/ffmpeg')
}

function parseDuration(stderr: string): number {
  const match = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/)
  if (!match) throw new Error('无法从视频容器读取时长')
  const duration = Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3])
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('视频时长无效')
  return duration
}

async function probeMedia(ffmpeg: string, sourcePath: string) {
  let stderr = ''
  try {
    const result = await runCommand(ffmpeg, ['-nostdin', '-hide_banner', '-i', sourcePath], {
      timeoutMs: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    stderr = result.stderr
  } catch (error) {
    stderr = String((error as { stderr?: string }).stderr || '')
    if (!stderr.includes('Duration:')) throw commandFailure(error, '视频容器探测失败')
  }
  return {
    durationSeconds: parseDuration(stderr),
    hasVideo: /Stream #[^\n]*Video:/i.test(stderr),
    hasAudio: /Stream #[^\n]*Audio:/i.test(stderr),
  }
}

async function assertControlledSource(videoKey: string) {
  const parsedKey = videoKeySchema.parse(videoKey)
  const inbox = mediaInboxRoot()
  await mkdir(inbox, { recursive: true, mode: 0o700 })
  await chmod(inbox, 0o700)
  const resolvedInbox = await realpath(inbox)
  const candidate = join(resolvedInbox, parsedKey)
  const sourcePath = await realpath(candidate)
  if (dirname(sourcePath) !== resolvedInbox || basename(sourcePath) !== parsedKey) {
    throw new Error('视频文件不在受控收件箱中')
  }
  const sourceStat = await stat(sourcePath)
  if (!sourceStat.isFile() || sourceStat.size <= 0) throw new Error('视频文件无效')
  await assertMediaCapacity({ sourcePath, destinationRoot: inbox })
  return { sourcePath, sourceBytes: sourceStat.size }
}

async function writeMetadata(workspace: string, metadata: MediaMetadata) {
  const path = join(workspace, 'metadata.json')
  const temporaryPath = `${path}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

async function readMetadata(taskId: string): Promise<MediaMetadata> {
  const raw = await readFile(join(mediaTaskWorkspace(taskId), 'metadata.json'), 'utf8')
  const parsed = JSON.parse(raw) as MediaMetadata
  if (parsed.taskId !== taskId || parsed.kind !== 'prepared-video') {
    throw new Error('媒体工作区与父任务不匹配')
  }
  return parsed
}

function preparedOutput(metadata: MediaMetadata): PreparedMedia {
  return {
    kind: metadata.kind,
    durationSeconds: metadata.durationSeconds,
    sourceBytes: metadata.sourceBytes,
    audioAvailable: metadata.audioAvailable,
    frameCount: metadata.frameCount,
    segmentCount: metadata.segmentCount,
    segmentSeconds: metadata.segmentSeconds,
    memoryMode: 'none',
  }
}

async function readExistingMetadata(taskId: string): Promise<MediaMetadata | null> {
  try {
    const metadata = await readMetadata(taskId)
    if (!Array.isArray(metadata.segments) || !metadata.segments.length) return null
    return metadata
  } catch {
    return null
  }
}

function segmentTimeLabel(segment: MediaSegment): string {
  const format = (milliseconds: number) => {
    const hours = Math.floor(milliseconds / 3_600_000)
    const minutes = Math.floor((milliseconds % 3_600_000) / 60_000)
    const seconds = Math.floor((milliseconds % 60_000) / 1_000)
    const remainder = milliseconds % 1_000
    return `${[hours, minutes, seconds]
      .map(item => String(item).padStart(2, '0')).join(':')}.${String(remainder).padStart(3, '0')}`
  }
  const startMilliseconds = Math.max(0, Math.round(segment.startSeconds * 1_000))
  // Keep every positive tail window representable by the millisecond contract.
  // Independent flooring used to collapse a 120.0-120.5s tail to 00:02:00-00:02:00,
  // which the director-evidence projector correctly rejected as a zero-length range.
  const endMilliseconds = Math.max(
    startMilliseconds + 1,
    Math.round((segment.startSeconds + segment.durationSeconds) * 1_000),
  )
  return `${format(startMilliseconds)}-${format(endMilliseconds)}`
}

export function buildMediaSegmentWindows(durationSeconds: number, segmentSeconds: number): MediaSegmentWindow[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('视频时长无效')
  if (!Number.isInteger(segmentSeconds) || segmentSeconds <= 0) throw new Error('分段时长无效')
  const segmentCount = Math.max(1, Math.ceil(durationSeconds / segmentSeconds))
  return Array.from({ length: segmentCount }, (_, index) => ({
    index: index + 1,
    startSeconds: index * segmentSeconds,
    durationSeconds: Math.min(segmentSeconds, durationSeconds - index * segmentSeconds),
  }))
}

async function writeCheckpoint(workspace: string, name: string, value: Record<string, unknown>) {
  const checkpointDir = join(workspace, 'checkpoints')
  await mkdir(checkpointDir, { recursive: true, mode: 0o700 })
  const path = join(checkpointDir, name)
  const temporaryPath = `${path}.tmp-${process.pid}`
  await writeFile(temporaryPath, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporaryPath, path)
  await chmod(path, 0o600)
}

async function readCheckpoint(
  workspace: string,
  name: string,
  validate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(join(workspace, 'checkpoints', name), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) && validate(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

export async function prepareN8nMedia(
  taskId: string,
  routing: Record<string, unknown>,
  input: Record<string, unknown>,
): Promise<PreparedMedia> {
  const settings = mediaConfig(routing)
  const videoKey = videoKeySchema.parse(input.videoKey)
  const cached = await readExistingMetadata(taskId)
  if (cached) {
    const orphanedSource = await assertControlledSource(videoKey).catch(() => null)
    if (orphanedSource) await unlink(orphanedSource.sourcePath).catch(() => undefined)
    return preparedOutput(cached)
  }

  const { sourcePath, sourceBytes } = await assertControlledSource(videoKey)
  const ffmpeg = ffmpegCommand()
  await access(ffmpeg, constants.X_OK)
  const workspace = mediaTaskWorkspace(taskId)
  await mkdir(mediaWorkRoot(), { recursive: true, mode: 0o700 })
  await chmod(mediaWorkRoot(), 0o700)
  await rm(workspace, { recursive: true, force: true })
  await mkdir(workspace, { recursive: false, mode: 0o700 })

  const probe = await probeMedia(ffmpeg, sourcePath)
  if (!probe.hasVideo) throw new Error('输入文件没有可分析的视频流')
  if (probe.durationSeconds > settings.maxDurationSeconds) {
    throw new Error(`视频时长超过 ${settings.maxDurationSeconds} 秒上限`)
  }
  const timeoutMs = Math.min(60 * 60_000, Math.max(60_000, Math.ceil(probe.durationSeconds * 4_000)))
  const audioSourcePath = join(workspace, 'audio.wav')
  if (probe.hasAudio) {
    try {
      await runCommand(ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioSourcePath,
      ], { timeoutMs })
    } catch (error) {
      throw commandFailure(error, '视频音轨提取失败')
    }
  }

  const segmentWindows = buildMediaSegmentWindows(probe.durationSeconds, settings.segmentSeconds)
  const segmentCount = segmentWindows.length
  const segments: MediaSegment[] = []
  let frameCount = 0
  for (const window of segmentWindows) {
    const index = window.index - 1
    const { startSeconds, durationSeconds } = window
    const prefix = `segment-${String(index + 1).padStart(3, '0')}`
    const segmentDir = join(workspace, prefix)
    await mkdir(segmentDir, { recursive: true, mode: 0o700 })
    let audioFile: string | null = null
    if (probe.hasAudio) {
      audioFile = join(prefix, 'audio.wav')
      const extendedDuration = Math.min(
        durationSeconds + settings.segmentOverlapSeconds,
        probe.durationSeconds - startSeconds,
      )
      try {
        await runCommand(ffmpeg, [
          '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
          '-ss', String(startSeconds), '-t', String(extendedDuration), '-i', audioSourcePath,
          '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', join(workspace, audioFile),
        ], { timeoutMs: Math.max(60_000, Math.ceil(extendedDuration * 2_000)) })
      } catch (error) {
        throw commandFailure(error, `第 ${index + 1} 段音频切分失败`)
      }
    }

    const frameFiles: string[] = []
    const scenePattern = join(segmentDir, 'scene-%02d.jpg')
    try {
      await runCommand(ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', String(startSeconds), '-t', String(durationSeconds), '-i', sourcePath, '-an',
        '-vf', `select=gt(scene\\,0.20),scale=${settings.frameWidth}:-2:force_original_aspect_ratio=decrease`,
        '-fps_mode', 'vfr', '-frames:v', String(settings.maxKeyframesPerSegment), '-q:v', '3', scenePattern,
      ], { timeoutMs: Math.max(60_000, Math.ceil(durationSeconds * 2_000)) })
    } catch {
      // Some videos have no scene boundary in a minute; uniform fallback below is authoritative.
    }
    const sceneFrames = (await readdir(segmentDir))
      .filter(name => /^scene-\d{2}\.jpg$/.test(name)).sort()
      .map(name => join(prefix, name))
    frameFiles.push(...sceneFrames.slice(0, settings.maxKeyframesPerSegment))

    if (frameFiles.length < settings.maxKeyframesPerSegment) {
      const needed = settings.maxKeyframesPerSegment - frameFiles.length
      try {
        await runCommand(ffmpeg, [
          '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
          '-ss', String(startSeconds), '-t', String(durationSeconds), '-i', sourcePath, '-an',
          '-vf', `fps=${Math.max(0.001, needed / durationSeconds)},scale=${settings.frameWidth}:-2:force_original_aspect_ratio=decrease`,
          '-frames:v', String(needed), '-q:v', '3', join(segmentDir, 'uniform-%02d.jpg'),
        ], { timeoutMs: Math.max(60_000, Math.ceil(durationSeconds * 2_000)) })
      } catch (error) {
        if (!frameFiles.length) throw commandFailure(error, `第 ${index + 1} 段画面抽帧失败`)
      }
      const uniformFrames = (await readdir(segmentDir))
        .filter(name => /^uniform-\d{2}\.jpg$/.test(name)).sort()
        .map(name => join(prefix, name))
      frameFiles.push(...uniformFrames.slice(0, needed))
    }
    if (!frameFiles.length) throw new Error(`第 ${index + 1} 段画面抽帧结果为空`)
    frameCount += frameFiles.length
    segments.push({
      index: index + 1,
      startSeconds: Math.round(startSeconds * 1000) / 1000,
      durationSeconds: Math.round(durationSeconds * 1000) / 1000,
      audioFile,
      frameFiles,
    })
  }

  await unlink(audioSourcePath).catch(() => undefined)
  const metadata: MediaMetadata = {
    taskId,
    kind: 'prepared-video',
    durationSeconds: Math.round(probe.durationSeconds * 1000) / 1000,
    sourceBytes,
    audioAvailable: probe.hasAudio,
    frameCount,
    segmentCount,
    segmentSeconds: settings.segmentSeconds,
    segments,
    memoryMode: 'none',
    preparedAt: new Date().toISOString(),
  }
  await writeMetadata(workspace, metadata)
  await unlink(sourcePath).catch(() => undefined)
  return preparedOutput(metadata)
}

function resolveAudioResource(routing: Record<string, unknown>): CliAudioResource {
  const settings = mediaConfig(routing)
  const registry = loadN8nModelRegistry()
  if (registry.errors.length) throw new Error(`模型注册表无效：${registry.errors.join('；')}`)
  const resource = registry.resources.find(item => item.id === settings.audioResourceId)
  if (!resource) throw new Error(`音频模型资源未登记：${settings.audioResourceId}`)
  if (!resource.enabled || resource.kind !== 'speech-recognition' || resource.runtime.type !== 'cli') {
    throw new Error(`音频模型资源不可执行：${settings.audioResourceId}`)
  }
  if (!resource.capabilities.includes('transcription')) {
    throw new Error(`音频模型资源不具备 transcription 能力：${settings.audioResourceId}`)
  }
  return resource as CliAudioResource
}

export async function transcribeN8nMedia(
  taskId: string,
  routing: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const metadata = await readMetadata(taskId)
  const settings = mediaConfig(routing)
  const resource = resolveAudioResource(routing)
  if (!metadata.audioAvailable) {
    return {
      transcript: '',
      skipped: true,
      reason: '视频没有音轨',
      resourceId: resource.id,
      model: resource.model,
      memoryMode: 'none',
    }
  }
  const command = expandHome(resource.runtime.command)
  await access(command, constants.X_OK)
  const workspace = mediaTaskWorkspace(taskId)
  const segments: Record<string, unknown>[] = []
  for (const segment of metadata.segments) {
    if (!segment.audioFile) continue
    const checkpointName = `audio-${String(segment.index).padStart(3, '0')}.json`
    let segmentResult = await readCheckpoint(workspace, checkpointName, value => (
      value.index === segment.index && typeof value.transcript === 'string'
    ))
    if (!segmentResult) {
      const audioPath = join(workspace, segment.audioFile)
      await access(audioPath, constants.R_OK)
      let result: CommandResult
      try {
        result = await runCommand(command, [
          '--model', resource.model,
          '--language', settings.language,
          '--max-chars', String(settings.maxTranscriptCharsPerSegment),
          audioPath,
        ], {
          timeoutMs: Math.min(15 * 60_000, Math.max(60_000, Math.ceil(segment.durationSeconds * 8_000))),
          maxBuffer: 2 * 1024 * 1024,
        })
      } catch (error) {
        throw commandFailure(error, `第 ${segment.index} 段音频模型转写失败`)
      }
      const transcript = result.stdout.trim().slice(0, settings.maxTranscriptCharsPerSegment)
      if (!transcript) throw new Error(`第 ${segment.index} 段音频模型返回空转写`)
      segmentResult = {
        index: segment.index,
        startSeconds: segment.startSeconds,
        durationSeconds: segment.durationSeconds,
        timeRange: segmentTimeLabel(segment),
        transcript,
      }
      await writeCheckpoint(workspace, checkpointName, segmentResult)
    }
    segments.push(segmentResult)
  }
  const transcript = segments.map(segment => (
    `[${segment.timeRange}]\n${String(segment.transcript || '').trim()}`
  )).join('\n\n').slice(0, settings.maxTranscriptChars)
  if (!transcript) throw new Error('音频模型返回空转写')
  return {
    transcript,
    segments,
    segmentCount: segments.length,
    skipped: false,
    resourceId: resource.id,
    model: resource.model,
    transport: 'cli',
    memoryMode: 'none',
  }
}

function assertVisionRoute(route: N8nModelRoute): Extract<N8nModelRoute, { transport: 'openai-compatible' }> {
  if (route.transport !== 'openai-compatible') {
    throw new Error('视频画面节点必须使用无会话的 OpenAI-compatible 直连路由')
  }
  if (!route.capabilities.includes('vision')) {
    throw new Error(`视频画面路由不具备 vision 能力：${route.id}`)
  }
  return route
}

async function callCompatibleModel(
  route: Extract<N8nModelRoute, { transport: 'openai-compatible' }>,
  apiKey: string,
  content: unknown,
  failurePrefix: string,
  options: {
    maxTokens?: number
    timeoutSeconds?: number
    reasoningEffort?: N8nVideoReasoningEffort
    phase?: N8nVideoModelPhase
  } = {},
): Promise<any> {
  const maxTokens = options.maxTokens ?? route.maxTokens
  const timeoutSeconds = options.timeoutSeconds ?? route.timeoutSeconds
  const response = await fetch(`${route.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: route.model,
      messages: [
        { role: 'system', content: '你是无状态视频分析工作节点，只处理当前请求，不读取或写入任何会话记忆。' },
        { role: 'user', content },
      ],
      ...(route.temperature === undefined ? {} : { temperature: route.temperature }),
      ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
      ...(options.reasoningEffort === undefined
        ? {}
        : compatibleReasoningPayload(options.reasoningEffort)),
      ...(options.phase === undefined ? {} : { aiworker_stage: options.phase }),
    }),
    signal: AbortSignal.timeout(timeoutSeconds * 1_000),
  })
  const raw = await response.text()
  let parsed: any = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    // The bounded raw fragment below is enough to diagnose a malformed response.
  }
  if (!response.ok) {
    const detail = String(parsed?.error?.message || raw || `HTTP ${response.status}`).slice(0, 2_000)
    throw new SafeOperationError('N8N_MEDIA_MODEL_HTTP_FAILED', {
      operation: failurePrefix,
      statusCode: response.status,
      detail,
    })
  }
  return parsed
}

interface CompatibleRouteAttempt {
  payload: any
  validated?: unknown
  route: Extract<N8nModelRoute, { transport: 'openai-compatible' }>
  routeIndex: number
}

/**
 * Resolve the declared route candidates once, then use them as a bounded
 * same-task failover chain. Route selection previously only checked whether a
 * route was configured before the request; a mid-request Qwen failure could
 * therefore fail an otherwise recoverable video even when its binding had a
 * tested fallback route. The caller keeps the returned routeIndex for the
 * rest of the current stage so a sick primary endpoint is not hammered for
 * every remaining segment.
 */
function compatibleRouteCandidates(
  resolved: ReturnType<typeof resolveN8nNodeRoute>,
): Array<Extract<N8nModelRoute, { transport: 'openai-compatible' }>> {
  const registry = loadN8nModelRegistry()
  const byId = new Map(registry.routes.map(route => [route.id, route]))
  const ids = resolved.candidates.length
    ? resolved.candidates
    : [resolved.route.id]
  const ordered = [resolved.route.id, ...ids.filter(id => id !== resolved.route.id)]
  const candidates: Array<Extract<N8nModelRoute, { transport: 'openai-compatible' }>> = []
  for (const id of ordered) {
    const route = byId.get(id) || (id === resolved.route.id ? resolved.route : null)
    if (!route || route.transport !== 'openai-compatible') continue
    if (!route.capabilities.includes('vision')) continue
    if (!publicN8nModelRoute(route).available) continue
    if (!candidates.some(candidate => candidate.id === route.id)) candidates.push(route)
  }
  return candidates
}

async function callCompatibleModelWithFallback(
  resolved: ReturnType<typeof resolveN8nNodeRoute>,
  candidates: Array<Extract<N8nModelRoute, { transport: 'openai-compatible' }>>,
  startRouteIndex: number,
  content: unknown,
  failurePrefix: string,
  options: Parameters<typeof callCompatibleModel>[4] = {},
  validatePayload?: (payload: any) => unknown,
): Promise<CompatibleRouteAttempt> {
  const errors: string[] = []
  const start = Math.max(0, Math.min(startRouteIndex, Math.max(0, candidates.length - 1)))
  for (let routeIndex = start; routeIndex < candidates.length; routeIndex += 1) {
    const route = candidates[routeIndex]
    try {
      assertVisionRoute(route)
      const apiKey = route.apiKeyEnv ? String(process.env[route.apiKeyEnv] || '').trim() : ''
      if (route.apiKeyEnv && !apiKey) throw new Error(`缺少外部凭据引用 ${route.apiKeyEnv}`)
      const payload = await callCompatibleModel(route, apiKey, content, failurePrefix, options)
      const validated = validatePayload ? validatePayload(payload) : undefined
      return { payload, validated, route, routeIndex }
    } catch (error) {
      const projection = projectSafeOperationError(error, 'N8N_MEDIA_MODEL_HTTP_FAILED')
      logSafeOperationError('media_model_route_attempt', error, projection)
      errors.push(`${route.id}: ${sanitizeOperationalDiagnostic(error, 600)}`)
    }
  }
  const configured = resolved.candidates.length ? resolved.candidates.join('、') : resolved.route.id
  throw new SafeOperationError('N8N_MEDIA_MODEL_HTTP_FAILED', {
    operation: failurePrefix,
    configuredRoutes: configured,
    attempts: errors,
  })
}

/**
 * Qwen visual checkpoints may contain a private reasoning block before the
 * user-facing answer. Persisting that block makes the next synthesis prompt
 * unnecessarily large and can push a slow local runtime past its callback
 * deadline. Keep only the visible answer while preserving the raw text when
 * the model did not emit a complete reasoning marker.
 */
export function visibleModelAnswer(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) return ''
  const closing = raw.lastIndexOf('</think>')
  if (closing >= 0) return raw.slice(closing + '</think>'.length).trim()
  return raw.replace(/<think>[\s\S]*$/i, '').trim() || raw
}

function uniquePerceptionValues(values: string[]): string[] {
  return [...new Set(values.map(value => value.replace(/\s+/gu, ' ').trim()).filter(Boolean))]
}

/**
 * Parse the factual visual node's bounded JSON response.  The parser accepts
 * an optional Markdown fence because several OpenAI-compatible runtimes add
 * one even when explicitly asked for JSON, but it rejects prose before or
 * after the object and never infers missing fields.
 */
export function parseVisualPerceptionAnswer(value: unknown): N8nVisualPerception {
  const visible = visibleModelAnswer(value)
  const unfenced = visible
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced)
  } catch {
    throw new Error('视频画面模型返回无法解析的结构化结果')
  }
  const result = visualPerceptionSchema.safeParse(parsed)
  if (!result.success) throw new Error('视频画面模型返回不符合结构化感知契约')
  return {
    ...result.data,
    people: uniquePerceptionValues(result.data.people),
    locations: uniquePerceptionValues(result.data.locations),
    actions: uniquePerceptionValues(result.data.actions),
    objects: uniquePerceptionValues(result.data.objects),
    environment: uniquePerceptionValues(result.data.environment),
    ocr: uniquePerceptionValues(result.data.ocr),
    shotTypes: uniquePerceptionValues(result.data.shotTypes),
    cameraMovement: uniquePerceptionValues(result.data.cameraMovement),
    composition: uniquePerceptionValues(result.data.composition),
    emotion: uniquePerceptionValues(result.data.emotion),
  }
}

export function parseDirectorSynthesisAnswer(value: unknown): N8nDirectorPerception {
  const visible = visibleModelAnswer(value)
  const unfenced = visible
    .replace(/^```(?:json)?\s*/iu, '')
    .replace(/\s*```$/u, '')
    .trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced)
  } catch {
    throw new Error('视频汇总模型返回无法解析的结构化结果')
  }
  const result = directorPerceptionSchema.safeParse(parsed)
  if (!result.success) throw new Error('视频汇总模型返回不符合导演感知契约')
  return {
    ...result.data,
    people: uniquePerceptionValues(result.data.people),
    locations: uniquePerceptionValues(result.data.locations),
    actions: uniquePerceptionValues(result.data.actions),
    objects: uniquePerceptionValues(result.data.objects),
    environment: uniquePerceptionValues(result.data.environment),
    ocr: uniquePerceptionValues(result.data.ocr),
    shotTypes: uniquePerceptionValues(result.data.shotTypes),
    cameraMovement: uniquePerceptionValues(result.data.cameraMovement),
    composition: uniquePerceptionValues(result.data.composition),
    emotion: uniquePerceptionValues(result.data.emotion),
  }
}

export async function analyzeN8nVideoFrames(
  taskId: string,
  routing: Record<string, unknown>,
  taskInput: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const metadata = await readMetadata(taskId)
  const resolved = resolveN8nNodeRoute(routing, 'vision')
  const candidates = compatibleRouteCandidates(resolved)
  if (!candidates.length) throw new Error('视频画面节点没有可用的 OpenAI-compatible 路由')
  const route = assertVisionRoute(candidates[0])
  const workspace = mediaTaskWorkspace(taskId)
  const prompt = String(taskInput.prompt || '分析视频画面中的人物、场景、动作、文字和事件，并按时间顺序概括。').trim()
  const generation = videoModelGenerationProfile('vision')
  const segments: Record<string, unknown>[] = []
  let totalFrames = 0
  let activeRouteIndex = 0
  for (const segment of metadata.segments) {
    const checkpointName = `vision-${String(segment.index).padStart(3, '0')}.json`
    let segmentResult = await readCheckpoint(workspace, checkpointName, value => (
      value.index === segment.index && typeof value.analysis === 'string'
    ))
    if (!segmentResult) {
      const images = await Promise.all(segment.frameFiles.map(async name => {
        const buffer = await readFile(join(workspace, name))
        if (buffer.byteLength > 4 * 1024 * 1024) throw new Error(`抽帧文件过大：${name}`)
        return `data:image/jpeg;base64,${buffer.toString('base64')}`
      }))
      if (!images.length) throw new Error(`第 ${segment.index} 段没有可供画面模型分析的抽帧`)
      const content = [
        {
          type: 'text',
          text: [
            resolved.instruction || '你是无状态的视频画面分析节点，只根据本次提供的抽帧作答。',
            `当前片段时间为 ${segmentTimeLabel(segment)}，提供 ${images.length} 张按时间排序的关键帧。`,
            `业务要求：${prompt.slice(0, 4_000)}`,
            '只记录画面能够确认的事实，不要分析音频，不要引用历史会话或长期记忆。',
            '只输出一个 JSON 对象，不要代码围栏或额外文字。对象必须恰好包含这些字段：',
            '{"summary":"简短画面事实","people":[],"locations":[],"actions":[],"objects":[],"environment":[],"ocr":[],"shotTypes":[],"cameraMovement":[],"composition":[],"emotion":[]}',
            '无法确认的数组保持为空；不得用猜测补齐。',
          ].join('\n'),
        },
        ...images.map(url => ({ type: 'image_url', image_url: { url } })),
      ]
      const attempt = await callCompatibleModelWithFallback(
        resolved,
        candidates,
        activeRouteIndex,
        content,
        '视频画面模型调用失败',
        {
          maxTokens: generation.maxTokens,
          reasoningEffort: generation.reasoningEffort,
          phase: generation.phase,
        },
        payload => parseVisualPerceptionAnswer(payload?.choices?.[0]?.message?.content),
      )
      activeRouteIndex = attempt.routeIndex
      const perception = attempt.validated as N8nVisualPerception
      segmentResult = {
        index: segment.index,
        startSeconds: segment.startSeconds,
        durationSeconds: segment.durationSeconds,
        timeRange: segmentTimeLabel(segment),
        analysis: perception.summary,
        perception,
        frameCount: images.length,
        routeId: attempt.route.id,
      }
      await writeCheckpoint(workspace, checkpointName, segmentResult)
    }
    totalFrames += Number(segmentResult.frameCount || segment.frameFiles.length)
    segments.push(segmentResult)
  }
  const analysis = segments.map(segment => (
    `[${segment.timeRange}]\n${String(segment.analysis || '').trim()}`
  )).join('\n\n').slice(0, 100_000)
  return {
    analysis,
    segments,
    segmentCount: segments.length,
    frameCount: totalFrames,
    routeId: candidates[activeRouteIndex]?.id || route.id,
    routeCandidates: candidates.map(candidate => candidate.id),
    fallbackUsed: activeRouteIndex > 0,
    model: candidates[activeRouteIndex]?.model || route.model,
    location: candidates[activeRouteIndex]?.location || route.location,
    transport: candidates[activeRouteIndex]?.transport || route.transport,
    generation: {
      reasoningEffort: generation.reasoningEffort,
      maxTokens: generation.maxTokens,
    },
    memoryMode: 'none',
  }
}

export function mergeN8nMediaResults(
  audio: Record<string, unknown>,
  vision: Record<string, unknown>,
): Record<string, unknown> {
  const transcript = String(audio.transcript || '').trim()
  const visualAnalysis = String(vision.analysis || '').trim()
  const audioSegments = Array.isArray(audio.segments) ? audio.segments : []
  const visionSegments = Array.isArray(vision.segments) ? vision.segments : []
  const segmentIndexes = new Set<number>()
  for (const segment of [...audioSegments, ...visionSegments]) {
    const index = Number(objectValue(segment).index)
    if (Number.isInteger(index) && index > 0) segmentIndexes.add(index)
  }
  const timeline = [...segmentIndexes].sort((a, b) => a - b).map(index => {
    const audioSegment = objectValue(audioSegments.find(item => Number(objectValue(item).index) === index))
    const visionSegment = objectValue(visionSegments.find(item => Number(objectValue(item).index) === index))
    const suppliedConfidence = [audioSegment.confidence, visionSegment.confidence]
      .map(Number)
      .filter(value => Number.isFinite(value) && value >= 0 && value <= 1)
    return {
      index,
      timeRange: String(audioSegment.timeRange || visionSegment.timeRange || ''),
      transcript: String(audioSegment.transcript || ''),
      visualAnalysis: String(visionSegment.analysis || ''),
      ...(visionSegment.perception && typeof visionSegment.perception === 'object'
        && !Array.isArray(visionSegment.perception)
        ? { perception: visionSegment.perception }
        : {}),
      // Existing Whisper and visual routes do not expose calibrated
      // probabilities. Persist 0 (unknown) instead of inventing certainty;
      // future calibrated routes may supply a bounded value per segment.
      confidence: suppliedConfidence.length ? Math.min(...suppliedConfidence) : 0,
    }
  })
  const timelineText = timeline.map(segment => [
    `【${segment.timeRange || `片段 ${segment.index}`}】`,
    `语音：${segment.transcript || '无可用转写'}`,
    `画面：${segment.visualAnalysis || '无可用画面分析'}`,
  ].join('\n')).join('\n\n')
  return {
    taskType: 'video-analysis',
    audio,
    vision,
    timeline,
    combinedText: [
      timelineText || [
        '【音频分析】',
        transcript || '未检测到可转写音轨。',
        '',
        '【画面分析】',
        visualAnalysis || '画面分析结果为空。',
      ].join('\n'),
    ].join('\n'),
    workers: {
      audio: { model: audio.model || null, memoryMode: 'none' },
      vision: { model: vision.model || null, memoryMode: 'none' },
    },
    memoryMode: 'none',
    persistence: 'operational-task-record-only',
  }
}

const segmentSummaryCheckpointSchema = z.object({
  schema: z.literal('video-autoworker-segment-summary'),
  version: z.literal(1),
  index: z.number().int().positive(),
  sourceName: z.string(),
  timeRange: z.string(),
  startTime: z.string(),
  endTime: z.string(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  summary: z.string().trim().min(1).max(4_000),
  directorPerception: directorPerceptionSchema,
  confidence: z.number().min(0).max(1),
  routeId: z.string(),
}).strict().refine(value => value.summary === value.directorPerception.summary)

type SegmentSummary = z.infer<typeof segmentSummaryCheckpointSchema>

// Hash semantic inputs in a stable order. Credentials never enter checkpoints.
function stableSynthesisValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSynthesisValue)
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, stableSynthesisValue(entry)]),
  )
  return value
}

function synthesisDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(stableSynthesisValue(value))).digest('hex')
}

/** The existing director contract is a bounded index, not the complete evidence.
 * Preserve every verified fact in segmentSummaries and explicitly report index
 * overflow instead of pretending a capped whole-video catalog is exhaustive. */
function indexSegmentPerceptions(segments: SegmentSummary[], summary: string) {
  const limits = {
    people: 20, locations: 12, actions: 20, objects: 20, environment: 12,
    ocr: 20, shotTypes: 12, cameraMovement: 12, composition: 12, emotion: 12,
  } as const
  const perception: Record<string, unknown> = { summary }
  const coverage: Record<string, { total: number; indexed: number }> = {}
  for (const [field, limit] of Object.entries(limits)) {
    const key = field as keyof typeof limits
    const facts = uniquePerceptionValues(segments.flatMap(segment => segment.directorPerception[key]))
    perception[field] = facts.slice(0, limit)
    coverage[field] = { total: facts.length, indexed: Math.min(facts.length, limit) }
  }
  const sound: Record<string, string | null> = {}
  for (const key of ['speechSummary', 'ambientSound', 'music', 'emotion'] as const) {
    const facts = uniquePerceptionValues(segments.flatMap(segment => {
      const value = segment.directorPerception.sound[key]
      return value ? [value] : []
    }))
    const indexed: string[] = []
    for (const fact of facts) {
      if ([...indexed, fact].join('；').length > 1_000) break
      indexed.push(fact)
    }
    sound[key] = indexed.join('；') || null
    coverage[`sound.${key}`] = { total: facts.length, indexed: indexed.length }
  }
  perception.sound = sound
  return {
    directorPerception: directorPerceptionSchema.parse(perception),
    directorPerceptionCoverage: {
      kind: 'bounded-index', complete: Object.values(coverage).every(value => value.total === value.indexed),
      fullEvidence: 'segmentSummaries[].directorPerception', fields: coverage,
    },
  }
}

export async function synthesizeN8nMediaResults(
  taskId: string,
  routing: Record<string, unknown>,
  taskInput: Record<string, unknown>,
  merged: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeline = Array.isArray(merged.timeline) ? merged.timeline.map(objectValue) : []
  if (!timeline.length) return merged
  const workspace = mediaTaskWorkspace(taskId)
  // A completed historical report is immutable evidence. Do not re-infer it
  // merely to populate a newer shape, or require a still-available model route.
  const storedFinal = await readCheckpoint(workspace, 'final-summary.json', value => (
    finalSummaryCheckpointSchema.safeParse(value).success
  ))
  if (storedFinal) {
    const historical = finalSummaryCheckpointSchema.parse(storedFinal)
    const chapters: Record<string, unknown>[] = []
    for (let index = 1; index <= Math.ceil(timeline.length / 5); index++) {
      const chapter = await readCheckpoint(workspace, `chapter-${String(index).padStart(3, '0')}.json`, value => (
        value.index === index && typeof value.summary === 'string'
      ))
      if (chapter) chapters.push(chapter)
    }
    return {
      ...merged, chapters, summary: historical.summary,
      directorPerception: historical.directorPerception,
      synthesis: { mode: 'historical-final-checkpoint', version: 1 },
      combinedText: historical.summary,
    }
  }
  const resolved = resolveN8nNodeRoute(routing, 'vision')
  const candidates = compatibleRouteCandidates(resolved)
  if (!candidates.length) throw new Error('视频片段摘要没有可用的 OpenAI-compatible 路由')
  const route = assertVisionRoute(candidates[0])
  const businessPrompt = String(taskInput.prompt || '综合语音和画面，按时间线分析视频内容。').trim()
  const sourceName = basename(String(taskInput.displayName || taskInput.originalFilename || taskInput.fileName || taskInput.videoName || taskInput.videoKey || taskId))
  // Retain the deployed generation knobs; the chapter phase now reconciles
  // one segment. No final/global model request is made by this pipeline.
  const generation = videoModelGenerationProfile('chapter')
  const timeoutSeconds = boundedIntegerEnv('AIWORKER_VIDEO_SYNTHESIS_TIMEOUT_SECONDS', route.timeoutSeconds, 60, 600)
  const modelIdentity = candidates.map(candidate => ({
    id: candidate.id, model: candidate.model, baseUrl: candidate.baseUrl,
    transport: candidate.transport, temperature: candidate.temperature,
  }))
  const segmentSummaries: SegmentSummary[] = []
  let activeRouteIndex = 0
  for (const [offset, segment] of timeline.entries()) {
    const index = offset + 1
    const timeRange = String(segment.timeRange || '')
    const transcript = String(segment.transcript || '')
    const visualAnalysis = visibleModelAnswer(segment.visualAnalysis)
    const inputSha256 = synthesisDigest({
      contract: 'segment-audiovisual-summary-v1', sourceName, index, segment,
      businessPrompt, generation, modelIdentity,
    })
    const checkpointName = `segment-summary-${String(index).padStart(3, '0')}.json`
    const cached = await readCheckpoint(workspace, checkpointName, value => (
      value.index === index && value.inputSha256 === inputSha256
      && segmentSummaryCheckpointSchema.safeParse(value).success
    ))
    if (cached) {
      const segmentSummary = segmentSummaryCheckpointSchema.parse(cached)
      segmentSummaries.push(segmentSummary)
      const cachedRouteIndex = candidates.findIndex(candidate => candidate.id === segmentSummary.routeId)
      if (cachedRouteIndex >= 0) activeRouteIndex = cachedRouteIndex
      continue
    }
    const prompt = [
      '仅为下面这一个视频片段生成独立摘要与结构化导演感知，不汇总其他片段。',
      `来源文件：${sourceName}；片段编号：${index}；时间：${timeRange}`,
      `业务要求：${businessPrompt}`,
      '语音和画面互相校验，说明事件、关键信息与不确定项；只记录有证据的事实，不推断未提供的音效或音乐。',
      '只输出 JSON，不要思考过程或额外文字；恰好包含：',
      '{"summary":"这个片段的独立摘要","people":[],"locations":[],"actions":[],"objects":[],"environment":[],"ocr":[],"shotTypes":[],"cameraMovement":[],"composition":[],"emotion":[],"sound":{"speechSummary":null,"ambientSound":null,"music":null,"emotion":null}}',
      '未知数组为空，未知声音字段为 null；各数组最多 12 项（人物、动作、物体和OCR最多20项），摘要不超过4000字，文字保持简练。',
      `语音：${transcript || '无可用转写'}`,
      `画面：${visualAnalysis || '无可用画面分析'}`,
      ...(segment.perception ? [`已验证画面感知：${JSON.stringify(segment.perception)}`] : []),
    ].join('\n\n')
    // Fail visibly for an abnormal single source instead of silently dropping
    // facts. Segment size, never video length, determines the request bound.
    if (Buffer.byteLength(prompt, 'utf8') > 128 * 1024) throw new Error(`片段 ${index} 输入超出单段摘要边界，需重新分段`)
    const attempt = await callCompatibleModelWithFallback(resolved, candidates, activeRouteIndex, prompt,
      `片段 ${index} 摘要失败`, {
        maxTokens: generation.maxTokens, timeoutSeconds,
        reasoningEffort: generation.reasoningEffort, phase: generation.phase,
      }, payload => {
        if (payload?.choices?.[0]?.finish_reason === 'length') throw new Error(`片段 ${index} 摘要输出被截断`)
        const perception = parseDirectorSynthesisAnswer(payload?.choices?.[0]?.message?.content)
        if (perception.summary.length > 4_000) throw new Error(`片段 ${index} 摘要超出长度边界`)
        return perception
      })
    activeRouteIndex = attempt.routeIndex
    const directorPerception = attempt.validated as N8nDirectorPerception
    const rawConfidence = Number(segment.confidence)
    const result = segmentSummaryCheckpointSchema.parse({
      schema: 'video-autoworker-segment-summary', version: 1,
      index, sourceName, timeRange, startTime: timeRange.split('-')[0] || '', endTime: timeRange.split('-')[1] || '',
      inputSha256, summary: directorPerception.summary, directorPerception,
      confidence: Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : 0,
      routeId: attempt.route.id,
    })
    await writeCheckpoint(workspace, checkpointName, result)
    segmentSummaries.push(result)
  }
  const summary = `已完成 ${segmentSummaries.length} 个片段的独立音画摘要。按文件名、片段编号与时间码保存；此处为索引概览，完整事实和不确定项见逐片段摘要，不代表全片叙事总结。`
  return {
    ...merged, segmentSummaries,
    timeline: timeline.map((segment, offset) => ({
      ...segment, segmentSummaryIndex: offset + 1, segmentSummaryInputSha256: segmentSummaries[offset].inputSha256,
    })),
    // Legacy readers may still use chapters: each entry now maps exactly to
    // one segment, not an inferred five-minute chapter.
    chapters: segmentSummaries.map(({ index, startTime, endTime, summary, confidence, inputSha256 }) => ({
      index, startTime, endTime, summary, confidence, inputSha256,
    })),
    summary, ...indexSegmentPerceptions(segmentSummaries, summary),
    synthesis: { mode: 'segment-summaries', version: 1, finalModelCall: false, chapterUnit: 'segment' },
    generation: { segment: { reasoningEffort: generation.reasoningEffort, maxTokens: generation.maxTokens } },
    routeId: candidates[activeRouteIndex]?.id || route.id,
    routeCandidates: candidates.map(candidate => candidate.id),
    fallbackUsed: segmentSummaries.some(segment => segment.routeId !== route.id),
    // Evidence stays in timeline/segmentSummaries for bounded reads and
    // deterministic exports, never in a second giant implicit prompt field.
    combinedText: summary,
  }
}

export async function cleanupN8nMediaTask(taskId: string): Promise<void> {
  if (
    typeof taskId !== 'string'
    || taskId.length < 1
    || taskId.length > 120
    || !/^[A-Za-z0-9._:-]+$/.test(taskId)
  ) {
    throw new Error('媒体清理任务标识无效')
  }

  const configuredRoot = mediaWorkRoot()
  let rootStat: Awaited<ReturnType<typeof lstat>>
  try {
    rootStat = await lstat(configuredRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('媒体工作区根目录类型不安全')
  }
  const controlledRoot = await realpath(configuredRoot)
  const digest = createHash('sha256').update(taskId).digest('hex')
  const workspace = join(controlledRoot, digest)
  if (dirname(workspace) !== controlledRoot || basename(workspace) !== digest) {
    throw new Error('媒体工作区清理路径越界')
  }

  let workspaceStat: Awaited<ReturnType<typeof lstat>>
  try {
    workspaceStat = await lstat(workspace)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  if (workspaceStat.isSymbolicLink() || !workspaceStat.isDirectory()) {
    throw new Error('媒体任务工作区类型不安全')
  }
  if (await realpath(workspace) !== workspace) {
    throw new Error('媒体任务工作区路径不受控')
  }

  const metadataPath = join(workspace, 'metadata.json')
  const metadataStat = await lstat(metadataPath)
  if (metadataStat.isSymbolicLink() || !metadataStat.isFile() || metadataStat.size > 2 * 1024 * 1024) {
    throw new Error('媒体任务工作区元数据无效')
  }
  let metadata: unknown
  try {
    metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
  } catch {
    throw new Error('媒体任务工作区元数据不可解析')
  }
  if (
    !metadata
    || typeof metadata !== 'object'
    || Array.isArray(metadata)
    || (metadata as { taskId?: unknown }).taskId !== taskId
    || (metadata as { kind?: unknown }).kind !== 'prepared-video'
  ) {
    throw new Error('媒体任务工作区与清理任务不匹配')
  }

  await rm(workspace, { recursive: true, force: false })
  try {
    await lstat(workspace)
    throw new Error('媒体任务工作区清理后仍然存在')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
