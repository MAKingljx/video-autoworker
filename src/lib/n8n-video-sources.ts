import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join, resolve } from 'node:path'

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v'])
const TASK_ID_PATTERN = /^[A-Za-z0-9._:-]{1,120}$/
const CACHE_TTL_MS = 5_000
const MAX_STATE_FILES = 2_000
const MAX_STATE_BYTES = 8 * 1024 * 1024
const MAX_STATE_ITEMS = 20_000

export interface N8nVideoSource {
  taskId: string
  name: string
  path: string
  bytes: number
  modifiedAt: number
  extension: string
}

interface SourceCache {
  root: string
  expiresAt: number
  sources: Map<string, N8nVideoSource>
}

let sourceCache: SourceCache | null = null

export function n8nVideoBatchRoot(): string {
  return resolve(String(process.env.AIWORKER_VIDEO_BATCH_DIR || '').trim()
    || join(homedir(), 'ai-worker/state/video-autoworker/video-batches'))
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
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

export function resetN8nVideoSourceCacheForTests(): void {
  sourceCache = null
}
