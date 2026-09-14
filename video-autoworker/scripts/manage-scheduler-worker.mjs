#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditSchedulerWorkerArtifact } from './start-scheduler-worker.mjs'
import { readIndependentWorkerStatus } from './lib/independent-worker-release.mjs'

const SCHEMA = 'video-autoworker-scheduler-handoff/v1'
const LABEL = 'com.aiworker.scheduler-worker'
const SHA = /^[a-f0-9]{64}$/u
const sha = value => createHash('sha256').update(value).digest('hex')
const sleep = ms => new Promise(done => setTimeout(done, ms))
const fail = code => { throw new Error(code) }

function privateFile(pathname) {
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > 65_536 || (stat.mode & 0o077)
      || stat.uid !== process.getuid()) fail('worker_handoff_file_unsafe')
    const bytes = readFileSync(fd)
    return { bytes, sha256: sha(bytes), value: JSON.parse(bytes.toString('utf8')) }
  } finally { closeSync(fd) }
}

function stateRoot(root) {
  const info = lstatSync(root)
  if (!isAbsolute(root) || realpathSync(root) !== root || !info.isDirectory()
    || info.isSymbolicLink() || (info.mode & 0o077) || info.uid !== process.getuid()) fail('worker_handoff_state_unsafe')
}

async function withLock(options, action) {
  stateRoot(options.stateDir)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(options.operationId || '')) fail('worker_handoff_operation_invalid')
  const pathname = join(options.stateDir, 'handoff.lock')
  const fd = openSync(pathname, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  const identity = fstatSync(fd)
  try {
    writeFileSync(fd, JSON.stringify({ operationId: options.operationId, pid: process.pid }))
    fsyncSync(fd)
    return await action()
  } finally {
    closeSync(fd)
    const current = lstatSync(pathname)
    if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(pathname)
  }
}

function context(options) {
  const { root, manifest } = auditSchedulerWorkerArtifact(dirname(options.manifestPath))
  if (resolve(options.manifestPath) !== join(root, 'worker-manifest.json')) fail('worker_handoff_manifest_path_invalid')
  const stat = lstatSync(options.databasePath)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.uid !== process.getuid()) {
    fail('worker_handoff_database_unsafe')
  }
  const database = { dev: String(stat.dev), ino: String(stat.ino), pathSha256: sha(realpathSync(options.databasePath)) }
  const require = createRequire(join(root, 'worker.cjs'))
  const Database = require('better-sqlite3')
  const query = read => {
    const db = new Database(options.databasePath, { readonly: true, fileMustExist: true })
    try { return read(db) } finally { db.close() }
  }
  return { root, manifest, database, query }
}

function equalDatabase(expected, actual) {
  return ['dev', 'ino', 'pathSha256'].every(key => expected?.[key] === actual?.[key])
}

function lease(context) {
  return context.query(db => db.prepare(`SELECT holder_id,revision,lease_expires_at
    FROM scheduler_leader_leases WHERE lease_name='builtin_scheduler'`).get())
}

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

function processIdentity(pid, { cwd, databasePath, port, commandFragments = [] }) {
  if (!Number.isSafeInteger(pid) || pid < 1 || !alive(pid)) fail('worker_handoff_process_unavailable')
  const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })
  if (commandFragments.some(fragment => !command.includes(fragment))) fail('worker_handoff_process_command_mismatch')
  const current = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
  if (!current.split('\n').includes(`n${realpathSync(cwd)}`)) fail('worker_handoff_process_cwd_mismatch')
  const opened = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), '-Fp', '--', databasePath], { encoding: 'utf8' })
  if (!opened.split('\n').includes(`p${pid}`)) fail('worker_handoff_process_database_mismatch')
  if (port) {
    const listening = execFileSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { encoding: 'utf8' })
    if (!listening.split('\n').includes(`p${pid}`)) fail('worker_handoff_process_port_mismatch')
  }
}

function webUrl(raw) {
  const parsed = new URL(raw)
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.search || parsed.hash
    || !parsed.port || (parsed.pathname !== '/' && parsed.pathname !== '')) fail('worker_handoff_web_url_invalid')
  return parsed.origin
}

async function readWeb(base, path) {
  const response = await fetch(`${webUrl(base)}${path}`, { redirect: 'error', signal: AbortSignal.timeout(5_000) })
  if (!response.ok) fail('worker_handoff_web_probe_failed')
  const text = await response.text()
  if (Buffer.byteLength(text) > 65_536) fail('worker_handoff_web_probe_too_large')
  return JSON.parse(text)
}

function readOwnedHandoff(options, context) {
  const old = privateFile(join(options.stateDir, 'handoff.json'))
  if (old.value.schema !== SCHEMA || old.value.operationId !== options.operationId
    || !equalDatabase(old.value.database, context.database)) fail('worker_handoff_scope_mismatch')
  if (old.value.targetWorkerContentSha256 !== context.manifest.contentSha256) fail('worker_handoff_manifest_mismatch')
  return old
}

async function currentWorker(options, context) {
  if (!Number.isSafeInteger(options.expectedPid) || options.expectedPid < 1
    || !SHA.test(options.expectedContentSha256 || '')
    || options.expectedContentSha256 !== context.manifest.contentSha256) fail('worker_handoff_expected_identity_invalid')
  const status = await readIndependentWorkerStatus(options.stateDir)
  if (status.schema !== 'video-autoworker-scheduler-worker/v1' || status.executionMode !== 'external-worker'
    || status.worker?.pid !== options.expectedPid || status.worker?.contentSha256 !== options.expectedContentSha256
    || status.handoff?.operationId !== options.operationId || !equalDatabase(status.worker?.database, context.database)
    || !Number.isSafeInteger(status.observedAt) || Math.abs(Date.now() - status.observedAt) > 15_000) {
    fail('worker_handoff_live_identity_mismatch')
  }
  processIdentity(options.expectedPid, { cwd: context.root, databasePath: options.databasePath,
    commandFragments: ['start-scheduler-worker.mjs', context.root, options.stateDir] })
  return status
}

function atomicReceipt(options, old, value) {
  const pathname = join(options.stateDir, 'handoff.json')
  if (old && privateFile(pathname).sha256 !== old.sha256) fail('worker_handoff_cas_conflict')
  if (!old && existsSync(pathname)) fail('worker_handoff_already_exists')
  if (old) {
    const backup = join(options.stateDir, 'handoff.previous.json')
    const pendingBackup = `${backup}.${randomUUID()}.tmp`
    writeFileSync(pendingBackup, old.bytes, { flag: 'wx', mode: 0o600 })
    if (sha(readFileSync(pendingBackup)) !== old.sha256) fail('worker_handoff_backup_mismatch')
    renameSync(pendingBackup, backup)
  }
  const pending = `${pathname}.${randomUUID()}.tmp`
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
  const fd = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  if (old && privateFile(pathname).sha256 !== old.sha256) { unlinkSync(pending); fail('worker_handoff_cas_conflict') }
  renameSync(pending, pathname)
  const readback = privateFile(pathname)
  if (readback.sha256 !== sha(bytes)) fail('worker_handoff_readback_mismatch')
  return readback.sha256
}

export async function prepareSchedulerHandoff(options) {
  return withLock(options, async () => {
    const ctx = context(options)
    if (!/^[a-f0-9]{40}$/.test(options.targetApplicationCommit || '')) fail('worker_handoff_target_commit_invalid')
    const pathname = join(options.stateDir, 'handoff.json')
    if (existsSync(pathname)) {
      const existing = readOwnedHandoff(options, ctx)
      if (existing.value.targetApplicationCommit !== options.targetApplicationCommit
        || existing.value.migrationPending !== true) fail('worker_handoff_existing_state_conflict')
      return { currentState: 'prepared', operationId: options.operationId, receiptSha256: existing.sha256, reused: true }
    }
    const router = privateFile(options.routerStatePath)
    const state = router.value
    const oldWebUrl = webUrl(options.oldWebUrl)
    const active = state.slots?.[state.active]
    if (state.schema !== 'video-autoworker-standalone-router/v1' || !['blue', 'green'].includes(state.active)
      || !Number.isSafeInteger(state.generation) || state.generation < 1
      || !active || Number(new URL(oldWebUrl).port) !== active.port) fail('worker_handoff_router_invalid')
    processIdentity(options.oldWebPid, { cwd: options.oldWebCwd,
      databasePath: options.databasePath, port: active.port })
    const readiness = (await readWeb(oldWebUrl, '/api/n8n/release-readiness')).readiness
    if (readiness?.schema !== 'video-autoworker-release-readiness/v1' || readiness.globalScope !== true || readiness.intake?.accepting !== false
      || readiness.intake?.counts?.active !== 0 || readiness.scheduler?.state !== 'leader'
      || readiness.scheduler.activeJobs !== 0 || readiness.scheduler.leaseExpired !== false
      || readiness.scheduler.routerGeneration !== state.generation
      || readiness.runtime?.runtimeSlot !== state.active || readiness.runtime?.runtimeReleaseId !== active.releaseId
      || readiness.runtime?.port !== active.port
      || Math.abs(Date.now() / 1_000 - readiness.observedAt) > 15) fail('worker_handoff_old_runtime_not_quiet')
    const observed = ctx.query(db => ({
      gate: db.prepare('SELECT accepting,revision FROM n8n_intake_controls WHERE control_id=1').get(),
      active: db.prepare("SELECT COUNT(*) AS n FROM n8n_task_runs WHERE status IN ('queued','accepted','running')").get().n,
      lease: db.prepare("SELECT holder_id,revision,lease_expires_at FROM scheduler_leader_leases WHERE lease_name='builtin_scheduler'").get(),
    }))
    if (observed.gate?.accepting !== 0 || observed.gate.revision !== readiness.intake.revision || observed.active !== 0
      || !observed.lease || observed.lease.lease_expires_at <= Date.now() / 1_000
      || observed.lease.lease_expires_at !== readiness.scheduler.leaseExpiresAt
      || privateFile(options.routerStatePath).sha256 !== router.sha256) fail('worker_handoff_source_changed')
    const receipt = { schema: SCHEMA, operationId: options.operationId, verifiedAt: Date.now(),
      targetApplicationCommit: options.targetApplicationCommit, targetWorkerContentSha256: ctx.manifest.contentSha256,
      database: ctx.database, migrationPending: true, oldSchedulerStopped: false,
      previous: { pid: options.oldWebPid, slot: state.active, releaseId: active.releaseId,
        routerGeneration: state.generation, leaseHolderId: observed.lease.holder_id,
        leaseRevision: observed.lease.revision, webUrl: oldWebUrl, cwd: realpathSync(options.oldWebCwd) },
      evidence: { intakeRevision: observed.gate.revision, routerSha256: router.sha256 } }
    const receiptSha256 = atomicReceipt(options, null, receipt)
    return { currentState: 'prepared', operationId: options.operationId, receiptSha256, reused: false }
  })
}

export async function completeSchedulerHandoff(options) {
  return withLock(options, async () => {
    const ctx = context(options)
    const old = readOwnedHandoff(options, ctx)
    const worker = await currentWorker(options, ctx)
    if (worker.handoff?.targetApplicationCommit !== old.value.targetApplicationCommit) fail('worker_handoff_target_commit_mismatch')
    if (!worker.healthy || !worker.leaseVerified || worker.leadership?.state !== 'leader'
      || worker.currentState !== 'ready') fail('worker_handoff_worker_not_ready')
    if (old.value.migrationPending !== true) {
      if (old.value.completedAt && old.value.oldSchedulerReleased === true) {
        return { currentState: 'completed', operationId: options.operationId, receiptSha256: old.sha256, reused: true }
      }
      fail('worker_handoff_not_pending')
    }
    const previous = old.value.previous
    let oldSchedulerStopped = !alive(previous.pid)
    if (!oldSchedulerStopped) {
      processIdentity(previous.pid, { cwd: previous.cwd, databasePath: options.databasePath,
        port: Number(new URL(previous.webUrl).port) })
      const response = await readWeb(previous.webUrl, '/api/scheduler')
      const status = response.webLeadership || response.leadership
      if (status?.state !== 'inactive' || status.activeJobs !== 0 || status.leaseExpiresAt !== null) {
        fail('worker_handoff_previous_scheduler_active')
      }
    }
    const currentLease = lease(ctx)
    if (!currentLease || currentLease.holder_id === previous.leaseHolderId
      || currentLease.lease_expires_at <= Date.now() / 1_000) fail('worker_handoff_lease_not_transferred')
    const finalWorker = await currentWorker(options, ctx)
    if (!finalWorker.healthy || !finalWorker.leaseVerified) fail('worker_handoff_worker_changed')
    const completed = { ...old.value, migrationPending: false, oldSchedulerStopped,
      oldSchedulerReleased: true, completedAt: Date.now(), completedWorker: {
        pid: options.expectedPid, startedAt: worker.worker.startedAt, contentSha256: options.expectedContentSha256,
      } }
    // Retain the prior receipt privately; completed restarts no longer inspect old PID/holder.
    const receiptSha256 = atomicReceipt(options, old, completed)
    return { currentState: 'completed', operationId: options.operationId, receiptSha256, reused: false }
  })
}

function drain(stateDir) {
  return new Promise((done, reject) => {
    const request = http.request({ socketPath: join(stateDir, 'worker.sock'), path: '/drain', method: 'POST' }, response => {
      response.resume()
      response.on('end', () => response.statusCode === 200 ? done() : reject(new Error('worker_handoff_drain_failed')))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.setTimeout(5_000, () => request.destroy(new Error('worker_handoff_drain_timeout')))
    request.end('{}')
  })
}

function stopOwnedWorker(options, ctx) {
  processIdentity(options.expectedPid, { cwd: ctx.root, databasePath: options.databasePath,
    commandFragments: ['start-scheduler-worker.mjs', ctx.root, options.stateDir] })
  const service = `gui/${process.getuid()}/${LABEL}`
  let loaded = null
  if (process.platform === 'darwin') {
    try { loaded = execFileSync('/bin/launchctl', ['print', service], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) {
      if (!/Could not find service|service not found|No such process/iu.test(String(error.stderr || ''))) throw error
    }
  }
  if (loaded !== null) {
    if (!new RegExp(`\\bpid = ${options.expectedPid}\\b`, 'u').test(loaded)
      || !loaded.includes(ctx.root) || !loaded.includes(options.stateDir)
      || !loaded.includes('start-scheduler-worker.mjs')) fail('worker_handoff_launchd_identity_mismatch')
    execFileSync('/bin/launchctl', ['bootout', service], { stdio: ['ignore', 'pipe', 'pipe'] })
    return 'launchd'
  }
  process.kill(options.expectedPid, 'SIGTERM')
  return 'process'
}

export async function rollbackSchedulerHandoff(options) {
  return withLock(options, async () => {
    const ctx = context(options)
    const old = readOwnedHandoff(options, ctx)
    if (old.value.rolledBackAt && old.value.migrationPending === false) {
      if (old.value.rollback?.workerPid !== options.expectedPid
        || options.expectedContentSha256 !== ctx.manifest.contentSha256
        || alive(options.expectedPid) || existsSync(join(options.stateDir, 'worker.sock'))) {
        fail('worker_handoff_rollback_readback_changed')
      }
      const remaining = lease(ctx)
      const oldWorkerHash = old.value.rollback.workerLeaseHolderSha256
      if (remaining && ((oldWorkerHash && sha(remaining.holder_id) === oldWorkerHash)
        || (!oldWorkerHash && remaining.holder_id !== old.value.previous?.leaseHolderId))) {
        fail('worker_handoff_rollback_lease_remaining')
      }
      return { currentState: 'worker-stopped', operationId: options.operationId, receiptSha256: old.sha256,
        workerStopped: true, oldWebRestored: false, reused: true,
        nextAction: 'restore_previous_web_then_verify_its_leadership' }
    }
    if (old.value.migrationPending !== true || old.value.completedAt) fail('worker_handoff_rollback_not_pending')
    const initial = await currentWorker(options, ctx)
    if (initial.handoff?.targetApplicationCommit !== old.value.targetApplicationCommit) fail('worker_handoff_target_commit_mismatch')
    const initialLease = lease(ctx)
    const workerLeaseHolderSha256 = initial.leaseVerified && initialLease ? sha(initialLease.holder_id) : null
    await drain(options.stateDir)
    const deadline = Date.now() + (options.waitMs ?? 30_000)
    while (true) {
      const status = await currentWorker(options, ctx)
      if (status.leadership?.state === 'inactive' && status.leadership.activeJobs === 0
        && status.leaseVerified === false) break
      if (Date.now() >= deadline) return { currentState: 'draining', operationId: options.operationId,
        nextAction: 'continue_same_rollback_after_owned_jobs_finish', workerStopped: false, oldWebRestored: false }
      await sleep(100)
    }
    if (privateFile(join(options.stateDir, 'handoff.json')).sha256 !== old.sha256) fail('worker_handoff_cas_conflict')
    const manager = stopOwnedWorker(options, ctx)
    while (alive(options.expectedPid) || existsSync(join(options.stateDir, 'worker.sock'))) {
      if (Date.now() >= deadline) fail('worker_handoff_stop_not_observed')
      await sleep(100)
    }
    const remainingLease = lease(ctx)
    if (remainingLease && remainingLease.holder_id !== old.value.previous?.leaseHolderId
      && remainingLease.lease_expires_at > Date.now() / 1_000) fail('worker_handoff_unexpected_lease_holder')
    const rolledBack = { ...old.value, migrationPending: false, oldSchedulerStopped: false,
      oldSchedulerReleased: false, rolledBackAt: Date.now(), rollback: {
        workerPid: options.expectedPid, workerLeaseHolderSha256, manager,
      } }
    const receiptSha256 = atomicReceipt(options, old, rolledBack)
    return { currentState: 'worker-stopped', operationId: options.operationId, receiptSha256,
      workerStopped: true, oldWebRestored: false, reused: false,
      nextAction: 'restore_previous_web_then_verify_its_leadership' }
  })
}

async function main(argv) {
  const [command, ...rest] = argv
  const names = { '--state-dir': 'stateDir', '--operation-id': 'operationId', '--manifest': 'manifestPath',
    '--database': 'databasePath', '--router-state': 'routerStatePath', '--old-web-url': 'oldWebUrl',
    '--old-web-pid': 'oldWebPid', '--old-web-cwd': 'oldWebCwd', '--target-application-commit': 'targetApplicationCommit',
    '--expected-pid': 'expectedPid', '--expected-content-sha256': 'expectedContentSha256', '--wait-ms': 'waitMs' }
  const values = {}
  for (let i = 0; i < rest.length; i += 2) {
    const key = names[rest[i]]
    if (!key || !rest[i + 1] || Object.hasOwn(values, key)) fail('worker_handoff_arguments_invalid')
    values[key] = ['oldWebPid', 'expectedPid', 'waitMs'].includes(key) ? Number(rest[i + 1]) : rest[i + 1]
  }
  if (!['stateDir', 'operationId', 'manifestPath', 'databasePath'].every(key => values[key])) fail('worker_handoff_arguments_required')
  const action = { 'prepare-handoff': prepareSchedulerHandoff,
    'complete-handoff': completeSchedulerHandoff, 'rollback-handoff': rollbackSchedulerHandoff }[command]
  if (!action) fail('worker_handoff_command_invalid')
  process.stdout.write(`${JSON.stringify(await action(values))}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${JSON.stringify({ currentState: 'blocked', errorCode: /^worker_handoff_[a-z_]+$/u.test(error.message)
      ? error.message : 'worker_handoff_probe_failed', nextAction: 'inspect_scoped_handoff_evidence' })}\n`)
    process.exitCode = 1
  })
}
