import {
  deriveTelegramSenderHash,
  normalizeAllowedSenderHash,
  resolveConsistentString,
  resolveDispatchIdentity,
  resolveTelegramConversationIdentity,
  TARGET_CHANNEL,
} from './dispatch-identity.js'
import { createRecentTaskStore } from './recent-task-store.js'
import { runVideoTask } from './runner.js'
import { formatShortReceipt } from './short-receipt.js'
import { runVideoStatus } from './status-runner.js'
import { formatVideoStatusReply } from './video-status-result.js'
import { routeVideoRequest } from './video-request-router.js'

function handledError(text) {
  return { handled: true, text }
}

function rememberTask(store, scopeKey, taskId) {
  try {
    store.set(scopeKey, taskId)
  } catch {
    // A receipt remains authoritative even if the optional recent-task hint
    // cannot be retained. A later query can still use the full task id.
  }
}

function recentTask(store, scopeKey) {
  try {
    return store.get(scopeKey)
  } catch {
    return null
  }
}

function isStatusRequest(request) {
  return request.kind === 'status'
    || request.kind === 'status_needs_task_id'
    || request.kind === 'status_invalid'
}

export function createBeforeDispatchHandler({
  runner = runVideoTask,
  statusRunner = runVideoStatus,
  recentTaskStore = createRecentTaskStore(),
  allowedSenderSha256,
} = {}) {
  const allowedSenderHash = normalizeAllowedSenderHash(allowedSenderSha256)

  return async function handleBeforeDispatch(event, context) {
    const request = routeVideoRequest(event?.content)
    if (request.kind === 'pass') return undefined

    const channel = resolveConsistentString(event?.channel, context?.channelId)
    if (channel === null) {
      return handledError(
        isStatusRequest(request)
          ? '暂时无法查询任务状态。'
          : '提交失败：消息上下文不一致。',
      )
    }
    if (channel !== TARGET_CHANNEL) return undefined
    if (request.kind === 'respond') {
      return event?.isGroup === false
        ? handledError(request.text)
        : undefined
    }
    if (event?.isGroup !== false) {
      return handledError(
        isStatusRequest(request)
          ? '无法查询：仅支持 Telegram 私聊。'
          : '未提交：仅支持 Telegram 私聊。',
      )
    }
    if (request.kind === 'reject') return handledError(request.text)

    if (isStatusRequest(request)) {
      const identity = resolveTelegramConversationIdentity(event, context)
      if (
        !identity.ok
        || !allowedSenderHash
        || deriveTelegramSenderHash(identity.senderId) !== allowedSenderHash
      ) {
        return handledError('暂时无法查询任务状态。')
      }
      if (request.kind === 'status_invalid') {
        return handledError('暂时无法查询任务状态。')
      }
      if (request.kind === 'status_needs_task_id') {
        return handledError('请提供完整任务编号。')
      }
      const taskId = request.taskId ?? recentTask(recentTaskStore, identity.scopeKey)
      if (!taskId) return handledError('请提供完整任务编号。')
      try {
        const result = await statusRunner({ taskId })
        return handledError(formatVideoStatusReply(result, taskId))
      } catch {
        return handledError('暂时无法查询任务状态。')
      }
    }

    const identity = resolveDispatchIdentity(event, context, request.route)
    if (!identity.ok) {
      if (identity.reason === 'direct_message_required') {
        return handledError('未提交：仅支持 Telegram 私聊。')
      }
      if (identity.reason === 'timestamp_missing') {
        return handledError('提交失败：缺少有效消息时间。')
      }
      if (identity.reason === 'identity_missing') {
        return handledError('提交失败：缺少可信消息身份。')
      }
      return handledError('提交失败：消息上下文不一致。')
    }
    if (
      !allowedSenderHash
      || deriveTelegramSenderHash(identity.senderId) !== allowedSenderHash
    ) {
      return handledError('未提交：当前发送者没有视频派发权限。')
    }

    try {
      const result = await runner({ videoPath: request.videoPath, taskId: identity.taskId })
      const text = formatShortReceipt(result, identity.taskId)
      rememberTask(recentTaskStore, identity.scopeKey, identity.taskId)
      return {
        handled: true,
        text,
      }
    } catch (error) {
      if (error?.message === 'submit_unconfirmed') {
        rememberTask(recentTaskStore, identity.scopeKey, identity.taskId)
        return handledError(`提交状态暂未确认，任务编号：${identity.taskId}。请稍后查询。`)
      }
      return handledError('提交失败：暂时无法确认任务状态。')
    }
  }
}
