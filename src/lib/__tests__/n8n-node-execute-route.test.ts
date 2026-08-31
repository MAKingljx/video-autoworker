import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyN8nWebhookSecret: vi.fn(),
  getDatabase: vi.fn(),
  resolveN8nNodeRoute: vi.fn(),
  executeN8nModelRoute: vi.fn(),
  createAndClaimN8nChildRunFromParent: vi.fn(),
  getN8nTaskRunByTaskId: vi.fn(),
  isScopedN8nParentExecutionOwner: vi.fn(),
  completeN8nChildExecution: vi.fn(),
  completeN8nTaskRun: vi.fn(),
  failN8nChildExecution: vi.fn(),
  failN8nTaskRun: vi.fn(),
  checkN8nCallbackAdmission: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n', () => ({ verifyN8nWebhookSecret: mocks.verifyN8nWebhookSecret }))
vi.mock('@/lib/n8n-runtime-affinity', () => ({
  checkN8nCallbackAdmission: mocks.checkN8nCallbackAdmission,
  resolveN8nRuntimeInstanceId: () => 'a'.repeat(64),
}))
vi.mock('@/lib/n8n-model-routing', () => ({ resolveN8nNodeRoute: mocks.resolveN8nNodeRoute }))
vi.mock('@/lib/n8n-model-execution', () => ({
  executeN8nModelRoute: mocks.executeN8nModelRoute,
  n8nModelExecutionError: (error: unknown) => error instanceof Error ? error.message : String(error),
}))
vi.mock('@/lib/n8n-task-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-task-runs')>()
  return {
    ...actual,
    createAndClaimN8nChildRunFromParent: mocks.createAndClaimN8nChildRunFromParent,
    getN8nTaskRunByTaskId: mocks.getN8nTaskRunByTaskId,
    isScopedN8nParentExecutionOwner: mocks.isScopedN8nParentExecutionOwner,
    completeN8nChildExecution: mocks.completeN8nChildExecution,
    completeN8nTaskRun: mocks.completeN8nTaskRun,
    failN8nChildExecution: mocks.failN8nChildExecution,
    pollN8nChildExecutionResult: (_attempt: unknown, initial: unknown) => Promise.resolve(initial),
    runWithN8nChildExecutionHeartbeat: (_db: unknown, _lease: unknown, _scope: unknown, operation: () => Promise<unknown>) => operation(),
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
    body: JSON.stringify({ executionOwner: 'n8n-execution:wf-1:123', ...body }),
  })
}

describe('n8n model node execution route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyN8nWebhookSecret.mockReturnValue(true)
    mocks.getDatabase.mockReturnValue({})
    mocks.getN8nTaskRunByTaskId.mockReturnValue(parent)
    mocks.isScopedN8nParentExecutionOwner.mockReturnValue(true)
    mocks.checkN8nCallbackAdmission.mockReturnValue({ allowed: true, mode: 'legacy' })
    mocks.resolveN8nNodeRoute.mockReturnValue({ route, instruction: '规划任务', candidates: ['local-qwen'], source: 'binding' })
    mocks.createAndClaimN8nChildRunFromParent.mockImplementation((_db, input) => ({
      outcome: 'claimed',
      parent,
      child: { ...parent, taskId: input.childTaskId, idempotencyKey: input.childIdempotencyKey, status: 'running', attemptCount: 1 },
      lease: { taskId: input.childTaskId, ownerInstanceId: 'a'.repeat(64), leaseToken: 'b'.repeat(64), leaseExpiresAt: 9999999999, revision: 1 },
    }))
    mocks.completeN8nChildExecution.mockReturnValue({ settled: true })
    mocks.failN8nChildExecution.mockReturnValue({ settled: true })
    mocks.executeN8nModelRoute.mockResolvedValue({ text: '节点完成', routeId: 'local-qwen' })
  })

  it('rejects a callback without the shared secret', async () => {
    mocks.verifyN8nWebhookSecret.mockReturnValue(false)
    const response = await POST(request({ taskId: 'parent-1', idempotencyKey: 'idem-1', nodeKey: 'planner', input: {} }, 'wrong'))
    expect(response.status).toBe(401)
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })

  it.each(['succeeded', 'failed', 'cancelled'])('rejects a late callback after the parent is %s', async status => {
    mocks.getN8nTaskRunByTaskId.mockReturnValue({ ...parent, status })

    const response = await POST(request({
      taskId: 'parent-1', idempotencyKey: 'idem-1', nodeKey: 'planner', input: {},
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ taskId: parent.taskId, status })
    expect(mocks.checkN8nCallbackAdmission).toHaveBeenCalledTimes(1)
    expect(mocks.createAndClaimN8nChildRunFromParent).not.toHaveBeenCalled()
    expect(mocks.executeN8nModelRoute).not.toHaveBeenCalled()
  })

  it('rejects a different execution owner before reading or creating a child', async () => {
    mocks.isScopedN8nParentExecutionOwner.mockReturnValue(false)

    const response = await POST(request({
      taskId: 'parent-1', idempotencyKey: 'idem-1', nodeKey: 'reviewer', input: {}, finalizeParent: true,
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: 'n8n execution 不拥有该父任务' })
    expect(mocks.getN8nTaskRunByTaskId).toHaveBeenCalledTimes(1)
    expect(mocks.createAndClaimN8nChildRunFromParent).not.toHaveBeenCalled()
    expect(mocks.executeN8nModelRoute).not.toHaveBeenCalled()
  })

  it('returns a deterministic cached reviewer result only to the owning execution', async () => {
    const succeededParent = { ...parent, status: 'succeeded', output: { text: 'final parent result' } }
    const expectedChildTaskId = 'node:parent-1:reviewer'
    mocks.getN8nTaskRunByTaskId.mockImplementation((_db, taskId: string) => (
      taskId === parent.taskId
        ? succeededParent
        : taskId === expectedChildTaskId
          ? {
              ...parent,
              taskId: expectedChildTaskId,
              idempotencyKey: 'node-idem:idem-1:reviewer',
              source: 'n8n-node',
              status: 'succeeded',
              output: { text: 'final reviewer result' },
            }
          : null
    ))

    const response = await POST(request({
      taskId: 'parent-1', idempotencyKey: 'idem-1', nodeKey: 'reviewer', input: {}, finalizeParent: true,
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      nodeTaskId: expectedChildTaskId,
      nodeKey: 'reviewer',
      status: 'succeeded',
      cached: true,
      output: succeededParent.output,
    })
    expect(mocks.getN8nTaskRunByTaskId).toHaveBeenCalledTimes(2)
    expect(mocks.createAndClaimN8nChildRunFromParent).not.toHaveBeenCalled()
    expect(mocks.executeN8nModelRoute).not.toHaveBeenCalled()
  })

  it.each([
    ['planner', false],
    ['executor', false],
    ['planner', true],
  ])('does not read cached output from non-final node %s (finalize=%s)', async (nodeKey, finalizeParent) => {
    mocks.getN8nTaskRunByTaskId.mockReturnValue({ ...parent, status: 'succeeded', output: { text: 'final' } })

    const response = await POST(request({
      taskId: 'parent-1', idempotencyKey: 'idem-1', nodeKey, input: {}, finalizeParent,
    }))

    expect(response.status).toBe(409)
    expect(mocks.getN8nTaskRunByTaskId).toHaveBeenCalledTimes(1)
    expect(mocks.createAndClaimN8nChildRunFromParent).not.toHaveBeenCalled()
  })

  it.each([
    ['idempotency', { idempotencyKey: 'node-idem:other' }],
    ['binding', { bindingId: 99 }],
    ['workspace', { workspaceId: 99 }],
    ['tenant', { tenantId: 99 }],
    ['source', { source: 'n8n-media-node' }],
    ['status', { status: 'failed' }],
    ['output', { output: null }],
  ])('rejects a terminal reviewer whose deterministic child has mismatched %s', async (_label, override) => {
    mocks.getN8nTaskRunByTaskId.mockImplementation((_db, taskId: string) => (
      taskId === parent.taskId
        ? { ...parent, status: 'succeeded', output: { text: 'final' } }
        : {
            ...parent,
            taskId: 'node:parent-1:reviewer',
            idempotencyKey: 'node-idem:idem-1:reviewer',
            source: 'n8n-node',
            status: 'succeeded',
            output: { text: 'reviewed' },
            ...override,
          }
    ))

    const response = await POST(request({
      taskId: 'parent-1', idempotencyKey: 'idem-1', nodeKey: 'reviewer', input: {}, finalizeParent: true,
    }))

    expect(response.status).toBe(409)
    expect(mocks.createAndClaimN8nChildRunFromParent).not.toHaveBeenCalled()
    expect(mocks.executeN8nModelRoute).not.toHaveBeenCalled()
  })

  it('rejects a callback after its release is frozen', async () => {
    mocks.checkN8nCallbackAdmission.mockReturnValue({
      allowed: false,
      code: 'callback_frozen',
      error: '当前运行版本已冻结回调接入',
    })

    const response = await POST(request({
      taskId: 'parent-1', idempotencyKey: 'idem-1', nodeKey: 'planner', input: {},
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'callback_frozen' })
    expect(mocks.createAndClaimN8nChildRunFromParent).not.toHaveBeenCalled()
    expect(mocks.executeN8nModelRoute).not.toHaveBeenCalled()
  })

  it.each(['planner', 'executor', 'custom-node'])(
    'rejects running non-reviewer node %s before it can finalize the parent',
    async nodeKey => {
      const response = await POST(request({
        taskId: 'parent-1', idempotencyKey: 'idem-1', nodeKey, input: {}, finalizeParent: true,
      }))

      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({
        taskId: parent.taskId,
        error: '只有受控 reviewer 节点可以完成父任务',
      })
      expect(mocks.resolveN8nNodeRoute).not.toHaveBeenCalled()
      expect(mocks.createAndClaimN8nChildRunFromParent).not.toHaveBeenCalled()
      expect(mocks.completeN8nTaskRun).not.toHaveBeenCalled()
      expect(mocks.executeN8nModelRoute).not.toHaveBeenCalled()
    },
  )

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
    expect(mocks.createAndClaimN8nChildRunFromParent).toHaveBeenCalledWith({}, expect.objectContaining({
      source: 'n8n-node',
      maxAttempts: 2,
      delivery: { mode: 'none' },
      executionOwner: 'n8n-execution:wf-1:123',
    }), { workspaceId: 2, tenantId: 3 })
    expect(mocks.executeN8nModelRoute).toHaveBeenCalledWith(route, expect.objectContaining({
      nodeKey: 'planner',
      instruction: '规划任务',
    }))
    expect(mocks.completeN8nChildExecution).toHaveBeenCalledTimes(1)
  })

  it('never persists or returns OpenClaw stderr from a failed model node', async () => {
    const error = Object.assign(new Error('Command failed with private arguments'), {
      stderr: 'failed /Users/operator/private/prompt.txt https://private.example token=secret',
      stdout: 'session cli_a1b2c3d4e5f6g7h8',
    })
    mocks.executeN8nModelRoute.mockRejectedValue(error)

    const response = await POST(request({
      taskId: 'parent-1', idempotencyKey: 'idem-1', nodeKey: 'planner', input: {},
    }))
    const body = await response.json()

    expect(response.status).toBe(502)
    expect(body).toMatchObject({
      code: 'N8N_MODEL_EXECUTION_FAILED',
      error: '模型节点执行失败',
    })
    expect(JSON.stringify(body)).not.toContain('/Users/operator')
    expect(JSON.stringify(body)).not.toContain('private.example')
    expect(mocks.failN8nChildExecution).toHaveBeenCalledWith(
      {},
      expect.any(Object),
      '[N8N_MODEL_EXECUTION_FAILED] 模型节点执行失败',
      { workspaceId: 2, tenantId: 3 },
    )
    expect(mocks.failN8nTaskRun).toHaveBeenCalledWith(
      {}, parent.taskId, '[N8N_MODEL_EXECUTION_FAILED] 模型节点执行失败',
    )
  })

  it('recovers a lost success response by returning the cached node without executing twice', async () => {
    const body = {
      taskId: 'parent-1', idempotencyKey: 'idem-1', nodeKey: 'planner', input: { task: '完成任务' },
    }
    const first = await POST(request(body))
    expect(first.status).toBe(200)

    mocks.createAndClaimN8nChildRunFromParent.mockImplementation((_db, input) => ({
      outcome: 'succeeded',
      parent,
      child: {
        ...parent,
        taskId: input.childTaskId,
        status: 'succeeded',
        output: { text: '节点完成', routeId: 'local-qwen' },
      },
      lease: null,
    }))
    const replay = await POST(request(body))

    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ cached: true, status: 'succeeded' })
    expect(mocks.executeN8nModelRoute).toHaveBeenCalledTimes(1)
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
    expect(mocks.completeN8nChildExecution).toHaveBeenCalledWith(
      {}, expect.any(Object), expect.any(Object), { workspaceId: 2, tenantId: 3 },
      { parentTaskId: 'parent-1' },
    )
  })

  it('resumes a child claimed by a replacement runtime and returns its persisted output', async () => {
    mocks.createAndClaimN8nChildRunFromParent.mockImplementation((_db, input) => ({
      outcome: 'claimed',
      parent: { ...parent, status: 'running' },
      child: { ...parent, taskId: input.childTaskId, status: 'running', attemptCount: 2, maxAttempts: 2 },
      lease: {
        taskId: input.childTaskId,
        ownerInstanceId: 'a'.repeat(64),
        leaseToken: 'd'.repeat(64),
        leaseExpiresAt: 9999999999,
        revision: 2,
      },
    }))
    mocks.executeN8nModelRoute.mockResolvedValue({ text: 'replacement-output' })

    const response = await POST(request({
      taskId: 'parent-1', idempotencyKey: 'idem-1', nodeKey: 'planner', input: {},
    }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      status: 'succeeded',
      output: { text: 'replacement-output' },
    })
    expect(mocks.completeN8nChildExecution).toHaveBeenCalledWith(
      {}, expect.objectContaining({ revision: 2 }), { text: 'replacement-output' },
      { workspaceId: 2, tenantId: 3 }, { parentTaskId: undefined },
    )
  })

  it('does not execute a same-instance duplicate that already owns the child lease', async () => {
    mocks.createAndClaimN8nChildRunFromParent.mockImplementation((_db, input) => ({
      outcome: 'running',
      parent,
      child: { ...parent, taskId: input.childTaskId, status: 'running', attemptCount: 1 },
      lease: {
        taskId: input.childTaskId,
        ownerInstanceId: 'a'.repeat(64),
        leaseToken: 'b'.repeat(64),
        leaseExpiresAt: 9999999999,
        revision: 1,
      },
    }))

    const response = await POST(request({
      taskId: 'parent-1', idempotencyKey: 'idem-1', nodeKey: 'planner', input: {},
    }))

    expect(response.status).toBe(503)
    expect(response.headers.get('Retry-After')).toBe('5')
    expect(mocks.executeN8nModelRoute).not.toHaveBeenCalled()
  })
})
