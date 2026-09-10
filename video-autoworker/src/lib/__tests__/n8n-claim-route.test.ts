import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getN8nTaskRunByTaskId: vi.fn(),
  claimScopedN8nTaskRun: vi.fn(),
  checkN8nCallbackAdmission: vi.fn(),
}))

vi.mock('@/lib/db', () => ({
  getDatabase: mocks.getDatabase,
}))

vi.mock('@/lib/n8n-runtime-affinity', () => ({
  checkN8nCallbackAdmission: mocks.checkN8nCallbackAdmission,
}))

vi.mock('@/lib/n8n-task-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-task-runs')>()
  return {
    ...actual,
    getN8nTaskRunByTaskId: mocks.getN8nTaskRunByTaskId,
    claimScopedN8nTaskRun: mocks.claimScopedN8nTaskRun,
  }
})

import { POST } from '@/app/api/n8n/claim/route'

const payload = {
  taskId: 'video-task-1',
  idempotencyKey: 'video-idem-1',
  bindingId: 7,
  workspaceId: 2,
  tenantId: 3,
  executionOwner: 'n8n-execution:12345',
}

function request(body: unknown) {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/claim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

describe('n8n video parent claim route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDatabase.mockReturnValue({})
    mocks.getN8nTaskRunByTaskId.mockReturnValue({ taskId: payload.taskId, routing: {} })
    mocks.checkN8nCallbackAdmission.mockReturnValue({ allowed: true, mode: 'legacy' })
    mocks.claimScopedN8nTaskRun.mockReturnValue({
      outcome: 'claimed',
      run: { taskId: payload.taskId, status: 'running' },
    })
  })

  it('claims the exact scoped video parent on the loopback task channel', async () => {
    const response = await POST(request(payload))

    expect(response.status).toBe(200)
    expect(mocks.claimScopedN8nTaskRun).toHaveBeenCalledWith(
      {},
      { taskId: payload.taskId, idempotencyKey: payload.idempotencyKey, bindingId: 7, executionOwner: payload.executionOwner },
      { workspaceId: 2, tenantId: 3 },
    )
    expect(await response.json()).toEqual({
      taskId: payload.taskId,
      status: 'running',
      claimed: true,
      resumed: false,
      duplicate: false,
    })
  })

  it('rejects a callback owned by another release before claiming', async () => {
    mocks.checkN8nCallbackAdmission.mockReturnValue({
      allowed: false,
      code: 'runtime_affinity_mismatch',
      error: '父任务回调属于其他运行版本',
    })

    const response = await POST(request(payload))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'runtime_affinity_mismatch' })
    expect(mocks.claimScopedN8nTaskRun).not.toHaveBeenCalled()
  })

  it('rejects malformed identities and scope values', async () => {
    const response = await POST(request({ ...payload, taskId: '../unsafe', workspaceId: 0 }))

    expect(response.status).toBe(400)
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.claimScopedN8nTaskRun).not.toHaveBeenCalled()
  })

  it('rejects a missing or malformed n8n execution owner before database access', async () => {
    const response = await POST(request({ ...payload, executionOwner: 'other-delivery/1' }))

    expect(response.status).toBe(400)
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.claimScopedN8nTaskRun).not.toHaveBeenCalled()
  })

  it('treats a concurrently claimed running task as an idempotent duplicate', async () => {
    mocks.claimScopedN8nTaskRun.mockReturnValue({
      outcome: 'running',
      run: { taskId: payload.taskId, status: 'running' },
    })

    const response = await POST(request(payload))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ claimed: false, resumed: false, duplicate: true, status: 'running' })
  })

  it('lets the same n8n execution resume after its first claim response is lost', async () => {
    mocks.claimScopedN8nTaskRun.mockReturnValue({
      outcome: 'owned',
      run: { taskId: payload.taskId, status: 'running' },
    })

    const response = await POST(request(payload))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      claimed: true,
      resumed: true,
      duplicate: false,
      status: 'running',
    })
  })

  it.each([
    ['not_found', 404],
    ['rejected', 409],
    ['terminal', 409],
  ] as const)('maps %s outcomes to HTTP %s without claiming', async (outcome, status) => {
    mocks.claimScopedN8nTaskRun.mockReturnValue({
      outcome,
      run: outcome === 'terminal'
        ? { taskId: payload.taskId, status: 'failed', error: 'already failed' }
        : null,
    })

    const response = await POST(request(payload))

    expect(response.status).toBe(status)
  })
})
