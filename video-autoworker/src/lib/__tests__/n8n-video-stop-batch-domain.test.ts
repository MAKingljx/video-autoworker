// @vitest-environment node
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { createN8nTaskRun } from '@/lib/n8n-task-runs'
import { mediaChildIdentity } from '@/lib/n8n-media-workspace'
import { acknowledgeScopedVideoBatchStop, advanceScopedVideoStop, drainScopedVideoStops,
  inspectScopedSingleVideoStop, readScopedVideoStopIntent, requestScopedSingleVideoStop } from '@/lib/n8n-video-stop'
import { acquireBatchLock, acquireGlobalBatchLock, batchStatePath, sourceFingerprintFromIdentity } from '../../../openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs'
import { sourceIdentity } from '../../../openclaw-skills/aiworker-task-flow/lib/media-ingest.mjs'

const scope = { tenantId: 3, workspaceId: 2 }
const foreign = { tenantId: 4, workspaceId: 2 }
const taskId = 'pre-admission-stop-original'
let db: Database.Database, root: string, databasePath: string, inbox: string, pathname: string, bindingId: number, foreignBinding: number
let batch: Record<string, any>
function save() { writeFileSync(pathname, JSON.stringify(batch), { mode: 0o600 }); chmodSync(pathname, 0o600) }
function item() { return batch.items[0] }
async function request() {
  const inspection = (await inspectScopedSingleVideoStop(db, taskId, scope))!
  return requestScopedSingleVideoStop(db, { taskId, expectedRevision: inspection.expectedRevision }, scope, 9)
}
function admit(connection: Database.Database, id = taskId, targetScope = scope, binding = bindingId) {
  return createN8nTaskRun(connection, { taskId: id, idempotencyKey: id === taskId ? item().idempotencyKey : id,
    bindingId: binding, source: 'openclaw', requestedBy: 'isolated-test', routing: { taskType: 'video-analysis' },
    taskInput: { videoKey: 'original.mp4' }, delivery: { mode: 'none' }, maxAttempts: 2 }, targetScope)
}
function staging() {
  const videoKey = '12345678-1234-4234-8234-123456789abc.mp4'
  const ownershipToken = '23456789-1234-4234-8234-123456789abc'
  const incomingName = `.incoming-${process.pid}-${videoKey}`
  const incoming = join(inbox, incomingName)
  writeFileSync(incoming, '', { mode: 0o600 })
  item().status = 'staging'
  item().stagingRecovery = { schemaVersion: 1, phase: 'prepared', taskId, batchId: batch.batchId,
    idempotencyKey: item().idempotencyKey, sourceIdentity: item().sourceIdentity, anchoredIdentity: null,
    anchorName: `.source-anchor-${process.pid}-${ownershipToken}`, incomingName, videoKey, ownershipToken,
    materialId: null, contentSha256: null, incomingIdentity: sourceIdentity(lstatSync(incoming)), stagedIdentity: null }
  save()
  return incoming
}
function receipt(requestId: string) {
  const row = db.prepare('SELECT snapshot_sha256 FROM n8n_video_stop_requests WHERE request_id=?').get(requestId) as { snapshot_sha256: string }
  const resource = (path: string) => ({ path, identity: sourceIdentity(lstatSync(path)) })
  const optional = (path: string) => existsSync(path) ? resource(path) : null
  const journal = item().stagingRecovery
  item().status = 'cancelled'; item().stopRequestId = requestId; item().stopAckPending = true
  item().stopReceipt = { schema: 'aiworker-video-batch-stop-local/v1', requestId, targetSha256: row.snapshot_sha256,
    taskId, batchId: batch.batchId, bindingId, idempotencyKey: item().idempotencyKey, observedAt: new Date().toISOString(),
    quiescent: { copy: true, hash: true, submission: true, writers: true }, resources: { source: resource(item().sourcePath),
      incoming: journal ? optional(join(inbox, journal.incomingName)) : null,
      staged: journal ? optional(join(inbox, journal.videoKey)) : null,
      anchor: journal ? optional(join(inbox, journal.anchorName)) : null } }
  save()
}
async function held() {
  const global = await acquireGlobalBatchLock(pathname), local = await acquireBatchLock(pathname)
  expect(global.acquired && local.acquired).toBe(true)
  return { lease: global.lease!, release: async () => { await local.release(); await global.release() } }
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'stop-batch-domain-')))
  databasePath = join(root, 'mission.sqlite'); db = new Database(databasePath)
  db.pragma('journal_mode=WAL'); runMigrations(db)
  const binding = db.prepare(`INSERT INTO n8n_workflow_bindings
    (name,task_type,workflow_id,webhook_path,agent_role,model,enabled,timeout_seconds,retry_count,config,workspace_id,tenant_id)
    VALUES (?, 'video-analysis','original-workflow','webhook/video','executor','model',1,30,2,'{}',2,?)`)
  bindingId = Number(binding.run('owned', 3).lastInsertRowid)
  foreignBinding = Number(binding.run('foreign', 4).lastInsertRowid)
  inbox = join(root, 'inbox'); mkdirSync(inbox, { mode: 0o700 })
  const files = ['source.mp4', 'other.mp4'].map(name => { const path = join(root, name); writeFileSync(path, name, { mode: 0o644 }); return path })
  batch = { schemaVersion: 2, batchId: 'original-batch', requestFingerprint: 'a'.repeat(64), bindingId,
    status: 'queued', baseUrl: 'http://127.0.0.1:3017', inboxRoot: inbox, prompt: 'learn original video',
    items: files.map((path, index) => ({ taskId: index ? 'untouched-neighbor' : taskId, index: index + 1,
      idempotencyKey: index ? 'untouched-neighbor-idem' : 'original-item-idem', status: 'queued', sourcePath: path,
      sourceBytes: lstatSync(path).size, sourceIdentity: sourceIdentity(lstatSync(path)),
      sourceFingerprint: sourceFingerprintFromIdentity(path, sourceIdentity(lstatSync(path))) })) }
  pathname = batchStatePath(batch.batchId, root); save()
  vi.stubEnv('AIWORKER_VIDEO_BATCH_DIR', root)
})
afterEach(() => { db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

describe('single durable stop intent before video admission', () => {
  it.each(['queued', 'staging'])('stops a %s target without creating any shadow parent or child', async mode => {
    const incoming = mode === 'staging' ? staging() : null
    const before = readFileSync(pathname), neighbor = JSON.stringify(batch.items[1]), source = readFileSync(item().sourcePath)
    const inspection = (await inspectScopedSingleVideoStop(db, taskId, scope))!
    expect(inspection).toMatchObject({ targetKind: 'batch_item', eligible: true, bindingId, status: mode })
    const intent = await request()
    expect(intent.stop).toMatchObject({ targetKind: 'batch_item', bindingId, currentState: 'requested' })
    expect(readFileSync(pathname)).toEqual(before)
    expect(db.prepare('SELECT count(*) count FROM n8n_task_runs').get()).toEqual({ count: 0 })
    expect(advanceScopedVideoStop(db, taskId, intent.stop!.requestId, scope)).toMatchObject({ outcome: 'stopping', status: 'stopping' })
    expect(drainScopedVideoStops(db)).toEqual({ scanned: 0, stopped: 0, stopping: 0, blocked: 0 })
    receipt(intent.stop!.requestId)
    const lock = await held()
    try {
      const ack = await acknowledgeScopedVideoBatchStop(db, { taskId, requestId: intent.stop!.requestId, workerLease: lock.lease }, scope)
      expect(ack.stop).toMatchObject({ currentState: 'stopped', targetKind: 'batch_item', bindingId })
      expect(readScopedVideoStopIntent(db, taskId, bindingId, scope).stop?.currentState).toBe('stopped')
      expect(db.prepare('SELECT count(*) count FROM n8n_task_runs').get()).toEqual({ count: 0 })
      expect(readFileSync(item().sourcePath)).toEqual(source)
      expect(JSON.stringify((JSON.parse(readFileSync(pathname, 'utf8')) as typeof batch).items[1])).toBe(neighbor)
      if (incoming) expect(lstatSync(incoming).size).toBe(0)
    } finally { await lock.release() }
  })

  it('lets a real parent insertion on another connection win and requires a fresh runtime confirmation', async () => {
    const inspection = (await inspectScopedSingleVideoStop(db, taskId, scope))!
    const other = new Database(databasePath)
    try { admit(other) } finally { other.close() }
    await expect(requestScopedSingleVideoStop(db, { taskId, expectedRevision: inspection.expectedRevision }, scope, 9)).rejects.toThrow('stop_revision_changed')
    expect(db.prepare('SELECT count(*) count FROM n8n_video_stop_requests').get()).toEqual({ count: 0 })
    const fresh = (await inspectScopedSingleVideoStop(db, taskId, scope))!
    expect(fresh.targetKind).toBe('runtime')
    const result = await requestScopedSingleVideoStop(db, { taskId, expectedRevision: fresh.expectedRevision }, scope, 9)
    expect(result.stop?.targetKind).toBe('runtime')
    expect(db.prepare('SELECT count(*) count FROM n8n_task_runs').get()).toEqual({ count: 1 })
  })

  it('lets the stop-first transaction reserve the original identity against same and foreign tenant admission', async () => {
    const intent = await request()
    const other = new Database(databasePath)
    try {
      expect(() => admit(other)).toThrow('N8N_VIDEO_STOP_REQUESTED')
      expect(() => admit(other, taskId, foreign, foreignBinding)).toThrow('N8N_VIDEO_STOP_REQUESTED')
      expect(() => admit(other, mediaChildIdentity('task', taskId, 'vision'), foreign, foreignBinding)).toThrow('N8N_VIDEO_STOP_REQUESTED')
    } finally { other.close() }
    expect(db.prepare('SELECT count(*) count FROM n8n_task_runs').get()).toEqual({ count: 0 })
    expect(readScopedVideoStopIntent(db, taskId, bindingId, scope).stop?.requestId).toBe(intent.stop!.requestId)
  })

  it('rejects a preexisting foreign child identity without creating or leaking a stop target', async () => {
    const inspection = (await inspectScopedSingleVideoStop(db, taskId, scope))!
    const other = new Database(databasePath)
    try { admit(other, mediaChildIdentity('task', taskId, 'audio'), foreign, foreignBinding) } finally { other.close() }
    await expect(requestScopedSingleVideoStop(db, { taskId, expectedRevision: inspection.expectedRevision }, scope, 9)).rejects.toThrow('stop_task_not_found')
    expect(db.prepare('SELECT count(*) count FROM n8n_video_stop_requests').get()).toEqual({ count: 0 })
    expect(await inspectScopedSingleVideoStop(db, taskId, foreign)).toBeNull()
    expect(() => readScopedVideoStopIntent(db, taskId, bindingId, foreign)).toThrow('stop_binding_unavailable')
  })

  it('keeps repeat clicks and a lost acknowledgement idempotent on the one original request', async () => {
    const intent = await request(), requestId = intent.stop!.requestId
    const replay = await requestScopedSingleVideoStop(db, { taskId, expectedRevision: 'f'.repeat(64) }, scope, 10)
    expect(replay.stop?.requestId).toBe(requestId)
    receipt(requestId)
    const lock = await held()
    try {
      const payload = { taskId, requestId, workerLease: lock.lease }
      const first = await acknowledgeScopedVideoBatchStop(db, payload, scope)
      const bytes = readFileSync(pathname)
      const second = await acknowledgeScopedVideoBatchStop(db, payload, scope)
      expect(second).toEqual(first)
      expect(readFileSync(pathname)).toEqual(bytes)
      expect(db.prepare('SELECT count(*) count FROM n8n_video_stop_requests').get()).toEqual({ count: 1 })
      expect(db.prepare('SELECT count(*) count FROM n8n_task_runs').get()).toEqual({ count: 0 })
    } finally { await lock.release() }
  })

  it.each(['foreign-lock', 'stale-receipt', 'resource-drift', 'resource-path', 'missing-receipt'])('does not confirm stopped with %s', async fault => {
    const intent = await request(), requestId = intent.stop!.requestId
    receipt(requestId)
    if (fault === 'stale-receipt') { item().stopReceipt.observedAt = new Date(0).toISOString(); save() }
    if (fault === 'resource-drift') writeFileSync(item().sourcePath, 'changed after receipt')
    if (fault === 'resource-path') { item().stopReceipt.resources.source.path = join(root, 'caller-selected.mp4'); save() }
    if (fault === 'missing-receipt') { delete item().stopReceipt; save() }
    const lock = await held()
    try {
      const lease = fault === 'foreign-lock' ? { ...lock.lease, token: 'ffffffff-ffff-4fff-8fff-ffffffffffff' } : lock.lease
      await expect(acknowledgeScopedVideoBatchStop(db, { taskId, requestId, workerLease: lease }, scope)).rejects.toThrow()
      expect(readScopedVideoStopIntent(db, taskId, bindingId, scope).stop?.currentState).not.toBe('stopped')
      expect(db.prepare('SELECT count(*) count FROM n8n_task_runs').get()).toEqual({ count: 0 })
    } finally { await lock.release() }
  })

  it('makes the cheap worker intent read wait for an in-flight stop transaction instead of reading a stale WAL snapshot', async () => {
    await request()
    const ready = join(root, 'writer-ready'), query = join(root, 'reader-query')
    const code = `const D=require('better-sqlite3'),fs=require('node:fs');const db=new D(${JSON.stringify(databasePath)});db.exec('BEGIN IMMEDIATE');db.prepare("UPDATE n8n_video_stop_requests SET state='stopping' WHERE task_id=?").run(${JSON.stringify(taskId)});fs.writeFileSync(${JSON.stringify(ready)},'1');let deadline=Date.now()+5000;function step(){if(fs.existsSync(${JSON.stringify(query)})){setTimeout(()=>{db.exec('COMMIT');db.close()},200);return}if(Date.now()>deadline){db.exec('ROLLBACK');db.close();process.exitCode=1;return}setTimeout(step,5)}step()`
    const child = spawn(process.execPath, ['-e', code], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''; child.stderr.on('data', value => { stderr += String(value) })
    const finished = new Promise<number | null>(resolve => child.once('close', resolve))
    try {
      const deadline = Date.now() + 3000
      while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
      expect({ ready: existsSync(ready), stderr }).toEqual({ ready: true, stderr: '' })
      writeFileSync(query, '1')
      const start = Date.now()
      const observed = readScopedVideoStopIntent(db, taskId, bindingId, scope)
      expect(observed.stop?.currentState).toBe('stopping')
      expect(Date.now() - start).toBeGreaterThanOrEqual(100)
      expect(await finished).toBe(0)
    } finally { if (!existsSync(query)) writeFileSync(query, '1'); await finished }
  }, 10_000)
})
