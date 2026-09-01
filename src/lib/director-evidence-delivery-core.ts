import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { N8nTaskRun } from '@/lib/n8n-task-runs'
import {
  DIRECTOR_EVIDENCE_SOURCE_AUTHORITY,
  MAX_EVIDENCE_PROJECTION_INPUT_BYTES,
  directorEvidenceProjectionBatches,
  directorEvidenceProjectionResultCount,
  directorEvidenceTransformEnvelope,
} from '@/lib/director-evidence-projection-semantics'

export const DIRECTOR_EVIDENCE_BINDING_AUTHORITY = 'director-brain-resolve-work-v1'

const SHA256 = /^[a-f0-9]{64}$/u
const STABLE_ID = /^[A-Za-z0-9._:-]{1,160}$/u
const MAX_QUERY_LENGTH = 240
const MEBIBYTE = 1024 * 1024

// These limits are part of the hashed delivery core. The transform wire accepts
// a legal 2 MiB JSON envelope plus its trailing newline, while its bounded
// output accounts for governed fields copied into multiple evidence columns.
export const DIRECTOR_COMMAND_LIMITS = Object.freeze({
  operate: Object.freeze({ maxInputBytes: 32 * 1024, maxOutputBytes: 256 * 1024 }),
  transform: Object.freeze({ maxInputBytes: (2 * MEBIBYTE) + 1, maxOutputBytes: 8 * MEBIBYTE }),
  'project-evidence': Object.freeze({
    maxInputBytes: MAX_EVIDENCE_PROJECTION_INPUT_BYTES,
    maxOutputBytes: 256 * 1024,
  }),
})

export type DirectorCommand = keyof typeof DIRECTOR_COMMAND_LIMITS

export interface DirectorEvidenceBinding {
  authority: typeof DIRECTOR_EVIDENCE_BINDING_AUTHORITY
  workId: string
  queryDigest: string
}

export interface DirectorEvidenceOutbox {
  taskId: string
  bindingId: number
  tenantId: number
  workspaceId: number
  workId: string
  queryDigest: string
  projectionContractDigest: string
  idempotencyKey: string
  resultSha256: string
  status: 'pending' | 'delivered' | 'conflict'
  attemptCount: number
  nextAttemptAt: number
  lastErrorCode: string | null
  deliveredAt: number | null
  createdAt: number
  updatedAt: number
}

type OutboxRow = {
  task_id: string
  binding_id: number
  tenant_id: number
  workspace_id: number
  work_id: string
  query_digest: string
  projection_contract_digest: string
  idempotency_key: string
  result_sha256: string
  status: DirectorEvidenceOutbox['status']
  attempt_count: number
  next_attempt_at: number
  last_error_code: string | null
  delivered_at: number | null
  created_at: number
  updated_at: number
}

export type DirectorCommandRunner = (
  command: DirectorCommand,
  input: Record<string, unknown>,
) => Promise<Record<string, unknown>>

export function canonicalDirectorEvidenceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalDirectorEvidenceJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalDirectorEvidenceJson(object[key])}`
    )).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? 'null' : encoded
}

export function directorEvidenceDigest(value: unknown): string {
  return createHash('sha256').update(canonicalDirectorEvidenceJson(value), 'utf8').digest('hex')
}

export function serializeDirectorCommandInput(
  command: DirectorCommand,
  input: Record<string, unknown>,
): string {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(input)
  } catch {
    throw new Error('director_command_input_invalid')
  }
  if (typeof serialized !== 'string') throw new Error('director_command_input_invalid')
  const wire = `${serialized}\n`
  if (Buffer.byteLength(wire, 'utf8') > DIRECTOR_COMMAND_LIMITS[command].maxInputBytes) {
    throw new Error('director_command_input_too_large')
  }
  return wire
}

function normalizeQuery(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || !value
    || value.length > MAX_QUERY_LENGTH || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error('director_work_query_invalid')
  }
  return value
}

export function normalizedDirectorWorkQuery(value: unknown): string {
  return normalizeQuery(value)
}

export function directorWorkQueryDigest(value: unknown): string {
  const query = normalizeQuery(value)
  return directorEvidenceDigest({ authority: DIRECTOR_EVIDENCE_BINDING_AUTHORITY, query })
}

function validBinding(value: unknown): value is DirectorEvidenceBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const binding = value as Record<string, unknown>
  return Object.keys(binding).sort().join(',') === 'authority,queryDigest,workId'
    && binding.authority === DIRECTOR_EVIDENCE_BINDING_AUTHORITY
    && typeof binding.workId === 'string' && STABLE_ID.test(binding.workId)
    && typeof binding.queryDigest === 'string' && SHA256.test(binding.queryDigest)
}

export function directorEvidenceBindingFromInput(
  input: Record<string, unknown> | null | undefined,
): DirectorEvidenceBinding | null {
  return input && validBinding(input.directorEvidence) ? input.directorEvidence : null
}

export function sameDirectorEvidenceBinding(
  left: Record<string, unknown> | null | undefined,
  right: Record<string, unknown> | null | undefined,
): boolean {
  const a = directorEvidenceBindingFromInput(left)
  const b = directorEvidenceBindingFromInput(right)
  return (!a && !b) || Boolean(a && b
    && a.workId === b.workId
    && a.queryDigest === b.queryDigest)
}

export function directorEvidenceBindingForResolvedWork(
  workId: unknown,
  queryValue: unknown,
): DirectorEvidenceBinding {
  if (typeof workId !== 'string' || !STABLE_ID.test(workId)) {
    throw new Error('director_work_not_found')
  }
  const query = normalizeQuery(queryValue)
  return {
    authority: DIRECTOR_EVIDENCE_BINDING_AUTHORITY,
    workId,
    queryDigest: directorWorkQueryDigest(query),
  }
}

function rowToOutbox(row: OutboxRow): DirectorEvidenceOutbox {
  return {
    taskId: row.task_id, bindingId: row.binding_id, tenantId: row.tenant_id,
    workspaceId: row.workspace_id, workId: row.work_id,
    queryDigest: row.query_digest,
    projectionContractDigest: row.projection_contract_digest,
    idempotencyKey: row.idempotency_key, resultSha256: row.result_sha256,
    status: row.status, attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at, lastErrorCode: row.last_error_code,
    deliveredAt: row.delivered_at, createdAt: row.created_at, updatedAt: row.updated_at,
  }
}

function assertProjectionContractDigest(value: string): void {
  if (!SHA256.test(value)) throw new Error('director_evidence_projection_contract_invalid')
}

function immutableIdentityValues(item: DirectorEvidenceOutbox): unknown[] {
  return [
    item.taskId, item.bindingId, item.tenantId, item.workspaceId, item.workId,
    item.queryDigest, item.projectionContractDigest, item.idempotencyKey, item.resultSha256,
  ]
}

function sameImmutableIdentity(
  item: DirectorEvidenceOutbox,
  identity: Omit<DirectorEvidenceOutbox,
    'status' | 'attemptCount' | 'nextAttemptAt' | 'lastErrorCode' | 'deliveredAt' | 'createdAt' | 'updatedAt'>,
): boolean {
  return item.taskId === identity.taskId
    && item.bindingId === identity.bindingId
    && item.tenantId === identity.tenantId
    && item.workspaceId === identity.workspaceId
    && item.workId === identity.workId
    && item.queryDigest === identity.queryDigest
    && item.projectionContractDigest === identity.projectionContractDigest
    && item.idempotencyKey === identity.idempotencyKey
    && item.resultSha256 === identity.resultSha256
}

export function getDirectorEvidenceOutboxCore(
  db: Database.Database,
  taskId: string,
): DirectorEvidenceOutbox | null {
  const row = db.prepare('SELECT * FROM n8n_director_evidence_outbox WHERE task_id = ?')
    .get(taskId) as OutboxRow | undefined
  return row ? rowToOutbox(row) : null
}

export function getDirectorEvidenceOutboxCountsCore(
  db: Database.Database,
  currentProjectionContractDigest: string,
): { pending: number; delivered: number; conflict: number; incompatiblePending: number } {
  assertProjectionContractDigest(currentProjectionContractDigest)
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM n8n_director_evidence_outbox
    GROUP BY status
  `).all() as Array<{ status: DirectorEvidenceOutbox['status']; count: number }>
  const counts = { pending: 0, delivered: 0, conflict: 0, incompatiblePending: 0 }
  for (const row of rows) counts[row.status] = Number(row.count)
  counts.incompatiblePending = Number((db.prepare(`
    SELECT COUNT(*) AS count
    FROM n8n_director_evidence_outbox
    WHERE status = 'pending' AND projection_contract_digest <> ?
  `).get(currentProjectionContractDigest) as { count: number }).count)
  return counts
}

function buildOutboxIdentity(
  parent: N8nTaskRun,
  binding: DirectorEvidenceBinding,
  projectionContractDigest: string,
) {
  assertProjectionContractDigest(projectionContractDigest)
  const resultSha256 = directorEvidenceDigest(parent.output)
  const idempotencyKey = directorEvidenceDigest({
    authority: DIRECTOR_EVIDENCE_SOURCE_AUTHORITY,
    schemaVersion: 2,
    taskId: parent.taskId,
    workId: binding.workId,
    queryDigest: binding.queryDigest,
    resultSha256,
    projectionContractDigest,
  })
  return {
    taskId: parent.taskId,
    bindingId: parent.bindingId,
    tenantId: parent.tenantId,
    workspaceId: parent.workspaceId,
    workId: binding.workId,
    queryDigest: binding.queryDigest,
    projectionContractDigest,
    idempotencyKey,
    resultSha256,
  }
}

export function enqueueDirectorEvidenceOutboxCore(
  db: Database.Database,
  parent: N8nTaskRun,
  currentProjectionContractDigest: string,
  nowSeconds: number,
): 'skipped' | 'created' | 'existing' | 'conflict' {
  const binding = directorEvidenceBindingFromInput(parent.input)
  if (!binding || parent.status !== 'succeeded' || !parent.output) return 'skipped'
  const identity = buildOutboxIdentity(parent, binding, currentProjectionContractDigest)
  const existing = getDirectorEvidenceOutboxCore(db, parent.taskId)
  if (existing) {
    if (sameImmutableIdentity(existing, identity)) return 'existing'
    const transition = db.prepare(`
      UPDATE n8n_director_evidence_outbox
      SET status = 'conflict', last_error_code = 'director_evidence_identity_conflict', updated_at = ?
      WHERE task_id = ? AND binding_id = ? AND tenant_id = ? AND workspace_id = ?
        AND work_id = ? AND query_digest = ? AND projection_contract_digest = ?
        AND idempotency_key = ? AND result_sha256 = ? AND status = ?
    `).run(nowSeconds, ...immutableIdentityValues(existing), existing.status)
    if (transition.changes !== 1) throw new Error('director_evidence_outbox_state_changed')
    return 'conflict'
  }
  db.prepare(`
    INSERT INTO n8n_director_evidence_outbox (
      task_id, binding_id, tenant_id, workspace_id, work_id, query_digest,
      projection_contract_digest, idempotency_key, result_sha256, status, attempt_count,
      next_attempt_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(
    identity.taskId, identity.bindingId, identity.tenantId, identity.workspaceId,
    identity.workId, identity.queryDigest, identity.projectionContractDigest,
    identity.idempotencyKey, identity.resultSha256, nowSeconds, nowSeconds, nowSeconds,
  )
  return 'created'
}

function retryDelaySeconds(attemptCount: number): number {
  return Math.min(6 * 60 * 60, 60 * (2 ** Math.min(8, Math.max(0, attemptCount - 1))))
}

function safeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : 'director_evidence_projection_failed'
  return /^[A-Za-z0-9_:-]{1,200}$/u.test(message) ? message : 'director_evidence_projection_failed'
}

export function directorEvidenceDeliveryErrorIsDeterministic(
  code: string,
  options: { commandInputContractGuaranteed: boolean },
): boolean {
  return (code.startsWith('director_evidence_')
      && code !== 'director_evidence_projection_failed'
      && code !== 'director_evidence_projection_result_invalid')
    || code === 'director_command_input_invalid'
    || code === 'director_command_input_too_large'
    || (code === 'director_command_output_too_large'
      && options.commandInputContractGuaranteed)
    || code.startsWith('evidence_projection_conflict')
    || code.startsWith('duplicate_stable_record_id')
    || code === 'director_work_not_found'
}

function pendingCasValues(item: DirectorEvidenceOutbox): unknown[] {
  return immutableIdentityValues(item)
}

function parseAuthorityObject(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

async function deliverOutbox(
  db: Database.Database,
  item: DirectorEvidenceOutbox,
  options: {
    currentProjectionContractDigest: string
    nowSeconds: () => number
    runner: DirectorCommandRunner
  },
): Promise<'delivered' | 'pending' | 'conflict'> {
  if (item.projectionContractDigest !== options.currentProjectionContractDigest) {
    const attemptCount = item.attemptCount + 1
    const settledAt = options.nowSeconds()
    const transition = db.prepare(`
      UPDATE n8n_director_evidence_outbox
      SET attempt_count = ?, next_attempt_at = ?,
        last_error_code = 'director_evidence_projection_contract_incompatible', updated_at = ?
      WHERE task_id = ? AND binding_id = ? AND tenant_id = ? AND workspace_id = ?
        AND work_id = ? AND query_digest = ? AND projection_contract_digest = ?
        AND idempotency_key = ? AND result_sha256 = ? AND status = 'pending'
    `).run(
      attemptCount, settledAt + retryDelaySeconds(attemptCount), settledAt,
      ...pendingCasValues(item),
    )
    if (transition.changes !== 1) throw new Error('director_evidence_outbox_state_changed')
    return 'pending'
  }

  const row = db.prepare(`
    SELECT run.status, run.output, run.input, binding.task_type
    FROM n8n_task_runs run
    JOIN n8n_workflow_bindings binding
      ON binding.id = run.binding_id
     AND binding.tenant_id = run.tenant_id
     AND binding.workspace_id = run.workspace_id
    WHERE run.task_id = ? AND run.binding_id = ? AND run.tenant_id = ? AND run.workspace_id = ?
  `).get(item.taskId, item.bindingId, item.tenantId, item.workspaceId) as {
    status: string
    output: string | null
    input: string | null
    task_type: string
  } | undefined
  const output = parseAuthorityObject(row?.output ?? null)
  const input = parseAuthorityObject(row?.input ?? null)
  const binding = directorEvidenceBindingFromInput(input)
  if (!row || row.status !== 'succeeded' || row.task_type !== 'video-analysis'
    || !output || directorEvidenceDigest(output) !== item.resultSha256
    || binding?.workId !== item.workId || binding?.queryDigest !== item.queryDigest) {
    const settledAt = options.nowSeconds()
    const transition = db.prepare(`
      UPDATE n8n_director_evidence_outbox
      SET status = 'conflict', last_error_code = 'director_evidence_authority_conflict', updated_at = ?
      WHERE task_id = ? AND binding_id = ? AND tenant_id = ? AND workspace_id = ?
        AND work_id = ? AND query_digest = ? AND projection_contract_digest = ?
        AND idempotency_key = ? AND result_sha256 = ? AND status = 'pending'
    `).run(settledAt, ...pendingCasValues(item))
    if (transition.changes !== 1) throw new Error('director_evidence_outbox_state_changed')
    return 'conflict'
  }

  let commandInputContractGuaranteed = false
  try {
    const transformInput = directorEvidenceTransformEnvelope(item, output)
    serializeDirectorCommandInput('transform', transformInput)
    commandInputContractGuaranteed = true
    const projection = await options.runner('transform', transformInput)
    let projected = 0
    const batches = directorEvidenceProjectionBatches(projection, item.workId)
    for (const batch of batches) {
      serializeDirectorCommandInput('project-evidence', batch)
      const result = await options.runner('project-evidence', batch)
      projected += directorEvidenceProjectionResultCount(result, batch)
    }
    if (projected !== batches.reduce((count, batch) => count + batch.items.length, 0)) {
      throw new Error('director_evidence_projection_result_invalid')
    }
  } catch (error) {
    const code = safeErrorCode(error)
    const conflict = directorEvidenceDeliveryErrorIsDeterministic(code, {
      commandInputContractGuaranteed,
    })
    const attemptCount = item.attemptCount + 1
    const settledAt = options.nowSeconds()
    const transition = db.prepare(`
      UPDATE n8n_director_evidence_outbox
      SET status = ?, attempt_count = ?, next_attempt_at = ?, last_error_code = ?, updated_at = ?
      WHERE task_id = ? AND binding_id = ? AND tenant_id = ? AND workspace_id = ?
        AND work_id = ? AND query_digest = ? AND projection_contract_digest = ?
        AND idempotency_key = ? AND result_sha256 = ? AND status = 'pending'
    `).run(
      conflict ? 'conflict' : 'pending', attemptCount,
      conflict ? item.nextAttemptAt : settledAt + retryDelaySeconds(attemptCount),
      code, settledAt, ...pendingCasValues(item),
    )
    if (transition.changes !== 1) throw new Error('director_evidence_outbox_state_changed')
    return conflict ? 'conflict' : 'pending'
  }
  const settledAt = options.nowSeconds()
  const transition = db.prepare(`
    UPDATE n8n_director_evidence_outbox
    SET status = 'delivered', delivered_at = ?, last_error_code = NULL, updated_at = ?
    WHERE task_id = ? AND binding_id = ? AND tenant_id = ? AND workspace_id = ?
      AND work_id = ? AND query_digest = ? AND projection_contract_digest = ?
      AND idempotency_key = ? AND result_sha256 = ? AND status = 'pending'
  `).run(settledAt, settledAt, ...pendingCasValues(item))
  if (transition.changes !== 1) throw new Error('director_evidence_outbox_state_changed')
  return 'delivered'
}

export async function drainDirectorEvidenceOutboxCore(
  db: Database.Database,
  options: {
    currentProjectionContractDigest: string
    nowSeconds?: number
    now?: () => number
    limit?: number
    runner: DirectorCommandRunner
  },
): Promise<{ scanned: number; delivered: number; pending: number; conflict: number }> {
  assertProjectionContractDigest(options.currentProjectionContractDigest)
  const fixedNow = Number.isSafeInteger(options.nowSeconds)
    ? Math.max(0, Number(options.nowSeconds)) : null
  const nowSeconds = () => fixedNow ?? Math.max(0, Math.floor(
    options.now ? options.now() : Date.now() / 1_000,
  ))
  const limit = Number.isSafeInteger(options.limit)
    ? Math.max(1, Math.min(100, Number(options.limit))) : 20
  const rows = db.prepare(`
    SELECT * FROM n8n_director_evidence_outbox
    WHERE status = 'pending' AND next_attempt_at <= ?
    ORDER BY next_attempt_at ASC, updated_at ASC, task_id ASC
    LIMIT ?
  `).all(nowSeconds(), limit) as OutboxRow[]
  const result = { scanned: rows.length, delivered: 0, pending: 0, conflict: 0 }
  for (const row of rows) {
    const outcome = await deliverOutbox(db, rowToOutbox(row), {
      currentProjectionContractDigest: options.currentProjectionContractDigest,
      nowSeconds,
      runner: options.runner,
    })
    result[outcome]++
  }
  return result
}
