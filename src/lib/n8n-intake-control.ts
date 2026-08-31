import type Database from 'better-sqlite3'
import { z } from 'zod'
import {
  createN8nTaskRun,
  getN8nTaskRunByIdempotencyKey,
  type N8nTaskRun,
  type N8nTaskScope,
} from '@/lib/n8n-task-runs'

export const n8nIntakeControlMutationSchema = z.object({
  action: z.enum(['drain', 'resume']),
  reason: z.string().trim().min(8).max(300),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
}).strict()

export const N8N_INTAKE_CONTROL_SCHEMA = 'video-autoworker-intake-control/v1' as const

export type N8nIntakeControlAction = z.infer<typeof n8nIntakeControlMutationSchema>['action']

export interface N8nIntakeControlActor {
  id: number
  name: string
}

export interface N8nIntakeCounts {
  queued: number
  accepted: number
  running: number
  waiting: number
  active: number
}

export interface N8nIntakeControl {
  schema: typeof N8N_INTAKE_CONTROL_SCHEMA
  globalScope: true
  mode: 'active' | 'draining' | 'paused'
  accepting: boolean
  revision: number
  reason: string | null
  changedBy: N8nIntakeControlActor | null
  changedAt: number | null
  counts: N8nIntakeCounts
}

interface N8nIntakeControlRow {
  accepting: number
  reason: string
  changed_by_id: number
  changed_by_name: string
  changed_at: number
  revision: number
}

interface N8nIntakeCountRow {
  queued: number | null
  accepted: number | null
  running: number | null
}

export type N8nTaskRunCreateInput = Parameters<typeof createN8nTaskRun>[1]

export type N8nGatedTaskRunCreation =
  | { outcome: 'created' | 'existing'; run: N8nTaskRun; control: N8nIntakeControl }
  | { outcome: 'blocked'; run: null; control: N8nIntakeControl }

function assertScope(scope: N8nTaskScope): void {
  if (
    !Number.isSafeInteger(scope.tenantId)
    || scope.tenantId <= 0
    || !Number.isSafeInteger(scope.workspaceId)
    || scope.workspaceId <= 0
  ) throw new TypeError('n8n intake scope is invalid')
}

function readCounts(db: Database.Database): N8nIntakeCounts {
  const row = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
    FROM n8n_task_runs
    WHERE status IN ('queued', 'accepted', 'running')
  `).get() as N8nIntakeCountRow
  const queued = Number(row?.queued || 0)
  const accepted = Number(row?.accepted || 0)
  const running = Number(row?.running || 0)
  return {
    queued,
    accepted,
    running,
    waiting: queued + accepted,
    active: queued + accepted + running,
  }
}

export function getN8nIntakeControl(
  db: Database.Database,
): N8nIntakeControl {
  const row = db.prepare(`
    SELECT accepting, reason, changed_by_id, changed_by_name, changed_at, revision
    FROM n8n_intake_controls
    WHERE control_id = 1
  `).get() as N8nIntakeControlRow | undefined
  const counts = readCounts(db)
  const accepting = row ? row.accepting === 1 : true
  return {
    schema: N8N_INTAKE_CONTROL_SCHEMA,
    globalScope: true,
    mode: accepting ? 'active' : counts.active > 0 ? 'draining' : 'paused',
    accepting,
    revision: row?.revision || 0,
    reason: row?.reason || null,
    changedBy: row ? { id: row.changed_by_id, name: row.changed_by_name } : null,
    changedAt: row?.changed_at || null,
    counts,
  }
}

export function setN8nIntakeControl(
  db: Database.Database,
  input: z.infer<typeof n8nIntakeControlMutationSchema>,
  actor: N8nIntakeControlActor,
): { outcome: 'updated' | 'conflict'; control: N8nIntakeControl } {
  const parsed = n8nIntakeControlMutationSchema.parse(input)
  if (!Number.isSafeInteger(actor.id)) throw new TypeError('n8n intake actor is invalid')
  const actorName = String(actor.name || '').trim()
  if (!actorName || actorName.length > 120) throw new TypeError('n8n intake actor is invalid')

  const update = db.transaction(() => {
    const current = getN8nIntakeControl(db)
    if (current.revision !== parsed.expectedRevision) {
      return { outcome: 'conflict' as const, control: current }
    }

    const accepting = parsed.action === 'resume'
    const nextRevision = current.revision + 1
    const now = Math.floor(Date.now() / 1_000)
    db.prepare(`
      INSERT INTO n8n_intake_controls (
        control_id, accepting, reason, changed_by_id,
        changed_by_name, changed_at, revision
      ) VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(control_id) DO UPDATE SET
        accepting = excluded.accepting,
        reason = excluded.reason,
        changed_by_id = excluded.changed_by_id,
        changed_by_name = excluded.changed_by_name,
        changed_at = excluded.changed_at,
        revision = excluded.revision
    `).run(
      accepting ? 1 : 0,
      parsed.reason,
      actor.id,
      actorName,
      now,
      nextRevision,
    )
    db.prepare(`
      INSERT INTO n8n_intake_control_events (
        action, before_accepting, after_accepting,
        reason, actor_id, actor_name, control_revision, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      parsed.action,
      current.accepting ? 1 : 0,
      accepting ? 1 : 0,
      parsed.reason,
      actor.id,
      actorName,
      nextRevision,
      now,
    )
    return { outcome: 'updated' as const, control: getN8nIntakeControl(db) }
  })

  return update.immediate()
}

/**
 * Linearize a new task row with the global intake gate. Existing
 * idempotent runs remain readable while draining so callers never resubmit an
 * operation whose admission already committed.
 */
export function createN8nTaskRunWithIntakeGate(
  db: Database.Database,
  input: N8nTaskRunCreateInput,
  scope: N8nTaskScope,
): N8nGatedTaskRunCreation {
  assertScope(scope)
  const create = db.transaction(() => {
    const existing = getN8nTaskRunByIdempotencyKey(db, input.idempotencyKey, scope)
    if (existing) {
      return { outcome: 'existing' as const, run: existing, control: getN8nIntakeControl(db) }
    }
    const control = getN8nIntakeControl(db)
    if (!control.accepting) return { outcome: 'blocked' as const, run: null, control }
    const created = createN8nTaskRun(db, input, scope)
    return {
      outcome: created.created ? 'created' as const : 'existing' as const,
      run: created.run,
      control: getN8nIntakeControl(db),
    }
  })
  return create.immediate()
}
