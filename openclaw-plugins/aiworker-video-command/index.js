import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

import { createBeforeDispatchHandler } from './lib/before-dispatch.js'

export default definePluginEntry({
  id: 'aiworker-video-command',
  name: 'AI-worker Video Command',
  description: 'Deterministic Telegram video-command dispatch for AI-worker.',
  register(api) {
    api.on('before_dispatch', createBeforeDispatchHandler(), {
      priority: 100,
      timeoutMs: 40_000,
    })
  },
})
