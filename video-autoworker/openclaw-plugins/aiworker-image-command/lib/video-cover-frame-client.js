import { createHash } from 'node:crypto'

export const VIDEO_COVER_FRAME_API_ORIGIN = 'http://127.0.0.1:3017'
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024
const MAX_FRAME_BYTES = 3 * 1024 * 1024
const FRAME_REF = /^[a-f0-9]{32}$/u
const SHA256 = /^[a-f0-9]{64}$/u

export class VideoCoverFrameError extends Error {
  constructor(errorCode) {
    super(errorCode)
    this.name = 'VideoCoverFrameError'
    this.errorCode = errorCode
  }
}

async function readBounded(response, limit) {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > limit)) {
    await response.body?.cancel()
    throw new VideoCoverFrameError('VIDEO_FRAME_RESPONSE_TOO_LARGE')
  }
  if (!response.body) throw new VideoCoverFrameError('VIDEO_FRAME_RESPONSE_INVALID')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        throw new VideoCoverFrameError('VIDEO_FRAME_RESPONSE_TOO_LARGE')
      }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, size)
}

function candidate(value) {
  const expected = ['bytes', 'data', 'frameRef', 'frameTimeSeconds', 'height', 'mimeType',
    'segmentIndex', 'sha256', 'summary', 'timeRange', 'width']
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== expected.sort().join(',')
    || !FRAME_REF.test(value.frameRef) || !Number.isSafeInteger(value.segmentIndex) || value.segmentIndex < 1
    || typeof value.timeRange !== 'string' || value.timeRange.length > 128
    || !Number.isFinite(value.frameTimeSeconds) || value.frameTimeSeconds < 0
    || !Number.isSafeInteger(value.width) || value.width < 64 || value.width > 8192
    || !Number.isSafeInteger(value.height) || value.height < 64 || value.height > 8192
    || value.width * value.height > 24 * 1024 * 1024
    || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_FRAME_BYTES
    || value.mimeType !== 'image/jpeg' || !SHA256.test(value.sha256)
    || typeof value.summary !== 'string' || Buffer.byteLength(value.summary) > 2_000
    || typeof value.data !== 'string' || value.data.length === 0 || value.data.length % 4
    || value.data.length > 4 * Math.ceil(MAX_FRAME_BYTES / 3)
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value.data)) {
    throw new VideoCoverFrameError('VIDEO_FRAME_RESPONSE_INVALID')
  }
  const bytes = Buffer.from(value.data, 'base64')
  if (bytes.length !== value.bytes || bytes.toString('base64') !== value.data
    || !bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || createHash('sha256').update(bytes).digest('hex') !== value.sha256) {
    throw new VideoCoverFrameError('VIDEO_FRAME_RESPONSE_INVALID')
  }
  return { ...value, bytesBuffer: bytes }
}

export function createVideoCoverFrameClient({ fetchImpl = globalThis.fetch } = {}) {
  return Object.freeze({
    async candidates({ query, segmentIndexes }, signal) {
      if (typeof query !== 'string' || !query.trim() || query !== query.trim()
        || query.length > 120 || Buffer.byteLength(query) > 480
        || !Array.isArray(segmentIndexes) || segmentIndexes.length !== 1
        || segmentIndexes.some(value => !Number.isSafeInteger(value) || value < 1)
        || new Set(segmentIndexes).size !== segmentIndexes.length) {
        throw new VideoCoverFrameError('VIDEO_FRAME_REQUEST_INVALID')
      }
      const timeout = AbortSignal.timeout(120_000)
      const combined = signal ? AbortSignal.any([timeout, signal]) : timeout
      let response
      try {
        response = await fetchImpl(`${VIDEO_COVER_FRAME_API_ORIGIN}/api/n8n/video-cover-frames`, {
          method: 'POST', redirect: 'error', cache: 'no-store',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ query, segmentIndexes }), signal: combined,
        })
      } catch { throw new VideoCoverFrameError('VIDEO_FRAME_UNAVAILABLE') }
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new VideoCoverFrameError('VIDEO_FRAME_RESPONSE_INVALID')
      }
      let data
      try { data = JSON.parse((await readBounded(response, MAX_RESPONSE_BYTES)).toString('utf8')) }
      catch (error) {
        if (error instanceof VideoCoverFrameError) throw error
        throw new VideoCoverFrameError('VIDEO_FRAME_RESPONSE_INVALID')
      }
      if (!response.ok) {
        const code = typeof data?.errorCode === 'string' && /^[A-Z0-9_]{1,96}$/u.test(data.errorCode)
          ? data.errorCode : 'VIDEO_FRAME_UNAVAILABLE'
        throw new VideoCoverFrameError(code)
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || Object.keys(data).sort().join(',') !== 'candidates,totalSegments,videoName'
        || typeof data.videoName !== 'string' || data.videoName !== query
        || !Number.isSafeInteger(data.totalSegments) || data.totalSegments < 1
        || !Array.isArray(data.candidates) || data.candidates.length !== 3) {
        throw new VideoCoverFrameError('VIDEO_FRAME_RESPONSE_INVALID')
      }
      const frames = data.candidates.map(item => ({ ...candidate(item), videoName: data.videoName }))
      if (frames.some(frame => !segmentIndexes.includes(frame.segmentIndex))
        || new Set(frames.map(frame => frame.frameRef)).size !== frames.length) {
        throw new VideoCoverFrameError('VIDEO_FRAME_RESPONSE_INVALID')
      }
      return { videoName: data.videoName, totalSegments: data.totalSegments, candidates: frames }
    },
  })
}
