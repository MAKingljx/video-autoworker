import assert from 'node:assert/strict'
import test from 'node:test'

import {
  projectPrivateGatewayResult,
  serializePrivateGatewayResult,
} from './lib/openclaw-private-gateway-rpc.mjs'

const token = 'a'.repeat(64)
const sessionKey = 'agent:second-original:private-session'

test('logs-tail retains only safe hot-reload evidence and one omission marker', () => {
  const result = projectPrivateGatewayResult('logs-tail', {
    file: '/private/tmp/openclaw-gateway.log', cursor: 512, size: 512,
    reset: false, truncated: false,
    lines: [
      JSON.stringify({ message: `unrelated token=${token}` }),
      JSON.stringify({ message: 'config change detected; evaluating reload (agents.defaults.compaction.keepRecentTokens, agents.defaults.compaction.maxActiveTranscriptBytes)' }),
    ],
  })
  assert.deepEqual(result, {
    file: '/private/tmp/openclaw-gateway.log', cursor: 512, size: 512,
    reset: false, truncated: false,
    lines: [
      JSON.stringify({ message: 'config change detected; evaluating reload (agents.defaults.compaction.keepRecentTokens, agents.defaults.compaction.maxActiveTranscriptBytes)' }),
      JSON.stringify({ message: '[redacted gateway log entries omitted]' }),
    ],
  })
  assert.doesNotMatch(serializePrivateGatewayResult('logs-tail', result, token, sessionKey), new RegExp(token, 'u'))
})

test('logs-tail canonicalizes failure evidence without retaining arbitrary suffixes', () => {
  const result = projectPrivateGatewayResult('logs-tail', {
    file: '/private/tmp/openclaw-gateway.log', cursor: 1024, size: 1024,
    reset: false, truncated: false,
    lines: [`config reload requires gateway restart details=${token}`],
  })
  assert.deepEqual(result.lines, [JSON.stringify({ message: 'config reload requires gateway restart' })])
})

test('logs-tail rejects incomplete or oversized evidence instead of forwarding it', () => {
  assert.throws(() => projectPrivateGatewayResult('logs-tail', {
    file: 'relative.log', cursor: 1, size: 1, reset: false, truncated: false, lines: [],
  }), /private Gateway RPC failed/u)
  assert.throws(() => projectPrivateGatewayResult('logs-tail', {
    file: '/private/tmp/openclaw-gateway.log', cursor: 1, size: 2, reset: false, truncated: false, lines: [],
  }), /private Gateway RPC failed/u)
})
