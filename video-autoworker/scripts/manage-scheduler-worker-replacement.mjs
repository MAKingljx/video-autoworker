#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { schedulerWorkerMaintenance as core } from './manage-scheduler-worker.mjs'
import { readIndependentWorkerStatus } from './lib/independent-worker-release.mjs'
import { acquireSharedDeploymentLockSync, verifySharedDeploymentLockDelegationSync } from './lib/shared-deployment-lock.mjs'
import { SCHEDULER_WORKER_LAUNCHD_LABEL as LABEL,
  validateSchedulerLaunchdReplacement as validateLaunchdReplacement,
  createSchedulerLaunchdAdapter as productionAdapter, assertSchedulerLaunchdProcess as launchctlStatus,
  assertSchedulerLaunchdReadiness, assertSchedulerLaunchdOriginalService } from './lib/scheduler-worker-launchd.mjs'

const SCHEMA = 'video-autoworker-scheduler-replacement/v1'
const OWNER = 'video-autoworker-scheduler-replacement-owner/v1'
const MIGRATION = '061_n8n_video_stop_requests'
const SHA = /^[a-f0-9]{64}$/u
const sha = value => createHash('sha256').update(value).digest('hex')
const digest = value => sha(JSON.stringify(value))
const fail = code => { throw new Error(code) }
const sleep = ms => new Promise(done => setTimeout(done, ms))
const activeGuards = new WeakMap()
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])) : value
const same = (a, b) => digest(sorted(a)) === digest(sorted(b))

function privateDirectory(pathname, create = false) {
  if (create) mkdirSync(pathname, { recursive: true, mode: 0o700 })
  core.stateRoot(pathname)
}
function writeJson(pathname, value, expected = null) {
  privateDirectory(dirname(pathname))
  if (expected === null ? existsSync(pathname) : core.privateFile(pathname).sha256 !== expected) fail('worker_replacement_receipt_changed')
  const temporary = join(dirname(pathname), `.${randomUUID()}.tmp`)
  const bytes = `${JSON.stringify(value, null, 2)}\n`
  if (Buffer.byteLength(bytes) > 65_536) fail('worker_replacement_receipt_too_large')
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  if (expected === null ? existsSync(pathname) : core.privateFile(pathname).sha256 !== expected) {
    unlinkSync(temporary); fail('worker_replacement_receipt_changed')
  }
  renameSync(temporary, pathname)
  const directory = openSync(dirname(pathname), constants.O_RDONLY)
  try { fsyncSync(directory) } finally { closeSync(directory) }
  return sha(Buffer.from(bytes))
}
function locations(options) {
  if (!SHA.test(options.operationId || '')) fail('worker_replacement_operation_invalid')
  privateDirectory(options.stateDir)
  const root = join(options.stateDir, 'replacements'), directory = join(root, options.operationId)
  return { root, directory, receipt: join(directory, 'receipt.json'), owner: join(root, 'owner.json') }
}
function contexts(options) {
  if (options.waitMs !== undefined && (!Number.isSafeInteger(options.waitMs) || options.waitMs < 100 || options.waitMs > 300000)) fail('worker_replacement_wait_invalid')
  for (const pathname of [options.oldManifestPath, options.targetManifestPath, options.databasePath]) {
    if (!isAbsolute(pathname || '') || realpathSync(pathname) !== pathname) fail('worker_replacement_path_invalid')
  }
  const before = core.context({ ...options, manifestPath: options.oldManifestPath })
  const target = core.context({ ...options, manifestPath: options.targetManifestPath })
  if (!core.equalDatabase(before.database, target.database)) fail('worker_replacement_database_changed')
  return { before, target }
}
function assertPause(options, context) {
  activeGuards.get(options)?.()
  const observed = context.query(db => ({
    intake: db.prepare('SELECT accepting,revision,reason FROM n8n_intake_controls WHERE control_id=1').get(),
    active: db.prepare("SELECT COUNT(*) n FROM n8n_task_runs WHERE status IN ('queued','accepted','running')").get().n,
  }))
  if (observed.intake?.accepting !== 0 || observed.active !== 0
    || observed.intake.revision !== options.intake?.revision || observed.intake.reason !== options.intake?.reason) fail('worker_replacement_intake_changed')
}
function handoff(options, context, expected = null) {
  const value = core.privateFile(join(options.stateDir, 'handoff.json'))
  if (value.value.schema !== 'video-autoworker-scheduler-handoff/v1'
    || value.value.migrationPending === true || value.value.rolledBackAt
    || !(value.value.oldSchedulerStopped === true || value.value.oldSchedulerReleased === true)
    || !core.equalDatabase(value.value.database, context.database)
    || expected && value.sha256 !== expected) fail('worker_replacement_completed_handoff_changed')
  return value
}
async function observe(options, context, expectedPid = null, expectedStartedAt = null) {
  const status = await readIndependentWorkerStatus(options.stateDir)
  if (status?.schema !== 'video-autoworker-scheduler-worker/v1' || status.executionMode !== 'external-worker'
    || status.worker?.contentSha256 !== context.manifest.contentSha256
    || !core.equalDatabase(status.worker?.database, context.database)
    || expectedPid !== null && status.worker.pid !== expectedPid
    || expectedStartedAt !== null && status.worker.startedAt !== expectedStartedAt
    || !Number.isSafeInteger(status.worker?.startedAt) || !Number.isSafeInteger(status.observedAt)
    || Math.abs(Date.now() - status.observedAt) > 15_000) fail('worker_replacement_live_identity_changed')
  core.processIdentity(status.worker.pid, { cwd: context.root, databasePath: options.databasePath,
    commandFragments: ['start-scheduler-worker.mjs', context.root, options.stateDir] })
  return status
}
function ready(status) {
  return status.healthy === true && status.leaseVerified === true && status.currentState === 'ready'
    && status.leadership?.state === 'leader'
}
function assertNoWorker(options, record, context) {
  if (core.alive(record.before.pid) || existsSync(join(options.stateDir, 'worker.sock')) || core.lease(context)) fail('worker_replacement_old_execution_remaining')
}
function staticBinding(options, ctx, service) {
  return { operationId: options.operationId, stateDir: options.stateDir, database: ctx.before.database,
    runDirectory: options.runDirectory,
    expectedOldPid: options.expectedOldPid,
    oldManifestPath: options.oldManifestPath, oldManifestSha256: sha(readFileSync(options.oldManifestPath)),
    targetManifestPath: options.targetManifestPath, targetManifestSha256: sha(readFileSync(options.targetManifestPath)),
    pythonBin: realpathSync(options.pythonBin || '/usr/bin/python3'),
    targetApplicationCommit: options.targetApplicationCommit, intake: options.intake, service }
}
function readOwned(options, ctx, allowCompleted = false) {
  const paths = locations(options), owner = existsSync(paths.owner) ? core.privateFile(paths.owner) : null, current = core.privateFile(paths.receipt)
  const record = current.value
  if (!owner && !(allowCompleted && record.step === 'completed')
    || owner && (owner.value.schema !== OWNER || owner.value.operationId !== options.operationId)
    || record.schema !== SCHEMA || record.operationId !== options.operationId
    || owner && owner.value.bindingSha256 !== record.bindingSha256
    || record.bindingSha256 !== digest(record.binding)
    || record.before?.pid !== options.expectedOldPid
    || record.before?.contentSha256 !== ctx.before.manifest.contentSha256
    || record.target?.contentSha256 !== ctx.target.manifest.contentSha256
    || !same(record.binding, staticBinding(options, ctx, record.binding.service))) fail('worker_replacement_scope_changed')
  handoff(options, ctx.before, record.handoffSha256)
  if (!(allowCompleted && record.step === 'completed')) assertPause(options, ctx.before)
  return { paths, record, sha256: current.sha256, ownerSha256: owner?.sha256 ?? null, assertCurrent: activeGuards.get(options) }
}
function update(loaded, step, extra = {}) {
  loaded.assertCurrent?.()
  const record = { ...loaded.record, ...extra, step, updatedAt: Date.now() }
  loaded.sha256 = writeJson(loaded.paths.receipt, record, loaded.sha256)
  loaded.record = record
  return record
}
async function recoverOwnedStaleLock(options) {
  const paths = locations(options)
  if (existsSync(paths.owner)) {
    const owner = core.privateFile(paths.owner)
    if (owner.value.schema !== OWNER || owner.value.operationId !== options.operationId) fail('worker_replacement_lock_not_owned')
  } else {
    // A killed prepare may not yet have published its owner pointer. Before
    // any stop effect, a fresh verified original worker is the safe baseline.
    const ctx = contexts(options)
    assertPause(options, ctx.before); handoff(options, ctx.before)
    if (!ready(await observe(options, ctx.before, options.expectedOldPid))) fail('worker_replacement_lock_not_owned')
    if (existsSync(paths.receipt)) {
      const record = core.privateFile(paths.receipt).value
      if (record.schema !== SCHEMA || record.operationId !== options.operationId || record.step !== 'prepared'
        || record.bindingSha256 !== digest(record.binding)) fail('worker_replacement_lock_not_owned')
    }
  }
  const claim = join(options.stateDir, 'replacement-lock-recovery.lock')
  const descriptor = openSync(claim, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    const pathname = join(options.stateDir, 'handoff.lock'), before = lstatSync(pathname), sample = core.privateFile(pathname)
    if (sample.value.operationId !== options.operationId || !Number.isSafeInteger(sample.value.pid)
      || core.alive(sample.value.pid)) fail('worker_replacement_lock_not_owned')
    const current = lstatSync(pathname)
    if (before.dev !== current.dev || before.ino !== current.ino || core.privateFile(pathname).sha256 !== sample.sha256) fail('worker_replacement_lock_changed')
    unlinkSync(pathname)
  } finally { closeSync(descriptor); unlinkSync(claim) }
}
async function locked(options, action) {
  if (!isAbsolute(options.runDirectory || '') || realpathSync(options.runDirectory) !== options.runDirectory) fail('worker_replacement_run_directory_invalid')
  if (options.service?.kind === 'launchd' && !options.deploymentLease) fail('worker_replacement_deployment_delegation_required')
  let owned = null
  const lease = options.deploymentLease || (owned = acquireSharedDeploymentLockSync({ runDirectory: options.runDirectory })).descriptor
  const owner = JSON.parse(lease.ownerSource)
  const witness = verifySharedDeploymentLockDelegationSync({ runDirectory: options.runDirectory,
    ownerPid: lease.ownerPid, ownerNonce: owner.nonce, expectedLease: lease })
  activeGuards.set(options, witness.assertCurrent)
  try {
    const invoke = async () => { witness.assertCurrent(); const result = await action(contexts(options)); witness.assertCurrent(); return result }
    try { return await core.withLock(options, invoke) }
    catch (error) {
      if (error.code !== 'EEXIST' || !existsSync(join(options.stateDir, 'handoff.lock'))) throw error
      witness.assertCurrent(); await recoverOwnedStaleLock(options)
      return await core.withLock(options, invoke)
    }
  } finally {
    activeGuards.delete(options)
    owned?.release()
  }
}

export function validateSchedulerLaunchdReplacement(options, ctx = contexts(options)) {
  return validateLaunchdReplacement(options, ctx)
}

export async function prepareSchedulerReplacement(options, services = null) {
  return locked(options, async ctx => {
    if (!/^[a-f0-9]{40}$/u.test(options.targetApplicationCommit || '')) fail('worker_replacement_target_commit_invalid')
    if (!Number.isSafeInteger(options.expectedOldPid) || options.expectedOldPid < 1) fail('worker_replacement_before_pid_invalid')
    assertPause(options, ctx.before)
    const paths = locations(options)
    privateDirectory(paths.root, true)
    if (existsSync(paths.owner)) {
      const loaded = readOwned(options, ctx)
      return { currentState: loaded.record.step, receiptSha256: loaded.sha256, reused: true }
    }
    const current = await observe(options, ctx.before, options.expectedOldPid)
    if (!ready(current)) fail('worker_replacement_before_not_ready')
    const oldHandoff = handoff(options, ctx.before)
    const service = services ? { kind: 'process' } : validateSchedulerLaunchdReplacement(options, ctx)
    if (!services) launchctlStatus(service, ctx.before.root, current.worker.pid)
    privateDirectory(paths.directory, true)
    const binding = staticBinding(options, ctx, service), bindingSha256 = digest(binding)
    if (existsSync(paths.receipt)) {
      const old = core.privateFile(paths.receipt)
      if (old.value.schema !== SCHEMA || old.value.operationId !== options.operationId || old.value.step !== 'prepared'
        || old.value.bindingSha256 !== bindingSha256 || !same(old.value.binding, binding)
        || old.value.before.pid !== current.worker.pid || old.value.before.startedAt !== current.worker.startedAt
        || old.value.handoffSha256 !== oldHandoff.sha256) fail('worker_replacement_orphan_prepare_changed')
      writeJson(paths.owner, { schema: OWNER, operationId: options.operationId, bindingSha256 })
      return { currentState: 'prepared', receiptSha256: old.sha256, reused: true, recoveredPrepare: true }
    }
    const record = { schema: SCHEMA, operationId: options.operationId, bindingSha256, binding,
      handoffSha256: oldHandoff.sha256, step: 'prepared', createdAt: Date.now(), updatedAt: Date.now(),
      before: { pid: current.worker.pid, startedAt: current.worker.startedAt, contentSha256: ctx.before.manifest.contentSha256 },
      target: { contentSha256: ctx.target.manifest.contentSha256 } }
    const receiptSha256 = writeJson(paths.receipt, record)
    await services?.afterPreparedReceipt?.()
    writeJson(paths.owner, { schema: OWNER, operationId: options.operationId, bindingSha256 })
    return { currentState: 'prepared', receiptSha256, reused: false }
  })
}

export async function drainSchedulerReplacement(options, services = null) {
  return locked(options, async ctx => {
    const loaded = readOwned(options, ctx), record = loaded.record
    if (!['prepared', 'draining', 'stopping', 'stopped'].includes(record.step)) fail('worker_replacement_drain_phase_invalid')
    if (record.step === 'stopped') { assertNoWorker(options, record, ctx.before); return { currentState: 'stopped', reused: true } }
    const adapter = services || productionAdapter(options, loaded, ctx)
    if (record.step !== 'stopping') {
      await observe(options, ctx.before, record.before.pid, record.before.startedAt)
      update(loaded, 'draining')
      await core.drain(options.stateDir)
      await services?.afterDrain?.()
      const deadline = Date.now() + (options.waitMs ?? 30_000)
      while (true) {
        const current = await observe(options, ctx.before, record.before.pid, record.before.startedAt)
        if (current.leadership?.state === 'inactive' && current.leadership.activeJobs === 0
          && current.leaseVerified === false && !core.lease(ctx.before)) break
        if (Date.now() >= deadline) return { currentState: 'draining', nextAction: 'resume_same_operation_after_jobs_finish' }
        await sleep(100)
      }
      update(loaded, 'stopping')
    }
    if (core.alive(record.before.pid)) {
      assertPause(options, ctx.before); handoff(options, ctx.before, record.handoffSha256)
      await observe(options, ctx.before, record.before.pid, record.before.startedAt)
      await adapter.stop('before', record.before.pid)
    }
    const deadline = Date.now() + (options.waitMs ?? 30_000)
    while (core.alive(record.before.pid) || existsSync(join(options.stateDir, 'worker.sock'))) {
      if (Date.now() >= deadline) return { currentState: 'stopping', nextAction: 'resume_same_operation_after_owned_exit' }
      await sleep(50)
    }
    assertNoWorker(options, record, ctx.before)
    update(loaded, 'stopped')
    return { currentState: 'stopped', receiptSha256: loaded.sha256, reused: false }
  })
}

function databaseShape(context) {
  return context.query(db => ({ migrations: db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map(row => row.id),
    objects: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all()
      .map(({ sql, ...object }) => ({ ...object, sqlSha256: digest(sql) })),
    counts: Object.fromEntries(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations','n8n_video_stop_requests') ORDER BY name").all()
      .map(({ name }) => [name, db.prepare(`SELECT COUNT(*) n FROM "${name.replaceAll('"', '""')}"`).get().n])) }))
}
function verifySchemaDelta(before, after) {
  if (!same(after.migrations, [...new Set([...before.migrations, MIGRATION])].sort()) || !same(before.counts, after.counts)) fail('worker_replacement_database_scope_changed')
  for (const object of before.objects) if (!after.objects.some(value => same(value, object))) fail('worker_replacement_existing_schema_changed')
  if (after.objects.some(object => !before.objects.some(value => same(value, object))
    && !object.name.startsWith('n8n_video_stop_') && object.name !== 'idx_n8n_video_stop_requests_scope')) fail('worker_replacement_unexpected_schema_change')
}
function backupEvidence(options, context, pathname) {
  const loaded = core.privateFile(pathname), receipt = loaded.value
  if (receipt.schema !== 'video-autoworker-database-backup/v1' || receipt.sourceFingerprint === null
    || String(receipt.sourceIdentity?.dev) !== context.database.dev || String(receipt.sourceIdentity?.ino) !== context.database.ino
    || receipt.sourceIdentity?.pathSha256 !== context.database.pathSha256 || !/^snapshot-[A-Za-z0-9T-]+\.db$/u.test(receipt.file || '')) fail('worker_replacement_backup_invalid')
  const backup = join(dirname(pathname), receipt.file)
  const script = join(context.root, 'scripts/database-backup.py')
  const program = "import importlib.util,json,sys;from pathlib import Path;s=importlib.util.spec_from_file_location('verified_backup',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps({'validation':m.verify_snapshot(Path(sys.argv[3])),'fingerprint':m.source_fingerprint(Path(sys.argv[2]))}))"
  const evidence = JSON.parse(execFileSync(options.pythonBin || '/usr/bin/python3', ['-I', '-B', '-c', program, script, options.databasePath, backup], { encoding: 'utf8', maxBuffer: 1024 * 1024 }))
  if (!same(evidence.validation, receipt.validation)) fail('worker_replacement_backup_changed')
  return { path: pathname, receiptSha256: loaded.sha256, snapshotSha256: receipt.validation.sha256,
    sourceFingerprint: receipt.sourceFingerprint, currentFingerprint: evidence.fingerprint }
}

export async function prepareSchedulerReplacementDatabase(options, backupReceiptPath, services = {}) {
  return locked(options, async ctx => {
    const loaded = readOwned(options, ctx)
    if (!['stopped', 'schema_preparing', 'schema_prepared'].includes(loaded.record.step)) fail('worker_replacement_database_phase_invalid')
    assertNoWorker(options, loaded.record, ctx.before)
    const evidence = backupEvidence(options, ctx.target, backupReceiptPath)
    let before = loaded.record.databasePreparation?.before
    if (!before) {
      if (evidence.currentFingerprint !== evidence.sourceFingerprint) fail('worker_replacement_backup_not_current')
      before = databaseShape(ctx.before)
      update(loaded, 'schema_preparing', { databasePreparation: { before, backup: evidence } })
    } else if (loaded.record.databasePreparation.backup.receiptSha256 !== evidence.receiptSha256) fail('worker_replacement_backup_scope_changed')
    const environment = { ...process.env, NODE_ENV: 'production', MISSION_CONTROL_DB_PATH: options.databasePath }
    delete environment.MISSION_CONTROL_TEST_MODE
    delete environment.NEXT_PHASE
    const program = "const result=require(process.argv[1]).prepareExistingDatabase(process.argv[2]);process.stdout.write(JSON.stringify(result))"
    const prepared = JSON.parse(execFileSync(process.execPath,
      ['-e', program, join(ctx.target.root, 'database-runtime.cjs'), options.databasePath],
      { cwd: ctx.target.root, env: environment, encoding: 'utf8', maxBuffer: 65_536 }).trim())
    if (prepared.currentState !== 'prepared' || String(prepared.database?.dev) !== ctx.target.database.dev
      || String(prepared.database?.ino) !== ctx.target.database.ino) fail('worker_replacement_database_prepare_unconfirmed')
    const actual = lstatSync(options.databasePath)
    if (String(actual.dev) !== ctx.target.database.dev || String(actual.ino) !== ctx.target.database.ino
      || actual.isSymbolicLink() || realpathSync(options.databasePath) !== options.databasePath) fail('worker_replacement_database_changed')
    await services.afterPrepare?.()
    const after = databaseShape(ctx.target)
    verifySchemaDelta(before, after)
    update(loaded, 'schema_prepared', { databasePreparation: { ...loaded.record.databasePreparation,
      afterSha256: digest(after), schemaSha256: digest({ migrations: after.migrations, objects: after.objects }),
      preparedAt: Date.now(), database: ctx.target.database } })
    return { currentState: 'schema_prepared', receiptSha256: loaded.sha256, database: ctx.target.database }
  })
}

async function verifyTarget(options, loaded, ctx) {
  const current = await observe(options, ctx.target, loaded.record.target.pid ?? null, loaded.record.target.startedAt ?? null)
  if (!ready(current) || current.worker.startedAt < loaded.record.activationRequestedAt) fail('worker_replacement_target_not_ready')
  const shape = databaseShape(ctx.target)
  if (digest({ migrations: shape.migrations, objects: shape.objects }) !== loaded.record.databasePreparation?.schemaSha256) fail('worker_replacement_schema_changed')
  if (loaded.record.binding.service.kind === 'launchd') {
    assertSchedulerLaunchdReadiness(loaded.record.binding.service, ctx.target.root, current.worker.pid)
  }
  return current
}
export async function activateSchedulerReplacement(options, services = null) {
  return locked(options, async ctx => {
    const loaded = readOwned(options, ctx)
    if (!['schema_prepared', 'activation_requested', 'ready'].includes(loaded.record.step)) fail('worker_replacement_activation_phase_invalid')
    const adapter = services || productionAdapter(options, loaded, ctx)
    if (loaded.record.step === 'ready') { await verifyTarget(options, loaded, ctx); return { currentState: 'ready', reused: true } }
    if (core.alive(loaded.record.before.pid)) fail('worker_replacement_old_process_remaining')
    if (loaded.record.step !== 'activation_requested') {
      assertNoWorker(options, loaded.record, ctx.target)
      update(loaded, 'activation_requested', { activationRequestedAt: Date.now() })
    }
    if (!existsSync(join(options.stateDir, 'worker.sock'))) await adapter.start('target')
    const deadline = Date.now() + (options.waitMs ?? 30_000)
    let current
    while (true) {
      try { current = await verifyTarget(options, loaded, ctx); break } catch (error) {
        if (Date.now() >= deadline) throw error
        await sleep(100)
      }
    }
    update(loaded, 'ready', { target: { ...loaded.record.target, pid: current.worker.pid, startedAt: current.worker.startedAt } })
    return { currentState: 'ready', worker: loaded.record.target, receiptSha256: loaded.sha256, reused: false }
  })
}

export async function restoreSchedulerReplacement(options, services = null) {
  return locked(options, async ctx => {
    const loaded = readOwned(options, ctx), adapter = services || productionAdapter(options, loaded, ctx)
    if (loaded.record.step === 'completed') fail('worker_replacement_completed_restore_requires_new_operation')
    if (existsSync(join(options.stateDir, 'worker.sock'))) {
      const current = await readIndependentWorkerStatus(options.stateDir)
      if (current.worker?.contentSha256 === ctx.before.manifest.contentSha256 && ready(current)) {
        const isOriginal = current.worker.pid === loaded.record.before.pid && current.worker.startedAt === loaded.record.before.startedAt
        const isRestoring = loaded.record.step === 'restoring' && current.worker.startedAt >= loaded.record.restoreRequestedAt
        const isRestored = loaded.record.step === 'restored' && current.worker.pid === loaded.record.restoredWorker?.pid
          && current.worker.startedAt === loaded.record.restoredWorker?.startedAt
        if (!isOriginal && !isRestoring && !isRestored) fail('worker_replacement_previous_scope_changed')
        if (!services) assertSchedulerLaunchdOriginalService(loaded.record.binding.service)
        await observe(options, ctx.before, current.worker.pid, current.worker.startedAt)
        update(loaded, 'restored', { restoredWorker: { pid: current.worker.pid, startedAt: current.worker.startedAt } })
        return { currentState: 'restored', reused: true }
      }
      if (current.worker?.contentSha256 === ctx.before.manifest.contentSha256) {
        // stopScheduler is intentionally irreversible in one process. Finish
        // draining this exact original, then start a fresh original artifact.
        await observe(options, ctx.before, loaded.record.before.pid, loaded.record.before.startedAt)
        await core.drain(options.stateDir)
        const deadline = Date.now() + (options.waitMs ?? 30000)
        while (true) {
          const status = await observe(options, ctx.before, loaded.record.before.pid, loaded.record.before.startedAt)
          if (status.leadership?.state === 'inactive' && status.leadership.activeJobs === 0 && !core.lease(ctx.before)) break
          if (Date.now() >= deadline) return { currentState: 'draining', nextAction: 'resume_same_restore_after_original_jobs_finish' }
          await sleep(100)
        }
        assertPause(options, ctx.before)
        await adapter.stop('before', current.worker.pid)
        while (core.alive(current.worker.pid) || existsSync(join(options.stateDir, 'worker.sock'))) {
          if (Date.now() >= deadline) fail('worker_replacement_previous_exit_unconfirmed')
          await sleep(50)
        }
      } else {
      const target = await observe(options, ctx.target, loaded.record.target.pid ?? null, loaded.record.target.startedAt ?? null)
      if (target.worker.startedAt < loaded.record.activationRequestedAt) fail('worker_replacement_target_scope_changed')
      await core.drain(options.stateDir)
      const deadline = Date.now() + (options.waitMs ?? 30_000)
      while (true) {
        const status = await observe(options, ctx.target, target.worker.pid, target.worker.startedAt)
        if (status.leadership?.state === 'inactive' && status.leadership.activeJobs === 0 && !core.lease(ctx.target)) break
        if (Date.now() >= deadline) return { currentState: 'draining', nextAction: 'resume_same_restore_after_jobs_finish' }
        await sleep(100)
      }
      await adapter.stop('target', target.worker.pid)
      while (core.alive(target.worker.pid) || existsSync(join(options.stateDir, 'worker.sock'))) {
        if (Date.now() >= deadline) fail('worker_replacement_target_exit_unconfirmed')
        await sleep(50)
      }
      }
    }
    if (core.lease(ctx.before)) fail('worker_replacement_lease_remaining')
    // Same database, never a backup overwrite. The actual old artifact must
    // pass its production startup gate before restoration is acknowledged.
    update(loaded, 'restoring', { restoreRequestedAt: Date.now() })
    await adapter.start('before')
    const deadline = Date.now() + (options.waitMs ?? 30_000)
    while (true) {
      try {
        const status = await observe(options, ctx.before)
        if (!ready(status)) throw new Error('worker_replacement_previous_not_ready')
        update(loaded, 'restored', { restoredWorker: { pid: status.worker.pid, startedAt: status.worker.startedAt } })
        return { currentState: 'restored', worker: loaded.record.restoredWorker, receiptSha256: loaded.sha256 }
      } catch (error) { if (Date.now() >= deadline) throw error; await sleep(100) }
    }
  })
}

export async function completeSchedulerReplacement(options) {
  return locked(options, async ctx => {
    const loaded = readOwned(options, ctx, true)
    if (!['ready', 'restored', 'completed'].includes(loaded.record.step)) fail('worker_replacement_completion_phase_invalid')
    const outcome = loaded.record.step === 'completed' ? loaded.record.outcome : loaded.record.step
    if (outcome === 'ready') await verifyTarget(options, loaded, ctx)
    else {
      const status = await observe(options, ctx.before, loaded.record.restoredWorker.pid, loaded.record.restoredWorker.startedAt)
      if (!ready(status)) fail('worker_replacement_previous_not_ready')
    }
    if (loaded.record.step !== 'completed') update(loaded, 'completed', { outcome, completedAt: Date.now() })
    if (existsSync(loaded.paths.owner)) {
      if (core.privateFile(loaded.paths.owner).sha256 !== loaded.ownerSha256) fail('worker_replacement_owner_changed')
      unlinkSync(loaded.paths.owner)
    }
    const parent = openSync(loaded.paths.root, constants.O_RDONLY)
    try { fsyncSync(parent) } finally { closeSync(parent) }
    return { currentState: 'completed', outcome: loaded.record.outcome, receiptSha256: loaded.sha256 }
  })
}

async function main(argv) {
  const [command, ...rest] = argv, options = {}, names = { '--state-dir': 'stateDir', '--operation-id': 'operationId',
    '--old-manifest': 'oldManifestPath', '--target-manifest': 'targetManifestPath', '--database': 'databasePath', '--run-dir': 'runDirectory',
    '--expected-old-pid': 'expectedOldPid', '--target-commit': 'targetApplicationCommit', '--intake-revision': 'intakeRevision',
    '--intake-reason': 'intakeReason', '--plist': 'plistPath', '--target-plist': 'targetPlistPath',
    '--before-plist-sha256': 'beforeSha256', '--target-plist-sha256': 'targetSha256', '--backup-receipt': 'backupReceiptPath', '--python-bin': 'pythonBin',
    '--before-plist-recovery': 'beforeRecoveryPath' }
  for (let i = 0; i < rest.length; i += 2) {
    const key = names[rest[i]]
    if (!key || !rest[i + 1] || Object.hasOwn(options, key)) fail('worker_replacement_arguments_invalid')
    options[key] = ['expectedOldPid', 'intakeRevision'].includes(key) ? Number(rest[i + 1]) : rest[i + 1]
  }
  options.intake = { revision: options.intakeRevision, reason: options.intakeReason }
  if (!process.env.AIWORKER_BG_INTAKE_LOCK_LEASE) fail('worker_replacement_deployment_delegation_required')
  options.deploymentLease = JSON.parse(process.env.AIWORKER_BG_INTAKE_LOCK_LEASE)
  delete process.env.AIWORKER_BG_INTAKE_LOCK_LEASE
  options.service = { kind: 'launchd', label: LABEL, plistPath: options.plistPath, targetPlistPath: options.targetPlistPath,
    beforeSha256: options.beforeSha256, targetSha256: options.targetSha256, beforeRecoveryPath: options.beforeRecoveryPath }
  const actions = { prepare: prepareSchedulerReplacement, drain: drainSchedulerReplacement,
    activate: activateSchedulerReplacement, restore: restoreSchedulerReplacement, complete: completeSchedulerReplacement }
  const result = command === 'prepare-database' ? await prepareSchedulerReplacementDatabase(options, options.backupReceiptPath)
    : actions[command] ? await actions[command](options) : fail('worker_replacement_command_invalid')
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${JSON.stringify({ currentState: 'blocked', errorCode: /^worker_replacement_[a-z_]+$/u.test(error.message)
      ? error.message : 'worker_replacement_unconfirmed', nextAction: 'inspect_same_operation_without_releasing_intake' })}\n`)
    process.exitCode = 1
  })
}
