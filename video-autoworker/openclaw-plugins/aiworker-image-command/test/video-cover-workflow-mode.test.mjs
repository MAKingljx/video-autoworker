import assert from 'node:assert/strict'
import test from 'node:test'

import { createVideoCoverWorkflowMode, isVideoCoverWorkflowRequest } from '../lib/video-cover-workflow-mode.js'

const context = { agentId: 'second-original', sessionKey: 'agent:second-original:feishu:direct:test' }

test('detects only video-cover requests and narrows their tool surface to the workflow facade', () => {
  assert.equal(isVideoCoverWorkflowRequest('用北美火车短片.mp4的学习资料生成视频封面'), true)
  assert.equal(isVideoCoverWorkflowRequest('给我看北美火车短片的学习摘要'), false)
  assert.equal(isVideoCoverWorkflowRequest('帮我设计一个产品封面'), false)
  const mode = createVideoCoverWorkflowMode()
  assert.deepEqual(mode({ currentUserMessage: '用北美火车短片.mp4的学习资料生成视频封面' }, context), {
    toolsAllow: ['aiworker_video_cover_workflow'],
  })
  assert.equal(mode({ currentUserMessage: '看学习进度' }, context), undefined)
  assert.equal(mode({ currentUserMessage: '生成视频封面' }, { ...context, agentId: 'other' }), undefined)
})
