import { logger } from '@/lib/logger'

export const SAFE_OPERATION_ERROR_SUMMARIES = {
  N8N_MODEL_ROUTE_INVALID: '模型路由配置无效',
  N8N_MODEL_HTTP_FAILED: '模型服务调用失败',
  N8N_OPENCLAW_EXECUTION_FAILED: 'OpenClaw 模型节点执行失败',
  N8N_MODEL_EXECUTION_FAILED: '模型节点执行失败',
  N8N_MEDIA_COMMAND_FAILED: '媒体处理命令执行失败',
  N8N_MEDIA_MODEL_HTTP_FAILED: '媒体分析模型调用失败',
  N8N_MEDIA_DEPENDENCY_FAILED: '媒体节点依赖未就绪',
  N8N_MEDIA_STAGE_FAILED: '媒体节点执行失败',
  N8N_CHILD_LEASE_LOST: '子任务执行租约已失效',
  N8N_WEBHOOK_CONFIG_INVALID: 'n8n Webhook 本地配置无效',
  N8N_CALLBACK_CONFIG_INVALID: 'n8n 节点回调配置无效',
  N8N_WEBHOOK_REJECTED: 'n8n 拒绝了任务请求',
  N8N_DISPATCH_FAILED: 'n8n 任务派发失败',
  VIDEO_CALLBACK_LEASE_EXPIRED: '视频回调租约已过期',
  VIDEO_FINALIZE_LEASE_EXPIRED: '视频最终处理租约已过期',
  MATERIALS_OVERVIEW_FAILED: '无法读取素材库',
  MATERIALS_SEARCH_FAILED: '素材搜索失败',
  MATERIALS_VECTOR_INDEX_FAILED: '向量索引失败',
} as const

export type SafeOperationErrorCode = keyof typeof SAFE_OPERATION_ERROR_SUMMARIES

export interface SafeOperationErrorProjection {
  code: SafeOperationErrorCode
  summary: string
  persistedMessage: string
}

const KNOWN_PERSISTED_ERROR = /^\[([A-Z][A-Z0-9_]{2,79})\]\s*/u

function serializeDiagnostic(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) {
    const candidate = value as Error & {
      stderr?: unknown
      stdout?: unknown
      code?: unknown
      statusCode?: unknown
      diagnostic?: unknown
    }
    const parts = [
      `name=${value.name}`,
      candidate.code === undefined ? '' : `code=${String(candidate.code)}`,
      candidate.statusCode === undefined ? '' : `status=${String(candidate.statusCode)}`,
      candidate.diagnostic === undefined ? '' : serializeDiagnostic(candidate.diagnostic),
      candidate.stderr === undefined ? '' : `stderr=${String(candidate.stderr)}`,
      candidate.stdout === undefined ? '' : `stdout=${String(candidate.stdout)}`,
      `message=${value.message}`,
    ].filter(Boolean)
    return parts.join(' ')
  }
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Keep local diagnostics useful while removing values that must never be
 * copied to callbacks, persistent task state, or ordinary application logs.
 */
export function sanitizeOperationalDiagnostic(value: unknown, maxLength = 2_000): string {
  return serializeDiagnostic(value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(["'](?:api[_-]?key|token|secret|password|passwd)["'])\s*:\s*["'][^"']*["']/gi, '$1:"[脱敏]"')
    .replace(/\b(authorization|proxy-authorization)\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi, '$1=[脱敏]')
    .replace(/\b(api[_-]?key|token|secret|password|passwd)\s*[:=]\s*["']?[^\s,"';}]+/gi, '$1=[脱敏]')
    .replace(/--(?:api[_-]?key|token|secret|password|session-key|reply-channel|reply-to|reply-account)\s+[^\s]+/gi, match => `${match.split(/\s+/u)[0]} [脱敏]`)
    .replace(/\b(?:sk|xox[baprs]|gh[pousr])-[A-Za-z0-9_-]{8,}\b/gi, '[凭据]')
    .replace(/https?:\/\/\S+/gi, '[链接]')
    .replace(/(?<![A-Za-z0-9])\/(?:[^\s，。；;,]+\/)*[^\s，。；;,]*/g, '[路径]')
    .replace(/[A-Za-z]:\\[^\s，。；;]+/g, '[路径]')
    .replace(/\b(?:cli|tbl|rec|chat|oc|ou)_[A-Za-z0-9_-]{8,}\b/g, '[内部ID]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '[ID]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[高熵值]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, maxLength))
}

export class SafeOperationError extends Error {
  readonly publicCode: SafeOperationErrorCode
  readonly diagnostic: string

  constructor(code: SafeOperationErrorCode, diagnostic?: unknown) {
    const summary = SAFE_OPERATION_ERROR_SUMMARIES[code]
    super(`[${code}] ${summary}`)
    this.name = 'SafeOperationError'
    this.publicCode = code
    this.diagnostic = sanitizeOperationalDiagnostic(diagnostic ?? '')
  }
}

export function projectSafeOperationError(
  error: unknown,
  fallbackCode: SafeOperationErrorCode,
): SafeOperationErrorProjection {
  let code = fallbackCode
  if (error instanceof SafeOperationError) {
    code = error.publicCode
  } else {
    const message = typeof error === 'string' ? error : error instanceof Error ? error.message : ''
    const match = message.match(KNOWN_PERSISTED_ERROR)
    if (match && Object.hasOwn(SAFE_OPERATION_ERROR_SUMMARIES, match[1])) {
      code = match[1] as SafeOperationErrorCode
    }
  }
  const summary = SAFE_OPERATION_ERROR_SUMMARIES[code]
  return { code, summary, persistedMessage: `[${code}] ${summary}` }
}

export function logSafeOperationError(
  context: string,
  error: unknown,
  projection: SafeOperationErrorProjection,
): void {
  const diagnostic = error instanceof SafeOperationError && error.diagnostic
    ? error.diagnostic
    : sanitizeOperationalDiagnostic(error)
  logger.error({
    event: 'operation_failed',
    context,
    publicCode: projection.code,
    ...(diagnostic ? { diagnostic } : {}),
  }, 'operation failed')
}
