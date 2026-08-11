import { isVideoTaskId } from './video-task-id.js'

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000
const DEFAULT_MAX_ENTRIES = 256

function validScopeKey(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
}

export function createRecentTaskStore({
  now = Date.now,
  ttlMs = DEFAULT_TTL_MS,
  maxEntries = DEFAULT_MAX_ENTRIES,
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be positive')
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new TypeError('maxEntries must be a positive integer')
  }

  const entries = new Map()

  function prune(currentTime) {
    for (const [scopeKey, entry] of entries) {
      if (entry.expiresAt <= currentTime) entries.delete(scopeKey)
    }
    while (entries.size > maxEntries) {
      entries.delete(entries.keys().next().value)
    }
  }

  return Object.freeze({
    get(scopeKey) {
      if (!validScopeKey(scopeKey)) return null
      const currentTime = now()
      prune(currentTime)
      return entries.get(scopeKey)?.taskId ?? null
    },
    set(scopeKey, taskId) {
      if (!validScopeKey(scopeKey) || !isVideoTaskId(taskId)) {
        throw new TypeError('valid scope key and video task id are required')
      }
      const currentTime = now()
      entries.delete(scopeKey)
      entries.set(scopeKey, { taskId, expiresAt: currentTime + ttlMs })
      prune(currentTime)
    },
  })
}
