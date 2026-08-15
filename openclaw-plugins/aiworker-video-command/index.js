import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

import { createQwenClassifier } from './lib/qwen-video-classifier.js'
import { createQwenBeforeDispatchHandler } from './lib/qwen-before-dispatch.js'

export default definePluginEntry({
  id: 'aiworker-video-command',
  name: 'AI-worker Video Command',
  description: 'Qwen-classified, hook-owned video learning dispatch and one-shot status reads.',
  register(api) {
    const handler = createQwenBeforeDispatchHandler({
      classifier: createQwenClassifier({
        complete: params => api.runtime.llm.complete(params),
      }),
      allowedSenderSha256: api.pluginConfig?.allowedSenderSha256,
      releaseReady: api.pluginConfig?.releaseReady === true,
    })

    api.on('before_dispatch', handler, {
      priority: 100,
      // The local Qwen simple-completion path has observed 44-66 s latency.
      // Keep the host timeout above the 90 s classifier deadline plus the
      // runner's bounded 25 s subprocess call so our fail-closed reply wins.
      timeoutMs: 140_000,
    })
  },
})
