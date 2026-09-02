#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  futimesSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acquireSharedDeploymentLockSync } from './lib/shared-deployment-lock.mjs'
import {
  inspectWorkerLaunchAuthorizationStateSync,
  issueWorkerLaunchAuthorizationSync,
  removeWorkerLaunchAuthorizationArtifactSync,
  verifyWorkerLaunchAuthorizationSync,
  workerLaunchAuthorizationClaimPath,
  workerLaunchAuthorizationPath,
} from '../openclaw-skills/aiworker-task-flow/lib/worker-launch-authorization.mjs'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPOSITORY_ROOT = realpathSync(join(dirname(SCRIPT_PATH), '..'))
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const LABEL = 'ai.aiworker.video-lane-supervisor'
const N8N_LABEL = 'com.video-autoworker.n8n'
const INTENT_SCHEMA = 'video-autoworker-legacy-media-orphan-runtime-intent/v1'
const RECEIPT_SCHEMA = 'video-autoworker-legacy-media-orphan-runtime-receipt/v1'
const RESTORE_INTENT_SCHEMA = 'video-autoworker-legacy-media-orphan-runtime-restore-intent/v1'
const RESTORE_SCHEMA = 'video-autoworker-legacy-media-orphan-runtime-restore/v1'
const RETIRE_INTENT_SCHEMA = 'video-autoworker-legacy-media-orphan-runtime-retire-intent/v1'
const RETIRE_SCHEMA = 'video-autoworker-legacy-media-orphan-runtime-retire/v1'
const FINAL_READINESS_SCHEMA = 'video-autoworker-legacy-retire-final-readiness/v1'
const FINAL_READINESS_VERIFY_SCHEMA = 'video-autoworker-legacy-retire-final-readiness-verification/v1'
const GUARDIAN_SCHEMA = 'video-autoworker-worker-launch-guardian/v2'
const GUARDIAN_OWNER_SCHEMA = 'video-autoworker-worker-launch-guardian-owner/v1'
// This exact predecessor can leave an intent after correctly stopping the lane
// while misreading newer macOS `print-disabled` wording. Newer code may consume
// that immutable pre-rename intent, but no receipt or arbitrary tool is accepted.
const RECOVERABLE_PREDECESSOR_TOOL_SHA256 = new Set([
  '95a873283b6f0c7c473354791eb9d57807735556de81fe27c1abb1aa035b6384',
])
// This exact production tool created the held post-quarantine receipt before
// the four-field CAS. It may authorize only `retire`; status, restore, and
// SIGKILL recovery keep requiring their own exact tool contracts.
const RETIRABLE_PREDECESSOR_TOOL_SHA256 = new Set([
  '61eb99581f2c0123634790e7667e04166f61b8115de16de282c9657208a84391',
])
const RECONCILED_ERROR = '[LEGACY_MEDIA_ORPHAN_RECONCILED] 历史媒体子记录已在父任务和对应执行终态、无运行资源时受管收敛'
const SHA256 = /^[a-f0-9]{64}$/u
const TASK_ID = /^[A-Za-z0-9._:-]{1,120}$/u
const ACTIVE_MEDIA = new Set(['queued', 'accepted', 'running'])
const TERMINAL_PARENT = new Set(['succeeded', 'failed', 'cancelled'])
const TERMINAL_EXECUTION = new Set(['success', 'error', 'crashed', 'canceled', 'cancelled'])
const RUNNABLE_BATCH = new Set(['queued', 'running', 'recovering'])
const ACTIVE_ITEM = new Set(['queued', 'staging', 'submitted', 'accepted', 'running', 'waiting', 'recovering'])
const TEST_MODE = process.env.NODE_ENV === 'test'
  && process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD === '1'
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_DATABASE_BYTES = 64 * 1024 * 1024 * 1024
const MAX_TREE_ENTRIES = 20_000
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024
const WAIT_ATTEMPTS = TEST_MODE ? 8 : 150
const WAIT_MILLISECONDS = TEST_MODE ? 5 : 200
const HANDOFF_WAIT_ATTEMPTS = TEST_MODE ? 200 : 50
const HANDOFF_WAIT_MILLISECONDS = TEST_MODE ? 10 : 200
const GUARDIAN_REFRESH_MILLISECONDS = TEST_MODE ? 250 : 5_000
const FINAL_READINESS_VERIFIER = join(REPOSITORY_ROOT, 'scripts', 'verify-legacy-retire-final-readiness.mjs')

function fail(message) {
  throw new Error(`legacy media orphan runtime guard failed: ${message}`)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function parseArguments(argv) {
  const command = argv[0]
  if (!['prepare', 'status', 'restore', 'recover', 'retire'].includes(command)) fail('unknown command')
  const allowed = command === 'prepare'
    ? new Set(['--run-root', '--quarantine-root', '--minimum-age-seconds', '--hold-guardian'])
    : new Set(command === 'retire'
      ? ['--receipt', '--final-readiness']
      : [command === 'recover' ? '--intent' : '--receipt'])
  const values = {}
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    if (!allowed.has(name) || Object.hasOwn(values, name) || index + 1 >= argv.length) fail('arguments are invalid')
    values[name] = argv[index + 1]
  }
  if (argv.length % 2 !== 1) fail('required arguments are missing')
  if (command === 'prepare') {
    if (!['--run-root', '--quarantine-root', '--minimum-age-seconds'].every(name => Object.hasOwn(values, name))) {
      fail('required arguments are missing')
    }
    if (Object.hasOwn(values, '--hold-guardian') && values['--hold-guardian'] !== 'yes') {
      fail('hold guardian must be yes when supplied')
    }
    const minimumAgeSeconds = Number(values['--minimum-age-seconds'])
    if (!Number.isSafeInteger(minimumAgeSeconds) || minimumAgeSeconds < 900
      || minimumAgeSeconds > 30 * 24 * 60 * 60) fail('minimum age is invalid')
    return {
      command,
      runRoot: normalizedAbsolute(values['--run-root'], 'run root'),
      quarantineRoot: normalizedAbsolute(values['--quarantine-root'], 'quarantine root'),
      minimumAgeSeconds,
      holdGuardian: values['--hold-guardian'] === 'yes',
    }
  }
  if (command === 'retire') {
    if (Object.keys(values).length !== 2) fail('required arguments are missing')
    return {
      command,
      pathname: normalizedAbsolute(values['--receipt'], 'receipt'),
      finalReadiness: normalizedAbsolute(values['--final-readiness'], 'final readiness'),
    }
  }
  if (Object.keys(values).length !== 1) fail('required arguments are missing')
  const key = command === 'recover' ? '--intent' : '--receipt'
  return { command, pathname: normalizedAbsolute(values[key], key.slice(2)) }
}

function normalizedAbsolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} must be one normalized absolute path`)
  return pathname
}

function assertNoSymlink(pathname, label, allowMissingLeaf = false) {
  normalizedAbsolute(pathname, label)
  const root = parse(pathname).root
  let current = root
  const parts = relative(root, pathname).split('/').filter(Boolean)
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index])
    let entry
    try { entry = lstatSync(current, { bigint: true }) } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && error?.code === 'ENOENT') return
      fail(`${label} path component is unavailable`)
    }
    if (entry.isSymbolicLink()) fail(`${label} path contains a symlink`)
  }
}

function safeEntry(pathname, label, kind, requiredMode = null) {
  assertNoSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if (kind === 'file' && !entry.isFile()) fail(`${label} is not a regular file`)
  if (kind === 'directory' && !entry.isDirectory()) fail(`${label} is not a directory`)
  if (kind === 'file' && entry.nlink !== 1n) fail(`${label} link count is unsafe`)
  if (entry.uid !== BigInt(process.getuid())) fail(`${label} owner is invalid`)
  const mode = Number(entry.mode & 0o7777n)
  if (requiredMode === null ? (mode & 0o022) !== 0 : mode !== requiredMode) fail(`${label} mode is unsafe`)
  return entry
}

function identity(pathname, label, kind = 'file', requiredMode = null) {
  const entry = safeEntry(pathname, label, kind, requiredMode)
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    uid: Number(entry.uid),
    mode: Number(entry.mode & 0o7777n),
  }
}

function sameIdentity(left, right) {
  return left.path === right.path && left.dev === right.dev && left.ino === right.ino
    && left.uid === right.uid && left.mode === right.mode
}

function optionalEntry(pathname) {
  try { return lstatSync(pathname, { bigint: true }) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function fsyncFile(pathname) {
  recordTestEvent(`fsync-file:${basename(pathname)}`)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function fsyncDirectory(pathname) {
  recordTestEvent(`fsync-directory:${basename(pathname)}`)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function acquireSharedDeploymentLock() {
  const runDirectory = normalizedAbsolute(
    process.env.AIWORKER_BG_RUN_DIR || join(REPOSITORY_ROOT, '.run', 'blue-green'),
    'blue-green run directory',
  )
  try {
    return acquireSharedDeploymentLockSync({ runDirectory })
  } catch (error) {
    fail(error instanceof Error ? error.message : 'shared deployment lock acquisition failed')
  }
}

function immutableJson(pathname, value) {
  assertNoSymlink(pathname, 'immutable output', true)
  if (optionalEntry(pathname)) fail('immutable output already exists')
  const parent = identity(dirname(pathname), 'immutable output parent', 'directory', 0o700)
  const temporary = join(parent.path, `.${basename(pathname)}.${randomBytes(12).toString('hex')}.tmp`)
  let descriptor
  try {
    if (TEST_MODE && process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_FAIL_OUTPUT_BASENAME === basename(pathname)) {
      fail(`injected ${basename(pathname)} write failure`)
    }
    recordTestEvent(`write-temp:${basename(pathname)}`)
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    const source = `${canonicalJson(value)}\n`
    writeFileSync(descriptor, source)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    chmodSync(temporary, 0o400)
    fsyncFile(temporary)
    renameSync(temporary, pathname)
    recordTestEvent(`publish:${basename(pathname)}`)
    fsyncFile(pathname)
    fsyncDirectory(parent.path)
    const loaded = readImmutableJson(pathname, basename(pathname))
    if (canonicalJson(loaded.value) !== canonicalJson(value)) fail('immutable output verification failed')
    return loaded
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    throw error
  }
}

function recordTestEvent(event) {
  if (!TEST_MODE || !process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_EVENT_LOG) return
  const pathname = testPath('AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_EVENT_LOG', '')
  writeFileSync(pathname, `${event}\n`, { flag: 'a', mode: 0o600 })
}

function readImmutableJson(pathname, label) {
  const entry = safeEntry(pathname, label, 'file', 0o400)
  if (entry.size > BigInt(MAX_JSON_BYTES)) fail(`${label} is too large`)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) fail(`${label} changed before read`)
    const source = readFileSync(descriptor, 'utf8')
    if (Buffer.byteLength(source) !== Number(opened.size)) fail(`${label} changed during read`)
    let value
    try { value = JSON.parse(source) } catch { fail(`${label} is not JSON`) }
    return { value, source, sha256: sha256(source), identity: identity(pathname, label, 'file', 0o400) }
  } finally { closeSync(descriptor) }
}

function treeSnapshot(root, label) {
  const rootIdentity = identity(root, label, 'directory', 0o700)
  if (realpathSync(root) !== root) fail(`${label} is not physical`)
  const entries = []
  let totalBytes = 0
  const visit = (directory, prefix) => {
    const handle = opendirSync(directory)
    try {
      for (;;) {
        const item = handle.readSync()
        if (!item) break
        if (entries.length >= MAX_TREE_ENTRIES) fail(`${label} exceeds the entry limit`)
        const pathname = join(directory, item.name)
        const relativeName = prefix ? `${prefix}/${item.name}` : item.name
        const entry = lstatSync(pathname, { bigint: true })
        if (entry.isSymbolicLink()) fail(`${label} contains a symlink`)
        if (entry.uid !== BigInt(process.getuid()) || (Number(entry.mode & 0o7777n) & 0o022) !== 0) {
          fail(`${label} contains an unsafe member`)
        }
        if (entry.isDirectory()) {
          entries.push({ path: `${relativeName}/`, type: 'directory', dev: String(entry.dev), ino: String(entry.ino), mode: Number(entry.mode & 0o7777n) })
          visit(pathname, relativeName)
        } else if (entry.isFile()) {
          totalBytes += Number(entry.size)
          if (totalBytes > MAX_TREE_BYTES) fail(`${label} exceeds the byte limit`)
          const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
          try {
            const opened = fstatSync(descriptor, { bigint: true })
            if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) fail(`${label} member changed during open`)
            const digest = createHash('sha256')
            const buffer = Buffer.allocUnsafe(1024 * 1024)
            let bytes = 0
            for (;;) {
              const count = readFileChunk(descriptor, buffer, bytes)
              if (count === 0) break
              digest.update(buffer.subarray(0, count))
              bytes += count
            }
            if (BigInt(bytes) !== opened.size) fail(`${label} member changed during read`)
            entries.push({ path: relativeName, type: 'file', bytes, dev: String(opened.dev), ino: String(opened.ino), mode: Number(opened.mode & 0o7777n), sha256: digest.digest('hex') })
          } finally { closeSync(descriptor) }
        } else fail(`${label} contains a non-file member`)
      }
    } finally { handle.closeSync() }
  }
  visit(root, '')
  entries.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  const currentRoot = identity(root, label, 'directory', 0o700)
  if (!sameIdentity(rootIdentity, currentRoot)) fail(`${label} changed during scan`)
  return { root: rootIdentity, entries: entries.length, bytes: totalBytes, digest: sha256(canonicalJson(entries)) }
}

function readFileChunk(descriptor, buffer, position) {
  return require('node:fs').readSync(descriptor, buffer, 0, buffer.length, position)
}

function testPath(name, production) {
  if (!TEST_MODE || !process.env[name]) return production
  return normalizedAbsolute(process.env[name], name)
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: MAX_JSON_BYTES, timeout: 10_000 })
  if (result.error || result.signal || result.status !== 0) fail(`${label} failed`)
  return result.stdout
}

function runStatus(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: MAX_JSON_BYTES, timeout: 10_000 })
}

function command(name, production) {
  return testPath(`AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_${name}`, production)
}

function parseLsof(source) {
  const records = []
  let current = null
  for (const line of source.split('\n')) {
    if (line[0] === 'f') { current = { descriptor: line.slice(1) }; records.push(current) }
    else if (current && line[0] === 'D') current.dev = BigInt(line.slice(1)).toString()
    else if (current && line[0] === 'i') current.ino = BigInt(line.slice(1)).toString()
    else if (current && line[0] === 'n') current.path = line.slice(1)
  }
  return records
}

function listenerPid(port) {
  const source = run(command('LSOF', '/usr/sbin/lsof'), ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], `${port} listener query`)
  const values = [...new Set(source.split('\n').filter(line => /^p[1-9][0-9]*$/u.test(line)).map(line => Number(line.slice(1))))]
  if (values.length !== 1) fail(`port ${port} does not have exactly one listener`)
  return values[0]
}

function openRecords(pid) {
  return parseLsof(run(command('LSOF', '/usr/sbin/lsof'), ['-a', '-p', String(pid), '-FfDin'], `PID ${pid} open-file query`))
}

function findOpenPath(records, expression, label, kind = 'file') {
  const values = [...new Set(records.filter(item => expression.test(item.path || '')).map(item => item.path))]
  if (values.length !== 1) fail(`${label} is not uniquely open`)
  const result = identity(values[0], label, kind)
  if (!records.some(item => item.path === result.path && item.dev === result.dev && item.ino === result.ino)) fail(`${label} open identity differs`)
  return result
}

function numericDatabaseRecords(records) {
  return records.filter(record => /^\d+[A-Za-z]*$/u.test(record.descriptor || '')
    && record.dev !== undefined && record.ino !== undefined)
}

function findDatabase(records, expression, label) {
  const paths = [...new Set(numericDatabaseRecords(records)
    .filter(item => expression.test(item.path || '')).map(item => item.path))]
  if (paths.length !== 1) fail(`${label} is not uniquely open on a numeric file descriptor`)
  const result = identity(paths[0], label)
  const matches = numericDatabaseRecords(records).filter(item => item.path === result.path
    && item.dev === result.dev && item.ino === result.ino)
  if (matches.length < 1) fail(`${label} open identity differs`)
  return result
}

function validateNewDatabaseConnection(expected, beforeRecords, afterRecords, label) {
  const current = identity(expected.path, label)
  if (!sameIdentity(current, expected)) fail(`${label} does not match the precaptured identity`)
  const occupied = new Set(numericDatabaseRecords(beforeRecords).map(record => record.descriptor))
  const added = numericDatabaseRecords(afterRecords).filter(record => !occupied.has(record.descriptor))
  const matches = added.filter(record => record.path === expected.path
    && record.dev === expected.dev && record.ino === expected.ino)
  if (matches.length !== 1 || added.some(record => record.path === expected.path
    && (record.dev !== expected.dev || record.ino !== expected.ino))) {
    fail(`${label} newly opened SQLite FD does not match the precaptured identity`)
  }
  return matches[0].descriptor
}

function revalidateDatabaseConnection(handle, label) {
  const current = identity(handle.expected.path, label)
  const verifier = fstatSync(handle.verifierFd, { bigint: true })
  const matches = numericDatabaseRecords(openRecords(process.pid))
    .filter(record => record.descriptor === handle.connectionDescriptor
      && record.path === handle.expected.path && record.dev === handle.expected.dev
      && record.ino === handle.expected.ino)
  if (!sameIdentity(current, handle.expected)
    || verifier.dev.toString() !== handle.expected.dev || verifier.ino.toString() !== handle.expected.ino
    || matches.length !== 1) fail(`${label} SQLite connection identity changed`)
}

function openBoundReadonlyDatabase(expected, label) {
  const entry = safeEntry(expected.path, label, 'file')
  if (entry.size > BigInt(MAX_DATABASE_BYTES)) fail(`${label} is too large`)
  if (!sameIdentity(identity(expected.path, label), expected)) fail(`${label} does not match the precaptured identity`)
  const verifierFd = openSync(expected.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  const verifier = fstatSync(verifierFd, { bigint: true })
  if (verifier.dev.toString() !== expected.dev || verifier.ino.toString() !== expected.ino
    || verifier.size !== entry.size) {
    closeSync(verifierFd)
    fail(`${label} changed before verifier open`)
  }
  const before = openRecords(process.pid)
  let db
  try {
    db = new Database(expected.path, { readonly: true, fileMustExist: true })
    const connectionDescriptor = validateNewDatabaseConnection(
      expected, before, openRecords(process.pid), label,
    )
    const handle = { db, verifierFd, expected, connectionDescriptor }
    db.pragma('query_only = ON')
    quickCheck(db, label)
    revalidateDatabaseConnection(handle, label)
    return handle
  } catch (error) {
    try { db?.close() } catch { /* Preserve the binding failure. */ }
    closeSync(verifierFd)
    throw error
  }
}

function closeBoundReadonlyDatabase(handle, label) {
  try { revalidateDatabaseConnection(handle, label) } finally {
    try { handle.db.close() } finally { closeSync(handle.verifierFd) }
  }
}

function processIdentity(pid, records, label) {
  const uid = Number(run(command('PS', '/bin/ps'), ['-p', String(pid), '-o', 'uid='], `${label} uid`).trim())
  const ppid = Number(run(command('PS', '/bin/ps'), ['-p', String(pid), '-o', 'ppid='], `${label} parent`).trim())
  const startTime = run(command('PS', '/bin/ps'), ['-p', String(pid), '-o', 'lstart='], `${label} start`).trim()
  const argv = run(command('PS', '/bin/ps'), ['-ww', '-p', String(pid), '-o', 'command='], `${label} argv`).trim()
  if (!Number.isSafeInteger(uid) || uid !== process.getuid() || !Number.isSafeInteger(ppid) || ppid <= 0 || !startTime || !argv) fail(`${label} process identity is invalid`)
  const cwdRecord = records.filter(item => item.descriptor === 'cwd')
  if (cwdRecord.length !== 1) fail(`${label} cwd is unavailable`)
  const cwd = identity(cwdRecord[0].path, `${label} cwd`, 'directory')
  if (cwd.dev !== cwdRecord[0].dev || cwd.ino !== cwdRecord[0].ino) fail(`${label} cwd differs from open identity`)
  return { pid, ppid, uid, startTime, argvSha256: sha256(argv), argv, cwd }
}

function launchState(label = LABEL) {
  const service = `gui/${process.getuid()}/${label}`
  const result = runStatus(command('LAUNCHCTL', '/bin/launchctl'), ['print', service])
  if (result.error || result.signal || ![0, 1, 3, 113].includes(result.status)) fail(`${label} LaunchAgent query failed`)
  if (result.status !== 0) return { loaded: false, pid: null }
  const matches = [...result.stdout.matchAll(/^\s*pid = ([1-9][0-9]*)\s*$/gmu)]
  if (matches.length !== 1 || !/^\s*state = running\s*$/mu.test(result.stdout)) fail(`${label} LaunchAgent state is invalid`)
  return { loaded: true, pid: Number(matches[0][1]) }
}

function disabledState() {
  const source = run(command('LAUNCHCTL', '/bin/launchctl'), ['print-disabled', `gui/${process.getuid()}`], 'video-lane disabled-state query')
  const escaped = LABEL.replaceAll('.', '\\.')
  return new RegExp(`"?${escaped}"?\\s*=>\\s*(?:true|disabled)`, 'u').test(source)
}

function workerPids() {
  const result = runStatus(command('PGREP', '/usr/bin/pgrep'), ['-f', 'run-video-batch\\.mjs .*--serve-root'])
  if (result.error || result.signal || ![0, 1].includes(result.status) || (result.status === 1 && result.stdout.trim())) fail('video worker query failed')
  return result.status === 1 ? [] : result.stdout.trim().split(/\s+/u).filter(Boolean).map(Number)
}

function batchProjection(batchRoot, lockPath, authorizationContext = null) {
  safeEntry(batchRoot, 'video batch root', 'directory', 0o700)
  const active = []
  let journals = 0
  const members = []
  let launchControlChecked = false
  const projectState = (pathname, memberPath, backup = false) => {
    const entry = safeEntry(pathname, 'video batch state', 'file')
    if (entry.size > 8n * 1024n * 1024n) fail('video batch state is too large')
    const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
    let source
    try {
      const opened = fstatSync(descriptor, { bigint: true })
      if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
        fail('video batch state changed before open')
      }
      source = readFileSync(descriptor, 'utf8')
      const closed = fstatSync(descriptor, { bigint: true })
      if (closed.dev !== opened.dev || closed.ino !== opened.ino || closed.size !== opened.size
        || Buffer.byteLength(source) !== Number(opened.size)) {
        fail('video batch state changed during read')
      }
    } finally { closeSync(descriptor) }
    let value
    try { value = JSON.parse(source) } catch { fail('video batch state is invalid JSON') }
    if (![1, 2].includes(value?.schemaVersion) || !Array.isArray(value.items) || typeof value.status !== 'string') fail('video batch state contract is invalid')
    const itemStates = []
    for (const item of value.items) {
      if (!item || typeof item !== 'object' || typeof item.status !== 'string') fail('video batch item contract is invalid')
      if (!backup && item.stagingRecovery && item.status !== 'attention') journals += 1
      if (!backup && ACTIVE_ITEM.has(item.status)) active.push({ status: item.status, taskHash: sha256(String(item.taskId || '')) })
      itemStates.push({ status: item.status, taskHash: sha256(String(item.taskId || '')), stagingRecovery: Boolean(item.stagingRecovery) })
    }
    if (!backup && RUNNABLE_BATCH.has(value.status) && !value.items.some(item => ACTIVE_ITEM.has(item?.status))) {
      active.push({ status: value.status, taskHash: sha256(String(value.batchId || '')) })
    }
    members.push({
      path: memberPath,
      type: 'file',
      dev: entry.dev.toString(),
      ino: entry.ino.toString(),
      mode: Number(entry.mode & 0o7777n),
      bytes: Number(entry.size),
      sha256: sha256(source),
      role: backup ? 'backup' : 'primary',
      batchStatus: value.status,
      itemStates,
    })
  }
  const names = []
  const handle = opendirSync(batchRoot)
  try { for (;;) { const item = handle.readSync(); if (!item) break; names.push(item.name) } } finally { handle.closeSync() }
  for (const name of names.sort()) {
    if (join(batchRoot, name) === lockPath
      || name === '.worker-launch.lock' || name === '.worker-launch.lock.owner') continue
    if (name === '.worker-launch.lock.authorization'
      || name === '.worker-launch.lock.authorization.claim'
      || name === '.worker-launch.lock.authorization.pending') {
      if (launchControlChecked) continue
      launchControlChecked = true
      if (!authorizationContext
        || !Number.isSafeInteger(authorizationContext.workerPid)
        || authorizationContext.workerPid <= 0
        || typeof authorizationContext.finalReadinessPath !== 'string') {
        fail('video batch root contains an unauthorized worker launch authorization')
      }
      const state = inspectWorkerLaunchAuthorizationStateSync({ batchRoot })
      if (state.pending && (state.authorization || state.claim)) {
        fail('video batch root contains conflicting worker launch authorization artifacts')
      }
      const currentLock = lockState(batchRoot, authorizationContext.workerPid)
      const readiness = readImmutableJson(
        authorizationContext.finalReadinessPath,
        'claimed worker final-readiness report',
      )
      const bindsCurrentSuccessor = control => {
        const value = control.value
        return value.workerPid === authorizationContext.workerPid
          && value.globalLock.path === currentLock.path
          && value.globalLock.dev === currentLock.dev && value.globalLock.ino === currentLock.ino
          && value.globalLock.sourceSha256 === currentLock.contentSha256
          && value.globalLock.tokenSha256 === currentLock.tokenSha256
          && value.finalReadiness.path === readiness.identity.path
          && value.finalReadiness.dev === readiness.identity.dev
          && value.finalReadiness.ino === readiness.identity.ino
          && value.finalReadiness.sha256 === readiness.sha256
      }
      const assertRecoverablePredecessor = (control, label) => {
        if (bindsCurrentSuccessor(control)) return false
        const oldPid = control.value.workerPid
        if (pidExists(oldPid, `old worker launch ${label} owner`)) {
          fail(`old worker launch ${label} PID is still live or was reused`)
        }
        const oldLock = control.value.globalLock
        if (oldLock.dev === currentLock.dev && oldLock.ino === currentLock.ino
          && oldLock.tokenSha256 === currentLock.tokenSha256) {
          fail(`old worker launch ${label} lock was not replaced`)
        }
        return true
      }
      if (state.authorization) {
        if (!assertRecoverablePredecessor(state.authorization, 'authorization')) {
          verifyWorkerLaunchAuthorizationSync({
            batchRoot,
            workerPid: authorizationContext.workerPid,
            finalReadinessPath: authorizationContext.finalReadinessPath,
          })
        }
      }
      if (state.claim) {
        assertRecoverablePredecessor(state.claim, 'claim')
      }
      continue
    }
    if (/\.material-handoff\.json$/u.test(name)) fail('video batch root still contains a material handoff journal')
    const pathname = join(batchRoot, name)
    const candidate = lstatSync(pathname, { bigint: true })
    if (candidate.isDirectory()) {
      const directory = identity(pathname, 'video batch terminal directory', 'directory', 0o700)
      if (realpathSync(pathname) !== pathname) fail('video batch terminal directory is not physical')
      const nestedNames = []
      const nested = opendirSync(pathname)
      try { for (;;) { const item = nested.readSync(); if (!item) break; nestedNames.push(item.name) } } finally { nested.closeSync() }
      if (nestedNames.length === 0) fail('video batch terminal directory is empty')
      for (const nestedName of nestedNames) {
        if (!/^[a-f0-9]{64}\.json(?:\.bak)?$/u.test(nestedName)) fail('video batch terminal directory contains an unknown member')
        const nestedPath = join(pathname, nestedName)
        if (!lstatSync(nestedPath).isFile()) fail('video batch terminal directory contains a non-file member')
        if (nestedName.endsWith('.bak')) {
          if (!nestedNames.includes(nestedName.slice(0, -4))) fail('video batch terminal backup has no primary')
        } else if (!nestedNames.includes(`${nestedName}.bak`)) fail('video batch terminal primary has no backup')
      }
      members.push({ ...directory, path: `${name}/`, type: 'directory' })
      for (const nestedName of nestedNames.sort()) {
        projectState(join(pathname, nestedName), `${name}/${nestedName}`, nestedName.endsWith('.bak'))
      }
      continue
    }
    if (!/^[a-f0-9]{64}\.json(?:\.bak)?$/u.test(name)) fail('video batch root contains an unknown member')
    if (name.endsWith('.bak') && !names.includes(name.slice(0, -4))) fail('video batch backup has no primary')
    projectState(pathname, name, name.endsWith('.bak'))
  }
  members.sort((left, right) => left.path.localeCompare(right.path, 'en'))
  return { runnable: active.length, journals, digest: sha256(canonicalJson({ active, journals, members })) }
}

function lockState(batchRoot, expectedPid = null) {
  const pathname = join(batchRoot, '.global-video-worker.lock')
  const entry = optionalEntry(pathname)
  if (!entry) return { present: false, path: pathname }
  const file = identity(pathname, 'video-lane global lock', 'file', 0o600)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  let source
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev.toString() !== file.dev || opened.ino.toString() !== file.ino) fail('video-lane global lock changed before open')
    source = readFileSync(descriptor, 'utf8')
    if (Buffer.byteLength(source) !== Number(opened.size)) fail('video-lane global lock changed during read')
  } finally { closeSync(descriptor) }
  let value
  try { value = JSON.parse(source) } catch { fail('video-lane global lock is invalid JSON') }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'createdAt,pid,token'
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.token)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) fail('video-lane global lock contract is invalid')
  if (expectedPid !== null && value.pid !== expectedPid) fail('video-lane global lock owner differs from worker')
  return {
    present: true,
    ...file,
    bytes: Buffer.byteLength(source),
    contentSha256: sha256(source),
    ownerPid: value.pid,
    tokenSha256: sha256(value.token),
    createdAt: value.createdAt,
  }
}

function laneSnapshot(batchRoot, plistPath, phase, authorizationContext = null) {
  const service = launchState()
  const disabled = disabledState()
  const workers = workerPids()
  const lock = lockState(batchRoot, phase === 'active' && workers.length === 1 ? workers[0] : null)
  const plist = identity(plistPath, 'video-lane LaunchAgent plist', 'file', 0o600)
  if (phase === 'active') {
    if (!service.loaded || disabled || workers.length !== 1 || service.pid !== workers[0] || !lock.present) fail('video lane is not one enabled healthy idle worker')
    const records = openRecords(workers[0])
    const worker = processIdentity(workers[0], records, 'video worker')
    const argumentsValue = plistArguments(plistPath)
    if (canonicalJson(argumentsValue) !== canonicalJson(worker.argv.split(' '))) fail('video worker argv differs from the installed LaunchAgent plist')
    const executable = findOpenPath(records, /\/bin\/node$/u, 'video worker executable')
    if (realpathSync(argumentsValue[0]) !== executable.path && realpathSync(argumentsValue[0]) !== realpathSync(executable.path)) fail('video worker executable differs from the installed LaunchAgent plist')
    const workingDirectory = run(command('PLUTIL', '/usr/bin/plutil'), ['-extract', 'WorkingDirectory', 'raw', '-o', '-', plistPath], 'video-lane WorkingDirectory query').trim()
    if (realpathSync(workingDirectory) !== worker.cwd.path) fail('video worker cwd differs from the installed LaunchAgent plist')
    const projection = batchProjection(batchRoot, lock.path, authorizationContext ? {
      ...authorizationContext,
      workerPid: workers[0],
    } : null)
    if (projection.runnable !== 0 || projection.journals !== 0) fail('video lane still has runnable or journal work')
    return { service, disabled, workers, worker, lock, plist, projection }
  }
  if (service.loaded || !disabled || workers.length !== 0) fail('video lane is not disabled, unloaded, and worker-free')
  if (phase === 'stopped' ? !lock.present : lock.present) {
    fail(phase === 'stopped' ? 'stopped video lane no longer has the captured dead-owner lock' : 'video lane global lock is still present')
  }
  const projection = batchProjection(batchRoot, lock.path)
  if (projection.runnable !== 0 || projection.journals !== 0) fail('video lane acquired new runnable or journal work')
  return { service, disabled, workers, worker: null, lock, plist, projection }
}

function plistArguments(plistPath) {
  const source = run(command('PLUTIL', '/usr/bin/plutil'), ['-extract', 'ProgramArguments', 'json', '-o', '-', plistPath], 'video-lane ProgramArguments query')
  let value
  try { value = JSON.parse(source) } catch { fail('video-lane ProgramArguments are invalid') }
  if (!Array.isArray(value) || value.length !== 4 || value[2] !== '--serve-root'
    || !value.every(item => typeof item === 'string' && item.length > 0)) fail('video-lane ProgramArguments contract is invalid')
  return value
}

function quickCheck(db, label) {
  if (db.pragma('quick_check', { simple: true }) !== 'ok') fail(`${label} quick_check failed`)
}

function mediaChildTaskId(parentTaskId, stage) {
  const digest = sha256(`${parentTaskId}:${stage}`).slice(0, 24)
  return `media-task:${parentTaskId.slice(0, 70)}:${stage}:${digest}`.slice(0, 120)
}

function locateOrphan(missionIdentity, n8nIdentity, minimumAgeSeconds) {
  const missionHandle = openBoundReadonlyDatabase(missionIdentity, 'Mission Control database')
  let n8nHandle
  try {
    n8nHandle = openBoundReadonlyDatabase(n8nIdentity, 'n8n database')
    const mission = missionHandle.db
    const n8n = n8nHandle.db
    const active = mission.prepare("SELECT * FROM n8n_task_runs WHERE source = 'n8n-media-node' AND status IN ('queued','accepted','running') ORDER BY id").all()
    if (active.length !== 1) fail('Mission Control does not have exactly one active media child')
    const child = active[0]
    let routing
    try { routing = JSON.parse(child.routing) } catch { fail('media child routing is invalid') }
    const stage = routing?.mediaStage
    if (!['prepare', 'audio', 'vision'].includes(stage) || !ACTIVE_MEDIA.has(child.status)) fail('media child is not eligible')
    if (Math.floor(Date.now() / 1000) - child.updated_at < minimumAgeSeconds) fail('media child is not stale enough')
    const candidates = mission.prepare("SELECT * FROM n8n_task_runs WHERE binding_id=? AND workspace_id=? AND tenant_id=? AND status IN ('succeeded','failed','cancelled')").all(child.binding_id, child.workspace_id, child.tenant_id)
      .filter(parent => mediaChildTaskId(parent.task_id, stage) === child.task_id)
    if (candidates.length !== 1 || !TERMINAL_PARENT.has(candidates[0].status)
      || candidates[0].completed_at === null) fail('media child does not have one terminal parent')
    const parent = candidates[0]
    let parentRouting
    try { parentRouting = JSON.parse(parent.routing) } catch { fail('media parent routing is invalid') }
    const binding = mission.prepare('SELECT task_type FROM n8n_workflow_bindings WHERE id=? AND workspace_id=? AND tenant_id=?')
      .get(child.binding_id, child.workspace_id, child.tenant_id)
    if (parentRouting?.taskType !== 'video-analysis' || binding?.task_type !== 'video-analysis') {
      fail('media parent and child are not bound to the video workflow')
    }
    if (!TASK_ID.test(parent.task_id) || !TASK_ID.test(child.task_id)) fail('task identity is invalid')
    const leaseTable = mission.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='n8n_child_execution_leases'").get()
    if (leaseTable && mission.prepare('SELECT 1 FROM n8n_child_execution_leases WHERE task_id=?').get(child.task_id)) fail('media child still has an execution lease')
    const executions = n8n.prepare("SELECT e.id,e.status,e.stoppedAt,d.data FROM execution_entity e JOIN execution_data d ON d.executionId=e.id WHERE e.workflowId='aiworker-video-analysis-v1' AND e.stoppedAt IS NOT NULL").all()
      .filter(item => TERMINAL_EXECUTION.has(String(item.status).toLowerCase()) && executionOwnsParent(item.data, parent.task_id))
    if (executions.length !== 1) fail('terminal n8n execution is not uniquely bound to the orphan parent')
    const n8nActive = Number(n8n.prepare("SELECT COUNT(*) count FROM execution_entity WHERE status IN ('new','running','waiting') AND stoppedAt IS NULL").get().count)
    if (n8nActive !== 0) fail('n8n still has active executions')
    const workspace = join(dirname(missionIdentity.path), 'media-tasks', sha256(parent.task_id))
    const result = {
      child: { id: child.id, taskId: child.task_id, status: child.status, updatedAt: child.updated_at, stage },
      parent: { id: parent.id, taskId: parent.task_id, status: parent.status, digest: sha256(canonicalJson(parent)) },
      execution: { id: executions[0].id, status: executions[0].status, digest: sha256(executions[0].data) },
      workspace,
    }
    revalidateDatabaseConnection(missionHandle, 'Mission Control database')
    revalidateDatabaseConnection(n8nHandle, 'n8n database')
    return result
  } finally {
    if (n8nHandle) closeBoundReadonlyDatabase(n8nHandle, 'n8n database')
    closeBoundReadonlyDatabase(missionHandle, 'Mission Control database')
  }
}

function executionOwnsParent(source, parentTaskId) {
  try {
    const table = JSON.parse(source)
    if (!Array.isArray(table) || table.length < 2 || table.length > 100_000
      || !table[0] || typeof table[0] !== 'object' || Array.isArray(table[0])) return false
    const resultData = flattedObject(table, table[0].resultData)
    const runData = flattedObject(table, resultData.runData)
    if (!Object.hasOwn(runData, 'AI-worker Video Webhook')) return false
    const runs = flattedArray(table, runData['AI-worker Video Webhook'])
    if (runs.length !== 1) return false
    const owners = []
    for (const runReference of runs) {
      const runValue = flattedObject(table, runReference)
      const data = flattedObject(table, runValue.data)
      const main = flattedArray(table, data.main)
      for (const branchReference of main) {
        for (const itemReference of flattedArray(table, branchReference)) {
          const item = flattedObject(table, itemReference)
          const json = flattedObject(table, item.json)
          const body = flattedObject(table, json.body)
          const headers = flattedObject(table, json.headers)
          owners.push({
            taskId: flattedString(table, body.taskId),
            idempotencyKey: flattedString(table, body.idempotencyKey),
            headerIdempotencyKey: flattedString(table, headers['x-aiworker-idempotency-key']),
          })
        }
      }
    }
    return owners.length === 1 && owners[0].taskId === parentTaskId
      && owners[0].idempotencyKey === parentTaskId
      && owners[0].headerIdempotencyKey === parentTaskId
  } catch { return false }
}

function flattedReference(table, value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error('invalid flatted reference')
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index < 0 || index >= table.length) throw new Error('invalid flatted reference')
  return table[index]
}

function flattedObject(table, value) {
  const result = flattedReference(table, value)
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('invalid flatted object')
  return result
}

function flattedArray(table, value) {
  const result = flattedReference(table, value)
  if (!Array.isArray(result)) throw new Error('invalid flatted array')
  return result
}

function flattedString(table, value) {
  const result = flattedReference(table, value)
  if (typeof result !== 'string') throw new Error('invalid flatted string')
  return result
}

function assertWorkspaceUnreferenced(orphan) {
  const open = runStatus(command('LSOF', '/usr/sbin/lsof'), ['-nP', '+D', orphan.workspace, '-Fp'])
  if (open.error || open.signal || ![0, 1].includes(open.status)) fail('workspace open-file query failed')
  if (open.status === 0 && open.stdout.split('\n').some(line => /^p[1-9][0-9]*$/u.test(line))) {
    fail('a live process still has the orphan workspace open')
  }
  const inventory = run(command('PS', '/bin/ps'), ['-axo', 'pid=,ppid=,command='], 'process inventory')
  const digest = basename(orphan.workspace)
  if (inventory.split('\n').some(line => [orphan.child.taskId, orphan.parent.taskId, digest]
    .some(value => line.includes(value)))) fail('a live process command still references the orphan workspace')
}

async function queueState() {
  if (TEST_MODE && process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_QUEUE_FILE) {
    const value = JSON.parse(readFileSync(testPath('AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_QUEUE_FILE', ''), 'utf8'))
    return validateQueue(value)
  }
  let response
  try { response = await fetch('http://127.0.0.1:3017/api/n8n/runs?view=queue', { signal: AbortSignal.timeout(8_000), headers: { accept: 'application/json' } }) } catch { fail('persistent queue endpoint is unavailable') }
  if (!response.ok) fail(`persistent queue endpoint returned HTTP ${response.status}`)
  let value
  try { value = await response.json() } catch { fail('persistent queue endpoint is not JSON') }
  return validateQueue(value)
}

function validateQueue(value) {
  const waiting = Number(value?.counts?.waiting)
  const running = Number(value?.counts?.running)
  if (!Number.isSafeInteger(waiting) || waiting < 0 || !Number.isSafeInteger(running) || running < 0 || !Array.isArray(value?.queue)) fail('persistent queue shape is invalid')
  if (waiting !== 0 || running !== 0) fail('persistent queue is not idle')
  return { waiting, running, digest: sha256(canonicalJson(value.queue)) }
}

function protectedListeners() {
  const ports = [3017, 5678, 5679, 18091, 18789, 18889, 18989]
  return Object.fromEntries(ports.map(port => [String(port), listenerPid(port)]))
}

async function productionSnapshot(minimumAgeSeconds, phase) {
  const protectedPids = protectedListeners()
  const legacyPid = protectedPids['3017']
  const n8nPid = protectedPids['5678']
  const legacyRecords = openRecords(legacyPid)
  const n8nRecords = openRecords(n8nPid)
  const legacy = processIdentity(legacyPid, legacyRecords, 'legacy 3017')
  const n8n = processIdentity(n8nPid, n8nRecords, 'n8n')
  const mission = findDatabase(legacyRecords, /\/mission-control\.db$/u, 'Mission Control database')
  const n8nDatabase = findDatabase(n8nRecords, /\/database\.sqlite$/u, 'n8n database')
  const n8nLaunch = launchState(N8N_LABEL)
  if (!n8nLaunch.loaded || n8n.ppid !== n8nLaunch.pid) fail('n8n is not the direct child of its LaunchAgent')
  const orphan = locateOrphan(mission, n8nDatabase, minimumAgeSeconds)
  assertWorkspaceUnreferenced(orphan)
  const queue = await queueState()
  const batchRoot = testPath('AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_BATCH_ROOT', join(homedir(), 'ai-worker/state/video-autoworker/video-batches'))
  const plistPath = testPath('AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_PLIST', join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`))
  const lane = laneSnapshot(batchRoot, plistPath, phase)
  return { protectedPids, legacy, n8n, mission, n8nDatabase, orphan, queue, batchRoot, plistPath, lane }
}

async function captureSnapshot(minimumAgeSeconds, phase) {
  if (TEST_MODE && process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_SNAPSHOT_COMMAND) {
    const source = run(testPath('AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_SNAPSHOT_COMMAND', ''), [phase, String(minimumAgeSeconds)], 'test snapshot')
    let value
    try { value = JSON.parse(source) } catch { fail('test snapshot is not JSON') }
    if (process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_REAL_BATCH_PROJECTION === '1') {
      value.lane.projection = batchProjection(value.batchRoot, value.lane.lock.path)
    }
    validateSnapshotShape(value, phase)
    return value
  }
  return productionSnapshot(minimumAgeSeconds, phase)
}

function postCasDatabaseState(chain, missionIdentity, n8nIdentity) {
  const missionHandle = openBoundReadonlyDatabase(missionIdentity, 'Mission Control database')
  let n8nHandle
  try {
    n8nHandle = openBoundReadonlyDatabase(n8nIdentity, 'n8n database')
    const mission = missionHandle.db
    const n8n = n8nHandle.db
    quickCheck(mission, 'Mission Control database')
    quickCheck(n8n, 'n8n database')
    const before = chain.value.runtimeBefore.orphan
    const child = mission.prepare('SELECT * FROM n8n_task_runs WHERE id = ? AND task_id = ?')
      .get(before.child.id, before.child.taskId)
    let routing
    try { routing = JSON.parse(child?.routing) } catch { fail('reconciled media child routing is invalid') }
    if (!child || child.source !== 'n8n-media-node' || child.status !== 'failed'
      || child.error !== RECONCILED_ERROR || child.completed_at !== child.updated_at
      || !Number.isSafeInteger(child.updated_at) || child.updated_at <= before.child.updatedAt
      || routing?.mediaStage !== before.child.stage
      || child.task_id !== mediaChildTaskId(before.parent.taskId, before.child.stage)) {
      fail('reconciled media child does not match the controlled four-field CAS terminal state')
    }
    const parent = mission.prepare('SELECT * FROM n8n_task_runs WHERE id = ? AND task_id = ?')
      .get(before.parent.id, before.parent.taskId)
    if (!parent || parent.status !== before.parent.status
      || sha256(canonicalJson(parent)) !== before.parent.digest) {
      fail('media parent changed after the controlled CAS')
    }
    const mediaActive = Number(mission.prepare(
      "SELECT COUNT(*) count FROM n8n_task_runs WHERE source = 'n8n-media-node' AND status IN ('queued','accepted','running')",
    ).get().count)
    if (mediaActive !== 0) fail('Mission Control still has active media work after CAS')
    const leaseTable = mission.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='n8n_child_execution_leases'",
    ).get()
    if (leaseTable && mission.prepare('SELECT 1 FROM n8n_child_execution_leases WHERE task_id=?')
      .get(before.child.taskId)) fail('reconciled media child regained an execution lease')
    const executionRows = n8n.prepare(`
      SELECT e.id,e.status,e.stoppedAt,d.data
      FROM execution_entity e JOIN execution_data d ON d.executionId=e.id
      WHERE e.id=? AND e.workflowId='aiworker-video-analysis-v1'
    `).all(before.execution.id)
    if (executionRows.length !== 1) fail('terminal n8n execution is no longer unique')
    const execution = executionRows[0]
    if (execution.status !== before.execution.status || execution.stoppedAt === null
      || sha256(execution.data) !== before.execution.digest
      || !executionOwnsParent(execution.data, before.parent.taskId)) {
      fail('terminal n8n execution changed after the controlled CAS')
    }
    const n8nActive = Number(n8n.prepare(
      "SELECT COUNT(*) count FROM execution_entity WHERE status IN ('new','running','waiting') AND stoppedAt IS NULL",
    ).get().count)
    if (n8nActive !== 0) fail('n8n regained an active execution after CAS')
    revalidateDatabaseConnection(missionHandle, 'Mission Control database')
    revalidateDatabaseConnection(n8nHandle, 'n8n database')
    return {
      child: {
        id: child.id,
        taskId: child.task_id,
        source: child.source,
        stage: before.child.stage,
        status: child.status,
        error: child.error,
        completedAt: child.completed_at,
        updatedAt: child.updated_at,
      },
      parent: before.parent,
      execution: before.execution,
      mediaActive,
      n8nActive,
    }
  } finally {
    if (n8nHandle) closeBoundReadonlyDatabase(n8nHandle, 'n8n database')
    closeBoundReadonlyDatabase(missionHandle, 'Mission Control database')
  }
}

function finalReadinessVerifierPath() {
  if (TEST_MODE && process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_FINAL_READINESS_VERIFIER) {
    return testPath('AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_FINAL_READINESS_VERIFIER', '')
  }
  const pathname = FINAL_READINESS_VERIFIER
  const entry = safeEntry(pathname, 'managed final-readiness verifier', 'file')
  if (entry.size > BigInt(MAX_JSON_BYTES)) fail('managed final-readiness verifier is too large')
  return pathname
}

function verifyFinalReadiness(finalReadinessPath, preparedReceiptPath) {
  const loaded = readImmutableJson(finalReadinessPath, 'final-readiness report')
  if (loaded.value?.schema !== FINAL_READINESS_SCHEMA) fail('final-readiness report schema is invalid')
  const verifier = finalReadinessVerifierPath()
  const args = [
    'verify-live', '--report', finalReadinessPath, '--prepared-receipt', preparedReceiptPath,
  ]
  const source = verifier === FINAL_READINESS_VERIFIER
    ? run(process.execPath, [verifier, ...args], 'managed final-readiness verification')
    : run(verifier, args, 'test final-readiness verification')
  let result
  try { result = JSON.parse(source) } catch { fail('final-readiness verification result is not JSON') }
  const reference = result?.report
  const expectedSize = Buffer.byteLength(loaded.source)
  if (result?.schema !== FINAL_READINESS_VERIFY_SCHEMA || result.ok !== true
    || !reference || reference.path !== loaded.identity.path
    || reference.dev !== loaded.identity.dev || reference.ino !== loaded.identity.ino
    || reference.uid !== loaded.identity.uid || reference.mode !== loaded.identity.mode
    || reference.nlink !== 1 || reference.size !== expectedSize
    || reference.sha256 !== loaded.sha256 || !SHA256.test(result.snapshotSha256 || '')
    || !result.snapshot || sha256(canonicalJson(result.snapshot)) !== result.snapshotSha256) {
    fail('final-readiness verification result contract is invalid')
  }
  const current = readImmutableJson(finalReadinessPath, 'final-readiness report')
  if (current.sha256 !== loaded.sha256 || !sameIdentity(current.identity, loaded.identity)) {
    fail('final-readiness report changed during live verification')
  }
  return {
    report: {
      path: loaded.identity.path,
      dev: loaded.identity.dev,
      ino: loaded.identity.ino,
      uid: loaded.identity.uid,
      mode: loaded.identity.mode,
      size: expectedSize,
      sha256: loaded.sha256,
    },
    snapshotSha256: result.snapshotSha256,
  }
}

function retireInvariantProjection(snapshot) {
  return {
    finalReadiness: snapshot.finalReadiness,
    unchangedPids: snapshot.unchangedPids,
    mission: snapshot.mission,
    n8nDatabase: snapshot.n8nDatabase,
    queue: snapshot.queue,
    batchRoot: snapshot.batchRoot,
    plistPath: snapshot.plistPath,
    lane: {
      plist: snapshot.lane?.plist,
      projection: snapshot.lane?.projection,
    },
    postCas: snapshot.postCas,
  }
}

function unchangedProtectedPids(before, current) {
  if (!before || !current || typeof before !== 'object' || typeof current !== 'object') {
    fail('post-CAS protected listener set is invalid')
  }
  const values = {}
  for (const port of ['18091', '18789', '18989']) {
    const pid = current[port]
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid !== before[port]) {
      fail(`post-CAS protected listener identity changed on port ${port}`)
    }
    values[port] = pid
  }
  return values
}

function validateRetireSnapshot(chain, snapshot, phase) {
  const before = chain.value.runtimeBefore
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.lane || !snapshot.postCas
    || !snapshot.finalReadiness
    || snapshot.batchRoot !== before.batchRoot || snapshot.plistPath !== before.plistPath
    || snapshot.queue?.waiting !== 0 || snapshot.queue?.running !== 0) {
    fail('post-CAS runtime snapshot contract is invalid')
  }
  assertStable(
    unchangedProtectedPids(before.protectedPids, snapshot.protectedPids),
    snapshot.unchangedPids,
    'post-CAS unchanged listener identities',
  )
  assertStable(before.mission, snapshot.mission, 'post-CAS Mission Control database identity')
  assertStable(before.n8nDatabase, snapshot.n8nDatabase, 'post-CAS n8n database identity')
  if (snapshot.lane.projection?.runnable !== 0 || snapshot.lane.projection?.journals !== 0) {
    fail('post-CAS video batch projection is not idle')
  }
  const postCas = snapshot.postCas
  const orphan = before.orphan
  if (postCas.mediaActive !== 0 || postCas.n8nActive !== 0
    || postCas.child?.id !== orphan.child.id || postCas.child.taskId !== orphan.child.taskId
    || postCas.child.source !== 'n8n-media-node' || postCas.child.stage !== orphan.child.stage
    || postCas.child.status !== 'failed' || postCas.child.error !== RECONCILED_ERROR
    || postCas.child.completedAt !== postCas.child.updatedAt
    || !Number.isSafeInteger(postCas.child.updatedAt)
    || postCas.child.updatedAt <= orphan.child.updatedAt
    || canonicalJson(postCas.parent) !== canonicalJson(orphan.parent)
    || canonicalJson(postCas.execution) !== canonicalJson(orphan.execution)) {
    fail('post-CAS terminal evidence does not match the prepared orphan identity')
  }
  const lane = snapshot.lane
  if (phase === 'quiesced') {
    if (lane.service?.loaded || !lane.disabled || lane.workers?.length !== 0 || lane.lock?.present) {
      fail('post-CAS video lane is not disabled, unloaded, worker-free, and lock-free')
    }
  } else if (!lane.service?.loaded || lane.disabled || lane.workers?.length !== 1
    || lane.service.pid !== lane.workers[0] || lane.worker?.pid !== lane.workers[0]
    || !lane.lock?.present || lane.lock.ownerPid !== lane.workers[0]) {
    fail('retired video lane is not owned by one LaunchAgent worker and its global lock')
  }
  return snapshot
}

async function productionRetireSnapshot(chain, phase, finalReadiness, finalReadinessPath) {
  const before = chain.value.runtimeBefore
  const protectedPids = protectedListeners()
  const mission = before.mission || before.legacy?.database
  const n8nDatabase = before.n8nDatabase || before.n8n?.database
  const postCas = postCasDatabaseState(chain, mission, n8nDatabase)
  const queue = await queueState()
  const lane = laneSnapshot(before.batchRoot, before.plistPath, phase, phase === 'active' ? {
    workerPid: null,
    finalReadinessPath,
  } : null)
  const snapshot = {
    protectedPids,
    unchangedPids: unchangedProtectedPids(before.protectedPids, protectedPids),
    finalReadiness,
    mission,
    n8nDatabase,
    queue,
    batchRoot: before.batchRoot,
    plistPath: before.plistPath,
    lane,
    postCas,
  }
  return validateRetireSnapshot(chain, snapshot, phase)
}

async function captureRetireSnapshot(chain, phase, finalReadinessPath) {
  const finalReadiness = verifyFinalReadiness(finalReadinessPath, chain.loaded.identity.path)
  if (TEST_MODE && process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_RETIRE_SNAPSHOT_COMMAND) {
    const source = run(
      testPath('AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_RETIRE_SNAPSHOT_COMMAND', ''),
      [phase],
      'test post-CAS snapshot',
    )
    let snapshot
    try { snapshot = JSON.parse(source) } catch { fail('test post-CAS snapshot is not JSON') }
    if (process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_REAL_BATCH_PROJECTION === '1') {
      snapshot.lane.projection = batchProjection(
        snapshot.batchRoot,
        snapshot.lane.lock.path,
        phase === 'active' ? {
          workerPid: snapshot.lane.workers?.[0],
          finalReadinessPath,
        } : null,
      )
    }
    snapshot.finalReadiness = finalReadiness
    snapshot.unchangedPids = unchangedProtectedPids(
      chain.value.runtimeBefore.protectedPids,
      snapshot.protectedPids,
    )
    return validateRetireSnapshot(chain, snapshot, phase)
  }
  return productionRetireSnapshot(chain, phase, finalReadiness, finalReadinessPath)
}

async function waitForRetireSnapshot(chain, phase, finalReadinessPath, expected = null) {
  let lastError
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    try {
      const snapshot = await captureRetireSnapshot(chain, phase, finalReadinessPath)
      if (expected) assertStable(expected, retireInvariantProjection(snapshot), 'post-CAS retire evidence')
      return snapshot
    } catch (error) { lastError = error }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_MILLISECONDS)
  }
  throw lastError || new Error('post-CAS snapshot wait failed')
}

function validateSnapshotShape(value, phase) {
  if (!value || typeof value !== 'object' || !value.orphan?.workspace || !value.lane || !value.protectedPids
    || value.queue?.waiting !== 0 || value.queue?.running !== 0) fail('snapshot contract is invalid')
  normalizedAbsolute(value.orphan.workspace, 'snapshot workspace')
  if (phase === 'active') {
    if (!value.lane.service?.loaded || value.lane.disabled || value.lane.workers?.length !== 1 || !value.lane.lock?.present
      || value.lane.projection?.runnable !== 0 || value.lane.projection?.journals !== 0) fail('active snapshot lane is invalid')
  } else if (value.lane.service?.loaded || !value.lane.disabled || value.lane.workers?.length !== 0
    || (phase === 'stopped' ? !value.lane.lock?.present : value.lane.lock?.present)) {
    fail(`${phase} snapshot lane is invalid`)
  }
  if ((phase === 'active' || phase === 'stopped') && (
    !value.lane.lock?.path || !value.lane.lock?.dev || !value.lane.lock?.ino
    || !Number.isSafeInteger(value.lane.lock?.uid) || value.lane.lock?.mode !== 0o600
    || !Number.isSafeInteger(value.lane.lock?.bytes) || value.lane.lock.bytes <= 0
    || !SHA256.test(value.lane.lock?.contentSha256) || !Number.isSafeInteger(value.lane.lock?.ownerPid)
    || value.lane.lock.ownerPid <= 0 || !SHA256.test(value.lane.lock?.tokenSha256)
    || !Number.isFinite(Date.parse(value.lane.lock?.createdAt))
  )) fail(`${phase} snapshot lock identity is invalid`)
  if (phase === 'active' && value.lane.worker?.pid !== value.lane.lock.ownerPid) {
    fail('active snapshot worker and lock owner differ')
  }
}

function stableComparable(snapshot) {
  const clone = structuredClone(snapshot)
  clone.lane = {
    plist: clone.lane?.plist,
    projection: clone.lane?.projection,
  }
  return clone
}

function assertStable(before, after, label) {
  if (canonicalJson(before) !== canonicalJson(after)) fail(`${label} changed between samples`)
}

function action(args, label) {
  run(command('LAUNCHCTL', '/bin/launchctl'), args, label)
}

async function waitForSnapshot(minimumAgeSeconds, phase) {
  let lastError
  for (let attempt = 0; attempt < WAIT_ATTEMPTS; attempt += 1) {
    try { return await captureSnapshot(minimumAgeSeconds, phase) } catch (error) { lastError = error }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, WAIT_MILLISECONDS)
  }
  throw lastError || new Error('snapshot wait failed')
}

function disableAndStop(plistPath) {
  const domain = `gui/${process.getuid()}`
  action(['disable', `${domain}/${LABEL}`], 'video-lane disable')
  action(['bootout', domain, plistPath], 'video-lane bootout')
}

function pidExists(pid, label) {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail(`${label} identity is invalid`)
  const result = runStatus(command('PS', '/bin/ps'), ['-p', String(pid), '-o', 'pid='])
  if (result.error || result.signal || ![0, 1].includes(result.status)) fail(`${label} PID query failed`)
  return result.status === 0 || Boolean(result.stdout.trim())
}

function assertOldWorkerGone(worker) {
  if (!worker || !Number.isSafeInteger(worker.pid) || worker.pid <= 0) fail('captured video worker identity is invalid')
  if (pidExists(worker.pid, 'old video worker')) fail('old video worker PID still exists or was reused')
}

function assertLockUnopened(pathname) {
  const result = runStatus(command('LSOF', '/usr/sbin/lsof'), ['-nP', '-Fp', '--', pathname])
  if (result.error || result.signal || ![0, 1].includes(result.status)) fail('dead-owner lock open-file query failed')
  if (result.status === 0 && result.stdout.split('\n').some(line => /^p[1-9][0-9]*$/u.test(line))) {
    fail('a process still has the dead-owner lock open')
  }
}

function comparableLock(value) {
  return {
    present: value.present,
    path: value.path,
    dev: value.dev,
    ino: value.ino,
    uid: value.uid,
    mode: value.mode,
    bytes: value.bytes,
    contentSha256: value.contentSha256,
    ownerPid: value.ownerPid,
    tokenSha256: value.tokenSha256,
    createdAt: value.createdAt,
  }
}

function quarantineDeadLock(activeLock, stoppedLock, attemptDirectory) {
  if (canonicalJson(comparableLock(activeLock)) !== canonicalJson(comparableLock(stoppedLock))) {
    fail('dead-owner lock drifted after video worker exit')
  }
  assertOldWorkerGone({ pid: activeLock.ownerPid })
  assertLockUnopened(activeLock.path)
  const current = lockState(dirname(activeLock.path), activeLock.ownerPid)
  if (canonicalJson(comparableLock(activeLock)) !== canonicalJson(comparableLock(current))) {
    fail('dead-owner lock drifted immediately before quarantine')
  }
  const target = join(attemptDirectory, 'dead-video-worker.lock')
  assertNoSymlink(target, 'dead-owner lock evidence', true)
  if (optionalEntry(target)) fail('dead-owner lock evidence already exists')
  const attempt = identity(attemptDirectory, 'attempt directory', 'directory', 0o700)
  if (attempt.dev !== activeLock.dev) fail('dead-owner lock evidence is not on the lock device')
  recordTestEvent('rename:dead-lock-to-evidence')
  renameSync(activeLock.path, target)
  const moved = identity(target, 'dead-owner lock evidence', 'file', 0o600)
  if (optionalEntry(activeLock.path) || moved.dev !== activeLock.dev || moved.ino !== activeLock.ino) {
    fail('dead-owner lock quarantine identity verification failed')
  }
  const source = readFileSync(target, 'utf8')
  if (Buffer.byteLength(source) !== activeLock.bytes || sha256(source) !== activeLock.contentSha256) {
    fail('dead-owner lock evidence content changed across quarantine')
  }
  chmodSync(target, 0o400)
  fsyncFile(target)
  const evidence = identity(target, 'dead-owner lock evidence', 'file', 0o400)
  fsyncDirectory(attemptDirectory)
  fsyncDirectory(dirname(activeLock.path))
  return {
    original: comparableLock(activeLock),
    evidence: {
      ...evidence,
      bytes: activeLock.bytes,
      contentSha256: activeLock.contentSha256,
      ownerPid: activeLock.ownerPid,
      tokenSha256: activeLock.tokenSha256,
      createdAt: activeLock.createdAt,
    },
  }
}

function launchGuardianPath(batchRoot) {
  return join(batchRoot, '.worker-launch.lock')
}

function launchGuardianOwnerPath(batchRoot) {
  return join(batchRoot, '.worker-launch.lock.owner')
}

function launchGuardianPendingOwnerPath(transactionRoot) {
  return join(transactionRoot, '.worker-launch.lock.owner.pending')
}

function guardianPayload(token, createdAt) {
  // The marker body is a permanent identity record. Liveness is represented
  // only by its monotonically increasing mtime and the separately replaceable
  // owner record, so refresh and takeover never truncate this unique inode.
  return `${canonicalJson({ schema: GUARDIAN_SCHEMA, pid: process.pid, createdAt, token })}\n`
}

function readSmallFileDescriptor(descriptor, size, label) {
  if (size <= 0n || size > BigInt(MAX_JSON_BYTES)) fail(`${label} size is invalid`)
  const buffer = Buffer.alloc(Number(size))
  let offset = 0
  while (offset < buffer.length) {
    const count = readFileChunk(descriptor, buffer.subarray(offset), offset)
    if (count <= 0) fail(`${label} changed during read`)
    offset += count
  }
  return buffer.toString('utf8')
}

function readGuardianRecord(pathname, label, requiredMode = 0o600) {
  const entry = safeEntry(pathname, label, 'file', requiredMode)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      fail(`${label} changed before read`)
    }
    const source = readSmallFileDescriptor(descriptor, opened.size, label)
    const after = fstatSync(descriptor, { bigint: true })
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      fail(`${label} changed during read`)
    }
    let value
    try { value = JSON.parse(source) } catch { fail(`${label} is invalid JSON`) }
    return {
      value,
      source,
      sha256: sha256(source),
      identity: identity(pathname, label, 'file', requiredMode),
      mtimeNs: after.mtimeNs,
    }
  } finally { closeSync(descriptor) }
}

function ownerRecordValue(marker, tokenSha256, createdAt) {
  return {
    schema: GUARDIAN_OWNER_SCHEMA,
    pid: process.pid,
    createdAt: new Date().toISOString(),
    marker: {
      path: marker.path,
      dev: marker.dev,
      ino: marker.ino,
      tokenSha256,
      createdAt,
      sourceSha256: marker.sourceSha256,
    },
  }
}

function validateGuardianOwner(loaded, marker, tokenSha256, createdAt) {
  const value = loaded.value
  if (value?.schema !== GUARDIAN_OWNER_SCHEMA || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !Number.isFinite(Date.parse(value.createdAt)) || value.marker?.path !== marker.path
    || value.marker.dev !== marker.dev || value.marker.ino !== marker.ino
    || value.marker.tokenSha256 !== tokenSha256 || value.marker.createdAt !== createdAt
    || value.marker.sourceSha256 !== marker.sourceSha256) {
    fail('video worker launch guardian owner record is invalid')
  }
  return loaded
}

function sameRecord(left, right) {
  return sameIdentity(left.identity, right.identity) && left.sha256 === right.sha256
}

function ownerMarker(value) {
  return {
    path: value.marker.path,
    dev: value.marker.dev,
    ino: value.marker.ino,
    sourceSha256: value.marker.sourceSha256,
  }
}

function removeDeadPendingGuardianOwner(transactionRoot, marker, tokenSha256, createdAt) {
  const pathname = launchGuardianPendingOwnerPath(transactionRoot)
  if (!optionalEntry(pathname)) return
  const pending = validateGuardianOwner(
    readGuardianRecord(pathname, 'pending video worker launch guardian owner record'),
    marker, tokenSha256, createdAt,
  )
  if (pidExists(pending.value.pid, 'pending guardian owner')) {
    fail('pending video worker launch guardian owner is still live')
  }
  const current = validateGuardianOwner(
    readGuardianRecord(pathname, 'pending video worker launch guardian owner record'),
    marker, tokenSha256, createdAt,
  )
  if (!sameRecord(current, pending)) fail('pending video worker launch guardian owner changed before cleanup')
  unlinkSync(pathname)
  fsyncDirectory(transactionRoot)
}

function publishGuardianOwner(batchRoot, transactionRoot, marker, tokenSha256, createdAt, expected = null) {
  const pathname = launchGuardianOwnerPath(batchRoot)
  const temporary = launchGuardianPendingOwnerPath(transactionRoot)
  assertNoSymlink(pathname, 'video worker launch guardian owner record', true)
  assertNoSymlink(temporary, 'pending video worker launch guardian owner record', true)
  const transaction = identity(transactionRoot, 'guardian owner transaction root', 'directory', 0o700)
  const parent = identity(batchRoot, 'video batch root', 'directory', 0o700)
  if (transaction.dev !== parent.dev) fail('guardian owner transaction root is not on the marker device')
  removeDeadPendingGuardianOwner(transactionRoot, marker, tokenSha256, createdAt)
  const existing = optionalEntry(pathname)
  if (expected) {
    if (!existing) fail('video worker launch guardian owner record disappeared before takeover')
    const current = validateGuardianOwner(
      readGuardianRecord(pathname, 'video worker launch guardian owner record'),
      marker, tokenSha256, createdAt,
    )
    if (!sameRecord(current, expected)) fail('video worker launch guardian owner record changed before takeover')
  } else if (existing) {
    fail('video worker launch guardian owner record already exists')
  }
  const value = ownerRecordValue(marker, tokenSha256, createdAt)
  const source = `${canonicalJson(value)}\n`
  let descriptor
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    writeFileSync(descriptor, source)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    fsyncFile(temporary)
    fsyncDirectory(transaction.path)
    testKillAfter('OWNER_TEMP_BEFORE_RENAME')
    if (expected) {
      const current = validateGuardianOwner(
        readGuardianRecord(pathname, 'video worker launch guardian owner record'),
        marker, tokenSha256, createdAt,
      )
      if (!sameRecord(current, expected)) fail('video worker launch guardian owner record changed before publish')
    } else if (optionalEntry(pathname)) {
      fail('video worker launch guardian owner record appeared before publish')
    }
    renameSync(temporary, pathname)
    fsyncFile(pathname)
    fsyncDirectory(transaction.path)
    fsyncDirectory(parent.path)
    testKillAfter('OWNER_TEMP_AFTER_RENAME')
    const written = validateGuardianOwner(
      readGuardianRecord(pathname, 'video worker launch guardian owner record'),
      marker, tokenSha256, createdAt,
    )
    if (written.source !== source) fail('video worker launch guardian owner record verification failed')
    return written
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    // Leave any partially published candidate inside the private attempt.
    // A later retry removes it only after full schema/identity/PID validation;
    // never unlink a pathname that may have been replaced after an error.
    throw error
  }
}

function removeGuardianOwner(batchRoot, expected, marker, tokenSha256, createdAt) {
  const pathname = launchGuardianOwnerPath(batchRoot)
  const current = validateGuardianOwner(
    readGuardianRecord(pathname, 'video worker launch guardian owner record'),
    marker, tokenSha256, createdAt,
  )
  if (!sameRecord(current, expected)) fail('video worker launch guardian owner record changed before release')
  unlinkSync(pathname)
  fsyncDirectory(batchRoot)
}

function removeDetachedGuardianOwner(batchRoot, plan) {
  const markerPath = launchGuardianPath(batchRoot)
  if (optionalEntry(markerPath)) fail('detached guardian owner cleanup found a live marker path')
  const pathname = launchGuardianOwnerPath(batchRoot)
  const loaded = readGuardianRecord(pathname, 'detached video worker launch guardian owner record')
  const marker = ownerMarker(loaded.value)
  const tokenSha256 = sha256(String(plan.token || ''))
  validateGuardianOwner(loaded, marker, tokenSha256, plan.createdAt)
  if (marker.path !== markerPath
    || (plan.dev !== undefined && marker.dev !== plan.dev)
    || (plan.ino !== undefined && marker.ino !== plan.ino)
    || (plan.sourceSha256 !== undefined && marker.sourceSha256 !== plan.sourceSha256)
    || pidExists(loaded.value.pid, 'detached guardian owner')) {
    fail('detached video worker launch guardian owner cannot be safely removed')
  }
  const current = validateGuardianOwner(
    readGuardianRecord(pathname, 'detached video worker launch guardian owner record'),
    marker, tokenSha256, plan.createdAt,
  )
  if (!sameRecord(current, loaded)) fail('detached video worker launch guardian owner changed before cleanup')
  unlinkSync(pathname)
  fsyncDirectory(batchRoot)
}

function openLaunchGuardian(batchRoot, transactionRoot, plan, takeover = false) {
  const pathname = launchGuardianPath(batchRoot)
  let takeoverMode = takeover
  let effectivePlan = plan
  if (!takeoverMode && optionalEntry(pathname)) {
    const abandoned = readGuardianRecord(pathname, 'abandoned video worker launch guardian')
    const value = abandoned.value
    if (value?.schema !== GUARDIAN_SCHEMA || !/^[a-f0-9]{64}$/u.test(String(value.token || ''))
      || !Number.isSafeInteger(value.pid) || value.pid <= 0
      || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
      fail('existing video worker launch guardian cannot be adopted')
    }
    if (pidExists(value.pid, 'abandoned guardian marker owner')) {
      fail('existing video worker launch guardian creator is still live')
    }
    effectivePlan = {
      path: pathname,
      dev: abandoned.identity.dev,
      ino: abandoned.identity.ino,
      uid: abandoned.identity.uid,
      mode: abandoned.identity.mode,
      token: value.token,
      tokenSha256: sha256(value.token),
      createdAt: value.createdAt,
      sourceSha256: abandoned.sha256,
      markerPid: value.pid,
    }
    takeoverMode = true
  }
  const createdAt = effectivePlan.createdAt
  if (typeof effectivePlan?.token !== 'string' || !/^[a-f0-9]{64}$/u.test(effectivePlan.token)
    || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    fail('video worker launch guardian plan is invalid')
  }
  if (takeoverMode && (effectivePlan.path !== pathname
    || (effectivePlan.uid !== undefined && effectivePlan.uid !== process.getuid())
    || (effectivePlan.mode !== undefined && effectivePlan.mode !== 0o600)
    || (effectivePlan.tokenSha256 !== undefined
      && effectivePlan.tokenSha256 !== sha256(effectivePlan.token)))) {
    fail('video worker launch guardian takeover plan is invalid')
  }
  let descriptor
  let immutableSource
  let markerValue
  let previousOwner = null
  if (takeoverMode) {
    const entry = safeEntry(pathname, 'video worker launch guardian', 'file', 0o600)
    descriptor = openSync(pathname, constants.O_RDWR | constants.O_NOFOLLOW)
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino) {
      closeSync(descriptor)
      fail('video worker launch guardian changed before takeover')
    }
    immutableSource = readSmallFileDescriptor(descriptor, opened.size, 'video worker launch guardian')
    try { markerValue = JSON.parse(immutableSource) } catch { fail('video worker launch guardian is invalid JSON') }
    if ((effectivePlan.dev !== undefined && entry.dev.toString() !== effectivePlan.dev)
      || (effectivePlan.ino !== undefined && entry.ino.toString() !== effectivePlan.ino)
      || sha256(String(markerValue?.token || '')) !== sha256(effectivePlan.token)
      || markerValue?.createdAt !== effectivePlan.createdAt
      || !Number.isSafeInteger(markerValue?.pid) || markerValue.pid <= 0
      || ![undefined, GUARDIAN_SCHEMA].includes(markerValue.schema)) {
      closeSync(descriptor)
      fail('video worker launch guardian cannot be taken over')
    }
    const preliminaryMarker = {
      path: pathname,
      dev: entry.dev.toString(),
      ino: entry.ino.toString(),
      sourceSha256: sha256(immutableSource),
    }
    const ownerPath = launchGuardianOwnerPath(batchRoot)
    if (optionalEntry(ownerPath)) {
      previousOwner = validateGuardianOwner(
        readGuardianRecord(ownerPath, 'video worker launch guardian owner record'),
        preliminaryMarker, sha256(effectivePlan.token), createdAt,
      )
    }
    const previousPid = previousOwner?.value?.pid || markerValue.pid
    const old = runStatus(command('PS', '/bin/ps'), ['-p', String(previousPid), '-o', 'pid='])
    if (old.error || old.signal || ![0, 1].includes(old.status) || old.status === 0 || old.stdout.trim()) {
      closeSync(descriptor)
      fail('previous video worker launch guardian PID still exists or was reused')
    }
  } else {
    if (optionalEntry(pathname)) fail('video worker launch lock already exists')
    if (optionalEntry(launchGuardianOwnerPath(batchRoot))) fail('video worker launch guardian owner record already exists')
    descriptor = openSync(pathname, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    immutableSource = guardianPayload(effectivePlan.token, createdAt)
    writeFileSync(descriptor, immutableSource)
    fsyncSync(descriptor)
    markerValue = JSON.parse(immutableSource)
  }
  recordTestEvent(takeoverMode ? 'guardian:takeover' : 'guardian:create')
  const token = effectivePlan.token
  const opened = fstatSync(descriptor, { bigint: true })
  const identityValue = {
    path: pathname,
    dev: opened.dev.toString(),
    ino: opened.ino.toString(),
    uid: Number(opened.uid),
    mode: Number(opened.mode & 0o7777n),
  }
  if (identityValue.uid !== process.getuid() || identityValue.mode !== 0o600) fail('video worker launch guardian identity is unsafe')
  if (takeoverMode && ((effectivePlan.dev !== undefined && identityValue.dev !== effectivePlan.dev)
    || (effectivePlan.ino !== undefined && identityValue.ino !== effectivePlan.ino))) {
    fail('video worker launch guardian takeover identity changed')
  }
  const marker = {
    ...identityValue,
    sourceSha256: sha256(immutableSource),
    markerPid: markerValue.pid,
  }
  if (effectivePlan.sourceSha256 !== undefined
    && effectivePlan.sourceSha256 !== marker.sourceSha256) {
    fail('video worker launch guardian body changed before takeover')
  }
  const owner = publishGuardianOwner(
    batchRoot, transactionRoot, marker, sha256(token), createdAt, previousOwner,
  )
  if (!takeoverMode) fsyncDirectory(batchRoot)
  const verifyOwner = () => {
    const current = validateGuardianOwner(
      readGuardianRecord(launchGuardianOwnerPath(batchRoot), 'video worker launch guardian owner record'),
      marker, sha256(token), createdAt,
    )
    if (!sameRecord(current, owner)) fail('video worker launch guardian owner record changed')
  }
  const refresh = () => {
    const before = fstatSync(descriptor, { bigint: true })
    const current = optionalEntry(pathname)
    if (!current || current.dev !== before.dev || current.ino !== before.ino
      || before.dev.toString() !== marker.dev || before.ino.toString() !== marker.ino
      || readSmallFileDescriptor(descriptor, before.size, 'video worker launch guardian') !== immutableSource) {
      fail('video worker launch guardian path or body changed before refresh')
    }
    verifyOwner()
    const nextMtimeMilliseconds = Math.max(
      Date.now(), Number(before.mtimeNs / 1_000_000n) + 1,
    )
    futimesSync(
      descriptor,
      Number(before.atimeNs) / 1_000_000_000,
      nextMtimeMilliseconds / 1_000,
    )
    fsyncSync(descriptor)
    const after = fstatSync(descriptor, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs <= before.mtimeNs
      || readSmallFileDescriptor(descriptor, after.size, 'video worker launch guardian') !== immutableSource) {
      fail('video worker launch guardian mtime refresh was not durable and monotonic')
    }
    verifyOwner()
    recordTestEvent('guardian:refresh')
    return after.mtimeNs
  }
  refresh()
  const timer = setInterval(() => {
    try { refresh() } catch { /* The foreground verifier will fail closed. */ }
  }, GUARDIAN_REFRESH_MILLISECONDS)
  timer.unref()
  let released = false
  const verify = () => {
    if (released) fail('video worker launch guardian was already released')
    refresh()
    const current = identity(pathname, 'video worker launch guardian', 'file', 0o600)
    if (!sameIdentity(current, identityValue)) fail('video worker launch guardian identity drifted')
  }
  const handoff = () => {
    if (released) fail('video worker launch guardian was already released')
    clearInterval(timer)
    verify()
    closeSync(descriptor)
    released = true
    recordTestEvent('guardian:handoff')
    let cleaned = false
    return () => {
      if (cleaned) return
      if (optionalEntry(pathname)) fail('video worker did not consume the launch handoff marker')
      removeGuardianOwner(batchRoot, owner, marker, sha256(token), createdAt)
      if (optionalEntry(launchGuardianOwnerPath(batchRoot))) {
        fail('video worker launch guardian owner record remains after handoff cleanup')
      }
      cleaned = true
      recordTestEvent('guardian:handoff-cleanup')
    }
  }
  return {
    ...identityValue,
    tokenSha256: sha256(token),
    token,
    createdAt,
    sourceSha256: marker.sourceSha256,
    markerPid: marker.markerPid,
    verify,
    hold() {
      verify()
      return new Promise((resolvePromise, rejectPromise) => {
        const cleanup = () => {
          clearInterval(monitor)
          process.off('SIGUSR2', onHandoff)
        }
        const onHandoff = () => {
          try {
            handoff()
            cleanup()
            resolvePromise()
          } catch (error) {
            cleanup()
            rejectPromise(error)
          }
        }
        const monitor = setInterval(() => {
          try { verify() } catch (error) {
            cleanup()
            rejectPromise(error)
          }
        }, GUARDIAN_REFRESH_MILLISECONDS)
        process.once('SIGUSR2', onHandoff)
        // This timer deliberately remains referenced: it is the live safety
        // barrier preventing submit-task from expiring and replacing the lock.
      })
    },
    handoff,
    release() {
      if (released) return
      clearInterval(timer)
      refresh()
      const current = identity(pathname, 'video worker launch guardian', 'file', 0o600)
      const source = readFileSync(pathname, 'utf8')
      let value
      try { value = JSON.parse(source) } catch { fail('video worker launch guardian is invalid at release') }
      if (!sameIdentity(current, identityValue) || sha256(String(value.token || '')) !== sha256(token)) {
        fail('video worker launch guardian ownership changed before release')
      }
      verifyOwner()
      if (TEST_MODE
        && process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_OWNER_REMOVED_BEFORE_MARKER_UNLINK === '1') {
        // Exercise recovery from the predecessor's unsafe deletion order. The
        // production path below is marker-first and cannot create this state.
        removeGuardianOwner(batchRoot, owner, marker, sha256(token), createdAt)
        process.kill(process.pid, 'SIGKILL')
      }
      unlinkSync(pathname)
      fsyncDirectory(batchRoot)
      testKillAfter('MARKER_REMOVED_BEFORE_OWNER_CLEANUP')
      removeGuardianOwner(batchRoot, owner, marker, sha256(token), createdAt)
      recordTestEvent('guardian:release')
      closeSync(descriptor)
      released = true
    },
  }
}

function validateLockEvidence(value, attemptDirectory, allowReplacementLock = false) {
  if (!value?.original || !value?.evidence
    || value.evidence.path !== join(attemptDirectory, 'dead-video-worker.lock')) {
    fail('dead-owner lock evidence contract is invalid')
  }
  const current = identity(value.evidence.path, 'dead-owner lock evidence', 'file', 0o400)
  const replacement = optionalEntry(value.original.path)
  if (!sameIdentity(current, value.evidence) || current.dev !== value.original.dev
    || current.ino !== value.original.ino
    || (replacement && (!allowReplacementLock
      || (replacement.dev.toString() === value.original.dev && replacement.ino.toString() === value.original.ino)))) {
    fail('dead-owner lock evidence identity changed')
  }
  if (replacement && allowReplacementLock) lockState(dirname(value.original.path))
  const source = readFileSync(current.path, 'utf8')
  if (Buffer.byteLength(source) !== value.evidence.bytes
    || sha256(source) !== value.evidence.contentSha256
    || value.evidence.contentSha256 !== value.original.contentSha256
    || value.evidence.tokenSha256 !== value.original.tokenSha256
    || value.evidence.ownerPid !== value.original.ownerPid) {
    fail('dead-owner lock evidence content changed')
  }
  return current
}

function recoverLockEvidence(intentValue, attemptDirectory, required) {
  const original = intentValue.runtime?.lane?.lock
  if (!original?.present) fail('intent does not bind the original video-lane lock')
  const evidencePath = join(attemptDirectory, 'dead-video-worker.lock')
  const evidenceEntry = optionalEntry(evidencePath)
  const originalEntry = optionalEntry(original.path)
  if (!evidenceEntry) {
    if (required || !originalEntry) fail('dead-owner lock evidence is missing')
    const current = lockState(dirname(original.path), original.ownerPid)
    if (canonicalJson(comparableLock(current)) !== canonicalJson(comparableLock(original))) {
      fail('original dead-owner lock drifted before recovery')
    }
    return null
  }
  if (originalEntry) fail('both original and quarantined dead-owner locks exist')
  const evidence = identity(evidencePath, 'dead-owner lock evidence', 'file', 0o400)
  const source = readFileSync(evidencePath, 'utf8')
  const recovered = {
    original: comparableLock(original),
    evidence: {
      ...evidence,
      bytes: Buffer.byteLength(source),
      contentSha256: sha256(source),
      ownerPid: original.ownerPid,
      tokenSha256: original.tokenSha256,
      createdAt: original.createdAt,
    },
  }
  validateLockEvidence(recovered, attemptDirectory)
  return recovered
}

async function enableAndStart(minimumAgeSeconds, before, handoffCleanup = null) {
  const domain = `gui/${process.getuid()}`
  action(['enable', `${domain}/${LABEL}`], 'video-lane enable')
  if (!launchState().loaded) action(['bootstrap', domain, before.plistPath], 'video-lane bootstrap')
  const active = await waitForSnapshot(minimumAgeSeconds, 'active')
  assertStable(before.protectedPids, active.protectedPids, 'protected listener PID set')
  assertStable(stableComparable(before), stableComparable(active), 'active runtime identity')
  if (optionalEntry(launchGuardianPath(before.batchRoot))) {
    fail('video worker did not consume the launch handoff marker')
  }
  if (handoffCleanup) testKillAfter('MARKER_CONSUMED_BEFORE_OWNER_CLEANUP')
  if (handoffCleanup) handoffCleanup()
  return active
}

function renameWorkspace(source, target, expectedTree) {
  assertNoSymlink(target, 'quarantine target', true)
  if (optionalEntry(target)) fail('quarantine target already exists')
  const sourceIdentity = identity(source, 'orphan workspace', 'directory', 0o700)
  const sourceParent = identity(dirname(source), 'workspace parent', 'directory')
  const targetParent = identity(dirname(target), 'quarantine parent', 'directory', 0o700)
  if (sourceIdentity.dev !== targetParent.dev) fail('workspace and quarantine root are not on the same device')
  const currentTree = treeSnapshot(source, 'orphan workspace')
  if (canonicalJson(currentTree) !== canonicalJson(expectedTree)) fail('workspace tree changed before rename')
  recordTestEvent('rename:workspace-to-quarantine')
  renameSync(source, target)
  const moved = identity(target, 'quarantined workspace', 'directory', 0o700)
  if (optionalEntry(source) || moved.dev !== sourceIdentity.dev || moved.ino !== sourceIdentity.ino) fail('workspace rename identity verification failed')
  const movedTree = treeSnapshot(target, 'quarantined workspace')
  if (canonicalJson({ ...movedTree, root: sourceIdentity }) !== canonicalJson(expectedTree)) fail('workspace tree changed across rename')
  fsyncDirectory(targetParent.path)
  fsyncDirectory(sourceParent.path)
  return { source: sourceIdentity, target: moved, tree: movedTree }
}

function reverseRename(source, target, expectedTarget, expectedTree) {
  if (optionalEntry(source)) fail('workspace source was recreated; refusing reverse rename')
  const current = identity(target, 'quarantined workspace', 'directory', 0o700)
  if (!sameIdentity(current, expectedTarget)) fail('quarantined workspace identity changed')
  const tree = treeSnapshot(target, 'quarantined workspace')
  if (tree.digest !== expectedTree.digest || tree.entries !== expectedTree.entries || tree.bytes !== expectedTree.bytes) fail('quarantined workspace tree changed')
  const sourceParent = identity(dirname(source), 'workspace parent', 'directory')
  const targetParent = identity(dirname(target), 'quarantine parent', 'directory', 0o700)
  if (current.dev !== sourceParent.dev) fail('workspace restore is not same-device')
  recordTestEvent('rename:quarantine-to-workspace')
  renameSync(target, source)
  const restored = identity(source, 'restored workspace', 'directory', 0o700)
  if (optionalEntry(target) || restored.dev !== current.dev || restored.ino !== current.ino) fail('workspace reverse rename identity verification failed')
  fsyncDirectory(sourceParent.path)
  fsyncDirectory(targetParent.path)
  return restored
}

function verifyRoots(runRoot, quarantineRoot, workspace, activeLock) {
  const run = identity(runRoot, 'run root', 'directory', 0o700)
  const quarantine = identity(quarantineRoot, 'quarantine root', 'directory', 0o700)
  if (run.path === quarantine.path || isWithin(run.path, quarantine.path) || isWithin(quarantine.path, run.path)
    || isWithin(REPOSITORY_ROOT, run.path) || isWithin(REPOSITORY_ROOT, quarantine.path)
    || isWithin(workspace, run.path) || isWithin(workspace, quarantine.path)) fail('managed roots overlap a protected path')
  if (identity(dirname(workspace), 'workspace parent', 'directory').dev !== quarantine.dev) fail('quarantine root is not on the workspace device')
  if (run.dev !== activeLock.dev) fail('run root is not on the video-lane lock device')
  return { run, quarantine }
}

function isWithin(root, candidate) {
  const value = relative(root, candidate)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

function toolSha256() {
  return sha256(readFileSync(SCRIPT_PATH))
}

function supportedToolSha256(value) {
  return value === toolSha256() || RECOVERABLE_PREDECESSOR_TOOL_SHA256.has(value)
}

function retirableToolSha256(value) {
  return value === toolSha256() || RETIRABLE_PREDECESSOR_TOOL_SHA256.has(value)
}

function heldGuardianSample(plan, requireLive, allowMissingOwner = false) {
  const marker = readGuardianRecord(plan.path, 'held video worker launch guardian')
  const current = marker.identity
  if ((plan.dev !== undefined && current.dev !== plan.dev)
    || (plan.ino !== undefined && current.ino !== plan.ino)
    || (plan.uid !== undefined && current.uid !== plan.uid)
    || (plan.mode !== undefined && current.mode !== plan.mode)
    || (plan.sourceSha256 !== undefined && marker.sha256 !== plan.sourceSha256)) {
    fail('held video worker launch guardian identity changed')
  }
  const value = marker.value
  const tokenSha256 = plan.tokenSha256 || sha256(String(plan.token || ''))
  if (!Number.isSafeInteger(value?.pid) || value.pid <= 0
    || value.createdAt !== plan.createdAt || sha256(String(value.token || '')) !== tokenSha256
    || ![undefined, GUARDIAN_SCHEMA].includes(value.schema)
    || (plan.markerPid !== undefined && value.pid !== plan.markerPid)) {
    fail('held video worker launch guardian is not live')
  }
  const ownerPath = launchGuardianOwnerPath(dirname(plan.path))
  const ownerEntry = optionalEntry(ownerPath)
  if (!ownerEntry) {
    if (!allowMissingOwner) fail('held video worker launch guardian owner record is missing')
    return { value, identity: current, source: marker.source, mtimeNs: marker.mtimeNs, owner: null }
  }
  const owner = validateGuardianOwner(
    readGuardianRecord(ownerPath, 'video worker launch guardian owner record'),
    { ...current, sourceSha256: marker.sha256 }, tokenSha256, plan.createdAt,
  )
  const mtimeMilliseconds = Number(marker.mtimeNs / 1_000_000n)
  if (requireLive && (!pidExists(owner.value.pid, 'guardian owner')
    || Date.now() - mtimeMilliseconds > 15_000
    || mtimeMilliseconds - Date.now() > 15_000)) {
    fail('held video worker launch guardian is not live')
  }
  return { value, identity: current, source: marker.source, mtimeNs: marker.mtimeNs, owner }
}

function validateHeldGuardian(plan) {
  const first = heldGuardianSample(plan, true)
  Atomics.wait(
    new Int32Array(new SharedArrayBuffer(4)), 0, 0,
    GUARDIAN_REFRESH_MILLISECONDS + (TEST_MODE ? 100 : 500),
  )
  const second = heldGuardianSample(plan, true)
  if (!sameIdentity(first.identity, second.identity)
    || first.source !== second.source || first.value.pid !== second.value.pid
    || first.value.createdAt !== second.value.createdAt || first.value.token !== second.value.token
    || !sameRecord(first.owner, second.owner) || first.owner.value.pid !== second.owner.value.pid
    || first.owner.value.createdAt !== second.owner.value.createdAt
    || second.mtimeNs <= first.mtimeNs) {
    fail('held video worker launch guardian did not refresh across samples')
  }
  return second.owner.value.pid
}

function requestHeldGuardianHandoff(plan) {
  const pid = validateHeldGuardian(plan)
  try { process.kill(pid, 'SIGUSR2') } catch { fail('held video worker launch guardian handoff signal failed') }
  let alive = true
  for (let attempt = 0; attempt < HANDOFF_WAIT_ATTEMPTS && alive; attempt += 1) {
    alive = pidExists(pid, 'guardian owner')
    if (alive) Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)), 0, 0, HANDOFF_WAIT_MILLISECONDS,
    )
  }
  if (alive) fail('held video worker launch guardian did not exit for handoff')
  const final = heldGuardianSample(plan, false)
  if (final.owner.value.pid !== pid || final.source === ''
    || final.value.createdAt !== plan.createdAt || pidExists(final.owner.value.pid, 'guardian owner')) {
    fail('held video worker launch guardian owner changed during handoff')
  }
  if (TEST_MODE && process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_AFTER_HOLDER_EXIT_COMMAND) {
    run(
      testPath('AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_AFTER_HOLDER_EXIT_COMMAND', ''),
      [plan.path],
      'test holder-exit interlock probe',
    )
  }
}

function workspacePlacement(sourceTree, targetPath) {
  const sourceEntry = optionalEntry(sourceTree.root.path)
  const targetEntry = optionalEntry(targetPath)
  if (Boolean(sourceEntry) === Boolean(targetEntry)) fail('workspace source and quarantine target are ambiguous')
  const pathname = sourceEntry ? sourceTree.root.path : targetPath
  const label = sourceEntry ? 'orphan workspace' : 'quarantined workspace'
  const current = identity(pathname, label, 'directory', 0o700)
  if (current.dev !== sourceTree.root.dev || current.ino !== sourceTree.root.ino
    || current.uid !== sourceTree.root.uid || current.mode !== sourceTree.root.mode) {
    fail(`${label} identity changed`)
  }
  const tree = treeSnapshot(pathname, label)
  if (tree.digest !== sourceTree.digest || tree.entries !== sourceTree.entries
    || tree.bytes !== sourceTree.bytes) fail(`${label} tree changed`)
  return { mode: sourceEntry ? 'source' : 'target', current, tree }
}

function writeAnchor(pathname, label, reference, intentSha256) {
  return immutableJson(pathname, {
    schema: `video-autoworker-legacy-media-orphan-${label}-anchor/v1`,
    createdAt: Math.floor(Date.now() / 1000),
    intentSha256,
    reference: {
      path: reference.identity.path,
      dev: reference.identity.dev,
      ino: reference.identity.ino,
      uid: reference.identity.uid,
      mode: reference.identity.mode,
      sha256: reference.sha256,
    },
  })
}

function validateAnchor(pathname, label, reference, intentSha256) {
  const anchor = readImmutableJson(pathname, `${label} anchor`)
  const expected = anchor.value?.reference
  if (anchor.value?.schema !== `video-autoworker-legacy-media-orphan-${label}-anchor/v1`
    || anchor.value.intentSha256 !== intentSha256 || !expected
    || expected.path !== reference.identity.path || expected.dev !== reference.identity.dev
    || expected.ino !== reference.identity.ino || expected.uid !== reference.identity.uid
    || expected.mode !== reference.identity.mode || expected.sha256 !== reference.sha256) {
    fail(`${label} anchor does not bind the immutable receipt`)
  }
  return anchor
}

async function prepare(values) {
  const first = await captureSnapshot(values.minimumAgeSeconds, 'active')
  const second = await captureSnapshot(values.minimumAgeSeconds, 'active')
  assertStable(first, second, 'active runtime snapshot')
  const workspaceTree = treeSnapshot(first.orphan.workspace, 'orphan workspace')
  const stableTree = treeSnapshot(first.orphan.workspace, 'orphan workspace')
  assertStable(workspaceTree, stableTree, 'workspace tree')
  const roots = verifyRoots(values.runRoot, values.quarantineRoot, first.orphan.workspace, first.lane.lock)
  const nonce = randomBytes(32).toString('hex')
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '')
  const attemptDirectory = join(values.runRoot, `${stamp}-${nonce.slice(0, 12)}`)
  mkdirSync(attemptDirectory, { mode: 0o700 })
  safeEntry(attemptDirectory, 'attempt directory', 'directory', 0o700)
  fsyncDirectory(values.runRoot)
  const target = join(values.quarantineRoot, `${stamp}-${nonce.slice(12, 24)}`)
  const intentPath = join(attemptDirectory, 'intent.json')
  const guardianToken = randomBytes(32).toString('hex')
  const guardianCreatedAt = new Date().toISOString()
  let launchGuardian = null
  let intentWritten = null
  let intent = null
  let laneChanged = false
  let deadLock = null
  let moved = null
  let renameAttempted = false
  let committed = false
  try {
    launchGuardian = openLaunchGuardian(first.batchRoot, attemptDirectory, {
      token: guardianToken,
      createdAt: guardianCreatedAt,
    })
    intent = {
      schema: INTENT_SCHEMA,
      createdAt: Math.floor(Date.now() / 1000),
      nonce,
      minimumAgeSeconds: values.minimumAgeSeconds,
      holdGuardian: values.holdGuardian,
      toolSha256: toolSha256(),
      roots,
      source: workspaceTree,
      target,
      runtime: first,
      launchGuardian: {
        path: launchGuardian.path,
        dev: launchGuardian.dev,
        ino: launchGuardian.ino,
        uid: launchGuardian.uid,
        mode: launchGuardian.mode,
        tokenSha256: launchGuardian.tokenSha256,
        createdAt: launchGuardian.createdAt,
        sourceSha256: launchGuardian.sourceSha256,
        markerPid: launchGuardian.markerPid,
        token: launchGuardian.token,
      },
    }
    intentWritten = immutableJson(intentPath, intent)
    if (TEST_MODE && process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_AFTER_INTENT_COMMAND) {
      run(testPath('AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_AFTER_INTENT_COMMAND', ''), [intentPath, target], 'test after-intent hook')
    }
    launchGuardian.verify()
    laneChanged = true
    disableAndStop(first.plistPath)
    const stopped = await waitForSnapshot(values.minimumAgeSeconds, 'stopped')
    launchGuardian.verify()
    assertStable(stableComparable(first), stableComparable(stopped), 'runtime identity')
    if (TEST_MODE && process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_STOP === '1') {
      process.kill(process.pid, 'SIGKILL')
    }
    assertOldWorkerGone(first.lane.worker)
    assertLockUnopened(first.lane.lock.path)
    deadLock = quarantineDeadLock(first.lane.lock, stopped.lane.lock, attemptDirectory)
    launchGuardian.verify()
    const quiesced = await waitForSnapshot(values.minimumAgeSeconds, 'quiesced')
    launchGuardian.verify()
    assertStable(stableComparable(first), stableComparable(quiesced), 'runtime identity')
    renameAttempted = true
    moved = renameWorkspace(first.orphan.workspace, target, workspaceTree)
    launchGuardian.verify()
    if (TEST_MODE && process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_RENAME === '1') {
      process.kill(process.pid, 'SIGKILL')
    }
    const receiptValue = {
      schema: RECEIPT_SCHEMA,
      createdAt: Math.floor(Date.now() / 1000),
      nonce,
      toolSha256: intent.toolSha256,
      holdGuardian: values.holdGuardian,
      intent: { path: intentPath, sha256: intentWritten.sha256, ...intentWritten.identity },
      minimumAgeSeconds: values.minimumAgeSeconds,
      runtimeBefore: first,
      runtimeQuiesced: quiesced,
      deadLock,
      launchGuardian: {
        path: launchGuardian.path,
        dev: launchGuardian.dev,
        ino: launchGuardian.ino,
        uid: launchGuardian.uid,
        mode: launchGuardian.mode,
        tokenSha256: launchGuardian.tokenSha256,
        createdAt: launchGuardian.createdAt,
        sourceSha256: launchGuardian.sourceSha256,
        markerPid: launchGuardian.markerPid,
      },
      source: moved.source,
      target: moved.target,
      tree: moved.tree,
    }
    const receiptPath = join(attemptDirectory, 'receipt.json')
    const receipt = immutableJson(receiptPath, receiptValue)
    writeAnchor(join(attemptDirectory, 'receipt.anchor.json'), 'receipt', receipt, intentWritten.sha256)
    committed = true
    chmodSync(attemptDirectory, 0o500)
    fsyncDirectory(attemptDirectory)
    fsyncDirectory(values.runRoot)
    if (values.holdGuardian) {
      const holdPromise = launchGuardian.hold()
      process.stdout.write(`${JSON.stringify({ mode: 'prepared-held', receipt: receiptPath, receiptSha256: receipt.sha256, guardianPid: process.pid })}\n`)
      await holdPromise
    } else {
      launchGuardian.release()
      process.stdout.write(`${JSON.stringify({ mode: 'prepared', receipt: receiptPath, receiptSha256: receipt.sha256 })}\n`)
    }
  } catch (error) {
    const failures = [error instanceof Error ? error.message : String(error)]
    let mayResume = true
    if (renameAttempted || committed) {
      try {
        const placement = workspacePlacement(workspaceTree, target)
        if (placement.mode === 'target' || committed) {
          mayResume = false
          failures.push('workspace quarantine is durable or may have committed; use recover with the immutable intent')
        }
      } catch (rollbackError) {
        mayResume = false
        failures.push(`workspace commit-state check failed: ${rollbackError.message}`)
      }
    }
    if (laneChanged && mayResume) {
      try {
        const serviceLoaded = launchState().loaded
        const oldWorkerAlive = pidExists(first.lane.worker.pid, 'old video worker')
        const originalLockRemains = Boolean(optionalEntry(first.lane.lock.path))
        mayResume = serviceLoaded || (!oldWorkerAlive && (!originalLockRemains || deadLock))
        if (!mayResume) failures.push('lane rollback withheld because the stopped worker or original lock is not safely recoverable')
      } catch (rollbackError) {
        mayResume = false
        failures.push(`lane rollback safety check failed: ${rollbackError.message}`)
      }
    }
    if (launchGuardian && mayResume) {
      try { launchGuardian.release() } catch (rollbackError) { failures.push(`launch guardian release failed: ${rollbackError.message}`) }
    }
    if (laneChanged && mayResume) {
      try { await enableAndStart(values.minimumAgeSeconds, first) } catch (rollbackError) { failures.push(`lane rollback failed: ${rollbackError.message}`) }
    }
    fail(failures.join('; '))
  }
}

function validateReceipt(
  pathname,
  allowReplacementLock = false,
  requireAnchor = true,
  allowRetirablePredecessor = false,
) {
  const loaded = readImmutableJson(pathname, 'runtime guard receipt')
  const value = loaded.value
  if (value?.schema !== RECEIPT_SCHEMA || !SHA256.test(value.toolSha256) || !value.intent?.path
    || !value.source?.path || !value.target?.path || !value.tree?.digest || !value.deadLock || !value.launchGuardian
    || value.intent.sha256 === undefined) fail('runtime guard receipt contract is invalid')
  if (allowRetirablePredecessor
    ? !retirableToolSha256(value.toolSha256)
    : value.toolSha256 !== toolSha256()) fail('runtime guard tool changed after prepare')
  if (dirname(pathname) !== dirname(value.intent.path) || basename(pathname) !== 'receipt.json'
    || basename(value.intent.path) !== 'intent.json') fail('runtime guard receipt path binding is invalid')
  const intent = readImmutableJson(value.intent.path, 'runtime guard intent')
  if (intent.sha256 !== value.intent.sha256 || !sameIdentity(intent.identity, value.intent)
    || intent.value?.schema !== INTENT_SCHEMA || intent.value.nonce !== value.nonce
    || intent.value.toolSha256 !== value.toolSha256 || intent.value.target !== value.target.path) fail('runtime guard intent binding is invalid')
  const guardian = intent.value.launchGuardian
  if (!guardian || guardian.path !== value.launchGuardian.path || guardian.dev !== value.launchGuardian.dev
    || guardian.ino !== value.launchGuardian.ino || guardian.uid !== value.launchGuardian.uid
    || guardian.mode !== value.launchGuardian.mode || guardian.tokenSha256 !== value.launchGuardian.tokenSha256
    || guardian.createdAt !== value.launchGuardian.createdAt
    || guardian.sourceSha256 !== value.launchGuardian.sourceSha256
    || guardian.markerPid !== value.launchGuardian.markerPid) fail('runtime guard launch guardian binding is invalid')
  if (requireAnchor) validateAnchor(join(dirname(pathname), 'receipt.anchor.json'), 'receipt', loaded, intent.sha256)
  validateLockEvidence(value.deadLock, dirname(pathname), allowReplacementLock)
  return { loaded, value, intent }
}

function restoreReceiptPath(receiptPath) {
  return join(dirname(receiptPath), 'restore.json')
}

function restoreIntentPath(receiptPath) {
  return join(dirname(receiptPath), 'restore-intent.json')
}

function retireReceiptPath(receiptPath) {
  return join(dirname(receiptPath), 'retire.json')
}

function retireIntentPath(receiptPath) {
  return join(dirname(receiptPath), 'retire-intent.json')
}

function retireAnchorPath(receiptPath) {
  return join(dirname(receiptPath), 'retire.anchor.json')
}

function hasRetireArtifact(receiptPath) {
  return [retireIntentPath(receiptPath), retireReceiptPath(receiptPath), retireAnchorPath(receiptPath)]
    .some(pathname => Boolean(optionalEntry(pathname)))
}

function hasRestoreArtifact(receiptPath) {
  return [restoreIntentPath(receiptPath), restoreReceiptPath(receiptPath), join(dirname(receiptPath), 'restore.anchor.json')]
    .some(pathname => Boolean(optionalEntry(pathname)))
}

function validateRetireIntent(pathname, chain, finalReadinessPath) {
  const loaded = readImmutableJson(pathname, 'runtime guard retire intent')
  const value = loaded.value
  const preparedPlan = chain.intent.value.launchGuardian
  if (value?.schema !== RETIRE_INTENT_SCHEMA || value.nonce !== chain.value.nonce
    || value.toolSha256 !== toolSha256() || value.preparedReceiptPath !== chain.loaded.identity.path
    || value.preparedReceiptSha256 !== chain.loaded.sha256
    || canonicalJson(value.launchGuardian) !== canonicalJson(preparedPlan)
    || value.finalReadiness?.report?.path !== finalReadinessPath
    || !value.evidence || !value.quarantine?.identity || !value.quarantine?.tree) {
    fail('retire intent contract is invalid')
  }
  const current = verifyFinalReadiness(finalReadinessPath, chain.loaded.identity.path)
  assertStable(value.finalReadiness, current, 'retire intent final-readiness identity')
  return loaded
}

function validateRetireReceipt(pathname, chain, retireIntent, requireAnchor = true) {
  const loaded = readImmutableJson(pathname, 'runtime guard retire receipt')
  const value = loaded.value
  if (value?.schema !== RETIRE_SCHEMA || value.nonce !== chain.value.nonce
    || value.toolSha256 !== toolSha256() || value.preparedReceiptPath !== chain.loaded.identity.path
    || value.preparedReceiptSha256 !== chain.loaded.sha256
    || value.retireIntent?.path !== retireIntent.identity.path
    || value.retireIntent.sha256 !== retireIntent.sha256
    || !sameIdentity(value.retireIntent, retireIntent.identity) || !value.runtimeActive) {
    fail('retire receipt contract is invalid')
  }
  validateRetireSnapshot(chain, value.runtimeActive, 'active')
  assertStable(
    retireIntent.value.evidence,
    retireInvariantProjection(value.runtimeActive),
    'retire receipt post-CAS evidence',
  )
  if (requireAnchor) {
    validateAnchor(retireAnchorPath(chain.loaded.identity.path), 'retire', loaded, chain.intent.sha256)
  }
  return loaded
}

async function validatePrepared(receiptPath, chain, activeGuardian = null) {
  const { value } = chain
  if (activeGuardian) activeGuardian.verify()
  else if (optionalEntry(value.launchGuardian.path)) {
    if (!value.holdGuardian) fail('video worker launch guardian was not released')
    validateHeldGuardian(value.launchGuardian)
  } else if (value.holdGuardian) fail('held video worker launch guardian is missing')
  if (optionalEntry(value.source.path)) fail('prepared workspace source unexpectedly exists')
  const target = identity(value.target.path, 'quarantined workspace', 'directory', 0o700)
  if (!sameIdentity(target, value.target)) fail('quarantined workspace identity changed')
  const tree = treeSnapshot(target.path, 'quarantined workspace')
  if (tree.digest !== value.tree.digest || tree.entries !== value.tree.entries || tree.bytes !== value.tree.bytes) fail('quarantined workspace tree changed')
  const snapshot = await captureSnapshot(value.minimumAgeSeconds, 'quiesced')
  assertStable(stableComparable(value.runtimeBefore), stableComparable(snapshot), 'prepared runtime identity')
  if (dirname(receiptPath) !== dirname(value.intent.path)) fail('receipt attempt directory changed')
  return { target, tree, snapshot }
}

function validateRestoreIntent(pathname, chain) {
  const loaded = readImmutableJson(pathname, 'runtime guard restore intent')
  const value = loaded.value
  if (value?.schema !== RESTORE_INTENT_SCHEMA || value.nonce !== chain.value.nonce
    || value.toolSha256 !== toolSha256() || value.preparedReceiptSha256 !== chain.loaded.sha256
    || value.preparedReceiptPath !== chain.loaded.identity.path
    || value.launchGuardian?.path !== launchGuardianPath(chain.value.runtimeBefore.batchRoot)
    || typeof value.launchGuardian?.token !== 'string' || !/^[a-f0-9]{64}$/u.test(value.launchGuardian.token)
    || !Number.isFinite(Date.parse(value.launchGuardian.createdAt))) fail('restore intent contract is invalid')
  return loaded
}

function validateRestoreReceipt(pathname, chain, requireAnchor = true) {
  const loaded = readImmutableJson(pathname, 'runtime guard restore receipt')
  const value = loaded.value
  if (value?.schema !== RESTORE_SCHEMA || value.nonce !== chain.value.nonce
    || value.toolSha256 !== toolSha256() || value.preparedReceiptSha256 !== chain.loaded.sha256
    || value.source?.path !== chain.value.source.path || value.source.dev !== chain.value.source.dev
    || value.source.ino !== chain.value.source.ino || value.source.uid !== chain.value.source.uid
    || value.source.mode !== chain.value.source.mode || !value.restoreIntent?.path
    || !value.runtimeActive) fail('restore receipt contract is invalid')
  assertStable(
    stableComparable(chain.value.runtimeBefore), stableComparable(value.runtimeActive),
    'restore receipt runtime identity',
  )
  const restoreIntent = validateRestoreIntent(value.restoreIntent.path, chain)
  if (restoreIntent.sha256 !== value.restoreIntent.sha256
    || !sameIdentity(restoreIntent.identity, value.restoreIntent)) fail('restore receipt intent binding is invalid')
  if (requireAnchor) validateAnchor(join(dirname(pathname), 'restore.anchor.json'), 'restore', loaded, chain.intent.sha256)
  return loaded
}

function restoredWorkspacePlacement(value) {
  const sourceEntry = optionalEntry(value.source.path)
  const targetEntry = optionalEntry(value.target.path)
  if (Boolean(sourceEntry) === Boolean(targetEntry)) fail('restore workspace placement is ambiguous')
  if (targetEntry) {
    const target = identity(value.target.path, 'quarantined workspace', 'directory', 0o700)
    if (!sameIdentity(target, value.target)) fail('quarantined workspace identity changed')
    const tree = treeSnapshot(target.path, 'quarantined workspace')
    if (tree.digest !== value.tree.digest || tree.entries !== value.tree.entries
      || tree.bytes !== value.tree.bytes) fail('quarantined workspace tree changed')
    return { mode: 'target', identity: target, tree }
  }
  const source = identity(value.source.path, 'restored workspace', 'directory', 0o700)
  if (source.dev !== value.source.dev || source.ino !== value.source.ino
    || source.uid !== value.source.uid || source.mode !== value.source.mode) {
    fail('restored workspace identity changed')
  }
  const tree = treeSnapshot(source.path, 'restored workspace')
  if (tree.digest !== value.tree.digest || tree.entries !== value.tree.entries
    || tree.bytes !== value.tree.bytes) fail('restored workspace tree changed')
  return { mode: 'source', identity: source, tree }
}

async function restoredRuntimeState(value) {
  let quiescedError
  try { return { mode: 'quiesced', snapshot: await captureSnapshot(value.minimumAgeSeconds, 'quiesced') } } catch (error) {
    quiescedError = error
  }
  try { return { mode: 'active', snapshot: await captureSnapshot(value.minimumAgeSeconds, 'active') } } catch (activeError) {
    fail(`restore runtime is neither quiesced nor active: ${quiescedError?.message}; ${activeError?.message}`)
  }
}

async function retireRuntimeState(chain, finalReadinessPath, expected) {
  let quiescedError
  try {
    return {
      mode: 'quiesced',
      snapshot: await captureRetireSnapshot(chain, 'quiesced', finalReadinessPath),
    }
  } catch (error) { quiescedError = error }
  try {
    const snapshot = await captureRetireSnapshot(chain, 'active', finalReadinessPath)
    if (expected) assertStable(expected, retireInvariantProjection(snapshot), 'post-CAS retire evidence')
    return { mode: 'active', snapshot }
  } catch (activeError) {
    fail(`retire runtime is neither quiesced nor active: ${quiescedError?.message}; ${activeError?.message}`)
  }
}

function testFailAfter(name) {
  if (TEST_MODE && process.env[`AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_FAIL_AFTER_${name}`] === '1') {
    fail(`injected failure after ${name}`)
  }
}

function waitForConsumedGuardian(pathname, authorizationPath, claimPath) {
  for (let attempt = 0; attempt < HANDOFF_WAIT_ATTEMPTS; attempt += 1) {
    if (!optionalEntry(pathname) && !optionalEntry(authorizationPath) && !optionalEntry(claimPath)) return
    Atomics.wait(
      new Int32Array(new SharedArrayBuffer(4)), 0, 0, HANDOFF_WAIT_MILLISECONDS,
    )
  }
  fail('video worker did not consume the launch handoff marker')
}

function launchControlBindsActive(control, active, finalReadinessPath) {
  const workerPid = active.lane.workers[0]
  const lock = active.lane.lock
  const value = control?.value
  return value?.workerPid === workerPid
    && value.globalLock?.path === lock.path
    && value.globalLock?.dev === lock.dev
    && value.globalLock?.ino === lock.ino
    && value.globalLock?.sourceSha256 === lock.contentSha256
    && value.globalLock?.tokenSha256 === lock.tokenSha256
    && value.finalReadiness?.path === finalReadinessPath
}

function reconcileWorkerLaunchControl(before, active, finalReadinessPath, markerPresent) {
  let state = inspectWorkerLaunchAuthorizationStateSync({ batchRoot: before.batchRoot })
  if (state.pending && (!markerPresent || state.authorization || state.claim)) {
    fail('incomplete worker launch authorization conflicts with handoff state')
  }
  for (const [kind, control] of [['authorization', state.authorization], ['claim', state.claim]]) {
    if (!control || launchControlBindsActive(control, active, finalReadinessPath)) continue
    const oldPid = control.value.workerPid
    if (pidExists(oldPid, `old worker launch ${kind} owner`)) {
      fail(`old worker launch ${kind} PID is still live or was reused`)
    }
    const oldLock = control.value.globalLock
    const currentLock = active.lane.lock
    if (oldLock.dev === currentLock.dev && oldLock.ino === currentLock.ino
      && oldLock.tokenSha256 === currentLock.tokenSha256) {
      fail(`old worker launch ${kind} lock was not replaced`)
    }
    removeWorkerLaunchAuthorizationArtifactSync({
      batchRoot: before.batchRoot,
      kind,
      expected: control,
    })
  }
  state = inspectWorkerLaunchAuthorizationStateSync({ batchRoot: before.batchRoot })
  if (!markerPresent && (state.authorization || state.pending)) {
    fail('worker launch authorization remains after guardian consumption')
  }
  return state
}

async function completeRetireWorkerHandoff(
  chain,
  finalReadinessPath,
  expected,
  active,
  handoffCleanup,
) {
  const before = chain.value.runtimeBefore
  const workerPid = active.lane.workers[0]
  const authorizationPath = workerLaunchAuthorizationPath(before.batchRoot)
  const claimPath = workerLaunchAuthorizationClaimPath(before.batchRoot)
  testKillAfter('RETIRE_SUCCESSOR_ACTIVE_BEFORE_AUTHORIZATION')
  testFailAfter('RETIRE_SUCCESSOR_ACTIVE_BEFORE_AUTHORIZATION')
  let control = reconcileWorkerLaunchControl(before, active, finalReadinessPath, true)
  if (!control.authorization && !control.claim) {
    issueWorkerLaunchAuthorizationSync({
      batchRoot: before.batchRoot,
      workerPid,
      finalReadinessPath,
    })
    control = reconcileWorkerLaunchControl(before, active, finalReadinessPath, true)
  }
  testKillAfter('RETIRE_WORKER_AUTHORIZATION')
  testFailAfter('RETIRE_WORKER_AUTHORIZATION')
  if (control.authorization && TEST_MODE
    && process.env.AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_CONSUME_AUTHORIZATION_COMMAND) {
    const result = runStatus(
      testPath('AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_CONSUME_AUTHORIZATION_COMMAND', ''),
      [before.batchRoot, String(workerPid)],
    )
    if (result.error || result.signal || result.status !== 0) {
      fail(`test worker launch authorization consumption failed: ${result.stderr?.trim() || 'unknown error'}`)
    }
  }
  waitForConsumedGuardian(chain.intent.value.launchGuardian.path, authorizationPath, claimPath)
  // At this point the only admitted successor is the LaunchAgent worker whose
  // PID also owns the global lock. Intake is deliberately untouched.
  testKillAfter('RETIRE_MARKER_CONSUMED_BEFORE_OWNER_CLEANUP')
  testFailAfter('RETIRE_MARKER_CONSUMED_BEFORE_OWNER_CLEANUP')
  handoffCleanup()
  if (optionalEntry(launchGuardianOwnerPath(before.batchRoot))) {
    fail('video worker launch guardian owner remains after retire handoff')
  }
  active = await waitForRetireSnapshot(chain, 'active', finalReadinessPath, expected)
  return active
}

async function enableAndStartAfterRetire(chain, finalReadinessPath, expected, handoffCleanup) {
  const before = chain.value.runtimeBefore
  const domain = `gui/${process.getuid()}`
  action(['enable', `${domain}/${LABEL}`], 'video-lane enable')
  if (!launchState().loaded) action(['bootstrap', domain, before.plistPath], 'video-lane bootstrap')
  const active = await waitForRetireSnapshot(chain, 'active', finalReadinessPath, expected)
  return completeRetireWorkerHandoff(
    chain,
    finalReadinessPath,
    expected,
    active,
    handoffCleanup,
  )
}

async function resumeActiveRetireHandoff(chain, finalReadinessPath, expected, active) {
  const before = chain.value.runtimeBefore
  const markerPath = chain.intent.value.launchGuardian.path
  const authorizationPath = workerLaunchAuthorizationPath(before.batchRoot)
  const claimPath = workerLaunchAuthorizationClaimPath(before.batchRoot)
  const ownerPath = launchGuardianOwnerPath(before.batchRoot)
  if (!optionalEntry(markerPath)) {
    const state = reconcileWorkerLaunchControl(before, active, finalReadinessPath, false)
    if (state.claim) {
      if (launchControlBindsActive(state.claim, active, finalReadinessPath)) {
        waitForConsumedGuardian(markerPath, authorizationPath, claimPath)
      } else {
        fail('stale worker launch claim could not be reconciled')
      }
    }
    if (optionalEntry(ownerPath)) {
      removeDetachedGuardianOwner(before.batchRoot, chain.intent.value.launchGuardian)
    }
    if (optionalEntry(ownerPath)) fail('detached launch guardian owner remains after cleanup')
    return waitForRetireSnapshot(chain, 'active', finalReadinessPath, expected)
  }

  const initialControl = reconcileWorkerLaunchControl(before, active, finalReadinessPath, true)
  let handoffCleanup
  if (initialControl.authorization || initialControl.claim || initialControl.pending) {
    const held = heldGuardianSample(chain.intent.value.launchGuardian, false)
    if (pidExists(held.owner.value.pid, 'guardian owner')) {
      fail('an active successor has a live competing launch guardian owner')
    }
    handoffCleanup = () => {
      if (optionalEntry(ownerPath)) {
        removeDetachedGuardianOwner(before.batchRoot, chain.intent.value.launchGuardian)
      }
    }
  } else {
    let guardian = takeoverRetireGuardian(chain, dirname(chain.loaded.identity.path))
    guardian.verify()
    handoffCleanup = guardian.handoff()
    guardian = null
  }

  try {
    return await completeRetireWorkerHandoff(
      chain,
      finalReadinessPath,
      expected,
      active,
      handoffCleanup,
    )
  } catch (error) {
    // An already-authorized worker may win the race with a recovering
    // controller. Once both one-shot files are gone, only the exact dead owner
    // record remains and can be removed under the same immutable plan.
    if (!optionalEntry(markerPath) && !optionalEntry(authorizationPath) && !optionalEntry(claimPath)) {
      if (optionalEntry(ownerPath)) {
        removeDetachedGuardianOwner(before.batchRoot, chain.intent.value.launchGuardian)
      }
      if (!optionalEntry(ownerPath)) {
        return waitForRetireSnapshot(chain, 'active', finalReadinessPath, expected)
      }
    }
    throw error
  }
}

function testKillAfter(name) {
  if (TEST_MODE && process.env[`AIWORKER_TEST_ORPHAN_RUNTIME_GUARD_KILL_AFTER_${name}`] === '1') {
    process.kill(process.pid, 'SIGKILL')
  }
}

async function status(values) {
  if (hasRetireArtifact(values.pathname)) fail('retire artifacts require the retire command')
  const restorePath = restoreReceiptPath(values.pathname)
  const intentPath = restoreIntentPath(values.pathname)
  const anchorPath = join(dirname(values.pathname), 'restore.anchor.json')
  const hasIntent = Boolean(optionalEntry(intentPath))
  const hasReceipt = Boolean(optionalEntry(restorePath))
  const hasAnchor = Boolean(optionalEntry(anchorPath))
  if (hasAnchor && !hasReceipt) fail('restore commit marker exists without its receipt')
  const chain = validateReceipt(values.pathname, hasIntent || hasReceipt || hasAnchor)
  if (!hasIntent && !hasReceipt && !hasAnchor) {
    await validatePrepared(values.pathname, chain)
    process.stdout.write(`${JSON.stringify({ mode: chain.value.holdGuardian ? 'prepared-held' : 'prepared', receipt: values.pathname })}\n`)
    return
  }
  if (!hasIntent) fail('restore artifacts exist without a restore intent')
  validateRestoreIntent(intentPath, chain)
  if (!hasAnchor) {
    if (hasReceipt) validateRestoreReceipt(restorePath, chain, false)
    process.stdout.write(`${JSON.stringify({ mode: 'restore-incomplete', receipt: values.pathname })}\n`)
    return
  }
  const restoreReceipt = validateRestoreReceipt(restorePath, chain, true)
  if (optionalEntry(chain.value.target.path)) fail('restored quarantine target still exists')
  const source = identity(chain.value.source.path, 'restored workspace', 'directory', 0o700)
  if (source.dev !== chain.value.source.dev || source.ino !== chain.value.source.ino) fail('restored workspace identity changed')
  const tree = treeSnapshot(source.path, 'restored workspace')
  if (tree.digest !== chain.value.tree.digest || tree.entries !== chain.value.tree.entries || tree.bytes !== chain.value.tree.bytes) fail('restored workspace tree changed')
  const active = await captureSnapshot(chain.value.minimumAgeSeconds, 'active')
  assertStable(restoreReceipt.value.runtimeActive, active, 'restored active runtime snapshot')
  process.stdout.write(`${JSON.stringify({ mode: 'restored', receipt: values.pathname })}\n`)
}

async function restore(values) {
  if (hasRetireArtifact(values.pathname)) fail('retire artifacts block workspace restore')
  const restorePath = restoreReceiptPath(values.pathname)
  const intentPath = restoreIntentPath(values.pathname)
  const anchorPath = join(dirname(values.pathname), 'restore.anchor.json')
  if (optionalEntry(anchorPath)) {
    const chain = validateReceipt(values.pathname, true)
    validateRestoreReceipt(restorePath, chain)
    chmodSync(dirname(values.pathname), 0o500)
    fsyncDirectory(dirname(values.pathname))
    fsyncDirectory(dirname(dirname(values.pathname)))
    return status(values)
  }
  const chain = validateReceipt(values.pathname, Boolean(optionalEntry(intentPath)))
  const attemptDirectory = dirname(values.pathname)
  chmodSync(attemptDirectory, 0o700)
  fsyncDirectory(attemptDirectory)
  const preparedMarkerPath = chain.value.launchGuardian.path
  const preparedOwnerPath = launchGuardianOwnerPath(chain.value.runtimeBefore.batchRoot)
  if (!optionalEntry(intentPath) && !optionalEntry(preparedMarkerPath)
    && optionalEntry(preparedOwnerPath)) {
    // A non-held prepare may have been killed after marker-first release. The
    // immutable prepare intent is the exact authority for this one sidecar.
    removeDetachedGuardianOwner(
      chain.value.runtimeBefore.batchRoot, chain.intent.value.launchGuardian,
    )
  }
  let restoreIntent
  if (optionalEntry(intentPath)) restoreIntent = validateRestoreIntent(intentPath, chain)
  else {
    const held = optionalEntry(chain.value.launchGuardian.path)
    const heldOwner = optionalEntry(preparedOwnerPath)
    if (held && heldOwner && !chain.value.holdGuardian) fail('unexpected live launch guardian blocks restore')
    const launchGuardian = held ? chain.intent.value.launchGuardian : {
      path: launchGuardianPath(chain.value.runtimeBefore.batchRoot),
      token: randomBytes(32).toString('hex'),
      createdAt: new Date().toISOString(),
    }
    restoreIntent = immutableJson(intentPath, {
      schema: RESTORE_INTENT_SCHEMA,
      createdAt: Math.floor(Date.now() / 1000),
      nonce: chain.value.nonce,
      toolSha256: toolSha256(),
      preparedReceiptPath: chain.loaded.identity.path,
      preparedReceiptSha256: chain.loaded.sha256,
      launchGuardian,
    })
  }
  const plan = restoreIntent.value.launchGuardian
  let existingGuardian = optionalEntry(plan.path)
  const existingOwnerPath = launchGuardianOwnerPath(chain.value.runtimeBefore.batchRoot)
  if (!existingGuardian && optionalEntry(existingOwnerPath)) {
    const runtime = await restoredRuntimeState(chain.value)
    if (runtime.mode !== 'active') {
      fail('detached launch guardian owner exists without the restored active worker')
    }
    assertStable(
      stableComparable(chain.value.runtimeBefore), stableComparable(runtime.snapshot),
      'detached-owner active runtime identity',
    )
    removeDetachedGuardianOwner(chain.value.runtimeBefore.batchRoot, plan)
    existingGuardian = null
  }
  if (existingGuardian && optionalEntry(existingOwnerPath)) {
    const sample = heldGuardianSample(plan, false)
    if (pidExists(sample.owner.value.pid, 'guardian owner')) {
      const preparedPlan = chain.intent.value.launchGuardian
      if (!chain.value.holdGuardian || plan.token !== preparedPlan.token
        || plan.createdAt !== preparedPlan.createdAt || plan.path !== preparedPlan.path) {
        fail('another live launch guardian blocks restore')
      }
      requestHeldGuardianHandoff(chain.value.launchGuardian)
    }
  }
  let launchGuardian = existingGuardian
    ? openLaunchGuardian(chain.value.runtimeBefore.batchRoot, attemptDirectory, plan, true)
    : openLaunchGuardian(chain.value.runtimeBefore.batchRoot, attemptDirectory, plan)
  try {
    let placement = restoredWorkspacePlacement(chain.value)
    if (placement.mode === 'target') {
      const prepared = await validatePrepared(values.pathname, chain, launchGuardian)
      launchGuardian.verify()
      reverseRename(chain.value.source.path, chain.value.target.path, prepared.target, prepared.tree)
      testKillAfter('RESTORE_RENAME')
      placement = restoredWorkspacePlacement(chain.value)
    }
    if (placement.mode !== 'source') fail('restore did not produce the source workspace')
    const runtime = await restoredRuntimeState(chain.value)
    let active
    if (runtime.mode === 'quiesced') {
      assertStable(stableComparable(chain.value.runtimeBefore), stableComparable(runtime.snapshot), 'restore quiesced runtime identity')
      launchGuardian.verify()
      const handoffCleanup = launchGuardian.handoff()
      launchGuardian = null
      testKillAfter('RESTORE_GUARDIAN_HANDOFF')
      active = await enableAndStart(
        chain.value.minimumAgeSeconds, chain.value.runtimeBefore, handoffCleanup,
      )
    } else {
      active = runtime.snapshot
      assertStable(stableComparable(chain.value.runtimeBefore), stableComparable(active), 'restored runtime identity')
      launchGuardian.verify()
      launchGuardian.release()
      launchGuardian = null
    }
    testKillAfter('RESTORE_ACTIVE')
    let receipt
    if (optionalEntry(restorePath)) {
      receipt = validateRestoreReceipt(restorePath, chain, false)
    } else {
      receipt = immutableJson(restorePath, {
        schema: RESTORE_SCHEMA,
        createdAt: Math.floor(Date.now() / 1000),
        nonce: chain.value.nonce,
        toolSha256: toolSha256(),
        preparedReceiptSha256: chain.loaded.sha256,
        restoreIntent: { path: intentPath, sha256: restoreIntent.sha256, ...restoreIntent.identity },
        source: identity(chain.value.source.path, 'restored workspace', 'directory', 0o700),
        runtimeActive: active,
      })
    }
    testKillAfter('RESTORE_RECEIPT')
    if (!optionalEntry(anchorPath)) writeAnchor(anchorPath, 'restore', receipt, chain.intent.sha256)
    testKillAfter('RESTORE_ANCHOR')
    chmodSync(attemptDirectory, 0o500)
    fsyncDirectory(attemptDirectory)
    fsyncDirectory(dirname(attemptDirectory))
    process.stdout.write(`${JSON.stringify({ mode: 'restored', receipt: values.pathname, restoreReceiptSha256: receipt.sha256 })}\n`)
  } catch (error) {
    // Restore is append-only. Leave the exact placement and guardian marker in
    // place so a retry can converge from its immutable restore intent.
    throw error
  }
}

function retireQuarantineProjection(placement) {
  return {
    identity: placement.current,
    tree: {
      digest: placement.tree.digest,
      entries: placement.tree.entries,
      bytes: placement.tree.bytes,
    },
  }
}

function validateRetireQuarantine(chain, retireIntent) {
  const placement = workspacePlacement(chain.intent.value.source, chain.value.target.path)
  if (placement.mode !== 'target') fail('retire never restores the quarantined workspace')
  const current = retireQuarantineProjection(placement)
  if (retireIntent
    && canonicalJson(current) !== canonicalJson(retireIntent.value.quarantine)) {
    fail('quarantined workspace changed after retire intent')
  }
  return current
}

function takeoverRetireGuardian(chain, attemptDirectory) {
  const plan = chain.intent.value.launchGuardian
  if (!optionalEntry(plan.path)) fail('post-CAS launch guardian is missing before worker handoff')
  const ownerPath = launchGuardianOwnerPath(chain.value.runtimeBefore.batchRoot)
  if (optionalEntry(ownerPath)) {
    const sample = heldGuardianSample(plan, false)
    if (pidExists(sample.owner.value.pid, 'guardian owner')) {
      if (!chain.value.holdGuardian) fail('a live guardian is not authorized for retire handoff')
      requestHeldGuardianHandoff(plan)
    }
  }
  return openLaunchGuardian(
    chain.value.runtimeBefore.batchRoot,
    attemptDirectory,
    plan,
    true,
  )
}

async function retireLocked(values, initialChain) {
  const chain = validateReceipt(values.pathname, true, true, true)
  if (chain.loaded.sha256 !== initialChain.loaded.sha256
    || !sameIdentity(chain.loaded.identity, initialChain.loaded.identity)) {
    fail('prepared receipt changed after shared deployment lock acquisition')
  }
  if (!chain.value.holdGuardian) fail('retire requires one held post-CAS launch guardian')
  if (hasRestoreArtifact(values.pathname)) fail('restore artifacts block post-CAS retire')
  const attemptDirectory = dirname(values.pathname)
  const intentPath = retireIntentPath(values.pathname)
  const receiptPath = retireReceiptPath(values.pathname)
  const anchorPath = retireAnchorPath(values.pathname)
  const hasIntent = Boolean(optionalEntry(intentPath))
  const hasReceipt = Boolean(optionalEntry(receiptPath))
  const hasAnchor = Boolean(optionalEntry(anchorPath))
  if (hasAnchor && !hasReceipt) fail('retire commit marker exists without its receipt')
  if ((hasReceipt || hasAnchor) && !hasIntent) fail('retire artifacts exist without a retire intent')

  let retireIntent
  if (hasIntent) {
    retireIntent = validateRetireIntent(intentPath, chain, values.finalReadiness)
    validateRetireQuarantine(chain, retireIntent)
  } else {
    if (hasReceipt || hasAnchor) fail('retire artifact ordering is invalid')
    const first = await captureRetireSnapshot(chain, 'quiesced', values.finalReadiness)
    const second = await captureRetireSnapshot(chain, 'quiesced', values.finalReadiness)
    assertStable(first, second, 'post-CAS quiesced snapshot')
    const quarantine = validateRetireQuarantine(chain, null)
    const plan = chain.intent.value.launchGuardian
    const held = heldGuardianSample(plan, false)
    if (!held.owner) fail('post-CAS launch guardian owner is missing')
    if (pidExists(held.owner.value.pid, 'guardian owner')) validateHeldGuardian(plan)
    retireIntent = immutableJson(intentPath, {
      schema: RETIRE_INTENT_SCHEMA,
      createdAt: Math.floor(Date.now() / 1000),
      nonce: chain.value.nonce,
      toolSha256: toolSha256(),
      preparedReceiptPath: chain.loaded.identity.path,
      preparedReceiptSha256: chain.loaded.sha256,
      launchGuardian: plan,
      finalReadiness: second.finalReadiness,
      quarantine,
      evidence: retireInvariantProjection(second),
    })
    testKillAfter('RETIRE_INTENT')
    testFailAfter('RETIRE_INTENT')
  }

  const expected = retireIntent.value.evidence
  if (hasReceipt) {
    const receipt = validateRetireReceipt(receiptPath, chain, retireIntent, hasAnchor)
    if (!hasAnchor) {
      if (optionalEntry(chain.intent.value.launchGuardian.path)
        || optionalEntry(launchGuardianOwnerPath(chain.value.runtimeBefore.batchRoot))) {
        fail('retire receipt exists while launch guardian artifacts remain')
      }
      const active = await waitForRetireSnapshot(
        chain, 'active', values.finalReadiness, expected,
      )
      assertStable(receipt.value.runtimeActive, active, 'retire active runtime snapshot')
      writeAnchor(anchorPath, 'retire', receipt, chain.intent.sha256)
    } else {
      if (optionalEntry(chain.intent.value.launchGuardian.path)
        || optionalEntry(launchGuardianOwnerPath(chain.value.runtimeBefore.batchRoot))) {
        fail('committed retire still has launch guardian artifacts')
      }
      const active = await waitForRetireSnapshot(
        chain, 'active', values.finalReadiness, expected,
      )
      assertStable(receipt.value.runtimeActive, active, 'retire active runtime snapshot')
    }
    return {
      mode: 'retired',
      receipt: values.pathname,
      retireReceiptSha256: receipt.sha256,
    }
  }

  const runtime = await retireRuntimeState(chain, values.finalReadiness, expected)
  let active
  if (runtime.mode === 'quiesced') {
    assertStable(expected, retireInvariantProjection(runtime.snapshot), 'post-CAS retire evidence')
    let guardian = takeoverRetireGuardian(chain, attemptDirectory)
    try {
      const beforeHandoff = await captureRetireSnapshot(
        chain, 'quiesced', values.finalReadiness,
      )
      assertStable(expected, retireInvariantProjection(beforeHandoff), 'post-CAS retire evidence')
      validateRetireQuarantine(chain, retireIntent)
      guardian.verify()
      const handoffCleanup = guardian.handoff()
      guardian = null
      testKillAfter('RETIRE_GUARDIAN_HANDOFF')
      testFailAfter('RETIRE_GUARDIAN_HANDOFF')
      active = await enableAndStartAfterRetire(
        chain, values.finalReadiness, expected, handoffCleanup,
      )
    } catch (error) {
      // Never restore the quarantined workspace or reopen intake. Before
      // handoff the owned marker remains; after handoff either that marker or
      // the successor worker's global lock remains the safety barrier.
      throw error
    }
  } else {
    active = await resumeActiveRetireHandoff(
      chain,
      values.finalReadiness,
      expected,
      runtime.snapshot,
    )
  }
  validateRetireQuarantine(chain, retireIntent)
  const receipt = immutableJson(receiptPath, {
    schema: RETIRE_SCHEMA,
    createdAt: Math.floor(Date.now() / 1000),
    nonce: chain.value.nonce,
    toolSha256: toolSha256(),
    preparedReceiptPath: chain.loaded.identity.path,
    preparedReceiptSha256: chain.loaded.sha256,
    retireIntent: { path: intentPath, sha256: retireIntent.sha256, ...retireIntent.identity },
    runtimeActive: active,
  })
  testKillAfter('RETIRE_RECEIPT')
  testFailAfter('RETIRE_RECEIPT')
  writeAnchor(anchorPath, 'retire', receipt, chain.intent.sha256)
  testKillAfter('RETIRE_ANCHOR')
  return {
    mode: 'retired',
    receipt: values.pathname,
    retireReceiptSha256: receipt.sha256,
  }
}

async function retire(values) {
  if (hasRestoreArtifact(values.pathname)) fail('restore artifacts block post-CAS retire')
  const initialChain = validateReceipt(values.pathname, true, true, true)
  const deploymentLock = acquireSharedDeploymentLock()
  const attemptDirectory = dirname(values.pathname)
  let output
  try {
    testKillAfter('DEPLOYMENT_LOCK_SEALED')
    testFailAfter('DEPLOYMENT_LOCK_SEALED')
    chmodSync(attemptDirectory, 0o700)
    fsyncDirectory(attemptDirectory)
    output = await retireLocked(values, initialChain)
  } finally {
    try {
      chmodSync(attemptDirectory, 0o500)
      fsyncDirectory(attemptDirectory)
      fsyncDirectory(dirname(attemptDirectory))
    } finally {
      deploymentLock.release()
    }
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

async function recover(values) {
  const preparedReceipt = join(dirname(values.pathname), 'receipt.json')
  if (hasRetireArtifact(preparedReceipt)) fail('retire artifacts block SIGKILL recovery')
  const intent = readImmutableJson(values.pathname, 'runtime guard intent')
  const value = intent.value
  if (value?.schema !== INTENT_SCHEMA || !value.source?.root?.path || !value.target || !value.runtime
    || !supportedToolSha256(value.toolSha256) || !value.launchGuardian?.token) fail('runtime guard intent contract is invalid')
  const attemptDirectory = dirname(values.pathname)
  chmodSync(attemptDirectory, 0o700)
  fsyncDirectory(attemptDirectory)
  const guardianMarker = optionalEntry(value.launchGuardian.path)
  const guardianOwnerPath = launchGuardianOwnerPath(value.runtime.batchRoot)
  if (!guardianMarker && optionalEntry(guardianOwnerPath)) {
    removeDetachedGuardianOwner(value.runtime.batchRoot, value.launchGuardian)
  }
  const launchGuardian = openLaunchGuardian(
    value.runtime.batchRoot, attemptDirectory, value.launchGuardian, Boolean(guardianMarker),
  )
  try {
    const source = optionalEntry(value.source.root.path)
    const target = optionalEntry(value.target)
    if (source && !target) {
      if (optionalEntry(join(attemptDirectory, 'receipt.json'))
        || optionalEntry(join(attemptDirectory, 'receipt.anchor.json'))) {
        fail('pre-rename recovery has a conflicting committed receipt')
      }
      const sourceIdentity = identity(value.source.root.path, 'orphan workspace', 'directory', 0o700)
      if (!sameIdentity(sourceIdentity, value.source.root)) fail('pre-rename workspace identity changed')
      const tree = treeSnapshot(value.source.root.path, 'orphan workspace')
      if (tree.digest !== value.source.digest || tree.entries !== value.source.entries
        || tree.bytes !== value.source.bytes) fail('pre-rename workspace changed')
      launchGuardian.verify()
      let deadLock = recoverLockEvidence(value, attemptDirectory, false)
      if (!deadLock) {
        const stopped = await waitForSnapshot(value.minimumAgeSeconds, 'stopped')
        launchGuardian.verify()
        assertStable(stableComparable(value.runtime), stableComparable(stopped), 'recovered runtime identity')
        assertOldWorkerGone(value.runtime.lane.worker)
        assertLockUnopened(value.runtime.lane.lock.path)
        deadLock = quarantineDeadLock(value.runtime.lane.lock, stopped.lane.lock, attemptDirectory)
      }
      const quiesced = await waitForSnapshot(value.minimumAgeSeconds, 'quiesced')
      launchGuardian.verify()
      assertStable(stableComparable(value.runtime), stableComparable(quiesced), 'recovered runtime identity')
      launchGuardian.release()
      await enableAndStart(value.minimumAgeSeconds, value.runtime)
      process.stdout.write(`${JSON.stringify({ mode: 'recovered-before-rename', intent: values.pathname })}\n`)
      return
    }
    if (!source && target) {
      if (value.toolSha256 !== toolSha256()) {
        fail('the predecessor tool is recoverable only before the workspace rename')
      }
      const deadLock = recoverLockEvidence(value, attemptDirectory, true)
      const targetIdentity = identity(value.target, 'quarantined workspace', 'directory', 0o700)
      if (targetIdentity.dev !== value.source.root.dev || targetIdentity.ino !== value.source.root.ino) fail('post-SIGKILL target identity differs')
      const tree = treeSnapshot(value.target, 'quarantined workspace')
      if (tree.digest !== value.source.digest || tree.entries !== value.source.entries || tree.bytes !== value.source.bytes) fail('post-SIGKILL target tree differs')
      launchGuardian.verify()
      const quiesced = await waitForSnapshot(value.minimumAgeSeconds, 'quiesced')
      assertStable(stableComparable(value.runtime), stableComparable(quiesced), 'recovered runtime identity')
      const receiptPath = join(attemptDirectory, 'receipt.json')
      const anchorPath = join(attemptDirectory, 'receipt.anchor.json')
      if (optionalEntry(anchorPath) && !optionalEntry(receiptPath)) {
        fail('receipt commit marker exists without its receipt')
      }
      let receipt
      if (optionalEntry(receiptPath)) {
        const chain = validateReceipt(receiptPath, false, Boolean(optionalEntry(anchorPath)))
        receipt = chain.loaded
        if (!sameIdentity(chain.value.target, targetIdentity)
          || chain.value.tree.digest !== tree.digest || chain.value.runtimeQuiesced?.lane?.projection?.digest !== quiesced.lane.projection.digest) {
          fail('recovered receipt does not match the quarantined workspace')
        }
      } else {
        receipt = immutableJson(receiptPath, {
          schema: RECEIPT_SCHEMA,
          createdAt: Math.floor(Date.now() / 1000),
          nonce: value.nonce,
          toolSha256: value.toolSha256,
          holdGuardian: Boolean(value.holdGuardian),
          intent: { path: values.pathname, sha256: intent.sha256, ...intent.identity },
          minimumAgeSeconds: value.minimumAgeSeconds,
          runtimeBefore: value.runtime,
          runtimeQuiesced: quiesced,
          deadLock,
          launchGuardian: {
            path: value.launchGuardian.path,
            dev: value.launchGuardian.dev,
            ino: value.launchGuardian.ino,
            uid: value.launchGuardian.uid,
            mode: value.launchGuardian.mode,
            tokenSha256: value.launchGuardian.tokenSha256,
            createdAt: value.launchGuardian.createdAt,
            sourceSha256: launchGuardian.sourceSha256,
            markerPid: launchGuardian.markerPid,
          },
          source: value.source.root,
          target: targetIdentity,
          tree,
        })
      }
      if (!optionalEntry(anchorPath)) writeAnchor(anchorPath, 'receipt', receipt, intent.sha256)
      chmodSync(attemptDirectory, 0o500)
      fsyncDirectory(attemptDirectory)
      fsyncDirectory(dirname(attemptDirectory))
      if (value.holdGuardian) {
        const holdPromise = launchGuardian.hold()
        process.stdout.write(`${JSON.stringify({ mode: 'recovered-after-rename-held', receipt: receiptPath, receiptSha256: receipt.sha256, guardianPid: process.pid })}\n`)
        await holdPromise
      } else {
        launchGuardian.release()
        process.stdout.write(`${JSON.stringify({ mode: 'recovered-after-rename', receipt: receiptPath, receiptSha256: receipt.sha256 })}\n`)
      }
      return
    }
    fail('SIGKILL recovery state is ambiguous')
  } catch (error) {
    throw error
  }
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArguments(argv)
  if (values.command === 'prepare') return prepare(values)
  if (values.command === 'status') return status(values)
  if (values.command === 'restore') return restore(values)
  if (values.command === 'recover') return recover(values)
  return retire(values)
}

// Exported for the real-FD regression harness; the CLI remains the only
// production entry point.
export { closeBoundReadonlyDatabase, openBoundReadonlyDatabase }

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
