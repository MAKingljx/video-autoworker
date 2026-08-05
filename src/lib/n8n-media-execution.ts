import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { access, chmod, mkdir, readFile, readdir, realpath, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { config } from '@/lib/config'
import {
  loadN8nModelRegistry,
  resolveN8nNodeRoute,
  type AuxiliaryModelResource,
  type N8nModelRoute,
} from '@/lib/n8n-model-routing'

const videoKeySchema = z.string().trim().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:mp4|mov|mkv|webm|m4v)$/i,
  'videoKey 必须是受控收件箱生成的视频标识',
)

const mediaConfigSchema = z.object({
  audioResourceId: z.string().trim().min(1).max(80).default('whisper-large-v3-turbo'),
  language: z.string().trim().min(2).max(20).default('zh'),
  maxDurationSeconds: z.coerce.number().int().min(1).max(7_200).default(1_800),
  maxFileBytes: z.coerce.number().int().min(1_024).max(10 * 1024 ** 3).default(2 * 1024 ** 3),
  maxFrames: z.coerce.number().int().min(1).max(12).default(4),
  frameWidth: z.coerce.number().int().min(320).max(2_048).default(960),
  maxTranscriptChars: z.coerce.number().int().min(500).max(100_000).default(12_000),
}).strict()

export type N8nMediaStage = 'prepare' | 'audio' | 'vision' | 'finalize'

export interface PreparedMedia extends Record<string, unknown> {
  kind: 'prepared-video'
  durationSeconds: number
  sourceBytes: number
  audioAvailable: boolean
  frameCount: number
  memoryMode: 'none'
}

interface CommandResult {
  stdout: string
  stderr: string
}

interface MediaMetadata extends PreparedMedia {
  taskId: string
  preparedAt: string
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
  return mediaConfigSchema.parse(objectValue(configValue.media))
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

async function assertControlledSource(videoKey: string, maxFileBytes: number) {
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
  if (sourceStat.size > maxFileBytes) throw new Error(`视频文件超过 ${maxFileBytes} 字节上限`)
  return { sourcePath, sourceBytes: sourceStat.size }
}

async function writeMetadata(workspace: string, metadata: MediaMetadata) {
  const path = join(workspace, 'metadata.json')
  await writeFile(path, `${JSON.stringify(metadata)}\n`, { encoding: 'utf8', mode: 0o600 })
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

export async function prepareN8nMedia(
  taskId: string,
  routing: Record<string, unknown>,
  input: Record<string, unknown>,
): Promise<PreparedMedia> {
  const settings = mediaConfig(routing)
  const videoKey = videoKeySchema.parse(input.videoKey)
  const { sourcePath, sourceBytes } = await assertControlledSource(videoKey, settings.maxFileBytes)
  const ffmpeg = ffmpegCommand()
  await access(ffmpeg, constants.X_OK)
  const workspace = mediaTaskWorkspace(taskId)
  await mkdir(mediaWorkRoot(), { recursive: true, mode: 0o700 })
  await chmod(mediaWorkRoot(), 0o700)
  await rm(workspace, { recursive: true, force: true })
  await mkdir(workspace, { recursive: false, mode: 0o700 })

  try {
    const probe = await probeMedia(ffmpeg, sourcePath)
    if (!probe.hasVideo) throw new Error('输入文件没有可分析的视频流')
    if (probe.durationSeconds > settings.maxDurationSeconds) {
      throw new Error(`视频时长超过 ${settings.maxDurationSeconds} 秒上限`)
    }
    const timeoutMs = Math.min(30 * 60_000, Math.max(60_000, Math.ceil(probe.durationSeconds * 4_000)))
    if (probe.hasAudio) {
      try {
        await runCommand(ffmpeg, [
          '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
          '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', join(workspace, 'audio.wav'),
        ], { timeoutMs })
      } catch (error) {
        throw commandFailure(error, '视频音轨提取失败')
      }
    }

    const frameRate = Math.max(0.001, settings.maxFrames / probe.durationSeconds)
    try {
      await runCommand(ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
        '-an', '-vf', `fps=${frameRate},scale=${settings.frameWidth}:-2:force_original_aspect_ratio=decrease`,
        '-frames:v', String(settings.maxFrames), '-q:v', '3', join(workspace, 'frame-%03d.jpg'),
      ], { timeoutMs })
    } catch (error) {
      throw commandFailure(error, '视频画面抽帧失败')
    }
    const frames = (await readdir(workspace)).filter(name => /^frame-\d{3}\.jpg$/.test(name)).sort()
    if (!frames.length) throw new Error('视频画面抽帧结果为空')

    const metadata: MediaMetadata = {
      taskId,
      kind: 'prepared-video',
      durationSeconds: Math.round(probe.durationSeconds * 1000) / 1000,
      sourceBytes,
      audioAvailable: probe.hasAudio,
      frameCount: frames.length,
      memoryMode: 'none',
      preparedAt: new Date().toISOString(),
    }
    await writeMetadata(workspace, metadata)
    return {
      kind: metadata.kind,
      durationSeconds: metadata.durationSeconds,
      sourceBytes: metadata.sourceBytes,
      audioAvailable: metadata.audioAvailable,
      frameCount: metadata.frameCount,
      memoryMode: 'none',
    }
  } finally {
    await unlink(sourcePath).catch(() => undefined)
  }
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
  const audioPath = join(mediaTaskWorkspace(taskId), 'audio.wav')
  await access(audioPath, constants.R_OK)
  let result: CommandResult
  try {
    result = await runCommand(command, [
      '--model', resource.model,
      '--language', settings.language,
      '--max-chars', String(settings.maxTranscriptChars),
      audioPath,
    ], {
      timeoutMs: Math.min(30 * 60_000, Math.max(60_000, Math.ceil(metadata.durationSeconds * 4_000))),
      maxBuffer: 2 * 1024 * 1024,
    })
  } catch (error) {
    throw commandFailure(error, '音频模型转写失败')
  }
  const transcript = result.stdout.trim().slice(0, settings.maxTranscriptChars)
  if (!transcript) throw new Error('音频模型返回空转写')
  return {
    transcript,
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

export async function analyzeN8nVideoFrames(
  taskId: string,
  routing: Record<string, unknown>,
  taskInput: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const metadata = await readMetadata(taskId)
  const resolved = resolveN8nNodeRoute(routing, 'vision')
  const route = assertVisionRoute(resolved.route)
  const workspace = mediaTaskWorkspace(taskId)
  const frameNames = (await readdir(workspace)).filter(name => /^frame-\d{3}\.jpg$/.test(name)).sort()
  if (!frameNames.length) throw new Error('没有可供画面模型分析的抽帧')
  const images = await Promise.all(frameNames.map(async name => {
    const buffer = await readFile(join(workspace, name))
    if (buffer.byteLength > 4 * 1024 * 1024) throw new Error(`抽帧文件过大：${name}`)
    return `data:image/jpeg;base64,${buffer.toString('base64')}`
  }))
  const prompt = String(taskInput.prompt || '分析视频画面中的人物、场景、动作、文字和事件，并按时间顺序概括。').trim()
  const apiKey = route.apiKeyEnv ? String(process.env[route.apiKeyEnv] || '').trim() : ''
  if (route.apiKeyEnv && !apiKey) throw new Error(`视频画面路由缺少外部凭据引用 ${route.apiKeyEnv}`)
  const content = [
    {
      type: 'text',
      text: [
        resolved.instruction || '你是无状态的视频画面分析节点，只根据本次提供的抽帧作答。',
        `视频时长约 ${metadata.durationSeconds} 秒，共提供 ${images.length} 张按时间排序的抽帧。`,
        `业务要求：${prompt.slice(0, 4_000)}`,
        '只输出画面可见信息，不分析或评论音频；音频与合并由其他节点负责。',
        '不要引用历史会话或长期记忆；无法从画面确认的内容要明确说明。',
      ].join('\n'),
    },
    ...images.map(url => ({ type: 'image_url', image_url: { url } })),
  ]
  const response = await fetch(`${route.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: route.model,
      messages: [
        { role: 'system', content: '你是无状态画面节点，只处理当前请求中的视频抽帧；不分析音频，不读取或写入任何会话记忆。' },
        { role: 'user', content },
      ],
      ...(route.temperature === undefined ? {} : { temperature: route.temperature }),
      ...(route.maxTokens === undefined ? {} : { max_tokens: route.maxTokens }),
    }),
    signal: AbortSignal.timeout(route.timeoutSeconds * 1_000),
  })
  const raw = await response.text()
  let parsed: any = null
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    // The error below intentionally reports a bounded response fragment.
  }
  if (!response.ok) {
    const detail = String(parsed?.error?.message || raw || `HTTP ${response.status}`).slice(0, 2_000)
    throw new Error(`视频画面模型调用失败：${detail}`)
  }
  const analysis = parsed?.choices?.[0]?.message?.content
  if (typeof analysis !== 'string' || !analysis.trim()) throw new Error('视频画面模型返回空结果')
  return {
    analysis: analysis.trim().slice(0, 100_000),
    frameCount: images.length,
    routeId: route.id,
    model: route.model,
    location: route.location,
    transport: route.transport,
    memoryMode: 'none',
    ...(parsed?.usage && typeof parsed.usage === 'object' ? { usage: parsed.usage } : {}),
  }
}

export function mergeN8nMediaResults(
  audio: Record<string, unknown>,
  vision: Record<string, unknown>,
): Record<string, unknown> {
  const transcript = String(audio.transcript || '').trim()
  const visualAnalysis = String(vision.analysis || '').trim()
  return {
    taskType: 'video-analysis',
    audio,
    vision,
    combinedText: [
      '【音频分析】',
      transcript || '未检测到可转写音轨。',
      '',
      '【画面分析】',
      visualAnalysis || '画面分析结果为空。',
    ].join('\n'),
    workers: {
      audio: { model: audio.model || null, memoryMode: 'none' },
      vision: { model: vision.model || null, memoryMode: 'none' },
    },
    memoryMode: 'none',
    persistence: 'operational-task-record-only',
  }
}

export async function cleanupN8nMediaTask(taskId: string): Promise<void> {
  await rm(mediaTaskWorkspace(taskId), { recursive: true, force: true })
}

export async function cleanupExpiredN8nMediaTasks(now = Date.now()): Promise<number> {
  const root = mediaWorkRoot()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const entries = await readdir(root, { withFileTypes: true })
  let removed = 0
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue
    const path = join(root, entry.name)
    const info = await stat(path).catch(() => null)
    if (!info || now - info.mtimeMs <= 24 * 60 * 60 * 1_000) continue
    await rm(path, { recursive: true, force: true })
    removed += 1
  }
  const inbox = mediaInboxRoot()
  await mkdir(inbox, { recursive: true, mode: 0o700 })
  const inboxEntries = await readdir(inbox, { withFileTypes: true })
  for (const entry of inboxEntries) {
    if (!entry.isFile() || !videoKeySchema.safeParse(entry.name).success) continue
    const path = join(inbox, entry.name)
    const info = await stat(path).catch(() => null)
    if (!info || now - info.mtimeMs <= 24 * 60 * 60 * 1_000) continue
    await rm(path, { force: true })
    removed += 1
  }
  return removed
}
