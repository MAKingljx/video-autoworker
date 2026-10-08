import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync,
  rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installEditingPlugin, renderEditingConfiguration } from './install-aiworker-editing-plugin.mjs'

let home
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const commit = 'a'.repeat(40)
const directory = pathname => { mkdirSync(pathname, { recursive: true, mode: 0o700 }); chmodSync(pathname, 0o700); return pathname }
const configPath = () => join(home, '.openclaw-gpt-main/openclaw.json')
const read = () => JSON.parse(readFileSync(configPath(), 'utf8'))
const write = (pathname, value) => { directory(dirname(pathname)); writeFileSync(pathname, JSON.stringify(value), { mode: 0o600 }); chmodSync(pathname, 0o600) }
const options = mode => ({ mode, home, sourceRoot, sourceCommit: commit })
const dependencies = { verifySource: () => ({ headCommit: commit }) }

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'editing-plugin-installer-')))
  write(configPath(), { agents: { entries: { main: { workspace: '/existing/workspace', tools: { alsoAllow: ['existing_tool'] } },
    assistant: { tools: { alsoAllow: ['other_tool'] } } } },
    gateway: { auth: { token: 'credential-must-never-enter-recovery-files' } },
    models: { provider: { secret: 'unrelated-model-credential' } }, plugins: { allow: ['existing-plugin'], entries: {} } })
  for (const name of ['qwen-current', 'qwen-weixin-new', 'image-studio']) write(join(home, `.openclaw-${name}/openclaw.json`), { immutable: name })
  const sdk = directory(join(home, 'ai-worker/node/test/lib/node_modules/openclaw'))
  write(join(sdk, 'package.json'), { name: 'openclaw', version: '2026.9.2' })
  writeFileSync(join(sdk, 'openclaw.mjs'), 'export {}', { mode: 0o600 })
  directory(join(home, 'ai-worker/bin')); symlinkSync(join(sdk, 'openclaw.mjs'), join(home, 'ai-worker/bin/openclaw'))
  directory(join(home, 'ai-worker/state/video-autoworker/blue-green'))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

test('prepare is read-only and fixes scope to gpt-main/main', () => {
  const original = readFileSync(configPath())
  const result = installEditingPlugin(options('prepare'), dependencies)
  assert.equal(result.currentState, 'PREPARED'); assert.equal(result.profile, 'gpt-main'); assert.equal(result.agentId, 'main')
  assert.deepEqual(readFileSync(configPath()), original)
  assert.equal(existsSync(join(home, '.openclaw-gpt-main/extensions/aiworker-editing')), false)
  assert.equal(existsSync(join(home, 'ai-worker/backups/aiworker-editing')), false)
})

test('apply changes only the target plugin grants and preserves credentials and other profiles', () => {
  const before = read(), others = ['qwen-current', 'qwen-weixin-new', 'image-studio'].map(name => readFileSync(join(home, `.openclaw-${name}/openclaw.json`)))
  const result = installEditingPlugin(options('apply'), dependencies), current = read()
  assert.equal(result.currentState, 'INSTALLED_PENDING_GATEWAY_VALIDATION'); assert.equal(result.gatewayChanged, false)
  assert.deepEqual(current.gateway, before.gateway); assert.deepEqual(current.models, before.models)
  assert.deepEqual(current.agents.entries.assistant, before.agents.entries.assistant)
  assert.deepEqual(current.agents.entries.main.tools.alsoAllow, ['existing_tool', 'aiworker_edit_video'])
  for (let index = 0; index < others.length; index++) assert.deepEqual(readFileSync(join(home,
    `.openclaw-${['qwen-current', 'qwen-weixin-new', 'image-studio'][index]}/openclaw.json`)), others[index])
  const recoveryText = readFileSync(join(result.recoveryBackup, 'recovery.json'), 'utf8')
  assert.equal(recoveryText.includes(before.gateway.auth.token), false)
  assert.equal(recoveryText.includes(before.models.provider.secret), false)
})

test('verified recovery restores owned fields without altering the credentials', () => {
  const original = read(); const result = installEditingPlugin(options('apply'), dependencies)
  const rolledBack = installEditingPlugin({ ...options('rollback'), backup: result.recoveryBackup }, dependencies)
  assert.equal(rolledBack.currentState, 'ROLLED_BACK_PENDING_GATEWAY_VALIDATION')
  assert.deepEqual(read().gateway, original.gateway)
  assert.deepEqual(read().agents.entries.main.tools, original.agents.entries.main.tools)
  assert.equal(read().plugins.entries['aiworker-editing'], undefined)
  assert.equal(existsSync(join(home, '.openclaw-gpt-main/extensions/aiworker-editing')), false)
})

test('updates retain no more than two verified component recovery versions', () => {
  for (let index = 0; index < 3; index++) installEditingPlugin(options('apply'), dependencies)
  assert.equal(readdirSync(join(home, 'ai-worker/backups/aiworker-editing/gpt-main')).length, 2)
})

test('global and cross-agent grants are rejected before configuration writes', () => {
  for (const variant of [{ tools: { alsoAllow: ['aiworker_edit_video'] } },
    { agents: { entries: { main: {}, other: { tools: { alsoAllow: ['aiworker_edit_video'] } } } } }]) {
    assert.throws(() => renderEditingConfiguration({ ...read(), ...variant }, '/target/plugin'), /grant_rejected/u)
  }
})

test('explicit tool denials and SDK version mismatch fail closed', () => {
  assert.throws(() => renderEditingConfiguration({ ...read(), tools: { deny: ['aiworker_edit_video'] } }, '/target/plugin'), /policy_denied/u)
  write(join(home, 'ai-worker/node/test/lib/node_modules/openclaw/package.json'), { version: 'different' })
  const original = readFileSync(configPath())
  assert.throws(() => installEditingPlugin(options('apply'), dependencies), /sdk_identity/u)
  assert.deepEqual(readFileSync(configPath()), original)
})

test('rollback refuses concurrent changes to the installed grant instead of overwriting them', () => {
  const result = installEditingPlugin(options('apply'), dependencies)
  const modified = read(); modified.agents.entries.main.tools.alsoAllow.push('new-unrelated-tool'); write(configPath(), modified)
  assert.throws(() => installEditingPlugin({ ...options('rollback'), backup: result.recoveryBackup }, dependencies), /configuration_drift/u)
  assert.ok(read().agents.entries.main.tools.alsoAllow.includes('new-unrelated-tool'))
})
