import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(() => ({ marker: 'db' })),
  requireN8nRole: vi.fn((_request: Request, _role: string) => ({
    user: { workspace_id: 2, tenant_id: 3 },
  }) as { user: { workspace_id: number; tenant_id: number } } | {
    error: string; status: number
  }),
  mutationLimiter: vi.fn(() => null),
  start: vi.fn(),
  status: vi.fn(),
  project: vi.fn((_: unknown, job: Record<string, unknown>) => ({
    status: job.status,
    phase: job.currentPhase,
    progress: 0,
    completedPhases: [],
    candidateCount: 0,
    message: '导演知识正在分阶段提炼',
  })),
}))

vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n', () => ({ requireN8nRole: mocks.requireN8nRole }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: mocks.mutationLimiter }))
vi.mock('@/lib/director-extraction-application', () => ({
  startDirectorExtractionForWork: mocks.start,
  getDirectorExtractionStatusForWork: mocks.status,
}))
vi.mock('@/lib/director-extraction-runs', () => ({
  projectDirectorExtractionStatus: mocks.project,
}))

import { POST } from '@/app/api/n8n/director-extraction/route'

function request(body: unknown) {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/director-extraction', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('director extraction loopback route', () => {
  const originalScope = {
    tenantId: process.env.MC_OPENCLAW_TENANT_ID,
    workspaceId: process.env.MC_OPENCLAW_WORKSPACE_ID,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MC_OPENCLAW_TENANT_ID = '3'
    process.env.MC_OPENCLAW_WORKSPACE_ID = '2'
    mocks.requireN8nRole.mockReturnValue({ user: { workspace_id: 2, tenant_id: 3 } })
    mocks.mutationLimiter.mockReturnValue(null)
  })

  afterEach(() => {
    if (originalScope.tenantId === undefined) delete process.env.MC_OPENCLAW_TENANT_ID
    else process.env.MC_OPENCLAW_TENANT_ID = originalScope.tenantId
    if (originalScope.workspaceId === undefined) delete process.env.MC_OPENCLAW_WORKSPACE_ID
    else process.env.MC_OPENCLAW_WORKSPACE_ID = originalScope.workspaceId
  })

  it('rejects a second scope before opening the database or shared service', async () => {
    mocks.requireN8nRole.mockReturnValue({ user: { workspace_id: 22, tenant_id: 33 } })

    const response = await POST(request({
      action: 'start_extraction', workId: 'WORK-EARTH-001',
    }))

    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'director_brain_scope_forbidden' })
    expect(mocks.mutationLimiter).not.toHaveBeenCalled()
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
  })

  it('starts by work and source query with a short status receipt', async () => {
    mocks.start.mockResolvedValue({ status: 'pending', currentPhase: 'perception' })
    const response = await POST(request({
      action: 'start_extraction',
      workId: 'WORK-EARTH-001',
      sourceQuery: '地球之极 第一季 第一集',
      objective: '提炼人物变化和叙事技法',
    }))
    expect(response.status).toBe(202)
    const body = await response.json()
    expect(body).toMatchObject({
      ok: true,
      action: 'start_extraction',
      status: 'pending',
      message: '导演知识正在分阶段提炼',
    })
    expect(JSON.stringify(body)).not.toContain('sourceTaskId')
    expect(mocks.start).toHaveBeenCalledWith(
      { marker: 'db' },
      { workspaceId: 2, tenantId: 3 },
      expect.objectContaining({ workId: 'WORK-EARTH-001' }),
    )
    const [authRequest, role] = mocks.requireN8nRole.mock.calls[0]
    expect(role).toBe('operator')
    expect(authRequest.headers.get('authorization')).toBeNull()
    expect(authRequest.headers.get('x-api-key')).toBeNull()
  })

  it('returns status by work without asking for a task or job id', async () => {
    mocks.status.mockReturnValue({
      status: 'awaiting_case_review',
      phase: 'technique',
      progress: 80,
      completedPhases: ['perception', 'understanding', 'judgment', 'case'],
      candidateCount: 6,
      message: '案例待复核，确认后才能提炼技法',
    })
    const response = await POST(request({
      action: 'extraction_status',
      workId: 'WORK-EARTH-001',
    }))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      found: true,
      status: 'awaiting_case_review',
      message: '案例待复核，确认后才能提炼技法',
    })
  })

  it('rejects source filters on the explicit whole-work backfill boundary', async () => {
    const response = await POST(request({
      action: 'backfill_extraction',
      workId: 'WORK-EARTH-001',
      sourceQuery: '地球之极',
    }))
    expect(response.status).toBe(400)
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })

  it('fails closed when one work has multiple extraction roots', async () => {
    mocks.status.mockImplementation(() => {
      throw new Error('director_extraction_source_ambiguous')
    })
    const response = await POST(request({
      action: 'extraction_status',
      workId: 'WORK-EARTH-001',
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      ok: false,
      code: 'director_extraction_source_ambiguous',
      error: '匹配到多个视频结果，请补充更准确的作品名或集数',
    })
  })

  it('does not expose an unexpected downstream error as an API code', async () => {
    mocks.start.mockRejectedValue(new Error('remote_internal_detail_123'))
    const response = await POST(request({
      action: 'start_extraction',
      workId: 'WORK-EARTH-001',
    }))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      ok: false,
      code: 'director_extraction_unavailable',
      error: '导演知识提炼暂时不可用，请稍后重试',
    })
  })

  it('rejects unauthorized or expanded requests before reaching the shared service', async () => {
    mocks.requireN8nRole.mockReturnValueOnce({ error: 'Forbidden', status: 403 })
    const denied = await POST(request({
      action: 'start_extraction', workId: 'WORK-EARTH-001',
    }))
    expect(denied.status).toBe(403)
    expect(mocks.mutationLimiter).not.toHaveBeenCalled()
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()

    mocks.requireN8nRole.mockReturnValue({ user: { workspace_id: 2, tenant_id: 3 } })
    for (const body of [
      {
        action: 'start_extraction',
        workId: 'WORK-EARTH-001',
        reviewedReferences: { material_evidence: ['EVIDENCE-1'] },
      },
      { action: 'approve', workId: 'WORK-EARTH-001' },
      { action: 'extraction_status', workId: 'WORK-EARTH-001', objective: '不允许' },
    ]) {
      const response = await POST(request(body))
      expect(response.status).toBe(400)
    }
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.start).not.toHaveBeenCalled()
    expect(mocks.status).not.toHaveBeenCalled()
  })
})
