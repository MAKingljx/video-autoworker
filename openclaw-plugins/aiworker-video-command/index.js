import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'

import { createBeforeDispatchHandler } from './lib/before-dispatch.js'

export default definePluginEntry({
  id: 'aiworker-video-command',
  name: 'AI-worker Video Command',
  description: 'Deterministic Telegram video dispatch and bounded task status queries.',
  register(api) {
    const beforeDispatch = createBeforeDispatchHandler({
      allowedSenderSha256: api.pluginConfig?.allowedSenderSha256,
    })

    api.on('before_dispatch', beforeDispatch, {
      priority: 100,
      timeoutMs: 40_000,
    })
  },
})
