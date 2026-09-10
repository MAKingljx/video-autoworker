import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireN8nRole: vi.fn(),
  getDatabase: vi.fn(),
  searchN8nVideoResults: vi.fn(),
  listN8nVideoSources: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n', () => ({ requireN8nRole: mocks.requireN8nRole }))
vi.mock('@/lib/n8n-task-runs', () => ({ searchN8nVideoResults: mocks.searchN8nVideoResults }))
vi.mock('@/lib/n8n-video-sources', () => ({ listN8nVideoSources: mocks.listN8nVideoSources }))

import { GET } from '@/app/api/n8n/video-library/route'

describe('n8n video library route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireN8nRole.mockReturnValue({ user: { workspace_id: 2, tenant_id: 3 } })
    mocks.getDatabase.mockReturnValue({})
    mocks.listN8nVideoSources.mockResolvedValue(new Map())
  })

  it('requires a search keyword', async () => {
    const response = await GET(new NextRequest('http://127.0.0.1:3017/api/n8n/video-library'))
    expect(response.status).toBe(400)
    expect(mocks.searchN8nVideoResults).not.toHaveBeenCalled()
  })

  it('returns safe content hits with source availability', async () => {
    mocks.searchN8nVideoResults.mockReturnValue({
      query: '雪山',
      hits: [{ id: 'task-1:timeline:1', taskId: 'task-1', title: '视频.mp4', startSeconds: 10 }],
      total: 1,
      videoCount: 1,
      segmentCount: 1,
      limit: 80,
      truncated: false,
    })
    mocks.listN8nVideoSources.mockResolvedValue(new Map([['task-1', { taskId: 'task-1' }]]))
    const response = await GET(new NextRequest(
      'http://127.0.0.1:3017/api/n8n/video-library?q=%E9%9B%AA%E5%B1%B1&limit=80',
    ))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      playableVideos: 1,
      hits: [{ taskId: 'task-1', mediaAvailable: true }],
    })
    expect(mocks.searchN8nVideoResults).toHaveBeenCalledWith(
      {}, { workspaceId: 2, tenantId: 3 }, '雪山', 80,
    )
  })
})
