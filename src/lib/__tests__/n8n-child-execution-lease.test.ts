import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import {
  claimScopedN8nTaskRun,
  completeN8nChildExecution,
  createAndClaimN8nChildRunFromParent,
  createN8nTaskRun,
  getN8nTaskRunByTaskId,
  pollN8nChildExecutionResult,
  renewN8nChildExecutionLease,
} from '@/lib/n8n-task-runs'

const scope = { tenantId: 3, workspaceId: 2 }
const ownerA = 'a'.repeat(64)
const ownerB = 'b'.repeat(64)

function createParent(db: Database.Database, taskId = 'parent'): void {
  createN8nTaskRun(db, {
    taskId,
    idempotencyKey: `${taskId}-idem`,
    bindingId: 9,
    source: 'openclaw',
    requestedBy: 'operator',
    routing: {
      callbackProtocol: 'slot-v1',
      runtimeSlot: 'blue',
      runtimeReleaseId: 'release-a',
      nodeCallbackUrl: 'http://127.0.0.1:3317/api/n8n/node-execute',
    },
    taskInput: {},
    delivery: { mode: 'none' },
    maxAttempts: 2,
  }, scope)
  db.prepare(`UPDATE n8n_task_runs SET status = 'running', attempt_count = 1 WHERE task_id = ?`).run(taskId)
  db.prepare(`
    INSERT INTO n8n_parent_execution_claims (
      task_id, tenant_id, workspace_id, execution_owner
    ) VALUES (?, 3, 2, 'n8n-execution:wf:1')
  `).run(taskId)
}

function childInput(parentTaskId: string, ownerInstanceId: string) {
  return {
    parentTaskId,
    parentIdempotencyKey: `${parentTaskId}-idem`,
    bindingId: 9,
    childTaskId: `node:${parentTaskId}:planner`,
    childIdempotencyKey: `node-idem:${parentTaskId}:planner`,
    source: 'n8n-node' as const,
    routing: { nodeKey: 'planner' },
    taskInput: { prompt: 'plan' },
    delivery: { mode: 'none' as const },
    maxAttempts: 2,
    ownerInstanceId,
    executionOwner: 'n8n-execution:wf:1',
  }
}

describe('n8n child execution leases', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    createParent(db)
  })

  afterEach(() => db.close())

  it('never lets one process instance self-take over, including after expiry', () => {
    const first = createAndClaimN8nChildRunFromParent(
      db, childInput('parent', ownerA), scope,
      { nowSeconds: 100, leaseSeconds: 5, leaseToken: 'c'.repeat(64) },
    )
    const duplicate = createAndClaimN8nChildRunFromParent(
      db, childInput('parent', ownerA), scope,
      { nowSeconds: 200, leaseSeconds: 5, leaseToken: 'd'.repeat(64) },
    )

    expect(first).toMatchObject({ outcome: 'claimed', child: { attemptCount: 1 } })
    expect(duplicate).toMatchObject({
      outcome: 'running',
      child: { attemptCount: 1 },
      lease: { ownerInstanceId: ownerA, leaseToken: 'c'.repeat(64), revision: 1 },
    })
  })

  it('fences a killed instance, lets the replacement resume, and rejects the old result', () => {
    const killed = createAndClaimN8nChildRunFromParent(
      db, childInput('parent', ownerA), scope,
      { nowSeconds: 100, leaseSeconds: 5, leaseToken: 'c'.repeat(64) },
    )
    const replacement = createAndClaimN8nChildRunFromParent(
      db, childInput('parent', ownerB), scope,
      { nowSeconds: 106, leaseSeconds: 900, leaseToken: 'd'.repeat(64) },
    )

    expect(replacement).toMatchObject({
      outcome: 'claimed',
      child: { status: 'running', attemptCount: 2 },
      lease: { ownerInstanceId: ownerB, leaseToken: 'd'.repeat(64), revision: 2 },
    })
    expect(completeN8nChildExecution(db, killed.lease!, { text: 'late-old' }, scope, { nowSeconds: 107 }).settled)
      .toBe(false)
    expect(completeN8nChildExecution(db, replacement.lease!, { text: 'replacement-output' }, scope, { nowSeconds: 107 }).settled)
      .toBe(true)
    expect(getN8nTaskRunByTaskId(db, replacement.child!.taskId)).toMatchObject({
      status: 'succeeded',
      output: { text: 'replacement-output' },
      attemptCount: 2,
    })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM n8n_child_execution_leases`).get())
      .toEqual({ count: 0 })
  })

  it('does not let another process take over before the current lease expires', () => {
    createAndClaimN8nChildRunFromParent(
      db, childInput('parent', ownerA), scope,
      { nowSeconds: 100, leaseSeconds: 900, leaseToken: 'c'.repeat(64) },
    )

    const contender = createAndClaimN8nChildRunFromParent(
      db, childInput('parent', ownerB), scope,
      { nowSeconds: 101, leaseSeconds: 900, leaseToken: 'd'.repeat(64) },
    )

    expect(contender).toMatchObject({
      outcome: 'running',
      child: { attemptCount: 1 },
      lease: { ownerInstanceId: ownerA, leaseToken: 'c'.repeat(64), revision: 1 },
    })
  })

  it('rejects child creation for a different n8n execution owner', () => {
    const rejected = createAndClaimN8nChildRunFromParent(
      db,
      { ...childInput('parent', ownerA), executionOwner: 'n8n-execution:wf:2' },
      scope,
      { nowSeconds: 100, leaseSeconds: 900, leaseToken: 'c'.repeat(64) },
    )

    expect(rejected).toMatchObject({ outcome: 'rejected', child: null, lease: null })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM n8n_task_runs WHERE source = 'n8n-node'`).get())
      .toEqual({ count: 0 })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM n8n_child_execution_leases`).get())
      .toEqual({ count: 0 })

    const claimed = createAndClaimN8nChildRunFromParent(
      db,
      childInput('parent', ownerA),
      scope,
      { nowSeconds: 100, leaseSeconds: 900, leaseToken: 'd'.repeat(64) },
    )
    expect(claimed).toMatchObject({ outcome: 'claimed', child: { status: 'running' } })
  })

  it('polls a running child until the persisted cached success is observable', async () => {
    const running = createAndClaimN8nChildRunFromParent(
      db, childInput('parent', ownerA), scope,
      { nowSeconds: 100, leaseSeconds: 900, leaseToken: 'c'.repeat(64) },
    )
    const succeeded = {
      ...running,
      outcome: 'succeeded' as const,
      child: { ...running.child!, status: 'succeeded', output: { text: 'cached' } },
      lease: null,
    }
    let attempts = 0

    const result = await pollN8nChildExecutionResult(() => {
      attempts += 1
      return succeeded
    }, { ...running, outcome: 'running' }, { waitSeconds: 1, pollMilliseconds: 10 })

    expect(result).toMatchObject({ outcome: 'succeeded', child: { output: { text: 'cached' } } })
    expect(attempts).toBe(1)
  })

  it('extends an owned lease heartbeat and atomically deletes a dispatch lease on parent claim', () => {
    createParent(db, 'claim-parent')
    db.prepare(`UPDATE n8n_task_runs SET status = 'queued', attempt_count = 0 WHERE task_id = 'claim-parent'`).run()
    db.prepare(`DELETE FROM n8n_parent_execution_claims WHERE task_id = 'claim-parent'`).run()
    db.prepare(`
      INSERT INTO n8n_task_dispatch_leases (
        task_id, tenant_id, workspace_id, owner_token, lease_expires_at, revision
      ) VALUES ('claim-parent', 3, 2, ?, 999, 1)
    `).run('e'.repeat(64))
    // The canonical migrations already create the binding table; seed the
    // smallest valid registered binding without coupling this test to APIs.
    db.prepare(`
      INSERT INTO n8n_workflow_bindings (
        name, task_type, workflow_id, webhook_path, agent_role, model,
        enabled, timeout_seconds, retry_count, config, workspace_id, tenant_id
      ) VALUES ('generic', 'generic-task', 'wf-1', 'webhook/task', 'executor',
        'model', 1, 30, 1, '{}', 2, 3)
    `).run()
    const bindingId = Number((db.prepare(`SELECT id FROM n8n_workflow_bindings WHERE workflow_id = 'wf-1'`).get() as { id: number }).id)
    db.prepare(`UPDATE n8n_task_runs SET binding_id = ? WHERE task_id = 'claim-parent'`).run(bindingId)

    expect(claimScopedN8nTaskRun(db, {
      taskId: 'claim-parent', idempotencyKey: 'claim-parent-idem', bindingId,
      executionOwner: 'n8n-execution:claim-1',
    }, scope)).toMatchObject({ outcome: 'claimed', run: { status: 'running' } })
    expect(db.prepare(`SELECT COUNT(*) AS count FROM n8n_task_dispatch_leases WHERE task_id = 'claim-parent'`).get())
      .toEqual({ count: 0 })
    expect(claimScopedN8nTaskRun(db, {
      taskId: 'claim-parent', idempotencyKey: 'claim-parent-idem', bindingId,
      executionOwner: 'n8n-execution:claim-1',
    }, scope)).toMatchObject({ outcome: 'owned', run: { status: 'running' } })
    expect(claimScopedN8nTaskRun(db, {
      taskId: 'claim-parent', idempotencyKey: 'claim-parent-idem', bindingId,
      executionOwner: 'n8n-execution:claim-2',
    }, scope)).toMatchObject({ outcome: 'running', run: { status: 'running' } })

    const child = createAndClaimN8nChildRunFromParent(
      db,
      {
        ...childInput('claim-parent', ownerA),
        bindingId,
        executionOwner: 'n8n-execution:claim-1',
      },
      scope,
      { nowSeconds: 300, leaseSeconds: 10, leaseToken: 'f'.repeat(64) },
    )
    expect(renewN8nChildExecutionLease(db, child.lease!, scope, { nowSeconds: 305, leaseSeconds: 10 }))
      .toMatchObject({ leaseExpiresAt: 315 })
  })
})
