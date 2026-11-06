import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { createVideoCoverWorkflowClient, VIDEO_COVER_WORKFLOW_ENDPOINT } from '../lib/video-cover-workflow-client.js'

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4])
const sha256 = createHash('sha256').update(jpeg).digest('hex')

function response(value) {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

test('uses one workflow endpoint for the saved directory and native candidate frames', async () => {
  const calls = []
  const client = createVideoCoverWorkflowClient({ fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push({ url, body })
    if (body.action === 'segments') return response({
      action: 'segments', videoName: '北美火车短片.mp4', totalSegments: 3, directoryPreviewCompacted: false,
      items: [{ index: 1, timeRange: '00:00:00-00:00:05', summary: '火车进站', available: true }],
    })
    return response({ videoName: '北美火车短片.mp4', totalSegments: 3, candidates: [0, 1, 2].map(index => ({
      frameRef: String(index + 1).repeat(32), segmentIndex: 1, timeRange: '00:00:00-00:00:05',
      frameTimeSeconds: index + 1, width: 1920, height: 1080, bytes: jpeg.length, sha256,
      mimeType: 'image/jpeg', data: jpeg.toString('base64'), summary: '火车进站',
    })) })
  } })
  const segments = await client.segments({ query: '北美火车短片.mp4' })
  const frames = await client.frames({ query: '北美火车短片.mp4', segmentIndex: 1 })
  assert.equal(calls[0].url, VIDEO_COVER_WORKFLOW_ENDPOINT)
  assert.deepEqual(calls.map(call => call.body), [
    { action: 'segments', query: '北美火车短片.mp4' },
    { action: 'frames', query: '北美火车短片.mp4', segmentIndex: 1 },
  ])
  assert.equal(segments.items[0].available, true)
  assert.deepEqual(frames.candidates[0].bytesBuffer, jpeg)
})
