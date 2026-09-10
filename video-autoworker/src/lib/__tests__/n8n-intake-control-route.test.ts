import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'

const mocks = vi.hoisted(() => ({
  getGlobalReleaseAccess: vi.fn(),
  requireGlobalReleaseManager: vi.fn(),
  mutationLimiter: vi.fn(),
  getDatabase: vi.fn(),
  getN8nIntakeControl: vi.fn(),
  setN8nIntakeControl: vi.fn(),
  acquireSharedDeploymentLock: vi.fn(),
  verifySharedDeploymentLockDelegation: vi.fn(),
  assertDelegationCurrent: vi.fn(),
  databaseTransaction: vi.fn(),
  releaseSharedDeploymentLock: vi.fn(),
}))

vi.mock('@/lib/n8n-global-release-auth', () => ({
  getN8nGlobalReleaseAccess: mocks.getGlobalReleaseAccess,
  requireN8nGlobalReleaseManager: mocks.requireGlobalReleaseManager,
}))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: mocks.mutationLimiter }))
vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/shared-deployment-lock', () => ({
  acquireSharedDeploymentLock: mocks.acquireSharedDeploymentLock,
  verifySharedDeploymentLockDelegation: mocks.verifySharedDeploymentLockDelegation,
}))
vi.mock('@/lib/n8n-intake-control', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/n8n-intake-control')>()
  return {
    ...actual,
    getN8nIntakeControl: mocks.getN8nIntakeControl,
    setN8nIntakeControl: mocks.setN8nIntakeControl,
  }
})

import { GET, POST } from '@/app/api/n8n/intake-control/route'

const control = {
  schema: 'video-autoworker-intake-control/v1',
  globalScope: true,
  mode: 'paused',
  accepting: false,
  revision: 2,
  reason: '准备发布新的服务版本',
  changedBy: { id: 8, name: 'admin' },
  changedAt: 100,
  counts: { queued: 0, accepted: 0, running: 0, waiting: 0, active: 0 },
}

function request(method: 'GET' | 'POST', body?: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/intake-control', {
    method,
    ...(body === undefined ? {} : {
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  })
}

describe('n8n intake control route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getGlobalReleaseAccess.mockReturnValue({
      user: { id: 8, username: 'admin', role: 'admin', workspace_id: 2, tenant_id: 3 },
      canManage: true,
    })
    mocks.requireGlobalReleaseManager.mockReturnValue({
      user: { id: 8, username: 'admin', role: 'admin', workspace_id: 2, tenant_id: 3 },
    })
    mocks.mutationLimiter.mockReturnValue(null)
    mocks.databaseTransaction.mockImplementation((callback: () => unknown) => ({
      immediate: () => callback(),
    }))
    mocks.getDatabase.mockReturnValue({ transaction: mocks.databaseTransaction })
    mocks.getN8nIntakeControl.mockReturnValue(control)
    mocks.setN8nIntakeControl.mockReturnValue({ outcome: 'updated', control })
    mocks.releaseSharedDeploymentLock.mockReturnValue(undefined)
    mocks.acquireSharedDeploymentLock.mockResolvedValue({
      acquired: true,
      lease: { path: '/private/run/.deployment.lock', release: mocks.releaseSharedDeploymentLock },
    })
    mocks.verifySharedDeploymentLockDelegation.mockReturnValue({
      path: '/private/run/.deployment.lock',
      ownerPid: 123,
      assertCurrent: mocks.assertDelegationCurrent,
    })
  })

  it('returns the complete global intake state to an administrator', async () => {
    const response = await GET(request('GET'))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ control: { ...control, canManage: true } })
    expect(mocks.getGlobalReleaseAccess).toHaveBeenCalledWith(expect.any(NextRequest))
    expect(mocks.getN8nIntakeControl).toHaveBeenCalledWith(expect.anything())
  })

  it('returns only the safe gate status to a non-admin caller', async () => {
    mocks.getGlobalReleaseAccess.mockReturnValue({
      user: { id: 9, username: 'tenant-admin', role: 'admin', workspace_id: 8, tenant_id: 7 },
      canManage: false,
    })
    const response = await GET(request('GET'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      control: {
        accepting: false,
        canManage: false,
      },
    })
    expect(mocks.getN8nIntakeControl).toHaveBeenCalledWith(expect.anything())
  })

  it('requires a global release manager before applying the mutation limiter or reading the database', async () => {
    mocks.requireGlobalReleaseManager.mockReturnValue({ error: 'forbidden', status: 403 })
    const response = await POST(request('POST', {
      action: 'drain', reason: '准备发布新的服务版本', expectedRevision: 0,
    }))
    expect(response.status).toBe(403)
    expect(mocks.mutationLimiter).not.toHaveBeenCalled()
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.setN8nIntakeControl).not.toHaveBeenCalled()
  })

  it('honors rate limiting before parsing or writing', async () => {
    mocks.mutationLimiter.mockReturnValue(NextResponse.json({ error: 'slow down' }, { status: 429 }))
    const response = await POST(request('POST', null))
    expect(response.status).toBe(429)
    expect(mocks.setN8nIntakeControl).not.toHaveBeenCalled()
  })

  it('uses strict input while deriving the actor only from authentication', async () => {
    const response = await POST(request('POST', {
      action: 'drain',
      reason: '  准备发布新的服务版本  ',
      expectedRevision: 1,
    }))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(mocks.requireGlobalReleaseManager).toHaveBeenCalledWith(expect.any(NextRequest))
    expect(mocks.setN8nIntakeControl).toHaveBeenCalledWith(
      expect.anything(),
      { action: 'drain', reason: '准备发布新的服务版本', expectedRevision: 1 },
      { id: 8, name: 'admin' },
    )
    expect(mocks.acquireSharedDeploymentLock).toHaveBeenCalledOnce()
    expect(mocks.releaseSharedDeploymentLock).toHaveBeenCalledOnce()
    expect(await response.json()).toEqual({ control: { ...control, canManage: true } })
  })

  it('rejects short reasons, forged scope fields, and stale revisions', async () => {
    const invalid = await POST(request('POST', {
      action: 'drain',
      reason: '短原因',
      expectedRevision: 1,
      tenantId: 999,
    }))
    expect(invalid.status).toBe(400)
    expect(mocks.setN8nIntakeControl).not.toHaveBeenCalled()

    mocks.setN8nIntakeControl.mockReturnValue({ outcome: 'conflict', control })
    const conflict = await POST(request('POST', {
      action: 'resume', reason: '发布完成后恢复接收新任务', expectedRevision: 1,
    }))
    expect(conflict.status).toBe(409)
    expect(conflict.headers.get('cache-control')).toBe('no-store')
    expect(mocks.acquireSharedDeploymentLock).toHaveBeenCalledOnce()
    expect(mocks.releaseSharedDeploymentLock).toHaveBeenCalledOnce()
    expect(await conflict.json()).toMatchObject({
      code: 'INTAKE_STATE_CONFLICT',
      control: { revision: 2 },
    })
  })

  it.each([
    ['drain', '准备发布新的服务版本', 2],
    ['resume', '发布完成后恢复接收新任务', 2],
  ] as const)('does not apply %s while a shared installation owns the deployment lock', async (
    action, reason, expectedRevision,
  ) => {
    mocks.acquireSharedDeploymentLock.mockResolvedValue({ acquired: false, reason: 'busy' })
    const response = await POST(request('POST', {
      action, reason, expectedRevision,
    }))
    expect(response.status).toBe(423)
    expect(await response.json()).toMatchObject({ code: 'DEPLOYMENT_IN_PROGRESS' })
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.setN8nIntakeControl).not.toHaveBeenCalled()
  })

  it('uses the current deployment owner as a transaction-scoped bootstrap drain delegation', async () => {
    const response = await POST(request('POST', {
      action: 'drain',
      reason: '首次蓝绿基线引导期间冻结入口',
      expectedRevision: 0,
    }, {
      'x-aiworker-bootstrap-lock-owner-pid': '123',
      'x-aiworker-bootstrap-lock-nonce': 'a'.repeat(64),
    }))

    expect(response.status).toBe(200)
    expect(mocks.verifySharedDeploymentLockDelegation).toHaveBeenCalledWith({
      ownerPid: 123,
      ownerNonce: 'a'.repeat(64),
    })
    expect(mocks.acquireSharedDeploymentLock).not.toHaveBeenCalled()
    expect(mocks.databaseTransaction).toHaveBeenCalledOnce()
    expect(mocks.assertDelegationCurrent).toHaveBeenCalledTimes(2)
    expect(mocks.setN8nIntakeControl).toHaveBeenCalledOnce()
    expect(mocks.releaseSharedDeploymentLock).not.toHaveBeenCalled()
  })

  it.each([
    [{ 'x-aiworker-bootstrap-lock-owner-pid': '123' }, 'drain', '首次蓝绿基线引导期间冻结入口'],
    [{ 'x-aiworker-bootstrap-lock-owner-pid': '123', 'x-aiworker-bootstrap-lock-nonce': 'z'.repeat(64) }, 'drain', '首次蓝绿基线引导期间冻结入口'],
    [{ 'x-aiworker-bootstrap-lock-owner-pid': '123', 'x-aiworker-bootstrap-lock-nonce': 'a'.repeat(64) }, 'resume', '首次蓝绿基线引导期间冻结入口'],
    [{ 'x-aiworker-bootstrap-lock-owner-pid': '123', 'x-aiworker-bootstrap-lock-nonce': 'a'.repeat(64) }, 'drain', '准备发布新的服务版本'],
  ] as const)('rejects an invalid bootstrap delegation without falling back to lock acquisition', async (
    headers, action, reason,
  ) => {
    const response = await POST(request('POST', { action, reason, expectedRevision: 0 }, headers))
    expect(response.status).toBe(403)
    expect(mocks.verifySharedDeploymentLockDelegation).not.toHaveBeenCalled()
    expect(mocks.acquireSharedDeploymentLock).not.toHaveBeenCalled()
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })

  it('rolls back the delegated mutation when the owner changes before transaction commit', async () => {
    const database = new Database(':memory:')
    try {
      runMigrations(database)
      const actual = await vi.importActual<typeof import('@/lib/n8n-intake-control')>(
        '@/lib/n8n-intake-control',
      )
      mocks.getDatabase.mockReturnValue(database)
      mocks.setN8nIntakeControl.mockImplementation(actual.setN8nIntakeControl)
      mocks.assertDelegationCurrent
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(() => { throw new Error('owner changed') })
      const response = await POST(request('POST', {
        action: 'drain', reason: '首次蓝绿基线引导期间冻结入口', expectedRevision: 0,
      }, {
        'x-aiworker-bootstrap-lock-owner-pid': '123',
        'x-aiworker-bootstrap-lock-nonce': 'a'.repeat(64),
      }))
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ code: 'BOOTSTRAP_LOCK_DELEGATION_LOST' })
      expect(database.prepare('SELECT COUNT(*) AS count FROM n8n_intake_controls').get())
        .toEqual({ count: 0 })
      expect(database.prepare('SELECT COUNT(*) AS count FROM n8n_intake_control_events').get())
        .toEqual({ count: 0 })
      expect(mocks.releaseSharedDeploymentLock).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it('rejects bootstrap delegation headers from a non-loopback request', async () => {
    const response = await POST(new NextRequest(
      'https://example.invalid/api/n8n/intake-control',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-aiworker-bootstrap-lock-owner-pid': '123',
          'x-aiworker-bootstrap-lock-nonce': 'a'.repeat(64),
        },
        body: JSON.stringify({
          action: 'drain',
          reason: '首次蓝绿基线引导期间冻结入口',
          expectedRevision: 0,
        }),
      },
    ))
    expect(response.status).toBe(403)
    expect(mocks.verifySharedDeploymentLockDelegation).not.toHaveBeenCalled()
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })

  it('fails closed when the shared deployment lock cannot be inspected', async () => {
    mocks.acquireSharedDeploymentLock.mockRejectedValue(new Error('unsafe run directory'))
    const response = await POST(request('POST', {
      action: 'drain', reason: '准备发布新的服务版本', expectedRevision: 2,
    }))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'DEPLOYMENT_LOCK_UNAVAILABLE' })
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.setN8nIntakeControl).not.toHaveBeenCalled()
  })

  it('releases the shared lock when the intake transaction throws', async () => {
    mocks.setN8nIntakeControl.mockImplementation(() => {
      throw new Error('database busy')
    })
    await expect(POST(request('POST', {
      action: 'drain', reason: '准备发布新的服务版本', expectedRevision: 2,
    }))).rejects.toThrow('database busy')
    expect(mocks.acquireSharedDeploymentLock).toHaveBeenCalledOnce()
    expect(mocks.releaseSharedDeploymentLock).toHaveBeenCalledOnce()
  })

  it('reports lock release failure without hiding the committed control state', async () => {
    mocks.releaseSharedDeploymentLock.mockImplementation(() => {
      throw new Error('lock replaced')
    })
    const response = await POST(request('POST', {
      action: 'resume', reason: '发布完成后恢复接收新任务', expectedRevision: 2,
    }))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      code: 'DEPLOYMENT_LOCK_RELEASE_FAILED',
      control: { revision: 2 },
    })
    expect(mocks.setN8nIntakeControl).toHaveBeenCalledOnce()
  })
})
