import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./apply-qwen-current-feishu-delivery-policy.mjs', import.meta.url))

function write(pathname, value, mode = 0o600) {
  writeFileSync(pathname, value, { mode })
  chmodSync(pathname, mode)
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aiworker-feishu-delivery-policy-')))
  const homeCandidate = join(root, 'home')
  mkdirSync(homeCandidate, { recursive: true, mode: 0o700 })
  chmodSync(homeCandidate, 0o700)
  const home = realpathSync(homeCandidate)
  const state = join(home, '.openclaw-qwen-current')
  const backups = join(home, 'ai-worker', 'backups', 'openclaw-feishu-delivery-policy')
  mkdirSync(state, { recursive: true, mode: 0o700 })
  chmodSync(state, 0o700)
  const stateReal = realpathSync(state)
  const config = join(stateReal, 'openclaw.json')
  write(config, `${JSON.stringify({
    agents: { entries: { 'second-original': { workspace: '/safe/workspace' } } },
    channels: { feishu: { enabled: true, appId: 'test-app', requireMention: true } },
  }, null, 2)}\n`)
  const fake = join(root, 'fake-openclaw.mjs')
  write(fake, `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
const profile = args.indexOf('--profile')
if (profile !== 0 || args[1] !== 'qwen-current') process.exit(91)
const command = args.slice(2)
const state = process.env.AIWORKER_OPENCLAW_QWEN_STATE_DIR
const configPath = state + '/openclaw.json'
const read = () => JSON.parse(fs.readFileSync(configPath, 'utf8'))
const merge = (target, patch) => {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key]
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {}
      merge(target[key], value)
    } else target[key] = value
  }
}
if (command[0] !== 'config') process.exit(92)
if (command[1] === 'file') { process.stdout.write(configPath + '\\n'); process.exit(0) }
if (command[1] === 'validate') process.exit(0)
if (command[1] === 'patch') {
  const index = command.indexOf('--file')
  if (index < 0) process.exit(93)
  const patch = JSON.parse(fs.readFileSync(command[index + 1], 'utf8'))
  if (command.includes('--dry-run')) process.exit(0)
  const config = read()
  merge(config, patch)
  config.meta = { ...(config.meta || {}), lastTouchedAt: 'fake', lastTouchedVersion: 'fake' }
  if (process.env.FAKE_MUTATE_UNRELATED_ON_PATCH === '1') config.gateway = { port: 19991 }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\\n', { mode: 0o600 })
  process.exit(0)
}
process.exit(94)
`, 0o700)
  return { root, home, state: stateReal, backups, config, fake }
}

function run(entry, ...args) {
  const result = spawnSync(process.execPath, [script, ...args], {
    env: {
      ...process.env,
      HOME: entry.home,
      OPENCLAW_BIN: fakeCommand(entry.fake),
      AIWORKER_OPENCLAW_QWEN_STATE_DIR: entry.state,
      AIWORKER_OPENCLAW_FEISHU_POLICY_BACKUP_ROOT: entry.backups,
    },
    encoding: 'utf8',
  })
  return result
}

function fakeCommand(pathname) {
  return pathname
}

test('dry-run validates the official streaming patch without changing config', () => {
  const entry = fixture()
  try {
    const before = readFileSync(entry.config, 'utf8')
    const result = run(entry, '--dry-run')
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.currentState, 'DRY_RUN_PASSED')
    assert.equal(receipt.streaming.mode, 'off')
    assert.equal(readFileSync(entry.config, 'utf8'), before)
    assert.equal(existsSync(entry.backups), false)
  } finally {
    rmSync(entry.root, { recursive: true, force: true })
  }
})

test('apply preserves unrelated Feishu fields and creates one private rollback backup', () => {
  const entry = fixture()
  try {
    const result = run(entry, '--apply')
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.currentState, 'APPLIED')
    assert.equal(receipt.nextAction, 'coordinated_gateway_restart_required')
    const config = JSON.parse(readFileSync(entry.config, 'utf8'))
    assert.deepEqual(config.channels.feishu, {
      enabled: true, appId: 'test-app', requireMention: true, streaming: { mode: 'off' },
    })
    const backups = readdirSync(entry.backups)
    assert.equal(backups.length, 1)
    assert.equal(statSync(join(entry.backups, backups[0])).mode & 0o777, 0o600)
  } finally {
    rmSync(entry.root, { recursive: true, force: true })
  }
})

test('rollback removes a policy value that was absent in the verified backup', () => {
  const entry = fixture()
  try {
    const applied = run(entry, '--apply')
    assert.equal(applied.status, 0, applied.stderr)
    const backup = join(entry.backups, readdirSync(entry.backups)[0])
    const rolledBack = run(entry, '--rollback', '--backup', backup)
    assert.equal(rolledBack.status, 0, rolledBack.stderr)
    const config = JSON.parse(readFileSync(entry.config, 'utf8'))
    assert.equal(Object.hasOwn(config.channels.feishu, 'streaming'), false)
    assert.equal(JSON.parse(rolledBack.stdout).currentState, 'ROLLED_BACK')
  } finally {
    rmSync(entry.root, { recursive: true, force: true })
  }
})

test('apply refuses unrelated drift and only restores its own policy field', () => {
  const entry = fixture()
  try {
    const result = spawnSync(process.execPath, [script, '--apply'], {
      env: {
        ...process.env,
        HOME: entry.home,
        OPENCLAW_BIN: entry.fake,
        AIWORKER_OPENCLAW_QWEN_STATE_DIR: entry.state,
        AIWORKER_OPENCLAW_FEISHU_POLICY_BACKUP_ROOT: entry.backups,
        FAKE_MUTATE_UNRELATED_ON_PATCH: '1',
      },
      encoding: 'utf8',
    })
    assert.notEqual(result.status, 0)
    const config = JSON.parse(readFileSync(entry.config, 'utf8'))
    assert.equal(config.gateway.port, 19991)
    assert.equal(Object.hasOwn(config.channels.feishu, 'streaming'), false)
  } finally {
    rmSync(entry.root, { recursive: true, force: true })
  }
})
