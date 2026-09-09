#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync,
  openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  verifyRollingRuntimeBinding,
  verifySharedRuntimeInstallGate,
} from './verify-shared-runtime-install-gate.mjs'
import { projectOfflineQueue } from './lib/runtime-safe-offline-queue.mjs'

const SCRIPT_PATH = realpathSync(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = realpathSync(join(dirname(SCRIPT_PATH), '..'))
const SHARED_GATE_PATH = realpathSync(join(dirname(SCRIPT_PATH), 'verify-shared-runtime-install-gate.mjs'))
const REPORT_SCHEMA = 'video-autoworker-guardian-resume-baseline/v1'
const VERIFY_SCHEMA = 'video-autoworker-guardian-resume-baseline-verification/v1'
const PREPARED_SCHEMA = 'video-autoworker-legacy-media-orphan-runtime-receipt/v1'
const GATE_SCHEMA = 'video-autoworker-shared-runtime-install-gate/v1'
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_DATABASE_BYTES = 64 * 1024 * 1024 * 1024

function fail(message) { throw new Error(`guardian resume baseline failed: ${message}`) }
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}
function canonicalJson(value) { return JSON.stringify(canonicalize(value)) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }

function normalizedAbsolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} must be one normalized absolute path`)
  return pathname
}

function assertNoSymlink(pathname, label, allowMissingLeaf = false) {
  normalizedAbsolute(pathname, label)
  const root = parse(pathname).root
  let cursor = root
  const parts = relative(root, pathname).split('/').filter(Boolean)
  for (let index = 0; index < parts.length; index += 1) {
    cursor = join(cursor, parts[index])
    let entry
    try { entry = lstatSync(cursor, { bigint: true }) } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && error?.code === 'ENOENT') return
      fail(`${label} path component is unavailable`)
    }
    if (entry.isSymbolicLink()) fail(`${label} path contains a symlink`)
  }
}

function safeEntry(pathname, label, kind, mode = null, maximumBytes = MAX_JSON_BYTES) {
  assertNoSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if (kind === 'file' && (!entry.isFile() || entry.nlink !== 1n)) fail(`${label} is not one regular file`)
  if (kind === 'directory' && !entry.isDirectory()) fail(`${label} is not a directory`)
  if (entry.uid !== BigInt(process.getuid())) fail(`${label} owner is invalid`)
  const actualMode = Number(entry.mode & 0o7777n)
  if (mode === null ? (actualMode & 0o022) !== 0 : actualMode !== mode) fail(`${label} mode is unsafe`)
  if (kind === 'file' && (entry.size <= 0n || entry.size > BigInt(maximumBytes))) fail(`${label} size is invalid`)
  return entry
}

function fullFileReference(pathname, label, mode = null, maximumBytes = MAX_JSON_BYTES) {
  const entry = safeEntry(pathname, label, 'file', mode, maximumBytes)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size
      || opened.nlink !== 1n) fail(`${label} changed before read`)
    const source = readFileSync(descriptor)
    const afterFd = fstatSync(descriptor, { bigint: true })
    const afterPath = lstatSync(pathname, { bigint: true })
    if (source.length !== Number(opened.size) || afterFd.dev !== opened.dev
      || afterFd.ino !== opened.ino || afterFd.size !== opened.size
      || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino
      || afterPath.size !== opened.size || afterPath.nlink !== 1n) fail(`${label} changed during read`)
    return {
      path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString(),
      size: Number(entry.size), mtimeNs: entry.mtimeNs.toString(), ctimeNs: entry.ctimeNs.toString(),
      uid: Number(entry.uid), mode: actualMode(entry), nlink: Number(entry.nlink), sha256: sha256(source),
    }
  } finally { closeSync(descriptor) }
}

function actualMode(entry) { return Number(entry.mode & 0o7777n) }

function verifyFullFileReference(reference, label, mode = null) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)
    || !SHA256.test(reference.sha256 || '') || typeof reference.path !== 'string') {
    fail(`${label} reference is invalid`)
  }
  const current = fullFileReference(reference.path, label, mode)
  if (canonicalJson(current) !== canonicalJson(reference)) fail(`${label} reference changed`)
  return current
}

function readJson(pathname, label, mode = null) {
  const reference = fullFileReference(pathname, label, mode)
  const source = readFileSync(pathname, 'utf8')
  let value
  try { value = JSON.parse(source) } catch { fail(`${label} is not JSON`) }
  if (sha256(source) !== reference.sha256
    || canonicalJson(fullFileReference(pathname, label, mode)) !== canonicalJson(reference)) {
    fail(`${label} changed during parse`)
  }
  return { value, reference, source }
}

function fsyncDirectory(pathname) {
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function writeImmutableJson(pathname, value) {
  assertNoSymlink(pathname, 'baseline output', true)
  if (existsSync(pathname)) fail('baseline output already exists')
  const parent = dirname(pathname)
  safeEntry(parent, 'baseline output directory', 'directory', 0o700)
  const temporary = join(parent, `.${basename(pathname)}.${randomBytes(16).toString('hex')}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    writeFileSync(descriptor, `${canonicalJson(value)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    chmodSync(temporary, 0o400)
    const verifyFd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(verifyFd) } finally { closeSync(verifyFd) }
    linkSync(temporary, pathname)
    unlinkSync(temporary)
    fsyncDirectory(parent)
    return readJson(pathname, 'baseline report', 0o400)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

function validatePrepared(pathname) {
  const loaded = readJson(pathname, 'prepared receipt', 0o400)
  if (loaded.value?.schema !== PREPARED_SCHEMA || !loaded.value.holdGuardian
    || loaded.value.launchGuardian?.path !== join(loaded.value.runtimeBefore?.batchRoot || '', '.worker-launch.lock')) {
    fail('prepared receipt is not one held guardian receipt')
  }
  return loaded
}

function validateGate(gate, inputs) {
  const baseline = gate?.maintenanceQueue?.baseline
  if (gate?.schema !== GATE_SCHEMA || gate.mode !== 'rolling'
    || gate.sourceCommit !== inputs.expectedSourceCommit
    || gate.targetReleaseId !== inputs.expectedReleaseId
    || gate.activeTasks !== gate.waiting || gate.waiting < 1 || gate.running !== 0
    || gate.activeMediaNodes !== 0 || gate.activeN8nExecutions !== 0 || gate.pendingOutbox !== 0
    || !Number.isSafeInteger(gate.intakeRevision) || gate.intakeRevision < 1
    || gate.maintenanceQueue?.reason !== 'maintenance_guardian'
    || gate.maintenanceQueue.queued !== gate.waiting || !baseline
    || baseline.activity?.intakeRevision !== gate.intakeRevision
    || baseline.activity.mediaActive !== 0 || baseline.activity.n8nActive !== 0
    || baseline.activity.pendingOutbox !== 0
    || baseline.queue?.waiting !== gate.waiting || baseline.queue.running !== 0
    || baseline.queue.attentionStale !== gate.attentionStale
    || !Array.isArray(baseline.queue.values)
    || baseline.queue.values.filter(item => item.origin !== 'attention-stale').length !== gate.waiting
    || baseline.queue.values.some(item => item.origin !== 'attention-stale'
      && (item.status !== 'queued' || !['durable', 'durable+n8n'].includes(item.origin)))
    || gate.maintenanceQueue.snapshotSha256 !== sha256(canonicalJson(baseline))
    || gate.stableQueueSha256 !== gate.maintenanceQueue.snapshotSha256
    || gate.runtimeBinding?.videoBatchRoot !== inputs.videoBatchRoot
    || gate.runtimeBinding?.activeApplication?.releaseId !== inputs.expectedActiveReleaseId
    || gate.runtimeBinding?.installedManager?.manager?.sourceCommit !== inputs.expectedManagerCommit
    || !SHA256.test(gate.runtimeBinding?.installedManager?.installation?.sha256 || '')) {
    fail('shared runtime gate result does not satisfy guardian resume')
  }
  return gate
}

function gateInputs(inputs) {
  return {
    missionControlDbPath: inputs.missionControlDbPath,
    n8nDbPath: inputs.n8nDbPath,
    deploymentRunDir: inputs.deploymentRunDir,
    videoBatchRoot: inputs.videoBatchRoot,
    expectedSourceCommit: inputs.expectedSourceCommit,
    expectedReleaseId: inputs.expectedReleaseId,
    expectedMaintenanceQueueSha256: inputs.expectedMaintenanceQueueSha256 || '',
    operation: 'install',
    phase: 'component',
  }
}

function captureGate(inputs, dependencies = {}) {
  const verifyGate = dependencies.verifySharedRuntimeInstallGate ?? verifySharedRuntimeInstallGate
  return validateGate(verifyGate(gateInputs(inputs), dependencies.sharedGateDependencies), inputs)
}

function captureInstalledComponents(inputs, dependencies = {}) {
  if (dependencies.captureInstalledComponents) return dependencies.captureInstalledComponents(inputs)
  const environment = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) delete environment[key]
  const git = args => {
    try { return execFileSync('/usr/bin/git', ['-C', REPOSITORY_ROOT, ...args], {
      encoding: 'utf8', env: environment, timeout: 10_000, maxBuffer: 1024 * 1024,
    }).trim() } catch { fail('shared component source Git binding failed') }
  }
  if (git(['rev-parse', 'HEAD']) !== inputs.expectedSourceCommit
    || git(['status', '--porcelain=v1', '--untracked-files=all'])
    || !['https://github.com/MAKingljx/video-autoworker.git', 'git@github.com:MAKingljx/video-autoworker.git']
      .includes(git(['remote', 'get-url', 'origin']))) fail('shared component source is not one clean canonical commit')
  const match = /^(\/Users\/[^/]+)\//u.exec(inputs.videoBatchRoot)
  if (!match) fail('shared component home is invalid')
  const home = match[1], workspace = join(home, 'AI-worker-second-original-workspace')
  const pairs = []
  const add = (source, installed) => {
    safeEntry(source, 'shared component source', lstatSync(source).isDirectory() ? 'directory' : 'file')
    if (lstatSync(source).isDirectory()) {
      for (const name of readdirSync(source).sort()) add(join(source, name), join(installed, name))
    } else {
      if (pairs.length >= 200) fail('shared component file limit exceeded')
      const expected = fullFileReference(source, 'shared component source')
      const current = fullFileReference(installed, 'installed shared component')
      if (expected.sha256 !== current.sha256) fail('installed shared component differs from canonical source')
      pairs.push({ source: expected, installed: current })
    }
  }
  for (const name of ['aiworker-video-command', 'aiworker-director-brain']) {
    const source = join(REPOSITORY_ROOT, 'openclaw-plugins', name)
    const installed = join(home, '.openclaw-qwen-current/extensions', name)
    for (const part of ['index.js', 'package.json', 'openclaw.plugin.json', 'lib', ...(name === 'aiworker-video-command' ? ['scripts'] : [])]) add(join(source, part), join(installed, part))
  }
  for (const name of ['SKILL.md', 'scripts', 'lib']) add(join(REPOSITORY_ROOT, 'openclaw-skills/aiworker-task-flow', name), join(workspace, 'skills/aiworker-task-flow', name))
  add(join(REPOSITORY_ROOT, 'openclaw-skills/aiworker-director-brain/SKILL.md'), join(workspace, 'skills/aiworker-director-brain/SKILL.md'))
  for (const part of ['scripts/lib/feishu-director-brain.mjs', 'scripts/lib/sensitive-value-scanner.mjs',
    'scripts/feishu-director-brain.mjs', 'ops/feishu-director-brain/schema.json']) {
    add(join(REPOSITORY_ROOT, part), join(home, '.openclaw-qwen-current/extensions/aiworker-director-brain/runtime', part))
  }
  return { sourceCommit: inputs.expectedSourceCommit, files: pairs }
}

function validateInputs(inputs) {
  for (const [label, pathname] of Object.entries({
    missionControlDbPath: inputs.missionControlDbPath,
    n8nDbPath: inputs.n8nDbPath,
    deploymentRunDir: inputs.deploymentRunDir,
    videoBatchRoot: inputs.videoBatchRoot,
  })) normalizedAbsolute(pathname, label)
  if (!COMMIT.test(inputs.expectedSourceCommit || '')
    || !RELEASE_ID.test(inputs.expectedReleaseId || '')
    || inputs.expectedReleaseId !== `${inputs.expectedSourceCommit}-runtime`
    || !RELEASE_ID.test(inputs.expectedActiveReleaseId || '')
    || !COMMIT.test(inputs.expectedManagerCommit || '')) fail('baseline version binding is invalid')
  return inputs
}

export function createGuardianResumeBaseline(inputs, dependencies = {}) {
  validateInputs(inputs)
  normalizedAbsolute(inputs.output, 'baseline output')
  const prepared = validatePrepared(inputs.preparedReceipt)
  const components = captureInstalledComponents(inputs, dependencies)
  const first = captureGate(inputs, dependencies)
  const second = captureGate({
    ...inputs,
    expectedMaintenanceQueueSha256: first.maintenanceQueue.snapshotSha256,
  }, dependencies)
  if (canonicalJson(first) !== canonicalJson(second)) fail('shared runtime gate changed between baseline samples')
  const report = writeImmutableJson(inputs.output, {
    schema: REPORT_SCHEMA,
    createdAt: new Date().toISOString(),
    producer: fullFileReference(SCRIPT_PATH, 'baseline producer'),
    sharedGateVerifier: fullFileReference(SHARED_GATE_PATH, 'shared runtime gate verifier'),
    preparedReceipt: prepared.reference,
    components,
    inputs: {
      missionControlDbPath: inputs.missionControlDbPath,
      n8nDbPath: inputs.n8nDbPath,
      deploymentRunDir: inputs.deploymentRunDir,
      videoBatchRoot: inputs.videoBatchRoot,
      expectedSourceCommit: inputs.expectedSourceCommit,
      expectedReleaseId: inputs.expectedReleaseId,
      expectedActiveReleaseId: inputs.expectedActiveReleaseId,
      expectedManagerCommit: inputs.expectedManagerCommit,
    },
    gate: second,
    snapshotSha256: sha256(canonicalJson(second)),
  })
  return { schema: VERIFY_SCHEMA, ok: true, report: report.reference, snapshot: second,
    snapshotSha256: sha256(canonicalJson(second)) }
}

function loadReport(pathname, preparedReceipt, dependencies = {}) {
  const loaded = readJson(pathname, 'baseline report', 0o400)
  const value = loaded.value
  if (value?.schema !== REPORT_SCHEMA || !value.inputs || !value.gate
    || !SHA256.test(value.snapshotSha256 || '')
    || value.snapshotSha256 !== sha256(canonicalJson(value.gate))) fail('baseline report contract is invalid')
  verifyFullFileReference(value.producer, 'baseline producer')
  verifyFullFileReference(value.sharedGateVerifier, 'shared runtime gate verifier')
  if (value.producer.path !== SCRIPT_PATH || value.sharedGateVerifier.path !== SHARED_GATE_PATH) {
    fail('baseline verifier path binding is invalid')
  }
  const prepared = validatePrepared(preparedReceipt)
  if (value.preparedReceipt.path !== prepared.reference.path
    || canonicalJson(value.preparedReceipt) !== canonicalJson(prepared.reference)) {
    fail('baseline prepared receipt binding changed')
  }
  validateInputs(value.inputs)
  validateGate(value.gate, value.inputs)
  if (canonicalJson(captureInstalledComponents(value.inputs, dependencies)) !== canonicalJson(value.components)) {
    fail('installed shared components changed after baseline')
  }
  return loaded
}

function verificationResult(loaded, snapshot) {
  const report = fullFileReference(loaded.reference.path, 'baseline report', 0o400)
  if (canonicalJson(report) !== canonicalJson(loaded.reference)) fail('baseline report changed during verification')
  return { schema: VERIFY_SCHEMA, ok: true, report, snapshot,
    snapshotSha256: sha256(canonicalJson(snapshot)) }
}

export function verifyGuardianResumeBaseline({ report, preparedReceipt }, dependencies = {}) {
  const loaded = loadReport(report, preparedReceipt, dependencies)
  const current = captureGate({
    ...loaded.value.inputs,
    expectedMaintenanceQueueSha256: loaded.value.gate.maintenanceQueue.snapshotSha256,
  }, dependencies)
  if (canonicalJson(current) !== canonicalJson(loaded.value.gate)) fail('guardian resume baseline changed')
  return verificationResult(loaded, current)
}

export function verifyGuardianResumeArtifact({ report, preparedReceipt }, dependencies = {}) {
  const loaded = loadReport(report, preparedReceipt, dependencies)
  return verificationResult(loaded, loaded.value.gate)
}

function physicalDatabase(pathname, label) {
  const entry = safeEntry(pathname, label, 'file', null, MAX_DATABASE_BYTES)
  if (realpathSync.native(pathname) !== pathname || entry.nlink !== 1n) fail(`${label} is not physical`)
  return { path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString() }
}

// Startup may add only its control files. Business files, including source paths
// and idempotency keys, remain byte-for-byte bound until authorization is issued.
export function verifyHeldBusinessFiles(batchRoot, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.files) || !Array.isArray(snapshot.entries)
    || snapshot.activeJournals !== 0) fail('held business snapshot is invalid')
  const controlNames = new Set(['.worker-launch.lock', '.worker-launch.lock.owner',
    '.global-video-worker.lock', '.worker-launch.lock.authorization',
    '.worker-launch.lock.authorization.pending', '.worker-launch.lock.authorization.claim'])
  const entries = readdirSync(batchRoot, { withFileTypes: true })
    .filter(entry => !controlNames.has(entry.name))
    .map(entry => ({ name: entry.name, kind: entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other' }))
    .sort((a, b) => a.name.localeCompare(b.name))
  const expected = snapshot.entries.filter(entry => !controlNames.has(entry.name))
  if (canonicalJson(entries) !== canonicalJson(expected)) fail('held business members changed')
  for (const file of snapshot.files) {
    const pathname = resolve(batchRoot, file.pathname)
    if (!pathname.startsWith(`${batchRoot}/`)) fail('held business file path is invalid')
    const current = fullFileReference(pathname, 'held business file')
    const entry = lstatSync(pathname, { bigint: true })
    const projection = Object.fromEntries(['dev','ino','uid','mode','nlink','size','mtimeNs','ctimeNs']
      .map(key => [key, entry[key].toString()]))
    if (current.sha256 !== file.sourceSha256 || canonicalJson(projection) !== canonicalJson(file.identity)) {
      fail('held business file changed')
    }
  }
  return snapshot
}

function successorDatabaseSnapshot(inputs, baseline, dependencies = {}) {
  const Database = dependencies.Database ?? createRequire(join(REPOSITORY_ROOT, 'package.json'))('better-sqlite3')
  const missionIdentity = physicalDatabase(inputs.missionControlDbPath, 'Mission Control database')
  const n8nIdentity = physicalDatabase(inputs.n8nDbPath, 'n8n database')
  let mission
  let n8n
  try {
    mission = new Database(missionIdentity.path, { readonly: true, fileMustExist: true })
    n8n = new Database(n8nIdentity.path, { readonly: true, fileMustExist: true })
    mission.pragma('query_only = ON'); n8n.pragma('query_only = ON')
    if (mission.pragma('quick_check', { simple: true }) !== 'ok'
      || n8n.pragma('quick_check', { simple: true }) !== 'ok') fail('successor database quick_check failed')
    mission.exec('BEGIN'); n8n.exec('BEGIN')
    const rows = mission.prepare(`
      SELECT task_id AS taskId, status, updated_at AS updatedAt
      FROM n8n_task_runs
      WHERE status IN ('queued','accepted','running','staging','submitted','waiting','recovering','paused')
      ORDER BY created_at, id
    `).all()
    const durable = baseline.queue.values.filter(item => ['durable', 'durable+n8n'].includes(item.origin))
      .map(item => ({ taskId: item.taskId, status: item.status, origin: 'durable' }))
    const queue = projectOfflineQueue(rows, durable, Math.floor(Date.now() / 1_000))
    const mediaActive = Number(mission.prepare(`
      SELECT COUNT(*) AS count FROM n8n_task_runs
      WHERE source = 'n8n-media-node' AND status IN ('queued','accepted','running')
    `).get()?.count)
    const n8nActive = Number(n8n.prepare(`
      SELECT COUNT(*) AS count FROM execution_entity
      WHERE status IN ('new','running','waiting') AND "stoppedAt" IS NULL
    `).get()?.count)
    const intake = mission.prepare('SELECT accepting, revision FROM n8n_intake_controls WHERE control_id = 1').get()
    const pendingOutbox = Number(mission.prepare(`
      SELECT COUNT(*) AS count FROM n8n_director_evidence_outbox WHERE status = 'pending'
    `).get()?.count)
    n8n.exec('COMMIT'); mission.exec('COMMIT')
    const snapshot = { queue: { ...queue, attentionStale: queue.values.filter(item => item.origin === 'attention-stale').length,
      durableSnapshot: baseline.queue.durableSnapshot },
      activity: { intakeRevision: Number(intake?.revision), mediaActive, n8nActive, pendingOutbox } }
    if (intake?.accepting !== 0 || canonicalJson(snapshot.queue) !== canonicalJson(baseline.queue)
      || canonicalJson(snapshot.activity) !== canonicalJson(baseline.activity)) {
      fail('held queue or paused activity changed before successor authorization')
    }
    return { ...snapshot, missionIdentity, n8nIdentity }
  } finally {
    try { n8n?.exec('ROLLBACK') } catch {}
    try { mission?.exec('ROLLBACK') } catch {}
    try { n8n?.close() } catch {}
    try { mission?.close() } catch {}
  }
}

export function verifyGuardianResumeSuccessor({ report, preparedReceipt }, dependencies = {}) {
  const loaded = loadReport(report, preparedReceipt, dependencies)
  const baseline = loaded.value.gate.maintenanceQueue.baseline
  verifyHeldBusinessFiles(loaded.value.inputs.videoBatchRoot, baseline.queue.durableSnapshot)
  const database = successorDatabaseSnapshot(loaded.value.inputs, baseline, dependencies)
  const verifyRuntime = dependencies.verifyRollingRuntimeBinding ?? verifyRollingRuntimeBinding
  const runtimeBinding = verifyRuntime({
    deploymentRunDir: loaded.value.inputs.deploymentRunDir,
    missionIdentity: database.missionIdentity,
    n8nIdentity: database.n8nIdentity,
    videoBatchRoot: loaded.value.inputs.videoBatchRoot,
  }, dependencies.runtimeDependencies)
  if (canonicalJson(runtimeBinding) !== canonicalJson(loaded.value.gate.runtimeBinding)) {
    fail('runtime binding changed before successor authorization')
  }
  verifyHeldBusinessFiles(loaded.value.inputs.videoBatchRoot, baseline.queue.durableSnapshot)
  return verificationResult(loaded, { database: { queue: database.queue, activity: database.activity }, runtimeBinding })
}

function parseArguments(argv) {
  const command = argv.shift()
  const allowed = new Set(command === 'create' ? [
    '--output', '--prepared-receipt', '--mission-control-db-path', '--n8n-db-path',
    '--deployment-run-dir', '--video-batch-root', '--expected-source-commit', '--expected-release-id',
    '--expected-active-release-id', '--expected-manager-commit',
  ] : ['--report', '--prepared-receipt'])
  if (!['create', 'verify-live', 'verify-successor', 'verify-artifact'].includes(command)) fail('unknown command')
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    if (!allowed.has(name) || Object.hasOwn(values, name) || !argv[index + 1]) fail('arguments are invalid')
    values[name] = argv[index + 1]
  }
  if (Object.keys(values).length !== allowed.size) fail('required arguments are missing')
  if (command === 'create') return { command, output: normalizedAbsolute(values['--output'], 'output'),
    preparedReceipt: normalizedAbsolute(values['--prepared-receipt'], 'prepared receipt'),
    missionControlDbPath: normalizedAbsolute(values['--mission-control-db-path'], 'Mission Control database'),
    n8nDbPath: normalizedAbsolute(values['--n8n-db-path'], 'n8n database'),
    deploymentRunDir: normalizedAbsolute(values['--deployment-run-dir'], 'deployment run directory'),
    videoBatchRoot: normalizedAbsolute(values['--video-batch-root'], 'video batch root'),
    expectedSourceCommit: values['--expected-source-commit'], expectedReleaseId: values['--expected-release-id'],
    expectedActiveReleaseId: values['--expected-active-release-id'], expectedManagerCommit: values['--expected-manager-commit'] }
  return { command, report: normalizedAbsolute(values['--report'], 'report'),
    preparedReceipt: normalizedAbsolute(values['--prepared-receipt'], 'prepared receipt') }
}

export function main(argv = process.argv.slice(2)) {
  const values = parseArguments([...argv])
  const result = values.command === 'create' ? createGuardianResumeBaseline(values)
    : values.command === 'verify-live' ? verifyGuardianResumeBaseline(values)
      : values.command === 'verify-artifact' ? verifyGuardianResumeArtifact(values)
      : verifyGuardianResumeSuccessor(values)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { main() } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
