import fs from 'node:fs'
import path from 'node:path'

function resolvePhysicalCandidate(candidate: string): string {
  let cursor = path.resolve(candidate)
  const suffix: string[] = []
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor)
    if (parent === cursor) throw new Error('platform environment path has no existing ancestor')
    suffix.unshift(path.basename(cursor))
    cursor = parent
  }
  return path.resolve(fs.realpathSync.native(cursor), ...suffix)
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function assertOwned(stat: fs.Stats, label: string): void {
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the runtime user`)
  }
}

export function resolveConfiguredPlatformEnvFilePath(): string {
  const configured = String(process.env.AIWORKER_PLATFORM_ENV_FILE || '').trim()
  if (!configured) {
    throw new Error('AIWORKER_PLATFORM_ENV_FILE must explicitly select an external runtime environment file')
  }
  if (!path.isAbsolute(configured) || /[\r\n]/u.test(configured)) {
    throw new Error('AIWORKER_PLATFORM_ENV_FILE must be an absolute single-line path')
  }

  const normalized = path.resolve(configured)
  const parent = path.dirname(normalized)
  const parentStat = fs.lstatSync(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error('AIWORKER_PLATFORM_ENV_FILE parent must be a real directory')
  }
  assertOwned(parentStat, 'AIWORKER_PLATFORM_ENV_FILE parent')
  if ((parentStat.mode & 0o022) !== 0) {
    throw new Error('AIWORKER_PLATFORM_ENV_FILE parent must not be group- or world-writable')
  }

  if (fs.existsSync(normalized)) {
    const targetStat = fs.lstatSync(normalized)
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) {
      throw new Error('AIWORKER_PLATFORM_ENV_FILE must be a regular non-symlink file')
    }
    assertOwned(targetStat, 'AIWORKER_PLATFORM_ENV_FILE')
    if ((targetStat.mode & 0o022) !== 0) {
      throw new Error('AIWORKER_PLATFORM_ENV_FILE must not be group- or world-writable')
    }
  }

  const standaloneRoot = String(process.env.AIWORKER_STANDALONE_ROOT || '').trim()
  if (standaloneRoot) {
    if (!path.isAbsolute(standaloneRoot) || /[\r\n]/u.test(standaloneRoot)) {
      throw new Error('AIWORKER_STANDALONE_ROOT must be an absolute single-line path')
    }
    if (isWithin(resolvePhysicalCandidate(standaloneRoot), resolvePhysicalCandidate(normalized))) {
      throw new Error('AIWORKER_PLATFORM_ENV_FILE must remain outside the immutable standalone root')
    }
  }

  return normalized
}

export function writePlatformEnvFile(filePath: string, content: string): void {
  const temporary = `${filePath}.tmp.${process.pid}.${Date.now()}`
  let descriptor: number | undefined
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600)
    fs.writeFileSync(descriptor, content, 'utf8')
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, filePath)
    fs.chmodSync(filePath, 0o600)
    const directoryDescriptor = fs.openSync(path.dirname(filePath), 'r')
    try { fs.fsyncSync(directoryDescriptor) } finally { fs.closeSync(directoryDescriptor) }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch { /* already renamed or never created */ }
  }
}
