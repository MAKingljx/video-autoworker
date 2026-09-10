import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const script = join(root, 'scripts/test-openclaw-owned-dialogue.mjs')

function fixture(overrides = {}) {
  const runRoot = realpathSync(mkdtempSync(join(tmpdir(), 'owned-dialogue-entry-')))
  chmodSync(runRoot, 0o700)
  const configPath = join(runRoot, 'openclaw.json')
  writeFileSync(configPath, '{}', { mode: 0o600 })
  const config = {
    schema: 'video-autoworker-owned-dialogue-input/v1', armed: true,
    qaSourceRoot: root,
    expectedQaCommit: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    nodePath: realpathSync(process.execPath), expectedNodeVersion: process.version,
    openclawPath: join(runRoot, 'not-invoked'), expectedSdkVersion: '2026.9.2',
    profile: 'qwen-current', agentId: 'second-original', stateRoot: runRoot, configPath,
    gatewayLaunchLabel: 'ai.openclaw.qwen-current', gatewayPort: 18889,
    expectedGatewayPid: 1, expectedThinking: 'medium', expectedModel: 'provider/model',
    ...overrides,
  }
  const inputPath = join(runRoot, 'inputs.json')
  writeFileSync(inputPath, JSON.stringify(config), { mode: 0o600 })
  return { runRoot, inputPath }
}

test('rejects an unarmed attempt before any ownership record, status, or CLI invocation', () => {
  const value = fixture({ armed: false })
  try {
    const result = spawnSync(process.execPath, [script, '--config', value.inputPath], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /input_not_armed/u)
    for (const name of ['attempt-started.json', 'synthetic-session-ownership.json', 'dialogue-status.json']) {
      assert.equal(existsSync(join(value.runRoot, name)), false)
    }
  } finally { rmSync(value.runRoot, { recursive: true, force: true }) }
})

test('a duplicate invocation preserves the existing attempt and cannot publish a competing result', () => {
  const value = fixture()
  const startedPath = join(value.runRoot, 'attempt-started.json')
  writeFileSync(startedPath, '{"existing":true}\n', { mode: 0o600 })
  try {
    const result = spawnSync(process.execPath, [script, '--config', value.inputPath], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /attempt_already_used/u)
    assert.equal(readFileSync(startedPath, 'utf8'), '{"existing":true}\n')
    assert.equal(existsSync(join(value.runRoot, 'dialogue-status.json')), false)
    assert.equal(existsSync(join(value.runRoot, 'synthetic-session-ownership.json')), false)
  } finally { rmSync(value.runRoot, { recursive: true, force: true }) }
})
