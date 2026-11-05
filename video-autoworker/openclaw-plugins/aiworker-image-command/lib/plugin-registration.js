import { createHash } from 'node:crypto'

import {
  createImageCommandTools,
  createImageSubmissionFence,
  IMAGE_COMMAND_TOOL_NAMES,
} from './image-command-tool.js'
import { createImageJobClient } from './image-job-client.js'
import { createImageNotifications } from './image-notifications.js'
import { imageSessionScope, resolveImagePluginBinding } from './image-profile-binding.js'
import { createImageTranscriptReceiptBridge } from './image-transcript-receipt-bridge.js'

const RECEIPT_CAPTURE_PRIORITY = 100
// The director-brain transcript projector runs at -1000. Project the safe
// image receipt afterwards so its generic long-session reduction cannot hide
// a job id or the actionable image error code.
const RECEIPT_PROJECT_PRIORITY = -1001

function notificationBinding(env, pluginConfig) {
  const binding = resolveImagePluginBinding(env, pluginConfig)
  const identity = createHash('sha256').update(JSON.stringify([
    binding.profile, binding.targetAgentId, binding.stateDir,
  ])).digest('hex')
  return { ...binding, key: `aiworker-image-command:notifications:v2:${identity}` }
}

export function registerImageCommands(api, {
  createRuntimeStore,
  saveMedia,
  env = process.env,
  createClient = createImageJobClient,
  createNotifications = createImageNotifications,
} = {}) {
  const binding = notificationBinding(env, api.pluginConfig)
  const store = createRuntimeStore({ key: binding.key, errorMessage: 'image_notification_service_not_started' })
  const receiptStore = createRuntimeStore({
    key: `${binding.key}:transcript-receipt-bridge`,
    errorMessage: 'image_transcript_receipt_bridge_not_started',
  })
  const client = createClient()
  const controller = createNotifications({ client, system: api.runtime.system, binding })
  const submissionFence = createImageSubmissionFence()
  const receiptBridge = receiptStore.tryGetRuntime() ?? createImageTranscriptReceiptBridge({
    isEligible: context => imageSessionScope(context, binding) !== null,
  })
  receiptStore.setRuntime(receiptBridge)
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
  for (const name of IMAGE_COMMAND_TOOL_NAMES) {
    api.registerTool(context => createImageCommandTools({
      context, binding,
      client,
      releaseReady: api.pluginConfig?.releaseReady === true,
      saveMedia,
      submissionFence,
      onSubmitted: subscription => withRunningNotifications('subscribe', subscription),
      onReceiptRead: subscription => withRunningNotifications('acknowledge', subscription),
    }).find(tool => tool.name === name) ?? null, { names: [name], optional: true })
  }
  if (typeof api.on === 'function') {
    api.on('tool_result_persist', (event, context) => receiptBridge.capture(event, context), {
      priority: RECEIPT_CAPTURE_PRIORITY,
    })
    api.on('tool_result_persist', (event, context) => receiptBridge.project(event, context), {
      priority: RECEIPT_PROJECT_PRIORITY,
    })
    api.on('before_message_write', (event, context) => receiptBridge.project(event, context), {
      priority: RECEIPT_PROJECT_PRIORITY,
    })
  }
}
