import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireN8nRole: vi.fn(),
  getDatabase: vi.fn(),
  getN8nVideoResultDetail: vi.fn(),
  getScopedN8nTaskRunByTaskId: vi.fn(),
  listN8nVideoResults: vi.fn(),
  listN8nTaskRunSummaries: vi.fn(),
  listN8nTaskRuns: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n', () => ({ requireN8nRole: mocks.requireN8nRole }))
vi.mock('@/lib/n8n-task-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-task-runs')>()
  return {
    ...actual,
    getN8nVideoResultDetail: mocks.getN8nVideoResultDetail,
    getScopedN8nTaskRunByTaskId: mocks.getScopedN8nTaskRunByTaskId,
    listN8nVideoResults: mocks.listN8nVideoResults,
    listN8nTaskRunSummaries: mocks.listN8nTaskRunSummaries,
    listN8nTaskRuns: mocks.listN8nTaskRuns,
  }
})

import { GET } from '@/app/api/n8n/runs/route'

describe('n8n task runs route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireN8nRole.mockReturnValue({
      user: { workspace_id: 2, tenant_id: 3 },
    })
    mocks.getDatabase.mockReturnValue({})
  })

  it('queries only the requested workspace-scoped task', async () => {
    mocks.getScopedN8nTaskRunByTaskId.mockReturnValue({ taskId: 'task-1', status: 'succeeded' })

    const response = await GET(new NextRequest('http://127.0.0.1:3017/api/n8n/runs?taskId=task-1'))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ runs: [{ taskId: 'task-1', status: 'succeeded' }] })
    expect(mocks.getScopedN8nTaskRunByTaskId).toHaveBeenCalledWith(
      {}, 'task-1', { workspaceId: 2, tenantId: 3 },
    )
    expect(mocks.listN8nTaskRuns).not.toHaveBeenCalled()
  })

  it('rejects an invalid task id before querying the database', async () => {
    const response = await GET(new NextRequest('http://127.0.0.1:3017/api/n8n/runs?taskId=bad%20id'))

    expect(response.status).toBe(400)
    expect(mocks.getScopedN8nTaskRunByTaskId).not.toHaveBeenCalled()
  })

  it('returns the compact paginated list view without changing the legacy response', async () => {
    mocks.listN8nTaskRunSummaries.mockReturnValue({
      runs: [{ taskId: 'task-2', title: 'S03E03.mp4', status: 'succeeded' }],
      total: 1,
      limit: 25,
      offset: 0,
    })

    const response = await GET(new NextRequest(
      'http://127.0.0.1:3017/api/n8n/runs?view=list&limit=25&status=succeeded&query=S03E03',
    ))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      runs: [{ taskId: 'task-2', title: 'S03E03.mp4', status: 'succeeded' }],
      total: 1,
      limit: 25,
      offset: 0,
    })
    expect(mocks.listN8nTaskRunSummaries).toHaveBeenCalledWith(
      {},
      { workspaceId: 2, tenantId: 3 },
      { limit: 25, offset: 0, status: 'succeeded', query: 'S03E03' },
    )
    expect(mocks.listN8nTaskRuns).not.toHaveBeenCalled()
  })

  it('rejects an unsupported list status', async () => {
    const response = await GET(new NextRequest(
      'http://127.0.0.1:3017/api/n8n/runs?view=list&status=waiting',
    ))

    expect(response.status).toBe(400)
    expect(mocks.listN8nTaskRunSummaries).not.toHaveBeenCalled()
  })

  it('returns the safe video-result list and detail views within the current scope', async () => {
    mocks.listN8nVideoResults.mockReturnValue({
      results: [{ taskId: 'video-1', title: 'S03E03.mp4', status: 'succeeded' }],
      total: 1,
      limit: 25,
      offset: 0,
    })
    const listResponse = await GET(new NextRequest(
      'http://127.0.0.1:3017/api/n8n/runs?view=video-results&status=succeeded&query=S03E03',
    ))
    expect(await listResponse.json()).toEqual({
      results: [{ taskId: 'video-1', title: 'S03E03.mp4', status: 'succeeded' }],
      total: 1,
      limit: 25,
      offset: 0,
    })
    expect(mocks.listN8nVideoResults).toHaveBeenCalledWith(
      {},
      { workspaceId: 2, tenantId: 3 },
      { limit: 25, offset: 0, status: 'succeeded', query: 'S03E03' },
    )

    mocks.getN8nVideoResultDetail.mockReturnValue({
      taskId: 'video-1', title: 'S03E03.mp4', fullReport: '正式报告',
    })
    const detailResponse = await GET(new NextRequest(
      'http://127.0.0.1:3017/api/n8n/runs?view=video-results&taskId=video-1',
    ))
    expect(await detailResponse.json()).toEqual({
      result: { taskId: 'video-1', title: 'S03E03.mp4', fullReport: '正式报告' },
    })
    expect(mocks.getN8nVideoResultDetail).toHaveBeenCalledWith(
      {}, 'video-1', { workspaceId: 2, tenantId: 3 },
    )
    expect(mocks.getScopedN8nTaskRunByTaskId).not.toHaveBeenCalled()
  })

  it('returns 404 for a scoped video detail that does not exist', async () => {
    mocks.getN8nVideoResultDetail.mockReturnValue(null)
    const response = await GET(new NextRequest(
      'http://127.0.0.1:3017/api/n8n/runs?view=video-results&taskId=missing',
    ))
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ error: '未找到视频分析结果' })
  })

  it('keeps the default list contract for existing callers', async () => {
    mocks.listN8nTaskRuns.mockReturnValue([{ taskId: 'legacy-task', output: { ok: true } }])

    const response = await GET(new NextRequest('http://127.0.0.1:3017/api/n8n/runs?limit=10'))

    expect(await response.json()).toEqual({
      runs: [{ taskId: 'legacy-task', output: { ok: true } }],
    })
    expect(mocks.listN8nTaskRuns).toHaveBeenCalledWith(
      {}, { workspaceId: 2, tenantId: 3 }, 10,
    )
    expect(mocks.listN8nTaskRunSummaries).not.toHaveBeenCalled()
  })
})
