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
  // Chapter summaries reconcile five minutes of audio and visual evidence.
  chapter: { reasoningEffort: 'low', maxTokens: 1_024 },
  // The whole-video report keeps one deliberate reasoning pass for quality.
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
  const candidate = error as { stderr?: string; stdout?: string; message?: string }
  const detail = String(candidate?.stderr || candidate?.stdout || candidate?.message || fallback).trim()
  return new Error(detail.slice(0, 2_000) || fallback)
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
  const format = (seconds: number) => {
    const value = Math.max(0, Math.floor(seconds))
    const hours = Math.floor(value / 3_600)
    const minutes = Math.floor((value % 3_600) / 60)
    const remaining = value % 60
    return [hours, minutes, remaining].map(item => String(item).padStart(2, '0')).join(':')
  }
  return `${format(segment.startSeconds)}-${format(segment.startSeconds + segment.durationSeconds)}`
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
    throw new Error(`${failurePrefix}：${detail}`)
  }
  return parsed
}

interface CompatibleRouteAttempt {
  payload: any
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
      return { payload, route, routeIndex }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      errors.push(`${route.id}: ${detail.slice(0, 600)}`)
    }
  }
  const configured = resolved.candidates.length ? resolved.candidates.join('、') : resolved.route.id
  throw new Error(`${failurePrefix}（已尝试 ${configured}）：${errors.join('；')}`.slice(0, 2_000))
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
            '只输出画面可见的人物、场景、动作、文字和事件；不要分析音频。',
            '不要引用历史会话或长期记忆；无法从画面确认的内容要明确说明。',
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
      )
      activeRouteIndex = attempt.routeIndex
      const analysis = visibleModelAnswer(attempt.payload?.choices?.[0]?.message?.content)
      if (!analysis) throw new Error(`第 ${segment.index} 段画面模型返回空结果`)
      segmentResult = {
        index: segment.index,
        startSeconds: segment.startSeconds,
        durationSeconds: segment.durationSeconds,
        timeRange: segmentTimeLabel(segment),
        analysis: analysis.slice(0, 12_000),
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

export async function synthesizeN8nMediaResults(
  taskId: string,
  routing: Record<string, unknown>,
  taskInput: Record<string, unknown>,
  merged: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const timeline = Array.isArray(merged.timeline) ? merged.timeline.map(objectValue) : []
  if (!timeline.length) return merged
  const resolved = resolveN8nNodeRoute(routing, 'vision')
  const candidates = compatibleRouteCandidates(resolved)
  if (!candidates.length) throw new Error('视频汇总没有可用的 OpenAI-compatible 路由')
  const route = assertVisionRoute(candidates[0])
  const workspace = mediaTaskWorkspace(taskId)
  const businessPrompt = String(taskInput.prompt || '综合语音和画面，按时间线分析视频内容。').trim().slice(0, 4_000)
  const chapterSize = 5
  // Final synthesis is text-only but still runs through the local multimodal
  // runtime. Keep the output bounded so a reasoning-heavy Qwen response cannot
  // hold the n8n callback open until its HTTP retry window expires.
  const chapterGeneration = videoModelGenerationProfile('chapter')
  const finalGeneration = videoModelGenerationProfile('final')
  const synthesisTimeoutSeconds = boundedIntegerEnv(
    'AIWORKER_VIDEO_SYNTHESIS_TIMEOUT_SECONDS',
    route.timeoutSeconds,
    60,
    600,
  )
  const chapters: Record<string, unknown>[] = []
  let activeRouteIndex = 0
  for (let offset = 0; offset < timeline.length; offset += chapterSize) {
    const group = timeline.slice(offset, offset + chapterSize)
    const chapterIndex = Math.floor(offset / chapterSize) + 1
    const checkpointName = `chapter-${String(chapterIndex).padStart(3, '0')}.json`
    let chapter = await readCheckpoint(workspace, checkpointName, value => (
      value.index === chapterIndex && typeof value.summary === 'string'
    ))
    if (!chapter) {
      const source = group.map(segment => [
        `[${String(segment.timeRange || '')}]`,
        `语音：${String(segment.transcript || '').slice(0, 4_000) || '无'}`,
        `画面：${visibleModelAnswer(segment.visualAnalysis).slice(0, 4_000) || '无'}`,
      ].join('\n')).join('\n\n')
      const attempt = await callCompatibleModelWithFallback(resolved, candidates, activeRouteIndex, [
        '请把以下约 5 分钟的分段结果汇总为一个章节。',
        `业务要求：${businessPrompt}`,
        '语音与画面要相互校验；明确主要事件、人物/地点、关键信息与不确定项。不要虚构。只输出最终章节，不要输出思考过程。',
        source,
      ].join('\n\n'), `第 ${chapterIndex} 章汇总失败`, {
        maxTokens: chapterGeneration.maxTokens,
        timeoutSeconds: synthesisTimeoutSeconds,
        reasoningEffort: chapterGeneration.reasoningEffort,
        phase: chapterGeneration.phase,
      })
      activeRouteIndex = attempt.routeIndex
      const summary = visibleModelAnswer(attempt.payload?.choices?.[0]?.message?.content)
      if (!summary) throw new Error(`第 ${chapterIndex} 章汇总返回空结果`)
      chapter = {
        index: chapterIndex,
        startTime: String(group[0]?.timeRange || '').split('-')[0],
        endTime: String(group.at(-1)?.timeRange || '').split('-')[1],
        summary: summary.slice(0, 8_000),
        confidence: group.reduce((lowest, segment) => {
          const value = Number(segment.confidence)
          return Number.isFinite(value) && value >= 0 && value <= 1
            ? Math.min(lowest, value)
            : 0
        }, 1),
      }
      await writeCheckpoint(workspace, checkpointName, chapter)
    }
    const storedConfidence = Number(chapter.confidence)
    chapters.push({
      ...chapter,
      confidence: Number.isFinite(storedConfidence)
        && storedConfidence >= 0
        && storedConfidence <= 1
        ? storedConfidence
        : group.reduce((lowest, segment) => {
          const value = Number(segment.confidence)
          return Number.isFinite(value) && value >= 0 && value <= 1
            ? Math.min(lowest, value)
            : 0
        }, 1),
    })
  }

  let finalSummary = await readCheckpoint(workspace, 'final-summary.json', value => typeof value.summary === 'string')
  if (!finalSummary) {
    const attempt = await callCompatibleModelWithFallback(resolved, candidates, activeRouteIndex, [
      '根据下面的章节汇总，生成整部视频的最终分析报告。',
      `业务要求：${businessPrompt}`,
      '报告包含：一句话结论、内容主线、按时间章节、音画相互印证的关键证据、无法确认的信息。保持事实边界。只输出最终报告，不要输出思考过程。',
      chapters.map(chapter => `【${chapter.startTime}-${chapter.endTime}】\n${visibleModelAnswer(chapter.summary).slice(0, 8_000)}`).join('\n\n'),
    ].join('\n\n'), '全片汇总失败', {
      maxTokens: finalGeneration.maxTokens,
      timeoutSeconds: synthesisTimeoutSeconds,
      reasoningEffort: finalGeneration.reasoningEffort,
      phase: finalGeneration.phase,
    })
    activeRouteIndex = attempt.routeIndex
    const summary = visibleModelAnswer(attempt.payload?.choices?.[0]?.message?.content)
    if (!summary) throw new Error('全片汇总返回空结果')
    finalSummary = { summary: summary.slice(0, 16_000) }
    await writeCheckpoint(workspace, 'final-summary.json', finalSummary)
  }
  return {
    ...merged,
    chapters,
    summary: finalSummary.summary,
    generation: {
      chapter: {
        reasoningEffort: chapterGeneration.reasoningEffort,
        maxTokens: chapterGeneration.maxTokens,
      },
      final: {
        reasoningEffort: finalGeneration.reasoningEffort,
        maxTokens: finalGeneration.maxTokens,
      },
    },
    routeId: candidates[activeRouteIndex]?.id || route.id,
    routeCandidates: candidates.map(candidate => candidate.id),
    fallbackUsed: activeRouteIndex > 0,
    combinedText: `${String(finalSummary.summary)}\n\n【逐分钟证据】\n${String(merged.combinedText || '')}`,
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
