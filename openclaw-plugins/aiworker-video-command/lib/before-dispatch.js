import {
  deriveTelegramSenderHash,
  normalizeAllowedSenderHash,
  resolveConsistentString,
  resolveDispatchIdentity,
  TARGET_CHANNEL,
} from './dispatch-identity.js'
import { runVideoTask } from './runner.js'
import { formatShortReceipt } from './short-receipt.js'
import { routeVideoRequest } from './video-request-router.js'

function handledError(text) {
  return { handled: true, text }
}

export function createBeforeDispatchHandler({
  runner = runVideoTask,
  allowedSenderSha256,
} = {}) {
  const allowedSenderHash = normalizeAllowedSenderHash(allowedSenderSha256)

  return async function handleBeforeDispatch(event, context) {
    const request = routeVideoRequest(event?.content)
    if (request.kind === 'pass') return undefined

    const channel = resolveConsistentString(event?.channel, context?.channelId)
    if (channel === null) {
      return handledError('提交失败：消息上下文不一致。')
    }
    if (channel !== TARGET_CHANNEL) return undefined
    if (request.kind === 'respond') {
      return event?.isGroup === false
        ? handledError(request.text)
        : undefined
    }
    if (event?.isGroup !== false) {
      return handledError('未提交：仅支持 Telegram 私聊。')
    }
    if (request.kind === 'reject') return handledError(request.text)

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
      return {
        handled: true,
        text: formatShortReceipt(result, identity.taskId),
      }
    } catch (error) {
      if (error?.message === 'submit_unconfirmed') {
        return handledError(`提交状态暂未确认，任务编号：${identity.taskId}。请稍后查询。`)
      }
      return handledError('提交失败：暂时无法确认任务状态。')
    }
  }
}
