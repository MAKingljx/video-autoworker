import { createHash } from 'node:crypto'

// The directory keeps preview text within 24KiB, but it still retains every
// index/time-range identity. Allow the large identity-only case without
// resurrecting a model-visible 20-item paging limit.
const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_FRAME_BYTES = 3 * 1024 * 1024
const FRAME_REF = /^[a-f0-9]{32}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const WORKFLOW_ENDPOINT = 'http://127.0.0.1:3017/api/n8n/video-cover-workflow'

export class VideoCoverWorkflowError extends Error {
  constructor(errorCode) {
    super(errorCode)
    this.name = 'VideoCoverWorkflowError'
    this.errorCode = errorCode
  }
}

async function readBounded(response) {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel()
    throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_RESPONSE_TOO_LARGE')
  }
  if (!response.body) throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_RESPONSE_INVALID')
  const reader = response.body.getReader()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_RESPONSE_TOO_LARGE')
      }
      chunks.push(Buffer.from(value))
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks, size)
}

function validQuery(value) {
  return typeof value === 'string' && value === value.trim() && value.length > 0
    && value.length <= 120 && Buffer.byteLength(value, 'utf8') <= 480
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
    throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_RESPONSE_INVALID')
  }
  const bytes = Buffer.from(value.data, 'base64')
  if (bytes.length !== value.bytes || bytes.toString('base64') !== value.data
    || !bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
    || createHash('sha256').update(bytes).digest('hex') !== value.sha256) {
    throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_RESPONSE_INVALID')
  }
  return { ...value, bytesBuffer: bytes }
}

function directoryItem(value) {
  const expected = ['available', 'index', 'summary', 'timeRange']
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== expected.join(',')
    || !Number.isSafeInteger(value.index) || value.index < 1
    || typeof value.available !== 'boolean'
    || typeof value.timeRange !== 'string' || value.timeRange.length > 128
    || typeof value.summary !== 'string' || Buffer.byteLength(value.summary, 'utf8') > 24 * 1024) {
    throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_RESPONSE_INVALID')
  }
  return value
}

export function createVideoCoverWorkflowClient({ fetchImpl = globalThis.fetch } = {}) {
  return Object.freeze({
    async segments({ query }, signal) {
      if (!validQuery(query)) throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_REQUEST_INVALID')
      const timeout = AbortSignal.timeout(120_000)
      const combined = signal ? AbortSignal.any([timeout, signal]) : timeout
      let response
      try {
        response = await fetchImpl(WORKFLOW_ENDPOINT, {
          method: 'POST', redirect: 'error', cache: 'no-store',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'segments', query }), signal: combined,
        })
      } catch { throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_UNAVAILABLE') }
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_RESPONSE_INVALID')
      }
      let data
      try { data = JSON.parse((await readBounded(response)).toString('utf8')) }
      catch (error) {
        if (error instanceof VideoCoverWorkflowError) throw error
        throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_RESPONSE_INVALID')
      }
      if (!response.ok) {
        const code = typeof data?.errorCode === 'string' && /^[A-Z0-9_]{1,96}$/u.test(data.errorCode)
          ? data.errorCode : 'VIDEO_COVER_WORKFLOW_UNAVAILABLE'
        throw new VideoCoverWorkflowError(code)
      }
      const expected = ['action', 'directoryPreviewCompacted', 'items', 'totalSegments', 'videoName']
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || Object.keys(data).sort().join(',') !== expected.join(',')
        || data.action !== 'segments' || data.videoName !== query
        || !Number.isSafeInteger(data.totalSegments) || data.totalSegments < 1
        || typeof data.directoryPreviewCompacted !== 'boolean'
        || !Array.isArray(data.items) || data.items.length > data.totalSegments
        || new Set(data.items.map(item => item?.index)).size !== data.items.length) {
        throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_RESPONSE_INVALID')
      }
      return {
        videoName: data.videoName,
        totalSegments: data.totalSegments,
        directoryPreviewCompacted: data.directoryPreviewCompacted,
        items: data.items.map(directoryItem),
      }
    },
    async frames({ query, segmentIndex }, signal) {
      if (!validQuery(query) || !Number.isSafeInteger(segmentIndex) || segmentIndex < 1) {
        throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_REQUEST_INVALID')
      }
      const timeout = AbortSignal.timeout(120_000)
      const combined = signal ? AbortSignal.any([timeout, signal]) : timeout
      let response
      try {
        response = await fetchImpl(WORKFLOW_ENDPOINT, {
          method: 'POST', redirect: 'error', cache: 'no-store',
          headers: { accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'frames', query, segmentIndex }), signal: combined,
        })
      } catch { throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_UNAVAILABLE') }
      if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_RESPONSE_INVALID')
      }
      let data
      try { data = JSON.parse((await readBounded(response)).toString('utf8')) }
      catch (error) {
        if (error instanceof VideoCoverWorkflowError) throw error
        throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_RESPONSE_INVALID')
      }
      if (!response.ok) {
        const code = typeof data?.errorCode === 'string' && /^[A-Z0-9_]{1,96}$/u.test(data.errorCode)
          ? data.errorCode : 'VIDEO_COVER_WORKFLOW_UNAVAILABLE'
        throw new VideoCoverWorkflowError(code)
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)
        || Object.keys(data).sort().join(',') !== 'candidates,totalSegments,videoName'
        || data.videoName !== query || !Number.isSafeInteger(data.totalSegments) || data.totalSegments < 1
        || !Array.isArray(data.candidates) || data.candidates.length !== 3) {
        throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_RESPONSE_INVALID')
      }
      const candidates = data.candidates.map(candidate)
      if (candidates.some(frame => frame.segmentIndex !== segmentIndex)
        || new Set(candidates.map(frame => frame.frameRef)).size !== candidates.length) {
        throw new VideoCoverWorkflowError('VIDEO_COVER_WORKFLOW_RESPONSE_INVALID')
      }
      return { videoName: data.videoName, totalSegments: data.totalSegments, candidates }
    },
  })
}

export { WORKFLOW_ENDPOINT as VIDEO_COVER_WORKFLOW_ENDPOINT }
