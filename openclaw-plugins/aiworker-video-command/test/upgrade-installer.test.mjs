import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const sourceInstallerPath = resolve(process.cwd(), 'scripts/upgrade-aiworker-video-command-plugin.sh')
const sourceValidatorPath = resolve(process.cwd(), 'scripts/validate-aiworker-video-command-upgrade.mjs')
const sourcePolicyPath = resolve(process.cwd(), 'scripts/lib/aiworker-video-command-upgrade-policy.mjs')
const sourceReleaseRollbackValidatorPath = resolve(process.cwd(), 'scripts/validate-aiworker-video-release-rollback.mjs')
const sourceReleaseRollbackPolicyPath = resolve(process.cwd(), 'scripts/lib/aiworker-video-release-rollback-policy.mjs')
const sourceCandidatePath = resolve(process.cwd(), 'openclaw-plugins/aiworker-video-command')
const pluginId = 'aiworker-video-command'
const toolName = 'aiworker_analyze_video'
const targetSha = '0123456789abcdef0123456789abcdef01234567'
const telegramOwnerId = '123456789'
const allowedSenderSha256 = createHash('sha256')
  .update('aiworker-video-command:telegram-sender:v1\0')
  .update(telegramOwnerId)
  .digest('hex')
const temporaryRoots = []

async function executable(pathname, content) {
  await writeFile(pathname, content, { mode: 0o755 })
  await chmod(pathname, 0o755)
}

async function writeJson(pathname, value, mode = 0o600) {
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, { mode })
}

async function makeFakeCommands(binDir) {
  // Keep the fake command environment independent from HOME. On production,
  // `node` is reached through a HOME-aware launcher, while process.execPath is
  // the already-resolved Node 22 executable running this test process.
  await symlink(process.execPath, join(binDir, 'node'))
  await executable(join(binDir, 'id'), '#!/bin/sh\n[ "$1" = "-un" ] && printf "heisenbergs-1\\n"\n')
  await executable(join(binDir, 'hostname'), '#!/bin/sh\nprintf "HEISENBERGS-1deMac-Studio.local\\n"\n')
  await executable(join(binDir, 'git'), `#!/usr/bin/env node
const { existsSync } = require('node:fs')
const args = process.argv.slice(2)
const joined = args.join(' ')
const driftMarker = process.env.FAKE_GIT_DRIFT_MARKER
const drifted = Boolean(driftMarker && existsSync(driftMarker))
const head = drifted
  ? 'ffffffffffffffffffffffffffffffffffffffff'
  : (process.env.FAKE_GIT_HEAD || '${targetSha}')
const originMain = process.env.FAKE_GIT_ORIGIN_MAIN || '${targetSha}'
const remoteMain = process.env.FAKE_GIT_REMOTE_MAIN || '${targetSha}'
if (joined.includes('remote get-url origin')) process.stdout.write('https://github.com/MAKingljx/video-autoworker.git\\n')
else if (joined.includes('status --porcelain')) process.stdout.write(process.env.FAKE_GIT_DIRTY || '')
else if (joined.includes('ls-remote') && joined.includes('refs/heads/main')) process.stdout.write(remoteMain + '\\trefs/heads/main\\n')
else if (joined.includes('rev-parse') && joined.includes('refs/remotes/origin/main')) process.stdout.write(originMain + '\\n')
else if (joined.includes('rev-parse') && joined.includes('HEAD')) process.stdout.write(head + '\\n')
else process.exit(2)
`)
  await executable(join(binDir, 'sqlite3'), `#!/usr/bin/env node
const { appendFileSync, existsSync, readFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (process.env.FAKE_SQLITE_LOG) {
  appendFileSync(process.env.FAKE_SQLITE_LOG, JSON.stringify({ args }) + '\\n')
}
const readOnly = args[0] === '-readonly'
const databasePath = readOnly ? args[1] : args[0]
const query = readOnly ? args[2] : args[1]
if (!databasePath || !query) {
  process.stderr.write('fake sqlite3 received an incomplete invocation\\n')
  process.exit(73)
}
const readinessPath = databasePath + '.readonly-ready'
const isolatedDatabase = databasePath.includes('/aiworker-video-command-upgrade.')
if (!readOnly) {
  if (!isolatedDatabase || !query.includes('PRAGMA query_only') || !query.includes('sqlite_schema')) {
    process.stderr.write('fake sqlite3 permits writable opens only for isolated query-only warmup\\n')
    process.exit(74)
  }
  writeFileSync(readinessPath, '')
  process.exit(0)
}
if (isolatedDatabase && !existsSync(readinessPath)) {
  process.stderr.write('Error: in prepare, unable to open database file (14)\\n')
  process.exit(14)
}
const recordPath = databasePath + '.record.json'
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
  symlinkSync,
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
  rmSync(join(installDir, 'node_modules'), { recursive: true, force: true })
  mkdirSync(join(installDir, 'node_modules'), { recursive: true })
  symlinkSync(process.env.FAKE_OPENCLAW_PEER_TARGET, join(installDir, 'node_modules', 'openclaw'), 'dir')
  if (profile === 'qwen-current' && version === '0.3.0'
    && process.env.FAKE_EXTRA_NODE_MODULE === '1') {
    writeFileSync(join(installDir, 'node_modules', 'unexpected.txt'), 'unexpected\\n')
  }
  writeFileSync(databasePath, '')
  rmSync(databasePath + '.readonly-ready', { force: true })
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
  const toolsMatch = /^agents\\.list\\[(\\d+)\\]\\.tools$/u.exec(args[2])
  const senderHashPath = 'plugins.entries.${pluginId}.config.allowedSenderSha256'
  if (!toolsMatch && args[2] !== senderHashPath) process.exit(75)
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  if (toolsMatch) {
    config.agents.list[Number(toolsMatch[1])].tools = JSON.parse(args[3])
    if (profile === 'qwen-current'
      && process.env.FAKE_GIT_DRIFT_ON_TOOLS_CONFIG === '1'
      && process.env.FAKE_GIT_DRIFT_MARKER) {
      writeFileSync(process.env.FAKE_GIT_DRIFT_MARKER, 'drifted\\n')
    }
  } else {
    const senderHash = JSON.parse(args[3])
    if (!/^[a-f0-9]{64}$/u.test(senderHash)) process.exit(76)
    config.plugins.entries['${pluginId}'].config = { allowedSenderSha256: senderHash }
  }
  config.meta = { ...(config.meta ?? {}), lastTouchedAt: 'fake-config', lastTouchedVersion: '2026.7.1-2' }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\\n', { mode: 0o600 })
  process.stdout.write('Config updated.\\n')
  process.exit(0)
}

if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'sessions.list') {
  const paramsIndex = args.indexOf('--params')
  if (paramsIndex < 0) process.exit(82)
  const params = JSON.parse(args[paramsIndex + 1])
  if (params.agentId !== 'second-original'
    || params.search !== 'telegram:direct:'
    || params.configuredAgentsOnly !== true
    || params.includeGlobal !== false
    || params.limit !== 200) process.exit(83)
  process.stdout.write(JSON.stringify({
    count: 1,
    hasMore: false,
    nextOffset: null,
    totalCount: 1,
    sessions: [{ key: 'agent:second-original:telegram:direct:owner' }],
  }) + '\\n')
  process.exit(0)
}

if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'tools.effective') {
  const paramsIndex = args.indexOf('--params')
  if (paramsIndex < 0) process.exit(84)
  const params = JSON.parse(args[paramsIndex + 1])
  if (params.agentId !== 'second-original'
    || params.sessionKey !== 'agent:second-original:telegram:direct:owner') process.exit(85)
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const target = config.agents.list.find(agent => agent.id === 'second-original')
  const baseIds = ['apply_patch', 'edit', 'exec', 'memory_get', 'memory_search', 'process', 'read', 'web_fetch', 'web_search', 'write']
  const installed = installedVersion()
  let ids = [...baseIds]
  if (installed === '0.2.0' && target.tools.allow.includes('${toolName}')) ids.push('${toolName}')
  if (installed === '0.3.0' && process.env.FAKE_EFFECTIVE_EXTRA_TOOL === '1') ids.push('image')
  process.stdout.write(JSON.stringify({
    agentId: 'second-original',
    profile: target.tools.profile ?? config.tools.profile,
    groups: [{ id: 'core', label: 'Core', source: 'core', tools: ids.map(id => ({ id })) }],
  }) + '\\n')
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
  if (runtime.version === '0.3.0' && process.env.FAKE_FAIL_LIVE_CATALOG_ONCE === '1') {
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
  if (profile === 'qwen-current' && version === '0.3.0'
    && process.env.FAKE_TAMPER_INSTALLED_PAYLOAD === '1') {
    writeFileSync(join(installDir, 'tampered-after-install.txt'), 'unexpected\\n')
  }
  if (profile === 'qwen-current' && version === '0.3.0' && process.env.FAKE_FAIL_CANDIDATE_ONCE === '1') {
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
  const isV02 = version === '0.2.0'
  process.stdout.write(JSON.stringify({
    plugin: { id: '${pluginId}', status: 'loaded', version },
    typedHooks: isV02
      ? [{ name: 'before_dispatch' }, { name: 'before_prompt_build' }, { name: 'before_tool_call' }]
      : [{ name: 'before_dispatch' }],
    tools: isV02 ? [{ names: ['${toolName}'], optional: true }] : [],
    diagnostics: [],
  }) + '\\n')
  process.exit(0)
}

if (args[0] === 'plugins' && args[1] === 'doctor') {
  const version = installedVersion()
  if (version === '0.3.0') {
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

function baselineConfig() {
  return {
    meta: { stable: true, lastTouchedAt: 'before' },
    tools: { profile: 'coding' },
    agents: {
      list: [
        { id: 'main', tools: { allow: ['read'] } },
        { id: 'second-original', tools: {
          allow: ['apply_patch', 'edit', 'exec', 'image', 'memory_get', 'memory_search', 'process', 'read', 'web_fetch', 'web_search', 'write'],
          loopDetection: { enabled: true },
        } },
      ],
    },
    plugins: {
      allow: ['telegram', pluginId],
      entries: { [pluginId]: { enabled: true } },
    },
    commands: { ownerAllowFrom: [`telegram:${telegramOwnerId}`] },
    channels: { telegram: { dmPolicy: 'pairing' } },
    bindings: [{ agentId: 'second-original', match: { channel: 'telegram' } }],
  }
}

function v02Config() {
  const config = baselineConfig()
  config.meta.lastTouchedAt = 'after-v02'
  config.agents.list[1].tools = {
    allow: ['apply_patch', 'edit', 'exec', 'memory_get', 'memory_search', 'process', 'read', 'web_fetch', 'web_search', 'write', toolName],
    loopDetection: { enabled: true },
    profile: 'full',
  }
  return config
}

function effectiveReport(profile, ids) {
  return {
    agentId: 'second-original',
    profile,
    groups: [{ id: 'core', source: 'core', tools: ids.map(id => ({ id })) }],
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
  const openclawPeerTarget = join(root, 'official-openclaw-peer')
  const log = join(root, 'openclaw.jsonl')
  const sqliteLog = join(root, 'sqlite.jsonl')
  const isolatedRepo = join(root, 'repo')
  const installerPath = join(isolatedRepo, 'scripts', 'upgrade-aiworker-video-command-plugin.sh')
  const candidatePath = join(isolatedRepo, 'openclaw-plugins', pluginId)
  await mkdir(bin, { recursive: true, mode: 0o700 })
  await mkdir(join(isolatedRepo, 'scripts'), { recursive: true, mode: 0o700 })
  await mkdir(join(isolatedRepo, 'scripts', 'lib'), { recursive: true, mode: 0o700 })
  await mkdir(join(isolatedRepo, 'openclaw-plugins'), { recursive: true, mode: 0o700 })
  await cp(sourceInstallerPath, installerPath)
  await cp(sourceValidatorPath, join(isolatedRepo, 'scripts', 'validate-aiworker-video-command-upgrade.mjs'))
  await cp(sourcePolicyPath, join(isolatedRepo, 'scripts', 'lib', 'aiworker-video-command-upgrade-policy.mjs'))
  await cp(sourceReleaseRollbackValidatorPath, join(isolatedRepo, 'scripts', 'validate-aiworker-video-release-rollback.mjs'))
  await cp(sourceReleaseRollbackPolicyPath, join(isolatedRepo, 'scripts', 'lib', 'aiworker-video-release-rollback-policy.mjs'))
  await cp(sourceCandidatePath, candidatePath, { recursive: true })
  const canonicalCandidatePath = await realpath(candidatePath)
  await mkdir(join(qwenState, 'state'), { recursive: true, mode: 0o700 })
  await mkdir(installed, { recursive: true, mode: 0o700 })
  await mkdir(openclawPeerTarget, { mode: 0o700 })
  await makeFakeCommands(bin)
  await writeJson(qwenConfig, v02Config())
  await writeFile(qwenDatabase, '')
  await writeJson(join(installed, 'package.json'), {
    name: '@aiworker/openclaw-aiworker-video-command',
    version: '0.2.0',
  })
  await writeJson(join(installed, 'openclaw.plugin.json'), {
    id: pluginId,
    activation: { onStartup: true, onCapabilities: ['hook', 'tool'] },
    contracts: { tools: [toolName] },
    toolMetadata: { [toolName]: { optional: true } },
    configSchema: { type: 'object', additionalProperties: false, properties: {} },
  })
  await writeFile(join(installed, 'index.js'), 'export default {}\n')
  await mkdir(join(installed, 'node_modules'))
  await symlink(openclawPeerTarget, join(installed, 'node_modules', 'openclaw'), 'dir')
  await writeJson(join(qwenState, 'fake-gateway-runtime.json'), { version: '0.2.0' })
  await writeJson(`${qwenDatabase}.record.json`, {
    [pluginId]: {
      source: 'path',
      sourcePath: canonicalCandidatePath,
      installPath: installed,
      version: '0.2.0',
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
  await writeFile(sqliteLog, '')

  const backupRoot = join(home, 'ai-worker', 'backups', pluginId)
  const verifiedFirstInstallBackup = join(backupRoot, '20260809-010203.seed01')
  const verifiedV02Backup = join(backupRoot, 'upgrade-20260810-010203.seed02')
  const verifiedReports = join(verifiedV02Backup, 'reports')
  const verifiedLive = join(verifiedReports, 'live-gateway')
  const verifiedPrevious = join(verifiedV02Backup, 'previous-plugin')
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  await mkdir(verifiedFirstInstallBackup, { mode: 0o700 })
  await writeFile(join(verifiedFirstInstallBackup, '.verified'), '', { mode: 0o600 })
  await mkdir(verifiedV02Backup, { mode: 0o700 })
  await mkdir(verifiedLive, { recursive: true, mode: 0o700 })
  await mkdir(verifiedPrevious, { mode: 0o700 })
  await writeFile(join(verifiedV02Backup, '.verified'), '', { mode: 0o600 })
  await writeJson(join(verifiedV02Backup, 'openclaw.json'), baselineConfig())
  const baseIds = ['apply_patch', 'edit', 'exec', 'memory_get', 'memory_search', 'process', 'read', 'web_fetch', 'web_search', 'write']
  await writeJson(join(verifiedReports, 'live-tools-effective-baseline.json'), effectiveReport('coding', baseIds))
  await writeJson(join(verifiedLive, 'live-tools-effective.json'), effectiveReport('full', [...baseIds, toolName]))
  await writeJson(join(verifiedReports, 'final-index.json'), {
    source: 'path',
    sourcePath: canonicalCandidatePath,
    installPath: installed,
    version: '0.2.0',
    installedAt: '2026-08-10T01:02:03.000Z',
  })
  await writeJson(join(verifiedPrevious, 'package.json'), { version: '0.1.0' }, 0o644)
  await writeJson(join(verifiedPrevious, 'openclaw.plugin.json'), { id: pluginId }, 0o644)

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
    sqliteLog,
    backupRoot,
    verifiedFirstInstallBackup,
    verifiedV02Backup,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_OPENCLAW_LOG: log,
      FAKE_SQLITE_LOG: sqliteLog,
      FAKE_OPENCLAW_PEER_TARGET: openclawPeerTarget,
      OPENCLAW_PROFILE: 'redirected-profile',
      OPENCLAW_STATE_DIR: join(root, 'redirected-state'),
      OPENCLAW_CONFIG_PATH: join(root, 'redirected-config.json'),
      OPENCLAW_HOME: join(root, 'redirected-home'),
      OPENCLAW_INCLUDE_ROOTS: join(root, 'redirected-includes'),
    },
  }
}

async function runInstaller(fixture, mode, extraEnv = {}, approvedSha = targetSha) {
  const args = [fixture.installerPath, mode]
  if (approvedSha !== null) args.push('--target-sha', approvedSha)
  return execFileAsync('/bin/bash', args, {
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
  it('requires an explicit target SHA and pins it to origin/main', async () => {
    const fixture = await setupFixture()
    await expect(runInstaller(fixture, '--dry-run', {}, null)).rejects.toMatchObject({ code: 2 })
    await expect(runInstaller(fixture, '--dry-run', {
      FAKE_GIT_REMOTE_MAIN: '1111111111111111111111111111111111111111',
    })).rejects.toMatchObject({ code: 1 })
    expect((await readLog(fixture.log)).filter(call =>
      call.args[0] === 'plugins' && call.args[1] === 'install')).toHaveLength(0)
  })

  it('dry-runs an isolated official 0.2.0 to 0.3.0 force upgrade without touching qwen-current', async () => {
    const fixture = await setupFixture()
    const configBefore = await readFile(fixture.qwenConfig)
    const pluginBefore = await readFile(join(fixture.installed, 'package.json'))
    const indexBefore = await readFile(`${fixture.qwenDatabase}.record.json`)
    const backupsBefore = await readdir(fixture.backupRoot)

    const { stdout } = await runInstaller(fixture, '--dry-run')

    expect(stdout).toContain('Dry run passed the controlled 0.2.0 to 0.3.0 upgrade checks.')
    expect(await readFile(fixture.qwenConfig)).toEqual(configBefore)
    expect(await readFile(join(fixture.installed, 'package.json'))).toEqual(pluginBefore)
    expect(await readFile(`${fixture.qwenDatabase}.record.json`)).toEqual(indexBefore)
    expect(await readdir(fixture.backupRoot)).toEqual(backupsBefore)

    const calls = await readLog(fixture.log)
    const qwenInstalls = calls.filter(call => call.profile === 'qwen-current'
      && call.args[0] === 'plugins' && call.args[1] === 'install')
    expect(qwenInstalls).toHaveLength(0)
    expect(calls.some(call => call.profile === 'qwen-current'
      && call.args[0] === 'gateway' && call.args[1] === 'restart')).toBe(false)
    expect(calls.some(call => call.profile === 'qwen-current'
      && call.args[0] === 'gateway' && call.args[1] === 'call'
      && call.args[2] === 'tools.catalog')).toBe(false)
    expect(calls.some(call => call.profile === 'qwen-current'
      && call.args[0] === 'gateway' && call.args[1] === 'call'
      && call.args[2] === 'tools.effective')).toBe(true)
    const isolatedInstalls = calls.filter(call => call.profile === null
      && call.args[0] === 'plugins' && call.args[1] === 'install')
    expect(isolatedInstalls).toHaveLength(2)
    const sqliteCalls = await readLog(fixture.sqliteLog)
    const writableSqliteCalls = sqliteCalls.filter(call => call.args[0] !== '-readonly')
    expect(writableSqliteCalls).toHaveLength(2)
    expect(writableSqliteCalls.every(call => call.args[0].includes('/aiworker-video-command-upgrade.')
      && call.args[1].includes('PRAGMA query_only')
      && call.args[1].includes('sqlite_schema'))).toBe(true)
    expect(sqliteCalls.filter(call => call.args[0] === '-readonly').length).toBeGreaterThan(2)
  }, 30_000)

  it('restores the complete pre-0.2 tools object and deploys hook-only 0.3 with live proof', async () => {
    const fixture = await setupFixture()

    const { stdout } = await runInstaller(fixture, '--apply')

    expect(stdout).toContain('complete pre-0.2 second-original tools object was restored')
    expect(stdout).toContain('Only qwen-current was restarted through the official Gateway service command.')
    expect(stdout).toContain('Runtime inspection proved only before_dispatch and no plugin tool contract.')
    expect(stdout).toContain(`live Gateway catalog omits ${toolName}`)
    expect(stdout).toContain('No production AI-worker task was submitted.')
    const after = JSON.parse(await readFile(fixture.qwenConfig, 'utf8'))
    expect(after.agents.list[1].tools).toEqual(baselineConfig().agents.list[1].tools)
    expect(after.agents.list[1].tools.allow).toContain('image')
    expect(after.agents.list[1].tools.allow).not.toContain(toolName)
    expect(after.agents.list[1].tools.profile).toBeUndefined()
    expect(after.agents.list[1].tools.alsoAllow).toBeUndefined()
    expect(after.plugins.entries[pluginId].config).toEqual({ allowedSenderSha256 })
    expect(JSON.parse(await readFile(join(fixture.installed, 'package.json'), 'utf8')).version).toBe('0.3.0')

    const backups = (await readdir(fixture.backupRoot)).filter(name => name.startsWith('upgrade-'))
    expect(backups).toHaveLength(2)
    const backupDir = join(fixture.backupRoot, backups.find(name => name !== basename(fixture.verifiedV02Backup)))
    expect((await stat(backupDir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(backupDir, 'openclaw-current.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(backupDir, 'pre-0.2-openclaw.json'))).mode & 0o777).toBe(0o600)
    expect((await stat(join(backupDir, 'owner-sender-policy.json'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(backupDir, 'source-commit.txt'), 'utf8')).toBe(`${targetSha}\n`)
    expect(await readFile(join(backupDir, 'previous-plugin-payload-sha256.txt'), 'utf8'))
      .toMatch(/^[a-f0-9]{64}\n$/u)
    expect((await stat(join(backupDir, 'previous-plugin-payload-sha256.txt'))).mode & 0o777).toBe(0o600)
    const payloadEvidence = JSON.parse(await readFile(
      join(backupDir, 'reports', 'installed-payload.json'),
      'utf8',
    ))
    expect(payloadEvidence.sourceFingerprint).toBe(payloadEvidence.expectedFingerprint)
    expect(payloadEvidence.installedFingerprint).toBe(payloadEvidence.expectedFingerprint)
    expect((await stat(join(backupDir, '.verified'))).mode & 0o777).toBe(0o600)
    await expect(stat(fixture.verifiedFirstInstallBackup)).rejects.toMatchObject({ code: 'ENOENT' })
    const retention = JSON.parse(await readFile(join(backupDir, 'reports', 'backup-retention.json'), 'utf8'))
    expect(retention).toMatchObject({
      schemaVersion: 1,
      maxBackups: 2,
      removed: [basename(fixture.verifiedFirstInstallBackup)],
    })
    const ownerEvidence = await readFile(join(backupDir, 'owner-sender-policy.json'), 'utf8')
    expect(JSON.parse(ownerEvidence)).toEqual({
      schemaVersion: 1,
      ownerCount: 1,
      allowedSenderSha256,
    })
    expect(ownerEvidence).not.toContain(telegramOwnerId)

    const calls = await readLog(fixture.log)
    const qwenCalls = calls.filter(call => call.profile === 'qwen-current')
    expect(qwenCalls.every(call => call.openclawHome === null
      && call.stateOverride === null && call.configOverride === null)).toBe(true)
    const qwenInstalls = qwenCalls.filter(call => call.args[0] === 'plugins' && call.args[1] === 'install')
    expect(qwenInstalls).toHaveLength(1)
    expect(qwenInstalls[0].args.slice(0, 3)).toEqual(['plugins', 'install', '--force'])
    expect(qwenCalls.filter(call => call.args[0] === 'gateway' && call.args[1] === 'restart')).toHaveLength(1)
    expect(qwenCalls.filter(call => call.args[0] === 'gateway' && call.args[1] === 'status')).toHaveLength(3)
    expect(qwenCalls.filter(call => call.args[0] === 'gateway'
      && call.args[1] === 'call' && call.args[2] === 'tools.catalog')).toHaveLength(1)
    expect(qwenCalls.filter(call => call.args[0] === 'gateway'
      && call.args[1] === 'call' && call.args[2] === 'tools.effective').length).toBeGreaterThanOrEqual(2)
    expect(calls.some(call => call.args[0] === 'plugins' && call.args[1] === 'update')).toBe(false)
  }, 30_000)

  it('fails before any install when current tools are not the exact known 0.2 transformation', async () => {
    const fixture = await setupFixture()
    const drifted = JSON.parse(await readFile(fixture.qwenConfig, 'utf8'))
    drifted.agents.list[1].tools.allow.push('image')
    await writeJson(fixture.qwenConfig, drifted)
    await expect(runInstaller(fixture, '--dry-run')).rejects.toMatchObject({ code: 1 })
    const calls = await readLog(fixture.log)
    expect(calls.filter(call => call.args[0] === 'plugins' && call.args[1] === 'install')).toHaveLength(0)
    expect(JSON.parse(await readFile(join(fixture.installed, 'package.json'), 'utf8')).version).toBe('0.2.0')
  }, 30_000)

  it('rechecks the approved HEAD under lock immediately before install', async () => {
    const fixture = await setupFixture()
    await expect(runInstaller(fixture, '--apply', {
      FAKE_GIT_DRIFT_ON_TOOLS_CONFIG: '1',
      FAKE_GIT_DRIFT_MARKER: join(fixture.root, 'git-head-drifted'),
    })).rejects.toMatchObject({ code: 1 })
    expect(JSON.parse(await readFile(join(fixture.installed, 'package.json'), 'utf8')).version).toBe('0.2.0')
    const installs = (await readLog(fixture.log)).filter(call => call.profile === 'qwen-current'
      && call.args[0] === 'plugins' && call.args[1] === 'install')
    expect(installs).toHaveLength(1)
    expect(installs[0].args[3]).toContain('previous-plugin')
  }, 30_000)

  it('rolls back when official install adds unexpected node_modules content', async () => {
    const fixture = await setupFixture()
    await expect(runInstaller(fixture, '--apply', {
      FAKE_EXTRA_NODE_MODULE: '1',
    })).rejects.toMatchObject({ code: 1 })
    expect(JSON.parse(await readFile(join(fixture.installed, 'package.json'), 'utf8')).version).toBe('0.2.0')
    const installs = (await readLog(fixture.log)).filter(call => call.profile === 'qwen-current'
      && call.args[0] === 'plugins' && call.args[1] === 'install')
    expect(installs).toHaveLength(2)
  }, 30_000)

  it('fails before a production install and preserves a named backup symlink', async () => {
    const fixture = await setupFixture()
    const linkedBackup = join(fixture.backupRoot, 'upgrade-20260809-010204.link01')
    await symlink(fixture.verifiedFirstInstallBackup, linkedBackup, 'dir')

    await expect(runInstaller(fixture, '--apply')).rejects.toMatchObject({ code: 1 })
    expect((await lstat(linkedBackup)).isSymbolicLink()).toBe(true)
    const calls = await readLog(fixture.log)
    expect(calls.filter(call => call.profile === 'qwen-current'
      && call.args[0] === 'plugins' && call.args[1] === 'install')).toHaveLength(0)
  }, 30_000)

  it.each([
    ['open dmPolicy', config => { config.channels.telegram.dmPolicy = 'open' }],
    ['duplicate Telegram binding', config => {
      config.bindings.push({ agentId: 'second-original', match: { channel: 'telegram', accountId: 'other' } })
    }],
    ['missing Telegram binding', config => { config.bindings = [] }],
    ['wrong Telegram agent', config => { config.bindings[0].agentId = 'main' }],
    ['duplicate second-original agent', config => {
      config.agents.list.push(structuredClone(config.agents.list[1]))
    }],
  ])('fails before any install for %s', async (_label, mutate) => {
    const fixture = await setupFixture()
    const config = JSON.parse(await readFile(fixture.qwenConfig, 'utf8'))
    mutate(config)
    await writeJson(fixture.qwenConfig, config)
    await expect(runInstaller(fixture, '--dry-run')).rejects.toMatchObject({ code: 1 })
    const calls = await readLog(fixture.log)
    expect(calls.filter(call => call.args[0] === 'plugins' && call.args[1] === 'install')).toHaveLength(0)
    expect(JSON.parse(await readFile(join(fixture.installed, 'package.json'), 'utf8')).version).toBe('0.2.0')
  }, 30_000)

  it.each([
    ['missing Telegram command owner', config => { delete config.commands.ownerAllowFrom }],
    ['duplicate Telegram command owner', config => {
      config.commands.ownerAllowFrom.push('telegram:987654321')
    }],
    ['Telegram command-owner wildcard', config => {
      config.commands.ownerAllowFrom = ['telegram:*']
    }],
    ['non-canonical Telegram command owner', config => {
      config.commands.ownerAllowFrom = ['tg:123456789']
    }],
  ])('fails before any install for %s', async (_label, mutate) => {
    const fixture = await setupFixture()
    const config = JSON.parse(await readFile(fixture.qwenConfig, 'utf8'))
    mutate(config)
    await writeJson(fixture.qwenConfig, config)
    await expect(runInstaller(fixture, '--dry-run')).rejects.toMatchObject({ code: 1 })
    const calls = await readLog(fixture.log)
    expect(calls.filter(call => call.args[0] === 'plugins' && call.args[1] === 'install')).toHaveLength(0)
    expect(JSON.parse(await readFile(join(fixture.installed, 'package.json'), 'utf8')).version).toBe('0.2.0')
  }, 30_000)

  it('rolls back the 0.2 plugin and exact current config when 0.3 effective tools drift', async () => {
    const fixture = await setupFixture()
    const configBefore = await readFile(fixture.qwenConfig)
    await expect(runInstaller(fixture, '--apply', { FAKE_EFFECTIVE_EXTRA_TOOL: '1' })).rejects.toMatchObject({ code: 1 })
    expect(await readFile(fixture.qwenConfig)).toEqual(configBefore)
    expect(JSON.parse(await readFile(join(fixture.installed, 'package.json'), 'utf8')).version).toBe('0.2.0')
    expect((await stat(fixture.verifiedFirstInstallBackup)).isDirectory()).toBe(true)
    const calls = await readLog(fixture.log)
    expect(calls.filter(call => call.profile === 'qwen-current'
      && call.args[0] === 'plugins' && call.args[1] === 'install')).toHaveLength(2)
    expect(calls.filter(call => call.profile === 'qwen-current'
      && call.args[0] === 'config' && call.args[1] === 'set'
      && call.args[2] === `plugins.entries.${pluginId}.config.allowedSenderSha256`)).toHaveLength(1)
    expect(calls.filter(call => call.profile === 'qwen-current'
      && call.args[0] === 'gateway' && call.args[1] === 'restart')).toHaveLength(2)
  }, 30_000)

  it('rolls back and refreshes 0.2 when the 0.3 live catalog probe fails, then permits a controlled retry', async () => {
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
    expect(injectedFailure.stderr).toContain('injected live catalog failure')

    expect(await readFile(fixture.qwenConfig)).toEqual(configBefore)
    expect(JSON.parse(await readFile(join(fixture.installed, 'package.json'), 'utf8')).version).toBe('0.2.0')
    expect((await stat(fixture.verifiedFirstInstallBackup)).isDirectory()).toBe(true)
    const record = JSON.parse(await readFile(`${fixture.qwenDatabase}.record.json`, 'utf8'))[pluginId]
    expect(record.version).toBe('0.2.0')
    expect(basename(record.sourcePath)).toBe('previous-plugin')

    const failedBackups = (await readdir(fixture.backupRoot)).filter(name => name.startsWith('upgrade-'))
    expect(failedBackups).toHaveLength(2)
    const activeBackup = join(fixture.backupRoot, failedBackups.find(name => name !== basename(fixture.verifiedV02Backup)))
    const activeMarker = join(activeBackup, '.active-rollback-source.json')
    expect((await stat(activeMarker)).mode & 0o777).toBe(0o600)
    const marker = JSON.parse(await readFile(activeMarker, 'utf8'))
    expect(marker).toMatchObject({
      schemaVersion: 1,
      pluginId,
      version: '0.2.0',
      sourcePath: join(activeBackup, 'previous-plugin'),
    })
    expect(marker.pluginFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    await expect(stat(join(activeBackup, '.verified')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(fixture.backupRoot, '.qwen-current-first-install.lock')))
      .rejects.toMatchObject({ code: 'ENOENT' })

    const dryRun = await runInstaller(fixture, '--dry-run')
    expect(dryRun.stdout).toContain('Dry run passed the controlled 0.2.0 to 0.3.0 upgrade checks.')
    const retry = await runInstaller(fixture, '--apply')
    expect(retry.stdout).toContain('Upgraded aiworker-video-command from 0.2.0 to 0.3.0')
    expect(JSON.parse(await readFile(join(fixture.installed, 'package.json'), 'utf8')).version).toBe('0.3.0')
    const finalRecord = JSON.parse(await readFile(`${fixture.qwenDatabase}.record.json`, 'utf8'))[pluginId]
    expect(finalRecord.version).toBe('0.3.0')
    expect(finalRecord.sourcePath).toBe(fixture.candidatePath)
    await expect(stat(fixture.verifiedFirstInstallBackup)).rejects.toMatchObject({ code: 'ENOENT' })

    const allBackups = (await readdir(fixture.backupRoot)).filter(name => name.startsWith('upgrade-'))
    const verifiedCount = (await Promise.all(allBackups.map(async name => {
      try {
        await stat(join(fixture.backupRoot, name, '.verified'))
        return 1
      } catch {
        return 0
      }
    }))).reduce((sum, value) => sum + value, 0)
    expect(verifiedCount).toBe(2)

    const calls = await readLog(fixture.log)
    const qwenInstalls = calls.filter(call => call.profile === 'qwen-current'
      && call.args[0] === 'plugins' && call.args[1] === 'install')
    expect(qwenInstalls).toHaveLength(3)
    expect(qwenInstalls.every(call => call.args[2] === '--force')).toBe(true)
    expect(calls.filter(call => call.profile === 'qwen-current'
      && call.args[0] === 'config' && call.args[1] === 'set'
      && call.args[2] === `plugins.entries.${pluginId}.config.allowedSenderSha256`)).toHaveLength(2)
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
