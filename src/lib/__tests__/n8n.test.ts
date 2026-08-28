import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkN8nHealth,
  getN8nRuntimeConfig,
  isN8nWebhookSecretConfigured,
  listN8nExecutions,
  listN8nRemoteWorkflows,
  normalizeN8nBaseUrl,
  normalizeN8nWebhookPath,
  triggerN8nWebhook,
  verifyN8nWebhookSecret,
} from '@/lib/n8n'
import {
  claimScopedN8nVideoTaskRun,
  claimN8nTaskRun,
  completeN8nFinalizeRun,
  completeN8nTaskRun,
  createN8nMediaChildRunFromParent,
  createN8nTaskRun,
  failN8nTaskRun,
  failScopedUnclaimedN8nTaskRun,
  getN8nTaskRunByIdempotencyKey,
  getN8nTaskRunByTaskId,
  getScopedN8nTaskRunByTaskId,
  listN8nTaskRuns,
  markN8nTaskAccepted,
  n8nTaskDeliverySchema,
  reconcileScopedN8nVideoTaskRun,
} from '@/lib/n8n-task-runs'
import {
  createN8nWorkflowBinding,
  deleteN8nWorkflowBinding,
  getN8nWorkflowBinding,
  listN8nWorkflowBindings,
  n8nWorkflowBindingInputSchema,
  updateN8nWorkflowBinding,
  updateN8nWorkflowRunStatus,
} from '@/lib/n8n-workflows'
import { runMigrations } from '@/lib/migrations'

const ENV_KEYS = [
  'N8N_BASE_URL',
  'N8N_API_KEY',
  'N8N_WEBHOOK_SECRET',
  'N8N_ALLOW_PRIVATE_REMOTE',
  'N8N_DEFAULT_WEBHOOK_PATH',
] as const

const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

beforeEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const key of ENV_KEYS) delete process.env[key]
  process.env.N8N_BASE_URL = 'http://127.0.0.1:5678'
})

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('n8n endpoint validation', () => {
  it('normalizes loopback URLs and removes credentials, query, and fragments', () => {
    expect(normalizeN8nBaseUrl('http://user:pass@localhost:5678/n8n/?debug=1#top'))
      .toBe('http://localhost:5678/n8n')
  })

  it('rejects non-loopback and non-http endpoints by default', () => {
    expect(() => normalizeN8nBaseUrl('http://10.0.0.9:5678')).toThrow(/回环地址/)
    expect(() => normalizeN8nBaseUrl('file:///tmp/n8n')).toThrow(/http 或 https/)
  })

  it('allows an explicitly configured private endpoint', () => {
    process.env.N8N_ALLOW_PRIVATE_REMOTE = '1'
    expect(normalizeN8nBaseUrl('https://10.0.0.9:5678/')).toBe('https://10.0.0.9:5678')
    expect(normalizeN8nBaseUrl('http://heisenbergs-1.local:5678/')).toBe('http://heisenbergs-1.local:5678')
    expect(() => normalizeN8nBaseUrl('https://n8n.example.com')).toThrow(/只允许.*私网地址/)
  })

  it('accepts only n8n webhook paths without traversal or URL injection', () => {
    expect(normalizeN8nWebhookPath('/webhook/aiworker-task')).toBe('webhook/aiworker-task')
    expect(normalizeN8nWebhookPath('webhook-test/test_1')).toBe('webhook-test/test_1')
    expect(() => normalizeN8nWebhookPath('api/v1/workflows')).toThrow(/webhook/)
    expect(() => normalizeN8nWebhookPath('webhook/../admin')).toThrow(/无效/)
    expect(() => normalizeN8nWebhookPath('https://example.test/webhook/a')).toThrow(/无效/)
  })

  it('validates the execution callback secret without accepting an empty configuration', () => {
    expect(isN8nWebhookSecretConfigured()).toBe(false)
    expect(getN8nRuntimeConfig().webhookSecretConfigured).toBe(false)
    expect(verifyN8nWebhookSecret('anything')).toBe(false)
    process.env.N8N_WEBHOOK_SECRET = 'shared-secret'
    expect(isN8nWebhookSecretConfigured()).toBe(true)
    expect(getN8nRuntimeConfig().webhookSecretConfigured).toBe(true)
    expect(verifyN8nWebhookSecret('shared-secret')).toBe(true)
    expect(verifyN8nWebhookSecret('wrong-secret')).toBe(false)
  })
})

describe('n8n HTTP integration', () => {
  it('checks the health endpoint without exposing management credentials', async () => {
    process.env.N8N_API_KEY = 'management-secret'
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const health = await checkN8nHealth()

    expect(health).toMatchObject({ ok: true, statusCode: 200, apiKeyConfigured: true })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:5678/healthz')
    expect(new Headers(init.headers).has('X-N8N-API-KEY')).toBe(false)
  })

  it('reads management workflows and executions using the API key', async () => {
    process.env.N8N_API_KEY = 'management-secret'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: '17', name: 'AI Worker', active: true }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: '81', workflowId: '17', status: 'success', finished: true }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(listN8nRemoteWorkflows()).resolves.toEqual([
      expect.objectContaining({ id: '17', name: 'AI Worker', active: true }),
    ])
    await expect(listN8nExecutions(500)).resolves.toEqual([
      expect.objectContaining({ id: '81', workflowId: '17', status: 'success', finished: true }),
    ])

    for (const [, init] of fetchMock.mock.calls as Array<[string, RequestInit]>) {
      expect(new Headers(init.headers).get('X-N8N-API-KEY')).toBe('management-secret')
    }
    expect(fetchMock.mock.calls[1][0]).toContain('limit=100')
  })

  it('sends idempotency and webhook-secret headers with the trigger payload', async () => {
    process.env.N8N_WEBHOOK_SECRET = 'webhook-secret'
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ accepted: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(triggerN8nWebhook('webhook/aiworker-task', { taskId: 'task-1' }, {
      idempotencyKey: 'task-1',
    })).resolves.toMatchObject({
      ok: true,
      statusCode: 200,
      data: { accepted: true },
    })

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const headers = new Headers(init.headers)
    expect(url).toBe('http://127.0.0.1:5678/webhook/aiworker-task')
    expect(headers.get('X-AIWorker-Idempotency-Key')).toBe('task-1')
    expect(headers.get('X-AIWorker-Webhook-Secret')).toBe('webhook-secret')
    expect(JSON.parse(String(init.body))).toEqual({ taskId: 'task-1' })
  })

  it('turns a non-success webhook response into a useful error', async () => {
    process.env.N8N_WEBHOOK_SECRET = 'webhook-secret'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'workflow inactive' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )))

    await expect(triggerN8nWebhook('webhook/aiworker-task', { taskId: 'task-2' }))
      .rejects.toThrow(/HTTP 404.*workflow inactive/)
  })

  it('refuses to call n8n when the webhook secret is missing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(triggerN8nWebhook('webhook/aiworker-task', { taskId: 'task-no-secret' }))
      .rejects.toThrow(/N8N_WEBHOOK_SECRET/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('n8n workflow binding persistence', () => {
  it('creates, updates, records, lists, and deletes a scoped binding through migration 049', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const scope = { workspaceId: 1, tenantId: 1 }
      const input = n8nWorkflowBindingInputSchema.parse({
        name: '视频学习任务链',
        description: 'Whisper、OCR 与 Qwen-VL 编排',
        workflowId: '17',
        webhookPath: '/webhook/aiworker-task',
        taskType: 'video-learning',
        agentRole: 'multimodal-analyst',
        model: 'qwen36-tools-local/default_model',
        timeoutSeconds: 120,
        retryCount: 2,
        enabled: true,
        config: { queue: 'heavy-model', persistResult: true },
      })

      const created = createN8nWorkflowBinding(db, input, 'tester', scope)
      expect(created).toMatchObject({
        id: 1,
        name: '视频学习任务链',
        webhookPath: 'webhook/aiworker-task',
        createdBy: 'tester',
        config: { queue: 'heavy-model', persistResult: true },
      })

      const updated = updateN8nWorkflowBinding(db, created.id, {
        ...input,
        model: 'qwen-vl-local/default_model',
        retryCount: 3,
      }, scope)
      expect(updated).toMatchObject({ model: 'qwen-vl-local/default_model', retryCount: 3 })

      updateN8nWorkflowRunStatus(db, created.id, 'success', scope)
      expect(getN8nWorkflowBinding(db, created.id, scope)).toMatchObject({ lastStatus: 'success' })
      expect(listN8nWorkflowBindings(db, scope)).toHaveLength(1)

      const otherScope = { workspaceId: 9, tenantId: 4 }
      const other = createN8nWorkflowBinding(db, input, 'other-user', otherScope)
      expect(other.id).not.toBe(created.id)
      expect(getN8nWorkflowBinding(db, created.id, otherScope)).toBeNull()
      expect(listN8nWorkflowBindings(db, otherScope)).toHaveLength(1)
      expect(deleteN8nWorkflowBinding(db, created.id, otherScope)).toBe(false)

      expect(deleteN8nWorkflowBinding(db, created.id, scope)).toBe(true)
      expect(listN8nWorkflowBindings(db, scope)).toEqual([])
    } finally {
      db.close()
    }
  })

  it('rejects secrets embedded in advanced workflow configuration', () => {
    const result = n8nWorkflowBindingInputSchema.safeParse({
      name: 'unsafe',
      webhookPath: 'webhook/unsafe',
      config: { provider: { apiKey: 'must-not-be-stored' } },
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0]?.message).toMatch(/不能保存密码、密钥、令牌或凭据/)
    }
  })
})

describe('n8n task run persistence', () => {
  it('enforces scoped idempotency and tracks accepted, running, and completed states', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const scope = { workspaceId: 1, tenantId: 1 }
      const input = {
        taskId: 'task-1',
        idempotencyKey: 'idem-1',
        bindingId: 7,
        source: 'video-autoworker',
        requestedBy: 'tester',
        routing: { model: 'qwen36-tools-local/default_model', timeoutSeconds: 120 },
        taskInput: { prompt: '测试闭环' },
        delivery: n8nTaskDeliverySchema.parse({ mode: 'none' }),
        maxAttempts: 2,
      }

      const created = createN8nTaskRun(db, input, scope)
      expect(created.created).toBe(true)
      expect(created.run).toMatchObject({ taskId: 'task-1', status: 'queued', attemptCount: 0 })

      const duplicate = createN8nTaskRun(db, { ...input, taskId: 'task-2' }, scope)
      expect(duplicate.created).toBe(false)
      expect(duplicate.run.taskId).toBe('task-1')

      expect(markN8nTaskAccepted(db, 'task-1')).toMatchObject({ status: 'accepted' })
      const claimed = claimN8nTaskRun(db, 'task-1')
      expect(claimed).toMatchObject({ claimed: true, run: { status: 'running', attemptCount: 1 } })
      expect(completeN8nTaskRun(db, 'task-1', { text: '完成' })).toMatchObject({
        status: 'succeeded',
        output: { text: '完成' },
      })

      expect(getN8nTaskRunByTaskId(db, 'task-1')).toMatchObject({ status: 'succeeded' })
      expect(getN8nTaskRunByIdempotencyKey(db, 'idem-1', scope)?.taskId).toBe('task-1')
      expect(getScopedN8nTaskRunByTaskId(db, 'task-1', scope)?.taskId).toBe('task-1')
      expect(getScopedN8nTaskRunByTaskId(db, 'task-1', { workspaceId: 9, tenantId: 9 })).toBeNull()
      expect(listN8nTaskRuns(db, scope, 10)).toHaveLength(1)
    } finally {
      db.close()
    }
  })

  it('allows a failed run to be claimed only until max attempts is reached', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      createN8nTaskRun(db, {
        taskId: 'task-retry',
        idempotencyKey: 'idem-retry',
        bindingId: 1,
        source: 'video-autoworker',
        requestedBy: 'tester',
        routing: {},
        taskInput: { prompt: 'retry' },
        delivery: { mode: 'none' },
        maxAttempts: 1,
      }, { workspaceId: 1, tenantId: 1 })

      expect(claimN8nTaskRun(db, 'task-retry').claimed).toBe(true)
      failN8nTaskRun(db, 'task-retry', 'failed once')
      expect(claimN8nTaskRun(db, 'task-retry').claimed).toBe(false)
      expect(getN8nTaskRunByTaskId(db, 'task-retry')).toMatchObject({
        status: 'failed',
        attemptCount: 1,
        maxAttempts: 1,
      })
    } finally {
      db.close()
    }
  })

  it('claims a scoped video parent once and treats a repeated claim as idempotent', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const scope = { workspaceId: 2, tenantId: 3 }
      const binding = createN8nWorkflowBinding(db, n8nWorkflowBindingInputSchema.parse({
        name: '视频分析任务链',
        webhookPath: 'webhook/aiworker-video-analysis',
        taskType: 'video-analysis',
      }), 'tester', scope)
      createN8nTaskRun(db, {
        taskId: 'video-unclaimed-1',
        idempotencyKey: 'video-unclaimed-idem-1',
        bindingId: binding.id,
        source: 'openclaw',
        requestedBy: 'tester',
        routing: { taskType: 'video-analysis' },
        taskInput: {},
        delivery: { mode: 'none' },
        maxAttempts: 2,
      }, scope)
      expect(failScopedUnclaimedN8nTaskRun(
        db, 'video-unclaimed-1', 'webhook rejected before claim', scope,
      )).toMatchObject({
        failed: true,
        run: { status: 'failed', error: 'webhook rejected before claim' },
      })
      createN8nTaskRun(db, {
        taskId: 'video-claim-1',
        idempotencyKey: 'video-claim-idem-1',
        bindingId: binding.id,
        source: 'openclaw',
        requestedBy: 'tester',
        routing: { taskType: 'video-analysis' },
        taskInput: { videoKey: 'video.mp4' },
        delivery: { mode: 'none' },
        maxAttempts: 2,
      }, scope)

      expect(claimScopedN8nVideoTaskRun(db, {
        taskId: 'video-claim-1', idempotencyKey: 'wrong-idem', bindingId: binding.id,
      }, scope)).toMatchObject({ outcome: 'rejected', run: { status: 'queued' } })
      expect(claimScopedN8nVideoTaskRun(db, {
        taskId: 'video-claim-1', idempotencyKey: 'video-claim-idem-1', bindingId: binding.id,
      }, { workspaceId: 9, tenantId: 9 })).toEqual({ outcome: 'not_found', run: null })

      const claimed = claimScopedN8nVideoTaskRun(db, {
        taskId: 'video-claim-1', idempotencyKey: 'video-claim-idem-1', bindingId: binding.id,
      }, scope)
      expect(claimed).toMatchObject({ outcome: 'claimed', run: { status: 'running', attemptCount: 1 } })
      const repeated = claimScopedN8nVideoTaskRun(db, {
        taskId: 'video-claim-1', idempotencyKey: 'video-claim-idem-1', bindingId: binding.id,
      }, scope)
      expect(repeated).toMatchObject({ outcome: 'running', run: { status: 'running', attemptCount: 1 } })
      expect(failScopedUnclaimedN8nTaskRun(
        db, 'video-claim-1', 'ambiguous webhook failure', scope,
      )).toMatchObject({ failed: false, run: { status: 'running', error: null } })

      failN8nTaskRun(db, 'video-claim-1', 'terminal failure')
      expect(claimScopedN8nVideoTaskRun(db, {
        taskId: 'video-claim-1', idempotencyKey: 'video-claim-idem-1', bindingId: binding.id,
      }, scope)).toMatchObject({ outcome: 'terminal', run: { status: 'failed', attemptCount: 1 } })
    } finally {
      db.close()
    }
  })

  it('reconciles only expired pre-media video parents within the requested scope', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const scope = { workspaceId: 2, tenantId: 3 }
      const binding = createN8nWorkflowBinding(db, n8nWorkflowBindingInputSchema.parse({
        name: '视频孤儿收敛任务链',
        webhookPath: 'webhook/aiworker-video-reconcile',
        taskType: 'video-analysis',
      }), 'tester', scope)
      const createParent = (taskId: string, idempotencyKey: string) => {
        createN8nTaskRun(db, {
          taskId,
          idempotencyKey,
          bindingId: binding.id,
          source: 'openclaw',
          requestedBy: 'tester',
          routing: { taskType: 'video-analysis' },
          taskInput: { videoKey: `${taskId}.mp4` },
          delivery: { mode: 'none' },
          maxAttempts: 2,
        }, scope)
        markN8nTaskAccepted(db, taskId)
        db.prepare(`UPDATE n8n_task_runs SET accepted_at = 100, updated_at = 100 WHERE task_id = ?`).run(taskId)
      }

      createParent('video-orphan', 'video-orphan-idem')
      expect(reconcileScopedN8nVideoTaskRun(
        db, 'video-orphan', { workspaceId: 9, tenantId: 9 }, { nowSeconds: 1_000 },
      )).toEqual({ outcome: 'not_found', run: null, code: null })
      expect(getN8nTaskRunByTaskId(db, 'video-orphan')?.status).toBe('accepted')
      expect(reconcileScopedN8nVideoTaskRun(
        db, 'video-orphan', scope, { nowSeconds: 999 },
      )).toMatchObject({ outcome: 'active', run: { status: 'accepted' }, code: null })
      const firstReconciliation = reconcileScopedN8nVideoTaskRun(
        db, 'video-orphan', scope, { nowSeconds: 1_000 },
      )
      expect(firstReconciliation).toMatchObject({
        outcome: 'reconciled',
        code: 'VIDEO_CALLBACK_LEASE_EXPIRED',
        run: { status: 'failed', completedAt: 1_000, error: expect.stringContaining('VIDEO_CALLBACK_LEASE_EXPIRED') },
      })
      const repeatedReconciliation = reconcileScopedN8nVideoTaskRun(
        db, 'video-orphan', scope, { nowSeconds: 9_999 },
      )
      expect(repeatedReconciliation).toMatchObject({
        outcome: 'terminal',
        code: null,
        run: {
          status: 'failed',
          completedAt: firstReconciliation.run?.completedAt,
          error: firstReconciliation.run?.error,
        },
      })
      expect(createN8nMediaChildRunFromParent(db, {
        parentTaskId: 'video-orphan',
        parentIdempotencyKey: 'video-orphan-idem',
        stage: 'prepare',
        taskInput: {},
      })).toMatchObject({ outcome: 'terminal', parent: { status: 'failed' }, child: null })

      for (const stage of ['prepare', 'audio', 'vision', 'finalize'] as const) {
        for (const childStatus of ['queued', 'running'] as const) {
          const parentTaskId = `video-with-${stage}-${childStatus}`
          const parentIdempotencyKey = `${parentTaskId}-idem`
          createParent(parentTaskId, parentIdempotencyKey)
          const createdChild = createN8nMediaChildRunFromParent(db, {
            parentTaskId,
            parentIdempotencyKey,
            stage,
            taskInput: {},
          })
          expect(createdChild).toMatchObject({
            outcome: 'created',
            parent: { status: 'accepted' },
            child: { status: 'queued' },
          })
          if (childStatus === 'running') {
            expect(claimN8nTaskRun(db, createdChild.child!.taskId)).toMatchObject({
              claimed: true,
              run: { status: 'running' },
            })
          }
          expect(reconcileScopedN8nVideoTaskRun(
            db, parentTaskId, scope, { nowSeconds: 1_000_000_000 },
          )).toMatchObject({
            outcome: 'active',
            run: { status: 'accepted' },
            code: null,
          })
        }
      }

      const generalBinding = createN8nWorkflowBinding(db, n8nWorkflowBindingInputSchema.parse({
        name: '普通任务链不可收敛',
        webhookPath: 'webhook/general-reconcile-guard',
        taskType: 'general',
      }), 'tester', scope)
      createN8nTaskRun(db, {
        taskId: 'general-accepted-run',
        idempotencyKey: 'general-accepted-idem',
        bindingId: generalBinding.id,
        source: 'openclaw',
        requestedBy: 'tester',
        routing: { taskType: 'video-analysis' },
        taskInput: {},
        delivery: { mode: 'none' },
        maxAttempts: 2,
      }, scope)
      markN8nTaskAccepted(db, 'general-accepted-run')
      db.prepare(`UPDATE n8n_task_runs SET accepted_at = 100, updated_at = 100 WHERE task_id = ?`)
        .run('general-accepted-run')
      expect(reconcileScopedN8nVideoTaskRun(
        db, 'general-accepted-run', scope, { nowSeconds: 1_000_000_000 },
      )).toMatchObject({ outcome: 'ineligible', run: { status: 'accepted' }, code: null })

      createParent('video-running-orphan', 'video-running-orphan-idem')
      claimScopedN8nVideoTaskRun(db, {
        taskId: 'video-running-orphan',
        idempotencyKey: 'video-running-orphan-idem',
        bindingId: binding.id,
      }, scope)
      db.prepare(`UPDATE n8n_task_runs SET started_at = 100, updated_at = 100 WHERE task_id = ?`)
        .run('video-running-orphan')
      expect(reconcileScopedN8nVideoTaskRun(
        db, 'video-running-orphan', scope, { nowSeconds: 1_000 },
      )).toMatchObject({ outcome: 'reconciled', run: { status: 'failed' } })
    } finally {
      db.close()
    }
  })

  it('completes finalize child and parent atomically and repairs a legacy partial completion', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const scope = { workspaceId: 2, tenantId: 3 }
      const binding = createN8nWorkflowBinding(db, n8nWorkflowBindingInputSchema.parse({
        name: '视频最终提交任务链',
        webhookPath: 'webhook/video-finalize-atomic',
        taskType: 'video-analysis',
      }), 'tester', scope)
      const createFinalizePair = (suffix: string) => {
        const parentTaskId = `video-finalize-${suffix}`
        const parentIdempotencyKey = `${parentTaskId}-idem`
        createN8nTaskRun(db, {
          taskId: parentTaskId,
          idempotencyKey: parentIdempotencyKey,
          bindingId: binding.id,
          source: 'openclaw',
          requestedBy: 'tester',
          routing: { taskType: 'video-analysis' },
          taskInput: {},
          delivery: { mode: 'none' },
          maxAttempts: 2,
        }, scope)
        markN8nTaskAccepted(db, parentTaskId)
        const child = createN8nMediaChildRunFromParent(db, {
          parentTaskId,
          parentIdempotencyKey,
          stage: 'finalize',
          taskInput: {},
        }).child!
        markN8nTaskAccepted(db, child.taskId)
        claimN8nTaskRun(db, child.taskId)
        return { parentTaskId, childTaskId: child.taskId }
      }

      const atomic = createFinalizePair('atomic')
      expect(completeN8nFinalizeRun(db, {
        ...atomic,
        output: { summary: 'atomic result' },
      })).toMatchObject({
        outcome: 'completed',
        parent: { status: 'succeeded', output: { summary: 'atomic result' } },
        child: { status: 'succeeded', output: { summary: 'atomic result' } },
      })

      const legacy = createFinalizePair('legacy')
      completeN8nTaskRun(db, legacy.childTaskId, { summary: 'persisted child result' })
      expect(getN8nTaskRunByTaskId(db, legacy.parentTaskId)).toMatchObject({ status: 'accepted' })
      expect(completeN8nFinalizeRun(db, legacy)).toMatchObject({
        outcome: 'completed',
        parent: { status: 'succeeded', output: { summary: 'persisted child result' } },
        child: { status: 'succeeded', output: { summary: 'persisted child result' } },
      })
    } finally {
      db.close()
    }
  })
})
