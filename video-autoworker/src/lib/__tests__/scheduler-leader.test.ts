// @vitest-environment node

import Database from 'better-sqlite3'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import {
  acquireOrRenewSchedulerLeadership,
  createSchedulerHolderId,
  getSchedulerRuntimeEligibility,
  isMultiInstanceSchedulerRuntime,
  relinquishSchedulerLeadership,
  renewSchedulerLeadership,
  shouldStartBuiltinScheduler,
} from '@/lib/scheduler-leader'

const cleanup: Array<() => void> = []

function databasePair(): [Database.Database, Database.Database] {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-leader-'))
  const path = join(root, 'mission-control.db')
  const first = new Database(path)
  runMigrations(first)
  const second = new Database(path)
  first.pragma('busy_timeout = 1000')
  second.pragma('busy_timeout = 1000')
  cleanup.push(() => {
    second.close()
    first.close()
    rmSync(root, { recursive: true, force: true })
  })
  return [first, second]
}

afterEach(() => {
  while (cleanup.length > 0) cleanup.pop()?.()
})

describe('built-in scheduler leader lease', () => {
  it('creates the additive lease schema through migration 053', () => {
    const [db] = databasePair()
    expect(db.prepare(`
      SELECT id FROM schema_migrations WHERE id = '053_scheduler_leader_lease'
    `).get()).toEqual({ id: '053_scheduler_leader_lease' })
    expect(db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name = 'scheduler_leader_leases'
    `).get()).toEqual({ name: 'scheduler_leader_leases' })
  })

  it('allows only one process to lead and lets that holder renew', () => {
    const [first, second] = databasePair()
    const firstHolder = createSchedulerHolderId()
    const secondHolder = createSchedulerHolderId()

    expect(acquireOrRenewSchedulerLeadership(first, {
      holderId: firstHolder,
      nowSeconds: 1_000,
      leaseSeconds: 60,
    })).toMatchObject({ isLeader: true, mode: 'lease', leaseExpiresAt: 1_060, revision: 1 })

    expect(acquireOrRenewSchedulerLeadership(second, {
      holderId: secondHolder,
      nowSeconds: 1_030,
      leaseSeconds: 60,
    })).toMatchObject({ isLeader: false, mode: 'lease', leaseExpiresAt: 1_060, revision: 1 })

    expect(acquireOrRenewSchedulerLeadership(first, {
      holderId: firstHolder,
      nowSeconds: 1_040,
      leaseSeconds: 60,
    })).toMatchObject({ isLeader: true, leaseExpiresAt: 1_100, revision: 2 })
  })

  it('atomically transfers leadership after the lease expires', () => {
    const [first, second] = databasePair()
    const firstHolder = createSchedulerHolderId()
    const secondHolder = createSchedulerHolderId()

    acquireOrRenewSchedulerLeadership(first, {
      holderId: firstHolder,
      nowSeconds: 2_000,
      leaseSeconds: 30,
    })
    expect(acquireOrRenewSchedulerLeadership(second, {
      holderId: secondHolder,
      nowSeconds: 2_030,
      leaseSeconds: 30,
    })).toMatchObject({ isLeader: true, leaseExpiresAt: 2_060, revision: 2 })
    expect(acquireOrRenewSchedulerLeadership(first, {
      holderId: firstHolder,
      nowSeconds: 2_031,
      leaseSeconds: 30,
    })).toMatchObject({ isLeader: false, leaseExpiresAt: 2_060, revision: 2 })
  })

  it('renews and relinquishes only the holder revision observed by the caller', () => {
    const [first, second] = databasePair()
    const firstHolder = createSchedulerHolderId()
    const secondHolder = createSchedulerHolderId()
    acquireOrRenewSchedulerLeadership(first, {
      holderId: firstHolder,
      nowSeconds: 2_100,
      leaseSeconds: 30,
    })

    expect(renewSchedulerLeadership(first, {
      holderId: firstHolder,
      revision: 1,
      nowSeconds: 2_105,
      leaseSeconds: 30,
    })).toMatchObject({ isLeader: true, revision: 2, leaseExpiresAt: 2_135 })
    expect(relinquishSchedulerLeadership(first, {
      holderId: firstHolder,
      revision: 1,
    })).toBe(false)
    expect(relinquishSchedulerLeadership(first, {
      holderId: firstHolder,
      revision: 2,
    })).toBe(true)
    expect(acquireOrRenewSchedulerLeadership(second, {
      holderId: secondHolder,
      nowSeconds: 2_106,
      leaseSeconds: 30,
    })).toMatchObject({ isLeader: true, revision: 1 })
  })

  it('does not revive an expired generation after an event-loop freeze', () => {
    const [first, second] = databasePair()
    const firstHolder = createSchedulerHolderId()
    const secondHolder = createSchedulerHolderId()
    acquireOrRenewSchedulerLeadership(first, {
      holderId: firstHolder,
      nowSeconds: 2_200,
      leaseSeconds: 30,
    })

    expect(renewSchedulerLeadership(first, {
      holderId: firstHolder,
      revision: 1,
      nowSeconds: 2_230,
      leaseSeconds: 30,
    })).toMatchObject({ isLeader: false, revision: 1, leaseExpiresAt: 2_230 })
    expect(acquireOrRenewSchedulerLeadership(second, {
      holderId: secondHolder,
      nowSeconds: 2_230,
      leaseSeconds: 30,
    })).toMatchObject({ isLeader: true, revision: 2 })
  })

  it('fails closed without the table except for an explicit single-instance fallback', () => {
    const db = new Database(':memory:')
    cleanup.push(() => db.close())
    const holderId = createSchedulerHolderId()

    expect(() => acquireOrRenewSchedulerLeadership(db, {
      holderId,
      nowSeconds: 3_000,
      allowMissingTableForSingleInstance: false,
    })).toThrow(/no such table: scheduler_leader_leases/i)
    expect(acquireOrRenewSchedulerLeadership(db, {
      holderId,
      nowSeconds: 3_000,
      allowMissingTableForSingleInstance: true,
    })).toEqual({
      isLeader: true,
      mode: 'single-instance-fallback',
      leaseExpiresAt: null,
      revision: null,
    })
  })

  it('starts only live runtimes and strictly disables build, probe/test and drain processes', () => {
    expect(isMultiInstanceSchedulerRuntime({
      AIWORKER_SLOT: 'green',
      AIWORKER_RUNTIME_ROLE: 'probe',
    })).toBe(true)
    expect(isMultiInstanceSchedulerRuntime({ AIWORKER_SLOT: 'blue' })).toBe(true)
    expect(shouldStartBuiltinScheduler({})).toBe(true)
    expect(shouldStartBuiltinScheduler({ MISSION_CONTROL_TEST_MODE: '1' })).toBe(false)
    expect(shouldStartBuiltinScheduler({
      MISSION_CONTROL_TEST_MODE: '1',
      AIWORKER_SLOT: 'green',
      AIWORKER_RUNTIME_ROLE: 'probe',
    })).toBe(false)
    expect(shouldStartBuiltinScheduler({
      AIWORKER_DISABLE_SCHEDULER: '1',
      AIWORKER_SLOT: 'blue',
      AIWORKER_RUNTIME_ROLE: 'drain',
    })).toBe(false)
    expect(shouldStartBuiltinScheduler({
      AIWORKER_DISABLE_SCHEDULER: 'true',
    })).toBe(true)
    expect(shouldStartBuiltinScheduler({
      NEXT_PHASE: 'phase-production-build',
      AIWORKER_SLOT: 'green',
      AIWORKER_RUNTIME_ROLE: 'probe',
    })).toBe(false)
  })

  it('allows only the router-active slot to compete and fails closed on unsafe state', () => {
    const root = mkdtempSync(join(tmpdir(), 'scheduler-router-state-'))
    cleanup.push(() => rmSync(root, { recursive: true, force: true }))
    const statePath = join(root, 'router-state.json')
    writeFileSync(statePath, JSON.stringify({
      schema: 'video-autoworker-standalone-router/v1',
      generation: 7,
      active: 'blue',
      previous: 'green',
      slots: {
        blue: { host: '127.0.0.1', port: 3317, releaseId: 'release-blue' },
        green: { host: '127.0.0.1', port: 3417, releaseId: 'release-green' },
      },
    }), { mode: 0o600 })

    expect(getSchedulerRuntimeEligibility({
      AIWORKER_SLOT: 'blue',
      AIWORKER_RELEASE_ID: 'release-blue',
      AIWORKER_BG_ROUTER_STATE: statePath,
    })).toMatchObject({ eligible: true, reason: 'slot_active', generation: 7 })
    expect(getSchedulerRuntimeEligibility({
      AIWORKER_SLOT: 'green',
      AIWORKER_RELEASE_ID: 'release-green',
      AIWORKER_BG_ROUTER_STATE: statePath,
    })).toMatchObject({ eligible: false, reason: 'slot_inactive', generation: 7 })
    expect(getSchedulerRuntimeEligibility({
      AIWORKER_SLOT: 'blue',
      AIWORKER_RELEASE_ID: 'stale-release',
      AIWORKER_BG_ROUTER_STATE: statePath,
    })).toMatchObject({
      eligible: false,
      reason: 'release_mismatch',
      activeSlot: 'blue',
      generation: 7,
    })

    chmodSync(statePath, 0o622)
    expect(getSchedulerRuntimeEligibility({
      AIWORKER_SLOT: 'blue',
      AIWORKER_RELEASE_ID: 'release-blue',
      AIWORKER_BG_ROUTER_STATE: statePath,
    })).toMatchObject({ eligible: false, reason: 'router_state_unsafe' })
    expect(getSchedulerRuntimeEligibility({
      AIWORKER_SLOT: 'blue',
      AIWORKER_RELEASE_ID: 'release-blue',
    })).toMatchObject({ eligible: false, reason: 'router_state_unconfigured' })
    expect(getSchedulerRuntimeEligibility({
      AIWORKER_RUNTIME_ROLE: 'active',
      AIWORKER_BG_ROUTER_STATE: statePath,
    })).toMatchObject({ eligible: false, reason: 'slot_invalid' })
  })
})
