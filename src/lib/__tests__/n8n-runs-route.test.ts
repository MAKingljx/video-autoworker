import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireN8nRole: vi.fn(),
  getDatabase: vi.fn(),
  getScopedN8nTaskRunByTaskId: vi.fn(),
  listN8nTaskRuns: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n', () => ({ requireN8nRole: mocks.requireN8nRole }))
vi.mock('@/lib/n8n-task-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-task-runs')>()
  return {
    ...actual,
    getScopedN8nTaskRunByTaskId: mocks.getScopedN8nTaskRunByTaskId,
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
})
