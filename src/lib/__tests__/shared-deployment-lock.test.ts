import { chmod, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  acquireSharedDeploymentLock,
  verifySharedDeploymentLockDelegation,
} from '@/lib/shared-deployment-lock'
import {
  acquireSharedDeploymentLockSync,
  verifySharedDeploymentLockDelegationSync,
} from '../../../scripts/lib/shared-deployment-lock.mjs'

describe('shared deployment lock', () => {
  it('serializes concurrent owners on the canonical deployment directory', async () => {
    const runDirectory = await realpath(await mkdtemp(resolve(tmpdir(), 'shared-deployment-lock-')))
    try {
      await chmod(runDirectory, 0o700)
      const first = await acquireSharedDeploymentLock({
        runDirectory, attempts: 1, retryDelayMs: 0,
      })
      expect(first.acquired).toBe(true)

      const blocked = await acquireSharedDeploymentLock({
        runDirectory, attempts: 2, retryDelayMs: 1,
      })
      expect(blocked).toEqual({ acquired: false, reason: 'busy' })

      if (!first.acquired) throw new Error('first lock was not acquired')
      first.lease.release()
      const next = await acquireSharedDeploymentLock({
        runDirectory, attempts: 1, retryDelayMs: 0,
      })
      expect(next.acquired).toBe(true)
      if (next.acquired) next.lease.release()
    } finally {
      await rm(runDirectory, { recursive: true, force: true })
    }
  })

  it('never removes a lock whose owner record changed after acquisition', async () => {
    const runDirectory = await realpath(await mkdtemp(resolve(tmpdir(), 'shared-deployment-lock-owner-')))
    try {
      await chmod(runDirectory, 0o700)
      const result = await acquireSharedDeploymentLock({
        runDirectory, attempts: 1, retryDelayMs: 0,
      })
      if (!result.acquired) throw new Error('lock was not acquired')
      const ownerPath = resolve(result.lease.path, 'pid')
      const original = await readFile(ownerPath, 'utf8')
      await writeFile(ownerPath, `${original.trim()}-changed\n`, { mode: 0o600 })
      expect(() => result.lease.release()).toThrow(/owner_record_changed/u)

      const blocked = await acquireSharedDeploymentLock({
        runDirectory, attempts: 1, retryDelayMs: 0,
      })
      expect(blocked).toEqual({ acquired: false, reason: 'busy' })
    } finally {
      await rm(runDirectory, { recursive: true, force: true })
    }
  })

  it('fails closed instead of locking through a non-private run directory', async () => {
    const runDirectory = await realpath(await mkdtemp(resolve(tmpdir(), 'shared-deployment-lock-mode-')))
    try {
      await chmod(runDirectory, 0o755)
      await expect(acquireSharedDeploymentLock({
        runDirectory, attempts: 1, retryDelayMs: 0,
      })).rejects.toThrow(/run_directory_unsafe/u)
    } finally {
      await rm(runDirectory, { recursive: true, force: true })
    }
  })

  it('verifies a live v2 owner without exposing or reacquiring its lease', async () => {
    const runDirectory = await realpath(await mkdtemp(resolve(tmpdir(), 'shared-delegation-')))
    try {
      await chmod(runDirectory, 0o700)
      const result = await acquireSharedDeploymentLock({
        runDirectory, attempts: 1, retryDelayMs: 0,
      })
      if (!result.acquired) throw new Error('lock was not acquired')
      const owner = JSON.parse(await readFile(resolve(result.lease.path, 'pid'), 'utf8'))
      const witness = verifySharedDeploymentLockDelegation({
        runDirectory, ownerPid: owner.pid, ownerNonce: owner.nonce,
      })
      expect(witness).toMatchObject({ path: result.lease.path, ownerPid: owner.pid })
      expect(witness).not.toHaveProperty('descriptor')
      witness.assertCurrent()
      expect(() => verifySharedDeploymentLockDelegation({
        runDirectory, ownerPid: owner.pid, ownerNonce: 'f'.repeat(64),
      })).toThrow(/delegated lock owner is not current/u)
      result.lease.release()
      expect(() => witness.assertCurrent()).toThrow()
    } finally {
      await rm(runDirectory, { recursive: true, force: true })
    }
  })

  it('binds a caller delegation to the originally acquired lease identities', async () => {
    const runDirectory = await realpath(await mkdtemp(resolve(tmpdir(), 'shared-lease-delegation-')))
    try {
      await chmod(runDirectory, 0o700)
      const lease = acquireSharedDeploymentLockSync({ runDirectory })
      if (!lease) throw new Error('lock was not acquired')
      const ownerPath = resolve(lease.path, 'pid')
      const ownerSource = await readFile(ownerPath, 'utf8')
      const owner = JSON.parse(ownerSource)
      const witness = verifySharedDeploymentLockDelegationSync({
        runDirectory, ownerPid: owner.pid, ownerNonce: owner.nonce,
      })
      expect(() => verifySharedDeploymentLockDelegationSync({
        runDirectory, ownerPid: owner.pid + 1, ownerNonce: owner.nonce,
      })).toThrow(/delegated lock owner is not current/u)
      const previous = resolve(runDirectory, 'owner.previous')
      await rename(ownerPath, previous)
      await writeFile(ownerPath, ownerSource, { mode: 0o600 })
      await chmod(ownerPath, 0o600)

      expect(() => witness.assertCurrent()).toThrow(/delegated lock ownership changed/u)

      expect(() => verifySharedDeploymentLockDelegationSync({
        runDirectory,
        ownerPid: owner.pid,
        ownerNonce: owner.nonce,
        expectedLease: lease.descriptor,
      })).toThrow(/does not match the expected lease/u)

      const legacyOwner = { ...owner, schema: 'video-autoworker-shared-deployment-lock-owner/v1' }
      delete legacyOwner.processIdentitySha256
      await writeFile(ownerPath, `${JSON.stringify(legacyOwner)}\n`, { mode: 0o600 })
      expect(() => verifySharedDeploymentLockDelegationSync({
        runDirectory, ownerPid: owner.pid, ownerNonce: owner.nonce,
      })).toThrow(/delegated lock owner is not current/u)
    } finally {
      await rm(runDirectory, { recursive: true, force: true })
    }
  })
})
