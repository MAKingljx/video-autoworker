import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { saveMediaBuffer } from 'openclaw/plugin-sdk/media-runtime'
import { createPluginRuntimeStore } from 'openclaw/plugin-sdk/runtime-store'

import { registerImageCommands } from './lib/plugin-registration.js'
import { PROTECTED_IMAGE_BYTES_LIMIT } from './lib/image-job-client.js'

export default definePluginEntry({
  id: 'aiworker-image-command',
  name: 'AI-worker Image Command',
  description: 'Session-scoped access to the shared H1 image service.',
  register(api) {
    registerImageCommands(api, {
      createRuntimeStore: createPluginRuntimeStore,
      // The application client retains the raw 10MiB cap; only verified
      // protected-mode source-sized images can reach this HD storage bound.
      saveMedia: buffer => saveMediaBuffer(buffer, 'image/png', 'outbound', PROTECTED_IMAGE_BYTES_LIMIT),
    })
  },
})
