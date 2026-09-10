import { createHash } from 'node:crypto'

function encodePart(value) {
  const normalized = typeof value === 'string'
    ? value
    : Number.isFinite(value) ? String(value) : ''
  return `${Buffer.byteLength(normalized, 'utf8')}:${normalized}`
}

function deriveStableMessageKey({
  namespace,
  taskPrefix,
  channel,
  accountId,
  conversationId,
  sessionKey,
  senderId,
  timestamp,
  content,
}) {
  if (!Number.isFinite(timestamp)) throw new TypeError('finite timestamp is required')
  if (typeof content !== 'string' || !content) throw new TypeError('content is required')

  const canonical = [
    namespace,
    channel,
    accountId,
    conversationId,
    sessionKey,
    senderId,
    timestamp,
    content,
  ].map(encodePart).join('|')
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
  return `${taskPrefix}${digest}`
}

export function deriveStableDispatchKey(fields) {
  return deriveStableMessageKey({
    ...fields,
    namespace: 'aiworker-video-dispatch-v1',
    taskPrefix: 'video-command-',
  })
}

export function deriveStableNaturalDispatchKey(fields) {
  return deriveStableMessageKey({
    ...fields,
    namespace: 'aiworker-natural-video-dispatch-v1',
    taskPrefix: 'video-natural-',
  })
}
