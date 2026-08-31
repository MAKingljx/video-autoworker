#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync, closeSync, constants, existsSync, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

const SCHEMA = 'video-autoworker-n8n-maintenance-lock/v1'
const TERMINAL_SCHEMA = 'video-autoworker-n8n-maintenance-terminal/v1'
const OWNERS = new Set(['import', 'install', 'restore', 'start'])
const EMPTY_GRACE_MS = 5_000
const SHA256 = /^[a-f0-9]{64}$/u

function fail(message) {
  process.stderr.write(`n8n maintenance lock failed: ${message}\n`)
  process.exit(1)
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

function canonicalJson(value) { return JSON.stringify(canonical(value)) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) fail(`${label} fields are invalid`)
}

function safeParent(pathname) {
  if (!isAbsolute(pathname) || resolve(pathname) !== pathname || /[\u0000-\u001f\u007f]/u.test(pathname)) {
    fail('lock path must be one normalized absolute path')
  }
  if (basename(pathname) !== '.n8n-maintenance.lock') fail('lock path must use the canonical maintenance filename')
  const parent = dirname(pathname)
  const entry = lstatSync(parent, { bigint: true })
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== BigInt(process.getuid())
    || Number(entry.mode & 0o7777n) !== 0o700 || realpathSync(parent) !== parent) {
    fail('lock parent must be one owner-private physical directory')
  }
  return parent
}

function processIdentity(pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 1024 * 1024,
  })
  if (result.error || result.signal || result.status !== 0 || !result.stdout.trim()) return null
  return sha256(result.stdout.trim())
}

function validateDirectory(pathname) {
  const entry = lstatSync(pathname, { bigint: true })
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== BigInt(process.getuid())
    || Number(entry.mode & 0o7777n) !== 0o700) fail('maintenance lock directory is unsafe')
  return entry
}

function fsyncDirectory(pathname, expectedEntry = null) {
  const before = validateDirectory(pathname)
  if (realpathSync(pathname) !== pathname
    || (expectedEntry && (before.dev !== expectedEntry.dev || before.ino !== expectedEntry.ino))) {
    fail('maintenance directory identity changed before sync')
  }
  const descriptor = openSync(pathname,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (!opened.isDirectory() || opened.uid !== BigInt(process.getuid())
      || opened.dev !== before.dev || opened.ino !== before.ino) {
      fail('maintenance directory identity changed while opening for sync')
    }
    fsyncSync(descriptor)
    const after = validateDirectory(pathname)
    if (after.dev !== before.dev || after.ino !== before.ino) {
      fail('maintenance directory identity changed during sync')
    }
  } finally { closeSync(descriptor) }
}

function unlinkEntryDurable(pathname, parent, expectedEntry = null) {
  const before = lstatSync(pathname, { bigint: true })
  if (before.isSymbolicLink() || (expectedEntry
    && (before.dev !== expectedEntry.dev || before.ino !== expectedEntry.ino))) {
    fail('maintenance entry identity changed before unlink')
  }
  unlinkSync(pathname)
  fsyncDirectory(parent)
}

function readLease(pathname) {
  const leasePath = join(pathname, 'lease.json')
  const entry = lstatSync(leasePath, { bigint: true })
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== BigInt(process.getuid())
    || entry.nlink !== 1n || Number(entry.mode & 0o7777n) !== 0o400 || entry.size < 1n || entry.size > 16_384n) {
    fail('maintenance lease file is unsafe')
  }
  let value
  let source
  const descriptor = openSync(leasePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size
      || opened.mtimeNs !== entry.mtimeNs || opened.ctimeNs !== entry.ctimeNs || opened.nlink !== 1n) {
      fail('maintenance lease changed before open')
    }
    source = readFileSync(descriptor, 'utf8')
    const afterFd = fstatSync(descriptor, { bigint: true })
    const afterPath = lstatSync(leasePath, { bigint: true })
    if (Buffer.byteLength(source) !== Number(opened.size) || afterFd.dev !== opened.dev
      || afterFd.ino !== opened.ino || afterFd.size !== opened.size || afterFd.mtimeNs !== opened.mtimeNs
      || afterFd.ctimeNs !== opened.ctimeNs || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino
      || afterPath.size !== opened.size || afterPath.mtimeNs !== opened.mtimeNs
      || afterPath.ctimeNs !== opened.ctimeNs || afterPath.nlink !== 1n) {
      fail('maintenance lease changed while read')
    }
    try { value = JSON.parse(source) } catch { fail('maintenance lease JSON is invalid') }
  } finally { closeSync(descriptor) }
  exactKeys(value, ['acquiredAt', 'nonce', 'owner', 'pid', 'processIdentitySha256', 'schema', 'uid'], 'maintenance lease')
  if (value.schema !== SCHEMA || value.uid !== process.getuid() || !OWNERS.has(value.owner)
    || !Number.isSafeInteger(value.pid) || value.pid <= 1 || !Number.isSafeInteger(value.acquiredAt)
    || value.acquiredAt <= 0 || !SHA256.test(value.nonce) || !SHA256.test(value.processIdentitySha256)) {
    fail('maintenance lease identity is invalid')
  }
  return {
    value,
    reference: {
      dev: entry.dev.toString(), ino: entry.ino.toString(), size: Number(entry.size),
      mtimeNs: entry.mtimeNs.toString(), ctimeNs: entry.ctimeNs.toString(),
      sha256: sha256(source),
    },
  }
}

function terminalLeaseBinding(lease) {
  if (!lease) return null
  return {
    reference: lease.reference,
    owner: lease.value.owner,
    pid: lease.value.pid,
    nonce: lease.value.nonce,
    processIdentitySha256: lease.value.processIdentitySha256,
  }
}

function terminalClaim(lockPath, purpose, expectedEntry, lease = null) {
  const marker = join(lockPath, '.terminal')
  if ((purpose === 'reap-empty') !== (lease === null)) fail('terminal claim lease binding is invalid')
  const value = {
    schema: TERMINAL_SCHEMA,
    purpose,
    uid: process.getuid(),
    claimantPid: process.pid,
    claimedAt: Date.now(),
    lock: { dev: expectedEntry.dev.toString(), ino: expectedEntry.ino.toString() },
    lease: terminalLeaseBinding(lease),
  }
  let descriptor
  try {
    descriptor = openSync(marker, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeFileSync(descriptor, `${canonicalJson(value)}\n`)
    fchmodSync(descriptor, 0o400)
    fsyncSync(descriptor)
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOENT') return false
    fail('unable to claim maintenance lock teardown')
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch {}
    }
  }
  const current = lstatSync(lockPath, { bigint: true })
  if (current.dev !== expectedEntry.dev || current.ino !== expectedEntry.ino) fail('maintenance lock changed during teardown claim')
  fsyncDirectory(lockPath, expectedEntry)
  if (process.env.NODE_ENV === 'test'
    && process.env.AIWORKER_TEST_MAINTENANCE_FAILPOINT === 'after-terminal-claim') {
    process.kill(process.pid, 'SIGKILL')
  }
  return true
}

function readTerminal(lockPath, expectedEntry, lease = null) {
  const marker = join(lockPath, '.terminal')
  const entry = lstatSync(marker, { bigint: true })
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== BigInt(process.getuid())
    || entry.nlink !== 1n || Number(entry.mode & 0o7777n) !== 0o400
    || entry.size < 1n || entry.size > 16_384n) fail('maintenance terminal marker is unsafe')
  const descriptor = openSync(marker, constants.O_RDONLY | constants.O_NOFOLLOW)
  let source
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size
      || opened.mtimeNs !== entry.mtimeNs || opened.ctimeNs !== entry.ctimeNs || opened.nlink !== 1n) {
      fail('maintenance terminal marker changed before open')
    }
    source = readFileSync(descriptor, 'utf8')
    const after = fstatSync(descriptor, { bigint: true })
    const current = lstatSync(marker, { bigint: true })
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size
      || current.mtimeNs !== opened.mtimeNs || current.ctimeNs !== opened.ctimeNs) {
      fail('maintenance terminal marker changed while read')
    }
  } finally { closeSync(descriptor) }
  let value
  try { value = JSON.parse(source) } catch { fail('maintenance terminal marker JSON is invalid') }
  exactKeys(value, ['claimedAt', 'claimantPid', 'lease', 'lock', 'purpose', 'schema', 'uid'], 'maintenance terminal marker')
  exactKeys(value.lock, ['dev', 'ino'], 'maintenance terminal lock binding')
  if (value.schema !== TERMINAL_SCHEMA || !['release', 'reap-stale', 'reap-empty'].includes(value.purpose)
    || value.uid !== process.getuid() || !Number.isSafeInteger(value.claimantPid) || value.claimantPid <= 1
    || !Number.isSafeInteger(value.claimedAt) || value.claimedAt <= 0
    || value.lock.dev !== expectedEntry.dev.toString() || value.lock.ino !== expectedEntry.ino.toString()) {
    fail('maintenance terminal marker identity is invalid')
  }
  const expectedLease = terminalLeaseBinding(lease)
  if (canonicalJson(value.lease) !== canonicalJson(expectedLease)
    || ((value.purpose === 'reap-empty') !== (value.lease === null))) {
    fail('maintenance terminal marker lease binding changed')
  }
  return value
}

function removeClaimed(lockPath, parent, expectedEntry) {
  const quarantine = join(parent, `.maintenance-lock-reaped-${randomUUID()}`)
  const current = lstatSync(lockPath, { bigint: true })
  if (current.dev !== expectedEntry.dev || current.ino !== expectedEntry.ino) fail('maintenance lock changed before quarantine')
  renameSync(lockPath, quarantine)
  const quarantined = validateDirectory(quarantine)
  if (quarantined.dev !== expectedEntry.dev || quarantined.ino !== expectedEntry.ino) {
    fail('maintenance lock identity changed during quarantine')
  }
  fsyncDirectory(parent)
  const members = readdirSync(quarantine).sort()
  if (canonicalJson(members) !== canonicalJson(['.terminal', 'lease.json'].filter(name => existsSync(join(quarantine, name))).sort())) {
    fail(`quarantined maintenance lock contains unknown members: ${quarantine}`)
  }
  for (const name of members) unlinkSync(join(quarantine, name))
  fsyncDirectory(quarantine, quarantined)
  rmdirSync(quarantine)
  fsyncDirectory(parent)
}

function resumeClaimedTeardown(lockPath, parent, entry, members, releaseCapability = null) {
  if (canonicalJson(members) === canonicalJson(['.terminal'])) {
    const terminal = readTerminal(lockPath, entry, null)
    if (terminal.purpose !== 'reap-empty') fail('lease-free terminal claim purpose is invalid')
    removeClaimed(lockPath, parent, entry)
    return true
  }
  if (canonicalJson(members) !== canonicalJson(['.terminal', 'lease.json'])) {
    fail('unknown maintenance lock holder; refusing automatic removal')
  }
  const lease = readLease(lockPath)
  const terminal = readTerminal(lockPath, entry, lease)
  if (releaseCapability) {
    if (terminal.purpose !== 'release'
      || lease.value.owner !== releaseCapability.owner
      || lease.value.pid !== releaseCapability.pid
      || lease.value.nonce !== releaseCapability.nonce
      || lease.value.processIdentitySha256 !== processIdentity(releaseCapability.pid)) {
      fail('maintenance lock release recovery capability is invalid')
    }
  } else {
    if (!['release', 'reap-stale'].includes(terminal.purpose)) {
      fail('maintenance terminal claim purpose is invalid')
    }
    if (processIdentity(lease.value.pid) === lease.value.processIdentitySha256) {
      fail(`maintenance lock is held by ${lease.value.owner} PID ${lease.value.pid}`)
    }
  }
  removeClaimed(lockPath, parent, entry)
  return true
}

function reapIfStale(lockPath, parent) {
  const entry = validateDirectory(lockPath)
  const members = readdirSync(lockPath).sort()
  if (members.includes('.terminal')) {
    return resumeClaimedTeardown(lockPath, parent, entry, members)
  }
  if (members.length === 0) {
    if (Date.now() - Number(statSync(lockPath, { bigint: true }).mtimeMs) < EMPTY_GRACE_MS) {
      fail('maintenance lock acquisition is still initializing')
    }
    if (!terminalClaim(lockPath, 'reap-empty', entry)) fail('maintenance lock teardown is already in progress')
    const after = readdirSync(lockPath).sort()
    if (canonicalJson(after) !== canonicalJson(['.terminal'])) fail('initializing maintenance lock changed during stale check')
    removeClaimed(lockPath, parent, entry)
    return true
  }
  if (canonicalJson(members) !== canonicalJson(['lease.json'])) fail('unknown maintenance lock holder; refusing automatic removal')
  const lease = readLease(lockPath)
  if (processIdentity(lease.value.pid) === lease.value.processIdentitySha256) {
    fail(`maintenance lock is held by ${lease.value.owner} PID ${lease.value.pid}`)
  }
  if (!terminalClaim(lockPath, 'reap-stale', entry, lease)) fail('maintenance lock teardown is already in progress')
  if (processIdentity(lease.value.pid) === lease.value.processIdentitySha256) fail('maintenance lock holder revived during stale check')
  removeClaimed(lockPath, parent, entry)
  return true
}

function acquire(lockPath, owner, pid) {
  if (!OWNERS.has(owner)) fail('lock owner is invalid')
  if (!Number.isSafeInteger(pid) || pid <= 1) fail('lock PID is invalid')
  const identity = processIdentity(pid)
  if (!identity) fail('lock holder process is unavailable')
  const parent = safeParent(lockPath)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const nonce = randomBytes(32).toString('hex')
    const lease = {
      schema: SCHEMA, owner, pid, uid: process.getuid(), acquiredAt: Math.floor(Date.now() / 1000),
      nonce, processIdentitySha256: identity,
    }
    const stagedLease = join(parent, `.n8n-maintenance-lease-${nonce}.tmp`)
    const descriptor = openSync(stagedLease, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o400)
    try {
      writeFileSync(descriptor, `${canonicalJson(lease)}\n`)
      fchmodSync(descriptor, 0o400)
      fsyncSync(descriptor)
    } finally { closeSync(descriptor) }
    fsyncDirectory(parent)
    try {
      mkdirSync(lockPath, { mode: 0o700 })
      chmodSync(lockPath, 0o700)
      const created = validateDirectory(lockPath)
      fsyncDirectory(lockPath, created)
      fsyncDirectory(parent)
    } catch (error) {
      try { unlinkEntryDurable(stagedLease, parent) } catch {}
      if (error?.code !== 'EEXIST') fail('unable to create maintenance lock')
      reapIfStale(lockPath, parent)
      continue
    }
    const leasePath = join(lockPath, 'lease.json')
    const stagedEntry = lstatSync(stagedLease, { bigint: true })
    try {
      renameSync(stagedLease, leasePath)
      const published = lstatSync(leasePath, { bigint: true })
      if (published.dev !== stagedEntry.dev || published.ino !== stagedEntry.ino) {
        fail('maintenance lease identity changed during publication')
      }
      fsyncDirectory(lockPath)
      fsyncDirectory(parent)
    } catch { fail('unable to publish maintenance lease') }
    process.stdout.write(`${nonce}\n`)
    return
  }
  fail('maintenance lock contention did not settle')
}

function release(lockPath, owner, pid, nonce) {
  const parent = safeParent(lockPath)
  const entry = validateDirectory(lockPath)
  const members = readdirSync(lockPath).sort()
  if (members.includes('.terminal')) {
    resumeClaimedTeardown(lockPath, parent, entry, members, { owner, pid, nonce })
    return
  }
  if (canonicalJson(members) !== canonicalJson(['lease.json'])) fail('maintenance lock has unknown members')
  const lease = readLease(lockPath)
  if (lease.value.owner !== owner || lease.value.pid !== pid || lease.value.nonce !== nonce
    || lease.value.processIdentitySha256 !== processIdentity(pid)) fail('maintenance lock release capability is invalid')
  if (!terminalClaim(lockPath, 'release', entry, lease)) fail('maintenance lock teardown is already in progress')
  removeClaimed(lockPath, parent, entry)
}

const [command, lockPath, owner, pidSource, nonce] = process.argv.slice(2)
const pid = Number(pidSource)
if (!['acquire', 'release'].includes(command) || !lockPath || !owner || !pidSource
  || (command === 'release' && !nonce) || process.argv.length !== (command === 'acquire' ? 6 : 7)) {
  fail('usage: n8n-maintenance-lock.mjs acquire|release LOCK OWNER PID [NONCE]')
}
if (command === 'acquire') acquire(lockPath, owner, pid)
else release(lockPath, owner, pid, nonce)
