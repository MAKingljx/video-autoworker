#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPOSITORY_ROOT = realpathSync(join(dirname(SCRIPT_PATH), '..'))
const BACKUP_SCHEMA = 'video-autoworker-legacy-media-orphan-backup/v2'
const PREPARE_SCHEMA = 'video-autoworker-legacy-media-orphan-prepare/v1'
const CONFIRMATION_SCHEMA = 'video-autoworker-legacy-media-orphan-confirmation/v2'
const ERROR_CODE = 'LEGACY_MEDIA_ORPHAN_RECONCILED'
const VIDEO_LANE_LABEL = 'ai.aiworker.video-lane-supervisor'
const N8N_LABEL = 'com.video-autoworker.n8n'
const TASK_ID = /^[A-Za-z0-9._:-]{1,120}$/u
const RELEASE_ID = /^[a-f0-9]{7,40}(?:-runtime)?$/u
const SHA256 = /^[a-f0-9]{64}$/u
const TERMINAL_PARENT = new Set(['succeeded', 'failed', 'cancelled'])
const TERMINAL_EXECUTION = new Set(['success', 'error', 'crashed', 'canceled', 'cancelled'])
const ELIGIBLE_CHILD = new Set(['queued', 'accepted', 'running'])
const ELIGIBLE_STAGE = new Set(['prepare', 'audio', 'vision'])
const TEST_MODE = process.env.NODE_ENV === 'test'
  && process.env.AIWORKER_TEST_LEGACY_ORPHAN === '1'
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_DATABASE_BYTES = 64 * 1024 * 1024 * 1024
const PREPARE_TTL_SECONDS = 10 * 60
const BACKUP_MEMBER_NAMES = [
  'mission-control.db',
  'mission-control.db-wal',
  'mission-control.db-shm',
  'consistent-snapshot.db',
]
const PREPARE_DIRECTORY_MEMBERS = [
  ...BACKUP_MEMBER_NAMES,
  'backup-manifest.json',
  'prepare-manifest.json',
]
const FINAL_BACKUP_DIRECTORY = /^\d{4}-\d{2}-\d{2}T\d{9}Z-[a-f0-9]{12}$/u
const PENDING_BACKUP_DIRECTORY = /^\.pending-\d{4}-\d{2}-\d{2}T\d{9}Z-[a-f0-9]{12}$/u
const EXCLUSIVE_RENAME_HELPER = `
import ctypes
import os
import sys

root, source, destination = sys.argv[1:]
if '/' in source or '/' in destination or source in ('.', '..') or destination in ('.', '..'):
    raise SystemExit(80)
descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        operation = libc.renameatx_np
        flags = 0x00000004  # RENAME_EXCL
    elif sys.platform.startswith('linux'):
        operation = libc.renameat2
        flags = 0x00000001  # RENAME_NOREPLACE
    else:
        raise SystemExit(81)
    operation.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    operation.restype = ctypes.c_int
    result = operation(
        descriptor,
        os.fsencode(source),
        descriptor,
        os.fsencode(destination),
        flags,
    )
    if result != 0:
        raise SystemExit(82)
    os.fsync(descriptor)
finally:
    os.close(descriptor)
`.trim()

function fail(message) {
  throw new Error(`legacy media orphan reconciliation failed: ${message}`)
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

function strictJson(source, label, maximumBytes = MAX_JSON_BYTES) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > maximumBytes) fail(`${label} is too large`)
  let index = 0
  const whitespace = () => { while (/\s/u.test(source[index] || '')) index += 1 }
  const stringValue = () => {
    const start = index
    index += 1
    let escaped = false
    while (index < source.length) {
      const character = source[index]
      index += 1
      if (escaped) { escaped = false; continue }
      if (character === '\\') { escaped = true; continue }
      if (character === '"') {
        try { return JSON.parse(source.slice(start, index)) } catch { fail(`${label} contains an invalid string`) }
      }
      if (character.charCodeAt(0) < 0x20) fail(`${label} contains an invalid control character`)
    }
    fail(`${label} contains an unterminated string`)
  }
  const value = () => {
    whitespace()
    const character = source[index]
    if (character === '"') return stringValue()
    if (character === '{') {
      index += 1
      whitespace()
      const output = {}
      const keys = new Set()
      if (source[index] === '}') { index += 1; return output }
      while (index < source.length) {
        whitespace()
        if (source[index] !== '"') fail(`${label} object key is invalid`)
        const key = stringValue()
        if (keys.has(key)) fail(`${label} contains a duplicate JSON key`)
        keys.add(key)
        whitespace()
        if (source[index] !== ':') fail(`${label} object separator is invalid`)
        index += 1
        output[key] = value()
        whitespace()
        if (source[index] === '}') { index += 1; return output }
        if (source[index] !== ',') fail(`${label} object delimiter is invalid`)
        index += 1
      }
      fail(`${label} object is unterminated`)
    }
    if (character === '[') {
      index += 1
      whitespace()
      const output = []
      if (source[index] === ']') { index += 1; return output }
      while (index < source.length) {
        output.push(value())
        whitespace()
        if (source[index] === ']') { index += 1; return output }
        if (source[index] !== ',') fail(`${label} array delimiter is invalid`)
        index += 1
      }
      fail(`${label} array is unterminated`)
    }
    const remainder = source.slice(index)
    const token = remainder.match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u)?.[0]
    if (!token) fail(`${label} value is invalid`)
    index += token.length
    if (token === 'true') return true
    if (token === 'false') return false
    if (token === 'null') return null
    const number = Number(token)
    if (!Number.isFinite(number)) fail(`${label} number is invalid`)
    return number
  }
  const parsed = value()
  whitespace()
  if (index !== source.length) fail(`${label} has trailing content`)
  return parsed
}

function readJsonFile(pathname, label, requiredMode = null, maximumBytes = MAX_JSON_BYTES) {
  const entry = safeEntry(pathname, label, 'file', requiredMode)
  if (entry.size > BigInt(maximumBytes)) fail(`${label} is too large`)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      fail(`${label} changed before open`)
    }
    const source = readFileSync(descriptor, 'utf8')
    if (Buffer.byteLength(source) !== Number(opened.size)) fail(`${label} changed during read`)
    return { value: strictJson(source, label, maximumBytes), source, entry: opened }
  } finally { closeSync(descriptor) }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail(`${label} fields are invalid`)
  }
}

function positiveInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${label} is invalid`)
  return parsed
}

function nonNegativeInteger(value, label) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) fail(`${label} is invalid`)
  return parsed
}

function assertAbsolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} must be one normalized absolute path`)
}

function assertNoSymlink(pathname, label) {
  assertAbsolute(pathname, label)
  const root = parse(pathname).root
  let current = root
  for (const part of relative(root, pathname).split('/').filter(Boolean)) {
    current = join(current, part)
    let entry
    try { entry = lstatSync(current) } catch { fail(`${label} path component is unavailable`) }
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
  if (requiredMode === null ? (mode & 0o022) !== 0 : mode !== requiredMode) {
    fail(`${label} mode is unsafe`)
  }
  return entry
}

function identity(pathname, label, kind = 'file') {
  const entry = safeEntry(pathname, label, kind)
  return { path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString() }
}

function optionalEntry(pathname, label) {
  try { return lstatSync(pathname, { bigint: true }) } catch (error) {
    if (error?.code === 'ENOENT') return null
    fail(`${label} state is unreadable`)
  }
}

function directoryMemberNames(pathname, label) {
  safeEntry(pathname, label, 'directory')
  const names = []
  const handle = opendirSync(pathname)
  try {
    for (;;) {
      const entry = handle.readSync()
      if (!entry) break
      names.push(entry.name)
    }
  } finally { handle.closeSync() }
  return names.sort()
}

function assertExactDirectoryMembers(pathname, expected, label) {
  const names = directoryMemberNames(pathname, label)
  if (canonicalJson(names) !== canonicalJson([...expected].sort())) {
    fail(`${label} member set is invalid`)
  }
  for (const name of expected) safeEntry(join(pathname, name), `${label} member ${name}`, 'file', 0o400)
}

function assertNoSnapshotSidecars(pathname) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (optionalEntry(`${pathname}${suffix}`, 'authoritative snapshot sidecar')) {
      fail('authoritative snapshot retained an unmanaged SQLite sidecar')
    }
  }
}

function triggerPrepareFailpoint(name) {
  if (!TEST_MODE || process.env.AIWORKER_TEST_LEGACY_ORPHAN_PREPARE_FAILPOINT !== name) return
  if (process.env.AIWORKER_TEST_LEGACY_ORPHAN_FAILPOINT_ACTION === 'sigkill') {
    process.kill(process.pid, 'SIGKILL')
  }
  fail(`test prepare failpoint reached: ${name}`)
}

function occupyFinalDestinationForTest(pathname) {
  if (!TEST_MODE || process.env.AIWORKER_TEST_LEGACY_ORPHAN_OCCUPY_FINAL !== '1') return
  mkdirSync(pathname, { mode: 0o700 })
  const sentinel = join(pathname, 'do-not-overwrite')
  writeFileSync(sentinel, 'occupied\n', { mode: 0o400, flag: 'wx' })
  fsyncFile(sentinel)
  fsyncDirectory(pathname)
  fsyncDirectory(dirname(pathname))
}

function parseArguments(argv) {
  const booleanNames = new Set(['--prepare', '--apply'])
  const valueNames = new Set([
    '--backup-root', '--child-row-id', '--child-task-id', '--confirm-token', '--execution-id',
    '--expected-status', '--expected-updated-at', '--minimum-age-seconds', '--parent-task-id',
    '--prepare-manifest', '--stage',
  ])
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    if (booleanNames.has(name)) {
      if (Object.hasOwn(values, name)) fail(`${name} was supplied more than once`)
      values[name] = true
      continue
    }
    if (!valueNames.has(name) || Object.hasOwn(values, name) || index + 1 >= argv.length) {
      fail('arguments are invalid')
    }
    values[name] = argv[index + 1]
    index += 1
  }
  const prepare = values['--prepare'] === true
  const apply = values['--apply'] === true
  if (prepare && apply) fail('--prepare and --apply are mutually exclusive')
  if (apply) {
    const allowed = new Set(['--apply', '--prepare-manifest', '--confirm-token'])
    if (Object.keys(values).some(name => !allowed.has(name))
      || !values['--prepare-manifest'] || !/^confirm-[a-f0-9]{64}$/u.test(values['--confirm-token'] || '')) {
      fail('--apply accepts only --prepare-manifest and --confirm-token')
    }
    assertAbsolute(values['--prepare-manifest'], 'prepare manifest')
    return {
      mode: 'apply',
      prepareManifest: values['--prepare-manifest'],
      confirmToken: values['--confirm-token'],
    }
  }
  if (Object.hasOwn(values, '--prepare-manifest') || Object.hasOwn(values, '--confirm-token')) {
    fail('--prepare-manifest and --confirm-token are valid only with --apply')
  }
  const required = [
    '--child-row-id', '--child-task-id', '--execution-id', '--expected-status',
    '--expected-updated-at', '--minimum-age-seconds', '--parent-task-id', '--stage',
  ]
  if (required.some(name => !Object.hasOwn(values, name))) fail(`required arguments: ${required.join(', ')}`)
  if (prepare ? !values['--backup-root'] : Object.hasOwn(values, '--backup-root')) {
    fail(prepare ? '--prepare requires --backup-root' : '--backup-root is valid only with --prepare')
  }
  if (!TASK_ID.test(values['--child-task-id']) || !TASK_ID.test(values['--parent-task-id'])) {
    fail('task identity is invalid')
  }
  if (!ELIGIBLE_CHILD.has(values['--expected-status'])) fail('expected child status is invalid')
  if (!ELIGIBLE_STAGE.has(values['--stage'])) fail('only non-finalize media stages are eligible')
  const minimumAgeSeconds = positiveInteger(values['--minimum-age-seconds'], 'minimum age')
  if (minimumAgeSeconds < 900 || minimumAgeSeconds > 30 * 24 * 60 * 60) {
    fail('minimum age must be between 900 and 2592000 seconds')
  }
  if (prepare) assertAbsolute(values['--backup-root'], 'backup root')
  return {
    mode: prepare ? 'prepare' : 'dry-run',
    backupRoot: values['--backup-root'] || null,
    childRowId: positiveInteger(values['--child-row-id'], 'child row ID'),
    childTaskId: values['--child-task-id'],
    executionId: positiveInteger(values['--execution-id'], 'n8n execution ID'),
    expectedStatus: values['--expected-status'],
    expectedUpdatedAt: nonNegativeInteger(values['--expected-updated-at'], 'expected updated time'),
    minimumAgeSeconds,
    parentTaskId: values['--parent-task-id'],
    stage: values['--stage'],
  }
}

function testPath(name, production) {
  if (!TEST_MODE || !process.env[name]) return production
  assertAbsolute(process.env[name], name)
  return process.env[name]
}

function run(command, args, label) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  } catch {
    fail(`${label} failed`)
  }
}

function runStatus(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
}

function command(name, production) {
  return testPath(`AIWORKER_TEST_LEGACY_ORPHAN_${name}`, production)
}

function parseLsof(source) {
  const records = []
  let current = null
  for (const line of source.split('\n')) {
    if (!line) continue
    if (line[0] === 'f') {
      current = { descriptor: line.slice(1) }
      records.push(current)
    } else if (current && line[0] === 'D') current.dev = BigInt(line.slice(1)).toString()
    else if (current && line[0] === 'i') current.ino = BigInt(line.slice(1)).toString()
    else if (current && line[0] === 'n') current.path = line.slice(1)
  }
  return records
}

function cwdIdentity(records, label) {
  const cwd = records.filter(record => record.descriptor === 'cwd')
  if (cwd.length !== 1 || !cwd[0].path || cwd[0].dev === undefined || cwd[0].ino === undefined) {
    fail(`${label} cwd is unavailable`)
  }
  const expected = identity(cwd[0].path, `${label} cwd`, 'directory')
  exactOpenIdentity(records, expected, `${label} cwd`, /^cwd$/u)
  return expected
}

function releaseIdFromCwd(pathname, label) {
  const parts = pathname.split('/')
  const index = parts.lastIndexOf('releases')
  const releaseId = index >= 0 ? parts[index + 1] : ''
  if (!RELEASE_ID.test(releaseId || '')) fail(`${label} cwd is not inside a named release`)
  return releaseId
}

function processFields(pid, records, label) {
  const uid = nonNegativeInteger(run(command('PS', '/bin/ps'), [
    '-p', String(pid), '-o', 'uid=',
  ], `${label} uid`).trim(), `${label} uid`)
  const ppid = positiveInteger(run(command('PS', '/bin/ps'), [
    '-p', String(pid), '-o', 'ppid=',
  ], `${label} parent`).trim(), `${label} parent`)
  const startTime = run(command('PS', '/bin/ps'), [
    '-p', String(pid), '-o', 'lstart=',
  ], `${label} start time`).trim()
  const argv = run(command('PS', '/bin/ps'), [
    '-ww', '-p', String(pid), '-o', 'command=',
  ], `${label} argv`).trim()
  if (!startTime || !argv || uid !== process.getuid()) fail(`${label} process identity is invalid`)
  const cwd = cwdIdentity(records, label)
  let executablePath = null
  if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_PROC_PIDPATH) {
    executablePath = run(testPath('AIWORKER_TEST_LEGACY_ORPHAN_PROC_PIDPATH', ''), [
      String(pid),
    ], `${label} executable path`).trim()
  }
  const text = records.filter(record => record.descriptor === 'txt'
    && record.path && record.dev !== undefined && record.ino !== undefined)
  if (executablePath) {
    assertAbsolute(executablePath, `${label} executable path`)
    if (text.filter(record => record.path === executablePath).length !== 1) {
      fail(`${label} executable path is not one text mapping`)
    }
  } else {
    const nodeText = text.filter(record => /\/bin\/node$/u.test(record.path))
    if (nodeText.length !== 1) fail(`${label} does not have exactly one Node executable text mapping`)
    executablePath = nodeText[0].path
  }
  const executable = identity(executablePath, `${label} executable`)
  exactOpenIdentity(records, executable, `${label} executable`, /^txt$/u)
  return {
    pid,
    ppid,
    uid,
    startTime,
    argvSha256: sha256(argv),
    cwd,
    executable,
    releaseId: releaseIdFromCwd(cwd.path, label),
  }
}

function listenerPid(port) {
  const source = run(command('LSOF', '/usr/sbin/lsof'), [
    '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp',
  ], `${port} listener query`)
  const pids = [...new Set(source.split('\n').filter(line => /^p[1-9][0-9]*$/u.test(line))
    .map(line => Number(line.slice(1))))]
  if (pids.length !== 1) fail(`port ${port} does not have exactly one listener`)
  return pids[0]
}

function openRecords(pid) {
  return parseLsof(run(command('LSOF', '/usr/sbin/lsof'), [
    '-a', '-p', String(pid), '-FfDin',
  ], `PID ${pid} open-file query`))
}

function exactOpenIdentity(records, expected, label, descriptors = null) {
  const matches = records.filter(record => record.path === expected.path
    && record.dev === expected.dev && record.ino === expected.ino
    && (!descriptors || descriptors.test(record.descriptor || '')))
  if (matches.length < 1) fail(`${label} is not bound to the process open-file identity`)
}

function numericDatabaseRecords(records) {
  return records.filter(record => /^\d+[A-Za-z]*$/u.test(record.descriptor || '')
    && record.dev !== undefined && record.ino !== undefined)
}

function validateNewDatabaseConnection(expected, beforeRecords, afterRecords, label) {
  const current = identity(expected.path, label)
  if (canonicalJson(current) !== canonicalJson(expected)) {
    fail(`${label} does not match the precaptured identity`)
  }
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

function revalidateDatabaseConnection(expected, descriptor, label) {
  const current = identity(expected.path, label)
  const matches = numericDatabaseRecords(openRecords(process.pid))
    .filter(record => record.descriptor === descriptor && record.path === expected.path
      && record.dev === expected.dev && record.ino === expected.ino)
  if (canonicalJson(current) !== canonicalJson(expected) || matches.length !== 1) {
    fail(`${label} SQLite connection identity changed`)
  }
}

function findDatabase(records, matcher, label) {
  const paths = [...new Set(records.filter(record => matcher.test(record.path || ''))
    .map(record => record.path))]
  if (paths.length !== 1) fail(`${label} process does not have exactly one authoritative database`)
  const database = identity(paths[0], label)
  exactOpenIdentity(records, database, label, /^\d+[A-Za-z]*$/u)
  return database
}

function launchPid(label) {
  const output = run(command('LAUNCHCTL', '/bin/launchctl'), [
    'print', `gui/${process.getuid()}/${label}`,
  ], `${label} LaunchAgent query`)
  const matches = [...output.matchAll(/^\s*pid = ([1-9][0-9]*)\s*$/gmu)]
  if (matches.length !== 1 || !/^\s*state = running\s*$/mu.test(output)) {
    fail(`${label} is not one running LaunchAgent job`)
  }
  return Number(matches[0][1])
}

function supervisorState() {
  const launchctl = command('LAUNCHCTL', '/bin/launchctl')
  const service = `gui/${process.getuid()}/${VIDEO_LANE_LABEL}`
  const loaded = runStatus(launchctl, ['print', service]).status === 0
  const disabledSource = run(launchctl, [
    'print-disabled', `gui/${process.getuid()}`,
  ], 'video-lane disabled-state query')
  const escaped = VIDEO_LANE_LABEL.replaceAll('.', '\\.')
  const disabled = new RegExp(
    `"?${escaped}"?\\s*=>\\s*(?:true|disabled)`,
    'u',
  ).test(disabledSource)
  const batchRoot = testPath(
    'AIWORKER_TEST_LEGACY_ORPHAN_BATCH_ROOT',
    join(process.env.HOME, 'ai-worker/state/video-autoworker/video-batches'),
  )
  const lockPath = join(batchRoot, '.global-video-worker.lock')
  let lockAbsent = false
  try {
    if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_LSTAT_ERROR_PATH === lockPath) {
      const error = new Error('injected lstat failure')
      error.code = 'EACCES'
      throw error
    }
    lstatSync(lockPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') fail('video-lane global lock state is unreadable')
    lockAbsent = true
  }
  const workers = runStatus(command('PGREP', '/usr/bin/pgrep'), [
    '-f', 'run-video-batch\\.mjs .*--serve-root',
  ])
  const workerPids = workerPidsFromPgrep(workers.status, workers.stdout, workers.error)
  if (loaded || !disabled || !lockAbsent
    || workerPids.some(value => !Number.isSafeInteger(value) || value <= 0)
    || workerPids.length !== 0) {
    fail('video-lane supervisor is not disabled, unloaded, worker-free, and lock-free')
  }
  return { disabled, loaded, lockAbsent, workerPids }
}

function workerPidsFromPgrep(status, stdout, error = null) {
  if (error || ![0, 1].includes(status) || typeof stdout !== 'string'
    || (status === 1 && stdout.trim())) fail('video worker process query failed')
  const values = status === 1 ? [] : stdout.trim().split(/\s+/u).filter(Boolean).map(Number)
  if (values.some(value => !Number.isSafeInteger(value) || value <= 0)) {
    fail('video worker process query failed')
  }
  return values
}

async function queueState() {
  let source
  if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_QUEUE_FILE) {
    const pathname = testPath('AIWORKER_TEST_LEGACY_ORPHAN_QUEUE_FILE', '')
    source = readJsonFile(pathname, 'test queue projection').source
  } else {
    let response
    try {
      response = await fetch('http://127.0.0.1:3017/api/n8n/runs?view=queue', {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(8_000),
      })
    } catch { fail('persistent queue endpoint is unavailable') }
    if (!response.ok) fail(`persistent queue endpoint returned HTTP ${response.status}`)
    try { source = await response.text() } catch { fail('persistent queue endpoint body is unavailable') }
  }
  const value = strictJson(source, 'persistent queue projection')
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('persistent queue shape is invalid')
  exactKeys(value.counts, ['attention', 'running', 'waiting'], 'persistent queue counts')
  if (!Array.isArray(value.queue) || nonNegativeInteger(value.total, 'persistent queue total') !== value.queue.length) {
    fail('persistent queue shape is invalid')
  }
  const projection = value.queue.map(item => ({
    taskId: String(item?.taskId || ''),
    status: String(item?.status || ''),
    updatedAt: item?.updatedAt,
    stale: item?.stale,
    sourceAvailable: item?.sourceAvailable,
  }))
  if (projection.some(item => !TASK_ID.test(item.taskId) || !item.status
    || !Number.isSafeInteger(item.updatedAt) || typeof item.stale !== 'boolean'
    || ![true, false, null].includes(item.sourceAvailable))) {
    fail('persistent queue item is invalid')
  }
  const attention = nonNegativeInteger(value.counts.attention, 'queue attention')
  const waiting = nonNegativeInteger(value.counts.waiting, 'queue waiting')
  const running = nonNegativeInteger(value.counts.running, 'queue running')
  if (waiting !== 0 || running !== 0) fail('persistent queue still has waiting or running work')
  return { attention, waiting, running, total: value.queue.length, digest: sha256(canonicalJson(projection)) }
}

function loadDatabase() {
  try {
    const scopedRequire = createRequire(import.meta.url)
    return scopedRequire(scopedRequire.resolve('better-sqlite3', { paths: [REPOSITORY_ROOT] }))
  } catch { fail('better-sqlite3 is unavailable') }
}

function openDatabase(Database, pathname, readonly = true) {
  const entry = safeEntry(pathname, 'SQLite database', 'file')
  if (entry.size > BigInt(MAX_DATABASE_BYTES)) fail('SQLite database is too large')
  const verifierFd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  const verifier = fstatSync(verifierFd, { bigint: true })
  if (verifier.dev !== entry.dev || verifier.ino !== entry.ino || verifier.size !== entry.size) {
    closeSync(verifierFd)
    fail('SQLite database changed before verifier open')
  }
  const expected = { path: pathname, dev: verifier.dev.toString(), ino: verifier.ino.toString() }
  const before = openRecords(process.pid)
  const db = new Database(pathname, { readonly, fileMustExist: true })
  try {
    const connectionDescriptor = validateNewDatabaseConnection(
      expected, before, openRecords(process.pid), 'SQLite database connection',
    )
    if (readonly) db.pragma('query_only = ON')
    if (db.pragma('quick_check', { simple: true }) !== 'ok') fail('SQLite quick_check did not return ok')
    revalidateDatabaseConnection(expected, connectionDescriptor, 'SQLite database connection')
    return {
      db,
      verifier: { dev: expected.dev, ino: expected.ino },
      verifierFd,
      connection: { descriptor: connectionDescriptor, identity: expected },
    }
  } catch (error) {
    try { db.close() } catch {}
    closeSync(verifierFd)
    throw error
  }
}

function closeDatabase(handle) {
  try {
    revalidateDatabaseConnection(
      handle.connection.identity, handle.connection.descriptor, 'SQLite database connection',
    )
  } finally {
    try { handle.db.close() } finally { closeSync(handle.verifierFd) }
  }
}

function normalizeAuthoritativeSnapshot(Database, pathname) {
  const handle = openDatabase(Database, pathname, false)
  try {
    const journalMode = String(handle.db.pragma('journal_mode = DELETE', { simple: true })).toLowerCase()
    if (journalMode !== 'delete') fail('authoritative snapshot journal mode is not self-contained')
    if (handle.db.pragma('quick_check', { simple: true }) !== 'ok') {
      fail('authoritative snapshot quick_check failed after journal normalization')
    }
  } finally { closeDatabase(handle) }
  assertNoSnapshotSidecars(pathname)
  fsyncFile(pathname)
  fsyncDirectory(dirname(pathname))
}

function tableColumns(db, table, required) {
  const columns = new Set(db.pragma(`table_info(${table})`).map(row => row.name))
  if (required.some(name => !columns.has(name))) fail(`${table} schema is unavailable`)
  return columns
}

function parseObject(value, label) {
  const parsed = strictJson(value, label)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`${label} is not an object`)
  return parsed
}

function mediaChildTaskId(parentTaskId, stage) {
  const digest = sha256(`${parentTaskId}:${stage}`).slice(0, 24)
  return `media-task:${parentTaskId.slice(0, 70)}:${stage}:${digest}`.slice(0, 120)
}

function rowDigest(row) {
  return sha256(canonicalJson(row))
}

function validateMissionTarget(db, input, now) {
  tableColumns(db, 'n8n_task_runs', [
    'id', 'task_id', 'binding_id', 'status', 'source', 'routing', 'error', 'output', 'attempt_count',
    'max_attempts', 'workspace_id', 'tenant_id', 'created_at', 'accepted_at', 'started_at',
    'completed_at', 'updated_at',
  ])
  tableColumns(db, 'n8n_workflow_bindings', ['id', 'task_type', 'workspace_id', 'tenant_id'])
  const child = db.prepare('SELECT * FROM n8n_task_runs WHERE id = ? AND task_id = ?')
    .get(input.childRowId, input.childTaskId)
  if (!child) fail('expected child row was not found')
  if (child.source !== 'n8n-media-node' || child.status !== input.expectedStatus
    || child.updated_at !== input.expectedUpdatedAt || !ELIGIBLE_CHILD.has(child.status)) {
    fail('child identity or expected state changed')
  }
  const routing = parseObject(child.routing, 'child routing')
  if (routing.mediaStage !== input.stage || input.stage === 'finalize'
    || child.task_id !== mediaChildTaskId(input.parentTaskId, input.stage)) {
    fail('child is not the expected deterministic non-finalize media stage')
  }
  if (now - child.updated_at < input.minimumAgeSeconds) fail('child has not exceeded the explicit stale threshold')
  const parent = db.prepare('SELECT * FROM n8n_task_runs WHERE task_id = ?').get(input.parentTaskId)
  const parentRouting = parent ? parseObject(parent.routing, 'parent routing') : null
  if (!parent || !['openclaw', 'video-autoworker'].includes(parent.source)
    || parentRouting?.taskType !== 'video-analysis'
    || !TERMINAL_PARENT.has(parent.status) || parent.completed_at === null
    || parent.binding_id !== child.binding_id || parent.workspace_id !== child.workspace_id
    || parent.tenant_id !== child.tenant_id) {
    fail('parent is missing, non-terminal, or outside the child identity scope')
  }
  const binding = db.prepare(`
    SELECT task_type FROM n8n_workflow_bindings
    WHERE id = ? AND workspace_id = ? AND tenant_id = ?
  `).get(child.binding_id, child.workspace_id, child.tenant_id)
  if (binding?.task_type !== 'video-analysis') fail('child binding is not the video workflow')
  const activeMedia = db.prepare(`
    SELECT id FROM n8n_task_runs
    WHERE source = 'n8n-media-node' AND status IN ('queued', 'accepted', 'running')
    ORDER BY id
  `).all()
  if (activeMedia.length !== 1 || activeMedia[0].id !== child.id) {
    fail('another active media child exists')
  }
  const leaseTable = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'n8n_child_execution_leases'
  `).get()
  if (leaseTable) {
    const lease = db.prepare('SELECT 1 FROM n8n_child_execution_leases WHERE task_id = ?').get(child.task_id)
    if (lease) fail('child still has an execution lease')
  }
  const others = db.prepare(`
    SELECT id, task_id, status, source, updated_at, completed_at, error, output
    FROM n8n_task_runs WHERE id <> ? ORDER BY id
  `).all(child.id)
  return {
    child,
    parent,
    parentDigest: rowDigest(parent),
    othersDigest: rowDigest(others),
  }
}

function flattedReference(table, value, label) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(value)) {
    fail(`${label} is not one n8n flatted reference`)
  }
  const index = Number(value)
  if (!Number.isSafeInteger(index) || index < 0 || index >= table.length) {
    fail(`${label} points outside n8n execution data`)
  }
  return table[index]
}

function flattedObject(table, value, label) {
  const output = flattedReference(table, value, label)
  if (!output || typeof output !== 'object' || Array.isArray(output)) {
    fail(`${label} is not one n8n flatted object`)
  }
  return output
}

function flattedArray(table, value, label) {
  const output = flattedReference(table, value, label)
  if (!Array.isArray(output)) fail(`${label} is not one n8n flatted array`)
  return output
}

function flattedString(table, value, label) {
  const output = flattedReference(table, value, label)
  if (typeof output !== 'string') fail(`${label} is not one n8n flatted string`)
  return output
}

function n8nWebhookOwner(source, input) {
  const table = strictJson(source, 'n8n execution data')
  if (!Array.isArray(table) || table.length < 2 || table.length > 100_000
    || !table[0] || typeof table[0] !== 'object' || Array.isArray(table[0])) {
    fail('n8n execution data is not one flatted execution payload')
  }
  const root = table[0]
  const resultData = flattedObject(table, root.resultData, 'n8n resultData')
  const runData = flattedObject(table, resultData.runData, 'n8n runData')
  if (!Object.hasOwn(runData, 'AI-worker Video Webhook')) {
    fail('n8n execution data is missing the video webhook run')
  }
  const runs = flattedArray(
    table, runData['AI-worker Video Webhook'], 'n8n video webhook runs',
  )
  if (runs.length !== 1) fail('n8n execution data does not have one video webhook run')
  const owners = []
  for (const [runIndex, runReference] of runs.entries()) {
    const run = flattedObject(table, runReference, `n8n video webhook run ${runIndex}`)
    const data = flattedObject(table, run.data, `n8n video webhook run ${runIndex} data`)
    const main = flattedArray(table, data.main, `n8n video webhook run ${runIndex} main`)
    for (const [branchIndex, branchReference] of main.entries()) {
      const branch = flattedArray(
        table, branchReference, `n8n video webhook run ${runIndex} branch ${branchIndex}`,
      )
      for (const [itemIndex, itemReference] of branch.entries()) {
        const item = flattedObject(
          table, itemReference,
          `n8n video webhook run ${runIndex} branch ${branchIndex} item ${itemIndex}`,
        )
        const json = flattedObject(table, item.json, 'n8n video webhook item JSON')
        const body = flattedObject(table, json.body, 'n8n video webhook body')
        const headers = flattedObject(table, json.headers, 'n8n video webhook headers')
        const taskId = flattedString(table, body.taskId, 'n8n video webhook task ID')
        const idempotencyKey = flattedString(
          table, body.idempotencyKey, 'n8n video webhook idempotency key',
        )
        const headerIdempotencyKey = flattedString(
          table, headers['x-aiworker-idempotency-key'], 'n8n video webhook idempotency header',
        )
        owners.push({ taskId, idempotencyKey, headerIdempotencyKey })
      }
    }
  }
  if (owners.length !== 1 || owners[0].taskId !== input.parentTaskId
    || owners[0].idempotencyKey !== input.parentTaskId
    || owners[0].headerIdempotencyKey !== input.parentTaskId
    || !TASK_ID.test(owners[0].taskId)) {
    fail('n8n execution data is not uniquely owned by the expected parent task')
  }
  return { owner: owners[0], digest: sha256(canonicalJson(table)) }
}

function validateN8n(db, input) {
  tableColumns(db, 'execution_entity', ['id', 'workflowId', 'status', 'stoppedAt'])
  tableColumns(db, 'execution_data', ['executionId', 'data'])
  const active = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM execution_entity
    WHERE status IN ('new', 'running', 'waiting') AND "stoppedAt" IS NULL
  `).get().count)
  if (active !== 0) fail('n8n still has active executions')
  const execution = db.prepare(`
    SELECT id, workflowId, status, "stoppedAt" AS stoppedAt
    FROM execution_entity WHERE id = ?
  `).get(input.executionId)
  if (!execution || execution.workflowId !== 'aiworker-video-analysis-v1'
    || !TERMINAL_EXECUTION.has(String(execution.status).toLowerCase()) || execution.stoppedAt === null) {
    fail('corresponding n8n execution is missing or not terminal')
  }
  const dataRows = db.prepare('SELECT data FROM execution_data WHERE executionId = ?').all(input.executionId)
  if (dataRows.length !== 1 || typeof dataRows[0].data !== 'string') {
    fail('n8n execution data is not bound to the expected parent task')
  }
  const binding = n8nWebhookOwner(dataRows[0].data, input)
  return {
    ...execution,
    executionDataDigest: binding.digest,
    parentBindingCount: 1,
  }
}

function activeProcessGuard(input, missionPath) {
  const workspaceDigest = sha256(input.parentTaskId)
  const workspace = join(dirname(missionPath), 'media-tasks', workspaceDigest)
  try {
    if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_LSTAT_ERROR_PATH === workspace) {
      const error = new Error('injected lstat failure')
      error.code = 'EACCES'
      throw error
    }
    lstatSync(workspace)
    fail('target media workspace still exists')
  } catch (error) {
    if (String(error?.message || '').includes('workspace still exists')) throw error
    if (error?.code !== 'ENOENT') fail('target media workspace state is unreadable')
  }
  const output = run(command('PS', '/bin/ps'), ['-axo', 'pid=,ppid=,command='], 'process inventory')
  const excluded = new Set([process.pid])
  let cursor = process.ppid
  for (let index = 0; cursor > 1 && index < 32; index += 1) {
    excluded.add(cursor)
    const parent = runStatus(command('PS', '/bin/ps'), ['-p', String(cursor), '-o', 'ppid='])
    if (parent.status !== 0) break
    const next = Number(parent.stdout.trim())
    if (!Number.isSafeInteger(next) || next <= 0 || next === cursor) break
    cursor = next
  }
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*([1-9][0-9]*)\s+([0-9]+)\s+(.*)$/u)
    if (!match || excluded.has(Number(match[1]))) continue
    const commandLine = match[3]
    if ([input.childTaskId, input.parentTaskId, workspaceDigest].some(value => commandLine.includes(value))) {
      fail('a live process still references the target task')
    }
  }
  return workspaceDigest
}

async function capturePlatform() {
  const pid3017 = listenerPid(3017)
  const n8nPid = listenerPid(5678)
  const legacyRecords = openRecords(pid3017)
  const n8nRecords = openRecords(n8nPid)
  const legacy = processFields(pid3017, legacyRecords, 'legacy 3017')
  const n8nProcess = processFields(n8nPid, n8nRecords, 'n8n')
  const mission = findDatabase(legacyRecords, /\/mission-control\.db$/u, 'Mission Control database')
  const n8n = findDatabase(n8nRecords, /\/database\.sqlite$/u, 'n8n database')
  const n8nLaunchPid = launchPid(N8N_LABEL)
  if (n8nProcess.ppid !== n8nLaunchPid) {
    fail('n8n listener is not the direct child of its LaunchAgent')
  }
  const supervisor = supervisorState()
  const queue = await queueState()
  return {
    legacy: { ...legacy, port: 3017, database: mission },
    n8n: { ...n8nProcess, port: 5678, launchPid: n8nLaunchPid, database: n8n },
    supervisor,
    queue,
  }
}

function stablePlatform(first, second) {
  if (canonicalJson(first) !== canonicalJson(second)) fail('runtime identity or external gate state changed between samples')
}

function fileFingerprint(pathname, label) {
  const entry = safeEntry(pathname, label, 'file')
  if (entry.size > BigInt(MAX_DATABASE_BYTES)) fail(`${label} is too large`)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      fail(`${label} changed before open`)
    }
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytes = 0
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null)
      if (count === 0) break
      digest.update(buffer.subarray(0, count))
      bytes += count
      if (bytes > MAX_DATABASE_BYTES) fail(`${label} is too large`)
    }
    const closed = fstatSync(descriptor, { bigint: true })
    if (closed.dev !== opened.dev || closed.ino !== opened.ino || closed.size !== opened.size
      || BigInt(bytes) !== opened.size) fail(`${label} changed during read`)
    return {
      name: basename(pathname),
      bytes,
      sha256: digest.digest('hex'),
      dev: opened.dev.toString(),
      ino: opened.ino.toString(),
    }
  } finally { closeSync(descriptor) }
}

function isWithin(candidate, root) {
  const value = relative(root, candidate)
  return value === '' || (!value.startsWith('..') && !isAbsolute(value))
}

function overlaps(first, second) {
  return isWithin(first, second) || isWithin(second, first)
}

function fsyncFile(pathname) {
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function fsyncDirectory(pathname) {
  const expected = safeEntry(pathname, 'directory fsync target', 'directory')
  const descriptor = openSync(
    pathname,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== expected.dev || opened.ino !== expected.ino
      || opened.uid !== expected.uid || opened.mode !== expected.mode) {
      fail('directory fsync target changed before open')
    }
    fsyncSync(descriptor)
    const closed = fstatSync(descriptor, { bigint: true })
    if (closed.dev !== opened.dev || closed.ino !== opened.ino
      || closed.uid !== opened.uid || closed.mode !== opened.mode) {
      fail('directory fsync target changed during fsync')
    }
  } finally { closeSync(descriptor) }
  const current = safeEntry(pathname, 'directory fsync target', 'directory')
  if (current.dev !== expected.dev || current.ino !== expected.ino
    || current.uid !== expected.uid || current.mode !== expected.mode) {
    fail('directory fsync target changed after fsync')
  }
}

function renameDirectoryExclusive(root, source, destination) {
  const sourceName = basename(source)
  const destinationName = basename(destination)
  if (dirname(source) !== root || dirname(destination) !== root
    || !PENDING_BACKUP_DIRECTORY.test(sourceName)
    || !FINAL_BACKUP_DIRECTORY.test(destinationName)) {
    fail('exclusive directory rename arguments are invalid')
  }
  run('/usr/bin/python3', [
    '-I', '-S', '-c', EXCLUSIVE_RENAME_HELPER, root, sourceName, destinationName,
  ], 'exclusive directory rename')
}

function writeImmutableJson(pathname, value, mode = 0o400) {
  const temporary = join(dirname(pathname), `.${basename(pathname)}.${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(temporary, `${canonicalJson(value)}\n`, { mode: 0o600, flag: 'wx' })
  fsyncFile(temporary)
  renameSync(temporary, pathname)
  chmodSync(pathname, mode)
  fsyncFile(pathname)
  const verified = readJsonFile(pathname, basename(pathname), mode)
  if (canonicalJson(verified.value) !== canonicalJson(value)) fail(`${basename(pathname)} verification failed`)
  return { path: pathname, source: verified.source, sha256: sha256(verified.source) }
}

function currentToolSha256() {
  if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_TOOL_SHA) {
    if (!SHA256.test(process.env.AIWORKER_TEST_LEGACY_ORPHAN_TOOL_SHA)) fail('test tool SHA is invalid')
    return process.env.AIWORKER_TEST_LEGACY_ORPHAN_TOOL_SHA
  }
  return sha256(readFileSync(SCRIPT_PATH))
}

async function inspectLiveState(Database, input) {
  const platform = await capturePlatform()
  const missionHandle = openDatabase(Database, platform.legacy.database.path, true)
  const n8nHandle = openDatabase(Database, platform.n8n.database.path, true)
  try {
    const now = Math.floor(Date.now() / 1_000)
    const target = validateMissionTarget(missionHandle.db, input, now)
    const execution = validateN8n(n8nHandle.db, input)
    const workspaceDigest = activeProcessGuard(input, platform.legacy.database.path)
    return {
      legacy: platform.legacy,
      n8n: platform.n8n,
      mission: { database: platform.legacy.database, verifier: missionHandle.verifier },
      queue: platform.queue,
      supervisor: platform.supervisor,
      target: {
        child: target.child,
        parentDigest: target.parentDigest,
        othersDigest: target.othersDigest,
      },
      execution,
      workspaceDigest,
    }
  } finally {
    closeDatabase(missionHandle)
    closeDatabase(n8nHandle)
  }
}

async function stableLiveState(Database, input) {
  const first = await inspectLiveState(Database, input)
  const second = await inspectLiveState(Database, input)
  if (canonicalJson(first) !== canonicalJson(second)) {
    fail('runtime, target, execution, or external gate state changed between samples')
  }
  return second
}

async function createRollbackBackup(Database, evidence, input) {
  safeEntry(input.backupRoot, 'backup root', 'directory', 0o700)
  const backupRoot = realpathSync(input.backupRoot)
  if ([
    REPOSITORY_ROOT,
    dirname(evidence.mission.database.path),
    dirname(evidence.n8n.database.path),
    evidence.legacy.cwd.path,
    evidence.n8n.cwd.path,
  ].some(pathname => overlaps(backupRoot, pathname))) {
    fail('backup root overlaps source, repository, or runtime data')
  }
  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, '')
  const backupNonce = randomBytes(32).toString('hex')
  const finalName = `${stamp}-${backupNonce.slice(0, 12)}`
  const finalDir = join(backupRoot, finalName)
  const backupDir = join(backupRoot, `.pending-${finalName}`)
  if (optionalEntry(finalDir, 'final backup destination')
    || optionalEntry(backupDir, 'pending backup destination')) {
    fail('backup destination already exists')
  }
  mkdirSync(backupDir, { mode: 0o700 })
  safeEntry(backupDir, 'pending backup directory', 'directory', 0o700)
  // Persist an explicitly incomplete, private staging entry before copying any
  // database bytes. Only a completely sealed prepare may enter the final
  // backup-family namespace.
  fsyncDirectory(backupRoot)
  triggerPrepareFailpoint('pending-created')
  const missionPath = evidence.mission.database.path
  const sources = [missionPath, `${missionPath}-wal`, `${missionPath}-shm`]
  for (const pathname of sources) {
    try { safeEntry(pathname, 'Mission Control SQLite/WAL/SHM source member', 'file') } catch (error) {
      fail(`Mission Control SQLite/WAL/SHM source set is incomplete: ${error.message}`)
    }
  }
  const before = sources.map((pathname, index) => fileFingerprint(pathname, `source backup member ${index}`))
  const copies = sources.map(pathname => join(backupDir, basename(pathname)))
  for (let index = 0; index < sources.length; index += 1) {
    copyFileSync(sources[index], copies[index], constants.COPYFILE_EXCL)
    chmodSync(copies[index], 0o400)
    fsyncFile(copies[index])
  }
  triggerPrepareFailpoint('raw-copies-created')
  const after = sources.map((pathname, index) => fileFingerprint(pathname, `source backup member ${index}`))
  if (canonicalJson(before) !== canonicalJson(after)) fail('SQLite source changed while creating rollback backup')
  const rawCopied = copies.map((pathname, index) => fileFingerprint(pathname, `copied backup member ${index}`))
  for (let index = 0; index < rawCopied.length; index += 1) {
    if (rawCopied[index].bytes !== before[index].bytes || rawCopied[index].sha256 !== before[index].sha256) {
      fail('rollback backup content does not match the source set')
    }
  }
  // Raw SQLite/WAL/SHM copies are forensic evidence only. The SQLite backup
  // snapshot below is the sole authoritative rollback database.
  const snapshotPath = join(backupDir, 'consistent-snapshot.db')
  const sourceDb = openDatabase(Database, missionPath, true)
  try { await sourceDb.db.backup(snapshotPath) } finally { closeDatabase(sourceDb) }
  normalizeAuthoritativeSnapshot(Database, snapshotPath)
  chmodSync(snapshotPath, 0o400)
  fsyncFile(snapshotPath)
  const backupDb = openDatabase(Database, snapshotPath, true)
  try {
    const backupTarget = validateMissionTarget(backupDb.db, input, Math.floor(Date.now() / 1_000))
    if (rowDigest(backupTarget.child) !== rowDigest(evidence.target.child)
      || backupTarget.parentDigest !== evidence.target.parentDigest
      || backupTarget.othersDigest !== evidence.target.othersDigest) {
      fail('authoritative rollback snapshot does not match prepared state')
    }
  } finally { closeDatabase(backupDb) }
  assertNoSnapshotSidecars(snapshotPath)
  triggerPrepareFailpoint('snapshot-created')
  const memberPaths = [...copies, snapshotPath]
  assertExactDirectoryMembers(backupDir, BACKUP_MEMBER_NAMES, 'backup directory')
  const copied = [...rawCopied, fileFingerprint(snapshotPath, 'consistent backup snapshot')]
  const manifest = {
    schema: BACKUP_SCHEMA,
    createdAt: Math.floor(Date.now() / 1_000),
    nonce: backupNonce,
    target: {
      childRowId: input.childRowId,
      childTaskId: input.childTaskId,
      parentTaskId: input.parentTaskId,
      stage: input.stage,
      status: input.expectedStatus,
      updatedAt: input.expectedUpdatedAt,
    },
    members: copied.map((item, index) => ({
      name: item.name,
      bytes: item.bytes,
      sha256: item.sha256,
      role: index < before.length ? 'forensic' : 'authoritative',
      sourceDev: index < before.length ? before[index].dev : null,
      sourceIno: index < before.length ? before[index].ino : null,
    })),
    quickCheck: 'ok',
  }
  const manifestPath = join(backupDir, 'backup-manifest.json')
  const writtenManifest = writeImmutableJson(manifestPath, manifest)
  assertExactDirectoryMembers(
    backupDir, [...BACKUP_MEMBER_NAMES, 'backup-manifest.json'], 'backup directory',
  )
  const directoryFd = openSync(backupDir, constants.O_RDONLY)
  try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
  const verified = readJsonFile(manifestPath, 'backup manifest', 0o400).value
  if (canonicalJson(verified) !== canonicalJson(manifest)
    || verified.members.some((item, index) => fileFingerprint(memberPaths[index], `verified member ${index}`).sha256 !== item.sha256)) {
    fail('rollback backup manifest verification failed')
  }
  triggerPrepareFailpoint('backup-manifest-created')
  return {
    backupRoot,
    backupDir,
    finalDir,
    manifestPath,
    manifest,
    manifestSha256: writtenManifest.sha256,
  }
}

function manifestInput(input) {
  return {
    childRowId: input.childRowId,
    childTaskId: input.childTaskId,
    executionId: input.executionId,
    expectedStatus: input.expectedStatus,
    expectedUpdatedAt: input.expectedUpdatedAt,
    minimumAgeSeconds: input.minimumAgeSeconds,
    parentTaskId: input.parentTaskId,
    stage: input.stage,
  }
}

function validateManifestInput(value) {
  exactKeys(value, [
    'childRowId', 'childTaskId', 'executionId', 'expectedStatus', 'expectedUpdatedAt',
    'minimumAgeSeconds', 'parentTaskId', 'stage',
  ], 'prepare input')
  return parseArguments([
    '--child-row-id', String(value.childRowId), '--child-task-id', String(value.childTaskId),
    '--execution-id', String(value.executionId), '--expected-status', String(value.expectedStatus),
    '--expected-updated-at', String(value.expectedUpdatedAt), '--minimum-age-seconds', String(value.minimumAgeSeconds),
    '--parent-task-id', String(value.parentTaskId), '--stage', String(value.stage),
  ])
}

function preparedEvidence(manifest) {
  return {
    legacy: manifest.legacy,
    n8n: manifest.n8n,
    mission: manifest.mission,
    queue: manifest.queue,
    supervisor: manifest.supervisor,
    target: manifest.target,
    execution: manifest.execution,
    workspaceDigest: manifest.workspaceDigest,
  }
}

function confirmationToken(prepareSha256, backupSha256, manifest) {
  return `confirm-${sha256(canonicalJson({
    schema: CONFIRMATION_SCHEMA,
    prepareManifestSha256: prepareSha256,
    backupManifestSha256: backupSha256,
    nonce: manifest.nonce,
    expiresAt: manifest.expiresAt,
    uid: manifest.uid,
  }))}`
}

async function createPrepare(Database, input, evidence) {
  const backup = await createRollbackBackup(Database, evidence, input)
  const createdAt = Math.floor(Date.now() / 1_000)
  const manifest = {
    schema: PREPARE_SCHEMA,
    toolSha256: currentToolSha256(),
    createdAt,
    expiresAt: createdAt + PREPARE_TTL_SECONDS,
    nonce: randomBytes(32).toString('hex'),
    handoffNonce: randomBytes(32).toString('hex'),
    uid: process.getuid(),
    input: manifestInput(input),
    legacy: evidence.legacy,
    n8n: evidence.n8n,
    mission: evidence.mission,
    queue: evidence.queue,
    supervisor: evidence.supervisor,
    target: evidence.target,
    execution: evidence.execution,
    workspaceDigest: evidence.workspaceDigest,
    backupManifest: { name: basename(backup.manifestPath), sha256: backup.manifestSha256 },
  }
  const preparePath = join(backup.backupDir, 'prepare-manifest.json')
  const written = writeImmutableJson(preparePath, manifest)
  chmodSync(backup.backupDir, 0o500)
  fsyncDirectory(backup.backupDir)
  assertExactDirectoryMembers(backup.backupDir, PREPARE_DIRECTORY_MEMBERS, 'prepare directory')
  const staged = loadPreparedArtifact(Database, preparePath, true)
  if (staged.prepareSha256 !== written.sha256
    || staged.backup.sha256 !== backup.manifestSha256
    || canonicalJson(staged.manifest) !== canonicalJson(manifest)) {
    fail('sealed pending prepare verification failed')
  }
  triggerPrepareFailpoint('before-publish')

  const pendingIdentity = safeEntry(backup.backupDir, 'pending prepare directory', 'directory', 0o500)
  if (optionalEntry(backup.finalDir, 'final backup destination')) {
    fail('final backup destination appeared before publish')
  }
  occupyFinalDestinationForTest(backup.finalDir)
  renameDirectoryExclusive(backup.backupRoot, backup.backupDir, backup.finalDir)
  const finalIdentity = safeEntry(backup.finalDir, 'published prepare directory', 'directory', 0o500)
  if (finalIdentity.dev !== pendingIdentity.dev || finalIdentity.ino !== pendingIdentity.ino
    || finalIdentity.nlink !== pendingIdentity.nlink) {
    fail('published prepare directory identity changed during rename')
  }
  if (optionalEntry(backup.backupDir, 'pending backup destination')) {
    fail('pending backup directory remained after publish')
  }
  fsyncDirectory(backup.finalDir)
  fsyncDirectory(backup.backupRoot)
  triggerPrepareFailpoint('after-publish')

  const finalPreparePath = join(backup.finalDir, 'prepare-manifest.json')
  const published = loadPreparedArtifact(Database, finalPreparePath)
  if (published.prepareSha256 !== written.sha256
    || published.backup.sha256 !== backup.manifestSha256
    || canonicalJson(published.manifest) !== canonicalJson(manifest)) {
    fail('published prepare verification failed')
  }
  fsyncDirectory(backup.finalDir)
  fsyncDirectory(backup.backupRoot)
  const token = confirmationToken(published.prepareSha256, published.backup.sha256, published.manifest)
  return {
    path: finalPreparePath,
    sha256: written.sha256,
    token,
    manifest,
    backup: {
      ...backup,
      backupDir: backup.finalDir,
      manifestPath: join(backup.finalDir, 'backup-manifest.json'),
    },
  }
}

function validateBackupManifest(Database, directory, prepared, backupReference, input) {
  assertExactDirectoryMembers(directory, PREPARE_DIRECTORY_MEMBERS, 'prepare directory')
  exactKeys(backupReference, ['name', 'sha256'], 'backup manifest reference')
  if (backupReference.name !== 'backup-manifest.json' || !SHA256.test(backupReference.sha256)) {
    fail('backup manifest reference is invalid')
  }
  const pathname = join(directory, backupReference.name)
  const loaded = readJsonFile(pathname, 'backup manifest', 0o400)
  if (sha256(loaded.source) !== backupReference.sha256) fail('backup manifest SHA does not match prepare manifest')
  const manifest = loaded.value
  exactKeys(manifest, ['createdAt', 'members', 'nonce', 'quickCheck', 'schema', 'target'], 'backup manifest')
  if (manifest.schema !== BACKUP_SCHEMA || !SHA256.test(manifest.nonce)
    || manifest.quickCheck !== 'ok' || !Number.isSafeInteger(manifest.createdAt)) {
    fail('backup manifest identity is invalid')
  }
  exactKeys(manifest.target, [
    'childRowId', 'childTaskId', 'parentTaskId', 'stage', 'status', 'updatedAt',
  ], 'backup target')
  if (canonicalJson(manifest.target) !== canonicalJson({
    childRowId: input.childRowId,
    childTaskId: input.childTaskId,
    parentTaskId: input.parentTaskId,
    stage: input.stage,
    status: input.expectedStatus,
    updatedAt: input.expectedUpdatedAt,
  })) fail('backup target does not match prepare input')
  if (!Array.isArray(manifest.members) || manifest.members.length !== 4) fail('backup members are invalid')
  const expectedNames = new Set(BACKUP_MEMBER_NAMES)
  let authoritative = null
  for (const member of manifest.members) {
    exactKeys(member, ['bytes', 'name', 'role', 'sha256', 'sourceDev', 'sourceIno'], 'backup member')
    if (!expectedNames.delete(member.name) || !['forensic', 'authoritative'].includes(member.role)
      || !Number.isSafeInteger(member.bytes) || member.bytes < 0 || !SHA256.test(member.sha256)) {
      fail('backup member is invalid')
    }
    if ((member.name === 'consistent-snapshot.db') !== (member.role === 'authoritative')) {
      fail('backup member role is invalid')
    }
    const memberPath = join(directory, member.name)
    const entry = safeEntry(memberPath, `backup member ${member.name}`, 'file', 0o400)
    if (entry.size !== BigInt(member.bytes)) fail('backup member size changed')
    if (fileFingerprint(memberPath, `backup member ${member.name}`).sha256 !== member.sha256) {
      fail('backup member content changed')
    }
    if (member.role === 'authoritative') authoritative = memberPath
  }
  if (expectedNames.size !== 0 || !authoritative) fail('backup member set is incomplete')
  const snapshot = openDatabase(Database, authoritative, true)
  try {
    if (String(snapshot.db.pragma('journal_mode', { simple: true })).toLowerCase() !== 'delete') {
      fail('authoritative rollback snapshot journal mode is not self-contained')
    }
    const target = validateMissionTarget(snapshot.db, input, prepared.createdAt)
    if (rowDigest(target.child) !== rowDigest(prepared.target.child)
      || target.parentDigest !== prepared.target.parentDigest
      || target.othersDigest !== prepared.target.othersDigest) {
      fail('authoritative rollback snapshot state changed')
    }
  } finally { closeDatabase(snapshot) }
  assertNoSnapshotSidecars(authoritative)
  assertExactDirectoryMembers(directory, PREPARE_DIRECTORY_MEMBERS, 'prepare directory')
  return { manifest, pathname, sha256: backupReference.sha256 }
}

function loadPreparedArtifact(Database, pathname, allowPending = false) {
  if (basename(pathname) !== 'prepare-manifest.json') fail('prepare manifest filename is invalid')
  const directory = dirname(pathname)
  const directoryName = basename(directory)
  if (!FINAL_BACKUP_DIRECTORY.test(directoryName)
    && !(allowPending && PENDING_BACKUP_DIRECTORY.test(directoryName))) {
    fail('prepare manifest is not in a managed backup directory')
  }
  safeEntry(directory, 'prepare directory', 'directory', 0o500)
  const loaded = readJsonFile(pathname, 'prepare manifest', 0o400)
  const manifest = loaded.value
  exactKeys(manifest, [
    'backupManifest', 'createdAt', 'execution', 'expiresAt', 'handoffNonce', 'input', 'legacy',
    'mission', 'n8n', 'nonce', 'queue', 'schema', 'supervisor', 'target', 'toolSha256', 'uid',
    'workspaceDigest',
  ], 'prepare manifest')
  const now = Math.floor(Date.now() / 1_000)
  if (manifest.schema !== PREPARE_SCHEMA || !SHA256.test(manifest.toolSha256)
    || !SHA256.test(manifest.nonce) || !SHA256.test(manifest.handoffNonce)
    || manifest.uid !== process.getuid() || !Number.isSafeInteger(manifest.createdAt)
    || !Number.isSafeInteger(manifest.expiresAt) || manifest.createdAt > now + 30
    || manifest.expiresAt !== manifest.createdAt + PREPARE_TTL_SECONDS || now > manifest.expiresAt) {
    fail('prepare manifest is invalid or expired')
  }
  if (manifest.toolSha256 !== currentToolSha256()) fail('reconciliation tool changed after prepare')
  const input = validateManifestInput(manifest.input)
  const backup = validateBackupManifest(Database, directory, manifest, manifest.backupManifest, input)
  const prepareSha256 = sha256(loaded.source)
  return { manifest, input, backup, prepareSha256 }
}

function loadPreparedApply(Database, pathname, suppliedToken) {
  const prepared = loadPreparedArtifact(Database, pathname)
  const expectedToken = confirmationToken(
    prepared.prepareSha256,
    prepared.backup.sha256,
    prepared.manifest,
  )
  if (suppliedToken !== expectedToken) fail('confirmation token does not match immutable prepare evidence')
  return { ...prepared, expectedToken }
}

function reconcileInsideImmediate(Database, evidence, input) {
  const missionHandle = openDatabase(Database, evidence.mission.database.path, false)
  const mission = missionHandle.db
  let committed = false
  try {
    mission.pragma('busy_timeout = 5000')
    mission.exec('BEGIN IMMEDIATE')
    const now = Math.floor(Date.now() / 1_000)
    activeProcessGuard(input, evidence.mission.database.path)
    const target = validateMissionTarget(mission, input, now)
    if (rowDigest(target.child) !== rowDigest(evidence.target.child)
      || target.parentDigest !== evidence.target.parentDigest
      || target.othersDigest !== evidence.target.othersDigest) {
      fail('Mission Control state changed after confirmation')
    }
    const n8n = openDatabase(Database, evidence.n8n.database.path, true)
    try {
      if (canonicalJson(validateN8n(n8n.db, input)) !== canonicalJson(evidence.execution)) {
        fail('n8n execution changed after confirmation')
      }
    } finally { closeDatabase(n8n) }
    const error = `[${ERROR_CODE}] 历史媒体子记录已在父任务和对应执行终态、无运行资源时受管收敛`
    const result = mission.prepare(`
      UPDATE n8n_task_runs
      SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND task_id = ? AND source = 'n8n-media-node'
        AND status = ? AND updated_at = ? AND routing = ?
        AND binding_id = ? AND workspace_id = ? AND tenant_id = ?
    `).run(
      error, now, now,
      evidence.target.child.id, evidence.target.child.task_id, evidence.target.child.status,
      evidence.target.child.updated_at, evidence.target.child.routing,
      evidence.target.child.binding_id, evidence.target.child.workspace_id, evidence.target.child.tenant_id,
    )
    if (result.changes !== 1) fail('child compare-and-swap update did not affect exactly one row')
    const updated = mission.prepare('SELECT * FROM n8n_task_runs WHERE id = ?').get(evidence.target.child.id)
    const parent = mission.prepare('SELECT * FROM n8n_task_runs WHERE task_id = ?').get(input.parentTaskId)
    const others = mission.prepare(`
      SELECT id, task_id, status, source, updated_at, completed_at, error, output
      FROM n8n_task_runs WHERE id <> ? ORDER BY id
    `).all(evidence.target.child.id)
    if (!updated || updated.status !== 'failed' || updated.error !== error
      || updated.completed_at !== now || updated.updated_at !== now
      || evidence.target.parentDigest !== rowDigest(parent)
      || evidence.target.othersDigest !== rowDigest(others)) {
      fail('write-back verification detected an unexpected row change')
    }
    const child = evidence.target.child
    const unchanged = { ...updated, status: child.status, error: child.error,
      completed_at: child.completed_at, updated_at: child.updated_at }
    if (rowDigest(unchanged) !== rowDigest(child)) fail('fields outside the controlled child transition changed')
    if (mission.pragma('quick_check', { simple: true }) !== 'ok') fail('post-write quick_check failed')
    mission.exec('COMMIT')
    committed = true
    return updated
  } finally {
    if (!committed) {
      try { mission.exec('ROLLBACK') } catch {}
    }
    closeDatabase(missionHandle)
  }
}

function verifyPostCommitZero(Database, platform, input) {
  const mission = openDatabase(Database, platform.legacy.database.path, true)
  const n8n = openDatabase(Database, platform.n8n.database.path, true)
  try {
    const mediaActive = Number(mission.db.prepare(`
      SELECT COUNT(*) AS count FROM n8n_task_runs
      WHERE source = 'n8n-media-node' AND status IN ('queued', 'accepted', 'running')
    `).get().count)
    if (mediaActive !== 0) fail('post-commit media active count did not reach zero')
    validateN8n(n8n.db, input)
    activeProcessGuard(input, platform.legacy.database.path)
  } finally {
    closeDatabase(mission)
    closeDatabase(n8n)
  }
}

async function main() {
  const argumentsValue = parseArguments(process.argv.slice(2))
  safeEntry(REPOSITORY_ROOT, 'repository root', 'directory')
  const Database = loadDatabase()
  if (argumentsValue.mode !== 'apply') {
    const evidence = await stableLiveState(Database, argumentsValue)
    if (argumentsValue.mode === 'dry-run') {
      process.stdout.write(`${JSON.stringify({
        mode: 'dry-run',
        eligible: true,
        childRowId: argumentsValue.childRowId,
        stage: argumentsValue.stage,
        prepareRequired: true,
      })}\n`)
      return
    }
    const prepared = await createPrepare(Database, argumentsValue, evidence)
    process.stdout.write(`${JSON.stringify({
      mode: 'prepare',
      eligible: true,
      childRowId: argumentsValue.childRowId,
      stage: argumentsValue.stage,
      expiresAt: prepared.manifest.expiresAt,
      prepareManifest: prepared.path,
      prepareManifestSha256: prepared.sha256,
      backupManifestSha256: prepared.backup.manifestSha256,
      confirmationToken: prepared.token,
    })}\n`)
    return
  }
  const prepared = loadPreparedApply(
    Database,
    argumentsValue.prepareManifest,
    argumentsValue.confirmToken,
  )
  const expected = preparedEvidence(prepared.manifest)
  const live = await stableLiveState(Database, prepared.input)
  if (canonicalJson(live) !== canonicalJson(expected)) {
    fail('live state drifted after prepare; run prepare and obtain confirmation again')
  }
  if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_BEFORE_WRITE_COMMAND) {
    run(testPath('AIWORKER_TEST_LEGACY_ORPHAN_BEFORE_WRITE_COMMAND', ''), [], 'test pre-write hook')
  }
  const finalPlatform = await capturePlatform()
  if (canonicalJson({
    legacy: finalPlatform.legacy,
    n8n: finalPlatform.n8n,
    queue: finalPlatform.queue,
    supervisor: finalPlatform.supervisor,
  }) !== canonicalJson({
    legacy: expected.legacy,
    n8n: expected.n8n,
    queue: expected.queue,
    supervisor: expected.supervisor,
  })) fail('runtime or external gate state changed immediately before write')
  const updated = reconcileInsideImmediate(Database, expected, prepared.input)
  const postPlatform = await capturePlatform()
  if (canonicalJson({ legacy: finalPlatform.legacy, n8n: finalPlatform.n8n,
    supervisor: finalPlatform.supervisor }) !== canonicalJson({
    legacy: postPlatform.legacy, n8n: postPlatform.n8n, supervisor: postPlatform.supervisor,
  })) fail('runtime identity changed after commit')
  verifyPostCommitZero(Database, postPlatform, prepared.input)
  const post = openDatabase(Database, finalPlatform.legacy.database.path, true)
  try {
    const row = post.db.prepare('SELECT status, error, completed_at, updated_at FROM n8n_task_runs WHERE id = ?')
      .get(prepared.input.childRowId)
    if (!row || row.status !== 'failed' || !String(row.error || '').startsWith(`[${ERROR_CODE}]`)
      || row.completed_at === null || row.updated_at !== updated.updated_at
      || post.db.pragma('quick_check', { simple: true }) !== 'ok') {
      fail('committed child state or quick_check could not be verified')
    }
  } finally { closeDatabase(post) }
  process.stdout.write(`${JSON.stringify({
    mode: 'apply',
    reconciled: true,
    childRowId: prepared.input.childRowId,
    stage: prepared.input.stage,
    handoffNonce: prepared.manifest.handoffNonce,
    postApplyQueueDigestSha256: postPlatform.queue.digest,
    backupManifestSha256: prepared.backup.sha256,
    othersDigest: prepared.manifest.target.othersDigest,
    handoffReady: false,
    releaseDecision: 'NO-GO',
  })}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
