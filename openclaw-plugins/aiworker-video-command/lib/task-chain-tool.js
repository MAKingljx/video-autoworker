import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

import {
  dispatchReceipt,
  queryStatusSearch,
  resultReceipt,
  statusReceipt,
} from './qwen-before-dispatch.js'
import {
  isSchedulerBatchId,
  isSchedulerTaskId,
  schedulerRunner,
} from './scheduler-runner.js'
import { validateVideoPath } from './video-path-policy.js'

// Keep the established OpenClaw tool name so existing profiles and health
// checks continue to discover the capability while its schema grows to cover
// submit, directory, and status operations.
export const TASK_CHAIN_TOOL_NAME = 'aiworker_analyze_video'
const TARGET_AGENT = 'second-original'
const MAX_QUERY_LENGTH = 512
const MAX_DIRECTORY_LENGTH = 4_096

const TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['submit_video', 'submit_directory', 'status', 'result'],
      description: 'submit_video 提交单个视频；submit_directory 扫描目录入队；status 查询进度；result 读取完整学习报告。',
    },
    videoPath: {
      type: 'string',
      minLength: 1,
      maxLength: 4_096,
      description: '要学习的本地绝对视频文件路径。',
    },
    videoDirectory: {
      type: 'string',
      minLength: 1,
      maxLength: 4_096,
      description: '要自动扫描并学习的本地绝对目录路径。',
    },
    query: {
      type: 'string',
      minLength: 1,
      maxLength: MAX_QUERY_LENGTH,
      description: '任务编号、批次编号、视频标题或关键词。由任务链受控登记搜索。',
    },
    offset: {
      type: 'integer',
      minimum: 0,
      maximum: 16777216,
      description: 'result 的下一页偏移；首次读取省略或传 0。',
    },
  },
})

function textResult(text) {
  return { content: [{ type: 'text', text }] }
}

function canonicalDirectory(value) {
  return typeof value === 'string'
    && value === value.trim()
    && value.length > 0
    && value.length <= MAX_DIRECTORY_LENGTH
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && isAbsolute(value)
    && !value.startsWith('//')
    && normalize(value) === value
    ? value
    : null
}

function normalizeRequest(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return null
  const action = params.action
  if (!['submit_video', 'submit_directory', 'status', 'result'].includes(action)) return null
  const keys = Object.keys(params)
  if (action === 'submit_video') {
    if (keys.sort().join(',') !== 'action,videoPath') return null
    // Structured tool arguments have no shell-style ambiguity, so paths with
    // spaces do not need the quoting rule used for free-form chat parsing.
    const checked = validateVideoPath(params.videoPath, { quoted: true })
    return checked.ok ? { action, videoPath: checked.videoPath } : null
  }
  if (action === 'submit_directory') {
    if (keys.sort().join(',') !== 'action,videoDirectory') return null
    const videoDirectory = canonicalDirectory(params.videoDirectory)
    return videoDirectory ? { action, videoDirectory } : null
  }
  if (action === 'result') {
    const expected = keys.sort().join(',')
    if (expected !== 'action,query' && expected !== 'action,offset,query') return null
    if (!Number.isInteger(params.offset ?? 0) || (params.offset ?? 0) < 0 || (params.offset ?? 0) > 16 * 1024 * 1024) {
      return null
    }
  } else if (keys.sort().join(',') !== 'action,query') return null
  if (
    typeof params.query !== 'string'
    || params.query !== params.query.trim()
    || !params.query
    || params.query.length > MAX_QUERY_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(params.query)
  ) return null
  return action === 'result'
    ? { action, query: params.query, offset: params.offset ?? 0 }
    : { action, query: params.query }
}

function stableOperationId({ action, sessionKey, value }) {
  const digest = createHash('sha256')
    .update('aiworker-task-chain-tool:v1\0', 'utf8')
    .update(action, 'utf8')
    .update('\0', 'utf8')
    .update(sessionKey || 'agent:second-original', 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex')
  return action === 'submit_directory' ? `video-batch-${digest}` : `video-command-${digest}`
}

function invalidRequestResult() {
  return textResult('任务链参数无效：请提供 action，以及对应的 videoPath、videoDirectory 或 query。')
}

async function executeRequest(request, { runner, sessionKey }) {
  if (request.action === 'submit_video') {
    const taskId = stableOperationId({
      action: request.action,
      sessionKey,
      value: request.videoPath,
    })
    try {
      return textResult(dispatchReceipt(await runner.dispatchVideo({
        videoPath: request.videoPath,
        taskId,
      })))
    } catch {
      return textResult(`提交状态未确认，任务编号：${taskId}。请稍后按编号查询，不要重复提交。`)
    }
  }
  if (request.action === 'submit_directory') {
    const batchId = stableOperationId({
      action: request.action,
      sessionKey,
      value: request.videoDirectory,
    })
    try {
      return textResult(dispatchReceipt(await runner.dispatchDirectory({
        videoDirectory: request.videoDirectory,
        batchId,
      })))
    } catch {
      return textResult(`入队状态未确认，批次编号：${batchId}。请稍后按编号查询，不要重复提交。`)
    }
  }
  if (request.action === 'result') {
    try {
      return textResult(resultReceipt(await runner.taskResult({
        query: request.query,
        offset: request.offset,
      })))
    } catch {
      return textResult('暂时无法读取完整学习结果，本次未重试。')
    }
  }
  try {
    if (isSchedulerTaskId(request.query)) {
      return textResult(statusReceipt(await runner.taskStatus({ taskId: request.query })))
    }
    if (isSchedulerBatchId(request.query)) {
      return textResult(statusReceipt(await runner.batchStatus({ batchId: request.query })))
    }
    return textResult(await queryStatusSearch({ runner, query: request.query }))
  } catch {
    return textResult('暂时无法查询视频任务，本次未重试。')
  }
}

export function createTaskChainTool({
  context,
  runner = schedulerRunner,
  releaseReady = true,
} = {}) {
  if (context?.agentId !== TARGET_AGENT) return null
  const sessionKey = typeof context?.sessionKey === 'string' ? context.sessionKey : ''
  return {
    name: TASK_CHAIN_TOOL_NAME,
    label: 'AI-worker 任务链',
    description: '直接调用 AI-worker 视频任务链。收到用户的视频学习、目录扫描、进度查询或完整学习结果请求时使用；不要要求用户记 slash 命令。submit_video 只提交一个绝对视频路径，submit_directory 让任务链自动扫描一个绝对目录，status 查询进度，result 读取正式任务链中的完整学习报告。完整结果必须使用 result 分页读取，禁止 exec/find/grep 或旧 bot-learning 搜索。status 与 result 只读受控任务登记和最终任务输出，不搜索聊天记录、SQLite、n8n 执行记录、媒体目录或其他用户数据。',
    parameters: TOOL_PARAMETERS,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      if (!releaseReady) return textResult('视频学习服务正在发布维护，请稍后再试。')
      const request = normalizeRequest(params)
      if (!request) return invalidRequestResult()
      return executeRequest(request, { runner, sessionKey })
    },
  }
}

export { normalizeRequest, stableOperationId }
