#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'

const args = process.argv.slice(2)

function option(name) {
  const index = args.indexOf(name)
  if (index < 0) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`)
  return value
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

const baseUrl = String(option('--base-url') || process.env.AIWORKER_PLATFORM_URL || 'http://127.0.0.1:3017')
  .replace(/\/+$/, '')
if (!/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(baseUrl)) {
  fail('AI-worker 提交地址必须是本机回环 HTTP 地址')
}

async function readJson(response) {
  const text = await response.text()
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return { error: text || `HTTP ${response.status}` }
  }
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await readJson(response)
  if (!response.ok) {
    throw new Error(body?.error || `AI-worker 请求失败：HTTP ${response.status}`)
  }
  return body
}

async function main() {
  const statusTaskId = option('--status')
  if (statusTaskId) {
    const body = await request(`/api/n8n/runs?taskId=${encodeURIComponent(statusTaskId)}`)
    const run = Array.isArray(body?.runs) ? body.runs.find(item => item?.taskId === statusTaskId) : null
    if (!run) throw new Error(`未找到任务：${statusTaskId}`)
    process.stdout.write(`${JSON.stringify({
      taskId: run.taskId,
      status: run.status,
      attemptCount: run.attemptCount,
      maxAttempts: run.maxAttempts,
      output: run.output,
      error: run.error,
      updatedAt: run.updatedAt,
    })}\n`)
    return
  }

  const promptFile = option('--prompt-file')
  const promptArg = option('--prompt')
  const prompt = promptFile ? await readFile(promptFile, 'utf8') : promptArg
  if (!prompt?.trim()) throw new Error('必须通过 --prompt-file 或 --prompt 提供任务内容')
  if (prompt.length > 120_000) throw new Error('任务内容超过 120000 字符上限')

  const bindingsBody = await request('/api/n8n/workflows')
  const bindings = Array.isArray(bindingsBody?.bindings) ? bindingsBody.bindings : []
  const requestedBinding = option('--binding-id')
  const binding = requestedBinding
    ? bindings.find(item => String(item.id) === requestedBinding && item.enabled)
    : bindings.find(item => item.enabled)
  if (!binding) throw new Error('没有找到可用的 AI-worker n8n 任务链')

  const deliveryMode = option('--delivery') || 'none'
  if (!['none', 'reply'].includes(deliveryMode)) throw new Error('--delivery 只能是 none 或 reply')
  const sessionKey = option('--session-key')
  const channel = option('--channel')
  const target = option('--target')
  const accountId = option('--account-id')
  if (deliveryMode === 'reply' && !sessionKey && !(channel && target)) {
    throw new Error('回投任务必须提供 --session-key，或同时提供 --channel 和 --target')
  }

  const taskId = option('--task-id') || randomUUID()
  const idempotencyKey = option('--idempotency-key') || taskId
  const response = await request('/api/n8n/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      bindingId: binding.id,
      taskId,
      idempotencyKey,
      source: 'openclaw',
      input: { prompt: prompt.trim() },
      delivery: {
        mode: deliveryMode,
        ...(sessionKey ? { sessionKey } : {}),
        ...(channel ? { channel } : {}),
        ...(target ? { target } : {}),
        ...(accountId ? { accountId } : {}),
      },
    }),
  })
  process.stdout.write(`${JSON.stringify({
    taskId: response.taskId,
    status: response.status || response.result?.data?.status || 'accepted',
    duplicate: Boolean(response.duplicate),
  })}\n`)
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)))
