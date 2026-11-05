import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attachmentForProfile,
  imageCapabilityReplacePaths,
  imageReferenceRoots,
  isImageCapabilityAttached,
  renderImageCapabilityConfig,
  renderImageCapabilityPatch,
  validateImageCapabilityManifest,
} from './lib/openclaw-image-capability-contract.mjs'

const IMAGE_TOOLS = [
  'aiworker_submit_creative_image',
  'aiworker_submit_designed_cover',
  'aiworker_submit_protected_cover',
  'aiworker_image_task',
  'aiworker_image_help',
]

const manifest = validateImageCapabilityManifest({
  schema: 'aiworker-openclaw-image-capabilities/v2',
  plugin: {
    id: 'aiworker-image-command', version: '0.4.0', tools: IMAGE_TOOLS,
    retiredTools: ['aiworker_generate_image'],
  },
  attachments: [
    { profile: 'image-studio', agentId: 'image-studio', stateRoot: '.openclaw-image-studio', gatewayPort: 19289, mediaRoot: '.openclaw-image-studio/media', legacyScope: true },
    { profile: 'qwen-current', agentId: 'second-original', stateRoot: '.openclaw-qwen-current', gatewayPort: 18889, mediaRoot: '.openclaw-qwen-current/media', legacyScope: false },
  ],
})

function config(layout = 'entries') {
  const agent = {
    name: '第二原始', workspace: '/safe/workspace',
    tools: { alsoAllow: ['aiworker_analyze_video', 'aiworker_generate_image'], deny: ['exec'] },
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
    assert.deepEqual(agent.tools.alsoAllow, ['aiworker_analyze_video', ...IMAGE_TOOLS])
    assert.equal(agent.tools.alsoAllow.includes('aiworker_generate_image'), false)
    assert.deepEqual(imageCapabilityReplacePaths(before, manifest, attachment), [layout === 'list'
      ? 'agents.list[].tools.alsoAllow'
      : 'agents.entries.second-original.tools.alsoAllow'])
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

test('does not request an array replacement when no legacy image tool is retired', () => {
  const attachment = attachmentForProfile(manifest, 'qwen-current')
  const before = config()
  before.agents.entries['second-original'].tools.alsoAllow = ['aiworker_analyze_video']
  assert.deepEqual(imageCapabilityReplacePaths(before, manifest, attachment), [])
})

test('uses the existing image-studio binding without plugin-specific config before first load', () => {
  const attachment = attachmentForProfile(manifest, 'image-studio')
  const before = {
    agents: { entries: { 'image-studio': {
      workspace: '/safe/workspace', tools: { alsoAllow: ['aiworker_generate_image'], deny: ['exec'] },
    } } },
    plugins: { allow: [], entries: {} },
  }
  const after = renderImageCapabilityConfig(before, manifest, attachment)
  assert.equal(after.plugins.entries['aiworker-image-command'].config.releaseReady, true)
  assert.equal(Object.hasOwn(after.plugins.entries['aiworker-image-command'].config, 'targetAgentId'), false)
  assert.equal(isImageCapabilityAttached(after, manifest, attachment), true)
})

test('refuses conflicting target-agent ownership', () => {
  const attachment = attachmentForProfile(manifest, 'qwen-current')
  const wrong = config()
  wrong.plugins.entries['aiworker-image-command'] = {
    enabled: true, config: { releaseReady: true, targetAgentId: 'another-agent' },
  }
  assert.throws(() => renderImageCapabilityConfig(wrong, manifest, attachment), /plugin_agent_conflict/u)
})

test('refuses duplicate, overlapping, or non-identifier image tool declarations', () => {
  for (const mutate of [
    value => { value.plugin.tools = [IMAGE_TOOLS[0], IMAGE_TOOLS[0]] },
    value => { value.plugin.retiredTools = [IMAGE_TOOLS[0]] },
    value => { value.plugin.tools = ['Bad Tool'] },
  ]) {
    const invalid = structuredClone(manifest)
    mutate(invalid)
    assert.throws(() => validateImageCapabilityManifest(invalid), /manifest_invalid|plugin_tools_invalid/u)
  }
})
