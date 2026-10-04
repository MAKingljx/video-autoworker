import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { saveMediaBuffer } from 'openclaw/plugin-sdk/media-runtime'

import { createImageCommandTool, IMAGE_COMMAND_TOOL_NAME } from './lib/image-command-tool.js'
import { createImageJobClient } from './lib/image-job-client.js'
import { createImageNotifications } from './lib/image-notifications.js'

export default definePluginEntry({
  id: 'aiworker-image-command',
  name: 'AI-worker Image Command',
  description: 'Session-scoped access to the shared H1 image service.',
  register(api) {
    const client = createImageJobClient()
    const notifications = createImageNotifications({ client, system: api.runtime.system })
    api.registerService(notifications)
    api.registerTool(context => createImageCommandTool({
      context,
      client,
      releaseReady: api.pluginConfig?.releaseReady === true,
      saveMedia: buffer => saveMediaBuffer(buffer, 'image/png', 'outbound', 10 * 1024 * 1024),
      onSubmitted: subscription => notifications.subscribe(subscription),
      onReceiptRead: subscription => notifications.acknowledge(subscription),
    }), { names: [IMAGE_COMMAND_TOOL_NAME], optional: true })
  },
})
