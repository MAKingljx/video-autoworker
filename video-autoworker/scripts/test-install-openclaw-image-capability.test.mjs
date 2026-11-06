import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { compareInventories, inspectImagePluginDoctor, inspectImagePluginRuntime, staleBackupsForRetention } from './install-openclaw-image-capability.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const installer = fileURLToPath(new URL('./install-openclaw-image-capability.mjs', import.meta.url))
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()

function qwenConfig() {
  return {
    agents: { entries: { 'second-original': {
      workspace: '/safe/workspace', tools: { alsoAllow: ['aiworker_analyze_video'], deny: ['exec'] },
    } } },
    plugins: { allow: ['aiworker-video-command', 'aiworker-director-brain'], entries: {
      'aiworker-video-command': { enabled: true, config: { releaseReady: true } },
      'aiworker-director-brain': { enabled: true, config: { releaseReady: true, targetAgentId: 'second-original' }, hooks: { allowConversationAccess: true } },
    } },
  }
}

function fixture({ extensions = true } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aiworker-image-capability-install-')))
  const state = join(home, '.openclaw-qwen-current')
  const bin = join(home, 'ai-worker/bin')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  if (extensions) mkdirSync(join(state, 'extensions'), { recursive: true, mode: 0o700 })
  chmodSync(state, 0o700)
  if (extensions) chmodSync(join(state, 'extensions'), 0o700)
  writeFileSync(join(state, 'openclaw.json'), `${JSON.stringify(qwenConfig(), null, 2)}\n`, { mode: 0o600 })
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  const openclaw = join(bin, 'openclaw')
  writeFileSync(openclaw, '#!/bin/sh\ncase "$*" in\n  *"config validate"*) exit 0 ;;\n  *"config patch"*) printf "%s" "$*" > "$HOME/unexpected-config-patch"; exit 77 ;;\n  *) exit 66 ;;\nesac\n', { mode: 0o700 })
  return { home, state }
}

test('generic installer dry-run validates only the declared qwen attachment and leaves config unchanged', () => {
  const { home, state } = fixture()
  try {
    const before = readFileSync(join(state, 'openclaw.json'))
    const result = spawnSync(process.execPath, [installer, '--dry-run', '--profile', 'qwen-current', '--source-commit', sourceCommit], {
      cwd: root, env: { HOME: home, PATH: process.env.PATH || '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(join(state, 'openclaw.json')), before)
    const receipt = JSON.parse(readFileSync(join(home, 'ai-worker/state/openclaw-image-capabilities/qwen-current.json'), 'utf8'))
    assert.equal(receipt.currentState, 'DRY_RUN_PASSED')
    assert.equal(receipt.attachment.agentId, 'second-original')
    assert.equal(receipt.nextAction, 'apply')
    assert.equal(existsSync(join(home, 'unexpected-config-patch')), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('dry-run accepts an existing declared profile without an extensions directory and does not create one', () => {
  const { home, state } = fixture({ extensions: false })
  try {
    const extensions = join(state, 'extensions')
    assert.equal(existsSync(extensions), false)
    const result = spawnSync(process.execPath, [installer, '--dry-run', '--profile', 'qwen-current', '--source-commit', sourceCommit], {
      cwd: root, env: { HOME: home, PATH: process.env.PATH || '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30_000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(extensions), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('generic installer refuses undeclared profiles before creating profile state', () => {
  const { home } = fixture()
  try {
    const result = spawnSync(process.execPath, [installer, '--dry-run', '--profile', 'qwen-weixin-new', '--source-commit', sourceCommit], {
      cwd: root, env: { HOME: home, PATH: process.env.PATH || '/usr/bin:/bin' }, encoding: 'utf8', timeout: 30_000,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /profile_not_declared/u)
    assert.equal(existsSync(join(home, '.openclaw-qwen-weixin-new')), false)
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('installer documents its declared-profile interface without reading runtime state', () => {
  const result = spawnSync(process.execPath, [installer, '--help'], {
    cwd: root, encoding: 'utf8', timeout: 30_000,
  })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--profile <declared-profile>/u)
})

test('installer separates official package installation from the single CAS config enablement', () => {
  const source = readFileSync(installer, 'utf8')
  assert.match(source, /--acknowledge-install-policy-warning/u)
  assert.match(source, /--no-enable/u)
  assert.match(source, /plugins', 'enable', '--accept-capabilities'/u)
  assert.match(source, /plugins', 'registry', '--refresh'/u)
  assert.match(source, /plugins', 'doctor', '--json'/u)
  assert.match(source, /reconciledLegacySource: true/u)
  assert.match(source, /restartGatewayAndValidate/u)
  assert.match(source, /pluginInstall\.status !== 0 && !installedPlugin/u)
  assert.match(source, /plugin_install_mutated_config/u)
  assert.match(source, /ensureExtensionsDirectory/u)
  assert.match(source, /imageCapabilityReplacePaths\(live\.config, manifest, attachment\)/u)
  assert.match(source, /--replace-path', replacePath/u)
  assert.match(source, /AIWORKER_OPENCLAW_CAPABILITY_REPLACE_PATHS/u)
})

test('doctor accepts unrelated warnings but rejects any image-plugin or critical finding', () => {
  assert.deepEqual(inspectImagePluginDoctor({
    pluginErrors: [],
    diagnostics: [{ pluginId: 'diffs', level: 'warn' }],
  }, 'aiworker-image-command'), { unrelatedWarningPlugins: ['diffs'] })
  assert.throws(() => inspectImagePluginDoctor({
    pluginErrors: [], diagnostics: [{ pluginId: 'aiworker-image-command', level: 'warn' }],
  }, 'aiworker-image-command'), /plugin_doctor_target_unhealthy/u)
  assert.throws(() => inspectImagePluginDoctor({
    pluginErrors: [], diagnostics: [{ pluginId: 'other', level: 'error' }],
  }, 'aiworker-image-command'), /plugin_doctor_unrelated_error/u)
})

test('runtime inspection requires the qwen cover routing hook and only declared tools', () => {
  const plugin = { id: 'aiworker-image-command', version: '0.5.4' }
  const attachment = { legacyScope: false, toolIds: [
    'aiworker_video_cover_read_directory', 'aiworker_video_cover_get_candidates',
    'aiworker_video_cover_submit_protected', 'aiworker_video_cover_task',
  ] }
  const report = {
    plugin: { ...plugin, status: 'loaded' },
    tools: [{ names: attachment.toolIds }],
    typedHooks: [
      { name: 'before_prompt_build' }, { name: 'tool_result_persist' }, { name: 'before_message_write' },
    ],
    diagnostics: [],
  }
  assert.deepEqual(inspectImagePluginRuntime(report, plugin, attachment).toolIds, attachment.toolIds.toSorted())
  assert.throws(() => inspectImagePluginRuntime({ ...report, typedHooks: report.typedHooks.slice(1) }, plugin, attachment),
    /plugin_runtime_unhealthy/u)
  assert.throws(() => inspectImagePluginRuntime({ ...report, tools: [{ names: ['old_tool'] }] }, plugin, attachment),
    /plugin_runtime_unhealthy/u)
})

test('catalog upgrade retires the old facade and exposes typed workflow actions', () => {
  const plugin = { id: 'aiworker-image-command', retiredTools: ['aiworker_generate_image', 'workflow', 'frames', 'frame_submit'] }
  const attachment = { toolIds: ['creative', 'protected', 'task', 'directory', 'candidates', 'submit', 'workflow_task'] }
  const oldImageTool = { id: 'creative', source: 'plugin', pluginId: plugin.id, version: '0.4.0' }
  const before = [oldImageTool, { id: 'aiworker_generate_image', source: 'plugin', pluginId: plugin.id },
    { id: 'frames', source: 'plugin', pluginId: plugin.id },
    { id: 'frame_submit', source: 'plugin', pluginId: plugin.id },
    { id: 'other', source: 'builtin', pluginId: 'core' }]
  const after = [
    { ...oldImageTool, version: '0.5.4' },
    { id: 'protected', source: 'plugin', pluginId: plugin.id },
    { id: 'task', source: 'plugin', pluginId: plugin.id },
    { id: 'directory', source: 'plugin', pluginId: plugin.id },
    { id: 'candidates', source: 'plugin', pluginId: plugin.id },
    { id: 'submit', source: 'plugin', pluginId: plugin.id },
    { id: 'workflow_task', source: 'plugin', pluginId: plugin.id },
    { id: 'other', source: 'builtin', pluginId: 'core' },
  ]
  assert.match(compareInventories(before, after, plugin, attachment, 'catalog'), /^[a-f0-9]{64}$/u)
  assert.match(compareInventories(before.filter(item => item.id !== 'aiworker_generate_image'), after,
    plugin, attachment, 'catalog'), /^[a-f0-9]{64}$/u)
  assert.throws(() => compareInventories(before, [...after, { id: 'unexpected', source: 'plugin', pluginId: plugin.id }],
    plugin, attachment, 'catalog'), /catalog_tool_delta_invalid/u)
})

test('backup retention keeps the two newest verified backup directories by real timestamp', () => {
  const stale = staleBackupsForRetention([
    { path: '/safe/current-z', mtimeNs: 20n },
    { path: '/safe/current-a', mtimeNs: 10n },
    { path: '/safe/current-b', mtimeNs: 30n },
    { path: '/safe/current-c', mtimeNs: 40n },
  ])
  assert.deepEqual(stale, [
    { path: '/safe/current-a', mtimeNs: 10n },
    { path: '/safe/current-z', mtimeNs: 20n },
  ])
})
