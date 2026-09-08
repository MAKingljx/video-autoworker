import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseOpenClawAgentJsonResult,
  summarizeNonDeliveryVerification,
} from './lib/openclaw-agent-json-result.mjs'

const argv = [
  '--profile', 'qwen-current', 'agent', '--agent', 'second-original',
  '--session-key', 'owned-test', '--message-file', '/private/prompt', '--timeout', '240', '--json',
]
const expectedModel = 'provider/model-id'

function result(overrides = {}) {
  return {
    payloads: [{ text: 'bounded visible reply' }],
    meta: {
      finalAssistantVisibleText: 'bounded visible reply',
      durationMs: 10,
      agentMeta: {
        provider: 'provider', model: 'model-id',
        usage: { input: 2, output: 3, total: 5 },
      },
    },
    ...overrides,
  }
}

test('parses the OpenClaw 2026.9 top-level non-delivering agent JSON envelope', () => {
  assert.deepEqual(parseOpenClawAgentJsonResult(result(), { argv, expectedModel }), {
    visibleText: 'bounded visible reply',
    provider: 'provider',
    model: 'model-id',
    modelRef: expectedModel,
    modelMatched: true,
    durationMs: 10,
    totalTokens: 5,
    externalDelivery: false,
    deliveryEvidence: 'agent-cli-without-deliver-and-no-explicit-delivery-evidence',
  })
})

test('uses only visible successful payload text when metadata text is absent', () => {
  const value = result({
    payloads: [
      { text: 'hidden', visible: false },
      { text: 'error', isError: true },
      { text: 'reasoning', isReasoning: true },
      { text: 'commentary', isCommentary: true },
      { text: 'first' },
      { text: 'second' },
    ],
    meta: { agentMeta: { provider: 'provider', model: 'model-id' } },
  })
  assert.equal(parseOpenClawAgentJsonResult(value, { argv, expectedModel }).visibleText, 'first\nsecond')
})

test('does not accept arbitrary nested output or payload model fields as authority', () => {
  assert.throws(() => parseOpenClawAgentJsonResult({
    outputs: [{ text: 'legacy', provider: 'provider', model: 'model-id' }],
    result: { payloads: [{ text: 'legacy' }] },
  }, { argv, expectedModel }), /envelope_invalid/u)
  assert.throws(() => parseOpenClawAgentJsonResult({
    payloads: [{ text: 'reply', provider: 'provider', model: 'model-id' }], meta: {},
  }, { argv, expectedModel }), /agent_meta_missing/u)
})

test('normalizes the successful Gateway run response to the same AgentRunResult', () => {
  const direct = parseOpenClawAgentJsonResult(result(), { argv, expectedModel })
  for (const status of ['ok', 'completed']) {
    assert.deepEqual(parseOpenClawAgentJsonResult({
      runId: 'owned-run', status, summary: 'completed', result: result(),
    }, { argv, expectedModel }), direct)
  }
})

test('rejects failed or still running Gateway responses even when payloads exist', () => {
  for (const status of ['error', 'timeout', 'in_flight', 'accepted', undefined]) {
    assert.throws(() => parseOpenClawAgentJsonResult({
      runId: 'owned-run', status, result: result(),
    }, { argv, expectedModel }), /run_not_completed/u)
  }
})

test('checks delivery evidence at both public Gateway response layers', () => {
  for (const extra of [{ deliverySucceeded: true }, { deliveryStatus: null }]) {
    for (const value of [
      { runId: 'owned-run', status: 'ok', result: result(), ...extra },
      { runId: 'owned-run', status: 'ok', result: result(extra) },
    ]) {
      assert.throws(() => parseOpenClawAgentJsonResult(value, {
        argv, expectedModel,
      }), /unexpected_delivery_evidence/u)
    }
  }
})

test('rejects mixed envelopes and missing run identity instead of guessing an authority', () => {
  for (const value of [
    { runId: 'owned-run', status: 'ok', result: result(), payloads: [] },
    { runId: 'owned-run', status: 'ok', result: result(), meta: {} },
    { status: 'ok', result: result() },
    { runId: 'owned-run', status: 'ok', result: { result: result() } },
  ]) {
    assert.throws(() => parseOpenClawAgentJsonResult(value, {
      argv, expectedModel,
    }), /envelope_invalid/u)
  }
})

test('rejects a delivering invocation and every explicit delivery-status envelope', () => {
  for (const flag of ['--deliver', '--deliver=true', '--deliver=false']) {
    assert.throws(() => parseOpenClawAgentJsonResult(result(), {
      argv: [...argv, flag], expectedModel,
    }), /invocation_not_non_delivering_agent_json/u)
  }
  assert.throws(() => parseOpenClawAgentJsonResult(result({
    deliveryStatus: { requested: true, attempted: true, status: 'sent', succeeded: true },
  }), { argv, expectedModel }), /unexpected_delivery_evidence/u)
  assert.throws(() => parseOpenClawAgentJsonResult(result({ deliverySucceeded: true }), {
    argv, expectedModel,
  }), /unexpected_delivery_evidence/u)
  for (const deliveryStatus of [null, false, 'invalid']) {
    assert.throws(() => parseOpenClawAgentJsonResult(result({ deliveryStatus }), {
      argv, expectedModel,
    }), /unexpected_delivery_evidence/u)
  }
})

test('reports an exact authoritative model mismatch without scanning nested fields', () => {
  const value = result({
    payloads: [{ text: 'reply', provider: 'other', model: 'other/model' }],
    meta: { agentMeta: { provider: 'provider', model: 'different' } },
  })
  const parsed = parseOpenClawAgentJsonResult(value, { argv, expectedModel })
  assert.equal(parsed.modelRef, 'provider/different')
  assert.equal(parsed.modelMatched, false)

  const mismatchedProvider = parseOpenClawAgentJsonResult(result({
    meta: {
      agentMeta: { provider: 'other-provider', model: expectedModel },
    },
  }), { argv, expectedModel })
  assert.equal(mismatchedProvider.modelRef, expectedModel)
  assert.equal(mismatchedProvider.modelMatched, false)
})

test('treats the official silent reply marker as no visible text', () => {
  const value = result({
    payloads: [{ text: 'NO_REPLY' }],
    meta: { finalAssistantVisibleText: 'NO_REPLY', agentMeta: { provider: 'provider', model: 'model-id' } },
  })
  assert.equal(parseOpenClawAgentJsonResult(value, { argv, expectedModel }).visibleText, '')
})

test('reports non-delivery only when every attempted turn has authoritative evidence', () => {
  assert.deepEqual(summarizeNonDeliveryVerification({ attemptedTurns: 5, verifiedTurns: 5 }), {
    externalDelivery: false,
    externalDeliveryVerified: true,
    explicitDeliveryEvidenceDetected: false,
  })
  assert.deepEqual(summarizeNonDeliveryVerification({ attemptedTurns: 2, verifiedTurns: 1 }), {
    externalDelivery: null,
    externalDeliveryVerified: false,
    explicitDeliveryEvidenceDetected: false,
  })
  assert.deepEqual(summarizeNonDeliveryVerification({
    attemptedTurns: 1, verifiedTurns: 0, explicitDeliveryEvidenceDetected: true,
  }), {
    externalDelivery: null,
    externalDeliveryVerified: false,
    explicitDeliveryEvidenceDetected: true,
  })
  assert.throws(() => summarizeNonDeliveryVerification({ attemptedTurns: 1, verifiedTurns: 2 }),
    /non_delivery_verification_invalid/u)
})
