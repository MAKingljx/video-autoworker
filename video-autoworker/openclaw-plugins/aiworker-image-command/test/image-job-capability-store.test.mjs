import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createImageJobCapabilityStore } from '../lib/image-job-capability-store.js'
import { imageSessionScope } from '../lib/image-profile-binding.js'

const jobId = 'c'.repeat(32)
const bindingFor = stateDir => ({ profile: 'qwen-current', targetAgentId: 'second-original', stateDir })
const context = { agentId: 'second-original', sessionKey: 'agent:second-original:capability-test' }

async function fixture(run) {
  const stateDir = await mkdtemp(join(tmpdir(), 'aiworker-image-capabilities-'))
  try { await run({ stateDir, binding: bindingFor(stateDir) }) }
  finally { await rm(stateDir, { recursive: true, force: true }) }
}

test('records a verified job for its exact session without retaining the raw session key', async () => {
  await fixture(async ({ stateDir, binding }) => {
    const scope = imageSessionScope(context, binding)
    const store = createImageJobCapabilityStore({ binding })
    await store.start({ stateDir })
    assert.equal(await store.authorize({ jobId, scope, sessionKey: context.sessionKey }), false)
    await store.grant({ jobId, scope, sessionKey: context.sessionKey })
    assert.equal(await store.authorize({ jobId, scope, sessionKey: context.sessionKey }), true)
    assert.equal(await store.authorize({ jobId, scope,
      sessionKey: 'agent:second-original:another-session' }), false)
    const saved = await readFile(join(stateDir, 'aiworker-image-command', 'job-capabilities.json'), 'utf8')
    assert.doesNotMatch(saved, /capability-test/u)
    await store.stop()
  })
})

test('survives a restart and retains the capability after a result read', async () => {
  await fixture(async ({ stateDir, binding }) => {
    const scope = imageSessionScope(context, binding)
    const first = createImageJobCapabilityStore({ binding })
    await first.start({ stateDir })
    await first.grant({ jobId, scope, sessionKey: context.sessionKey })
    await first.stop()
    const second = createImageJobCapabilityStore({ binding })
    await second.start({ stateDir })
    assert.equal(await second.authorize({ jobId, scope, sessionKey: context.sessionKey }), true)
    await second.stop()
  })
})

test('fails closed on a malformed persisted authority record', async () => {
  await fixture(async ({ stateDir, binding }) => {
    const folder = join(stateDir, 'aiworker-image-command')
    await mkdir(folder, { recursive: true, mode: 0o700 })
    await writeFile(join(folder, 'job-capabilities.json'), '{"schema":"wrong","grants":[]}', { mode: 0o600 })
    const store = createImageJobCapabilityStore({ binding })
    await assert.rejects(store.start({ stateDir }), /image_job_capability_store_invalid/u)
  })
})
