import { IMAGE_VIDEO_COVER_WORKFLOW_TOOL_NAME } from './image-command-tool.js'

const TARGET_AGENT_ID = 'second-original'
const COVER_TERMS = /(?:封面|封皮|头图|缩略图|thumbnail|cover)/iu
const VIDEO_TERMS = /(?:视频|短片|素材|片段|镜头|原片|mp4|mov|学习)/iu

export function isVideoCoverWorkflowRequest(value) {
  return typeof value === 'string' && value.length <= 32_768
    && COVER_TERMS.test(value) && VIDEO_TERMS.test(value)
}

/**
 * Route one cover request to the direct-only workflow before model submission.
 * The return value narrows the normal policy-approved tool set; it cannot grant
 * any additional capability or alter task/image application state.
 */
export function createVideoCoverWorkflowMode() {
  return function videoCoverWorkflowMode(event, context) {
    if (context?.agentId !== TARGET_AGENT_ID) return undefined
    // Never infer mode from reconstructed history: a past cover request must
    // not narrow a later unrelated turn. Unsupported harnesses simply retain
    // their ordinary policy rather than guessing a request boundary.
    const current = typeof event?.currentUserMessage === 'string'
      ? event.currentUserMessage : ''
    if (!isVideoCoverWorkflowRequest(current)) return undefined
    return { toolsAllow: [IMAGE_VIDEO_COVER_WORKFLOW_TOOL_NAME] }
  }
}
