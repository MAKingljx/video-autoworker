import { createHash } from 'node:crypto'
import { chmod, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { SUPPORTED_VIDEO_EXTENSIONS, inspectVideoFile } from './media-ingest.mjs'

const BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]+$/
const MAX_BATCH_ITEMS = 100

export function validateBatchId(value) {
  const batchId = String(value || '').trim()
  if (!batchId || batchId.length > 80 || !BATCH_ID_PATTERN.test(batchId)) {
    throw new Error('批次 ID 必须为 1 到 80 位，只能包含字母、数字、点、下划线、冒号和连字符')
  }
  return batchId
}

export function defaultBatchRoot() {
  return resolve(process.env.AIWORKER_VIDEO_BATCH_DIR
    || join(homedir(), 'ai-worker/state/video-autoworker/video-batches'))
}

export function batchStatePath(batchId, root = defaultBatchRoot()) {
  const safeId = validateBatchId(batchId)
  const digest = createHash('sha256').update(safeId).digest('hex')
  return join(resolve(root), `${digest}.json`)
}

export function deriveBatchTaskId(batchId, index, sourcePath) {
  const safeId = validateBatchId(batchId)
  const suffix = createHash('sha256').update(`${safeId}\0${index}\0${sourcePath}`).digest('hex').slice(0, 12)
  const prefix = safeId.slice(0, 80)
  return `${prefix}:video:${String(index).padStart(3, '0')}:${suffix}`.slice(0, 120)
}

export async function discoverBatchVideos(videoDir) {
  const directory = await realpath(resolve(videoDir))
  const directoryStat = await stat(directory)
  if (!directoryStat.isDirectory()) throw new Error('批量视频路径不是目录')
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && SUPPORTED_VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
  if (!names.length) throw new Error('目录中没有支持的视频文件')
  if (names.length > MAX_BATCH_ITEMS) throw new Error(`单批最多支持 ${MAX_BATCH_ITEMS} 个视频`)
  const videos = []
  for (const name of names) {
    const inspected = await inspectVideoFile(join(directory, name))
    videos.push({ name, path: inspected.sourcePath, bytes: inspected.sourceBytes })
  }
  return { directory, videos }
}

export async function readBatchState(path) {
  const parsed = JSON.parse(await readFile(resolve(path), 'utf8'))
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.items)) {
    throw new Error('批次状态文件无效')
  }
  return parsed
}

export async function writeBatchState(path, state) {
  const target = resolve(path)
  const parent = dirname(target)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await chmod(parent, 0o700)
  const next = { ...state, updatedAt: new Date().toISOString() }
  const temp = `${target}.tmp.${process.pid}`
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, target)
  return next
}

export async function createBatchState({
  batchId,
  baseUrl,
  bindingId,
  prompt,
  visionRoute,
  videoDir,
  inboxRoot,
  batchRoot,
}) {
  const safeId = validateBatchId(batchId)
  const statePath = batchStatePath(safeId, batchRoot)
  try {
    return { statePath, state: await readBatchState(statePath), duplicate: true }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const discovered = await discoverBatchVideos(videoDir)
  const createdAt = new Date().toISOString()
  const state = {
    schemaVersion: 1,
    batchId: safeId,
    status: 'queued',
    baseUrl,
    bindingId,
    prompt: prompt.trim(),
    visionRoute: visionRoute || null,
    sourceDirectory: discovered.directory,
    inboxRoot: resolve(inboxRoot),
    createdAt,
    updatedAt: createdAt,
    error: null,
    items: discovered.videos.map((video, offset) => {
      const index = offset + 1
      const taskId = deriveBatchTaskId(safeId, index, video.path)
      return {
        index,
        name: video.name,
        sourcePath: video.path,
        sourceBytes: video.bytes,
        taskId,
        idempotencyKey: taskId,
        status: 'queued',
        error: null,
        submittedAt: null,
        completedAt: null,
      }
    }),
  }
  return { statePath, state: await writeBatchState(statePath, state), duplicate: false }
}

export function summarizeBatchState(state) {
  const counts = {}
  for (const item of state.items) counts[item.status] = (counts[item.status] || 0) + 1
  const current = state.items.find(item => ['staging', 'submitted', 'accepted', 'running', 'waiting'].includes(item.status))
  return {
    batchId: state.batchId,
    status: state.status,
    total: state.items.length,
    counts,
    current: current ? {
      index: current.index,
      name: current.name,
      taskId: current.taskId,
      status: current.status,
    } : null,
    items: state.items.map(item => ({
      index: item.index,
      name: item.name,
      taskId: item.taskId,
      status: item.status,
      ...(item.error ? { error: item.error } : {}),
    })),
    error: state.error || null,
    updatedAt: state.updatedAt,
  }
}

async function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function acquireBatchLock(statePath) {
  const lockPath = `${resolve(statePath)}.lock`
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${process.pid}\n`)
      return {
        acquired: true,
        async release() {
          await handle.close().catch(() => undefined)
          await rm(lockPath, { force: true }).catch(() => undefined)
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const pid = Number(String(await readFile(lockPath, 'utf8').catch(() => '')).trim())
      if (await pidIsAlive(pid)) return { acquired: false, release: async () => undefined }
      await rm(lockPath, { force: true })
    }
  }
  return { acquired: false, release: async () => undefined }
}

export function batchItemDisplayName(item) {
  return basename(String(item?.sourcePath || item?.name || 'video'))
}
