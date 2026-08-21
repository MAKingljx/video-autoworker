import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'
import { isTerminalTaskStatus } from '../../openclaw-skills/aiworker-task-flow/lib/task-status-authority.mjs'

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v'])
const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/
const CACHE_TTL_MS = 5_000
const MAX_STATE_FILES = 2_000
const MAX_STATE_BYTES = 8 * 1024 * 1024
const MAX_STATE_ITEMS = 20_000
const QUEUE_STATUSES = new Set([
  'queued', 'staging', 'submitted', 'accepted', 'running', 'waiting', 'recovering', 'paused',
])

export interface N8nVideoSource {
  taskId: string
  name: string
  path: string
  bytes: number
  modifiedAt: number
  extension: string
}

export interface N8nVideoQueueItem {
  taskId: string
  name: string
  status: string
  batchId: string | null
  batchIndex: number | null
  batchStatus: string | null
  bindingId: number
  createdAt: number
  updatedAt: number
  submittedAt: number | null
  error: string | null
  sourceAvailable: boolean
  queuePosition: number
}

interface SourceCache {
  root: string
  expiresAt: number
  sources: Map<string, N8nVideoSource>
}

let sourceCache: SourceCache | null = null

interface QueueCache {
  root: string
  expiresAt: number
  items: N8nVideoQueueItem[]
}

let queueCache: QueueCache | null = null

export function n8nVideoBatchRoot(): string {
  return resolve(String(process.env.AIWORKER_VIDEO_BATCH_DIR || '').trim()
    || join(homedir(), 'ai-worker/state/video-autoworker/video-batches'))
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function timestampSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value)
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? Math.floor(parsed / 1_000) : null
}

function safeQueueText(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  return cleaned
    .replace(/https?:\/\/\S+/gi, '[\u94fe\u63a5]')
    .replace(/(?:\/Users|\/home|\/private|\/var|\/tmp)\/[^\s，。；;]+/g, '[\u8def\u5f84]')
    .replace(/[A-Za-z]:\\[^\s，。；;]+/g, '[\u8def\u5f84]')
    .slice(0, maxLength)
}

async function buildSourceIndex(root: string): Promise<Map<string, N8nVideoSource>> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(root)
  } catch {
    return new Map()
  }

  const entries = (await readdir(canonicalRoot, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .slice(0, MAX_STATE_FILES)
  const sources = new Map<string, N8nVideoSource>()
  const conflicts = new Set<string>()
  let visitedItems = 0

  for (const entry of entries) {
    if (visitedItems >= MAX_STATE_ITEMS) break
    const statePath = join(canonicalRoot, entry.name)
    const stateInfo = await lstat(statePath).catch(() => null)
    if (!stateInfo?.isFile() || stateInfo.size <= 0 || stateInfo.size > MAX_STATE_BYTES) continue
    let state: Record<string, unknown>
    try {
      state = objectValue(JSON.parse(await readFile(statePath, 'utf8')))
    } catch {
      continue
    }
    const items = Array.isArray(state.items) ? state.items : []
    for (const rawItem of items) {
      if (++visitedItems > MAX_STATE_ITEMS) break
      const item = objectValue(rawItem)
      const taskId = typeof item.taskId === 'string' ? item.taskId.trim() : ''
      const sourcePath = typeof item.sourcePath === 'string' ? item.sourcePath : ''
      if (!TASK_ID_PATTERN.test(taskId) || !sourcePath || conflicts.has(taskId)) continue
      try {
        const canonicalSource = await realpath(resolve(sourcePath))
        const sourceInfo = await lstat(canonicalSource)
        const extension = extname(canonicalSource).toLowerCase()
        const expectedBytes = Number(item.sourceBytes)
        if (!sourceInfo.isFile() || sourceInfo.size <= 0 || !VIDEO_EXTENSIONS.has(extension)) continue
        if (Number.isFinite(expectedBytes) && expectedBytes > 0 && sourceInfo.size !== expectedBytes) continue
        const expectedName = typeof item.name === 'string' ? basename(item.name) : ''
        if (expectedName && expectedName !== basename(canonicalSource)) continue
        const candidate: N8nVideoSource = {
          taskId,
          name: basename(canonicalSource),
          path: canonicalSource,
          bytes: sourceInfo.size,
          modifiedAt: Math.floor(sourceInfo.mtimeMs),
          extension,
        }
        const existing = sources.get(taskId)
        if (existing && existing.path !== candidate.path) {
          sources.delete(taskId)
          conflicts.add(taskId)
          continue
        }
        sources.set(taskId, candidate)
      } catch {
        // Missing or changed source files remain unavailable without exposing paths.
      }
    }
  }
  return sources
}

export async function listN8nVideoSources(): Promise<Map<string, N8nVideoSource>> {
  const root = n8nVideoBatchRoot()
  const now = Date.now()
  if (sourceCache?.root === root && sourceCache.expiresAt > now) return sourceCache.sources
  const sources = await buildSourceIndex(root)
  sourceCache = { root, expiresAt: now + CACHE_TTL_MS, sources }
  return sources
}

export async function getN8nVideoSource(taskId: string): Promise<N8nVideoSource | null> {
  return (await listN8nVideoSources()).get(taskId) || null
}

async function buildQueueIndex(
  root: string,
  sources: Map<string, N8nVideoSource>,
): Promise<N8nVideoQueueItem[]> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(root)
  } catch {
    return []
  }
  const entries = (await readdir(canonicalRoot, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .slice(0, MAX_STATE_FILES)
  const queue: N8nVideoQueueItem[] = []
  let visitedItems = 0

  for (const entry of entries) {
    if (visitedItems >= MAX_STATE_ITEMS) break
    const statePath = join(canonicalRoot, entry.name)
    const stateInfo = await lstat(statePath).catch(() => null)
    if (!stateInfo?.isFile() || stateInfo.size <= 0 || stateInfo.size > MAX_STATE_BYTES) continue
    let state: Record<string, unknown>
    try {
      state = objectValue(JSON.parse(await readFile(statePath, 'utf8')))
    } catch {
      continue
    }
    const batchId = safeQueueText(state.batchId, 120)
    const batchStatus = safeQueueText(state.status, 40)
    const bindingId = Number(state.bindingId)
    if (!Number.isInteger(bindingId) || bindingId <= 0) continue
    const createdAt = timestampSeconds(state.createdAt)
      ?? Math.floor((stateInfo.birthtimeMs || stateInfo.mtimeMs) / 1_000)
    const updatedAt = timestampSeconds(state.updatedAt) ?? Math.floor(stateInfo.mtimeMs / 1_000)
    const items = Array.isArray(state.items) ? state.items : []
    for (const rawItem of items) {
      if (++visitedItems > MAX_STATE_ITEMS) break
      const item = objectValue(rawItem)
      const taskId = typeof item.taskId === 'string' ? item.taskId.trim() : ''
      if (!TASK_ID_PATTERN.test(taskId)) continue
      const rawStatus = safeQueueText(item.status, 40) || 'queued'
      if (isTerminalTaskStatus(rawStatus)) continue
      let status = rawStatus
      if (batchStatus === 'paused' && !['submitted', 'accepted', 'running'].includes(status)) {
        status = 'paused'
      } else if (batchStatus === 'recovering' && status === 'queued') {
        status = 'recovering'
      }
      if (!QUEUE_STATUSES.has(status)) continue
      const index = Number(item.index)
      queue.push({
        taskId,
        name: basename(safeQueueText(item.name, 240) || '未命名视频'),
        status,
        batchId,
        batchIndex: Number.isInteger(index) && index > 0 ? index : null,
        batchStatus,
        bindingId,
        createdAt,
        updatedAt,
        submittedAt: timestampSeconds(item.submittedAt),
        error: safeQueueText(item.error, 240) || safeQueueText(state.error, 240),
        sourceAvailable: sources.has(taskId),
        queuePosition: 0,
      })
    }
  }
  queue.sort((left, right) => (
    left.createdAt - right.createdAt
    || String(left.batchId || '').localeCompare(String(right.batchId || ''), 'zh-CN')
    || (left.batchIndex || 0) - (right.batchIndex || 0)
    || left.taskId.localeCompare(right.taskId)
  ))
  return queue.map((item, index) => ({ ...item, queuePosition: index + 1 }))
}

export async function listN8nVideoQueueItems(): Promise<N8nVideoQueueItem[]> {
  const root = n8nVideoBatchRoot()
  const now = Date.now()
  if (queueCache?.root === root && queueCache.expiresAt > now) return queueCache.items
  const items = await buildQueueIndex(root, await listN8nVideoSources())
  queueCache = { root, expiresAt: now + CACHE_TTL_MS, items }
  return items
}

export function resetN8nVideoSourceCacheForTests(): void {
  sourceCache = null
  queueCache = null
}
