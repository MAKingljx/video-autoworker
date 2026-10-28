// @vitest-environment node
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireBatchLock, acquireGlobalBatchLock, batchStatePath, sourceFingerprintFromIdentity } from '../../../openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs'
import { sourceIdentity } from '../../../openclaw-skills/aiworker-task-flow/lib/media-ingest.mjs'
import { inspectScopedVideoBatchStopTarget, revalidateScopedVideoBatchStopAck, revalidateVideoBatchStopTarget, verifyScopedVideoBatchStopAck,
  type VideoBatchStopTargetSnapshot } from '@/lib/n8n-video-stop-batch'

const scope = { tenantId: 3, workspaceId: 2 }
const taskId = 'queued-video-stop-original'
const requestId = 'c'.repeat(64)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
let db: Database.Database, root: string, inbox: string, source: string, pathname: string
let batch: Record<string, any>
function save() { writeFileSync(pathname, JSON.stringify(batch), { mode: 0o600 }); chmodSync(pathname, 0o600) }
function item() { return batch.items[0] }
async function inspect() { return (await inspectScopedVideoBatchStopTarget(db, taskId, scope))! }
function resources(snapshot: VideoBatchStopTargetSnapshot) {
  const resource = (path: string) => ({ path, identity: sourceIdentity(lstatSync(path)) })
  const journal = item().stagingRecovery
  const optional = (path: string) => { try { return resource(path) } catch { return null } }
  return { source: resource(source), incoming: journal ? optional(join(inbox, journal.incomingName)) : null,
    staged: journal ? optional(join(inbox, journal.videoKey)) : null,
    anchor: journal ? optional(join(inbox, journal.anchorName)) : null }
}
function receipt(snapshot: VideoBatchStopTargetSnapshot) {
  item().status = 'cancelled'; item().stopRequestId = requestId; item().stopAckPending = true
  item().stopReceipt = { schema: 'aiworker-video-batch-stop-local/v1', requestId, targetSha256: hash(snapshot), taskId,
    batchId: batch.batchId, bindingId: batch.bindingId, idempotencyKey: item().idempotencyKey,
    observedAt: new Date().toISOString(), quiescent: { copy: true, hash: true, submission: true, writers: true },
    resources: resources(snapshot) }
  save()
}
function staging() {
  const videoKey = '12345678-1234-4234-8234-123456789abc.mp4'
  const ownershipToken = '23456789-1234-4234-8234-123456789abc'
  const incomingName = `.incoming-${process.pid}-${videoKey}`
  writeFileSync(join(inbox, incomingName), 'part', { mode: 0o600 })
  item().status = 'staging'
  item().stagingRecovery = { schemaVersion: 1, phase: 'prepared', sourceIdentity: item().sourceIdentity,
    anchoredIdentity: null, anchorName: `.source-anchor-${process.pid}-${ownershipToken}`, incomingName,
    videoKey, ownershipToken, taskId, idempotencyKey: item().idempotencyKey, batchId: batch.batchId,
    materialId: null, contentSha256: null, incomingIdentity: sourceIdentity(lstatSync(join(inbox, incomingName))), stagedIdentity: null }
  save()
  return join(inbox, incomingName)
}
async function locks() {
  const global = await acquireGlobalBatchLock(pathname), local = await acquireBatchLock(pathname)
  expect(global.acquired && local.acquired).toBe(true)
  return { lease: global.lease!, release: async () => { await local.release(); await global.release() } }
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'video-stop-batch-')))
  inbox = join(root, 'inbox'); mkdirSync(inbox, { mode: 0o700 })
  source = join(root, 'original.mp4'); writeFileSync(source, 'original-video-bytes', { mode: 0o644 })
  pathname = batchStatePath('original-batch', root)
  batch = { schemaVersion: 2, batchId: 'original-batch', requestFingerprint: 'a'.repeat(64), bindingId: 7,
    status: 'queued', baseUrl: 'http://127.0.0.1:3017', inboxRoot: inbox, prompt: 'learn original video',
    items: [{ taskId, index: 1, idempotencyKey: 'original-item-idem', status: 'queued', sourcePath: source,
      sourceBytes: lstatSync(source).size, sourceIdentity: sourceIdentity(lstatSync(source)),
      sourceFingerprint: sourceFingerprintFromIdentity(source, sourceIdentity(lstatSync(source))) }] }
  save()
  vi.stubEnv('AIWORKER_VIDEO_BATCH_DIR', root)
  db = new Database(':memory:')
  db.exec(`CREATE TABLE n8n_workflow_bindings(id INTEGER PRIMARY KEY,tenant_id INTEGER,workspace_id INTEGER,task_type TEXT);
    INSERT INTO n8n_workflow_bindings VALUES(7,3,2,'video-analysis'),(8,4,2,'video-analysis')`)
})
afterEach(() => { db.close(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })

describe('controlled batch stop target authority', () => {
  it('takes a fresh read-only server snapshot and accepts an ordinary readable source', async () => {
    const before = readFileSync(pathname)
    const target = await inspect()
    expect(target).toMatchObject({ expectedRevision: hash(target.snapshot), snapshot: { taskId, bindingId: 7,
      tenantId: 3, workspaceId: 2, batchId: 'original-batch', statePath: pathname, itemStatus: 'queued' } })
    expect(revalidateVideoBatchStopTarget(target.snapshot)).toBeUndefined()
    expect(readFileSync(pathname)).toEqual(before)
    expect(db.prepare('SELECT count(*) count FROM n8n_workflow_bindings').get()).toEqual({ count: 2 })
  })
  it('never inspects the source for an unbound tenant', async () => {
    unlinkSync(source)
    expect(await inspectScopedVideoBatchStopTarget(db, taskId, { ...scope, tenantId: 99 })).toBeNull()
    batch.bindingId = 8; save()
    expect(await inspectScopedVideoBatchStopTarget(db, taskId, scope)).toBeNull()
  })
  it('does not use a stale backup as mutation authority', async () => {
    renameSync(pathname, `${pathname}.bak`)
    expect(await inspectScopedVideoBatchStopTarget(db, taskId, scope)).toBeNull()
  })
  it('allows unrelated heartbeat writes but fences changed item identity or ordered membership', async () => {
    const { snapshot } = await inspect()
    batch.worker = { pid: process.pid, heartbeatAt: new Date().toISOString() }; save()
    expect(revalidateVideoBatchStopTarget(snapshot)).toBeUndefined()
    item().idempotencyKey = 'different-item'; save()
    expect(() => revalidateVideoBatchStopTarget(snapshot)).toThrow('stop_batch_revision_changed')
    item().idempotencyKey = snapshot.idempotencyKey
    batch.items.push({ ...item(), taskId: 'another-video', index: 2 }); save()
    expect(() => revalidateVideoBatchStopTarget(snapshot)).toThrow('stop_batch_revision_changed')
  })
  it('rejects duplicate targets across primary batches', async () => {
    const other = { ...batch, batchId: 'other-batch' }
    writeFileSync(batchStatePath(other.batchId, root), JSON.stringify(other), { mode: 0o600 })
    await expect(inspect()).rejects.toThrow('stop_batch_item_ambiguous')
  })
  it('keeps unrelated historical v1 batches readable without accepting a v1 target', async () => {
    const other = { ...batch, schemaVersion: 1, batchId: 'historical', items: [{ taskId: 'historical-task', status: 'succeeded' }] }
    writeFileSync(batchStatePath(other.batchId, root), JSON.stringify(other), { mode: 0o600 })
    expect(await inspect()).toBeTruthy()
    batch.schemaVersion = 1; save()
    await expect(inspect()).rejects.toThrow('stop_batch_legacy_identity_unconfirmed')
  })
  it.each(['symlink', 'hardlink', 'permissions'])('rejects unsafe primary state: %s', async fault => {
    if (fault === 'symlink') { renameSync(pathname, `${pathname}.saved`); symlinkSync(`${pathname}.saved`, pathname) }
    if (fault === 'hardlink') linkSync(pathname, `${pathname}.saved`)
    if (fault === 'permissions') chmodSync(pathname, 0o644)
    await expect(inspect()).rejects.toThrow('stop_batch_file_invalid')
  })
  it('fences root replacement and caller-controlled paths', async () => {
    const { snapshot } = await inspect()
    expect(() => revalidateVideoBatchStopTarget({ ...snapshot, statePath: join(root, 'other.json') })).toThrow('stop_batch_root_changed')
    expect(() => revalidateVideoBatchStopTarget({ ...snapshot, rootIdentity: { ...snapshot.rootIdentity, ino: 0 } })).toThrow('stop_batch_root_changed')
  })
  it('bounds primary-file discovery and refuses a foreign private inbox', async () => {
    chmodSync(inbox, 0o755)
    await expect(inspect()).rejects.toThrow('stop_batch_root_invalid')
    chmodSync(inbox, 0o700)
    for (let index = 0; index <= 1000; index++) writeFileSync(join(root, `${index.toString(16).padStart(64, '0')}.json`), '{}', { mode: 0o600 })
    await expect(inspect()).rejects.toThrow('stop_batch_scan_limit')
  })
  it('allows the original incoming inode to grow while staging, but never a substituted inode', async () => {
    const incoming = staging()
    const { snapshot } = await inspect()
    writeFileSync(incoming, 'partial-copy')
    expect(revalidateVideoBatchStopTarget(snapshot)).toBeUndefined()
    renameSync(incoming, `${incoming}.kept`); writeFileSync(incoming, 'partial-copy', { mode: 0o600 })
    expect(() => revalidateVideoBatchStopTarget(snapshot)).toThrow('stop_batch_resource_changed')
  })
  it.each(['discarding', 'discarding_prepared'])('rejects a stop request CAS when %s cleanup won first', async phase => {
    staging()
    const { snapshot } = await inspect()
    item().stagingRecovery.phase = phase; save()
    expect(() => revalidateVideoBatchStopTarget(snapshot)).toThrow('stop_batch_cleanup_in_progress')
    await expect(inspect()).rejects.toThrow('stop_batch_cleanup_in_progress')
  })
})

describe('owned worker batch stop acknowledgement', () => {
  it('requires the existing global and batch locks and a complete system receipt', async () => {
    const { snapshot } = await inspect(); receipt(snapshot)
    const held = await locks()
    try {
      await expect(verifyScopedVideoBatchStopAck(snapshot, requestId, held.lease)).resolves.toMatchObject({ evidenceSha256: expect.stringMatching(/^[a-f0-9]{64}$/u) })
      await expect(verifyScopedVideoBatchStopAck(snapshot, requestId, { ...held.lease, token: '0'.repeat(36) })).rejects.toThrow('recovery_worker_lease_invalid')
      delete item().stopReceipt; save()
      await expect(verifyScopedVideoBatchStopAck(snapshot, requestId, held.lease)).rejects.toThrow('stop_batch_quiescence_unconfirmed')
    } finally { await held.release() }
  })
  it.each(['request', 'quiescence', 'target', 'resource-path', 'ack-not-pending'])('rejects altered acknowledgement: %s', async fault => {
    const { snapshot } = await inspect(); receipt(snapshot)
    if (fault === 'request') item().stopRequestId = 'd'.repeat(64)
    if (fault === 'quiescence') item().stopReceipt.quiescent.submission = false
    if (fault === 'target') item().stopReceipt.targetSha256 = 'd'.repeat(64)
    if (fault === 'resource-path') item().stopReceipt.resources.source.path = join(root, 'elsewhere.mp4')
    if (fault === 'ack-not-pending') item().stopAckPending = false
    save()
    const held = await locks()
    try { await expect(verifyScopedVideoBatchStopAck(snapshot, requestId, held.lease)).rejects.toThrow() }
    finally { await held.release() }
  })
  it('retains the partial copy and refuses an inode replacement even with a rewritten receipt', async () => {
    const incoming = staging()
    const { snapshot } = await inspect()
    writeFileSync(incoming, 'partial-copy'); receipt(snapshot)
    const held = await locks()
    try {
      await expect(verifyScopedVideoBatchStopAck(snapshot, requestId, held.lease)).resolves.toBeTruthy()
      expect(readFileSync(source, 'utf8')).toBe('original-video-bytes')
      expect(readFileSync(incoming, 'utf8')).toBe('partial-copy')
      renameSync(incoming, `${incoming}.kept`); writeFileSync(incoming, 'partial-copy', { mode: 0o600 }); receipt(snapshot)
      await expect(verifyScopedVideoBatchStopAck(snapshot, requestId, held.lease)).rejects.toThrow('stop_batch_resource_lost')
    } finally { await held.release() }
  })
  it('accepts a journaled atomic incoming-to-staged rename and preserves that exact inode', async () => {
    const incoming = staging()
    const { snapshot } = await inspect()
    writeFileSync(incoming, readFileSync(source))
    const staged = join(inbox, item().stagingRecovery.videoKey)
    renameSync(incoming, staged)
    item().stagingRecovery.phase = 'staged'
    item().stagingRecovery.stagedIdentity = sourceIdentity(lstatSync(staged))
    item().stagingRecovery.contentSha256 = hash('not-a-content-proof-used-here')
    receipt(snapshot)
    const held = await locks()
    try { await expect(verifyScopedVideoBatchStopAck(snapshot, requestId, held.lease)).resolves.toBeTruthy() }
    finally { await held.release() }
  })
  it('rejects source changes after a frozen receipt and never deletes anything', async () => {
    const { snapshot } = await inspect(); receipt(snapshot)
    writeFileSync(source, 'changed-video-bytes')
    const held = await locks()
    try {
      await expect(verifyScopedVideoBatchStopAck(snapshot, requestId, held.lease)).rejects.toThrow('stop_batch_resource_changed')
      expect(readFileSync(source, 'utf8')).toBe('changed-video-bytes')
    } finally { await held.release() }
  })
  it('rechecks the exact item and receipt synchronously after asynchronous worker verification', async () => {
    const { snapshot } = await inspect(); receipt(snapshot)
    const held = await locks()
    try {
      const observed = await verifyScopedVideoBatchStopAck(snapshot, requestId, held.lease)
      expect(() => db.transaction(() => revalidateScopedVideoBatchStopAck(snapshot, requestId, observed.evidenceSha256)).immediate()).not.toThrow()
      item().error = 'changed after observation'; save()
      expect(() => revalidateScopedVideoBatchStopAck(snapshot, requestId, observed.evidenceSha256)).toThrow('stop_batch_ack_evidence_changed')
    } finally { await held.release() }
  })
  it('rejects a resource mutation in the asynchronous observation-to-commit gap', async () => {
    const { snapshot } = await inspect(); receipt(snapshot)
    const held = await locks()
    try {
      const observed = await verifyScopedVideoBatchStopAck(snapshot, requestId, held.lease)
      writeFileSync(source, 'mutated after observation')
      expect(() => revalidateScopedVideoBatchStopAck(snapshot, requestId, observed.evidenceSha256)).toThrow('stop_batch_resource_changed')
    } finally { await held.release() }
  })
  it('accepts stop-first acknowledgement after cleanup is armed but the same incoming inode was retained', async () => {
    const incoming = staging()
    const { snapshot } = await inspect()
    item().stagingRecovery.phase = 'discarding_prepared'; receipt(snapshot)
    const held = await locks()
    try {
      await expect(verifyScopedVideoBatchStopAck(snapshot, requestId, held.lease)).resolves.toBeTruthy()
      expect(readFileSync(incoming, 'utf8')).toBe('part')
    } finally { await held.release() }
  })
})
