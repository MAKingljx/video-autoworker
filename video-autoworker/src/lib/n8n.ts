import { getOpenClawN8nOperatorUser, requireRole } from '@/lib/auth'
import { normalizeN8nBaseUrl } from '@/lib/n8n-base-url'
import { SafeOperationError, type SafeOperationErrorCode } from '@/lib/operational-errors'

const DEFAULT_TIMEOUT_MS = 8_000

export { normalizeN8nBaseUrl } from '@/lib/n8n-base-url'

export interface N8nRuntimeConfig {
  baseUrl: string
  apiKeyConfigured: boolean
  defaultWebhookPath: string
}

export interface N8nHealthStatus {
  ok: boolean
  baseUrl: string
  apiKeyConfigured: boolean
  statusCode: number | null
  latencyMs: number
  error: string | null
}

export interface N8nRemoteWorkflow {
  id: string
  name: string
  active: boolean
  updatedAt?: string
  createdAt?: string
  tags?: Array<{ id?: string; name?: string }>
}

export interface N8nExecutionSummary {
  id: string
  workflowId?: string
  status?: string
  mode?: string
  startedAt?: string
  stoppedAt?: string
  finished?: boolean
}

export interface N8nTriggerResult {
  ok: boolean
  statusCode: number
  data: unknown
  latencyMs: number
}

export type N8nWebhookDispatchOutcome = 'rejected' | 'outcome_unknown'

/**
 * Separates a response that proves n8n rejected the request from a transport
 * result where n8n may already have accepted it. Callers must not turn an
 * `outcome_unknown` delivery into a terminal task failure.
 */
export class N8nWebhookDispatchError extends SafeOperationError {
  readonly outcome: N8nWebhookDispatchOutcome
  readonly statusCode: number | null

  constructor(
    outcome: N8nWebhookDispatchOutcome,
    statusCode: number | null = null,
    diagnostic?: unknown,
  ) {
    const code: SafeOperationErrorCode = outcome === 'rejected'
      ? 'N8N_WEBHOOK_REJECTED'
      : 'N8N_DISPATCH_FAILED'
    super(code, diagnostic)
    this.name = 'N8nWebhookDispatchError'
    this.outcome = outcome
    this.statusCode = statusCode
  }
}

export function isN8nWebhookDispatchError(error: unknown): error is N8nWebhookDispatchError {
  return error instanceof N8nWebhookDispatchError
}

export function normalizeN8nWebhookPath(raw: string): string {
  const value = String(raw || '').trim().replace(/^\/+/, '')
  if (!value) throw new Error('n8n Webhook 路径不能为空')
  if (value.includes('..') || value.includes('?') || value.includes('#') || value.includes('://')) {
    throw new Error('n8n Webhook 路径无效')
  }
  if (!/^(?:webhook|webhook-test)\/[A-Za-z0-9._~/-]+$/.test(value)) {
    throw new Error('n8n Webhook 路径必须以 webhook/ 或 webhook-test/ 开头')
  }
  return value
}

export function getN8nRuntimeConfig(): N8nRuntimeConfig {
  return {
    baseUrl: normalizeN8nBaseUrl(),
    apiKeyConfigured: Boolean(String(process.env.N8N_API_KEY || '').trim()),
    defaultWebhookPath: normalizeN8nWebhookPath(
      process.env.N8N_DEFAULT_WEBHOOK_PATH || 'webhook/aiworker-task',
    ),
  }
}

/** Validate every local precondition before a durable parent task is created. */
export function validateN8nWebhookDispatchConfiguration(webhookPath: string): void {
  normalizeN8nWebhookPath(webhookPath)
  normalizeN8nBaseUrl()
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function n8nFetch(
  path: string,
  init: RequestInit = {},
  options: { management?: boolean; timeoutMs?: number } = {},
): Promise<{ response: Response; data: unknown; latencyMs: number }> {
  const config = getN8nRuntimeConfig()
  const normalizedPath = String(path || '').replace(/^\/+/, '')
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')

  if (options.management) {
    const apiKey = String(process.env.N8N_API_KEY || '').trim()
    if (!apiKey) throw new Error('尚未配置 N8N_API_KEY，无法读取 n8n 管理接口')
    headers.set('X-N8N-API-KEY', apiKey)
  }

  const startedAt = Date.now()
  const response = await fetch(`${config.baseUrl}/${normalizedPath}`, {
    ...init,
    headers,
    cache: 'no-store',
    signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  })
  const data = await parseResponseBody(response)
  return { response, data, latencyMs: Date.now() - startedAt }
}

export async function checkN8nHealth(): Promise<N8nHealthStatus> {
  const config = getN8nRuntimeConfig()
  const startedAt = Date.now()
  try {
    const { response } = await n8nFetch('healthz', {}, { timeoutMs: 3_000 })
    return {
      ok: response.ok,
      baseUrl: config.baseUrl,
      apiKeyConfigured: config.apiKeyConfigured,
      statusCode: response.status,
      latencyMs: Date.now() - startedAt,
      error: response.ok ? null : `n8n healthz 返回 HTTP ${response.status}`,
    }
  } catch (error) {
    return {
      ok: false,
      baseUrl: config.baseUrl,
      apiKeyConfigured: config.apiKeyConfigured,
      statusCode: null,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : '无法连接 n8n',
    }
  }
}

export async function listN8nRemoteWorkflows(): Promise<N8nRemoteWorkflow[]> {
  if (!String(process.env.N8N_API_KEY || '').trim()) return []
  const { response, data } = await n8nFetch('api/v1/workflows?limit=100', {}, { management: true })
  if (!response.ok) throw new Error(`读取 n8n 工作流失败：HTTP ${response.status}`)
  const rows = Array.isArray(data)
    ? data
    : (data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)
      ? (data as { data: unknown[] }).data
      : [])
  return rows.map((row) => {
    const value = row as Record<string, unknown>
    return {
      id: String(value.id || ''),
      name: String(value.name || '未命名工作流'),
      active: Boolean(value.active),
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : undefined,
      createdAt: typeof value.createdAt === 'string' ? value.createdAt : undefined,
      tags: Array.isArray(value.tags) ? value.tags as N8nRemoteWorkflow['tags'] : undefined,
    }
  }).filter(row => row.id)
}

export async function listN8nExecutions(limit = 20): Promise<N8nExecutionSummary[]> {
  if (!String(process.env.N8N_API_KEY || '').trim()) return []
  const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)))
  const { response, data } = await n8nFetch(`api/v1/executions?limit=${safeLimit}`, {}, { management: true })
  if (!response.ok) throw new Error(`读取 n8n 执行记录失败：HTTP ${response.status}`)
  const rows = data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)
    ? (data as { data: unknown[] }).data
    : []
  return rows.map((row) => {
    const value = row as Record<string, unknown>
    return {
      id: String(value.id || ''),
      workflowId: value.workflowId === undefined ? undefined : String(value.workflowId),
      status: typeof value.status === 'string' ? value.status : undefined,
      mode: typeof value.mode === 'string' ? value.mode : undefined,
      startedAt: typeof value.startedAt === 'string' ? value.startedAt : undefined,
      stoppedAt: typeof value.stoppedAt === 'string' ? value.stoppedAt : undefined,
      finished: typeof value.finished === 'boolean' ? value.finished : undefined,
    }
  }).filter(row => row.id)
}

export async function triggerN8nWebhook(
  webhookPath: string,
  payload: Record<string, unknown>,
  options: { timeoutMs?: number; idempotencyKey?: string } = {},
): Promise<N8nTriggerResult> {
  validateN8nWebhookDispatchConfiguration(webhookPath)
  const path = normalizeN8nWebhookPath(webhookPath)
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const idempotencyKey = String(options.idempotencyKey || '').trim()
  if (idempotencyKey) headers.set('X-AIWorker-Idempotency-Key', idempotencyKey)

  let result: Awaited<ReturnType<typeof n8nFetch>>
  try {
    result = await n8nFetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }, { timeoutMs: options.timeoutMs ?? 30_000 })
  } catch (error) {
    throw new N8nWebhookDispatchError(
      'outcome_unknown',
      null,
      error,
    )
  }

  const { response, data, latencyMs } = result

  if (!response.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data)
    const outcome: N8nWebhookDispatchOutcome = response.status >= 400
      && response.status < 500
      && ![408, 425, 429].includes(response.status)
      ? 'rejected'
      : 'outcome_unknown'
    throw new N8nWebhookDispatchError(outcome, response.status, {
      statusCode: response.status,
      detail,
    })
  }
  return { ok: true, statusCode: response.status, data, latencyMs }
}

export function requireN8nRole(request: Request, minRole: 'viewer' | 'operator' | 'admin') {
  const internal = getOpenClawN8nOperatorUser(request)
  if (internal) return { user: internal }
  return requireRole(request, minRole)
}
