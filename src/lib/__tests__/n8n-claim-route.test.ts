import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyN8nWebhookSecret: vi.fn(),
  getDatabase: vi.fn(),
  claimScopedN8nVideoTaskRun: vi.fn(),
}))

vi.mock('@/lib/n8n', () => ({
  verifyN8nWebhookSecret: mocks.verifyN8nWebhookSecret,
}))

vi.mock('@/lib/db', () => ({
  getDatabase: mocks.getDatabase,
}))

vi.mock('@/lib/n8n-task-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-task-runs')>()
  return {
    ...actual,
    claimScopedN8nVideoTaskRun: mocks.claimScopedN8nVideoTaskRun,
  }
})

import { POST } from '@/app/api/n8n/claim/route'

const payload = {
  taskId: 'video-task-1',
  idempotencyKey: 'video-idem-1',
  bindingId: 7,
  workspaceId: 2,
  tenantId: 3,
}

function request(body: unknown, secret = 'shared-secret') {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/claim', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-AIWorker-Webhook-Secret': secret,
    },
    body: JSON.stringify(body),
  })
}

describe('n8n video parent claim route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyN8nWebhookSecret.mockReturnValue(true)
    mocks.getDatabase.mockReturnValue({})
    mocks.claimScopedN8nVideoTaskRun.mockReturnValue({
      outcome: 'claimed',
      run: { taskId: payload.taskId, status: 'running' },
    })
  })

  it('authenticates and claims the exact scoped video parent', async () => {
    const response = await POST(request(payload))

    expect(response.status).toBe(200)
    expect(mocks.verifyN8nWebhookSecret).toHaveBeenCalledWith('shared-secret')
    expect(mocks.claimScopedN8nVideoTaskRun).toHaveBeenCalledWith(
      {},
      { taskId: payload.taskId, idempotencyKey: payload.idempotencyKey, bindingId: 7 },
      { workspaceId: 2, tenantId: 3 },
    )
    expect(await response.json()).toEqual({
      taskId: payload.taskId,
      status: 'running',
      claimed: true,
      duplicate: false,
    })
  })

  it('rejects an invalid secret before reading the database', async () => {
    mocks.verifyN8nWebhookSecret.mockReturnValue(false)

    const response = await POST(request(payload, 'wrong-secret'))

    expect(response.status).toBe(401)
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.claimScopedN8nVideoTaskRun).not.toHaveBeenCalled()
  })

  it('rejects malformed identities and scope values', async () => {
    const response = await POST(request({ ...payload, taskId: '../unsafe', workspaceId: 0 }))

    expect(response.status).toBe(400)
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.claimScopedN8nVideoTaskRun).not.toHaveBeenCalled()
  })

  it('treats a concurrently claimed running task as an idempotent duplicate', async () => {
    mocks.claimScopedN8nVideoTaskRun.mockReturnValue({
      outcome: 'running',
      run: { taskId: payload.taskId, status: 'running' },
    })

    const response = await POST(request(payload))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ claimed: false, duplicate: true, status: 'running' })
  })

  it.each([
    ['not_found', 404],
    ['rejected', 409],
    ['terminal', 409],
  ] as const)('maps %s outcomes to HTTP %s without claiming', async (outcome, status) => {
    mocks.claimScopedN8nVideoTaskRun.mockReturnValue({
      outcome,
      run: outcome === 'terminal'
        ? { taskId: payload.taskId, status: 'failed', error: 'already failed' }
        : null,
    })

    const response = await POST(request(payload))

    expect(response.status).toBe(status)
  })
})
