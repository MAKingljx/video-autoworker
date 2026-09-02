import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest, NextResponse } from 'next/server'
import { runOpenClaw } from '@/lib/command'
import { getDatabase } from '@/lib/db'
import { checkOpenClawN8nCallbackRequest } from '@/lib/openclaw-loopback-auth'
import {
  checkN8nCallbackAdmission,
  N8N_LEGACY_CALLBACK_PROTOCOL,
} from '@/lib/n8n-runtime-affinity'
import {
  claimN8nTaskRun,
  completeN8nTaskRun,
  failN8nTaskRun,
  getN8nTaskRunByTaskId,
  n8nTaskIdentitySchema,
  type N8nTaskRun,
} from '@/lib/n8n-task-runs'

export const runtime = 'nodejs'

const SAFE_COMPONENT = /^[A-Za-z0-9._:-]+$/
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'adaptive', 'max'])

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function safeComponent(value: unknown, fallback: string): string {
  const text = String(value || '').trim()
  return text && text.length <= 120 && SAFE_COMPONENT.test(text) ? text : fallback
}

function promptFromRun(run: N8nTaskRun): string {
  const direct = [run.input.prompt, run.input.message, run.input.text]
    .find(value => typeof value === 'string' && value.trim())
  const taskText = typeof direct === 'string'
    ? direct.trim()
    : JSON.stringify(run.input, null, 2)
  if (!taskText || taskText === '{}') throw new Error('任务输入中没有可执行内容')
  if (taskText.length > 120_000) throw new Error('任务输入超过 120000 字符上限')
  return [
    `AI-worker 后台任务 ${run.taskId}`,
    '请完成下面的任务，直接给出最终结果。不要伪造工具调用；需要工具时只使用已授权的真实工具。',
    '',
    taskText,
  ].join('\n')
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

function executionError(error: unknown): string {
  const value = error as { stderr?: string; stdout?: string }
  const detail = String(value?.stderr || value?.stdout || '').trim()
  if (detail) return detail.slice(0, 2_000)
  return error instanceof Error && !error.message.startsWith('Command failed (')
    ? error.message.slice(0, 2_000)
    : 'OpenClaw 任务执行失败'
}

async function executeRun(run: N8nTaskRun): Promise<Record<string, unknown>> {
  const routingConfig = objectValue(run.routing.config)
  const profile = safeComponent(routingConfig.profile, 'qwen-current')
  const agentId = safeComponent(routingConfig.agentId, 'second-original')
  const model = String(run.routing.model || 'qwen36-tools-local/default_model').trim()
  const timeoutSeconds = Math.max(5, Math.min(600, Number(run.routing.timeoutSeconds) || 120))
  // The current local Qwen route only accepts `off`; bindings may explicitly
  // opt into another level after the selected model advertises support for it.
  const thinking = String(routingConfig.thinking || 'off').trim().toLowerCase()
  const sessionKey = run.delivery.sessionKey
    || `agent:${agentId}:aiworker-task-${run.taskId}`
  const prompt = promptFromRun(run)
  const tempRoot = await mkdtemp(join(tmpdir(), 'aiworker-n8n-'))
  const promptPath = join(tempRoot, 'prompt.txt')

  try {
    await writeFile(promptPath, prompt, { encoding: 'utf8', mode: 0o600 })
    const args = [
      '--profile', profile,
      'agent',
      '--agent', agentId,
      '--session-key', sessionKey,
      '--message-file', promptPath,
      '--model', model,
      '--timeout', String(timeoutSeconds),
      '--json',
    ]
    if (THINKING_LEVELS.has(thinking)) args.push('--thinking', thinking)
    if (run.delivery.mode === 'reply') {
      args.push('--deliver')
      if (run.delivery.channel) args.push('--reply-channel', run.delivery.channel)
      if (run.delivery.target) args.push('--reply-to', run.delivery.target)
      if (run.delivery.accountId) args.push('--reply-account', run.delivery.accountId)
    }

    const result = await runOpenClaw(args, { timeoutMs: (timeoutSeconds + 15) * 1_000 })
    return {
      ...parseOpenClawOutput(result.stdout),
      profile,
      agentId,
      deliveryRequested: run.delivery.mode === 'reply',
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

export async function POST(request: NextRequest) {
  const channel = checkOpenClawN8nCallbackRequest(request, '/api/n8n/execute')
  if (!channel.allowed) return NextResponse.json({ error: channel.error }, { status: channel.status })
  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const taskIdResult = n8nTaskIdentitySchema.safeParse(body?.taskId)
  const idempotencyResult = n8nTaskIdentitySchema.safeParse(body?.idempotencyKey)
  if (!taskIdResult.success || !idempotencyResult.success) {
    return NextResponse.json({ error: '任务标识无效' }, { status: 400 })
  }

  const db = getDatabase()
  const existing = getN8nTaskRunByTaskId(db, taskIdResult.data)
  if (!existing) return NextResponse.json({ error: '未找到任务运行记录' }, { status: 404 })
  if (existing.idempotencyKey !== idempotencyResult.data) {
    return NextResponse.json({ error: '幂等键与任务记录不匹配' }, { status: 409 })
  }
  if (existing.routing.callbackProtocol !== N8N_LEGACY_CALLBACK_PROTOCOL) {
    return NextResponse.json({
      taskId: existing.taskId,
      code: 'N8N_LEGACY_EXECUTION_REQUIRED',
      error: '旧执行接口只允许显式 legacy-v1 任务',
    }, { status: 409 })
  }
  const admission = checkN8nCallbackAdmission(existing.routing)
  if (!admission.allowed || admission.mode !== 'legacy') {
    return NextResponse.json({
      taskId: existing.taskId,
      code: admission.allowed ? 'N8N_LEGACY_RUNTIME_REQUIRED' : admission.code,
      error: admission.allowed ? '旧执行接口不能在蓝绿 slot 运行时执行' : admission.error,
    }, { status: 409 })
  }
  if (existing.status === 'succeeded') {
    return NextResponse.json({ taskId: existing.taskId, status: existing.status, output: existing.output, cached: true })
  }
  if (existing.status === 'running') {
    return NextResponse.json({ taskId: existing.taskId, status: existing.status, duplicate: true }, { status: 202 })
  }

  const claimed = claimN8nTaskRun(db, existing.taskId)
  if (!claimed.claimed || !claimed.run) {
    return NextResponse.json({
      taskId: existing.taskId,
      status: claimed.run?.status || existing.status,
      error: '任务重试次数已用尽或状态不可执行',
    }, { status: 409 })
  }

  try {
    const output = await executeRun(claimed.run)
    const completed = completeN8nTaskRun(db, claimed.run.taskId, output)
    return NextResponse.json({ taskId: claimed.run.taskId, status: completed?.status || 'succeeded', output })
  } catch (error) {
    const message = executionError(error)
    const failed = failN8nTaskRun(db, claimed.run.taskId, message)
    return NextResponse.json({
      taskId: claimed.run.taskId,
      status: failed?.status || 'failed',
      error: message,
      retryable: Boolean(failed && failed.attemptCount < failed.maxAttempts),
    }, { status: 502 })
  }
}
