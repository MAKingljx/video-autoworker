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
import { createRequire, isBuiltin, registerHooks } from 'node:module'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPOSITORY_ROOT = realpathSync(join(dirname(SCRIPT_PATH), '..'))
const SUBMISSION_LOCK_MODULE_PATH = join(
  REPOSITORY_ROOT,
  'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
)
const BACKUP_SCHEMA = 'video-autoworker-legacy-media-orphan-backup/v2'
const PREPARE_SCHEMA = 'video-autoworker-legacy-media-orphan-prepare/v3'
const CONFIRMATION_SCHEMA = 'video-autoworker-legacy-media-orphan-confirmation/v3'
const ERROR_CODE = 'LEGACY_MEDIA_ORPHAN_RECONCILED'
const PARENT_ERROR_CODE = 'VIDEO_CALLBACK_LEASE_EXPIRED'
const VIDEO_LANE_LABEL = 'ai.aiworker.video-lane-supervisor'
const N8N_LABEL = 'com.video-autoworker.n8n'
const QWEN_CURRENT_LABEL = 'ai.openclaw.qwen-current'
const QWEN_CURRENT_GATEWAY_PORT = 18889
const TASK_ID = /^[A-Za-z0-9._:-]{1,120}$/u
const RELEASE_ID = /^[a-f0-9]{7,40}(?:-runtime)?$/u
const SHA256 = /^[a-f0-9]{64}$/u
const TERMINAL_PARENT = new Set(['succeeded', 'failed', 'cancelled'])
const TERMINAL_EXECUTION = new Set(['success', 'error', 'crashed', 'canceled', 'cancelled'])
const ELIGIBLE_CHILD = new Set(['queued', 'accepted', 'running'])
const ELIGIBLE_STAGE = new Set(['prepare', 'audio', 'vision'])
const PARENT_STALE_SECONDS = 24 * 60 * 60
const TEST_MODE = process.env.NODE_ENV === 'test'
  && process.env.AIWORKER_TEST_LEGACY_ORPHAN === '1'
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_DATABASE_BYTES = 64 * 1024 * 1024 * 1024
const MAX_TOOL_CLOSURE_BYTES = 32 * 1024 * 1024
const MAX_TOOL_CLOSURE_MEMBERS = 128
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
const PARENT_KNOWN_MIGRATIONS = [
  '049_n8n_workflow_bindings',
  '050_n8n_task_runs',
  '051_n8n_media_cleanup_debts',
  '052_n8n_intake_controls',
  '053_scheduler_leader_lease',
  '054_n8n_task_dispatch_leases',
  '055_n8n_child_execution_leases',
  '056_n8n_parent_execution_claims',
  '057_n8n_director_evidence_outbox',
  '058_director_extraction_task_runs',
  '059_director_evidence_projection_receipts',
]
const PARENT_CORE_MIGRATIONS = PARENT_KNOWN_MIGRATIONS.slice(0, 2)
const PARENT_MODERN_MIGRATIONS = PARENT_KNOWN_MIGRATIONS.slice(2, 9)
const PARENT_SCHEMA_TABLES = [
  ['schema_migrations', ['id', 'applied_at']],
  ['n8n_workflow_bindings', [
    'id', 'name', 'description', 'workflow_id', 'webhook_path', 'task_type', 'agent_role', 'model',
    'timeout_seconds', 'retry_count', 'enabled', 'config', 'workspace_id', 'tenant_id',
    'created_by', 'created_at', 'updated_at', 'last_run_at', 'last_status',
  ]],
  ['n8n_task_runs', [
    'id', 'task_id', 'idempotency_key', 'binding_id', 'status', 'source', 'requested_by', 'routing',
    'input', 'delivery', 'output', 'error', 'attempt_count', 'max_attempts', 'workspace_id',
    'tenant_id', 'created_at', 'accepted_at', 'started_at', 'completed_at', 'updated_at',
  ]],
  ['n8n_media_cleanup_debts', [
    'task_id', 'binding_id', 'workspace_id', 'tenant_id', 'workspace_digest', 'reason',
    'attempt_count', 'last_error', 'next_attempt_at', 'created_at', 'updated_at',
  ]],
  ['n8n_intake_controls', [
    'control_id', 'accepting', 'reason', 'changed_by_id', 'changed_by_name', 'changed_at', 'revision',
  ]],
  ['n8n_intake_control_events', [
    'id', 'action', 'before_accepting', 'after_accepting', 'reason', 'actor_id', 'actor_name',
    'control_revision', 'created_at',
  ]],
  ['scheduler_leader_leases', [
    'lease_name', 'holder_id', 'lease_expires_at', 'revision', 'updated_at',
  ]],
  ['n8n_task_dispatch_leases', [
    'task_id', 'tenant_id', 'workspace_id', 'owner_token', 'lease_expires_at', 'revision',
    'created_at', 'updated_at',
  ]],
  ['n8n_child_execution_leases', [
    'task_id', 'tenant_id', 'workspace_id', 'owner_instance_id', 'lease_token', 'lease_expires_at',
    'heartbeat_at', 'revision', 'created_at', 'updated_at',
  ]],
  ['n8n_parent_execution_claims', [
    'task_id', 'tenant_id', 'workspace_id', 'execution_owner', 'created_at', 'updated_at',
  ]],
  ['n8n_director_evidence_outbox', [
    'task_id', 'binding_id', 'tenant_id', 'workspace_id', 'work_id', 'query_digest',
    'projection_contract_digest', 'idempotency_key', 'result_sha256', 'status', 'attempt_count',
    'next_attempt_at', 'last_error_code', 'delivered_at', 'created_at', 'updated_at',
  ]],
]
const PARENT_ANCILLARY_TABLES = [
  'n8n_media_cleanup_debts',
  'n8n_task_dispatch_leases',
  'n8n_child_execution_leases',
  'n8n_parent_execution_claims',
  'n8n_director_evidence_outbox',
]
const PARENT_EPOCH_SUPPORT_TABLES = [
  'n8n_intake_controls',
  'n8n_intake_control_events',
  'scheduler_leader_leases',
]
const FINAL_BACKUP_DIRECTORY = /^\d{4}-\d{2}-\d{2}T\d{9}Z-[a-f0-9]{12}$/u
const PENDING_BACKUP_DIRECTORY = /^\.pending-\d{4}-\d{2}-\d{2}T\d{9}Z-[a-f0-9]{12}$/u
const EXCLUSIVE_RENAME_HELPER = `
import ctypes
import errno
import os
import sys

def fail_errno(value):
    code = int(value or 0)
    try:
        summary = os.strerror(code)
    except (OverflowError, ValueError):
        summary = 'Unknown error'
    sys.stderr.write(f'errno={code} strerror={summary}\\n')
    raise SystemExit(82)

root, source, destination, expected_dev, expected_ino, expected_uid, expected_nlink = sys.argv[1:]
if '/' in source or '/' in destination or source in ('.', '..') or destination in ('.', '..'):
    raise SystemExit(80)
try:
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
except OSError as error:
    fail_errno(error.errno or errno.EIO)
source_descriptor = None
try:
    try:
        source_descriptor = os.open(
            source,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=descriptor,
        )
        source_identity = os.fstat(source_descriptor)
    except OSError as error:
        fail_errno(error.errno or errno.EIO)
    if (
        str(source_identity.st_dev) != expected_dev
        or str(source_identity.st_ino) != expected_ino
        or str(source_identity.st_uid) != expected_uid
        or str(source_identity.st_nlink) != expected_nlink
        or (source_identity.st_mode & 0o7777) != 0o500
    ):
        fail_errno(errno.ESTALE)
    try:
        if sys.platform == 'darwin':
            libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
            operation = libc.renameatx_np
            flags = 0x00000004  # RENAME_EXCL
        elif sys.platform.startswith('linux'):
            libc = ctypes.CDLL(None, use_errno=True)
            operation = libc.renameat2
            flags = 0x00000001  # RENAME_NOREPLACE
        else:
            raise SystemExit(81)
    except (AttributeError, OSError) as error:
        fail_errno(getattr(error, 'errno', None) or errno.ENOSYS)
    # macOS 15 requires the source directory itself to be owner-writable for
    # renameatx_np(RENAME_EXCL). Keep this permission window on the already
    # verified directory FD, then restore the sealed mode before returning.
    try:
        os.fchmod(source_descriptor, 0o700)
        os.fsync(source_descriptor)
    except OSError as error:
        fail_errno(error.errno or errno.EIO)
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
        operation_errno = ctypes.get_errno()
        try:
            os.fchmod(source_descriptor, 0o500)
            os.fsync(source_descriptor)
        except OSError as error:
            fail_errno(error.errno or errno.EIO)
        fail_errno(operation_errno)
    try:
        os.fchmod(source_descriptor, 0o500)
        os.fsync(source_descriptor)
        published_identity = os.fstat(source_descriptor)
        if (
            str(published_identity.st_dev) != expected_dev
            or str(published_identity.st_ino) != expected_ino
            or str(published_identity.st_uid) != expected_uid
            or str(published_identity.st_nlink) != expected_nlink
            or (published_identity.st_mode & 0o7777) != 0o500
        ):
            fail_errno(errno.ESTALE)
        os.fsync(descriptor)
    except OSError as error:
        fail_errno(error.errno or errno.EIO)
finally:
    if source_descriptor is not None:
        os.close(source_descriptor)
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
  const booleanNames = new Set(['--prepare', '--apply', '--parent-pre-media'])
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
  const parentPreMedia = values['--parent-pre-media'] === true
  if (parentPreMedia) {
    const allowed = new Set([
      '--parent-pre-media', '--minimum-age-seconds',
      ...(prepare ? ['--prepare', '--backup-root'] : []),
    ])
    if (Object.keys(values).some(name => !allowed.has(name))) {
      fail('parent pre-media mode does not accept business identifiers')
    }
    if (!Object.hasOwn(values, '--minimum-age-seconds')) {
      fail('parent pre-media mode requires --minimum-age-seconds')
    }
    if (prepare ? !values['--backup-root'] : Object.hasOwn(values, '--backup-root')) {
      fail(prepare ? '--prepare requires --backup-root' : '--backup-root is valid only with --prepare')
    }
    const minimumAgeSeconds = positiveInteger(values['--minimum-age-seconds'], 'minimum age')
    if (minimumAgeSeconds < PARENT_STALE_SECONDS || minimumAgeSeconds > 30 * 24 * 60 * 60) {
      fail('parent minimum age must be between 86400 and 2592000 seconds')
    }
    if (prepare) assertAbsolute(values['--backup-root'], 'backup root')
    return {
      mode: prepare ? 'prepare' : 'dry-run',
      targetKind: 'parent-pre-media',
      backupRoot: values['--backup-root'] || null,
      minimumAgeSeconds,
    }
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
    targetKind: 'media-child',
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

function errnoDiagnostic(error) {
  const stderr = error && typeof error === 'object' && 'stderr' in error
    ? String(error.stderr || '').trim()
    : ''
  const match = stderr.match(/^errno=(\d{1,5}) strerror=([\p{L}\p{N} .,:'()_-]{1,120})$/u)
  return match ? `errno=${match[1]} strerror=${match[2]}` : 'errno=0 strerror=unavailable'
}

function run(command, args, label, diagnostic = 'none') {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    const detail = diagnostic === 'errno' ? `: ${errnoDiagnostic(error)}` : ''
    fail(`${label} failed${detail}`)
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

function absentListenerState(port) {
  const result = runStatus(command('LSOF', '/usr/sbin/lsof'), [
    '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp',
  ])
  if (result.error || result.signal || ![0, 1].includes(result.status)
    || typeof result.stdout !== 'string') {
    fail(`${port} listener absence query failed`)
  }
  const pids = [...new Set(result.stdout.split('\n')
    .filter(line => /^p[1-9][0-9]*$/u.test(line))
    .map(line => Number(line.slice(1))))]
  if (pids.length !== 0) fail(`port ${port} still has a listener`)
  return { absent: true, port }
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

function legacyIngressFreezeState() {
  const launchctl = runStatus(command('LAUNCHCTL', '/bin/launchctl'), [
    'print', `gui/${process.getuid()}/${QWEN_CURRENT_LABEL}`,
  ])
  if (launchctl.error || launchctl.signal || !Number.isInteger(launchctl.status)) {
    fail('qwen-current Gateway LaunchAgent absence query failed')
  }
  if (launchctl.status === 0) fail('qwen-current Gateway LaunchAgent is still loaded')
  if (![1, 113].includes(launchctl.status)) {
    fail('qwen-current Gateway LaunchAgent absence query failed')
  }
  const listener = absentListenerState(QWEN_CURRENT_GATEWAY_PORT)
  const source = run(command('PS', '/bin/ps'), [
    '-axo', 'pid=,ppid=,command=',
  ], 'legacy ingress process inventory')
  const matchingGatewayPids = []
  const submissionPids = []
  for (const line of source.split('\n')) {
    const match = line.match(/^\s*([1-9][0-9]*)\s+([0-9]+)\s+(.*)$/u)
    if (!match) continue
    const pid = Number(match[1])
    const commandLine = match[3]
    if (/(?:openclaw|gateway)/iu.test(commandLine)
      && /(?:qwen-current|\.openclaw-qwen-current|(?:^|\D)18889(?:\D|$))/u.test(commandLine)) {
      matchingGatewayPids.push(pid)
    }
    if (/(?:^|[/\s])submit-task\.mjs(?:\s|$)|material-handoff(?:\.mjs)?(?:\s|$)/u.test(commandLine)) {
      submissionPids.push(pid)
    }
  }
  if (matchingGatewayPids.length !== 0) fail('qwen-current Gateway process is still running')
  if (submissionPids.length !== 0) fail('video submission or material-handoff process is still running')
  return {
    mode: 'legacy-gateway-freeze',
    label: QWEN_CURRENT_LABEL,
    launchAgentAbsent: true,
    listener,
    matchingGatewayPids,
    submissionPids,
  }
}

function supervisorState(requireLegacyIngressFreeze = false) {
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
  const configuredBatchRoot = testPath(
    'AIWORKER_TEST_LEGACY_ORPHAN_BATCH_ROOT',
    join(process.env.HOME, 'ai-worker/state/video-autoworker/video-batches'),
  )
  let batchRootIdentity = null
  if (requireLegacyIngressFreeze) {
    safeEntry(configuredBatchRoot, 'video batch root', 'directory', 0o700)
    const batchRoot = realpathSync(configuredBatchRoot)
    batchRootIdentity = identity(batchRoot, 'video batch root', 'directory')
  }
  const lockPath = join(configuredBatchRoot, '.global-video-worker.lock')
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
  return {
    disabled,
    loaded,
    lockAbsent,
    workerPids,
    ...(requireLegacyIngressFreeze
      ? { batchRoot: batchRootIdentity, legacyIngress: legacyIngressFreezeState() }
      : {}),
  }
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
  const items = value.queue.map((item, index) => ({
    ...projection[index],
    queueOrigin: item?.queueOrigin === undefined ? null : String(item.queueOrigin),
  }))
  return {
    attention,
    waiting,
    running,
    total: value.queue.length,
    digest: sha256(canonicalJson(projection)),
    items,
  }
}

class BuiltinDatabase {
  constructor(pathname, options = {}) {
    if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_DATABASE_OPEN_CANARY) {
      writeFileSync(
        testPath('AIWORKER_TEST_LEGACY_ORPHAN_DATABASE_OPEN_CANARY', ''),
        'database-opened\n',
        { mode: 0o600, flag: 'wx' },
      )
    }
    if (options.fileMustExist !== true) fail('SQLite connections must require an existing database')
    const databaseUrl = pathToFileURL(pathname)
    databaseUrl.searchParams.set('mode', options.readonly === true ? 'ro' : 'rw')
    this.database = new DatabaseSync(databaseUrl.href, {
      readOnly: options.readonly === true,
      timeout: 5_000,
    })
  }

  prepare(source) {
    return this.database.prepare(source)
  }

  exec(source) {
    return this.database.exec(source)
  }

  pragma(source, options = {}) {
    const rows = this.database.prepare(`PRAGMA ${source}`).all()
    if (!options.simple) return rows
    return rows.length === 0 ? undefined : Object.values(rows[0])[0]
  }

  backup(pathname) {
    return sqliteBackup(this.database, pathname)
  }

  close() {
    return this.database.close()
  }
}

let sqliteBackup = null
let DatabaseSync = null

function validateSqliteCapabilities(sqlite) {
  if (!sqlite || typeof sqlite !== 'object'
    || typeof sqlite.DatabaseSync !== 'function'
    || typeof sqlite.StatementSync !== 'function'
    || typeof sqlite.backup !== 'function') {
    fail('node:sqlite does not provide the required reconciliation capabilities')
  }
  for (const name of ['close', 'exec', 'prepare']) {
    if (typeof sqlite.DatabaseSync.prototype[name] !== 'function') {
      fail('node:sqlite does not provide the required reconciliation capabilities')
    }
  }
  for (const name of ['all', 'get', 'run']) {
    if (typeof sqlite.StatementSync.prototype[name] !== 'function') {
      fail('node:sqlite does not provide the required reconciliation capabilities')
    }
  }
  let probe = null
  try {
    probe = new sqlite.DatabaseSync(':memory:')
    probe.exec('BEGIN IMMEDIATE; CREATE TABLE capability_probe (value INTEGER NOT NULL); COMMIT')
    const statement = probe.prepare('SELECT 1 AS value')
    if (Number(statement.get()?.value) !== 1
      || probe.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') {
      fail('node:sqlite reconciliation capability probe failed')
    }
  } catch {
    fail('node:sqlite reconciliation capability probe failed')
  } finally {
    try { probe?.close() } catch {}
  }
}

function loadDatabase() {
  if (!DatabaseSync || !sqliteBackup) {
    const originalEmitWarning = process.emitWarning
    process.emitWarning = (warning, type, ...args) => {
      if (warning === 'SQLite is an experimental feature and might change at any time'
        && type === 'ExperimentalWarning') return
      return Reflect.apply(originalEmitWarning, process, [warning, type, ...args])
    }
    try {
      const sqlite = createRequire(import.meta.url)('node:sqlite')
      validateSqliteCapabilities(sqlite)
      sqliteBackup = sqlite.backup
      DatabaseSync = sqlite.DatabaseSync
    } finally {
      process.emitWarning = originalEmitWarning
    }
  }
  return BuiltinDatabase
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
  const databaseOpenHookName = !readonly
    ? 'AIWORKER_TEST_LEGACY_ORPHAN_BEFORE_WRITABLE_DATABASE_OPEN_COMMAND'
    : 'AIWORKER_TEST_LEGACY_ORPHAN_BEFORE_DATABASE_OPEN_COMMAND'
  if (TEST_MODE && process.env[databaseOpenHookName]) {
    run(
      testPath(databaseOpenHookName, ''), [],
      'test pre-database-open hook',
    )
  }
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

function tableExists(db, table) {
  return Boolean(db.prepare(
    'SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?',
  ).get(table))
}

function requireTable(db, table, columns) {
  if (!tableExists(db, table)) fail(`${table} schema is unavailable`)
  tableColumns(db, table, columns)
}

function tableSchemaBinding(db, table, requiredColumns) {
  const definition = db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(table)
  if (!definition) return { present: false }
  if (typeof definition.sql !== 'string' || !definition.sql) {
    fail(`${table} schema definition is unavailable`)
  }
  const columns = db.pragma(`table_info(${table})`).map(row => ({
    cid: row.cid,
    name: row.name,
    type: row.type,
    notnull: row.notnull,
    defaultValue: row.dflt_value,
    primaryKey: row.pk,
  }))
  const names = new Set(columns.map(column => column.name))
  if (requiredColumns.some(name => !names.has(name))) fail(`${table} schema is unavailable`)
  return {
    present: true,
    sqlSha256: sha256(definition.sql),
    columnsSha256: sha256(canonicalJson(columns)),
  }
}

function parentSchemaEpoch(db) {
  const tables = Object.fromEntries(PARENT_SCHEMA_TABLES.map(([table, columns]) => [
    table,
    tableSchemaBinding(db, table, columns),
  ]))
  if (!tables.schema_migrations.present
    || !tables.n8n_workflow_bindings.present || !tables.n8n_task_runs.present) {
    fail('parent reconciliation core schema is unavailable')
  }
  const migrationIds = db.prepare('SELECT id FROM schema_migrations ORDER BY id').all()
    .map(row => row.id)
  if (migrationIds.some(id => typeof id !== 'string' || !/^\d{3}_[a-z0-9_]+$/u.test(id))) {
    fail('parent reconciliation migration history is invalid')
  }
  const migrationSet = new Set(migrationIds)
  if (PARENT_CORE_MIGRATIONS.some(id => !migrationSet.has(id))) {
    fail('parent reconciliation core migration history is incomplete')
  }
  const versions = migrationIds.map(id => Number(id.slice(0, 3)))
  const latestMigrationVersion = Math.max(...versions)
  if (!Number.isSafeInteger(latestMigrationVersion) || latestMigrationVersion > 59) {
    fail('parent reconciliation migration history is unsupported')
  }
  const knownByVersion = new Map(PARENT_KNOWN_MIGRATIONS.map(id => [Number(id.slice(0, 3)), id]))
  for (const id of migrationIds.filter(value => Number(value.slice(0, 3)) >= 49)) {
    if (knownByVersion.get(Number(id.slice(0, 3))) !== id) {
      fail('parent reconciliation migration history contains an unknown current-epoch marker')
    }
  }
  for (let version = 49; version <= latestMigrationVersion; version += 1) {
    const expected = knownByVersion.get(version)
    if (!expected || !migrationSet.has(expected)) {
      fail('parent reconciliation migration history is not contiguous')
    }
  }
  const laterTables = [...PARENT_ANCILLARY_TABLES, ...PARENT_EPOCH_SUPPORT_TABLES]
  const legacy = latestMigrationVersion === 50
    && PARENT_MODERN_MIGRATIONS.every(id => !migrationSet.has(id))
    && laterTables.every(table => tables[table].present === false)
  const modern = latestMigrationVersion >= 57
    && PARENT_MODERN_MIGRATIONS.every(id => migrationSet.has(id))
    && laterTables.every(table => tables[table].present === true)
  if (!legacy && !modern) {
    fail('parent reconciliation schema epoch is incomplete or inconsistent')
  }
  return {
    kind: legacy ? 'legacy-through-050' : 'modern-057-plus',
    latestMigrationVersion,
    migrationIdsSha256: sha256(canonicalJson(migrationIds)),
    migrationMarkers: Object.fromEntries([
      ...PARENT_CORE_MIGRATIONS,
      ...PARENT_MODERN_MIGRATIONS,
    ].map(id => [id, migrationSet.has(id)])),
    tables,
  }
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

function parentAncillaryState(db, parent, childTaskIds) {
  const schemaEpoch = parentSchemaEpoch(db)
  const placeholders = childTaskIds.map(() => '?').join(', ')
  const values = schemaEpoch.kind === 'legacy-through-050'
    ? { parentClaims: 0, dispatchLeases: 0, childLeases: 0, cleanupDebts: 0, directorOutbox: 0 }
    : {
        parentClaims: Number(db.prepare(`
          SELECT COUNT(*) AS count FROM n8n_parent_execution_claims
          WHERE task_id = ?
        `).get(parent.task_id).count),
        dispatchLeases: Number(db.prepare(`
          SELECT COUNT(*) AS count FROM n8n_task_dispatch_leases
          WHERE task_id = ?
        `).get(parent.task_id).count),
        childLeases: Number(db.prepare(`
          SELECT COUNT(*) AS count FROM n8n_child_execution_leases
          WHERE task_id IN (${placeholders})
        `).get(...childTaskIds).count),
        cleanupDebts: Number(db.prepare(
          'SELECT COUNT(*) AS count FROM n8n_media_cleanup_debts WHERE task_id = ?',
        ).get(parent.task_id).count),
        directorOutbox: Number(db.prepare(
          'SELECT COUNT(*) AS count FROM n8n_director_evidence_outbox WHERE task_id = ?',
        ).get(parent.task_id).count),
      }
  if (Object.values(values).some(count => count !== 0)) {
    fail('parent still has a claim, lease, cleanup debt, or director outbox record')
  }
  return { schemaEpoch, ...values }
}

function parentIntakeState(db) {
  if (!tableExists(db, 'n8n_intake_controls')) {
    return { mode: 'legacy-gateway-freeze', intakeTablePresent: false }
  }
  requireTable(db, 'n8n_intake_controls', [
    'control_id', 'accepting', 'reason', 'changed_by_id', 'changed_by_name',
    'changed_at', 'revision',
  ])
  const rows = db.prepare('SELECT * FROM n8n_intake_controls ORDER BY control_id').all()
  if (rows.length !== 1 || rows[0].control_id !== 1 || rows[0].accepting !== 0
    || !Number.isSafeInteger(rows[0].revision) || rows[0].revision < 1) {
    fail('global n8n intake is not paused')
  }
  return {
    mode: 'legacy-gateway-freeze',
    intakeTablePresent: true,
    rowDigest: rowDigest(rows[0]),
    revision: rows[0].revision,
  }
}

function validateParentQueue(queue) {
  if (queue.attention !== 1 || queue.waiting !== 0 || queue.running !== 0
    || queue.total !== 1 || queue.items.length !== 1) {
    fail('parent pre-media mode requires exactly one attention record and no other queue work')
  }
  const item = queue.items[0]
  if (item.status !== 'accepted' || item.stale !== true || item.sourceAvailable !== null
    || item.queueOrigin !== 'n8n') {
    fail('attention record is not one stale non-durable accepted parent')
  }
  return item
}

function validateParentTarget(db, input, now, queue = null, expected = null) {
  tableColumns(db, 'n8n_task_runs', [
    'id', 'task_id', 'idempotency_key', 'binding_id', 'status', 'source', 'routing', 'input',
    'delivery', 'output', 'error', 'attempt_count', 'max_attempts', 'workspace_id', 'tenant_id',
    'created_at', 'accepted_at', 'started_at', 'completed_at', 'updated_at',
  ])
  tableColumns(db, 'n8n_workflow_bindings', ['id', 'task_type', 'workspace_id', 'tenant_id'])
  const queueItem = queue ? validateParentQueue(queue) : null
  const expectedTaskId = expected?.parent?.task_id || queueItem?.taskId
  if (!TASK_ID.test(expectedTaskId || '')) fail('parent task identity is unavailable')
  const parent = db.prepare('SELECT * FROM n8n_task_runs WHERE task_id = ?').get(expectedTaskId)
  let routing
  let delivery
  try {
    routing = parseObject(parent?.routing, 'parent routing')
    delivery = parseObject(parent?.delivery, 'parent delivery')
  } catch { fail('parent routing or delivery is invalid') }
  const binding = parent ? db.prepare(`
    SELECT task_type FROM n8n_workflow_bindings
    WHERE id = ? AND workspace_id = ? AND tenant_id = ?
  `).get(parent.binding_id, parent.workspace_id, parent.tenant_id) : null
  if (!parent || parent.status !== 'accepted'
    || !['openclaw', 'video-autoworker'].includes(parent.source)
    || routing.taskType !== 'video-analysis' || binding?.task_type !== 'video-analysis'
    || parent.idempotency_key !== parent.task_id
    || parent.accepted_at === null || parent.started_at !== null || parent.completed_at !== null
    || parent.attempt_count !== 0 || parent.max_attempts < 1
    || parent.error !== null || parent.output !== null || delivery.mode !== 'none'
    || now - parent.updated_at < Math.max(PARENT_STALE_SECONDS, input.minimumAgeSeconds)
    || (queueItem && queueItem.updatedAt !== parent.updated_at)) {
    fail('parent is not the exact stale accepted pre-media video-analysis record')
  }
  const activeTopLevel = db.prepare(`
    SELECT id FROM n8n_task_runs
    WHERE source IN ('openclaw', 'video-autoworker')
      AND status IN ('queued', 'accepted', 'running')
    ORDER BY id
  `).all()
  if (activeTopLevel.length !== 1 || activeTopLevel[0].id !== parent.id) {
    fail('another active top-level task exists')
  }
  const childTaskIds = ['prepare', 'audio', 'vision', 'finalize']
    .map(stage => mediaChildTaskId(parent.task_id, stage))
  const placeholders = childTaskIds.map(() => '?').join(', ')
  const children = db.prepare(`
    SELECT id FROM n8n_task_runs WHERE task_id IN (${placeholders})
  `).all(...childTaskIds)
  if (children.length !== 0) fail('parent already has a deterministic media child')
  const activeMedia = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM n8n_task_runs
    WHERE source = 'n8n-media-node' AND status IN ('queued', 'accepted', 'running')
  `).get().count)
  const activeModel = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM n8n_task_runs
    WHERE source = 'n8n-node' AND status IN ('queued', 'accepted', 'running')
  `).get().count)
  if (activeMedia !== 0 || activeModel !== 0) fail('Mission Control still has active media or model work')
  const intake = parentIntakeState(db)
  const ancillary = parentAncillaryState(db, parent, childTaskIds)
  const others = db.prepare('SELECT * FROM n8n_task_runs WHERE id <> ? ORDER BY id').all(parent.id)
  const result = {
    kind: 'parent-pre-media',
    parent,
    parentDigest: rowDigest(parent),
    othersDigest: rowDigest(others),
    childTaskIdsDigest: rowDigest(childTaskIds),
    ancillary,
    intake,
    activeMedia,
    activeModel,
  }
  if (expected && canonicalJson(result) !== canonicalJson(expected)) {
    fail('parent database identity changed after prepare')
  }
  return result
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

function validateN8nIdle(db) {
  tableColumns(db, 'execution_entity', ['id', 'workflowId', 'status', 'stoppedAt'])
  const executionDigest = createHash('sha256')
  let executionCount = 0
  for (const row of db.prepare('SELECT * FROM execution_entity ORDER BY id').iterate()) {
    executionDigest.update(canonicalJson(row))
    executionDigest.update('\n')
    executionCount += 1
  }
  const active = Number(db.prepare(`
    SELECT COUNT(*) AS count FROM execution_entity
    WHERE status IN ('new', 'running', 'waiting') AND "stoppedAt" IS NULL
  `).get().count)
  if (active !== 0) fail('n8n still has active executions')
  return {
    activeExecutionCount: active,
    executionCount,
    executionDigest: executionDigest.digest('hex'),
  }
}

function validateN8n(db, input) {
  const idle = validateN8nIdle(db)
  tableColumns(db, 'execution_data', ['executionId', 'data'])
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
    ...idle,
    ...execution,
    executionDataDigest: binding.digest,
    parentBindingCount: 1,
  }
}

function activeProcessGuard(input, missionPath, target = null) {
  const parentTaskId = input.parentTaskId || target?.parent?.task_id
  if (!TASK_ID.test(parentTaskId || '')) fail('target parent identity is unavailable')
  const childTaskIds = input.targetKind === 'parent-pre-media'
    ? ['prepare', 'audio', 'vision', 'finalize'].map(stage => mediaChildTaskId(parentTaskId, stage))
    : [input.childTaskId]
  const taskReferences = [parentTaskId, ...childTaskIds]
  const workspaceDigest = sha256(parentTaskId)
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
    if ([...taskReferences, workspaceDigest].some(value => commandLine.includes(value))) {
      fail('a live process still references the target task')
    }
  }
  return workspaceDigest
}

async function capturePlatform(input) {
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
  const supervisor = supervisorState(input?.targetKind === 'parent-pre-media')
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

function renameDirectoryExclusive(root, source, destination, sourceIdentity) {
  const sourceName = basename(source)
  const destinationName = basename(destination)
  if (dirname(source) !== root || dirname(destination) !== root
    || !PENDING_BACKUP_DIRECTORY.test(sourceName)
    || !FINAL_BACKUP_DIRECTORY.test(destinationName)) {
    fail('exclusive directory rename arguments are invalid')
  }
  run('/usr/bin/python3', [
    '-I', '-S', '-c', EXCLUSIVE_RENAME_HELPER, root, sourceName, destinationName,
    sourceIdentity.dev.toString(), sourceIdentity.ino.toString(), sourceIdentity.uid.toString(),
    sourceIdentity.nlink.toString(),
  ], 'exclusive directory rename', 'errno')
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

function readVerifiedToolSource(pathname, label = 'reconciliation tool dependency') {
  const entry = safeEntry(pathname, label, 'file')
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size
      || opened.uid !== entry.uid || opened.mode !== entry.mode || opened.nlink !== entry.nlink) {
      fail(`${label} changed before open`)
    }
    const source = readFileSync(descriptor)
    const closed = fstatSync(descriptor, { bigint: true })
    if (closed.dev !== opened.dev || closed.ino !== opened.ino || closed.size !== opened.size
      || closed.uid !== opened.uid || closed.mode !== opened.mode || closed.nlink !== opened.nlink
      || BigInt(source.byteLength) !== opened.size) {
      fail(`${label} changed during read`)
    }
    return {
      source,
      bytes: source.byteLength,
      sha256: sha256(source),
      identity: {
        dev: opened.dev.toString(),
        ino: opened.ino.toString(),
        size: opened.size.toString(),
        uid: opened.uid.toString(),
        mode: opened.mode.toString(),
        nlink: opened.nlink.toString(),
      },
    }
  } finally { closeSync(descriptor) }
}

function fileBinding(pathname, fingerprint) {
  return {
    path: pathname,
    bytes: fingerprint.bytes,
    sha256: fingerprint.sha256,
    identity: fingerprint.identity,
  }
}

function validateFileBinding(value, label) {
  exactKeys(value, ['bytes', 'identity', 'path', 'sha256'], label)
  exactKeys(value.identity, ['dev', 'ino', 'mode', 'nlink', 'size', 'uid'], `${label} identity`)
  assertAbsolute(value.path, `${label} path`)
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 0 || !SHA256.test(value.sha256)
    || Object.values(value.identity).some(item => !/^[0-9]{1,30}$/u.test(item))) {
    fail(`${label} is invalid`)
  }
  return value
}

function readVerifiedRuntimeFile(pathname, label) {
  const entry = safeEntry(pathname, label, 'file')
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size
      || opened.uid !== entry.uid || opened.mode !== entry.mode || opened.nlink !== entry.nlink) {
      fail(`${label} changed before open`)
    }
    const digest = createHash('sha256')
    const buffer = Buffer.allocUnsafe(1024 * 1024)
    let bytes = 0
    for (;;) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null)
      if (count === 0) break
      digest.update(buffer.subarray(0, count))
      bytes += count
      if (bytes > 256 * 1024 * 1024) fail(`${label} is too large`)
    }
    const closed = fstatSync(descriptor, { bigint: true })
    if (closed.dev !== opened.dev || closed.ino !== opened.ino || closed.size !== opened.size
      || closed.uid !== opened.uid || closed.mode !== opened.mode || closed.nlink !== opened.nlink
      || BigInt(bytes) !== opened.size) {
      fail(`${label} changed during read`)
    }
    return {
      bytes,
      sha256: digest.digest('hex'),
      identity: {
        dev: opened.dev.toString(),
        ino: opened.ino.toString(),
        size: opened.size.toString(),
        uid: opened.uid.toString(),
        mode: opened.mode.toString(),
        nlink: opened.nlink.toString(),
      },
    }
  } finally { closeSync(descriptor) }
}

let databaseRuntimeBindingCache = null

function currentDatabaseRuntimeBinding() {
  if (databaseRuntimeBindingCache) return databaseRuntimeBindingCache
  if (!/^v\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(process.version)
    || typeof process.versions.sqlite !== 'string'
    || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(process.versions.sqlite)) {
    fail('Node/SQLite runtime version is unavailable')
  }
  const executablePath = realpathSync(process.execPath)
  const executable = fileBinding(
    executablePath,
    readVerifiedRuntimeFile(executablePath, 'Node database runtime executable'),
  )
  if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_DATABASE_RUNTIME_SHA) {
    if (!SHA256.test(process.env.AIWORKER_TEST_LEGACY_ORPHAN_DATABASE_RUNTIME_SHA)) {
      fail('test database runtime SHA is invalid')
    }
    executable.sha256 = process.env.AIWORKER_TEST_LEGACY_ORPHAN_DATABASE_RUNTIME_SHA
  }
  databaseRuntimeBindingCache = {
    kind: 'node:sqlite',
    nodeVersion: process.version,
    sqliteVersion: process.versions.sqlite,
    executable,
  }
  return databaseRuntimeBindingCache
}

function validateDatabaseRuntimeBinding(value) {
  exactKeys(value, ['executable', 'kind', 'nodeVersion', 'sqliteVersion'], 'database runtime binding')
  validateFileBinding(value.executable, 'database runtime executable binding')
  if (value.kind !== 'node:sqlite' || value.nodeVersion !== process.version
    || value.sqliteVersion !== process.versions.sqlite
    || value.executable.path !== realpathSync(process.execPath)) {
    fail('database runtime binding is invalid for this Node process')
  }
  if (canonicalJson(value) !== canonicalJson(currentDatabaseRuntimeBinding())) {
    fail('database runtime changed after prepare')
  }
}

function validateParserBinding(value) {
  exactKeys(value, ['bytes', 'identity', 'path', 'sha256', 'version'], 'TypeScript parser binding')
  validateFileBinding({
    path: value.path,
    bytes: value.bytes,
    sha256: value.sha256,
    identity: value.identity,
  }, 'TypeScript parser file binding')
  if (typeof value.version !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(value.version)) {
    fail('TypeScript parser binding is invalid')
  }
  return value
}

function configuredParserPath() {
  if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_PARSER_PATH) {
    return testPath('AIWORKER_TEST_LEGACY_ORPHAN_PARSER_PATH', '')
  }
  const scopedRequire = createRequire(import.meta.url)
  try {
    return realpathSync(scopedRequire.resolve('typescript', { paths: [REPOSITORY_ROOT] }))
  } catch { fail('TypeScript parser is unavailable') }
}

function withVerifiedToolParser(expectedBinding, callback) {
  const parserPath = expectedBinding
    ? validateParserBinding(expectedBinding).path
    : configuredParserPath()
  const captured = readVerifiedToolSource(parserPath, 'TypeScript parser')
  const capturedFileBinding = fileBinding(parserPath, captured)
  if (expectedBinding && canonicalJson(capturedFileBinding) !== canonicalJson({
    path: expectedBinding.path,
    bytes: expectedBinding.bytes,
    sha256: expectedBinding.sha256,
    identity: expectedBinding.identity,
  })) {
    fail('TypeScript parser changed after prepare')
  }
  if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_AFTER_PARSER_SNAPSHOT_CHECK_COMMAND) {
    run(
      testPath('AIWORKER_TEST_LEGACY_ORPHAN_AFTER_PARSER_SNAPSHOT_CHECK_COMMAND', ''), [],
      'test post-parser-snapshot-check hook',
    )
  }
  const parserUrl = pathToFileURL(parserPath).href
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === parserPath || specifier === parserUrl) {
        return { url: parserUrl, format: 'commonjs', shortCircuit: true }
      }
      if (isBuiltin(specifier)) return nextResolve(specifier, context)
      throw new Error('unverified TypeScript parser dependency requested')
    },
    load(url, context, nextLoad) {
      if (url === parserUrl) {
        return { format: 'commonjs', source: captured.source, shortCircuit: true }
      }
      if (url.startsWith('node:')) return nextLoad(url, context)
      throw new Error('unverified TypeScript parser source requested')
    },
  })
  try {
    let parser
    try { parser = createRequire(import.meta.url)(parserPath) } catch (error) {
      fail(`verified TypeScript parser could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (typeof parser?.createSourceFile !== 'function' || typeof parser?.forEachChild !== 'function'
      || typeof parser?.version !== 'string'
      || (expectedBinding && parser.version !== expectedBinding.version)) {
      fail('verified TypeScript parser has an invalid API or version')
    }
    const result = callback(parser, {
      ...capturedFileBinding,
      version: parser.version,
    })
    const after = readVerifiedToolSource(parserPath, 'TypeScript parser')
    if (after.sha256 !== captured.sha256
      || canonicalJson(after.identity) !== canonicalJson(captured.identity)) {
      fail('TypeScript parser changed after verified parsing')
    }
    return result
  } finally { hooks.deregister() }
}

function staticToolSpecifiers(parser, pathname, source, isEntry) {
  const sourceFile = parser.createSourceFile(
    pathname,
    source.toString('utf8'),
    parser.ScriptTarget.Latest,
    true,
    parser.ScriptKind.JS,
  )
  if ((sourceFile.parseDiagnostics || []).length !== 0) {
    fail('reconciliation tool dependency contains invalid JavaScript syntax')
  }
  const specifiers = []
  const visit = node => {
    if (!isEntry && parser.isMetaProperty(node)
      && node.keywordToken === parser.SyntaxKind.ImportKeyword) {
      fail('runtime import.meta module loading is unsupported')
    }
    if (!isEntry && parser.isCallExpression(node)) {
      const expression = node.expression
      const name = parser.isIdentifier(expression)
        ? expression.text
        : parser.isPropertyAccessExpression(expression) ? expression.name.text : ''
      if (name === 'require' || name === 'createRequire') {
        fail('runtime require/createRequire module loading is unsupported')
      }
    }
    if (parser.isCallExpression(node) && node.expression?.kind === parser.SyntaxKind.ImportKeyword) {
      fail('dynamic reconciliation tool dependencies are unsupported')
    }
    if (parser.isImportEqualsDeclaration(node)) {
      fail('import-equals reconciliation tool dependencies are unsupported')
    }
    if (parser.isImportDeclaration(node)
      || (parser.isExportDeclaration(node) && node.moduleSpecifier)) {
      const moduleSpecifier = node.moduleSpecifier
      if (!moduleSpecifier || !parser.isStringLiteralLike(moduleSpecifier)) {
        fail('reconciliation tool dependency specifier is unsupported')
      }
      if (!isEntry && moduleSpecifier.text === 'node:module') {
        fail('runtime createRequire module loading is unsupported')
      }
      specifiers.push(moduleSpecifier.text)
    }
    parser.forEachChild(node, visit)
  }
  visit(sourceFile)
  return specifiers
}

function toolClosureConfiguration() {
  const entryPath = TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_TOOL_CLOSURE_ROOT
    ? testPath('AIWORKER_TEST_LEGACY_ORPHAN_TOOL_CLOSURE_ROOT', '')
    : SCRIPT_PATH
  const runtimePath = TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_TOOL_RUNTIME_ROOT
    ? testPath('AIWORKER_TEST_LEGACY_ORPHAN_TOOL_RUNTIME_ROOT', '')
    : SUBMISSION_LOCK_MODULE_PATH
  const entryRoot = entryPath === SCRIPT_PATH ? REPOSITORY_ROOT : dirname(entryPath)
  const runtimeRoot = runtimePath === SUBMISSION_LOCK_MODULE_PATH ? REPOSITORY_ROOT : dirname(runtimePath)
  const roots = []
  const addRoot = (pathname, preferredLabel) => {
    const normalized = resolve(pathname)
    const existing = roots.find(item => item.path === normalized)
    if (existing) return existing
    const root = { path: normalized, label: preferredLabel }
    roots.push(root)
    return root
  }
  return {
    entry: { path: resolve(entryPath), root: addRoot(entryRoot, entryRoot === REPOSITORY_ROOT ? 'repository' : 'entry') },
    runtime: {
      path: resolve(runtimePath),
      root: addRoot(runtimeRoot, runtimeRoot === REPOSITORY_ROOT ? 'repository' : 'runtime'),
    },
  }
}

function createToolSnapshot(expectedParserBinding = null) {
  return withVerifiedToolParser(expectedParserBinding, (parser, parserBinding) => {
    const configuration = toolClosureConfiguration()
    const pending = [configuration.entry, configuration.runtime]
    const members = new Map()
    let totalBytes = 0
    while (pending.length > 0) {
      const request = pending.pop()
      const pathname = resolve(request.path)
      const relativePath = relative(request.root.path, pathname)
      if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
        fail('reconciliation tool dependency escapes its closure root')
      }
      if (members.has(pathname)) continue
      if (members.size >= MAX_TOOL_CLOSURE_MEMBERS) fail('reconciliation tool dependency closure is too large')
      if (!/\.(?:js|mjs)$/u.test(pathname)) {
        fail('reconciliation tool dependency type is unsupported')
      }
      const loaded = readVerifiedToolSource(pathname)
      if (loaded.bytes > MAX_TOOL_CLOSURE_BYTES - totalBytes) {
        fail('reconciliation tool dependency closure is too large')
      }
      totalBytes += loaded.bytes
      const member = {
        pathname,
        url: pathToFileURL(pathname).href,
        logicalPath: `${request.root.label}/${relativePath}`,
        root: request.root,
        edges: new Map(),
        ...loaded,
      }
      members.set(pathname, member)
      for (const specifier of staticToolSpecifiers(
        parser,
        pathname,
        loaded.source,
        pathname === configuration.entry.path,
      )) {
        if (specifier.startsWith('node:')) {
          if (!isBuiltin(specifier)) fail('reconciliation tool builtin dependency is invalid')
          continue
        }
        if (!specifier.startsWith('./') && !specifier.startsWith('../')) {
          fail('reconciliation tool dependency specifier is unsupported')
        }
        if (specifier.includes('?') || specifier.includes('#')) {
          fail('reconciliation tool dependency specifier is unsupported')
        }
        const dependencyPath = resolve(dirname(pathname), specifier)
        const dependencyRelative = relative(request.root.path, dependencyPath)
        if (!dependencyRelative || dependencyRelative.startsWith('..') || isAbsolute(dependencyRelative)) {
          fail('reconciliation tool dependency escapes its closure root')
        }
        member.edges.set(specifier, dependencyPath)
        pending.push({ path: dependencyPath, root: request.root })
      }
    }
    const runtime = members.get(configuration.runtime.path)
    if (!runtime) fail('submission-lock runtime is absent from the verified tool closure')
    const digest = sha256(canonicalJson({
      parser: { version: parserBinding.version, bytes: parserBinding.bytes,
        sha256: parserBinding.sha256 },
      members: [...members.values()].map(member => ({
        path: member.logicalPath,
        bytes: member.bytes,
        sha256: member.sha256,
      })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0),
    }))
    const override = TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_TOOL_SHA
    if (override && !SHA256.test(override)) fail('test tool SHA is invalid')
    return {
      digest: override || digest,
      runtimePath: configuration.runtime.path,
      members,
      parserBinding,
    }
  })
}

function assertToolSnapshotCurrent(snapshot) {
  const parser = readVerifiedToolSource(snapshot.parserBinding.path, 'TypeScript parser')
  if (canonicalJson(fileBinding(snapshot.parserBinding.path, parser)) !== canonicalJson({
    path: snapshot.parserBinding.path,
    bytes: snapshot.parserBinding.bytes,
    sha256: snapshot.parserBinding.sha256,
    identity: snapshot.parserBinding.identity,
  })) {
    fail('TypeScript parser changed after tool closure verification')
  }
  for (const member of snapshot.members.values()) {
    const current = readVerifiedToolSource(member.pathname)
    if (current.sha256 !== member.sha256
      || canonicalJson(current.identity) !== canonicalJson(member.identity)) {
      fail('reconciliation tool changed after closure verification')
    }
  }
}

async function acquireVerifiedSubmissionLock(snapshot, batchRoot) {
  assertToolSnapshotCurrent(snapshot)
  if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_AFTER_TOOL_SNAPSHOT_CHECK_COMMAND) {
    run(
      testPath('AIWORKER_TEST_LEGACY_ORPHAN_AFTER_TOOL_SNAPSHOT_CHECK_COMMAND', ''), [],
      'test post-tool-snapshot-check hook',
    )
  }
  const byUrl = new Map([...snapshot.members.values()].map(member => [member.url, member]))
  const runtimeUrl = pathToFileURL(snapshot.runtimePath).href
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('node:')) return nextResolve(specifier, context)
      if (specifier === snapshot.runtimePath || specifier === runtimeUrl) {
        return { url: runtimeUrl, format: 'module', shortCircuit: true }
      }
      const parent = byUrl.get(context.parentURL || '')
      const dependencyPath = parent?.edges.get(specifier)
      const dependency = dependencyPath ? snapshot.members.get(dependencyPath) : null
      if (!dependency) throw new Error('unverified reconciliation runtime dependency requested')
      return { url: dependency.url, format: 'module', shortCircuit: true }
    },
    load(url, context, nextLoad) {
      if (url.startsWith('node:')) return nextLoad(url, context)
      const member = byUrl.get(url)
      if (!member) throw new Error('unverified reconciliation runtime source requested')
      return { format: 'module', source: member.source, shortCircuit: true }
    },
  })
  let submissionLock = null
  try {
    const namespace = createRequire(import.meta.url)(snapshot.runtimePath)
    if (typeof namespace?.acquireVideoSubmissionLock !== 'function') {
      fail('verified submission-lock runtime export is invalid')
    }
    submissionLock = await namespace.acquireVideoSubmissionLock(batchRoot)
    if (!submissionLock?.acquired || typeof submissionLock.release !== 'function') {
      fail('video submission lock could not be acquired')
    }
    assertToolSnapshotCurrent(snapshot)
    return submissionLock
  } catch (error) {
    if (submissionLock) {
      try { await submissionLock.release() } catch {}
    }
    if (error instanceof Error && error.message.startsWith('legacy media orphan reconciliation failed:')) {
      throw error
    }
    fail(`verified submission-lock runtime could not be loaded or invoked: ${error instanceof Error ? error.message : String(error)}`)
  } finally { hooks.deregister() }
}

async function inspectLiveState(Database, input) {
  const platform = await capturePlatform(input)
  const missionHandle = openDatabase(Database, platform.legacy.database.path, true)
  const n8nHandle = openDatabase(Database, platform.n8n.database.path, true)
  try {
    const now = Math.floor(Date.now() / 1_000)
    const target = input.targetKind === 'parent-pre-media'
      ? validateParentTarget(missionHandle.db, input, now, platform.queue)
      : validateMissionTarget(missionHandle.db, input, now)
    const execution = input.targetKind === 'parent-pre-media'
      ? validateN8nIdle(n8nHandle.db)
      : validateN8n(n8nHandle.db, input)
    const workspaceDigest = activeProcessGuard(input, platform.legacy.database.path, target)
    return {
      legacy: platform.legacy,
      n8n: platform.n8n,
      mission: { database: platform.legacy.database, verifier: missionHandle.verifier },
      queue: platform.queue,
      supervisor: platform.supervisor,
      target: input.targetKind === 'parent-pre-media' ? target : {
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
    const backupTarget = input.targetKind === 'parent-pre-media'
      ? validateParentTarget(
        backupDb.db, input, Math.floor(Date.now() / 1_000), null, evidence.target,
      )
      : validateMissionTarget(backupDb.db, input, Math.floor(Date.now() / 1_000))
    const targetMatches = input.targetKind === 'parent-pre-media'
      ? canonicalJson(backupTarget) === canonicalJson(evidence.target)
      : rowDigest(backupTarget.child) === rowDigest(evidence.target.child)
        && backupTarget.parentDigest === evidence.target.parentDigest
        && backupTarget.othersDigest === evidence.target.othersDigest
    if (!targetMatches) {
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
    target: backupManifestTarget(input, evidence),
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

function backupManifestTarget(input, evidence) {
  if (input.targetKind === 'parent-pre-media') {
    return {
      targetKind: input.targetKind,
      parentRowId: evidence.target.parent.id,
      parentTaskId: evidence.target.parent.task_id,
      status: evidence.target.parent.status,
      updatedAt: evidence.target.parent.updated_at,
      parentDigest: evidence.target.parentDigest,
    }
  }
  return {
    childRowId: input.childRowId,
    childTaskId: input.childTaskId,
    parentTaskId: input.parentTaskId,
    stage: input.stage,
    status: input.expectedStatus,
    updatedAt: input.expectedUpdatedAt,
  }
}

function manifestInput(input) {
  if (input.targetKind === 'parent-pre-media') {
    return { targetKind: input.targetKind, minimumAgeSeconds: input.minimumAgeSeconds }
  }
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
  if (value?.targetKind === 'parent-pre-media') {
    exactKeys(value, ['minimumAgeSeconds', 'targetKind'], 'prepare input')
    return parseArguments([
      '--parent-pre-media', '--minimum-age-seconds', String(value.minimumAgeSeconds),
    ])
  }
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
  const toolSnapshot = createToolSnapshot()
  const toolSha256 = toolSnapshot.digest
  const databaseRuntimeBinding = currentDatabaseRuntimeBinding()
  const backup = await createRollbackBackup(Database, evidence, input)
  const createdAt = Math.floor(Date.now() / 1_000)
  const manifest = {
    schema: PREPARE_SCHEMA,
    toolSha256,
    parserBinding: toolSnapshot.parserBinding,
    databaseRuntimeBinding,
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
  const staged = loadPreparedArtifact(preparePath, true)
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
  renameDirectoryExclusive(backup.backupRoot, backup.backupDir, backup.finalDir, pendingIdentity)
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
  const published = loadPreparedArtifact(finalPreparePath)
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
  const expectedBackupTarget = input.targetKind === 'parent-pre-media'
    ? {
        targetKind: input.targetKind,
        parentRowId: prepared.target.parent.id,
        parentTaskId: prepared.target.parent.task_id,
        status: prepared.target.parent.status,
        updatedAt: prepared.target.parent.updated_at,
        parentDigest: prepared.target.parentDigest,
      }
    : {
        childRowId: input.childRowId,
        childTaskId: input.childTaskId,
        parentTaskId: input.parentTaskId,
        stage: input.stage,
        status: input.expectedStatus,
        updatedAt: input.expectedUpdatedAt,
      }
  exactKeys(manifest.target, Object.keys(expectedBackupTarget), 'backup target')
  if (canonicalJson(manifest.target) !== canonicalJson(expectedBackupTarget)) {
    fail('backup target does not match prepare input')
  }
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
    const target = input.targetKind === 'parent-pre-media'
      ? validateParentTarget(snapshot.db, input, prepared.createdAt, null, prepared.target)
      : validateMissionTarget(snapshot.db, input, prepared.createdAt)
    const targetMatches = input.targetKind === 'parent-pre-media'
      ? canonicalJson(target) === canonicalJson(prepared.target)
      : rowDigest(target.child) === rowDigest(prepared.target.child)
        && target.parentDigest === prepared.target.parentDigest
        && target.othersDigest === prepared.target.othersDigest
    if (!targetMatches) {
      fail('authoritative rollback snapshot state changed')
    }
  } finally { closeDatabase(snapshot) }
  assertNoSnapshotSidecars(authoritative)
  assertExactDirectoryMembers(directory, PREPARE_DIRECTORY_MEMBERS, 'prepare directory')
  return { manifest, pathname, sha256: backupReference.sha256 }
}

function loadPreparedArtifact(pathname, allowPending = false, suppliedToken = null) {
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
    'backupManifest', 'createdAt', 'databaseRuntimeBinding', 'execution', 'expiresAt',
    'handoffNonce', 'input', 'legacy', 'mission', 'n8n', 'nonce', 'parserBinding', 'queue',
    'schema', 'supervisor', 'target', 'toolSha256', 'uid', 'workspaceDigest',
  ], 'prepare manifest')
  const now = Math.floor(Date.now() / 1_000)
  if (manifest.schema !== PREPARE_SCHEMA || !SHA256.test(manifest.toolSha256)
    || !SHA256.test(manifest.nonce) || !SHA256.test(manifest.handoffNonce)
    || manifest.uid !== process.getuid() || !Number.isSafeInteger(manifest.createdAt)
    || !Number.isSafeInteger(manifest.expiresAt) || manifest.createdAt > now + 30
    || manifest.expiresAt !== manifest.createdAt + PREPARE_TTL_SECONDS || now > manifest.expiresAt) {
    fail('prepare manifest is invalid or expired')
  }
  exactKeys(manifest.backupManifest, ['name', 'sha256'], 'backup manifest reference')
  if (manifest.backupManifest.name !== 'backup-manifest.json'
    || !SHA256.test(manifest.backupManifest.sha256)) {
    fail('backup manifest reference is invalid')
  }
  validateParserBinding(manifest.parserBinding)
  exactKeys(
    manifest.databaseRuntimeBinding,
    ['executable', 'kind', 'nodeVersion', 'sqliteVersion'],
    'database runtime binding',
  )
  validateFileBinding(
    manifest.databaseRuntimeBinding.executable,
    'database runtime executable binding',
  )
  const prepareSha256 = sha256(loaded.source)
  let expectedToken = null
  if (suppliedToken !== null) {
    expectedToken = confirmationToken(
      prepareSha256,
      manifest.backupManifest.sha256,
      manifest,
    )
    if (suppliedToken !== expectedToken) {
      fail('confirmation token does not match immutable prepare evidence')
    }
  }
  validateDatabaseRuntimeBinding(manifest.databaseRuntimeBinding)
  const toolSnapshot = createToolSnapshot(manifest.parserBinding)
  if (manifest.toolSha256 !== toolSnapshot.digest) {
    fail('reconciliation tool changed after prepare (entry or dependency closure)')
  }
  const input = validateManifestInput(manifest.input)
  const Database = loadDatabase()
  const backup = validateBackupManifest(Database, directory, manifest, manifest.backupManifest, input)
  return { manifest, input, backup, prepareSha256, toolSnapshot, expectedToken, Database }
}

function loadPreparedApply(pathname, suppliedToken) {
  return loadPreparedArtifact(pathname, false, suppliedToken)
}

async function reconcileParentInsideImmediate(Database, evidence, input, toolSnapshot) {
  let submissionLock = null
  let missionHandle = null
  let mission = null
  let n8nHandle = null
  let missionLocked = false
  let n8nLocked = false
  let committed = false
  try {
    const batchRoot = evidence.supervisor?.batchRoot
    if (!batchRoot || canonicalJson(identity(batchRoot.path, 'video batch root', 'directory'))
      !== canonicalJson(batchRoot)) {
      fail('video batch root identity changed before submission lock')
    }
    safeEntry(batchRoot.path, 'video batch root', 'directory', 0o700)
    if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_BEFORE_SUBMISSION_LOCK_COMMAND) {
      run(
        testPath('AIWORKER_TEST_LEGACY_ORPHAN_BEFORE_SUBMISSION_LOCK_COMMAND', ''), [],
        'test pre-submission-lock hook',
      )
    }
    submissionLock = await acquireVerifiedSubmissionLock(toolSnapshot, batchRoot.path)
    if (canonicalJson(identity(batchRoot.path, 'video batch root', 'directory'))
      !== canonicalJson(batchRoot)) {
      fail('video batch root identity changed while acquiring submission lock')
    }
    missionHandle = openDatabase(Database, evidence.mission.database.path, false)
    mission = missionHandle.db
    mission.pragma('busy_timeout = 5000')
    mission.exec('BEGIN IMMEDIATE')
    missionLocked = true
    if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_AFTER_MISSION_LOCK_COMMAND) {
      run(
        testPath('AIWORKER_TEST_LEGACY_ORPHAN_AFTER_MISSION_LOCK_COMMAND', ''), [],
        'test post-Mission-lock hook',
      )
    }
    n8nHandle = openDatabase(Database, evidence.n8n.database.path, false)
    n8nHandle.db.pragma('busy_timeout = 5000')
    n8nHandle.db.exec('BEGIN IMMEDIATE')
    n8nLocked = true
    if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_AFTER_DUAL_LOCK_COMMAND) {
      run(
        testPath('AIWORKER_TEST_LEGACY_ORPHAN_AFTER_DUAL_LOCK_COMMAND', ''), [],
        'test post-dual-lock hook',
      )
    }

    const firstQueue = await queueState()
    if (canonicalJson(firstQueue) !== canonicalJson(evidence.queue)) {
      fail('persistent queue changed inside the write boundary')
    }
    const now = Math.floor(Date.now() / 1_000)
    const target = validateParentTarget(mission, input, now, firstQueue, evidence.target)
    if (canonicalJson(target) !== canonicalJson(evidence.target)) {
      fail('Mission Control state changed after confirmation')
    }
    if (canonicalJson(validateN8nIdle(n8nHandle.db)) !== canonicalJson(evidence.execution)) {
      fail('n8n execution changed after confirmation')
    }
    if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_BETWEEN_LOCKED_QUEUE_SAMPLES_COMMAND) {
      run(
        testPath('AIWORKER_TEST_LEGACY_ORPHAN_BETWEEN_LOCKED_QUEUE_SAMPLES_COMMAND', ''), [],
        'test locked-queue race hook',
      )
    }
    const secondQueue = await queueState()
    if (canonicalJson(secondQueue) !== canonicalJson(firstQueue)) {
      fail('persistent queue changed between locked write-boundary samples')
    }
    const secondTarget = validateParentTarget(mission, input, now, secondQueue, evidence.target)
    if (canonicalJson(secondTarget) !== canonicalJson(target)) {
      fail('parent target changed between locked write-boundary samples')
    }
    activeProcessGuard(input, evidence.mission.database.path, secondTarget)
    if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_AFTER_LOCKED_QUEUE_SAMPLES_COMMAND) {
      run(
        testPath('AIWORKER_TEST_LEGACY_ORPHAN_AFTER_LOCKED_QUEUE_SAMPLES_COMMAND', ''), [],
        'test post-locked-queue-samples hook',
      )
    }

    const parent = evidence.target.parent
    const error = `[${PARENT_ERROR_CODE}] n8n 视频任务已受理，但在 ${input.minimumAgeSeconds} 秒内未建立媒体处理阶段`
    const result = mission.prepare(`
      UPDATE n8n_task_runs
      SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND task_id = ? AND source = ? AND status = ? AND updated_at = ?
        AND routing = ? AND binding_id = ? AND workspace_id = ? AND tenant_id = ?
        AND idempotency_key = ?
    `).run(
      error, now, now,
      parent.id, parent.task_id, parent.source, parent.status, parent.updated_at,
      parent.routing, parent.binding_id, parent.workspace_id, parent.tenant_id,
      parent.idempotency_key,
    )
    if (result.changes !== 1) fail('parent compare-and-swap update did not affect exactly one row')
    const updated = mission.prepare('SELECT * FROM n8n_task_runs WHERE id = ?').get(parent.id)
    const others = mission.prepare('SELECT * FROM n8n_task_runs WHERE id <> ? ORDER BY id').all(parent.id)
    const childTaskIds = ['prepare', 'audio', 'vision', 'finalize']
      .map(stage => mediaChildTaskId(parent.task_id, stage))
    const placeholders = childTaskIds.map(() => '?').join(', ')
    const children = mission.prepare(`
      SELECT id FROM n8n_task_runs WHERE task_id IN (${placeholders})
    `).all(...childTaskIds)
    const activeMedia = Number(mission.prepare(`
      SELECT COUNT(*) AS count FROM n8n_task_runs
      WHERE source = 'n8n-media-node' AND status IN ('queued', 'accepted', 'running')
    `).get().count)
    const activeModel = Number(mission.prepare(`
      SELECT COUNT(*) AS count FROM n8n_task_runs
      WHERE source = 'n8n-node' AND status IN ('queued', 'accepted', 'running')
    `).get().count)
    const intake = parentIntakeState(mission)
    const ancillary = parentAncillaryState(mission, parent, childTaskIds)
    if (!updated || updated.status !== 'failed' || updated.error !== error
      || updated.completed_at !== now || updated.updated_at !== now
      || children.length !== 0 || activeMedia !== 0 || activeModel !== 0
      || rowDigest(others) !== evidence.target.othersDigest
      || canonicalJson(intake) !== canonicalJson(evidence.target.intake)
      || canonicalJson(ancillary) !== canonicalJson(evidence.target.ancillary)) {
      fail('write-back verification detected an unexpected parent or related-state change')
    }
    const unchanged = {
      ...updated,
      status: parent.status,
      error: parent.error,
      completed_at: parent.completed_at,
      updated_at: parent.updated_at,
    }
    if (rowDigest(unchanged) !== evidence.target.parentDigest) {
      fail('fields outside the controlled parent transition changed')
    }
    if (mission.pragma('quick_check', { simple: true }) !== 'ok') fail('post-write quick_check failed')
    mission.exec('COMMIT')
    committed = true
    missionLocked = false
    n8nHandle.db.exec('ROLLBACK')
    n8nLocked = false
    return updated
  } finally {
    if (n8nLocked) {
      try { n8nHandle.db.exec('ROLLBACK') } catch {}
    }
    if (missionLocked && !committed && mission) {
      try { mission.exec('ROLLBACK') } catch {}
    }
    try {
      if (n8nHandle) closeDatabase(n8nHandle)
    } finally {
      try {
        if (missionHandle) closeDatabase(missionHandle)
      } finally {
        if (submissionLock) await submissionLock.release()
      }
    }
  }
}

function reconcileChildInsideImmediate(Database, evidence, input) {
  const missionHandle = openDatabase(Database, evidence.mission.database.path, false)
  const mission = missionHandle.db
  let n8nHandle = null
  let missionLocked = false
  let n8nLocked = false
  let committed = false
  try {
    mission.pragma('busy_timeout = 5000')
    mission.exec('BEGIN IMMEDIATE')
    missionLocked = true
    const now = Math.floor(Date.now() / 1_000)
    const target = validateMissionTarget(mission, input, now)
    activeProcessGuard(input, evidence.mission.database.path, target)
    const targetMatches = rowDigest(target.child) === rowDigest(evidence.target.child)
      && target.parentDigest === evidence.target.parentDigest
      && target.othersDigest === evidence.target.othersDigest
    if (!targetMatches) fail('Mission Control state changed after confirmation')
    if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_AFTER_MISSION_LOCK_COMMAND) {
      run(
        testPath('AIWORKER_TEST_LEGACY_ORPHAN_AFTER_MISSION_LOCK_COMMAND', ''), [],
        'test post-Mission-Control-lock hook',
      )
    }
    n8nHandle = openDatabase(Database, evidence.n8n.database.path, false)
    n8nHandle.db.pragma('busy_timeout = 5000')
    n8nHandle.db.exec('BEGIN IMMEDIATE')
    n8nLocked = true
    const execution = validateN8n(n8nHandle.db, input)
    if (canonicalJson(execution) !== canonicalJson(evidence.execution)) {
      fail('n8n execution changed after confirmation')
    }
    if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_AFTER_DUAL_LOCK_COMMAND) {
      run(
        testPath('AIWORKER_TEST_LEGACY_ORPHAN_AFTER_DUAL_LOCK_COMMAND', ''), [],
        'test post-dual-lock hook',
      )
    }
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
    missionLocked = false
    n8nHandle.db.exec('ROLLBACK')
    n8nLocked = false
    return updated
  } finally {
    if (n8nLocked) {
      try { n8nHandle.db.exec('ROLLBACK') } catch {}
    }
    if (missionLocked && !committed) {
      try { mission.exec('ROLLBACK') } catch {}
    }
    try {
      if (n8nHandle) closeDatabase(n8nHandle)
    } finally { closeDatabase(missionHandle) }
  }
}

async function reconcileInsideImmediate(Database, evidence, input, toolSnapshot) {
  return input.targetKind === 'parent-pre-media'
    ? reconcileParentInsideImmediate(Database, evidence, input, toolSnapshot)
    : reconcileChildInsideImmediate(Database, evidence, input)
}

function verifyPostCommitZero(Database, platform, input, target) {
  const mission = openDatabase(Database, platform.legacy.database.path, true)
  const n8n = openDatabase(Database, platform.n8n.database.path, true)
  try {
    const mediaActive = Number(mission.db.prepare(`
      SELECT COUNT(*) AS count FROM n8n_task_runs
      WHERE source = 'n8n-media-node' AND status IN ('queued', 'accepted', 'running')
    `).get().count)
    if (mediaActive !== 0) fail('post-commit media active count did not reach zero')
    if (input.targetKind === 'parent-pre-media') {
      const modelActive = Number(mission.db.prepare(`
        SELECT COUNT(*) AS count FROM n8n_task_runs
        WHERE source = 'n8n-node' AND status IN ('queued', 'accepted', 'running')
      `).get().count)
      if (modelActive !== 0) fail('post-commit model active count did not reach zero')
      validateN8nIdle(n8n.db)
    } else {
      validateN8n(n8n.db, input)
    }
    activeProcessGuard(input, platform.legacy.database.path, target)
  } finally {
    closeDatabase(mission)
    closeDatabase(n8n)
  }
}

async function main() {
  const argumentsValue = parseArguments(process.argv.slice(2))
  safeEntry(REPOSITORY_ROOT, 'repository root', 'directory')
  if (argumentsValue.mode !== 'apply') {
    const Database = loadDatabase()
    const evidence = await stableLiveState(Database, argumentsValue)
    if (argumentsValue.mode === 'dry-run') {
      const output = argumentsValue.targetKind === 'parent-pre-media'
        ? { mode: 'dry-run', eligible: true, targetKind: 'parent-pre-media', prepareRequired: true }
        : {
            mode: 'dry-run',
            eligible: true,
            childRowId: argumentsValue.childRowId,
            stage: argumentsValue.stage,
            prepareRequired: true,
          }
      process.stdout.write(`${JSON.stringify(output)}\n`)
      return
    }
    const prepared = await createPrepare(Database, argumentsValue, evidence)
    const output = {
      mode: 'prepare',
      eligible: true,
      ...(argumentsValue.targetKind === 'parent-pre-media'
        ? { targetKind: 'parent-pre-media' }
        : { childRowId: argumentsValue.childRowId, stage: argumentsValue.stage }),
      expiresAt: prepared.manifest.expiresAt,
      prepareManifest: prepared.path,
      prepareManifestSha256: prepared.sha256,
      backupManifestSha256: prepared.backup.manifestSha256,
      confirmationToken: prepared.token,
    }
    process.stdout.write(`${JSON.stringify(output)}\n`)
    return
  }
  const prepared = loadPreparedApply(
    argumentsValue.prepareManifest,
    argumentsValue.confirmToken,
  )
  const Database = prepared.Database
  const expected = preparedEvidence(prepared.manifest)
  const live = await stableLiveState(Database, prepared.input)
  if (canonicalJson(live) !== canonicalJson(expected)) {
    fail('live state drifted after prepare; run prepare and obtain confirmation again')
  }
  if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_BEFORE_WRITE_COMMAND) {
    run(testPath('AIWORKER_TEST_LEGACY_ORPHAN_BEFORE_WRITE_COMMAND', ''), [], 'test pre-write hook')
  }
  const finalPlatform = await capturePlatform(prepared.input)
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
  const updated = await reconcileInsideImmediate(
    Database,
    expected,
    prepared.input,
    prepared.toolSnapshot,
  )
  if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_ORPHAN_AFTER_COMMIT_COMMAND) {
    run(testPath('AIWORKER_TEST_LEGACY_ORPHAN_AFTER_COMMIT_COMMAND', ''), [], 'test post-commit hook')
  }
  const postPlatform = await capturePlatform(prepared.input)
  if (canonicalJson({ legacy: finalPlatform.legacy, n8n: finalPlatform.n8n,
    supervisor: finalPlatform.supervisor }) !== canonicalJson({
    legacy: postPlatform.legacy, n8n: postPlatform.n8n, supervisor: postPlatform.supervisor,
  })) fail('runtime identity changed after commit')
  if (prepared.input.targetKind === 'parent-pre-media'
    && (postPlatform.queue.attention !== 0 || postPlatform.queue.waiting !== 0
      || postPlatform.queue.running !== 0 || postPlatform.queue.total !== 0)) {
    fail('post-commit parent queue state did not reach zero')
  }
  verifyPostCommitZero(Database, postPlatform, prepared.input, expected.target)
  const post = openDatabase(Database, finalPlatform.legacy.database.path, true)
  try {
    const rowId = prepared.input.targetKind === 'parent-pre-media'
      ? expected.target.parent.id
      : prepared.input.childRowId
    const errorCode = prepared.input.targetKind === 'parent-pre-media' ? PARENT_ERROR_CODE : ERROR_CODE
    const row = post.db.prepare('SELECT status, error, completed_at, updated_at FROM n8n_task_runs WHERE id = ?')
      .get(rowId)
    if (!row || row.status !== 'failed' || !String(row.error || '').startsWith(`[${errorCode}]`)
      || row.completed_at === null || row.updated_at !== updated.updated_at
      || post.db.pragma('quick_check', { simple: true }) !== 'ok') {
      fail('committed target state or quick_check could not be verified')
    }
  } finally { closeDatabase(post) }
  const output = {
    mode: 'apply',
    reconciled: true,
    ...(prepared.input.targetKind === 'parent-pre-media'
      ? { targetKind: 'parent-pre-media' }
      : { childRowId: prepared.input.childRowId, stage: prepared.input.stage }),
    handoffNonce: prepared.manifest.handoffNonce,
    postApplyQueueDigestSha256: postPlatform.queue.digest,
    backupManifestSha256: prepared.backup.sha256,
    othersDigest: prepared.manifest.target.othersDigest,
    handoffReady: false,
    releaseDecision: 'NO-GO',
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
