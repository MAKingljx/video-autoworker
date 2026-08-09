import { createHash } from 'node:crypto'

function encodePart(value) {
  const normalized = typeof value === 'string'
    ? value
    : Number.isFinite(value) ? String(value) : ''
  return `${Buffer.byteLength(normalized, 'utf8')}:${normalized}`
}

export function deriveStableDispatchKey({
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
    'aiworker-video-dispatch-v1',
    channel,
    accountId,
    conversationId,
    sessionKey,
    senderId,
    timestamp,
    content,
  ].map(encodePart).join('|')
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
  return `video-command-${digest}`
}
