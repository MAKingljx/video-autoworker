import { createHash, randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import type { N8nTaskScope } from '@/lib/n8n-task-runs'
import { ensureDirectorMaintainabilitySchema } from '@/lib/director-maintainability-schema'

const stableText = z.string().trim().min(1).max(240)
const targetSchema = z.object({
  table: stableText.max(64),
  stableId: stableText.max(160),
  workId: stableText.max(160).nullable().optional(),
  state: stableText.max(32),
  version: z.string().regex(/^v\d+\.\d+\.\d+$/u),
  targetStatuses: z.array(stableText.max(32)).min(1).max(3),
  name: z.string().max(240).optional(),
  workName: z.string().max(80).optional(),
  start: z.string().max(32).optional(),
  end: z.string().max(32).optional(),
  summary: z.string().max(2_000).optional(),
}).strict()

export type DirectorReviewBatchTarget = z.infer<typeof targetSchema>
export type DirectorReviewBatchItemStatus = 'pending' | 'completed' | 'unknown' | 'failed' | 'stale'

export interface DirectorReviewBatch {
  batchId: string
  decision: 'approve' | 'reject'
  confirmationCode: string
  status: 'pending' | 'applying' | 'completed' | 'cancelled' | 'failed'
  targets: DirectorReviewBatchTarget[]
  itemStatuses: DirectorReviewBatchItemStatus[]
  completedCount: number
  unknownCount: number
  expiresAt: number
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function actorDigest(actorKey: string): string {
  const value = actorKey.normalize('NFKC').trim()
  if (!value || value.length > 512) throw new Error('director_review_actor_invalid')
  return digest(`director-review-actor/v1\0${value}`)
}

function requestDigest(requestKey: string): string {
  const value = requestKey.normalize('NFKC').trim()
  if (!value || value.length > 240) throw new Error('director_review_request_invalid')
  return digest(`director-review-request/v1\0${value}`)
}

function assertScope(scope: N8nTaskScope): void {
  if (!Number.isSafeInteger(scope.tenantId) || scope.tenantId < 1
    || !Number.isSafeInteger(scope.workspaceId) || scope.workspaceId < 1) {
    throw new Error('director_brain_scope_invalid')
  }
}

type BatchRow = {
  batch_id: string
  decision: 'approve' | 'reject'
  confirmation_code: string
  status: DirectorReviewBatch['status']
  target_count: number
  completed_count: number
  unknown_count: number
  expires_at: number
}

function readBatch(
  db: Database.Database,
  scope: N8nTaskScope,
  actor: string,
  batchId: string,
): DirectorReviewBatch | null {
  ensureDirectorMaintainabilitySchema(db)
  assertScope(scope)
  const row = db.prepare(`
    SELECT * FROM director_review_batches
    WHERE batch_id = ? AND tenant_id = ? AND workspace_id = ? AND actor_digest = ?
  `).get(batchId, scope.tenantId, scope.workspaceId, actorDigest(actor)) as BatchRow | undefined
  if (!row) return null
  const items = db.prepare(`
    SELECT * FROM director_review_batch_items WHERE batch_id = ? ORDER BY ordinal
  `).all(batchId) as Array<Record<string, unknown>>
  if (items.length !== row.target_count) throw new Error('director_review_batch_invalid')
  return {
    batchId: row.batch_id,
    decision: row.decision,
    confirmationCode: row.confirmation_code,
    status: row.status,
    completedCount: row.completed_count,
    unknownCount: row.unknown_count,
    expiresAt: row.expires_at,
    targets: items.map(item => targetSchema.parse(JSON.parse(String(item.target_json)))),
    itemStatuses: items.map(item => item.status as DirectorReviewBatchItemStatus),
  }
}

export function getDirectorReviewBatch(
  db: Database.Database,
  scope: N8nTaskScope,
  actorKey: string,
  batchId: string,
): DirectorReviewBatch | null {
  return readBatch(db, scope, actorKey, batchId)
}

export function prepareDirectorReviewBatch(
  db: Database.Database,
  scope: N8nTaskScope,
  input: {
    actorKey: string
    requestKey: string
    decision: 'approve' | 'reject'
    targets: DirectorReviewBatchTarget[]
    nowSeconds?: number
    ttlSeconds?: number
    createCode?: () => string
  },
): DirectorReviewBatch {
  ensureDirectorMaintainabilitySchema(db)
  assertScope(scope)
  const actor = actorDigest(input.actorKey)
  const request = requestDigest(`${input.requestKey}\0${input.decision}`)
  const targets = z.array(targetSchema).min(1).max(50).parse(input.targets)
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000)
  const ttl = input.ttlSeconds ?? 10 * 60
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(ttl) || ttl < 60 || ttl > 3600) {
    throw new Error('director_review_batch_time_invalid')
  }
  const code = (input.createCode?.() || randomBytes(4).toString('hex').slice(0, 8))
    .normalize('NFKC').trim().toUpperCase()
  if (!/^[A-Z0-9]{6,12}$/u.test(code)) throw new Error('director_review_confirmation_code_invalid')
  const batchId = `DRB-${digest(`${scope.tenantId}\0${scope.workspaceId}\0${actor}\0${request}`).slice(0, 32)}`
  const created = db.transaction(() => {
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO director_review_batches (
        batch_id, tenant_id, workspace_id, actor_digest, request_digest, decision,
        confirmation_code, status, target_count, completed_count, unknown_count,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, 0, ?, ?, ?)
    `).run(batchId, scope.tenantId, scope.workspaceId, actor, request, input.decision,
      code, targets.length, now + ttl, now, now)
    if (inserted.changes === 0) return false
    const insert = db.prepare(`
      INSERT INTO director_review_batch_items (
        batch_id, ordinal, table_key, stable_id, work_id, initial_state,
        initial_version, target_statuses, target_json, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `)
    targets.forEach((target, ordinal) => insert.run(
      batchId, ordinal, target.table, target.stableId, target.workId || null,
      target.state, target.version, JSON.stringify(target.targetStatuses),
      JSON.stringify(target), now,
    ))
    return true
  }).immediate()
  const storedId = created ? batchId : (db.prepare(`
    SELECT batch_id FROM director_review_batches
    WHERE tenant_id = ? AND workspace_id = ? AND actor_digest = ? AND request_digest = ?
  `).get(scope.tenantId, scope.workspaceId, actor, request) as {
    batch_id: string
  } | undefined)?.batch_id
  if (!storedId) throw new Error('director_review_batch_identity_conflict')
  const batch = readBatch(db, scope, input.actorKey, storedId)!
  if (batch.decision !== input.decision
    || JSON.stringify(batch.targets) !== JSON.stringify(targets)) {
    throw new Error('director_review_batch_identity_conflict')
  }
  return batch
}

export function claimDirectorReviewBatch(
  db: Database.Database,
  scope: N8nTaskScope,
  input: {
    actorKey: string
    confirmationCode: string
    decision: 'approve' | 'reject'
    count: number
    nowSeconds?: number
  },
): DirectorReviewBatch {
  ensureDirectorMaintainabilitySchema(db)
  assertScope(scope)
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000)
  const row = db.prepare(`
    SELECT batch_id FROM director_review_batches
    WHERE tenant_id = ? AND workspace_id = ? AND actor_digest = ? AND confirmation_code = ?
  `).get(scope.tenantId, scope.workspaceId, actorDigest(input.actorKey),
    input.confirmationCode) as { batch_id: string } | undefined
  if (!row) throw new Error('director_review_batch_not_found')
  const batch = readBatch(db, scope, input.actorKey, row.batch_id)!
  if (batch.targets.length !== input.count || batch.decision !== input.decision) {
    throw new Error('director_review_batch_confirmation_mismatch')
  }
  if (batch.expiresAt <= now && batch.status === 'pending') {
    db.prepare(`UPDATE director_review_batches SET status = 'cancelled', updated_at = ?
      WHERE batch_id = ? AND status = 'pending'`).run(now, batch.batchId)
    throw new Error('director_review_batch_expired')
  }
  if (batch.status === 'pending') {
    db.prepare(`UPDATE director_review_batches SET status = 'applying', updated_at = ?
      WHERE batch_id = ? AND status = 'pending'`).run(now, batch.batchId)
  } else if (!['applying', 'completed'].includes(batch.status)) {
    throw new Error('director_review_batch_not_applicable')
  }
  return readBatch(db, scope, input.actorKey, batch.batchId)!
}

export function recordDirectorReviewBatchItem(
  db: Database.Database,
  scope: N8nTaskScope,
  input: {
    actorKey: string
    batchId: string
    ordinal: number
    status: Exclude<DirectorReviewBatchItemStatus, 'pending'>
    resultVersion?: string
    errorCode?: string
    nowSeconds?: number
  },
): DirectorReviewBatch {
  ensureDirectorMaintainabilitySchema(db)
  const batch = readBatch(db, scope, input.actorKey, input.batchId)
  if (!batch || !['applying', 'completed'].includes(batch.status)) {
    throw new Error('director_review_batch_not_applicable')
  }
  if (!Number.isSafeInteger(input.ordinal) || input.ordinal < 0 || input.ordinal >= batch.targets.length) {
    throw new Error('director_review_batch_item_invalid')
  }
  if (!['completed', 'unknown', 'failed', 'stale'].includes(input.status)
    || (input.resultVersion !== undefined && !/^v\d+\.\d+\.\d+$/u.test(input.resultVersion))
    || (input.errorCode !== undefined && !/^[A-Za-z0-9_:-]{1,200}$/u.test(input.errorCode))) {
    throw new Error('director_review_batch_item_invalid')
  }
  const current = batch.itemStatuses[input.ordinal]
  if (current === 'completed') {
    const stored = db.prepare(`
      SELECT result_version FROM director_review_batch_items
      WHERE batch_id = ? AND ordinal = ?
    `).get(input.batchId, input.ordinal) as { result_version: string | null }
    if (input.status !== 'completed'
      || stored.result_version !== (input.resultVersion || null)) {
      throw new Error('director_review_batch_item_conflict')
    }
    return batch
  }
  if (batch.status === 'completed') throw new Error('director_review_batch_item_conflict')
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000)
  db.transaction(() => {
    const changed = db.prepare(`
      UPDATE director_review_batch_items
      SET status = ?, result_version = ?, error_code = ?, updated_at = ?
      WHERE batch_id = ? AND ordinal = ? AND status <> 'completed'
    `).run(input.status, input.resultVersion || null,
      input.errorCode || null, now, input.batchId, input.ordinal)
    if (changed.changes !== 1) throw new Error('director_review_batch_item_conflict')
    const counts = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count
      FROM director_review_batch_items WHERE batch_id = ?
    `).get(input.batchId) as { total: number; completed: number; unknown_count: number }
    db.prepare(`
      UPDATE director_review_batches
      SET completed_count = ?, unknown_count = ?,
        status = CASE WHEN ? = target_count THEN 'completed' ELSE status END,
        updated_at = ? WHERE batch_id = ? AND status = 'applying'
    `).run(counts.completed, counts.unknown_count, counts.completed, now, input.batchId)
  }).immediate()
  return readBatch(db, scope, input.actorKey, input.batchId)!
}

export function cancelDirectorReviewBatch(
  db: Database.Database,
  scope: N8nTaskScope,
  input: { actorKey: string; confirmationCode: string; nowSeconds?: number },
): DirectorReviewBatch {
  ensureDirectorMaintainabilitySchema(db)
  const row = db.prepare(`
    SELECT batch_id FROM director_review_batches
    WHERE tenant_id = ? AND workspace_id = ? AND actor_digest = ? AND confirmation_code = ?
  `).get(scope.tenantId, scope.workspaceId, actorDigest(input.actorKey),
    input.confirmationCode) as { batch_id: string } | undefined
  if (!row) throw new Error('director_review_batch_not_found')
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000)
  const changed = db.prepare(`UPDATE director_review_batches SET status = 'cancelled', updated_at = ?
    WHERE batch_id = ? AND status = 'pending'`).run(now, row.batch_id)
  if (changed.changes !== 1) throw new Error('director_review_batch_not_cancellable')
  return readBatch(db, scope, input.actorKey, row.batch_id)!
}
