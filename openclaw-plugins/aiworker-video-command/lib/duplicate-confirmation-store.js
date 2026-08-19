import { createHash } from 'node:crypto'

export const DUPLICATE_CONFIRMATION_TEXT = '确认重新分析'

const DEFAULT_TTL_MS = 15 * 60 * 1_000
const DEFAULT_MAX_ENTRIES = 256
const SCOPE_DOMAIN = 'aiworker-video-command:duplicate-confirmation:v1\0'

export function duplicateConfirmationScopeKey(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  return createHash('sha256')
    .update(SCOPE_DOMAIN, 'utf8')
    .update(value.trim(), 'utf8')
    .digest('hex')
}

export function isDuplicateConfirmationText(value) {
  return typeof value === 'string' && value.trim() === DUPLICATE_CONFIRMATION_TEXT
}

export function createDuplicateConfirmationStore({
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
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
  }

  function validOperation(operation) {
    return operation
      && ['task', 'batch'].includes(operation.kind)
      && typeof operation.id === 'string'
      && operation.id.length > 0
      && typeof operation.path === 'string'
      && operation.path.length > 0
  }

  return Object.freeze({
    get(scopeKey) {
      if (typeof scopeKey !== 'string' || !scopeKey) return null
      const currentTime = now()
      prune(currentTime)
      return entries.get(scopeKey)?.operation ?? null
    },
    set(scopeKey, operation) {
      if (typeof scopeKey !== 'string' || !scopeKey || !validOperation(operation)) {
        throw new TypeError('valid confirmation scope and operation are required')
      }
      const currentTime = now()
      entries.delete(scopeKey)
      entries.set(scopeKey, {
        operation: Object.freeze({ ...operation }),
        expiresAt: currentTime + ttlMs,
      })
      prune(currentTime)
    },
    take(scopeKey) {
      const operation = this.get(scopeKey)
      if (operation) entries.delete(scopeKey)
      return operation
    },
    delete(scopeKey) {
      entries.delete(scopeKey)
    },
  })
}
