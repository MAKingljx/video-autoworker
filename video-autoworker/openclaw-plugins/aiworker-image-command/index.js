import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { saveMediaBuffer } from 'openclaw/plugin-sdk/media-runtime'
import { createPluginRuntimeStore } from 'openclaw/plugin-sdk/runtime-store'

import { registerImageCommands } from './lib/plugin-registration.js'

export default definePluginEntry({
  id: 'aiworker-image-command',
  name: 'AI-worker Image Command',
  description: 'Session-scoped access to the shared H1 image service.',
  register(api) {
    registerImageCommands(api, {
      createRuntimeStore: createPluginRuntimeStore,
      saveMedia: buffer => saveMediaBuffer(buffer, 'image/png', 'outbound', 10 * 1024 * 1024),
    })
  },
})
