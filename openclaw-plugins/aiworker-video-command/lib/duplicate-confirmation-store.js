import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute } from 'node:path'

export const DUPLICATE_CONFIRMATION_TEXT = '确认重新分析'

const DEFAULT_TTL_MS = 15 * 60 * 1_000
const DEFAULT_MAX_ENTRIES = 256
const SCOPE_DOMAIN = 'aiworker-video-command:duplicate-confirmation:v1\0'
const STORAGE_VERSION = 1
const MATERIAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u

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
  storagePath = null,
} = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError('ttlMs must be positive')
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new TypeError('maxEntries must be a positive integer')
  }
  if (storagePath !== null && (typeof storagePath !== 'string' || !isAbsolute(storagePath))) {
    throw new TypeError('storagePath must be an absolute path')
  }
  const entries = new Map()

  function validScopeKey(scopeKey) {
    return /^[a-f0-9]{64}$/u.test(scopeKey)
  }

  function prune(currentTime) {
    for (const [scopeKey, entry] of entries) {
      if (entry.expiresAt <= currentTime) entries.delete(scopeKey)
    }
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
  }

  function validOperation(operation) {
    // Only trusted adapters may seed an existing material identity. Reject the
    // old generic field name so it cannot blur into a model-originated value.
    const legacyMaterialIdAbsent = !Object.hasOwn(operation || {}, 'materialId')
    const trustedExistingMaterialIdValid = !Object.hasOwn(operation || {}, 'trustedExistingMaterialId')
      || (operation.kind === 'task'
        && typeof operation.trustedExistingMaterialId === 'string'
        && operation.trustedExistingMaterialId === operation.trustedExistingMaterialId.trim()
        && MATERIAL_ID_PATTERN.test(operation.trustedExistingMaterialId))
    return operation
      && ['task', 'batch'].includes(operation.kind)
      && typeof operation.id === 'string'
      && operation.id.length > 0
      && typeof operation.path === 'string'
      && operation.path.length > 0
      && legacyMaterialIdAbsent
      && trustedExistingMaterialIdValid
  }

  function load() {
    if (!storagePath) return
    entries.clear()
    let persisted
    try {
      persisted = JSON.parse(readFileSync(storagePath, 'utf8'))
    } catch {
      return
    }
    if (persisted?.version !== STORAGE_VERSION || !persisted.entries
      || typeof persisted.entries !== 'object' || Array.isArray(persisted.entries)) return
    for (const [scopeKey, entry] of Object.entries(persisted.entries)) {
      if (!validScopeKey(scopeKey) || !Number.isFinite(entry?.expiresAt)
        || !validOperation(entry.operation)) continue
      entries.set(scopeKey, {
        operation: Object.freeze({ ...entry.operation }),
        expiresAt: entry.expiresAt,
      })
    }
  }

  function persist() {
    if (!storagePath) return
    try {
      mkdirSync(dirname(storagePath), { recursive: true, mode: 0o700 })
      chmodSync(dirname(storagePath), 0o700)
      const temporaryPath = `${storagePath}.${process.pid}.${Date.now()}.tmp`
      const serialized = JSON.stringify({
        version: STORAGE_VERSION,
        entries: Object.fromEntries(entries),
      })
      writeFileSync(temporaryPath, `${serialized}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
      chmodSync(temporaryPath, 0o600)
      renameSync(temporaryPath, storagePath)
      chmodSync(storagePath, 0o600)
    } catch {
      // The in-memory store remains authoritative if the optional checkpoint is unavailable.
    }
  }

  function refresh(currentTime) {
    load()
    const before = entries.size
    prune(currentTime)
    if (storagePath && entries.size !== before) persist()
  }

  return Object.freeze({
    get(scopeKey) {
      if (typeof scopeKey !== 'string' || !scopeKey) return null
      const currentTime = now()
      refresh(currentTime)
      return entries.get(scopeKey)?.operation ?? null
    },
    set(scopeKey, operation) {
      if (typeof scopeKey !== 'string' || !scopeKey || !validOperation(operation)) {
        throw new TypeError('valid confirmation scope and operation are required')
      }
      const currentTime = now()
      load()
      entries.delete(scopeKey)
      entries.set(scopeKey, {
        operation: Object.freeze({ ...operation }),
        expiresAt: currentTime + ttlMs,
      })
      prune(currentTime)
      persist()
    },
    take(scopeKey) {
      if (typeof scopeKey !== 'string' || !scopeKey) return null
      const currentTime = now()
      refresh(currentTime)
      const operation = entries.get(scopeKey)?.operation ?? null
      if (operation) {
        entries.delete(scopeKey)
        persist()
      }
      return operation
    },
    delete(scopeKey) {
      load()
      entries.delete(scopeKey)
      persist()
    },
  })
}
