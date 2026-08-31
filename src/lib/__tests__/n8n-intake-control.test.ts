import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import {
  createN8nTaskRunWithIntakeGate,
  getN8nIntakeControl,
  n8nIntakeControlMutationSchema,
  setN8nIntakeControl,
  type N8nTaskRunCreateInput,
} from '@/lib/n8n-intake-control'

const scope = { tenantId: 3, workspaceId: 2 }
const otherScope = { tenantId: 4, workspaceId: 2 }
const actor = { id: 7, name: 'release-admin' }

function task(taskId: string, idempotencyKey = taskId): N8nTaskRunCreateInput {
  return {
    taskId,
    idempotencyKey,
    bindingId: 9,
    source: 'openclaw',
    requestedBy: 'operator',
    routing: { taskType: 'video-analysis' },
    taskInput: { prompt: 'test' },
    delivery: { mode: 'none' },
    maxAttempts: 2,
  }
}

describe('n8n intake control', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
  })

  afterEach(() => db.close())

  it('defaults the global gate to active revision zero', () => {
    expect(getN8nIntakeControl(db)).toEqual({
      schema: 'video-autoworker-intake-control/v1',
      globalScope: true,
      mode: 'active',
      accepting: true,
      revision: 0,
      reason: null,
      changedBy: null,
      changedAt: null,
      counts: { queued: 0, accepted: 0, running: 0, waiting: 0, active: 0 },
    })
  })

  it('uses optimistic revisions and applies the control to every tenant and workspace', () => {
    const drained = setN8nIntakeControl(db, {
      action: 'drain',
      reason: '准备发布新的服务版本',
      expectedRevision: 0,
    }, actor)
    expect(drained).toMatchObject({
      outcome: 'updated',
      control: {
        mode: 'paused',
        accepting: false,
        revision: 1,
        reason: '准备发布新的服务版本',
        changedBy: actor,
      },
    })
    expect(getN8nIntakeControl(db)).toMatchObject({
      globalScope: true,
      accepting: false,
      revision: 1,
    })

    const conflict = setN8nIntakeControl(db, {
      action: 'resume',
      reason: '发布已经结束恢复任务入口',
      expectedRevision: 0,
    }, actor)
    expect(conflict).toMatchObject({ outcome: 'conflict', control: { accepting: false, revision: 1 } })
    expect(db.prepare('SELECT COUNT(*) AS count FROM n8n_intake_control_events').get())
      .toEqual({ count: 1 })
  })

  it('records the global event in the same transaction as the control update', () => {
    db.exec(`
      CREATE TRIGGER reject_intake_event
      BEFORE INSERT ON n8n_intake_control_events
      BEGIN
        SELECT RAISE(ABORT, 'audit unavailable');
      END;
    `)
    expect(() => setN8nIntakeControl(db, {
      action: 'drain',
      reason: '准备发布新的服务版本',
      expectedRevision: 0,
    }, actor)).toThrow(/audit unavailable/)
    expect(getN8nIntakeControl(db)).toMatchObject({ accepting: true, revision: 0 })
    expect(db.prepare('SELECT COUNT(*) AS count FROM n8n_intake_controls').get())
      .toEqual({ count: 0 })
  })

  it('blocks only new runs while allowing an admitted idempotent run to be read during drain', () => {
    const created = createN8nTaskRunWithIntakeGate(db, task('existing-task', 'same-key'), scope)
    expect(created.outcome).toBe('created')
    const drained = setN8nIntakeControl(db, {
      action: 'drain',
      reason: '等待当前任务自然排空完成',
      expectedRevision: 0,
    }, actor)
    expect(drained).toMatchObject({
      outcome: 'updated',
      control: { mode: 'draining', counts: { queued: 1, active: 1 } },
    })

    const existing = createN8nTaskRunWithIntakeGate(db, task('different-task', 'same-key'), scope)
    expect(existing).toMatchObject({ outcome: 'existing', run: { taskId: 'existing-task' } })
    const blocked = createN8nTaskRunWithIntakeGate(db, task('new-task'), scope)
    expect(blocked).toMatchObject({ outcome: 'blocked', run: null, control: { accepting: false } })
    expect(createN8nTaskRunWithIntakeGate(db, task('other-tenant-task'), otherScope).outcome)
      .toBe('blocked')
  })

  it('requires a bounded non-trivial reason and rejects extra fields', () => {
    expect(n8nIntakeControlMutationSchema.safeParse({
      action: 'drain', reason: '太短', expectedRevision: 0,
    }).success).toBe(false)
    expect(n8nIntakeControlMutationSchema.safeParse({
      action: 'drain', reason: '准备发布新的服务版本', expectedRevision: 0, actor: 'forged',
    }).success).toBe(false)
  })
})
