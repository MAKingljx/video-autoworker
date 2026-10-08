import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { auditStandaloneArtifact, verifyStandaloneVerificationBundle } from '../check-standalone-artifact.mjs'
import { acquireSharedDeploymentLockSync, assertSharedDeploymentLockAvailableSync } from './shared-deployment-lock.mjs'
import { artifactMetadataDigest, readCurrentRuntimeReceipt, readRuntimeFile, runtimeDigest, safeRuntimeEntry, validateRuntimeReceipt } from './runtime-receipt.mjs'
import { createReleaseOperationScope, readReleaseOperationJournal, releaseOperationPaths,
  releaseOperationStatus, RELEASE_OPERATION_OWNER_SCHEMA, RELEASE_OPERATION_CANCEL_SCHEMA } from './release-operation.mjs'

const SCHEMA = 'video-autoworker-runtime-retention-plan/v1'
const RELEASE = /^[a-f0-9]{40}-runtime$/u
const SHA = /^[a-f0-9]{64}$/u
const identity = entry => ({ dev: String(entry.dev), ino: String(entry.ino), mode: entry.mode & 0o777, uid: entry.uid })

/** Read process file references without inspecting command lines or credentials. */
export function readProcessReleaseReferences(releasesDir) {
  const source = execFileSync('/usr/sbin/lsof', ['-nP', '-u', String(process.getuid()), '-F', 'n'],
    { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  return source.split('\n').filter(line => line.startsWith(`n${releasesDir}/`)).map(line => line.slice(1))
}

function readPendingOperationReferences(operationsRoot, runDir, releasesDir) {
  const references = [], blockers = []; let visited = 0, inspectedPath = operationsRoot || null
  const operations = new Map(), attemptPattern = /^[a-f0-9-]{36}$/u
  const readOperation = pathname => {
    if (operations.has(pathname)) return operations.get(pathname)
    if (!existsSync(pathname)) throw new Error('retention_operation_sidecar_orphan')
    const plan = JSON.parse(readRuntimeFile(pathname, 4 * 1024 * 1024))
    if (plan.schema !== 'video-autoworker-release-impact-plan/v2') throw new Error('retention_operation_plan_unknown')
    const scope = createReleaseOperationScope(plan), paths = releaseOperationPaths(pathname, runDir)
    const events = readReleaseOperationJournal(paths.journal, scope.operationId)
    const state = releaseOperationStatus(scope, events)
    if (state.state !== 'completed') {
      if (plan.artifactRoot) references.push(plan.artifactRoot)
      if (plan.router?.releaseId) references.push(join(releasesDir, plan.router.releaseId))
    }
    const operation = { scope, paths, events, state }
    operations.set(pathname, operation)
    return operation
  }
  const readSidecar = pathname => {
    if (!existsSync(pathname)) throw new Error('retention_operation_sidecar_orphan')
    if ((safeRuntimeEntry(pathname).mode & 0o777) !== 0o600) throw new Error('retention_operation_sidecar_unsafe')
    return JSON.parse(readRuntimeFile(pathname, 128 * 1024))
  }
  const verifyOwner = (value, operation) => {
    if (value?.schema !== RELEASE_OPERATION_OWNER_SCHEMA || value.operationId !== operation.scope.operationId
      || !attemptPattern.test(value.attemptId || '') || !['running', 'completed', 'failed', 'cancelled'].includes(value.status)
      || (operation.state.attemptId && value.attemptId !== operation.state.attemptId)
      || (value.status === 'running' ? !Number.isSafeInteger(value.pid) || value.pid <= 0
        || typeof value.startToken !== 'string' || !value.startToken : value.pid !== null || value.startToken !== null)) {
      throw new Error('retention_operation_sidecar_binding_invalid')
    }
    return value
  }
  const classifySidecar = (directory, name, pathname) => {
    const ownerOrCancel = /^\.(.+\.json)\.release-operation\.(owner|cancel)\.json$/u.exec(name)
    const proof = /^\.(.+\.json)\.(runtime-proof(?:-override)?)\.([a-f0-9-]{36})\.json$/u.exec(name)
    if (!ownerOrCancel && !proof) return false
    const operation = readOperation(join(directory, (ownerOrCancel || proof)[1]))
    const value = readSidecar(pathname)
    if (ownerOrCancel) {
      const kind = ownerOrCancel[2]
      if (operation.paths[kind] !== pathname) throw new Error('retention_operation_sidecar_binding_invalid')
      if (kind === 'owner') verifyOwner(value, operation)
      else {
        const owner = verifyOwner(readSidecar(operation.paths.owner), operation)
        if (value?.schema !== RELEASE_OPERATION_CANCEL_SCHEMA || value.operationId !== operation.scope.operationId
          || !attemptPattern.test(value.targetAttemptId || '')
          || (value.targetAttemptId !== owner.attemptId && !operation.events.some(event => event.attemptId === value.targetAttemptId))
          || !Number.isFinite(Date.parse(value.requestedAt))) throw new Error('retention_operation_sidecar_binding_invalid')
      }
    } else {
      const attemptId = proof[3]
      if (value?.schema !== 'video-autoworker-runtime-proof-reference/v1' || value.attemptId !== attemptId
        || !operation.events.some(event => event.attemptId === attemptId)
        || !isAbsolute(value.proofPath || '') || resolve(value.proofPath) !== value.proofPath
        || !SHA.test(value.proofSha256 || '')
        || runtimeDigest(readRuntimeFile(value.proofPath, 4 * 1024 * 1024)) !== value.proofSha256) {
        throw new Error('retention_operation_sidecar_binding_invalid')
      }
    }
    return true
  }
  const visit = (directory, depth) => {
    inspectedPath = directory
    if (depth > 3) throw new Error('retention_operation_depth_limit')
    for (const name of readdirSync(directory)) {
      inspectedPath = join(directory, name)
      if (++visited > 1024) throw new Error('retention_operation_member_limit')
      const pathname = join(directory, name), entry = lstatSync(pathname)
      if (entry.isSymbolicLink()) throw new Error('retention_operation_symlink')
      if (entry.isDirectory()) {
        // Immutable payload subtrees cannot contain coordinator plan files.
        if (!['node_modules', '.next', '.git', 'standalone', 'worker-artifact', 'runtime-artifact'].includes(name)) visit(pathname, depth + 1)
        continue
      }
      if (classifySidecar(directory, name, pathname)) continue
      if (!/plan[^/]*\.json$/iu.test(name)) continue
      readOperation(pathname)
    }
  }
  try {
    if (!operationsRoot) throw new Error('retention_operation_inventory_missing')
    safeRuntimeEntry(operationsRoot, 'directory')
    visit(operationsRoot, 0)
  } catch (error) {
    // Stop at the same existing boundary. Do not inspect legacy plan bodies or
    // continue into more directories merely to produce a diagnostic inventory.
    const code = typeof error.message === 'string' && /^(?:retention|runtime)_[a-z0-9_]{1,100}$/u.test(error.message)
      ? error.message : 'retention_operation_inventory_unverifiable'
    blockers.push({ code, path: inspectedPath,
      ...(typeof error.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? { systemCode: error.code } : {}) })
  }
  return { references, blockers, complete: blockers.length === 0, visited }
}

function assertSingleDeviceReleaseTree(root, expectedDevice, readEntry = lstatSync) {
  let count = 0, bytes = 0
  const visit = (pathname, depth = 0) => {
    if (++count > 40000 || depth > 128) throw new Error('retention_tree_limit')
    const value = readEntry(pathname)
    if (String(value.dev) !== expectedDevice) throw new Error('retention_cross_device')
    if (value.uid !== process.getuid()) throw new Error('retention_tree_unsafe')
    if (value.mode & 0o7000) throw new Error('retention_tree_unsafe')
    if (value.isSymbolicLink()) {
      const target = realpathSync(pathname)
      const resolved = readEntry(target)
      if (!target.startsWith(`${root}/`) || String(resolved.dev) !== expectedDevice
        || resolved.uid !== process.getuid() || (!resolved.isFile() && !resolved.isDirectory())
        || (resolved.mode & 0o7002) || value.nlink !== 1) throw new Error('retention_link_unsafe')
    } else if (value.isDirectory()) {
      if (value.mode & 0o7002) throw new Error('retention_tree_unsafe')
      for (const name of readdirSync(pathname)) visit(join(pathname, name), depth + 1)
    } else if (value.isFile()) {
      if (value.mode & 0o7002) throw new Error('retention_tree_unsafe')
      if (value.nlink !== 1 || (bytes += value.size) > 2 * 1024 ** 3 + 5 * 1024 ** 2) throw new Error('retention_file_unsafe')
    } else throw new Error('retention_special_member')
  }
  visit(root)
}

async function verifiedCurrentRuntime({ runDir, databasePath, readWorker, inspectProcess }, expectedReceiptSha256) {
  safeRuntimeEntry(databasePath)
  const pathname = join(runDir, 'current-runtime.json')
  const before = runtimeDigest(readRuntimeFile(pathname, 256 * 1024))
  if (expectedReceiptSha256 && before !== expectedReceiptSha256) throw new Error('retention_snapshot_changed')
  const status = await readCurrentRuntimeReceipt({ runDir, databasePath, readWorker, inspectProcess })
  if (status.currentState !== 'ready' || !status.receipt) throw new Error('retention_current_runtime_unverified')
  const current = status.receipt
  if (current.database.pathSha256 !== runtimeDigest(databasePath) || !SHA.test(current.database.schemaSha256 || '')) {
    throw new Error('retention_database_binding_unverified')
  }
  if (runtimeDigest(readRuntimeFile(pathname, 256 * 1024)) !== before) throw new Error('retention_snapshot_changed')
  return { current, currentReceiptSha256: before }
}

async function releaseCandidate(pathname, auditArtifact, readEntry = lstatSync, expectedDevice = null, expectedSchemaSha256 = null) {
  const entry = safeRuntimeEntry(pathname, 'directory')
  assertSingleDeviceReleaseTree(pathname, expectedDevice || String(entry.dev), readEntry)
  // Source worktrees, unknown siblings and runtime data never become regenerable artifacts.
  if (existsSync(join(pathname, '.git'))) throw new Error('source_worktree_protected')
  const allowed = new Set(['standalone', 'recovery-receipt.json'])
  if (readdirSync(pathname).some(name => !allowed.has(name))) throw new Error('unknown_members_protected')
  const receiptBytes = readRuntimeFile(join(pathname, 'recovery-receipt.json'), 256 * 1024)
  const receipt = validateRuntimeReceipt(JSON.parse(receiptBytes))
  if (receipt.releaseId !== pathname.split('/').at(-1) || receipt.evidence.recoveryVerified !== true
    || !Number.isFinite(Date.parse(receipt.verifiedAt))) throw new Error('recovery_unverified')
  if (!SHA.test(expectedSchemaSha256 || '') || receipt.database.schemaSha256 !== expectedSchemaSha256) {
    throw new Error('recovery_schema_incompatible')
  }
  const standalone = join(pathname, 'standalone')
  const manifest = readRuntimeFile(join(standalone, 'release-manifest.json'))
  const parsed = JSON.parse(manifest)
  if (runtimeDigest(manifest) !== receipt.artifact.manifestSha256 || !Array.isArray(parsed.files)
    || parsed.files.length > 20000 || parsed.files.reduce((sum, member) => sum + (member.bytes || 0), 0) > 2 * 1024 ** 3) {
    throw new Error('artifact_unverified_or_limit_exceeded')
  }
  const audit = await auditArtifact(standalone)
  if (audit.ok !== true) throw new Error('artifact_unverified')
  artifactMetadataDigest(standalone, parsed)
  const candidate = { path: pathname, releaseId: receipt.releaseId, verifiedAt: receipt.verifiedAt,
    identity: identity(entry), manifestSha256: runtimeDigest(manifest),
    recoveryReceiptSha256: runtimeDigest(receiptBytes), databaseSchemaSha256: receipt.database.schemaSha256,
    treeSha256: audit.verificationBundle.treeMetadata.sha256,
    contentSha256: audit.artifactContent.digest,
    bytes: parsed.files.reduce((sum, member) => sum + member.bytes, 0) }
  // Reuse the just-completed full audit through its official metadata fence.
  // The large bundle stays in this operation's memory, never in the short plan.
  Object.defineProperty(candidate, 'verificationBundle', { value: audit.verificationBundle })
  return candidate
}

/** Only application release artifacts are supported. Other resource classes remain protected. */
export async function planRuntimeRetention({ runDir, releasesDir, databasePath, referencedPaths = [], maxObjects = 64,
  readProcesses = readProcessReleaseReferences, auditArtifact = auditStandaloneArtifact, readEntry = lstatSync,
  readWorker, inspectProcess }) {
  safeRuntimeEntry(runDir, 'directory'); const releasesIdentity = identity(safeRuntimeEntry(releasesDir, 'directory'))
  assertSharedDeploymentLockAvailableSync(runDir)
  if (existsSync(join(runDir, '.release-operation.lock'))) throw new Error('release_operation_active')
  const routerBytes = readRuntimeFile(join(runDir, 'router-state.json'), 128 * 1024)
  const router = JSON.parse(routerBytes)
  const { current, currentReceiptSha256 } = await verifiedCurrentRuntime({ runDir, databasePath, readWorker, inspectProcess })
  if (current.route.generation !== router.generation || current.route.active !== router.active
    || current.releaseId !== router.slots?.[router.active]?.releaseId) throw new Error('retention_current_receipt_drift')
  if (!Number.isSafeInteger(maxObjects) || maxObjects < 1 || maxObjects > 256) throw new Error('retention_limit_invalid')
  const members = readdirSync(releasesDir).sort()
  if (members.length > maxObjects) throw new Error('retention_inventory_limit')
  const operationsRoot = current.evidence.operationsRoot
  const operationInventory = readPendingOperationReferences(operationsRoot, runDir, releasesDir)
  const references = [...referencedPaths, ...readProcesses(releasesDir),
    ...operationInventory.references]
  const protectedReleases = new Set([router.slots?.[router.active]?.releaseId,
    router.slots?.[router.previous]?.releaseId].filter(Boolean))
  const protectedObjects = [], candidates = []
  for (const name of members) {
    const pathname = join(releasesDir, name)
    let reason
    if (!RELEASE.test(name)) reason = 'unknown_object'
    else if (protectedReleases.has(name)) reason = 'current_or_previous'
    else if (references.some(path => path === pathname || path.startsWith(`${pathname}/`))) reason = 'runtime_reference'
    else if (!operationInventory.complete) reason = 'operation_inventory_incomplete'
    if (reason) { protectedObjects.push({ path: pathname, reason }); continue }
    try { candidates.push(await releaseCandidate(pathname, auditArtifact, readEntry, releasesIdentity.dev, current.database.schemaSha256)) }
    catch (error) { protectedObjects.push({ path: pathname, reason: error.message === 'recovery_schema_incompatible'
      ? 'recovery_schema_incompatible' : 'unverified_or_unsafe' }) }
  }
  candidates.sort((left, right) => Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt))
  // The immediately previous release counts as one historical version; current does not.
  const protectedHistory = []
  const previous = router.slots?.[router.previous]?.releaseId
  if (operationInventory.complete && previous && previous !== current.releaseId && RELEASE.test(previous)) {
    try { protectedHistory.push(await releaseCandidate(join(releasesDir, previous), auditArtifact, readEntry, releasesIdentity.dev, current.database.schemaSha256)) }
    catch { /* An unverified protected previous object is reported, not counted as a verified recovery point. */ }
  }
  const keep = candidates.slice(0, Math.max(0, 2 - protectedHistory.length))
  const remove = operationInventory.complete ? candidates.slice(keep.length) : []
  const currentState = operationInventory.complete ? 'ready' : 'blocked'
  const plan = { schema: SCHEMA, kind: 'application-release-artifacts', currentState,
    inventoryComplete: operationInventory.complete, blockers: operationInventory.blockers,
    errorCode: operationInventory.complete ? null : 'retention_operation_inventory_incomplete',
    nextAction: operationInventory.complete ? 'review_retention_plan' : 'inspect_operation_reference_blockers',
    runDir, releasesDir, releasesIdentity,
    databasePath, databasePathSha256: current.database.pathSha256, databaseSchemaSha256: current.database.schemaSha256,
    routerSha256: runtimeDigest(routerBytes), currentReceiptSha256,
    referencedPaths, operationsRoot, keep, protectedHistory, remove, protectedObjects,
    summary: { currentState, inventoryComplete: operationInventory.complete, blockers: operationInventory.blockers,
      retainedVerifiedHistory: keep.length + protectedHistory.length, removalCount: remove.length,
      removalBytes: remove.reduce((sum, item) => sum + item.bytes, 0), protectedCount: protectedObjects.length } }
  return { ...plan, planSha256: runtimeDigest(plan) }
}

/** A human-confirmed digest authorizes only the exact regenerable artifacts in that plan. */
export async function applyRuntimeRetention(plan, confirmedPlanSha256, dependencies = {}) {
  if (plan?.currentState !== 'ready' || plan.inventoryComplete !== true
    || !Array.isArray(plan.blockers) || plan.blockers.length) throw new Error('retention_inventory_incomplete')
  const { planSha256, ...body } = plan
  if (plan.schema !== SCHEMA || plan.kind !== 'application-release-artifacts'
    || typeof plan.databasePath !== 'string' || plan.databasePathSha256 !== runtimeDigest(plan.databasePath)
    || !SHA.test(plan.databaseSchemaSha256 || '')
    || !Array.isArray(plan.remove) || plan.remove.length > 256
    || !Array.isArray(plan.keep) || !Array.isArray(plan.protectedHistory)
    || plan.keep.length > 2 || plan.protectedHistory.length > 1
    || planSha256 !== confirmedPlanSha256 || runtimeDigest(body) !== planSha256) {
    throw new Error('retention_confirmation_required')
  }
  safeRuntimeEntry(plan.runDir, 'directory')
  if (existsSync(join(plan.runDir, '.release-operation.lock'))) throw new Error('release_operation_active')
  const lock = acquireSharedDeploymentLockSync({ runDirectory: plan.runDir })
  try {
    if (JSON.stringify(identity(safeRuntimeEntry(plan.releasesDir, 'directory'))) !== JSON.stringify(plan.releasesIdentity)
      || runtimeDigest(readRuntimeFile(join(plan.runDir, 'router-state.json'))) !== plan.routerSha256
      || runtimeDigest(readRuntimeFile(join(plan.runDir, 'current-runtime.json'))) !== plan.currentReceiptSha256) {
      throw new Error('retention_snapshot_changed')
    }
    const current = validateRuntimeReceipt(JSON.parse(readRuntimeFile(join(plan.runDir, 'current-runtime.json'), 256 * 1024)))
    if (current.database.pathSha256 !== plan.databasePathSha256
      || current.database.schemaSha256 !== plan.databaseSchemaSha256) throw new Error('retention_database_binding_unverified')
    const readProcesses = dependencies.readProcesses || readProcessReleaseReferences
    const operationInventory = readPendingOperationReferences(plan.operationsRoot, plan.runDir, plan.releasesDir)
    if (!operationInventory.complete) throw new Error('retention_operation_inventory_incomplete')
    const references = [...plan.referencedPaths, ...readProcesses(plan.releasesDir),
      ...operationInventory.references]
    const router = JSON.parse(readRuntimeFile(join(plan.runDir, 'router-state.json')))
    const protectedReleases = new Set([router.slots?.[router.active]?.releaseId,
      router.slots?.[router.previous]?.releaseId, ...plan.keep.map(item => item.releaseId)].filter(Boolean))
    // Check protected targets even for a manually recomputed confirmed digest.
    if (plan.remove.some(item => protectedReleases.has(item.releaseId))) throw new Error('retention_target_protected')
    const retained = [...plan.keep, ...plan.protectedHistory]
    if (retained.length !== plan.summary.retainedVerifiedHistory
      || new Set(retained.map(item => item.releaseId)).size !== retained.length
      || (plan.remove.length && retained.length !== 2)) throw new Error('retention_recovery_count_changed')
    const retainedNow = []
    for (const item of retained) {
      if (dirname(item.path) !== plan.releasesDir || item.path !== join(plan.releasesDir, item.releaseId)
        || !RELEASE.test(item.releaseId) || item.releaseId === router.slots?.[router.active]?.releaseId
        || item.identity.dev !== plan.releasesIdentity.dev
        || (plan.protectedHistory.includes(item) && item.releaseId !== router.slots?.[router.previous]?.releaseId)) {
        throw new Error('retention_recovery_changed')
      }
      try {
        const now = await releaseCandidate(item.path, dependencies.auditArtifact || auditStandaloneArtifact,
          dependencies.readEntry || lstatSync, plan.releasesIdentity.dev, plan.databaseSchemaSha256)
        if (JSON.stringify(now) !== JSON.stringify(item)) throw new Error('changed')
        retainedNow.push(now)
      } catch { throw new Error('retention_recovery_changed') }
    }
    const verified = []
    // Revalidate the complete list before deleting its first member.
    for (const item of plan.remove) {
      if (dirname(item.path) !== plan.releasesDir || !RELEASE.test(item.releaseId)
        || item.path !== join(plan.releasesDir, item.releaseId)
        || protectedReleases.has(item.releaseId) || item.identity.dev !== plan.releasesIdentity.dev
        || references.some(path => path === item.path || path.startsWith(`${item.path}/`))) {
        throw new Error('retention_target_protected')
      }
      const now = await releaseCandidate(item.path, dependencies.auditArtifact || auditStandaloneArtifact,
        dependencies.readEntry || lstatSync, plan.releasesIdentity.dev, plan.databaseSchemaSha256)
      if (JSON.stringify(now) !== JSON.stringify(item)) throw new Error('retention_candidate_changed')
      verified.push(item)
    }
    // Candidate audits may take time. Fence all retained points again before the
    // first delete without rehashing an unchanged full artifact.
    for (const item of retainedNow) {
      try {
        if (JSON.stringify(identity(safeRuntimeEntry(item.path, 'directory'))) !== JSON.stringify(item.identity)
          || runtimeDigest(readRuntimeFile(join(item.path, 'recovery-receipt.json'))) !== item.recoveryReceiptSha256) {
          throw new Error('changed')
        }
        await (dependencies.verifyArtifactSnapshot || verifyStandaloneVerificationBundle)(
          join(item.path, 'standalone'), item.verificationBundle)
      } catch { throw new Error('retention_recovery_changed') }
    }
    // Check every deletion subtree before removing the first one, rather than
    // discovering a later mount boundary after an earlier object was removed.
    for (const item of verified) {
      assertSingleDeviceReleaseTree(item.path, plan.releasesIdentity.dev, dependencies.readEntry || lstatSync)
      const standalone = join(item.path, 'standalone')
      artifactMetadataDigest(standalone, JSON.parse(readRuntimeFile(join(standalone, 'release-manifest.json'))))
    }
    // Audits can outlive a schema migration or Worker restart. Re-read the same
    // authoritative runtime immediately before the first removal, not only its files.
    await verifiedCurrentRuntime({ runDir: plan.runDir, databasePath: plan.databasePath,
      readWorker: dependencies.readWorker, inspectProcess: dependencies.inspectProcess }, plan.currentReceiptSha256)
    for (const item of verified.sort((left, right) => Date.parse(left.verifiedAt) - Date.parse(right.verifiedAt))) {
      // Recheck the complete device boundary at the deletion boundary; fs.rm
      // itself does not provide a no-cross-filesystem recursive option.
      assertSingleDeviceReleaseTree(item.path, plan.releasesIdentity.dev, dependencies.readEntry || lstatSync)
      if (JSON.stringify(identity(lstatSync(item.path))) !== JSON.stringify(item.identity)) throw new Error('retention_candidate_changed')
      rmSync(item.path, { recursive: true, force: false })
    }
    return { currentState: 'completed', removed: verified.map(item => item.releaseId),
      plannedBytes: plan.summary.removalBytes, actualFreeSpaceGain: null }
  } finally { lock.release() }
}
