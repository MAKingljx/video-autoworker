import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

import {
  createDirectorBrainTool,
  DEFAULT_TARGET_AGENT_ID,
  DIRECTOR_BRAIN_TOOL_NAME,
} from './lib/director-brain-tool.js'

export default definePluginEntry({
  id: 'aiworker-director-brain',
  name: 'AI-worker Director Brain',
  description: 'Work-scoped OpenClaw access to the isolated Feishu director knowledge brain.',
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
  },
})
