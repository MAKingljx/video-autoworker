#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { readIndependentWorkerStatus } from './lib/independent-worker-release.mjs'
import { acquireSharedDeploymentLockSync, verifySharedDeploymentLockDelegationSync } from './lib/shared-deployment-lock.mjs'
import { prepareSchedulerReplacement, drainSchedulerReplacement, prepareSchedulerReplacementDatabase,
  activateSchedulerReplacement, restoreSchedulerReplacement, completeSchedulerReplacement,
  validateSchedulerLaunchdReplacement } from './manage-scheduler-worker-replacement.mjs'

const arg = name => { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error('replacement_test_artifacts_required'); return realpathSync(process.argv[index + 1]) }
const beforeRoot = arg('--old-artifact'), targetRoot = arg('--target-artifact')
const pythonIndex = process.argv.indexOf('--python-bin'), pythonBin = pythonIndex >= 0 ? realpathSync(process.argv[pythonIndex + 1]) : '/usr/bin/python3'
const require = createRequire(join(beforeRoot, 'worker.cjs')), Database = require('better-sqlite3')
const launcher = fileURLToPath(new URL('./start-scheduler-worker.mjs', import.meta.url))
const sha = value => createHash('sha256').update(value).digest('hex')
const sleep = ms => new Promise(done => setTimeout(done, ms))
async function until(action) {
  const deadline = Date.now() + 12000
  let last
  while (Date.now() < deadline) {
    try { const result = await action(); if (result) return result } catch (error) { last = error }
    await sleep(50)
  }
  throw last || new Error('replacement_test_wait_expired')
}
async function fixture(run) {
  const root = realpathSync(mkdtempSync('/tmp/vaw-replacement-')), stateDir = join(root, 'state'), databasePath = join(root, 'mission.db')
  for (const part of ['state', 'openclaw', 'workspace', 'run']) mkdirSync(join(root, part), { mode: 0o700 })
  new Database(databasePath).close(); chmodSync(databasePath, 0o600)
  require('./database-runtime.cjs').prepareExistingDatabase(databasePath)
  const identity = lstatSync(databasePath), operationId = 'b'.repeat(64), reason = `isolated replacement [operation:${operationId}]`
  const db = new Database(databasePath)
  db.prepare(`INSERT INTO n8n_intake_controls(control_id,accepting,revision,reason,changed_by_id,changed_by_name)
    VALUES (1,0,7,?,0,'isolated-maintenance') ON CONFLICT(control_id)
    DO UPDATE SET accepting=0,revision=7,reason=excluded.reason`).run(reason)
  db.close()
  const handoffPath = join(stateDir, 'handoff.json')
  writeFileSync(handoffPath, JSON.stringify({ schema: 'video-autoworker-scheduler-handoff/v1', operationId: 'original-handoff',
    migrationPending: false, oldSchedulerStopped: true, oldSchedulerReleased: true, verifiedAt: Date.now(), completedAt: Date.now(),
    database: { dev: String(identity.dev), ino: String(identity.ino), pathSha256: sha(databasePath) } }), { mode: 0o600 })
  const handoffSha256 = sha(readFileSync(handoffPath)), envFile = join(root, 'platform.env')
  const configPath = join(root, 'openclaw/openclaw.json')
  writeFileSync(configPath, JSON.stringify({ agents: { list: [] } }), { mode: 0o600 })
  const environment = { MISSION_CONTROL_DB_PATH: databasePath, MISSION_CONTROL_DATA_DIR: root,
    MISSION_CONTROL_TOKENS_PATH: join(root, 'tokens.json'), OPENCLAW_STATE_DIR: join(root, 'openclaw'), OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_WORKSPACE_DIR: join(root, 'workspace'), MC_AUTH_MODE: 'openclaw-loopback', LOG_LEVEL: 'silent',
    AIWORKER_DATABASE_BACKUP_CONFIG: join(root, 'missing-backup.json') }
  writeFileSync(envFile, Object.entries(environment).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600 })
  const processes = [], starts = { before: 0, target: 0 }, faults = { stop: false, start: false }
  const start = side => {
    const artifact = side === 'before' ? beforeRoot : targetRoot
    const child = spawn(process.execPath, [launcher, '--artifact', artifact, '--state-dir', stateDir, '--env-file', envFile], {
      env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] })
    starts[side]++; let stderr = ''; child.stdout.resume(); child.stderr.on('data', bytes => { stderr += bytes })
    const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal, stderr })))
    processes.push({ child, exited, side }); return child.pid
  }
  const stop = async pid => {
    const owned = processes.find(value => value.child.pid === pid)
    assert.ok(owned)
    if (owned.child.exitCode === null) owned.child.kill('SIGTERM')
    const result = await owned.exited
    assert.equal(result.code, 0, result.stderr)
  }
  const services = { async stop(_side, pid) { await stop(pid); if (faults.stop) { faults.stop = false; throw new Error('lost stop response') } },
    async start(side) { const pid = start(side); if (faults.start) { faults.start = false; await until(async () => (await readIndependentWorkerStatus(stateDir)).healthy); throw new Error('lost start response') } return pid } }
  const oldPid = start('before')
  const options = { stateDir, operationId, databasePath, runDirectory: join(root, 'run'), oldManifestPath: join(beforeRoot, 'worker-manifest.json'),
    targetManifestPath: join(targetRoot, 'worker-manifest.json'), expectedOldPid: oldPid, targetApplicationCommit: 'a'.repeat(40),
    intake: { revision: 7, reason }, waitMs: 12000, pythonBin }
  const backup = () => {
    const config = join(root, 'backup-config.json')
    writeFileSync(config, JSON.stringify({ schema: 'video-autoworker-database-backup/v1',
      sources: [{ name: 'mission', database: databasePath, directory: join(root, 'snapshots') }] }), { mode: 0o600 })
    let report
    try { report = JSON.parse(execFileSync(pythonBin, [fileURLToPath(new URL('./database-backup.py', import.meta.url)),
      'run', '--config', config, '--source', 'mission', '--if-changed'], { encoding: 'utf8' })) }
    catch (error) { throw new Error(`isolated backup failed: ${error.stdout || ''} ${error.stderr || ''}`) }
    return report.result[0].file.replace(/\.db$/u, '.json')
  }
  const receipt = () => JSON.parse(readFileSync(join(stateDir, 'replacements', operationId, 'receipt.json'), 'utf8'))
  try { await until(async () => (await readIndependentWorkerStatus(stateDir)).healthy); await run({ root, options, services, faults, starts, backup, receipt, handoffPath, handoffSha256, envFile, stop, processes }) }
  finally {
    for (const owned of processes) if (owned.child.exitCode === null) {
      owned.child.kill('SIGTERM')
      let timer
      try { await Promise.race([owned.exited, new Promise(done => { timer = setTimeout(() => { if (owned.child.exitCode === null) owned.child.kill('SIGKILL'); done() }, 8000) })]) }
      finally { clearTimeout(timer) }
      await owned.exited
    }
    rmSync(root, { recursive: true, force: true })
  }
}

test('actual old worker drains, releases its lease, prepares 061 and is replaced on the same database', { timeout: 120000 }, async () => {
  await fixture(async ({ options, services, backup, receipt, handoffPath, handoffSha256 }) => {
    assert.equal((await prepareSchedulerReplacement(options, services)).currentState, 'prepared')
    assert.equal((await drainSchedulerReplacement(options, services)).currentState, 'stopped')
    let db = new Database(options.databasePath)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM scheduler_leader_leases').get().n, 0)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE id=?').get('061_n8n_video_stop_requests').n, 0); db.close()
    assert.equal((await prepareSchedulerReplacementDatabase(options, backup())).currentState, 'schema_prepared')
    const activated = await activateSchedulerReplacement(options, services)
    assert.equal(activated.currentState, 'ready'); assert.notEqual(activated.worker.pid, options.expectedOldPid)
    db = new Database(options.databasePath)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM scheduler_leader_leases').get().n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE id=?').get('061_n8n_video_stop_requests').n, 1)
    assert.deepEqual(db.prepare('SELECT accepting,revision,reason FROM n8n_intake_controls').get(), { accepting: 0, ...options.intake }); db.close()
    assert.equal(sha(readFileSync(handoffPath)), handoffSha256)
    assert.equal((await completeSchedulerReplacement(options)).outcome, 'ready')
    assert.equal((await completeSchedulerReplacement(options)).currentState, 'completed')
    assert.equal(receipt().step, 'completed')
  })
})

test('lost stop, migration and start responses resume from actual scoped state without a second start', { timeout: 120000 }, async () => {
  await fixture(async ({ options, services, faults, starts, backup, receipt, handoffPath, handoffSha256 }) => {
    await prepareSchedulerReplacement(options, services)
    faults.stop = true
    await assert.rejects(drainSchedulerReplacement(options, services), /lost stop response/u)
    assert.equal(receipt().step, 'stopping')
    await drainSchedulerReplacement(options, services)
    const recovery = backup()
    await assert.rejects(prepareSchedulerReplacementDatabase(options, recovery, { afterPrepare() { throw new Error('lost migration response') } }), /lost migration response/u)
    assert.equal(receipt().step, 'schema_preparing')
    await prepareSchedulerReplacementDatabase(options, recovery)
    faults.start = true
    await assert.rejects(activateSchedulerReplacement(options, services), /lost start response/u)
    assert.equal(receipt().step, 'activation_requested')
    assert.equal((await activateSchedulerReplacement(options, services)).currentState, 'ready')
    assert.equal(starts.target, 1); assert.equal(sha(readFileSync(handoffPath)), handoffSha256)
    await completeSchedulerReplacement(options)
  })
})

test('restore drains only its replacement, starts the real old artifact and preserves post-backup data and 061', { timeout: 120000 }, async () => {
  await fixture(async ({ options, services, backup, handoffPath, handoffSha256 }) => {
    await prepareSchedulerReplacement(options, services); await drainSchedulerReplacement(options, services)
    await prepareSchedulerReplacementDatabase(options, backup()); await activateSchedulerReplacement(options, services)
    let db = new Database(options.databasePath)
    const result = db.prepare(`INSERT INTO n8n_workflow_bindings(name,task_type,webhook_path,agent_role,model,enabled,
      timeout_seconds,retry_count,config,workspace_id,tenant_id) VALUES ('post-backup-survivor','general','isolated','executor','test',0,30,0,'{}',1,1)`).run()
    const id = Number(result.lastInsertRowid); db.close()
    assert.equal((await restoreSchedulerReplacement(options, services)).currentState, 'restored')
    const live = await readIndependentWorkerStatus(options.stateDir)
    assert.equal(live.healthy, true)
    assert.equal(live.worker.contentSha256, JSON.parse(readFileSync(options.oldManifestPath)).contentSha256)
    db = new Database(options.databasePath)
    assert.equal(db.prepare('SELECT name FROM n8n_workflow_bindings WHERE id=?').get(id).name, 'post-backup-survivor')
    assert.equal(db.prepare('SELECT COUNT(*) n FROM schema_migrations WHERE id=?').get('061_n8n_video_stop_requests').n, 1); db.close()
    assert.equal(sha(readFileSync(handoffPath)), handoffSha256)
    assert.equal((await completeSchedulerReplacement(options)).outcome, 'restored')
  })
})

test('another operation and an intake CAS change are rejected before stopping the real old worker', { timeout: 120000 }, async () => {
  await fixture(async ({ options, services }) => {
    await prepareSchedulerReplacement(options, services)
    await assert.rejects(drainSchedulerReplacement({ ...options, operationId: 'c'.repeat(64) }, services))
    const db = new Database(options.databasePath); db.prepare('UPDATE n8n_intake_controls SET revision=8').run(); db.close()
    await assert.rejects(drainSchedulerReplacement(options, services), /worker_replacement_intake_changed/u)
    assert.equal((await readIndependentWorkerStatus(options.stateDir)).worker.pid, options.expectedOldPid)
    assert.equal((await readIndependentWorkerStatus(options.stateDir)).healthy, true)
  })
})

test('the Web shared deployment lock excludes replacement and delegation remains owned by the controller', { timeout: 120000 }, async () => {
  await fixture(async ({ options, services }) => {
    const lease = acquireSharedDeploymentLockSync({ runDirectory: options.runDirectory })
    try {
      await assert.rejects(prepareSchedulerReplacement(options, services), /another shared deployment operation is active/u)
      assert.equal((await readIndependentWorkerStatus(options.stateDir)).worker.pid, options.expectedOldPid)
      const delegated = { ...options, deploymentLease: lease.descriptor }
      assert.equal((await prepareSchedulerReplacement(delegated, services)).currentState, 'prepared')
      const owner = JSON.parse(lease.descriptor.ownerSource)
      verifySharedDeploymentLockDelegationSync({ runDirectory: options.runDirectory, ownerPid: lease.ownerPid,
        ownerNonce: owner.nonce, expectedLease: lease.descriptor }).assertCurrent()
      assert.equal(existsSync(lease.path), true)
    } finally { lease.release() }
  })
})

test('a real killed prepare recovers its orphan receipt and dead locks without touching the running original', { timeout: 120000 }, async () => {
  await fixture(async ({ root, options, services, processes }) => {
    const marker = join(root, 'prepare-effect-observed')
    const moduleUrl = new URL('./manage-scheduler-worker-replacement.mjs', import.meta.url).href
    const program = `import{writeFileSync}from'node:fs';import{prepareSchedulerReplacement}from ${JSON.stringify(moduleUrl)};const options=JSON.parse(process.argv[1]);await prepareSchedulerReplacement(options,{afterPreparedReceipt:()=>new Promise(()=>{writeFileSync(process.argv[2],'ready',{mode:0o600});setInterval(()=>{},1000)})});`
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, JSON.stringify(options), marker], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''; child.stdout.resume(); child.stderr.on('data', part => { stderr += part })
    const exited = new Promise(done => child.once('exit', (code, signal) => done({ code, signal, stderr })))
    processes.push({ child, exited, side: 'prepare-helper' })
    await until(() => { if (child.exitCode !== null) throw new Error(stderr); return existsSync(marker) })
    assert.equal(existsSync(join(options.stateDir, 'replacements/owner.json')), false)
    assert.equal((await readIndependentWorkerStatus(options.stateDir)).worker.pid, options.expectedOldPid)
    child.kill('SIGKILL'); await exited
    const recovered = await prepareSchedulerReplacement(options, services)
    assert.equal(recovered.currentState, 'prepared'); assert.equal(recovered.recoveredPrepare, true)
    assert.equal((await readIndependentWorkerStatus(options.stateDir)).healthy, true)
    assert.equal((await restoreSchedulerReplacement(options, services)).currentState, 'restored')
    await completeSchedulerReplacement(options)
    assert.equal(existsSync(join(options.stateDir, 'handoff.lock')), false)
  })
})

test('restoring while the actual original is draining restarts that original rather than treating it as the target', { timeout: 120000 }, async () => {
  await fixture(async ({ options, services, starts, handoffPath, handoffSha256 }) => {
    await prepareSchedulerReplacement(options, services)
    await assert.rejects(drainSchedulerReplacement(options, { ...services, afterDrain() { throw new Error('interrupted after drain request') } }), /interrupted after drain request/u)
    const draining = await readIndependentWorkerStatus(options.stateDir)
    assert.equal(draining.worker.pid, options.expectedOldPid); assert.equal(draining.currentState, 'draining')
    const result = await restoreSchedulerReplacement(options, services)
    assert.equal(result.currentState, 'restored'); assert.equal(starts.before, 2); assert.equal(starts.target, 0)
    assert.equal(sha(readFileSync(handoffPath)), handoffSha256)
    await completeSchedulerReplacement(options)
  })
})

test('the real launchd adapter validates only its old/target plist and rejects unscoped configuration changes', { timeout: 120000 }, async () => {
  await fixture(async ({ root, options, envFile }) => {
    const before = { Label: 'com.aiworker.scheduler-worker', ProgramArguments: [process.execPath, launcher, '--artifact', beforeRoot,
      '--state-dir', options.stateDir, '--env-file', envFile], WorkingDirectory: beforeRoot, KeepAlive: true, RunAtLoad: true }
    const target = { ...before, ProgramArguments: [...before.ProgramArguments], WorkingDirectory: targetRoot }
    target.ProgramArguments[3] = targetRoot
    const oldPath = join(root, 'old.plist'), targetPath = join(root, 'target.plist'), recoveryPath = join(root, 'existing-recovery.plist')
    writeFileSync(oldPath, JSON.stringify(before), { mode: 0o600 }); writeFileSync(targetPath, JSON.stringify(target), { mode: 0o600 })
    writeFileSync(recoveryPath, JSON.stringify(before), { mode: 0o600 })
    const service = { kind: 'launchd', label: before.Label, plistPath: oldPath, targetPlistPath: targetPath,
      beforeSha256: sha(readFileSync(oldPath)), targetSha256: sha(readFileSync(targetPath)), beforeRecoveryPath: recoveryPath }
    assert.equal(validateSchedulerLaunchdReplacement({ ...options, service }).targetSha256, service.targetSha256)
    assert.throws(() => validateSchedulerLaunchdReplacement({ ...options, service: { ...service, beforeRecoveryPath: null } }), /worker_replacement_existing_plist_recovery_required/u)
    writeFileSync(recoveryPath, JSON.stringify({ ...before, KeepAlive: false }), { mode: 0o600 })
    assert.throws(() => validateSchedulerLaunchdReplacement({ ...options, service }), /worker_replacement_plist_recovery_mismatch/u)
    writeFileSync(recoveryPath, JSON.stringify(before), { mode: 0o600 })
    writeFileSync(targetPath, JSON.stringify({ ...target, EnvironmentVariables: { UNSCOPED: 'changed' } }), { mode: 0o600 })
    assert.throws(() => validateSchedulerLaunchdReplacement({ ...options, service: { ...service, targetSha256: sha(readFileSync(targetPath)) } }), /worker_replacement_unscoped_service_change/u)
  })
})
