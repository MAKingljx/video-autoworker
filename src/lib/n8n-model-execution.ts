import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runOpenClaw } from '@/lib/command'
import type { N8nTaskDelivery } from '@/lib/n8n-task-runs'
import type { N8nModelRoute } from '@/lib/n8n-model-routing'

const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max'])

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function parseOpenClawOutput(stdout: string): Record<string, unknown> {
  const raw = String(stdout || '').trim()
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end < start) {
    if (!raw) throw new Error('OpenClaw 返回空结果')
    return { text: raw.slice(0, 100_000) }
  }
  let parsed: Record<string, any>
  try {
    parsed = JSON.parse(raw.slice(start, end + 1)) as Record<string, any>
  } catch {
    throw new Error('OpenClaw 返回了无法解析的 JSON')
  }
  const text = parsed.payloads?.[0]?.text
    ?? parsed.result?.payloads?.[0]?.text
    ?? parsed.result?.finalAssistantVisibleText
    ?? parsed.output
    ?? parsed.result
  const agentMeta = objectValue(parsed.meta?.agentMeta ?? parsed.result?.meta?.agentMeta)
  const output: Record<string, unknown> = {
    text: typeof text === 'string' ? text.slice(0, 100_000) : JSON.stringify(text ?? parsed).slice(0, 100_000),
  }
  const sessionId = parsed.sessionId ?? parsed.session_id ?? agentMeta.sessionId
  if (sessionId) output.sessionId = String(sessionId)
  if (agentMeta.provider) output.provider = String(agentMeta.provider)
  if (agentMeta.model) output.model = String(agentMeta.model)
  if (typeof parsed.deliverySucceeded === 'boolean') output.deliverySucceeded = parsed.deliverySucceeded
  return output
}

function promptText(nodeKey: string, instruction: string, input: Record<string, unknown>): string {
  const body = JSON.stringify(input, null, 2)
  if (body.length > 120_000) throw new Error('节点输入超过 120000 字符上限')
  return [
    `AI-worker 自动化节点：${nodeKey}`,
    instruction || '完成当前节点任务，只输出可供下一节点直接使用的结果。',
    '不要伪造工具调用；需要工具时只使用已授权的真实工具。',
    '',
    body,
  ].join('\n')
}

async function executeOpenClaw(
  route: Extract<N8nModelRoute, { transport: 'openclaw' }>,
  options: ExecutionOptions,
): Promise<Record<string, unknown>> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'aiworker-model-node-'))
  const promptPath = join(tempRoot, 'prompt.txt')
  const prompt = promptText(options.nodeKey, options.instruction || route.systemPrompt, options.input)
  const timeoutSeconds = options.timeoutSeconds || route.timeoutSeconds
  try {
    await writeFile(promptPath, prompt, { encoding: 'utf8', mode: 0o600 })
    const args = [
      '--profile', route.profile,
      'agent',
      '--agent', route.agentId,
      '--session-key', options.sessionKey,
      '--message-file', promptPath,
      '--model', route.model,
      '--timeout', String(timeoutSeconds),
      '--json',
    ]
    const thinking = String(route.thinking || 'off').toLowerCase()
    if (THINKING_LEVELS.has(thinking)) args.push('--thinking', thinking)
    if (options.delivery.mode === 'reply') {
      args.push('--deliver')
      if (options.delivery.channel) args.push('--reply-channel', options.delivery.channel)
      if (options.delivery.target) args.push('--reply-to', options.delivery.target)
      if (options.delivery.accountId) args.push('--reply-account', options.delivery.accountId)
    }
    const result = await runOpenClaw(args, { timeoutMs: (timeoutSeconds + 15) * 1_000 })
    return {
      ...parseOpenClawOutput(result.stdout),
      routeId: route.id,
      location: route.location,
      transport: route.transport,
      profile: route.profile,
      agentId: route.agentId,
      deliveryRequested: options.delivery.mode === 'reply',
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function executeCompatibleApi(
  route: Extract<N8nModelRoute, { transport: 'openai-compatible' }>,
  options: ExecutionOptions,
): Promise<Record<string, unknown>> {
  if (options.delivery.mode === 'reply') {
    throw new Error('直接模型 API 节点不能负责会话回投；请让最终节点使用 OpenClaw 路由')
  }
  const apiKey = route.apiKeyEnv ? String(process.env[route.apiKeyEnv] || '').trim() : ''
  if (route.apiKeyEnv && !apiKey) throw new Error(`模型路由缺少外部凭据引用 ${route.apiKeyEnv}`)
  const timeoutSeconds = options.timeoutSeconds || route.timeoutSeconds
  const response = await fetch(`${route.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: route.model,
      messages: [
        { role: 'system', content: options.instruction || route.systemPrompt || `你是 ${options.nodeKey} 节点。` },
        { role: 'user', content: JSON.stringify(options.input, null, 2) },
      ],
      ...(route.temperature === undefined ? {} : { temperature: route.temperature }),
      ...(route.maxTokens === undefined ? {} : { max_tokens: route.maxTokens }),
    }),
    signal: AbortSignal.timeout(timeoutSeconds * 1_000),
  })
  const raw = await response.text()
  let parsed: any
  try {
    parsed = raw ? JSON.parse(raw) : null
  } catch {
    parsed = null
  }
  if (!response.ok) {
    const detail = String(parsed?.error?.message || raw || `HTTP ${response.status}`).slice(0, 2_000)
    throw new Error(`模型 API 调用失败：${detail}`)
  }
  const text = parsed?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new Error('模型 API 返回空结果')
  return {
    text: text.slice(0, 100_000),
    routeId: route.id,
    location: route.location,
    transport: route.transport,
    provider: new URL(route.baseUrl).hostname,
    model: route.model,
    deliveryRequested: false,
    ...(parsed?.usage && typeof parsed.usage === 'object' ? { usage: parsed.usage } : {}),
  }
}

export interface ExecutionOptions {
  nodeKey: string
  instruction?: string
  input: Record<string, unknown>
  sessionKey: string
  delivery: N8nTaskDelivery
  timeoutSeconds?: number
}

export async function executeN8nModelRoute(
  route: N8nModelRoute,
  options: ExecutionOptions,
): Promise<Record<string, unknown>> {
  return route.transport === 'openclaw'
    ? executeOpenClaw(route, options)
    : executeCompatibleApi(route, options)
}

export function n8nModelExecutionError(error: unknown): string {
  const value = error as { stderr?: string; stdout?: string }
  const detail = String(value?.stderr || value?.stdout || '').trim()
  if (detail) return detail.slice(0, 2_000)
  return error instanceof Error && !error.message.startsWith('Command failed (')
    ? error.message.slice(0, 2_000)
    : '模型节点执行失败'
}
