const ORIGIN = 'http://127.0.0.1:3017'
const RESPONSE_LIMIT = 2 * 1024 * 1024

export function createEditingClient({ fetchImpl = globalThis.fetch } = {}) {
  async function request(path, { body, signal } = {}) {
    const response = await fetchImpl(`${ORIGIN}${path}`, {
      method: body === undefined ? 'GET' : 'POST', cache: 'no-store', redirect: 'error',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
    })
    if (response.headers.get('content-type')?.split(';')[0] !== 'application/json'
      || Number(response.headers.get('content-length') || 0) > RESPONSE_LIMIT) throw new Error('EDITING_RESPONSE_INVALID')
    if (!response.body) throw new Error('EDITING_RESPONSE_INVALID')
    const reader = response.body.getReader(), chunks = []; let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break
        size += value.byteLength
        if (size > RESPONSE_LIMIT) { await reader.cancel(); throw new Error('EDITING_RESPONSE_LIMIT') }
        chunks.push(Buffer.from(value))
      }
    } finally { reader.releaseLock() }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('EDITING_RESPONSE_INVALID')
    if (!response.ok) throw new Error(typeof data.code === 'string' && /^[A-Za-z0-9_:-]{1,100}$/u.test(data.code)
      ? data.code : 'EDITING_SERVICE_UNAVAILABLE')
    return data
  }
  const planQuery = ({ planId, revision }) => `/api/editing/plans?${new URLSearchParams({ planId, revision: String(revision) })}`
  return Object.freeze({
    inspect: signal => request('/api/editing/status', { signal }),
    evidence: ({ taskId, offset = 0, limit = 20 }, signal) => request(`/api/editing/evidence?${new URLSearchParams({
      taskId, offset: String(offset), limit: String(limit) })}`, { signal }),
    propose: (plan, signal) => request('/api/editing/plans', { body: { action: 'propose', plan }, signal }),
    status: (query, signal) => request(query.planId ? planQuery(query) : '/api/editing/plans', { signal }),
  })
}
