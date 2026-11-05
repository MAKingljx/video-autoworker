import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createVideoCoverFrameClient, VIDEO_COVER_FRAME_API_ORIGIN } from '../lib/video-cover-frame-client.js'

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4])
const sha256 = createHash('sha256').update(jpeg).digest('hex')

function response(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('requests controlled frame candidates on the fixed loopback app endpoint', async () => {
  let captured
  const frameRef = 'e'.repeat(32)
  const client = createVideoCoverFrameClient({ fetchImpl: async (url, init) => {
    captured = { url, init, body: JSON.parse(init.body) }
    return response({ videoName: '北美火车短片.mp4', totalSegments: 25, candidates: [0, 1, 2].map(index => ({
      frameRef: index === 0 ? frameRef : String(index + 1).repeat(32), segmentIndex: 3,
      timeRange: '00:00:10-00:00:15', frameTimeSeconds: [11, 12.5, 14][index],
      width: 1920, height: 1080, bytes: jpeg.length, sha256, mimeType: 'image/jpeg',
      data: jpeg.toString('base64'), summary: '火车进入站台',
    })) })
  } })
  const result = await client.candidates({ query: '北美火车短片.mp4', segmentIndexes: [3] })
  assert.equal(captured.url, `${VIDEO_COVER_FRAME_API_ORIGIN}/api/n8n/video-cover-frames`)
  assert.equal(captured.init.method, 'POST')
  assert.equal(captured.init.redirect, 'error')
  assert.deepEqual(captured.body, { query: '北美火车短片.mp4', segmentIndexes: [3] })
  assert.deepEqual(result.candidates[0].bytesBuffer, jpeg)
  assert.equal(result.candidates[0].videoName, '北美火车短片.mp4')
})

test('rejects an invalid video query before making a request', async () => {
  let called = false
  const client = createVideoCoverFrameClient({ fetchImpl: async () => { called = true; return response({}) } })
  await assert.rejects(client.candidates({ query: ' ', segmentIndexes: [1] }), /VIDEO_FRAME_REQUEST_INVALID/u)
  await assert.rejects(client.candidates({ query: '视频.mp4', segmentIndexes: [1, 2] }), /VIDEO_FRAME_REQUEST_INVALID/u)
  assert.equal(called, false)
})

test('fails closed on corrupt or out-of-scope candidate data', async () => {
  const client = createVideoCoverFrameClient({ fetchImpl: async () => response({
    videoName: '北美火车短片.mp4', totalSegments: 25, candidates: [0, 1, 2].map(index => ({
      frameRef: 'f'.repeat(32), segmentIndex: 5, timeRange: '00:00:20-00:00:25', frameTimeSeconds: 22.5 + index,
      width: 1920, height: 1080, bytes: jpeg.length, sha256, mimeType: 'image/jpeg',
      data: jpeg.toString('base64'), summary: '不在请求的片段中',
    })),
  }) })
  await assert.rejects(client.candidates({ query: '北美火车短片.mp4', segmentIndexes: [3] }), /VIDEO_FRAME_RESPONSE_INVALID/u)
})
