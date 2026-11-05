import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createImageCommandTools,
  IMAGE_COMMAND_TOOL_NAMES,
  IMAGE_SUBMIT_PROTECTED_FRAME_TOOL_NAME,
  IMAGE_VIDEO_FRAMES_TOOL_NAME,
  imageCommandToolNamesForProfile,
  imageSessionScope,
} from '../lib/image-command-tool.js'

const binding = { profile: 'qwen-current', targetAgentId: 'second-original' }
const context = { agentId: 'second-original', sessionKey: 'agent:second-original:video-cover-test' }
const scope = imageSessionScope(context, binding)
const frameRef = 'a'.repeat(32)
const frameData = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64')
const protectedPlan = {
  schema: 'aiworker-protected-cover/v1',
  textLayers: [{ text: '老大的火车体验又升级了', box: { x: 30, y: 30, width: 800, height: 160 } }],
}

function tools(overrides = {}) {
  const calls = { candidates: [], capture: [], resolve: [], submit: [] }
  const videoFrameClient = overrides.videoFrameClient ?? {
    async candidates(value) {
      calls.candidates.push(value)
      return { videoName: '北美火车短片.mp4', totalSegments: 25, candidates: [0, 1, 2].map(index => ({
        frameRef: index === 0 ? frameRef : String(index + 1).repeat(32),
        segmentIndex: 3, timeRange: '00:00:10-00:00:15', frameTimeSeconds: [11, 12.5, 14][index],
        videoName: '北美火车短片.mp4', width: 1920, height: 1080,
        sha256: 'b'.repeat(64), data: frameData,
        bytesBuffer: Buffer.from(frameData, 'base64'),
      })) }
    },
  }
  const videoFrameStore = overrides.videoFrameStore ?? {
    async captureBatch(value) {
      calls.capture.push(value)
      return value.candidates.map(candidate => ({
        frameRef: candidate.frameRef, segmentIndex: candidate.segmentIndex,
        timeRange: candidate.timeRange, frameTimeSeconds: candidate.frameTimeSeconds,
        width: candidate.width, height: candidate.height, sha256: candidate.sha256,
        summary: candidate.summary, data: candidate.bytesBuffer.toString('base64'),
      }))
    },
    async resolve(value) {
      calls.resolve.push(value)
      return { path: '/private/qwen/media/video-frame-references/frame-a.jpg' }
    },
  }
  const client = overrides.client ?? {
    async submit(value) {
      calls.submit.push(value)
      return { jobId: 'c'.repeat(32), currentState: 'QUEUED', mode: 'protected' }
    },
  }
  return {
    calls,
    tools: createImageCommandTools({ context, binding, videoFrameClient, videoFrameStore, client }),
  }
}

test('only qwen-current receives the learned-video frame tools', () => {
  assert.deepEqual(imageCommandToolNamesForProfile('qwen-current'), [
    ...IMAGE_COMMAND_TOOL_NAMES, IMAGE_VIDEO_FRAMES_TOOL_NAME, IMAGE_SUBMIT_PROTECTED_FRAME_TOOL_NAME,
  ])
  assert.deepEqual(imageCommandToolNamesForProfile('image-studio'), IMAGE_COMMAND_TOOL_NAMES)
  const instance = tools()
  assert.ok(instance.tools.some(tool => tool.name === IMAGE_VIDEO_FRAMES_TOOL_NAME))
  assert.ok(instance.tools.some(tool => tool.name === IMAGE_SUBMIT_PROTECTED_FRAME_TOOL_NAME))
})

test('returns native candidate image blocks and opaque references without file paths', async () => {
  const instance = tools()
  const tool = instance.tools.find(item => item.name === IMAGE_VIDEO_FRAMES_TOOL_NAME)
  const result = await tool.execute('frames-1', { query: '北美火车短片.mp4', segmentIndexes: [3] })
  assert.equal(tool.catalogMode, 'direct-only')
  assert.deepEqual(instance.calls.candidates[0], {
    query: '北美火车短片.mp4', segmentIndexes: [3],
  })
  assert.equal(instance.calls.capture[0].imageScope, scope)
  assert.equal(instance.calls.capture[0].sessionKey, context.sessionKey)
  assert.equal(result.content.filter(item => item.type === 'image').length, 3)
  assert.match(result.content.find(item => item.type === 'text').text, /片段摘要/u)
  assert.doesNotMatch(JSON.stringify(result), /\/private\/|frame-a\.jpg/u)
  assert.deepEqual(result.details.candidates.map(item => item.frameRef), [frameRef, '2'.repeat(32), '3'.repeat(32)])
})

test('refuses unchosen or multiple segment indices before requesting original frames', async () => {
  const instance = tools()
  const frameTool = instance.tools.find(item => item.name === IMAGE_VIDEO_FRAMES_TOOL_NAME)
  const result = await frameTool.execute('frames-invalid', {
    query: '北美火车短片.mp4', segmentIndexes: [3, 4],
  })
  assert.equal(result.details.errorCode, 'VIDEO_FRAME_REQUEST_INVALID')
  assert.equal(instance.calls.candidates.length, 0)
})

test('selected frame uses the existing protected image queue and remains session-bound', async () => {
  const instance = tools()
  const submit = instance.tools.find(item => item.name === IMAGE_SUBMIT_PROTECTED_FRAME_TOOL_NAME)
  const result = await submit.execute('submit-frame-1', { frameRef, protected: protectedPlan })
  assert.equal(instance.calls.resolve.length, 1)
  assert.deepEqual(instance.calls.resolve[0], { frameRef, imageScope: scope, sessionKey: context.sessionKey })
  assert.equal(instance.calls.submit.length, 1)
  assert.deepEqual(instance.calls.submit[0].images, ['/private/qwen/media/video-frame-references/frame-a.jpg'])
  assert.equal(instance.calls.submit[0].scope, scope)
  assert.equal(instance.calls.submit[0].protected.textLayers[0].role, 'title')
  assert.equal(result.details.jobId, 'c'.repeat(32))
  assert.match(result.content[0].text, /任务编号/u)
})

test('expired or cross-session references cannot reach the image queue', async () => {
  const instance = tools({ videoFrameStore: {
    async captureBatch() { return [] },
    async resolve() { throw new Error('video_frame_reference_scope_mismatch') },
  } })
  const submit = instance.tools.find(item => item.name === IMAGE_SUBMIT_PROTECTED_FRAME_TOOL_NAME)
  const result = await submit.execute('submit-frame-2', { frameRef, protected: protectedPlan })
  assert.equal(result.details.errorCode, 'VIDEO_FRAME_REFERENCE_INVALID')
  assert.equal(instance.calls.submit.length, 0)
})
