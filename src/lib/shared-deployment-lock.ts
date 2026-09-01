import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

const LOCK_NAME = '.deployment.lock'
const DEFAULT_ATTEMPTS = 4
const DEFAULT_RETRY_DELAY_MS = 25

interface FileIdentity {
  dev: string
  ino: string
}

export interface SharedDeploymentLockLease {
  path: string
  release: () => void
}

export type SharedDeploymentLockResult =
  | { acquired: true, lease: SharedDeploymentLockLease }
  | { acquired: false, reason: 'busy' }

export interface SharedDeploymentLockOptions {
  runDirectory?: string
  attempts?: number
  retryDelayMs?: number
}

function fail(message: string): never {
  throw new Error(`shared_deployment_lock:${message}`)
}

function identity(entry: Stats): FileIdentity {
  return { dev: String(entry.dev), ino: String(entry.ino) }
}

function currentUid(): number {
  if (typeof process.getuid !== 'function') fail('platform_unsupported')
  return process.getuid()
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function normalizedRunDirectory(configured?: string): string {
  const pathname = String(
    configured || process.env.AIWORKER_BG_RUN_DIR || resolve(process.cwd(), '.run/blue-green'),
  ).trim()
  if (!isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail('run_directory_invalid')
  return pathname
}

function verifyPrivateRunDirectory(pathname: string): void {
  let entry
  let physical
  try {
    entry = lstatSync(pathname)
    physical = realpathSync.native(pathname)
  } catch {
    fail('run_directory_missing')
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || physical !== pathname
    || entry.uid !== currentUid() || (entry.mode & 0o077) !== 0) {
    fail('run_directory_unsafe')
  }
}

function safeRemoveIncompleteLock(lockPath: string, expected: FileIdentity): void {
  try {
    const current = identity(lstatSync(lockPath))
    if (sameIdentity(current, expected)) rmdirSync(lockPath)
  } catch {
    // A failed acquisition must never remove an object it no longer owns.
  }
}

function tryAcquire(runDirectory: string): SharedDeploymentLockResult {
  verifyPrivateRunDirectory(runDirectory)
  const lockPath = resolve(runDirectory, LOCK_NAME)
  try {
    mkdirSync(lockPath, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') {
      return { acquired: false, reason: 'busy' }
    }
    fail('acquire_failed')
  }

  let lockIdentity: FileIdentity
  try {
    chmodSync(lockPath, 0o700)
    const entry = lstatSync(lockPath)
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== currentUid()
      || (entry.mode & 0o777) !== 0o700 || realpathSync.native(lockPath) !== lockPath) {
      fail('acquired_directory_unsafe')
    }
    lockIdentity = identity(entry)
  } catch (error) {
    try { rmdirSync(lockPath) } catch { /* fail closed with the unexpected object in place */ }
    throw error
  }

  const owner = `${JSON.stringify({
    schema: 'video-autoworker-shared-deployment-lock-owner/v1',
    pid: process.pid,
    nonce: randomBytes(32).toString('hex'),
  })}\n`
  const ownerPath = resolve(lockPath, 'pid')
  let descriptor: number | undefined
  try {
    descriptor = openSync(
      ownerPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    )
    writeFileSync(descriptor, owner, 'utf8')
    closeSync(descriptor)
    descriptor = undefined
    const ownerEntry = lstatSync(ownerPath)
    const currentLock = identity(lstatSync(lockPath))
    if (!ownerEntry.isFile() || ownerEntry.isSymbolicLink() || ownerEntry.nlink !== 1
      || ownerEntry.uid !== currentUid() || (ownerEntry.mode & 0o777) !== 0o600
      || !sameIdentity(currentLock, lockIdentity)) fail('owner_record_unsafe')
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch { /* descriptor already closed */ }
    }
    try { unlinkSync(ownerPath) } catch { /* owner may not have been created */ }
    safeRemoveIncompleteLock(lockPath, lockIdentity)
    throw error
  }

  let released = false
  return {
    acquired: true,
    lease: {
      path: lockPath,
      release() {
        if (released) return
        const currentLock = lstatSync(lockPath)
        if (!currentLock.isDirectory() || currentLock.isSymbolicLink()
          || !sameIdentity(identity(currentLock), lockIdentity)) fail('ownership_changed')
        const ownerEntry = lstatSync(ownerPath)
        if (!ownerEntry.isFile() || ownerEntry.isSymbolicLink() || ownerEntry.nlink !== 1
          || ownerEntry.uid !== currentUid() || (ownerEntry.mode & 0o777) !== 0o600) {
          fail('owner_record_changed')
        }
        const ownerFd = openSync(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW)
        let observed
        try {
          const opened = fstatSync(ownerFd)
          if (opened.dev !== ownerEntry.dev || opened.ino !== ownerEntry.ino) {
            fail('owner_record_replaced')
          }
          observed = readFileSync(ownerFd, 'utf8')
        } finally {
          closeSync(ownerFd)
        }
        if (observed !== owner) fail('owner_record_changed')
        if (!sameIdentity(identity(lstatSync(lockPath)), lockIdentity)) fail('ownership_changed')
        unlinkSync(ownerPath)
        rmdirSync(lockPath)
        released = true
      },
    },
  }
}

export async function acquireSharedDeploymentLock(
  options: SharedDeploymentLockOptions = {},
): Promise<SharedDeploymentLockResult> {
  const runDirectory = normalizedRunDirectory(options.runDirectory)
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20
    || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 250) {
    fail('retry_policy_invalid')
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = tryAcquire(runDirectory)
    if (result.acquired || attempt === attempts) return result
    await new Promise(resolveWait => setTimeout(resolveWait, retryDelayMs))
  }
  return { acquired: false, reason: 'busy' }
}
