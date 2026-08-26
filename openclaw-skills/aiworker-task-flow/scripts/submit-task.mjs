#!/usr/bin/env node

import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, open, readFile, rm, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPlatformClient, isRetryablePlatformError } from '../lib/platform-client.mjs'
import { defaultMediaInboxRoot } from '../lib/media-ingest.mjs'
import {
  resolveAuthoritativeTaskRecord,
  toPublicDurableTaskStatus,
} from '../lib/task-status-authority.mjs'
import {
  paginateVideoReport,
  parseResultOffset,
  selectFinalVideoReport,
} from '../lib/video-result-page.mjs'
import {
  batchStatePath,
  createBatchState,
  createSingleVideoState,
  defaultBatchRoot,
  markBatchQueued,
  readBatchState,
  readSingleVideoTaskState,
  searchVideoTaskStates,
  summarizeBatchState,
  validateBatchId,
} from '../lib/video-batch-state.mjs'

const args = process.argv.slice(2)
const VIDEO_ACTION = /(?:分析|解析|处理|识别|总结)/u
const VIDEO_SUBJECT = /(?:视频|影片|录像|video|\/[^\r\n\0]*\.(?:3gp|avi|flv|m4v|mkv|mov|mp4|mpeg|mpg|ts|webm|wmv))/iu
const VALUE_OPTIONS = new Set([
  '--account-id', '--base-url', '--batch-id', '--batch-status', '--binding-id', '--channel',
  '--delivery', '--executor-route', '--idempotency-key', '--planner-route', '--prompt',
  '--prompt-file', '--resume-batch', '--reviewer-route', '--session-key', '--status', '--target',
  '--result', '--result-offset', '--search-status', '--status-brief', '--task-id', '--video-dir', '--video-file', '--vision-route', '--wait-seconds',
])
const FLAG_OPTIONS = new Set(['--confirm-duplicate', '--no-trigger-recovery', '--resume-pending'])
const DIRECT_VIDEO_TASK_ID = /^(?:video-command|video-natural)-[a-f0-9]{64}$/u
const BATCH_VIDEO_TASK_ID = /^video-batch-[a-f0-9]{64}:video:\d{3}:[a-f0-9]{12}$/u
const VIDEO_BATCH_ID = /^video-batch-[a-f0-9]{64}$/u

function option(name) {
  const index = args.indexOf(name)
  if (index < 0) return null
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} 缺少参数值`)
  return value
}

function flag(name) {
  return args.includes(name)
}

function validateCliArguments() {
  const present = new Set()
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!VALUE_OPTIONS.has(argument) && !FLAG_OPTIONS.has(argument)) {
      throw new Error(`未知参数：${argument}`)
    }
    if (present.has(argument)) throw new Error(`参数不能重复：${argument}`)
    present.add(argument)
    if (VALUE_OPTIONS.has(argument)) {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} 缺少参数值`)
      index += 1
    }
  }

  if (present.has('--prompt') && present.has('--prompt-file')) {
    throw new Error('--prompt 与 --prompt-file 不能同时使用')
  }
  const primaryModes = [
    '--batch-status', '--resume-batch', '--resume-pending', '--result', '--search-status', '--status', '--status-brief', '--video-dir', '--video-file',
  ]
    .filter(name => present.has(name))
  if (primaryModes.length > 1) throw new Error(`任务模式参数不能同时使用：${primaryModes.join('、')}`)
  if (present.has('--batch-id') !== present.has('--video-dir')) {
    throw new Error('--video-dir 必须与 --batch-id 同时使用')
  }
  if (present.has('--result-offset') && !present.has('--result')) {
    throw new Error('--result-offset 必须与 --result 一起使用')
  }

  const mode = primaryModes[0] || 'generic'
  const allowedByMode = {
    '--batch-status': new Set(['--batch-status']),
    '--resume-batch': new Set(['--resume-batch']),
    '--resume-pending': new Set(['--resume-pending']),
    '--result': new Set(['--result', '--result-offset', '--base-url']),
    '--status': new Set(['--status', '--base-url']),
    '--status-brief': new Set(['--status-brief', '--base-url']),
    '--search-status': new Set(['--search-status']),
    '--video-dir': new Set([
      '--video-dir', '--batch-id', '--base-url', '--binding-id', '--prompt', '--prompt-file',
      '--vision-route', '--delivery', '--confirm-duplicate',
    ]),
    '--video-file': new Set([
      '--video-file', '--base-url', '--binding-id', '--prompt', '--prompt-file', '--vision-route',
      '--delivery', '--session-key', '--channel', '--target', '--account-id', '--task-id',
      '--idempotency-key', '--wait-seconds', '--no-trigger-recovery', '--confirm-duplicate',
    ]),
    generic: new Set([
      '--base-url', '--binding-id', '--prompt', '--prompt-file', '--planner-route',
      '--executor-route', '--reviewer-route', '--vision-route', '--delivery', '--session-key',
      '--channel', '--target', '--account-id', '--task-id', '--idempotency-key', '--wait-seconds',
    ]),
  }
  const disallowed = [...present].filter(name => !allowedByMode[mode].has(name))
  if (disallowed.length) throw new Error(`${mode} 模式不支持参数：${disallowed.join('、')}`)
}

function fail(message, code = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(code)
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

function compactStatusOutput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const summary = typeof value.summary === 'string'
    ? value.summary.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim()
    : ''
  return summary ? { summary: summary.slice(0, 160) } : null
}

function resultDisplayName(value) {
  const name = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  return name && name.length <= 180 ? name : null
}

function resultTimestamp(value) {
  const timestamp = String(value || '').trim()
  if (!timestamp || timestamp.length > 64 || !Number.isFinite(Date.parse(timestamp))) return null
  return timestamp
}

function publicDuplicateConfirmation(historical) {
  const matches = Array.isArray(historical?.matches) ? historical.matches : []
  const names = [...new Set(matches
    .map(match => resultDisplayName(match?.name))
    .filter(Boolean))].slice(0, 10)
  return {
    duplicateCount: Number.isInteger(historical?.total) && historical.total > 0
      ? historical.total
      : names.length,
    duplicateNames: names,
    truncated: historical?.truncated === true,
  }
}

function publicResultMatch(match) {
  const kind = match.kind === 'batch' ? 'batch' : 'task'
  const taskId = typeof match.taskId === 'string'
    && (DIRECT_VIDEO_TASK_ID.test(match.taskId) || BATCH_VIDEO_TASK_ID.test(match.taskId))
    ? match.taskId
    : null
  const batchId = kind === 'batch'
    && typeof match.batchId === 'string'
    && VIDEO_BATCH_ID.test(match.batchId)
    ? match.batchId
    : null
  return {
    kind,
    taskId,
    batchId,
    index: kind === 'batch' && Number.isInteger(match.index) ? match.index : null,
    name: resultDisplayName(match.name) || '未命名视频',
    status: String(match.status || 'unknown'),
    completedAt: resultTimestamp(match.completedAt),
    updatedAt: resultTimestamp(match.updatedAt),
  }
}

async function resolveResultTarget(query) {
  if (DIRECT_VIDEO_TASK_ID.test(query)) return { taskId: query, name: null, status: null }
  const search = await searchVideoTaskStates(query)
  if (search.total !== 1 || search.truncated || search.matches.length !== 1) {
    return {
      matches: search.matches.map(publicResultMatch),
      total: search.total,
      truncated: search.truncated,
    }
  }
  const match = search.matches[0]
  if (typeof match?.taskId !== 'string' || !match.taskId) {
    throw new Error('正式学习报告任务登记无效')
  }
  return {
    taskId: match.taskId,
    name: resultDisplayName(match.name),
    status: String(match.status || 'unknown'),
  }
}

async function handleResult(client, query, offset) {
  const resolved = await resolveResultTarget(query)
  if ('matches' in resolved) {
    output({ kind: 'matches', ...resolved })
    return
  }
  const run = await client.getRun(resolved.taskId)
  if (!run) {
    output({
      kind: 'report',
      taskId: resolved.taskId,
      name: resolved.name,
      status: resolved.status || 'unknown',
      report: null,
    })
    return
  }
  const status = String(run.status || 'unknown')
  const finalReport = status === 'succeeded' ? selectFinalVideoReport(run.output) : null
  output({
    kind: 'report',
    taskId: resolved.taskId,
    name: resolved.name,
    status,
    report: finalReport ? {
      source: finalReport.source,
      ...paginateVideoReport(finalReport.text, offset),
    } : null,
  })
}

function rejectGenericVideoPrompt(prompt) {
  if (VIDEO_ACTION.test(prompt) && VIDEO_SUBJECT.test(prompt)) {
    throw new Error('视频会话请求只能由已加载的原生视频插件提交')
  }
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

async function spawnBatchWorker({ batchRoot = defaultBatchRoot() } = {}) {
  const worker = fileURLToPath(new URL('./run-video-batch.mjs', import.meta.url))
  await mkdir(batchRoot, { recursive: true, mode: 0o700 })
  const launchLockPath = resolve(batchRoot, '.worker-launch.lock')
  let launchLock
  try {
    launchLock = await open(launchLockPath, 'wx', 0o600)
  } catch (error) {
    if (error?.code === 'EEXIST') {
      const lockStat = await stat(launchLockPath).catch(() => null)
      if (lockStat && Date.now() - lockStat.mtimeMs < 30_000) return false
      await rm(launchLockPath, { force: true })
      launchLock = await open(launchLockPath, 'wx', 0o600)
    } else {
      throw error
    }
  }
  try {
    await launchLock.writeFile(`${JSON.stringify({
      pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`)
    await launchLock.sync()
  } catch (error) {
    await launchLock.close().catch(() => undefined)
    await rm(launchLockPath, { force: true }).catch(() => undefined)
    throw error
  }
  try {
    const child = spawn(process.execPath, [worker, '--serve-root', batchRoot], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    await new Promise((resolvePromise, rejectPromise) => {
      let settled = false
      const finish = callback => value => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        callback(value)
      }
      const succeed = finish(resolvePromise)
      const failWorker = finish(error => rejectPromise(error))
      const timeout = setTimeout(succeed, 100)
      child.once('error', error => failWorker(new Error(`视频队列 worker 启动失败：${error.message}`)))
      child.once('exit', code => {
        if (!settled && code === 0) succeed()
        else if (!settled) failWorker(new Error(
          `视频队列 worker 启动失败${Number.isInteger(code) ? `（退出码 ${code}）` : ''}`,
        ))
      })
    })
    child.unref()
    return true
  } catch (error) {
    // A launcher lock is only a short handoff semaphore. If the child could
    // not be spawned, remove it immediately so the next submission is not
    // held behind a false in-flight marker.
    await rm(launchLockPath, { force: true }).catch(() => undefined)
    throw error
  } finally {
    await launchLock?.close().catch(() => undefined)
  }
}

async function readPromptInput() {
  const promptFile = option('--prompt-file')
  const promptArg = option('--prompt')
  return promptFile ? await readFile(promptFile, 'utf8') : promptArg
}

async function resolvePrompt({ video = false, promptInput } = {}) {
  const prompt = (promptInput ?? await readPromptInput())
    || (video ? '分析视频中的语音内容和画面信息，分别给出结果后合并。' : '')
  if (!prompt?.trim()) throw new Error('必须通过 --prompt-file、--prompt 或视频参数提供任务内容')
  if (prompt.length > 120_000) throw new Error('任务内容超过 120000 字符上限')
  return prompt.trim()
}

async function handleBatchStatus(batchId) {
  const safeBatchId = validateBatchId(batchId)
  try {
    const state = await readBatchState(batchStatePath(safeBatchId))
    output(summarizeBatchState(state))
  } catch (error) {
    if (error?.code === 'ENOENT') {
      output({
        batchId: safeBatchId,
        status: 'not_registered',
        stateAvailable: false,
        total: 0,
        counts: {},
        current: null,
        items: [],
        error: '批次状态未登记，无法验证进度；未执行恢复或提交。',
        updatedAt: null,
      })
      return
    }
    if (error?.code === 'EBADSTATE') {
      output({
        batchId: safeBatchId,
        status: 'unavailable',
        stateAvailable: false,
        total: 0,
        counts: {},
        current: null,
        items: [],
        error: '批次状态文件损坏且备份不可用，无法验证进度；未执行恢复或提交。',
        updatedAt: null,
      })
      return
    }
    throw error
  }
}

async function handleBatchResume(batchId) {
  const statePath = batchStatePath(validateBatchId(batchId))
  let state = await readBatchState(statePath)
  if (!['succeeded', 'completed_with_errors'].includes(state.status)) {
    state = await markBatchQueued(statePath)
    await spawnBatchWorker()
  }
  output({ ...summarizeBatchState(state), resumed: !['succeeded', 'completed_with_errors'].includes(state.status) })
}

async function handlePendingResume() {
  await spawnBatchWorker()
  output({ resumed: true })
}

async function handleStatusSearch(query) {
  output(await searchVideoTaskStates(query))
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
    confirmDuplicate: flag('--confirm-duplicate'),
  })
  if (created.confirmationRequired) {
    output({
      batchId,
      status: 'confirmation_required',
      duplicate: false,
      confirmationRequired: true,
      ...publicDuplicateConfirmation(created.historical),
    })
    return
  }
  if (!['succeeded', 'completed_with_errors'].includes(created.state.status)) {
    await spawnBatchWorker()
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
  validateCliArguments()
  const batchStatus = option('--batch-status')
  if (batchStatus) return handleBatchStatus(batchStatus)
  const resumeBatch = option('--resume-batch')
  if (resumeBatch) return handleBatchResume(resumeBatch)
  if (flag('--resume-pending')) return handlePendingResume()
  const searchStatus = option('--search-status')
  if (searchStatus) return handleStatusSearch(searchStatus)

  const client = createPlatformClient(option('--base-url') || process.env.AIWORKER_PLATFORM_URL || 'http://127.0.0.1:3017')
  const resultQuery = option('--result')
  if (resultQuery) return handleResult(client, resultQuery, parseResultOffset(option('--result-offset')))
  const statusTaskId = option('--status') || option('--status-brief')
  const briefStatus = Boolean(option('--status-brief'))
  if (statusTaskId) {
    const selected = await resolveAuthoritativeTaskRecord({
      loadPlatformRecord: () => client.getRun(statusTaskId),
      loadDurableRecord: async () => {
        const local = await readSingleVideoTaskState(statusTaskId).catch(error => {
          if (error?.code === 'ENOENT') return null
          throw error
        })
        return local
          ? {
            taskId: statusTaskId,
            status: toPublicDurableTaskStatus(local.item.status),
            output: null,
            error: local.item.error || null,
            updatedAt: local.state.updatedAt,
          }
          : null
      },
      isPlatformUnavailable: isRetryablePlatformError,
    })
    if (!selected) throw new Error(`未找到任务：${statusTaskId}`)
    if (selected.source !== 'platform') {
      output(selected.record)
      return
    }
    const run = selected.record
    output({
      taskId: run.taskId,
      status: run.status,
      attemptCount: run.attemptCount,
      maxAttempts: run.maxAttempts,
      output: briefStatus ? compactStatusOutput(run.output) : run.output,
      error: run.error,
      updatedAt: run.updatedAt,
    })
    return
  }

  const videoDir = option('--video-dir')
  if (videoDir) return handleBatchCreate(client, videoDir)

  const videoFile = option('--video-file')
  const promptInput = await readPromptInput()
  const prompt = await resolvePrompt({
    video: Boolean(videoFile),
    promptInput,
  })
  if (!videoFile) rejectGenericVideoPrompt(prompt)
  const bindings = await client.listBindings()
  const binding = chooseBinding(
    bindings,
    option('--binding-id'),
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
  const noTriggerRecovery = flag('--no-trigger-recovery')
  if (noTriggerRecovery && !videoFile) {
    throw new Error('--no-trigger-recovery 仅用于视频单次派发')
  }
  const waitSeconds = Number(option('--wait-seconds') || '0')
  if (noTriggerRecovery && waitSeconds !== 0) {
    throw new Error('--no-trigger-recovery 必须与 --wait-seconds 0 一起使用')
  }
  let taskId
  let idempotencyKey
  if (videoFile) {
    if (!requestedTaskId || !requestedIdempotencyKey || requestedTaskId !== requestedIdempotencyKey) {
      throw new Error('视频任务必须提供相同的 --task-id 与 --idempotency-key')
    }
    taskId = requestedTaskId
    idempotencyKey = requestedIdempotencyKey
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

  if (videoFile) {
    const created = await createSingleVideoState({
      taskId,
      idempotencyKey,
      baseUrl: client.baseUrl,
      bindingId: binding.id,
      prompt,
      videoFile,
      visionRoute: option('--vision-route'),
      inboxRoot: defaultMediaInboxRoot(),
      confirmDuplicate: flag('--confirm-duplicate'),
    })
    if (created.confirmationRequired) {
      output({
        taskId,
        status: 'confirmation_required',
        duplicate: false,
        confirmationRequired: true,
        ...publicDuplicateConfirmation(created.historical),
      })
      return
    }
    if (!['succeeded', 'completed_with_errors'].includes(created.state.status)) {
      await spawnBatchWorker()
    }
    const item = created.state.items[0]
    output({
      taskId,
      status: item.status,
      duplicate: created.duplicate,
      bindingId: binding.id,
    })
    return
  }

  const response = await client.trigger({
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

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error))
})
