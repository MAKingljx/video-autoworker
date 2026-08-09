#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createPlatformClient } from '../lib/platform-client.mjs'
import { defaultMediaInboxRoot } from '../lib/media-ingest.mjs'
import { submitVideoTask } from '../lib/video-task.mjs'
import {
  batchStatePath,
  createBatchState,
  readBatchState,
  summarizeBatchState,
  validateBatchId,
} from '../lib/video-batch-state.mjs'
import { deriveVideoCommandTaskKey, parseExactVideoCommand } from '../lib/video-command.mjs'

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

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function chooseBinding(bindings, requestedBinding, video) {
  const binding = requestedBinding
    ? bindings.find(item => String(item.id) === requestedBinding && item.enabled)
    : video
      ? bindings.find(item => item.enabled && item.taskType === 'video-analysis')
      : bindings.find(item => item.enabled && item.taskType !== 'video-analysis')
        || bindings.find(item => item.enabled)
  if (!binding) throw new Error('没有找到可用的 AI-worker n8n 任务链')
  if (video && binding.taskType !== 'video-analysis') {
    throw new Error('视频任务必须使用启用的 video-analysis binding')
  }
  return binding
}

function spawnBatchWorker(statePath) {
  const worker = fileURLToPath(new URL('./run-video-batch.mjs', import.meta.url))
  const child = spawn(process.execPath, [worker, '--state-file', statePath], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
}

async function readPromptInput() {
  const promptFile = option('--prompt-file')
  const promptArg = option('--prompt')
  return promptFile ? await readFile(promptFile, 'utf8') : promptArg
}

async function resolvePrompt({ video = false, promptInput, forceVideoDefault = false } = {}) {
  const prompt = forceVideoDefault
    ? '分析视频中的语音内容和画面信息，分别给出结果后合并。'
    : (promptInput ?? await readPromptInput())
      || (video ? '分析视频中的语音内容和画面信息，分别给出结果后合并。' : '')
  if (!prompt?.trim()) throw new Error('必须通过 --prompt-file、--prompt 或视频参数提供任务内容')
  if (prompt.length > 120_000) throw new Error('任务内容超过 120000 字符上限')
  return prompt.trim()
}

async function handleBatchStatus(batchId) {
  const state = await readBatchState(batchStatePath(validateBatchId(batchId)))
  output(summarizeBatchState(state))
}

async function handleBatchResume(batchId) {
  const statePath = batchStatePath(validateBatchId(batchId))
  const state = await readBatchState(statePath)
  if (!['succeeded', 'completed_with_errors'].includes(state.status)) spawnBatchWorker(statePath)
  output({ ...summarizeBatchState(state), resumed: !['succeeded', 'completed_with_errors'].includes(state.status) })
}

async function handleBatchCreate(client, videoDir) {
  const batchId = validateBatchId(option('--batch-id'))
  const prompt = await resolvePrompt({ video: true })
  const deliveryMode = option('--delivery') || 'none'
  if (deliveryMode !== 'none') throw new Error('批量视频工作节点不进入 OpenClaw 会话；请用批次状态查询结果')
  const bindings = await client.listBindings()
  const binding = chooseBinding(bindings, option('--binding-id'), true)
  const created = await createBatchState({
    batchId,
    baseUrl: client.baseUrl,
    bindingId: binding.id,
    prompt,
    visionRoute: option('--vision-route'),
    videoDir,
    inboxRoot: defaultMediaInboxRoot(),
  })
  if (!['succeeded', 'completed_with_errors'].includes(created.state.status)) {
    spawnBatchWorker(created.statePath)
  }
  output({
    ...summarizeBatchState(created.state),
    duplicate: created.duplicate,
    bindingId: binding.id,
  })
}

async function waitForTask(client, taskId, waitSeconds) {
  if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 14_400) {
    throw new Error('--wait-seconds 必须是 0 到 14400 的整数')
  }
  let run = null
  const deadline = Date.now() + waitSeconds * 1_000
  while (waitSeconds > 0 && Date.now() <= deadline) {
    run = await client.getRun(taskId)
    if (run && ['succeeded', 'failed'].includes(run.status)) break
    await new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))
  }
  if (waitSeconds > 0 && (!run || !['succeeded', 'failed'].includes(run.status))) {
    throw new Error(`等待任务 ${taskId} 超时，可使用 --status 继续查询`)
  }
  return run
}

async function main() {
  const batchStatus = option('--batch-status')
  if (batchStatus) return handleBatchStatus(batchStatus)
  const resumeBatch = option('--resume-batch')
  if (resumeBatch) return handleBatchResume(resumeBatch)

  const client = createPlatformClient(option('--base-url') || process.env.AIWORKER_PLATFORM_URL || 'http://127.0.0.1:3017')
  const statusTaskId = option('--status')
  if (statusTaskId) {
    const run = await client.getRun(statusTaskId)
    if (!run) throw new Error(`未找到任务：${statusTaskId}`)
    output({
      taskId: run.taskId,
      status: run.status,
      attemptCount: run.attemptCount,
      maxAttempts: run.maxAttempts,
      output: run.output,
      error: run.error,
      updatedAt: run.updatedAt,
    })
    return
  }

  const videoDir = option('--video-dir')
  if (videoDir) return handleBatchCreate(client, videoDir)

  let videoFile = option('--video-file')
  let promptInput
  let inferredVideoCommand = false
  if (!videoFile) {
    promptInput = await readPromptInput()
    const inferredVideoFile = parseExactVideoCommand(promptInput)
    if (inferredVideoFile) {
      videoFile = inferredVideoFile
      inferredVideoCommand = true
    }
  }

  const prompt = await resolvePrompt({
    video: Boolean(videoFile),
    promptInput,
    forceVideoDefault: inferredVideoCommand,
  })
  const bindings = await client.listBindings()
  const binding = chooseBinding(
    bindings,
    inferredVideoCommand ? null : option('--binding-id'),
    Boolean(videoFile),
  )
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

  const requestedTaskId = option('--task-id')
  const requestedIdempotencyKey = option('--idempotency-key')
  let taskId
  let idempotencyKey
  if (inferredVideoCommand) {
    if (requestedTaskId && requestedIdempotencyKey && requestedTaskId !== requestedIdempotencyKey) {
      throw new Error('视频命令的 --task-id 与 --idempotency-key 必须相同')
    }
    taskId = requestedTaskId
      || requestedIdempotencyKey
      || deriveVideoCommandTaskKey(videoFile)
    idempotencyKey = taskId
  } else {
    taskId = requestedTaskId || randomUUID()
    idempotencyKey = requestedIdempotencyKey || taskId
  }
  const routingNodes = Object.fromEntries([
    ['planner', option('--planner-route')],
    ['executor', option('--executor-route')],
    ['reviewer', option('--reviewer-route')],
    ['vision', option('--vision-route')],
  ].filter(([, routeId]) => Boolean(routeId)).map(([nodeKey, routeId]) => [
    nodeKey,
    { routeId, fallbackRouteIds: [] },
  ]))

  const response = videoFile
    ? await submitVideoTask({
      client,
      bindingId: binding.id,
      taskId,
      idempotencyKey,
      prompt,
      videoFile,
      visionRoute: option('--vision-route'),
      inboxRoot: defaultMediaInboxRoot(),
    })
    : await client.trigger({
      bindingId: binding.id,
      taskId,
      idempotencyKey,
      source: 'openclaw',
      input: { prompt },
      ...(Object.keys(routingNodes).length ? { routing: { nodes: routingNodes } } : {}),
      delivery: {
        mode: deliveryMode,
        ...(sessionKey ? { sessionKey } : {}),
        ...(channel ? { channel } : {}),
        ...(target ? { target } : {}),
        ...(accountId ? { accountId } : {}),
      },
    })

  const waitSeconds = inferredVideoCommand
    ? 0
    : Number(option('--wait-seconds') || '0')
  const finalRun = await waitForTask(client, response.taskId, waitSeconds)
  output({
    taskId: response.taskId,
    status: finalRun?.status || response.status || response.result?.data?.status || 'accepted',
    duplicate: Boolean(response.duplicate),
    bindingId: binding.id,
    ...(response.recoveredAfterTriggerError ? { recoveredAfterTriggerError: true } : {}),
    ...(finalRun ? { output: finalRun.output, error: finalRun.error } : {}),
    ...(Object.keys(routingNodes).length ? { routes: routingNodes } : {}),
  })
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)))
