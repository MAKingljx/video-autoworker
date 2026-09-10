#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync, closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync,
  openSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertCleanGitSource,
  getGitProductFileEntry,
  readGitProductFile,
} from '../../scripts/lib/git-source-layout.mjs'

const PLAN_SCHEMA = 'video-autoworker-legacy-bootstrap-sdk-successor-plan/v1'
const RECEIPT_SCHEMA = 'video-autoworker-legacy-bootstrap-sdk-successor/v1'
const CONSUMED_SCHEMA = 'video-autoworker-legacy-bootstrap-sdk-successor-consumed/v1'
const MAPPING_SCHEMA = 'video-autoworker-legacy-bootstrap-sdk-target-mapping/v1'
const BASELINE_SCHEMA = 'video-autoworker-blue-green-baseline/v3'
const COMPLETION_SCHEMA = 'video-autoworker-legacy-bootstrap-sdk-successor-baseline-established/v1'
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const scriptPath = realpathSync(fileURLToPath(import.meta.url))

function fail(message) { throw new Error(`committed bootstrap successor finisher failed: ${message}`) }
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
function safeDirectory(pathname, label, mode = 0o700) {
  noSymlink(pathname, label)
  const entry = lstatSync(pathname)
  if (!entry.isDirectory() || entry.uid !== process.getuid()
    || (mode === null ? (entry.mode & 0o022) !== 0 : (entry.mode & 0o777) !== mode)
    || realpathSync(pathname) !== pathname) fail(`${label} is unsafe`)
}
function stableFile(pathname, label, mode = 0o600, parseJson = true) {
  noSymlink(pathname, label)
  const before = lstatSync(pathname, { bigint: true })
  if (!before.isFile() || before.uid !== BigInt(process.getuid()) || before.nlink !== 1n
    || Number(before.mode & 0o7777n) !== mode || before.size <= 0n || before.size > 16n * 1024n * 1024n) {
    fail(`${label} is unsafe`)
  }
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
    const result = {
      source,
      reference: {
        path: pathname, dev: opened.dev.toString(), ino: opened.ino.toString(),
        size: Number(opened.size), sha256: sha256(source),
      },
    }
    if (parseJson) result.value = JSON.parse(source)
    return result
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${label} is invalid JSON`)
    throw error
  } finally { closeSync(descriptor) }
}
function sameReference(actual, expected, label) {
  for (const key of ['path', 'dev', 'ino', 'size', 'sha256']) {
    if (actual?.[key] !== expected?.[key]) fail(`${label} reference changed`)
  }
}
function run(command, args, label, options = {}) {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options,
    }).trim()
  } catch { fail(`${label} failed`) }
}
function gitFile(repository, commit, relativePath, expectedPath, mode) {
  safeDirectory(repository, 'source repository', null)
  if (!COMMIT.test(commit) || join(repository, relativePath) !== expectedPath) fail(`${relativePath} binding is invalid`)
  let layout
  try { layout = assertCleanGitSource(repository, commit) } catch { fail('source repository changed') }
  const loaded = stableFile(expectedPath, relativePath, mode, false)
  const treeMode = mode === 0o755 ? '100755' : '100644'
  let entry
  let tracked
  try {
    entry = getGitProductFileEntry(layout.gitRoot, commit, relativePath)
    tracked = readGitProductFile(layout.gitRoot, commit, relativePath)
  } catch { fail('source file failed') }
  if (entry.mode !== treeMode || sha256(tracked) !== sha256(loaded.source)) {
    fail(`${relativePath} differs from Git`)
  }
  return loaded.reference
}
function absent(pathname, label) {
  try { lstatSync(pathname); fail(`${label} still exists`) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}
function nonNegative(value) { return Number.isSafeInteger(value) && value >= 0 }
function fileIdentity(pathname, expected, label) {
  noSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== BigInt(process.getuid())
    || entry.dev.toString() !== expected?.dev || entry.ino.toString() !== expected?.ino
    || realpathSync(pathname) !== pathname) fail(`${label} identity changed`)
}
function processAbsent(pid, label) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail(`${label} PID is invalid`)
  try { process.kill(pid, 0); fail(`${label} process still exists`) } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
}
function processOwnsPath(pid, pathname, descriptor, label) {
  const args = ['-a', '-p', String(pid)]
  if (descriptor) args.push('-d', descriptor)
  args.push('-Fn')
  const paths = run('/usr/sbin/lsof', args, `${label} open path`).split('\n')
    .filter(line => line.startsWith('n')).map(line => line.slice(1))
  if (!paths.includes(pathname)) fail(`${label} does not own ${pathname}`)
}
function listenerPids(pid, port, label) {
  return run('/usr/sbin/lsof', [
    '-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-t',
  ], `${label} listener`).split('\n').filter(Boolean)
}

export function validateCommittedState({ plan, receipt, consumed, mapping, pending, baseline,
  routerState, binding, runtime, router, readiness, intake }) {
  const target = receipt.requestedTarget
  if (plan.schema !== PLAN_SCHEMA || receipt.schema !== RECEIPT_SCHEMA
    || consumed.schema !== CONSUMED_SCHEMA || mapping.schema !== MAPPING_SCHEMA
    || pending.schema !== 'video-autoworker-blue-green-bootstrap-pending/v4'
    || baseline.schema !== BASELINE_SCHEMA || routerState.schema !== 'video-autoworker-standalone-router/v1'
    || binding.schema !== 'video-autoworker-standalone-slot/v1'
    || runtime.schema !== 'video-autoworker-standalone-runtime/v1') fail('recovery schemas are invalid')
  if (receipt.control?.sourceCommit !== plan.control.commit
    || receipt.control?.repository !== plan.control.repository
    || receipt.historical?.sourceCommit !== plan.historical.commit
    || receipt.historical?.repository !== plan.historical.repository
    || receipt.historical?.bootstrapAttempt !== plan.historical.bootstrapAttempt
    || receipt.requestedTarget?.sourceCommit !== plan.target.releaseId.replace(/-runtime$/u, '')
    || target.releaseId !== plan.target.releaseId || target.releaseRoot !== plan.target.releaseRoot
    || consumed.authorizationId !== receipt.authorizationId
    || consumed.compatibilitySha256 !== receipt.compatibility?.compatibilitySha256) {
    fail('successor authorization identities differ')
  }
  if (mapping.authorization?.receipt?.path !== join(plan.successorAttempt, 'sdk-successor.receipt.json')
    || mapping.authorization?.consumed?.path !== join(plan.successorAttempt, 'sdk-successor.consumed.json')
    || mapping.requested?.releaseId !== target.releaseId || mapping.requested?.releaseRoot !== target.releaseRoot
    || mapping.requested?.manifestSha256 !== target.manifestSha256) fail('target mapping differs')
  if (baseline.baselineSlot !== plan.target.slot || baseline.baselineReleaseId !== target.releaseId
    || baseline.baselineReleaseRoot !== target.releaseRoot
    || baseline.baselineManifestSha256 !== target.manifestSha256
    || baseline.baselineSourceCommit !== target.sourceCommit
    || typeof pending.legacyReleaseId !== 'string' || !pending.legacyReleaseId
    || baseline.legacyReleaseId !== pending.legacyReleaseId
    || baseline.dbPath !== receipt.historical?.databases?.mission?.path
    || baseline.n8nDbPath !== receipt.historical?.databases?.n8n?.path
    || baseline.n8nWorkflowSourceCommit !== receipt.historical?.sourceCommit
    || baseline.routerStatePath !== plan.environment.routerState
    || baseline.routerPort !== 3017
    || !Number.isSafeInteger(baseline.n8nPid) || baseline.n8nPid < 1) fail('committed baseline differs')
  if (routerState.generation !== 1 || routerState.active !== plan.target.slot || routerState.previous !== null
    || routerState.slots?.[plan.target.slot]?.releaseId !== target.releaseId
    || binding.slot !== plan.target.slot || binding.releaseId !== target.releaseId
    || binding.releaseRoot !== target.releaseRoot || binding.manifestSha256 !== target.manifestSha256
    || runtime.slot !== plan.target.slot || runtime.role !== 'active' || runtime.releaseId !== target.releaseId
    || runtime.manifestSha256 !== target.manifestSha256
    || runtime.host !== routerState.slots[plan.target.slot].host
    || runtime.port !== routerState.slots[plan.target.slot].port
    || runtime.dbPath !== baseline.dbPath || runtime.routerStatePath !== plan.environment.routerState
    || !Number.isSafeInteger(runtime.pid) || runtime.pid < 1) {
    fail('active runtime binding differs')
  }
  const ready = readiness?.readiness
  if (router.schema !== 'video-autoworker-standalone-router-health/v1' || router.ok !== true
    || router.active !== plan.target.slot || router.releaseId !== target.releaseId || router.generation !== 1
    || !Number.isSafeInteger(router.pid) || router.pid < 1
    || ready?.schema !== 'video-autoworker-release-readiness/v1' || ready.globalScope !== true
    || ready.runtime?.callbackProtocol !== 'slot-v1'
    || ready.runtime?.runtimeSlot !== plan.target.slot || ready.runtime?.runtimeReleaseId !== target.releaseId
    || ready.runtime?.port !== runtime.port
    || ready.intake?.schema !== 'video-autoworker-intake-control/v1'
    || ready.intake.accepting !== false || ready.intake.mode !== 'paused'
    || !nonNegative(ready.intake.counts?.active) || ready.intake.counts.active !== 0
    || ready.projection?.schema !== 'video-autoworker-director-evidence-outbox-readiness/v1'
    || ready.projection.incompatiblePending !== 0
    || ready.scheduler?.routerGeneration !== 1
    || intake?.schema !== 'video-autoworker-intake-control/v1' || intake.globalScope !== true
    || intake.canManage !== true || intake.accepting !== false
    || intake.mode !== 'paused' || intake.revision !== ready.intake.revision || intake.counts?.active !== 0) {
    fail('paused runtime readiness differs')
  }
  return { pausedIntakeRevision: intake.revision, target }
}

function writeImmutable(pathname, value) {
  const source = Buffer.from(`${canonicalJson(value)}\n`)
  if (existsSync(pathname)) {
    const existing = stableFile(pathname, 'recovery completion', 0o400)
    if (existing.reference.sha256 !== sha256(source)) fail('recovery completion changed')
    return
  }
  const descriptor = openSync(pathname,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
  try { writeFileSync(descriptor, source); fsyncSync(descriptor); chmodSync(pathname, 0o400) } finally { closeSync(descriptor) }
  const parent = openSync(dirname(pathname), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
function writeOrValidateCompletion(pathname, value) {
  if (!existsSync(pathname)) {
    writeImmutable(pathname, value)
    return value
  }
  const existing = stableFile(pathname, 'recovery completion', 0o400).value
  const withoutTime = item => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'establishedAt'))
  if (!Number.isSafeInteger(existing.establishedAt) || existing.establishedAt < 1_000_000_000_000
    || existing.establishedAt > Date.now() + 5_000
    || canonicalJson(withoutTime(existing)) !== canonicalJson(withoutTime(value))) {
    fail('recovery completion changed')
  }
  return existing
}
function unlinkPending(pathname, expected) {
  const current = stableFile(pathname, 'bootstrap pending', 0o400)
  sameReference(current.reference, expected.reference, 'bootstrap pending')
  unlinkSync(pathname)
  const parent = openSync(dirname(pathname), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}
export function publishCompletionAndRemovePending({ completionPath, pendingPath, pendingLoaded, completion }) {
  writeOrValidateCompletion(completionPath, completion)
  if (existsSync(pendingPath)) unlinkPending(pendingPath, pendingLoaded)
  else stableFile(completionPath, 'recovery completion', 0o400)
}
async function getJson(url, label) {
  let response
  try { response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8_000) }) }
  catch { fail(`${label} is unavailable`) }
  if (!response.ok) fail(`${label} returned HTTP ${response.status}`)
  try { return await response.json() } catch { fail(`${label} returned invalid JSON`) }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const probe = {
    getJson: dependencies.getJson ?? getJson,
    processAbsent: dependencies.processAbsent ?? processAbsent,
    processOwnsPath: dependencies.processOwnsPath ?? processOwnsPath,
    listenerPids: dependencies.listenerPids ?? listenerPids,
    scriptPath: dependencies.scriptPath ?? scriptPath,
  }
  const mode = argv.shift()
  if (!['--verify-only', '--apply'].includes(mode) || argv.length !== 6
    || argv[0] !== '--plan' || argv[2] !== '--finisher-repository'
    || argv[4] !== '--finisher-commit') fail('arguments are invalid')
  const planPath = normalized(argv[1], 'successor plan')
  const finisherRepository = normalized(argv[3], 'finisher repository')
  const finisherCommit = argv[5]
  const finisher = gitFile(finisherRepository, finisherCommit,
    'ops/recovery/finalize-committed-bootstrap-successor.mjs', probe.scriptPath, 0o755)
  const plan = stableFile(planPath, 'successor plan').value
  safeDirectory(plan.successorAttempt, 'successor attempt')
  const control = plan.control.repository
  const runnerReference = gitFile(control, plan.control.commit,
    'ops/recovery/run-legacy-bootstrap-sdk-successor.mjs',
    join(control, 'ops/recovery/run-legacy-bootstrap-sdk-successor.mjs'), 0o755)
  const controllerReference = gitFile(control, plan.control.commit,
    'scripts/legacy-bootstrap-sdk-successor-controller.mjs',
    join(control, 'scripts/legacy-bootstrap-sdk-successor-controller.mjs'), 0o755)
  const receiptLoaded = stableFile(join(plan.successorAttempt, 'sdk-successor.receipt.json'), 'successor receipt', 0o400)
  const consumedLoaded = stableFile(join(plan.successorAttempt, 'sdk-successor.consumed.json'), 'successor consumed', 0o400)
  absent(join(plan.successorAttempt, 'sdk-successor.token.json'), 'successor token')
  const mappingLoaded = stableFile(join(plan.successorAttempt, 'target-mapping.json'), 'target mapping', 0o400)
  const pendingLoaded = stableFile(plan.historical.pending, 'bootstrap pending', 0o400)
  sameReference(pendingLoaded.reference, receiptLoaded.value.historical?.pending, 'authorized pending')
  sameReference(receiptLoaded.reference, consumedLoaded.value.receipt, 'consumed receipt')
  sameReference(controllerReference, receiptLoaded.value.control?.controller, 'authorized successor controller')
  if (runnerReference.path !== join(control, 'ops/recovery/run-legacy-bootstrap-sdk-successor.mjs')
    || receiptLoaded.value.uid !== process.getuid()
    || !Number.isSafeInteger(receiptLoaded.value.issuedAt)
    || !Number.isSafeInteger(receiptLoaded.value.expiresAt)
    || !SHA256.test(receiptLoaded.value.nonceSha256 || '')
    || !Number.isSafeInteger(consumedLoaded.value.consumedAt)
    || consumedLoaded.value.consumedAt < receiptLoaded.value.issuedAt
    || consumedLoaded.value.consumedAt >= receiptLoaded.value.expiresAt
    || !SHA256.test(consumedLoaded.value.tokenSha256 || '')
    || !SHA256.test(consumedLoaded.value.initialReadinessSha256 || '')) {
    fail('consumed successor capability is invalid')
  }
  for (const [relativePath, expected, mode] of [
    ['scripts/verify-openclaw-runtime-compatibility.mjs', receiptLoaded.value.control?.compatibilityValidator, 0o644],
    ['scripts/verify-director-video-release-readiness.mjs', receiptLoaded.value.control?.readinessValidator, 0o644],
    ['scripts/lib/openclaw-runtime-contract.mjs', receiptLoaded.value.control?.runtimeContract, 0o644],
  ]) {
    sameReference(gitFile(control, plan.control.commit, relativePath,
      join(control, relativePath), mode), expected, relativePath)
  }
  const historicalController = receiptLoaded.value.historical?.controller
  const historicalGuard = receiptLoaded.value.historical?.guardController
  sameReference(gitFile(plan.historical.repository, plan.historical.commit,
    'scripts/legacy-bootstrap-controller.mjs', historicalController?.path, 0o755),
  historicalController, 'historical controller')
  sameReference(gitFile(plan.historical.repository, plan.historical.commit,
    'scripts/legacy-freeze-guard.mjs', historicalGuard?.path, 0o644),
  historicalGuard, 'historical guard controller')
  sameReference(stableFile(receiptLoaded.value.historical.resume.path,
    'historical resume', 0o400).reference, receiptLoaded.value.historical.resume, 'historical resume')
  sameReference(stableFile(receiptLoaded.value.historical.resumeConsumed.path,
    'historical resume consumed', 0o400).reference,
  receiptLoaded.value.historical.resumeConsumed, 'historical resume consumed')
  const compatibilityLoaded = stableFile(join(plan.successorAttempt, 'openclaw-runtime-compatibility.json'),
    'runtime compatibility')
  sameReference(compatibilityLoaded.reference, receiptLoaded.value.compatibility?.reference,
    'runtime compatibility')
  if (compatibilityLoaded.value.compatibilitySha256
      !== receiptLoaded.value.compatibility?.compatibilitySha256
    || compatibilityLoaded.value.source?.commit !== plan.control.commit) {
    fail('runtime compatibility differs')
  }
  if (mappingLoaded.value.authorization?.receipt?.sha256 !== receiptLoaded.reference.sha256
    || mappingLoaded.value.authorization?.consumed?.sha256 !== consumedLoaded.reference.sha256) {
    fail('target mapping authorization digests differ')
  }
  const execveProofLoaded = stableFile(join(plan.successorAttempt, 'execve-adapter.json'), 'execve adapter proof')
  sameReference(execveProofLoaded.reference, receiptLoaded.value.execveAdapter?.reference, 'execve adapter proof')
  const adapter = gitFile(control, plan.control.commit, 'ops/recovery/install-blue-green-execve-adapter.mjs',
    join(control, 'ops/recovery/install-blue-green-execve-adapter.mjs'), 0o755)
  const currentAdapter = JSON.parse(run(process.execPath, [adapter.path, '--verify-installed',
    '--source-root', plan.historical.repository, '--expected-commit', plan.historical.commit,
    '--adapter-source-root', control, '--expected-adapter-commit', plan.control.commit,
    '--installation', plan.execve.installation, '--launch-agents-dir', plan.execve.launchAgentsDir,
  ], 'installed execve adapter'))
  if (canonicalJson(currentAdapter) !== canonicalJson(execveProofLoaded.value)) fail('installed execve adapter changed')
  const storedReadinessLoaded = stableFile(join(plan.successorAttempt, 'current-readiness.json'),
    'stored release readiness')
  const storedReadiness = storedReadinessLoaded.value
  if (storedReadiness.schema !== 'video-autoworker-director-video-preflight/v1'
    || storedReadiness.ok !== true || storedReadiness.phase !== 'pre-bootstrap'
    || storedReadinessLoaded.reference.sha256 !== consumedLoaded.value.initialReadinessSha256
    || storedReadiness.commit !== receiptLoaded.value.requestedTarget?.sourceCommit
    || storedReadiness.app?.releaseId !== plan.target.releaseId
    || storedReadiness.app?.root !== plan.target.releaseRoot
    || storedReadiness.app?.manifestSha256 !== receiptLoaded.value.requestedTarget?.manifestSha256) {
    fail('stored release readiness differs')
  }
  const baselineLoaded = stableFile(join(plan.environment.runDir, 'baseline.json'), 'committed baseline')
  const routerState = stableFile(plan.environment.routerState, 'router state').value
  const binding = stableFile(join(plan.environment.runDir, 'slots', `${plan.target.slot}.json`), 'slot binding').value
  const runtime = stableFile(join(plan.environment.runDir, 'slots', `${plan.target.slot}.runtime.json`), 'slot runtime').value
  const manifest = stableFile(join(plan.target.releaseRoot, 'release-manifest.json'), 'release manifest', 0o644)
  if (manifest.reference.sha256 !== receiptLoaded.value.requestedTarget?.manifestSha256) fail('release manifest changed')
  absent(plan.guard.socket, 'recovery guard socket')
  absent(join(dirname(plan.guard.socket), 'guard.token'), 'recovery guard token')
  probe.processAbsent(receiptLoaded.value.recoveryHold?.pid, 'released recovery guard')
  const router = await probe.getJson('http://127.0.0.1:3017/__router/health', 'router health')
  const port = routerState.slots?.[plan.target.slot]?.port
  if (!Number.isSafeInteger(port)) fail('active slot port is invalid')
  const readiness = await probe.getJson(
    `http://127.0.0.1:${port}/api/n8n/release-readiness`, 'release readiness',
  )
  const intakePayload = await probe.getJson(
    `http://127.0.0.1:${port}/api/n8n/intake-control`, 'intake status',
  )
  const validated = validateCommittedState({
    plan, receipt: receiptLoaded.value, consumed: consumedLoaded.value, mapping: mappingLoaded.value,
    pending: pendingLoaded.value, baseline: baselineLoaded.value, routerState, binding, runtime,
    router, readiness, intake: intakePayload.control,
  })
  fileIdentity(runtime.dbPath, receiptLoaded.value.historical.databases?.mission,
    'authoritative mission database')
  fileIdentity(baselineLoaded.value.n8nDbPath, receiptLoaded.value.historical.databases?.n8n,
    'authoritative n8n database')
  probe.processOwnsPath(runtime.pid, plan.target.releaseRoot, 'cwd', 'active slot')
  probe.processOwnsPath(runtime.pid, runtime.dbPath, null, 'active slot')
  probe.processOwnsPath(baselineLoaded.value.n8nPid, baselineLoaded.value.n8nDbPath, null, 'managed n8n')
  const routerListeners = probe.listenerPids(router.pid, 3017, 'router')
  const slotListeners = probe.listenerPids(runtime.pid, port, 'slot')
  if (routerListeners.length !== 1 || routerListeners[0] !== String(router.pid)
    || slotListeners.length !== 1 || slotListeners[0] !== String(runtime.pid)) {
    fail('managed listeners differ from runtime attestations')
  }
  const completionPath = join(plan.successorAttempt, 'recovery-completion.json')
  const completion = {
    schema: COMPLETION_SCHEMA, baselineEstablished: true, intakePaused: true,
    sourceCommit: validated.target.sourceCommit,
    historicalSourceCommit: plan.historical.commit,
    attempt: receiptLoaded.value.historical.attemptId,
    releaseId: validated.target.releaseId, releaseRoot: validated.target.releaseRoot,
    manifestSha256: validated.target.manifestSha256,
    pausedIntakeRevision: validated.pausedIntakeRevision, establishedAt: Date.now(),
    controlSourceCommit: plan.control.commit,
    successorReceipt: { path: receiptLoaded.reference.path, sha256: receiptLoaded.reference.sha256 },
    targetMapping: { path: mappingLoaded.reference.path, sha256: mappingLoaded.reference.sha256 },
  }
  if (mode === '--verify-only') {
    process.stdout.write(`${JSON.stringify({
      ok: true, mode: 'verify-only', finisherCommit, controlSourceCommit: plan.control.commit,
      releaseId: validated.target.releaseId, pausedIntakeRevision: validated.pausedIntakeRevision,
      pendingSha256: pendingLoaded.reference.sha256, baselineSha256: baselineLoaded.reference.sha256,
    })}\n`)
    return
  }
  publishCompletionAndRemovePending({
    completionPath, pendingPath: plan.historical.pending, pendingLoaded, completion,
  })
  process.stdout.write(`${JSON.stringify({
    ok: true, mode: 'finalize-committed-baseline', finisherCommit,
    finisherSha256: finisher.sha256, controlSourceCommit: plan.control.commit,
    releaseId: validated.target.releaseId, pausedIntakeRevision: validated.pausedIntakeRevision,
    completion: { path: completionPath, sha256: stableFile(completionPath, 'recovery completion', 0o400).reference.sha256 },
    pendingRemoved: true,
  })}\n`)
}

if (process.argv[1] && scriptPath === realpathSync(process.argv[1])) {
  try { await main() } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
