import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getOpenClawN8nOperatorUser: vi.fn(),
  getDatabase: vi.fn(),
  createN8nCoverFrameCandidates: vi.fn(),
  readN8nVideoCoverDirectory: vi.fn(),
}))

vi.mock('@/lib/auth', () => ({ getOpenClawN8nOperatorUser: mocks.getOpenClawN8nOperatorUser }))
vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n-cover-frame-candidates', () => ({ createN8nCoverFrameCandidates: mocks.createN8nCoverFrameCandidates }))
vi.mock('@/lib/n8n-video-cover-workflow', () => ({ readN8nVideoCoverDirectory: mocks.readN8nVideoCoverDirectory }))

import { POST } from '@/app/api/n8n/video-cover-workflow/route'

describe('n8n video cover workflow route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDatabase.mockReturnValue({})
    mocks.getOpenClawN8nOperatorUser.mockReturnValue({ workspace_id: 7, tenant_id: 9 })
    mocks.readN8nVideoCoverDirectory.mockReturnValue({
      videoName: '北美火车短片.mp4', totalSegments: 25, items: [], directoryPreviewCompacted: false,
    })
    mocks.createN8nCoverFrameCandidates.mockResolvedValue({
      videoName: '北美火车短片.mp4', totalSegments: 25, candidates: [],
    })
  })

  it('requires the existing loopback operator boundary', async () => {
    mocks.getOpenClawN8nOperatorUser.mockReturnValue(null)
    const response = await POST(new NextRequest('http://127.0.0.1:3017/api/n8n/video-cover-workflow', {
      method: 'POST', body: JSON.stringify({ action: 'segments', query: '北美火车短片.mp4' }),
    }))
    expect(response.status).toBe(403)
    expect(mocks.readN8nVideoCoverDirectory).not.toHaveBeenCalled()
  })

  it('routes directory and native-frame work through one endpoint with strict actions', async () => {
    const directory = await POST(new NextRequest('http://127.0.0.1:3017/api/n8n/video-cover-workflow', {
      method: 'POST', body: JSON.stringify({ action: 'segments', query: '北美火车短片.mp4' }),
    }))
    expect(directory.status).toBe(200)
    expect(mocks.readN8nVideoCoverDirectory).toHaveBeenCalledWith({}, { workspaceId: 7, tenantId: 9 }, {
      query: '北美火车短片.mp4',
    })

    const frames = await POST(new NextRequest('http://127.0.0.1:3017/api/n8n/video-cover-workflow', {
      method: 'POST', body: JSON.stringify({ action: 'frames', query: '北美火车短片.mp4', segmentIndex: 3 }),
    }))
    expect(frames.status).toBe(200)
    expect(mocks.createN8nCoverFrameCandidates).toHaveBeenCalledWith({}, { workspaceId: 7, tenantId: 9 }, {
      query: '北美火车短片.mp4', segmentIndexes: [3],
    }, undefined, { signal: expect.any(AbortSignal) })

    const invalid = await POST(new NextRequest('http://127.0.0.1:3017/api/n8n/video-cover-workflow', {
      method: 'POST', body: JSON.stringify({ action: 'frames', query: '北美火车短片.mp4', segmentIndexes: [3] }),
    }))
    expect(invalid.status).toBe(400)
  })
})
