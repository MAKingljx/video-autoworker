import { parseVideoCommand } from './parse-video-command.js'
import { runVideoTask } from './runner.js'
import { deriveStableDispatchKey } from './stable-message-key.js'

const TARGET_CHANNEL = 'telegram'

function handledError(text) {
  return { handled: true, text }
}

function resolveStableField(eventValue, contextValue) {
  const normalizedEvent = typeof eventValue === 'string' ? eventValue : ''
  const normalizedContext = typeof contextValue === 'string' ? contextValue : ''
  if (normalizedEvent && normalizedContext && normalizedEvent !== normalizedContext) return null
  return normalizedContext || normalizedEvent || undefined
}

export function createBeforeDispatchHandler({ runner = runVideoTask } = {}) {
  return async function handleBeforeDispatch(event, context) {
    const parsed = parseVideoCommand(event?.content)
    const channel = resolveStableField(event?.channel, context?.channelId)
    if (channel === null) {
      return parsed.kind === 'unmatched'
        ? undefined
        : handledError('提交失败：消息上下文不一致。')
    }
    if (channel !== TARGET_CHANNEL || parsed.kind === 'unmatched') return undefined
    if (event?.isGroup !== false) {
      return handledError('未提交：仅支持 Telegram 私聊。')
    }
    if (parsed.kind === 'invalid') return handledError('未提交：命令格式无效。')

    if (!Number.isFinite(event.timestamp)) {
      return handledError('提交失败：缺少有效消息时间。')
    }

    const sessionKey = resolveStableField(event.sessionKey, context.sessionKey)
    const senderId = resolveStableField(event.senderId, context.senderId)
    if (sessionKey === null || senderId === null) {
      return handledError('提交失败：消息上下文不一致。')
    }

    const taskId = deriveStableDispatchKey({
      channel,
      accountId: context.accountId,
      conversationId: context.conversationId,
      sessionKey,
      senderId,
      timestamp: event.timestamp,
      content: event.content,
    })

    try {
      const result = await runner({ videoPath: parsed.videoPath, taskId })
      return {
        handled: true,
        text: `已提交：taskId=${result.taskId}，status=${result.status}，duplicate=${result.duplicate}。`,
      }
    } catch {
      return handledError('提交失败：暂时无法确认任务状态。')
    }
  }
}
