import assert from 'node:assert/strict'
import test from 'node:test'

import { validateConfigPatchReplacePaths } from './lib/openclaw-profile-private-gateway-rpc.mjs'

const binding = { profile: 'qwen-current', agentId: 'second-original', port: 18889 }

function entriesPatch() {
  return { agents: { entries: { 'second-original': {
    tools: { alsoAllow: ['aiworker_analyze_video', 'aiworker_submit_creative_image'] },
  } } } }
}

function listPatch() {
  return { agents: { list: [{ id: 'second-original',
    tools: { alsoAllow: ['aiworker_analyze_video', 'aiworker_submit_creative_image'] },
  }] } }
}

test('allows only the target entry allowlist replacement path', () => {
  assert.deepEqual(validateConfigPatchReplacePaths(binding, entriesPatch(), [
    'agents.entries.second-original.tools.alsoAllow',
  ]), ['agents.entries.second-original.tools.alsoAllow'])
  assert.throws(() => validateConfigPatchReplacePaths(binding, entriesPatch(), [
    'agents.entries.second-original.tools.deny',
  ]), /openclaw_profile_private_gateway_rpc_failed/u)
})

test('uses the ID-merged legacy list path and rejects broader replacements', () => {
  assert.deepEqual(validateConfigPatchReplacePaths(binding, listPatch(), [
    'agents.list[].tools.alsoAllow',
  ]), ['agents.list[].tools.alsoAllow'])
  assert.throws(() => validateConfigPatchReplacePaths(binding, listPatch(), ['agents.list']),
    /openclaw_profile_private_gateway_rpc_failed/u)
  assert.throws(() => validateConfigPatchReplacePaths(binding, listPatch(), [
    'agents.list[].tools.alsoAllow', 'plugins.allow',
  ]), /openclaw_profile_private_gateway_rpc_failed/u)
})

test('rejects a replacement path when its target is absent from the patch', () => {
  const patch = entriesPatch()
  delete patch.agents.entries['second-original'].tools.alsoAllow
  assert.throws(() => validateConfigPatchReplacePaths(binding, patch, [
    'agents.entries.second-original.tools.alsoAllow',
  ]), /openclaw_profile_private_gateway_rpc_failed/u)
})
