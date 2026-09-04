import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const OWNER_SCHEMA = 'video-autoworker-shared-deployment-lock-owner/v2'
const LEGACY_OWNER_SCHEMA = 'video-autoworker-shared-deployment-lock-owner/v1'
const LEASE_SCHEMA = 'video-autoworker-shared-deployment-lock-lease/v1'
const MAX_OWNER_BYTES = 4 * 1024

function fail(message) {
  throw new Error(`shared deployment lock failed: ${message}`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function processIdentity(pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024,
  })
  if (result.error || result.signal || result.status !== 0 || !result.stdout.trim()) return null
  return sha256(result.stdout.trim())
}

function normalizedAbsolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} must be one normalized absolute path`)
  return pathname
}

function physicalSystemTemporaryPath(pathname) {
  normalizedAbsolute(pathname, 'blue-green run directory')
  if (process.platform !== 'darwin' || (pathname !== '/tmp' && !pathname.startsWith('/tmp/'))) {
    return pathname
  }
  const temporaryAlias = lstatSync('/tmp')
  if (!temporaryAlias.isSymbolicLink() || realpathSync('/tmp') !== '/private/tmp') {
    fail('system temporary directory alias is unsafe')
  }
  return join('/private/tmp', relative('/tmp', pathname))
}

function assertNoSymlink(pathname, label) {
  const root = parse(normalizedAbsolute(pathname, label)).root
  let current = root
  for (const part of relative(root, pathname).split('/').filter(Boolean)) {
    current = join(current, part)
    const entry = lstatSync(current, { bigint: true })
    if (entry.isSymbolicLink()) fail(`${label} contains a symlink`)
  }
}

function identity(entry) {
  return {
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    uid: Number(entry.uid),
    mode: Number(entry.mode & 0o7777n),
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino
    && left.uid === right.uid && left.mode === right.mode
}

function fullFileIdentity(entry) {
  return {
    ...identity(entry),
    nlink: entry.nlink.toString(),
    size: entry.size.toString(),
    mtimeNs: entry.mtimeNs.toString(),
    ctimeNs: entry.ctimeNs.toString(),
  }
}

function sameFullFileIdentity(left, right) {
  return sameIdentity(left, right) && left.nlink === right.nlink && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

function fsyncDirectory(pathname) {
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function safeDirectory(pathname, label, mode) {
  assertNoSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if (!entry.isDirectory() || entry.uid !== BigInt(process.getuid())
    || Number(entry.mode & 0o7777n) !== mode || realpathSync(pathname) !== pathname) {
    fail(`${label} is unsafe`)
  }
  return { entry, identity: identity(entry) }
}

function readOwner(pathname) {
  assertNoSymlink(pathname, 'deployment lock owner')
  const entry = lstatSync(pathname, { bigint: true })
  if (!entry.isFile() || entry.nlink !== 1n || entry.uid !== BigInt(process.getuid())
    || Number(entry.mode & 0o7777n) !== 0o600 || entry.size <= 0n
    || entry.size > BigInt(MAX_OWNER_BYTES)) fail('owner record is unsafe')
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      fail('owner record changed before read')
    }
    const source = readFileSync(descriptor, 'utf8')
    const after = fstatSync(descriptor, { bigint: true })
    const current = lstatSync(pathname, { bigint: true })
    if (Buffer.byteLength(source) !== Number(opened.size) || after.dev !== opened.dev
      || after.ino !== opened.ino || after.size !== opened.size || current.dev !== opened.dev
      || current.ino !== opened.ino || current.size !== opened.size || current.nlink !== 1n) {
      fail('owner record changed during read')
    }
    let value
    const trimmed = source.trim()
    if (/^[1-9][0-9]*$/u.test(trimmed)) {
      value = { schema: 'legacy-pid/v1', pid: Number(trimmed), nonce: null, createdAt: null }
    } else {
      try { value = JSON.parse(source) } catch { fail('owner record is not JSON') }
      const keys = Object.keys(value || {}).sort()
      const legacy = value?.schema === LEGACY_OWNER_SCHEMA
        && JSON.stringify(keys) === JSON.stringify(['createdAt', 'nonce', 'pid', 'schema'])
      const current = value?.schema === OWNER_SCHEMA
        && JSON.stringify(keys) === JSON.stringify([
          'createdAt', 'nonce', 'pid', 'processIdentitySha256', 'schema',
        ])
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || (!legacy && !current) || !Number.isSafeInteger(value.pid) || value.pid <= 0
        || typeof value.nonce !== 'string' || !/^[a-f0-9]{64}$/u.test(value.nonce)
        || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
        || (current && !/^[a-f0-9]{64}$/u.test(value.processIdentitySha256))) {
        fail('owner record contract is invalid')
      }
    }
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0) fail('owner PID is invalid')
    return { entry, identity: identity(entry), source, value }
  } finally { closeSync(descriptor) }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    fail('owner liveness cannot be determined')
  }
}

function ownerProcessIsCurrent(owner) {
  if (owner.schema === OWNER_SCHEMA) {
    return processIdentity(owner.pid) === owner.processIdentitySha256
  }
  return processExists(owner.pid)
}

function lockMembers(lockPath) {
  const names = []
  const directory = opendirSync(lockPath)
  try { for (;;) { const entry = directory.readSync(); if (!entry) break; names.push(entry.name) } } finally {
    directory.closeSync()
  }
  return names.sort()
}

function restoreQuarantinedDirectory(quarantinedPath, lockPath, runDirectory) {
  try {
    renameSync(quarantinedPath, lockPath)
    fsyncDirectory(runDirectory)
    return true
  } catch (error) {
    if (['EEXIST', 'ENOTEMPTY'].includes(error?.code)) return false
    throw error
  }
}

function recoverDeadOwner(lockPath, runDirectory) {
  const lock = safeDirectory(lockPath, 'existing deployment lock', 0o700)
  if (JSON.stringify(lockMembers(lockPath)) !== JSON.stringify(['pid'])) {
    fail('existing lock does not have one recoverable owner record')
  }
  const ownerPath = join(lockPath, 'pid')
  const owner = readOwner(ownerPath)
  if (ownerProcessIsCurrent(owner.value)) return false
  for (let pass = 0; pass < 2; pass += 1) {
    const currentLock = safeDirectory(lockPath, 'existing deployment lock', 0o700)
    const currentOwner = readOwner(ownerPath)
    if (!sameIdentity(lock.identity, currentLock.identity)
      || !sameIdentity(owner.identity, currentOwner.identity)
      || owner.source !== currentOwner.source
      || JSON.stringify(lockMembers(lockPath)) !== JSON.stringify(['pid'])) {
      fail('dead-owner lock changed during recovery')
    }
    if (ownerProcessIsCurrent(owner.value)) return false
  }
  const retiredPath = `${lockPath}.recovered-${process.pid}-${randomBytes(16).toString('hex')}`
  renameSync(lockPath, retiredPath)
  const movedOwnerPath = join(retiredPath, 'pid')
  let movedMatches = false
  try {
    const movedLock = safeDirectory(retiredPath, 'recovered deployment lock', 0o700)
    const movedOwner = readOwner(movedOwnerPath)
    movedMatches = sameIdentity(lock.identity, movedLock.identity)
      && sameIdentity(owner.identity, movedOwner.identity) && owner.source === movedOwner.source
  } catch (error) {
    restoreQuarantinedDirectory(retiredPath, lockPath, runDirectory)
    throw error
  }
  if (!movedMatches) {
    restoreQuarantinedDirectory(retiredPath, lockPath, runDirectory)
    fail('dead-owner lock changed during quarantine')
  }
  fsyncDirectory(runDirectory)
  unlinkSync(movedOwnerPath)
  fsyncDirectory(retiredPath)
  rmdirSync(retiredPath)
  fsyncDirectory(runDirectory)
  return true
}

function recoverIncompleteLegacyLock(lockPath, runDirectory) {
  const firstLock = safeDirectory(lockPath, 'incomplete deployment lock', 0o700)
  const names = lockMembers(lockPath)
  let pendingName = null
  let pendingPid = null
  let firstPending = null
  if (names.length === 1) {
    const match = /^pid\.pending\.([1-9][0-9]*)\.[a-f0-9]{64}$/u.exec(names[0])
    if (!match || !Number.isSafeInteger(Number(match[1])) || Number(match[1]) <= 0) {
      return false
    }
    pendingName = names[0]
    pendingPid = Number(match[1])
    const entry = lstatSync(join(lockPath, pendingName), { bigint: true })
    if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== BigInt(process.getuid())
      || entry.nlink !== 1n || Number(entry.mode & 0o7777n) !== 0o600
      || entry.size > BigInt(MAX_OWNER_BYTES)) return false
    firstPending = fullFileIdentity(entry)
    if (processExists(pendingPid)) return false
  } else if (names.length !== 0) {
    return false
  }
  for (let pass = 0; pass < 2; pass += 1) {
    const currentLock = safeDirectory(lockPath, 'incomplete deployment lock', 0o700)
    if (!sameIdentity(firstLock.identity, currentLock.identity)
      || JSON.stringify(lockMembers(lockPath)) !== JSON.stringify(names)) return false
    if (pendingName !== null) {
      const currentEntry = lstatSync(join(lockPath, pendingName), { bigint: true })
      if (!sameFullFileIdentity(firstPending, fullFileIdentity(currentEntry))
        || processExists(pendingPid)) return false
    }
  }
  const retiredPath = `${lockPath}.recovered-incomplete-${process.pid}-${randomBytes(16).toString('hex')}`
  renameSync(lockPath, retiredPath)
  let movedMatches = false
  try {
    const movedLock = safeDirectory(retiredPath, 'recovered incomplete deployment lock', 0o700)
    movedMatches = sameIdentity(firstLock.identity, movedLock.identity)
      && JSON.stringify(lockMembers(retiredPath)) === JSON.stringify(names)
    if (movedMatches && pendingName !== null) {
      const movedPending = lstatSync(join(retiredPath, pendingName), { bigint: true })
      movedMatches = sameFullFileIdentity(firstPending, fullFileIdentity(movedPending))
    }
  } catch (error) {
    restoreQuarantinedDirectory(retiredPath, lockPath, runDirectory)
    throw error
  }
  if (!movedMatches) {
    restoreQuarantinedDirectory(retiredPath, lockPath, runDirectory)
    fail('incomplete lock changed during quarantine')
  }
  if (pendingName !== null) {
    const movedPendingPath = join(retiredPath, pendingName)
    unlinkSync(movedPendingPath)
    fsyncDirectory(retiredPath)
  }
  fsyncDirectory(runDirectory)
  rmdirSync(retiredPath)
  fsyncDirectory(runDirectory)
  return true
}

function recoverStaleLock(lockPath, runDirectory) {
  try {
    if (recoverDeadOwner(lockPath, runDirectory)) return true
  } catch {
    // It may be an interrupted legacy Bash publication instead of a sealed owner.
  }
  return recoverIncompleteLegacyLock(lockPath, runDirectory)
}

function removeIncompleteOwnedLock(lockPath, runDirectory, lockIdentity, ownerPath, ownerSource) {
  try {
    const currentLock = safeDirectory(lockPath, 'incomplete deployment lock', 0o700)
    if (!sameIdentity(currentLock.identity, lockIdentity)) return
    const names = lockMembers(lockPath)
    if (names.length === 0) {
      rmdirSync(lockPath)
      fsyncDirectory(runDirectory)
      return
    }
    if (JSON.stringify(names) !== JSON.stringify(['pid'])) return
    const currentOwner = readOwner(ownerPath)
    if (currentOwner.source !== ownerSource) return
    unlinkSync(ownerPath)
    fsyncDirectory(lockPath)
    rmdirSync(lockPath)
    fsyncDirectory(runDirectory)
  } catch {
    // Preserve an object whose ownership cannot still be proven.
  }
}

function leaseDescriptor({ runDirectory, run, lockPath, lock, ownerPath, owner, ownerSource, ownerPid }) {
  return {
    schema: LEASE_SCHEMA,
    runDirectory,
    runIdentity: run.identity,
    lockPath,
    lockIdentity: lock.identity,
    ownerPath,
    ownerIdentity: owner.identity,
    ownerSource,
    ownerPid,
  }
}

function validIdentity(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(['dev', 'ino', 'mode', 'uid'])
    && typeof value.dev === 'string' && /^[0-9]+$/u.test(value.dev)
    && typeof value.ino === 'string' && /^[0-9]+$/u.test(value.ino)
    && Number.isSafeInteger(value.uid) && value.uid >= 0
    && Number.isSafeInteger(value.mode) && value.mode >= 0 && value.mode <= 0o7777
}

function validateLeaseDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([
      'lockIdentity', 'lockPath', 'ownerIdentity', 'ownerPath', 'ownerPid', 'ownerSource',
      'runDirectory', 'runIdentity', 'schema',
    ])
    || value.schema !== LEASE_SCHEMA || !validIdentity(value.runIdentity)
    || !validIdentity(value.lockIdentity) || !validIdentity(value.ownerIdentity)
    || !Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0
    || typeof value.ownerSource !== 'string' || Buffer.byteLength(value.ownerSource) > MAX_OWNER_BYTES
    || value.lockPath !== join(value.runDirectory, '.deployment.lock')
    || value.ownerPath !== join(value.lockPath, 'pid')) fail('lease descriptor is invalid')
  normalizedAbsolute(value.runDirectory, 'blue-green run directory')
  return value
}

export function releaseSharedDeploymentLockSync(descriptorValue) {
  const descriptor = validateLeaseDescriptor(descriptorValue)
  const currentRun = safeDirectory(descriptor.runDirectory, 'blue-green run directory', 0o700)
  const currentLock = safeDirectory(descriptor.lockPath, 'shared deployment lock', 0o700)
  const currentOwner = readOwner(descriptor.ownerPath)
  if (!sameIdentity(currentRun.identity, descriptor.runIdentity)
    || !sameIdentity(currentLock.identity, descriptor.lockIdentity)
    || !sameIdentity(currentOwner.identity, descriptor.ownerIdentity)
    || currentOwner.source !== descriptor.ownerSource
    || JSON.stringify(lockMembers(descriptor.lockPath)) !== JSON.stringify(['pid'])) {
    fail('lock ownership changed before release')
  }
  const retiredPath = `${descriptor.lockPath}.release-${process.pid}-${randomBytes(16).toString('hex')}`
  renameSync(descriptor.lockPath, retiredPath)
  fsyncDirectory(descriptor.runDirectory)
  const movedOwnerPath = join(retiredPath, 'pid')
  let movedMatches = false
  try {
    const movedLock = safeDirectory(retiredPath, 'released deployment lock', 0o700)
    const movedOwner = readOwner(movedOwnerPath)
    movedMatches = sameIdentity(movedLock.identity, descriptor.lockIdentity)
      && sameIdentity(movedOwner.identity, descriptor.ownerIdentity)
      && movedOwner.source === descriptor.ownerSource
  } catch (error) {
    restoreQuarantinedDirectory(retiredPath, descriptor.lockPath, descriptor.runDirectory)
    throw error
  }
  if (!movedMatches) {
    restoreQuarantinedDirectory(retiredPath, descriptor.lockPath, descriptor.runDirectory)
    fail('lock ownership changed during release quarantine')
  }
  unlinkSync(movedOwnerPath)
  fsyncDirectory(retiredPath)
  rmdirSync(retiredPath)
  fsyncDirectory(descriptor.runDirectory)
}

export function acquireSharedDeploymentLockSync({ runDirectory, ownerPid = process.pid }) {
  runDirectory = physicalSystemTemporaryPath(runDirectory)
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) fail('owner PID is invalid')
  const ownerProcessIdentitySha256 = processIdentity(ownerPid)
  if (!ownerProcessIdentitySha256) fail('owner process identity is unavailable')
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 })
  const run = safeDirectory(runDirectory, 'blue-green run directory', 0o700)
  const lockPath = join(runDirectory, '.deployment.lock')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const ownerValue = {
      schema: OWNER_SCHEMA,
      pid: ownerPid,
      nonce: randomBytes(32).toString('hex'),
      createdAt: new Date().toISOString(),
      processIdentitySha256: ownerProcessIdentitySha256,
    }
    const ownerSource = `${JSON.stringify(ownerValue)}\n`
    const stagingPath = `${lockPath}.pending-${process.pid}-${randomBytes(16).toString('hex')}`
    mkdirSync(stagingPath, { mode: 0o700 })
    chmodSync(stagingPath, 0o700)
    const stagingLock = safeDirectory(stagingPath, 'pending shared deployment lock', 0o700)
    const stagingOwnerPath = join(stagingPath, 'pid')
    let ownerDescriptor
    try {
      ownerDescriptor = openSync(stagingOwnerPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      writeFileSync(ownerDescriptor, ownerSource)
      fsyncSync(ownerDescriptor)
      closeSync(ownerDescriptor)
      ownerDescriptor = undefined
      fsyncDirectory(stagingPath)
      fsyncDirectory(runDirectory)
      const stagedOwner = readOwner(stagingOwnerPath)
      if (stagedOwner.source !== ownerSource
        || JSON.stringify(lockMembers(stagingPath)) !== JSON.stringify(['pid'])) {
        fail('new lock did not seal exactly')
      }
      try {
        renameSync(stagingPath, lockPath)
      } catch (error) {
        removeIncompleteOwnedLock(
          stagingPath, runDirectory, stagingLock.identity, stagingOwnerPath, ownerSource,
        )
        if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error
        if (attempt < 2) {
          let recovered = false
          try { recovered = recoverStaleLock(lockPath, runDirectory) } catch { recovered = false }
          if (recovered) continue
        }
        fail('another shared deployment operation is active')
      }
      fsyncDirectory(runDirectory)
      const lock = safeDirectory(lockPath, 'shared deployment lock', 0o700)
      if (!sameIdentity(stagingLock.identity, lock.identity)) fail('published lock identity changed')
      const ownerPath = join(lockPath, 'pid')
      const owner = readOwner(ownerPath)
      if (owner.source !== ownerSource || JSON.stringify(lockMembers(lockPath)) !== JSON.stringify(['pid'])) {
        fail('published lock did not seal exactly')
      }
      let released = false
      const descriptor = leaseDescriptor({
        runDirectory, run, lockPath, lock, ownerPath, owner, ownerSource, ownerPid,
      })
      return {
        path: lockPath,
        ownerPid,
        descriptor,
        release() {
          if (released) return
          releaseSharedDeploymentLockSync(descriptor)
          released = true
        },
      }
    } catch (error) {
      if (ownerDescriptor !== undefined) closeSync(ownerDescriptor)
      removeIncompleteOwnedLock(
        stagingPath, runDirectory, stagingLock.identity, stagingOwnerPath, ownerSource,
      )
      throw error
    }
  }
  fail('shared deployment lock acquisition did not converge')
}

export function assertSharedDeploymentLockAvailableSync(runDirectory) {
  runDirectory = physicalSystemTemporaryPath(runDirectory)
  try {
    const entry = lstatSync(runDirectory, { bigint: true })
    if (entry.isSymbolicLink() || !entry.isDirectory() || entry.uid !== BigInt(process.getuid())
      || Number(entry.mode & 0o7777n) !== 0o700 || realpathSync(runDirectory) !== runDirectory) {
      fail('blue-green run directory is unsafe')
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  const lockPath = join(runDirectory, '.deployment.lock')
  try {
    lstatSync(lockPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  // A read-only preflight never repairs or quarantines a stale lock. Any
  // canonical lock object means a writer may own the deployment transaction.
  fail('another shared deployment operation is active')
}

function runCli() {
  const [command, runDirectorySource, ownerPidSource] = process.argv.slice(2)
  const runDirectory = physicalSystemTemporaryPath(runDirectorySource)
  const ownerPid = Number(ownerPidSource)
  if (!['acquire-shell', 'release-shell', 'inspect-shell'].includes(command)
    || !Number.isSafeInteger(ownerPid) || ownerPid <= 0 || ownerPid !== process.ppid) {
    fail('shell bridge invocation is invalid')
  }
  if (command === 'inspect-shell') {
    assertSharedDeploymentLockAvailableSync(runDirectory)
    return
  } else if (command === 'acquire-shell') {
    const lease = acquireSharedDeploymentLockSync({ runDirectory, ownerPid })
    process.stdout.write(`${JSON.stringify(lease.descriptor)}\n`)
    return
  }
  const source = readFileSync(0, 'utf8')
  if (Buffer.byteLength(source) > 32 * 1024) fail('lease descriptor is too large')
  let descriptor
  try { descriptor = JSON.parse(source) } catch { fail('lease descriptor is not JSON') }
  if (descriptor.ownerPid !== ownerPid || descriptor.runDirectory !== runDirectory) {
    fail('lease descriptor does not belong to shell')
  }
  releaseSharedDeploymentLockSync(descriptor)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runCli()
