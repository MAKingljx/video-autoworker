import { randomBytes } from 'crypto'
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from 'fs'
import { isAbsolute } from 'path'
import type Database from 'better-sqlite3'

export const BUILTIN_SCHEDULER_LEASE = 'builtin_scheduler'
export const DEFAULT_SCHEDULER_LEASE_SECONDS = 30

type SchedulerLeaseRow = {
  holder_id: string
  lease_expires_at: number
  revision: number
}

export type SchedulerLeadershipResult = {
  isLeader: boolean
  mode: 'lease' | 'single-instance-fallback'
  leaseExpiresAt: number | null
  revision: number | null
}

type SchedulerLeadershipOptions = {
  holderId: string
  leaseSeconds?: number
  nowSeconds?: number
  allowMissingTableForSingleInstance?: boolean
}

type SchedulerLeaseMutationOptions = {
  holderId: string
  revision: number
  leaseSeconds?: number
  nowSeconds?: number
}

export type SchedulerRuntimeEligibility = {
  eligible: boolean
  mode: 'single-instance' | 'blue-green'
  reason: 'single_instance' | 'slot_active' | 'slot_inactive' | 'slot_invalid'
    | 'release_mismatch'
    | 'router_state_unconfigured' | 'router_state_unsafe' | 'router_state_invalid'
  activeSlot: 'blue' | 'green' | null
  generation: number | null
}

/**
 * Each process gets an opaque random identity. It deliberately excludes host,
 * port, release, slot and PID information so the durable lease contains no
 * infrastructure or user identifiers.
 */
export function createSchedulerHolderId(): string {
  return randomBytes(16).toString('hex')
}

/** Blue/green runtimes must never fall back to an in-process-only lock. */
export function isMultiInstanceSchedulerRuntime(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const slot = env.AIWORKER_SLOT
  return slot === 'blue' || slot === 'green'
    || Boolean(env.AIWORKER_RUNTIME_ROLE)
    || Boolean(env.AIWORKER_BG_ROUTER_STATE)
}

/**
 * Decide whether this process may start the built-in scheduler at all.
 *
 * Build and isolated probe/test processes never touch the lease or run startup
 * work. A blue/green drain process is also strictly disabled by the explicit
 * flag; only the exact value `1` has that meaning.
 */
export function shouldStartBuiltinScheduler(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.NEXT_PHASE === 'phase-production-build') return false
  if (env.AIWORKER_DISABLE_SCHEDULER === '1') return false
  if (env.MISSION_CONTROL_TEST_MODE === '1') return false
  return true
}

function invalidBlueGreenEligibility(
  reason: SchedulerRuntimeEligibility['reason'],
): SchedulerRuntimeEligibility {
  return {
    eligible: false,
    mode: 'blue-green',
    reason,
    activeSlot: null,
    generation: null,
  }
}

/**
 * Resolve whether this runtime is allowed to compete for scheduler leadership.
 * A slot runtime fails closed unless it can read a permission-restricted router
 * state file and that file currently selects its own slot. The descriptor is
 * opened with O_NOFOLLOW where supported and validated before it is read.
 */
export function getSchedulerRuntimeEligibility(
  env: Record<string, string | undefined> = process.env,
): SchedulerRuntimeEligibility {
  const slot = env.AIWORKER_SLOT
  if (!slot) {
    if (env.AIWORKER_RUNTIME_ROLE || env.AIWORKER_BG_ROUTER_STATE) {
      return invalidBlueGreenEligibility('slot_invalid')
    }
    return {
      eligible: true,
      mode: 'single-instance',
      reason: 'single_instance',
      activeSlot: null,
      generation: null,
    }
  }
  if (slot !== 'blue' && slot !== 'green') return invalidBlueGreenEligibility('slot_invalid')

  const pathname = env.AIWORKER_BG_ROUTER_STATE
  if (!pathname || !isAbsolute(pathname)) {
    return invalidBlueGreenEligibility('router_state_unconfigured')
  }

  let descriptor: number | undefined
  let raw: string
  try {
    const noFollow = typeof fsConstants.O_NOFOLLOW === 'number' ? fsConstants.O_NOFOLLOW : 0
    descriptor = openSync(pathname, fsConstants.O_RDONLY | noFollow)
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size <= 0 || stat.size > 65_536) {
      return invalidBlueGreenEligibility('router_state_unsafe')
    }
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return invalidBlueGreenEligibility('router_state_unsafe')
    }
    if ((stat.mode & 0o022) !== 0) return invalidBlueGreenEligibility('router_state_unsafe')
    raw = readFileSync(descriptor, 'utf8')
  } catch {
    return invalidBlueGreenEligibility('router_state_unsafe')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }

  try {
    const state = JSON.parse(raw) as Record<string, unknown>
    if (state.schema !== 'video-autoworker-standalone-router/v1') {
      return invalidBlueGreenEligibility('router_state_invalid')
    }
    if (state.active !== 'blue' && state.active !== 'green') {
      return invalidBlueGreenEligibility('router_state_invalid')
    }
    if (state.previous !== null && state.previous !== 'blue' && state.previous !== 'green') {
      return invalidBlueGreenEligibility('router_state_invalid')
    }
    if (state.previous === state.active) {
      return invalidBlueGreenEligibility('router_state_invalid')
    }
    if (!Number.isSafeInteger(state.generation) || Number(state.generation) < 1) {
      return invalidBlueGreenEligibility('router_state_invalid')
    }
    const slots = state.slots
    if (!slots || typeof slots !== 'object' || Array.isArray(slots)) {
      return invalidBlueGreenEligibility('router_state_invalid')
    }
    const ports: number[] = []
    for (const name of ['blue', 'green'] as const) {
      const entry = (slots as Record<string, unknown>)[name]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return invalidBlueGreenEligibility('router_state_invalid')
      }
      const candidate = entry as Record<string, unknown>
      if (candidate.host !== '127.0.0.1' && candidate.host !== '::1') {
        return invalidBlueGreenEligibility('router_state_invalid')
      }
      if (!Number.isInteger(candidate.port) || Number(candidate.port) < 1 || Number(candidate.port) > 65_535) {
        return invalidBlueGreenEligibility('router_state_invalid')
      }
      ports.push(Number(candidate.port))
      if (typeof candidate.releaseId !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(candidate.releaseId)) {
        return invalidBlueGreenEligibility('router_state_invalid')
      }
    }
    if (ports[0] === ports[1]) return invalidBlueGreenEligibility('router_state_invalid')
    const activeSlot = state.active
    const releaseId = String(env.AIWORKER_RELEASE_ID || '').trim()
    const ownSlot = (slots as Record<string, Record<string, unknown>>)[slot]
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(releaseId)
      || ownSlot.releaseId !== releaseId) {
      return {
        eligible: false,
        mode: 'blue-green',
        reason: 'release_mismatch',
        activeSlot,
        generation: Number(state.generation),
      }
    }
    return {
      eligible: activeSlot === slot,
      mode: 'blue-green',
      reason: activeSlot === slot ? 'slot_active' : 'slot_inactive',
      activeSlot,
      generation: Number(state.generation),
    }
  } catch {
    return invalidBlueGreenEligibility('router_state_invalid')
  }
}

export function isSchedulerLeaseTableMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table:\s*scheduler_leader_leases\b/i.test(message)
}

/**
 * Atomically acquires or renews the single built-in scheduler lease.
 *
 * `better-sqlite3`'s `immediate()` transaction obtains SQLite's RESERVED lock
 * before reading the row. The UPDATE predicates additionally fence stale
 * observations by holder/revision (and expiry for takeover), so only one
 * process can report leadership for a lease generation.
 */
export function acquireOrRenewSchedulerLeadership(
  db: Database.Database,
  options: SchedulerLeadershipOptions,
): SchedulerLeadershipResult {
  if (!/^[0-9a-f]{32}$/.test(options.holderId)) {
    throw new Error('scheduler_holder_id_invalid')
  }

  const leaseSeconds = options.leaseSeconds ?? DEFAULT_SCHEDULER_LEASE_SECONDS
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 3600) {
    throw new Error('scheduler_lease_seconds_invalid')
  }

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('scheduler_lease_clock_invalid')
  }
  const nextExpiry = now + leaseSeconds
  if (!Number.isSafeInteger(nextExpiry)) {
    throw new Error('scheduler_lease_clock_invalid')
  }

  const changeLease = db.transaction((): SchedulerLeadershipResult => {
    const row = db.prepare(`
      SELECT holder_id, lease_expires_at, revision
      FROM scheduler_leader_leases
      WHERE lease_name = ?
    `).get(BUILTIN_SCHEDULER_LEASE) as SchedulerLeaseRow | undefined

    if (!row) {
      db.prepare(`
        INSERT INTO scheduler_leader_leases (
          lease_name, holder_id, lease_expires_at, revision, updated_at
        ) VALUES (?, ?, ?, 1, ?)
      `).run(BUILTIN_SCHEDULER_LEASE, options.holderId, nextExpiry, now)
      return { isLeader: true, mode: 'lease', leaseExpiresAt: nextExpiry, revision: 1 }
    }

    if (row.holder_id === options.holderId) {
      const update = db.prepare(`
        UPDATE scheduler_leader_leases
        SET lease_expires_at = ?, revision = revision + 1, updated_at = ?
        WHERE lease_name = ? AND holder_id = ? AND revision = ?
      `).run(
        nextExpiry,
        now,
        BUILTIN_SCHEDULER_LEASE,
        options.holderId,
        row.revision,
      )
      if (update.changes === 1) {
        return {
          isLeader: true,
          mode: 'lease',
          leaseExpiresAt: nextExpiry,
          revision: row.revision + 1,
        }
      }
    } else if (row.lease_expires_at <= now) {
      const update = db.prepare(`
        UPDATE scheduler_leader_leases
        SET holder_id = ?, lease_expires_at = ?, revision = revision + 1, updated_at = ?
        WHERE lease_name = ?
          AND holder_id = ?
          AND revision = ?
          AND lease_expires_at <= ?
      `).run(
        options.holderId,
        nextExpiry,
        now,
        BUILTIN_SCHEDULER_LEASE,
        row.holder_id,
        row.revision,
        now,
      )
      if (update.changes === 1) {
        return {
          isLeader: true,
          mode: 'lease',
          leaseExpiresAt: nextExpiry,
          revision: row.revision + 1,
        }
      }
    }

    return {
      isLeader: false,
      mode: 'lease',
      leaseExpiresAt: row.lease_expires_at,
      revision: row.revision,
    }
  })

  try {
    return changeLease.immediate()
  } catch (error) {
    if (isSchedulerLeaseTableMissing(error) && options.allowMissingTableForSingleInstance) {
      return {
        isLeader: true,
        mode: 'single-instance-fallback',
        leaseExpiresAt: null,
        revision: null,
      }
    }
    throw error
  }
}

/**
 * Renew only a still-live lease generation. If the event loop was frozen past
 * expiry this CAS fails; callers must treat leadership as lost. A job already
 * handed to an external system cannot be made exactly-once by this DB lease.
 */
export function renewSchedulerLeadership(
  db: Database.Database,
  options: SchedulerLeaseMutationOptions,
): SchedulerLeadershipResult {
  if (!/^[0-9a-f]{32}$/.test(options.holderId)) throw new Error('scheduler_holder_id_invalid')
  if (!Number.isSafeInteger(options.revision) || options.revision < 1) {
    throw new Error('scheduler_lease_revision_invalid')
  }
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_SCHEDULER_LEASE_SECONDS
  if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 15 || leaseSeconds > 3600) {
    throw new Error('scheduler_lease_seconds_invalid')
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  const nextExpiry = now + leaseSeconds
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(nextExpiry)) {
    throw new Error('scheduler_lease_clock_invalid')
  }

  return db.transaction((): SchedulerLeadershipResult => {
    const update = db.prepare(`
      UPDATE scheduler_leader_leases
      SET lease_expires_at = ?, revision = revision + 1, updated_at = ?
      WHERE lease_name = ?
        AND holder_id = ?
        AND revision = ?
        AND lease_expires_at > ?
    `).run(
      nextExpiry,
      now,
      BUILTIN_SCHEDULER_LEASE,
      options.holderId,
      options.revision,
      now,
    )
    if (update.changes === 1) {
      return {
        isLeader: true,
        mode: 'lease',
        leaseExpiresAt: nextExpiry,
        revision: options.revision + 1,
      }
    }
    const row = db.prepare(`
      SELECT lease_expires_at, revision
      FROM scheduler_leader_leases
      WHERE lease_name = ?
    `).get(BUILTIN_SCHEDULER_LEASE) as Pick<SchedulerLeaseRow, 'lease_expires_at' | 'revision'> | undefined
    return {
      isLeader: false,
      mode: 'lease',
      leaseExpiresAt: row?.lease_expires_at ?? null,
      revision: row?.revision ?? null,
    }
  }).immediate()
}

/** Relinquish exactly the lease generation last observed by this process. */
export function relinquishSchedulerLeadership(
  db: Database.Database,
  options: Pick<SchedulerLeaseMutationOptions, 'holderId' | 'revision'>,
): boolean {
  if (!/^[0-9a-f]{32}$/.test(options.holderId)) throw new Error('scheduler_holder_id_invalid')
  if (!Number.isSafeInteger(options.revision) || options.revision < 1) {
    throw new Error('scheduler_lease_revision_invalid')
  }
  return db.transaction(() => db.prepare(`
    DELETE FROM scheduler_leader_leases
    WHERE lease_name = ? AND holder_id = ? AND revision = ?
  `).run(BUILTIN_SCHEDULER_LEASE, options.holderId, options.revision).changes === 1).immediate()
}
