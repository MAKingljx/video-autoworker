import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { createN8nMediaChildRunFromParent, createN8nTaskRun } from '@/lib/n8n-task-runs'
import {
  buildN8nReleaseReadiness,
  checkN8nCallbackAdmission,
  getN8nRollingDatabaseCompatibility,
  getN8nRuntimeDrainStatus,
  resolveN8nRuntimeAffinity,
  resolveN8nRuntimeIdentity,
  type N8nRuntimeIdentity,
} from '@/lib/n8n-runtime-affinity'

const scope = { tenantId: 3, workspaceId: 2 }
const runtime: N8nRuntimeIdentity = {
  callbackProtocol: 'slot-v1',
  runtimeSlot: 'blue',
  runtimeReleaseId: 'release-a',
  port: 3317,
  startedAt: 800,
}

function createRun(
  db: Database.Database,
  taskId: string,
  routing: Record<string, unknown>,
  source = 'openclaw',
): void {
  createN8nTaskRun(db, {
    taskId,
    idempotencyKey: taskId,
    bindingId: 9,
    source,
    requestedBy: 'operator',
    routing,
    taskInput: { prompt: 'test' },
    delivery: { mode: 'none' },
    maxAttempts: 2,
  }, scope)
}

describe('n8n blue/green runtime affinity', () => {
  let db: Database.Database
  let temporaryRoot: string

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    temporaryRoot = mkdtempSync(join(tmpdir(), 'n8n-runtime-affinity-'))
  })

  afterEach(() => {
    db.close()
    rmSync(temporaryRoot, { recursive: true, force: true })
  })

  it('omits affinity for a legacy runtime and fails closed on partial slot identity', () => {
    expect(resolveN8nRuntimeAffinity({ PORT: '3017' })).toBeNull()
    expect(() => resolveN8nRuntimeAffinity({ AIWORKER_SLOT: 'blue' })).toThrow(/release/)
    expect(() => resolveN8nRuntimeAffinity({ AIWORKER_RELEASE_ID: 'release-a' })).toThrow(/槽位/)
  })

  it('derives a bounded release owner without persisting host or process identifiers', () => {
    expect(resolveN8nRuntimeIdentity({
      AIWORKER_SLOT: 'green',
      AIWORKER_RELEASE_ID: 'release-20260831',
      PORT: '3417',
    }, { nowSeconds: 1_000, uptimeSeconds: 50 })).toEqual({
      callbackProtocol: 'slot-v1',
      runtimeSlot: 'green',
      runtimeReleaseId: 'release-20260831',
      port: 3417,
      startedAt: 950,
    })

    const environment = {
      AIWORKER_SLOT: 'green',
      AIWORKER_RELEASE_ID: 'release-20260831',
      PORT: '3417',
    }
    expect(resolveN8nRuntimeIdentity(environment)?.startedAt)
      .toBe(resolveN8nRuntimeIdentity(environment)?.startedAt)
  })

  it('requires explicit legacy compatibility instead of inferring missing ownership', () => {
    expect(checkN8nCallbackAdmission({}, {})).toMatchObject({
      allowed: false,
      code: 'runtime_affinity_missing',
    })
    expect(checkN8nCallbackAdmission({ callbackProtocol: 'legacy-v1' }, {}))
      .toEqual({ allowed: true, mode: 'legacy' })
    expect(checkN8nCallbackAdmission({}, { AIWORKER_ALLOW_LEGACY_N8N_CALLBACKS: '1' }))
      .toEqual({ allowed: true, mode: 'legacy' })
  })

  it('admits only the owning slot release and rejects it after an atomic freeze marker appears', () => {
    const freezeFile = join(temporaryRoot, 'blue.callbacks-frozen.json')
    const environment = {
      AIWORKER_SLOT: 'blue',
      AIWORKER_RELEASE_ID: 'release-a',
      AIWORKER_N8N_CALLBACK_FREEZE_FILE: freezeFile,
    }
    const routing = {
      callbackProtocol: 'slot-v1',
      runtimeSlot: 'blue',
      runtimeReleaseId: 'release-a',
    }
    expect(checkN8nCallbackAdmission(routing, environment)).toEqual({ allowed: true, mode: 'slot' })
    expect(checkN8nCallbackAdmission({ ...routing, runtimeReleaseId: 'release-b' }, environment))
      .toMatchObject({ allowed: false, code: 'runtime_affinity_mismatch' })

    writeFileSync(freezeFile, `${JSON.stringify({
      schema: 'video-autoworker-callback-freeze/v1',
      slot: 'blue',
      releaseId: 'release-a',
      manifestSha256: 'a'.repeat(64),
      pid: 123,
      dbPath: '/tmp/mission-control.db',
      routerStatePath: '/tmp/router-state.json',
      routerGeneration: 2,
      activeSlot: 'green',
      requiredQuietSeconds: 120,
      runtimeStartedAt: 800,
      schedulerObservedAt: 990,
      routerActiveRequests: 0,
      routerUpgradedSockets: 0,
      freezeId: 'b'.repeat(64),
      frozenAt: 1_000,
      quiesceId: null,
      quiescedAt: null,
    })}\n`, { mode: 0o600 })

    expect(checkN8nCallbackAdmission(routing, environment))
      .toMatchObject({ allowed: false, code: 'callback_frozen' })
  })

  it('allows a release switch with active work only after the global intake gate closes', () => {
    const control = {
      schema: 'video-autoworker-intake-control/v1' as const,
      globalScope: true as const,
      mode: 'draining' as const,
      accepting: false,
      revision: 2,
      reason: '准备发布新的服务版本',
      changedBy: { id: 7, name: 'release-admin' },
      changedAt: 900,
      counts: { active: 3, queued: 1, accepted: 1, running: 1, waiting: 2 },
    }
    const retirement = {
      schema: 'video-autoworker-runtime-drain/v1' as const,
      globalScope: true as const,
      runtime,
      counts: {
        tracked: 3,
        active: 3,
        queued: 1,
        accepted: 1,
        running: 1,
        topLevel: 1,
        mediaNodes: 2,
        modelNodes: 0,
        childExecutionLeases: 0,
        untrackedCallbacks: 0,
        otherReleaseActive: 0,
      },
      lastActivityAt: 990,
      quietSince: 990,
      quietSeconds: 10,
      requiredQuietSeconds: 120,
      safeToRetire: false,
      observedAt: 1_000,
    }
    const scheduler = {
      state: 'leader' as const,
      leaseExpiresAt: 1_030,
      leaseExpired: false,
      observedAt: 1_000,
      reason: 'slot_active',
      routerGeneration: 4,
      activeJobs: 1,
    }
    expect(buildN8nReleaseReadiness(
      control,
      runtime,
      retirement,
      scheduler,
      getN8nRollingDatabaseCompatibility(db),
      { nowSeconds: 1_000 },
    )).toEqual({
      schema: 'video-autoworker-release-readiness/v1',
      globalScope: true,
      observedAt: 1_000,
      intake: {
        schema: 'video-autoworker-intake-control/v1',
        accepting: false,
        mode: 'draining',
        revision: 2,
        counts: { active: 3, queued: 1, accepted: 1, running: 1, waiting: 2 },
      },
      runtime,
      database: {
        schemaEpoch: 1,
        rollingSafeFrom: '052_n8n_intake_controls',
        latestMigration: '056_n8n_parent_execution_claims',
      },
      retirement,
      scheduler,
    })
    expect(() => buildN8nReleaseReadiness({
      ...control,
      mode: 'active',
      accepting: true,
    }, runtime, retirement, scheduler, getN8nRollingDatabaseCompatibility(db))).toThrow(/still accepting/)
    expect(() => buildN8nReleaseReadiness(
      control,
      runtime,
      { ...retirement, runtime: { ...runtime, runtimeReleaseId: 'release-forged' } },
      scheduler,
      getN8nRollingDatabaseCompatibility(db),
    )).toThrow(/does not match/)
  })

  it('blocks retirement while any owned parent or child is active', () => {
    const routing = {
      callbackProtocol: 'slot-v1',
      runtimeSlot: 'blue',
      runtimeReleaseId: 'release-a',
      claimCallbackUrl: 'http://127.0.0.1:3317/api/n8n/claim',
      mediaCallbackUrl: 'http://127.0.0.1:3317/api/n8n/media-execute',
      nodeCallbackUrl: 'http://127.0.0.1:3317/api/n8n/node-execute',
    }
    createRun(db, 'parent', routing)
    createRun(db, 'media-child', routing, 'n8n-media-node')
    db.prepare(`
      UPDATE n8n_task_runs
      SET status = CASE WHEN task_id = 'parent' THEN 'running' ELSE 'accepted' END,
          updated_at = 990
    `).run()

    expect(getN8nRuntimeDrainStatus(db, runtime, { nowSeconds: 1_000 })).toMatchObject({
      counts: { tracked: 2, active: 2, running: 1, accepted: 1, topLevel: 1, mediaNodes: 1 },
      quietSeconds: 10,
      safeToRetire: false,
    })
  })

  it('inherits release ownership when the canonical task service creates a media child', () => {
    const routing = {
      callbackProtocol: 'slot-v1',
      runtimeSlot: 'blue',
      runtimeReleaseId: 'release-a',
      taskType: 'video-analysis',
    }
    createRun(db, 'inherited-parent', routing)

    const created = createN8nMediaChildRunFromParent(db, {
      parentTaskId: 'inherited-parent',
      parentIdempotencyKey: 'inherited-parent',
      stage: 'vision',
      taskInput: {},
    })

    expect(created).toMatchObject({
      outcome: 'created',
      child: {
        source: 'n8n-media-node',
        routing: {
          callbackProtocol: 'slot-v1',
          runtimeSlot: 'blue',
          runtimeReleaseId: 'release-a',
        },
      },
    })
    expect(getN8nRuntimeDrainStatus(db, runtime, { nowSeconds: 1_000 })).toMatchObject({
      counts: { active: 2, topLevel: 1, mediaNodes: 1 },
      safeToRetire: false,
    })
  })

  it('requires a terminal quiet window and detects untracked callbacks on the same slot', () => {
    const taggedRouting = {
      callbackProtocol: 'slot-v1',
      runtimeSlot: 'blue',
      runtimeReleaseId: 'release-a',
      claimCallbackUrl: 'http://127.0.0.1:3317/api/n8n/claim',
    }
    createRun(db, 'completed-parent', taggedRouting)
    db.prepare(`
      UPDATE n8n_task_runs
      SET status = 'succeeded', updated_at = 850, completed_at = 850
      WHERE task_id = 'completed-parent'
    `).run()

    expect(getN8nRuntimeDrainStatus(db, runtime, { nowSeconds: 969 }))
      .toMatchObject({ quietSeconds: 119, safeToRetire: false })
    expect(getN8nRuntimeDrainStatus(db, runtime, { nowSeconds: 970 }))
      .toMatchObject({ quietSeconds: 120, safeToRetire: true })

    createRun(db, 'legacy-callback', {
      claimCallbackUrl: 'http://localhost:3317/api/n8n/claim',
    })
    db.prepare(`UPDATE n8n_task_runs SET status = 'accepted' WHERE task_id = 'legacy-callback'`).run()
    expect(getN8nRuntimeDrainStatus(db, runtime, { nowSeconds: 1_000 })).toMatchObject({
      counts: { untrackedCallbacks: 1 },
      safeToRetire: false,
    })

    db.prepare(`
      UPDATE n8n_task_runs
      SET status = 'succeeded', updated_at = 990, completed_at = 990
      WHERE task_id = 'legacy-callback'
    `).run()
    expect(getN8nRuntimeDrainStatus(db, runtime, { nowSeconds: 1_000 })).toMatchObject({
      counts: { untrackedCallbacks: 0 },
      lastActivityAt: 990,
      quietSeconds: 10,
      safeToRetire: false,
    })
    expect(getN8nRuntimeDrainStatus(db, runtime, { nowSeconds: 1_110 }))
      .toMatchObject({ quietSeconds: 120, safeToRetire: true })
  })

  it('blocks process retirement for an active task in another tenant', () => {
    createN8nTaskRun(db, {
      taskId: 'other-scope',
      idempotencyKey: 'other-scope',
      bindingId: 9,
      source: 'openclaw',
      requestedBy: 'operator',
      routing: { ...runtime },
      taskInput: {},
      delivery: { mode: 'none' },
      maxAttempts: 1,
    }, { tenantId: 4, workspaceId: 2 })

    expect(getN8nRuntimeDrainStatus(db, runtime, { nowSeconds: 1_000 })).toMatchObject({
      counts: { tracked: 1, active: 1 },
      safeToRetire: false,
    })
  })

  it('blocks retirement while an execution lease remains, even when it is expired', () => {
    createRun(db, 'leased-child', {
      callbackProtocol: 'slot-v1',
      runtimeSlot: 'blue',
      runtimeReleaseId: 'release-a',
    }, 'n8n-node')
    db.prepare(`
      UPDATE n8n_task_runs
      SET status = 'succeeded', updated_at = 700, completed_at = 700
      WHERE task_id = 'leased-child'
    `).run()
    db.prepare(`
      INSERT INTO n8n_child_execution_leases (
        task_id, tenant_id, workspace_id, owner_instance_id, lease_token,
        lease_expires_at, heartbeat_at, revision, created_at, updated_at
      ) VALUES ('leased-child', 3, 2, ?, ?, 850, 800, 1, 800, 800)
    `).run('a'.repeat(64), 'b'.repeat(64))

    expect(getN8nRuntimeDrainStatus(db, runtime, { nowSeconds: 1_000 })).toMatchObject({
      counts: { active: 0, childExecutionLeases: 1 },
      quietSeconds: 200,
      safeToRetire: false,
    })
  })
})
