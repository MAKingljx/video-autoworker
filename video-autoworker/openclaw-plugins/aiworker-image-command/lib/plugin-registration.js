import { createHash } from 'node:crypto'

import {
  createImageCommandTools,
  createImageSubmissionFence,
  imageCommandToolNamesForProfile,
} from './image-command-tool.js'
import { createImageJobClient } from './image-job-client.js'
import { createVideoCoverWorkflowClient } from './video-cover-workflow-client.js'
import { createVideoFrameReferenceStore } from './video-frame-reference-store.js'
import { createVideoCoverSubmissionAttemptStore } from './video-cover-submission-attempt-store.js'
import { createImageNotifications } from './image-notifications.js'
import { createImageJobCapabilityStore } from './image-job-capability-store.js'
import { imageSessionScope, resolveImagePluginBinding } from './image-profile-binding.js'
import { createImageTranscriptReceiptBridge } from './image-transcript-receipt-bridge.js'
import { createVideoCoverWorkflowMode } from './video-cover-workflow-mode.js'

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
  const capabilityRuntimeStore = createRuntimeStore({
    key: `${binding.key}:job-capabilities`, errorMessage: 'image_job_capability_service_not_started',
  })
  const receiptStore = createRuntimeStore({
    key: `${binding.key}:transcript-receipt-bridge`,
    errorMessage: 'image_transcript_receipt_bridge_not_started',
  })
  const client = createClient()
  const frameToolsEnabled = binding.profile === 'qwen-current'
  const videoWorkflowClient = frameToolsEnabled ? createVideoCoverWorkflowClient() : undefined
  const videoFrameStore = frameToolsEnabled ? createVideoFrameReferenceStore({ stateDir: binding.stateDir }) : undefined
  const videoCoverAttemptStore = frameToolsEnabled
    ? createVideoCoverSubmissionAttemptStore({ stateDir: binding.stateDir, binding }) : undefined
  const controller = createNotifications({ client, system: api.runtime.system, binding })
  const jobCapabilities = createImageJobCapabilityStore({ binding })
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
  async function withRunningJobCapabilities(action, request) {
    const runtime = capabilityRuntimeStore.getRuntime()
    await runtime.ready
    return runtime.jobCapabilities[action](request)
  }

  // OpenClaw loads startup and tool-discovery registries independently. Publish
  // only the started service through its official cross-module runtime slot;
  // tool factories must not close over their unstarted discovery controller.
  api.registerService({
    id: controller.id,
    async start(context) {
      if (context.stateDir !== binding.stateDir) throw new Error('image_notification_profile_binding_mismatch')
      const active = store.tryGetRuntime()
      const activeCapabilities = capabilityRuntimeStore.tryGetRuntime()
      if ((active && active !== ownedRuntime) || (activeCapabilities && activeCapabilities !== ownedRuntime)) {
        throw new Error('image_notification_service_already_started')
      }
      if (ownedRuntime) return ownedRuntime.ready
      const runtime = { controller, jobCapabilities, ready: undefined }
      ownedRuntime = runtime
      store.setRuntime(runtime)
      capabilityRuntimeStore.setRuntime(runtime)
      runtime.ready = Promise.resolve().then(async () => {
        await videoFrameStore?.start()
        await videoCoverAttemptStore?.start(context)
        await jobCapabilities.start(context)
        await controller.start(context)
      }).catch(async error => {
        if (store.tryGetRuntime() === runtime) store.clearRuntime()
        if (capabilityRuntimeStore.tryGetRuntime() === runtime) capabilityRuntimeStore.clearRuntime()
        ownedRuntime = undefined
        await jobCapabilities.stop().catch(() => {})
        await videoCoverAttemptStore?.stop().catch(() => {})
        await videoFrameStore?.stop().catch(() => {})
        throw error
      })
      return runtime.ready
    },
    async stop() {
      if (ownedRuntime && store.tryGetRuntime() === ownedRuntime) store.clearRuntime()
      if (ownedRuntime && capabilityRuntimeStore.tryGetRuntime() === ownedRuntime) capabilityRuntimeStore.clearRuntime()
      await ownedRuntime?.ready.catch(() => {})
      await controller.stop()
      await jobCapabilities.stop()
      await videoCoverAttemptStore?.stop()
      await videoFrameStore?.stop()
      ownedRuntime = undefined
    },
  })
  for (const name of imageCommandToolNamesForProfile(binding.profile)) {
    api.registerTool(context => createImageCommandTools({
      context, binding,
      client,
      videoWorkflowClient,
      videoFrameStore,
      videoCoverAttemptStore,
      releaseReady: api.pluginConfig?.releaseReady === true,
      saveMedia,
      submissionFence,
      onSubmitted: subscription => withRunningNotifications('subscribe', subscription),
      onReceiptRead: subscription => withRunningNotifications('acknowledge', subscription),
      jobCapabilities: {
        grant: subscription => withRunningJobCapabilities('grant', subscription),
        authorize: subscription => withRunningJobCapabilities('authorize', subscription),
      },
    }).find(tool => tool.name === name) ?? null, { names: [name], optional: true })
  }
  if (typeof api.on === 'function') {
    if (binding.profile === 'qwen-current') {
      api.on('before_prompt_build', createVideoCoverWorkflowMode(), { priority: 200 })
    }
    api.on('tool_result_persist', (event, context) => receiptBridge.capture(event, context), {
      priority: RECEIPT_CAPTURE_PRIORITY,
    })
    api.on('tool_result_persist', (event, context) => receiptBridge.project(event, context), {
      priority: RECEIPT_PROJECT_PRIORITY,
    })
    api.on('before_message_write', (event, context) => receiptBridge.projectUserVisibleFailure(event, context), {
      priority: RECEIPT_PROJECT_PRIORITY,
    })
  }
}
