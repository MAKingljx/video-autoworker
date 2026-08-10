import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

import { createBeforeDispatchHandler } from './lib/before-dispatch.js'
import {
  createNaturalVideoToolRuntime,
  NATURAL_VIDEO_TOOL_NAME,
} from './lib/natural-video-tool.js'

export default definePluginEntry({
  id: 'aiworker-video-command',
  name: 'AI-worker Video Command',
  description: 'Deterministic exact-command dispatch and guarded natural-language video submission.',
  register(api) {
    const naturalVideo = createNaturalVideoToolRuntime({ runContext: api.runContext })
    const exactDispatch = createBeforeDispatchHandler()

    api.on('before_dispatch', async (event, context) => {
      const exactResult = await exactDispatch(event, context)
      if (exactResult !== undefined) return exactResult
      naturalVideo.beforeDispatch(event, context)
      return undefined
    }, {
      priority: 100,
      timeoutMs: 40_000,
    })
    api.on('before_prompt_build', naturalVideo.beforePromptBuild, {
      priority: 100,
      timeoutMs: 1_000,
    })
    api.on('before_tool_call', naturalVideo.beforeToolCall, {
      priority: 100,
      timeoutMs: 1_000,
    })
    api.registerTool(context => naturalVideo.createTool(context), {
      names: [NATURAL_VIDEO_TOOL_NAME],
      optional: true,
    })
  },
})
