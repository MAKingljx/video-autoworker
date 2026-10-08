import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'
import { registerEditingTool } from './lib/registration.js'

export default definePluginEntry({
  id: 'aiworker-editing', name: 'AI-worker Editing',
  description: 'GPT main access to the application-owned editing plan and evidence service.',
  register(api) { registerEditingTool(api) },
})
