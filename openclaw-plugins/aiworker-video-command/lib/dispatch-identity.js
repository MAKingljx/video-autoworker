import { createHash } from 'node:crypto'

import {
  deriveStableDispatchKey,
  deriveStableNaturalDispatchKey,
} from './stable-message-key.js'

export const TARGET_CHANNEL = 'telegram'
const SENDER_HASH_DOMAIN = 'aiworker-video-command:telegram-sender:v1\0'
const SHA256_PATTERN = /^[a-f0-9]{64}$/u

function normalizedString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function resolveConsistentString(eventValue, contextValue) {
  const eventString = normalizedString(eventValue)
  const contextString = normalizedString(contextValue)
  if (eventString && contextString && eventString !== contextString) return null
  return contextString || eventString
}

export function deriveTelegramSenderHash(senderId) {
  const normalized = normalizedString(senderId)
  if (!normalized) throw new TypeError('non-empty sender id is required')
  return createHash('sha256')
    .update(`${SENDER_HASH_DOMAIN}${normalized}`, 'utf8')
    .digest('hex')
}

export function normalizeAllowedSenderHash(value) {
  return typeof value === 'string' && SHA256_PATTERN.test(value) ? value : null
}

export function resolveDispatchIdentity(event, context, route) {
  // Telegram pairing/allowlist owns sender authorization upstream. This hook
  // receives stable identity fields, so it verifies their direct-message shape
  // and consistency without inventing an unavailable senderIsOwner signal.
  const channel = resolveConsistentString(event?.channel, context?.channelId)
  if (channel === null) return { ok: false, reason: 'context_mismatch' }
  if (channel !== TARGET_CHANNEL) return { ok: false, reason: 'unsupported_channel' }
  if (event?.isGroup !== false) return { ok: false, reason: 'direct_message_required' }

  if (!Number.isFinite(event?.timestamp)) {
    return { ok: false, reason: 'timestamp_missing' }
  }

  const sessionKey = resolveConsistentString(event?.sessionKey, context?.sessionKey)
  const senderId = resolveConsistentString(event?.senderId, context?.senderId)
  if (sessionKey === null || senderId === null) {
    return { ok: false, reason: 'context_mismatch' }
  }
  if (!sessionKey || !senderId) return { ok: false, reason: 'identity_missing' }

  const fields = {
    channel,
    accountId: normalizedString(context?.accountId),
    conversationId: normalizedString(context?.conversationId),
    sessionKey,
    senderId,
    timestamp: event.timestamp,
    content: event.content,
  }
  const taskId = route === 'natural'
    ? deriveStableNaturalDispatchKey(fields)
    : deriveStableDispatchKey(fields)
  return { ok: true, taskId, senderId }
}
