import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { acquireSharedDeploymentLock } from '@/lib/shared-deployment-lock'

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
})
