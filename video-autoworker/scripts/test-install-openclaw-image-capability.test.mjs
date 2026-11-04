import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

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

function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'aiworker-image-capability-install-')))
  const state = join(home, '.openclaw-qwen-current')
  const bin = join(home, 'ai-worker/bin')
  mkdirSync(join(state, 'extensions'), { recursive: true, mode: 0o700 })
  chmodSync(state, 0o700)
  chmodSync(join(state, 'extensions'), 0o700)
  writeFileSync(join(state, 'openclaw.json'), `${JSON.stringify(qwenConfig(), null, 2)}\n`, { mode: 0o600 })
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  const openclaw = join(bin, 'openclaw')
  writeFileSync(openclaw, '#!/bin/sh\ncase "$*" in\n  *"config validate"*|*"config patch"*"--dry-run"*) exit 0 ;;\n  *) exit 66 ;;\nesac\n', { mode: 0o700 })
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
  assert.match(source, /plugin_install_mutated_config/u)
})
