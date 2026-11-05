import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerImageCommands } from '../lib/plugin-registration.js'
import { createImageNotifications } from '../lib/image-notifications.js'
import { IMAGE_COMMAND_TOOL_NAMES, IMAGE_SUBMIT_CREATIVE_TOOL_NAME } from '../lib/image-command-tool.js'

const context = { agentId: 'image-studio', sessionKey: 'agent:image-studio:main' }
const jobId = '3'.repeat(32)
const params = { prompt: '完整中文封面', images: ['/approved/source.png'] }

function namedStoreFactory() {
  // The public named-slot semantics of OpenClaw's runtime-store. Separate
  // registrations get separate handles backed by the same keyed runtime.
  const slots = new Map()
  return ({ key, errorMessage }) => ({
    setRuntime: value => slots.set(key, value),
    tryGetRuntime: () => slots.get(key) ?? null,
    clearRuntime: () => slots.delete(key),
    getRuntime: () => {
      const value = slots.get(key)
      if (!value) throw new Error(errorMessage)
      return value
    },
  })
}

function api(mode, system = { enqueueSystemEvent() {}, requestHeartbeatNow() {} }) {
  const result = { registrationMode: mode, runtime: { system }, pluginConfig: { releaseReady: true },
    services: [], toolFactories: [],
    registerService(service) { result.services.push(service) },
    registerTool(factory, options) { result.toolFactories.push({ factory, options }) },
  }
  return result
}

function registeredTool(host, name, context) {
  const registration = host.toolFactories.find(entry => entry.options.names.includes(name))
  assert.ok(registration, `missing registration for ${name}`)
  return registration.factory(context)
}

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'aiworker-image-registration-'))
  const env = { OPENCLAW_PROFILE: 'image-studio', OPENCLAW_STATE_DIR: dir }
  const services = []
  const register = (host, dependencies) => {
    registerImageCommands(host, dependencies)
    services.push(...host.services)
  }
  try { await run({ dir, env, register }) }
  finally {
    for (const service of services.toReversed()) await service.stop()
    await rm(dir, { recursive: true, force: true })
  }
}

test('full startup and separate tool-discovery registrations share the running transport', async () => {
  await fixture(async ({ dir, env, register }) => {
    const createRuntimeStore = namedStoreFactory()
    const controllers = []
    const events = []
    const startup = api('full', { enqueueSystemEvent: (...args) => events.push(args), requestHeartbeatNow() {} })
    const discovery = api('tool-discovery', { enqueueSystemEvent() { throw new Error('unstarted discovery system') },
      requestHeartbeatNow() { throw new Error('unstarted discovery heartbeat') } })
    let currentState = 'QUEUED'
    const dependencies = { env, createRuntimeStore,
      createClient: () => ({ submit: async () => ({ jobId, currentState }),
        list: async () => ({ jobs: [{ jobId, currentState, updatedAt: '2026-10-04T08:00:00Z' }] }) }),
      createNotifications: options => {
        const controller = createImageNotifications({ ...options, pollIntervalMs: 3600000 })
        controllers.push(controller)
        return controller
      },
    }
    register(startup, dependencies)
    await startup.services[0].start({ stateDir: dir })
    register(discovery, dependencies)
    const answer = await registeredTool(discovery, IMAGE_SUBMIT_CREATIVE_TOOL_NAME, context)
      .execute('separate-tool-registry', params)
    assert.equal(answer.details.jobId, jobId)
    assert.equal(answer.details.notificationErrorCode, undefined)
    const stored = JSON.parse(await readFile(join(dir, 'aiworker-image-command', 'notifications.json'), 'utf8'))
    assert.deepEqual(stored.subscriptions[0].pendingJobIds, [jobId])
    assert.equal(controllers.length, 2)
    currentState = 'GENERATED_PENDING_REVIEW'
    await controllers[0].poll()
    assert.equal(events.length, 1)
    assert.equal(events[0][1].sessionKey, context.sessionKey)
  })
})

test('an unstarted discovery cleanup cannot clear the startup owner', async () => {
  await fixture(async ({ dir, env, register }) => {
    const dependencies = { env, createRuntimeStore: namedStoreFactory(),
      createClient: () => ({ submit: async () => ({ jobId, currentState: 'QUEUED' }) }) }
    const startup = api('full')
    const discovery = api('tool-discovery')
    register(startup, dependencies)
    await startup.services[0].start({ stateDir: dir })
    register(discovery, dependencies)
    await discovery.services[0].stop()
    const answer = await registeredTool(discovery, IMAGE_SUBMIT_CREATIVE_TOOL_NAME, context)
      .execute('after-unowned-stop', params)
    assert.equal(answer.details.notificationErrorCode, undefined)
  })
})

test('stopping the startup owner clears the slot and keeps accepted job feedback honest', async () => {
  await fixture(async ({ dir, env, register }) => {
    const dependencies = { env, createRuntimeStore: namedStoreFactory(),
      createClient: () => ({ submit: async () => ({ jobId, currentState: 'QUEUED' }) }) }
    const startup = api('full')
    const discovery = api('tool-discovery')
    register(startup, dependencies)
    await startup.services[0].start({ stateDir: dir })
    register(discovery, dependencies)
    await startup.services[0].stop()
    const answer = await registeredTool(discovery, IMAGE_SUBMIT_CREATIVE_TOOL_NAME, context)
      .execute('after-owned-stop', params)
    assert.equal(answer.details.jobId, jobId)
    assert.equal(answer.details.notificationErrorCode, 'IMAGE_NOTIFICATION_UNAVAILABLE')
  })
})

test('same process slots are isolated by trusted profile state root', async () => {
  await fixture(async ({ dir, env, register }) => {
    const createRuntimeStore = namedStoreFactory()
    const envOther = { ...env, OPENCLAW_STATE_DIR: join(dir, 'different-profile-state') }
    const base = { createRuntimeStore, createClient: () => ({ submit: async () => ({ jobId, currentState: 'QUEUED' }) }) }
    const startup = api('full')
    const otherDiscovery = api('tool-discovery')
    register(startup, { ...base, env })
    await startup.services[0].start({ stateDir: dir })
    register(otherDiscovery, { ...base, env: envOther })
    const answer = await registeredTool(otherDiscovery, IMAGE_SUBMIT_CREATIVE_TOOL_NAME, context)
      .execute('wrong-profile-state', params)
    assert.equal(answer.details.notificationErrorCode, 'IMAGE_NOTIFICATION_UNAVAILABLE')
    assert.throws(() => registerImageCommands(api('tool-discovery'), { ...base,
      env: { ...env, OPENCLAW_PROFILE: 'qwen-current' } }), /image_notification_profile_binding_invalid/u)
  })
})

test('service state identity must match process binding and duplicate starts fail closed', async () => {
  await fixture(async ({ dir, env, register }) => {
    const dependencies = { env, createRuntimeStore: namedStoreFactory() }
    const first = api('full')
    const second = api('full')
    register(first, dependencies)
    await assert.rejects(first.services[0].start({ stateDir: join(dir, 'wrong') }), /image_notification_profile_binding_mismatch/u)
    await first.services[0].start({ stateDir: dir })
    register(second, dependencies)
    await assert.rejects(second.services[0].start({ stateDir: dir }), /image_notification_service_already_started/u)
  })
})

test('failed startup never leaves a broken runtime owner in the shared slot', async () => {
  await fixture(async ({ dir, env, register }) => {
    const createRuntimeStore = namedStoreFactory()
    const first = api('full')
    const second = api('full')
    register(first, { env, createRuntimeStore,
      createNotifications: () => ({ id: 'aiworker-image-notifications',
        start: async () => { throw new Error('startup rejected') }, stop: async () => {} }) })
    await assert.rejects(first.services[0].start({ stateDir: dir }), /startup rejected/u)
    register(second, { env, createRuntimeStore })
    await second.services[0].start({ stateDir: dir })
  })
})

test('qwen-current can bind the shared plugin to second-original without inheriting image-studio sessions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aiworker-image-registration-qwen-'))
  const env = { OPENCLAW_PROFILE: 'qwen-current', OPENCLAW_STATE_DIR: dir }
  const context = { agentId: 'second-original', sessionKey: 'agent:second-original:main' }
  const host = api('full')
  host.pluginConfig = { releaseReady: true, targetAgentId: 'second-original' }
  try {
    registerImageCommands(host, {
      env,
      createRuntimeStore: namedStoreFactory(),
      createClient: () => ({ submit: async () => ({ jobId, currentState: 'QUEUED' }) }),
    })
    await host.services[0].start({ stateDir: dir })
    assert.deepEqual(host.toolFactories.map(entry => entry.options.names[0]), IMAGE_COMMAND_TOOL_NAMES)
    const accepted = await registeredTool(host, IMAGE_SUBMIT_CREATIVE_TOOL_NAME, context)
      .execute('qwen-tool', params)
    assert.equal(accepted.details.jobId, jobId)
    assert.equal(registeredTool(host, IMAGE_SUBMIT_CREATIVE_TOOL_NAME,
      { agentId: 'image-studio', sessionKey: 'agent:image-studio:main' }), null)
  } finally {
    await host.services[0]?.stop()
    await rm(dir, { recursive: true, force: true })
  }
})
