import assert from 'node:assert/strict'
import test from 'node:test'
import { canaryToolCallDigest, observeCanaryTool, observedCanonicalRouteVerified } from './lib/openclaw-canary-tool-observer.mjs'
import { inspectCurrentTurnToolRoute, RICH_CANARY_CONTRACT } from './lib/openclaw-rich-canary-contract.mjs'

const reply = { content: [{ type: 'text', text: JSON.stringify({ ok: true, action: 'explain',
  outcome: 'answered', responseContract: { mustQuoteUserVisibleAnswerExactly: true } }) }] }
const parameters = { action: 'explain', topic: 'technique_learning' }

test('observes original execution without changing its arguments or response', async () => {
  const records = []
  const original = { name: 'aiworker_director_brain', parameters: { fixture: true },
    async execute(id, params, extra) {
      assert.equal(id, 'owned-call')
      assert.equal(params, parameters)
      assert.equal(extra, 'extra')
      return reply
    } }
  const wrapped = observeCanaryTool(original, value => records.push(value))
  assert.equal(wrapped.parameters, original.parameters)
  assert.equal(await wrapped.execute('owned-call', parameters, 'extra'), reply)
  assert.deepEqual(records, [{ callIdSha256: canaryToolCallDigest('owned-call'),
    exactCanonicalArguments: true, canonicalResult: true }])
  assert.equal(JSON.stringify(records).includes('owned-call'), false)
  assert.equal(observeCanaryTool(null, () => assert.fail()), null)
})

test('wrong or extra arguments, unstructured replies and failures cannot prove execution', async () => {
  for (const params of [null, {}, { action: 'explain' }, { ...parameters, topic: 'architecture' },
    { ...parameters, unexpectedMetadata: 'do-not-record' }]) {
    const records = []
    await observeCanaryTool({ async execute() { return reply } }, value => records.push(value))
      .execute('owned-call', params)
    assert.equal(records[0].exactCanonicalArguments, false)
    assert.equal(JSON.stringify(records).includes('do-not-record'), false)
  }
  const records = []
  await assert.rejects(observeCanaryTool({ async execute() { throw new Error('failure') } },
    value => records.push(value)).execute('owned-call', parameters), /failure/u)
  assert.equal(records[0].canonicalResult, false)
})

test('binds exact execution to one successful projected call in the current distinct turn', () => {
  const rows = []
  for (let turn = 1; turn <= 2; turn++) rows.push(
    { message: { role: 'user', content: [{ type: 'text', text: `turn-${turn}` }] } },
    { message: { role: 'assistant', content: [{ type: 'toolCall', id: `call-${turn}`,
      name: 'aiworker_director_brain', arguments: { action: 'explain' } }] } },
    { message: { role: 'toolResult', toolCallId: `call-${turn}`, toolName: 'aiworker_director_brain',
      isError: false, content: [{ type: 'text', text: RICH_CANARY_CONTRACT.persistedBusinessToolStatus }] } },
  )
  const route = inspectCurrentTurnToolRoute(rows, 'turn-2', { includeCallDigests: true })
  const observed = { callIdSha256: canaryToolCallDigest('call-2'), exactCanonicalArguments: true, canonicalResult: true }
  assert.equal(observedCanonicalRouteVerified(route, [observed]), true)
  assert.equal(observedCanonicalRouteVerified(route, []), false)
  assert.equal(observedCanonicalRouteVerified(route, [observed, observed]), false)
  for (const update of [{ callIdSha256: canaryToolCallDigest('call-1') },
    { exactCanonicalArguments: false }, { canonicalResult: false }]) {
    assert.equal(observedCanonicalRouteVerified(route, [{ ...observed, ...update }]), false)
  }
})
