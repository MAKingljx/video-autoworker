import { resolve } from 'node:path'

import { acquireSharedDeploymentLockSync } from '../../scripts/lib/shared-deployment-lock.mjs'

const DEFAULT_ATTEMPTS = 4
const DEFAULT_RETRY_DELAY_MS = 25

export interface SharedDeploymentLockLease {
  path: string
  release: () => void
}

export type SharedDeploymentLockResult =
  | { acquired: true, lease: SharedDeploymentLockLease }
  | { acquired: false, reason: 'busy' }

export interface SharedDeploymentLockOptions {
  runDirectory?: string
  attempts?: number
  retryDelayMs?: number
}

function fail(message: string): never {
  throw new Error(`shared_deployment_lock:${message}`)
}

function busy(error: unknown): boolean {
  return error instanceof Error
    && (error.message === 'shared deployment lock failed: another shared deployment operation is active'
      || /shared deployment lock failed: (?:existing lock|owner record)/u.test(error.message))
}

function translateAcquireError(error: unknown): never {
  if (error instanceof Error
    && error.message === 'shared deployment lock failed: blue-green run directory is unsafe') {
    fail('run_directory_unsafe')
  }
  throw error
}

function publicLease(lease: SharedDeploymentLockLease): SharedDeploymentLockLease {
  return {
    path: lease.path,
    release() {
      try { lease.release() } catch (error) {
        if (error instanceof Error && /owner record/u.test(error.message)) fail('owner_record_changed')
        if (error instanceof Error && /lock ownership/u.test(error.message)) fail('ownership_changed')
        throw error
      }
    },
  }
}

export async function acquireSharedDeploymentLock(
  options: SharedDeploymentLockOptions = {},
): Promise<SharedDeploymentLockResult> {
  const runDirectory = String(
    options.runDirectory || process.env.AIWORKER_BG_RUN_DIR || resolve(process.cwd(), '.run/blue-green'),
  ).trim()
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 20
    || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 250) {
    fail('retry_policy_invalid')
  }
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const lease = acquireSharedDeploymentLockSync({ runDirectory })
      if (!lease) fail('acquire_returned_empty')
      return { acquired: true, lease: publicLease(lease) }
    } catch (error) {
      if (!busy(error)) translateAcquireError(error)
      if (attempt === attempts) return { acquired: false, reason: 'busy' }
      await new Promise(resolveWait => setTimeout(resolveWait, retryDelayMs))
    }
  }
  return { acquired: false, reason: 'busy' }
}
