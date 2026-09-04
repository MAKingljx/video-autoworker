#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readdirSync, realpathSync, statSync, writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acquireSharedDeploymentLockSync } from './lib/shared-deployment-lock.mjs'

const INSTALLER_RESULT_SCHEMA = 'video-autoworker-installer-result/v1'
const CONVERGENCE_RAW_SCHEMA = 'video-autoworker-legacy-preinstall-convergence-result/v1'
const PID_SCHEMA = 'video-autoworker-legacy-preinstall-protected-pids/v1'
const PROTECTED_LISTENERS = Object.freeze({
  application: 3017,
  n8n: 5678,
  taskBroker: 5679,
  gptMain: 18789,
  qwenCurrent: 18889,
  qwenWeixin: 18989,
  qwen36: 18091,
  qwen38Text: 18092,
  qwen38Vision: 18094,
  ollama: 11434,
})
const STABLE_LISTENER_NAMES = Object.freeze(
  Object.keys(PROTECTED_LISTENERS).filter(name => name !== 'qwenCurrent'),
)
const MAX_BYTES = 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const scriptPath = realpathSync(fileURLToPath(import.meta.url))
const repositoryRoot = realpathSync(join(dirname(scriptPath), '..'))
const testMode = process.env.NODE_ENV === 'test'
  && process.env.AIWORKER_TEST_LEGACY_PREINSTALL_ORCHESTRATOR === '1'

function fail(message) { throw new Error(`legacy preinstall orchestrator failed: ${message}`) }
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail(`${label} fields are invalid`)
  }
}
function assertAbsolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} must be one normalized absolute path`)
}
function assertNoSymlink(pathname, label, allowMissing = false) {
  assertAbsolute(pathname, label)
  const root = parse(pathname).root
  let current = root
  for (const part of relative(root, pathname).split('/').filter(Boolean)) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) fail(`${label} contains a symlink`)
    } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return
      throw error
    }
  }
}
function safeDirectory(pathname, label, mode = 0o700) {
  assertNoSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if (!entry.isDirectory() || entry.uid !== BigInt(process.getuid())
    || Number(entry.mode & 0o7777n) !== mode || realpathSync(pathname) !== pathname) {
    fail(`${label} is unsafe`)
  }
  return entry
}
export function initializePreinstallArtifactRoot(attemptDirectory) {
  safeDirectory(attemptDirectory, 'preinstall attempt directory')
  const preinstallRoot = join(attemptDirectory, 'preinstall')
  if (!existsSync(preinstallRoot)) mkdirSync(preinstallRoot, { mode: 0o700 })
  safeDirectory(preinstallRoot, 'preinstall managed root')
  const artifactRoot = join(preinstallRoot, 'orchestrator')
  if (!existsSync(artifactRoot)) mkdirSync(artifactRoot, { mode: 0o700 })
  safeDirectory(artifactRoot, 'orchestrator artifact directory')
  return artifactRoot
}
function stableFile(pathname, label, mode) {
  assertNoSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if (!entry.isFile() || entry.nlink !== 1n || entry.uid !== BigInt(process.getuid())
    || Number(entry.mode & 0o7777n) !== mode || entry.size <= 0n || entry.size > BigInt(MAX_BYTES)) {
    fail(`${label} is unsafe`)
  }
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size) {
      fail(`${label} changed before read`)
    }
    const source = readFileSync(descriptor)
    const after = lstatSync(pathname, { bigint: true })
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      fail(`${label} changed during read`)
    }
    return {
      source,
      reference: {
        path: pathname, dev: opened.dev.toString(), ino: opened.ino.toString(),
        size: Number(opened.size), sha256: sha256(source),
      },
    }
  } finally { closeSync(descriptor) }
}
function strictJson(source, label) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_BYTES) fail(`${label} is too large`)
  let index = 0
  const whitespace = () => { while (/\s/u.test(source[index] || '')) index += 1 }
  const stringValue = () => {
    const start = index++
    let escaped = false
    while (index < source.length) {
      const character = source[index++]
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
    if (source[index] === '"') return stringValue()
    if (source[index] === '{') {
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
        if (source[index++] !== ':') fail(`${label} object separator is invalid`)
        output[key] = value()
        whitespace()
        if (source[index] === '}') { index += 1; return output }
        if (source[index++] !== ',') fail(`${label} object delimiter is invalid`)
      }
      fail(`${label} object is unterminated`)
    }
    if (source[index] === '[') {
      index += 1
      whitespace()
      const output = []
      if (source[index] === ']') { index += 1; return output }
      while (index < source.length) {
        output.push(value())
        whitespace()
        if (source[index] === ']') { index += 1; return output }
        if (source[index++] !== ',') fail(`${label} array delimiter is invalid`)
      }
      fail(`${label} array is unterminated`)
    }
    const token = source.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u)?.[0]
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
function readJson(pathname, label, mode) {
  const loaded = stableFile(pathname, label, mode)
  return { value: strictJson(loaded.source.toString('utf8'), label), reference: loaded.reference }
}
function fsyncDirectory(pathname) {
  const descriptor = openSync(pathname, constants.O_RDONLY)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}
function writeExclusive(pathname, value, mode, label) {
  assertNoSymlink(pathname, label, true)
  safeDirectory(dirname(pathname), `${label} parent`)
  const source = Buffer.from(`${canonicalJson(value)}\n`)
  let descriptor
  try {
    descriptor = openSync(pathname,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
    let offset = 0
    while (offset < source.length) offset += writeSync(descriptor, source, offset)
    fsyncSync(descriptor)
    chmodSync(pathname, mode)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    if (error?.code === 'EEXIST') return readJson(pathname, label, mode)
    fail(`unable to write ${label}`)
  }
  closeSync(descriptor)
  fsyncDirectory(dirname(pathname))
  return readJson(pathname, label, mode)
}
function sameValue(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} changed on retry`)
}
function managedPath(name, production) {
  const candidate = process.env[name]
  if (candidate !== undefined) {
    if (!testMode) fail(`${name} override is forbidden outside isolated tests`)
    assertAbsolute(candidate, name)
    return candidate
  }
  return production
}
function resolveCommand(name) {
  const result = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' })
  const pathname = result.status === 0 ? result.stdout.trim() : ''
  if (!pathname || !isAbsolute(pathname) || resolve(pathname) !== pathname) {
    fail(`${name} executable is unavailable`)
  }
  return pathname
}

const paths = {
  controller: managedPath('AIWORKER_TEST_LEGACY_PREINSTALL_CONTROLLER',
    join(repositoryRoot, 'scripts/legacy-preinstall-controller.mjs')),
  task: managedPath('AIWORKER_TEST_LEGACY_PREINSTALL_TASK_INSTALLER',
    join(repositoryRoot, 'scripts/install-aiworker-task-flow-skill.sh')),
  video: managedPath('AIWORKER_TEST_LEGACY_PREINSTALL_VIDEO_INSTALLER',
    join(repositoryRoot, 'scripts/install-aiworker-video-command-plugin.sh')),
  director: managedPath('AIWORKER_TEST_LEGACY_PREINSTALL_DIRECTOR_INSTALLER',
    join(repositoryRoot, 'scripts/install-aiworker-director-brain.sh')),
  convergence: managedPath('AIWORKER_TEST_LEGACY_PREINSTALL_CONVERGENCE',
    join(repositoryRoot, 'scripts/apply-openclaw-runtime-convergence.sh')),
  openclaw: managedPath('AIWORKER_TEST_LEGACY_PREINSTALL_OPENCLAW',
    testMode ? process.execPath : resolveCommand('openclaw')),
  lsof: managedPath('AIWORKER_TEST_LEGACY_PREINSTALL_LSOF', '/usr/sbin/lsof'),
  pgrep: managedPath('AIWORKER_TEST_LEGACY_PREINSTALL_PGREP', '/usr/bin/pgrep'),
}

function baseEnvironment(values, status, { convergence = false } = {}) {
  status ??= emptyStatus
  const environment = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('AIWORKER_') || name.startsWith('OPENCLAW_')
      || ['GATEWAY_TOKEN', 'GATEWAY_PASSWORD'].includes(name)) continue
    environment[name] = value
  }
  environment.NODE_ENV = testMode ? 'test' : 'production'
  environment.HOME = values.home
  environment.PATH = `${dirname(paths.openclaw)}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`
  environment.AIWORKER_NODE_BIN = process.execPath
  environment.AIWORKER_QWEN_WORKSPACE = values['--workspace-root']
  environment.AIWORKER_SKILL_BACKUP_ROOT = values['--task-flow-backup-root']
  environment.AIWORKER_OPENCLAW_QWEN_STATE_DIR = values['--profile-state-root']
  environment.AIWORKER_OPENCLAW_RUNTIME_BACKUP_ROOT = values['--runtime-backup-root']
  environment.AIWORKER_BG_RUN_DIR = values['--deployment-run-dir']
  environment.AIWORKER_BG_LIVE_DB_PATH = status.bindings.databases.mission.path
  environment.AIWORKER_BG_N8N_DB_PATH = status.bindings.databases.n8n.path
  environment.AIWORKER_BG_LEGACY_PREINSTALL_ATTEMPT_DIR = values['--attempt-dir']
  environment.AIWORKER_VIDEO_BATCH_DIR = values['--video-batch-root']
  environment.OPENCLAW_BIN = paths.openclaw
  if (testMode) {
    environment.AIWORKER_TEST_LEGACY_PREINSTALL_ORCHESTRATOR_CHILD = '1'
  }
  if (convergence && process.env.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY) {
    environment.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY =
      process.env.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY
  }
  return environment
}
function run(command, args, label, environment, timeout = 120_000) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot, env: environment, encoding: 'utf8', maxBuffer: MAX_BYTES, timeout,
  })
  if (result.error || result.signal || result.status !== 0) {
    fail(`${label} failed${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ''}`)
  }
  return result.stdout
}
function runController(args, label) {
  const environment = baseEnvironment(currentValues, currentStatus || emptyStatus)
  const output = run(process.execPath, [paths.controller, ...args], label, environment)
  return strictJson(output.trim(), label)
}

let currentValues
let currentStatus
const emptyStatus = { bindings: { databases: { mission: { path: '' }, n8n: { path: '' } } } }

function controllerStatus(values) {
  const output = run(process.execPath, [paths.controller, 'status', '--attempt-dir', values['--attempt-dir']],
    'preinstall status', { ...process.env, NODE_ENV: testMode ? 'test' : 'production' })
  const status = strictJson(output.trim(), 'preinstall status')
  if (!UUID.test(status?.installAttemptId || '') || !Number.isSafeInteger(status?.revision)
    || !Array.isArray(status?.components?.installed) || !Array.isArray(status?.components?.rolledBack)
    || !status?.bindings?.databases?.mission?.path || !status?.bindings?.databases?.n8n?.path) {
    fail('preinstall status is invalid')
  }
  return status
}
function prepare(values) {
  const preinstall = join(values['--attempt-dir'], 'preinstall')
  if (readdirSync(preinstall).some(name => /^install-prepared\.r\d{6}\.receipt\.json$/u.test(name))) {
    return controllerStatus(values)
  }
  const result = runController([
    'prepare', '--attempt-dir', values['--attempt-dir'], '--evidence', values['--evidence'],
    '--proof', values['--proof'], '--source-commit', values['--source-commit'],
    '--transition-intent', values['--transition-intent'],
    '--transition-confirmation', values['--transition-confirmation'],
    '--transition-journal', values['--transition-journal'],
    '--transition-attestation', values['--transition-attestation'],
    '--transition-claim', values['--transition-claim'],
  ], 'preinstall prepare')
  if (result?.phase !== 'INSTALL_PREPARED') fail('preinstall prepare result is invalid')
  return controllerStatus(values)
}

function artifact(values, name) { return join(values.artifactRoot, name) }
function modeString(pathname) { return (statSync(pathname).mode & 0o7777).toString(8) }
function treeEntries(root, exclude = new Set()) {
  const output = []
  function visit(directory, prefix) {
    for (const name of readdirSync(directory).sort()) {
      const relativeName = prefix ? `${prefix}/${name}` : name
      if (exclude.has(relativeName)) continue
      if (/\r|\n|\t/u.test(relativeName)) fail('backup contains an unsafe path name')
      const pathname = join(directory, name)
      const entry = lstatSync(pathname)
      if (entry.isSymbolicLink()) fail('backup contains a symlink')
      output.push({ relativeName, pathname, entry })
      if (entry.isDirectory()) visit(pathname, relativeName)
    }
  }
  visit(root, '')
  return output
}
function shellTreeManifest(root, excludeNames = ['MANIFEST.sha256'], leadingDot = true) {
  const lines = leadingDot ? [`.\tdirectory\t${modeString(root)}\t-`] : []
  for (const { relativeName, pathname, entry } of treeEntries(root, new Set(excludeNames))) {
    const name = leadingDot ? `./${relativeName}` : relativeName
    const suffix = leadingDot ? '' : '\t-'
    if (entry.isDirectory()) lines.push(`${name}\tdirectory\t${modeString(pathname)}\t-${suffix}`)
    else if (entry.isFile()) lines.push(`${name}\tfile\t${modeString(pathname)}\t${sha256(readFileSync(pathname))}${suffix}`)
    else fail('backup contains an unsupported object')
  }
  return `${lines.join('\n')}\n`
}
function validateBackupDirectory(pathname, root, component, expectedManifestSha = null) {
  safeDirectory(root, `${component} backup root`)
  safeDirectory(pathname, `${component} backup`)
  if (dirname(pathname) !== root) fail(`${component} backup is not a direct child of its root`)
  const patterns = {
    'task-flow': /^[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]{6}$/u,
    'video-command': /^current-release-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]+$/u,
    'director-brain': /^[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]{6}$/u,
  }
  if (!patterns[component].test(basename(pathname))) fail(`${component} backup family is invalid`)
  const manifest = stableFile(join(pathname, 'MANIFEST.sha256'), `${component} backup manifest`, 0o600)
  if (expectedManifestSha !== null && manifest.reference.sha256 !== expectedManifestSha) {
    fail(`${component} backup manifest digest changed`)
  }
  if (component === 'video-command') {
    const verified = stableFile(join(pathname, '.verified'), 'video-command backup verifier', 0o600)
    if (verified.source.toString('utf8').trim() !== manifest.reference.sha256) {
      fail('video-command backup verifier changed')
    }
    const expected = shellTreeManifest(pathname, ['MANIFEST.sha256', '.verified'], false)
    if (manifest.source.toString('utf8') !== expected) fail('video-command backup manifest changed')
  } else {
    const expected = shellTreeManifest(pathname)
    if (manifest.source.toString('utf8') !== expected) fail(`${component} backup manifest changed`)
  }
  return manifest.reference
}
function parseState(pathname) {
  const source = stableFile(pathname, 'backup STATE', 0o600).source.toString('utf8')
  const lines = source.trimEnd().split('\n')
  const values = {}
  for (const line of lines) {
    const index = line.indexOf('=')
    if (index < 1 || Object.hasOwn(values, line.slice(0, index))) fail('backup STATE is invalid')
    values[line.slice(0, index)] = line.slice(index + 1)
  }
  return { lines, values }
}
function validateTaskBackup(pathname, values) {
  const manifest = validateBackupDirectory(pathname, values['--task-flow-backup-root'], 'task-flow')
  const state = parseState(join(pathname, 'STATE'))
  exactKeys(state.values, ['version', 'workspace_sha256', 'source_commit', 'release_id',
    'skill_present', 'agents_present', 'memory_present'], 'task-flow backup STATE')
  if (state.lines.length !== 7 || state.values.version !== '2'
    || state.values.workspace_sha256 !== sha256(values['--workspace-root'])
    || state.values.source_commit !== values['--source-commit']
    || state.values.release_id !== `${values['--source-commit']}-runtime`
    || [state.values.skill_present, state.values.agents_present, state.values.memory_present]
      .some(item => !['0', '1'].includes(item))) fail('task-flow backup STATE binding is invalid')
  const applied = ['APPLIED.skill.manifest', 'APPLIED.AGENTS.manifest', 'APPLIED.MEMORY.manifest']
    .map(name => stableFile(join(pathname, name), `task-flow ${name}`, 0o600))
  return {
    backup: pathname,
    manifest,
    before: manifest.sha256,
    after: sha256(applied.map((item, index) => `${index}:${item.reference.sha256}`).join('\n')),
  }
}

function validateInstallerResult(pathname, component, operation, values) {
  const loaded = readJson(pathname, `${component} ${operation} raw result`, 0o600)
  const value = loaded.value
  exactKeys(value, ['schema', 'component', 'operation', 'status', 'sourceCommit', 'targetReleaseId',
    'beforeManifestSha256', 'afterManifestSha256', 'backup', 'requiresFreshRestart', 'completedAt'],
  `${component} raw result`)
  if (value.schema !== INSTALLER_RESULT_SCHEMA || value.component !== component
    || value.operation !== operation || !['applied', 'noop', 'restored'].includes(value.status)
    || value.sourceCommit !== values['--source-commit']
    || value.targetReleaseId !== `${values['--source-commit']}-runtime`
    || !SHA256.test(value.beforeManifestSha256 || '') || !SHA256.test(value.afterManifestSha256 || '')
    || !Number.isSafeInteger(value.completedAt) || typeof value.requiresFreshRestart !== 'boolean') {
    fail(`${component} raw result binding is invalid`)
  }
  const expectedRestart = component !== 'task-flow'
    && operation === 'apply' && value.status === 'applied'
  if (operation === 'apply' && value.requiresFreshRestart !== expectedRestart) {
    fail(`${component} restart contract changed`)
  }
  if (operation === 'apply' && value.status === 'restored') fail(`${component} apply status is invalid`)
  if (operation === 'rollback' && value.status !== 'restored') fail(`${component} rollback status is invalid`)
  if (value.backup !== null) {
    exactKeys(value.backup, ['path', 'manifestSha256'], `${component} raw backup`)
    if (!SHA256.test(value.backup.manifestSha256 || '')) fail(`${component} raw backup digest is invalid`)
    const root = values[`--${component}-backup-root`]
    validateBackupDirectory(value.backup.path, root, component, value.backup.manifestSha256)
  } else if (value.status !== 'noop'
    && !(operation === 'rollback' && value.status === 'restored'
      && value.beforeManifestSha256 === value.afterManifestSha256)) {
    fail(`${component} mutating result has no backup`)
  }
  return loaded
}

function pidSnapshot(values) {
  const result = {}
  for (const [name, port] of Object.entries(PROTECTED_LISTENERS)) {
    const stdout = run(paths.lsof, ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
      `${name} listener snapshot`, baseEnvironment(values, currentStatus))
    const pids = [...new Set(stdout.trim().split(/\s+/u).filter(Boolean))]
    if (pids.length !== 1 || !/^[1-9][0-9]*$/u.test(pids[0])) fail(`${name} listener is not singular`)
    result[name] = Number(pids[0])
  }
  return result
}
function videoWorkerPidSnapshot(values) {
  const result = spawnSync(paths.pgrep, ['-f', 'run-video-batch\\.mjs .*--serve-root'], {
    cwd: repositoryRoot,
    env: baseEnvironment(values, currentStatus),
    encoding: 'utf8',
    maxBuffer: MAX_BYTES,
    timeout: 30_000,
  })
  if (result.error || result.signal || ![0, 1].includes(result.status)
    || (result.status === 1 && result.stdout.trim())) {
    fail('video worker process query failed')
  }
  const pids = result.status === 1
    ? []
    : [...new Set(result.stdout.trim().split(/\s+/u).filter(Boolean).map(Number))].sort((a, b) => a - b)
  if (pids.some(pid => !Number.isSafeInteger(pid) || pid < 1)) {
    fail('video worker process query failed')
  }
  if (pids.length !== 0) fail('video worker is running during protected preinstall')
  return pids
}
function loadOrCreatePidBaseline(values) {
  const pathname = artifact(values, 'protected-pids.before.json')
  if (existsSync(pathname)) {
    const loaded = readJson(pathname, 'protected PID baseline', 0o600)
    if (loaded.value?.schema !== PID_SCHEMA || loaded.value.phase !== 'before'
      || !loaded.value.pids || Object.values(loaded.value.pids)
        .some(pid => !Number.isSafeInteger(pid) || pid < 1)
      || canonicalJson(Object.keys(loaded.value.pids).sort())
        !== canonicalJson(Object.keys(PROTECTED_LISTENERS).sort())
      || !Array.isArray(loaded.value.videoWorkerPids)
      || loaded.value.videoWorkerPids.length !== 0) {
      fail('protected PID baseline is invalid')
    }
    return loaded.value
  }
  const expected = {
    schema: PID_SCHEMA,
    phase: 'before',
    pids: pidSnapshot(values),
    videoWorkerPids: videoWorkerPidSnapshot(values),
  }
  const loaded = writeExclusive(pathname, expected, 0o600, 'protected PID baseline')
  sameValue(loaded.value, expected, 'protected PID baseline')
  return loaded.value
}
function assertPids(values, baseline, qwenMode) {
  const current = pidSnapshot(values)
  for (const name of STABLE_LISTENER_NAMES) {
    if (current[name] !== baseline.pids[name]) fail(`protected ${name} PID drifted`)
  }
  if (canonicalJson(videoWorkerPidSnapshot(values)) !== canonicalJson(baseline.videoWorkerPids)) {
    fail('protected video worker PID set drifted')
  }
  if ((qwenMode === 'same' && current.qwenCurrent !== baseline.pids.qwenCurrent)
    || (qwenMode === 'changed' && current.qwenCurrent === baseline.pids.qwenCurrent)) {
    fail('qwen-current PID did not match the expected fresh-restart state')
  }
  return current
}

function preflight(values, baseline) {
  run(paths.task, ['--dry-run'], 'task-flow dry-run', baseEnvironment(values, null))
  run(paths.video, ['--dry-run', '--target-sha', values['--source-commit']],
    'video-command dry-run', baseEnvironment(values, null))
  run(paths.director, ['--dry-run', '--profile', values['--profile'],
    '--state-dir', values['--profile-state-root'], '--workspace', values['--workspace-root'],
    '--agent', values['--agent-id'], '--backup-root', values['--director-brain-backup-root']],
  'director-brain dry-run', baseEnvironment(values, null))
  assertPids(values, baseline, 'same')
}
function requireForwardLease() {
  if (!Number.isSafeInteger(currentStatus?.expiresAt)
    || Math.floor(Date.now() / 1000) + 30 >= currentStatus.expiresAt) {
    fail('preinstall lease is too close to expiry for another forward step')
  }
}
function requireForwardLeaseUnlessRecovering(component) {
  if (currentStatus?.reservation?.component === component
    && currentStatus.reservation.operation === 'install') return
  requireForwardLease()
}

function record(values, component, operation, raw) {
  runController(['record-component', '--attempt-dir', values['--attempt-dir'],
    '--install-attempt-id', currentStatus.installAttemptId,
    '--expected-revision', String(currentStatus.revision), '--operation', operation,
    '--component', component, '--raw-result', raw.reference.path], `${component} ${operation} record`)
  currentStatus = controllerStatus(values)
}

function probeCurrentTarget(values, component) {
  const reservation = currentStatus.reservation
  if (!reservation || reservation.component !== component) fail('target probe has no active reservation')
  const resultPath = reservation.reference.path.replace(
    'install-component-reservation.', 'install-component-result.',
  )
  let probePath
  if (existsSync(resultPath)) {
    const partial = readJson(resultPath, 'partial component cancellation result', 0o400)
    probePath = partial.value?.probe?.path
    assertAbsolute(probePath, 'partial component cancellation probe')
  } else {
    probePath = artifact(values, `${component}.cancel-probe.${randomUUID()}.json`)
  }
  let command
  let args
  if (component === 'task-flow') {
    command = paths.task
    args = ['--probe-current-manifest', '--result-output', probePath,
      '--reservation-sha256', reservation.reference.sha256]
  } else if (component === 'video-command') {
    command = paths.video
    args = ['--probe-current-manifest', '--target-sha', values['--source-commit'],
      '--result-output', probePath, '--reservation-sha256', reservation.reference.sha256]
  } else if (component === 'director-brain') {
    command = paths.director
    args = ['--probe-current-manifest', '--profile', values['--profile'],
      '--state-dir', values['--profile-state-root'], '--workspace', values['--workspace-root'],
      '--agent', values['--agent-id'], '--backup-root', values['--director-brain-backup-root'],
      '--result-output', probePath, '--reservation-sha256', reservation.reference.sha256]
  } else fail('reserved component target probe is invalid')
  if (!existsSync(probePath)) run(command, args, `${component} target probe`,
    baseEnvironment(values, currentStatus))
  const loaded = readJson(probePath, `${component} target probe`, 0o600)
  const probe = loaded.value
  if (probe?.schema !== 'video-autoworker-component-target-probe/v1'
    || probe.component !== component || probe.sourceCommit !== values['--source-commit']
    || probe.targetReleaseId !== `${values['--source-commit']}-runtime`
    || probe.reservationSha256 !== reservation.reference.sha256
    || !SHA256.test(probe.targetStateSha256 || '')) fail(`${component} target probe is invalid`)
  return loaded
}

function cancelActiveReservation(values) {
  currentStatus = controllerStatus(values)
  const reservation = currentStatus.reservation
  if (!reservation) return false
  const rawExists = existsSync(reservation.rawResultPath)
  const reason = rawExists ? 'invalid-raw-result'
    : currentStatus.expired ? 'lease-expired' : 'installer-failed'
  const lock = acquireSharedDeploymentLockSync({ runDirectory: values['--deployment-run-dir'] })
  try {
    const probe = probeCurrentTarget(values, reservation.component)
    runController(['cancel-component', '--attempt-dir', values['--attempt-dir'],
      '--install-attempt-id', currentStatus.installAttemptId,
      '--expected-revision', String(currentStatus.revision), '--operation', reservation.operation,
      '--component', reservation.component, '--reservation-sha256', reservation.reference.sha256,
      '--probe', probe.reference.path, '--reason', reason],
    `${reservation.component} ${reservation.operation} cancellation`)
  } finally { lock.release() }
  currentStatus = controllerStatus(values)
  return true
}

function installTask(values, baseline) {
  if (currentStatus.components.installed.includes('task-flow')) return
  const rawPath = artifact(values, 'task-flow.apply.raw.json')
  if (!existsSync(rawPath)) run(paths.task, ['--apply', '--result-output', rawPath],
    'task-flow apply', baseEnvironment(values, currentStatus))
  const raw = validateInstallerResult(rawPath, 'task-flow', 'apply', values)
  if (raw.value.backup) validateTaskBackup(raw.value.backup.path, values)
  record(values, 'task-flow', 'install', raw)
  assertPids(values, baseline, 'same')
}
function installStructured(values, component, command, args, baseline) {
  if (currentStatus.components.installed.includes(component)) return
  const rawPath = artifact(values, `${component}.apply.raw.json`)
  if (!existsSync(rawPath)) run(command, [...args, '--result-output', rawPath], `${component} apply`,
    baseEnvironment(values, currentStatus))
  const raw = validateInstallerResult(rawPath, component, 'apply', values)
  record(values, component, 'install', raw)
  assertPids(values, baseline, 'same')
}

function recordDirectorRaw(values, directorRaw) {
  record(values, 'director-brain', 'install', directorRaw)
}

function restartGateway(values, baseline) {
  const claimPath = artifact(values, 'qwen-current-fresh-restart.claim.json')
  const donePath = artifact(values, 'qwen-current-fresh-restart.result.json')
  const claim = { schema: PID_SCHEMA, phase: 'restart-claimed', beforePid: baseline.pids.qwenCurrent }
  const loadedClaim = writeExclusive(claimPath, claim, 0o600, 'qwen-current restart claim')
  sameValue(loadedClaim.value, claim, 'qwen-current restart claim')
  if (existsSync(donePath)) {
    const done = readJson(donePath, 'qwen-current restart result', 0o600)
    if (done.value?.schema !== PID_SCHEMA || done.value.phase !== 'restarted'
      || done.value.beforePid !== baseline.pids.qwenCurrent
      || done.value.afterPid === baseline.pids.qwenCurrent) {
      fail('qwen-current restart result is invalid')
    }
    const current = assertPids(values, baseline, 'changed')
    if (current.qwenCurrent !== done.value.afterPid) fail('qwen-current PID drifted after fresh restart')
    return done.value.afterPid
  }
  const observed = pidSnapshot(values)
  if (observed.qwenCurrent === baseline.pids.qwenCurrent) {
    run(paths.openclaw, ['--profile', values['--profile'], 'gateway', 'restart', '--wait', '60s', '--json'],
      'qwen-current fresh restart', baseEnvironment(values, currentStatus), 90_000)
  }
  const after = assertPids(values, baseline, 'changed')
  const doneValue = { schema: PID_SCHEMA, phase: 'restarted', beforePid: baseline.pids.qwenCurrent,
    afterPid: after.qwenCurrent }
  const done = writeExclusive(donePath, doneValue, 0o600, 'qwen-current restart result')
  sameValue(done.value, doneValue, 'qwen-current restart result')
  return after.qwenCurrent
}
function parseConvergenceOutput(source) {
  const proofMatches = [...source.matchAll(/^Verified session-scoped runtime convergence proof: (\/[^\r\n]+)$/gmu)]
  const reusedMatches = [...source.matchAll(/^Reused verified session-scoped runtime convergence proof: (\/[^\r\n]+)$/gmu)]
  const backupMatches = [...source.matchAll(/^Verified 0600 rollback backup: (\/[^\r\n]+)$/gmu)]
  const proofs = [...proofMatches, ...reusedMatches]
  if (proofs.length !== 1 || backupMatches.length > 1) fail('runtime convergence output is invalid')
  return { proof: proofs[0][1], backup: backupMatches[0]?.[1] ?? null }
}
function validateConvergenceRaw(values) {
  const loaded = readJson(artifact(values, 'runtime-convergence.apply.raw.json'),
    'runtime convergence raw result', 0o600)
  const value = loaded.value
  exactKeys(value, ['schema', 'operation', 'sourceCommit', 'targetReleaseId', 'proof', 'backup',
    'completedAt'], 'runtime convergence raw result')
  if (value.schema !== CONVERGENCE_RAW_SCHEMA || value.operation !== 'apply'
    || value.sourceCommit !== values['--source-commit']
    || value.targetReleaseId !== `${values['--source-commit']}-runtime`
    || !Number.isSafeInteger(value.completedAt)) fail('runtime convergence result binding is invalid')
  const proof = stableFile(value.proof.path, 'runtime convergence proof', 0o600)
  if (canonicalJson(proof.reference) !== canonicalJson(value.proof)) fail('runtime convergence proof changed')
  if (value.backup !== null) {
    const backup = stableFile(value.backup.path, 'runtime convergence backup', 0o600)
    if (dirname(value.backup.path) !== values['--runtime-backup-root']
      || canonicalJson(backup.reference) !== canonicalJson(value.backup)) {
      fail('runtime convergence backup changed')
    }
  }
  return loaded
}
function applyConvergence(values, baseline) {
  const rawPath = artifact(values, 'runtime-convergence.apply.raw.json')
  if (!existsSync(rawPath)) {
    const stdout = run(paths.convergence, ['--apply', '--tool-baseline', values['--tool-baseline']],
      'runtime convergence apply', baseEnvironment(values, currentStatus, { convergence: true }))
    const parsed = parseConvergenceOutput(stdout)
    const proof = stableFile(parsed.proof, 'runtime convergence proof', 0o600)
    const backup = parsed.backup === null ? null
      : stableFile(parsed.backup, 'runtime convergence backup', 0o600)
    if ((backup && dirname(backup.reference.path) !== values['--runtime-backup-root'])
      || dirname(proof.reference.path) !== values['--runtime-backup-root']) {
      fail('runtime convergence artifact is outside its explicit backup root')
    }
    writeExclusive(rawPath, {
      schema: CONVERGENCE_RAW_SCHEMA, operation: 'apply', sourceCommit: values['--source-commit'],
      targetReleaseId: `${values['--source-commit']}-runtime`, proof: proof.reference,
      backup: backup?.reference ?? null, completedAt: Math.floor(Date.now() / 1000),
    }, 0o600, 'runtime convergence raw result')
  }
  assertPids(values, baseline, 'changed')
  return validateConvergenceRaw(values)
}
function installDirector(values, baseline) {
  if (!currentStatus.components.installed.includes('director-brain')) {
    const rawPath = artifact(values, 'director-brain.apply.raw.json')
    if (!existsSync(rawPath)) run(paths.director, ['--apply', '--profile', values['--profile'],
      '--state-dir', values['--profile-state-root'], '--workspace', values['--workspace-root'],
      '--agent', values['--agent-id'], '--backup-root', values['--director-brain-backup-root'],
      '--result-output', rawPath], 'director-brain apply', baseEnvironment(values, currentStatus))
    const directorRaw = validateInstallerResult(rawPath, 'director-brain', 'apply', values)
    recordDirectorRaw(values, directorRaw)
    assertPids(values, baseline, 'same')
  }
  requireForwardLease()
  restartGateway(values, baseline)
  requireForwardLease()
  const convergenceRaw = applyConvergence(values, baseline)
  return convergenceRaw
}

function rollbackStructured(values, component) {
  if (!currentStatus.components.installed.includes(component)
    || currentStatus.components.rolledBack.includes(component)) return
  const installRaw = validateInstallerResult(artifact(values, `${component}.apply.raw.json`),
    component, 'apply', values)
  const rawPath = artifact(values, `${component}.rollback.raw.json`)
  if (!existsSync(rawPath) && installRaw.value.status === 'noop') {
    const common = ['--rollback', '--noop', '--result-output', rawPath]
    const args = component === 'director-brain'
      ? [...common, '--profile', values['--profile'], '--state-dir', values['--profile-state-root'],
        '--workspace', values['--workspace-root'], '--agent', values['--agent-id'],
        '--backup-root', values['--director-brain-backup-root']]
      : [...common, '--target-sha', values['--source-commit'], '--defer-gateway-restart']
    run(component === 'director-brain' ? paths.director : paths.video, args,
      `${component} noop rollback`, baseEnvironment(values, currentStatus))
  } else if (!existsSync(rawPath)) {
    const common = ['--rollback', '--backup', installRaw.value.backup.path, '--result-output', rawPath]
    const args = component === 'director-brain'
      ? [...common, '--profile', values['--profile'], '--state-dir', values['--profile-state-root'],
        '--workspace', values['--workspace-root'], '--agent', values['--agent-id'],
        '--backup-root', values['--director-brain-backup-root']]
      : [...common, '--target-sha', values['--source-commit'], '--defer-gateway-restart']
    run(component === 'director-brain' ? paths.director : paths.video, args,
      `${component} rollback`, baseEnvironment(values, currentStatus))
  }
  const raw = validateInstallerResult(rawPath, component, 'rollback', values)
  if (raw.value.beforeManifestSha256 !== installRaw.value.afterManifestSha256
    || raw.value.afterManifestSha256 !== installRaw.value.beforeManifestSha256
    || canonicalJson(raw.value.backup) !== canonicalJson(installRaw.value.backup)) {
    fail(`${component} rollback result is not the inverse of install`)
  }
  record(values, component, 'rollback', raw)
}

function recordUnrecordedInstall(values, component) {
  if (currentStatus.components.installed.includes(component)
    || !existsSync(artifact(values, `${component}.apply.raw.json`))) return
  const raw = validateInstallerResult(artifact(values, `${component}.apply.raw.json`),
    component, 'apply', values)
  if (component === 'task-flow' && raw.value.backup) validateTaskBackup(raw.value.backup.path, values)
  if (component === 'director-brain') {
    recordDirectorRaw(values, raw)
    return
  }
  record(values, component, 'install', raw)
}
function rollbackTask(values) {
  if (!currentStatus.components.installed.includes('task-flow')
    || currentStatus.components.rolledBack.includes('task-flow')) return
  const install = validateInstallerResult(artifact(values, 'task-flow.apply.raw.json'),
    'task-flow', 'apply', values)
  const rawPath = artifact(values, 'task-flow.rollback.raw.json')
  if (!existsSync(rawPath) && install.value.status === 'noop') {
    run(paths.task, ['--rollback', '--noop', '--result-output', rawPath],
      'task-flow noop rollback', baseEnvironment(values, currentStatus))
  } else if (!existsSync(rawPath)) {
    run(paths.task,
      ['--rollback', '--backup', install.value.backup.path, '--result-output', rawPath],
      'task-flow rollback', baseEnvironment(values, currentStatus))
  }
  const raw = validateInstallerResult(rawPath, 'task-flow', 'rollback', values)
  if (raw.value.backup) validateTaskBackup(raw.value.backup.path, values)
  if (raw.value.beforeManifestSha256 !== install.value.afterManifestSha256
    || raw.value.afterManifestSha256 !== install.value.beforeManifestSha256
    || canonicalJson(raw.value.backup) !== canonicalJson(install.value.backup)) {
    fail('task-flow rollback result is not the inverse of install')
  }
  record(values, 'task-flow', 'rollback', raw)
}

function recoveryRestart(values) {
  const forwardPath = artifact(values, 'qwen-current-fresh-restart.result.json')
  if (!existsSync(forwardPath)) return
  const forward = readJson(forwardPath, 'qwen-current forward restart result', 0o600)
  const claimPath = artifact(values, 'qwen-current-recovery-restart.claim.json')
  const donePath = artifact(values, 'qwen-current-recovery-restart.result.json')
  const claimValue = {
    schema: PID_SCHEMA, phase: 'recovery-restart-claimed', beforePid: forward.value.afterPid,
  }
  const claim = writeExclusive(claimPath, claimValue, 0o600, 'qwen-current recovery restart claim')
  sameValue(claim.value, claimValue, 'qwen-current recovery restart claim')
  const baseline = readJson(artifact(values, 'protected-pids.before.json'),
    'protected PID baseline', 0o600).value
  if (existsSync(donePath)) {
    const done = readJson(donePath, 'qwen-current recovery restart result', 0o600)
    const current = assertPids(values, baseline, 'changed')
    if (done.value?.schema !== PID_SCHEMA || done.value.phase !== 'recovery-restarted'
      || done.value.beforePid !== forward.value.afterPid
      || done.value.afterPid !== current.qwenCurrent) fail('qwen-current recovery restart result changed')
    return
  }
  const before = pidSnapshot(values)
  if (before.qwenCurrent === forward.value.afterPid) {
    run(paths.openclaw, ['--profile', values['--profile'], 'gateway', 'restart', '--wait', '60s', '--json'],
      'qwen-current recovery restart', baseEnvironment(values, currentStatus), 90_000)
  }
  const after = assertPids(values, baseline, 'changed')
  if (after.qwenCurrent === forward.value.afterPid) fail('qwen-current recovery restart did not drift')
  const doneValue = {
    schema: PID_SCHEMA, phase: 'recovery-restarted', beforePid: forward.value.afterPid,
    afterPid: after.qwenCurrent,
  }
  const done = writeExclusive(donePath, doneValue, 0o600, 'qwen-current recovery restart result')
  sameValue(done.value, doneValue, 'qwen-current recovery restart result')
}

function rollbackConvergence(values) {
  if (!existsSync(artifact(values, 'runtime-convergence.apply.raw.json'))) return
  const convergence = validateConvergenceRaw(values)
  if (!convergence.value.backup) return
  const pathname = artifact(values, 'runtime-convergence.rollback.raw.json')
  const expected = {
    schema: CONVERGENCE_RAW_SCHEMA, operation: 'rollback',
    sourceCommit: values['--source-commit'],
    targetReleaseId: `${values['--source-commit']}-runtime`,
    backup: convergence.value.backup,
  }
  if (existsSync(pathname)) {
    const existing = readJson(pathname, 'runtime convergence rollback result', 0o600)
    sameValue(existing.value, expected, 'runtime convergence rollback result')
    return
  }
  run(paths.convergence, ['--rollback', '--backup', convergence.value.backup.path],
    'runtime convergence rollback', baseEnvironment(values, currentStatus, { convergence: true }))
  const written = writeExclusive(pathname, expected, 0o600, 'runtime convergence rollback result')
  sameValue(written.value, expected, 'runtime convergence rollback result')
}
function rollback(values) {
  currentStatus = controllerStatus(values)
  if (currentStatus.phase === 'BOOTSTRAP_HANDOFF') return
  let unrecordedFailure = null
  try {
    for (const component of ['task-flow', 'video-command', 'director-brain']) {
      recordUnrecordedInstall(values, component)
    }
  } catch (error) {
    unrecordedFailure = error
  }
  if (currentStatus.reservation && cancelActiveReservation(values)) unrecordedFailure = null
  if (currentStatus.components.installed.includes('director-brain')
    && !currentStatus.components.rolledBack.includes('director-brain')) {
    rollbackConvergence(values)
    rollbackStructured(values, 'director-brain')
  }
  rollbackStructured(values, 'video-command')
  rollbackTask(values)
  currentStatus = controllerStatus(values)
  if (unrecordedFailure) throw unrecordedFailure
  recoveryRestart(values)
  if (currentStatus.phase !== 'INSTALL_ABANDONED') {
    runController(['abandon', '--attempt-dir', values['--attempt-dir'],
      '--install-attempt-id', currentStatus.installAttemptId,
      '--expected-revision', String(currentStatus.revision)], 'preinstall abandon')
    currentStatus = controllerStatus(values)
  }
}

function parseArguments(argv) {
  const names = ['--attempt-dir', '--evidence', '--proof', '--source-commit', '--transition-intent',
    '--transition-confirmation', '--transition-journal', '--transition-attestation', '--transition-claim',
    '--releases-root', '--profile', '--profile-state-root', '--workspace-root', '--agent-id',
    '--tool-baseline', '--task-flow-backup-root', '--video-command-backup-root',
    '--director-brain-backup-root', '--runtime-backup-root', '--deployment-run-dir', '--video-batch-root']
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!names.includes(name) || value === undefined || Object.hasOwn(values, name)) {
      fail('arguments are invalid')
    }
    values[name] = value
  }
  if (Object.keys(values).length !== names.length) fail('arguments are incomplete')
  for (const name of names.filter(item => !['--source-commit', '--profile', '--agent-id'].includes(item))) {
    assertAbsolute(values[name], name)
  }
  if (!COMMIT.test(values['--source-commit']) || values['--profile'] !== 'qwen-current'
    || values['--agent-id'] !== 'second-original') fail('source commit, profile, or agent binding is invalid')
  safeDirectory(values['--attempt-dir'], 'preinstall attempt directory')
  const home = dirname(values['--profile-state-root'])
  if (values['--profile-state-root'] !== join(home, '.openclaw-qwen-current')
    || values['--video-command-backup-root'] !== join(home, 'ai-worker/backups/aiworker-video-command')) {
    fail('profile state or video-command backup root is outside the explicit production family')
  }
  const canonicalBatchRoot = join(home, 'ai-worker/state/video-autoworker/video-batches')
  if (!testMode && values['--video-batch-root'] !== canonicalBatchRoot) {
    fail(`production video batch root must be canonical: ${canonicalBatchRoot}`)
  }
  values.home = home
  values.artifactRoot = initializePreinstallArtifactRoot(values['--attempt-dir'])
  return values
}

export async function main(argv = process.argv.slice(2)) {
  currentValues = parseArguments(argv)
  const newAttempt = !readdirSync(join(currentValues['--attempt-dir'], 'preinstall'))
    .some(name => /^install-prepared\.r\d{6}\.receipt\.json$/u.test(name))
  const baseline = loadOrCreatePidBaseline(currentValues)
  if (newAttempt) preflight(currentValues, baseline)
  currentStatus = prepare(currentValues)
  if (currentStatus.phase === 'BOOTSTRAP_HANDOFF') {
    process.stdout.write(`${canonicalJson({ phase: 'BOOTSTRAP_HANDOFF', resumed: true })}\n`)
    return
  }
  if (currentStatus.phase === 'INSTALL_ABANDONED') fail('preinstall attempt was already abandoned')
  if (['BOOTSTRAP_HANDOFF_FINALIZING', 'BOOTSTRAP_HANDOFF_PENDING'].includes(currentStatus.phase)) {
    const convergence = validateConvergenceRaw(currentValues)
    const handoffResult = runController(['handoff', '--attempt-dir', currentValues['--attempt-dir'],
      '--install-attempt-id', currentStatus.installAttemptId,
      '--expected-revision', String(currentStatus.revision),
      '--runtime-convergence-proof', convergence.value.proof.path,
      '--video-batch-root', currentValues['--video-batch-root']], 'resumed preinstall handoff')
    if (handoffResult?.phase !== 'BOOTSTRAP_HANDOFF') fail('resumed preinstall handoff result is invalid')
    process.stdout.write(`${canonicalJson({ phase: 'BOOTSTRAP_HANDOFF', resumed: true })}\n`)
    return
  }
  if (currentStatus.phase === 'INSTALL_ROLLBACK_PENDING') {
    rollback(currentValues)
    fail('resumed preinstall rollback completed; attempt is abandoned')
  }
  try {
    requireForwardLeaseUnlessRecovering('task-flow')
    installTask(currentValues, baseline)
    requireForwardLeaseUnlessRecovering('video-command')
    installStructured(currentValues, 'video-command', paths.video,
      ['--apply', '--target-sha', currentValues['--source-commit'], '--defer-gateway-restart'], baseline)
    requireForwardLeaseUnlessRecovering('director-brain')
    const convergence = installDirector(currentValues, baseline)
    currentStatus = controllerStatus(currentValues)
    requireForwardLease()
    const verifyResult = runController(['verify', '--attempt-dir', currentValues['--attempt-dir'],
      '--install-attempt-id', currentStatus.installAttemptId,
      '--expected-revision', String(currentStatus.revision),
      '--releases-root', currentValues['--releases-root'],
      '--profile-state-root', currentValues['--profile-state-root'],
      '--workspace-root', currentValues['--workspace-root'],
      '--runtime-convergence-proof', convergence.value.proof.path,
      '--gateway-restart-evidence', artifact(
        currentValues, 'qwen-current-fresh-restart.result.json',
      )], 'preinstall verify')
    if (verifyResult?.phase !== 'INSTALL_VERIFIED') fail('preinstall verification result is invalid')
    currentStatus = controllerStatus(currentValues)
    assertPids(currentValues, baseline, 'changed')
    requireForwardLease()
    const handoffResult = runController(['handoff', '--attempt-dir', currentValues['--attempt-dir'],
      '--install-attempt-id', currentStatus.installAttemptId,
      '--expected-revision', String(currentStatus.revision),
      '--runtime-convergence-proof', convergence.value.proof.path,
      '--video-batch-root', currentValues['--video-batch-root']], 'preinstall handoff')
    if (handoffResult?.phase !== 'BOOTSTRAP_HANDOFF') fail('preinstall handoff result is invalid')
    process.stdout.write(`${canonicalJson({ phase: 'BOOTSTRAP_HANDOFF', resumed: false })}\n`)
  } catch (error) {
    currentStatus = controllerStatus(currentValues)
    if (currentStatus.phase.startsWith('BOOTSTRAP_HANDOFF')) throw error
    try { rollback(currentValues) } catch (rollbackError) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`)
    }
    throw error
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
