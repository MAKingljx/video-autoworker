import assert from 'node:assert/strict'
import test from 'node:test'
import { buildVideoTaskPayload } from '../lib/video-task.mjs'

test('video task payload stores only a safe display name and batch metadata', () => {
  const payload = buildVideoTaskPayload({
    bindingId: 2,
    taskId: 'batch-a:video:003:abcdef123456',
    idempotencyKey: 'batch-a:video:003:abcdef123456',
    prompt: '  深度分析视频  ',
    videoKey: '123e4567-e89b-42d3-a456-426614174000.mp4',
    displayName: '/Users/operator/private/S03E03.mp4',
    batchId: 'batch-a',
    batchIndex: 3,
    visionRoute: 'local-qwen38-vl-direct',
  })

  assert.deepEqual(payload.input, {
    prompt: '深度分析视频',
    videoKey: '123e4567-e89b-42d3-a456-426614174000.mp4',
    displayName: 'S03E03.mp4',
    batchId: 'batch-a',
    batchIndex: 3,
  })
  assert.equal(JSON.stringify(payload).includes('/Users/operator/private'), false)
  assert.deepEqual(payload.routing, {
    nodes: { vision: { routeId: 'local-qwen38-vl-direct', fallbackRouteIds: [] } },
  })
})
