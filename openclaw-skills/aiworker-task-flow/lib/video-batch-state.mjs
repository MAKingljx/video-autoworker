import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { SUPPORTED_VIDEO_EXTENSIONS, inspectVideoFile } from './media-ingest.mjs'

const BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]+$/
const MAX_BATCH_ITEMS = 100
const MAX_STATUS_SEARCH_QUERY = 512
const MAX_STATUS_SEARCH_MATCHES = 32
const MAX_DUPLICATE_MATCHES = 32

const SEARCH_STOPWORDS = new Set([
  '请', '帮我', '帮', '查', '查询', '看', '一下', '下', '视频', '影片', '录像',
  '任务', '学习', '分析', '进度', '状态', '结果', '情况', '正式', '的', '一下子',
])

const SEARCH_STATUS_ALIASES = {
  queued: 'queued 排队 入队 已排队',
  accepted: 'accepted 受理 已受理',
  running: 'running 处理中 运行中',
  waiting: 'waiting 等待中',
  staging: 'staging 准备中',
  submitted: 'submitted 已提交',
  succeeded: 'succeeded 成功 完成 已完成',
  failed: 'failed 失败',
  cancelled: 'cancelled canceled 取消 已取消',
  recovering: 'recovering 恢复中',
  paused: 'paused 暂停 已暂停',
  completed_with_errors: 'completed_with_errors 完成 含失败项',
}

function stableFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function batchRequestIdentity({
  batchId,
  baseUrl,
  bindingId,
  prompt,
  visionRoute,
  sourceDirectory,
  inboxRoot,
}) {
  return {
    batchId: validateBatchId(batchId),
    baseUrl: String(baseUrl || ''),
    bindingId,
    prompt: String(prompt || '').trim(),
    visionRoute: visionRoute || null,
    sourceDirectory: resolve(sourceDirectory),
    inboxRoot: resolve(inboxRoot),
  }
}

function singleRequestIdentity({
  taskId,
  idempotencyKey,
  baseUrl,
  bindingId,
  prompt,
  visionRoute,
  sourcePath,
  inboxRoot,
}) {
  return {
    taskId: String(taskId || ''),
    idempotencyKey: String(idempotencyKey || ''),
    baseUrl: String(baseUrl || ''),
    bindingId,
    prompt: String(prompt || '').trim(),
    visionRoute: visionRoute || null,
    sourcePath: resolve(sourcePath),
    inboxRoot: resolve(inboxRoot),
  }
}

async function sourceFingerprint(sourcePath) {
  const sourceStat = await stat(sourcePath)
  return stableFingerprint({
    path: sourcePath,
    bytes: sourceStat.size,
    modifiedMs: sourceStat.mtimeMs,
    changedMs: sourceStat.ctimeMs,
    device: sourceStat.dev,
    inode: sourceStat.ino,
  })
}

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

function chineseNumeralToNumber(value) {
  const digits = {
    零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
    五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  }
  if (!value || [...value].some(char => digits[char] === undefined && char !== '十' && char !== '百')) {
    return null
  }
  if ([...value].every(char => digits[char] !== undefined)) {
    return Number([...value].map(char => digits[char]).join(''))
  }
  let total = 0
  let current = 0
  for (const char of value) {
    if (digits[char] !== undefined) {
      current = digits[char]
    } else if (char === '十') {
      total += (current || 1) * 10
      current = 0
    } else if (char === '百') {
      total += (current || 1) * 100
      current = 0
    }
  }
  const result = total + current
  return Number.isInteger(result) && result > 0 ? result : null
}

function formatSearchSequence(value) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) return String(value)
  return String(number).padStart(3, '0')
}

function normalizeSeasonEpisodeMarkers(value) {
  let text = String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')

  // Convert Chinese numerals before normalizing the marker spelling. This
  // keeps “第三季第三集” equivalent to “s3e3” and “season03 episode03”.
  text = text.replace(/第([零〇一二两三四五六七八九十百]+)(季|集)/gu, (_match, number, unit) => {
    const converted = chineseNumeralToNumber(number)
    return converted === null ? `第${number}${unit}` : `第${converted}${unit}`
  })

  // Use fixed-width internal markers so ep4 never matches ep40. The marker
  // is deliberately textual: it remains safe for the existing bounded
  // substring search while preserving the original display filename.
  text = text
    .replace(/(?:season|s)\s*0*(\d{1,3})\s*(?:episode|ep|e)\s*0*(\d{1,4})/giu,
      (_match, season, episode) => `season${formatSearchSequence(season)}ep${formatSearchSequence(episode)}`)
    .replace(/第\s*0*(\d{1,4})\s*季/gu,
      (_match, season) => `season${formatSearchSequence(season)}`)
    .replace(/第\s*0*(\d{1,4})\s*集/gu,
      (_match, episode) => `ep${formatSearchSequence(episode)}`)
    .replace(/(?:season|s)\s*0*(\d{1,3})/giu,
      (_match, season) => `season${formatSearchSequence(season)}`)
    .replace(/(?:episode|ep|e)\s*0*(\d{1,4})/giu,
      (_match, episode) => `ep${formatSearchSequence(episode)}`)

  return text.replace(/[\s\p{P}\p{S}]+/gu, '')
}

function normalizeSearchText(value) {
  return normalizeSeasonEpisodeMarkers(value)
}

function extractSearchTerms(value) {
  const normalized = normalizeSearchText(value)
    .replace(/^(?:请|帮我|帮|查询|查|看|一下|下|视频|影片|录像|任务|学习)+/u, '')
    .replace(/(?:进度|状态|结果|情况|正式|入队|排队|受理|完成|的|了)+$/u, '')
  const segmented = normalized
    .replace(/season\d{3}/gu, ' $& ')
    .replace(/ep\d{3,4}/gu, ' $& ')
  const terms = []
  const matcher = /s\d{1,2}e\d{1,3}|第\d{1,3}季|第\d{1,3}集|[\p{Script=Han}]+|[a-z0-9]+/giu
  for (const match of segmented.matchAll(matcher)) {
    const term = match[0]
    if (SEARCH_STOPWORDS.has(term) || term.length < 2) continue
    terms.push(term)
  }
  const aliases = []
  const westernSeasonEpisode = normalized.match(/season(\d{3})ep(\d{3,4})/u)
  if (westernSeasonEpisode) {
    aliases.push(`season${westernSeasonEpisode[1]}`, `ep${westernSeasonEpisode[2]}`)
  }
  return [...new Set([...terms, ...aliases])]
}

function searchHaystack(state, item) {
  const statusText = [
    SEARCH_STATUS_ALIASES[item.status] || '',
    SEARCH_STATUS_ALIASES[state.status] || '',
  ].join(' ')
  // Search only the task registry's public identifiers and display metadata.
  const source = [
    state.batchId,
    state.kind,
    item.taskId,
    item.name,
    statusText,
  ].join(' ')
  const normalized = normalizeSearchText(source)
  return normalized
}

function validateStatusSearchQuery(value) {
  const query = String(value || '').trim()
  if (!query || query.length > MAX_STATUS_SEARCH_QUERY || /[\u0000-\u001f\u007f]/u.test(query)) {
    throw new Error('状态搜索关键词无效')
  }
  return query
}

export async function searchVideoTaskStates(query, root = defaultBatchRoot()) {
  const normalizedQuery = validateStatusSearchQuery(query)
  const terms = extractSearchTerms(normalizedQuery)
  if (!terms.length) return { matches: [], total: 0, truncated: false }

  const stateRoot = resolve(root)
  let entries
  try {
    entries = await readdir(stateRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { matches: [], total: 0, truncated: false }
    throw error
  }

  const matches = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue
    let state
    try {
      state = await readBatchState(join(stateRoot, entry.name))
    } catch {
      continue
    }
    for (const item of state.items) {
      if (!item || typeof item !== 'object') continue
      const haystack = searchHaystack(state, item)
      if (!terms.every(term => haystack.includes(normalizeSearchText(term)))) continue
      const exact = haystack.includes(normalizeSearchText(normalizedQuery))
      matches.push({
        kind: state.kind === 'single' ? 'task' : 'batch',
        taskId: typeof item.taskId === 'string' ? item.taskId : null,
        batchId: typeof state.batchId === 'string' ? state.batchId : null,
        index: Number.isInteger(item.index) ? item.index : null,
        name: batchItemDisplayName(item),
        status: typeof item.status === 'string' ? item.status : 'unknown',
        batchStatus: typeof state.status === 'string' ? state.status : 'unknown',
        completedAt: typeof item.completedAt === 'string' ? item.completedAt : null,
        updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
        score: exact ? 2 : 1,
      })
    }
  }

  const unique = new Map()
  for (const match of matches) {
    const key = match.kind === 'task'
      ? `${match.kind}:${match.taskId}`
      : `${match.kind}:${match.batchId}:${match.index}`
    const current = unique.get(key)
    if (!current || match.score > current.score) unique.set(key, match)
  }
  const sorted = [...unique.values()].sort((left, right) => (
    right.score - left.score
    || String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))
    || String(left.name).localeCompare(String(right.name), 'zh-CN')
    || String(left.taskId || left.batchId).localeCompare(String(right.taskId || right.batchId))
  ))
  const total = sorted.length
  const limited = sorted.slice(0, MAX_STATUS_SEARCH_MATCHES).map(({ score: _score, ...match }) => match)
  return {
    matches: limited,
    total,
    truncated: total > limited.length,
  }
}

export function batchStatePath(batchId, root = defaultBatchRoot()) {
  const safeId = validateBatchId(batchId)
  const digest = createHash('sha256').update(safeId).digest('hex')
  return join(resolve(root), `${digest}.json`)
}

function duplicateSubmissionLockPath(root = defaultBatchRoot()) {
  return join(resolve(root), '.duplicate-submission.lock')
}

async function acquireDuplicateSubmissionLock(root) {
  const path = duplicateSubmissionLockPath(root)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const lock = await acquireFileLock(path)
    if (lock.acquired) return lock
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
  }
  throw new Error('视频重复检查正在进行，请稍后重试')
}

function publicDuplicateMatch(state, item) {
  return {
    kind: state.kind === 'single' ? 'task' : 'batch',
    name: batchItemDisplayName(item),
    status: typeof item.status === 'string' ? item.status : 'unknown',
    taskId: typeof item.taskId === 'string' ? item.taskId : null,
    batchId: state.kind === 'single' ? null : (typeof state.batchId === 'string' ? state.batchId : null),
    index: Number.isInteger(item.index) ? item.index : null,
    completedAt: typeof item.completedAt === 'string' ? item.completedAt : null,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : null,
  }
}

/**
 * Read only the controlled task registry and match a video by both canonical
 * path and basename. Broken historical paths and malformed state files are
 * ignored; no source path is returned across the caller boundary.
 */
export async function findHistoricalVideoMatches(
  videos,
  { root = defaultBatchRoot(), excludeStatePaths = [] } = {},
) {
  const requested = new Map()
  for (const video of videos) {
    const canonicalPath = await realpath(resolve(video.path))
    const name = basename(canonicalPath)
    requested.set(`${canonicalPath}\0${name}`, { path: canonicalPath, name })
  }
  if (!requested.size) return { matches: [], total: 0, truncated: false }

  const stateRoot = resolve(root)
  const excluded = new Set(excludeStatePaths.map(path => resolve(path)))
  let entries
  try {
    entries = await readdir(stateRoot, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { matches: [], total: 0, truncated: false }
    throw error
  }

  const matches = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue
    const path = join(stateRoot, entry.name)
    if (excluded.has(resolve(path))) continue
    let state
    try {
      state = await readBatchState(path)
    } catch {
      continue
    }
    for (const item of state.items) {
      if (!item || typeof item !== 'object' || typeof item.sourcePath !== 'string') continue
      let canonicalPath
      try {
        canonicalPath = await realpath(resolve(item.sourcePath))
      } catch {
        continue
      }
      const name = batchItemDisplayName(item)
      if (!requested.has(`${canonicalPath}\0${name}`)) continue
      matches.push(publicDuplicateMatch(state, item))
    }
  }

  matches.sort((left, right) => (
    String(right.completedAt || right.updatedAt || '').localeCompare(
      String(left.completedAt || left.updatedAt || ''),
    )
    || String(left.name).localeCompare(String(right.name), 'zh-CN')
  ))
  const total = matches.length
  return {
    matches: matches.slice(0, MAX_DUPLICATE_MATCHES),
    total,
    truncated: total > MAX_DUPLICATE_MATCHES,
  }
}

export function globalBatchLockPath(statePath) {
  return join(dirname(resolve(statePath)), '.global-video-worker.lock')
}

export function deriveBatchTaskId(batchId, index, sourcePath) {
  const safeId = validateBatchId(batchId)
  const suffix = createHash('sha256').update(`${safeId}\0${index}\0${sourcePath}`).digest('hex').slice(0, 12)
  const prefix = safeId.slice(0, 80)
  return `${prefix}:video:${String(index).padStart(3, '0')}:${suffix}`.slice(0, 120)
}

export async function discoverBatchVideos(videoDir, { inboxRoot } = {}) {
  const directory = await realpath(resolve(videoDir))
  const directoryStat = await stat(directory)
  if (!directoryStat.isDirectory()) throw new Error('批量视频路径不是目录')
  const names = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && SUPPORTED_VIDEO_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map(entry => entry.name)
    .sort((a, b) => a === b ? 0 : a < b ? -1 : 1)
  if (!names.length) throw new Error('目录中没有支持的视频文件')
  if (names.length > MAX_BATCH_ITEMS) throw new Error(`单批最多支持 ${MAX_BATCH_ITEMS} 个视频`)
  const videos = []
  for (const name of names) {
    const inspected = await inspectVideoFile(join(directory, name), {
      capacityRoot: inboxRoot,
    })
    videos.push({ name, path: inspected.sourcePath, bytes: inspected.sourceBytes })
  }
  return { directory, videos }
}

export async function readBatchState(path) {
  const parsed = JSON.parse(await readFile(resolve(path), 'utf8'))
  const validV1 = parsed?.schemaVersion === 1 && Array.isArray(parsed.items)
  const validV2 = parsed?.schemaVersion === 2
    && typeof parsed.requestFingerprint === 'string'
    && /^[a-f0-9]{64}$/u.test(parsed.requestFingerprint)
    && Array.isArray(parsed.items)
  if (!validV1 && !validV2) {
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
  confirmDuplicate = false,
}) {
  const safeId = validateBatchId(batchId)
  const statePath = batchStatePath(safeId, batchRoot)
  const requestedDirectory = await realpath(resolve(videoDir))
  const requestedIdentity = batchRequestIdentity({
    batchId: safeId,
    baseUrl,
    bindingId,
    prompt,
    visionRoute,
    sourceDirectory: requestedDirectory,
    inboxRoot,
  })
  const requestFingerprint = stableFingerprint(requestedIdentity)
  try {
    const existing = await readBatchState(statePath)
    assertBatchInput(existing, requestFingerprint)
    return { statePath, state: existing, duplicate: true }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const createLockPath = `${statePath}.create.lock`
  const createLock = await acquireFileLock(createLockPath)
  if (!createLock.acquired) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        const state = await readBatchState(statePath)
        assertBatchInput(state, requestFingerprint)
        return { statePath, state, duplicate: true }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100))
    }
    throw new Error('同一批次正在初始化，请稍后使用相同参数重试')
  }
  try {
    try {
      const state = await readBatchState(statePath)
      assertBatchInput(state, requestFingerprint)
      return { statePath, state, duplicate: true }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const duplicateLock = await acquireDuplicateSubmissionLock(batchRoot)
    try {
      const discovered = await discoverBatchVideos(requestedDirectory, { inboxRoot })
      const historical = await findHistoricalVideoMatches(
        discovered.videos,
        { root: batchRoot, excludeStatePaths: [statePath] },
      )
      if (historical.total > 0 && !confirmDuplicate) {
        return {
          statePath,
          state: null,
          duplicate: false,
          confirmationRequired: true,
          historical,
        }
      }
      const createdAt = new Date().toISOString()
      const state = {
        schemaVersion: 2,
        batchId: safeId,
        requestFingerprint,
        status: 'queued',
        ...requestedIdentity,
        sourceDirectory: discovered.directory,
        createdAt,
        updatedAt: createdAt,
        error: null,
        items: await Promise.all(discovered.videos.map(async (video, offset) => {
          const index = offset + 1
          const taskId = deriveBatchTaskId(safeId, index, video.path)
          return {
            index,
            name: video.name,
            sourcePath: video.path,
            sourceBytes: video.bytes,
            sourceFingerprint: await sourceFingerprint(video.path),
            taskId,
            idempotencyKey: taskId,
            status: 'queued',
            error: null,
            submittedAt: null,
            completedAt: null,
          }
        })),
      }
      return {
        statePath,
        state: await writeBatchState(statePath, state),
        duplicate: false,
        confirmedDuplicate: historical.total > 0,
      }
    } finally {
      await duplicateLock.release()
    }
  } finally {
    await createLock.release()
  }
}

export function assertBatchInput(state, requestFingerprint) {
  const persistedFingerprint = state.schemaVersion === 1
    ? stableFingerprint(batchRequestIdentity(state))
    : state.requestFingerprint
  if (persistedFingerprint !== requestFingerprint) {
    throw new Error('同一批次 ID 已绑定其他视频目录、提示词或执行配置')
  }
}

export async function createSingleVideoState({
  taskId,
  idempotencyKey,
  baseUrl,
  bindingId,
  prompt,
  visionRoute,
  videoFile,
  inboxRoot,
  batchRoot,
  confirmDuplicate = false,
}) {
  const inspected = await inspectVideoFile(videoFile, { capacityRoot: inboxRoot })
  const requestIdentity = singleRequestIdentity({
    taskId,
    idempotencyKey,
    baseUrl,
    bindingId,
    sourcePath: inspected.sourcePath,
    prompt,
    visionRoute,
    inboxRoot,
  })
  const requestFingerprint = stableFingerprint(requestIdentity)
  const statePath = singleVideoStatePath(taskId, batchRoot)
  const batchId = `single:${stableFingerprint(String(taskId || '')).slice(0, 32)}`
  try {
    const state = await readBatchState(statePath)
    if (state.requestFingerprint !== requestFingerprint) {
      throw new Error('同一任务 ID 已绑定其他视频、提示词或执行配置')
    }
    return { statePath, state, duplicate: true }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const createLock = await acquireFileLock(`${statePath}.create.lock`)
  if (!createLock.acquired) throw new Error('同一视频任务正在初始化，请稍后查询同一任务')
  try {
    try {
      const state = await readBatchState(statePath)
      if (state.requestFingerprint !== requestFingerprint) {
        throw new Error('同一任务 ID 已绑定其他视频、提示词或执行配置')
      }
      return { statePath, state, duplicate: true }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    const duplicateLock = await acquireDuplicateSubmissionLock(batchRoot)
    try {
      const historical = await findHistoricalVideoMatches(
        [{ path: inspected.sourcePath }],
        { root: batchRoot, excludeStatePaths: [statePath] },
      )
      if (historical.total > 0 && !confirmDuplicate) {
        return {
          statePath,
          state: null,
          duplicate: false,
          confirmationRequired: true,
          historical,
        }
      }
      const createdAt = new Date().toISOString()
      const state = {
        schemaVersion: 2,
        batchId,
        requestFingerprint,
        kind: 'single',
        status: 'queued',
        baseUrl,
        bindingId,
        prompt: String(prompt || '').trim(),
        visionRoute: visionRoute || null,
        sourceDirectory: dirname(inspected.sourcePath),
        inboxRoot: resolve(inboxRoot),
        createdAt,
        updatedAt: createdAt,
        error: null,
        items: [{
          index: 1,
          name: basename(inspected.sourcePath),
          sourcePath: inspected.sourcePath,
          sourceBytes: inspected.sourceBytes,
          sourceFingerprint: await sourceFingerprint(inspected.sourcePath),
          taskId,
          idempotencyKey,
          status: 'queued',
          error: null,
          submittedAt: null,
          completedAt: null,
        }],
      }
      return {
        statePath,
        state: await writeBatchState(statePath, state),
        duplicate: false,
        confirmedDuplicate: historical.total > 0,
      }
    } finally {
      await duplicateLock.release()
    }
  } finally {
    await createLock.release()
  }
}

export async function verifyBatchItemSource(item, { inboxRoot } = {}) {
  const inspected = await inspectVideoFile(item.sourcePath, { capacityRoot: inboxRoot })
  if (inspected.sourceBytes !== item.sourceBytes
    || await sourceFingerprint(inspected.sourcePath) !== item.sourceFingerprint) {
    throw new Error('视频源文件在入队后发生变化')
  }
  return inspected
}

function isBatchTerminal(status) {
  return ['succeeded', 'completed_with_errors'].includes(status)
}

function legacyMigrationError(error) {
  return `旧版批次不能安全迁移，已暂停：${error instanceof Error ? error.message : String(error)}`.slice(0, 2_000)
}

export async function prepareBatchStateForExecution(path) {
  const state = await readBatchState(path)
  if (state.schemaVersion === 2 || isBatchTerminal(state.status)) return state
  try {
    const identity = batchRequestIdentity(state)
    const items = []
    for (const item of state.items) {
      if (!item || typeof item !== 'object' || !item.taskId || !item.sourcePath) {
        throw new Error('旧版条目缺少任务编号或源路径')
      }
      const inspected = await inspectVideoFile(item.sourcePath)
      if (Number(item.sourceBytes) !== inspected.sourceBytes) {
        throw new Error(`源文件大小已变化：${basename(item.sourcePath)}`)
      }
      items.push({
        ...item,
        sourcePath: inspected.sourcePath,
        sourceBytes: inspected.sourceBytes,
        sourceFingerprint: await sourceFingerprint(inspected.sourcePath),
      })
    }
    const migratedStatus = state.status === 'paused' ? 'paused' : state.status
    return writeBatchState(path, {
      ...state,
      ...identity,
      schemaVersion: 2,
      requestFingerprint: stableFingerprint(identity),
      items,
      status: migratedStatus,
      error: migratedStatus === 'paused' ? state.error || null : null,
    })
  } catch (error) {
    return writeBatchState(path, {
      ...state,
      status: 'paused',
      error: legacyMigrationError(error),
    })
  }
}

export function singleVideoStatePath(taskId, root = defaultBatchRoot()) {
  const batchId = `single:${stableFingerprint(String(taskId || '')).slice(0, 32)}`
  return batchStatePath(batchId, root)
}

export async function readSingleVideoTaskState(taskId, root = defaultBatchRoot()) {
  const state = await readBatchState(singleVideoStatePath(taskId, root))
  if (state.kind !== 'single' || state.items.length !== 1 || state.items[0]?.taskId !== taskId) {
    throw new Error('单视频任务状态文件无效')
  }
  return { state, item: state.items[0] }
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
  return acquireFileLock(`${resolve(statePath)}.lock`)
}

export async function acquireGlobalBatchLock(statePath) {
  return acquireFileLock(globalBatchLockPath(statePath))
}

async function acquireFileLock(lockPath) {
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  await chmod(dirname(lockPath), 0o700)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = randomUUID()
    try {
      const handle = await open(lockPath, 'wx', 0o600)
      const ownership = JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })
      await handle.writeFile(`${ownership}\n`)
      return {
        acquired: true,
        async release() {
          await handle.close().catch(() => undefined)
          const current = await readFile(lockPath, 'utf8').catch(() => '')
          let currentToken = null
          try { currentToken = JSON.parse(current).token } catch { currentToken = null }
          if (currentToken === token) await rm(lockPath, { force: true }).catch(() => undefined)
        },
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const lockText = String(await readFile(lockPath, 'utf8').catch(() => '')).trim()
      let pid = /^\d+$/u.test(lockText) ? Number(lockText) : null
      try {
        const parsedLock = JSON.parse(lockText)
        pid = Number.isInteger(parsedLock?.pid) ? parsedLock.pid : null
      } catch { /* legacy PID-only lock or an owner still writing the lock */ }
      if (await pidIsAlive(pid)) return { acquired: false, release: async () => undefined }
      const lockStat = await stat(lockPath).catch(() => null)
      if ((!Number.isInteger(pid) || pid <= 0) && lockStat && Date.now() - lockStat.mtimeMs < 30_000) {
        return { acquired: false, release: async () => undefined }
      }
      await rm(lockPath, { force: true })
    }
  }
  return { acquired: false, release: async () => undefined }
}

export async function listBatchStatePaths(statePath, { onWarning } = {}) {
  const root = dirname(resolve(statePath))
  const entries = await readdir(root, { withFileTypes: true })
  const states = []
  for (const entry of entries) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue
    const path = join(root, entry.name)
    try {
      const state = await readBatchState(path)
      if (state.schemaVersion === 1 && isBatchTerminal(state.status)) continue
      states.push({ path, state })
    } catch (error) {
      onWarning?.(`忽略无效批次状态 ${entry.name}：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  states.sort((left, right) => {
    const createdOrder = String(left.state.createdAt).localeCompare(String(right.state.createdAt))
    if (createdOrder) return createdOrder
    return String(left.state.batchId).localeCompare(String(right.state.batchId))
  })
  return states.map(entry => entry.path)
}

export async function markBatchQueued(path) {
  const state = await readBatchState(path)
  if (isBatchTerminal(state.status)) return state
  return writeBatchState(path, {
    ...state,
    status: 'queued',
    error: null,
  })
}

export function batchItemDisplayName(item) {
  return basename(String(item?.sourcePath || item?.name || 'video'))
}
