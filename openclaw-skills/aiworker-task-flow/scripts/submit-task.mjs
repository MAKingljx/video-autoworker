#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { extname, join, resolve } from 'node:path'

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

  const videoFile = option('--video-file')
  const promptFile = option('--prompt-file')
  const promptArg = option('--prompt')
  const prompt = (promptFile ? await readFile(promptFile, 'utf8') : promptArg)
    || (videoFile ? '分析视频中的语音内容和画面信息，分别给出结果后合并。' : '')
  if (!prompt?.trim()) throw new Error('必须通过 --prompt-file、--prompt 或 --video-file 提供任务内容')
  if (prompt.length > 120_000) throw new Error('任务内容超过 120000 字符上限')

  const bindingsBody = await request('/api/n8n/workflows')
  const bindings = Array.isArray(bindingsBody?.bindings) ? bindingsBody.bindings : []
  const requestedBinding = option('--binding-id')
  const binding = requestedBinding
    ? bindings.find(item => String(item.id) === requestedBinding && item.enabled)
    : videoFile
      ? bindings.find(item => item.enabled && item.taskType === 'video-analysis')
      : bindings.find(item => item.enabled && item.taskType !== 'video-analysis')
        || bindings.find(item => item.enabled)
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
  if (videoFile && deliveryMode !== 'none') {
    throw new Error('视频分析工作节点不进入 OpenClaw 会话；请使用 --delivery none 和 --wait-seconds 获取结果')
  }

  const taskId = option('--task-id') || randomUUID()
  const idempotencyKey = option('--idempotency-key') || taskId
  const routingNodes = Object.fromEntries([
    ['planner', option('--planner-route')],
    ['executor', option('--executor-route')],
    ['reviewer', option('--reviewer-route')],
    ['vision', option('--vision-route')],
  ].filter(([, routeId]) => Boolean(routeId)).map(([nodeKey, routeId]) => [
    nodeKey,
    { routeId, fallbackRouteIds: [] },
  ]))
  let stagedVideo = null
  try {
    if (videoFile) {
      const sourcePath = await realpath(resolve(videoFile))
      const sourceStat = await stat(sourcePath)
      if (!sourceStat.isFile() || sourceStat.size <= 0) throw new Error('视频文件无效')
      const maxBytes = Number(process.env.AIWORKER_MEDIA_MAX_FILE_BYTES || 2 * 1024 ** 3)
      if (!Number.isFinite(maxBytes) || sourceStat.size > maxBytes) throw new Error('视频文件超过允许大小')
      const extension = extname(sourcePath).toLowerCase()
      if (!['.mp4', '.mov', '.mkv', '.webm', '.m4v'].includes(extension)) {
        throw new Error('视频格式只支持 mp4、mov、mkv、webm 或 m4v')
      }
      const inbox = resolve(process.env.AIWORKER_MEDIA_INGEST_DIR
        || join(homedir(), 'ai-worker/state/video-autoworker/media-inbox'))
      await mkdir(inbox, { recursive: true, mode: 0o700 })
      await chmod(inbox, 0o700)
      const videoKey = `${randomUUID()}${extension}`
      stagedVideo = join(inbox, videoKey)
      await copyFile(sourcePath, stagedVideo, constants.COPYFILE_EXCL)
      await chmod(stagedVideo, 0o600)
    }

    const response = await request('/api/n8n/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bindingId: binding.id,
        taskId,
        idempotencyKey,
        source: 'openclaw',
        input: {
          prompt: prompt.trim(),
          ...(stagedVideo ? { videoKey: stagedVideo.split('/').pop() } : {}),
        },
        ...(Object.keys(routingNodes).length ? { routing: { nodes: routingNodes } } : {}),
        delivery: {
          mode: deliveryMode,
          ...(sessionKey ? { sessionKey } : {}),
          ...(channel ? { channel } : {}),
          ...(target ? { target } : {}),
          ...(accountId ? { accountId } : {}),
        },
      }),
    })
    if (response.duplicate && stagedVideo) {
      await rm(stagedVideo, { force: true })
      stagedVideo = null
    } else if (stagedVideo) {
      // n8n now owns the managed inbox copy. A later client-side wait timeout
      // must not delete media that an accepted workflow may still consume.
      stagedVideo = null
    }

    const waitSecondsRaw = option('--wait-seconds') || '0'
    const waitSeconds = Number(waitSecondsRaw)
    if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 1_800) {
      throw new Error('--wait-seconds 必须是 0 到 1800 的整数')
    }
    let finalRun = null
    const deadline = Date.now() + waitSeconds * 1_000
    while (waitSeconds > 0 && Date.now() <= deadline) {
      const statusBody = await request(`/api/n8n/runs?taskId=${encodeURIComponent(response.taskId)}`)
      finalRun = Array.isArray(statusBody?.runs)
        ? statusBody.runs.find(item => item?.taskId === response.taskId) || null
        : null
      if (finalRun && ['succeeded', 'failed'].includes(finalRun.status)) break
      await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
    }
    if (waitSeconds > 0 && (!finalRun || !['succeeded', 'failed'].includes(finalRun.status))) {
      throw new Error(`等待任务 ${response.taskId} 超时，可使用 --status 继续查询`)
    }
    process.stdout.write(`${JSON.stringify({
      taskId: response.taskId,
      status: finalRun?.status || response.status || response.result?.data?.status || 'accepted',
      duplicate: Boolean(response.duplicate),
      bindingId: binding.id,
      ...(finalRun ? { output: finalRun.output, error: finalRun.error } : {}),
      ...(Object.keys(routingNodes).length ? { routes: routingNodes } : {}),
    })}\n`)
  } catch (error) {
    if (stagedVideo) await rm(stagedVideo, { force: true }).catch(() => undefined)
    throw error
  }
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)))
