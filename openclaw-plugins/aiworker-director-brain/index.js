import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

import {
  createDirectorBrainTool,
  DEFAULT_TARGET_AGENT_ID,
  DIRECTOR_BRAIN_TOOL_NAME,
} from './lib/director-brain-tool.js'
import {
  projectAiworkerMessageForTargetAgent,
  projectAiworkerToolResultForTargetAgent,
} from './lib/transcript-tool-result-projection.js'
import { createDirectorBrainSystemQuestionHandler } from './lib/director-system-question-router.js'

const TRANSCRIPT_LAST_DEFENSE_PRIORITY = -1_000

export default definePluginEntry({
  id: 'aiworker-director-brain',
  name: 'AI-worker Director Brain',
  description: 'OpenClaw access to work-scoped director context, global techniques, and shared extraction workflows.',
  register(api) {
    const releaseReady = api.pluginConfig?.releaseReady === true
    const targetAgentId = api.pluginConfig?.targetAgentId?.trim() || DEFAULT_TARGET_AGENT_ID
    api.registerTool(context => createDirectorBrainTool({
      context,
      releaseReady,
      targetAgentId,
    }), {
      names: [DIRECTOR_BRAIN_TOOL_NAME],
      optional: true,
    })
    api.on('before_agent_reply', createDirectorBrainSystemQuestionHandler({
      releaseReady,
      targetAgentId,
    }), {
      priority: 200,
      eligibleTriggers: ['user'],
      // The handler returns its own fail-closed reply within 30 s. Keep the
      // host deadline slightly larger so OpenClaw never falls through to the
      // model merely because the canonical read failed or timed out.
      timeoutMs: 35_000,
    })
    api.on('tool_result_persist', (event, context) => (
      projectAiworkerToolResultForTargetAgent(event, context, targetAgentId)
    ), { priority: TRANSCRIPT_LAST_DEFENSE_PRIORITY })
    api.on('before_message_write', (event, context) => (
      projectAiworkerMessageForTargetAgent(event, context, targetAgentId)
    ), { priority: TRANSCRIPT_LAST_DEFENSE_PRIORITY })
  },
})
