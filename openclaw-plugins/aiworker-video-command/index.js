import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

import { createQwenClassifier } from './lib/qwen-video-classifier.js'
import { createQwenBeforeDispatchHandler } from './lib/qwen-before-dispatch.js'
import { createTaskChainTool, TASK_CHAIN_TOOL_NAME } from './lib/task-chain-tool.js'

export default definePluginEntry({
  id: 'aiworker-video-command',
  name: 'AI-worker Video Command',
  description: 'Hook-owned video learning dispatch and direct task-chain tool access.',
  register(api) {
    const handler = createQwenBeforeDispatchHandler({
      classifier: createQwenClassifier({
        complete: params => api.runtime.llm.complete(params),
      }),
      releaseReady: api.pluginConfig?.releaseReady === true,
    })

    api.on('before_dispatch', handler, {
      priority: 100,
      // The local Qwen simple-completion path has observed 44-66 s latency.
      // Keep the host timeout above the 90 s classifier deadline plus the
      // runner's bounded 25 s subprocess call so our fail-closed reply wins.
      timeoutMs: 140_000,
    })
    api.registerTool(context => createTaskChainTool({
      context,
      releaseReady: api.pluginConfig?.releaseReady === true,
    }), {
      names: [TASK_CHAIN_TOOL_NAME],
      optional: true,
    })
  },
})
