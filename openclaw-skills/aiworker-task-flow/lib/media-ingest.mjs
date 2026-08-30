import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { chmod, copyFile, link, lstat, mkdir, open, readdir, realpath, rename, rm, stat, utimes } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { assertMediaCapacity, configuredMediaFileLimit } from './media-policy.mjs'

export const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v'])
const MATERIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/

export class StagedMediaCleanupError extends Error {
  constructor(primaryError, cleanupError, videoKey) {
    const rawCleanupCode = cleanupError && typeof cleanupError === 'object' && 'code' in cleanupError
      ? String(cleanupError.code)
      : 'UNKNOWN'
    const cleanupCode = /^[A-Z][A-Z0-9_]{0,31}$/u.test(rawCleanupCode)
      ? rawCleanupCode
      : 'UNKNOWN'
    super('staged_media_cleanup_failed', { cause: primaryError })
    this.name = 'StagedMediaCleanupError'
    this.code = 'ESTAGEDCLEANUP'
    this.cleanupCode = cleanupCode
    this.orphanedVideoKey = videoKey
  }
}

export function normalizeMaterialId(value) {
  if (typeof value !== 'string') throw new Error('素材稳定标识无效')
  const normalized = value.trim()
  if (!MATERIAL_ID_PATTERN.test(normalized)) throw new Error('素材稳定标识无效')
  return normalized
}

export async function deriveMaterialIdFromFile(videoFile, {
  onProgress = null,
  progressIntervalMs = 5_000,
} = {}) {
  if (onProgress !== null && typeof onProgress !== 'function') {
    throw new TypeError('素材哈希进度回调无效')
  }
  if (!Number.isInteger(progressIntervalMs) || progressIntervalMs < 100 || progressIntervalMs > 60_000) {
    throw new TypeError('素材哈希心跳间隔无效')
  }
  const hash = createHash('sha256')
  let lastProgressAt = 0
  const reportProgress = async (force = false) => {
    const now = Date.now()
    if (!force && now - lastProgressAt < progressIntervalMs) return
    lastProgressAt = now
    // Deliberately expose no path, byte count, filename, or hash state. The
    // callback is only a liveness signal for the controlled worker state.
    await onProgress?.()
  }
  await reportProgress(true)
  for await (const chunk of createReadStream(videoFile)) {
    hash.update(chunk)
    await reportProgress()
  }
  await reportProgress(true)
  return `MATERIAL-SHA256-${hash.digest('hex')}`
}

function validateProgressOptions(onProgress, progressIntervalMs) {
  if (onProgress !== null && typeof onProgress !== 'function') {
    throw new TypeError('素材哈希进度回调无效')
  }
  if (!Number.isInteger(progressIntervalMs) || progressIntervalMs < 100 || progressIntervalMs > 60_000) {
    throw new TypeError('素材哈希心跳间隔无效')
  }
}

async function withStagingHeartbeat(operation, {
  onProgress = null,
  progressIntervalMs = 5_000,
} = {}) {
  validateProgressOptions(onProgress, progressIntervalMs)
  if (onProgress === null) return operation()

  // Start before copying so both physical-copy and trusted-existing-ID paths
  // remain visibly alive. Timer beats are serialized and receive no media
  // details; the final beat is emitted only after the operation succeeds.
  await onProgress()
  let activeBeat = null
  let heartbeatError = null
  const beat = () => {
    if (heartbeatError || activeBeat) return activeBeat
    activeBeat = Promise.resolve()
      .then(() => onProgress())
      .catch(error => { heartbeatError = error })
      .finally(() => { activeBeat = null })
    return activeBeat
  }
  const timer = setInterval(() => { void beat() }, progressIntervalMs)
  timer.unref?.()
  try {
    const result = await operation()
    if (activeBeat) await activeBeat
    if (!heartbeatError) await beat()
    if (activeBeat) await activeBeat
    if (heartbeatError) throw heartbeatError
    return result
  } finally {
    clearInterval(timer)
    if (activeBeat) await activeBeat
  }
}

export function sourceIdentity(sourceStat) {
  return Object.freeze({
    dev: sourceStat.dev,
    ino: sourceStat.ino,
    size: sourceStat.size,
    mtimeMs: sourceStat.mtimeMs,
    ctimeMs: sourceStat.ctimeMs,
  })
}

function normalizeStagingBinding(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('staging_binding_invalid')
  }
  const binding = {}
  for (const key of ['taskId', 'idempotencyKey', 'batchId']) {
    const field = value[key]
    if (typeof field !== 'string' || !field || field.length > 240 || /[\u0000-\u001f\u007f]/u.test(field)) {
      throw new TypeError('staging_binding_invalid')
    }
    binding[key] = field
  }
  return Object.freeze(binding)
}

export function sameSourceIdentity(expected, current) {
  return current.isFile()
    && current.dev === expected.dev
    && current.ino === expected.ino
    && current.size === expected.size
    && current.mtimeMs === expected.mtimeMs
    && current.ctimeMs === expected.ctimeMs
}

async function assertSourceIdentity(sourcePath, expectedIdentity) {
  let current
  try {
    current = await stat(sourcePath)
  } catch (error) {
    throw new Error('视频源文件在收件期间发生变化', { cause: error })
  }
  if (!sameSourceIdentity(expectedIdentity, current)) {
    throw new Error('视频源文件在收件期间发生变化')
  }
  return current
}

async function assertHandleIdentity(sourceHandle, expectedIdentity) {
  let current
  try {
    current = await sourceHandle.stat()
  } catch (error) {
    throw new Error('视频源文件在收件期间发生变化', { cause: error })
  }
  if (!sameSourceIdentity(expectedIdentity, current)) {
    throw new Error('视频源文件在收件期间发生变化')
  }
  return current
}

async function openVerifiedSource(sourcePath, expectedIdentity) {
  let sourceHandle
  try {
    sourceHandle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    await assertHandleIdentity(sourceHandle, expectedIdentity)
    return sourceHandle
  } catch (error) {
    await sourceHandle?.close().catch(() => undefined)
    if (error?.message === '视频源文件在收件期间发生变化') throw error
    throw new Error('视频源文件在收件期间发生变化', { cause: error })
  }
}

function sourceHandlePath(sourceHandle) {
  return `/dev/fd/${sourceHandle.fd}`
}

async function copyIntoHandlePhysical(sourceHandle, destination) {
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  let position = 0
  while (true) {
    const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) break
    let written = 0
    while (written < bytesRead) {
      const result = await destination.write(buffer, written, bytesRead - written, position + written)
      written += result.bytesWritten
    }
    position += bytesRead
  }
  await destination.sync()
}

async function copyFromHandlePhysical(sourceHandle, stagedPath) {
  const destination = await open(
    stagedPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  )
  try {
    await copyIntoHandlePhysical(sourceHandle, destination)
  } finally {
    await destination.close()
  }
}

async function runDarwinCloneFallback(sourceAnchorPath, stagedPath, spawnImpl = spawn) {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl('/bin/cp', ['-c', '-n', sourceAnchorPath, stagedPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', chunk => {
      if (stderr.length < 8_192) stderr += String(chunk).slice(0, 8_192 - stderr.length)
    })
    child.once('error', rejectPromise)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`darwin_clone_fallback_failed:${code ?? signal ?? 'unknown'}:${stderr.trim()}`))
    })
  })
}

export async function copyDarwinVideoFileFromAnchor(sourceAnchorPath, stagedPath, {
  copyFileImpl = copyFile,
  spawnImpl = spawn,
} = {}) {
  try {
    await copyFileImpl(
      sourceAnchorPath,
      stagedPath,
      constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE,
    )
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    if (!['ENOSYS', 'ENOTSUP', 'EINVAL'].includes(code)) {
      throw new Error('视频与受控收件箱必须位于支持 APFS 克隆的同一文件系统，未执行大文件完整复制')
    }
    await rm(stagedPath, { force: true })
    await runDarwinCloneFallback(sourceAnchorPath, stagedPath, spawnImpl)
  }
}

async function createVerifiedSourceAnchor(sourcePath, sourceHandle, expectedIdentity, anchorPath) {
  try {
    await link(sourcePath, anchorPath)
    const [anchorStat, handleStat] = await Promise.all([stat(anchorPath), sourceHandle.stat()])
    const stableFieldsMatch = current => current.isFile()
      && current.dev === expectedIdentity.dev
      && current.ino === expectedIdentity.ino
      && current.size === expectedIdentity.size
      && current.mtimeMs === expectedIdentity.mtimeMs
    if (
      !stableFieldsMatch(anchorStat)
      || !stableFieldsMatch(handleStat)
      || anchorStat.dev !== handleStat.dev
      || anchorStat.ino !== handleStat.ino
      || anchorStat.ctimeMs !== handleStat.ctimeMs
    ) throw new Error('视频源文件在收件期间发生变化')
    return { anchorPath, anchoredIdentity: sourceIdentity(handleStat) }
  } catch (error) {
    await rm(anchorPath, { force: true })
    throw error
  }
}

function stagingOwnerPid(name) {
  const match = /^\.(?:source-anchor|incoming)-(\d+)-/u.exec(name)
  if (!match) return null
  const pid = Number(match[1])
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null
}

function processIsAlive(pid) {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export async function cleanupOrphanedMediaStaging(inbox) {
  const entries = await readdir(inbox, { withFileTypes: true })
  for (const entry of entries) {
    const ownerPid = stagingOwnerPid(entry.name)
    if (ownerPid === null || processIsAlive(ownerPid)) continue
    const pathname = join(inbox, entry.name)
    const details = await lstat(pathname).catch(() => null)
    if (!details) continue
    if (!details.isFile() || details.isSymbolicLink()) {
      throw new Error('视频收件箱存在异常的孤儿暂存目录')
    }
    await removeStagedVideo(pathname, entry.name, new Error('orphaned_media_staging'))
  }
}

export async function copyPhysicalVideoFile(sourcePath, stagedPath, {
  copyFileImpl = copyFile,
  expectedSourceIdentity = null,
} = {}) {
  const sourceBefore = await stat(sourcePath)
  if (!sourceBefore.isFile()) throw new Error('视频源文件在收件期间发生变化')
  const copyIdentity = expectedSourceIdentity || sourceIdentity(sourceBefore)
  if (!sameSourceIdentity(copyIdentity, sourceBefore)) {
    throw new Error('视频源文件在收件期间发生变化')
  }
  const sourceHandle = await openVerifiedSource(sourcePath, copyIdentity)
  try {
    if (copyFileImpl === copyFile) await copyFromHandlePhysical(sourceHandle, stagedPath)
    else await copyFileImpl(sourceHandlePath(sourceHandle), stagedPath, constants.COPYFILE_EXCL)
    await assertHandleIdentity(sourceHandle, copyIdentity)
    await assertSourceIdentity(sourcePath, copyIdentity)
  } finally {
    await sourceHandle.close()
  }
}

export async function sha256FileHandle(handle) {
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  let position = 0
  while (true) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
    if (bytesRead === 0) break
    hash.update(buffer.subarray(0, bytesRead))
    position += bytesRead
  }
  return hash.digest('hex')
}

async function removeStagedVideo(stagedPath, videoKey, primaryError, {
  expectedIdentity = null,
  expectedContentSha256 = null,
  ownershipToken = null,
  claimSlot = 'final',
  validateIdentity = null,
} = {}) {
  const deterministicClaim = ownershipToken && /^[0-9a-f-]{36}$/u.test(ownershipToken)
    && ['incoming', 'final', 'anchor'].includes(claimSlot)
  const claimPath = join(dirname(stagedPath), deterministicClaim
    ? `.cleanup-claim-${ownershipToken}-${claimSlot}`
    : `.cleanup-claim-${randomUUID()}`)
  let handle
  try {
    const originalStat = await lstat(stagedPath).catch(error => {
      if (error?.code === 'ENOENT') return null
      throw error
    })
    const existingClaimStat = await lstat(claimPath).catch(error => {
      if (error?.code === 'ENOENT') return null
      throw error
    })
    if (originalStat && existingClaimStat) throw new Error('视频暂存清理认领冲突')
    if (!originalStat && !existingClaimStat) return
    const selectedStat = originalStat || existingClaimStat
    if (!selectedStat.isFile() || selectedStat.isSymbolicLink()) {
      throw new Error('视频暂存清理对象无效')
    }
    const expectedIdentityMatches = !expectedIdentity || (selectedStat.isFile()
      && selectedStat.dev === expectedIdentity.dev
      && selectedStat.ino === expectedIdentity.ino
      && selectedStat.size === expectedIdentity.size
      && selectedStat.mtimeMs === expectedIdentity.mtimeMs)
    if (!expectedIdentityMatches) {
      throw new Error('视频暂存清理对象身份不匹配')
    }
    if (validateIdentity && !validateIdentity(selectedStat)) {
      throw new Error('视频暂存清理对象身份不匹配')
    }
    if (originalStat) {
      try {
        await rename(stagedPath, claimPath)
      } catch (error) {
        if (error?.code === 'ENOENT') return
        throw error
      }
    }
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
    ) throw new Error('视频暂存清理对象身份不匹配')
    if (validateIdentity && !validateIdentity(handleStat)) {
      throw new Error('视频暂存清理对象身份不匹配')
    }
    if (expectedContentSha256 && await sha256FileHandle(handle) !== expectedContentSha256) {
      throw new Error('视频暂存清理对象内容不匹配')
    }
    const afterHash = await handle.stat()
    if (
      afterHash.dev !== handleStat.dev
      || afterHash.ino !== handleStat.ino
      || afterHash.size !== handleStat.size
      || afterHash.mtimeMs !== handleStat.mtimeMs
    ) {
      throw new Error('视频暂存清理对象在校验期间发生变化')
    }
    await handle.close()
    handle = null
    await rm(claimPath)
  } catch (cleanupError) {
    await handle?.close().catch(() => undefined)
    const originalStillExists = await lstat(stagedPath)
      .then(() => true)
      .catch(error => error?.code === 'ENOENT' ? false : true)
    if (!originalStillExists) await rename(claimPath, stagedPath).catch(() => undefined)
    throw new StagedMediaCleanupError(primaryError, cleanupError, videoKey)
  }
}

export function defaultMediaInboxRoot() {
  return resolve(process.env.AIWORKER_MEDIA_INGEST_DIR
    || join(homedir(), 'ai-worker/state/video-autoworker/media-inbox'))
}

function inspectOptions(value) {
  if (typeof value === 'number' || value === null) return { maxBytes: value }
  return value && typeof value === 'object' ? value : {}
}

export async function inspectVideoFile(videoFile, options = {}) {
  const normalizedOptions = inspectOptions(options)
  const sourcePath = await realpath(resolve(videoFile))
  const sourceStat = await stat(sourcePath)
  if (!sourceStat.isFile() || sourceStat.size <= 0) throw new Error('视频文件无效')
  const extension = extname(sourcePath).toLowerCase()
  if (!SUPPORTED_VIDEO_EXTENSIONS.has(extension)) {
    throw new Error('视频格式只支持 mp4、mov、mkv、webm 或 m4v')
  }
  const maxBytes = normalizedOptions.maxBytes === undefined
    ? configuredMediaFileLimit()
    : normalizedOptions.maxBytes
  if (maxBytes !== null && maxBytes !== undefined) {
    const limit = Number(maxBytes)
    if (!Number.isSafeInteger(limit) || limit < 1 || sourceStat.size > limit) {
      throw new Error(`视频文件大小 ${sourceStat.size} 字节超过系统准入上限 ${limit} 字节`)
    }
  }
  if (normalizedOptions.capacityRoot) {
    await assertMediaCapacity({
      sourcePath,
      destinationRoot: normalizedOptions.capacityRoot,
      maxBytes,
    })
  }
  return {
    sourcePath,
    sourceBytes: sourceStat.size,
    extension,
    sourceIdentity: sourceIdentity(sourceStat),
  }
}

export async function stageVideoFile(videoFile, options = {}) {
  if (Object.hasOwn(options, 'materialId')) throw new Error('untrusted_material_id_field')
  if (options.onStagingPrepared !== undefined
    && typeof options.onStagingPrepared !== 'function') {
    throw new TypeError('staging_recovery_callback_invalid')
  }
  const stagingBinding = options.onStagingPrepared === undefined
    ? null
    : normalizeStagingBinding(options.stagingBinding)
  if (options.onStagingCompleted !== undefined
    && typeof options.onStagingCompleted !== 'function') {
    throw new TypeError('staging_completion_callback_invalid')
  }
  for (const [name, callback] of [
    ['staging_cleanup', options.onStagingCleanupStarted],
    ['staging_settled', options.onStagingSettled],
  ]) {
    if (callback !== undefined && typeof callback !== 'function') {
      throw new TypeError(`${name}_callback_invalid`)
    }
  }
  if (options.onSourceIdentityFinalized !== undefined
    && typeof options.onSourceIdentityFinalized !== 'function') {
    throw new TypeError('staged_source_callback_invalid')
  }
  if (options.onSourceAnchorCreated !== undefined
    && typeof options.onSourceAnchorCreated !== 'function') {
    throw new TypeError('source_anchor_callback_invalid')
  }
  if (options.removeSourceAnchorImpl !== undefined
    && typeof options.removeSourceAnchorImpl !== 'function') {
    throw new TypeError('source_anchor_remover_invalid')
  }
  // trustedExistingMaterialId is accepted only from the controlled adapter and
  // durable worker chain. Same-user module execution is not an authentication boundary.
  const inbox = resolve(options.inboxRoot || defaultMediaInboxRoot())
  await mkdir(inbox, { recursive: true, mode: 0o700 })
  await chmod(inbox, 0o700)
  // Durable workers recover their own journal-bound artifacts before source
  // verification. A different task must not delete those artifacts first.
  if (options.onStagingPrepared === undefined) await cleanupOrphanedMediaStaging(inbox)
  const inspected = await inspectVideoFile(videoFile, {
    maxBytes: options.maxBytes,
    capacityRoot: inbox,
  })
  const expectedSourceIdentity = options.expectedSourceIdentity || inspected.sourceIdentity
  if (!sameSourceIdentity(expectedSourceIdentity, {
    ...inspected.sourceIdentity,
    isFile: () => true,
  })) throw new Error('视频源文件在收件期间发生变化')
  const videoKey = `${randomUUID()}${inspected.extension}`
  const ownershipToken = randomUUID()
  const stagedPath = join(inbox, videoKey)
  const incomingName = `.incoming-${process.pid}-${videoKey}`
  const anchorName = `.source-anchor-${process.pid}-${ownershipToken}`
  const incomingPath = join(inbox, incomingName)
  const anchorPath = join(inbox, anchorName)
  let stagingPrepared = false
  let anchorCleanupPending = false
  let cleanupIncomingIdentity = null
  let cleanupStagedIdentity = null
  let cleanupContentSha256 = null
  try {
    return await withStagingHeartbeat(async () => {
      // Bind every copy branch to one descriptor opened after admission. Path
      // checks remain defense in depth, but never select the copied inode.
      const sourceHandle = await openVerifiedSource(inspected.sourcePath, expectedSourceIdentity)
      let durableIncomingHandle = null
      let initialIncomingIdentity = null
      if (options.onStagingPrepared !== undefined) {
        durableIncomingHandle = await open(
          incomingPath,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        )
        initialIncomingIdentity = sourceIdentity(await durableIncomingHandle.stat())
        cleanupIncomingIdentity = initialIncomingIdentity
      }
      stagingPrepared = options.onStagingPrepared !== undefined
      try {
        await options.onStagingPrepared?.(Object.freeze({
          schemaVersion: 1,
          phase: 'prepared',
          sourceIdentity: expectedSourceIdentity,
          anchoredIdentity: null,
          anchorName,
          incomingName,
          videoKey,
          materialId: null,
          contentSha256: null,
          incomingIdentity: initialIncomingIdentity,
          stagedIdentity: null,
          ownershipToken,
          ...stagingBinding,
        }))
      } catch (error) {
        await durableIncomingHandle?.close().catch(() => undefined)
        await sourceHandle.close().catch(() => undefined)
        throw error
      }
      let sourceAnchor = null
      let finalSourceIdentity = inspected.sourceIdentity
      let finalIncomingIdentity = null
      let sourceIdentityReported = false
      try {
        if (durableIncomingHandle) {
          // A durable worker journals the empty destination inode before the
          // first byte is written. Copy through that bound descriptor so a
          // crash can never leave an unowned incoming/final path.
          await copyIntoHandlePhysical(sourceHandle, durableIncomingHandle)
          await assertHandleIdentity(sourceHandle, expectedSourceIdentity)
          const [incomingPathStat, incomingHandleStat] = await Promise.all([
            lstat(incomingPath),
            durableIncomingHandle.stat(),
          ])
          if (
            !incomingPathStat.isFile()
            || incomingPathStat.isSymbolicLink()
            || incomingPathStat.dev !== initialIncomingIdentity.dev
            || incomingPathStat.ino !== initialIncomingIdentity.ino
            || incomingHandleStat.dev !== initialIncomingIdentity.dev
            || incomingHandleStat.ino !== initialIncomingIdentity.ino
          ) throw new Error('视频收件副本身份发生变化')
        } else if (process.platform === 'darwin') {
          try {
            sourceAnchor = await createVerifiedSourceAnchor(
              inspected.sourcePath,
              sourceHandle,
              expectedSourceIdentity,
              anchorPath,
            )
          } catch (error) {
            const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
            if (!['EXDEV', 'ENOTSUP', 'EPERM'].includes(code)) throw error
          }
          if (sourceAnchor) {
            await options.onSourceAnchorCreated?.(sourceAnchor.anchoredIdentity)
            await copyDarwinVideoFileFromAnchor(sourceAnchor.anchorPath, incomingPath)
            await assertHandleIdentity(sourceHandle, sourceAnchor.anchoredIdentity)
          } else {
            await copyFromHandlePhysical(sourceHandle, incomingPath)
            await assertHandleIdentity(sourceHandle, expectedSourceIdentity)
          }
        } else {
          await copyFromHandlePhysical(sourceHandle, incomingPath)
          await assertHandleIdentity(sourceHandle, expectedSourceIdentity)
        }
        await assertSourceIdentity(
          inspected.sourcePath,
          sourceAnchor?.anchoredIdentity || expectedSourceIdentity,
        )
        const ingestedAt = new Date()
        await utimes(incomingPath, ingestedAt, ingestedAt)
        await chmod(incomingPath, 0o600)
        finalIncomingIdentity = sourceIdentity(await stat(incomingPath))
        cleanupIncomingIdentity = finalIncomingIdentity
      } finally {
        try {
          if (sourceAnchor) {
            try {
              await (options.removeSourceAnchorImpl || rm)(sourceAnchor.anchorPath, { force: true })
            } catch (error) {
              anchorCleanupPending = true
              throw error
            }
            finalSourceIdentity = sourceIdentity(await sourceHandle.stat())
            await assertSourceIdentity(inspected.sourcePath, finalSourceIdentity)
            await options.onSourceIdentityFinalized?.(finalSourceIdentity, {
              incomingIdentity: finalIncomingIdentity,
            })
            sourceIdentityReported = true
          }
        } finally {
          await durableIncomingHandle?.close().catch(() => undefined)
          await sourceHandle.close()
        }
      }

      if (!sourceIdentityReported) {
        await options.onSourceIdentityFinalized?.(finalSourceIdentity, {
          incomingIdentity: finalIncomingIdentity,
        })
      }

      const stagedStat = await stat(incomingPath)
      if (!stagedStat.isFile() || stagedStat.size !== inspected.sourceBytes) {
        throw new Error('视频收件副本校验失败')
      }
      // Bind generated identity to the exact controlled snapshot submitted.
      const contentMaterialId = await deriveMaterialIdFromFile(incomingPath)
      const contentSha256 = contentMaterialId.slice('MATERIAL-SHA256-'.length)
      const materialId = options.trustedExistingMaterialId === undefined
        ? contentMaterialId
        : normalizeMaterialId(options.trustedExistingMaterialId)
      await rename(incomingPath, stagedPath)
      const stagedIdentity = sourceIdentity(await stat(stagedPath))
      cleanupStagedIdentity = stagedIdentity
      cleanupContentSha256 = contentSha256
      const staged = {
        sourcePath: inspected.sourcePath,
        sourceBytes: inspected.sourceBytes,
        extension: inspected.extension,
        inbox,
        videoKey,
        materialId,
        stagedPath,
        sourceIdentity: finalSourceIdentity,
        stagedIdentity,
        contentSha256,
        ownershipToken,
      }
      await options.onStagingCompleted?.(staged)
      return staged
    }, {
      onProgress: options.onHashProgress ?? null,
      progressIntervalMs: options.hashProgressIntervalMs ?? 5_000,
    })
  } catch (error) {
    if (error instanceof StagedMediaCleanupError) throw error
    if (stagingPrepared) await options.onStagingCleanupStarted?.()
    if (cleanupIncomingIdentity) {
      await removeStagedVideo(incomingPath, videoKey, error, {
        ownershipToken,
        claimSlot: 'incoming',
        validateIdentity: details => details.dev === cleanupIncomingIdentity.dev
          && details.ino === cleanupIncomingIdentity.ino
          && details.size <= inspected.sourceBytes,
      })
    }
    if (cleanupStagedIdentity && cleanupContentSha256) {
      await removeStagedVideo(stagedPath, videoKey, error, {
        expectedIdentity: cleanupStagedIdentity,
        expectedContentSha256: cleanupContentSha256,
        ownershipToken,
        claimSlot: 'final',
      })
    }
    const unboundArtifactPending = (
      (!cleanupIncomingIdentity && await lstat(incomingPath).then(() => true).catch(() => false))
      || (!cleanupStagedIdentity && await lstat(stagedPath).then(() => true).catch(() => false))
    )
    if (anchorCleanupPending || unboundArtifactPending) {
      const cleanupError = anchorCleanupPending
        ? error
        : new Error('staged_media_identity_not_persisted')
      throw new StagedMediaCleanupError(error, cleanupError, videoKey)
    }
    if (stagingPrepared) await options.onStagingSettled?.()
    throw error
  }
}

export async function discardStagedVideo(staged, primaryError = null) {
  if (!staged?.stagedPath) return
  const fallbackError = new Error('视频暂存副本清理失败')
  await removeStagedVideo(
    staged.stagedPath,
    staged.videoKey || 'unknown-video-key',
    primaryError || fallbackError,
    {
      expectedIdentity: staged.stagedIdentity || null,
      expectedContentSha256: staged.contentSha256 || null,
      ownershipToken: staged.ownershipToken || null,
      claimSlot: 'final',
    },
  )
}
