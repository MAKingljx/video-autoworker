import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireN8nRole: vi.fn(),
  isN8nWebhookSecretConfigured: vi.fn(),
  isN8nWebhookDispatchError: vi.fn(),
  validateN8nWebhookDispatchConfiguration: vi.fn(),
  triggerN8nWebhook: vi.fn(),
  getDatabase: vi.fn(),
  logAuditEvent: vi.fn(),
  getN8nWorkflowBinding: vi.fn(),
  updateN8nWorkflowRunStatus: vi.fn(),
  createN8nTaskRun: vi.fn(),
  acquireDispatchOwnership: vi.fn(),
  settleDispatchSuccess: vi.fn(),
  settleDispatchFailure: vi.fn(),
  mutationLimiter: vi.fn(),
  resolveDirectorWorkBinding: vi.fn(),
  getN8nTaskRunByIdempotencyKey: vi.fn(),
  getN8nIntakeControl: vi.fn(),
  acquireSharedDeploymentLock: vi.fn(),
  releaseSharedDeploymentLock: vi.fn(),
}))

vi.mock('@/lib/n8n', () => ({
  requireN8nRole: mocks.requireN8nRole,
  isN8nWebhookSecretConfigured: mocks.isN8nWebhookSecretConfigured,
  isN8nWebhookDispatchError: mocks.isN8nWebhookDispatchError,
  validateN8nWebhookDispatchConfiguration: mocks.validateN8nWebhookDispatchConfiguration,
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

vi.mock('@/lib/n8n-intake-control', () => ({
  createN8nTaskRunWithIntakeGate: mocks.createN8nTaskRun,
  getN8nIntakeControl: mocks.getN8nIntakeControl,
}))

vi.mock('@/lib/shared-deployment-lock', () => ({
  acquireSharedDeploymentLock: mocks.acquireSharedDeploymentLock,
}))

vi.mock('@/lib/n8n-task-dispatch', () => ({
  acquireN8nTaskDispatchOwnership: mocks.acquireDispatchOwnership,
  settleN8nTaskDispatchSuccess: mocks.settleDispatchSuccess,
  settleN8nTaskDispatchFailure: mocks.settleDispatchFailure,
}))

vi.mock('@/lib/rate-limit', () => ({
  mutationLimiter: mocks.mutationLimiter,
}))

vi.mock('@/lib/n8n-task-runs', async importOriginal => {
  const actual = await importOriginal<typeof import('@/lib/n8n-task-runs')>()
  return {
    ...actual,
    getN8nTaskRunByIdempotencyKey: mocks.getN8nTaskRunByIdempotencyKey,
  }
})

vi.mock('@/lib/director-evidence-outbox', () => ({
  resolveDirectorWorkBinding: mocks.resolveDirectorWorkBinding,
  directorWorkQueryDigest: (value: unknown) => (
    value === '测试作品' ? 'a'.repeat(64) : 'b'.repeat(64)
  ),
  directorEvidenceBindingFromInput: (input: Record<string, any> | undefined) => (
    input?.directorEvidence || null
  ),
  sameDirectorEvidenceBinding: (left: Record<string, any> | undefined, right: Record<string, any> | undefined) => (
    (left?.directorEvidence?.workId || null) === (right?.directorEvidence?.workId || null)
    && (left?.directorEvidence?.queryDigest || null) === (right?.directorEvidence?.queryDigest || null)
  ),
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
    delete process.env.AIWORKER_N8N_CLAIM_CALLBACK_URL
    delete process.env.AIWORKER_SLOT
    delete process.env.AIWORKER_RELEASE_ID
    process.env.PORT = '3017'
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
    mocks.isN8nWebhookSecretConfigured.mockReturnValue(true)
    mocks.validateN8nWebhookDispatchConfiguration.mockReturnValue(undefined)
    mocks.isN8nWebhookDispatchError.mockImplementation(error => (
      error instanceof Error
      && ['rejected', 'outcome_unknown'].includes(
        String((error as Error & { outcome?: unknown }).outcome || ''),
      )
    ))
    mocks.getDatabase.mockReturnValue({})
    mocks.getN8nWorkflowBinding.mockReturnValue(binding)
    mocks.getN8nTaskRunByIdempotencyKey.mockReturnValue(null)
    mocks.getN8nIntakeControl.mockReturnValue({ accepting: true })
    mocks.releaseSharedDeploymentLock.mockReturnValue(undefined)
    mocks.acquireSharedDeploymentLock.mockResolvedValue({
      acquired: true,
      lease: {
        path: '/private/run/.deployment.lock',
        release: mocks.releaseSharedDeploymentLock,
      },
    })
    mocks.resolveDirectorWorkBinding.mockResolvedValue({
      authority: 'director-brain-resolve-work-v1',
      workId: 'WORK-001',
      queryDigest: 'a'.repeat(64),
    })
    mocks.triggerN8nWebhook.mockResolvedValue({
      ok: true,
      statusCode: 202,
      data: { accepted: true },
      latencyMs: 12,
    })
    mocks.createN8nTaskRun.mockReturnValue({
      outcome: 'created',
      run: { taskId: 'task-7', status: 'queued', output: null },
      control: { accepting: true },
    })
    mocks.acquireDispatchOwnership.mockReturnValue({
      outcome: 'acquired',
      token: 'a'.repeat(64),
      leaseExpiresAt: 180,
      revision: 1,
      run: { taskId: 'task-7', status: 'queued' },
    })
    mocks.settleDispatchSuccess.mockImplementation((_db, taskId) => ({
      outcome: 'accepted',
      run: { taskId, status: 'accepted', output: null },
    }))
    mocks.settleDispatchFailure.mockImplementation((_db, taskId, _token, error) => ({
      outcome: 'failed',
      run: { taskId, status: 'failed', error, output: null },
    }))
  })

  it('sends a stable routing envelope to n8n without the reserved binding property', async () => {
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-7',
      idempotencyKey: 'idem-7',
      input: { prompt: '分析视频', materialId: 'MATERIAL-EXISTING-001' },
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
          claimCallbackUrl: 'http://127.0.0.1:3017/api/n8n/claim',
          claimScope: { workspaceId: 2, tenantId: 3 },
          config: { queue: 'heavy-model' },
          memoryMode: 'none',
        },
        input: { prompt: '分析视频', materialId: 'MATERIAL-EXISTING-001' },
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
    expect(mocks.settleDispatchSuccess).toHaveBeenCalledWith(
      {}, 'task-7', 'a'.repeat(64), { workspaceId: 2, tenantId: 3 },
    )
    expect(await response.json()).toMatchObject({ taskId: 'task-7', result: { ok: true } })
  })

  it('persists the current slot and release owner in every new task routing envelope', async () => {
    process.env.AIWORKER_SLOT = 'green'
    process.env.AIWORKER_RELEASE_ID = 'release-20260831'
    process.env.PORT = '3417'

    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-release-owned',
      idempotencyKey: 'idem-release-owned',
      input: { prompt: '分析视频' },
    }))

    expect(response.status).toBe(202)
    const affinity = {
      callbackProtocol: 'slot-v1',
      runtimeSlot: 'green',
      runtimeReleaseId: 'release-20260831',
    }
    expect(mocks.createN8nTaskRun).toHaveBeenCalledWith({}, expect.objectContaining({
      routing: expect.objectContaining(affinity),
    }), { workspaceId: 2, tenantId: 3 })
    expect(mocks.triggerN8nWebhook).toHaveBeenCalledWith(
      'webhook/aiworker-task',
      expect.objectContaining({ routing: expect.objectContaining(affinity) }),
      expect.any(Object),
    )
  })

  it('resolves an optional work name and persists only the trusted stable binding', async () => {
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-director-bound',
      idempotencyKey: 'idem-director-bound',
      directorWork: '测试作品',
      input: { prompt: '分析视频', materialId: 'MATERIAL-DIRECTOR-001' },
    }))

    expect(response.status).toBe(202)
    expect(mocks.resolveDirectorWorkBinding).toHaveBeenCalledWith('测试作品')
    const trustedInput = {
      prompt: '分析视频',
      materialId: 'MATERIAL-DIRECTOR-001',
      directorEvidence: {
        authority: 'director-brain-resolve-work-v1',
        workId: 'WORK-001',
        queryDigest: 'a'.repeat(64),
      },
    }
    expect(mocks.createN8nTaskRun).toHaveBeenCalledWith({}, expect.objectContaining({
      taskInput: trustedInput,
    }), { workspaceId: 2, tenantId: 3 })
    expect(mocks.triggerN8nWebhook).toHaveBeenCalledWith(
      'webhook/aiworker-task',
      expect.objectContaining({ input: trustedInput }),
      expect.any(Object),
    )
    expect(mocks.acquireSharedDeploymentLock).toHaveBeenCalledOnce()
    expect(mocks.getN8nIntakeControl).toHaveBeenCalledOnce()
    expect(mocks.releaseSharedDeploymentLock).toHaveBeenCalledOnce()
    expect(mocks.acquireSharedDeploymentLock.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resolveDirectorWorkBinding.mock.invocationCallOrder[0])
    expect(mocks.resolveDirectorWorkBinding.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createN8nTaskRun.mock.invocationCallOrder[0])
    expect(mocks.createN8nTaskRun.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.releaseSharedDeploymentLock.mock.invocationCallOrder[0])
  })

  it('requires a stable material ID before acquiring the director deployment lock', async () => {
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-director-no-material',
      directorWork: '测试作品',
      input: { prompt: '分析视频' },
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      code: 'DIRECTOR_MATERIAL_ID_REQUIRED',
      error: '使用导演脑作品绑定时必须提供有效的 input.materialId',
    })
    expect(mocks.acquireSharedDeploymentLock).not.toHaveBeenCalled()
    expect(mocks.resolveDirectorWorkBinding).not.toHaveBeenCalled()
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
  })

  it('does not resolve or admit a new director task while intake is paused', async () => {
    mocks.getN8nIntakeControl.mockReturnValue({ accepting: false })
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-director-paused',
      directorWork: '测试作品',
      input: { prompt: '分析视频', materialId: 'MATERIAL-DIRECTOR-PAUSED' },
    }))

    expect(response.status).toBe(423)
    expect(await response.json()).toMatchObject({ code: 'N8N_INTAKE_DRAINING' })
    expect(mocks.acquireSharedDeploymentLock).toHaveBeenCalledOnce()
    expect(mocks.releaseSharedDeploymentLock).toHaveBeenCalledOnce()
    expect(mocks.resolveDirectorWorkBinding).not.toHaveBeenCalled()
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
  })

  it('does not resolve or admit a new director task when the shared lock is busy', async () => {
    mocks.acquireSharedDeploymentLock.mockResolvedValue({ acquired: false, reason: 'busy' })
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-director-lock-busy',
      directorWork: '测试作品',
      input: { prompt: '分析视频', materialId: 'MATERIAL-DIRECTOR-BUSY' },
    }))

    expect(response.status).toBe(423)
    expect(await response.json()).toMatchObject({ code: 'DEPLOYMENT_IN_PROGRESS' })
    expect(mocks.getN8nIntakeControl).not.toHaveBeenCalled()
    expect(mocks.resolveDirectorWorkBinding).not.toHaveBeenCalled()
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.releaseSharedDeploymentLock).not.toHaveBeenCalled()
  })

  it('maps a shared-lock acquisition failure without misreporting Feishu resolution', async () => {
    mocks.acquireSharedDeploymentLock.mockRejectedValue(new Error('run directory unsafe'))
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-director-lock-unavailable',
      directorWork: '测试作品',
      input: { prompt: '分析视频', materialId: 'MATERIAL-DIRECTOR-UNAVAILABLE' },
    }))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'DEPLOYMENT_LOCK_UNAVAILABLE' })
    expect(mocks.resolveDirectorWorkBinding).not.toHaveBeenCalled()
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
  })

  it('returns the durable task identity when lock release fails after admission', async () => {
    mocks.createN8nTaskRun.mockReturnValue({
      outcome: 'created',
      run: { taskId: 'task-director-release-failed', status: 'queued', output: null },
      control: { accepting: true },
    })
    mocks.releaseSharedDeploymentLock.mockImplementation(() => {
      throw new Error('owner record changed')
    })
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-director-release-failed',
      directorWork: '测试作品',
      input: { prompt: '分析视频', materialId: 'MATERIAL-DIRECTOR-RELEASE' },
    }))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      code: 'DEPLOYMENT_LOCK_RELEASE_FAILED',
      taskId: 'task-director-release-failed',
      status: 'queued',
      retryable: true,
    })
    expect(mocks.createN8nTaskRun).toHaveBeenCalledOnce()
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('fails before task creation when a work name cannot resolve uniquely', async () => {
    mocks.resolveDirectorWorkBinding.mockRejectedValueOnce(new Error('director_work_not_found'))
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-director-missing',
      directorWork: '不存在的作品',
      input: { prompt: '分析视频', materialId: 'MATERIAL-DIRECTOR-404' },
    }))
    expect(response.status).toBe(404)
    expect(mocks.releaseSharedDeploymentLock).toHaveBeenCalledOnce()
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('replays an existing exact work binding without depending on Feishu resolution', async () => {
    const existing = {
      taskId: 'task-director-existing',
      idempotencyKey: 'idem-director-existing',
      bindingId: 7,
      status: 'succeeded',
      output: { summary: '完成' },
      input: {
        prompt: '分析视频',
        materialId: 'MATERIAL-DIRECTOR-REPLAY',
        directorEvidence: {
          authority: 'director-brain-resolve-work-v1',
          workId: 'WORK-001',
          queryDigest: 'a'.repeat(64),
        },
      },
    }
    mocks.getN8nTaskRunByIdempotencyKey.mockReturnValueOnce(existing)
    mocks.createN8nTaskRun.mockReturnValueOnce({
      outcome: 'existing',
      run: existing,
      control: { accepting: false },
    })
    const response = await POST(request({
      bindingId: 7,
      taskId: existing.taskId,
      idempotencyKey: existing.idempotencyKey,
      directorWork: '测试作品',
      input: { prompt: '分析视频', materialId: 'MATERIAL-DIRECTOR-REPLAY' },
    }))
    expect(response.status).toBe(200)
    expect(mocks.resolveDirectorWorkBinding).not.toHaveBeenCalled()
    expect(mocks.acquireSharedDeploymentLock).not.toHaveBeenCalled()
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('rejects a terminal director replay when its stable material ID changes', async () => {
    mocks.getN8nTaskRunByIdempotencyKey.mockReturnValueOnce({
      taskId: 'task-director-material',
      idempotencyKey: 'idem-director-material',
      bindingId: 7,
      status: 'succeeded',
      output: { summary: '完成' },
      input: {
        materialId: 'MATERIAL-DIRECTOR-ORIGINAL',
        directorEvidence: {
          authority: 'director-brain-resolve-work-v1',
          workId: 'WORK-001',
          queryDigest: 'a'.repeat(64),
        },
      },
    })
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-director-material',
      idempotencyKey: 'idem-director-material',
      directorWork: '测试作品',
      input: { prompt: '分析视频', materialId: 'MATERIAL-DIRECTOR-CHANGED' },
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'DIRECTOR_WORK_BINDING_MISMATCH' })
    expect(mocks.acquireSharedDeploymentLock).not.toHaveBeenCalled()
    expect(mocks.resolveDirectorWorkBinding).not.toHaveBeenCalled()
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('rejects a director replay when the same idempotency key names another task', async () => {
    mocks.getN8nTaskRunByIdempotencyKey.mockReturnValueOnce({
      taskId: 'task-director-original',
      idempotencyKey: 'idem-director-identity',
      bindingId: 7,
      status: 'succeeded',
      output: { summary: '完成' },
      input: {
        materialId: 'MATERIAL-DIRECTOR-IDENTITY',
        directorEvidence: {
          authority: 'director-brain-resolve-work-v1',
          workId: 'WORK-001',
          queryDigest: 'a'.repeat(64),
        },
      },
    })
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-director-changed',
      idempotencyKey: 'idem-director-identity',
      directorWork: '测试作品',
      input: { prompt: '分析视频', materialId: 'MATERIAL-DIRECTOR-IDENTITY' },
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'DIRECTOR_WORK_BINDING_MISMATCH' })
    expect(mocks.acquireSharedDeploymentLock).not.toHaveBeenCalled()
    expect(mocks.resolveDirectorWorkBinding).not.toHaveBeenCalled()
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('rejects an existing idempotency row when the work query digest changes', async () => {
    mocks.getN8nTaskRunByIdempotencyKey.mockReturnValueOnce({
      taskId: 'task-director-existing',
      idempotencyKey: 'idem-director-existing',
      bindingId: 7,
      input: {
        materialId: 'MATERIAL-DIRECTOR-EXISTING',
        directorEvidence: {
          authority: 'director-brain-resolve-work-v1',
          workId: 'WORK-001',
          queryDigest: 'a'.repeat(64),
        },
      },
    })
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-director-existing',
      idempotencyKey: 'idem-director-existing',
      directorWork: '另一作品',
      input: { prompt: '分析视频', materialId: 'MATERIAL-DIRECTOR-EXISTING' },
    }))
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'DIRECTOR_WORK_BINDING_MISMATCH' })
    expect(mocks.resolveDirectorWorkBinding).not.toHaveBeenCalled()
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
  })

  it('rejects an idempotent replay that resolves to a different work', async () => {
    mocks.createN8nTaskRun.mockReturnValueOnce({
      outcome: 'existing',
      run: {
        taskId: 'task-director-conflict',
        idempotencyKey: 'task-director-conflict',
        bindingId: 7,
        status: 'succeeded',
        output: {},
        input: {
          materialId: 'MATERIAL-DIRECTOR-CONFLICT',
          directorEvidence: { workId: 'WORK-OTHER' },
        },
      },
      control: { accepting: true },
    })
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-director-conflict',
      directorWork: '测试作品',
      input: { prompt: '分析视频', materialId: 'MATERIAL-DIRECTOR-CONFLICT' },
    }))
    expect(response.status).toBe(409)
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('rejects caller-injected stable director evidence', async () => {
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-director-injected',
      input: { prompt: '分析视频', directorEvidence: { workId: 'WORK-EVIL' } },
    }))
    expect(response.status).toBe(400)
    expect(mocks.resolveDirectorWorkBinding).not.toHaveBeenCalled()
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
  })

  it('rejects an invalid optional material ID before creating the task', async () => {
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-invalid-material',
      input: { prompt: '分析视频', materialId: '/private/source/video.mp4' },
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'materialId 无效' })
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('rejects an invalid director material ID before locking or resolving', async () => {
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-invalid-director-material',
      directorWork: '测试作品',
      input: { prompt: '分析视频', materialId: '/private/source/video.mp4' },
    }))

    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: 'materialId 无效' })
    expect(mocks.acquireSharedDeploymentLock).not.toHaveBeenCalled()
    expect(mocks.resolveDirectorWorkBinding).not.toHaveBeenCalled()
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
  })

  it('fails before creating a parent task when the shared webhook secret is missing', async () => {
    mocks.isN8nWebhookSecretConfigured.mockReturnValue(false)

    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-no-secret',
      input: { prompt: '分析视频' },
    }))

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/N8N_WEBHOOK_SECRET/) })
    expect(mocks.getDatabase).not.toHaveBeenCalled()
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
    expect(mocks.logAuditEvent).not.toHaveBeenCalled()
  })

  it('fails before creating a parent task when local webhook configuration is invalid', async () => {
    mocks.validateN8nWebhookDispatchConfiguration.mockImplementation(() => {
      throw new Error('n8n 地址只支持 http 或 https')
    })

    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-invalid-local-config',
      input: { prompt: '分析视频' },
    }))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: 'N8N_WEBHOOK_CONFIG_INVALID',
      error: 'n8n Webhook 本地配置无效',
    })
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.acquireDispatchOwnership).not.toHaveBeenCalled()
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
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

  it('rejects a new run while intake is draining without calling n8n', async () => {
    mocks.createN8nTaskRun.mockReturnValue({
      outcome: 'blocked',
      run: null,
      control: {
        mode: 'draining',
        accepting: false,
        revision: 4,
        reason: '准备发布新的服务版本',
        changedBy: { id: 1, name: 'local-desktop' },
        changedAt: 100,
        counts: { queued: 0, accepted: 1, running: 0, waiting: 1, active: 1 },
      },
    })

    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-blocked',
      input: { prompt: '执行任务' },
    }))

    expect(response.status).toBe(423)
    expect(await response.json()).toEqual({
      code: 'N8N_INTAKE_DRAINING',
      error: '系统正在维护，当前未接收新任务；已运行任务不受影响',
      retryable: true,
      retryAfterSeconds: 30,
    })
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
    expect(mocks.acquireDispatchOwnership).not.toHaveBeenCalled()
  })

  it('returns a clear duplicate response when another caller owns queued dispatch', async () => {
    mocks.createN8nTaskRun.mockReturnValue({
      outcome: 'existing',
      run: {
        taskId: 'queued-owned',
        idempotencyKey: 'queued-owned',
        bindingId: 7,
        status: 'queued',
      },
      control: { accepting: true },
    })
    mocks.acquireDispatchOwnership.mockReturnValue({
      outcome: 'in_progress',
      token: null,
      leaseExpiresAt: 200,
      revision: 1,
      run: { taskId: 'queued-owned', status: 'queued' },
    })

    const response = await POST(request({
      bindingId: 7,
      taskId: 'queued-owned',
      idempotencyKey: 'queued-owned',
      input: { prompt: 'test' },
    }))

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      taskId: 'queued-owned',
      duplicate: true,
      status: 'queued',
      dispatchInProgress: true,
    })
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
    expect(mocks.settleDispatchSuccess).not.toHaveBeenCalled()
    expect(mocks.settleDispatchFailure).not.toHaveBeenCalled()
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
    expect(await response.json()).toEqual({
      code: 'N8N_CALLBACK_CONFIG_INVALID',
      error: 'n8n 节点回调配置无效',
    })
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
    expect(await response.json()).toEqual({
      code: 'N8N_CALLBACK_CONFIG_INVALID',
      error: 'n8n 节点回调配置无效',
    })
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('rejects a parent-claim callback URL outside the loopback interface', async () => {
    process.env.AIWORKER_N8N_CLAIM_CALLBACK_URL = 'https://example.test/api/n8n/claim'
    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-unsafe-claim-callback',
      input: { prompt: 'test' },
    }))

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      code: 'N8N_CALLBACK_CONFIG_INVALID',
      error: 'n8n 节点回调配置无效',
    })
    expect(mocks.createN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('returns the existing task without triggering n8n for a duplicate idempotency key', async () => {
    mocks.createN8nTaskRun.mockReturnValue({
      outcome: 'existing',
      run: { taskId: 'original-task', status: 'running', output: null },
      control: { accepting: false },
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

  it('idempotently resumes an exact queued task created before webhook dispatch', async () => {
    mocks.createN8nTaskRun.mockReturnValue({
      outcome: 'existing',
      run: {
        taskId: 'queued-task',
        idempotencyKey: 'queued-key',
        bindingId: 7,
        status: 'queued',
        source: 'openclaw',
        requestedBy: 'local-desktop',
        routing: { persisted: true },
        input: { prompt: 'persisted', videoKey: '00000000-0000-4000-8000-000000000070.mp4' },
        delivery: { mode: 'none' },
        output: null,
      },
      control: { accepting: false },
    })

    const response = await POST(request({
      bindingId: 7,
      taskId: 'queued-task',
      idempotencyKey: 'queued-key',
      source: 'openclaw',
      input: { prompt: 'retry', videoKey: '00000000-0000-4000-8000-000000000070.mp4' },
    }))

    expect(response.status).toBe(202)
    expect(mocks.triggerN8nWebhook).toHaveBeenCalledWith(
      'webhook/aiworker-task',
      expect.objectContaining({
        taskId: 'queued-task',
        idempotencyKey: 'queued-key',
        routing: { persisted: true },
        input: { prompt: 'persisted', videoKey: '00000000-0000-4000-8000-000000000070.mp4' },
      }),
      { timeoutMs: 120_000, idempotencyKey: 'queued-key' },
    )
    expect(mocks.acquireDispatchOwnership).toHaveBeenCalledWith(
      {}, 'queued-task', { workspaceId: 2, tenantId: 3 },
    )
    expect(await response.json()).toMatchObject({
      taskId: 'queued-task',
      status: 'accepted',
      duplicate: true,
      resumedQueued: true,
    })
  })

  it.each(['failed', 'cancelled'])('returns 409 for an existing duplicate in %s state', async status => {
    mocks.createN8nTaskRun.mockReturnValue({
      outcome: 'existing',
      run: { taskId: 'terminal-task', status, output: null },
      control: { accepting: false },
    })

    const response = await POST(request({
      bindingId: 7,
      taskId: 'duplicate-terminal-task',
      idempotencyKey: 'terminal-key',
      input: { prompt: 'test' },
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ taskId: 'terminal-task', duplicate: true, status })
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('refuses disabled bindings before calling n8n', async () => {
    mocks.getN8nWorkflowBinding.mockReturnValue({ ...binding, enabled: false })

    const response = await POST(request({ bindingId: 7, input: { prompt: 'test' } }))

    expect(response.status).toBe(409)
    expect(mocks.triggerN8nWebhook).not.toHaveBeenCalled()
  })

  it('records a failed run when the n8n webhook rejects the request', async () => {
    const rejection = Object.assign(new Error(
      'n8n rejected: HTTP 404 /Users/operator/private https://private.example token=secret',
    ), {
      outcome: 'rejected' as const,
      statusCode: 404,
    })
    mocks.triggerN8nWebhook.mockRejectedValue(rejection)

    const response = await POST(request({ bindingId: 7, taskId: 'task-failed', input: {} }))

    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({
      taskId: 'task-failed',
      status: 'failed',
      code: 'N8N_WEBHOOK_REJECTED',
      error: 'n8n 拒绝了任务请求',
    })
    expect(mocks.updateN8nWorkflowRunStatus).toHaveBeenCalledWith(
      {}, 7, 'failed: [N8N_WEBHOOK_REJECTED] n8n 拒绝了任务请求', { workspaceId: 2, tenantId: 3 },
    )
    expect(mocks.settleDispatchFailure).toHaveBeenCalledWith(
      {}, 'task-failed', 'a'.repeat(64),
      '[N8N_WEBHOOK_REJECTED] n8n 拒绝了任务请求',
      { workspaceId: 2, tenantId: 3 },
    )
  })

  it('keeps the queued parent and dispatch lease when the webhook response is lost', async () => {
    mocks.triggerN8nWebhook.mockRejectedValue(new Error('response connection reset'))

    const response = await POST(request({ bindingId: 7, taskId: 'task-unknown', input: {} }))

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      code: 'N8N_DISPATCH_OUTCOME_UNKNOWN',
      taskId: 'task-unknown',
      status: 'queued',
      dispatchOutcome: 'outcome_unknown',
      retryable: true,
    })
    expect(mocks.settleDispatchFailure).not.toHaveBeenCalled()
    expect(mocks.settleDispatchSuccess).not.toHaveBeenCalled()
    expect(mocks.updateN8nWorkflowRunStatus).not.toHaveBeenCalled()
  })

  it('never converts a known webhook acceptance into failure when local settlement throws', async () => {
    mocks.settleDispatchSuccess.mockImplementation(() => {
      throw new Error('database busy')
    })

    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-settlement-error',
      input: {},
    }))

    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({
      code: 'N8N_DISPATCH_SETTLEMENT_FAILED',
      taskId: 'task-settlement-error',
    })
    expect(mocks.settleDispatchFailure).not.toHaveBeenCalled()
  })

  it('does not overwrite a newer owner when an expired dispatch reports failure late', async () => {
    mocks.triggerN8nWebhook.mockRejectedValue(Object.assign(new Error('late HTTP 404 rejection'), {
      outcome: 'rejected' as const,
      statusCode: 404,
    }))
    mocks.settleDispatchFailure.mockReturnValue({
      outcome: 'stale',
      run: { taskId: 'task-reowned', status: 'queued', output: null },
    })

    const response = await POST(request({
      bindingId: 7,
      taskId: 'task-reowned',
      input: {},
    }))

    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({
      taskId: 'task-reowned',
      duplicate: true,
      status: 'queued',
      dispatchInProgress: true,
    })
    expect(mocks.updateN8nWorkflowRunStatus).not.toHaveBeenCalled()
  })

  it('returns a completed parent when the workflow finishes before the response is lost', async () => {
    mocks.triggerN8nWebhook.mockRejectedValue(Object.assign(new Error('late HTTP 404 rejection'), {
      outcome: 'rejected' as const,
      statusCode: 404,
    }))
    mocks.settleDispatchFailure.mockReturnValue({
      outcome: 'terminal',
      run: { taskId: 'task-fast', status: 'succeeded', output: { summary: 'done' } },
    })

    const response = await POST(request({ bindingId: 7, taskId: 'task-fast', input: {} }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      taskId: 'task-fast',
      status: 'succeeded',
      output: { summary: 'done' },
    })
  })

  it.each(['failed', 'cancelled'])('returns 409 when an ambiguous response resolves to %s', async status => {
    mocks.triggerN8nWebhook.mockRejectedValue(Object.assign(new Error('late HTTP 404 rejection'), {
      outcome: 'rejected' as const,
      statusCode: 404,
    }))
    mocks.settleDispatchFailure.mockReturnValue({
      outcome: 'terminal',
      run: { taskId: 'task-terminal', status, error: 'already terminal', output: null },
    })

    const response = await POST(request({ bindingId: 7, taskId: 'task-terminal', input: {} }))

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      taskId: 'task-terminal',
      status,
      code: 'N8N_DISPATCH_FAILED',
      error: 'n8n 任务派发失败',
    })
  })
})
