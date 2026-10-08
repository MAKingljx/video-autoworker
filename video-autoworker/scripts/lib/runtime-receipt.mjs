import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, readlinkSync,
  realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { readIndependentWorkerStatus } from './independent-worker-release.mjs'
import { inspectRuntimeIdentityDoctor } from '../runtime-identity-doctor.mjs'
import Database from 'better-sqlite3'

const SCHEMA = 'video-autoworker-current-runtime/v1'
const SHA = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
export const runtimeDigest = value => createHash('sha256').update(
  typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex')

export function safeRuntimeEntry(pathname, kind = 'file') {
  if (!isAbsolute(pathname || '') || resolve(pathname) !== pathname || /[\u0000-\u001f]/u.test(pathname)) {
    throw new Error('runtime_path_invalid')
  }
  const entry = lstatSync(pathname)
  if (entry.isSymbolicLink() || realpathSync(pathname) !== pathname || entry.uid !== process.getuid()
    || (entry.mode & 0o022) || (kind === 'file' ? !entry.isFile() || entry.nlink !== 1 : !entry.isDirectory())) {
    throw new Error('runtime_path_unsafe')
  }
  return entry
}

export function readRuntimeFile(pathname, maximum = 32 * 1024 * 1024) {
  const before = safeRuntimeEntry(pathname)
  if (before.size > maximum) throw new Error('runtime_file_limit')
  const bytes = readFileSync(pathname)
  const after = safeRuntimeEntry(pathname)
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('runtime_file_changed')
  return bytes
}

/** Bounded fingerprints contain paths and hashes, never configuration or model text. */
export function fingerprintRuntimeReference(pathname, kind = 'file') {
  if (kind === 'file') return { path: pathname, kind, sha256: runtimeDigest(readRuntimeFile(pathname)) }
  safeRuntimeEntry(pathname, 'directory')
  const members = []; let bytes = 0
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      if (members.length >= 4096) throw new Error('runtime_tree_member_limit')
      const current = join(directory, name), member = relative(pathname, current)
      const entry = lstatSync(current)
      if (entry.isSymbolicLink()) {
        // The installed video plugin has one upstream SDK link, already verified
        // by release readiness. Record the target and package identity; never walk it.
        if (member !== 'node_modules/openclaw') throw new Error('runtime_tree_symlink')
        const packagePath = join(realpathSync(current), 'package.json')
        const packageBytes = readRuntimeFile(packagePath, 1024 * 1024)
        if ((bytes += packageBytes.length) > 64 * 1024 * 1024) throw new Error('runtime_tree_byte_limit')
        members.push([member, 'sdk-link', readlinkSync(current), runtimeDigest(packageBytes)])
      } else if (entry.isDirectory()) {
        safeRuntimeEntry(current, 'directory'); members.push([member, 'directory', entry.mode & 0o777]); visit(current)
      } else {
        if (entry.size > 16 * 1024 * 1024 || (bytes += entry.size) > 64 * 1024 * 1024) throw new Error('runtime_tree_byte_limit')
        members.push([member, 'file', entry.mode & 0o777, runtimeDigest(readRuntimeFile(current, 16 * 1024 * 1024))])
      }
    }
  }
  visit(pathname)
  let version = null
  try { version = JSON.parse(readRuntimeFile(join(pathname, 'package.json'), 128 * 1024)).version || null } catch { /* Skills have no package version. */ }
  return { path: pathname, kind: 'tree', sha256: runtimeDigest(members), members: members.length, bytes, version }
}

export function runtimeReceiptPath(runDir) { return join(runDir, 'current-runtime.json') }

function assertDeclaredArtifactEntry(value, kind, member) {
  if (value.uid !== BigInt(process.getuid())) throw new Error('runtime_artifact_member_unsafe')
  if (kind === 'symlink' ? !value.isSymbolicLink()
    : kind === 'file' ? !value.isFile() : !value.isDirectory()) throw new Error('runtime_artifact_member_type_invalid')
  if ((value.mode & 0o7000n) || (kind !== 'symlink' && (value.mode & 0o002n))) throw new Error('runtime_artifact_member_unsafe')
  if ((kind === 'file' || kind === 'symlink') && value.nlink !== 1n) throw new Error('runtime_artifact_member_unsafe')
  if (typeof member.mode !== 'string' || !/^[0-7]{4}$/u.test(member.mode)
    || (value.mode & 0o7777n).toString(8).padStart(4, '0') !== member.mode) throw new Error('runtime_artifact_mode_mismatch')
  return value
}

export function artifactMetadataDigest(root, manifest) {
  const rows = []
  const members = [['file', manifest.files || []], ['directory', manifest.directories || []], ['symlink', manifest.symlinks || []]]
    .flatMap(([kind, entries]) => entries.map(member => ({ kind, member })))
  if (members.length > 20000) throw new Error('runtime_artifact_member_limit')
  const declared = new Map()
  for (const item of members) {
    const name = item.member?.path
    if (typeof name !== 'string' || isAbsolute(name) || name.includes('\\')
      || name.split('/').some(part => ['', '.', '..'].includes(part)) || declared.has(name)) {
      throw new Error('runtime_artifact_member_invalid')
    }
    declared.set(name, item)
  }
  const assertMember = (pathname, kind, member) => {
    const value = lstatSync(pathname, { bigint: true })
    // Symlink permission bits are metadata, not write authority. Ordinary
    // members follow the exact mode sealed by the existing artifact auditor.
    return assertDeclaredArtifactEntry(value, kind, member)
  }
  for (const { kind, member } of members) {
    const name = member.path
    const pathname = join(root, name), entry = assertMember(pathname, kind, member)
    if (kind === 'symlink') {
      if (typeof member.target !== 'string'
        || isAbsolute(member.target) || readlinkSync(pathname) !== member.target) throw new Error('runtime_artifact_link_invalid')
      const target = realpathSync(pathname)
      if (!target.startsWith(`${root}/`)) throw new Error('runtime_artifact_link_escape')
      const targetDeclaration = declared.get(relative(root, target))
      if (!targetDeclaration || targetDeclaration.kind === 'symlink') throw new Error('runtime_artifact_link_unsafe')
      assertMember(target, targetDeclaration.kind, targetDeclaration.member)
    }
    rows.push([name, String(entry.dev), String(entry.ino), String(entry.size), String(entry.mode),
      String(entry.mtimeNs), String(entry.ctimeNs), entry.isSymbolicLink() ? readlinkSync(pathname) : null])
  }
  return runtimeDigest(rows)
}

export function validateRuntimeReceipt(value) {
  const evidence = { ...value?.evidence }; delete evidence.sha256
  if (value?.schema !== SCHEMA || value.currentState !== 'ready' || !COMMIT.test(value.sourceCommit || '')
    || value.releaseId !== `${value.sourceCommit}-runtime` || !SHA.test(value.artifact?.manifestSha256 || '')
    || !Number.isSafeInteger(value.route?.generation) || value.route.generation < 1
    || !['blue', 'green'].includes(value.route?.active) || !/^\d+$/u.test(value.database?.dev || '')
    || !/^\d+$/u.test(value.database?.ino || '') || !SHA.test(value.database?.pathSha256 || '')
    || value.evidence?.acceptance !== 'verified' || !SHA.test(value.evidence?.sha256 || '')
    || runtimeDigest(evidence) !== value.evidence.sha256
    || !Array.isArray(value.references) || value.references.length > 12
    || value.references.some(reference => !SHA.test(reference.sha256 || '') || !['file', 'tree'].includes(reference.kind))) {
    throw new Error('runtime_receipt_invalid')
  }
  return value
}

export async function observeRuntime({ runDir, databasePath, workerBinding = null,
  references = [], readWorker = readIndependentWorkerStatus, inspectProcess = inspectRuntimeIdentityDoctor }) {
  safeRuntimeEntry(runDir, 'directory')
  const router = JSON.parse(readRuntimeFile(join(runDir, 'router-state.json'), 128 * 1024))
  if (router.schema !== 'video-autoworker-standalone-router/v1' || !['blue', 'green'].includes(router.active)
    || !Number.isSafeInteger(router.generation) || router.generation < 1) throw new Error('runtime_route_invalid')
  const slot = JSON.parse(readRuntimeFile(join(runDir, 'slots', `${router.active}.json`), 128 * 1024))
  if (slot.releaseId !== router.slots?.[router.active]?.releaseId) throw new Error('runtime_slot_mismatch')
  const manifestBytes = readRuntimeFile(join(slot.releaseRoot, 'release-manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  const provenance = JSON.parse(readRuntimeFile(join(slot.releaseRoot, 'release-provenance.json')))
  const sourceCommit = provenance.gitCommit
  if (!COMMIT.test(sourceCommit || '') || slot.releaseId !== `${sourceCommit}-runtime`
    || slot.manifestSha256 !== runtimeDigest(manifestBytes)) throw new Error('runtime_artifact_mismatch')
  safeRuntimeEntry(databasePath)
  const database = lstatSync(databasePath, { bigint: true })
  const readOnlyDatabase = new Database(databasePath, { readonly: true, fileMustExist: true })
  let databaseState
  try {
    databaseState = readOnlyDatabase.transaction(() => {
      const migrations = readOnlyDatabase.prepare('SELECT id FROM schema_migrations ORDER BY id LIMIT 2049').all().map(row => row.id)
      const editingTables = readOnlyDatabase.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'video_edit%' LIMIT 2049").all().map(row => row.name)
      const schema = readOnlyDatabase.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name LIMIT 2049").all()
      if (migrations.length > 2048 || schema.length > 2048 || JSON.stringify(schema).length > 4 * 1024 * 1024) throw new Error('runtime_schema_limit')
      return { latestMigration: migrations.at(-1) || null, schemaSha256: runtimeDigest(schema),
        videoEditingMigrationPresent: migrations.includes('060_video_edit_task_receipts'),
        videoEditingTables: editingTables }
    })()
  } finally { readOnlyDatabase.close() }
  const platform = references.find(reference => reference.name === 'platform')
  if (!platform) throw new Error('runtime_platform_reference_required')
  const processIdentity = inspectProcess({ runDir, slot: router.active, platformEnvPath: platform.path,
    expectedConfigSha256: runtimeDigest(readRuntimeFile(platform.path)) })
  if (processIdentity.status !== 'aligned') throw new Error('runtime_process_drift')
  let worker = null
  if (workerBinding) {
    const status = await readWorker(workerBinding.stateDir)
    const bytes = readRuntimeFile(workerBinding.manifestPath)
    const workerManifest = JSON.parse(bytes)
    if (workerManifest.schema !== 'video-autoworker-scheduler-artifact/v1'
      || status.executionMode !== 'external-worker' || status.currentState !== 'ready'
      || status.healthy !== true || status.leaseVerified !== true || status.leadership?.state !== 'leader'
      || Math.abs(Date.now() - status.observedAt) > 15000
      || status.worker?.contentSha256 !== workerManifest.contentSha256
      || status.worker?.database?.dev !== String(database.dev)
      || status.worker?.database?.ino !== String(database.ino)
      || status.worker?.database?.pathSha256 !== runtimeDigest(databasePath)) throw new Error('runtime_worker_mismatch')
    worker = { stateDir: workerBinding.stateDir, manifestPath: workerBinding.manifestPath,
      manifestSha256: runtimeDigest(bytes), contentSha256: workerManifest.contentSha256,
      runtime: workerManifest.runtime, pid: status.worker.pid }
  }
  let version = null
  const packageDeclaration = manifest.files?.find(member => member.path === 'package.json')
  if (packageDeclaration) {
    const handle = openSync(join(slot.releaseRoot, 'package.json'), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = assertDeclaredArtifactEntry(fstatSync(handle, { bigint: true }), 'file', packageDeclaration)
      if (before.size > 1024n * 1024n) throw new Error('runtime_file_limit')
      const content = readFileSync(handle), after = fstatSync(handle, { bigint: true })
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error('runtime_file_changed')
      const declaredVersion = JSON.parse(content.toString('utf8')).version
      if (typeof declaredVersion === 'string' && declaredVersion.length <= 160) version = declaredVersion
    } finally { closeSync(handle) }
  }
  return { sourceCommit, releaseId: slot.releaseId,
    route: { active: router.active, previous: router.previous, generation: router.generation,
      slots: Object.fromEntries(Object.entries(router.slots).map(([key, value]) => [key, value.releaseId])) },
    artifact: { manifestSha256: runtimeDigest(manifestBytes), contentSha256: manifest.artifactContent?.digest || null,
      treeMetadataSha256: artifactMetadataDigest(slot.releaseRoot, manifest), releaseRoot: slot.releaseRoot, version },
    database: { pathSha256: runtimeDigest(databasePath), dev: String(database.dev), ino: String(database.ino), ...databaseState },
    worker, process: processIdentity.process, references: references.map(reference => ({ name: reference.name,
      ...fingerprintRuntimeReference(reference.path, reference.kind) })) }
}

export async function readCurrentRuntimeReceipt({ runDir, databasePath, readWorker, inspectProcess } = {}) {
  let receiptPresent = false
  try {
    const pathname = runtimeReceiptPath(runDir)
    lstatSync(pathname)
    receiptPresent = true
    const value = validateRuntimeReceipt(JSON.parse(readRuntimeFile(pathname, 256 * 1024)))
    const current = await observeRuntime({ runDir, databasePath, workerBinding: value.components?.worker,
      references: value.references, readWorker, inspectProcess })
    const mismatches = ['sourceCommit', 'releaseId', 'route', 'artifact', 'database', 'references']
      .filter(key => JSON.stringify(current[key]) !== JSON.stringify(value[key]))
    if (value.components?.worker && (current.worker?.contentSha256 !== value.components.worker.contentSha256
      || current.worker?.manifestSha256 !== value.components.worker.manifestSha256)) mismatches.push('worker')
    return { currentState: mismatches.length ? 'drift' : 'ready', errorCode: mismatches.length ? 'runtime_receipt_drift' : null,
      nextAction: mismatches.length ? 'inspect_runtime_bindings' : null, mismatches, receipt: value }
  } catch (error) {
    const missingReceipt = !receiptPresent && error.code === 'ENOENT'
    return { currentState: missingReceipt ? 'uninitialized' : 'drift',
      errorCode: missingReceipt ? 'runtime_receipt_missing' : 'runtime_receipt_unverifiable',
      nextAction: missingReceipt ? 'complete_verified_release' : 'inspect_runtime_bindings', mismatches: [], receipt: null }
  }
}

/** Called only inside the release operation lock after acceptance and intake settlement. */
export function writeCurrentRuntimeReceipt({ runDir, databasePath, observation, components, evidence, expectedReceiptSha256 }) {
  const directory = safeRuntimeEntry(runDir, 'directory')
  if ((directory.mode & 0o777) !== 0o700 || evidence?.acceptance !== 'verified'
    || evidence?.settlement !== 'verified') throw new Error('runtime_receipt_acceptance_required')
  const pathname = runtimeReceiptPath(runDir)
  const priorHash = () => {
    try { return runtimeDigest(readRuntimeFile(pathname, 256 * 1024)) } catch (error) {
      if (error.code === 'ENOENT') return null; throw error
    }
  }
  const baseline = priorHash()
  if (expectedReceiptSha256 !== undefined && baseline !== expectedReceiptSha256) throw new Error('runtime_receipt_cas_failed')
  const value = validateRuntimeReceipt({ schema: SCHEMA, currentState: 'ready', errorCode: null, nextAction: null,
    verifiedAt: new Date().toISOString(), ...observation, components: { ...components, worker: observation.worker },
    evidence: { ...evidence, sha256: runtimeDigest(evidence) } })
  const temporary = `${pathname}.tmp-${process.pid}-${randomUUID()}`
  let descriptor, createdTemporary = false
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    createdTemporary = true
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined
    if (priorHash() !== baseline) throw new Error('runtime_receipt_cas_failed')
    const route = JSON.parse(readRuntimeFile(join(runDir, 'router-state.json')))
    if (route.generation !== observation.route.generation || route.active !== observation.route.active
      || route.slots?.[route.active]?.releaseId !== observation.releaseId) throw new Error('runtime_receipt_route_changed')
    safeRuntimeEntry(databasePath)
    const database = lstatSync(databasePath, { bigint: true })
    if (String(database.dev) !== observation.database.dev || String(database.ino) !== observation.database.ino
      || runtimeDigest(databasePath) !== observation.database.pathSha256) throw new Error('runtime_receipt_database_changed')
    renameSync(temporary, pathname)
    const handle = openSync(runDir, 'r'); try { fsyncSync(handle) } finally { closeSync(handle) }
    return value
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (createdTemporary) try { unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

/** Public status exposes versions and evidence digests, not private runtime paths. */
export function publicRuntimeReceiptStatus(status) {
  const value = status.receipt
  return { currentState: status.currentState, errorCode: status.errorCode, nextAction: status.nextAction,
    mismatches: status.mismatches, ...(value ? { sourceCommit: value.sourceCommit, releaseId: value.releaseId,
      route: value.route, artifact: { manifestSha256: value.artifact.manifestSha256,
        contentSha256: value.artifact.contentSha256, treeMetadataSha256: value.artifact.treeMetadataSha256,
        version: value.artifact.version }, database: value.database,
      components: { app: value.sourceCommit, control: value.components?.control,
        worker: value.components?.worker ? { contentSha256: value.components.worker.contentSha256,
          manifestSha256: value.components.worker.manifestSha256, runtime: value.components.worker.runtime } : null,
        plugins: value.references.filter(reference => reference.kind === 'tree').map(reference => (
          { name: reference.name, version: reference.version, sha256: reference.sha256 })) },
      verifiedAt: value.verifiedAt, evidenceSha256: value.evidence.sha256 } : {}) }
}
