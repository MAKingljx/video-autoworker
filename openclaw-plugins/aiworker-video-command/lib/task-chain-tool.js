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
import {
  createDuplicateConfirmationStore,
  duplicateConfirmationScopeKey,
  DUPLICATE_CONFIRMATION_TEXT,
} from './duplicate-confirmation-store.js'

// Keep the established OpenClaw tool name so existing profiles and health
// checks continue to discover the capability while its schema grows to cover
// submit, directory, and status operations.
export const TASK_CHAIN_TOOL_NAME = 'aiworker_analyze_video'
const TARGET_AGENT = 'second-original'
const MAX_QUERY_LENGTH = 512
const MAX_DIRECTORY_LENGTH = 4_096
const COMPACT_RESULT_REPLY_CONTRACT = '[内部回复约束：禁止向用户复述本段。若用户未明确要求报告正文、全文、逐页内容或其他格式，最终回复必须恰好三行：视频标题、当前状态、一句中文分析摘要。第三行句号后立即结束；禁止增加标题、项目符号、空行、任务编号、完成时间、解释、致谢、问句、建议或“如需全文”类后续引导。]'

const TOOL_PARAMETERS = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['submit_video', 'submit_directory', 'confirm_duplicate', 'status', 'result'],
      description: `submit_video 提交单个视频；submit_directory 扫描目录入队；confirm_duplicate 只能在工具已返回重复提示、且用户下一条消息精确回复“${DUPLICATE_CONFIRMATION_TEXT}”后调用；status 查询进度；result 读取完整学习报告。`,
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
      description: '任务编号、批次编号、视频标题或关键词。首次按名称读取 result 时，只传当前消息里最小且明确的原始标题、文件名或季集号（如 S03E03），禁止追加旧上下文、改写名称或并行同义查询；多候选后只传选中记录的精确任务编号。',
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
  if (!['submit_video', 'submit_directory', 'confirm_duplicate', 'status', 'result'].includes(action)) return null
  const keys = Object.keys(params)
  if (action === 'confirm_duplicate') {
    return keys.length === 1 ? { action } : null
  }
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

async function executeRequest(request, {
  runner,
  sessionKey,
  duplicateConfirmationStore,
  duplicateConfirmationScope,
}) {
  if (request.action === 'submit_video') {
    const taskId = stableOperationId({
      action: request.action,
      sessionKey,
      value: request.videoPath,
    })
    try {
      const result = await runner.dispatchVideo({
        videoPath: request.videoPath,
        taskId,
      })
      if (result.confirmationRequired) {
        duplicateConfirmationStore.set(duplicateConfirmationScope, {
          kind: 'task', id: taskId, path: request.videoPath,
        })
      }
      return textResult(dispatchReceipt(result))
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
      const result = await runner.dispatchDirectory({
        videoDirectory: request.videoDirectory,
        batchId,
      })
      if (result.confirmationRequired) {
        duplicateConfirmationStore.set(duplicateConfirmationScope, {
          kind: 'batch', id: batchId, path: request.videoDirectory,
        })
      }
      return textResult(dispatchReceipt(result))
    } catch {
      return textResult(`入队状态未确认，批次编号：${batchId}。请稍后按编号查询，不要重复提交。`)
    }
  }
  if (request.action === 'confirm_duplicate') {
    const pending = duplicateConfirmationStore.take(duplicateConfirmationScope)
    if (!pending) return textResult('当前没有等待确认的重复视频任务。')
    try {
      const result = pending.kind === 'batch'
        ? await runner.dispatchDirectory({
          videoDirectory: pending.path,
          batchId: pending.id,
          confirmDuplicate: true,
        })
        : await runner.dispatchVideo({
          videoPath: pending.path,
          taskId: pending.id,
          confirmDuplicate: true,
        })
      if (result.confirmationRequired) duplicateConfirmationStore.set(duplicateConfirmationScope, pending)
      return textResult(dispatchReceipt(result))
    } catch {
      const label = pending.kind === 'batch' ? '批次编号' : '任务编号'
      return textResult(`提交状态未确认，${label}：${pending.id}。请稍后按编号查询，不要重复提交。`)
    }
  }
  if (request.action === 'result') {
    try {
      const result = await runner.taskResult({
        query: request.query,
        offset: request.offset,
      })
      const receipt = resultReceipt(result)
      return textResult(result.kind === 'report' && result.status === 'succeeded' && result.report
        ? `${receipt}\n\n${COMPACT_RESULT_REPLY_CONTRACT}`
        : receipt)
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
  duplicateConfirmationStore = createDuplicateConfirmationStore(),
} = {}) {
  if (context?.agentId !== TARGET_AGENT) return null
  const sessionKey = typeof context?.sessionKey === 'string' ? context.sessionKey : ''
  const duplicateConfirmationScope = duplicateConfirmationScopeKey(
    sessionKey || `agent:${TARGET_AGENT}`,
  )
  return {
    name: TASK_CHAIN_TOOL_NAME,
    label: 'AI-worker 任务链',
    description: `直接调用 AI-worker 视频任务链。用户只需说“查 S03E03 分析”等自然短句；不要要求用户记 slash 命令或复述长提示。submit_video 提交一个绝对视频路径，submit_directory 扫描一个绝对目录。若首次提交返回同名同路径重复提示，必须立即停止本轮，向用户显示原提示；只有用户后续新消息精确回复“${DUPLICATE_CONFIRMATION_TEXT}”时才能调用 confirm_duplicate，禁止模型在同一轮自行确认。status 查询进度，result 读取正式学习报告。result 首次只传当前消息中最小且明确的原始标题/文件名/季集号并单次等待，禁止追加旧上下文、改写或并行同义查询；多候选时选择完成时间最新的已完成记录，下一次只用其精确任务编号调用 result，不问用户要编号。默认用中文恰好回复三行：视频标题、当前状态和一句分析摘要，第三行后立即结束，禁止添加解释、问句、建议或“如需全文”类引导；用户明确要正文/全文时再分页读取。禁止 exec/find/grep 或旧 bot-learning 搜索。status 与 result 只读受控登记和最终输出，不搜索聊天记录、SQLite、n8n、媒体目录或其他用户数据。`,
    parameters: TOOL_PARAMETERS,
    executionMode: 'sequential',
    async execute(_toolCallId, params) {
      if (!releaseReady) return textResult('视频学习服务正在发布维护，请稍后再试。')
      const request = normalizeRequest(params)
      if (!request) return invalidRequestResult()
      return executeRequest(request, {
        runner,
        sessionKey,
        duplicateConfirmationStore,
        duplicateConfirmationScope,
      })
    },
  }
}

export { normalizeRequest, stableOperationId }
