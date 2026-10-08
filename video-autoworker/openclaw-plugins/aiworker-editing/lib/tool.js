import { createEditingClient } from './client.js'

export const EDITING_TOOL_NAME = 'aiworker_edit_video'
const ACTIONS = new Set(['inspect', 'evidence', 'propose', 'status', 'result', 'execute'])
const PARAMETERS = { type: 'object', additionalProperties: false, required: ['action'], properties: {
  action: { type: 'string', enum: [...ACTIONS] }, planId: { type: 'string', minLength: 1, maxLength: 160 },
  revision: { type: 'integer', minimum: 1 }, taskId: { type: 'string', minLength: 1, maxLength: 160 },
  offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
  plan: { type: 'object', properties: { status: { const: 'validated' } }, required: ['status'] },
} }
const text = (message, details) => ({ content: [{ type: 'text', text: message }], details })
const safeId = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\u0000-\u001f]/u.test(value)

/** A review token is reserved for the human browser confirmation path. */
export function stripReviewTokens(value) {
  if (Array.isArray(value)) return value.map(stripReviewTokens)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['reviewToken', 'approvalToken'].includes(key)).map(([key, child]) => [key, stripReviewTokens(child)]))
  return value
}

function validRequest(params) {
  if (!params || typeof params !== 'object' || Array.isArray(params) || !ACTIONS.has(params.action)) return false
  if (Object.keys(params).some(key => !Object.hasOwn(PARAMETERS.properties, key))) return false
  const allowed = { inspect: ['action'], evidence: ['action', 'taskId', 'offset', 'limit'],
    propose: ['action', 'plan'], status: ['action', 'planId', 'revision'],
    result: ['action', 'planId', 'revision'], execute: ['action', 'planId', 'revision'] }
  if (Object.keys(params).some(key => !allowed[params.action].includes(key))) return false
  if (params.action === 'evidence') return safeId(params.taskId)
    && (params.offset === undefined || Number.isSafeInteger(params.offset) && params.offset >= 0)
    && (params.limit === undefined || Number.isSafeInteger(params.limit) && params.limit >= 1 && params.limit <= 50)
  if (params.action === 'propose') return params.plan && typeof params.plan === 'object' && !Array.isArray(params.plan)
    && params.plan.status === 'validated' && !Object.hasOwn(params.plan, 'approved')
    && Buffer.byteLength(JSON.stringify(params.plan)) <= 1024 * 1024
  if (['result', 'execute'].includes(params.action) || params.planId !== undefined || params.revision !== undefined) {
    return safeId(params.planId) && Number.isSafeInteger(params.revision) && params.revision > 0
  }
  return true
}

export function createEditingTool({ context, client = createEditingClient(), releaseReady = false }) {
  if (context?.agentId !== 'main' || typeof context.sessionKey !== 'string' || context.sessionKey.length > 4096
    || /[\u0000-\u001f]/u.test(context.sessionKey)
    || !context.sessionKey.startsWith('agent:main:')) return null
  return { name: EDITING_TOOL_NAME, label: '视频剪辑方案', parameters: PARAMETERS, executionMode: 'sequential',
    description: '通过唯一AI-worker应用服务读取达芬奇连接、成功学习证据和剪辑计划。evidence分页读取已保存摘要，不重新分析视频；propose仅提交status=validated候选，计划须引用完整证据并由用户在审核页明确确认。工具没有approve权限，不接受approved:true，也不自动外发飞书。execute只查询已获人类批准计划的任务状态，未批准时必须提示网页确认，禁止另建任务或绕过审批。unknown表示结果待核对，不是成功，不能重复执行已完成步骤。',
    async execute(_callId, params, signal) {
      if (!releaseReady) return text('剪辑入口尚未启用。', { errorCode: 'EDITING_NOT_READY' })
      if (!validRequest(params)) return text('剪辑请求无效；执行需由用户在审核页确认。', { errorCode: 'EDITING_REQUEST_INVALID' })
      try {
        const data = params.action === 'inspect' ? await client.inspect(signal)
          : params.action === 'evidence' ? await client.evidence(params, signal)
            : params.action === 'propose' ? await client.propose(params.plan, signal) : await client.status(params, signal)
        const details = stripReviewTokens(data)
        if (params.action === 'execute' && data.planStatus !== 'approved') return text('候选方案尚未获人工确认，请用户进入剪辑审核页确认。',
          { ...details, currentState: 'waiting_for_human_approval', nextAction: 'open_editing_review' })
        return text(params.action === 'propose' ? '候选方案已保存，等待用户审核；尚未执行剪辑。'
          : '已读取应用服务的真实状态与证据。', details)
      } catch (error) {
        const code = typeof error.message === 'string' && /^[A-Za-z0-9_:-]{1,100}$/u.test(error.message)
          ? error.message : 'EDITING_SERVICE_UNAVAILABLE'
        return text('剪辑服务暂不可用；请先核对状态，不要重复提交或批准。', { errorCode: code })
      }
    },
  }
}
