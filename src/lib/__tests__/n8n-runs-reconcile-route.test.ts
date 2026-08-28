import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireN8nRole: vi.fn(),
  mutationLimiter: vi.fn(),
  getDatabase: vi.fn(),
  logAuditEvent: vi.fn(),
  reconcileScopedN8nVideoTaskRun: vi.fn(),
}))

vi.mock('@/lib/n8n', () => ({ requireN8nRole: mocks.requireN8nRole }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: mocks.mutationLimiter }))
vi.mock('@/lib/db', () => ({
  getDatabase: mocks.getDatabase,
  logAuditEvent: mocks.logAuditEvent,
}))
vi.mock('@/lib/n8n-task-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-task-runs')>()
  return { ...actual, reconcileScopedN8nVideoTaskRun: mocks.reconcileScopedN8nVideoTaskRun }
})

import { POST } from '@/app/api/n8n/runs/reconcile/route'

function request(body: unknown = { taskId: 'video-task-1' }) {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/runs/reconcile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('n8n video run reconciliation route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireN8nRole.mockReturnValue({
      user: { id: 7, username: 'operator', workspace_id: 2, tenant_id: 3 },
    })
    mocks.mutationLimiter.mockReturnValue(null)
    mocks.getDatabase.mockReturnValue({})
    mocks.reconcileScopedN8nVideoTaskRun.mockReturnValue({
      outcome: 'reconciled',
      code: 'VIDEO_CALLBACK_LEASE_EXPIRED',
      run: { id: 11, taskId: 'video-task-1', status: 'failed', error: '[VIDEO_CALLBACK_LEASE_EXPIRED] expired' },
    })
  })

  it('requires operator access before reading or mutating a run', async () => {
    mocks.requireN8nRole.mockReturnValue({ error: 'forbidden', status: 403 })
    const response = await POST(request())
    expect(response.status).toBe(403)
    expect(mocks.mutationLimiter).not.toHaveBeenCalled()
    expect(mocks.reconcileScopedN8nVideoTaskRun).not.toHaveBeenCalled()
  })

  it('honors the mutation rate limiter', async () => {
    mocks.mutationLimiter.mockReturnValue(NextResponse.json({ error: 'slow down' }, { status: 429 }))
    const response = await POST(request())
    expect(response.status).toBe(429)
    expect(mocks.reconcileScopedN8nVideoTaskRun).not.toHaveBeenCalled()
  })

  it('reconciles only through the authenticated workspace scope', async () => {
    const response = await POST(request())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      taskId: 'video-task-1',
      status: 'failed',
      reconciled: true,
      code: 'VIDEO_CALLBACK_LEASE_EXPIRED',
    })
    expect(mocks.reconcileScopedN8nVideoTaskRun).toHaveBeenCalledWith(
      {}, 'video-task-1', { workspaceId: 2, tenantId: 3 },
    )
    expect(mocks.logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      action: 'n8n_video_run_reconcile',
      target_id: 11,
      detail: expect.objectContaining({ task_id: 'video-task-1', code: 'VIDEO_CALLBACK_LEASE_EXPIRED' }),
    }))
  })

  it('does not audit an active run and rejects ineligible runs', async () => {
    mocks.reconcileScopedN8nVideoTaskRun.mockReturnValueOnce({
      outcome: 'active', code: null, run: { id: 12, status: 'accepted', error: null },
    })
    const activeResponse = await POST(request())
    expect(activeResponse.status).toBe(200)
    expect(await activeResponse.json()).toMatchObject({ status: 'accepted', reconciled: false, code: null })
    expect(mocks.logAuditEvent).not.toHaveBeenCalled()

    mocks.reconcileScopedN8nVideoTaskRun.mockReturnValueOnce({
      outcome: 'ineligible', code: null, run: { id: 13, status: 'queued' },
    })
    const rejectedResponse = await POST(request())
    expect(rejectedResponse.status).toBe(409)
  })

  it('returns a scoped not-found response without leaking another workspace run', async () => {
    mocks.reconcileScopedN8nVideoTaskRun.mockReturnValue({ outcome: 'not_found', code: null, run: null })
    const response = await POST(request())
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: '未找到任务运行记录' })
  })

  it('rejects malformed task identifiers before opening the database', async () => {
    const response = await POST(request({ taskId: 'bad task id' }))
    expect(response.status).toBe(400)
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })
})
