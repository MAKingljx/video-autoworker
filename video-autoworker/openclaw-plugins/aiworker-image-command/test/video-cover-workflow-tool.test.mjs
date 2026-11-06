import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createImageCommandTools,
  IMAGE_COMMAND_TOOL_NAMES,
  IMAGE_VIDEO_COVER_WORKFLOW_TOOL_NAME,
  imageCommandToolNamesForProfile,
  imageSessionScope,
} from '../lib/image-command-tool.js'

const binding = { profile: 'qwen-current', targetAgentId: 'second-original' }
const context = { agentId: 'second-original', sessionKey: 'agent:second-original:video-cover-test' }
const scope = imageSessionScope(context, binding)
const operationId = 'b'.repeat(32)
const frameRef = 'a'.repeat(32)
const frameData = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]).toString('base64')
const protectedPlan = {
  schema: 'aiworker-protected-cover/v1',
  textLayers: [{ text: '老大的火车体验又升级了', box: { x: 30, y: 30, width: 800, height: 160 } }],
}

function tools(overrides = {}) {
  const calls = { segments: [], frames: [], begin: [], workflow: [], capture: [], resolve: [], submit: [] }
  const videoWorkflowClient = overrides.videoWorkflowClient ?? {
    async segments(value) {
      calls.segments.push(value)
      return {
        videoName: '北美火车短片.mp4', totalSegments: 25, directoryPreviewCompacted: false,
        items: [
          { index: 2, timeRange: '00:00:05-00:00:10', summary: '不可用片段', available: false },
          { index: 3, timeRange: '00:00:10-00:00:15', summary: '蒸汽火车驶入站台，司机在驾驶室。', available: true },
        ],
      }
    },
    async frames(value) {
      calls.frames.push(value)
      return { videoName: '北美火车短片.mp4', totalSegments: 25, candidates: [0, 1, 2].map(index => ({
        frameRef: index === 0 ? frameRef : String(index + 1).repeat(32),
        segmentIndex: 3, timeRange: '00:00:10-00:00:15', frameTimeSeconds: [11, 12.5, 14][index],
        videoName: '北美火车短片.mp4', width: 1920, height: 1080,
        sha256: 'c'.repeat(64), data: frameData, bytesBuffer: Buffer.from(frameData, 'base64'),
      })) }
    },
  }
  const videoFrameStore = overrides.videoFrameStore ?? {
    async beginWorkflow(value) {
      calls.begin.push(value)
      return { operationId, videoName: value.videoName, segmentIndexes: value.segmentIndexes }
    },
    async resolveWorkflow(value) {
      calls.workflow.push(value)
      return { operationId: value.operationId, videoName: '北美火车短片.mp4', segmentIndexes: [3] }
    },
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
      return { jobId: 'd'.repeat(32), currentState: 'QUEUED', mode: 'protected' }
    },
  }
  return {
    calls,
    tools: createImageCommandTools({ context, binding, videoWorkflowClient, videoFrameStore, client }),
  }
}

function workflowTool(instance) {
  const tool = instance.tools.find(item => item.name === IMAGE_VIDEO_COVER_WORKFLOW_TOOL_NAME)
  assert.ok(tool, 'missing unified video cover workflow tool')
  return tool
}

test('qwen-current exposes one direct-only video-cover workflow instead of the legacy frame pair', () => {
  assert.deepEqual(imageCommandToolNamesForProfile('qwen-current'), [
    ...IMAGE_COMMAND_TOOL_NAMES, IMAGE_VIDEO_COVER_WORKFLOW_TOOL_NAME,
  ])
  assert.deepEqual(imageCommandToolNamesForProfile('image-studio'), IMAGE_COMMAND_TOOL_NAMES)
  const instance = tools()
  const tool = workflowTool(instance)
  assert.equal(tool.catalogMode, 'direct-only')
  assert.match(tool.description, /唯一规范入口/u)
  assert.equal(instance.tools.some(item => item.name === 'aiworker_video_cover_frames'), false)
  assert.equal(instance.tools.some(item => item.name === 'aiworker_submit_protected_cover_from_frame'), false)
})

test('the unified state machine returns a directory, native frames, then one protected submission', async () => {
  const instance = tools()
  const tool = workflowTool(instance)
  const directory = await tool.execute('cover-directory', { action: 'read_segments', query: '北美火车短片.mp4' })
  assert.deepEqual(instance.calls.segments, [{ query: '北美火车短片.mp4' }])
  assert.deepEqual(instance.calls.begin[0], {
    imageScope: scope, sessionKey: context.sessionKey, videoName: '北美火车短片.mp4', segmentIndexes: [3],
  })
  assert.equal(directory.details.phase, 'segments')
  assert.equal(directory.details.operationId, operationId)
  assert.match(directory.content[0].text, /operationId=/u)

  const frames = await tool.execute('cover-frames', { action: 'cover_frames', operationId, segmentIndex: 3 })
  assert.deepEqual(instance.calls.workflow[0], { operationId, imageScope: scope, sessionKey: context.sessionKey })
  assert.deepEqual(instance.calls.frames, [{ query: '北美火车短片.mp4', segmentIndex: 3 }])
  assert.deepEqual(instance.calls.capture[0], {
    imageScope: scope, sessionKey: context.sessionKey, workflowId: operationId, candidates: expectCandidates(),
  })
  assert.equal(frames.details.phase, 'frames')
  assert.equal(frames.content.filter(item => item.type === 'image').length, 3)
  assert.doesNotMatch(JSON.stringify(frames), /\/private\//u)

  const submitted = await tool.execute('cover-submit', {
    action: 'submit_protected_cover', operationId, frameRef, protected: protectedPlan,
  })
  assert.deepEqual(instance.calls.resolve[0], { frameRef, imageScope: scope, sessionKey: context.sessionKey, workflowId: operationId })
  assert.equal(instance.calls.submit.length, 1)
  assert.deepEqual(instance.calls.submit[0].images, ['/private/qwen/media/video-frame-references/frame-a.jpg'])
  assert.equal(submitted.details.phase, 'submitted')
  assert.equal(submitted.details.jobId, 'd'.repeat(32))
  assert.match(submitted.content[0].text, /任务编号/u)
})

function expectCandidates() {
  return [0, 1, 2].map(index => ({
    frameRef: index === 0 ? frameRef : String(index + 1).repeat(32), segmentIndex: 3,
    timeRange: '00:00:10-00:00:15', frameTimeSeconds: [11, 12.5, 14][index],
    videoName: '北美火车短片.mp4', width: 1920, height: 1080,
    sha256: 'c'.repeat(64), data: frameData, bytesBuffer: Buffer.from(frameData, 'base64'),
  }))
}

test('the workflow rejects skipped phases and never reaches the image queue', async () => {
  const instance = tools({ videoFrameStore: {
    async resolveWorkflow() { throw new Error('video_frame_reference_scope_mismatch') },
  } })
  const tool = workflowTool(instance)
  const result = await tool.execute('bad-submit', {
    action: 'submit_protected_cover', operationId, frameRef, protected: protectedPlan,
  })
  assert.equal(result.isError, true)
  assert.equal(result.details.phase, 'failed')
  assert.equal(instance.calls.submit.length, 0)
})

test('repeated stages reuse scoped workflow state instead of reading or extracting again', async () => {
  const instance = tools({ videoFrameStore: {
    async findWorkflow() { return { operationId, videoName: '北美火车短片.mp4', segmentIndexes: [3] } },
    async resolveWorkflow() { return { operationId, videoName: '北美火车短片.mp4', segmentIndexes: [3] } },
    async listWorkflowFrames() { return [{
      frameRef, segmentIndex: 3, timeRange: '00:00:10-00:00:15', width: 1920, height: 1080,
      sha256: 'c'.repeat(64), data: frameData,
    }] },
  } })
  const tool = workflowTool(instance)
  const directory = await tool.execute('repeat-directory', { action: 'read_segments', query: '北美火车短片.mp4' })
  assert.equal(directory.details.status, 'blocked')
  assert.equal(instance.calls.segments.length, 0)
  const frames = await tool.execute('repeat-frames', { action: 'cover_frames', operationId, segmentIndex: 3 })
  assert.equal(frames.details.status, 'blocked')
  assert.equal(instance.calls.frames.length, 0)
  assert.equal(frames.content.filter(item => item.type === 'image').length, 1)
})
