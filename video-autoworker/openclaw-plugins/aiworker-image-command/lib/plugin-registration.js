import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'

import { createImageCommandTool, IMAGE_AGENT_ID, IMAGE_COMMAND_TOOL_NAME } from './image-command-tool.js'
import { createImageJobClient } from './image-job-client.js'
import { createImageNotifications } from './image-notifications.js'

function notificationBinding(env) {
  const profile = env.OPENCLAW_PROFILE
  const stateDir = env.OPENCLAW_STATE_DIR
  // These values belong to the host process, never to model tool arguments.
  // The dedicated managed profile sets both explicitly on startup.
  if (profile !== IMAGE_AGENT_ID || typeof stateDir !== 'string' || !isAbsolute(stateDir)
    || normalize(stateDir) !== stateDir || /[\u0000-\u001f\u007f]/u.test(stateDir)) {
    throw new Error('image_notification_profile_binding_invalid')
  }
  const identity = createHash('sha256').update(JSON.stringify([profile, stateDir])).digest('hex')
  return { stateDir, key: `aiworker-image-command:notifications:v1:${identity}` }
}

export function registerImageCommands(api, {
  createRuntimeStore,
  saveMedia,
  env = process.env,
  createClient = createImageJobClient,
  createNotifications = createImageNotifications,
} = {}) {
  const binding = notificationBinding(env)
  const store = createRuntimeStore({ key: binding.key, errorMessage: 'image_notification_service_not_started' })
  const client = createClient()
  const controller = createNotifications({ client, system: api.runtime.system })
  let ownedRuntime

  async function withRunningNotifications(action, subscription) {
    const runtime = store.getRuntime()
    await runtime.ready
    return runtime.controller[action](subscription)
  }

  // OpenClaw loads startup and tool-discovery registries independently. Publish
  // only the started service through its official cross-module runtime slot;
  // tool factories must not close over their unstarted discovery controller.
  api.registerService({
    id: controller.id,
    async start(context) {
      if (context.stateDir !== binding.stateDir) throw new Error('image_notification_profile_binding_mismatch')
      const active = store.tryGetRuntime()
      if (active && active !== ownedRuntime) throw new Error('image_notification_service_already_started')
      if (ownedRuntime) return ownedRuntime.ready
      const runtime = { controller, ready: undefined }
      ownedRuntime = runtime
      store.setRuntime(runtime)
      runtime.ready = Promise.resolve().then(() => controller.start(context)).catch(error => {
        if (store.tryGetRuntime() === runtime) store.clearRuntime()
        ownedRuntime = undefined
        throw error
      })
      return runtime.ready
    },
    async stop() {
      if (ownedRuntime && store.tryGetRuntime() === ownedRuntime) store.clearRuntime()
      await ownedRuntime?.ready.catch(() => {})
      await controller.stop()
      ownedRuntime = undefined
    },
  })
  api.registerTool(context => createImageCommandTool({
    context,
    client,
    releaseReady: api.pluginConfig?.releaseReady === true,
    saveMedia,
    onSubmitted: subscription => withRunningNotifications('subscribe', subscription),
    onReceiptRead: subscription => withRunningNotifications('acknowledge', subscription),
  }), { names: [IMAGE_COMMAND_TOOL_NAME], optional: true })
}
