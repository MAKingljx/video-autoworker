#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateOpenClawRuntimeCompatibility } from './lib/openclaw-runtime-contract.mjs'
import { verifyInstalledExecveAdapter } from '../ops/recovery/install-blue-green-execve-adapter.mjs'

const RECEIPT_SCHEMA = 'video-autoworker-legacy-bootstrap-sdk-successor/v1'
const TOKEN_SCHEMA = 'video-autoworker-legacy-bootstrap-sdk-successor-capability/v1'
const CONSUMED_SCHEMA = 'video-autoworker-legacy-bootstrap-sdk-successor-consumed/v1'
const READINESS_SCHEMA = 'video-autoworker-director-video-preflight/v1'
const RESUME_SCHEMA = 'video-autoworker-legacy-bootstrap-resume-authorization/v1'
const RESUME_CONSUMED_SCHEMA = 'video-autoworker-legacy-bootstrap-resume-consumed/v1'
const PENDING_SCHEMA = 'video-autoworker-blue-green-bootstrap-pending/v4'
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const TTL_SECONDS = 3600
const scriptPath = realpathSync(fileURLToPath(import.meta.url))

function fail(message) { throw new Error(`legacy bootstrap SDK successor failed: ${message}`) }
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
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} path is invalid`)
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
function safeDirectory(pathname, label, mode = 0o700) {
  noSymlink(pathname, label)
  const entry = lstatSync(pathname)
  if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o777) !== mode
    || realpathSync(pathname) !== pathname) fail(`${label} is unsafe`)
  return entry
}
function safeSourceDirectory(pathname, label) {
  noSymlink(pathname, label)
  const entry = lstatSync(pathname)
  if (!entry.isDirectory() || entry.uid !== process.getuid() || (entry.mode & 0o022) !== 0
    || realpathSync(pathname) !== pathname) fail(`${label} is unsafe`)
  return entry
}
function stableFile(pathname, label, mode, maximumBytes = 16 * 1024 * 1024) {
  noSymlink(pathname, label)
  const before = lstatSync(pathname, { bigint: true })
  if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n
    || Number(before.mode & 0o7777n) !== mode || before.size <= 0n
    || before.size > BigInt(maximumBytes)) fail(`${label} is unsafe`)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    const source = readFileSync(descriptor)
    const after = lstatSync(pathname, { bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.nlink !== 1n || opened.uid !== before.uid
      || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      fail(`${label} changed while read`)
    }
    return {
      source,
      reference: {
        path: pathname, dev: before.dev.toString(), ino: before.ino.toString(),
        size: Number(before.size), sha256: sha256(source),
      },
    }
  } finally { closeSync(descriptor) }
}
function readJson(pathname, label, mode) {
  const loaded = stableFile(pathname, label, mode)
  try { return { ...loaded, value: JSON.parse(loaded.source.toString('utf8')) } }
  catch { fail(`${label} is invalid JSON`) }
}
function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail(`${label} fields are invalid`)
  }
}
function sameReference(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} reference changed`)
}
function gitFile(repository, commit, relativePath, expectedPath, expectedMode) {
  safeSourceDirectory(repository, 'Git source')
  if (realpathSync(repository) !== repository) fail('Git source is not physical')
  const head = execFileSync('/usr/bin/git', ['-C', repository, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (head !== commit) fail('Git source HEAD changed')
  const dirty = execFileSync('/usr/bin/git', ['-C', repository, 'status', '--porcelain=v1', '--untracked-files=all'], { encoding: 'utf8' }).trim()
  if (dirty) fail('Git source is not clean')
  const path = join(repository, relativePath)
  if (path !== expectedPath) fail(`${relativePath} path changed`)
  const loaded = stableFile(path, relativePath, expectedMode)
  const tracked = execFileSync('/usr/bin/git', ['-C', repository, 'show', `${commit}:${relativePath}`])
  if (sha256(tracked) !== loaded.reference.sha256) fail(`${relativePath} differs from Git`)
  return loaded.reference
}
function writeExclusive(pathname, value, mode) {
  const source = Buffer.from(`${canonicalJson(value)}\n`)
  const descriptor = openSync(pathname,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode)
  try { writeFileSync(descriptor, source); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  chmodSync(pathname, mode)
  const parent = openSync(dirname(pathname), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
  return readJson(pathname, basename(pathname), mode)
}
function unlinkDurable(pathname) {
  unlinkSync(pathname)
  const parent = openSync(dirname(pathname), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
function validateCompatibility(loaded) {
  try { return validateOpenClawRuntimeCompatibility(loaded.value) }
  catch { fail('OpenClaw compatibility is invalid') }
}
function normalizeGuard(value) {
  if (value?.mode !== 'recovery-hold' || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !value.database?.path || !value.n8nDatabase?.path || !value.socket?.path
    || typeof value.startedAt !== 'string' || value.startedAt.length === 0
    || !SHA256.test(value.guardNonceSha256 || '') || !SHA256.test(value.legacyBindingSha256 || '')) {
    fail('recovery hold is invalid')
  }
  return {
    mode: value.mode, pid: value.pid, startedAt: value.startedAt,
    database: value.database, n8nDatabase: value.n8nDatabase, socket: value.socket,
    guardNonceSha256: value.guardNonceSha256, legacyBindingSha256: value.legacyBindingSha256,
  }
}
function currentGuardStatus(controller, hold) {
  let stdout
  try {
    stdout = execFileSync(process.execPath, [
      controller, 'status', '--socket', hold.socket.path,
      '--database', hold.database.path, '--n8n-database', hold.n8nDatabase.path,
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 15_000 })
  } catch { fail('recovery hold status command failed') }
  let value
  try { value = JSON.parse(stdout) } catch { fail('recovery hold status command returned invalid JSON') }
  return normalizeGuard(value)
}
function validateReadiness(loaded, target) {
  const value = loaded.value
  const manifestSha256 = target.manifestSha256 ?? target.manifest?.sha256
  exactKeys(value?.contracts, [
    'directorWork', 'extractionSourceProvenance', 'outboxClosure',
    'sessionScopedRuntimeConvergence', 'standaloneArtifactContentBound',
  ], 'current 9.2 readiness contracts')
  exactKeys(value?.runtimeConvergence, [
    'catalogSha256', 'createdAt', 'effectiveSha256', 'gatewayPid', 'pluginTreesSha256',
    'schema', 'sessionKeySha256', 'sha256',
  ], 'current runtime convergence summary')
  if (value?.schema !== READINESS_SCHEMA || value.phase !== 'pre-bootstrap' || value.ok !== true
    || value.commit !== target.sourceCommit
    || value.app?.releaseId !== target.releaseId || value.app?.root !== target.releaseRoot
    || value.app?.manifestSha256 !== manifestSha256
    || value.provenance?.gitCommit !== target.sourceCommit
    || value.provenance?.sha256 !== target.provenanceSha256
    || value.payloads?.projectionContract?.currentDigest !== target.projectionContractDigest
    || value.runtimeConvergence?.schema !== 'video-autoworker-openclaw-runtime-convergence-proof/v1'
    || value.runtimeConvergence.sessionKeySha256 !== target.runtimeSessionKeySha256
    || !['sha256', 'catalogSha256', 'effectiveSha256', 'pluginTreesSha256', 'sessionKeySha256']
      .every(key => SHA256.test(value.runtimeConvergence[key] || ''))
    || !Number.isSafeInteger(value.runtimeConvergence.gatewayPid)
    || value.runtimeConvergence.gatewayPid <= 0
    || !Number.isFinite(Date.parse(value.runtimeConvergence.createdAt))
    || Object.values(value.contracts).some(item => item !== true)) {
    fail('current 9.2 readiness is invalid')
  }
  return value
}
function requestedTargetFromReadiness(loaded) {
  const value = loaded.value
  const projectionDigest = value?.payloads?.projectionContract?.currentDigest
  if (value?.schema !== READINESS_SCHEMA || value.phase !== 'pre-bootstrap' || value.ok !== true
    || !COMMIT.test(value.commit || '') || !value.app?.releaseId || !value.app?.root
    || !SHA256.test(value.app?.manifestSha256 || '') || !SHA256.test(projectionDigest || '')
    || value.provenance?.gitCommit !== value.commit
    || !SHA256.test(value.runtimeConvergence?.sessionKeySha256 || '')
    || !SHA256.test(value.provenance?.sha256 || '')) fail('requested target readiness is invalid')
  return {
    sourceCommit: value.commit,
    releaseId: value.app.releaseId,
    releaseRoot: value.app.root,
    manifestSha256: value.app.manifestSha256,
    provenanceSha256: value.provenance.sha256,
    projectionContractDigest: projectionDigest,
    runtimeSessionKeySha256: value.runtimeConvergence.sessionKeySha256,
  }
}
function parseArguments(argv) {
  const command = argv.shift()
  const definitions = {
    authorize: [
      '--successor-attempt', '--historical-repository', '--historical-commit',
      '--historical-bootstrap-attempt', '--pending', '--resume-attempt', '--runtime-release',
      '--n8n-pid', '--control-repository', '--control-commit', '--compatibility', '--guard-status',
      '--execve-adapter', '--requested-readiness',
    ],
    verify: ['--receipt', '--token', '--compatibility', '--execve-adapter', '--readiness', '--guard-status'],
    consume: ['--receipt', '--token', '--compatibility', '--execve-adapter', '--readiness', '--guard-status'],
    'verify-consumed': ['--receipt', '--consumed', '--compatibility', '--execve-adapter', '--readiness', '--guard-status'],
  }
  const allowed = definitions[command]
  if (!allowed) fail('command is invalid')
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!allowed.includes(key) || !value || Object.hasOwn(values, key)) fail(`${command} arguments are invalid`)
    values[key] = value
  }
  if (Object.keys(values).length !== allowed.length) fail(`${command} arguments are incomplete`)
  return { command, values }
}
function historicalResume(values) {
  const repository = normalized(values['--historical-repository'], 'historical repository')
  const commit = values['--historical-commit']
  if (!COMMIT.test(commit)) fail('historical commit is invalid')
  const controllerPath = join(repository, 'scripts/legacy-bootstrap-controller.mjs')
  const controller = gitFile(repository, commit, 'scripts/legacy-bootstrap-controller.mjs', controllerPath, 0o644)
  const attempt = normalized(values['--historical-bootstrap-attempt'], 'historical bootstrap attempt')
  const resumeAttempt = normalized(values['--resume-attempt'], 'historical resume attempt')
  safeDirectory(attempt, 'historical bootstrap attempt')
  safeDirectory(resumeAttempt, 'historical resume attempt')
  const pending = readJson(normalized(values['--pending'], 'bootstrap pending'), 'bootstrap pending', 0o400)
  if (pending.value?.schema !== PENDING_SCHEMA) fail('bootstrap pending is invalid')
  const receipt = readJson(join(resumeAttempt, 'resume.receipt.json'), 'historical resume receipt', 0o400)
  const consumed = readJson(join(resumeAttempt, 'resume.consumed.json'), 'historical resume consumed', 0o400)
  if (receipt.value?.schema !== RESUME_SCHEMA || consumed.value?.schema !== RESUME_CONSUMED_SCHEMA
    || consumed.value.recoveryAttemptId !== receipt.value.recoveryAttemptId
    || consumed.value.attemptId !== receipt.value.authorization?.attemptId
    || canonicalJson(consumed.value.resume) !== canonicalJson(receipt.reference)
    || !SHA256.test(consumed.value.runtimeSnapshotSha256 || '')
    || canonicalJson(receipt.value.authorization?.pending) !== canonicalJson(pending.reference)
    || pending.value.attemptId !== receipt.value.authorization?.attemptId
    || pending.value.slot !== receipt.value.target?.slot
    || pending.value.releaseId !== receipt.value.target?.releaseId
    || pending.value.releaseRoot !== receipt.value.target?.releaseRoot
    || pending.value.manifestSha256 !== receipt.value.target?.manifest?.sha256
    || pending.value.baselineSourceCommit !== commit
    || pending.value.n8n?.workflowSourceCommit !== commit) {
    fail('historical consumed resume chain is invalid')
  }
  const n8nPid = values['--n8n-pid']
  if (!/^[1-9][0-9]*$/u.test(n8nPid)) fail('n8n PID is invalid')
  const derive = execFileSync(process.execPath, [
    controllerPath, 'derive-bootstrap-resume',
    '--prepare', join(attempt, 'prepare.receipt.json'),
    '--confirm', join(attempt, 'current-confirm.receipt.json'),
    '--shutdown', join(attempt, 'shutdown-requested.receipt.json'),
    '--pending', pending.reference.path,
    '--runtime-release', normalized(values['--runtime-release'], 'n8n runtime release'),
    '--n8n-pid', n8nPid,
    '--recovery-attempt-dir', resumeAttempt,
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 60_000 })
  let result
  try { result = JSON.parse(derive) } catch { fail('historical controller returned invalid JSON') }
  if (result?.alreadyConsumed !== true || result.recoveryAttemptId !== receipt.value.recoveryAttemptId
    || canonicalJson(result.receipt) !== canonicalJson(receipt.reference)) {
    fail('historical controller did not confirm the consumed resume')
  }
  return { repository, commit, controller, attempt, pending, receipt, consumed }
}
function paths(attempt) {
  return {
    receipt: join(attempt, 'sdk-successor.receipt.json'),
    token: join(attempt, 'sdk-successor.token.json'),
    consumed: join(attempt, 'sdk-successor.consumed.json'),
  }
}
function validateConsumedArtifact(consumed, receipt, tokenReference = null) {
  exactKeys(consumed.value, [
    'authorizationId', 'compatibilitySha256', 'consumedAt', 'initialReadinessSha256',
    'receipt', 'schema', 'tokenSha256',
  ], 'successor consumed')
  if (consumed.value.schema !== CONSUMED_SCHEMA
    || consumed.value.authorizationId !== receipt.value.authorizationId
    || canonicalJson(consumed.value.receipt) !== canonicalJson(receipt.reference)
    || !Number.isSafeInteger(consumed.value.consumedAt)
    || consumed.value.consumedAt < receipt.value.issuedAt
    || consumed.value.consumedAt >= receipt.value.expiresAt
    || !SHA256.test(consumed.value.tokenSha256 || '')
    || (tokenReference && consumed.value.tokenSha256 !== tokenReference.sha256)
    || !SHA256.test(consumed.value.initialReadinessSha256 || '')
    || consumed.value.compatibilitySha256 !== receipt.value.compatibility.compatibilitySha256) {
    fail('successor consumed is invalid')
  }
  return consumed
}
function validateReceiptBindings(receipt) {
  exactKeys(receipt.value, [
    'authorizationId', 'compatibility', 'control', 'execveAdapter', 'expiresAt', 'historical', 'issuedAt',
    'nonceSha256', 'recoveryHold', 'requestedTarget', 'schema', 'uid',
  ], 'successor receipt')
  const value = receipt.value
  exactKeys(value.historical, [
    'attemptId', 'bootstrapAttempt', 'controller', 'databases', 'guardController', 'pending', 'repository', 'resume',
    'resumeConsumed', 'resumeRuntimeSnapshotSha256', 'routing', 'runtime', 'sourceCommit', 'target',
  ], 'successor historical authorization')
  exactKeys(value.control, [
    'compatibilityValidator', 'controller', 'readinessValidator', 'repository', 'runtimeContract',
    'sourceCommit',
  ], 'successor control source')
  exactKeys(value.requestedTarget, [
    'manifestSha256', 'projectionContractDigest', 'provenanceSha256', 'releaseId',
    'releaseRoot', 'runtimeSessionKeySha256', 'sourceCommit',
  ], 'successor requested target')
  exactKeys(value.compatibility, ['compatibilitySha256', 'reference', 'source'],
    'successor compatibility binding')
  exactKeys(value.execveAdapter, ['reference'], 'successor execve adapter binding')
  if (!COMMIT.test(value.historical.sourceCommit || '') || !COMMIT.test(value.control.sourceCommit || '')
    || value.historical.runtime?.workflow?.sourceCommit !== value.historical.sourceCommit
    || !SHA256.test(value.historical.resumeRuntimeSnapshotSha256 || '')
    || !UUID.test(value.historical.attemptId || '')
    || !SHA256.test(value.compatibility.compatibilitySha256 || '')) {
    fail('successor source bindings are invalid')
  }
  if (!COMMIT.test(value.requestedTarget.sourceCommit)
    || !SHA256.test(value.requestedTarget.manifestSha256)
    || !SHA256.test(value.requestedTarget.provenanceSha256)
    || !SHA256.test(value.requestedTarget.projectionContractDigest)
    || !SHA256.test(value.requestedTarget.runtimeSessionKeySha256)) {
    fail('successor requested target is invalid')
  }
  const historicalController = gitFile(
    value.historical.repository,
    value.historical.sourceCommit,
    'scripts/legacy-bootstrap-controller.mjs',
    value.historical.controller.path,
    0o644,
  )
  sameReference(historicalController, value.historical.controller, 'historical controller')
  const controlController = gitFile(
    value.control.repository,
    value.control.sourceCommit,
    'scripts/legacy-bootstrap-sdk-successor-controller.mjs',
    scriptPath,
    0o755,
  )
  sameReference(controlController, value.control.controller, 'successor controller')
  const compatibilityValidator = gitFile(
    value.control.repository,
    value.control.sourceCommit,
    'scripts/verify-openclaw-runtime-compatibility.mjs',
    value.control.compatibilityValidator.path,
    0o755,
  )
  sameReference(compatibilityValidator, value.control.compatibilityValidator,
    'OpenClaw compatibility validator')
  const readinessValidator = gitFile(
    value.control.repository,
    value.control.sourceCommit,
    'scripts/verify-director-video-release-readiness.mjs',
    value.control.readinessValidator.path,
    0o644,
  )
  sameReference(readinessValidator, value.control.readinessValidator,
    'release readiness validator')
  const runtimeContract = gitFile(
    value.control.repository,
    value.control.sourceCommit,
    'scripts/lib/openclaw-runtime-contract.mjs',
    value.control.runtimeContract.path,
    0o644,
  )
  sameReference(runtimeContract, value.control.runtimeContract, 'OpenClaw runtime contract')
  const execveAdapter = readJson(value.execveAdapter?.reference?.path,
    'successor execve adapter proof', 0o600)
  sameReference(execveAdapter.reference, value.execveAdapter.reference, 'successor execve adapter proof')
  const currentExecveAdapter = verifyInstalledExecveAdapter({
    sourceRoot: value.historical.repository,
    expectedCommit: value.historical.sourceCommit,
    adapterSourceRoot: value.control.repository,
    expectedAdapterCommit: value.control.sourceCommit,
    installationPath: execveAdapter.value.installation?.path,
    launchAgentsDir: execveAdapter.value.launchAgentsDir,
  })
  if (canonicalJson(currentExecveAdapter) !== canonicalJson(execveAdapter.value)) {
    fail('installed execve adapter changed')
  }
  const historicalGuardController = gitFile(
    value.historical.repository,
    value.historical.sourceCommit,
    'scripts/legacy-freeze-guard.mjs',
    value.historical.guardController.path,
    0o644,
  )
  sameReference(historicalGuardController, value.historical.guardController,
    'historical recovery guard controller')
  const pending = readJson(value.historical.pending.path, 'successor pending', 0o400)
  const resume = readJson(value.historical.resume.path, 'successor historical resume', 0o400)
  const consumed = readJson(value.historical.resumeConsumed.path,
    'successor historical resume consumed', 0o400)
  sameReference(pending.reference, value.historical.pending, 'successor pending')
  sameReference(resume.reference, value.historical.resume, 'successor historical resume')
  sameReference(consumed.reference, value.historical.resumeConsumed,
    'successor historical resume consumed')
  if (pending.value?.schema !== PENDING_SCHEMA || resume.value?.schema !== RESUME_SCHEMA
    || consumed.value?.schema !== RESUME_CONSUMED_SCHEMA
    || consumed.value.runtimeSnapshotSha256 !== value.historical.resumeRuntimeSnapshotSha256
    || canonicalJson(consumed.value.resume) !== canonicalJson(resume.reference)
    || canonicalJson(resume.value.target) !== canonicalJson(value.historical.target)
    || canonicalJson(resume.value.databases) !== canonicalJson(value.historical.databases)
    || canonicalJson(resume.value.routing) !== canonicalJson(value.historical.routing)
    || canonicalJson(resume.value.runtime) !== canonicalJson(value.historical.runtime)) {
    fail('successor historical chain changed')
  }
  if (pending.value.attemptId !== value.historical.attemptId
    || pending.value.slot !== value.historical.target?.slot
    || pending.value.releaseId !== value.historical.target?.releaseId
    || pending.value.releaseRoot !== value.historical.target?.releaseRoot
    || pending.value.manifestSha256 !== value.historical.target?.manifest?.sha256
    || pending.value.baselineSourceCommit !== value.historical.sourceCommit
    || pending.value.n8n?.workflowSourceCommit !== value.historical.sourceCommit
    || value.requestedTarget.sourceCommit === value.historical.sourceCommit
    || value.requestedTarget.sourceCommit === value.control.sourceCommit
    || value.control.sourceCommit === value.historical.sourceCommit
    || value.requestedTarget.releaseId === value.historical.target?.releaseId
    || value.requestedTarget.releaseRoot === value.historical.target?.releaseRoot) {
    fail('successor historical and requested target identities are invalid')
  }
  const hold = normalizeGuard(value.recoveryHold)
  if (hold.database.path !== value.historical.databases?.mission?.path
    || hold.n8nDatabase.path !== value.historical.databases?.n8n?.path) {
    fail('recovery hold database bindings changed')
  }
  if (canonicalJson(currentGuardStatus(value.historical.guardController.path, hold))
    !== canonicalJson(hold)) fail('recovery hold changed')
}
function authorize(values) {
  const attempt = normalized(values['--successor-attempt'], 'successor attempt')
  if (!existsSync(attempt)) mkdirSync(attempt, { mode: 0o700 })
  safeDirectory(attempt, 'successor attempt')
  const output = paths(attempt)
  if (!existsSync(output.receipt) && !existsSync(output.consumed) && existsSync(output.token)) {
    const orphan = readJson(output.token, 'orphaned successor token', 0o600)
    exactKeys(orphan.value, [
      'authorizationId', 'capability', 'expiresAt', 'issuedAt', 'receiptSha256', 'schema',
    ], 'orphaned successor token')
    if (orphan.value.schema !== TOKEN_SCHEMA || !UUID.test(orphan.value.authorizationId || '')
      || !Number.isSafeInteger(orphan.value.issuedAt) || orphan.value.issuedAt <= 0
      || !Number.isSafeInteger(orphan.value.expiresAt)
      || orphan.value.expiresAt <= orphan.value.issuedAt
      || !/^[a-f0-9]{64}$/u.test(orphan.value.capability || '')
      || !SHA256.test(orphan.value.receiptSha256 || '')) fail('orphaned successor token is invalid')
    unlinkDurable(output.token)
  }
  if (existsSync(output.receipt) || existsSync(output.token) || existsSync(output.consumed)) {
    fail('successor attempt already contains immutable authorization artifacts; create a new successor attempt directory and plan')
  }
  const historical = historicalResume(values)
  const controlRepository = normalized(values['--control-repository'], 'control repository')
  const controlCommit = values['--control-commit']
  if (!COMMIT.test(controlCommit)) fail('control commit is invalid')
  const control = gitFile(controlRepository, controlCommit,
    'scripts/legacy-bootstrap-sdk-successor-controller.mjs', scriptPath, 0o755)
  const compatibilityValidatorPath = join(
    controlRepository, 'scripts/verify-openclaw-runtime-compatibility.mjs',
  )
  const readinessValidatorPath = join(
    controlRepository, 'scripts/verify-director-video-release-readiness.mjs',
  )
  const runtimeContractPath = join(controlRepository, 'scripts/lib/openclaw-runtime-contract.mjs')
  const compatibilityValidator = gitFile(controlRepository, controlCommit,
    'scripts/verify-openclaw-runtime-compatibility.mjs', compatibilityValidatorPath, 0o755)
  const readinessValidator = gitFile(controlRepository, controlCommit,
    'scripts/verify-director-video-release-readiness.mjs', readinessValidatorPath, 0o644)
  const runtimeContract = gitFile(controlRepository, controlCommit,
    'scripts/lib/openclaw-runtime-contract.mjs', runtimeContractPath, 0o644)
  const historicalGuardControllerPath = join(
    historical.repository, 'scripts/legacy-freeze-guard.mjs',
  )
  const historicalGuardController = gitFile(historical.repository, historical.commit,
    'scripts/legacy-freeze-guard.mjs', historicalGuardControllerPath, 0o644)
  const compatibility = readJson(normalized(values['--compatibility'], 'compatibility'),
    'OpenClaw compatibility', 0o600)
  const compatibilityValue = validateCompatibility(compatibility)
  if (compatibilityValue.source.commit !== controlCommit
    || compatibilityValue.source.contractSha256 !== runtimeContract.sha256) {
    fail('OpenClaw compatibility source is not the control source')
  }
  const execveAdapterPath = normalized(values['--execve-adapter'], 'execve adapter proof')
  if (!existsSync(execveAdapterPath)) fail('execve adapter proof is unavailable')
  const execveAdapter = readJson(execveAdapterPath, 'execve adapter proof', 0o600)
  const currentExecveAdapter = verifyInstalledExecveAdapter({
    sourceRoot: historical.repository,
    expectedCommit: historical.commit,
    adapterSourceRoot: controlRepository,
    expectedAdapterCommit: controlCommit,
    installationPath: execveAdapter.value.installation?.path,
    launchAgentsDir: execveAdapter.value.launchAgentsDir,
  })
  if (canonicalJson(currentExecveAdapter) !== canonicalJson(execveAdapter.value)) {
    fail('installed execve adapter proof is not current')
  }
  const guard = readJson(normalized(values['--guard-status'], 'guard status'), 'guard status', 0o600)
  const hold = normalizeGuard(guard.value)
  if (canonicalJson(currentGuardStatus(historicalGuardControllerPath, hold)) !== canonicalJson(hold)) {
    fail('recovery hold status is not current')
  }
  const requestedReadiness = readJson(
    normalized(values['--requested-readiness'], 'requested readiness'),
    'requested target readiness',
    0o600,
  )
  const requestedTarget = requestedTargetFromReadiness(requestedReadiness)
  if (requestedTarget.sourceCommit === historical.commit
    || requestedTarget.sourceCommit === controlCommit
    || controlCommit === historical.commit
    || requestedTarget.releaseId === historical.receipt.value.target?.releaseId
    || requestedTarget.releaseRoot === historical.receipt.value.target?.releaseRoot) {
    fail('successor target must differ from the historical application')
  }
  if (hold.database.path !== historical.receipt.value.databases?.mission?.path
    || hold.n8nDatabase.path !== historical.receipt.value.databases?.n8n?.path) {
    fail('recovery hold databases differ from the historical authorization')
  }
  const issuedAt = Math.floor(Date.now() / 1000)
  const capability = randomBytes(32).toString('hex')
  const receipt = {
    schema: RECEIPT_SCHEMA,
    authorizationId: randomUUID(),
    issuedAt,
    expiresAt: issuedAt + TTL_SECONDS,
    uid: process.getuid(),
    nonceSha256: sha256(capability),
    historical: {
      attemptId: historical.receipt.value.authorization.attemptId,
      repository: historical.repository,
      sourceCommit: historical.commit,
      controller: historical.controller,
      guardController: historicalGuardController,
      bootstrapAttempt: historical.attempt,
      pending: historical.pending.reference,
      resume: historical.receipt.reference,
      resumeConsumed: historical.consumed.reference,
      resumeRuntimeSnapshotSha256: historical.consumed.value.runtimeSnapshotSha256,
      target: historical.receipt.value.target,
      databases: historical.receipt.value.databases,
      routing: historical.receipt.value.routing,
      runtime: historical.receipt.value.runtime,
    },
    control: {
      repository: controlRepository,
      sourceCommit: controlCommit,
      controller: control,
      compatibilityValidator,
      readinessValidator,
      runtimeContract,
    },
    compatibility: {
      reference: compatibility.reference,
      compatibilitySha256: compatibilityValue.compatibilitySha256,
      source: compatibilityValue.source,
    },
    execveAdapter: { reference: execveAdapter.reference },
    requestedTarget,
    recoveryHold: hold,
  }
  const receiptSha256 = sha256(`${canonicalJson(receipt)}\n`)
  writeExclusive(output.token, {
    schema: TOKEN_SCHEMA,
    authorizationId: receipt.authorizationId,
    issuedAt, expiresAt: receipt.expiresAt,
    capability,
    receiptSha256,
  }, 0o600)
  let receiptLoaded
  try { receiptLoaded = writeExclusive(output.receipt, receipt, 0o400) }
  catch (error) { try { unlinkDurable(output.token) } catch {}; throw error }
  process.stdout.write(`${canonicalJson({
    mode: 'authorize', receipt: receiptLoaded.reference, token: output.token,
    authorizationId: receipt.authorizationId, expiresAt: receipt.expiresAt,
  })}\n`)
}
function loadCurrent(values, consumedMode) {
  const receipt = readJson(normalized(values['--receipt'], 'successor receipt'), 'successor receipt', 0o400)
  if (receipt.value?.schema !== RECEIPT_SCHEMA || !UUID.test(receipt.value.authorizationId || '')
    || receipt.value.uid !== process.getuid() || !Number.isSafeInteger(receipt.value.issuedAt)
    || !Number.isSafeInteger(receipt.value.expiresAt) || !SHA256.test(receipt.value.nonceSha256 || '')) {
    fail('successor receipt is invalid')
  }
  validateReceiptBindings(receipt)
  const storedCompatibility = readJson(receipt.value.compatibility?.reference?.path,
    'stored OpenClaw compatibility', 0o600)
  sameReference(storedCompatibility.reference, receipt.value.compatibility.reference,
    'stored OpenClaw compatibility')
  const compatibility = readJson(normalized(values['--compatibility'], 'current compatibility'),
    'current OpenClaw compatibility', 0o600)
  const storedValue = validateCompatibility(storedCompatibility)
  const currentValue = validateCompatibility(compatibility)
  if (currentValue.compatibilitySha256 !== receipt.value.compatibility.compatibilitySha256
    || currentValue.compatibilitySha256 !== storedValue.compatibilitySha256) {
    fail('stable OpenClaw compatibility changed')
  }
  if (currentValue.source.commit !== receipt.value.control.sourceCommit
    || currentValue.source.contractSha256 !== receipt.value.control.runtimeContract.sha256) {
    fail('OpenClaw compatibility source changed')
  }
  const execveAdapter = readJson(normalized(values['--execve-adapter'], 'current execve adapter proof'),
    'current execve adapter proof', 0o600)
  sameReference(execveAdapter.reference, receipt.value.execveAdapter.reference,
    'current execve adapter proof')
  const guard = readJson(normalized(values['--guard-status'], 'current guard status'),
    'current guard status', 0o600)
  const currentHold = normalizeGuard(guard.value)
  if (canonicalJson(currentHold) !== canonicalJson(receipt.value.recoveryHold)
    || canonicalJson(currentGuardStatus(receipt.value.historical.guardController.path, currentHold))
      !== canonicalJson(currentHold)) {
    fail('recovery hold changed')
  }
  const readiness = readJson(normalized(values['--readiness'], 'current readiness'),
    'current 9.2 readiness', 0o600)
  validateReadiness(readiness, receipt.value.requestedTarget)
  const result = { receipt, compatibility, guard, readiness }
  if (consumedMode) {
    const consumed = readJson(normalized(values['--consumed'], 'successor consumed'),
      'successor consumed', 0o400)
    result.consumed = validateConsumedArtifact(consumed, receipt)
  } else {
    const token = readJson(normalized(values['--token'], 'successor token'), 'successor token', 0o600)
    if (token.value?.schema !== TOKEN_SCHEMA
      || token.value.authorizationId !== receipt.value.authorizationId
      || token.value.receiptSha256 !== receipt.reference.sha256
      || token.value.expiresAt !== receipt.value.expiresAt
      || sha256(token.value.capability || '') !== receipt.value.nonceSha256) fail('successor token is invalid')
    result.token = token
  }
  return result
}
function outputVerification(chain, mode) {
  process.stdout.write(`${canonicalJson({
    mode,
    ok: true,
    authorizationId: chain.receipt.value.authorizationId,
    historicalRepository: chain.receipt.value.historical.repository,
    historicalSourceCommit: chain.receipt.value.historical.sourceCommit,
    controlSourceCommit: chain.receipt.value.control.sourceCommit,
    historicalAttemptId: chain.receipt.value.historical.attemptId,
    historicalController: chain.receipt.value.historical.controller,
    compatibilitySha256: chain.receipt.value.compatibility.compatibilitySha256,
    historicalTarget: chain.receipt.value.historical.target,
    requestedTarget: chain.receipt.value.requestedTarget,
    n8nWorkflowSourceCommit: chain.receipt.value.historical.runtime?.workflow?.sourceCommit,
    historicalPending: chain.receipt.value.historical.pending,
    historicalRunDirectory: chain.receipt.value.historical.routing?.runDirectory,
    historicalRouterStatePath: chain.receipt.value.historical.routing?.statePath,
    historicalSlot: chain.receipt.value.historical.target?.slot,
    readiness: chain.readiness.value,
    receipt: chain.receipt.reference,
    consumed: chain.consumed?.reference ?? null,
  })}\n`)
}
function verify(values) {
  const chain = loadCurrent(values, false)
  if (Math.floor(Date.now() / 1000) >= chain.receipt.value.expiresAt) {
    fail('successor capability expired; preserve immutable artifacts and create a new successor attempt directory and plan')
  }
  outputVerification(chain, 'verify')
}
function consume(values) {
  const chain = loadCurrent(values, false)
  const now = Math.floor(Date.now() / 1000)
  if (now >= chain.receipt.value.expiresAt) {
    fail('successor capability expired; preserve immutable artifacts and create a new successor attempt directory and plan')
  }
  const consumedPath = join(dirname(chain.receipt.reference.path), 'sdk-successor.consumed.json')
  if (existsSync(consumedPath)) {
    chain.consumed = validateConsumedArtifact(
      readJson(consumedPath, 'successor consumed', 0o400),
      chain.receipt,
      chain.token.reference,
    )
    unlinkDurable(chain.token.reference.path)
    outputVerification(chain, 'consume')
    return
  }
  const consumed = writeExclusive(consumedPath, {
    schema: CONSUMED_SCHEMA,
    authorizationId: chain.receipt.value.authorizationId,
    consumedAt: now,
    receipt: chain.receipt.reference,
    tokenSha256: chain.token.reference.sha256,
    initialReadinessSha256: chain.readiness.reference.sha256,
    compatibilitySha256: chain.receipt.value.compatibility.compatibilitySha256,
  }, 0o400)
  unlinkDurable(chain.token.reference.path)
  chain.consumed = consumed
  outputVerification(chain, 'consume')
}
function verifyConsumed(values) { outputVerification(loadCurrent(values, true), 'verify-consumed') }

export function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArguments([...argv])
  if (command === 'authorize') return authorize(values)
  if (command === 'verify') return verify(values)
  if (command === 'consume') return consume(values)
  return verifyConsumed(values)
}

if (process.argv[1] && scriptPath === realpathSync(process.argv[1])) {
  try { main() } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
