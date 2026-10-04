import { createHash } from 'node:crypto'

// No caller or model can replace this application-owned loopback endpoint.
export const IMAGE_SERVICE_ORIGIN = 'http://127.0.0.1:18095'
export const IMAGE_BYTES_LIMIT = 10 * 1024 * 1024
const JSON_BYTES_LIMIT = 64 * 1024
const HTTP_TIMEOUT_MS = 15_000
const JOB_ID = /^[0-9a-f]{32}$/u
const SCOPE = /^[0-9a-f]{64}$/u
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

export class ImageServiceError extends Error {
  constructor(errorCode) {
    super(errorCode)
    this.name = 'ImageServiceError'
    this.errorCode = errorCode
  }
}

function requireScope(scope) {
  if (typeof scope !== 'string' || !SCOPE.test(scope)) throw new ImageServiceError('IMAGE_SCOPE_INVALID')
}

function jobRoute(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw new ImageServiceError('IMAGE_JOB_ID_INVALID')
  return `/v1/jobs/${jobId}`
}

async function readBounded(response, limit) {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel()
    throw new ImageServiceError('IMAGE_RESPONSE_TOO_LARGE')
  }
  if (!response.body) throw new ImageServiceError('IMAGE_RESPONSE_INVALID')
  const chunks = []
  let size = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new ImageServiceError('IMAGE_RESPONSE_TOO_LARGE')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks, size)
}

function safeErrorCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_:-]{1,96}$/u.test(value)
    ? value : 'IMAGE_SERVICE_ERROR'
}

export function createImageJobClient({ fetchImpl = globalThis.fetch } = {}) {
  async function request(path, { body, signal, image = false } = {}) {
    const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout
    const response = await fetchImpl(`${IMAGE_SERVICE_ORIGIN}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { accept: image ? 'image/png' : 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: combined,
    })
    if (image && response.ok) {
      const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
      if (mime !== 'image/png') throw new ImageServiceError('IMAGE_FORMAT_INVALID')
      const buffer = await readBounded(response, IMAGE_BYTES_LIMIT)
      if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new ImageServiceError('IMAGE_FORMAT_INVALID')
      }
      return buffer
    }
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (mime !== 'application/json') throw new ImageServiceError('IMAGE_RESPONSE_INVALID')
    let data
    try { data = JSON.parse((await readBounded(response, JSON_BYTES_LIMIT)).toString('utf8')) }
    catch (error) {
      if (error instanceof ImageServiceError) throw error
      throw new ImageServiceError('IMAGE_RESPONSE_INVALID')
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new ImageServiceError('IMAGE_RESPONSE_INVALID')
    }
    if (!response.ok) throw new ImageServiceError(safeErrorCode(data.errorCode))
    return data
  }

  return Object.freeze({
    submit(payload, signal) {
      requireScope(payload.scope)
      if (!SCOPE.test(payload.requestKey)) throw new ImageServiceError('IMAGE_REQUEST_KEY_INVALID')
      return request('/v1/jobs', { body: payload, signal })
    },
    status(jobId, scope, signal) {
      requireScope(scope)
      return request(`${jobRoute(jobId)}?scope=${scope}`, { signal })
    },
    list(scope, signal) {
      requireScope(scope)
      return request(`/v1/jobs?scope=${scope}`, { signal })
    },
    cancel(jobId, scope, signal) {
      requireScope(scope)
      return request(`${jobRoute(jobId)}/cancel`, { body: { scope }, signal })
    },
    async image(jobId, scope, expectedSha256, signal) {
      requireScope(scope)
      if (typeof expectedSha256 !== 'string' || !SCOPE.test(expectedSha256)) throw new ImageServiceError('IMAGE_DIGEST_INVALID')
      const buffer = await request(`${jobRoute(jobId)}/image?scope=${scope}`, { image: true, signal })
      if (createHash('sha256').update(buffer).digest('hex') !== expectedSha256) {
        throw new ImageServiceError('IMAGE_DIGEST_MISMATCH')
      }
      return buffer
    },
  })
}
