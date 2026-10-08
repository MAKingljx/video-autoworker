import { homedir } from 'node:os'
import { join } from 'node:path'
import { createEditingTool, EDITING_TOOL_NAME } from './tool.js'
import { createEditingClient } from './client.js'

export function registerEditingTool(api, { env = process.env, home = homedir(), createClient = createEditingClient } = {}) {
  const expectedState = join(home, '.openclaw-gpt-main')
  if (env.OPENCLAW_PROFILE !== 'gpt-main' || env.OPENCLAW_STATE_DIR !== expectedState) {
    throw new Error('editing_profile_binding_invalid')
  }
  const client = createClient()
  api.registerTool(context => createEditingTool({ context, client, releaseReady: api.pluginConfig?.releaseReady === true }),
    { names: [EDITING_TOOL_NAME], optional: true })
}
