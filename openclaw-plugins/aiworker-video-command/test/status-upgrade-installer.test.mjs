import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access, chmod, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { materializeHistoricalPlugin, V03_SOURCE_SHA } from './helpers/historical-plugin-fixture.mjs'

const execFileAsync = promisify(execFile)
const sourceRoot = process.cwd()
const sourceEntry = resolve(sourceRoot, 'scripts/upgrade-aiworker-video-command-status-plugin.sh')
const sourceStatusValidator = resolve(sourceRoot, 'scripts/validate-aiworker-video-status-upgrade.mjs')
const sourceUpgradeValidator = resolve(sourceRoot, 'scripts/validate-aiworker-video-command-upgrade.mjs')
const sourceUpgradePolicy = resolve(sourceRoot, 'scripts/lib/aiworker-video-command-upgrade-policy.mjs')
const sourceCandidate = resolve(sourceRoot, 'openclaw-plugins/aiworker-video-command')
const pluginId = 'aiworker-video-command'
const targetSha = 'a'.repeat(40)
const roots = []
const senderHash = createHash('sha256')
  .update('aiworker-video-command:telegram-sender:v1\0')
  .update('123456789')
  .digest('hex')

async function executable(pathname, source) {
  await writeFile(pathname, source, { mode: 0o755 })
  await chmod(pathname, 0o755)
}

async function json(pathname, value, mode = 0o600) {
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, { mode })
}

function profileConfig() {
  return {
    channels: { telegram: { dmPolicy: 'allowlist' } },
    bindings: [{ agentId: 'second-original', match: { channel: 'telegram' } }],
    commands: { ownerAllowFrom: ['telegram:123456789'] },
    plugins: {
      allow: [pluginId],
      entries: { [pluginId]: { enabled: true, config: { allowedSenderSha256: senderHash } } },
    },
    agents: { list: [{ id: 'second-original', tools: { profile: 'standard', allow: ['read', 'exec'] } }] },
  }
}

async function fakeCommands(bin) {
  await symlink(process.execPath, join(bin, 'node'))
  await executable(join(bin, 'id'), '#!/bin/sh\n[ "$1" = "-un" ] && printf "heisenbergs-1\\n"\n')
  await executable(join(bin, 'hostname'), '#!/bin/sh\nprintf "HEISENBERGS-1deMac-Studio.local\\n"\n')
  await executable(join(bin, 'git'), `#!/usr/bin/env node
const { spawnSync } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const args = process.argv.slice(2)
const joined = args.join(' ')
const gitDrift = process.env.FAKE_GIT_DRIFT_AFTER_INSTALL === '1'
  && existsSync(process.env.FAKE_QWEN_DB + '.record.json')
  && JSON.parse(readFileSync(process.env.FAKE_QWEN_DB + '.record.json', 'utf8')).version === '0.4.0'
if (joined.includes('remote get-url origin')) process.stdout.write('https://github.com/MAKingljx/video-autoworker.git\\n')
else if (joined.includes('symbolic-ref --short -q HEAD')) process.stdout.write((gitDrift ? 'drifted' : 'main') + '\\n')
else if (joined.includes('status --porcelain')) process.stdout.write('')
else if (joined.includes('rev-parse') && joined.includes('refs/remotes/origin/main')) process.stdout.write('${targetSha}\\n')
else if (joined.includes('rev-parse') && joined.includes('HEAD')) process.stdout.write('${targetSha}\\n')
else if (joined.includes('ls-remote')) process.stdout.write('${targetSha}\\trefs/heads/main\\n')
else if (joined.includes('cat-file -e ${V03_SOURCE_SHA}^{commit}')) process.exit(0)
else if (joined.includes('merge-base --is-ancestor ${V03_SOURCE_SHA} ${targetSha}')) process.exit(0)
else if (args.includes('archive')) {
  const result = spawnSync('/usr/bin/tar', ['-cf', '-', '-C', process.env.FAKE_HISTORY_ROOT, 'openclaw-plugins/${pluginId}'])
  if (result.status !== 0) process.exit(result.status || 1)
  process.stdout.write(result.stdout)
} else process.exit(2)
`)
  await executable(join(bin, 'lsof'), `#!/usr/bin/env node
const { readFileSync } = require('node:fs')
const joined = process.argv.slice(2).join(' ')
const match = /-iTCP:(\\d+)/.exec(joined)
if (!match) process.exit(2)
const port = match[1]
const record = JSON.parse(readFileSync(process.env.FAKE_QWEN_DB + '.record.json', 'utf8'))
const drift = process.env.FAKE_PROTECTED_PID_DRIFT === '1' && record.version === '0.4.0' && port === '3017'
const values = { '3017': '3017', '5678': '5678', '5679': '5679', '18091': '18091', '18789': '18789', '18989': '18989' }
if (!values[port]) process.exit(1)
process.stdout.write((drift ? '93017' : values[port]) + '\\n')
`)
  await executable(join(bin, 'sqlite3'), `#!/usr/bin/env node
const { readFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] !== '-readonly' || !args[1]) process.exit(73)
process.stdout.write(JSON.stringify(JSON.parse(readFileSync(args[1] + '.record.json', 'utf8'))) + '\\n')
`)
  await executable(join(bin, 'openclaw'), `#!/usr/bin/env node
const { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
let args = process.argv.slice(2)
let profile = null
if (args[0] === '--profile') { profile = args[1]; args = args.slice(2) }
if (args[0] === '--version') { process.stdout.write('OpenClaw 2026.7.1-2 (fake)\\n'); process.exit(0) }
const state = process.env.OPENCLAW_STATE_DIR || join(process.env.HOME, '.openclaw-qwen-current')
const installed = join(state, 'extensions', '${pluginId}')
const database = join(state, 'state', 'openclaw.sqlite')
const version = () => JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')).version
const isProduction = profile === 'qwen-current'
const log = process.env.FAKE_OPENCLAW_LOG
if (log) appendFileSync(log, JSON.stringify({ profile, args }) + '\\n')
if (args[0] === 'plugins' && args[1] === 'install') {
  const source = resolve(args.at(-1))
  const sourceVersion = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version
  const failMarker = process.env.FAKE_INSTALL_FAIL_MARKER
  const shouldFail = isProduction && failMarker && !existsSync(failMarker)
    && ((process.env.FAKE_FAIL_CANDIDATE_INSTALL === '1' && sourceVersion === '0.4.0')
      || (process.env.FAKE_FAIL_ROLLBACK_INSTALL === '1' && sourceVersion === '0.3.0'))
  if (shouldFail) { writeFileSync(failMarker, 'failed'); process.stderr.write('injected install failure\\n'); process.exit(91) }
  rmSync(installed, { recursive: true, force: true })
  mkdirSync(join(state, 'extensions'), { recursive: true })
  cpSync(source, installed, { recursive: true })
  rmSync(join(installed, 'node_modules'), { recursive: true, force: true })
  mkdirSync(join(installed, 'node_modules'), { recursive: true })
  symlinkSync(process.env.FAKE_OPENCLAW_PEER, join(installed, 'node_modules', 'openclaw'))
  mkdirSync(join(state, 'state'), { recursive: true })
  writeFileSync(database, '')
  writeFileSync(database + '.record.json', JSON.stringify({
    source: 'path', sourcePath: source, installPath: installed, version: sourceVersion,
    installedAt: '2026-08-11T01:02:03.000Z',
  }))
  process.stdout.write('installed\\n'); process.exit(0)
}
if (args[0] === 'plugins' && args[1] === 'inspect') {
  process.stdout.write(JSON.stringify({ plugin: { id: '${pluginId}', status: 'loaded', version: version() },
    typedHooks: [{ name: 'before_dispatch' }], tools: [], diagnostics: [] }) + '\\n'); process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'restart') {
  process.stdout.write(JSON.stringify({ ok: true }) + '\\n'); process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ service: { loaded: true }, rpc: { ok: true } }) + '\\n'); process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.list') {
  process.stdout.write(JSON.stringify({ count: 1, hasMore: false, nextOffset: null, totalCount: 1,
    sessions: [{ key: 'agent:second-original:telegram:direct:owner' }] }) + '\\n'); process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'tools.catalog') {
  const marker = process.env.FAKE_LIVE_FAIL_MARKER
  if (isProduction && version() === '0.4.0' && process.env.FAKE_FAIL_CANDIDATE_LIVE === '1'
    && marker && !existsSync(marker)) {
    writeFileSync(marker, 'failed'); process.stderr.write('injected live failure\\n'); process.exit(92)
  }
  process.stdout.write(JSON.stringify({ agentId: 'second-original', groups: [] }) + '\\n'); process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'tools.effective') {
  process.stdout.write(JSON.stringify({ agentId: 'second-original', profile: 'standard', groups: [{
    id: 'core', source: 'core', tools: [{ id: 'exec' }, { id: 'read' }],
  }] }) + '\\n'); process.exit(0)
}
process.stderr.write('unsupported fake openclaw call: ' + args.join(' ') + '\\n'); process.exit(74)
`)
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'video-status-upgrade-entry.')))
  roots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const repo = join(root, 'repo')
  const history = join(root, 'history')
  const state = join(home, '.openclaw-qwen-current')
  const installed = join(state, 'extensions', pluginId)
  const database = join(state, 'state', 'openclaw.sqlite')
  const config = join(state, 'openclaw.json')
  const peer = join(root, 'openclaw-peer')
  const entry = join(repo, 'scripts', 'upgrade-aiworker-video-command-status-plugin.sh')
  const log = join(root, 'openclaw.jsonl')
  await Promise.all([
    mkdir(bin, { recursive: true, mode: 0o700 }), mkdir(join(repo, 'scripts', 'lib'), { recursive: true, mode: 0o700 }),
    mkdir(join(repo, 'openclaw-plugins'), { recursive: true, mode: 0o700 }),
    mkdir(join(history, 'openclaw-plugins'), { recursive: true, mode: 0o700 }),
    mkdir(join(state, 'extensions'), { recursive: true, mode: 0o700 }), mkdir(join(state, 'state'), { recursive: true, mode: 0o700 }),
    mkdir(peer, { recursive: true, mode: 0o700 }),
  ])
  await Promise.all([
    cp(sourceEntry, entry), cp(sourceStatusValidator, join(repo, 'scripts', 'validate-aiworker-video-status-upgrade.mjs')),
    cp(sourceUpgradeValidator, join(repo, 'scripts', 'validate-aiworker-video-command-upgrade.mjs')),
    cp(sourceUpgradePolicy, join(repo, 'scripts', 'lib', 'aiworker-video-command-upgrade-policy.mjs')),
    cp(sourceCandidate, join(repo, 'openclaw-plugins', pluginId), { recursive: true }),
  ])
  await chmod(entry, 0o755)
  await materializeHistoricalPlugin(join(history, 'openclaw-plugins', pluginId))
  await materializeHistoricalPlugin(installed)
  await mkdir(join(installed, 'node_modules'))
  await symlink(peer, join(installed, 'node_modules', 'openclaw'))
  await writeFile(database, '')
  await json(config, profileConfig())
  await json(`${database}.record.json`, {
    source: 'path', sourcePath: join(repo, 'openclaw-plugins', pluginId), installPath: installed,
    version: '0.3.0', installedAt: '2026-08-11T00:00:00.000Z',
  })
  await fakeCommands(bin)
  const env = {
    ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
    FAKE_HISTORY_ROOT: history, FAKE_OPENCLAW_PEER: peer, FAKE_QWEN_DB: database,
    FAKE_OPENCLAW_LOG: log, FAKE_INSTALL_FAIL_MARKER: join(root, 'install.fail'),
    FAKE_LIVE_FAIL_MARKER: join(root, 'live.fail'),
  }
  return { root, home, entry, state, installed, database, config, log, env }
}

async function run(value, mode, extra = {}) {
  const args = [mode, '--target-sha', targetSha]
  if (extra.backup) args.push('--backup', extra.backup)
  const env = { ...value.env, ...extra }
  delete env.backup
  return execFileAsync(value.entry, args, { env, maxBuffer: 8 * 1024 * 1024 })
}

async function packageVersion(value) {
  return JSON.parse(await readFile(join(value.installed, 'package.json'), 'utf8')).version
}

async function statusBackups(value) {
  const root = join(value.home, 'ai-worker', 'backups', pluginId)
  try {
    return (await readdir(root)).filter(name => name.startsWith('status-upgrade-')).map(name => join(root, name))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function markerState(backup) {
  const present = async path => access(path).then(() => true, () => false)
  return {
    active: await present(join(backup, '.active-rollback-source.json')),
    verified: await present(join(backup, '.verified')),
  }
}

async function seedVerifiedHistory(value) {
  const backupRoot = join(value.home, 'ai-worker', 'backups', pluginId)
  const backups = [
    join(backupRoot, 'status-upgrade-20260810-010101.oldone'),
    join(backupRoot, 'status-upgrade-20260810-020202.oldtwo'),
  ]
  for (const backup of backups) {
    await mkdir(backup, { recursive: true, mode: 0o700 })
    await writeFile(join(backup, '.verified'), '', { mode: 0o600 })
  }
  return backups
}

async function payloadFingerprint(pathname) {
  const result = await execFileAsync(process.execPath, [sourceUpgradeValidator, 'payload-fingerprint', pathname])
  return result.stdout.trim()
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('controlled 0.3.0 to 0.4.0 status upgrade entry', () => {
  it('dry-runs through an isolated official install with zero production change', async () => {
    const value = await fixture()
    const configBefore = await readFile(value.config)
    const result = await run(value, '--dry-run')
    expect(result.stdout).toContain('Dry run passed')
    expect(await packageVersion(value)).toBe('0.3.0')
    expect(await readFile(value.config)).toEqual(configBefore)
    expect(await statusBackups(value)).toEqual([])
    expect((await readFile(value.log, 'utf8')).split('\n').filter(Boolean)
      .some(line => JSON.parse(line).profile === 'qwen-current' && JSON.parse(line).args[0] === 'gateway'
        && JSON.parse(line).args[1] === 'restart')).toBe(false)
  }, 30_000)

  it('applies 0.4.0 with config unchanged and one verified recovery point', async () => {
    const value = await fixture()
    const history = await seedVerifiedHistory(value)
    const configBefore = await readFile(value.config)
    const result = await run(value, '--apply')
    expect(result.stdout).toContain('from 0.3.0 to 0.4.0')
    expect(await packageVersion(value)).toBe('0.4.0')
    expect(await readFile(value.config)).toEqual(configBefore)
    const backups = await statusBackups(value)
    expect(backups.map(pathname => basename(pathname))).not.toContain(basename(history[0]))
    expect(backups.map(pathname => basename(pathname))).toContain(basename(history[1]))
    expect(backups).toHaveLength(2)
    const backup = backups.find(pathname => !history.includes(pathname))
    expect(await markerState(backup)).toEqual({ active: false, verified: true })
    expect((await stat(backup)).mode & 0o777).toBe(0o700)
  }, 30_000)

  it('automatically restores exact 0.3.0 and active-only marker after candidate live failure', async () => {
    const value = await fixture()
    const history = await seedVerifiedHistory(value)
    await expect(run(value, '--apply', { FAKE_FAIL_CANDIDATE_LIVE: '1' })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('Upgrade failed; exact 0.3.0 payload'),
    })
    await expect(access(join(value.root, 'live.fail'))).resolves.toBeUndefined()
    expect(await packageVersion(value)).toBe('0.3.0')
    for (const backup of history) {
      await expect(access(join(backup, '.verified'))).resolves.toBeUndefined()
    }
    const backups = await statusBackups(value)
    const states = await Promise.all(backups.map(async backup => ({ backup, ...await markerState(backup) })))
    const [{ backup }] = states.filter(state => state.active)
    expect(await markerState(backup)).toEqual({ active: true, verified: false })
    const marker = JSON.parse(await readFile(join(backup, '.active-rollback-source.json'), 'utf8'))
    expect(marker.pluginFingerprint).toBe(await payloadFingerprint(join(backup, 'previous-plugin')))
    expect(marker.pluginFingerprint).toBe(await payloadFingerprint(value.installed))
  }, 30_000)

  it('explicitly rolls a successful 0.4.0 release back to exact 0.3.0', async () => {
    const value = await fixture()
    await run(value, '--apply')
    const [backup] = await statusBackups(value)
    const result = await run(value, '--rollback', { backup })
    expect(result.stdout).toContain('from 0.4.0 to exact 0.3.0')
    expect(await packageVersion(value)).toBe('0.3.0')
    expect(await markerState(backup)).toEqual({ active: true, verified: false })
  }, 30_000)

  it('fully restores 0.4.0 and verified-only backup when explicit rollback install fails', async () => {
    const value = await fixture()
    await run(value, '--apply')
    const [backup] = await statusBackups(value)
    await expect(run(value, '--rollback', { backup, FAKE_FAIL_ROLLBACK_INSTALL: '1' }))
      .rejects.toMatchObject({ code: 1 })
    expect(await packageVersion(value)).toBe('0.4.0')
    expect(await markerState(backup)).toEqual({ active: false, verified: true })
  }, 30_000)

  it('rejects protected PID drift and restores 0.3.0 without dual marker state', async () => {
    const value = await fixture()
    await expect(run(value, '--apply', { FAKE_PROTECTED_PID_DRIFT: '1' })).rejects.toMatchObject({ code: 1 })
    expect(await packageVersion(value)).toBe('0.3.0')
    const [backup] = await statusBackups(value)
    expect(await markerState(backup)).toEqual({ active: true, verified: false })
  }, 30_000)

  it('rejects a post-install Git target drift and restores exact 0.3.0', async () => {
    const value = await fixture()
    await expect(run(value, '--apply', { FAKE_GIT_DRIFT_AFTER_INSTALL: '1' })).rejects.toMatchObject({ code: 1 })
    expect(await packageVersion(value)).toBe('0.3.0')
    const [backup] = await statusBackups(value)
    expect(await markerState(backup)).toEqual({ active: true, verified: false })
  }, 30_000)
})
