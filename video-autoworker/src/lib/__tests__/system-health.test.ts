// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { healthHttpStatus, parseDiskUsageRows, readStorageSnapshot, storageHealthCheck, summarizeHealth } from '../system-health'

const header = 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
const row = '/dev/disk3s1 1000 350 650 35% /System/Volumes/Data\n'

describe('health aggregation and storage sampling', () => {
  it.each(['unhealthy', 'critical', 'error'] as const)('propagates a %s dependency to HTTP 503', status => {
    const summary = summarizeHealth([{ name: 'Gateway', status, message: 'unavailable' }])
    expect(summary).toBe('unhealthy')
    expect(healthHttpStatus(summary)).toBe(503)
  })

  it('keeps a slow database degraded and ordinary warnings non-fatal', () => {
    expect(summarizeHealth([{ name: 'Database', status: 'warning', message: 'slow' }])).toBe('degraded')
    expect(summarizeHealth([{ name: 'Disk Space', status: 'warning', message: '90%' }])).toBe('warning')
    expect(healthHttpStatus('degraded')).toBe(200)
    expect(healthHttpStatus('warning')).toBe(200)
    expect(summarizeHealth([])).toBe('unhealthy')
  })

  it('samples actual database and materials paths and exposes the most constrained volume', async () => {
    const inspect = vi.fn(async () => `${header}${row}/dev/disk4 1000 920 80 92% /Volumes/Materials\n`)
    const snapshot = await readStorageSnapshot([
      { role: 'database', path: '/data/database.db' }, { role: 'materials', path: '/media/workspace' },
    ], inspect)
    expect(inspect).toHaveBeenCalledTimes(1)
    expect(inspect).toHaveBeenCalledWith(['/data/database.db', '/media/workspace'])
    expect(snapshot).toMatchObject({ status: 'warning', usage: '92%', role: 'materials' })
    expect(snapshot.volumes[0].usagePercent).toBe(35)
    expect(storageHealthCheck(snapshot)).toMatchObject({ name: 'Disk Space', status: 'warning' })
    expect(JSON.stringify(snapshot)).not.toContain('/data/database.db')
  })

  it('uses the APFS Data volume capacity instead of deriving usage from shared container totals', () => {
    const [sample] = parseDiskUsageRows(`${header}/dev/disk3s1 971350180 589094240 357467856 63% /System/Volumes/Data\n`)
    expect(sample.usagePercent).toBe(63)
    expect(sample.usedBytes).toBe(589094240 * 1024)
    expect(parseDiskUsageRows(`${header}/dev/disk-name 1000 950 50 95% /Volumes/Material disk\n`)[0].usagePercent).toBe(95)
  })

  it.each([
    null,
    `${header}/dev/disk 0 0 0 0% /missing\n`,
    `${header}/dev/disk 1000 350 650 ??% /missing\n`,
  ])('never substitutes zero percent for missing or invalid samples', async usage => {
    const snapshot = await readStorageSnapshot([{ role: 'database', path: '/missing/database.db' }], async () => {
      if (!usage) throw new Error('ENOENT /private/path')
      return usage
    })
    expect(snapshot).toMatchObject({ status: 'error', usage: null, usagePercent: null, total: null })
    expect(snapshot.volumes[0].errorCode).toBe('storage_usage_unavailable')
    expect(healthHttpStatus(summarizeHealth([storageHealthCheck(snapshot)]))).toBe(503)
    expect(JSON.stringify(snapshot)).not.toContain('/private/path')
  })

  it('does not let a partial response claim that an unavailable material mount was sampled', async () => {
    const snapshot = await readStorageSnapshot([
      { role: 'database', path: '/data/database.db' }, { role: 'materials', path: '/media/missing' },
    ], async () => `${header}${row}`)
    expect(snapshot).toMatchObject({ status: 'error', usage: null })
    expect(snapshot.volumes.every(volume => volume.usagePercent === null)).toBe(true)
  })

  it('reuses one read when two roles resolve to the same path', async () => {
    const inspect = vi.fn(async () => `${header}${row}`)
    await readStorageSnapshot([
      { role: 'database', path: '/data/root' }, { role: 'materials', path: '/data/./root' },
    ], inspect)
    expect(inspect).toHaveBeenCalledTimes(1)
  })

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('reads the actual local data filesystem through the shared sampler', async () => {
    const snapshot = await readStorageSnapshot([{ role: 'materials', path: process.cwd() }])
    expect(snapshot.status).not.toBe('error')
    expect(snapshot.usagePercent).toBeTypeOf('number')
    expect(snapshot.volumes[0].totalBytes).toBeGreaterThan(0)
  })
})
