import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { createImageNotifications } from '../lib/image-notifications.js'
import { imageSessionScope } from '../lib/image-command-tool.js'

const sessionKey = 'agent:image-studio:main'
const scope = imageSessionScope({ agentId: 'image-studio', sessionKey })
const jobId = '1'.repeat(32)
const stamp = '2026-10-04T10:00:00Z'
const completed = { jobId, currentState: 'GENERATED_PENDING_REVIEW', updatedAt: stamp }

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'aiworker-image-notifications-'))
  const events = []
  const heartbeats = []
  const system = { enqueueSystemEvent: (...args) => { events.push(args); return true },
    requestHeartbeatNow: input => heartbeats.push(input) }
  const services = []
  const make = client => {
    const service = createImageNotifications({ client, system, pollIntervalMs: 3600000 })
    services.push(service)
    return service
  }
  try { await run({ dir, events, heartbeats, system, make }) }
  finally { for (const service of services) await service.stop(); await rm(dir, { recursive: true, force: true }) }
}

test('completion emits only a same-session event and targeted heartbeat once', async () => {
  await fixture(async ({ dir, events, heartbeats, make }) => {
    const service = make({ list: async input => {
      assert.equal(input, scope)
      return { jobs: [completed] }
    } })
    await service.start({ stateDir: dir })
    await service.subscribe({ jobId, scope, sessionKey })
    await service.poll()
    await service.poll()
    assert.equal(events.length, 1)
    assert.equal(events[0][1].sessionKey, sessionKey)
    assert.match(events[0][0], /result/u)
    assert.deepEqual(heartbeats[0], { agentId: 'image-studio', sessionKey, reason: `aiworker-image:${jobId}` })
    assert.ok(!Object.hasOwn(heartbeats[0], 'to'))
    const stored = JSON.parse(await readFile(join(dir, 'aiworker-image-command', 'notifications.json'), 'utf8'))
    assert.deepEqual(stored.subscriptions[0].pendingJobIds, [jobId])
    assert.equal(stored.subscriptions[0].notified[jobId], `GENERATED_PENDING_REVIEW:${stamp}`)
    assert.ok(!Object.hasOwn(stored.subscriptions[0], 'currentState'))
    assert.equal((await stat(join(dir, 'aiworker-image-command', 'notifications.json'))).mode & 0o777, 0o600)
  })
})

test('restart reads application truth and does not announce old unsubscribed jobs', async () => {
  await fixture(async ({ dir, events, make }) => {
    const first = make({ list: async () => ({ jobs: [{ jobId, currentState: 'RUNNING' }] }) })
    await first.start({ stateDir: dir })
    await first.subscribe({ jobId, scope, sessionKey })
    await first.poll()
    assert.equal(events.length, 0)
    await first.stop()
    const second = make({ list: async () => ({ jobs: [completed, { ...completed, jobId: '2'.repeat(32) }] }) })
    await second.start({ stateDir: dir })
    await second.poll()
    assert.equal(events.length, 1)
    await second.stop()
    const third = make({ list: async () => ({ jobs: [completed] }) })
    await third.start({ stateDir: dir })
    await third.poll()
    assert.equal(events.length, 2)
    await third.acknowledge({ jobId, scope, sessionKey })
    await third.stop()
    const fourth = make({ list: async () => ({ jobs: [completed] }) })
    await fourth.start({ stateDir: dir })
    await fourth.poll()
    assert.equal(events.length, 2)
  })
})

test('pending notification outside the recent list is read by the same owned id', async () => {
  await fixture(async ({ dir, events, make }) => {
    let query
    const service = make({ list: async () => ({ jobs: [] }), status: async (...args) => { query = args; return completed } })
    await service.start({ stateDir: dir })
    await service.subscribe({ jobId, scope, sessionKey })
    await service.poll()
    assert.deepEqual(query.slice(0, 2), [jobId, scope])
    assert.equal(events.length, 1)
  })
})

test('running and cancel-requested tasks stay quiet; final cancellation is notified', async () => {
  await fixture(async ({ dir, events, make }) => {
    let currentState = 'RUNNING'
    const service = make({ list: async () => ({ jobs: [{ jobId, currentState, updatedAt: stamp }] }) })
    await service.start({ stateDir: dir })
    await service.subscribe({ jobId, scope, sessionKey })
    await service.poll()
    currentState = 'CANCEL_REQUESTED'
    await service.poll()
    assert.equal(events.length, 0)
    currentState = 'CANCELLED'
    await service.poll()
    assert.equal(events.length, 1)
    assert.match(events[0][0], /已取消/u)
  })
})

test('invalid ownership and unavailable runtime cannot create a notification subscription', async () => {
  await fixture(async ({ dir, make }) => {
    const service = make({})
    await service.start({ stateDir: dir })
    for (const input of [{ jobId, scope: null, sessionKey: 'invalid' },
      { jobId, scope, sessionKey: 'agent:gpt-main:main' }, { jobId: '../outside', scope, sessionKey }]) {
      await assert.rejects(service.subscribe(input), /image_notification_subscription_invalid/u)
    }
    const noRuntime = createImageNotifications({ system: {} })
    await assert.rejects(noRuntime.start({ stateDir: dir }), /image_notification_runtime_unavailable/u)
  })
})

test('corrupt persisted subscription fails closed instead of silently resetting', async () => {
  await fixture(async ({ dir, make }) => {
    const service = make({})
    await service.start({ stateDir: dir })
    await service.subscribe({ jobId, scope, sessionKey })
    await service.stop()
    const path = join(dir, 'aiworker-image-command', 'notifications.json')
    const data = JSON.parse(await readFile(path, 'utf8'))
    data.subscriptions[0].sessionKey = 'agent:gpt-main:main'
    await writeFile(path, JSON.stringify(data))
    const replacement = make({})
    await assert.rejects(replacement.start({ stateDir: dir }), /image_notification_subscription_invalid/u)
  })
})
