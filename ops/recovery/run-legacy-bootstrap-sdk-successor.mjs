#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, openSync,
  readFileSync, realpathSync, renameSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLAN_SCHEMA = 'video-autoworker-legacy-bootstrap-sdk-successor-plan/v1'
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const INTAKE_SCHEMA = 'video-autoworker-intake-control/v1'
const INTAKE_URL = 'http://127.0.0.1:3017/api/n8n/intake-control'
const scriptPath = realpathSync(fileURLToPath(import.meta.url))

function fail(message) { throw new Error(`legacy bootstrap SDK successor runner failed: ${message}`) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  }
  return value
}
function canonicalJson(value) { return JSON.stringify(stable(value)) }
function normalized(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} is invalid`)
  return pathname
}
function noSymlink(pathname, label) {
  normalized(pathname, label)
  let cursor = parse(pathname).root
  for (const part of relative(cursor, pathname).split('/').filter(Boolean)) {
    cursor = join(cursor, part)
    if (lstatSync(cursor).isSymbolicLink()) fail(`${label} traverses a symlink`)
  }
}
function stableFile(pathname, label, mode = null) {
  noSymlink(pathname, label)
  const before = lstatSync(pathname, { bigint: true })
  if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n
    || (mode === null ? Number(before.mode & 0o6022n) !== 0 : Number(before.mode & 0o7777n) !== mode)
    || before.size <= 0n || before.size > 16n * 1024n * 1024n) fail(`${label} is unsafe`)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    const source = readFileSync(descriptor)
    const after = lstatSync(pathname, { bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.uid !== before.uid || opened.nlink !== 1n
      || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      fail(`${label} changed while read`)
    }
    return { source, sha256: sha256(source) }
  } finally { closeSync(descriptor) }
}
function safeDirectory(pathname, label, mode = 0o700) {
  noSymlink(pathname, label)
  const entry = lstatSync(pathname)
  if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o777) !== mode
    || realpathSync(pathname) !== pathname) fail(`${label} is unsafe`)
}
function safeSourceDirectory(pathname, label) {
  noSymlink(pathname, label)
  const entry = lstatSync(pathname)
  if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o022) !== 0
    || realpathSync(pathname) !== pathname) fail(`${label} is unsafe`)
}
function readJson(pathname, label, mode) {
  const loaded = stableFile(pathname, label, mode)
  try { return JSON.parse(loaded.source.toString('utf8')) } catch { fail(`${label} is invalid JSON`) }
}
function atomicWrite(pathname, value) {
  const source = Buffer.from(`${canonicalJson(value)}\n`)
  const temporary = `${pathname}.${process.pid}.tmp`
  const descriptor = openSync(temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(descriptor, source); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  chmodSync(temporary, 0o600)
  renameSync(temporary, pathname)
  const parent = openSync(dirname(pathname), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
  return source
}
function writeStable(pathname, value) {
  const source = Buffer.from(`${canonicalJson(value)}\n`)
  if (existsSync(pathname)) {
    const existing = stableFile(pathname, 'stable compatibility output', 0o600)
    if (existing.sha256 !== sha256(source)) fail('stable compatibility changed after authorization')
    return
  }
  const descriptor = openSync(pathname,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(descriptor, source); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  chmodSync(pathname, 0o600)
  const parent = openSync(dirname(pathname), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
function writeExclusive(pathname, value, mode) {
  const source = Buffer.from(`${canonicalJson(value)}\n`)
  const descriptor = openSync(pathname,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try { writeFileSync(descriptor, source); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  chmodSync(pathname, mode)
  const parent = openSync(dirname(pathname), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
  return source
}
function writeImmutable(pathname, value) {
  const source = Buffer.from(`${canonicalJson(value)}\n`)
  if (existsSync(pathname)) {
    const existing = stableFile(pathname, 'immutable recovery output', 0o400)
    if (existing.sha256 !== sha256(source)) fail('immutable recovery output changed')
    return existing
  }
  writeExclusive(pathname, value, 0o400)
  return { source, sha256: sha256(source) }
}
function runJson(command, args, label, options = {}) {
  let stdout
  try {
    stdout = execFileSync(command, args, {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120_000, ...options,
    })
  } catch { fail(`${label} failed`) }
  try { return JSON.parse(stdout) } catch { fail(`${label} returned invalid JSON`) }
}
function gitBoundFile(repository, commit, relativePath, mode) {
  safeSourceDirectory(repository, 'control repository')
  const pathname = join(repository, relativePath)
  const loaded = stableFile(pathname, relativePath, mode)
  let head
  let dirty
  let tracked
  try {
    head = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', '--verify', 'HEAD^{commit}'], {
      encoding: 'utf8',
    }).trim()
    dirty = execFileSync('/usr/bin/git', [
      '-C', repository, 'status', '--porcelain=v1', '--untracked-files=all',
    ], { encoding: 'utf8' }).trim()
    tracked = execFileSync('/usr/bin/git', ['-C', repository, 'show', `${commit}:${relativePath}`])
  } catch { fail(`${relativePath} Git binding failed`) }
  if (head !== commit || dirty || sha256(tracked) !== loaded.sha256) {
    fail(`${relativePath} is not bound to the clean control source`)
  }
  return pathname
}
function requiredObject(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || keys.some(key => !Object.hasOwn(value, key))) fail(`${label} is incomplete`)
  return value
}
function sanitizedEnvironment(source = process.env) {
  if (source.NODE_ENV === 'test' || Object.keys(source).some(key => (
    key.startsWith('AIWORKER_TEST_')
    || key === 'AIWORKER_OPENCLAW_RUNTIME_TEST_MODE'
    || key.startsWith('FAKE_')
  ))) fail('test injection environment is forbidden')
  const clean = {}
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'SHELL']) {
    if (typeof source[key] === 'string' && source[key]) clean[key] = source[key]
  }
  clean.PATH = '/usr/bin:/bin:/usr/sbin:/sbin'
  clean.NODE_BIN = process.execPath
  for (const key of ['AIWORKER_BG_CONTROL_TOKEN_FILE', 'AIWORKER_PLATFORM_ENV_FILE']) {
    if (typeof source[key] === 'string' && source[key]) clean[key] = source[key]
  }
  return clean
}
function loadPlan(pathname) {
  const value = readJson(normalized(pathname, 'plan'), 'successor plan', 0o600)
  requiredObject(value, [
    'schema', 'control', 'historical', 'successorAttempt', 'runtime', 'guard', 'target', 'environment', 'execve',
  ], 'successor plan')
  if (value.schema !== PLAN_SCHEMA) fail('plan schema is invalid')
  requiredObject(value.control, ['repository', 'commit'], 'control source')
  requiredObject(value.historical, [
    'repository', 'commit', 'bootstrapAttempt', 'pending', 'resumeAttempt', 'runtimeRelease', 'n8nPid',
  ], 'historical source')
  requiredObject(value.runtime, [
    'openclawPackageRoot', 'profileConfig', 'videoPluginRoot', 'directorPluginRoot',
    'profileStateRoot', 'workspaceRoot', 'liveProof',
  ], 'OpenClaw runtime')
  requiredObject(value.guard, ['controller', 'socket', 'database', 'n8nDatabase'], 'recovery guard')
  requiredObject(value.target, [
    'slot', 'releaseId', 'releaseRoot', 'releasesRoot', 'evidence', 'rollbackProof',
  ], 'historical target')
  requiredObject(value.environment, ['runDir', 'routerState'], 'bootstrap environment')
  requiredObject(value.execve, ['installation', 'launchAgentsDir'], 'execve adapter')
  if (!COMMIT.test(value.control.commit) || !COMMIT.test(value.historical.commit)
    || !['blue', 'green'].includes(value.target.slot)
    || !Number.isSafeInteger(value.historical.n8nPid) || value.historical.n8nPid <= 0) {
    fail('plan identities are invalid')
  }
  for (const [label, path] of Object.entries({
    controlRepository: value.control.repository,
    historicalRepository: value.historical.repository,
    bootstrapAttempt: value.historical.bootstrapAttempt,
    pending: value.historical.pending,
    resumeAttempt: value.historical.resumeAttempt,
    runtimeRelease: value.historical.runtimeRelease,
    successorAttempt: value.successorAttempt,
    openclawPackageRoot: value.runtime.openclawPackageRoot,
    profileConfig: value.runtime.profileConfig,
    videoPluginRoot: value.runtime.videoPluginRoot,
    directorPluginRoot: value.runtime.directorPluginRoot,
    profileStateRoot: value.runtime.profileStateRoot,
    workspaceRoot: value.runtime.workspaceRoot,
    liveProof: value.runtime.liveProof,
    guardController: value.guard.controller,
    guardSocket: value.guard.socket,
    missionDatabase: value.guard.database,
    n8nDatabase: value.guard.n8nDatabase,
    releaseRoot: value.target.releaseRoot,
    releasesRoot: value.target.releasesRoot,
    evidence: value.target.evidence,
    rollbackProof: value.target.rollbackProof,
    runDir: value.environment.runDir,
    routerState: value.environment.routerState,
    execveInstallation: value.execve.installation,
    launchAgentsDir: value.execve.launchAgentsDir,
  })) normalized(path, label)
  return value
}
function intakeResumeReason(recoveryReceiptSha256) {
  return `SDK successor 恢复完成，恢复新任务入口 [${recoveryReceiptSha256.slice(0, 24)}]`
}
function validIntakeControl(value) {
  return value?.schema === INTAKE_SCHEMA && value.globalScope === true && value.canManage === true
    && Number.isSafeInteger(value.revision) && value.revision >= 1
    && value.counts && Number.isSafeInteger(value.counts.active) && value.counts.active >= 0
}
function validRecoveredAttestation(attestation, plan, completion, expectedRevision) {
  return attestation?.schema === 'video-autoworker-transition-release-evidence/v1'
    && attestation.payload?.slot === plan.target.slot
    && attestation.payload?.releaseId === completion.releaseId
    && attestation.payload?.releaseRoot === completion.releaseRoot
    && attestation.payload?.manifestSha256 === completion.manifestSha256
    && attestation.payload?.readiness?.revision === expectedRevision
    && attestation.payload?.route?.activeSlot === plan.target.slot
    && attestation.payload?.route?.releaseId === completion.releaseId
    && Number.isSafeInteger(attestation.payload?.route?.generation)
    && attestation.payload.route.generation >= 1
}
async function responseJson(response, label) {
  let value
  try { value = await response.json() } catch { fail(`${label} returned invalid JSON`) }
  if (!response.ok) fail(`${label} returned HTTP ${response.status}`)
  return value
}
export async function verifyRecoveredRouter({
  slot,
  releaseId,
  generation,
  request = fetch,
}) {
  if (!['blue', 'green'].includes(slot) || typeof releaseId !== 'string' || !releaseId
    || !Number.isSafeInteger(generation) || generation < 1) {
    fail('recovered router binding is invalid')
  }
  const router = await responseJson(await request('http://127.0.0.1:3017/__router/health', {
    cache: 'no-store', signal: AbortSignal.timeout(8_000),
  }), 'recovered router status')
  if (router?.schema !== 'video-autoworker-standalone-router-health/v1'
    || router.ok !== true || router.active !== slot || router.releaseId !== releaseId
    || router.generation !== generation || !Number.isSafeInteger(router.pid) || router.pid < 1) {
    fail('recovered router differs from the baseline attestation')
  }
  return {
    activeSlot: router.active,
    releaseId: router.releaseId,
    generation: router.generation,
  }
}
export async function reconcileRecoveredIntake({
  pausedRevision,
  recoveryReceiptSha256,
  request = fetch,
}) {
  if (!Number.isSafeInteger(pausedRevision) || pausedRevision < 1 || !SHA256.test(recoveryReceiptSha256)) {
    fail('intake resume binding is invalid')
  }
  const reason = intakeResumeReason(recoveryReceiptSha256)
  const initial = (await responseJson(await request(INTAKE_URL, {
    cache: 'no-store', signal: AbortSignal.timeout(8_000),
  }), 'intake status'))?.control
  if (!validIntakeControl(initial)) fail('intake status is invalid')

  let control = initial
  if (!control.accepting) {
    if (control.mode !== 'paused' || control.revision !== pausedRevision || control.counts.active !== 0) {
      fail('paused intake differs from the recovered completion')
    }
    control = (await responseJson(await request(INTAKE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'resume', reason, expectedRevision: pausedRevision }),
      signal: AbortSignal.timeout(8_000),
    }), 'intake resume'))?.control
  }
  if (!validIntakeControl(control) || control.accepting !== true || control.mode !== 'active'
    || control.revision !== pausedRevision + 1 || control.reason !== reason
    || !Number.isSafeInteger(control.changedAt) || control.changedAt < 1
    || !control.changedBy || !Number.isSafeInteger(control.changedBy.id)
    || typeof control.changedBy.name !== 'string' || !control.changedBy.name) {
    fail('resumed intake is not bound to this recovery')
  }
  return {
    pausedRevision,
    resumedRevision: control.revision,
    reason,
    changedAt: control.changedAt,
    changedBy: control.changedBy,
  }
}
async function publishRecoveredResult(plan, deploy, env, required = false) {
  const completionPath = join(plan.successorAttempt, 'recovery-completion.json')
  if (!existsSync(completionPath)) {
    if (required) fail('recovery completion is unavailable')
    return false
  }
  const receiptPath = join(plan.successorAttempt, 'sdk-successor.receipt.json')
  const mappingPath = join(plan.successorAttempt, 'target-mapping.json')
  const successorReceipt = readJson(receiptPath, 'successor receipt', 0o400)
  const targetMapping = stableFile(mappingPath, 'target mapping', 0o400)
  const completion = readJson(completionPath, 'recovery completion', 0o400)
  const releaseManifest = stableFile(join(completion.releaseRoot, 'release-manifest.json'),
    'target release manifest')
  if (completion?.schema !== 'video-autoworker-legacy-bootstrap-sdk-successor-baseline-established/v1'
    || completion.baselineEstablished !== true || completion.intakePaused !== true
    || !COMMIT.test(completion.sourceCommit || '')
    || completion.historicalSourceCommit !== plan.historical.commit
    || completion.sourceCommit !== successorReceipt.requestedTarget?.sourceCommit
    || completion.attempt !== successorReceipt.historical?.attemptId
    || successorReceipt.historical?.sourceCommit !== plan.historical.commit
    || successorReceipt.control?.sourceCommit !== plan.control.commit
    || successorReceipt.requestedTarget?.releaseId !== plan.target.releaseId
    || successorReceipt.requestedTarget?.releaseRoot !== plan.target.releaseRoot
    || completion.releaseId !== plan.target.releaseId
    || completion.releaseRoot !== plan.target.releaseRoot
    || !SHA256.test(completion.manifestSha256 || '')
    || completion.manifestSha256 !== releaseManifest.sha256
    || typeof completion.attempt !== 'string'
    || !Number.isSafeInteger(completion.pausedIntakeRevision)
    || completion.pausedIntakeRevision < 1 || !Number.isSafeInteger(completion.establishedAt)
    || completion.establishedAt < 1_000_000_000_000
    || completion.establishedAt > Date.now() + 5_000
    || completion.controlSourceCommit !== plan.control.commit
    || completion.successorReceipt?.path !== receiptPath
    || completion.successorReceipt?.sha256 !== stableFile(receiptPath, 'successor receipt', 0o400).sha256
    || completion.targetMapping?.path !== mappingPath
    || completion.targetMapping?.sha256 !== targetMapping.sha256) {
    fail('recovery completion is invalid')
  }
  const completionReference = {
    path: completionPath,
    sha256: stableFile(completionPath, 'recovery completion', 0o400).sha256,
  }
  const attestationPath = join(plan.successorAttempt, 'baseline-attestation.json')
  let attestation
  if (existsSync(attestationPath)) {
    attestation = readJson(attestationPath, 'baseline attestation', 0o400)
  } else {
    attestation = runJson('/bin/bash', [deploy, 'attest-current'],
      'current recovered release attestation', { env, timeout: 120_000 })
    if (!validRecoveredAttestation(
      attestation, plan, completion, completion.pausedIntakeRevision,
    )) fail('paused baseline attestation differs from recovery completion')
    writeImmutable(attestationPath, attestation)
  }
  if (!validRecoveredAttestation(
    attestation, plan, completion, completion.pausedIntakeRevision,
  )) fail('paused baseline attestation differs from recovery completion')
  const attestationReference = {
    path: attestationPath,
    sha256: stableFile(attestationPath, 'baseline attestation', 0o400).sha256,
  }
  await verifyRecoveredRouter({
    slot: plan.target.slot,
    releaseId: completion.releaseId,
    generation: attestation.payload.route.generation,
  })
  const intake = await reconcileRecoveredIntake({
    pausedRevision: completion.pausedIntakeRevision,
    recoveryReceiptSha256: completionReference.sha256,
  })
  const router = await verifyRecoveredRouter({
    slot: plan.target.slot,
    releaseId: completion.releaseId,
    generation: attestation.payload.route.generation,
  })
  const intakeProofPath = join(plan.successorAttempt, 'intake-resumed.json')
  const intakeProof = {
    schema: 'video-autoworker-legacy-bootstrap-sdk-successor-intake-resumed/v1',
    intakeResumed: true,
    authorizationId: successorReceipt.authorizationId,
    completion: completionReference,
    baselineAttestation: attestationReference,
    route: {
      activeSlot: router.activeSlot,
      releaseId: router.releaseId,
      generation: router.generation,
    },
    ...intake,
  }
  const intakeProofReference = {
    path: intakeProofPath,
    sha256: writeImmutable(intakeProofPath, intakeProof).sha256,
  }
  const controlRoot = dirname(plan.historical.bootstrapAttempt)
  safeDirectory(controlRoot, 'historical control root')
  const resultPath = join(controlRoot, 'result.json')
  const result = {
    schema: 'video-autoworker-legacy-release-recovery-result/v1',
    ok: true,
    recovered: true,
    sourceCommit: completion.sourceCommit,
    historicalSourceCommit: plan.historical.commit,
    attempt: completion.attempt,
    pausedIntakeRevision: completion.pausedIntakeRevision,
    intakeRevision: intake.resumedRevision,
    intakeResumed: true,
    completedAt: intake.changedAt * 1_000,
    controlSourceCommit: plan.control.commit,
    releaseId: completion.releaseId,
    releaseRoot: completion.releaseRoot,
    manifestSha256: completion.manifestSha256,
    recoveryReceipt: completionReference,
    baselineAttestation: attestationReference,
    intakeResume: intakeProofReference,
  }
  if (existsSync(resultPath)) {
    const existing = readJson(resultPath, 'historical result', 0o600)
    if (canonicalJson(existing) !== canonicalJson(result)) fail('historical result differs from recovery completion')
  } else {
    writeExclusive(resultPath, result, 0o600)
  }
  return true
}
async function main(planPath) {
  const cleanEnvironment = sanitizedEnvironment()
  const plan = loadPlan(planPath)
  safeDirectory(plan.successorAttempt, 'successor attempt')
  const runner = gitBoundFile(plan.control.repository, plan.control.commit,
    'ops/recovery/run-legacy-bootstrap-sdk-successor.mjs', 0o755)
  if (runner !== scriptPath) fail('successor runner path differs from the control source')
  const deploy = gitBoundFile(plan.control.repository, plan.control.commit,
    'scripts/deploy-blue-green.sh', 0o755)
  const env = {
    ...cleanEnvironment,
    AIWORKER_BG_RUN_DIR: plan.environment.runDir,
    AIWORKER_BG_ROUTER_STATE: plan.environment.routerState,
    AIWORKER_BG_RELEASES_DIR: plan.target.releasesRoot,
    AIWORKER_BG_LIVE_DB_PATH: plan.guard.database,
    AIWORKER_BG_N8N_DB_PATH: plan.guard.n8nDatabase,
    AIWORKER_OPENCLAW_RUNTIME_CONVERGENCE_PROOF: plan.runtime.liveProof,
  }
  if (!existsSync(plan.historical.pending) && await publishRecoveredResult(plan, deploy, env)) return
  const compatibilityPath = join(plan.successorAttempt, 'openclaw-runtime-compatibility.json')
  const readinessPath = join(plan.successorAttempt, 'current-readiness.json')
  const guardStatusPath = join(plan.successorAttempt, 'current-guard-status.json')
  const controller = gitBoundFile(plan.control.repository, plan.control.commit,
    'scripts/legacy-bootstrap-sdk-successor-controller.mjs', 0o755)
  const compatibilityCli = gitBoundFile(plan.control.repository, plan.control.commit,
    'scripts/verify-openclaw-runtime-compatibility.mjs', 0o755)
  const readinessCli = gitBoundFile(plan.control.repository, plan.control.commit,
    'scripts/verify-director-video-release-readiness.mjs', 0o644)
  const execveAdapter = gitBoundFile(plan.control.repository, plan.control.commit,
    'ops/recovery/install-blue-green-execve-adapter.mjs', 0o755)

  const execveAdapterPath = join(plan.successorAttempt, 'execve-adapter.json')
  const execveAdapterProof = runJson(process.execPath, [
    execveAdapter, '--verify-installed',
    '--source-root', plan.historical.repository,
    '--expected-commit', plan.historical.commit,
    '--adapter-source-root', plan.control.repository,
    '--expected-adapter-commit', plan.control.commit,
    '--installation', plan.execve.installation,
    '--launch-agents-dir', plan.execve.launchAgentsDir,
  ], 'installed execve adapter', { env: cleanEnvironment })
  writeStable(execveAdapterPath, execveAdapterProof)

  const compatibility = runJson(process.execPath, [
    compatibilityCli,
    '--repository-root', plan.control.repository,
    '--source-commit', plan.control.commit,
    '--openclaw-package-root', plan.runtime.openclawPackageRoot,
    '--profile-config', plan.runtime.profileConfig,
    '--video-plugin-root', plan.runtime.videoPluginRoot,
    '--director-plugin-root', plan.runtime.directorPluginRoot,
  ], 'OpenClaw runtime compatibility', { env: cleanEnvironment })
  writeStable(compatibilityPath, compatibility)

  const readiness = runJson(process.execPath, [
    readinessCli,
    '--repository-root', plan.control.repository,
    '--releases-root', plan.target.releasesRoot,
    '--release-id', plan.target.releaseId,
    '--release-root', plan.target.releaseRoot,
    '--profile-state-root', plan.runtime.profileStateRoot,
    '--workspace-root', plan.runtime.workspaceRoot,
    '--runtime-convergence-proof', plan.runtime.liveProof,
    '--repository-release-mode', 'ancestor',
    '--verification-phase', 'pre-bootstrap',
  ], 'current 9.2 release readiness', { env: cleanEnvironment })
  atomicWrite(readinessPath, readiness)

  const guardStatus = runJson(process.execPath, [
    plan.guard.controller, 'status', '--socket', plan.guard.socket,
    '--database', plan.guard.database, '--n8n-database', plan.guard.n8nDatabase,
  ], 'recovery hold status', { env: cleanEnvironment, timeout: 15_000 })
  atomicWrite(guardStatusPath, guardStatus)

  const receiptPath = join(plan.successorAttempt, 'sdk-successor.receipt.json')
  const tokenPath = join(plan.successorAttempt, 'sdk-successor.token.json')
  const consumedPath = join(plan.successorAttempt, 'sdk-successor.consumed.json')
  if (!existsSync(receiptPath)) {
    runJson(process.execPath, [
      controller, 'authorize',
      '--successor-attempt', plan.successorAttempt,
      '--historical-repository', plan.historical.repository,
      '--historical-commit', plan.historical.commit,
      '--historical-bootstrap-attempt', plan.historical.bootstrapAttempt,
      '--pending', plan.historical.pending,
      '--resume-attempt', plan.historical.resumeAttempt,
      '--runtime-release', plan.historical.runtimeRelease,
      '--n8n-pid', String(plan.historical.n8nPid),
      '--control-repository', plan.control.repository,
      '--control-commit', plan.control.commit,
      '--compatibility', compatibilityPath,
      '--execve-adapter', execveAdapterPath,
      '--guard-status', guardStatusPath,
      '--requested-readiness', readinessPath,
    ], 'successor authorization', { env: cleanEnvironment })
  }
  if (existsSync(tokenPath)) {
    runJson(process.execPath, [
      controller, 'verify', '--receipt', receiptPath, '--token', tokenPath,
      '--compatibility', compatibilityPath, '--execve-adapter', execveAdapterPath, '--readiness', readinessPath,
      '--guard-status', guardStatusPath,
    ], 'successor verification', { env: cleanEnvironment })
  } else if (!existsSync(consumedPath)) {
    fail('successor authorization has neither a token nor consumed receipt')
  }
  if (existsSync(consumedPath)) {
    runJson(process.execPath, [
      controller, 'verify-consumed', '--receipt', receiptPath, '--consumed', consumedPath,
      '--compatibility', compatibilityPath, '--execve-adapter', execveAdapterPath, '--readiness', readinessPath,
      '--guard-status', guardStatusPath,
    ], 'consumed successor verification', { env: cleanEnvironment })
  }

  execFileSync('/bin/bash', [
    deploy, 'bootstrap-successor',
    plan.target.slot, plan.target.releaseId, plan.target.releaseRoot,
    plan.target.evidence, plan.target.rollbackProof, plan.historical.bootstrapAttempt,
    controller, receiptPath, tokenPath, consumedPath, compatibilityPath, execveAdapterPath,
    readinessPath, guardStatusPath,
  ], { env, stdio: 'inherit', timeout: 20 * 60_000 })

  await publishRecoveredResult(plan, deploy, env, true)
}

if (process.argv[1] && scriptPath === realpathSync(process.argv[1])) {
  try {
    const argv = process.argv.slice(2)
    if (argv.length !== 2 || argv[0] !== '--plan') fail('expected --plan <path>')
    await main(argv[1])
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
