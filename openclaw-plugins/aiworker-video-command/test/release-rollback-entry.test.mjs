import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import {
  fingerprintAuditedPreviousPlugin,
  snapshotTaskFlowState,
} from '../../../scripts/lib/aiworker-video-release-rollback-policy.mjs'

const execFileAsync = promisify(execFile)
const rollbackEntry = resolve(process.cwd(), 'scripts/rollback-aiworker-video-release.sh')
const pluginSource = resolve(process.cwd(), 'openclaw-plugins/aiworker-video-command')
const upgradeValidator = resolve(process.cwd(), 'scripts/validate-aiworker-video-command-upgrade.mjs')
const targetSha = '0123456789abcdef0123456789abcdef01234567'
const pluginId = 'aiworker-video-command'
const toolName = 'aiworker_analyze_video'
const baseToolIds = ['apply_patch', 'edit', 'exec', 'memory_get', 'memory_search', 'process', 'read', 'web_fetch', 'web_search', 'write']
const senderHash = createHash('sha256')
  .update('aiworker-video-command:telegram-sender:v1\0')
  .update('123456789')
  .digest('hex')
const roots = []

async function directory(pathname, mode = 0o700) {
  await mkdir(pathname, { recursive: true, mode })
}

async function file(pathname, value, mode = 0o600) {
  await writeFile(pathname, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode })
}

async function executable(pathname, source) {
  await writeFile(pathname, source, { mode: 0o755 })
  await chmod(pathname, 0o755)
}

function baseConfig(tools, pluginConfig) {
  return {
    channels: { telegram: { dmPolicy: 'allowlist' } },
    bindings: [{ agentId: 'second-original', match: { channel: 'telegram' } }],
    commands: { ownerAllowFrom: ['telegram:123456789'] },
    plugins: {
      allow: [pluginId],
      entries: { [pluginId]: { enabled: true, ...(pluginConfig ? { config: pluginConfig } : {}) } },
    },
    agents: { list: [{ id: 'second-original', tools }] },
  }
}

function effectiveReport(version) {
  const isOld = version === '0.2.0'
  const ids = isOld ? [...baseToolIds, toolName] : baseToolIds
  return {
    agentId: 'second-original',
    profile: isOld ? 'full' : 'standard',
    groups: [{ id: 'core', label: 'Core', source: 'core', tools: ids.map(id => ({ id })) }],
  }
}

async function createFakeCommands(binDir) {
  await symlink(process.execPath, join(binDir, 'node'))
  await executable(join(binDir, 'id'), '#!/bin/sh\n[ "$1" = "-un" ] && printf "heisenbergs-1\\n"\n')
  await executable(join(binDir, 'hostname'), '#!/bin/sh\nprintf "HEISENBERGS-1deMac-Studio.local\\n"\n')
  await executable(join(binDir, 'git'), `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ')
if (args.includes('remote get-url origin')) process.stdout.write('https://github.com/MAKingljx/video-autoworker.git\\n')
else if (args.includes('status --porcelain')) process.stdout.write('')
else if (args.includes('ls-remote --exit-code origin refs/heads/main')) process.stdout.write('${targetSha}\\trefs/heads/main\\n')
else if (args.includes('rev-parse HEAD')) process.stdout.write('${targetSha}\\n')
else if (args.includes('rev-parse refs/remotes/origin/main')) process.stdout.write('${targetSha}\\n')
else process.exit(2)
`)
  await executable(join(binDir, 'lsof'), `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ')
if (args.includes(':3017')) process.stdout.write('111\\n')
else if (args.includes(':5678') || args.includes(':5679')) process.stdout.write('222\\n')
else process.exit(1)
`)
  await executable(join(binDir, 'sqlite3'), `#!/usr/bin/env node
const { existsSync, readFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] !== '-readonly' || !args[1]) process.exit(73)
const recordPath = args[1] + '.record.json'
if (existsSync(recordPath)) process.stdout.write(JSON.stringify(JSON.parse(readFileSync(recordPath, 'utf8'))) + '\\n')
`)
  await executable(join(binDir, 'openclaw'), `#!/usr/bin/env node
const { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
let args = process.argv.slice(2)
let profile = null
if (args[0] === '--profile') { profile = args[1]; args = args.slice(2) }
if (args[0] === '--version') { process.stdout.write('OpenClaw 2026.7.1-2 (fake)\\n'); process.exit(0) }
if (profile !== 'qwen-current') process.exit(72)
const stateDir = join(process.env.HOME, '.openclaw-qwen-current')
const configPath = join(stateDir, 'openclaw.json')
const installDir = join(stateDir, 'extensions', '${pluginId}')
const databasePath = join(stateDir, 'state', 'openclaw.sqlite')
const version = () => JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version
if (args[0] === 'plugins' && args[1] === 'install') {
  const source = resolve(args.at(-1))
  rmSync(installDir, { recursive: true, force: true })
  mkdirSync(join(stateDir, 'extensions'), { recursive: true })
  cpSync(source, installDir, { recursive: true })
  rmSync(join(installDir, 'node_modules'), { recursive: true, force: true })
  mkdirSync(join(installDir, 'node_modules'), { recursive: true })
  symlinkSync(process.env.FAKE_OPENCLAW_TARGET, join(installDir, 'node_modules', 'openclaw'))
  mkdirSync(join(stateDir, 'state'), { recursive: true })
  writeFileSync(databasePath, '')
  writeFileSync(databasePath + '.record.json', JSON.stringify({
    source: 'path', sourcePath: source, installPath: installDir, version: version(),
    installedAt: '2026-08-10T02:03:04.000Z',
  }))
  process.stdout.write('installed\\n')
  process.exit(0)
}
if (args[0] === 'plugins' && args[1] === 'inspect') {
  const old = version() === '0.2.0'
  process.stdout.write(JSON.stringify({
    plugin: { id: '${pluginId}', status: 'loaded', version: version() },
    typedHooks: (old ? ['before_dispatch', 'before_prompt_build', 'before_tool_call'] : ['before_dispatch']).map(name => ({ name })),
    tools: old ? [{ names: ['${toolName}'], optional: true }] : [], diagnostics: [],
  }) + '\\n')
  process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'restart') {
  process.stdout.write(JSON.stringify({ ok: true, service: { loaded: true } }) + '\\n')
  process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ service: { loaded: true }, rpc: { ok: true } }) + '\\n')
  process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.list') {
  process.stdout.write(JSON.stringify({ count: 1, hasMore: false, nextOffset: null, totalCount: 1,
    sessions: [{ key: 'agent:second-original:telegram:direct:owner' }] }) + '\\n')
  process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'tools.catalog') {
  const old = version() === '0.2.0'
  process.stdout.write(JSON.stringify({ agentId: 'second-original', groups: old ? [{
    id: '${pluginId}', label: 'Video', source: 'plugin', pluginId: '${pluginId}',
    tools: [{ id: '${toolName}', source: 'plugin', pluginId: '${pluginId}', optional: true }],
  }] : [{ id: 'core', label: 'Core', source: 'core', tools: [] }] }) + '\\n')
  process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'tools.effective') {
  const old = version() === '0.2.0'
  const ids = old ? ${JSON.stringify([...baseToolIds, toolName])} : ${JSON.stringify(baseToolIds)}
  process.stdout.write(JSON.stringify({ agentId: 'second-original', profile: old ? 'full' : 'standard',
    groups: [{ id: 'core', label: 'Core', source: 'core', tools: ids.map(id => ({ id })) }] }) + '\\n')
  process.exit(0)
}
process.stderr.write('unsupported fake openclaw call: ' + args.join(' ') + '\\n')
process.exit(74)
`)
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'video-release-rollback-entry.')))
  roots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const stateDir = join(home, '.openclaw-qwen-current')
  const installedPlugin = join(stateDir, 'extensions', pluginId)
  const databasePath = join(stateDir, 'state', 'openclaw.sqlite')
  const workspace = join(home, 'AI-worker-second-original-workspace')
  const pluginBackupRoot = join(home, 'ai-worker', 'backups', pluginId)
  const taskBackupRoot = join(home, 'ai-worker', 'backups', 'aiworker-task-flow-skill')
  const officialOpenClaw = join(root, 'official-openclaw')
  await Promise.all([
    directory(home), directory(bin), directory(join(stateDir, 'extensions')),
    directory(join(stateDir, 'state')), directory(join(workspace, 'skills', 'aiworker-task-flow')),
    directory(pluginBackupRoot), directory(taskBackupRoot), directory(officialOpenClaw),
  ])
  await createFakeCommands(bin)
  await file(join(officialOpenClaw, 'package.json'), { name: 'openclaw', version: '2026.7.1-2' })
  await cp(pluginSource, installedPlugin, { recursive: true })
  await directory(join(installedPlugin, 'node_modules'))
  await symlink(officialOpenClaw, join(installedPlugin, 'node_modules', 'openclaw'))
  const v03Config = baseConfig({ profile: 'standard', allow: baseToolIds }, { allowedSenderSha256: senderHash })
  const baselineConfig = baseConfig({ profile: 'standard', allow: baseToolIds })
  const v02Config = baseConfig({ profile: 'full', allow: [...baseToolIds, toolName] })
  await file(join(stateDir, 'openclaw.json'), v03Config)
  await file(databasePath, '')
  await file(`${databasePath}.record.json`, {
    source: 'path', sourcePath: pluginSource, installPath: installedPlugin,
    version: '0.3.0', installedAt: '2026-08-10T01:02:03.000Z',
  })
  await file(join(workspace, 'skills', 'aiworker-task-flow', 'SKILL.md'), 'task-flow 0.3\n')
  await file(join(workspace, 'AGENTS.md'), 'agents 0.3\n')
  await file(join(workspace, 'MEMORY.md'), 'memory 0.3\n')

  const oldWorkspace = join(root, 'old-workspace')
  await directory(join(oldWorkspace, 'skills', 'aiworker-task-flow'))
  await file(join(oldWorkspace, 'skills', 'aiworker-task-flow', 'SKILL.md'), 'task-flow 0.2\n')
  await file(join(oldWorkspace, 'AGENTS.md'), 'agents 0.2\n')
  await file(join(oldWorkspace, 'MEMORY.md'), 'memory 0.2\n')
  const releaseRoot = join(root, 'release')
  const releaseTx = join(releaseRoot, 'rollback-20260810-010203.abcdef')
  await directory(releaseTx)
  await snapshotTaskFlowState({ workspaceRoot: oldWorkspace, destination: join(releaseTx, 'task-current') })
  const taskBackup = join(taskBackupRoot, '20260810-010203.abcdef')
  await rename(join(releaseTx, 'task-current'), taskBackup)

  const pluginBackup = join(pluginBackupRoot, 'upgrade-20260810-010203.abcdef')
  const previousPlugin = join(pluginBackup, 'previous-plugin')
  await directory(previousPlugin)
  await file(join(previousPlugin, 'package.json'), { name: pluginId, version: '0.2.0' })
  await file(join(previousPlugin, 'openclaw.plugin.json'), {
    id: pluginId,
    activation: { onCapabilities: ['hook', 'tool'] },
    contracts: { tools: [toolName] },
  })
  await file(join(previousPlugin, 'index.js'), 'export default {}\n')
  await directory(join(previousPlugin, 'node_modules'))
  await symlink(officialOpenClaw, join(previousPlugin, 'node_modules', 'openclaw'))
  const sourcePluginFingerprint = (await execFileAsync(process.execPath, [
    upgradeValidator, 'payload-fingerprint', pluginSource,
  ])).stdout.trim()
  const previousPluginFingerprint = (await fingerprintAuditedPreviousPlugin(previousPlugin)).fingerprint
  for (const [name, value] of [
    ['.verified', ''],
    ['openclaw-current.json', v02Config],
    ['pre-0.2-openclaw.json', baselineConfig],
    ['pre-0.2-effective-tools.json', effectiveReport('0.3.0')],
    ['current-0.2-effective-tools.json', effectiveReport('0.2.0')],
    ['owner-sender-policy.json', { schemaVersion: 1, ownerCount: 1, allowedSenderSha256: senderHash }],
    ['source-commit.txt', `${targetSha}\n`],
    ['source-plugin-payload-sha256.txt', `${sourcePluginFingerprint}\n`],
    ['previous-plugin-payload-sha256.txt', `${previousPluginFingerprint}\n`],
  ]) await file(join(pluginBackup, name), value)
  await file(join(pluginBackup, 'install-index-old.json'), {
    source: 'path', sourcePath: pluginSource, installPath: installedPlugin,
    version: '0.2.0', installedAt: '2026-08-10T00:00:00.000Z',
  })
  return {
    root, home, bin, stateDir, installedPlugin, workspace,
    pluginBackup, taskBackup,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_OPENCLAW_TARGET: officialOpenClaw,
    },
  }
}

async function runRollback(value, mode, extraEnv = {}) {
  return execFileAsync(rollbackEntry, [
    mode,
    '--plugin-backup', value.pluginBackup,
    '--task-flow-backup', value.taskBackup,
    '--target-sha', targetSha,
  ], { env: { ...value.env, ...extraEnv }, maxBuffer: 4 * 1024 * 1024 })
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(pathname => rm(pathname, { recursive: true, force: true })))
})

describe('release rollback entry', () => {
  it('fails closed on conflicting modes before inspecting production state', async () => {
    await expect(execFileAsync(rollbackEntry, ['--dry-run', '--apply'])).rejects.toMatchObject({ code: 2 })
  })

  it('dry-runs without changing the approved 0.3 state', async () => {
    const value = await fixture()
    const beforeConfig = await readFile(join(value.stateDir, 'openclaw.json'), 'utf8')
    const result = await runRollback(value, '--dry-run')
    expect(result.stdout).toContain('dry run passed')
    expect(JSON.parse(await readFile(join(value.installedPlugin, 'package.json'), 'utf8')).version).toBe('0.3.0')
    expect(await readFile(join(value.stateDir, 'openclaw.json'), 'utf8')).toBe(beforeConfig)
    expect(await readFile(join(value.workspace, 'AGENTS.md'), 'utf8')).toBe('agents 0.3\n')
  }, 30_000)

  it('restores the complete explicit 0.2 release and leaves protected services untouched', async () => {
    const value = await fixture()
    const result = await runRollback(value, '--apply')
    expect(result.stdout).toContain('Restored the explicit 0.2 plugin/config')
    expect(JSON.parse(await readFile(join(value.installedPlugin, 'package.json'), 'utf8')).version).toBe('0.2.0')
    expect(await readFile(join(value.workspace, 'AGENTS.md'), 'utf8')).toBe('agents 0.2\n')
    expect(await readFile(join(value.workspace, 'MEMORY.md'), 'utf8')).toBe('memory 0.2\n')
    await access(join(value.pluginBackup, '.active-rollback-source.json'))
    await expect(access(join(value.pluginBackup, '.verified'))).rejects.toThrow()
  }, 30_000)

  it('restores the complete 0.3 transaction snapshot when a later rollback phase fails', async () => {
    const value = await fixture()
    let failure
    try {
      await runRollback(value, '--apply', {
        AIWORKER_RELEASE_ROLLBACK_TESTING: '1',
        AIWORKER_RELEASE_ROLLBACK_TEST_FAILPOINT: 'after-plugin-install',
      })
    } catch (error) {
      failure = error
    }
    expect(failure?.code, failure?.stderr).toBe(97)
    expect(JSON.parse(await readFile(join(value.installedPlugin, 'package.json'), 'utf8')).version).toBe('0.3.0')
    expect(await readFile(join(value.workspace, 'AGENTS.md'), 'utf8')).toBe('agents 0.3\n')
    expect(await readFile(join(value.workspace, 'MEMORY.md'), 'utf8')).toBe('memory 0.3\n')
    await expect(access(join(value.pluginBackup, '.active-rollback-source.json'))).rejects.toThrow()
    await access(join(value.pluginBackup, '.verified'))
    await expect(access(join(value.workspace, '.aiworker-task-flow-install.lock'))).rejects.toThrow()
  }, 30_000)

  it('keeps the active 0.2 source unverified when rollback-of-rollback validation fails', async () => {
    const value = await fixture()
    let failure
    try {
      await runRollback(value, '--apply', {
        AIWORKER_RELEASE_ROLLBACK_TESTING: '1',
        AIWORKER_RELEASE_ROLLBACK_TEST_FAILPOINT: 'after-plugin-install',
        AIWORKER_RELEASE_ROLLBACK_TEST_RECOVERY_FAILPOINT: 'before-marker-transition',
      })
    } catch (error) {
      failure = error
    }
    expect(failure?.code, failure?.stderr).toBe(70)
    expect(JSON.parse(await readFile(join(value.installedPlugin, 'package.json'), 'utf8')).version).toBe('0.3.0')
    await access(join(value.pluginBackup, '.active-rollback-source.json'))
    await expect(access(join(value.pluginBackup, '.verified'))).rejects.toThrow()
  }, 30_000)

  for (const recoveryFailpoint of [
    'after-verified-before-active-delete',
    'active-delete-failure',
  ]) {
    it(`compensates ${recoveryFailpoint} without leaving active plus verified`, async () => {
      const value = await fixture()
      let failure
      try {
        await runRollback(value, '--apply', {
          AIWORKER_RELEASE_ROLLBACK_TESTING: '1',
          AIWORKER_RELEASE_ROLLBACK_TEST_FAILPOINT: 'after-plugin-install',
          AIWORKER_RELEASE_ROLLBACK_TEST_RECOVERY_FAILPOINT: recoveryFailpoint,
        })
      } catch (error) {
        failure = error
      }
      expect(failure?.code, failure?.stderr).toBe(70)
      const activeMarker = join(value.pluginBackup, '.active-rollback-source.json')
      expect((await stat(activeMarker)).mode & 0o777).toBe(0o600)
      const expectedPluginFingerprint = (await execFileAsync(process.execPath, [
        upgradeValidator,
        'payload-fingerprint',
        join(value.pluginBackup, 'previous-plugin'),
      ])).stdout.trim()
      expect(JSON.parse(await readFile(activeMarker, 'utf8'))).toMatchObject({
        schemaVersion: 1,
        pluginId,
        version: '0.2.0',
        sourcePath: join(value.pluginBackup, 'previous-plugin'),
        pluginFingerprint: expectedPluginFingerprint,
      })
      await expect(access(join(value.pluginBackup, '.verified'))).rejects.toThrow()
    }, 30_000)
  }
})
