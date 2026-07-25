import { getLocalDesktopUserFromRequest, requireRole } from '@/lib/auth'
import { isIP } from 'node:net'

const DEFAULT_N8N_BASE_URL = 'http://127.0.0.1:5678'
const DEFAULT_TIMEOUT_MS = 8_000

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

function envFlag(name: string): boolean {
  const raw = process.env[name]
  if (raw === undefined) return false
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase())
}

function isPrivateN8nHost(host: string): boolean {
  if (host.endsWith('.local')) return true
  const ipVersion = isIP(host)
  if (ipVersion === 4) {
    const octets = host.split('.').map(Number)
    return octets[0] === 10
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
  }
  if (ipVersion === 6) {
    const firstHextet = Number.parseInt(host.split(':')[0] || '0', 16)
    return (firstHextet >= 0xfc00 && firstHextet <= 0xfdff)
      || (firstHextet >= 0xfe80 && firstHextet <= 0xfebf)
  }
  return false
}

export function normalizeN8nBaseUrl(raw = process.env.N8N_BASE_URL || DEFAULT_N8N_BASE_URL): string {
  const parsed = new URL(String(raw || '').trim() || DEFAULT_N8N_BASE_URL)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('n8n 地址只支持 http 或 https')
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  if (!isLoopback) {
    if (!envFlag('N8N_ALLOW_PRIVATE_REMOTE')) {
      throw new Error('n8n 默认只允许本机回环地址；远端私网需显式设置 N8N_ALLOW_PRIVATE_REMOTE=1')
    }
    if (!isPrivateN8nHost(host)) {
      throw new Error('N8N_ALLOW_PRIVATE_REMOTE 只允许 RFC1918、链路本地、Tailscale 或 .local 私网地址')
    }
  }

  parsed.username = ''
  parsed.password = ''
  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/$/, '')
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
  const path = normalizeN8nWebhookPath(webhookPath)
  const headers = new Headers({ 'Content-Type': 'application/json' })
  const idempotencyKey = String(options.idempotencyKey || '').trim()
  if (idempotencyKey) headers.set('X-AIWorker-Idempotency-Key', idempotencyKey)
  const secret = String(process.env.N8N_WEBHOOK_SECRET || '').trim()
  if (secret) headers.set('X-AIWorker-Webhook-Secret', secret)

  const { response, data, latencyMs } = await n8nFetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }, { timeoutMs: options.timeoutMs ?? 30_000 })

  if (!response.ok) {
    const detail = typeof data === 'string' ? data : JSON.stringify(data)
    throw new Error(`n8n Webhook 执行失败：HTTP ${response.status}${detail ? ` - ${detail}` : ''}`)
  }
  return { ok: true, statusCode: response.status, data, latencyMs }
}

export function requireN8nRole(request: Request, minRole: 'viewer' | 'operator' | 'admin') {
  const localDesktop = getLocalDesktopUserFromRequest(request)
  if (localDesktop) {
    // MC_DESKTOP_MODE is an explicit trusted-console boundary and auth.ts only
    // returns this identity for loopback URLs. Represent that trust accurately
    // instead of silently treating a viewer as an operator.
    return { user: { ...localDesktop, role: 'admin' as const } }
  }
  return requireRole(request, minRole)
}
