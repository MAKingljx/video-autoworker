#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCHEMA = 'video-autoworker-legacy-freeze-evidence/v3'
const GUARD_SCHEMA = 'video-autoworker-legacy-freeze-guard/v1'
const LABEL = 'ai.aiworker.video-lane-supervisor'
const N8N_LABEL = 'com.video-autoworker.n8n'
const SHA256 = /^[a-f0-9]{64}$/u
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u
const scriptPath = fileURLToPath(import.meta.url)
const defaultRepositoryRoot = realpathSync(join(dirname(scriptPath), '..'))
const guardScript = join(defaultRepositoryRoot, 'scripts/legacy-freeze-guard.mjs')
const testMode = process.env.NODE_ENV === 'test'
  && process.env.AIWORKER_TEST_LEGACY_FREEZE === '1'

function fail(message) {
  throw new Error(`legacy freeze evidence failed: ${message}`)
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

export function hashFileStable(pathname, label = 'file') {
  const entry = safeEntry(pathname, label, 'file')
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      fail(`${label} changed before hashing`)
    }
    const digest = createHash('sha256')
    const block = Buffer.allocUnsafe(1024 * 1024)
    let position = 0
    while (position < Number(opened.size)) {
      const length = readSync(fd, block, 0, Math.min(block.length, Number(opened.size) - position), position)
      if (length <= 0) fail(`${label} short read`)
      digest.update(block.subarray(0, length))
      position += length
    }
    const afterFd = fstatSync(fd, { bigint: true })
    const afterPath = lstatSync(pathname, { bigint: true })
    if (afterFd.dev !== opened.dev || afterFd.ino !== opened.ino || afterFd.size !== opened.size
      || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || afterPath.size !== opened.size) {
      fail(`${label} changed while hashing`)
    }
    return digest.digest('hex')
  } finally { closeSync(fd) }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail(`${label} fields are invalid`)
  }
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} is invalid`)
  return value
}

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`)
  return value
}

function assertAbsolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} must be one normalized absolute path`)
}

export function assertNoSymlink(pathname, label) {
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

function safeEntry(pathname, label, kind, mode = null) {
  assertNoSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if (kind === 'file' && !entry.isFile()) fail(`${label} is not a regular file`)
  if (kind === 'directory' && !entry.isDirectory()) fail(`${label} is not a directory`)
  if (entry.uid !== BigInt(process.getuid())) fail(`${label} owner is invalid`)
  const actualMode = Number(entry.mode & 0o7777n)
  if (mode !== null ? actualMode !== mode : (actualMode & 0o022) !== 0) {
    fail(`${label} mode is unsafe`)
  }
  return entry
}

function identity(pathname, label, kind = 'file') {
  const entry = safeEntry(pathname, label, kind)
  return { path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString() }
}

function parseArguments(argv) {
  const names = ['--output', '--slot', '--release-id', '--standalone-root', '--rollback-proof']
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!names.includes(name) || !value || Object.hasOwn(values, name)) fail(`expected ${names.join(', ')}`)
    values[name] = value
  }
  if (Object.keys(values).length !== names.length) fail(`expected ${names.join(', ')}`)
  if (!['blue', 'green'].includes(values['--slot'])) fail('slot must be blue or green')
  if (!RELEASE_ID.test(values['--release-id'])) fail('release ID is invalid')
  assertAbsolute(values['--output'], 'output')
  assertAbsolute(values['--standalone-root'], 'standalone root')
  return {
    output: values['--output'],
    slot: values['--slot'],
    releaseId: values['--release-id'],
    standaloneRoot: values['--standalone-root'],
    rollbackProof: values['--rollback-proof'],
  }
}

function testPath(name, fallback) {
  if (!testMode) return fallback
  const value = process.env[name]
  if (!value) return fallback
  assertAbsolute(value, name)
  return value
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

function listenerPid(port) {
  const source = run('/usr/sbin/lsof', [
    '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp',
  ], `${port} listener query`)
  const pids = [...new Set(source.split('\n').filter(line => /^p[1-9][0-9]*$/u.test(line))
    .map(line => Number(line.slice(1))))]
  if (pids.length !== 1) fail(`port ${port} does not have exactly one listener`)
  return pids[0]
}

function optionalListenerPids(port) {
  const result = spawnSync('/usr/sbin/lsof', [
    '-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp',
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000 })
  if (result.error || result.signal || ![0, 1].includes(result.status)) {
    fail(`${port} listener query failed`)
  }
  return [...new Set(result.stdout.split('\n').filter(line => /^p[1-9][0-9]*$/u.test(line))
    .map(line => Number(line.slice(1))))]
}

function openRecords(pid) {
  return parseLsof(run('/usr/sbin/lsof', [
    '-a', '-p', String(pid), '-FfDin',
  ], `PID ${pid} open-file query`))
}

export function captureOpenFileRecords(pid) {
  positiveInteger(pid, 'open-file PID')
  return openRecords(pid)
}

function exactOpenIdentity(records, expected, label, descriptors = null) {
  const matches = records.filter(record => record.path === expected.path
    && record.dev === expected.dev && record.ino === expected.ino
    && (!descriptors || descriptors.test(record.descriptor || '')))
  if (matches.length < 1) fail(`${label} is not bound to the process open-file identity`)
}

function cwdIdentity(records, label) {
  const cwd = records.find(record => record.descriptor === 'cwd')
  if (!cwd?.path || cwd.dev === undefined || cwd.ino === undefined) fail(`${label} cwd is unavailable`)
  const expected = identity(cwd.path, `${label} cwd`, 'directory')
  exactOpenIdentity(records, expected, `${label} cwd`, /^cwd$/u)
  return expected
}

function processIncarnation(pid, label) {
  const rawUid = run('/bin/ps', ['-p', String(pid), '-o', 'uid='], `${label} uid`).trim()
  const rawPpid = run('/bin/ps', ['-p', String(pid), '-o', 'ppid='], `${label} parent`).trim()
  const startTime = run('/bin/ps', ['-p', String(pid), '-o', 'lstart='], `${label} start time`).trim()
  const argv = run('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], `${label} argv`).trim()
  return {
    pid,
    ppid: positiveInteger(Number(rawPpid), `${label} ppid`),
    uid: nonNegativeInteger(Number(rawUid), `${label} uid`),
    startTime,
    argvSha256: sha256(argv),
  }
}

function processFields(pid, records, label) {
  const incarnation = processIncarnation(pid, label)
  // Darwin does not ship proc_pidpath(1), and Node/Next may rewrite the process
  // title so ps comm/argv cannot be treated as the executable pathname. lsof's
  // txt set is kernel-backed: require exactly one physical Node executable and
  // bind its device/inode together with the independently captured argv digest.
  const nodeText = records.filter(record => record.descriptor === 'txt'
    && /\/bin\/node$/u.test(record.path || '')
    && record.dev !== undefined && record.ino !== undefined)
  if (nodeText.length !== 1) fail(`${label} does not have exactly one Node executable text mapping`)
  const executable = identity(nodeText[0].path, `${label} executable`)
  exactOpenIdentity(records, executable, `${label} executable`, /^txt$/u)
  return {
    ...incarnation,
    executable,
    cwd: cwdIdentity(records, label),
  }
}

export function captureProcessIdentity(pid, label = 'process') {
  positiveInteger(pid, `${label} PID`)
  return processFields(pid, openRecords(pid), label)
}

export function classifyEvidencedLegacyProcess(expected, current, listeners) {
  const uniqueListeners = [...new Set(listeners)]
  if (uniqueListeners.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) {
    fail('router listener PID set is invalid')
  }
  if (uniqueListeners.length > 1 || (uniqueListeners.length === 1
    && uniqueListeners[0] !== expected.pid)) {
    fail('router port 3017 is occupied by a process other than the evidenced legacy runtime')
  }
  if (current === null) return 'stopped'
  const stableKeys = ['pid', 'ppid', 'uid', 'startTime', 'argvSha256']
  const sameIncarnation = stableKeys.every(key => current[key] === expected[key])
  if (!sameIncarnation) {
    if (uniqueListeners.length) {
      fail('the evidenced legacy PID was reused by another process listening on router port 3017')
    }
    return 'stopped'
  }
  if (canonicalJson(current) !== canonicalJson(expected)) {
    fail('the evidenced legacy process identity changed without a PID incarnation change')
  }
  return 'alive'
}

function probeEvidencedLegacyProcess(descriptor, routerPort) {
  if (!Number.isSafeInteger(descriptor) || descriptor < 3) fail('evidence file descriptor is invalid')
  if (!Number.isSafeInteger(routerPort) || routerPort !== 3017) fail('router port must be 3017')
  const opened = fstatSync(descriptor, { bigint: true })
  if (!opened.isFile() || Number(opened.mode & 0o7777n) !== 0o600
    || opened.uid !== BigInt(process.getuid()) || opened.nlink !== 1n) {
    fail('opened evidence file identity is unsafe')
  }
  const buffer = Buffer.alloc(Number(opened.size))
  if (readSync(descriptor, buffer, 0, buffer.length, 0) !== buffer.length) fail('evidence short read')
  let evidence
  try { evidence = JSON.parse(buffer) } catch { fail('evidence is invalid JSON') }
  exactKeys(evidence, [
    'counts', 'frozen', 'generatorSha256', 'legacy', 'n8n', 'observedAt',
    'queueDigestSha256', 'rollback', 'schema', 'supervisor', 'target',
  ], 'evidence')
  if (evidence.schema !== SCHEMA) fail('evidence schema is invalid')
  validateSnapshot({
    legacy: evidence.legacy,
    n8n: evidence.n8n,
    counts: evidence.counts,
    queueDigestSha256: evidence.queueDigestSha256,
    supervisor: evidence.supervisor,
    frozen: evidence.frozen,
  }, { allowExpiredGuard: true })
  const expected = evidence.legacy
  const listeners = optionalListenerPids(routerPort)
  let current = null
  try {
    process.kill(expected.pid, 0)
  } catch (error) {
    if (error?.code !== 'ESRCH') fail('unable to query evidenced legacy PID')
    return classifyEvidencedLegacyProcess(expected, null, listeners)
  }
  let partial
  try {
    partial = processIncarnation(expected.pid, 'legacy 3017')
  } catch (error) {
    try { process.kill(expected.pid, 0) } catch (secondError) {
      if (secondError?.code === 'ESRCH') {
        return classifyEvidencedLegacyProcess(expected, null, listeners)
      }
    }
    throw error
  }
  const stableKeys = ['pid', 'ppid', 'uid', 'startTime', 'argvSha256']
  if (stableKeys.every(key => partial[key] === expected[key])) {
    try {
      const records = openRecords(expected.pid)
      const fullProcess = processFields(expected.pid, records, 'legacy 3017')
      const database = identity(expected.database.path, 'Mission Control database')
      exactOpenIdentity(records, database, 'Mission Control database', /^\d+[A-Za-z]*$/u)
      const releaseParts = fullProcess.cwd.path.split('/')
      const releasesIndex = releaseParts.lastIndexOf('releases')
      const releaseId = releasesIndex >= 0 ? releaseParts[releasesIndex + 1] : ''
      current = { ...fullProcess, database, releaseId, routerPort }
    } catch (error) {
      try { process.kill(expected.pid, 0) } catch (secondError) {
        if (secondError?.code === 'ESRCH') {
          return classifyEvidencedLegacyProcess(expected, null, listeners)
        }
      }
      throw error
    }
  } else {
    current = partial
  }
  return classifyEvidencedLegacyProcess(expected, current, listeners)
}

function findDatabase(records, matcher, label) {
  const paths = [...new Set(records.filter(record => matcher.test(record.path || ''))
    .map(record => record.path))]
  if (paths.length !== 1) fail(`${label} process does not have exactly one authoritative database`)
  const database = identity(paths[0], label)
  exactOpenIdentity(records, database, label, /^\d+[A-Za-z]*$/u)
  return database
}

export function validateDatabaseBinding(pathname, records, label = 'database') {
  const database = identity(pathname, label)
  exactOpenIdentity(records, database, label, /^\d+[A-Za-z]*$/u)
  return database
}

function numericDatabaseRecords(records) {
  return records.filter(record => /^\d+[A-Za-z]*$/u.test(record.descriptor || '')
    && record.dev !== undefined && record.ino !== undefined)
}

export function validateNewDatabaseConnection(expected, beforeRecords, afterRecords, label = 'database') {
  const current = identity(expected.path, label)
  if (canonicalJson(current) !== canonicalJson(expected)) fail(`${label} does not match the precaptured identity`)
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

export function revalidateDatabaseConnection(expected, descriptor, records, label = 'database') {
  const current = identity(expected.path, label)
  const matches = numericDatabaseRecords(records).filter(record => record.descriptor === descriptor
    && record.path === expected.path && record.dev === expected.dev && record.ino === expected.ino)
  if (canonicalJson(current) !== canonicalJson(expected) || matches.length !== 1) {
    fail(`${label} SQLite connection identity changed`)
  }
}

function openDatabases(repositoryRoot, missionIdentity, n8nIdentity) {
  let Database
  try {
    const scopedRequire = createRequire(import.meta.url)
    Database = scopedRequire(scopedRequire.resolve('better-sqlite3', { paths: [defaultRepositoryRoot] }))
  } catch { fail('better-sqlite3 is unavailable') }
  const open = (value, label) => {
    const before = openRecords(process.pid)
    const db = new Database(value.path, { readonly: true, fileMustExist: true })
    db.pragma('query_only = ON')
    if (db.pragma('quick_check', { simple: true }) !== 'ok') fail(`${label} quick_check failed`)
    const descriptor = validateNewDatabaseConnection(
      value, before, openRecords(process.pid), `${label} verifier FD`,
    )
    return { db, descriptor, identity: value, label }
  }
  let mission
  let n8n
  try {
    mission = open(missionIdentity, 'Mission Control database')
    const mediaNodes = Number(mission.db.prepare(`
      SELECT COUNT(*) AS count FROM n8n_task_runs
      WHERE source = 'n8n-media-node' AND status IN ('queued', 'accepted', 'running')
    `).get().count)
    n8n = open(n8nIdentity, 'n8n database')
    const n8nActiveExecutions = Number(n8n.db.prepare(`
      SELECT COUNT(*) AS count FROM execution_entity
      WHERE status IN ('new', 'running', 'waiting') AND "stoppedAt" IS NULL
    `).get().count)
    // Keep both SQLite handles open while rebinding them a second time. This
    // rejects a path/inode ABA replacement during either query window.
    const finalRecords = openRecords(process.pid)
    revalidateDatabaseConnection(mission.identity, mission.descriptor, finalRecords, mission.label)
    revalidateDatabaseConnection(n8n.identity, n8n.descriptor, finalRecords, n8n.label)
    return { mediaNodes, n8nActiveExecutions }
  } finally {
    try { mission?.db.close() } catch {}
    try { n8n?.db.close() } catch {}
  }
}

async function queueState() {
  let response
  try {
    response = await fetch('http://127.0.0.1:3017/api/n8n/runs?view=queue', {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8_000),
    })
  } catch { fail('persistent queue endpoint is unavailable') }
  if (!response.ok) fail(`persistent queue endpoint returned HTTP ${response.status}`)
  let value
  try { value = await response.json() } catch { fail('persistent queue endpoint is not JSON') }
  exactKeys(value.counts, ['attention', 'running', 'waiting'], 'persistent queue counts')
  if (!Array.isArray(value.queue) || value.total !== value.queue.length) fail('persistent queue shape is invalid')
  const projection = value.queue.map(item => ({
    taskId: String(item?.taskId || ''),
    status: String(item?.status || ''),
    updatedAt: item?.updatedAt,
    stale: item?.stale,
    sourceAvailable: item?.sourceAvailable,
  }))
  if (projection.some(item => !item.taskId || !Number.isSafeInteger(item.updatedAt)
    || typeof item.stale !== 'boolean'
    || ![true, false, null].includes(item.sourceAvailable))) fail('persistent queue item is invalid')
  return {
    waiting: nonNegativeInteger(value.counts.waiting, 'queue waiting'),
    running: nonNegativeInteger(value.counts.running, 'queue running'),
    digest: sha256(canonicalJson(projection)),
  }
}

function supervisorState() {
  const uid = process.getuid()
  const service = `gui/${uid}/${LABEL}`
  const loaded = runStatus('/bin/launchctl', ['print', service]).status === 0
  const disabledSource = run('/bin/launchctl', [
    'print-disabled', `gui/${uid}`,
  ], 'video-lane disabled-state query')
  const escaped = LABEL.replaceAll('.', '\\.')
  const disabled = new RegExp(`"?${escaped}"?\\s*=>\\s*true`, 'u').test(disabledSource)
  const batchRoot = join(process.env.HOME, 'ai-worker/state/video-autoworker/video-batches')
  const lockPath = join(batchRoot, '.global-video-worker.lock')
  let lockAbsent = false
  try {
    lstatSync(lockPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') fail('video-lane global lock state is unreadable')
    lockAbsent = true
  }
  const workers = runStatus('/usr/bin/pgrep', [
    '-f', 'run-video-batch\\.mjs .*--serve-root',
  ])
  const workerPids = workerPidsFromPgrep(workers.status, workers.stdout, workers.error)
  if (loaded || !disabled || !lockAbsent || workerPids.some(value => !Number.isSafeInteger(value))) {
    fail('video-lane supervisor is not disabled, unloaded, worker-free, and lock-free')
  }
  return { disabled, loaded, workerPids, lockAbsent }
}

export function workerPidsFromPgrep(status, stdout, error = null) {
  if (error || ![0, 1].includes(status) || typeof stdout !== 'string'
    || (status === 1 && stdout.trim())) fail('video worker process query failed')
  const values = status === 1 ? [] : stdout.trim().split(/\s+/u).filter(Boolean).map(Number)
  if (values.some(value => !Number.isSafeInteger(value) || value <= 0)) {
    fail('video worker process query failed')
  }
  return values
}

function launchPid(label) {
  const output = run('/bin/launchctl', [
    'print', `gui/${process.getuid()}/${label}`,
  ], `${label} LaunchAgent query`)
  const matches = [...output.matchAll(/^\s*pid = ([1-9][0-9]*)\s*$/gmu)]
  if (matches.length !== 1 || !/^\s*state = running\s*$/mu.test(output)) {
    fail(`${label} is not one running LaunchAgent job`)
  }
  return Number(matches[0][1])
}

export async function captureProduction(repositoryRoot = defaultRepositoryRoot) {
  const legacyPid = listenerPid(3017)
  const n8nPid = listenerPid(5678)
  const legacyRecords = openRecords(legacyPid)
  const n8nRecords = openRecords(n8nPid)
  const legacyProcess = processFields(legacyPid, legacyRecords, 'legacy 3017')
  const n8nProcess = processFields(n8nPid, n8nRecords, 'n8n')
  const releaseParts = legacyProcess.cwd.path.split('/')
  const releasesIndex = releaseParts.lastIndexOf('releases')
  const legacyReleaseId = releasesIndex >= 0 ? releaseParts[releasesIndex + 1] : ''
  if (!RELEASE_ID.test(legacyReleaseId)) fail('legacy 3017 cwd is not inside a named release')
  const missionDatabase = findDatabase(legacyRecords, /\/mission-control\.db$/u, 'Mission Control database')
  const n8nDatabase = findDatabase(n8nRecords, /\/database\.sqlite$/u, 'n8n database')
  const n8nLaunchPid = launchPid(N8N_LABEL)
  if (n8nProcess.ppid !== n8nLaunchPid) fail('n8n listener is not a direct child of its LaunchAgent')
  const databaseCounts = openDatabases(repositoryRoot, missionDatabase, n8nDatabase)
  const queue = await queueState()
  const frozen = freezeGuard(missionDatabase, n8nDatabase)
  return {
    legacy: {
      ...legacyProcess,
      releaseId: legacyReleaseId,
      routerPort: 3017,
      database: missionDatabase,
    },
    n8n: {
      ...n8nProcess,
      launchPid: n8nLaunchPid,
      port: 5678,
      database: n8nDatabase,
    },
    counts: {
      mediaNodes: databaseCounts.mediaNodes,
      n8nActiveExecutions: databaseCounts.n8nActiveExecutions,
      queueWaiting: queue.waiting,
      queueRunning: queue.running,
    },
    queueDigestSha256: queue.digest,
    supervisor: supervisorState(),
    frozen,
  }
}

async function captureSnapshot(repositoryRoot) {
  if (!testMode) return captureProduction(repositoryRoot)
  const command = testPath('AIWORKER_TEST_LEGACY_FREEZE_SNAPSHOT_COMMAND', '')
  if (!command) fail('test snapshot command is required')
  safeEntry(command, 'test snapshot command', 'file')
  const result = run(command, [], 'test snapshot command')
  try { return JSON.parse(result) } catch { fail('test snapshot command returned invalid JSON') }
}

function validateFileIdentity(value, label) {
  exactKeys(value, ['dev', 'ino', 'path'], label)
  assertAbsolute(value.path, `${label} path`)
  if (!/^\d+$/u.test(value.dev) || !/^\d+$/u.test(value.ino)) fail(`${label} identity is invalid`)
}

function validateProcess(value, label, extraKeys) {
  exactKeys(value, [
    'argvSha256', 'cwd', 'database', 'executable', 'pid', 'ppid', 'startTime', 'uid', ...extraKeys,
  ], label)
  positiveInteger(value.pid, `${label} PID`)
  positiveInteger(value.ppid, `${label} parent PID`)
  nonNegativeInteger(value.uid, `${label} uid`)
  if (!value.startTime || !SHA256.test(value.argvSha256)) fail(`${label} process identity is invalid`)
  validateFileIdentity(value.cwd, `${label} cwd`)
  validateFileIdentity(value.database, `${label} database`)
  validateFileIdentity(value.executable, `${label} executable`)
}

function validateSnapshot(value, { allowExpiredGuard = false } = {}) {
  exactKeys(value, ['counts', 'frozen', 'legacy', 'n8n', 'queueDigestSha256', 'supervisor'], 'snapshot')
  validateProcess(value.legacy, 'legacy', ['releaseId', 'routerPort'])
  if (!RELEASE_ID.test(value.legacy.releaseId) || value.legacy.routerPort !== 3017) {
    fail('legacy release or port is invalid')
  }
  validateProcess(value.n8n, 'n8n', ['launchPid', 'port'])
  positiveInteger(value.n8n.launchPid, 'n8n LaunchAgent PID')
  if (value.n8n.port !== 5678 || value.n8n.ppid !== value.n8n.launchPid) fail('n8n process binding is invalid')
  exactKeys(value.counts, [
    'mediaNodes', 'n8nActiveExecutions', 'queueRunning', 'queueWaiting',
  ], 'counts')
  for (const [key, count] of Object.entries(value.counts)) nonNegativeInteger(count, key)
  if (Object.values(value.counts).some(count => count !== 0)) fail('active production work is still present')
  if (!SHA256.test(value.queueDigestSha256)) fail('persistent queue digest is invalid')
  exactKeys(value.supervisor, ['disabled', 'loaded', 'lockAbsent', 'workerPids'], 'supervisor')
  if (value.supervisor.disabled !== true || value.supervisor.loaded !== false
    || value.supervisor.lockAbsent !== true || !Array.isArray(value.supervisor.workerPids)
    || value.supervisor.workerPids.length !== 0) fail('video-lane supervisor is not quiesced')
  exactKeys(value.frozen, [
    'argvSha256', 'database', 'expiresAt', 'guardNonceSha256', 'issuedAt', 'pid',
    'legacyBindingSha256', 'mode', 'n8nDatabase', 'ready', 'schema', 'scriptSha256', 'socket', 'startedAt', 'uid',
  ], 'freeze guard')
  if (value.frozen.schema !== GUARD_SCHEMA || value.frozen.mode !== 'dual'
    || !Number.isSafeInteger(value.frozen.pid)
    || value.frozen.ready !== true || value.frozen.pid <= 0 || value.frozen.uid !== process.getuid()
    || !value.frozen.startedAt || !SHA256.test(value.frozen.argvSha256)
    || !SHA256.test(value.frozen.scriptSha256) || !SHA256.test(value.frozen.guardNonceSha256)
    || !SHA256.test(value.frozen.legacyBindingSha256)) {
    fail('freeze guard identity is invalid')
  }
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(value.frozen.issuedAt) || !Number.isSafeInteger(value.frozen.expiresAt)
    || value.frozen.issuedAt > now || (!allowExpiredGuard && value.frozen.expiresAt < now)
    || value.frozen.expiresAt - value.frozen.issuedAt < 30
    || value.frozen.expiresAt - value.frozen.issuedAt > 1800) fail('freeze guard TTL is invalid')
  validateFileIdentity(value.frozen.database, 'freeze guard database')
  validateFileIdentity(value.frozen.n8nDatabase, 'freeze guard n8n database')
  validateFileIdentity(value.frozen.socket, 'freeze guard socket')
  if (canonicalJson(value.frozen.database) !== canonicalJson(value.legacy.database)) {
    fail('freeze guard does not hold the authoritative Mission Control database')
  }
  if (canonicalJson(value.frozen.n8nDatabase) !== canonicalJson(value.n8n.database)) {
    fail('freeze guard does not hold the authoritative n8n database')
  }
  return value
}

export async function captureValidatedSnapshot(repositoryRoot = defaultRepositoryRoot) {
  return validateSnapshot(await captureSnapshot(repositoryRoot))
}

function targetIdentity(argumentsValue, repositoryRoot) {
  const expected = join(repositoryRoot, '.runtime/releases', argumentsValue.releaseId, 'standalone')
  assertNoSymlink(argumentsValue.standaloneRoot, 'target standalone root')
  const physical = realpathSync(argumentsValue.standaloneRoot)
  if (physical !== expected) fail(`target standalone root must be ${expected}`)
  safeEntry(physical, 'target standalone root', 'directory')
  const manifestPath = join(physical, 'release-manifest.json')
  safeEntry(manifestPath, 'target release manifest', 'file')
  if (!testMode) {
    run(process.execPath, [
      join(repositoryRoot, 'scripts/check-standalone-artifact.mjs'), physical,
    ], 'target standalone audit')
  }
  return {
    slot: argumentsValue.slot,
    releaseId: argumentsValue.releaseId,
    releaseRoot: physical,
    manifestSha256: sha256(readFileSync(manifestPath)),
  }
}

function freezeGuard(database, n8nDatabase) {
  const socketPath = testPath(
    'AIWORKER_TEST_LEGACY_FREEZE_GUARD_SOCKET',
    join(process.env.HOME, 'ai-worker/state/video-autoworker/legacy-freeze/guard.sock'),
  )
  const source = run(process.execPath, [
    guardScript, 'status', '--socket', socketPath, '--database', database.path,
    '--n8n-database', n8nDatabase.path,
  ], 'legacy freeze guard attestation')
  let value
  try { value = JSON.parse(source) } catch { fail('legacy freeze guard attestation is invalid') }
  delete value.challenge
  return value
}

function validateRollbackProof(argumentsValue, target, snapshot, { allowExpired = false } = {}) {
  safeEntry(dirname(argumentsValue.rollbackProof), 'rollback proof directory', 'directory', 0o700)
  const entry = safeEntry(argumentsValue.rollbackProof, 'rollback proof', 'file', 0o600)
  if (entry.nlink !== 1n) fail('rollback proof link count is invalid')
  let value
  const source = readFileSync(argumentsValue.rollbackProof)
  try { value = JSON.parse(source) } catch { fail('rollback proof is invalid JSON') }
  exactKeys(value, [
    'backups', 'createdAt', 'generatorSha256', 'guardSha256', 'host', 'queueDigestSha256',
    'runtimeIdentitySha256', 'schema', 'sources', 'target', 'uid',
  ], 'rollback proof')
  exactKeys(value.sources, ['mission', 'n8n'], 'rollback proof sources')
  exactKeys(value.backups, ['mission', 'n8n'], 'rollback proof backups')
  exactKeys(value.target, ['manifestSha256', 'releaseId', 'slot'], 'rollback proof target')
  const now = Math.floor(Date.now() / 1000)
  if (value.schema !== 'video-autoworker-legacy-bootstrap-rollback-proof/v2'
    || value.uid !== process.getuid() || value.host !== run('/bin/hostname', [], 'hostname query').trim()
    || !Number.isSafeInteger(value.createdAt) || value.createdAt > now
    || (!allowExpired && now - value.createdAt > 3600)
    || canonicalJson(value.target) !== canonicalJson({
      slot: target.slot, releaseId: target.releaseId, manifestSha256: target.manifestSha256,
    }) || value.generatorSha256 !== hashFileStable(
      join(defaultRepositoryRoot, 'scripts/generate-legacy-bootstrap-rollback-proof.mjs'),
      'rollback proof generator',
    ) || !SHA256.test(value.guardSha256) || !SHA256.test(value.runtimeIdentitySha256)
    || value.queueDigestSha256 !== snapshot.queueDigestSha256
    || value.guardSha256 !== sha256(canonicalJson(snapshot.frozen))
    || value.runtimeIdentitySha256 !== sha256(canonicalJson(snapshot))) {
    fail('rollback proof identity, guard, queue, or target is invalid')
  }
  for (const [name, expected] of [
    ['mission', snapshot.legacy.database], ['n8n', snapshot.n8n.database],
  ]) {
    validateFileIdentity(value.sources[name], `rollback ${name} source`)
    if (canonicalJson(value.sources[name]) !== canonicalJson(expected)) {
      fail(`rollback ${name} source does not match the authoritative database`)
    }
    exactKeys(value.backups[name], ['path', 'sha256'], `rollback ${name} backup`)
    assertAbsolute(value.backups[name].path, `rollback ${name} backup path`)
    if (!SHA256.test(value.backups[name].sha256) || value.backups[name].path === expected.path) {
      fail(`rollback ${name} backup identity is invalid`)
    }
    safeEntry(dirname(value.backups[name].path), `rollback ${name} backup directory`, 'directory', 0o700)
    const backup = safeEntry(value.backups[name].path, `rollback ${name} backup`, 'file', 0o600)
    if (backup.nlink !== 1n || hashFileStable(value.backups[name].path, `rollback ${name} backup`) !== value.backups[name].sha256) {
      fail(`rollback ${name} backup digest is invalid`)
    }
  }
  let Database
  try {
    const scopedRequire = createRequire(import.meta.url)
    Database = scopedRequire(scopedRequire.resolve('better-sqlite3', { paths: [defaultRepositoryRoot] }))
  } catch { fail('better-sqlite3 is unavailable') }
  for (const name of ['mission', 'n8n']) {
    const db = new Database(value.backups[name].path, { readonly: true, fileMustExist: true })
    try {
      db.pragma('query_only = ON')
      if (db.pragma('quick_check', { simple: true }) !== 'ok') fail(`rollback ${name} backup quick_check failed`)
    } finally { db.close() }
  }
  return {
    path: argumentsValue.rollbackProof,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    sha256: sha256(source),
  }
}

export function writeExclusiveAtomic(pathname, source) {
  assertAbsolute(pathname, 'output')
  const parent = dirname(pathname)
  safeEntry(parent, 'output directory', 'directory', 0o700)
  if (existsSync(pathname)) fail('output already exists')
  const temporary = join(parent, `.${basename(pathname)}.${randomUUID()}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    writeSync(descriptor, source)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    linkSync(temporary, pathname)
    unlinkSync(temporary)
    const output = safeEntry(pathname, 'output evidence', 'file', 0o600)
    if (output.nlink !== 1n) fail('output evidence link count is invalid')
    const parentFd = openSync(parent, constants.O_RDONLY)
    try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
  } catch (error) {
    try { if (descriptor !== undefined) closeSync(descriptor) } catch {}
    try { unlinkSync(temporary) } catch {}
    if (error instanceof Error && error.message.startsWith('legacy freeze evidence failed:')) throw error
    fail('unable to publish evidence without overwriting an existing path')
  }
}

async function main() {
  if (process.argv[2] === '--probe-legacy-state-fd') {
    if (process.argv.length !== 6 || process.argv[4] !== '--router-port') {
      fail('legacy process probe arguments are invalid')
    }
    const descriptor = Number(process.argv[3])
    const routerPort = Number(process.argv[5])
    process.stdout.write(`${probeEvidencedLegacyProcess(descriptor, routerPort)}\n`)
    return
  }
  if (['--verify-evidence-fd', '--verify-evidence-static-fd'].includes(process.argv[2])) {
    const verifyCurrent = process.argv[2] === '--verify-evidence-fd'
    const descriptor = Number(process.argv[3])
    const argumentsValue = parseArguments(process.argv.slice(4))
    if (!Number.isSafeInteger(descriptor) || descriptor < 3) fail('evidence file descriptor is invalid')
    const opened = fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || Number(opened.mode & 0o7777n) !== 0o600
      || opened.uid !== BigInt(process.getuid()) || opened.nlink !== 1n) {
      fail('opened evidence file identity is unsafe')
    }
    const buffer = Buffer.alloc(Number(opened.size))
    if (readSync(descriptor, buffer, 0, buffer.length, 0) !== buffer.length) fail('evidence short read')
    let evidence
    try { evidence = JSON.parse(buffer) } catch { fail('evidence is invalid JSON') }
    exactKeys(evidence, [
      'counts', 'frozen', 'generatorSha256', 'legacy', 'n8n', 'observedAt',
      'queueDigestSha256', 'rollback', 'schema', 'supervisor', 'target',
    ], 'evidence')
    const repositoryRoot = testPath('AIWORKER_TEST_LEGACY_FREEZE_REPOSITORY_ROOT', defaultRepositoryRoot)
    const target = targetIdentity(argumentsValue, repositoryRoot)
    if (evidence.schema !== SCHEMA || evidence.generatorSha256 !== sha256(readFileSync(scriptPath))
      || canonicalJson(evidence.target) !== canonicalJson(target)) fail('evidence generator or target binding is invalid')
    const evidenceSnapshot = validateSnapshot({
      legacy: evidence.legacy,
      n8n: evidence.n8n,
      counts: evidence.counts,
      queueDigestSha256: evidence.queueDigestSha256,
      supervisor: evidence.supervisor,
      frozen: evidence.frozen,
    }, { allowExpiredGuard: !verifyCurrent })
    const rollback = validateRollbackProof(
      argumentsValue, target, evidenceSnapshot, { allowExpired: !verifyCurrent },
    )
    if (canonicalJson(evidence.rollback) !== canonicalJson(rollback)) fail('evidence rollback proof binding is invalid')
    if (verifyCurrent) {
      const firstCurrent = validateSnapshot(await captureSnapshot(repositoryRoot))
      const verifyDelay = testMode
        ? Number(process.env.AIWORKER_TEST_LEGACY_FREEZE_SAMPLE_DELAY_MS || 0)
        : 1000
      if (!Number.isSafeInteger(verifyDelay) || verifyDelay < 0 || verifyDelay > 5000) {
        fail('verification sample delay is invalid')
      }
      if (verifyDelay) await new Promise(resolvePromise => setTimeout(resolvePromise, verifyDelay))
      const secondCurrent = validateSnapshot(await captureSnapshot(repositoryRoot))
      if (canonicalJson(firstCurrent) !== canonicalJson(secondCurrent)
        || canonicalJson(secondCurrent) !== canonicalJson(evidenceSnapshot)) {
        fail('current production identity does not match the stable evidence snapshot')
      }
    }
    if (verifyCurrent) {
      const frozen = testMode
        ? validateSnapshot(await captureSnapshot(repositoryRoot)).frozen
        : freezeGuard(evidence.legacy.database)
      if (canonicalJson(evidence.frozen) !== canonicalJson(frozen)) {
        fail('evidence freeze guard binding is invalid')
      }
    }
    process.stdout.write(`${sha256(buffer)}\n`)
    return
  }
  const argumentsValue = parseArguments(process.argv.slice(2))
  const repositoryRoot = testPath('AIWORKER_TEST_LEGACY_FREEZE_REPOSITORY_ROOT', defaultRepositoryRoot)
  safeEntry(repositoryRoot, 'repository root', 'directory')
  const target = targetIdentity(argumentsValue, repositoryRoot)
  const first = validateSnapshot(await captureSnapshot(repositoryRoot))
  const delay = testMode ? Number(process.env.AIWORKER_TEST_LEGACY_FREEZE_SAMPLE_DELAY_MS || 0) : 1000
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 5000) fail('sample delay is invalid')
  if (delay) await new Promise(resolvePromise => setTimeout(resolvePromise, delay))
  const second = validateSnapshot(await captureSnapshot(repositoryRoot))
  if (canonicalJson(first) !== canonicalJson(second)) fail('production identity changed between stable samples')
  const rollback = validateRollbackProof(argumentsValue, target, second)
  const evidence = {
    schema: SCHEMA,
    observedAt: Math.floor(Date.now() / 1000),
    generatorSha256: sha256(readFileSync(scriptPath)),
    frozen: second.frozen,
    rollback,
    target,
    legacy: second.legacy,
    n8n: second.n8n,
    counts: second.counts,
    queueDigestSha256: second.queueDigestSha256,
    supervisor: second.supervisor,
  }
  writeExclusiveAtomic(argumentsValue.output, `${canonicalJson(evidence)}\n`)
  process.stdout.write(`Created managed legacy freeze evidence: ${argumentsValue.output}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
