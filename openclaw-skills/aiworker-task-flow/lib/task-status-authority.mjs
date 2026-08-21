const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled'])

/** @param {unknown} status */
export function isTerminalTaskStatus(status) {
  return TERMINAL_TASK_STATUSES.has(String(status || '').trim().toLowerCase())
}

/** @param {unknown} status */
export function toPublicDurableTaskStatus(status) {
  const normalized = String(status || '').trim()
  return {
    staging: 'queued',
    submitted: 'accepted',
    waiting: 'running',
  }[normalized] || normalized
}

/**
 * @template TPlatform
 * @template TDurable
 * @param {{
 *   platformRecord?: TPlatform | null,
 *   durableRecord?: TDurable | null,
 *   platformAvailable?: boolean,
 * }} [options]
 * @returns {(
 *   | { source: 'platform', record: TPlatform, platformAvailable: true }
 *   | { source: 'durable', record: TDurable, platformAvailable: true }
 *   | { source: 'durable-fallback', record: TDurable, platformAvailable: false }
 * ) | null}
 */
export function selectAuthoritativeTaskRecord({
  platformRecord = null,
  durableRecord = null,
  platformAvailable = true,
} = {}) {
  if (platformRecord !== null && platformRecord !== undefined) {
    return {
      source: 'platform',
      record: platformRecord,
      platformAvailable: true,
    }
  }
  if (durableRecord !== null && durableRecord !== undefined) {
    return {
      source: platformAvailable ? 'durable' : 'durable-fallback',
      record: durableRecord,
      platformAvailable,
    }
  }
  return null
}

export async function resolveAuthoritativeTaskRecord({
  loadPlatformRecord,
  loadDurableRecord = async () => null,
  isPlatformUnavailable = () => false,
} = {}) {
  if (typeof loadPlatformRecord !== 'function') {
    throw new TypeError('loadPlatformRecord 必须是函数')
  }
  if (typeof loadDurableRecord !== 'function') {
    throw new TypeError('loadDurableRecord 必须是函数')
  }
  let platformAvailable = true
  let platformError = null
  try {
    const platformRecord = await loadPlatformRecord()
    if (platformRecord !== null && platformRecord !== undefined) {
      return selectAuthoritativeTaskRecord({ platformRecord })
    }
  } catch (error) {
    if (!isPlatformUnavailable(error)) throw error
    platformAvailable = false
    platformError = error
  }
  const durableRecord = await loadDurableRecord()
  if ((durableRecord === null || durableRecord === undefined) && platformError) {
    throw platformError
  }
  return selectAuthoritativeTaskRecord({ durableRecord, platformAvailable })
}
