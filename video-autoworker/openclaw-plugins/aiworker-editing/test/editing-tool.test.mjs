import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEditingTool } from '../lib/tool.js'
import { registerEditingTool } from '../lib/registration.js'
import { createEditingClient } from '../lib/client.js'

const context = { agentId: 'main', sessionKey: 'agent:main:main' }
function fixture(status = { planStatus: 'validated', reviewToken: 'browser-only', plan: { reviewToken: 'nested' } }) {
  const calls = []
  const client = Object.fromEntries(['inspect', 'evidence', 'propose', 'status'].map(name => [name, async (...args) => {
    calls.push({ name, args }); return status
  }]))
  return { calls, tool: createEditingTool({ context, client, releaseReady: true }) }
}

test('gpt-main registers one optional SDK tool, and only its main agent obtains it', () => {
  let factory, registration
  registerEditingTool({ pluginConfig: { releaseReady: true }, registerTool(fn, options) { factory = fn; registration = options } },
    { home: '/fixture', env: { OPENCLAW_PROFILE: 'gpt-main', OPENCLAW_STATE_DIR: '/fixture/.openclaw-gpt-main' }, createClient: () => ({}) })
  assert.deepEqual(registration, { names: ['aiworker_edit_video'], optional: true })
  assert.equal(factory(context).name, 'aiworker_edit_video')
  assert.equal(factory({ agentId: 'second-original', sessionKey: 'agent:second-original:main' }), null)
  assert.equal(factory({ agentId: 'main', sessionKey: 'agent:other:main' }), null)
})

test('other three profiles cannot register the editing tool even with main context', () => {
  for (const profile of ['qwen-current', 'qwen-weixin-new', 'image-studio']) {
    assert.throws(() => registerEditingTool({ registerTool() { assert.fail('cross-profile registration') } },
      { home: '/fixture', env: { OPENCLAW_PROFILE: profile, OPENCLAW_STATE_DIR: `/fixture/.openclaw-${profile}` } }), /profile_binding/u)
  }
})

test('model cannot approve, inject approved:true, alter transport or override scope', async () => {
  const { tool, calls } = fixture()
  for (const params of [{ action: 'approve', planId: 'plan', revision: 1 }, { action: 'execute', planId: 'plan', revision: 1, approved: true },
    { action: 'inspect', baseUrl: 'https://external.test' }, { action: 'status', planId: 'plan', revision: 1, reviewToken: 'token' },
    { action: 'propose', plan: { status: 'approved' } }, { action: 'propose', plan: { status: 'validated', approved: true } }]) {
    assert.equal((await tool.execute('call', params)).details.errorCode, 'EDITING_REQUEST_INVALID')
  }
  assert.equal(calls.length, 0)
})

test('execute only reads approval state, strips browser tokens and never creates a task', async () => {
  const { tool, calls } = fixture()
  const result = await tool.execute('call', { action: 'execute', planId: 'plan', revision: 1 })
  assert.equal(result.details.currentState, 'waiting_for_human_approval')
  assert.equal(result.details.reviewToken, undefined)
  assert.equal(result.details.plan.reviewToken, undefined)
  assert.deepEqual(calls.map(call => call.name), ['status'])
})

test('validated proposal remains a candidate and repeated queries share application authority', async () => {
  const { tool, calls } = fixture({ planStatus: 'approved', taskStatus: 'running', taskId: 'existing-task' })
  await tool.execute('proposal', { action: 'propose', plan: { status: 'validated' } })
  for (let index = 0; index < 2; index++) {
    const result = await tool.execute('status-' + index, { action: 'execute', planId: 'plan', revision: 1 })
    assert.equal(result.details.taskId, 'existing-task')
  }
  assert.deepEqual(calls.map(call => call.name), ['propose', 'status', 'status'])
})

test('evidence pagination is bounded and does not rerun learning', async () => {
  const { tool, calls } = fixture()
  await tool.execute('evidence', { action: 'evidence', taskId: 'learned-task', offset: 20, limit: 20 })
  assert.deepEqual(calls.map(call => call.name), ['evidence'])
  assert.equal((await tool.execute('excessive', { action: 'evidence', taskId: 'task', limit: 1000 })).details.errorCode, 'EDITING_REQUEST_INVALID')
})

test('client sends only same-chain fixed loopback requests without credential or approval transport', async () => {
  const calls = []
  const client = createEditingClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options }); return new Response(JSON.stringify({ plans: [] }), { headers: { 'content-type': 'application/json' } })
  } })
  await client.propose({ status: 'validated' })
  await client.status({ planId: 'a&b', revision: 1 })
  assert.equal(calls[0].url, 'http://127.0.0.1:3017/api/editing/plans')
  assert.equal(JSON.parse(calls[0].options.body).action, 'propose')
  assert.equal(calls[0].options.headers.authorization, undefined)
  assert.ok(calls[1].url.includes('planId=a%26b'))
  assert.equal(calls[1].options.method, 'GET')
})

test('unavailable release and unknown executor outcomes are not reported as successful edits', async () => {
  const disabled = createEditingTool({ context, releaseReady: false })
  assert.equal((await disabled.execute('call', { action: 'inspect' })).details.errorCode, 'EDITING_NOT_READY')
  const { tool } = fixture({ planStatus: 'approved', operations: [{ status: 'unknown' }], taskStatus: 'running' })
  assert.equal((await tool.execute('call', { action: 'result', planId: 'plan', revision: 1 })).details.operations[0].status, 'unknown')
})
