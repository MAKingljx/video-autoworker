#!/usr/bin/env node

import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  projectOfflineQueue,
  scanOfflineDurableBatchStates,
} from './lib/runtime-safe-offline-queue.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMMIT = /^[a-f0-9]{40}$/u
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const COMPONENTS = ['task-flow', 'video-command', 'director-brain']
const FINAL_GATE_SCHEMA = 'video-autoworker-shared-runtime-final-gate/v1'

function fail(message) {
  throw new Error(`shared_runtime_install_not_ready:${message}`)
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
function sha256(value) { return createHash('sha256').update(value).digest('hex') }

function parseArguments(argv) {
  let missionControlDbPath = ''
  let n8nDbPath = ''
  let deploymentRunDir = ''
  let legacyPreinstallAttemptDir = ''
  let videoBatchRoot = ''
  let expectedSourceCommit = ''
  let expectedReleaseId = ''
  let operation = 'install'
  let component = ''
  let rawResultOutput = ''
  let targetStateSha256 = ''
  let expectedFinalizeSha256 = ''
  let phase = 'component'
  let operationSeen = false
  let componentSeen = false
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--mission-control-db-path'
      && index + 1 < argv.length && !missionControlDbPath) {
      missionControlDbPath = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--n8n-db-path' && index + 1 < argv.length && !n8nDbPath) {
      n8nDbPath = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--deployment-run-dir'
      && index + 1 < argv.length && !deploymentRunDir) {
      deploymentRunDir = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--legacy-preinstall-attempt-dir'
      && index + 1 < argv.length && !legacyPreinstallAttemptDir) {
      legacyPreinstallAttemptDir = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--video-batch-root' && index + 1 < argv.length && !videoBatchRoot) {
      videoBatchRoot = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--expected-source-commit'
      && index + 1 < argv.length && !expectedSourceCommit) {
      expectedSourceCommit = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--expected-release-id'
      && index + 1 < argv.length && !expectedReleaseId) {
      expectedReleaseId = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--operation' && index + 1 < argv.length && !operationSeen) {
      operation = argv[index + 1]
      operationSeen = true
      index += 1
      continue
    }
    if (argv[index] === '--component' && index + 1 < argv.length && !componentSeen) {
      component = argv[index + 1]
      componentSeen = true
      index += 1
      continue
    }
    if (argv[index] === '--raw-result-output' && index + 1 < argv.length && !rawResultOutput) {
      rawResultOutput = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--target-state-sha256'
      && index + 1 < argv.length && !targetStateSha256) {
      targetStateSha256 = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--expected-finalize-sha256'
      && index + 1 < argv.length && !expectedFinalizeSha256) {
      expectedFinalizeSha256 = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--phase' && index + 1 < argv.length && phase === 'component') {
      phase = argv[index + 1]
      index += 1
      continue
    }
    fail('usage')
  }
  if (!missionControlDbPath || !n8nDbPath || !videoBatchRoot
    || !expectedSourceCommit || !expectedReleaseId) fail('usage')
  if (!['component', 'final'].includes(phase) || !['install', 'rollback'].includes(operation)
    || (componentSeen && !COMPONENTS.includes(component))
    || (targetStateSha256 && !SHA256.test(targetStateSha256))
    || (expectedFinalizeSha256 && (!SHA256.test(expectedFinalizeSha256) || phase !== 'final'))) {
    fail('operation_or_component_invalid')
  }
  return {
    missionControlDbPath,
    n8nDbPath,
    deploymentRunDir,
    legacyPreinstallAttemptDir,
    videoBatchRoot,
    expectedSourceCommit,
    expectedReleaseId,
    operation,
    component,
    rawResultOutput,
    targetStateSha256,
    expectedFinalizeSha256,
    phase,
  }
}

function safeOwnedDirectory(pathname, label, exactMode = null) {
  if (!validAbsolutePath(pathname)) fail(`${label}_path_invalid`)
  let entry
  let physical
  try {
    entry = lstatSync(pathname)
    physical = realpathSync.native(pathname)
  } catch {
    fail(`${label}_missing`)
  }
  const mode = entry.mode & 0o777
  if (!entry.isDirectory() || entry.isSymbolicLink() || physical !== pathname
    || entry.uid !== process.getuid() || (entry.mode & 0o022) !== 0
    || (exactMode !== null && mode !== exactMode)) fail(`${label}_unsafe`)
  return physical
}

function readOwnedText(pathname, label, maxBytes = 64 * 1024) {
  if (!validAbsolutePath(pathname)) fail(`${label}_path_invalid`)
  let before
  let opened
  let source
  let after
  let current
  let descriptor
  try {
    before = lstatSync(pathname, { bigint: true })
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.uid !== BigInt(process.getuid()) || (before.mode & 0o022n) !== 0n
      || before.size <= 0n || before.size > BigInt(maxBytes)
      || realpathSync.native(pathname) !== pathname) fail(`${label}_unsafe`)
    descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
    opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail(`${label}_changed`)
    }
    source = readFileSync(descriptor, 'utf8')
    after = fstatSync(descriptor, { bigint: true })
    current = lstatSync(pathname, { bigint: true })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('shared_runtime_install_not_ready:')) {
      throw error
    }
    fail(`${label}_unreadable`)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size
    || opened.mtimeNs !== after.mtimeNs || opened.ctimeNs !== after.ctimeNs
    || current.dev !== opened.dev || current.ino !== opened.ino || current.size !== opened.size
    || current.nlink !== 1n || realpathSync.native(pathname) !== pathname
    || Buffer.byteLength(source) !== Number(before.size)) fail(`${label}_changed`)
  return source
}

function readOwnedJson(pathname, label) {
  const source = readOwnedText(pathname, label)
  try { return JSON.parse(source) } catch { fail(`${label}_invalid`) }
}

function trustedLsof() {
  const pathname = '/usr/sbin/lsof'
  let entry
  try { entry = lstatSync(pathname) } catch { fail('lsof_missing') }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) !== 0) {
    fail('lsof_unsafe')
  }
  return pathname
}

function productionHomeFromRepository(root) {
  const match = /^\/Users\/([A-Za-z0-9._-]+)(?:\/|$)/u.exec(root)
  if (!match) fail('production_repository_home_invalid')
  let username
  try {
    username = execFileSync('/usr/bin/id', ['-un'], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 4096,
    }).trim()
  } catch { fail('production_user_unavailable') }
  if (username !== match[1]) fail('production_repository_user_mismatch')
  const home = `/Users/${username}`
  safeOwnedDirectory(home, 'production_home')
  return home
}

function defaultListenerPids(lsof, port) {
  let output = ''
  try {
    output = execFileSync(lsof, ['-nP', '-a', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
    })
  } catch (error) {
    if (error?.status !== 1) fail(`listener_${port}_query_failed`)
  }
  return [...new Set(output.split('\n').filter(line => /^p[1-9][0-9]*$/u.test(line))
    .map(line => Number(line.slice(1))))]
}

function defaultOpenFiles(lsof, pid, descriptor = '') {
  let output
  try {
    const args = ['-nP', '-a', '-p', String(pid)]
    if (descriptor) args.push('-d', descriptor)
    args.push('-FfDin')
    output = execFileSync(lsof, args, {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
    })
  } catch { fail(`process_${pid}_paths_unavailable`) }
  const records = []
  let current = null
  const publish = () => {
    if (current?.path && current.dev && current.ino) records.push(current)
  }
  for (const line of output.split('\n')) {
    if (line.startsWith('f')) {
      publish()
      current = { descriptor: line.slice(1), path: '', dev: '', ino: '' }
    } else if (current && line.startsWith('D')) {
      try { current.dev = BigInt(line.slice(1)).toString() } catch { current.dev = '' }
    } else if (current && line.startsWith('i') && /^[0-9]+$/u.test(line.slice(1))) {
      current.ino = BigInt(line.slice(1)).toString()
    } else if (current && line.startsWith('n')) current.path = line.slice(1)
  }
  publish()
  return records
}

function pathIdentity(pathname) {
  try {
    const physical = realpathSync.native(pathname)
    const entry = lstatSync(physical, { bigint: true })
    return { path: physical, dev: entry.dev.toString(), ino: entry.ino.toString() }
  } catch { return null }
}

function identitySetContains(entries, expected) {
  return entries.some(entry => entry?.dev === expected.dev && entry?.ino === expected.ino)
}

function defaultProcessAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function verifyStandaloneRelease(sourceRepositoryRoot, binding) {
  const auditor = join(sourceRepositoryRoot, 'scripts', 'check-standalone-artifact.mjs')
  const manifestPath = join(binding.releaseRoot, 'release-manifest.json')
  if (sha256(readOwnedText(manifestPath, 'rolling_release_manifest', 8 * 1024 * 1024))
    !== binding.manifestSha256) fail('rolling_release_manifest_mismatch')
  try {
    execFileSync(process.execPath, [auditor, binding.releaseRoot], {
      cwd: sourceRepositoryRoot,
      encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
    })
  } catch { fail('rolling_release_artifact_invalid') }
}

function validateRetirementProof({ deploymentRunDir, slot, state, binding, runtime, recordedPid,
  missionIdentity }) {
  const proof = readOwnedJson(join(deploymentRunDir, 'slots', `${slot}.retired.json`),
    `rolling_${slot}_retirement`)
  const freeze = readOwnedJson(join(deploymentRunDir, 'slots', `${slot}.callbacks-frozen.json`),
    `rolling_${slot}_callback_freeze`)
  const zeroFields = ['active', 'childExecutionLeases', 'untrackedCallbacks', 'otherReleaseActive',
    'routerActiveRequests', 'routerUpgradedSockets']
  const updatedAt = Math.floor(Date.parse(state.updatedAt) / 1_000)
  if (proof?.schema !== 'video-autoworker-retirement-proof/v2' || proof.slot !== slot
    || proof.releaseId !== binding.releaseId || proof.manifestSha256 !== binding.manifestSha256
    || proof.pid !== recordedPid || proof.pid !== runtime.pid || proof.dbPath !== missionIdentity.path
    || proof.routerStatePath !== join(deploymentRunDir, 'router-state.json')
    || proof.routerGeneration !== state.generation || proof.activeSlot !== state.active
    || !Number.isSafeInteger(proof.observedAt) || proof.observedAt < updatedAt
    || !proof.drain || zeroFields.some(field => proof.drain[field] !== 0)
    || proof.drain.schedulerState !== 'inactive'
    || proof.drain.schedulerRouterGeneration !== state.generation
    || !Number.isSafeInteger(proof.drain.quietSeconds)
    || !Number.isSafeInteger(proof.drain.requiredQuietSeconds)
    || proof.drain.quietSeconds < proof.drain.requiredQuietSeconds
    || !SHA256.test(proof.freeze?.quiesceId || '')
    || !Number.isSafeInteger(proof.freeze?.quiescedAt)
    || freeze?.schema !== 'video-autoworker-callback-freeze/v1'
    || freeze.slot !== slot || freeze.releaseId !== binding.releaseId
    || freeze.manifestSha256 !== binding.manifestSha256 || freeze.pid !== recordedPid
    || freeze.dbPath !== missionIdentity.path || freeze.routerStatePath !== proof.routerStatePath
    || freeze.routerGeneration !== state.generation || freeze.activeSlot !== state.active
    || freeze.freezeId !== proof.freeze.freezeId || freeze.frozenAt !== proof.freeze.frozenAt
    || freeze.quiesceId !== proof.freeze.quiesceId || freeze.quiescedAt !== proof.freeze.quiescedAt) {
    fail(`rolling_${slot}_retirement_invalid`)
  }
}

export function verifyRollingRuntimeBinding({
  deploymentRunDir,
  missionIdentity,
  n8nIdentity,
  videoBatchRoot,
  sourceRepositoryRoot = repositoryRoot,
}, dependencies = {}) {
  const expectedRunDir = join(sourceRepositoryRoot, '.run', 'blue-green')
  if (deploymentRunDir !== expectedRunDir) fail('rolling_run_directory_not_canonical')
  safeOwnedDirectory(sourceRepositoryRoot, 'rolling_repository')
  safeOwnedDirectory(deploymentRunDir, 'rolling_run_directory', 0o700)
  const canonicalHome = dependencies.canonicalHome
    ?? productionHomeFromRepository(sourceRepositoryRoot)
  const expectedBatchRoot = join(canonicalHome, 'ai-worker', 'state',
    'video-autoworker', 'video-batches')
  if (videoBatchRoot !== expectedBatchRoot) fail('rolling_batch_root_not_canonical')
  safeOwnedDirectory(videoBatchRoot, 'rolling_batch_root')

  const statePath = join(deploymentRunDir, 'router-state.json')
  const routerRuntimePath = join(deploymentRunDir, 'router.runtime.json')
  const state = readOwnedJson(statePath, 'rolling_router_state')
  const routerRuntime = readOwnedJson(routerRuntimePath, 'rolling_router_runtime')
  const stateKeys = ['active', 'generation', 'previous', 'schema', 'slots', 'updatedAt']
  if (state?.schema !== 'video-autoworker-standalone-router/v1'
    || canonicalJson(Object.keys(state).sort()) !== canonicalJson(stateKeys)
    || !['blue', 'green'].includes(state.active)
    || (state.previous !== null && !['blue', 'green'].includes(state.previous))
    || state.previous === state.active || !Number.isSafeInteger(state.generation)
    || state.generation < 1 || !Number.isFinite(Date.parse(state.updatedAt || ''))
    || canonicalJson(Object.keys(state.slots || {}).sort()) !== canonicalJson(['blue', 'green'])) {
    fail('rolling_router_state_invalid')
  }
  for (const [slot, port] of [['blue', 3317], ['green', 3417]]) {
    const value = state.slots[slot]
    if (!value || value.host !== '127.0.0.1' || value.port !== port
      || typeof value.releaseId !== 'string' || !RELEASE_ID.test(value.releaseId)) {
      fail(`rolling_${slot}_state_invalid`)
    }
  }
  if (routerRuntime?.schema !== 'video-autoworker-standalone-router-runtime/v1'
    || !Number.isSafeInteger(routerRuntime.pid) || routerRuntime.pid <= 0
    || routerRuntime.host !== '127.0.0.1' || routerRuntime.port !== 3017
    || routerRuntime.stateFile !== statePath || !Number.isSafeInteger(routerRuntime.startedAt)
    || routerRuntime.startedAt <= 0) fail('rolling_router_runtime_invalid')

  const lsof = dependencies.lsof ?? trustedLsof()
  const listenerPids = dependencies.listenerPids
    ?? (port => defaultListenerPids(lsof, port))
  const openPaths = dependencies.openPaths
  const openFiles = dependencies.openFiles ?? (openPaths
    ? ((pid, descriptor = '') => openPaths(pid, descriptor).map(pathIdentity).filter(Boolean))
    : ((pid, descriptor = '') => defaultOpenFiles(lsof, pid, descriptor)))
  const processAlive = dependencies.processAlive ?? defaultProcessAlive
  const verifyRelease = dependencies.verifyRelease ?? verifyStandaloneRelease
  const routerListeners = listenerPids(3017)
  if (canonicalJson(routerListeners) !== canonicalJson([routerRuntime.pid])) {
    fail('rolling_router_listener_mismatch')
  }
  const repositoryIdentity = pathIdentity(sourceRepositoryRoot)
  if (!processAlive(routerRuntime.pid) || !repositoryIdentity
    || !identitySetContains(openFiles(routerRuntime.pid, 'cwd'), repositoryIdentity)) {
    fail('rolling_router_repository_mismatch')
  }

  const runtimePids = {}
  for (const [slot, port] of [['blue', 3317], ['green', 3417]]) {
    const listeners = listenerPids(port)
    const shouldRun = slot === state.active
    const mayRun = shouldRun || slot === state.previous
    if ((shouldRun && listeners.length !== 1) || (!mayRun && listeners.length !== 0)
      || listeners.length > 1) fail(`rolling_${slot}_listener_mismatch`)
    const bindingPath = join(deploymentRunDir, 'slots', `${slot}.json`)
    const runtimePath = join(deploymentRunDir, 'slots', `${slot}.runtime.json`)
    const pidPath = join(deploymentRunDir, 'slots', `${slot}.pid`)
    const runtimeStatePresent = [bindingPath, runtimePath, pidPath].map(existsSync)
    if (!listeners.length && runtimeStatePresent.every(value => !value)) continue
    if (runtimeStatePresent.some(Boolean) && !runtimeStatePresent.every(Boolean)) {
      fail(`rolling_${slot}_runtime_state_partial`)
    }
    const binding = readOwnedJson(bindingPath, `rolling_${slot}_binding`)
    const runtime = readOwnedJson(runtimePath, `rolling_${slot}_runtime`)
    const recordedPid = Number(readOwnedText(pidPath, `rolling_${slot}_pid`, 128).trim())
    const expectedReleaseRoot = join(sourceRepositoryRoot, '.runtime', 'releases',
      binding?.releaseId || '', 'standalone')
    if (binding?.schema !== 'video-autoworker-standalone-slot/v1' || binding.slot !== slot
      || binding.releaseId !== state.slots[slot].releaseId
      || !validAbsolutePath(binding.releaseRoot) || binding.releaseRoot !== expectedReleaseRoot
      || !SHA256.test(binding.manifestSha256 || '')
      || binding.host !== '127.0.0.1' || binding.port !== port
      || runtime?.schema !== 'video-autoworker-standalone-runtime/v1'
      || (listeners.length === 1 && runtime.pid !== listeners[0])
      || runtime.pid !== recordedPid || runtime.slot !== slot
      || runtime.role !== 'active' || runtime.releaseId !== binding.releaseId
      || runtime.manifestSha256 !== binding.manifestSha256
      || runtime.host !== binding.host || runtime.port !== binding.port
      || runtime.dbPath !== missionIdentity.path || runtime.routerStatePath !== statePath) {
      fail(`rolling_${slot}_runtime_binding_mismatch`)
    }
    const releaseIdentity = pathIdentity(binding.releaseRoot)
    if (!releaseIdentity) fail(`rolling_${slot}_release_missing`)
    verifyRelease(sourceRepositoryRoot, binding)
    if (listeners.length === 0) {
      if (processAlive(recordedPid)) fail(`rolling_${slot}_process_still_alive`)
      if (slot !== state.previous) fail(`rolling_${slot}_unexpected_stopped_runtime`)
      validateRetirementProof({ deploymentRunDir, slot, state, binding, runtime, recordedPid,
        missionIdentity })
      continue
    }
    if (!processAlive(recordedPid)
      || !identitySetContains(openFiles(runtime.pid), missionIdentity)
      || !identitySetContains(openFiles(runtime.pid, 'cwd'), releaseIdentity)) {
      fail(`rolling_${slot}_process_binding_mismatch`)
    }
    runtimePids[slot] = runtime.pid
  }

  const n8nListeners = listenerPids(5678)
  if (n8nListeners.length !== 1
    || !processAlive(n8nListeners[0])
    || !identitySetContains(openFiles(n8nListeners[0]), n8nIdentity)) {
    fail('rolling_n8n_runtime_binding_mismatch')
  }
  return {
    schema: 'video-autoworker-rolling-runtime-binding/v1',
    runDirectory: deploymentRunDir,
    routerStatePath: statePath,
    activeSlot: state.active,
    previousSlot: state.previous,
    generation: state.generation,
    routerPid: routerRuntime.pid,
    slotPids: runtimePids,
    n8nPid: n8nListeners[0],
    mission: missionIdentity,
    n8n: n8nIdentity,
    videoBatchRoot,
  }
}

function physicalDatabase(pathname, label) {
  if (!isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label}_path_invalid`)
  let entry
  let physical
  try {
    entry = lstatSync(pathname)
    physical = realpathSync.native(pathname)
  } catch {
    fail(`${label}_missing`)
  }
  if (!entry.isFile() || entry.isSymbolicLink() || physical !== resolve(pathname)
    || entry.uid !== process.getuid() || entry.nlink !== 1 || (entry.mode & 0o0022) !== 0) {
    fail(`${label}_unsafe`)
  }
  return {
    path: physical,
    dev: BigInt(entry.dev).toString(),
    ino: BigInt(entry.ino).toString(),
  }
}

function validAbsolutePath(value) {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function validDatabaseIdentity(value) {
  return validAbsolutePath(value?.path) && /^[0-9]+$/u.test(value?.dev || '')
    && /^[0-9]+$/u.test(value?.ino || '')
}

function validFileReference(value) {
  return validDatabaseIdentity(value) && SHA256.test(value?.sha256 || '')
    && Number.isSafeInteger(value?.size) && value.size >= 0
}

function validDirectoryReference(value) {
  return validDatabaseIdentity(value)
}

function validateLegacyBindingContext(status, expectedSourceCommit, expectedReleaseId) {
  const bindings = status?.bindings
  const target = bindings?.target
  const guard = bindings?.guard
  const transition = bindings?.transition
  if (bindings?.sourceCommit !== expectedSourceCommit || target?.releaseId !== expectedReleaseId) {
    fail('legacy_preinstall_target_binding_mismatch')
  }
  if (!validFileReference(status?.prepared)
    || !['blue', 'green'].includes(target?.slot)
    || !validAbsolutePath(target?.releaseRoot)
    || !SHA256.test(target?.manifestSha256 || '')
    || !validFileReference(bindings?.evidence)
    || !validFileReference(bindings?.proof)
    || !validDatabaseIdentity(bindings?.databases?.mission)
    || !validDatabaseIdentity(bindings?.databases?.n8n)
    || !Number.isSafeInteger(bindings?.evidenceObservedAt)
    || !Number.isSafeInteger(guard?.expiresAt)
    || !SHA256.test(guard?.guardNonceSha256 || '')
    || !SHA256.test(guard?.legacyBindingSha256 || '')
    || !SHA256.test(guard?.sha256 || '')
    || !SHA256.test(bindings?.runtimeSnapshotSha256 || '')
    || !validFileReference(transition?.anchor)
    || !validFileReference(transition?.intent)
    || !validFileReference(transition?.confirmation)
    || !validDirectoryReference(transition?.journal)
    || !validFileReference(transition?.attestation)
    || typeof transition?.upgradeId !== 'string' || transition.upgradeId.length === 0
    || !SHA256.test(transition?.committedJournalHeadSha256 || '')
    || !SHA256.test(transition?.liveCombinedSha256 || '')) {
    fail('legacy_preinstall_identity_context_invalid')
  }
  return bindings
}

function componentState(status) {
  const installed = status?.components?.installed
  const rolledBack = status?.components?.rolledBack
  const cancelled = status?.components?.cancelled ?? []
  if (!Array.isArray(installed) || !Array.isArray(rolledBack)
    || !Array.isArray(cancelled)
    || cancelled.some(value => !value || !COMPONENTS.includes(value.component)
      || !['install', 'rollback'].includes(value.operation) || !SHA256.test(value.reservationSha256 || ''))
    || installed.length > COMPONENTS.length
    || canonicalJson(installed) !== canonicalJson(COMPONENTS.slice(0, installed.length))
    || rolledBack.length > installed.length
    || canonicalJson(rolledBack)
      !== canonicalJson(installed.slice(installed.length - rolledBack.length).reverse())
    || ((installed.length + rolledBack.length + cancelled.length > 0)
      && !validFileReference(status?.components?.journalHead))
    || ((installed.length + rolledBack.length + cancelled.length === 0)
      && status?.components?.journalHead !== null)) {
    fail('legacy_preinstall_component_journal_invalid')
  }
  return { installed, rolledBack, cancelled }
}

function statusIdentity(status) {
  return canonicalJson({
    phase: status.phase,
    installAttemptId: status.installAttemptId,
    revision: status.revision,
    prepared: status.prepared,
    verification: status.verification,
    terminal: status.terminal,
    finalize: status.finalize,
    components: status.components,
    bindings: status.bindings,
  })
}

function legacyPreinstallReserve(
  attemptDirectory, authorization, rawResultOutput, targetStateSha256, snapshot,
) {
  if (!validAbsolutePath(rawResultOutput)) fail('raw_result_output_invalid')
  if (!SHA256.test(targetStateSha256 || '')) fail('target_state_sha256_invalid')
  const controller = join(repositoryRoot, 'scripts/legacy-preinstall-controller.mjs')
  const productionEnvironment = { ...process.env, NODE_ENV: 'production' }
  for (const name of Object.keys(productionEnvironment)) {
    if (name.startsWith('AIWORKER_TEST_')) delete productionEnvironment[name]
  }
  const activity = {
    mission: authorization.bindings.databases.mission,
    n8n: authorization.bindings.databases.n8n,
    activeTasks: snapshot.queue.waiting + snapshot.queue.running,
    activeMediaNodes: snapshot.mediaActive,
    activeN8nExecutions: snapshot.n8nActive,
    waiting: snapshot.queue.waiting,
    running: snapshot.queue.running,
    attentionStale: snapshot.queue.attentionStale,
    pendingOutbox: 0,
  }
  const statusIdentitySha256 = authorization.reservation?.statusIdentitySha256
    ?? sha256(authorization.identity)
  const installerPid = process.ppid
  let installerStartToken = ''
  try {
    installerStartToken = execFileSync('/bin/ps', ['-p', String(installerPid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 5_000, maxBuffer: 4096,
    }).trim()
  } catch { fail('legacy_preinstall_installer_owner_unavailable') }
  if (installerStartToken.length < 8 || installerStartToken.length > 128) {
    fail('legacy_preinstall_installer_owner_invalid')
  }
  let result
  try {
    result = JSON.parse(execFileSync(process.execPath, [controller,
      'reserve-component', '--attempt-dir', attemptDirectory,
      '--install-attempt-id', authorization.installAttemptId,
      '--expected-revision', String(authorization.revision),
      '--operation', authorization.operation,
      '--component', authorization.component,
      '--raw-result-output', rawResultOutput,
      '--target-state-sha256', targetStateSha256,
      '--installer-pid', String(installerPid), '--installer-start-token', installerStartToken,
      '--status-identity-sha256', statusIdentitySha256,
      '--active-tasks', String(activity.activeTasks),
      '--active-media-nodes', String(activity.activeMediaNodes),
      '--active-n8n-executions', String(activity.activeN8nExecutions),
      '--waiting', String(activity.waiting), '--running', String(activity.running),
      '--attention-stale', String(activity.attentionStale),
      '--pending-outbox', '0', '--snapshot-sha256', sha256(canonicalJson(activity)),
    ], {
      encoding: 'utf8', env: productionEnvironment, maxBuffer: 1024 * 1024, timeout: 30_000,
    }))
  } catch {
    fail('legacy_preinstall_reservation_failed')
  }
  if (result?.phase !== 'COMPONENT_RESERVED' || !validFileReference(result.reservation)) {
    fail('legacy_preinstall_reservation_invalid')
  }
  return result.reservation
}

export function validateLegacyPreinstallStatus(
  status,
  expectedSourceCommit,
  expectedReleaseId,
  operation = 'install',
  requestedComponent = '',
) {
  if (!COMMIT.test(expectedSourceCommit)
    || !RELEASE_ID.test(expectedReleaseId)
    || expectedReleaseId !== `${expectedSourceCommit}-runtime`) {
    fail('expected_release_binding_invalid')
  }
  if (!['install', 'rollback'].includes(operation)
    || (requestedComponent && !COMPONENTS.includes(requestedComponent))) {
    fail('operation_or_component_invalid')
  }
  if (!UUID.test(status?.installAttemptId || '')
    || !Number.isSafeInteger(status?.revision) || status.revision < 1
    || typeof status?.expired !== 'boolean'
    || status?.terminal !== null) {
    fail('legacy_preinstall_attempt_not_authorizable')
  }
  const bindings = validateLegacyBindingContext(status, expectedSourceCommit, expectedReleaseId)
  const { installed, rolledBack } = componentState(status)
  const reservation = status.reservation ?? null
  if (reservation !== null && (!validFileReference(reservation?.reference)
    || !COMPONENTS.includes(reservation?.component)
    || !['install', 'rollback'].includes(reservation?.operation)
    || !validAbsolutePath(reservation?.rawResultPath)
    || !SHA256.test(reservation?.statusIdentitySha256 || ''))) {
    fail('legacy_preinstall_reservation_invalid')
  }
  let expectedComponent
  if (operation === 'install') {
    if (status.phase !== 'INSTALL_PREPARED' || (status.expired !== false && reservation === null)
      || status.verification !== null || status.finalize !== null || rolledBack.length !== 0) {
      fail('legacy_preinstall_lease_not_current')
    }
    expectedComponent = COMPONENTS[installed.length]
  } else {
    const preparedCompensation = status.phase === 'INSTALL_PREPARED'
      && status.verification === null && status.finalize === null
      && installed.length > 0 && rolledBack.length === 0
    const rollbackPhaseAllowed = preparedCompensation
      || ['INSTALL_VERIFIED', 'INSTALL_ROLLBACK_PENDING'].includes(status.phase)
    if (!rollbackPhaseAllowed
      || (status.verification !== null && !validFileReference(status.verification))
      || (status.phase === 'INSTALL_VERIFIED'
        && (!validFileReference(status.verification) || status.finalize !== null
          || installed.length !== COMPONENTS.length || rolledBack.length !== 0))
      || (status.phase === 'INSTALL_ROLLBACK_PENDING'
        && !validFileReference(status.finalize))) {
      fail('legacy_preinstall_rollback_not_authorized')
    }
    const pending = installed.filter(name => !rolledBack.includes(name))
    expectedComponent = pending.at(-1)
  }
  if (!expectedComponent || (requestedComponent && requestedComponent !== expectedComponent)) {
    fail('legacy_preinstall_component_order_invalid')
  }
  if (reservation && (reservation.component !== expectedComponent
    || reservation.operation !== operation)) {
    fail('legacy_preinstall_component_reserved_elsewhere')
  }
  return {
    bindings,
    installAttemptId: status.installAttemptId,
    revision: status.revision,
    operation,
    component: expectedComponent,
    identity: statusIdentity(status),
    reservation,
  }
}

export function validateLegacyPreinstallFinalStatus(
  status, expectedSourceCommit, expectedReleaseId, expectedFinalizeSha256 = '',
) {
  if (!UUID.test(status?.installAttemptId || '') || !Number.isSafeInteger(status?.revision)
    || status.revision < 1
    || !['INSTALL_VERIFIED', 'BOOTSTRAP_HANDOFF_FINALIZING'].includes(status.phase)
    || (!expectedFinalizeSha256 && status.expired !== false)
    || status.terminal !== null || status.reservation !== null
    || !validFileReference(status.verification)) {
    fail('legacy_preinstall_final_status_not_authorizable')
  }
  if (expectedFinalizeSha256) {
    if (!SHA256.test(expectedFinalizeSha256) || !validFileReference(status.finalize)
      || status.finalize.sha256 !== expectedFinalizeSha256) {
      fail('legacy_preinstall_finalize_recovery_mismatch')
    }
  } else if (status.finalize !== null) {
    fail('legacy_preinstall_final_status_not_authorizable')
  }
  const bindings = validateLegacyBindingContext(status, expectedSourceCommit, expectedReleaseId)
  const { installed, rolledBack } = componentState(status)
  if (canonicalJson(installed) !== canonicalJson(COMPONENTS) || rolledBack.length !== 0) {
    fail('legacy_preinstall_final_components_invalid')
  }
  return {
    bindings,
    installAttemptId: status.installAttemptId,
    revision: status.revision,
    identity: statusIdentity(status),
    finalize: status.finalize,
  }
}

function legacyPreinstallGate(
  attemptDirectory,
  _expectedSourceCommit,
  _expectedReleaseId,
  operation = 'install',
) {
  if (!isAbsolute(attemptDirectory) || resolve(attemptDirectory) !== attemptDirectory) {
    fail('legacy_preinstall_attempt_path_invalid')
  }
  const controller = join(repositoryRoot, 'scripts/legacy-preinstall-controller.mjs')
  const productionEnvironment = { ...process.env, NODE_ENV: 'production' }
  for (const name of Object.keys(productionEnvironment)) {
    if (name.startsWith('AIWORKER_TEST_')) delete productionEnvironment[name]
  }
  let status
  try {
    const args = operation === 'rollback'
      ? [
          '--input-type=module', '--eval',
          `const { inspectPreinstallAttempt } = await import(${JSON.stringify(pathToFileURL(controller).href)});`
            + `process.stdout.write(JSON.stringify(inspectPreinstallAttempt(${JSON.stringify(attemptDirectory)}, { verifyLive: false })))`,
        ]
      : [controller, 'status', '--attempt-dir', attemptDirectory]
    const source = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      env: productionEnvironment,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    })
    status = JSON.parse(source)
  } catch {
    fail('legacy_preinstall_attempt_invalid')
  }
  return status
}

function tableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name))
}

function requireTableColumns(database, table, required) {
  if (!tableExists(database, table)) fail(`${table}_missing`)
  const columns = new Set(database.pragma(`table_info(${table})`).map(row => row.name))
  if (required.some(column => !columns.has(column))) fail(`${table}_schema_invalid`)
}

function formalQueueProjection(database, batchRoot) {
  if (!isAbsolute(batchRoot) || resolve(batchRoot) !== batchRoot) {
    fail('video_batch_root_invalid')
  }
  let durable
  try {
    durable = scanOfflineDurableBatchStates(batchRoot)
  } catch {
    fail('video_batch_root_unsafe')
  }
  const rows = database.prepare(`
    SELECT task_id AS taskId, status, updated_at AS updatedAt
    FROM n8n_task_runs
    WHERE status IN (
      'queued', 'accepted', 'running', 'staging', 'submitted', 'waiting', 'recovering', 'paused'
    )
    ORDER BY created_at, id
  `).all()
  const projection = projectOfflineQueue(rows, durable, Math.floor(Date.now() / 1_000))
  return {
    ...projection,
    attentionStale: projection.values.filter(item => item.origin === 'attention-stale').length,
  }
}

function readLegacyIdleSnapshot(Database, missionIdentity, n8nIdentity, videoBatchRoot) {
  const currentMissionIdentity = physicalDatabase(missionIdentity.path, 'mission_control_database')
  const currentN8nIdentity = physicalDatabase(n8nIdentity.path, 'n8n_database')
  if (canonicalJson(currentMissionIdentity) !== canonicalJson(missionIdentity)) {
    fail('legacy_preinstall_mission_database_mismatch')
  }
  if (canonicalJson(currentN8nIdentity) !== canonicalJson(n8nIdentity)) {
    fail('legacy_preinstall_n8n_database_mismatch')
  }
  let mission
  let n8n
  try {
    mission = new Database(missionIdentity.path, { readonly: true, fileMustExist: true })
    n8n = new Database(n8nIdentity.path, { readonly: true, fileMustExist: true })
    mission.pragma('query_only = ON')
    n8n.pragma('query_only = ON')
    if (mission.pragma('quick_check', { simple: true }) !== 'ok') {
      fail('mission_control_database_integrity_failed')
    }
    if (n8n.pragma('quick_check', { simple: true }) !== 'ok') {
      fail('n8n_database_integrity_failed')
    }
    mission.exec('BEGIN')
    n8n.exec('BEGIN')
    requireTableColumns(mission, 'n8n_task_runs', [
      'task_id', 'source', 'status', 'created_at', 'updated_at',
    ])
    requireTableColumns(n8n, 'execution_entity', ['status', 'stoppedAt'])
    if (tableExists(mission, 'n8n_intake_controls')
      || tableExists(mission, 'n8n_director_evidence_outbox')) {
      fail('legacy_preinstall_schema_changed')
    }
    const queue = formalQueueProjection(mission, videoBatchRoot)
    const mediaActive = Number(mission.prepare(`
      SELECT COUNT(*) AS count
      FROM n8n_task_runs
      WHERE source = 'n8n-media-node'
        AND status IN ('queued', 'accepted', 'running')
    `).get()?.count)
    const n8nActive = Number(n8n.prepare(`
      SELECT COUNT(*) AS count
      FROM execution_entity
      WHERE status IN ('new', 'running', 'waiting') AND "stoppedAt" IS NULL
    `).get()?.count)
    n8n.exec('COMMIT')
    mission.exec('COMMIT')
    if (!Number.isSafeInteger(mediaActive) || mediaActive !== 0) {
      fail('active_media_nodes_present')
    }
    if (!Number.isSafeInteger(n8nActive) || n8nActive !== 0) {
      fail('active_n8n_executions_present')
    }
    if (queue.waiting !== 0 || queue.running !== 0) fail('active_tasks_present')
    return { queue, mediaActive, n8nActive }
  } catch (error) {
    try { n8n?.exec('ROLLBACK') } catch { /* no active read transaction */ }
    try { mission?.exec('ROLLBACK') } catch { /* no active read transaction */ }
    if (error instanceof Error && error.message.startsWith('shared_runtime_install_not_ready:')) {
      throw error
    }
    fail('live_database_query_failed')
  } finally {
    try { n8n?.close() } catch { /* the failed process remains closed to installation */ }
    try { mission?.close() } catch { /* the failed process remains closed to installation */ }
  }
}

export function verifySharedRuntimeInstallGate(
  {
    missionControlDbPath,
    n8nDbPath,
    deploymentRunDir = '',
    legacyPreinstallAttemptDir = '',
    videoBatchRoot,
    expectedSourceCommit,
    expectedReleaseId,
    operation = 'install',
    component = '',
    rawResultOutput = '',
    targetStateSha256 = '',
    expectedFinalizeSha256 = '',
    phase = 'component',
  },
  dependencies = {},
) {
  if (!COMMIT.test(expectedSourceCommit)
    || !RELEASE_ID.test(expectedReleaseId)
    || expectedReleaseId !== `${expectedSourceCommit}-runtime`) {
    fail('expected_release_binding_invalid')
  }
  if (!['component', 'final'].includes(phase)
    || !['install', 'rollback'].includes(operation) || (component && !COMPONENTS.includes(component))
    || (targetStateSha256 && !SHA256.test(targetStateSha256))
    || (expectedFinalizeSha256 && (!SHA256.test(expectedFinalizeSha256) || phase !== 'final'))) {
    fail('operation_or_component_invalid')
  }
  const verifyLegacyPreinstall = dependencies.verifyLegacyPreinstall ?? legacyPreinstallGate
  const reserveLegacyPreinstall = dependencies.reserveLegacyPreinstall ?? legacyPreinstallReserve
  const missionIdentity = physicalDatabase(missionControlDbPath, 'mission_control_database')
  const n8nIdentity = physicalDatabase(n8nDbPath, 'n8n_database')
  let Database
  try {
    Database = createRequire(join(repositoryRoot, 'package.json'))('better-sqlite3')
  } catch {
    fail('sqlite_runtime_unavailable')
  }

  let mission
  let n8n
  try {
    mission = new Database(missionIdentity.path, { readonly: true, fileMustExist: true })
    n8n = new Database(n8nIdentity.path, { readonly: true, fileMustExist: true })
    mission.pragma('query_only = ON')
    n8n.pragma('query_only = ON')
    if (mission.pragma('quick_check', { simple: true }) !== 'ok') {
      fail('mission_control_database_integrity_failed')
    }
    if (n8n.pragma('quick_check', { simple: true }) !== 'ok') {
      fail('n8n_database_integrity_failed')
    }

    mission.exec('BEGIN')
    n8n.exec('BEGIN')
    requireTableColumns(mission, 'n8n_task_runs', [
      'task_id', 'source', 'status', 'created_at', 'updated_at',
    ])
    requireTableColumns(n8n, 'execution_entity', ['status', 'stoppedAt'])
    const hasIntake = tableExists(mission, 'n8n_intake_controls')
    const hasOutbox = tableExists(mission, 'n8n_director_evidence_outbox')
    const queue = formalQueueProjection(mission, videoBatchRoot)
    const mediaActive = Number(mission.prepare(`
      SELECT COUNT(*) AS count
      FROM n8n_task_runs
      WHERE source = 'n8n-media-node'
        AND status IN ('queued', 'accepted', 'running')
    `).get()?.count)
    const n8nActive = Number(n8n.prepare(`
      SELECT COUNT(*) AS count
      FROM execution_entity
      WHERE status IN ('new', 'running', 'waiting') AND "stoppedAt" IS NULL
    `).get()?.count)
    if (!Number.isSafeInteger(mediaActive) || mediaActive !== 0) fail('active_media_nodes_present')
    if (!Number.isSafeInteger(n8nActive) || n8nActive !== 0) fail('active_n8n_executions_present')
    if (queue.waiting !== 0 || queue.running !== 0) fail('active_tasks_present')
    if (!hasIntake || !hasOutbox) {
      if (hasIntake !== hasOutbox) fail('rolling_schema_partial')
      if (!legacyPreinstallAttemptDir) fail('legacy_preinstall_attempt_required')
      if (!isAbsolute(legacyPreinstallAttemptDir)
        || resolve(legacyPreinstallAttemptDir) !== legacyPreinstallAttemptDir) {
        fail('legacy_preinstall_attempt_path_invalid')
      }
      n8n.exec('COMMIT')
      mission.exec('COMMIT')
      n8n.close()
      mission.close()
      n8n = undefined
      mission = undefined
      const firstStatus = verifyLegacyPreinstall(
        legacyPreinstallAttemptDir,
        expectedSourceCommit,
        expectedReleaseId,
        operation,
      )
      const firstAuthorization = phase === 'final'
        ? validateLegacyPreinstallFinalStatus(
          firstStatus, expectedSourceCommit, expectedReleaseId, expectedFinalizeSha256,
        )
        : validateLegacyPreinstallStatus(
          firstStatus, expectedSourceCommit, expectedReleaseId, operation, component,
        )
      const bindings = firstAuthorization.bindings
      if (bindings?.databases?.mission?.path !== missionIdentity.path
        || bindings?.databases?.mission?.dev !== missionIdentity.dev
        || bindings?.databases?.mission?.ino !== missionIdentity.ino) {
        fail('legacy_preinstall_mission_database_mismatch')
      }
      if (bindings?.databases?.n8n?.path !== n8nIdentity.path
        || bindings?.databases?.n8n?.dev !== n8nIdentity.dev
        || bindings?.databases?.n8n?.ino !== n8nIdentity.ino) {
        fail('legacy_preinstall_n8n_database_mismatch')
      }
      readLegacyIdleSnapshot(
        Database, missionIdentity, n8nIdentity, videoBatchRoot,
      )
      const secondStatus = verifyLegacyPreinstall(
        legacyPreinstallAttemptDir,
        expectedSourceCommit,
        expectedReleaseId,
        operation,
      )
      const secondAuthorization = phase === 'final'
        ? validateLegacyPreinstallFinalStatus(
          secondStatus, expectedSourceCommit, expectedReleaseId, expectedFinalizeSha256,
        )
        : validateLegacyPreinstallStatus(
          secondStatus, expectedSourceCommit, expectedReleaseId,
          operation, firstAuthorization.component,
        )
      if (secondAuthorization.identity !== firstAuthorization.identity
        || secondAuthorization.component !== firstAuthorization.component) {
        fail('legacy_preinstall_status_changed')
      }
      const current = readLegacyIdleSnapshot(
        Database, missionIdentity, n8nIdentity, videoBatchRoot,
      )
      if (phase === 'final') {
        const activity = {
          mission: missionIdentity,
          n8n: n8nIdentity,
          activeTasks: current.queue.waiting + current.queue.running,
          activeMediaNodes: current.mediaActive,
          activeN8nExecutions: current.n8nActive,
          waiting: current.queue.waiting,
          running: current.queue.running,
          attentionStale: current.queue.attentionStale,
          pendingOutbox: 0,
        }
        return {
          schema: FINAL_GATE_SCHEMA,
          mode: 'legacy-preinstall',
          installAttemptId: secondAuthorization.installAttemptId,
          revision: secondAuthorization.revision,
          sourceCommit: bindings.sourceCommit,
          targetReleaseId: bindings.target.releaseId,
          observedAt: Math.floor(Date.now() / 1_000),
          statusIdentitySha256: sha256(secondAuthorization.identity),
          finalize: secondAuthorization.finalize,
          activity: { ...activity, snapshotSha256: sha256(canonicalJson(activity)) },
        }
      }
      if (!rawResultOutput) fail('raw_result_output_required')
      const reservation = reserveLegacyPreinstall(
        legacyPreinstallAttemptDir, secondAuthorization, rawResultOutput, targetStateSha256, current,
      )
      return {
        schema: 'video-autoworker-shared-runtime-install-gate/v1',
        mode: 'legacy-preinstall',
        sourceCommit: bindings.sourceCommit,
        targetReleaseId: bindings.target.releaseId,
        intakeRevision: null,
        activeTasks: current.queue.waiting + current.queue.running,
        activeMediaNodes: current.mediaActive,
        activeN8nExecutions: current.n8nActive,
        waiting: current.queue.waiting,
        running: current.queue.running,
        attentionStale: current.queue.attentionStale,
        pendingOutbox: 0,
        reservation,
      }
    }

    const intake = mission.prepare(`
      SELECT accepting, revision
      FROM n8n_intake_controls
      WHERE control_id = 1
    `).get()
    const outbox = mission.prepare(`
      SELECT COUNT(*) AS count
      FROM n8n_director_evidence_outbox
      WHERE status = 'pending'
    `).get()
    n8n.exec('COMMIT')
    mission.exec('COMMIT')

    const revision = Number(intake?.revision)
    const activeTasks = queue.waiting + queue.running
    const pendingOutbox = Number(outbox?.count)
    if (intake?.accepting !== 0 || !Number.isSafeInteger(revision) || revision < 1) {
      fail('intake_not_paused')
    }
    if (!Number.isSafeInteger(activeTasks) || activeTasks !== 0) fail('active_tasks_present')
    if (!Number.isSafeInteger(pendingOutbox) || pendingOutbox !== 0) {
      fail('director_outbox_pending')
    }
    const runtimeBinding = deploymentRunDir
      ? (dependencies.verifyRollingRuntimeBinding ?? verifyRollingRuntimeBinding)({
          deploymentRunDir,
          missionIdentity,
          n8nIdentity,
          videoBatchRoot,
        })
      : null
    return {
      schema: 'video-autoworker-shared-runtime-install-gate/v1',
      mode: 'rolling',
      sourceCommit: expectedSourceCommit,
      targetReleaseId: expectedReleaseId,
      intakeRevision: revision,
      activeTasks,
      activeMediaNodes: mediaActive,
      activeN8nExecutions: n8nActive,
      waiting: queue.waiting,
      running: queue.running,
      attentionStale: queue.attentionStale,
      pendingOutbox,
      ...(runtimeBinding ? { runtimeBinding } : {}),
    }
  } catch (error) {
    try { n8n?.exec('ROLLBACK') } catch { /* no active read transaction */ }
    try { mission?.exec('ROLLBACK') } catch { /* no active read transaction */ }
    if (error instanceof Error && error.message.startsWith('shared_runtime_install_not_ready:')) {
      throw error
    }
    fail('live_database_query_failed')
  } finally {
    try { n8n?.close() } catch { /* the failed process remains closed to installation */ }
    try { mission?.close() } catch { /* the failed process remains closed to installation */ }
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    const result = verifySharedRuntimeInstallGate(parseArguments(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
