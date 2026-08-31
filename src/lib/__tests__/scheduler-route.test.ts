import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getSchedulerLeadershipStatus: vi.fn(),
  getSchedulerStatus: vi.fn(),
  triggerTask: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ requireRole: mocks.requireRole }))
vi.mock('@/lib/scheduler', () => ({
  getSchedulerLeadershipStatus: mocks.getSchedulerLeadershipStatus,
  getSchedulerStatus: mocks.getSchedulerStatus,
  triggerTask: mocks.triggerTask,
}))

import { GET } from '@/app/api/scheduler/route'

describe('scheduler status route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireRole.mockReturnValue({ user: { id: 1, role: 'admin' } })
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
})
