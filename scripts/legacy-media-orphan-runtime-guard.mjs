#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPOSITORY_ROOT = realpathSync(join(dirname(SCRIPT_PATH), '..'))
const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const LABEL = 'ai.aiworker.video-lane-supervisor'
const N8N_LABEL = 'com.video-autoworker.n8n'
const INTENT_SCHEMA = 'video-autoworker-legacy-media-orphan-runtime-intent/v1'
const RECEIPT_SCHEMA = 'video-autoworker-legacy-media-orphan-runtime-receipt/v1'
const RESTORE_SCHEMA = 'video-autoworker-legacy-media-orphan-runtime-restore/v1'
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
const MAX_TREE_ENTRIES = 20_000
const MAX_TREE_BYTES = 2 * 1024 * 1024 * 1024
const WAIT_ATTEMPTS = TEST_MODE ? 8 : 150
const WAIT_MILLISECONDS = TEST_MODE ? 5 : 200

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
  if (!['prepare', 'status', 'restore', 'recover'].includes(command)) fail('unknown command')
  const allowed = command === 'prepare'
    ? new Set(['--run-root', '--quarantine-root', '--minimum-age-seconds'])
    : new Set([command === 'recover' ? '--intent' : '--receipt'])
  const values = {}
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    if (!allowed.has(name) || Object.hasOwn(values, name) || index + 1 >= argv.length) fail('arguments are invalid')
    values[name] = argv[index + 1]
  }
  if (argv.length % 2 !== 1 || Object.keys(values).length !== allowed.size) fail('required arguments are missing')
  if (command === 'prepare') {
    const minimumAgeSeconds = Number(values['--minimum-age-seconds'])
    if (!Number.isSafeInteger(minimumAgeSeconds) || minimumAgeSeconds < 900
      || minimumAgeSeconds > 30 * 24 * 60 * 60) fail('minimum age is invalid')
    return {
      command,
      runRoot: normalizedAbsolute(values['--run-root'], 'run root'),
      quarantineRoot: normalizedAbsolute(values['--quarantine-root'], 'quarantine root'),
      minimumAgeSeconds,
    }
  }
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
  return new RegExp(`"?${escaped}"?\\s*=>\\s*true`, 'u').test(source)
}

function workerPids() {
  const result = runStatus(command('PGREP', '/usr/bin/pgrep'), ['-f', 'run-video-batch\\.mjs .*--serve-root'])
  if (result.error || result.signal || ![0, 1].includes(result.status) || (result.status === 1 && result.stdout.trim())) fail('video worker query failed')
  return result.status === 1 ? [] : result.stdout.trim().split(/\s+/u).filter(Boolean).map(Number)
}

function batchProjection(batchRoot, lockPath) {
  safeEntry(batchRoot, 'video batch root', 'directory', 0o700)
  const active = []
  let journals = 0
  const names = []
  const handle = opendirSync(batchRoot)
  try { for (;;) { const item = handle.readSync(); if (!item) break; names.push(item.name) } } finally { handle.closeSync() }
  for (const name of names.sort()) {
    if (join(batchRoot, name) === lockPath || name === '.worker-launch.lock') continue
    if (/\.material-handoff\.json$/u.test(name)) fail('video batch root still contains a material handoff journal')
    if (!/^[a-f0-9]{64}\.json(?:\.bak)?$/u.test(name)) fail('video batch root contains an unknown member')
    if (name.endsWith('.bak')) {
      if (!names.includes(name.slice(0, -4))) fail('video batch backup has no primary')
      continue
    }
    const pathname = join(batchRoot, name)
    const entry = safeEntry(pathname, 'video batch state', 'file')
    if (entry.size > 8n * 1024n * 1024n) fail('video batch state is too large')
    let value
    try { value = JSON.parse(readFileSync(pathname, 'utf8')) } catch { fail('video batch state is invalid JSON') }
    if (![1, 2].includes(value?.schemaVersion) || !Array.isArray(value.items) || typeof value.status !== 'string') fail('video batch state contract is invalid')
    for (const item of value.items) {
      if (!item || typeof item !== 'object' || typeof item.status !== 'string') fail('video batch item contract is invalid')
      if (item.stagingRecovery && item.status !== 'attention') journals += 1
      if (ACTIVE_ITEM.has(item.status)) active.push({ status: item.status, taskHash: sha256(String(item.taskId || '')) })
    }
    if (RUNNABLE_BATCH.has(value.status) && !value.items.some(item => ACTIVE_ITEM.has(item?.status))) {
      active.push({ status: value.status, taskHash: sha256(String(value.batchId || '')) })
    }
  }
  return { runnable: active.length, journals, digest: sha256(canonicalJson(active)) }
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

function laneSnapshot(batchRoot, plistPath, phase) {
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
    const projection = batchProjection(batchRoot, lock.path)
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

function locateOrphan(missionPath, n8nPath, minimumAgeSeconds) {
  const mission = new Database(missionPath, { readonly: true, fileMustExist: true })
  const n8n = new Database(n8nPath, { readonly: true, fileMustExist: true })
  try {
    quickCheck(mission, 'Mission Control database')
    quickCheck(n8n, 'n8n database')
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
    const workspace = join(dirname(missionPath), 'media-tasks', sha256(parent.task_id))
    return {
      child: { id: child.id, taskId: child.task_id, status: child.status, updatedAt: child.updated_at, stage },
      parent: { id: parent.id, taskId: parent.task_id, status: parent.status, digest: sha256(canonicalJson(parent)) },
      execution: { id: executions[0].id, status: executions[0].status, digest: sha256(executions[0].data) },
      workspace,
    }
  } finally { mission.close(); n8n.close() }
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
  const mission = findOpenPath(legacyRecords, /\/mission-control\.db$/u, 'Mission Control database')
  const n8nDatabase = findOpenPath(n8nRecords, /\/database\.sqlite$/u, 'n8n database')
  const n8nLaunch = launchState(N8N_LABEL)
  if (!n8nLaunch.loaded || n8n.ppid !== n8nLaunch.pid) fail('n8n is not the direct child of its LaunchAgent')
  const orphan = locateOrphan(mission.path, n8nDatabase.path, minimumAgeSeconds)
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
    validateSnapshotShape(value, phase)
    return value
  }
  return productionSnapshot(minimumAgeSeconds, phase)
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
  delete clone.lane
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

function guardianPayload(token, createdAt) {
  return `${canonicalJson({ pid: process.pid, createdAt, token, updatedAt: new Date().toISOString() })}\n`
}

function openLaunchGuardian(batchRoot, plan, takeover = false) {
  const pathname = launchGuardianPath(batchRoot)
  const createdAt = plan.createdAt
  if (typeof plan?.token !== 'string' || !/^[a-f0-9]{64}$/u.test(plan.token)
    || typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) {
    fail('video worker launch guardian plan is invalid')
  }
  if (takeover && (plan.path !== pathname || !plan.dev || !plan.ino
    || plan.uid !== process.getuid() || plan.mode !== 0o600
    || plan.tokenSha256 !== sha256(plan.token))) {
    fail('video worker launch guardian takeover plan is invalid')
  }
  let descriptor
  if (takeover) {
    const entry = safeEntry(pathname, 'video worker launch guardian', 'file', 0o600)
    descriptor = openSync(pathname, constants.O_RDWR | constants.O_NOFOLLOW)
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino) {
      closeSync(descriptor)
      fail('video worker launch guardian changed before takeover')
    }
    const source = readFileSync(descriptor, 'utf8')
    let value
    try { value = JSON.parse(source) } catch { fail('video worker launch guardian is invalid JSON') }
    if (entry.dev.toString() !== plan.dev || entry.ino.toString() !== plan.ino
      || sha256(String(value?.token || '')) !== plan.tokenSha256
      || value?.createdAt !== plan.createdAt
      || !Number.isFinite(Date.parse(value?.updatedAt))
      || !Number.isSafeInteger(value?.pid) || value.pid <= 0) {
      closeSync(descriptor)
      fail('video worker launch guardian cannot be taken over')
    }
    const old = runStatus(command('PS', '/bin/ps'), ['-p', String(value.pid), '-o', 'pid='])
    if (old.error || old.signal || ![0, 1].includes(old.status) || old.status === 0 || old.stdout.trim()) {
      closeSync(descriptor)
      fail('previous video worker launch guardian PID still exists or was reused')
    }
  } else {
    if (optionalEntry(pathname)) fail('video worker launch lock already exists')
    descriptor = openSync(pathname, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  }
  recordTestEvent(takeover ? 'guardian:takeover' : 'guardian:create')
  const token = plan.token
  const refresh = () => {
    const entry = fstatSync(descriptor, { bigint: true })
    const current = optionalEntry(pathname)
    if (!current || current.dev !== entry.dev || current.ino !== entry.ino) {
      fail('video worker launch guardian path was replaced')
    }
    const source = guardianPayload(token, createdAt)
    ftruncateSync(descriptor, 0)
    writeSync(descriptor, source, 0, 'utf8')
    fsyncSync(descriptor)
    const verified = readFileSync(pathname, 'utf8')
    if (verified !== source) fail('video worker launch guardian refresh failed')
    recordTestEvent('guardian:refresh')
  }
  refresh()
  const opened = fstatSync(descriptor, { bigint: true })
  const identityValue = {
    path: pathname,
    dev: opened.dev.toString(),
    ino: opened.ino.toString(),
    uid: Number(opened.uid),
    mode: Number(opened.mode & 0o7777n),
  }
  if (identityValue.uid !== process.getuid() || identityValue.mode !== 0o600) fail('video worker launch guardian identity is unsafe')
  if (takeover && (identityValue.dev !== plan.dev || identityValue.ino !== plan.ino)) {
    fail('video worker launch guardian takeover identity changed')
  }
  if (!takeover) fsyncDirectory(batchRoot)
  const timer = setInterval(() => {
    try { refresh() } catch { /* The foreground verifier will fail closed. */ }
  }, 5_000)
  timer.unref()
  let released = false
  return {
    ...identityValue,
    tokenSha256: sha256(token),
    createdAt,
    verify() {
      if (released) fail('video worker launch guardian was already released')
      refresh()
      const current = identity(pathname, 'video worker launch guardian', 'file', 0o600)
      if (!sameIdentity(current, identityValue)) fail('video worker launch guardian identity drifted')
    },
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
      unlinkSync(pathname)
      recordTestEvent('guardian:release')
      fsyncDirectory(batchRoot)
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

async function enableAndStart(minimumAgeSeconds, before) {
  const domain = `gui/${process.getuid()}`
  action(['enable', `${domain}/${LABEL}`], 'video-lane enable')
  if (!launchState().loaded) action(['bootstrap', domain, before.plistPath], 'video-lane bootstrap')
  const active = await waitForSnapshot(minimumAgeSeconds, 'active')
  assertStable(before.protectedPids, active.protectedPids, 'protected listener PID set')
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
  try {
    launchGuardian = openLaunchGuardian(first.batchRoot, {
      token: guardianToken,
      createdAt: guardianCreatedAt,
    })
    intent = {
      schema: INTENT_SCHEMA,
      createdAt: Math.floor(Date.now() / 1000),
      nonce,
      minimumAgeSeconds: values.minimumAgeSeconds,
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
        token: guardianToken,
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
      },
      source: moved.source,
      target: moved.target,
      tree: moved.tree,
    }
    const receiptPath = join(attemptDirectory, 'receipt.json')
    const receipt = immutableJson(receiptPath, receiptValue)
    writeAnchor(join(attemptDirectory, 'receipt.anchor.json'), 'receipt', receipt, intentWritten.sha256)
    chmodSync(attemptDirectory, 0o500)
    fsyncDirectory(attemptDirectory)
    fsyncDirectory(values.runRoot)
    launchGuardian.release()
    process.stdout.write(`${JSON.stringify({ mode: 'prepared', receipt: receiptPath, receiptSha256: receipt.sha256 })}\n`)
  } catch (error) {
    const failures = [error instanceof Error ? error.message : String(error)]
    if (moved) {
      try { reverseRename(first.orphan.workspace, target, moved.target, moved.tree) } catch (rollbackError) { failures.push(`workspace rollback failed: ${rollbackError.message}`) }
    }
    let mayResume = true
    if (laneChanged) {
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

function validateReceipt(pathname, allowReplacementLock = false) {
  const loaded = readImmutableJson(pathname, 'runtime guard receipt')
  const value = loaded.value
  if (value?.schema !== RECEIPT_SCHEMA || !SHA256.test(value.toolSha256) || !value.intent?.path
    || !value.source?.path || !value.target?.path || !value.tree?.digest || !value.deadLock || !value.launchGuardian
    || value.intent.sha256 === undefined) fail('runtime guard receipt contract is invalid')
  if (value.toolSha256 !== toolSha256()) fail('runtime guard tool changed after prepare')
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
    || guardian.createdAt !== value.launchGuardian.createdAt) fail('runtime guard launch guardian binding is invalid')
  validateAnchor(join(dirname(pathname), 'receipt.anchor.json'), 'receipt', loaded, intent.sha256)
  validateLockEvidence(value.deadLock, dirname(pathname), allowReplacementLock)
  return { loaded, value, intent }
}

function restoreReceiptPath(receiptPath) {
  return join(dirname(receiptPath), 'restore.json')
}

async function validatePrepared(receiptPath, chain, activeGuardian = null) {
  const { value } = chain
  if (activeGuardian) activeGuardian.verify()
  else if (optionalEntry(value.launchGuardian.path)) fail('video worker launch guardian was not released')
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

function validateRestoreReceipt(pathname, chain) {
  const loaded = readImmutableJson(pathname, 'runtime guard restore receipt')
  const value = loaded.value
  if (value?.schema !== RESTORE_SCHEMA || value.nonce !== chain.value.nonce
    || value.preparedReceiptSha256 !== chain.loaded.sha256 || value.source?.path !== chain.value.source.path) fail('restore receipt contract is invalid')
  validateAnchor(join(dirname(pathname), 'restore.anchor.json'), 'restore', loaded, chain.intent.sha256)
  return loaded
}

async function status(values) {
  const restorePath = restoreReceiptPath(values.pathname)
  const restored = Boolean(optionalEntry(restorePath))
  const chain = validateReceipt(values.pathname, restored)
  if (!restored) {
    await validatePrepared(values.pathname, chain)
    process.stdout.write(`${JSON.stringify({ mode: 'prepared', receipt: values.pathname })}\n`)
    return
  }
  validateRestoreReceipt(restorePath, chain)
  if (optionalEntry(chain.value.target.path)) fail('restored quarantine target still exists')
  const source = identity(chain.value.source.path, 'restored workspace', 'directory', 0o700)
  if (source.dev !== chain.value.source.dev || source.ino !== chain.value.source.ino) fail('restored workspace identity changed')
  const tree = treeSnapshot(source.path, 'restored workspace')
  if (tree.digest !== chain.value.tree.digest || tree.entries !== chain.value.tree.entries || tree.bytes !== chain.value.tree.bytes) fail('restored workspace tree changed')
  const active = await captureSnapshot(chain.value.minimumAgeSeconds, 'active')
  assertStable(chain.value.runtimeBefore.protectedPids, active.protectedPids, 'restored protected listener PID set')
  process.stdout.write(`${JSON.stringify({ mode: 'restored', receipt: values.pathname })}\n`)
}

async function restore(values) {
  const restorePath = restoreReceiptPath(values.pathname)
  if (optionalEntry(restorePath)) return status(values)
  const chain = validateReceipt(values.pathname)
  let launchGuardian = openLaunchGuardian(chain.value.runtimeBefore.batchRoot, {
    token: randomBytes(32).toString('hex'),
    createdAt: new Date().toISOString(),
  })
  let restored = false
  let laneActive = false
  try {
    const prepared = await validatePrepared(values.pathname, chain, launchGuardian)
    launchGuardian.verify()
    reverseRename(chain.value.source.path, chain.value.target.path, prepared.target, prepared.tree)
    restored = true
    launchGuardian.verify()
    launchGuardian.release()
    launchGuardian = null
    const active = await enableAndStart(chain.value.minimumAgeSeconds, chain.value.runtimeBefore)
    laneActive = true
    chmodSync(dirname(values.pathname), 0o700)
    const receipt = immutableJson(restorePath, {
      schema: RESTORE_SCHEMA,
      createdAt: Math.floor(Date.now() / 1000),
      nonce: chain.value.nonce,
      preparedReceiptSha256: chain.loaded.sha256,
      source: identity(chain.value.source.path, 'restored workspace', 'directory', 0o700),
      runtimeActive: active,
    })
    writeAnchor(join(dirname(values.pathname), 'restore.anchor.json'), 'restore', receipt, chain.intent.sha256)
    chmodSync(dirname(values.pathname), 0o500)
    fsyncDirectory(dirname(values.pathname))
    fsyncDirectory(dirname(dirname(values.pathname)))
    process.stdout.write(`${JSON.stringify({ mode: 'restored', receipt: values.pathname, restoreReceiptSha256: receipt.sha256 })}\n`)
  } catch (error) {
    const failures = [error instanceof Error ? error.message : String(error)]
    if (launchGuardian) {
      try { launchGuardian.release() } catch (rollbackError) { failures.push(`launch guardian release failed: ${rollbackError.message}`) }
    }
    if (laneActive) {
      try { disableAndStop(chain.value.runtimeBefore.plistPath); await waitForSnapshot(chain.value.minimumAgeSeconds, 'quiesced') } catch (rollbackError) { failures.push(`lane re-quiesce failed: ${rollbackError.message}`) }
    }
    if (restored && !optionalEntry(chain.value.target.path)) {
      try { renameWorkspace(chain.value.source.path, chain.value.target.path, { ...chain.value.tree, root: chain.value.source }) } catch (rollbackError) { failures.push(`workspace re-quarantine failed: ${rollbackError.message}`) }
    }
    fail(failures.join('; '))
  }
}

async function recover(values) {
  const intent = readImmutableJson(values.pathname, 'runtime guard intent')
  const value = intent.value
  if (value?.schema !== INTENT_SCHEMA || !value.source?.root?.path || !value.target || !value.runtime
    || value.toolSha256 !== toolSha256() || !value.launchGuardian?.token) fail('runtime guard intent contract is invalid')
  const attemptDirectory = dirname(values.pathname)
  const launchGuardian = openLaunchGuardian(value.runtime.batchRoot, value.launchGuardian, true)
  try {
    const source = optionalEntry(value.source.root.path)
    const target = optionalEntry(value.target)
    if (source && !target) {
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
      const deadLock = recoverLockEvidence(value, attemptDirectory, true)
      const targetIdentity = identity(value.target, 'quarantined workspace', 'directory', 0o700)
      if (targetIdentity.dev !== value.source.root.dev || targetIdentity.ino !== value.source.root.ino) fail('post-SIGKILL target identity differs')
      const tree = treeSnapshot(value.target, 'quarantined workspace')
      if (tree.digest !== value.source.digest || tree.entries !== value.source.entries || tree.bytes !== value.source.bytes) fail('post-SIGKILL target tree differs')
      launchGuardian.verify()
      const quiesced = await waitForSnapshot(value.minimumAgeSeconds, 'quiesced')
      assertStable(stableComparable(value.runtime), stableComparable(quiesced), 'recovered runtime identity')
      const receiptPath = join(attemptDirectory, 'receipt.json')
      const receipt = immutableJson(receiptPath, {
        schema: RECEIPT_SCHEMA,
        createdAt: Math.floor(Date.now() / 1000),
        nonce: value.nonce,
        toolSha256: value.toolSha256,
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
        },
        source: value.source.root,
        target: targetIdentity,
        tree,
      })
      writeAnchor(join(attemptDirectory, 'receipt.anchor.json'), 'receipt', receipt, intent.sha256)
      chmodSync(attemptDirectory, 0o500)
      fsyncDirectory(attemptDirectory)
      fsyncDirectory(dirname(attemptDirectory))
      launchGuardian.release()
      process.stdout.write(`${JSON.stringify({ mode: 'recovered-after-rename', receipt: receiptPath, receiptSha256: receipt.sha256 })}\n`)
      return
    }
    fail('SIGKILL recovery state is ambiguous')
  } catch (error) {
    try { launchGuardian.release() } catch { /* Preserve the primary recovery failure. */ }
    throw error
  }
}

export async function main(argv = process.argv.slice(2)) {
  const values = parseArguments(argv)
  if (values.command === 'prepare') return prepare(values)
  if (values.command === 'status') return status(values)
  if (values.command === 'restore') return restore(values)
  return recover(values)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
