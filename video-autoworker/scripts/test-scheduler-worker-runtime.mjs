#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { auditSchedulerWorkerArtifact } from './start-scheduler-worker.mjs'
import { prepareSchedulerHandoff, completeSchedulerHandoff, rollbackSchedulerHandoff } from './manage-scheduler-worker.mjs'

const index = process.argv.indexOf('--artifact')
if (index < 0 || !process.argv[index + 1]) throw new Error('worker_test_artifact_required')
const artifact = resolve(process.argv[index + 1])
const launcher = fileURLToPath(new URL('./start-scheduler-worker.mjs', import.meta.url))
const runtimeRequire = createRequire(join(artifact, 'worker.cjs'))
const Database = runtimeRequire('better-sqlite3')
const { prepareExistingDatabase } = runtimeRequire('./database-runtime.cjs')
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

function socketRequest(socketPath, pathname, body) {
  return new Promise((done, reject) => {
    const request = http.request({ socketPath, path: pathname, method: body === undefined ? 'GET' : 'POST' }, response => {
      let content = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { content += chunk })
      response.on('end', () => done({ code: response.statusCode, body: JSON.parse(content) }))
      response.on('error', reject)
    })
    request.on('error', reject)
    request.setTimeout(2_000, () => request.destroy(new Error('test_request_timeout')))
    request.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

async function waitFor(fn) {
  const end = Date.now() + 12_000
  let last
  while (Date.now() < end) {
    try { const value = await fn(); if (value) return value } catch (error) { last = error }
    await sleep(50)
  }
  throw last || new Error('worker_test_wait_timeout')
}

function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/vaw-worker-'))
  const state = join(root, 'state')
  mkdirSync(state, { mode: 0o700 })
  mkdirSync(join(root, 'openclaw'), { mode: 0o700 })
  mkdirSync(join(root, 'workspace'), { mode: 0o700 })
  const databasePath = join(root, 'mission-control.db')
  new Database(databasePath).close()
  chmodSync(databasePath, 0o600)
  prepareExistingDatabase(databasePath)
  const stat = lstatSync(databasePath)
  const database = { dev: String(stat.dev), ino: String(stat.ino),
    pathSha256: createHash('sha256').update(realpathSync(databasePath)).digest('hex') }
  const envPath = join(root, 'platform.env')
  const configPath = join(root, 'openclaw', 'openclaw.json')
  writeFileSync(configPath, JSON.stringify({ agents: { list: [] } }), { mode: 0o600 })
  const values = { MISSION_CONTROL_DB_PATH: databasePath, MISSION_CONTROL_DATA_DIR: root,
    MISSION_CONTROL_TOKENS_PATH: join(root, 'tokens.json'), OPENCLAW_STATE_DIR: join(root, 'openclaw'),
    OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_WORKSPACE_DIR: join(root, 'workspace'),
    MC_AUTH_MODE: 'openclaw-loopback', LOG_LEVEL: 'silent',
    AIWORKER_DATABASE_BACKUP_CONFIG: join(root, 'missing-backup.json') }
  writeFileSync(envPath, Object.entries(values).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600 })
  const handoff = { schema: 'video-autoworker-scheduler-handoff/v1', operationId: 'isolated-test',
    verifiedAt: Date.now(), oldSchedulerStopped: true, database,
    targetWorkerContentSha256: JSON.parse(readFileSync(join(artifact, 'worker-manifest.json'), 'utf8')).contentSha256,
    targetApplicationCommit: 'a'.repeat(40) }
  const writeHandoff = value => writeFileSync(join(state, 'handoff.json'), JSON.stringify(value), { mode: 0o600 })
  writeHandoff(handoff)
  return { root, state, databasePath, envPath, handoff, writeHandoff, socket: join(state, 'worker.sock') }
}

function start(fixture) {
  const child = spawn(process.execPath, [launcher, '--artifact', artifact, '--state-dir', fixture.state,
    '--env-file', fixture.envPath], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: fixture.root } })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.resume()
  const exited = new Promise(resolveExit => child.once('exit', (code, signal) => resolveExit({ code, signal, stderr })))
  return { child, exited }
}

async function terminate(process) {
  if (process.child.exitCode === null) process.child.kill('SIGTERM')
  let timer
  try {
    return await Promise.race([process.exited, new Promise((_, reject) => {
      timer = setTimeout(() => { process.child.kill('SIGKILL'); reject(new Error('worker_did_not_drain')) }, 8_000)
    })])
  } finally { clearTimeout(timer) }
}

test('isolated artifact opens the existing database, relays events, rejects duplicates and drains', async () => {
  auditSchedulerWorkerArtifact(artifact)
  const f = fixture()
  // A completed migration is a database/ownership proof, not a permanent pin
  // to the worker artifact that happened to perform the initial migration.
  f.writeHandoff({ ...f.handoff, targetWorkerContentSha256: 'c'.repeat(64) })
  const worker = start(f)
  let stream
  try {
    const ready = await waitFor(async () => {
      const response = await socketRequest(f.socket, '/status')
      return response.body.healthy ? response.body : null
    })
    assert.equal(ready.executionMode, 'external-worker')
    assert.equal(ready.leadership.routerGeneration, null)
    assert.equal(ready.leaseVerified, true)
    assert.deepEqual(ready.worker.database, f.handoff.database)
    const db = new Database(f.databasePath)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM scheduler_leader_leases').get().n, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM n8n_task_runs').get().n, 0)
    db.close()
    const duplicate = start(f)
    const result = await duplicate.exited
    assert.equal(result.code, 1)
    assert.match(result.stderr, /scheduler_worker_already_running/)
    const received = new Promise((done, reject) => {
      stream = http.get({ socketPath: f.socket, path: '/events' }, response => {
        let input = ''
        response.setEncoding('utf8')
        response.on('data', chunk => {
          input += chunk
          const line = input.trim()
          if (line) { done(JSON.parse(line)); response.destroy() }
        })
        response.on('error', reject)
      })
      stream.on('error', reject)
    })
    await sleep(50)
    const event = { type: 'agent.status_changed', data: { id: 91, workspace_id: 17, status: 'idle' },
      timestamp: Date.now(), eventId: 'isolated-event', sourceId: 'isolated-web' }
    assert.equal((await socketRequest(f.socket, '/event', event)).code, 200)
    assert.deepEqual(await received, { ...event, relayed: true })
    assert.equal((await socketRequest(f.socket, '/trigger', { task_id: 'arbitrary-shell' })).code, 400)
    assert.equal((await socketRequest(f.socket, '/drain', {})).body.currentState, 'draining')
    const stopped = await terminate(worker)
    assert.equal(stopped.code, 0, stopped.stderr)
    assert.equal(existsSync(f.socket), false)
  } finally {
    stream?.destroy()
    if (worker.child.exitCode === null) await terminate(worker)
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('pending migration remains a follower until the old lease is actually relinquished', async () => {
  const f = fixture()
  const db = new Database(f.databasePath)
  const holder = 'a'.repeat(32)
  const now = Math.floor(Date.now() / 1_000)
  db.prepare(`INSERT INTO scheduler_leader_leases
    (lease_name, holder_id, lease_expires_at, revision, updated_at) VALUES ('builtin_scheduler', ?, ?, 1, ?)`)
    .run(holder, now + 300, now)
  f.writeHandoff({ ...f.handoff, oldSchedulerStopped: false, migrationPending: true,
    previous: { pid: process.pid, slot: 'blue', releaseId: 'previous-web', routerGeneration: 8,
      leaseHolderId: holder, leaseRevision: 1 } })
  const worker = start(f)
  try {
    const follower = await waitFor(async () => {
      const response = await socketRequest(f.socket, '/status')
      return response.body.leadership.state === 'follower' ? response.body : null
    })
    assert.equal(follower.healthy, false)
    assert.equal(follower.handoff.migrationPending, true)
    assert.equal(db.prepare('SELECT holder_id FROM scheduler_leader_leases').get().holder_id, holder)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM n8n_task_runs').get().n, 0)
    db.prepare('DELETE FROM scheduler_leader_leases WHERE holder_id = ? AND revision = 1').run(holder)
    await waitFor(async () => (await socketRequest(f.socket, '/status')).body.healthy)
    assert.notEqual(db.prepare('SELECT holder_id FROM scheduler_leader_leases').get().holder_id, holder)
    assert.equal((await terminate(worker)).code, 0)
  } finally {
    if (worker.child.exitCode === null) await terminate(worker)
    db.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('production startup refuses an unprepared journal without changing it or acquiring a lease', async () => {
  const f = fixture()
  const before = new Database(f.databasePath)
  before.pragma('journal_mode = DELETE')
  before.close()
  const worker = start(f)
  try {
    const result = await worker.exited
    assert.equal(result.code, 1)
    assert.match(result.stderr, /database_wal_prepare_required/)
    const after = new Database(f.databasePath, { readonly: true })
    try {
      assert.equal(after.pragma('journal_mode', { simple: true }), 'delete')
      assert.equal(after.prepare('SELECT COUNT(*) AS n FROM scheduler_leader_leases').get().n, 0)
    } finally { after.close() }
    assert.equal(existsSync(f.socket), false)
  } finally {
    if (worker.child.exitCode === null) await terminate(worker)
    rmSync(f.root, { recursive: true, force: true })
  }
})

async function previousWeb(f) {
  const db = new Database(f.databasePath)
  const holder = 'b'.repeat(32)
  const now = Math.floor(Date.now() / 1_000)
  const expires = now + 300
  db.prepare(`INSERT INTO scheduler_leader_leases
    (lease_name,holder_id,lease_expires_at,revision,updated_at) VALUES ('builtin_scheduler',?,?,1,?)`).run(holder, expires, now)
  db.prepare(`INSERT INTO n8n_intake_controls
    (control_id,accepting,reason,changed_by_id,changed_by_name,revision) VALUES (1,0,'isolated handoff pause',1,'test',1)`).run()
  let released = false
  let port
  const leadership = () => ({ state: released ? 'inactive' : 'leader', activeJobs: 0,
    leaseExpiresAt: released ? null : expires, leaseExpired: false, routerGeneration: 8 })
  const server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/scheduler') response.end(JSON.stringify({ leadership: leadership() }))
    else response.end(JSON.stringify({ readiness: { schema: 'video-autoworker-release-readiness/v1',
      globalScope: true, observedAt: Math.floor(Date.now() / 1_000), intake: { accepting: false, revision: 1, counts: { active: 0 } },
      scheduler: leadership(), runtime: { runtimeSlot: 'blue', runtimeReleaseId: 'previous-web', port } } }))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  port = server.address().port
  const routerStatePath = join(f.root, 'router-state.json')
  writeFileSync(routerStatePath, JSON.stringify({ schema: 'video-autoworker-standalone-router/v1', generation: 8,
    active: 'blue', previous: 'green', slots: { blue: { host: '127.0.0.1', port, releaseId: 'previous-web' },
      green: { host: '127.0.0.1', port: port === 41000 ? 41001 : 41000, releaseId: 'candidate-web' } } }), { mode: 0o600 })
  unlinkSync(join(f.state, 'handoff.json'))
  const options = { stateDir: f.state, operationId: 'isolated-managed-handoff', databasePath: f.databasePath,
    manifestPath: join(artifact, 'worker-manifest.json'), routerStatePath, oldWebUrl: `http://127.0.0.1:${port}`,
    oldWebPid: process.pid, oldWebCwd: process.cwd(), targetApplicationCommit: 'a'.repeat(40) }
  return { db, holder, options,
    release: () => { released = true; db.prepare('DELETE FROM scheduler_leader_leases WHERE holder_id=?').run(holder) },
    reacquire: () => { released = false; db.prepare(`INSERT INTO scheduler_leader_leases
      (lease_name,holder_id,lease_expires_at,revision,updated_at) VALUES ('builtin_scheduler',?,?,1,?)`).run(holder, expires, now) },
    close: async () => { await new Promise(done => server.close(done)); db.close() } }
}

test('managed completion persists the CAS receipt and a worker restart does not require the old holder', async () => {
  const f = fixture()
  const old = await previousWeb(f)
  let worker
  try {
    const prepared = await prepareSchedulerHandoff(old.options)
    assert.equal(prepared.currentState, 'prepared')
    worker = start(f)
    await waitFor(async () => (await socketRequest(f.socket, '/status')).body.leadership.state === 'follower')
    old.release()
    const status = await waitFor(async () => {
      const current = (await socketRequest(f.socket, '/status')).body
      return current.healthy ? current : null
    })
    const options = { ...old.options, expectedPid: worker.child.pid, expectedContentSha256: status.worker.contentSha256 }
    const completed = await completeSchedulerHandoff(options)
    assert.equal(completed.currentState, 'completed')
    assert.equal(JSON.parse(readFileSync(join(f.state, 'handoff.json'), 'utf8')).migrationPending, false)
    assert.equal(JSON.parse(readFileSync(join(f.state, 'handoff.previous.json'), 'utf8')).migrationPending, true)
    assert.equal((await socketRequest(f.socket, '/status')).body.handoff.migrationPending, false)
    await assert.rejects(rollbackSchedulerHandoff(options), /worker_handoff_rollback_not_pending/)
    assert.equal((await socketRequest(f.socket, '/status')).body.healthy, true)
    await terminate(worker)
    worker = start(f)
    const restarted = await waitFor(async () => {
      const current = (await socketRequest(f.socket, '/status')).body
      return current.healthy ? current : null
    })
    assert.equal(restarted.handoff.migrationPending, false)
    assert.equal(restarted.handoff.targetApplicationCommit, old.options.targetApplicationCommit)
  } finally {
    if (worker?.child.exitCode === null) await terminate(worker)
    await old.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})

test('managed rollback refuses another operation, then drains its new leader before the old worker can reacquire', async () => {
  const f = fixture()
  const old = await previousWeb(f)
  let worker
  try {
    await prepareSchedulerHandoff(old.options)
    worker = start(f)
    await waitFor(async () => (await socketRequest(f.socket, '/status')).body.leadership.state === 'follower')
    old.release()
    const status = await waitFor(async () => {
      const current = (await socketRequest(f.socket, '/status')).body
      return current.healthy ? current : null
    })
    const options = { ...old.options, expectedPid: worker.child.pid, expectedContentSha256: status.worker.contentSha256 }
    await assert.rejects(rollbackSchedulerHandoff({ ...options, operationId: 'different-operation' }), /worker_handoff_scope_mismatch/)
    assert.equal((await socketRequest(f.socket, '/status')).body.currentState, 'ready')
    const result = await rollbackSchedulerHandoff(options)
    assert.equal(result.currentState, 'worker-stopped')
    assert.equal(result.oldWebRestored, false)
    assert.equal((await worker.exited).code, 0)
    assert.equal(old.db.prepare('SELECT holder_id FROM scheduler_leader_leases').get(), undefined)
    old.reacquire()
    assert.equal(old.db.prepare('SELECT holder_id FROM scheduler_leader_leases').get().holder_id, old.holder)
    assert.equal((await rollbackSchedulerHandoff(options)).reused, true)
    assert.equal(old.db.prepare('SELECT holder_id FROM scheduler_leader_leases').get().holder_id, old.holder)
    assert.equal(JSON.parse(readFileSync(join(f.state, 'handoff.json'), 'utf8')).migrationPending, false)
  } finally {
    if (worker?.child.exitCode === null) await terminate(worker)
    await old.close()
    rmSync(f.root, { recursive: true, force: true })
  }
})
