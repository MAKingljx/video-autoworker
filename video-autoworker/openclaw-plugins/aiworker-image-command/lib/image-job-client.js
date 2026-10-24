import { createHash } from 'node:crypto'
import { crc32, inflateSync } from 'node:zlib'

// No caller or model can replace this application-owned loopback endpoint.
export const IMAGE_SERVICE_ORIGIN = 'http://127.0.0.1:18095'
export const IMAGE_BYTES_LIMIT = 10 * 1024 * 1024
export const PROTECTED_IMAGE_BYTES_LIMIT = 40 * 1024 * 1024
export const INSPECTION_JSON_BYTES_LIMIT = 6 * 1024 * 1024
const INSPECTION_IMAGE_BYTES_LIMIT = 2 * 1024 * 1024
const INSPECTION_MAX_SIDE = 1280
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

function inspectionPng(buffer, width, height) {
  if (buffer.length < 57 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return false
  let offset = 8
  let header
  let ended = false
  const compressed = []
  while (offset < buffer.length) {
    if (buffer.length - offset < 12) return false
    const size = buffer.readUInt32BE(offset)
    if (size > buffer.length - offset - 12) return false
    const name = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + size)
    if (crc32(buffer.subarray(offset + 4, offset + 8 + size)) !== buffer.readUInt32BE(offset + 8 + size)) return false
    if (!header) {
      if (name !== 'IHDR' || size !== 13) return false
      header = data
      if (header.readUInt32BE(0) !== width || header.readUInt32BE(4) !== height
        || header[8] !== 8 || ![2, 6].includes(header[9])
        || header[10] !== 0 || header[11] !== 0 || header[12] !== 0) return false
    } else if (name === 'IHDR' || ['acTL', 'fcTL', 'fdAT'].includes(name)) return false
    if (!['IHDR', 'IDAT', 'IEND'].includes(name) && (name.charCodeAt(0) & 32) === 0) return false
    if (name === 'IDAT') compressed.push(data)
    offset += size + 12
    if (name === 'IEND') {
      if (size !== 0 || offset !== buffer.length) return false
      ended = true
      break
    }
  }
  if (!ended || compressed.length === 0) return false
  const rowBytes = width * (header[9] === 6 ? 4 : 3) + 1
  try {
    const raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: rowBytes * height })
    if (raw.length !== rowBytes * height) return false
    for (let row = 0; row < height; row += 1) if (raw[row * rowBytes] > 4) return false
    return true
  } catch { return false }
}

// Inspection is a bounded derived view, never arbitrary file access. Validate
// again at the tool boundary so injected/test transports cannot skip the check.
export function normalizeImageInspection(data, expectedJobId) {
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || data.jobId !== expectedJobId || !JOB_ID.test(expectedJobId)
    || data.currentState !== 'GENERATED_PENDING_REVIEW'
    || !Array.isArray(data.images) || data.images.length !== 2) {
    throw new ImageServiceError('IMAGE_INSPECTION_INVALID')
  }
  const roles = new Set()
  const images = []
  for (const image of data.images) {
    if (!image || typeof image !== 'object' || Array.isArray(image)
      || !['source', 'result'].includes(image.role) || roles.has(image.role)
      || image.mimeType !== 'image/png'
      || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
      || image.width < 1 || image.height < 1
      || image.width > INSPECTION_MAX_SIDE || image.height > INSPECTION_MAX_SIDE
      || typeof image.sha256 !== 'string' || !SCOPE.test(image.sha256)
      || typeof image.data !== 'string' || image.data.length === 0 || image.data.length % 4
      || image.data.length > 4 * Math.ceil(INSPECTION_IMAGE_BYTES_LIMIT / 3)
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(image.data)) {
      throw new ImageServiceError('IMAGE_INSPECTION_INVALID')
    }
    const buffer = Buffer.from(image.data, 'base64')
    if (buffer.length > INSPECTION_IMAGE_BYTES_LIMIT || buffer.toString('base64') !== image.data
      || createHash('sha256').update(buffer).digest('hex') !== image.sha256
      || !inspectionPng(buffer, image.width, image.height)) {
      throw new ImageServiceError('IMAGE_INSPECTION_INVALID')
    }
    roles.add(image.role)
    images.push({ role: image.role, mimeType: 'image/png', data: image.data,
      sha256: image.sha256, width: image.width, height: image.height })
  }
  return { jobId: expectedJobId, currentState: data.currentState,
    images: images.sort((a, b) => (a.role === 'source' ? -1 : 1)) }
}

export function createImageJobClient({ fetchImpl = globalThis.fetch } = {}) {
  async function request(path, { body, signal, image = false,
    imageLimit = IMAGE_BYTES_LIMIT, jsonLimit = JSON_BYTES_LIMIT } = {}) {
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
      const buffer = await readBounded(response, imageLimit)
      if (buffer.length < PNG_SIGNATURE.length || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        throw new ImageServiceError('IMAGE_FORMAT_INVALID')
      }
      return buffer
    }
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (mime !== 'application/json') throw new ImageServiceError('IMAGE_RESPONSE_INVALID')
    let data
    try { data = JSON.parse((await readBounded(response, jsonLimit)).toString('utf8')) }
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
    async image(jobId, scope, expectedSha256, signal, { mode = 'raw' } = {}) {
      requireScope(scope)
      if (typeof expectedSha256 !== 'string' || !SCOPE.test(expectedSha256)) throw new ImageServiceError('IMAGE_DIGEST_INVALID')
      if (!['raw', 'protected'].includes(mode)) throw new ImageServiceError('IMAGE_MODE_INVALID')
      const buffer = await request(`${jobRoute(jobId)}/image?scope=${scope}`, {
        image: true, signal, imageLimit: mode === 'protected' ? PROTECTED_IMAGE_BYTES_LIMIT : IMAGE_BYTES_LIMIT,
      })
      if (createHash('sha256').update(buffer).digest('hex') !== expectedSha256) {
        throw new ImageServiceError('IMAGE_DIGEST_MISMATCH')
      }
      return buffer
    },
    async inspection(jobId, scope, signal) {
      requireScope(scope)
      const data = await request(`${jobRoute(jobId)}/inspection?scope=${scope}`, {
        signal, jsonLimit: INSPECTION_JSON_BYTES_LIMIT,
      })
      return normalizeImageInspection(data, jobId)
    },
  })
}
