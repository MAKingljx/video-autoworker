import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireN8nRole: vi.fn(),
  triggerN8nWebhook: vi.fn(),
  getDatabase: vi.fn(),
  logAuditEvent: vi.fn(),
  getN8nWorkflowBinding: vi.fn(),
  updateN8nWorkflowRunStatus: vi.fn(),
  createN8nTaskRun: vi.fn(),
  markN8nTaskAccepted: vi.fn(),
  failN8nTaskRun: vi.fn(),
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

vi.mock('@/lib/n8n-task-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-task-runs')>()
  return {
    ...actual,
    createN8nTaskRun: mocks.createN8nTaskRun,
    markN8nTaskAccepted: mocks.markN8nTaskAccepted,
    failN8nTaskRun: mocks.failN8nTaskRun,
  }
})

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
    delete process.env.AIWORKER_N8N_NODE_CALLBACK_URL
    delete process.env.AIWORKER_N8N_MEDIA_CALLBACK_URL
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify({
      version: 1,
      routes: [{
        id: 'cloud-planner',
        label: '云端规划模型',
        location: 'cloud',
        transport: 'openclaw',
        model: 'openai/gpt-5.5',
        profile: 'gpt-main',
        agentId: 'main',
        enabled: true,
      }],
    })
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
    mocks.createN8nTaskRun.mockReturnValue({
      created: true,
      run: { taskId: 'task-7', status: 'queued', output: null },
    })
  })

  it('sends a stable routing envelope to n8n without the reserved binding property', async () => {
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-7',
      idempotencyKey: 'idem-7',
      input: { prompt: '分析视频' },
    }))

    expect(response.status).toBe(202)
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
          nodeCallbackUrl: 'http://127.0.0.1:3017/api/n8n/node-execute',
          mediaCallbackUrl: 'http://127.0.0.1:3017/api/n8n/media-execute',
          config: { queue: 'heavy-model' },
          memoryMode: 'none',
        },
        input: { prompt: '分析视频' },
        delivery: { mode: 'none' },
      },
      { timeoutMs: 120_000, idempotencyKey: 'idem-7' },
    )
    expect(mocks.getN8nWorkflowBinding).toHaveBeenCalledWith({}, 7, { workspaceId: 2, tenantId: 3 })
    expect(mocks.updateN8nWorkflowRunStatus).toHaveBeenCalledWith(
      {}, 7, 'accepted', { workspaceId: 2, tenantId: 3 },
    )
    expect(mocks.createN8nTaskRun).toHaveBeenCalledWith({}, expect.objectContaining({
      taskId: 'task-7',
      idempotencyKey: 'idem-7',
      delivery: { mode: 'none' },
      maxAttempts: 3,
    }), { workspaceId: 2, tenantId: 3 })
    expect(mocks.markN8nTaskAccepted).toHaveBeenCalledWith({}, 'task-7')
    expect(await response.json()).toMatchObject({ taskId: 'task-7', result: { ok: true } })
  })

  it('preserves the OpenClaw source marker for agent-submitted tasks', async () => {
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-openclaw',
      source: 'openclaw',
      input: { prompt: '执行任务' },
    }))

    expect(response.status).toBe(202)
    expect(mocks.createN8nTaskRun).toHaveBeenCalledWith({}, expect.objectContaining({
      source: 'openclaw',
    }), { workspaceId: 2, tenantId: 3 })
    expect(mocks.triggerN8nWebhook).toHaveBeenCalledWith(
      'webhook/aiworker-task',
      expect.objectContaining({ source: 'openclaw' }),
      expect.any(Object),
    )
  })

  it('rejects direct session delivery for stateless video workers', async () => {
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-video-reply',
      input: { prompt: '分析视频' },
      delivery: { mode: 'reply', sessionKey: 'agent:main:video-test' },
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/不进入 OpenClaw 会话/) })
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('accepts an OpenClaw per-task route override from the registered model list', async () => {
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-routed',
      idempotencyKey: 'idem-routed',
      input: { prompt: '规划任务' },
      routing: {
        nodes: { planner: { routeId: 'cloud-planner', fallbackRouteIds: [] } },
      },
    }))

    expect(response.status).toBe(202)
    expect(mocks.createN8nTaskRun).toHaveBeenCalledWith({}, expect.objectContaining({
      routing: expect.objectContaining({
        taskRouting: {
          nodes: { planner: { routeId: 'cloud-planner', fallbackRouteIds: [] } },
        },
      }),
    }), { workspaceId: 2, tenantId: 3 })
    expect(mocks.triggerN8nWebhook).toHaveBeenCalledWith(
      'webhook/aiworker-task',
      expect.objectContaining({
        routing: expect.objectContaining({
          taskRouting: expect.objectContaining({ nodes: expect.any(Object) }),
        }),
      }),
      expect.any(Object),
    )
  })

  it('rejects a model-node callback URL outside the loopback interface', async () => {
    process.env.AIWORKER_N8N_NODE_CALLBACK_URL = 'https://example.test/api/n8n/node-execute'
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-unsafe-callback',
      input: { prompt: 'test' },
    }))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/本机回环/) })
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('rejects a media-node callback URL outside the loopback interface', async () => {
    process.env.AIWORKER_N8N_MEDIA_CALLBACK_URL = 'https://example.test/api/n8n/media-execute'
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-unsafe-media-callback',
      input: { prompt: 'test' },
    }))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/本机回环/) })
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('returns the existing task without triggering n8n for a duplicate idempotency key', async () => {
    mocks.createN8nTaskRun.mockReturnValue({
      created: false,
      run: { taskId: 'original-task', status: 'running', output: null },
    })

    const response = await POST(request({
      bindingId: 7,
      taskId: 'duplicate-task',
      idempotencyKey: 'same-key',
      input: { prompt: 'test' },
    }))

    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({
      taskId: 'original-task',
      duplicate: true,
      status: 'running',
    })
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
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
    expect(mocks.failN8nTaskRun).toHaveBeenCalledWith({}, 'task-failed', 'n8n unavailable')
  })
})
