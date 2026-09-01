import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import {
  SUPPORTED_VIDEO_EXTENSIONS,
  inspectVideoFile,
  normalizeMaterialId,
  sameSourceIdentity,
  sha256FileHandle,
  sourceIdentity,
} from './media-ingest.mjs'
import { assertOptionalDirectorWork } from './director-work-policy.mjs'

const BATCH_ID_PATTERN = /^[A-Za-z0-9._:-]+$/
const MAX_BATCH_ITEMS = 100
const MAX_STATUS_SEARCH_QUERY = 512
const MAX_STATUS_SEARCH_MATCHES = 32
const MAX_DUPLICATE_MATCHES = 32
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MATERIAL_HANDOFF_JOURNAL_SCHEMA_VERSION = 1

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
  trustedExistingMaterialId,
  directorWork,
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
    ...(trustedExistingMaterialId === undefined
      ? {}
      : { trustedExistingMaterialId: normalizeMaterialId(trustedExistingMaterialId) }),
    ...(directorWork === undefined || directorWork === null
      ? {}
      : { directorWork: String(directorWork) }),
  }
}

export function sourceFingerprintFromIdentity(sourcePath, identity) {
  return stableFingerprint({
    path: sourcePath,
    bytes: identity.size,
    modifiedMs: identity.mtimeMs,
    changedMs: identity.ctimeMs,
    device: identity.dev,
    inode: identity.ino,
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
  const matches = []
  let statePaths
  try {
    statePaths = await listControlledStatePaths(stateRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') return { matches: [], total: 0, truncated: false }
    throw error
  }

  for (const path of statePaths) {
    let state
    try {
      state = await readBatchState(path)
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

export function batchStateBackupPath(statePath) {
  return `${resolve(statePath)}.bak`
}

function controlledStatePath(root, name) {
  const primaryName = name.endsWith('.bak') ? name.slice(0, -4) : name
  if (!/^[a-f0-9]{64}\.json$/u.test(primaryName)) return null
  return join(resolve(root), primaryName)
}

async function listControlledStatePaths(root) {
  const entries = await readdir(resolve(root), { withFileTypes: true })
  const paths = new Set()
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const path = controlledStatePath(root, entry.name)
    if (path) paths.add(path)
  }
  return [...paths]
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
  const matches = []
  let statePaths
  try {
    statePaths = await listControlledStatePaths(stateRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') return { matches: [], total: 0, truncated: false }
    throw error
  }

  for (const path of statePaths) {
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
    videos.push({
      name,
      path: inspected.sourcePath,
      bytes: inspected.sourceBytes,
      sourceIdentity: inspected.sourceIdentity,
    })
  }
  return { directory, videos }
}

function invalidBatchStateError(message = '批次状态文件无效', cause) {
  const error = new Error(message)
  error.code = 'EBADSTATE'
  if (cause) error.cause = cause
  return error
}

function trustedMaterialStateValid(items) {
  return items.every(item => {
    if (!item || typeof item !== 'object' || Object.hasOwn(item, 'materialId')) return false
    if (!Object.hasOwn(item, 'trustedExistingMaterialId')) return true
    try {
      return item.trustedExistingMaterialId === normalizeMaterialId(item.trustedExistingMaterialId)
    } catch {
      return false
    }
  })
}

function sourceIdentityValid(value) {
  return value === undefined || (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'ctimeMs,dev,ino,mtimeMs,size'
    && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => Number.isFinite(value[key]))
    && value.size > 0
  )
}

function artifactIdentityValid(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'ctimeMs,dev,ino,mtimeMs,size'
    && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => Number.isFinite(value[key]))
    && value.size >= 0
  )
}

function stagingRecoveryValid(value) {
  if (value === undefined) return true
  const keys = value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort().join(',')
    : ''
  const legacyKeys = 'anchorName,batchId,contentSha256,idempotencyKey,incomingIdentity,incomingName,materialId,ownershipToken,phase,schemaVersion,sourceIdentity,stagedIdentity,taskId,videoKey'
  const checkpointKeys = 'anchorName,anchoredIdentity,batchId,contentSha256,idempotencyKey,incomingIdentity,incomingName,materialId,ownershipToken,phase,schemaVersion,sourceIdentity,stagedIdentity,taskId,videoKey'
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || ![legacyKeys, checkpointKeys].includes(keys)
    || value.schemaVersion !== 1
    || ![
      'prepared', 'anchor_observed', 'copy_observed', 'source_finalized', 'staged', 'triggering',
      'discarding_prepared', 'discarding',
    ].includes(value.phase)
    || value.sourceIdentity === undefined
    || !sourceIdentityValid(value.sourceIdentity)
    || ![value.taskId, value.idempotencyKey, value.batchId].every(field => (
      typeof field === 'string'
      && field.length > 0
      && field.length <= 240
      && !/[\u0000-\u001f\u007f]/u.test(field)
    ))
    || typeof value.ownershipToken !== 'string'
    || !UUID_PATTERN.test(value.ownershipToken)
  ) return false
  const anchor = /^\.source-anchor-(\d+)-([0-9a-f-]{36})$/u.exec(value.anchorName)
  const videoKeyParts = /^([0-9a-f-]{36})\.(?:mp4|mov|mkv|webm|m4v)$/u.exec(value.videoKey)
  const videoKeyValid = Boolean(videoKeyParts && UUID_PATTERN.test(videoKeyParts[1]))
  const materialIdValid = ['staged', 'triggering', 'discarding'].includes(value.phase)
    ? (() => {
        try {
          return value.materialId === normalizeMaterialId(value.materialId)
        } catch {
          return false
        }
      })()
    : value.materialId === null
  const completed = ['staged', 'triggering', 'discarding'].includes(value.phase)
  const artifactIdentitiesValid = (value.incomingIdentity === null || artifactIdentityValid(value.incomingIdentity))
    && (value.stagedIdentity === null || sourceIdentityValid(value.stagedIdentity))
    && (value.anchoredIdentity === undefined
      || value.anchoredIdentity === null
      || sourceIdentityValid(value.anchoredIdentity))
    && (completed
      ? value.stagedIdentity !== null && value.contentSha256 !== null
      : value.stagedIdentity === null && value.contentSha256 === null)
    && (value.contentSha256 === null || /^[a-f0-9]{64}$/u.test(value.contentSha256))
  return Boolean(
    anchor
    && anchor[2] === value.ownershipToken
    && videoKeyValid
    && value.incomingName === `.incoming-${anchor[1]}-${value.videoKey}`
    && materialIdValid
    && artifactIdentitiesValid
  )
}

function parseBatchStateText(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw invalidBatchStateError('批次状态文件不是有效 JSON', error)
  }
  const validV1 = parsed?.schemaVersion === 1 && Array.isArray(parsed.items)
  const validV2 = parsed?.schemaVersion === 2
    && typeof parsed.requestFingerprint === 'string'
    && /^[a-f0-9]{64}$/u.test(parsed.requestFingerprint)
    && Array.isArray(parsed.items)
    && trustedMaterialStateValid(parsed.items)
    && parsed.items.every(item => sourceIdentityValid(item?.sourceIdentity))
    && parsed.items.every(item => stagingRecoveryValid(item?.stagingRecovery))
  if (!validV1 && !validV2) {
    throw invalidBatchStateError()
  }
  return parsed
}

function isRecoverableStateError(error) {
  return error?.code === 'ENOENT' || error?.code === 'EBADSTATE'
}

export async function readBatchState(path) {
  const target = resolve(path)
  let primaryError
  try {
    return parseBatchStateText(await readFile(target, 'utf8'))
  } catch (error) {
    primaryError = error
  }
  if (!isRecoverableStateError(primaryError)) throw primaryError

  const backup = batchStateBackupPath(target)
  try {
    return parseBatchStateText(await readFile(backup, 'utf8'))
  } catch (backupError) {
    if (primaryError?.code === 'ENOENT' && backupError?.code === 'ENOENT') {
      throw primaryError
    }
    if (primaryError?.code === 'EBADSTATE' && backupError?.code === 'ENOENT') {
      throw primaryError
    }
    const message = primaryError?.code === 'ENOENT'
      ? '批次状态文件缺失且备份不可用'
      : '批次状态文件损坏且备份不可用'
    throw invalidBatchStateError(message, backupError)
  }
}

async function syncDirectory(path) {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch (error) {
    // Some filesystems do not allow fsync on directories. The file itself is
    // still durably written and the rename remains atomic on those systems.
    if (!['EISDIR', 'EINVAL', 'ENOTSUP'].includes(error?.code)) throw error
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function writeDurableText(target, text) {
  const path = resolve(target)
  const temp = `${path}.tmp.${process.pid}.${randomUUID()}`
  let handle
  try {
    handle = await open(temp, 'wx', 0o600)
    await handle.writeFile(text, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temp, path)
    await syncDirectory(dirname(path))
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function materialHandoffJournalPath(taskId, root = defaultBatchRoot()) {
  const safeTaskId = String(taskId || '')
  if (
    !safeTaskId
    || safeTaskId.length > 240
    || /[\u0000-\u001f\u007f]/u.test(safeTaskId)
  ) throw new Error('媒体身份恢复任务编号无效')
  return `${singleVideoStatePath(safeTaskId, root)}.material-handoff.json`
}

async function ensurePrivateStateRoot(root) {
  const requestedRoot = resolve(root)
  try {
    await mkdir(requestedRoot, { recursive: true, mode: 0o700 })
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const requestedStat = await lstat(requestedRoot)
  if (
    !requestedStat.isDirectory()
    || requestedStat.isSymbolicLink()
    || (requestedStat.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && requestedStat.uid !== process.getuid())
  ) throw new Error('媒体身份恢复状态目录不安全')
  const physicalRoot = await realpath(requestedRoot)
  const physicalStat = await lstat(physicalRoot)
  if (
    !physicalStat.isDirectory()
    || physicalStat.isSymbolicLink()
    || physicalStat.dev !== requestedStat.dev
    || physicalStat.ino !== requestedStat.ino
    || (physicalStat.mode & 0o777) !== 0o700
    || (typeof process.getuid === 'function' && physicalStat.uid !== process.getuid())
  ) throw new Error('媒体身份恢复状态目录不安全')
  return physicalRoot
}

function assertJournalContext(context) {
  if (
    !context
    || typeof context !== 'object'
    || Array.isArray(context)
    || typeof context.taskId !== 'string'
    || !context.taskId
    || context.taskId.length > 240
    || /[\u0000-\u001f\u007f]/u.test(context.taskId)
    || typeof context.idempotencyKey !== 'string'
    || !context.idempotencyKey
    || context.idempotencyKey.length > 240
    || /[\u0000-\u001f\u007f]/u.test(context.idempotencyKey)
    || typeof context.requestFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(context.requestFingerprint)
    || typeof context.sourcePath !== 'string'
    || context.sourceIdentity === undefined
    || !sourceIdentityValid(context.sourceIdentity)
    || typeof context.journalPath !== 'string'
    || !/^[a-f0-9]{64}\.json\.material-handoff\.json$/u.test(basename(context.journalPath))
  ) throw new Error('媒体身份恢复上下文无效')
}

function parseMaterialHandoffJournal(text) {
  let journal
  try {
    journal = JSON.parse(text)
  } catch (error) {
    throw new Error('媒体身份恢复记录损坏', { cause: error })
  }
  if (
    !journal
    || typeof journal !== 'object'
    || Array.isArray(journal)
    || Object.keys(journal).sort().join(',') !== 'createdAt,idempotencyKey,materialId,nonce,requestFingerprint,schemaVersion,sourceIdentity,sourcePath,taskId'
    || journal.schemaVersion !== MATERIAL_HANDOFF_JOURNAL_SCHEMA_VERSION
    || typeof journal.taskId !== 'string'
    || !journal.taskId
    || journal.taskId.length > 240
    || /[\u0000-\u001f\u007f]/u.test(journal.taskId)
    || typeof journal.idempotencyKey !== 'string'
    || !journal.idempotencyKey
    || journal.idempotencyKey.length > 240
    || /[\u0000-\u001f\u007f]/u.test(journal.idempotencyKey)
    || typeof journal.requestFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/u.test(journal.requestFingerprint)
    || typeof journal.sourcePath !== 'string'
    || journal.sourceIdentity === undefined
    || !sourceIdentityValid(journal.sourceIdentity)
    || typeof journal.nonce !== 'string'
    || !UUID_PATTERN.test(journal.nonce)
    || typeof journal.createdAt !== 'string'
    || !Number.isFinite(Date.parse(journal.createdAt))
  ) throw new Error('媒体身份恢复记录损坏')
  try {
    if (journal.materialId !== normalizeMaterialId(journal.materialId)) {
      throw new Error('material_id_not_canonical')
    }
  } catch (error) {
    throw new Error('媒体身份恢复记录损坏', { cause: error })
  }
  return journal
}

async function readPrivateMaterialHandoffJournal(path, { optional = false } = {}) {
  let details
  try {
    details = await lstat(path)
  } catch (error) {
    if (optional && error?.code === 'ENOENT') return null
    throw error
  }
  if (
    !details.isFile()
    || details.isSymbolicLink()
    || details.nlink !== 1
    || (details.mode & 0o777) !== 0o600
    || details.size < 2
    || details.size > 4_096
    || (typeof process.getuid === 'function' && details.uid !== process.getuid())
  ) throw new Error('媒体身份恢复记录权限无效')
  let handle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = await handle.stat()
    if (opened.dev !== details.dev || opened.ino !== details.ino) {
      throw new Error('媒体身份恢复记录发生变化')
    }
    return parseMaterialHandoffJournal(await handle.readFile({ encoding: 'utf8' }))
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

function assertJournalMatchesContext(journal, context) {
  assertJournalContext(context)
  if (
    journal.taskId !== context.taskId
    || journal.idempotencyKey !== context.idempotencyKey
    || journal.requestFingerprint !== context.requestFingerprint
    || journal.sourcePath !== context.sourcePath
    || !sameSourceIdentity(journal.sourceIdentity, {
      ...context.sourceIdentity,
      isFile: () => true,
    })
  ) throw new Error('媒体身份恢复记录与任务、来源或请求不匹配')
}

export async function prepareMaterialHandoffJournalContext({
  taskId,
  idempotencyKey,
  baseUrl,
  bindingId,
  prompt,
  visionRoute,
  directorWork,
  videoFile,
  inboxRoot,
  batchRoot = defaultBatchRoot(),
}) {
  const physicalRoot = await ensurePrivateStateRoot(batchRoot)
  const inspected = await inspectVideoFile(videoFile, { capacityRoot: inboxRoot })
  const requestIdentity = singleRequestIdentity({
    taskId,
    idempotencyKey,
    baseUrl,
    bindingId,
    prompt,
    visionRoute,
    directorWork,
    sourcePath: inspected.sourcePath,
    inboxRoot,
  })
  const context = {
    taskId: String(taskId || ''),
    idempotencyKey: String(idempotencyKey || ''),
    requestFingerprint: stableFingerprint(requestIdentity),
    sourcePath: inspected.sourcePath,
    sourceIdentity: inspected.sourceIdentity,
    journalPath: materialHandoffJournalPath(taskId, physicalRoot),
  }
  assertJournalContext(context)
  return context
}

export async function withMaterialHandoffJournalLock(taskId, batchRoot, callback) {
  if (typeof callback !== 'function') throw new TypeError('媒体身份恢复锁回调无效')
  const physicalRoot = await ensurePrivateStateRoot(batchRoot || defaultBatchRoot())
  const lockPath = `${materialHandoffJournalPath(taskId, physicalRoot)}.lock`
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const existing = await lstat(lockPath).catch(error => {
      if (error?.code === 'ENOENT') return null
      throw error
    })
    if (existing && (
      !existing.isFile()
      || existing.isSymbolicLink()
      || existing.nlink !== 1
      || (existing.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && existing.uid !== process.getuid())
    )) throw new Error('媒体身份恢复锁权限无效')
    const lock = await acquireFileLock(lockPath)
    if (lock.acquired) {
      try {
        return await callback()
      } finally {
        await lock.release()
      }
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))
  }
  throw new Error('同一视频任务正在恢复媒体身份，请稍后重试')
}

export async function readMaterialHandoffJournal(context) {
  assertJournalContext(context)
  const journal = await readPrivateMaterialHandoffJournal(context.journalPath, { optional: true })
  if (!journal) return null
  assertJournalMatchesContext(journal, context)
  const currentSource = await stat(context.sourcePath)
  if (!sameSourceIdentity(journal.sourceIdentity, currentSource)) {
    throw new Error('媒体身份恢复记录对应的视频已变化')
  }
  return journal
}

export async function writeMaterialHandoffJournal(context, { materialId, nonce }) {
  assertJournalContext(context)
  const normalizedMaterialId = normalizeMaterialId(materialId)
  if (typeof nonce !== 'string' || !UUID_PATTERN.test(nonce)) {
    throw new Error('媒体身份交接凭证 nonce 无效')
  }
  const existing = await readPrivateMaterialHandoffJournal(context.journalPath, { optional: true })
  if (existing) {
    assertJournalMatchesContext(existing, context)
    // A producer may have lost the ACK after the consumer journal became
    // durable and legitimately recreated its delivery credential. The
    // material identity is authoritative; a new nonce is only a transport
    // attempt and must not permanently wedge the same task.
    if (existing.materialId !== normalizedMaterialId) {
      throw new Error('同一任务存在冲突的媒体身份恢复记录')
    }
    return existing
  }
  const journal = {
    schemaVersion: MATERIAL_HANDOFF_JOURNAL_SCHEMA_VERSION,
    taskId: context.taskId,
    idempotencyKey: context.idempotencyKey,
    requestFingerprint: context.requestFingerprint,
    sourcePath: context.sourcePath,
    sourceIdentity: context.sourceIdentity,
    materialId: normalizedMaterialId,
    nonce,
    createdAt: new Date().toISOString(),
  }
  await writeDurableText(context.journalPath, `${JSON.stringify(journal)}\n`)
  const persisted = await readPrivateMaterialHandoffJournal(context.journalPath)
  assertJournalMatchesContext(persisted, context)
  if (persisted.materialId !== normalizedMaterialId || persisted.nonce !== nonce) {
    throw new Error('媒体身份恢复记录写后校验失败')
  }
  return persisted
}

export async function clearMaterialHandoffJournal(context, expectedJournal) {
  assertJournalContext(context)
  const current = await readPrivateMaterialHandoffJournal(context.journalPath, { optional: true })
  if (!current) return false
  assertJournalMatchesContext(current, context)
  if (expectedJournal && (
    current.materialId !== expectedJournal.materialId
    || current.nonce !== expectedJournal.nonce
  )) throw new Error('媒体身份恢复记录清理冲突')
  await rm(context.journalPath)
  await syncDirectory(dirname(context.journalPath))
  return true
}

export async function writeBatchState(path, state) {
  const target = resolve(path)
  const parent = dirname(target)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  await chmod(parent, 0o700)
  const next = { ...state, updatedAt: new Date().toISOString() }
  const nextText = `${JSON.stringify(next, null, 2)}\n`
  // Refuse to create a checkpoint that cannot be read by the same validator
  // used by workers and status queries.
  parseBatchStateText(nextText)

  const backup = batchStateBackupPath(target)
  let currentText = null
  try {
    const candidate = await readFile(target, 'utf8')
    parseBatchStateText(candidate)
    currentText = candidate
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'EBADSTATE') throw error
  }

  if (currentText !== null) {
    // Preserve the last known-good state before replacing the primary file.
    await writeDurableText(backup, currentText)
  } else {
    let backupValid = false
    try {
      parseBatchStateText(await readFile(backup, 'utf8'))
      backupValid = true
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EBADSTATE') throw error
    }
    // The first write also gets a backup. This closes the window where a
    // freshly created task could otherwise disappear before its next update.
    if (!backupValid) await writeDurableText(backup, nextText)
  }

  await writeDurableText(target, nextText)
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
            sourceFingerprint: sourceFingerprintFromIdentity(video.path, video.sourceIdentity),
            sourceIdentity: video.sourceIdentity,
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

function assertSingleVideoInput(
  state,
  requestIdentityInput,
  requestFingerprint,
  trustedExistingMaterialId,
) {
  const persistedMaterialId = state.items?.[0]?.trustedExistingMaterialId
  const expectedFingerprint = trustedExistingMaterialId === undefined && persistedMaterialId !== undefined
    ? stableFingerprint(singleRequestIdentity({
        ...requestIdentityInput,
        trustedExistingMaterialId: persistedMaterialId,
      }))
    : requestFingerprint
  if (state.requestFingerprint !== expectedFingerprint) {
    throw new Error('同一任务 ID 已绑定其他视频、提示词或执行配置')
  }
  if (trustedExistingMaterialId === undefined) return
  if (
    persistedMaterialId === undefined
    || persistedMaterialId !== normalizeMaterialId(trustedExistingMaterialId)
  ) throw new Error('同一任务 ID 已绑定其他视频、提示词或执行配置')
}

export async function createSingleVideoState(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new TypeError('single_video_request_invalid')
  }
  if (Object.hasOwn(request, 'materialId')) throw new Error('untrusted_material_id_field')
  const {
    taskId,
    idempotencyKey,
    baseUrl,
    bindingId,
    prompt,
    visionRoute,
    videoFile,
    expectedSourceIdentity,
    trustedExistingMaterialId,
    directorWork,
    inboxRoot,
    batchRoot,
    confirmDuplicate = false,
  } = request
  const normalizedTrustedExistingMaterialId = trustedExistingMaterialId === undefined
    ? undefined
    : normalizeMaterialId(trustedExistingMaterialId)
  assertOptionalDirectorWork(directorWork)
  const inspected = await inspectVideoFile(videoFile, { capacityRoot: inboxRoot })
  if (expectedSourceIdentity !== undefined && !sameSourceIdentity(expectedSourceIdentity, {
    ...inspected.sourceIdentity,
    isFile: () => true,
  })) throw new Error('视频源文件在入队期间发生变化')
  const requestIdentityInput = {
    taskId,
    idempotencyKey,
    baseUrl,
    bindingId,
    sourcePath: inspected.sourcePath,
    prompt,
    visionRoute,
    inboxRoot,
    directorWork,
  }
  const requestIdentity = singleRequestIdentity({
    ...requestIdentityInput,
    trustedExistingMaterialId: normalizedTrustedExistingMaterialId,
  })
  const requestFingerprint = stableFingerprint(requestIdentity)
  const statePath = singleVideoStatePath(taskId, batchRoot)
  const batchId = `single:${stableFingerprint(String(taskId || '')).slice(0, 32)}`
  try {
    const state = await readBatchState(statePath)
    assertSingleVideoInput(
      state,
      requestIdentityInput,
      requestFingerprint,
      normalizedTrustedExistingMaterialId,
    )
    return { statePath, state, duplicate: true }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const createLock = await acquireFileLock(`${statePath}.create.lock`)
  if (!createLock.acquired) throw new Error('同一视频任务正在初始化，请稍后查询同一任务')
  try {
    try {
      const state = await readBatchState(statePath)
      assertSingleVideoInput(
        state,
        requestIdentityInput,
        requestFingerprint,
        normalizedTrustedExistingMaterialId,
      )
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
        ...(directorWork === undefined || directorWork === null ? {} : { directorWork }),
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
          sourceFingerprint: sourceFingerprintFromIdentity(inspected.sourcePath, inspected.sourceIdentity),
          sourceIdentity: inspected.sourceIdentity,
          taskId,
          idempotencyKey,
          ...(normalizedTrustedExistingMaterialId === undefined
            ? {}
            : { trustedExistingMaterialId: normalizedTrustedExistingMaterialId }),
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
    || (item.sourceIdentity !== undefined && !sameSourceIdentity(item.sourceIdentity, {
      ...inspected.sourceIdentity,
      isFile: () => true,
    }))
    || sourceFingerprintFromIdentity(inspected.sourcePath, inspected.sourceIdentity) !== item.sourceFingerprint) {
    throw new Error('视频源文件在入队后发生变化')
  }
  return inspected
}

function sameStableSourceIdentity(expected, current) {
  return current.isFile()
    && current.dev === expected.dev
    && current.ino === expected.ino
    && current.size === expected.size
    && current.mtimeMs === expected.mtimeMs
}

function sameArtifactInode(expected, current) {
  return current.isFile()
    && current.dev === expected.dev
    && current.ino === expected.ino
}

async function optionalLstat(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function assertRecoveryBinding(item, recovery, binding) {
  if (
    !binding
    || recovery.taskId !== item.taskId
    || recovery.idempotencyKey !== item.idempotencyKey
    || recovery.taskId !== binding.taskId
    || recovery.idempotencyKey !== binding.idempotencyKey
    || recovery.batchId !== binding.batchId
  ) throw new Error('视频暂存恢复记录与任务绑定不匹配')
}

function cleanupClaimPath(inbox, ownershipToken, claimSlot) {
  return join(inbox, `.cleanup-claim-${ownershipToken}-${claimSlot}`)
}

function selectRecoveryArtifact(originalStat, claimStat) {
  if (originalStat && claimStat) throw new Error('视频暂存清理认领冲突')
  return claimStat || originalStat
}

async function claimAndRemoveArtifact(path, {
  inbox,
  ownershipToken,
  claimSlot,
  expectedIdentity = null,
  expectedContentSha256 = null,
  validateIdentity = null,
} = {}) {
  if (!['incoming', 'final', 'anchor'].includes(claimSlot)) {
    throw new Error('视频暂存清理认领类型无效')
  }
  const claimPath = cleanupClaimPath(inbox, ownershipToken, claimSlot)
  const originalStat = await optionalLstat(path)
  const existingClaimStat = await optionalLstat(claimPath)
  if (originalStat && existingClaimStat) throw new Error('视频暂存清理认领冲突')
  if (!originalStat && !existingClaimStat) return false
  const selectedStat = originalStat || existingClaimStat
  if (!selectedStat.isFile() || selectedStat.isSymbolicLink()) {
    throw new Error('视频暂存清理对象无效')
  }
  if (expectedIdentity && !sameStableSourceIdentity(expectedIdentity, selectedStat)) {
    throw new Error('视频暂存清理对象身份不匹配')
  }
  if (validateIdentity && !validateIdentity(selectedStat)) {
    throw new Error('视频暂存清理对象身份不匹配')
  }
  if (originalStat) {
    try {
      await rename(path, claimPath)
    } catch (error) {
      if (error?.code === 'ENOENT') return false
      throw error
    }
  }
  let handle
  try {
    const claimedStat = await lstat(claimPath)
    if (!claimedStat.isFile() || claimedStat.isSymbolicLink()) {
      throw new Error('视频暂存清理对象无效')
    }
    handle = await open(claimPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const handleStat = await handle.stat()
    if (
      claimedStat.dev !== selectedStat.dev
      || claimedStat.ino !== selectedStat.ino
      || handleStat.dev !== selectedStat.dev
      || handleStat.ino !== selectedStat.ino
      || handleStat.size !== selectedStat.size
      || handleStat.mtimeMs !== selectedStat.mtimeMs
    ) {
      throw new Error('视频暂存清理对象在认领后发生变化')
    }
    if (validateIdentity && !validateIdentity(handleStat)) {
      throw new Error('视频暂存清理对象身份不匹配')
    }
    if (expectedContentSha256 && await sha256FileHandle(handle) !== expectedContentSha256) {
      throw new Error('视频暂存清理对象内容不匹配')
    }
    const afterValidation = await handle.stat()
    if (
      afterValidation.dev !== handleStat.dev
      || afterValidation.ino !== handleStat.ino
      || afterValidation.size !== handleStat.size
      || afterValidation.mtimeMs !== handleStat.mtimeMs
    ) throw new Error('视频暂存清理对象在校验期间发生变化')
    await handle.close()
    handle = null
    await rm(claimPath)
    return true
  } catch (error) {
    await handle?.close().catch(() => undefined)
    if (!await optionalLstat(path)) {
      await rename(claimPath, path).catch(() => undefined)
    }
    throw error
  }
}

export async function recoverBatchItemStaging(item, {
  inboxRoot,
  binding,
  onCheckpoint = null,
} = {}) {
  const initialRecovery = item?.stagingRecovery
  if (initialRecovery === undefined) return null
  if (!stagingRecoveryValid(initialRecovery)) throw new Error('视频暂存恢复记录无效')
  assertRecoveryBinding(item, initialRecovery, binding)
  if (onCheckpoint !== null && typeof onCheckpoint !== 'function') {
    throw new TypeError('staging_recovery_checkpoint_invalid')
  }
  if (!item.sourceIdentity || !sameSourceIdentity(item.sourceIdentity, {
    ...initialRecovery.sourceIdentity,
    isFile: () => true,
  })) throw new Error('视频暂存恢复记录与任务身份不匹配')

  const inbox = resolve(inboxRoot)
  const anchorPath = join(inbox, initialRecovery.anchorName)
  const incomingPath = join(inbox, initialRecovery.incomingName)
  const stagedPath = join(inbox, initialRecovery.videoKey)
  const anchorClaimPath = cleanupClaimPath(inbox, initialRecovery.ownershipToken, 'anchor')
  const incomingClaimPath = cleanupClaimPath(inbox, initialRecovery.ownershipToken, 'incoming')
  const stagedClaimPath = cleanupClaimPath(inbox, initialRecovery.ownershipToken, 'final')
  let recovery = initialRecovery
  let currentSource = await stat(item.sourcePath)
  if (!sameStableSourceIdentity(initialRecovery.sourceIdentity, currentSource)) {
    throw new Error('视频源文件在暂存恢复前发生变化')
  }

  const [
    anchorOriginalStat,
    anchorClaimStat,
    incomingOriginalStat,
    incomingClaimStat,
    stagedOriginalStat,
    stagedClaimStat,
  ] = await Promise.all([
    optionalLstat(anchorPath),
    optionalLstat(anchorClaimPath),
    optionalLstat(incomingPath),
    optionalLstat(incomingClaimPath),
    optionalLstat(stagedPath),
    optionalLstat(stagedClaimPath),
  ])
  // A deterministic claim is the journal-bound continuation of its original
  // artifact after rename. Inspect every pair before removing anything so a
  // conflicting original+claim or a drifted claim fails closed.
  const anchorStat = selectRecoveryArtifact(anchorOriginalStat, anchorClaimStat)
  const incomingStat = selectRecoveryArtifact(incomingOriginalStat, incomingClaimStat)
  const stagedStat = selectRecoveryArtifact(stagedOriginalStat, stagedClaimStat)
  if (anchorStat && (
    !anchorStat.isFile()
    || anchorStat.isSymbolicLink()
    || anchorStat.nlink < 2
    || !sameStableSourceIdentity(initialRecovery.sourceIdentity, anchorStat)
  )) throw new Error('视频暂存恢复锚点无效')
  if (incomingStat && (
    !incomingStat.isFile()
    || incomingStat.isSymbolicLink()
    || incomingStat.size > initialRecovery.sourceIdentity.size
  )) throw new Error('视频暂存恢复副本无效')
  if (stagedStat && (
    !stagedStat.isFile()
    || stagedStat.isSymbolicLink()
    || stagedStat.size !== initialRecovery.sourceIdentity.size
  )) throw new Error('视频暂存恢复成品无效')
  if (['staged', 'triggering', 'discarding'].includes(recovery.phase)) {
    throw new Error('已完成的视频暂存必须通过平台交接恢复')
  }
  if (stagedStat && !['source_finalized', 'copy_observed'].includes(recovery.phase)) {
    throw new Error('视频暂存恢复阶段与成品不匹配')
  }

  let observedPhase = null
  if (anchorStat) observedPhase = 'anchor_observed'
  else if (incomingStat) observedPhase = 'copy_observed'
  if (observedPhase && recovery.phase === 'prepared') {
    recovery = Object.freeze({ ...recovery, phase: observedPhase })
    await onCheckpoint?.(recovery)
  }
  if (!anchorStat && !incomingStat && !stagedStat
    && recovery.phase === 'prepared'
    && !sameSourceIdentity(initialRecovery.sourceIdentity, currentSource)) {
    throw new Error('视频源文件在暂存恢复前发生变化')
  }

  // Remove the copy first. Removing the hard-link anchor is the only cleanup
  // step that changes source ctime; the observed phase is already durable.
  if (incomingStat && recovery.incomingIdentity === null) {
    throw new Error('视频暂存恢复副本身份未持久化')
  }
  if (incomingStat && !sameArtifactInode(recovery.incomingIdentity, incomingStat)) {
    throw new Error('视频暂存恢复副本身份不匹配')
  }
  if (stagedStat && recovery.stagedIdentity !== null
    && !sameStableSourceIdentity(recovery.stagedIdentity, stagedStat)) {
    throw new Error('视频暂存恢复成品身份不匹配')
  }
  if (incomingStat) {
    await claimAndRemoveArtifact(incomingPath, {
      inbox,
      ownershipToken: recovery.ownershipToken,
      claimSlot: 'incoming',
      validateIdentity: details => sameArtifactInode(recovery.incomingIdentity, details)
        && details.size <= recovery.sourceIdentity.size,
    })
  }
  if (stagedStat && recovery.stagedIdentity === null && recovery.incomingIdentity === null) {
    throw new Error('视频暂存恢复成品身份未持久化')
  }
  if (stagedStat && recovery.stagedIdentity === null
    && !sameArtifactInode(recovery.incomingIdentity, stagedStat)) {
    throw new Error('视频暂存恢复成品身份不匹配')
  }
  if (stagedStat) {
    await claimAndRemoveArtifact(stagedPath, {
      inbox,
      ownershipToken: recovery.ownershipToken,
      claimSlot: 'final',
      expectedIdentity: recovery.stagedIdentity,
      expectedContentSha256: recovery.stagedIdentity === null ? null : recovery.contentSha256,
      validateIdentity: recovery.stagedIdentity === null
        ? details => sameArtifactInode(recovery.incomingIdentity, details)
          && details.size <= recovery.sourceIdentity.size
        : null,
    })
  }
  if (anchorStat) {
    await claimAndRemoveArtifact(anchorPath, {
      inbox,
      ownershipToken: recovery.ownershipToken,
      claimSlot: 'anchor',
      validateIdentity: details => details.nlink >= 2
        && sameStableSourceIdentity(recovery.sourceIdentity, details),
    })
  }

  currentSource = await stat(item.sourcePath)
  if (!sameStableSourceIdentity(initialRecovery.sourceIdentity, currentSource)) {
    throw new Error('视频源文件在暂存恢复期间发生变化')
  }
  return {
    sourceIdentity: sourceIdentity(currentSource),
    recovery,
  }
}

export async function loadBatchItemStagedMedia(item, { inboxRoot, binding } = {}) {
  const recovery = item?.stagingRecovery
  if (!stagingRecoveryValid(recovery) || !['staged', 'triggering'].includes(recovery.phase)) {
    throw new Error('视频平台交接恢复记录无效')
  }
  assertRecoveryBinding(item, recovery, binding)
  if (!item.sourceIdentity || !sameSourceIdentity(item.sourceIdentity, {
    ...recovery.sourceIdentity,
    isFile: () => true,
  })) throw new Error('视频平台交接恢复记录与任务身份不匹配')
  const inbox = resolve(inboxRoot)
  const stagedPath = join(inbox, recovery.videoKey)
  const [stagedStat, anchorStat, incomingStat] = await Promise.all([
    optionalLstat(stagedPath),
    optionalLstat(join(inbox, recovery.anchorName)),
    optionalLstat(join(inbox, recovery.incomingName)),
  ])
  if (
    !stagedStat
    || !stagedStat.isFile()
    || stagedStat.isSymbolicLink()
    || stagedStat.size !== item.sourceBytes
    || anchorStat
    || incomingStat
  ) throw new Error('视频平台交接暂存文件无效')
  let handle
  try {
    handle = await open(stagedPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    const handleStat = await handle.stat()
    if (
      handleStat.dev !== stagedStat.dev
      || handleStat.ino !== stagedStat.ino
      || !sameSourceIdentity(recovery.stagedIdentity, handleStat)
    ) throw new Error('视频平台交接暂存文件身份不匹配')
    const contentSha256 = await sha256FileHandle(handle)
    const afterHash = await handle.stat()
    if (!sameSourceIdentity(recovery.stagedIdentity, afterHash)) {
      throw new Error('视频平台交接暂存文件在校验期间发生变化')
    }
    if (contentSha256 !== recovery.contentSha256) {
      throw new Error('视频平台交接暂存文件已变化')
    }
  } finally {
    await handle?.close().catch(() => undefined)
  }
  return {
    sourcePath: item.sourcePath,
    sourceBytes: item.sourceBytes,
    extension: extname(recovery.videoKey),
    inbox,
    videoKey: recovery.videoKey,
    materialId: recovery.materialId,
    stagedPath,
    sourceIdentity: recovery.sourceIdentity,
    stagedIdentity: recovery.stagedIdentity,
    contentSha256: recovery.contentSha256,
    ownershipToken: recovery.ownershipToken,
    taskId: recovery.taskId,
    idempotencyKey: recovery.idempotencyKey,
    batchId: recovery.batchId,
  }
}

export async function cleanupBatchItemStagedMedia(item, { inboxRoot, binding } = {}) {
  const recovery = item?.stagingRecovery
  if (!stagingRecoveryValid(recovery) || !['discarding_prepared', 'discarding'].includes(recovery.phase)) {
    throw new Error('视频本地暂存清理记录无效')
  }
  assertRecoveryBinding(item, recovery, binding)
  const inbox = resolve(inboxRoot)
  const artifacts = [
    {
      path: join(inbox, recovery.incomingName),
      claimSlot: 'incoming',
      expectedIdentity: null,
      expectedContentSha256: null,
      removable: recovery.incomingIdentity !== null,
      validateIdentity: recovery.incomingIdentity === null
        ? null
        : details => sameArtifactInode(recovery.incomingIdentity, details)
          && details.size <= recovery.sourceIdentity.size,
    },
    {
      path: join(inbox, recovery.videoKey),
      claimSlot: 'final',
      expectedIdentity: recovery.stagedIdentity,
      expectedContentSha256: recovery.contentSha256,
      removable: (recovery.stagedIdentity !== null && recovery.contentSha256 !== null)
        || recovery.incomingIdentity !== null,
      validateIdentity: recovery.stagedIdentity === null && recovery.incomingIdentity !== null
        ? details => sameArtifactInode(recovery.incomingIdentity, details)
          && details.size <= recovery.sourceIdentity.size
        : null,
    },
    {
      path: join(inbox, recovery.anchorName),
      claimSlot: 'anchor',
      expectedIdentity: null,
      expectedContentSha256: null,
      removable: true,
      validateIdentity: details => details.nlink >= 2
        && sameStableSourceIdentity(recovery.sourceIdentity, details),
    },
  ]
  for (const artifact of artifacts) {
    if (!artifact.removable && (
      await optionalLstat(artifact.path)
      || await optionalLstat(join(inbox, `.cleanup-claim-${recovery.ownershipToken}-${artifact.claimSlot}`))
    )) throw new Error('视频暂存清理对象身份未持久化')
    if (!artifact.removable) continue
    await claimAndRemoveArtifact(artifact.path, {
      inbox,
      ownershipToken: recovery.ownershipToken,
      claimSlot: artifact.claimSlot,
      expectedIdentity: artifact.expectedIdentity,
      expectedContentSha256: artifact.expectedContentSha256,
      validateIdentity: artifact.validateIdentity,
    })
  }
  const currentSource = await stat(item.sourcePath).catch(error => {
    if (error?.code === 'ENOENT') return null
    throw error
  })
  return {
    sourceIdentity: currentSource && sameStableSourceIdentity(recovery.sourceIdentity, currentSource)
      ? sourceIdentity(currentSource)
      : recovery.sourceIdentity,
  }
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
        sourceFingerprint: sourceFingerprintFromIdentity(inspected.sourcePath, inspected.sourceIdentity),
        sourceIdentity: inspected.sourceIdentity,
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
    let handle
    try {
      handle = await open(lockPath, 'wx', 0o600)
      const ownership = JSON.stringify({ pid: process.pid, token, createdAt: new Date().toISOString() })
      await handle.writeFile(`${ownership}\n`)
      await handle.sync()
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
      await handle?.close().catch(() => undefined)
      // If the exclusive create succeeded, this process owns the path even if
      // writing its metadata failed. Never leave a half-written marker behind.
      if (handle) await rm(lockPath, { force: true }).catch(() => undefined)
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
  let statePaths
  try {
    statePaths = await listControlledStatePaths(root)
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const states = []
  for (const path of statePaths) {
    try {
      const state = await readBatchState(path)
      if (state.schemaVersion === 1 && isBatchTerminal(state.status)) continue
      states.push({ path, state })
    } catch (error) {
      onWarning?.(`忽略无效批次状态 ${basename(path)}：${error instanceof Error ? error.message : String(error)}`)
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
