import { createHash } from 'node:crypto'
import { constants, closeSync, fstatSync, lstatSync, openSync, opendirSync, readFileSync, realpathSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { n8nTaskIdentitySchema, type N8nTaskScope } from '@/lib/n8n-task-runs'
import { n8nVideoBatchRoot } from '@/lib/n8n-video-sources'
import { assertVideoRepairWorkerLease, batchStatePath, sourceFingerprintFromIdentity } from '../../openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs'

const SHA = /^[a-f0-9]{64}$/u
const MAX_BYTES = 8 * 1024 * 1024
const MAX_SCAN_BYTES = 32 * 1024 * 1024
const MAX_FILES = 1000
const MAX_ITEMS = 20_000
const pending = new Set(['queued', 'staging', 'recovering'])
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const identitySchema = z.object({ dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative(),
  size: z.number().int().nonnegative(), mtimeMs: z.number().finite(), ctimeMs: z.number().finite() }).strict()
type FileIdentity = z.infer<typeof identitySchema>
type JsonObject = Record<string, unknown>
type Batch = JsonObject & { schemaVersion: number; batchId: string; requestFingerprint: string; bindingId: number;
  inboxRoot: string; items: JsonObject[] }

/** Private server snapshot. Never return its filesystem paths or ownership tokens to the browser. */
export interface VideoBatchStopTargetSnapshot {
  schema: 'aiworker-video-batch-stop-target/v1'
  taskId: string
  tenantId: number
  workspaceId: number
  bindingId: number
  root: string
  rootIdentity: { dev: number; ino: number; uid: number; mode: number }
  statePath: string
  batchId: string
  requestFingerprint: string
  membersSha256: string
  configurationSha256: string
  itemIndex: number
  idempotencyKey: string
  sourcePath: string
  sourceBytes: number
  sourceIdentity: FileIdentity
  sourceFingerprint: string
  inboxRoot: string
  itemStatus: string
  stagingRecovery: JsonObject | null
  resources: VideoBatchStopLocalReceipt['resources']
}

const resourceSchema = z.object({ path: z.string().min(1), identity: identitySchema }).strict()
export const videoBatchStopLocalReceiptSchema = z.object({
  schema: z.literal('aiworker-video-batch-stop-local/v1'), requestId: z.string().regex(SHA),
  targetSha256: z.string().regex(SHA), taskId: n8nTaskIdentitySchema,
  batchId: z.string().min(1).max(80), bindingId: z.number().int().positive(), idempotencyKey: n8nTaskIdentitySchema,
  observedAt: z.string().datetime({ offset: true }),
  quiescent: z.object({ copy: z.literal(true), hash: z.literal(true), submission: z.literal(true), writers: z.literal(true) }).strict(),
  resources: z.object({ source: resourceSchema, incoming: resourceSchema.nullable(), staged: resourceSchema.nullable(),
    anchor: resourceSchema.nullable() }).strict(),
}).strict()
export type VideoBatchStopLocalReceipt = z.infer<typeof videoBatchStopLocalReceiptSchema>

function fail(code = 'stop_batch_identity_changed'): never { throw new Error(code) }
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('stop_batch_file_invalid')
  return value as JsonObject
}
function absolute(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value) || resolve(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail('stop_batch_path_invalid')
  return value
}
function rootIdentity(pathname: string) {
  const path = absolute(pathname)
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || (stat.mode & 0o077)
    || realpathSync.native(path) !== path) fail('stop_batch_root_invalid')
  return { dev: stat.dev, ino: stat.ino, uid: stat.uid, mode: stat.mode }
}
function sameStat(left: Stats, right: Stats) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.uid === right.uid
    && left.mode === right.mode && left.nlink === right.nlink && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}
function fileIdentity(stat: Stats): FileIdentity {
  return identitySchema.parse({ dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs })
}

/** Reads only the primary file. A stale .bak must never authorize cancellation. */
function readBatch(pathname: string, root: string): { batch: Batch; bytes: number } {
  if (dirname(absolute(pathname)) !== root || !/^[a-f0-9]{64}\.json$/u.test(pathname.slice(root.length + 1))) fail('stop_batch_path_invalid')
  const before = lstatSync(pathname)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid!()
    || (before.mode & 0o077) || before.size < 2 || before.size > MAX_BYTES) fail('stop_batch_file_invalid')
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  let raw: string
  try {
    const opened = fstatSync(fd)
    if (!sameStat(before, opened)) fail()
    raw = readFileSync(fd, 'utf8')
    if (!sameStat(opened, fstatSync(fd)) || !sameStat(opened, lstatSync(pathname))) fail()
  } finally { closeSync(fd) }
  let batch: Batch
  try { batch = object(JSON.parse(raw)) as Batch } catch { fail('stop_batch_file_invalid') }
  if (![1, 2].includes(batch.schemaVersion) || typeof batch.batchId !== 'string' || batchStatePath(batch.batchId, root) !== pathname
    || (batch.schemaVersion === 2 && !SHA.test(batch.requestFingerprint)) || !Number.isSafeInteger(batch.bindingId) || batch.bindingId <= 0
    || !Array.isArray(batch.items) || batch.items.length > MAX_ITEMS) fail('stop_batch_file_invalid')
  return { batch, bytes: before.size }
}
function members(batch: Batch) {
  const ids = batch.items.map(item => n8nTaskIdentitySchema.parse(object(item).taskId))
  if (new Set(ids).size !== ids.length) fail('stop_batch_item_ambiguous')
  return digest(ids)
}
function configuration(batch: Batch) {
  return digest({ requestFingerprint: batch.requestFingerprint, bindingId: batch.bindingId,
    baseUrl: batch.baseUrl, inboxRoot: batch.inboxRoot, prompt: batch.prompt,
    visionRoute: batch.visionRoute ?? null, directorWork: batch.directorWork ?? null })
}
function resource(pathname: string, optional = false, privateArtifact = false): z.infer<typeof resourceSchema> | null {
  const path = absolute(pathname)
  let before: Stats
  try { before = lstatSync(path) } catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (!before.isFile() || before.isSymbolicLink() || realpathSync.native(path) !== path
    || (privateArtifact && (before.uid !== process.getuid!() || (before.mode & 0o077) || before.nlink !== 1))) fail('stop_batch_resource_invalid')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!sameStat(before, opened) || !sameStat(opened, fstatSync(fd)) || !sameStat(opened, lstatSync(path))) fail('stop_batch_resource_changed')
    return { path, identity: fileIdentity(opened) }
  } finally { closeSync(fd) }
}
function stagingPaths(snapshot: Pick<VideoBatchStopTargetSnapshot, 'inboxRoot' | 'taskId' | 'batchId' | 'idempotencyKey'>, staging: JsonObject | null) {
  if (!staging) return null
  const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}'
  if (staging.taskId !== snapshot.taskId || staging.batchId !== snapshot.batchId || staging.idempotencyKey !== snapshot.idempotencyKey
    || typeof staging.ownershipToken !== 'string' || !new RegExp(`^${uuid}$`, 'u').test(staging.ownershipToken)
    || typeof staging.videoKey !== 'string' || !new RegExp(`^${uuid}\\.(mp4|mov|mkv|webm|m4v)$`, 'u').test(staging.videoKey)
    || typeof staging.anchorName !== 'string' || !new RegExp(`^\\.source-anchor-[1-9][0-9]*-${staging.ownershipToken}$`, 'u').test(staging.anchorName)) fail('stop_batch_staging_invalid')
  const pid = staging.anchorName.split('-')[2]
  if (staging.incomingName !== `.incoming-${pid}-${staging.videoKey}`) fail('stop_batch_staging_invalid')
  return { incoming: join(snapshot.inboxRoot, staging.incomingName as string), staged: join(snapshot.inboxRoot, staging.videoKey),
    anchor: join(snapshot.inboxRoot, staging.anchorName) }
}
function makeSnapshot(batch: Batch, item: JsonObject, path: string, root: string, scope: N8nTaskScope): VideoBatchStopTargetSnapshot {
  if (batch.schemaVersion !== 2) fail('stop_batch_legacy_identity_unconfirmed')
  if (item.stagingRecovery && ['discarding', 'discarding_prepared'].includes(String(object(item.stagingRecovery).phase))) {
    fail('stop_batch_cleanup_in_progress')
  }
  const taskId = n8nTaskIdentitySchema.parse(item.taskId)
  const sourcePath = absolute(item.sourcePath), inboxRoot = absolute(batch.inboxRoot)
  rootIdentity(inboxRoot)
  if (!Number.isSafeInteger(item.index) || Number(item.index) <= 0 || !Number.isSafeInteger(item.sourceBytes)
    || Number(item.sourceBytes) <= 0 || typeof item.sourceFingerprint !== 'string' || !SHA.test(item.sourceFingerprint)) fail('stop_batch_item_invalid')
  const sourceIdentity = identitySchema.parse(item.sourceIdentity)
  const actual = resource(sourcePath)!
  if (digest(actual.identity) !== digest(sourceIdentity) || sourceIdentity.size !== item.sourceBytes
    || sourceFingerprintFromIdentity(sourcePath, sourceIdentity) !== item.sourceFingerprint) fail('stop_batch_source_changed')
  const snapshot: VideoBatchStopTargetSnapshot = { schema: 'aiworker-video-batch-stop-target/v1', taskId, ...scope,
    bindingId: batch.bindingId, root, rootIdentity: rootIdentity(root), statePath: path, batchId: batch.batchId,
    requestFingerprint: batch.requestFingerprint, membersSha256: members(batch), configurationSha256: configuration(batch),
    itemIndex: Number(item.index), idempotencyKey: n8nTaskIdentitySchema.parse(item.idempotencyKey), sourcePath,
    sourceBytes: Number(item.sourceBytes), sourceIdentity, sourceFingerprint: item.sourceFingerprint, inboxRoot,
    itemStatus: String(item.status), stagingRecovery: item.stagingRecovery === undefined ? null : object(item.stagingRecovery),
    resources: { source: actual, incoming: null, staged: null, anchor: null } }
  const paths = stagingPaths(snapshot, snapshot.stagingRecovery)
  if (paths) snapshot.resources = { source: actual, incoming: resource(paths.incoming, true, true),
    staged: resource(paths.staged, true, true), anchor: resource(paths.anchor, true) }
  if (snapshot.resources.incoming && snapshot.resources.incoming.identity.size > snapshot.sourceBytes
    || snapshot.resources.staged && snapshot.resources.staged.identity.size !== snapshot.sourceBytes) fail('stop_batch_resource_invalid')
  for (const [name, field] of [['incoming', 'incomingIdentity'], ['staged', 'stagedIdentity'], ['anchor', 'anchoredIdentity']] as const) {
    const expected = snapshot.stagingRecovery?.[field]
    if (!expected) continue
    const parsed = identitySchema.parse(expected)
    const current = snapshot.resources[name]?.identity
    if (current && (current.dev !== parsed.dev || current.ino !== parsed.ino)) fail('stop_batch_resource_changed')
    if (!current && (name === 'staged' || name === 'incoming' && (!snapshot.resources.staged
      || snapshot.resources.staged.identity.dev !== parsed.dev || snapshot.resources.staged.identity.ino !== parsed.ino))) fail('stop_batch_resource_lost')
  }
  return snapshot
}
function findItem(batch: Batch, snapshot: Pick<VideoBatchStopTargetSnapshot, 'taskId' | 'itemIndex'>): JsonObject {
  const found = batch.items.filter(item => item.taskId === snapshot.taskId)
  if (found.length !== 1 || found[0].index !== snapshot.itemIndex) fail('stop_batch_item_ambiguous')
  return found[0]
}
function assertSnapshotRoot(snapshot: VideoBatchStopTargetSnapshot) {
  if (snapshot?.schema !== 'aiworker-video-batch-stop-target/v1' || snapshot.root !== n8nVideoBatchRoot()
    || snapshot.statePath !== batchStatePath(snapshot.batchId, snapshot.root)
    || digest(rootIdentity(snapshot.root)) !== digest(snapshot.rootIdentity)) fail('stop_batch_root_changed')
}

/** Bounded, fresh authority lookup; queue UI caches are deliberately bypassed. */
export async function inspectScopedVideoBatchStopTarget(db: Database.Database, taskId: string, scope: N8nTaskScope) {
  n8nTaskIdentitySchema.parse(taskId)
  const allowed = new Set((db.prepare(`SELECT id FROM n8n_workflow_bindings WHERE tenant_id=? AND workspace_id=? AND task_type='video-analysis'`)
    .all(scope.tenantId, scope.workspaceId) as Array<{ id: number }>).map(row => row.id))
  if (!allowed.size) return null
  const root = n8nVideoBatchRoot()
  rootIdentity(root)
  const names: string[] = []
  const directory = opendirSync(root)
  try {
    let visited = 0
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (++visited > MAX_FILES * 4) fail('stop_batch_scan_limit')
      if (/^[a-f0-9]{64}\.json$/u.test(entry.name)) names.push(entry.name)
      if (names.length > MAX_FILES) fail('stop_batch_scan_limit')
    }
  } finally { directory.closeSync() }
  names.sort()
  let scannedBytes = 0, scannedItems = 0
  const matches: VideoBatchStopTargetSnapshot[] = []
  for (const name of names) {
    const path = join(root, name)
    const { batch, bytes } = readBatch(path, root)
    scannedBytes += bytes; scannedItems += batch.items.length
    if (scannedBytes > MAX_SCAN_BYTES || scannedItems > MAX_ITEMS) fail('stop_batch_scan_limit')
    if (!allowed.has(batch.bindingId)) continue
    const found = batch.items.filter(item => item.taskId === taskId)
    if (found.length > 1) fail('stop_batch_item_ambiguous')
    if (!found.length) continue
    if (!pending.has(String(found[0].status))) fail('stop_batch_item_not_pending')
    matches.push(makeSnapshot(batch, found[0], path, root, scope))
  }
  if (matches.length > 1) fail('stop_batch_item_ambiguous')
  return matches.length ? { snapshot: matches[0], expectedRevision: digest(matches[0]) } : null
}

/** Synchronous bounded descriptor read for the caller's SQLite IMMEDIATE CAS. */
export function revalidateVideoBatchStopTarget(snapshot: VideoBatchStopTargetSnapshot): void {
  assertSnapshotRoot(snapshot)
  const { batch } = readBatch(snapshot.statePath, snapshot.root)
  const item = findItem(batch, snapshot)
  const current = makeSnapshot(batch, item, snapshot.statePath, snapshot.root,
    { tenantId: snapshot.tenantId, workspaceId: snapshot.workspaceId })
  // The original worker can advance its descriptor-bound copy without a
  // batch checkpoint. Growing that same incoming inode is not target drift.
  if (snapshot.resources.incoming && current.resources.incoming
    && snapshot.resources.incoming.identity.dev === current.resources.incoming.identity.dev
    && snapshot.resources.incoming.identity.ino === current.resources.incoming.identity.ino
    && current.resources.incoming.identity.size >= snapshot.resources.incoming.identity.size) {
    current.resources.incoming = snapshot.resources.incoming
  }
  if (!pending.has(String(item.status)) || digest(current) !== digest(snapshot)) fail('stop_batch_revision_changed')
}

function captureBatchStopAck(snapshot: VideoBatchStopTargetSnapshot, requestId: string) {
  if (!SHA.test(requestId)) fail('stop_batch_request_invalid')
  assertSnapshotRoot(snapshot)
  const { batch } = readBatch(snapshot.statePath, snapshot.root)
  const item = findItem(batch, snapshot)
  if (batch.bindingId !== snapshot.bindingId || batch.requestFingerprint !== snapshot.requestFingerprint
    || members(batch) !== snapshot.membersSha256 || configuration(batch) !== snapshot.configurationSha256
    || item.idempotencyKey !== snapshot.idempotencyKey || item.sourcePath !== snapshot.sourcePath
    || item.sourceBytes !== snapshot.sourceBytes || item.status !== 'cancelled' || item.stopRequestId !== requestId
    || item.stopAckPending !== true) fail()
  const parsed = videoBatchStopLocalReceiptSchema.safeParse(item.stopReceipt)
  if (!parsed.success) fail('stop_batch_quiescence_unconfirmed')
  const receipt = parsed.data
  if (receipt.requestId !== requestId || receipt.targetSha256 !== digest(snapshot) || receipt.taskId !== snapshot.taskId
    || receipt.batchId !== snapshot.batchId || receipt.bindingId !== snapshot.bindingId || receipt.idempotencyKey !== snapshot.idempotencyKey
    || Date.parse(receipt.observedAt) > Date.now() + 5000) fail('stop_batch_receipt_changed')
  rootIdentity(snapshot.inboxRoot)
  const journal = item.stagingRecovery === undefined ? null : object(item.stagingRecovery)
  const paths = stagingPaths(snapshot, journal)
  const oldPaths = stagingPaths(snapshot, snapshot.stagingRecovery)
  if (oldPaths && (!paths || digest(oldPaths) !== digest(paths))) fail('stop_batch_staging_changed')
  const resources = { source: resource(snapshot.sourcePath)!, incoming: paths ? resource(paths.incoming, true, true) : null,
    staged: paths ? resource(paths.staged, true, true) : null, anchor: paths ? resource(paths.anchor, true) : null }
  if (digest(resources) !== digest(receipt.resources)) fail('stop_batch_resource_changed')
  const oldSource = snapshot.sourceIdentity
  if (resources.source.identity.dev !== oldSource.dev || resources.source.identity.ino !== oldSource.ino
    || resources.source.identity.size !== oldSource.size || resources.source.identity.mtimeMs !== oldSource.mtimeMs) fail('stop_batch_source_changed')
  const currentSourceIdentity = identitySchema.safeParse(item.sourceIdentity)
  if (!currentSourceIdentity.success || digest(currentSourceIdentity.data) !== digest(resources.source.identity)
    || item.sourceFingerprint !== sourceFingerprintFromIdentity(snapshot.sourcePath, resources.source.identity)) fail('stop_batch_source_changed')
  // Own anchoring can change ctime. Only a journaled same-inode stage
  // transition can explain it; unrelated source changes remain rejected.
  if (resources.source.identity.ctimeMs !== oldSource.ctimeMs && (!journal || !journal.anchoredIdentity)) fail('stop_batch_source_changed')
  for (const name of ['incoming', 'staged', 'anchor'] as const) {
    const expected = snapshot.resources[name]?.identity
    const observed = resources[name]
    if (expected && (!observed || observed.identity.dev !== expected.dev || observed.identity.ino !== expected.ino)) {
      // Incoming may be atomically renamed to the final staged path by the
      // owned worker. Its inode must still be retained, never substituted.
      if (name !== 'incoming' || !resources.staged || resources.staged.identity.dev !== expected.dev
        || resources.staged.identity.ino !== expected.ino) fail('stop_batch_resource_lost')
    }
  }
  assertSnapshotRoot(snapshot)
  const readback = readBatch(snapshot.statePath, snapshot.root).batch
  if (digest(findItem(readback, snapshot)) !== digest(item)) fail('stop_batch_receipt_changed')
  return { evidenceSha256: digest({ target: digest(snapshot), requestId, receipt, itemSha256: digest(item), root: snapshot.rootIdentity }), receipt }
}

/** The worker supplies only its existing lock credential. The receipt and all
 * paths are reconstructed from the private snapshot and primary batch file. */
export async function verifyScopedVideoBatchStopAck(snapshot: VideoBatchStopTargetSnapshot, requestId: string,
  workerLease: { pid: number; token: string }): Promise<{ evidenceSha256: string; receipt: VideoBatchStopLocalReceipt }> {
  assertSnapshotRoot(snapshot)
  if (!SHA.test(requestId)) fail('stop_batch_request_invalid')
  await assertVideoRepairWorkerLease(snapshot.statePath, workerLease)
  const observed = captureBatchStopAck(snapshot, requestId)
  await assertVideoRepairWorkerLease(snapshot.statePath, workerLease)
  revalidateScopedVideoBatchStopAck(snapshot, requestId, observed.evidenceSha256)
  return observed
}

/** Final synchronous filesystem CAS inside the caller's SQLite IMMEDIATE
 * transaction; never replaces the prior owned-worker lock verification. */
export function revalidateScopedVideoBatchStopAck(snapshot: VideoBatchStopTargetSnapshot, requestId: string,
  evidenceSha256: string): void {
  if (!SHA.test(evidenceSha256) || captureBatchStopAck(snapshot, requestId).evidenceSha256 !== evidenceSha256) {
    fail('stop_batch_ack_evidence_changed')
  }
}
