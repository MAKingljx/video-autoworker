import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachmentForProfile,
  imageReferenceRoots,
  isImageCapabilityAttached,
  renderImageCapabilityConfig,
  renderImageCapabilityPatch,
  validateImageCapabilityManifest,
} from './lib/openclaw-image-capability-contract.mjs'

const manifest = validateImageCapabilityManifest({
  schema: 'aiworker-openclaw-image-capabilities/v1',
  plugin: { id: 'aiworker-image-command', version: '0.3.0', tool: 'aiworker_generate_image' },
  attachments: [
    { profile: 'image-studio', agentId: 'image-studio', stateRoot: '.openclaw-image-studio', gatewayPort: 19289, mediaRoot: '.openclaw-image-studio/media', legacyScope: true },
    { profile: 'qwen-current', agentId: 'second-original', stateRoot: '.openclaw-qwen-current', gatewayPort: 18889, mediaRoot: '.openclaw-qwen-current/media', legacyScope: false },
  ],
})

function config(layout = 'entries') {
  const agent = {
    name: '第二原始', workspace: '/safe/workspace',
    tools: { alsoAllow: ['aiworker_analyze_video'], deny: ['exec'] },
  }
  return {
    agents: layout === 'list' ? { list: [{ id: 'second-original', ...agent }] }
      : { entries: { 'second-original': agent } },
    plugins: {
      allow: ['aiworker-video-command', 'aiworker-director-brain'],
      entries: {
        'aiworker-video-command': { enabled: true, config: { releaseReady: true } },
        'aiworker-director-brain': { enabled: true, config: { releaseReady: true, targetAgentId: 'second-original' } },
      },
    },
    channels: { feishu: { enabled: true } },
  }
}

for (const layout of ['entries', 'list']) {
  test(`renders a narrow reusable attachment patch for ${layout}`, () => {
    const attachment = attachmentForProfile(manifest, 'qwen-current')
    const before = config(layout)
    const after = renderImageCapabilityConfig(before, manifest, attachment)
    assert.equal(isImageCapabilityAttached(before, manifest, attachment), false)
    assert.equal(isImageCapabilityAttached(after, manifest, attachment), true)
    assert.deepEqual(after.channels, before.channels)
    assert.deepEqual(after.plugins.entries['aiworker-video-command'], before.plugins.entries['aiworker-video-command'])
    const agent = layout === 'list' ? after.agents.list[0] : { id: 'second-original', ...after.agents.entries['second-original'] }
    assert.deepEqual(agent.tools.alsoAllow, ['aiworker_analyze_video', 'aiworker_generate_image'])
    const patch = renderImageCapabilityPatch(before, manifest, attachment)
    assert.deepEqual(Object.keys(patch.plugins.entries), ['aiworker-image-command'])
  })
}

test('manifests centrally declare the only approved profile media roots', () => {
  assert.deepEqual(imageReferenceRoots('/Users/h1', manifest), [
    '/Users/h1/ai-worker/output/covers',
    '/Users/h1/.openclaw-image-studio/media',
    '/Users/h1/.openclaw-qwen-current/media',
  ])
  const invalid = structuredClone(manifest)
  invalid.attachments[1].mediaRoot = '../../private'
  assert.throws(() => validateImageCapabilityManifest(invalid), /attachment_invalid/u)
})

test('refuses conflicting target-agent ownership', () => {
  const attachment = attachmentForProfile(manifest, 'qwen-current')
  const wrong = config()
  wrong.plugins.entries['aiworker-image-command'] = {
    enabled: true, config: { releaseReady: true, targetAgentId: 'another-agent' },
  }
  assert.throws(() => renderImageCapabilityConfig(wrong, manifest, attachment), /plugin_agent_conflict/u)
})
