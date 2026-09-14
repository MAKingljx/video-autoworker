// @vitest-environment node
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  db: vi.fn(), command: vi.fn(), auth: vi.fn(), gatewayReachable: false,
}))
vi.mock('@/lib/db', () => ({ getDatabase: mocks.db }))
vi.mock('@/lib/auth', () => ({ requireRole: mocks.auth }))
vi.mock('@/lib/config', () => ({ config: { dbPath: '/data/database.db', gatewayHost: '127.0.0.1', gatewayPort: 18789 } }))
vi.mock('@/lib/command', () => ({ runCommand: mocks.command, runOpenClaw: mocks.command, runClawdbot: mocks.command }))
vi.mock('@/lib/runtime-provider', () => ({ getRuntimeProvider: vi.fn() }))
vi.mock('@/lib/gateway-runtime', () => ({ registerMcAsDashboard: vi.fn() }))
vi.mock('@/lib/provider-subscriptions', () => ({ detectProviderSubscriptions: vi.fn(), getPrimarySubscription: vi.fn() }))
vi.mock('@/lib/hermes-sessions', () => ({ isHermesInstalled: vi.fn(), scanHermesSessions: vi.fn() }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('node:net', () => ({ default: { Socket: class extends EventEmitter {
  setTimeout() { return this }
  destroy() { return this }
  connect() { queueMicrotask(() => this.emit(mocks.gatewayReachable ? 'connect' : 'error')); return this }
} } }))

import { GET } from '@/app/api/status/route'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.gatewayReachable = false
  mocks.db.mockReturnValue({ prepare: () => ({ get: () => ({ ok: 1 }) }) })
  mocks.command.mockImplementation(async (command: string, args: string[]) => ({
    stdout: command === 'df'
      ? `Filesystem 1024-blocks Used Available Capacity Mounted on\n${args.slice(1).map(() => '/dev/disk3 1000 350 650 35% /System/Volumes/Data\n').join('')}`
      : '123 openclaw-gateway\n',
    code: 0,
  }))
  vi.spyOn(process, 'memoryUsage').mockReturnValue({ rss: 100e6, heapUsed: 40e6, heapTotal: 80e6, external: 0, arrayBuffers: 0 })
  vi.spyOn(os, 'totalmem').mockReturnValue(16e9)
  vi.spyOn(os, 'freemem').mockReturnValue(8e9)
  vi.stubEnv('MC_OPENCLAW_PROFILE_TARGET', 'local')
  vi.stubEnv('MC_MATERIALS_WORKSPACE_ROOT', '/media/materials')
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

const request = (action: string) => GET(new NextRequest(`http://localhost/api/status?action=${action}`))

describe('application probes', () => {
  it('liveness works without reading database, storage or Gateway and without viewer auth', async () => {
    mocks.db.mockImplementation(() => { throw new Error('unavailable') })
    const response = await request('liveness')
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ status: 'alive' })
    expect(mocks.db).not.toHaveBeenCalled()
    expect(mocks.command).not.toHaveBeenCalled()
    expect(mocks.auth).not.toHaveBeenCalled()
  })

  it('full health returns 503 for an unreachable Gateway even if a process name matches', async () => {
    const response = await request('health')
    const health = await response.json()
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(health.status).toBe('unhealthy')
    expect(health.checks).toContainEqual(expect.objectContaining({ name: 'Gateway', status: 'unhealthy' }))
  })

  it('readiness checks local dependencies without external Gateway calls', async () => {
    const response = await request('readiness')
    expect(response.status).toBe(200)
    const health = await response.json()
    expect(health.status).toBe('healthy')
    expect(health.checks.map((check: { name: string }) => check.name)).not.toContain('Gateway')
    expect(mocks.command.mock.calls.flat()).not.toContain('ps')
    expect(mocks.command).toHaveBeenCalledWith('df', ['-kP', '/data/database.db', '/media/materials'], expect.objectContaining({ timeoutMs: 3000 }))
  })

  it('readiness fails for an inaccessible database or missing data mount', async () => {
    mocks.db.mockImplementation(() => { throw new Error('database broken') })
    expect((await request('readiness')).status).toBe(503)
    mocks.db.mockReturnValue({ prepare: () => ({ get: () => ({ ok: 1 }) }) })
    mocks.command.mockRejectedValue(new Error('missing mount'))
    const response = await request('readiness')
    expect(response.status).toBe(503)
    const health = await response.json()
    expect(health.checks.find((check: { name: string }) => check.name === 'Disk Space').detail.volumes[0].usagePercent).toBeNull()
  })

  it('exposes unconfigured and remote material coverage without sampling a false local path', async () => {
    vi.stubEnv('MC_MATERIALS_WORKSPACE_ROOT', '')
    const local = await (await request('readiness')).json()
    expect(local.checks.find((check: { name: string }) => check.name === 'Disk Space').detail.materialsCoverage).toBe('root_unconfigured')
    vi.stubEnv('MC_OPENCLAW_PROFILE_TARGET', 'ssh')
    vi.stubEnv('MC_MATERIALS_WORKSPACE_ROOT', '/remote/materials')
    const remote = await (await request('readiness')).json()
    expect(remote.checks.find((check: { name: string }) => check.name === 'Disk Space').detail.materialsCoverage).toBe('remote_not_sampled')
    expect(mocks.command.mock.calls.flatMap(call => call[1] || [])).not.toContain('/remote/materials')
  })
})
