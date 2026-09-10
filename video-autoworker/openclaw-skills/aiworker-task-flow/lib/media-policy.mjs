import { stat, statfs } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const MEBIBYTE = 1024 ** 2
const MIN_WORKSPACE_RESERVE_BYTES = 512 * MEBIBYTE
const MAX_WORKSPACE_RESERVE_BYTES = 8 * 1024 ** 3
const WORKSPACE_RESERVE_RATIO = 0.05

/**
 * The system owns media admission. An unset value means hardware-aware mode;
 * there is deliberately no baked-in file-size ceiling here.
 */
export function configuredMediaFileLimit(environment = process.env) {
  return parseOptionalByteLimit(environment?.AIWORKER_MEDIA_MAX_FILE_BYTES)
}

export function parseOptionalByteLimit(value) {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw || ['auto', 'none', 'unlimited'].includes(raw)) return null
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('AIWORKER_MEDIA_MAX_FILE_BYTES 必须是正整数，或设置为 auto')
  }
  return parsed
}

export function estimateMediaWorkspaceBytes(sourceBytes) {
  const bytes = Number(sourceBytes)
  if (!Number.isSafeInteger(bytes) || bytes < 1) return MIN_WORKSPACE_RESERVE_BYTES
  return Math.min(
    MAX_WORKSPACE_RESERVE_BYTES,
    Math.max(MIN_WORKSPACE_RESERVE_BYTES, Math.ceil(bytes * WORKSPACE_RESERVE_RATIO)),
  )
}

async function nearestExistingPath(pathname) {
  let current = resolve(pathname)
  while (true) {
    try {
      await stat(current)
      return current
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      current = parent
    }
  }
}

async function filesystemCapacity(pathname) {
  const existingPath = await nearestExistingPath(pathname)
  const [filesystem, owner] = await Promise.all([
    statfs(existingPath),
    stat(existingPath),
  ])
  const blockSize = Number(filesystem.bsize)
  const availableBlocks = Number(filesystem.bavail)
  const availableBytes = blockSize > 0 && Number.isFinite(availableBlocks)
    ? Math.max(0, Math.floor(blockSize * availableBlocks))
    : 0
  return {
    path: existingPath,
    device: String(owner.dev),
    availableBytes,
  }
}

function formatBytes(value) {
  const bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) return `${value} 字节`
  if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(2)} GiB`
  if (bytes >= MEBIBYTE) return `${(bytes / MEBIBYTE).toFixed(2)} MiB`
  return `${bytes} 字节`
}

/**
 * Check whether the current machine can admit a source file.
 *
 * On macOS, a source and inbox on the same filesystem are expected to use the
 * existing APFS clone path, so only workspace reserve is required. Other
 * filesystems must have room for a physical staged copy plus workspace data.
 *
 * @param {{
 *   sourcePath?: string,
 *   destinationRoot?: string,
 *   maxBytes?: number|string|null,
 *   environment?: Record<string, string|undefined>,
 * }} options
 */
export async function assertMediaCapacity({
  sourcePath,
  destinationRoot,
  maxBytes,
  environment = process.env,
} = {}) {
  const source = await stat(resolve(String(sourcePath || '')))
  if (!source.isFile() || source.size <= 0) throw new Error('视频文件无效')

  const explicitLimit = maxBytes === undefined
    ? configuredMediaFileLimit(environment)
    : parseOptionalByteLimit(maxBytes)
  if (explicitLimit !== null && source.size > explicitLimit) {
    throw new Error(`视频文件大小 ${formatBytes(source.size)} 超过系统准入上限 ${formatBytes(explicitLimit)}`)
  }

  const capacity = await filesystemCapacity(destinationRoot || dirname(resolve(String(sourcePath))))
  const sameFilesystem = String(source.dev) === capacity.device
  const cloneExpected = process.platform === 'darwin' && sameFilesystem
  const workspaceReserveBytes = estimateMediaWorkspaceBytes(source.size)
  const requiredBytes = cloneExpected
    ? workspaceReserveBytes
    : source.size + workspaceReserveBytes
  if (capacity.availableBytes < requiredBytes) {
    throw new Error(
      `视频资源不足：文件 ${formatBytes(source.size)}，收件箱可用空间 ${formatBytes(capacity.availableBytes)}，` +
      `至少需要 ${formatBytes(requiredBytes)}（${cloneExpected ? 'APFS 克隆后的工作区预留' : '暂存副本和工作区预留'}）`,
    )
  }

  return {
    sourceBytes: source.size,
    availableBytes: capacity.availableBytes,
    requiredBytes,
    workspaceReserveBytes,
    cloneExpected,
    configuredLimit: explicitLimit,
  }
}
