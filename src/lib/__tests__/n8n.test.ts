import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkN8nHealth,
  listN8nExecutions,
  listN8nRemoteWorkflows,
  normalizeN8nBaseUrl,
  normalizeN8nWebhookPath,
  triggerN8nWebhook,
} from '@/lib/n8n'
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: 'workflow inactive' }),
      { status: 404, headers: { 'Content-Type': 'application/json' } },
    )))

    await expect(triggerN8nWebhook('webhook/aiworker-task', { taskId: 'task-2' }))
      .rejects.toThrow(/HTTP 404.*workflow inactive/)
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
