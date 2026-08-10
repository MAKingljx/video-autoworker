import { execFile } from 'node:child_process'
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const sourceInstallerPath = resolve(process.cwd(), 'scripts/upgrade-aiworker-video-command-plugin.sh')
const sourceValidatorPath = resolve(process.cwd(), 'scripts/validate-aiworker-video-command-upgrade.mjs')
const sourceCandidatePath = resolve(process.cwd(), 'openclaw-plugins/aiworker-video-command')
const pluginId = 'aiworker-video-command'
const toolName = 'aiworker_analyze_video'
const temporaryRoots = []

async function executable(pathname, content) {
  await writeFile(pathname, content, { mode: 0o755 })
  await chmod(pathname, 0o755)
}

async function writeJson(pathname, value, mode = 0o600) {
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, { mode })
}

async function makeFakeCommands(binDir) {
  await executable(join(binDir, 'id'), '#!/bin/sh\n[ "$1" = "-un" ] && printf "heisenbergs-1\\n"\n')
  await executable(join(binDir, 'hostname'), '#!/bin/sh\nprintf "HEISENBERGS-1deMac-Studio.local\\n"\n')
  await executable(join(binDir, 'git'), `#!/usr/bin/env node
const args = process.argv.slice(2)
const joined = args.join(' ')
if (joined.includes('remote get-url origin')) process.stdout.write('https://github.com/MAKingljx/video-autoworker.git\\n')
else if (joined.includes('status --porcelain')) process.stdout.write('')
else if (joined.includes('rev-parse HEAD')) process.stdout.write('0123456789abcdef0123456789abcdef01234567\\n')
else process.exit(2)
`)
  await executable(join(binDir, 'sqlite3'), `#!/usr/bin/env node
const { existsSync, readFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (args[0] !== '-readonly' || args.length < 3) {
  process.stderr.write('fake sqlite3 permits only -readonly queries\\n')
  process.exit(73)
}
const recordPath = args[1] + '.record.json'
if (!existsSync(recordPath)) process.exit(0)
const records = JSON.parse(readFileSync(recordPath, 'utf8'))
const record = records['${pluginId}']
if (record) process.stdout.write(JSON.stringify(record) + '\\n')
`)
  await executable(join(binDir, 'openclaw'), `#!/usr/bin/env node
const {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} = require('node:fs')
const { join, resolve } = require('node:path')

let args = process.argv.slice(2)
let profile = null
if (args[0] === '--profile') {
  profile = args[1]
  args = args.slice(2)
}
appendFileSync(process.env.FAKE_OPENCLAW_LOG, JSON.stringify({
  args,
  profile,
  openclawHome: process.env.OPENCLAW_HOME ?? null,
  stateOverride: process.env.OPENCLAW_STATE_DIR ?? null,
  configOverride: process.env.OPENCLAW_CONFIG_PATH ?? null,
}) + '\\n')

if (args[0] === '--version') {
  process.stdout.write('OpenClaw 2026.7.1-2 (fake)\\n')
  process.exit(0)
}

const stateDir = profile
  ? join(process.env.HOME, '.openclaw-' + profile)
  : process.env.OPENCLAW_STATE_DIR
const configPath = profile
  ? join(stateDir, 'openclaw.json')
  : process.env.OPENCLAW_CONFIG_PATH
if (!stateDir || !configPath) process.exit(74)
const installDir = join(stateDir, 'extensions', '${pluginId}')
const databasePath = join(stateDir, 'state', 'openclaw.sqlite')
const gatewayRuntimePath = join(stateDir, 'fake-gateway-runtime.json')

function installedVersion() {
  return JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version
}

function updateInstall(source) {
  const absoluteSource = resolve(source)
  const version = JSON.parse(readFileSync(join(absoluteSource, 'package.json'), 'utf8')).version
  mkdirSync(join(stateDir, 'extensions'), { recursive: true })
  mkdirSync(join(stateDir, 'state'), { recursive: true })
  rmSync(installDir, { recursive: true, force: true })
  cpSync(absoluteSource, installDir, { recursive: true })
  writeFileSync(databasePath, '')
  writeFileSync(databasePath + '.record.json', JSON.stringify({
    '${pluginId}': {
      source: 'path',
      sourcePath: absoluteSource,
      installPath: installDir,
      version,
      installedAt: '2026-08-10T01:02:03.000Z',
    },
  }))
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.plugins ??= {}
  config.plugins.allow ??= []
  if (!config.plugins.allow.includes('${pluginId}')) config.plugins.allow.push('${pluginId}')
  config.plugins.entries ??= {}
  config.plugins.entries['${pluginId}'] = { enabled: true }
  config.meta = { ...(config.meta ?? {}), lastTouchedAt: 'fake-install', lastTouchedVersion: '2026.7.1-2' }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\\n', { mode: 0o600 })
  return version
}

if (args[0] === 'config' && args[1] === 'set') {
  if (args.includes('--dry-run')) {
    process.stdout.write('Config dry run passed.\\n')
    process.exit(0)
  }
  const match = /^agents\\.list\\[(\\d+)\\]\\.tools\\.alsoAllow$/u.exec(args[2])
  if (!match) process.exit(75)
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  config.agents.list[Number(match[1])].tools.alsoAllow = JSON.parse(args[3])
  config.meta = { ...(config.meta ?? {}), lastTouchedAt: 'fake-config', lastTouchedVersion: '2026.7.1-2' }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\\n', { mode: 0o600 })
  process.stdout.write('Config updated.\\n')
  process.exit(0)
}

if (args[0] === 'gateway' && args[1] === 'restart') {
  if (!args.includes('--wait') || !args.includes('--json')) process.exit(78)
  const version = installedVersion()
  writeFileSync(gatewayRuntimePath, JSON.stringify({ version }))
  process.stdout.write(JSON.stringify({
    ok: true,
    result: 'restarted',
    service: { loaded: true },
  }) + '\\n')
  process.exit(0)
}

if (args[0] === 'gateway' && args[1] === 'status') {
  if (!args.includes('--deep') || !args.includes('--require-rpc') || !args.includes('--json')) process.exit(79)
  if (!existsSync(gatewayRuntimePath)) process.exit(80)
  process.stdout.write(JSON.stringify({
    service: { loaded: true },
    rpc: { ok: true },
  }) + '\\n')
  process.exit(0)
}

if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'tools.catalog') {
  if (!args.includes('--json') || !args.includes('--timeout')) process.exit(81)
  const paramsIndex = args.indexOf('--params')
  if (paramsIndex < 0) process.exit(82)
  const params = JSON.parse(args[paramsIndex + 1])
  if (params.agentId !== 'second-original' || params.includePlugins !== true) process.exit(83)
  const runtime = JSON.parse(readFileSync(gatewayRuntimePath, 'utf8'))
  if (runtime.version === '0.2.0' && process.env.FAKE_FAIL_LIVE_CATALOG_ONCE === '1') {
    const marker = process.env.FAKE_FAILURE_MARKER
    if (!existsSync(marker)) {
      writeFileSync(marker, 'failed-once\\n')
      process.stderr.write('injected live catalog failure\\n')
      process.exit(23)
    }
  }
  const groups = runtime.version === '0.2.0'
    ? [{
        id: 'plugin:${pluginId}',
        label: '${pluginId}',
        source: 'plugin',
        pluginId: '${pluginId}',
        tools: [{
          id: '${toolName}',
          source: 'plugin',
          pluginId: '${pluginId}',
          optional: true,
          defaultProfiles: [],
        }],
      }]
    : []
  process.stdout.write(JSON.stringify({
    agentId: 'second-original',
    profiles: [],
    groups,
  }) + '\\n')
  process.exit(0)
}

if (args[0] === 'plugins' && args[1] === 'install') {
  if (args[2] !== '--force') process.exit(76)
  const source = args[3]
  const version = updateInstall(source)
  if (profile === 'qwen-current' && version === '0.2.0' && process.env.FAKE_FAIL_CANDIDATE_ONCE === '1') {
    const marker = process.env.FAKE_FAILURE_MARKER
    if (!existsSync(marker)) {
      writeFileSync(marker, 'failed-once\\n')
      process.stderr.write('injected candidate failure\\n')
      process.exit(19)
    }
  }
  process.stdout.write('Installed.\\n')
  process.exit(0)
}

if (args[0] === 'plugins' && args[1] === 'inspect' && args.includes('--runtime')) {
  const version = installedVersion()
  const isNew = version === '0.2.0'
  process.stdout.write(JSON.stringify({
    plugin: { id: '${pluginId}', status: 'loaded', version },
    typedHooks: isNew
      ? [{ name: 'before_dispatch' }, { name: 'before_prompt_build' }, { name: 'before_tool_call' }]
      : [{ name: 'before_dispatch' }],
    tools: isNew ? [{ names: ['${toolName}'], optional: true }] : [],
    diagnostics: [],
  }) + '\\n')
  process.exit(0)
}

if (args[0] === 'plugins' && args[1] === 'doctor') {
  const version = installedVersion()
  if (version === '0.1.0') {
    process.stdout.write([
      'Compatibility:',
      '- ${pluginId} is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet. [info]',
      'Docs: https://docs.openclaw.ai/plugin',
      '',
    ].join('\\n'))
  } else {
    process.stdout.write('No plugin issues detected.\\n')
  }
  process.exit(0)
}

process.stderr.write('unsupported fake openclaw command: ' + args.join(' ') + '\\n')
process.exit(77)
`)
}

function baseConfig() {
  return {
    meta: { stable: true, lastTouchedAt: 'before' },
    tools: { profile: 'coding' },
    agents: {
      list: [
        { id: 'main', tools: { allow: ['read'] } },
        { id: 'second-original', tools: { allow: ['read', 'exec'] } },
      ],
    },
    plugins: {
      allow: ['telegram', pluginId],
      entries: { [pluginId]: { enabled: true } },
    },
  }
}

async function setupFixture() {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-upgrade-test-'))
  temporaryRoots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const qwenState = join(home, '.openclaw-qwen-current')
  const qwenConfig = join(qwenState, 'openclaw.json')
  const qwenDatabase = join(qwenState, 'state', 'openclaw.sqlite')
  const installed = join(qwenState, 'extensions', pluginId)
  const log = join(root, 'openclaw.jsonl')
  const isolatedRepo = join(root, 'repo')
  const installerPath = join(isolatedRepo, 'scripts', 'upgrade-aiworker-video-command-plugin.sh')
  const candidatePath = join(isolatedRepo, 'openclaw-plugins', pluginId)
  await mkdir(bin, { recursive: true, mode: 0o700 })
  await mkdir(join(isolatedRepo, 'scripts'), { recursive: true, mode: 0o700 })
  await mkdir(join(isolatedRepo, 'openclaw-plugins'), { recursive: true, mode: 0o700 })
  await cp(sourceInstallerPath, installerPath)
  await cp(sourceValidatorPath, join(isolatedRepo, 'scripts', 'validate-aiworker-video-command-upgrade.mjs'))
  await cp(sourceCandidatePath, candidatePath, { recursive: true })
  const canonicalCandidatePath = await realpath(candidatePath)
  await mkdir(join(qwenState, 'state'), { recursive: true, mode: 0o700 })
  await mkdir(installed, { recursive: true, mode: 0o700 })
  await makeFakeCommands(bin)
  await writeJson(qwenConfig, baseConfig())
  await writeFile(qwenDatabase, '')
  await writeJson(join(installed, 'package.json'), {
    name: '@aiworker/openclaw-aiworker-video-command',
    version: '0.1.0',
  })
  await writeJson(join(installed, 'openclaw.plugin.json'), {
    id: pluginId,
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  })
  await writeFile(join(installed, 'index.js'), 'export default {}\n')
  await writeJson(`${qwenDatabase}.record.json`, {
    [pluginId]: {
      source: 'path',
      sourcePath: canonicalCandidatePath,
      installPath: installed,
      version: '0.1.0',
      installedAt: '2026-08-09T01:02:03.000Z',
    },
  })

  for (const suffix of ['', '-gpt-main', '-qwen-weixin-new']) {
    const state = join(home, `.openclaw${suffix}`)
    await mkdir(join(state, 'state'), { recursive: true, mode: 0o700 })
    await writeJson(join(state, 'openclaw.json'), {
      agents: { list: [{ id: 'other', tools: { allow: ['read'] } }] },
      plugins: { allow: ['other-plugin'], entries: {} },
    })
    await writeFile(join(state, 'state', 'openclaw.sqlite'), '')
    await writeJson(join(state, 'state', 'openclaw.sqlite.record.json'), {})
  }
  await writeFile(log, '')

  return {
    root,
    candidatePath: canonicalCandidatePath,
    installerPath,
    home,
    bin,
    qwenConfig,
    qwenDatabase,
    installed,
    log,
    backupRoot: join(home, 'ai-worker', 'backups', pluginId),
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_OPENCLAW_LOG: log,
      OPENCLAW_PROFILE: 'redirected-profile',
      OPENCLAW_STATE_DIR: join(root, 'redirected-state'),
      OPENCLAW_CONFIG_PATH: join(root, 'redirected-config.json'),
      OPENCLAW_HOME: join(root, 'redirected-home'),
      OPENCLAW_INCLUDE_ROOTS: join(root, 'redirected-includes'),
    },
  }
}

async function runInstaller(fixture, mode, extraEnv = {}) {
  return execFileAsync('/bin/bash', [fixture.installerPath, mode], {
    cwd: process.cwd(),
    env: { ...fixture.env, ...extraEnv },
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  })
}

async function readLog(pathname) {
  return (await readFile(pathname, 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line))
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(pathname => rm(pathname, { recursive: true, force: true })))
})

describe('controlled video-command plugin upgrade installer', () => {
  it('dry-runs an isolated official 0.1.0 to 0.2.0 force upgrade without touching qwen-current', async () => {
    const fixture = await setupFixture()
    const configBefore = await readFile(fixture.qwenConfig)
    const pluginBefore = await readFile(join(fixture.installed, 'package.json'))
    const indexBefore = await readFile(`${fixture.qwenDatabase}.record.json`)

    const { stdout } = await runInstaller(fixture, '--dry-run')

    expect(stdout).toContain('Dry run passed the controlled 0.1.0 to 0.2.0 upgrade checks.')
    expect(await readFile(fixture.qwenConfig)).toEqual(configBefore)
    expect(await readFile(join(fixture.installed, 'package.json'))).toEqual(pluginBefore)
    expect(await readFile(`${fixture.qwenDatabase}.record.json`)).toEqual(indexBefore)
    await expect(stat(fixture.backupRoot)).rejects.toMatchObject({ code: 'ENOENT' })

    const calls = await readLog(fixture.log)
    const qwenInstalls = calls.filter(call => call.profile === 'qwen-current'
      && call.args[0] === 'plugins' && call.args[1] === 'install')
    expect(qwenInstalls).toHaveLength(0)
    expect(calls.some(call => call.args[0] === 'gateway')).toBe(false)
    const isolatedInstalls = calls.filter(call => call.profile === null
      && call.args[0] === 'plugins' && call.args[1] === 'install')
    expect(isolatedInstalls).toHaveLength(2)
  }, 30_000)

  it('applies exactly one optional-tool grant and one official production force install', async () => {
    const fixture = await setupFixture()
    const before = JSON.parse(await readFile(fixture.qwenConfig, 'utf8'))

    const { stdout } = await runInstaller(fixture, '--apply')

    expect(stdout).toContain(`Only ${toolName} was appended`)
    expect(stdout).toContain('Only qwen-current was restarted through the official Gateway service command.')
    expect(stdout).toContain(`The live Gateway RPC proved the 0.2.0-only ${toolName} tool`)
    expect(stdout).toContain('No production AI-worker task was submitted.')
    const after = JSON.parse(await readFile(fixture.qwenConfig, 'utf8'))
    expect(after.agents.list[1].tools.allow).toEqual(before.agents.list[1].tools.allow)
    expect(after.agents.list[1].tools.alsoAllow).toEqual([toolName])
    expect(after.agents.list[0]).toEqual(before.agents.list[0])
    expect(JSON.parse(await readFile(join(fixture.installed, 'package.json'), 'utf8')).version).toBe('0.2.0')

    const backups = (await readdir(fixture.backupRoot)).filter(name => name.startsWith('upgrade-'))
    expect(backups).toHaveLength(1)
    const backupDir = join(fixture.backupRoot, backups[0])
    expect((await stat(backupDir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(backupDir, 'openclaw.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(backupDir, '.verified'))).mode & 0o777).toBe(0o600)

    const calls = await readLog(fixture.log)
    const qwenCalls = calls.filter(call => call.profile === 'qwen-current')
    expect(qwenCalls.every(call => call.openclawHome === null
      && call.stateOverride === null && call.configOverride === null)).toBe(true)
    const qwenInstalls = qwenCalls.filter(call => call.args[0] === 'plugins' && call.args[1] === 'install')
    expect(qwenInstalls).toHaveLength(1)
    expect(qwenInstalls[0].args.slice(0, 3)).toEqual(['plugins', 'install', '--force'])
    expect(qwenCalls.filter(call => call.args[0] === 'gateway' && call.args[1] === 'restart')).toHaveLength(1)
    expect(qwenCalls.filter(call => call.args[0] === 'gateway' && call.args[1] === 'status')).toHaveLength(1)
    expect(qwenCalls.filter(call => call.args[0] === 'gateway'
      && call.args[1] === 'call' && call.args[2] === 'tools.catalog')).toHaveLength(1)
    expect(calls.some(call => call.args[0] === 'plugins' && call.args[1] === 'update')).toBe(false)
  }, 30_000)

  it('rolls back and refreshes the old live Gateway when the new live catalog probe fails', async () => {
    const fixture = await setupFixture()
    const configBefore = await readFile(fixture.qwenConfig)
    const failureMarker = join(fixture.root, 'candidate-failed-once')

    let injectedFailure
    try {
      await runInstaller(fixture, '--apply', {
        FAKE_FAIL_LIVE_CATALOG_ONCE: '1',
        FAKE_FAILURE_MARKER: failureMarker,
      })
    } catch (error) {
      injectedFailure = error
    }
    expect(injectedFailure).toMatchObject({ code: 1 })

    expect(await readFile(fixture.qwenConfig)).toEqual(configBefore)
    expect(JSON.parse(await readFile(join(fixture.installed, 'package.json'), 'utf8')).version).toBe('0.1.0')
    const record = JSON.parse(await readFile(`${fixture.qwenDatabase}.record.json`, 'utf8'))[pluginId]
    expect(record.version).toBe('0.1.0')
    expect(basename(record.sourcePath)).toBe('previous-plugin')

    const failedBackups = (await readdir(fixture.backupRoot)).filter(name => name.startsWith('upgrade-'))
    expect(failedBackups).toHaveLength(1)
    const activeBackup = join(fixture.backupRoot, failedBackups[0])
    const activeMarker = join(activeBackup, '.active-rollback-source.json')
    expect((await stat(activeMarker)).mode & 0o777).toBe(0o600)
    const marker = JSON.parse(await readFile(activeMarker, 'utf8'))
    expect(marker).toMatchObject({
      schemaVersion: 1,
      pluginId,
      version: '0.1.0',
      sourcePath: join(activeBackup, 'previous-plugin'),
    })
    expect(marker.pluginFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    await expect(stat(join(activeBackup, '.verified')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(fixture.backupRoot, '.qwen-current-first-install.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' })

    const dryRun = await runInstaller(fixture, '--dry-run')
    expect(dryRun.stdout).toContain('Dry run passed the controlled 0.1.0 to 0.2.0 upgrade checks.')
    const retry = await runInstaller(fixture, '--apply')
    expect(retry.stdout).toContain('Upgraded aiworker-video-command from 0.1.0 to 0.2.0')
    expect(JSON.parse(await readFile(join(fixture.installed, 'package.json'), 'utf8')).version).toBe('0.2.0')
    const finalRecord = JSON.parse(await readFile(`${fixture.qwenDatabase}.record.json`, 'utf8'))[pluginId]
    expect(finalRecord.version).toBe('0.2.0')
    expect(finalRecord.sourcePath).toBe(fixture.candidatePath)

    const calls = await readLog(fixture.log)
    const qwenInstalls = calls.filter(call => call.profile === 'qwen-current'
      && call.args[0] === 'plugins' && call.args[1] === 'install')
    expect(qwenInstalls).toHaveLength(3)
    expect(qwenInstalls.every(call => call.args[2] === '--force')).toBe(true)
    const qwenRestarts = calls.filter(call => call.profile === 'qwen-current'
      && call.args[0] === 'gateway' && call.args[1] === 'restart')
    expect(qwenRestarts).toHaveLength(3)
    expect(qwenRestarts.every(call => call.args.includes('--wait') && call.args.includes('--json'))).toBe(true)
    const qwenCatalogs = calls.filter(call => call.profile === 'qwen-current'
      && call.args[0] === 'gateway' && call.args[1] === 'call'
      && call.args[2] === 'tools.catalog')
    expect(qwenCatalogs).toHaveLength(3)
  }, 60_000)
})
