import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireN8nRole: vi.fn(),
  triggerN8nWebhook: vi.fn(),
  getDatabase: vi.fn(),
  logAuditEvent: vi.fn(),
  getN8nWorkflowBinding: vi.fn(),
  updateN8nWorkflowRunStatus: vi.fn(),
  mutationLimiter: vi.fn(),
}))

vi.mock('@/lib/n8n', () => ({
  requireN8nRole: mocks.requireN8nRole,
  triggerN8nWebhook: mocks.triggerN8nWebhook,
}))

vi.mock('@/lib/db', () => ({
  getDatabase: mocks.getDatabase,
  logAuditEvent: mocks.logAuditEvent,
}))

vi.mock('@/lib/n8n-workflows', () => ({
  getN8nWorkflowBinding: mocks.getN8nWorkflowBinding,
  updateN8nWorkflowRunStatus: mocks.updateN8nWorkflowRunStatus,
}))

vi.mock('@/lib/rate-limit', () => ({
  mutationLimiter: mocks.mutationLimiter,
}))

import { POST } from '@/app/api/n8n/trigger/route'

const binding = {
  id: 7,
  name: '视频分析任务链',
  webhookPath: 'webhook/aiworker-task',
  taskType: 'video-analysis',
  agentRole: 'video-specialist',
  model: 'qwen36-tools-local/default_model',
  timeoutSeconds: 120,
  retryCount: 2,
  enabled: true,
  config: { queue: 'heavy-model' },
}

function request(body: unknown) {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('n8n trigger route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireN8nRole.mockReturnValue({
      user: { id: 1, username: 'local-desktop', workspace_id: 2, tenant_id: 3 },
    })
    mocks.mutationLimiter.mockReturnValue(null)
    mocks.getDatabase.mockReturnValue({})
    mocks.getN8nWorkflowBinding.mockReturnValue(binding)
    mocks.triggerN8nWebhook.mockResolvedValue({
      ok: true,
      statusCode: 202,
      data: { accepted: true },
      latencyMs: 12,
    })
  })

  it('sends a stable routing envelope to n8n without the reserved binding property', async () => {
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-7',
      idempotencyKey: 'idem-7',
      input: { prompt: '分析视频' },
    }))

    expect(response.status).toBe(200)
    expect(mocks.triggerN8nWebhook).toHaveBeenCalledWith(
      'webhook/aiworker-task',
      {
        taskId: 'task-7',
        idempotencyKey: 'idem-7',
        source: 'video-autoworker',
        requestedBy: 'local-desktop',
        routing: {
          id: 7,
          name: '视频分析任务链',
          taskType: 'video-analysis',
          agentRole: 'video-specialist',
          model: 'qwen36-tools-local/default_model',
          timeoutSeconds: 120,
          retryCount: 2,
          config: { queue: 'heavy-model' },
        },
        input: { prompt: '分析视频' },
      },
      { timeoutMs: 120_000, idempotencyKey: 'idem-7' },
    )
    expect(mocks.getN8nWorkflowBinding).toHaveBeenCalledWith({}, 7, { workspaceId: 2, tenantId: 3 })
    expect(mocks.updateN8nWorkflowRunStatus).toHaveBeenCalledWith(
      {}, 7, 'accepted', { workspaceId: 2, tenantId: 3 },
    )
    expect(await response.json()).toMatchObject({ taskId: 'task-7', result: { ok: true } })
  })

  it('refuses disabled bindings before calling n8n', async () => {
    mocks.getN8nWorkflowBinding.mockReturnValue({ ...binding, enabled: false })

    const response = await POST(request({ bindingId: 7, input: { prompt: 'test' } }))

    expect(response.status).toBe(409)
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('records a failed run when the n8n webhook rejects the request', async () => {
    mocks.triggerN8nWebhook.mockRejectedValue(new Error('n8n unavailable'))

    const response = await POST(request({ bindingId: 7, taskId: 'task-failed', input: {} }))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ taskId: 'task-failed', error: 'n8n unavailable' })
    expect(mocks.updateN8nWorkflowRunStatus).toHaveBeenCalledWith(
      {}, 7, 'failed: n8n unavailable', { workspaceId: 2, tenantId: 3 },
    )
  })
})
