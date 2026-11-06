import test from 'node:test'
import assert from 'node:assert/strict'

import {
  IMAGE_SUBMIT_CREATIVE_TOOL_NAME,
  IMAGE_TASK_TOOL_NAME,
  IMAGE_VIDEO_COVER_WORKFLOW_TOOL_NAME,
} from '../lib/image-command-tool.js'
import { createImageTranscriptReceiptBridge } from '../lib/image-transcript-receipt-bridge.js'

const sessionKey = 'agent:second-original:feishu:direct:ou_safe-user'
const context = { agentId: 'second-original', sessionKey }
const jobId = 'a'.repeat(32)

function rawResult({ toolName = IMAGE_SUBMIT_CREATIVE_TOOL_NAME, details, isError = false } = {}) {
  return {
    toolName,
    message: {
      role: 'toolResult',
      toolName,
      toolCallId: 'call-image-1',
      content: [{ type: 'text', text: 'private prompt /Users/private/source.png MEDIA:/private/out.png' }],
      details,
      isError,
    },
  }
}

function genericResult() {
  return {
    message: {
      role: 'toolResult',
      toolName: IMAGE_SUBMIT_CREATIVE_TOOL_NAME,
      toolCallId: 'call-image-1',
      content: [{ type: 'text', text: '工具执行已完成；长期会话仅保留本轮助手结论。' }],
      isError: false,
    },
  }
}

test('safe receipt bridge restores only image task receipt after a generic transcript projection', () => {
  const bridge = createImageTranscriptReceiptBridge({
    isEligible: value => value?.agentId === 'second-original' && value?.sessionKey === sessionKey,
  })
  assert.equal(bridge.capture(rawResult({ details: {
    jobId, currentState: 'QUEUED', nextAction: 'WAIT_FOR_IMAGE_NOTIFICATION',
    prompt: 'must-not-persist', source: '/Users/private/source.png', media: 'base64',
  } }), context), undefined)

  const projected = bridge.project(genericResult(), context)
  assert.equal(projected.message.toolName, IMAGE_SUBMIT_CREATIVE_TOOL_NAME)
  assert.equal(projected.message.toolCallId, 'call-image-1')
  assert.equal(projected.message.isError, false)
  assert.match(projected.message.content[0].text, new RegExp(`jobId=${jobId}`, 'u'))
  assert.match(projected.message.content[0].text, /currentState=QUEUED/u)
  assert.match(projected.message.content[0].text, /nextAction=WAIT_FOR_IMAGE_NOTIFICATION/u)
  assert.doesNotMatch(JSON.stringify(projected), /private|base64|prompt|source\.png/u)
})

test('invalid image submission remains an actionable error after the generic projector', () => {
  const bridge = createImageTranscriptReceiptBridge()
  bridge.capture(rawResult({
    details: { errorCode: 'IMAGE_REQUEST_INVALID', nextAction: 'PROVIDE_REQUIRED_IMAGE_SUBMISSION_FIELDS' },
    isError: true,
  }), context)
  const projected = bridge.project(genericResult(), context)
  assert.equal(projected.message.isError, true)
  assert.match(projected.message.content[0].text, /errorCode=IMAGE_REQUEST_INVALID/u)
  assert.match(projected.message.content[0].text, /nextAction=PROVIDE_REQUIRED_IMAGE_SUBMISSION_FIELDS/u)
})

test('unified video-cover submission preserves the same bounded image receipt', () => {
  const bridge = createImageTranscriptReceiptBridge()
  bridge.capture(rawResult({
    toolName: IMAGE_VIDEO_COVER_WORKFLOW_TOOL_NAME,
    details: { jobId, currentState: 'QUEUED', nextAction: 'WAIT_FOR_IMAGE_NOTIFICATION' },
  }), context)
  const projected = bridge.project({
    message: { role: 'toolResult', toolName: IMAGE_VIDEO_COVER_WORKFLOW_TOOL_NAME,
      toolCallId: 'call-image-1', content: [], isError: false },
  }, context)
  assert.match(projected.message.content[0].text, new RegExp(`jobId=${jobId}`, 'u'))
})

test('bridge ignores non-image tools and a different trusted-agent context', () => {
  const bridge = createImageTranscriptReceiptBridge({
    isEligible: value => value?.agentId === 'second-original' && value?.sessionKey === sessionKey,
  })
  bridge.capture(rawResult({ toolName: 'exec', details: { errorCode: 'IMAGE_REQUEST_INVALID' } }), context)
  assert.equal(bridge.project(genericResult(), context), undefined)

  bridge.capture(rawResult({ toolName: IMAGE_TASK_TOOL_NAME, details: { jobId, currentState: 'RUNNING' } }), {
    agentId: 'other', sessionKey,
  })
  const event = {
    message: { role: 'toolResult', toolName: IMAGE_TASK_TOOL_NAME, toolCallId: 'call-image-1', content: [] },
  }
  assert.equal(bridge.project(event, context), undefined)
})
