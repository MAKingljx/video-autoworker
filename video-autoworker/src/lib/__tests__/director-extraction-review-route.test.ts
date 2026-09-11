import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({ marker: 'db' })),
  requireN8nRole: vi.fn(() => ({
    user: { id: 7, username: 'reviewer', workspace_id: 38, tenant_id: 83 },
  })),
  scope: vi.fn(() => true),
  mutationLimiter: vi.fn(() => null),
  list: vi.fn(),
  prepare: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n', () => ({ requireN8nRole: mocks.requireN8nRole }))
vi.mock('@/lib/director-brain-scope', () => ({ isDirectorBrainScope: mocks.scope }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: mocks.mutationLimiter }))
vi.mock('@/lib/director-extraction-review-application', () => ({
  listDirectorLearningReviews: mocks.list,
  prepareDirectorLearningReview: mocks.prepare,
  confirmDirectorLearningReview: mocks.confirm,
  cancelDirectorLearningReview: mocks.cancel,
}))

import { POST } from '@/app/api/n8n/director-extraction/review/route'

function request(body: unknown) {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/director-extraction/review', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('director extraction review route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireN8nRole.mockReturnValue({
      user: { id: 7, username: 'reviewer', workspace_id: 38, tenant_id: 83 },
    })
    mocks.scope.mockReturnValue(true)
    mocks.mutationLimiter.mockReturnValue(null)
  })

  it('lists public review DTOs behind the operator and scope gates', async () => {
    mocks.list.mockResolvedValue([{ reviewId: 'a'.repeat(64), reviewRevision: 7 }])
    const response = await POST(request({ action: 'list' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true, action: 'list', reviews: [{ reviewId: 'a'.repeat(64), reviewRevision: 7 }],
    })
    expect(mocks.requireN8nRole).toHaveBeenCalledWith(expect.any(Request), 'operator')
    expect(mocks.mutationLimiter).toHaveBeenCalledOnce()
    expect(mocks.list).toHaveBeenCalledWith(
      { marker: 'db' }, { workspaceId: 38, tenantId: 83 },
    )
  })

  it('prepares a persistent batch without calling the confirm service', async () => {
    mocks.prepare.mockResolvedValue({
      requestId: 'request-route-001', reviewId: 'b'.repeat(64), reviewRevision: 9,
      decision: 'approve', batchId: `DRB-${'d'.repeat(32)}`,
      confirmationCode: 'ABC123', count: 1, status: 'pending', message: '请确认',
    })
    const response = await POST(request({
      action: 'prepare', requestId: 'request-route-001', reviewId: 'b'.repeat(64),
      reviewRevision: 9, decision: 'approve', candidateIds: ['c'.repeat(64)],
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true, action: 'prepare', batchId: `DRB-${'d'.repeat(32)}`,
      confirmationCode: 'ABC123', count: 1, status: 'pending',
    })
    expect(mocks.prepare).toHaveBeenCalledOnce()
    expect(mocks.confirm).not.toHaveBeenCalled()
  })

  it.each([
    ['completed', 200, true],
    ['conflict', 409, false],
    ['unknown', 503, false],
  ] as const)('maps a confirmed %s outcome without browser-supplied authority', async (
    outcome, status, ok,
  ) => {
    mocks.confirm.mockResolvedValue({
      outcome,
      requestId: 'request-route-001',
      reviewId: 'b'.repeat(64),
      reviewRevision: 9,
      decision: 'approve',
      completedCount: outcome === 'completed' ? 1 : 0,
      totalCount: 1,
      message: '结果',
    })
    const response = await POST(request({
      action: 'confirm',
      requestId: 'request-route-001',
      reviewId: 'b'.repeat(64),
      reviewRevision: 9,
      decision: 'approve',
      candidateIds: ['c'.repeat(64)],
      batchId: `DRB-${'d'.repeat(32)}`,
      confirmationCode: 'ABC123',
      count: 1,
    }))

    expect(response.status).toBe(status)
    expect(await response.json()).toMatchObject({ ok, action: 'confirm', outcome })
    expect(mocks.confirm).toHaveBeenCalledWith(
      { marker: 'db' },
      { workspaceId: 38, tenantId: 83 },
      'platform:7:reviewer',
      expect.objectContaining({
        requestId: 'request-route-001',
        reviewRevision: 9,
        decision: 'approve',
        candidateIds: ['c'.repeat(64)],
      }),
    )
    const applicationInput = mocks.confirm.mock.calls[0][3]
    expect(applicationInput).not.toHaveProperty('actorKey')
    expect(applicationInput).not.toHaveProperty('reviewer')
    expect(applicationInput).not.toHaveProperty('reason')
    expect(applicationInput).not.toHaveProperty('expectedVersion')
    expect(applicationInput).not.toHaveProperty('targetStatus')
  })

  it('cancels through the same server-derived actor', async () => {
    mocks.cancel.mockReturnValue({
      batchId: `DRB-${'d'.repeat(32)}`, count: 1, status: 'cancelled', message: '已取消',
    })
    const response = await POST(request({
      action: 'cancel', batchId: `DRB-${'d'.repeat(32)}`, confirmationCode: 'ABC123',
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, action: 'cancel', status: 'cancelled' })
    expect(mocks.cancel).toHaveBeenCalledWith(
      { marker: 'db' }, { workspaceId: 38, tenantId: 83 }, 'platform:7:reviewer',
      { action: 'cancel', batchId: `DRB-${'d'.repeat(32)}`, confirmationCode: 'ABC123' },
    )
  })

  it('rejects unauthorized, cross-scope, and expanded prepare bodies before the service', async () => {
    mocks.requireN8nRole.mockReturnValueOnce({ error: 'Forbidden', status: 403 } as never)
    expect((await POST(request({ action: 'list' }))).status).toBe(403)
    expect(mocks.getDatabase).not.toHaveBeenCalled()

    mocks.scope.mockReturnValueOnce(false)
    expect((await POST(request({ action: 'list' }))).status).toBe(403)
    expect(mocks.getDatabase).not.toHaveBeenCalled()

    const expanded = await POST(request({
      action: 'prepare',
      requestId: 'request-route-002',
      reviewId: 'b'.repeat(64),
      reviewRevision: 9,
      decision: 'reject',
      candidateIds: ['c'.repeat(64)],
      reviewer: 'browser-controlled',
    }))
    expect(expanded.status).toBe(400)
    expect(await expanded.json()).toMatchObject({
      code: 'director_extraction_review_request_invalid',
    })
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
