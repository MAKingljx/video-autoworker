import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

import {
  createDirectorBrainTool,
  DEFAULT_TARGET_AGENT_ID,
  DIRECTOR_BRAIN_TOOL_NAME,
  loadInstalledDirectorBrainReviewServices,
} from './lib/director-brain-tool.js'
import {
  createDirectorBrainChatReviewHandler,
  createDirectorReviewSessionStore,
} from './lib/director-chat-review.js'
import {
  projectAiworkerMessageForTargetAgent,
  projectAiworkerToolResultForTargetAgent,
} from './lib/transcript-tool-result-projection.js'
import { createDirectorBrainSystemQuestionHandler } from './lib/director-system-question-router.js'

const TRANSCRIPT_LAST_DEFENSE_PRIORITY = -1_000
const CHAT_REVIEW_HOOK_TIMEOUT_MS = 10 * 60 * 1000

export default definePluginEntry({
  id: 'aiworker-director-brain',
  name: 'AI-worker Director Brain',
  description: 'OpenClaw access to work-scoped director context, global techniques, and shared extraction workflows.',
  register(api) {
    const releaseReady = api.pluginConfig?.releaseReady === true
    const targetAgentId = api.pluginConfig?.targetAgentId?.trim() || DEFAULT_TARGET_AGENT_ID
    const onDiagnostic = diagnostic => api.logger?.warn?.(JSON.stringify(diagnostic))
    const reviewSessionStore = createDirectorReviewSessionStore()
    api.registerTool(context => createDirectorBrainTool({
      context,
      releaseReady,
      targetAgentId,
      reviewSessionStore,
      onDiagnostic,
    }), {
      names: [DIRECTOR_BRAIN_TOOL_NAME],
      optional: true,
    })
    const chatReviewHandler = createDirectorBrainChatReviewHandler({
      releaseReady,
      targetAgentId,
      store: reviewSessionStore,
      loadServices: loadInstalledDirectorBrainReviewServices,
      onDiagnostic,
    })
    const systemQuestionHandler = createDirectorBrainSystemQuestionHandler({
      releaseReady,
      targetAgentId,
      onDiagnostic,
    })
    api.on('before_agent_reply', async (event, context) => (
      await chatReviewHandler(event, context)
      || systemQuestionHandler(event, context)
    ), {
      priority: 200,
      eligibleTriggers: ['user'],
      // Review batches retain a bounded nine-minute work budget. The host
      // deadline stays larger so a timed-out hook cannot continue writes after
      // OpenClaw has fallen through to another reply path.
      timeoutMs: CHAT_REVIEW_HOOK_TIMEOUT_MS,
    })
    api.on('tool_result_persist', (event, context) => (
      projectAiworkerToolResultForTargetAgent(event, context, targetAgentId)
    ), { priority: TRANSCRIPT_LAST_DEFENSE_PRIORITY })
    api.on('before_message_write', (event, context) => (
      projectAiworkerMessageForTargetAgent(event, context, targetAgentId)
    ), { priority: TRANSCRIPT_LAST_DEFENSE_PRIORITY })
  },
})
