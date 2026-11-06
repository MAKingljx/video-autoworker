import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getOpenClawN8nOperatorUser: vi.fn(),
  getDatabase: vi.fn(),
  createN8nCoverFrameCandidates: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ getOpenClawN8nOperatorUser: mocks.getOpenClawN8nOperatorUser }))
vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n-cover-frame-candidates', () => ({ createN8nCoverFrameCandidates: mocks.createN8nCoverFrameCandidates }))

import { POST } from '@/app/api/n8n/video-cover-frames/route'

describe('legacy n8n video cover frame adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDatabase.mockReturnValue({})
    mocks.getOpenClawN8nOperatorUser.mockReturnValue({ workspace_id: 7, tenant_id: 9 })
    mocks.createN8nCoverFrameCandidates.mockResolvedValue({
      videoName: '北美火车短片.mp4', totalSegments: 25, candidates: [],
    })
  })

  it('remains loopback-only and preserves the old one-segment request shape during migration', async () => {
    const response = await POST(new NextRequest('http://127.0.0.1:3017/api/n8n/video-cover-frames', {
      method: 'POST', body: JSON.stringify({ query: '北美火车短片.mp4', segmentIndexes: [3] }),
    }))
    expect(response.status).toBe(200)
    expect(mocks.createN8nCoverFrameCandidates).toHaveBeenCalledWith({}, { workspaceId: 7, tenantId: 9 }, {
      query: '北美火车短片.mp4', segmentIndexes: [3],
    }, undefined, { signal: expect.any(AbortSignal) })
  })
})
