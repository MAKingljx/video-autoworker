import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, realpath, rm, stat, utimes } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { assertMediaCapacity, configuredMediaFileLimit } from './media-policy.mjs'

const execFileAsync = promisify(execFile)
export const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v'])

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
  return { sourcePath, sourceBytes: sourceStat.size, extension }
}

export async function stageVideoFile(videoFile, options = {}) {
  const inbox = resolve(options.inboxRoot || defaultMediaInboxRoot())
  await mkdir(inbox, { recursive: true, mode: 0o700 })
  await chmod(inbox, 0o700)
  const inspected = await inspectVideoFile(videoFile, {
    maxBytes: options.maxBytes,
    capacityRoot: inbox,
  })
  const videoKey = `${randomUUID()}${inspected.extension}`
  const stagedPath = join(inbox, videoKey)
  const copyMode = process.platform === 'darwin'
    ? constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE_FORCE
    : constants.COPYFILE_EXCL
  try {
    try {
      await copyFile(inspected.sourcePath, stagedPath, copyMode)
    } catch (error) {
      if (process.platform !== 'darwin') throw error
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (!['ENOSYS', 'ENOTSUP', 'EINVAL'].includes(code)) {
        throw new Error('视频与受控收件箱必须位于支持 APFS 克隆的同一文件系统，未执行大文件完整复制')
      }
      await rm(stagedPath, { force: true })
      await execFileAsync('/bin/cp', ['-c', '-n', inspected.sourcePath, stagedPath])
    }
    const stagedStat = await stat(stagedPath)
    if (!stagedStat.isFile() || stagedStat.size !== inspected.sourceBytes) {
      throw new Error('视频收件副本校验失败')
    }
    const ingestedAt = new Date()
    await utimes(stagedPath, ingestedAt, ingestedAt)
    await chmod(stagedPath, 0o600)
    return { ...inspected, inbox, videoKey, stagedPath }
  } catch (error) {
    await rm(stagedPath, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function discardStagedVideo(staged) {
  if (staged?.stagedPath) await rm(staged.stagedPath, { force: true }).catch(() => undefined)
}
