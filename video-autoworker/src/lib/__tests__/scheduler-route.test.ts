import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireN8nGlobalReleaseManager: vi.fn(),
  isOpenClawLoopbackAuthMode: vi.fn(),
  getSchedulerLeadershipStatus: vi.fn(),
  getSchedulerStatus: vi.fn(),
  triggerTask: vi.fn(),
  getExternalSchedulerStatus: vi.fn(),
  requestSchedulerWorker: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }))
vi.mock('@/lib/n8n-global-release-auth', () => ({
  requireN8nGlobalReleaseManager: mocks.requireN8nGlobalReleaseManager,
}))
vi.mock('@/lib/openclaw-loopback-auth', () => ({
  isOpenClawLoopbackAuthMode: mocks.isOpenClawLoopbackAuthMode,
}))
vi.mock('@/lib/scheduler', () => ({
  getSchedulerLeadershipStatus: mocks.getSchedulerLeadershipStatus,
  getSchedulerStatus: mocks.getSchedulerStatus,
  triggerTask: mocks.triggerTask,
}))
vi.mock('@/lib/scheduler-worker-ipc', () => ({
  getExternalSchedulerStatus: mocks.getExternalSchedulerStatus,
  requestSchedulerWorker: mocks.requestSchedulerWorker,
}))

import { GET, POST } from '@/app/api/scheduler/route'

describe('scheduler status route', () => {
  afterEach(() => vi.unstubAllEnvs())
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.isOpenClawLoopbackAuthMode.mockReturnValue(false)
    mocks.requireRole.mockReturnValue({ user: { id: 1, role: 'admin' } })
    mocks.requireN8nGlobalReleaseManager.mockReturnValue({
      user: { id: 0, role: 'admin', username: 'openclaw-loopback:n8n-global-release' },
    })
    mocks.getSchedulerLeadershipStatus.mockReturnValue({
      state: 'leader',
      leaseExpiresAt: 100,
      leaseExpired: false,
      observedAt: 90,
      reason: 'slot_active',
      routerGeneration: 4,
      activeJobs: 1,
    })
    mocks.getSchedulerStatus.mockReturnValue([{ id: 'webhook_retry', running: true }])
  })

  it('reads the independent worker and never runs a web scheduler as fallback', async () => {
    vi.stubEnv('AIWORKER_SCHEDULER_STATE_DIR', '/private-worker-state')
    mocks.getExternalSchedulerStatus.mockResolvedValue({ executionMode: 'external-worker', healthy: true,
      leadership: { state: 'leader', routerGeneration: null }, tasks: [{ id: 'webhook_retry' }] })
    const response = await GET(new NextRequest('http://127.0.0.1:3017/api/scheduler'))
    expect(response.status).toBe(200)
    expect((await response.json()).executionMode).toBe('external-worker')
    expect(mocks.getSchedulerLeadershipStatus).toHaveBeenCalledTimes(1)
    mocks.getExternalSchedulerStatus.mockRejectedValue(new Error('socket unavailable'))
    expect((await GET(new NextRequest('http://127.0.0.1:3017/api/scheduler'))).status).toBe(503)
    expect(mocks.getSchedulerLeadershipStatus).toHaveBeenCalledTimes(1)
  })

  it('forwards manual tasks to the sole worker after checking the existing admin identity', async () => {
    vi.stubEnv('AIWORKER_SCHEDULER_STATE_DIR', '/private-worker-state')
    mocks.getExternalSchedulerStatus.mockResolvedValue({ healthy: true, tasks: [{ id: 'webhook_retry' }] })
    mocks.requestSchedulerWorker.mockResolvedValue({ ok: true, message: 'done' })
    const response = await POST(new NextRequest('http://127.0.0.1:3017/api/scheduler', {
      method: 'POST', body: JSON.stringify({ task_id: 'webhook_retry' }),
    }))
    expect(response.status).toBe(200)
    expect(mocks.requestSchedulerWorker).toHaveBeenCalledWith('/trigger', { task_id: 'webhook_retry' }, { timeoutMs: 0 })
    expect(mocks.triggerTask).not.toHaveBeenCalled()
  })

  it('exposes live leadership with registered tasks and disables caching', async () => {
    const response = await GET(new NextRequest('http://127.0.0.1:3017/api/scheduler'))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.requireRole).toHaveBeenCalledWith(expect.any(NextRequest), 'admin')
    expect(await response.json()).toEqual({
      leadership: {
        state: 'leader',
        leaseExpiresAt: 100,
        leaseExpired: false,
        observedAt: 90,
        reason: 'slot_active',
        routerGeneration: 4,
        activeJobs: 1,
      },
      tasks: [{ id: 'webhook_retry', running: true }],
    })
  })

  it('does not disclose scheduler state to an unauthorized request', async () => {
    mocks.requireRole.mockReturnValue({ error: 'Forbidden', status: 403 })
    const response = await GET(new NextRequest('http://127.0.0.1:3017/api/scheduler'))

    expect(response.status).toBe(403)
    expect(mocks.getSchedulerLeadershipStatus).not.toHaveBeenCalled()
    expect(mocks.getSchedulerStatus).not.toHaveBeenCalled()
  })

  it('uses the existing global release manager for loopback GET status', async () => {
    mocks.isOpenClawLoopbackAuthMode.mockReturnValue(true)
    const request = new NextRequest('http://127.0.0.1:3017/api/scheduler')
    const response = await GET(request)

    expect(response.status).toBe(200)
    expect(mocks.requireN8nGlobalReleaseManager).toHaveBeenCalledWith(request)
    expect(mocks.requireRole).not.toHaveBeenCalled()
  })

  it('does not fall back or read scheduler state when loopback release access is denied', async () => {
    mocks.isOpenClawLoopbackAuthMode.mockReturnValue(true)
    mocks.requireN8nGlobalReleaseManager.mockReturnValue({ error: 'Forbidden', status: 403 })
    const request = new NextRequest('http://127.0.0.1:3017/api/scheduler')
    const response = await GET(request)

    expect(response.status).toBe(403)
    expect(mocks.requireN8nGlobalReleaseManager).toHaveBeenCalledWith(request)
    expect(mocks.requireRole).not.toHaveBeenCalled()
    expect(mocks.getSchedulerLeadershipStatus).not.toHaveBeenCalled()
    expect(mocks.getSchedulerStatus).not.toHaveBeenCalled()
  })

  it('does not grant the loopback release identity permission to trigger tasks', async () => {
    mocks.isOpenClawLoopbackAuthMode.mockReturnValue(true)
    mocks.requireRole.mockReturnValue({ error: 'Forbidden', status: 403 })
    const request = new NextRequest('http://127.0.0.1:3017/api/scheduler', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ task_id: 'webhook_retry' }),
    })
    const response = await POST(request)

    expect(response.status).toBe(403)
    expect(mocks.requireRole).toHaveBeenCalledWith(request, 'admin')
    expect(mocks.requireN8nGlobalReleaseManager).not.toHaveBeenCalled()
    expect(mocks.triggerTask).not.toHaveBeenCalled()
  })
})
