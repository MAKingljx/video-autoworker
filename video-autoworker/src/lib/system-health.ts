import { resolve } from 'node:path'
import { runCommand } from './command'

export type CheckStatus = 'healthy' | 'warning' | 'critical' | 'unhealthy' | 'error'
export type HealthStatus = 'healthy' | 'warning' | 'degraded' | 'unhealthy'
export interface HealthCheck {
  name: string
  status: CheckStatus
  message: string
  detail?: unknown
}

export function summarizeHealth(checks: readonly HealthCheck[]): HealthStatus {
  if (!checks.length || checks.some(check => ['error', 'critical', 'unhealthy'].includes(check.status))) {
    return 'unhealthy'
  }
  if (checks.some(check => check.name === 'Database' && check.status === 'warning')) return 'degraded'
  return checks.some(check => check.status === 'warning') ? 'warning' : 'healthy'
}

export function healthHttpStatus(status: HealthStatus): 200 | 503 {
  return status === 'unhealthy' ? 503 : 200
}

export interface StorageTarget {
  role: 'database' | 'materials'
  path: string
}

interface FileSystemUsage {
  totalBytes: number
  usedBytes: number
  availableBytes: number
  usagePercent: number
}

interface StorageVolume {
  role: StorageTarget['role']
  status: CheckStatus
  usagePercent: number | null
  totalBytes: number | null
  usedBytes: number | null
  availableBytes: number | null
  errorCode: 'storage_usage_unavailable' | null
}

function usageStatus(percent: number): CheckStatus {
  return percent < 90 ? 'healthy' : percent < 95 ? 'warning' : 'critical'
}

function formatBytes(bytes: number | null): string | null {
  if (bytes === null) return null
  return `${(bytes / 1024 ** 3).toFixed(1)}G`
}

export function parseDiskUsageRows(stdout: string): FileSystemUsage[] {
  const lines = stdout.trim().split(/\r?\n/u)
  if (!/^Filesystem\s/u.test(lines.shift() || '') || !lines.length) throw new Error('storage_usage_invalid')
  return lines.map(line => {
    // POSIX output has fixed numeric columns; the filesystem and mount path can contain spaces.
    const fields = /^.+?\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)%\s+.+$/u.exec(line.trim())
    if (!fields) throw new Error('storage_usage_invalid')
    const [blocks, used, available, usagePercent] = fields.slice(1).map(Number)
    if (![blocks, used, available, usagePercent].every(Number.isSafeInteger)
      || blocks <= 0 || used < 0 || usagePercent < 0) throw new Error('storage_usage_invalid')
    return { totalBytes: blocks * 1024, usedBytes: used * 1024, availableBytes: Math.max(0, available) * 1024, usagePercent }
  })
}

async function inspectStorage(paths: string[]): Promise<string> {
  const { stdout } = await runCommand('df', ['-kP', ...paths], {
    timeoutMs: 3000, env: { PATH: process.env.PATH, NODE_ENV: process.env.NODE_ENV, LC_ALL: 'C' },
  })
  return stdout
}

/** Sample the configured data paths themselves, so missing mounts cannot masquerade as a healthy parent volume. */
export async function readStorageSnapshot(
  targets: readonly StorageTarget[],
  inspect: (paths: string[]) => Promise<string> = inspectStorage,
) {
  if (!targets.length) throw new Error('storage_targets_empty')
  const paths = [...new Set(targets.map(target => resolve(target.path)))]
  let samples: Map<string, FileSystemUsage> = new Map()
  try {
    // One bounded command covers both paths. df understands APFS shared space; statfs blocks-bfree does not.
    const rows = parseDiskUsageRows(await inspect(paths))
    if (rows.length !== paths.length) throw new Error('storage_sample_count_mismatch')
    samples = new Map(paths.map((pathname, index) => [pathname, rows[index]]))
  } catch {
    // A partial command response cannot prove which requested path was sampled.
  }
  const volumes: StorageVolume[] = targets.map(target => {
    const sample = samples.get(resolve(target.path))
    if (sample) {
      return {
        role: target.role, status: usageStatus(sample.usagePercent), ...sample,
        errorCode: null,
      }
    } else {
      return {
        role: target.role, status: 'error', usagePercent: null,
        totalBytes: null, usedBytes: null, availableBytes: null,
        errorCode: 'storage_usage_unavailable',
      }
    }
  })
  const unknown = volumes.find(volume => volume.status === 'error')
  const mostUsed = volumes.reduce((left, right) => (
    (right.usagePercent ?? -1) > (left.usagePercent ?? -1) ? right : left
  ))
  const selected = unknown || mostUsed
  return {
    status: selected.status,
    total: formatBytes(selected.totalBytes),
    used: formatBytes(selected.usedBytes),
    available: formatBytes(selected.availableBytes),
    usage: selected.usagePercent === null ? null : `${selected.usagePercent}%`,
    usagePercent: selected.usagePercent,
    role: selected.role,
    volumes,
  }
}

export function storageHealthCheck(snapshot: Awaited<ReturnType<typeof readStorageSnapshot>>): HealthCheck {
  return {
    name: 'Disk Space',
    status: snapshot.status,
    message: snapshot.usage === null ? 'Data storage usage unavailable' : `Data storage usage: ${snapshot.usage}`,
    detail: { volumes: snapshot.volumes },
  }
}
