import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyN8nWebhookSecret: vi.fn(),
  getDatabase: vi.fn(),
  resolveN8nNodeRoute: vi.fn(),
  executeN8nModelRoute: vi.fn(),
  createN8nTaskRun: vi.fn(),
  getN8nTaskRunByTaskId: vi.fn(),
  markN8nTaskAccepted: vi.fn(),
  claimN8nTaskRun: vi.fn(),
  completeN8nTaskRun: vi.fn(),
  failN8nTaskRun: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n', () => ({ verifyN8nWebhookSecret: mocks.verifyN8nWebhookSecret }))
vi.mock('@/lib/n8n-model-routing', () => ({ resolveN8nNodeRoute: mocks.resolveN8nNodeRoute }))
vi.mock('@/lib/n8n-model-execution', () => ({
  executeN8nModelRoute: mocks.executeN8nModelRoute,
  n8nModelExecutionError: (error: unknown) => error instanceof Error ? error.message : String(error),
}))
vi.mock('@/lib/n8n-task-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-task-runs')>()
  return {
    ...actual,
    createN8nTaskRun: mocks.createN8nTaskRun,
    getN8nTaskRunByTaskId: mocks.getN8nTaskRunByTaskId,
    markN8nTaskAccepted: mocks.markN8nTaskAccepted,
    claimN8nTaskRun: mocks.claimN8nTaskRun,
    completeN8nTaskRun: mocks.completeN8nTaskRun,
    failN8nTaskRun: mocks.failN8nTaskRun,
  }
})

import { POST } from '@/app/api/n8n/node-execute/route'

const parent = {
  id: 1,
  taskId: 'parent-1',
  idempotencyKey: 'idem-1',
  bindingId: 7,
  status: 'accepted',
  source: 'openclaw',
  requestedBy: 'local-desktop',
  routing: { model: 'qwen36-tools-local/default_model', timeoutSeconds: 120, config: {} },
  input: { prompt: '完成任务' },
  delivery: { mode: 'none' as const },
  output: null,
  error: null,
  attemptCount: 0,
  maxAttempts: 2,
  workspaceId: 2,
  tenantId: 3,
  createdAt: 1,
  acceptedAt: 1,
  startedAt: null,
  completedAt: null,
  updatedAt: 1,
}

const route = {
  id: 'local-qwen',
  label: '本地千问',
  description: '',
  location: 'local' as const,
  transport: 'openclaw' as const,
  model: 'qwen36-tools-local/default_model',
  profile: 'qwen-current',
  agentId: 'second-original',
  enabled: true,
  timeoutSeconds: 120,
  thinking: 'off',
  capabilities: ['text' as const],
  systemPrompt: '',
}

function request(body: Record<string, unknown>, secret = 'shared-secret') {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/node-execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AIWorker-Webhook-Secret': secret },
    body: JSON.stringify(body),
  })
}

describe('n8n model node execution route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyN8nWebhookSecret.mockReturnValue(true)
    mocks.getDatabase.mockReturnValue({})
    mocks.getN8nTaskRunByTaskId.mockReturnValue(parent)
    mocks.resolveN8nNodeRoute.mockReturnValue({ route, instruction: '规划任务', candidates: ['local-qwen'], source: 'binding' })
    mocks.createN8nTaskRun.mockImplementation((_db, input) => ({
      created: true,
      run: { ...parent, taskId: input.taskId, idempotencyKey: input.idempotencyKey, status: 'queued' },
    }))
    mocks.claimN8nTaskRun.mockImplementation((_db, taskId) => ({
      claimed: true,
      run: { ...parent, taskId, status: 'running', attemptCount: 1 },
    }))
    mocks.executeN8nModelRoute.mockResolvedValue({ text: '节点完成', routeId: 'local-qwen' })
  })

  it('rejects a callback without the shared secret', async () => {
    mocks.verifyN8nWebhookSecret.mockReturnValue(false)
    const response = await POST(request({ taskId: 'parent-1', idempotencyKey: 'idem-1', nodeKey: 'planner', input: {} }, 'wrong'))
    expect(response.status).toBe(401)
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })

  it('executes a saved route for one model node without finalizing the parent', async () => {
    const response = await POST(request({
      taskId: 'parent-1',
      idempotencyKey: 'idem-1',
      nodeKey: 'planner',
      input: { task: '完成任务' },
      finalizeParent: false,
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ nodeKey: 'planner', status: 'succeeded', route: { id: 'local-qwen' } })
    expect(mocks.createN8nTaskRun).toHaveBeenCalledWith({}, expect.objectContaining({
      source: 'n8n-node',
      maxAttempts: 1,
      delivery: { mode: 'none' },
    }), { workspaceId: 2, tenantId: 3 })
    expect(mocks.executeN8nModelRoute).toHaveBeenCalledWith(route, expect.objectContaining({
      nodeKey: 'planner',
      instruction: '规划任务',
    }))
    expect(mocks.completeN8nTaskRun).toHaveBeenCalledTimes(1)
  })

  it('uses the parent delivery and completes the parent from the final node', async () => {
    const deliveredParent = { ...parent, delivery: { mode: 'reply' as const, sessionKey: 'agent:second-original:telegram:direct:1' } }
    mocks.getN8nTaskRunByTaskId
      .mockReturnValueOnce(deliveredParent)
      .mockReturnValueOnce(deliveredParent)

    const response = await POST(request({
      taskId: 'parent-1',
      idempotencyKey: 'idem-1',
      nodeKey: 'reviewer',
      input: { result: '待审核' },
      finalizeParent: true,
    }))

    expect(response.status).toBe(200)
    expect(mocks.executeN8nModelRoute).toHaveBeenCalledWith(route, expect.objectContaining({
      delivery: deliveredParent.delivery,
      sessionKey: deliveredParent.delivery.sessionKey,
    }))
    expect(mocks.claimN8nTaskRun).toHaveBeenCalledWith({}, 'parent-1')
    expect(mocks.completeN8nTaskRun).toHaveBeenCalledTimes(2)
  })
})
