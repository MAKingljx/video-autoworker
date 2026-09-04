import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repositoryRoot = process.cwd()
const installer = resolve(repositoryRoot, 'scripts/apply-openclaw-runtime-convergence.sh')
const manifestFile = resolve(
  repositoryRoot,
  'ops/openclaw/qwen-current-runtime-convergence.manifest.json',
)
const convergenceHelper = resolve(
  repositoryRoot,
  'scripts/lib/openclaw-runtime-convergence.mjs',
)
const roots: string[] = []
const gatewayProcesses: ChildProcess[] = []

type Fixture = Awaited<ReturnType<typeof createFixture>>

async function exists(pathname: string) {
  return access(pathname).then(() => true, () => false)
}

async function executable(pathname: string, source: string) {
  await writeFile(pathname, source, { mode: 0o755 })
  await chmod(pathname, 0o755)
}

async function installPluginManifest(
  state: string,
  id: string,
  tool: string,
  includePersistenceHooks = false,
  version?: string,
) {
  const directory = join(state, 'extensions', id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(join(directory, 'openclaw.plugin.json'), `${JSON.stringify({
    id,
    ...(version ? { version } : {}),
    contracts: { tools: [tool] },
    toolMetadata: { [tool]: { optional: true } },
  }, null, 2)}\n`, { mode: 0o600 })
  if (version) {
    await writeFile(join(directory, 'package.json'), `${JSON.stringify({
      name: `@fixture/${id}`,
      version,
      type: 'module',
    }, null, 2)}\n`, { mode: 0o600 })
  }
  if (includePersistenceHooks) {
    await mkdir(join(directory, 'lib'), { recursive: true, mode: 0o700 })
    await writeFile(
      join(directory, 'index.js'),
      [
        "api.on('before_agent_reply', routeDirectorBlueprintQuestion)",
        "api.on('before_message_write', projectAiworkerMessageBeforeWrite)",
        "api.on('tool_result_persist', projectAiworkerToolResultForTranscript)",
        '',
      ].join('\n'),
      { mode: 0o600 },
    )
    await writeFile(
      join(directory, 'lib/director-context-summary.js'),
      await readFile(resolve(
        repositoryRoot,
        'openclaw-plugins/aiworker-director-brain/lib/director-context-summary.js',
      ), 'utf8'),
      { mode: 0o600 },
    )
    await writeFile(
      join(directory, 'lib/director-system-question-router.js'),
      await readFile(resolve(
        repositoryRoot,
        'openclaw-plugins/aiworker-director-brain/lib/director-system-question-router.js',
      ), 'utf8'),
      { mode: 0o600 },
    )
    await writeFile(
      join(directory, 'lib/sensitive-narrative-text.js'),
      await readFile(resolve(
        repositoryRoot,
        'openclaw-plugins/aiworker-director-brain/lib/sensitive-narrative-text.js',
      ), 'utf8'),
      { mode: 0o600 },
    )
    await writeFile(
      join(directory, 'lib/transcript-tool-result-projection.js'),
      await readFile(resolve(
        repositoryRoot,
        'openclaw-plugins/aiworker-director-brain/lib/transcript-tool-result-projection.js',
      ), 'utf8'),
      { mode: 0o600 },
    )
  }
}

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'openclaw-runtime-convergence.')))
  roots.push(root)
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const state = join(home, '.openclaw-qwen-current')
  const config = join(state, 'openclaw.json')
  const backupRoot = join(home, 'backups')
  const deploymentRunDir = join(root, 'deployment-run')
  const callLog = join(root, 'openclaw-calls.log')
  const authLog = join(root, 'openclaw-auth.log')
  const rpcArgvLog = join(root, 'private-rpc-argv.log')
  const rpcRuntimeLog = join(root, 'private-rpc-runtime.log')
  const validationCount = join(root, 'validation-count')
  const lsofCount = join(root, 'lsof-count')
  const gatewayLog = join(root, 'gateway-restarts.log')
  const toolBaseline = join(home, 'pre-install-tool-baseline.json')
  const fakeOpenClaw = join(bin, 'openclaw')
  const fakeProgram = join(bin, 'openclaw.mjs')
  const fakePrivateRpc = join(bin, 'private-gateway-rpc.mjs')
  const fakeLsof = join(bin, 'lsof')
  const gatewayTokenHelper = join(bin, 'gateway-token')
  const fixtureGatewayToken = 'a'.repeat(64)
  const fixtureSessionKey = 'agent:second-original:telegram:direct:fixture-user'
  const initial = {
    agents: {
      defaults: {
        model: 'qwen38-local/default_model',
        temperature: 0.2,
        compaction: {
          reserveTokens: 4096,
          keepRecentTokens: 1024,
          maxHistoryShare: 0.75,
          customInstructions: 'Preserve every tool value.',
          identifierPolicy: 'strict',
          identifierInstructions: 'Preserve every identifier.',
          recentTurnsPreserve: 4,
          notifyUser: false,
          midTurnPrecheck: { minimumBytes: 4096 },
        },
      },
      list: [
        {
          id: 'second-original',
          workspace: '/fixture/workspace',
          tools: {
            profile: 'coding',
            allow: ['read', 'write', 'exec', 'memory_search', 'session_status'],
            alsoAllow: ['aiworker_analyze_video'],
            deny: ['web_search'],
            byProvider: { qwen38: { profile: 'coding' } },
            toolsBySender: { fixture: { allow: ['exec'] } },
            sandbox: { tools: { allow: ['read'] } },
            codeMode: true,
            exec: { host: 'gateway' },
            fs: { workspaceOnly: false },
            elevated: { enabled: true },
            loopDetection: { enabled: true, historySize: 24 },
          },
        },
      ],
    },
    plugins: {
      entries: {
        'aiworker-video-command': {
          enabled: true,
          config: { releaseReady: true, unrelated: 'preserve' },
        },
        'aiworker-director-brain': {
          enabled: true,
          hooks: { allowConversationAccess: true },
          config: {
            releaseReady: true,
            targetAgentId: 'second-original',
            unrelated: 'preserve',
          },
        },
      },
    },
    gateway: {
      port: 18889,
      auth: {
        token: {
          source: 'exec',
          provider: 'fixture-gateway-token',
          id: 'qwen-current-gateway-token',
        },
      },
    },
    secrets: {
      providers: {
        'fixture-gateway-token': {
          source: 'exec',
          command: gatewayTokenHelper,
          args: [],
        },
      },
    },
  }

  await Promise.all([
    mkdir(bin, { recursive: true, mode: 0o700 }),
    mkdir(state, { recursive: true, mode: 0o700 }),
  ])
  await writeFile(config, `${JSON.stringify(initial, null, 2)}\n`, { mode: 0o600 })
  const baselineToolIds = [
    'aiworker_analyze_video', 'aiworker_director_brain', 'exec', 'read', 'session_status',
  ].toSorted()
  await writeFile(toolBaseline, `${JSON.stringify(
    toolBaselineValue(fixtureSessionKey, baselineToolIds), null, 2,
  )}\n`, { mode: 0o600 })
  await installPluginManifest(
    state,
    'aiworker-video-command',
    'aiworker_analyze_video',
    false,
    '0.5.14',
  )
  await installPluginManifest(
    state,
    'aiworker-director-brain',
    'aiworker_director_brain',
    true,
    '0.4.0',
  )

  await writeFile(fakeProgram, `
import fs from 'node:fs'
let args = process.argv.slice(2)
if (args[0] === '--version') {
  if ([
    process.env.OPENCLAW_GATEWAY_TOKEN,
    process.env.GATEWAY_TOKEN,
    process.env.OPENCLAW_GATEWAY_PASSWORD,
    process.env.GATEWAY_PASSWORD,
  ].some(Boolean)) process.exit(99)
  fs.appendFileSync(process.env.FAKE_OPENCLAW_AUTH_LOG, 'version=absent\\n')
  process.stdout.write('OpenClaw ' + (process.env.FAKE_OPENCLAW_VERSION || '2026.7.1-2') + ' (fixture)\\n')
  process.exit(0)
}
if (args[0] !== '--profile' || args[1] !== 'qwen-current') process.exit(90)
args = args.slice(2)
const loggedArgs = [...args]
const loggedParamsIndex = loggedArgs.indexOf('--params')
if (loggedParamsIndex >= 0 && loggedArgs[loggedParamsIndex + 1]) {
  loggedArgs[loggedParamsIndex + 1] = '<private-json>'
}
fs.appendFileSync(process.env.FAKE_OPENCLAW_CALL_LOG, loggedArgs.join(' ') + '\\n')
const gatewayCommand = (args[0] === 'gateway' && ['status', 'call'].includes(args[1]))
  || (args[0] === 'plugins' && args[1] === 'inspect' && args.includes('--runtime'))
const conflictingAuth = [
  process.env.GATEWAY_TOKEN,
  process.env.OPENCLAW_GATEWAY_PASSWORD,
  process.env.GATEWAY_PASSWORD,
].some(Boolean)
const authState = process.env.OPENCLAW_GATEWAY_TOKEN === process.env.FAKE_GATEWAY_TOKEN
  && !conflictingAuth
  ? 'resolved'
  : process.env.OPENCLAW_GATEWAY_TOKEN || conflictingAuth ? 'unexpected' : 'absent'
fs.appendFileSync(
  process.env.FAKE_OPENCLAW_AUTH_LOG,
  args.slice(0, 3).join(' ') + '=' + authState + '\\n',
)
if (gatewayCommand !== (authState === 'resolved')) process.exit(97)
if (process.argv.includes(process.env.FAKE_GATEWAY_TOKEN)) process.exit(98)
const configPath = process.env.FAKE_ACTIVE_CONFIG_PATH
  || process.env.AIWORKER_OPENCLAW_QWEN_STATE_DIR + '/openclaw.json'
const configFileOutput = process.env.FAKE_ACTIVE_CONFIG_OUTPUT || configPath
const read = pathname => JSON.parse(fs.readFileSync(pathname, 'utf8'))
const isObject = value => value && typeof value === 'object' && !Array.isArray(value)
const mergePatch = (current, patch) => {
  if (!isObject(patch)) return structuredClone(patch)
  const next = isObject(current) ? structuredClone(current) : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else if (isObject(value)) next[key] = mergePatch(next[key], value)
    else next[key] = structuredClone(value)
  }
  return next
}
if (args[0] === 'config' && args[1] === 'file') {
  process.stdout.write(configFileOutput + '\\n')
  process.exit(0)
}
if (args[0] === 'config' && args[1] === 'validate') {
  const countPath = process.env.FAKE_VALIDATION_COUNT_FILE
  const count = (fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0) + 1
  fs.writeFileSync(countPath, String(count), { mode: 0o600 })
  const current = read(configPath)
  if (Number(process.env.FAKE_CONCURRENT_WRITE_ON_VALIDATE_CALL) === count) {
    current.gateway.port = 19991
    fs.writeFileSync(configPath, JSON.stringify(current, null, 2) + '\\n', { mode: 0o600 })
  }
  if (process.env.FAKE_VALIDATE_FAIL === '1') {
    process.stderr.write('validation detail ' + process.env.FAKE_SENSITIVE_MARKER + '\\n')
    process.exit(94)
  }
  process.exit(0)
}
if (args[0] === 'config' && args[1] === 'patch') {
  const fileIndex = args.indexOf('--file')
  if (fileIndex < 0 || !args[fileIndex + 1]) process.exit(91)
  const patch = read(args[fileIndex + 1])
  const compactionPatch = patch?.agents?.defaults?.compaction
  const isApprovedCompactionPatch = isObject(compactionPatch)
    && JSON.stringify(Object.keys(compactionPatch).sort()) === JSON.stringify([
      'identifierInstructions',
      'keepRecentTokens',
      'maxActiveTranscriptBytes',
      'midTurnPrecheck',
      'model',
      'recentTurnsPreserve',
      'timeoutSeconds',
      'truncateAfterCompaction',
    ])
    && compactionPatch.model === 'qwen36-tools-local/default_model'
    && compactionPatch.timeoutSeconds === 240
    && compactionPatch.keepRecentTokens === 8192
    && compactionPatch.identifierInstructions === null
    && compactionPatch.recentTurnsPreserve === 4
    && compactionPatch.truncateAfterCompaction === true
    && compactionPatch.maxActiveTranscriptBytes === '128kb'
    && isObject(compactionPatch.midTurnPrecheck)
    && Object.keys(compactionPatch.midTurnPrecheck).length === 1
    && compactionPatch.midTurnPrecheck.enabled === true
  fs.appendFileSync(
    process.env.FAKE_OPENCLAW_CALL_LOG,
    'patch-approved-compaction=' + String(isApprovedCompactionPatch) + '\\n',
  )
  if (!isApprovedCompactionPatch) process.exit(96)
  const dryRun = args.includes('--dry-run')
  if (dryRun && process.env.FAKE_MUTATE_ON_DRY_RUN === '1') {
    const concurrent = read(configPath)
    concurrent.gateway.port = 19992
    fs.writeFileSync(configPath, JSON.stringify(concurrent, null, 2) + '\\n', { mode: 0o600 })
  }
  if (dryRun && process.env.FAKE_REPLACE_SAME_CONTENT_ON_DRY_RUN === '1') {
    const replacement = configPath + '.replacement'
    fs.writeFileSync(replacement, fs.readFileSync(configPath), { mode: 0o600 })
    fs.renameSync(replacement, configPath)
  }
  if (!dryRun) {
    const current = read(configPath)
    const updated = mergePatch(current, patch)
    updated.meta ??= {}
    updated.meta.lastTouchedVersion = process.env.FAKE_OPENCLAW_VERSION || '2026.7.1-2'
    updated.meta.lastTouchedAt = new Date().toISOString()
    if (process.env.FAKE_EXTRA_CONFIG_ON_APPLY === '1') updated.gateway.port = 19993
    if (process.env.FAKE_EXTRA_META_ON_APPLY === '1') updated.meta.owner = 'unexpected'
    if (process.env.FAKE_ADD_AGENT_ON_APPLY === '1') {
      updated.agents.list.push({ id: 'late-agent', tools: { profile: 'coding' } })
    }
    fs.writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\\n', { mode: 0o600 })
  }
  process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'status') {
  const pid = Number(process.env.FAKE_STATUS_GATEWAY_PID || process.env.FAKE_GATEWAY_PID)
  process.stdout.write(JSON.stringify({
    service: { runtime: { pid, status: 'running', state: 'active' } },
    gateway: { bindHost: '127.0.0.1', port: 18889 },
    port: { port: 18889, status: 'busy', listeners: [{ pid }] },
    connections: { port: 18889 },
    rpc: { ok: true },
    health: { healthy: true, staleGatewayPids: [] },
  }) + '\\n')
  process.exit(0)
}
if (args[0] === 'plugins' && args[1] === 'inspect') {
  const typedHooks = process.env.FAKE_MISSING_PERSISTENCE_HOOK === '1'
    ? ['tool_result_persist']
    : ['before_agent_reply', 'before_message_write', 'tool_result_persist']
  process.stdout.write(JSON.stringify({
    plugin: { id: 'aiworker-director-brain', status: 'loaded', version: '0.4.0' },
    tools: [{ names: ['aiworker_director_brain'] }],
    typedHooks,
    diagnostics: [],
  }) + '\\n')
  process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'tools.catalog') {
  const catalogCall = fs.readFileSync(process.env.FAKE_OPENCLAW_CALL_LOG, 'utf8')
    .split(/\\r?\\n/u).filter(line => line.startsWith('gateway call tools.catalog ')).length
  if (Number(process.env.FAKE_MUTATE_PLUGIN_ON_CATALOG_CALL) === catalogCall) {
    fs.appendFileSync(process.env.FAKE_PLUGIN_ENTRY_PATH, '// runtime drift\\n')
  }
  if (Number(process.env.FAKE_REPLACE_CONFIG_ON_CATALOG_CALL) === catalogCall) {
    const replacement = configPath + '.catalog-replacement'
    fs.writeFileSync(replacement, fs.readFileSync(configPath), { mode: 0o600 })
    fs.renameSync(replacement, configPath)
  }
  const includeVideo = Number(process.env.FAKE_REMOVE_VIDEO_ON_CATALOG_CALL) !== catalogCall
  const includeRead = Number(process.env.FAKE_REMOVE_READ_ON_CATALOG_CALL) !== catalogCall
  process.stdout.write(JSON.stringify({
    agentId: 'second-original',
    groups: [
      { source: 'core', tools: [
        ...includeRead ? [{ id: 'read' }] : [],
        { id: 'exec' },
        { id: 'session_status' },
      ] },
      ...includeVideo ? [{
        pluginId: 'aiworker-video-command',
        source: 'plugin',
        tools: [{
          id: 'aiworker_analyze_video',
          pluginId: 'aiworker-video-command',
          source: 'plugin',
          optional: true,
        }],
      }] : [],
      {
        pluginId: 'aiworker-director-brain',
        source: 'plugin',
        tools: [{
          id: 'aiworker_director_brain',
          pluginId: 'aiworker-director-brain',
          source: 'plugin',
          optional: true,
        }],
      },
    ],
  }) + '\\n')
  process.exit(0)
}
if (args[0] === 'gateway' && args[1] === 'call' && args[2] === 'tools.effective') {
  const paramsIndex = args.indexOf('--params')
  let effectiveParams
  try { effectiveParams = JSON.parse(args[paramsIndex + 1]) } catch { process.exit(93) }
  if (effectiveParams?.agentId !== 'second-original'
    || effectiveParams?.sessionKey !== process.env.FAKE_RUNTIME_SESSION_KEY) process.exit(93)
  const effectiveCall = fs.readFileSync(process.env.FAKE_OPENCLAW_CALL_LOG, 'utf8')
    .split(/\\r?\\n/u).filter(line => line.startsWith('gateway call tools.effective ')).length
  const includeRead = Number(process.env.FAKE_REMOVE_READ_ON_EFFECTIVE_CALL) !== effectiveCall
  process.stdout.write(JSON.stringify({
    agentId: 'second-original',
    ...(process.env.FAKE_EFFECTIVE_NOTICE === '1' ? {
      notices: [{ id: 'mcp-not-yet-listed', severity: 'info' }],
    } : {}),
    groups: [
      { source: 'core', tools: [
        ...includeRead ? [{ id: 'read' }] : [],
        { id: 'exec' },
        { id: 'session_status' },
      ] },
      { pluginId: 'aiworker-video-command', source: 'plugin', tools: [{
        id: 'aiworker_analyze_video', pluginId: 'aiworker-video-command', source: 'plugin',
      }] },
      { pluginId: 'aiworker-director-brain', source: 'plugin', tools: [{
        id: 'aiworker_director_brain', pluginId: 'aiworker-director-brain', source: 'plugin',
      }] },
    ],
  }) + '\\n')
  process.exit(0)
}
if (args[0] === 'gateway' && ['restart', 'start', 'stop'].includes(args[1])) {
  fs.appendFileSync(process.env.FAKE_GATEWAY_LOG, args[1] + '\\n')
  process.exit(0)
}
process.exit(92)
`)
  await executable(
    fakeOpenClaw,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeProgram)} "$@"\n`,
  )
  await executable(fakePrivateRpc, `
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const [operation, outputPath] = process.argv.slice(2)
const token = process.env.OPENCLAW_GATEWAY_TOKEN || ''
const sessionKey = process.env.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY || ''
const liveArgv = execFileSync('/bin/ps', ['-o', 'command=', '-p', String(process.pid)], {
  encoding: 'utf8',
})
fs.appendFileSync(process.env.FAKE_RPC_ARGV_LOG, liveArgv.trim() + '\\n')
if (!operation || !outputPath || process.argv.length !== 4
  || process.argv.includes(token) || process.argv.includes(sessionKey)
  || liveArgv.includes(token) || liveArgv.includes(sessionKey)
  || token !== process.env.FAKE_GATEWAY_TOKEN) process.exit(98)
const configPath = process.env.FAKE_ACTIVE_CONFIG_PATH
  || process.env.AIWORKER_OPENCLAW_QWEN_STATE_DIR + '/openclaw.json'
const read = pathname => JSON.parse(fs.readFileSync(pathname, 'utf8'))
const isObject = value => value && typeof value === 'object' && !Array.isArray(value)
const mergePatch = (current, patch) => {
  if (!isObject(patch)) return structuredClone(patch)
  const next = isObject(current) ? structuredClone(current) : {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else if (isObject(value)) next[key] = mergePatch(next[key], value)
    else next[key] = structuredClone(value)
  }
  return next
}
const hash = source => createHash('sha256').update(source).digest('hex')
const callLog = process.env.FAKE_OPENCLAW_CALL_LOG
const authLog = process.env.FAKE_OPENCLAW_AUTH_LOG
const runtimeLog = process.env.FAKE_RPC_RUNTIME_LOG
const calls = name => fs.readFileSync(callLog, 'utf8').split(/\\r?\\n/u)
  .filter(line => line.startsWith('gateway call ' + name + ' ')).length
const write = value => fs.writeFileSync(outputPath, JSON.stringify(value) + '\\n', { mode: 0o600 })
if (operation === 'catalog') {
  fs.appendFileSync(callLog, 'gateway call tools.catalog private-rpc\\n')
  fs.appendFileSync(authLog, 'gateway call tools.catalog=resolved\\n')
  const call = calls('tools.catalog')
  if (Number(process.env.FAKE_MUTATE_PLUGIN_ON_CATALOG_CALL) === call) {
    fs.appendFileSync(process.env.FAKE_PLUGIN_ENTRY_PATH, '// runtime drift\\n')
  }
  if (Number(process.env.FAKE_REPLACE_CONFIG_ON_CATALOG_CALL) === call) {
    const replacement = configPath + '.catalog-replacement'
    fs.writeFileSync(replacement, fs.readFileSync(configPath), { mode: 0o600 })
    fs.renameSync(replacement, configPath)
  }
  const includeVideo = Number(process.env.FAKE_REMOVE_VIDEO_ON_CATALOG_CALL) !== call
  const includeRead = Number(process.env.FAKE_REMOVE_READ_ON_CATALOG_CALL) !== call
  write({ agentId: 'second-original', groups: [
    { source: 'core', tools: [...includeRead ? [{ id: 'read',
      ...(process.env.FAKE_READ_DESCRIPTION ? { description: process.env.FAKE_READ_DESCRIPTION } : {}) }] : [],
    { id: 'exec' }, { id: 'session_status' }] },
    ...includeVideo ? [{ pluginId: 'aiworker-video-command', source: 'plugin', tools: [{
      id: 'aiworker_analyze_video', pluginId: 'aiworker-video-command', source: 'plugin', optional: true,
    }] }] : [],
    { pluginId: 'aiworker-director-brain', source: 'plugin', tools: [{
      id: 'aiworker_director_brain', pluginId: 'aiworker-director-brain', source: 'plugin', optional: true,
    }] },
  ] })
  process.exit(0)
}
if (operation === 'effective') {
  if (sessionKey !== process.env.FAKE_RUNTIME_SESSION_KEY) process.exit(93)
  fs.appendFileSync(callLog, 'gateway call tools.effective private-rpc\\n')
  fs.appendFileSync(authLog, 'gateway call tools.effective=resolved\\n')
  const call = calls('tools.effective')
  const includeRead = Number(process.env.FAKE_REMOVE_READ_ON_EFFECTIVE_CALL) !== call
  write({ agentId: 'second-original', ...(process.env.FAKE_EFFECTIVE_NOTICE === '1'
    ? { notices: [{ id: 'mcp-not-yet-listed', severity: 'info' }] } : {}), groups: [
    { source: 'core', tools: [...includeRead ? [{ id: 'read',
      ...(process.env.FAKE_READ_DESCRIPTION ? { description: process.env.FAKE_READ_DESCRIPTION } : {}) }] : [],
    { id: 'exec' }, { id: 'session_status' }] },
    { pluginId: 'aiworker-video-command', source: 'plugin', tools: [{
      id: 'aiworker_analyze_video', pluginId: 'aiworker-video-command', source: 'plugin',
    }] },
    { pluginId: 'aiworker-director-brain', source: 'plugin', tools: [{
      id: 'aiworker_director_brain', pluginId: 'aiworker-director-brain', source: 'plugin',
    }] },
  ] })
  process.exit(0)
}
if (operation === 'config-get') {
  fs.appendFileSync(callLog, 'gateway call config.get private-rpc\\n')
  const call = calls('config.get')
  const source = fs.readFileSync(configPath, 'utf8')
  const config = JSON.parse(source)
  if (process.env.FAKE_POST_CONFIG_MISMATCH === '1' && call >= 2) {
    config.gateway.port = 19997
  }
  write({
    exists: true,
    valid: true,
    ...(!(process.env.FAKE_MISSING_BASE_HASH === '1' && call === 1)
      && !(process.env.FAKE_MISSING_POST_HASH === '1' && call >= 2)
      ? { hash: hash(source) } : {}),
    config,
  })
  process.exit(0)
}
if (operation === 'config-patch') {
  const source = fs.readFileSync(configPath, 'utf8')
  if (process.env.AIWORKER_OPENCLAW_RUNTIME_BASE_HASH !== hash(source)) process.exit(95)
  const patch = read(process.env.AIWORKER_OPENCLAW_RUNTIME_PATCH_FILE)
  const updated = mergePatch(JSON.parse(source), patch)
  updated.meta ??= {}
  updated.meta.lastTouchedVersion = process.env.FAKE_OPENCLAW_VERSION || '2026.7.1-2'
  updated.meta.lastTouchedAt = new Date().toISOString()
    if (process.env.FAKE_EXTRA_CONFIG_ON_APPLY === '1') updated.gateway.port = 19993
    if (process.env.FAKE_EXTRA_META_ON_APPLY === '1') updated.meta.owner = 'unexpected'
    if (process.env.FAKE_ADD_AGENT_ON_APPLY === '1') {
      updated.agents.list.push({ id: 'late-agent', tools: { profile: 'coding' } })
    }
  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\\n', { mode: 0o600 })
  fs.appendFileSync(callLog, 'config rpc-patch\\npatch-approved-compaction=true\\n')
  fs.appendFileSync(runtimeLog, JSON.stringify({
    msg: process.env.FAKE_RELOAD_FAILURE_LOG === '1'
      ? 'config hot reload failed (agents.defaults.compaction)'
      : 'config hot reload applied (agents.defaults.compaction)',
  }) + '\\n')
  write({ ok: true, config: updated,
    restart: process.env.FAKE_PATCH_RESTART === '1' ? { pending: true } : null,
    sentinel: { persisted: true, payload: { stats: { mode: 'config.patch',
      requiresRestart: process.env.FAKE_PATCH_REQUIRES_RESTART === '1' } } } })
  process.exit(0)
}
if (operation === 'health') {
  write({ configReload: { hotReloadStatus: process.env.FAKE_HOT_RELOAD_STATUS || 'active' } })
  process.exit(0)
}
if (operation === 'logs-tail') {
  const lines = fs.existsSync(runtimeLog) ? fs.readFileSync(runtimeLog, 'utf8').trim().split(/\\r?\\n/u).filter(Boolean) : []
  const requestedCursor = process.env.AIWORKER_OPENCLAW_RUNTIME_LOG_CURSOR === undefined
    ? 0 : Number(process.env.AIWORKER_OPENCLAW_RUNTIME_LOG_CURSOR)
  if (!Number.isSafeInteger(requestedCursor) || requestedCursor < 0 || requestedCursor > lines.length) {
    process.exit(96)
  }
  write({
    file: runtimeLog,
    cursor: process.env.FAKE_CURSOR_DOES_NOT_ADVANCE === '1'
      ? requestedCursor : lines.length,
    size: lines.length,
    lines: lines.slice(requestedCursor),
  })
  process.exit(0)
}
process.exit(92)
`)
  await executable(gatewayTokenHelper, `#!/bin/sh
if [ -n "\${OPENCLAW_GATEWAY_TOKEN:-}" ] \
  || [ -n "\${GATEWAY_TOKEN:-}" ] \
  || [ -n "\${OPENCLAW_GATEWAY_PASSWORD:-}" ] \
  || [ -n "\${GATEWAY_PASSWORD:-}" ]; then
  exit 99
fi
printf '%s\\n' '${fixtureGatewayToken}'
`)
  await executable(fakeLsof, `#!/bin/sh
count=0
if [ -f "$FAKE_LSOF_COUNT_FILE" ]; then count=$(cat "$FAKE_LSOF_COUNT_FILE"); fi
count=$((count + 1))
printf '%s' "$count" > "$FAKE_LSOF_COUNT_FILE"
pid="$FAKE_GATEWAY_PID"
if [ -n "\${FAKE_LSOF_REPLACEMENT_CALL:-}" ] && [ "$count" = "$FAKE_LSOF_REPLACEMENT_CALL" ]; then
  pid="$FAKE_REPLACEMENT_GATEWAY_PID"
fi
printf 'p%s\\n' "$pid"
`)
  const gatewayProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  })
  gatewayProcesses.push(gatewayProcess)
  expect(gatewayProcess.pid).toBeTruthy()

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    OPENCLAW_BIN: fakeOpenClaw,
    AIWORKER_NODE_BIN: process.execPath,
    AIWORKER_OPENCLAW_QWEN_STATE_DIR: state,
    AIWORKER_OPENCLAW_RUNTIME_BACKUP_ROOT: backupRoot,
    AIWORKER_BG_RUN_DIR: deploymentRunDir,
    FAKE_OPENCLAW_CALL_LOG: callLog,
    FAKE_OPENCLAW_AUTH_LOG: authLog,
    FAKE_RPC_ARGV_LOG: rpcArgvLog,
    FAKE_RPC_RUNTIME_LOG: rpcRuntimeLog,
    FAKE_GATEWAY_TOKEN: fixtureGatewayToken,
    FAKE_RUNTIME_SESSION_KEY: fixtureSessionKey,
    FAKE_VALIDATION_COUNT_FILE: validationCount,
    FAKE_LSOF_COUNT_FILE: lsofCount,
    FAKE_GATEWAY_LOG: gatewayLog,
    FAKE_PLUGIN_ENTRY_PATH: join(state, 'extensions/aiworker-director-brain/index.js'),
    FAKE_GATEWAY_PID: String(gatewayProcess.pid),
    OPENCLAW_GATEWAY_TOKEN: 'parent-token-must-not-leak',
    GATEWAY_TOKEN: 'parent-gateway-token-must-not-leak',
    OPENCLAW_GATEWAY_PASSWORD: 'parent-openclaw-password-must-not-leak',
    GATEWAY_PASSWORD: 'parent-gateway-password-must-not-leak',
    AIWORKER_OPENCLAW_RUNTIME_TEST_MODE: '1',
    AIWORKER_OPENCLAW_RUNTIME_RPC_HELPER: fakePrivateRpc,
    AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY: fixtureSessionKey,
    AIWORKER_OPENCLAW_RUNTIME_TEST_GATEWAY_START_MS: String(
      (Math.floor(Date.now() / 1_000) + 1) * 1_000,
    ),
    AIWORKER_OPENCLAW_RUNTIME_LSOF_BIN: fakeLsof,
  }
  const fixture = {
    root,
    home,
    state,
    config,
    backupRoot,
    deploymentRunDir,
    callLog,
    authLog,
    rpcArgvLog,
    gatewayTokenHelper,
    fixtureGatewayToken,
    fixtureSessionKey,
    gatewayLog,
    toolBaseline,
    initial,
    env,
  }
  await writeFile(callLog, '', { mode: 0o600 })
  await writeFile(authLog, '', { mode: 0o600 })
  await writeFile(rpcArgvLog, '', { mode: 0o600 })
  await writeFile(rpcRuntimeLog, '', { mode: 0o600 })
  await writeFile(validationCount, '0', { mode: 0o600 })
  await writeFile(lsofCount, '0', { mode: 0o600 })
  return fixture
}

async function run(entry: Fixture, ...args: string[]) {
  const needsBaseline = (args.includes('--apply') || args.includes('--dry-run'))
    && !args.includes('--tool-baseline')
  const invocation = needsBaseline ? [...args, '--tool-baseline', entry.toolBaseline] : args
  return execFileAsync('bash', [installer, ...invocation], {
    cwd: repositoryRoot,
    env: entry.env,
    encoding: 'utf8',
  })
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stable(child)]))
}

function capabilities(ids: string[], catalog: boolean) {
  return [...ids].sort().map((id) => {
    const pluginId = id === 'aiworker_analyze_video'
      ? 'aiworker-video-command'
      : id === 'aiworker_director_brain' ? 'aiworker-director-brain' : null
    const source = pluginId ? 'plugin' : 'core'
    const descriptorSurface = stable({
      label: null,
      description: null,
      rawDescription: null,
      optional: catalog && pluginId ? true : null,
      defaultProfiles: null,
      risk: null,
      tags: null,
    })
    return stable({
      id,
      source,
      pluginId,
      channelId: null,
      descriptorSurfaceSha256: digest(JSON.stringify(descriptorSurface)),
    }) as {
      id: string
      source: string
      pluginId: string | null
      channelId: string | null
      descriptorSurfaceSha256: string
    }
  })
}

function toolBaselineValue(sessionKey: string, catalogIds: string[], effectiveIds = catalogIds) {
  const catalogCapabilities = capabilities(catalogIds, true)
  const effectiveCapabilities = capabilities(effectiveIds, false)
  return {
    agentId: 'second-original',
    catalogCapabilities,
    catalogSha256: digest(JSON.stringify(catalogCapabilities)),
    catalogToolIds: [...catalogIds].toSorted(),
    effectiveCapabilities,
    effectiveSha256: digest(JSON.stringify(effectiveCapabilities)),
    effectiveToolIds: [...effectiveIds].toSorted(),
    profile: 'qwen-current',
    schema: 'video-autoworker-openclaw-tool-baseline/v3',
    sessionKeySha256: digest(sessionKey),
  }
}

async function replaceToolBaseline(entry: Fixture, catalog: string[], effective = catalog) {
  const catalogToolIds = [...catalog].toSorted()
  const effectiveToolIds = [...effective].toSorted()
  await writeFile(entry.toolBaseline, `${JSON.stringify(
    toolBaselineValue(entry.fixtureSessionKey, catalogToolIds, effectiveToolIds), null, 2,
  )}\n`, { mode: 0o600 })
}

async function addProfileAgent(entry: Fixture, id = 'other-agent') {
  const config = JSON.parse(await readFile(entry.config, 'utf8'))
  config.agents.list.push({ id, tools: { profile: 'coding', allow: ['read', 'exec'] } })
  await writeFile(entry.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

afterEach(async () => {
  for (const child of gatewayProcesses.splice(0)) child.kill('SIGKILL')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('qwen-current unified runtime convergence installer', () => {
  it('pins one exact manifest and contains no Gateway lifecycle action', async () => {
    expect(JSON.parse(await readFile(manifestFile, 'utf8'))).toEqual({
      schema: 'video-autoworker-openclaw-runtime-convergence/v1',
      openclawVersion: '2026.7.1-2',
      profile: 'qwen-current',
      compaction: {
        set: {
          model: 'qwen36-tools-local/default_model',
          timeoutSeconds: 240,
          keepRecentTokens: 8192,
          recentTurnsPreserve: 4,
          truncateAfterCompaction: true,
          maxActiveTranscriptBytes: '128kb',
          midTurnPrecheck: { enabled: true },
        },
        remove: ['identifierInstructions'],
      },
      agent: { id: 'second-original' },
      requiredPlugins: [
        {
          id: 'aiworker-video-command',
          version: '0.5.14',
          tool: 'aiworker_analyze_video',
          requiredConfig: { releaseReady: true },
        },
        {
          id: 'aiworker-director-brain',
          version: '0.4.0',
          tool: 'aiworker_director_brain',
          requiredHooks: ['before_agent_reply', 'before_message_write', 'tool_result_persist'],
          requiredHookConfig: { allowConversationAccess: true },
          requiredConfig: { releaseReady: true, targetAgentId: 'second-original' },
        },
      ],
    })
    const source = await readFile(installer, 'utf8')
    expect(source).not.toMatch(/gateway\s+(?:restart|start|stop)|launchctl|\bssh\b|\bscp\b/u)
    const sourceContractCall = source.lastIndexOf('\nassert_source_contract\n')
    expect(sourceContractCall).toBeGreaterThan(0)
    expect(source.indexOf('acquire_shared_deployment_lock'))
      .toBeLessThan(sourceContractCall)
    expect(source.indexOf('assert_shared_deployment_lock_available'))
      .toBeLessThan(sourceContractCall)
  })

  it('captures a private pre-install catalog and effective-tool baseline without mutation', async () => {
    const entry = await createFixture()
    const configBefore = await readFile(entry.config, 'utf8')

    const result = await run(entry, '--capture-tool-baseline')
    const baseline = /baseline: (.+)$/mu.exec(result.stdout)?.[1]

    expect(baseline).toBeTruthy()
    expect((await stat(baseline as string)).mode & 0o777).toBe(0o600)
    const value = JSON.parse(await readFile(baseline as string, 'utf8'))
    expect(value.schema).toBe('video-autoworker-openclaw-tool-baseline/v3')
    expect(value.sessionKeySha256).toBe(digest(entry.fixtureSessionKey))
    expect(await readFile(baseline as string, 'utf8')).not.toContain(entry.fixtureSessionKey)
    expect(value.catalogToolIds).toContain('read')
    expect(value.effectiveToolIds).toContain('read')
    expect(await readFile(entry.config, 'utf8')).toBe(configBefore)
    expect(await exists(entry.gatewayLog)).toBe(false)
  }, 15_000)

  it.each(['capture-tool-baseline', 'dry-run', 'apply'])(
    'rejects a multi-agent qwen-current profile during %s without persistent writes',
    async (mode) => {
      const entry = await createFixture()
      await addProfileAgent(entry)
      const before = await readFile(entry.config, 'utf8')

      await expect(run(entry, `--${mode}`)).rejects.toThrow(
        /agents\.list must contain only the second-original profile agent/u,
      )
      expect(await readFile(entry.config, 'utf8')).toBe(before)
      expect(await exists(entry.backupRoot)).toBe(false)
      expect(await exists(entry.gatewayLog)).toBe(false)
    },
    15_000,
  )

  it('captures the pre-install baseline before the 0.4.0 plugin is present', async () => {
    const entry = await createFixture()
    const pluginManifestPath = join(
      entry.state,
      'extensions/aiworker-director-brain/openclaw.plugin.json',
    )
    const packageManifestPath = join(
      entry.state,
      'extensions/aiworker-director-brain/package.json',
    )
    const pluginManifest = JSON.parse(await readFile(pluginManifestPath, 'utf8'))
    const packageManifest = JSON.parse(await readFile(packageManifestPath, 'utf8'))
    pluginManifest.version = '0.3.0'
    packageManifest.version = '0.3.0'
    await writeFile(pluginManifestPath, `${JSON.stringify(pluginManifest, null, 2)}\n`, {
      mode: 0o600,
    })
    await writeFile(packageManifestPath, `${JSON.stringify(packageManifest, null, 2)}\n`, {
      mode: 0o600,
    })

    await expect(run(entry, '--capture-tool-baseline')).resolves.toMatchObject({
      stdout: expect.stringContaining('Captured pre-install'),
    })
  }, 30_000)

  it('requires one real existing session and binds later verification to it', async () => {
    const missing = await createFixture()
    delete missing.env.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY
    await expect(run(missing, '--capture-tool-baseline')).rejects.toMatchObject({
      stderr: expect.stringContaining('must identify one existing real session'),
    })
    expect(await exists(missing.backupRoot)).toBe(false)

    const synthetic = await createFixture()
    synthetic.env.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY = 'synthetic-session-does-not-exist'
    await expect(run(synthetic, '--capture-tool-baseline')).rejects.toThrow()
    expect(await exists(synthetic.backupRoot)).toBe(false)

    const incomplete = await createFixture()
    incomplete.env.FAKE_EFFECTIVE_NOTICE = '1'
    await expect(run(incomplete, '--capture-tool-baseline')).rejects.toThrow(
      /pre-install effective tools is incomplete/u,
    )
    expect(await exists(incomplete.backupRoot)).toBe(false)

    const rebound = await createFixture()
    rebound.env.AIWORKER_OPENCLAW_RUNTIME_SESSION_KEY = 'another-existing-session'
    rebound.env.FAKE_RUNTIME_SESSION_KEY = 'another-existing-session'
    await expect(run(rebound, '--dry-run')).rejects.toThrow(
      /pre-install tool baseline is bound to a different runtime session/u,
    )
    expect(await exists(rebound.backupRoot)).toBe(false)
  }, 30_000)

  it('allows only the director tool to be added after the pre-install baseline', async () => {
    const accepted = await createFixture()
    const withoutDirector = [
      'aiworker_analyze_video', 'exec', 'read', 'session_status',
    ]
    await replaceToolBaseline(accepted, withoutDirector)
    await expect(run(accepted, '--dry-run')).resolves.toMatchObject({
      stdout: expect.stringContaining('dry-run passed'),
    })

    const removed = await createFixture()
    await replaceToolBaseline(removed, [
      'aiworker_analyze_video', 'aiworker_director_brain', 'exec', 'historical_tool',
      'read', 'session_status',
    ])
    await expect(run(removed, '--dry-run')).rejects.toThrow(
      /tool catalog changed outside the allowed director-brain addition/u,
    )

    const unexpectedAddition = await createFixture()
    await replaceToolBaseline(unexpectedAddition, [
      'aiworker_analyze_video', 'aiworker_director_brain', 'read', 'session_status',
    ])
    await expect(run(unexpectedAddition, '--dry-run')).rejects.toThrow(
      /tool catalog changed outside the allowed director-brain addition/u,
    )

    const effectiveRemoval = await createFixture()
    const current = [
      'aiworker_analyze_video', 'aiworker_director_brain', 'exec', 'read', 'session_status',
    ]
    await replaceToolBaseline(effectiveRemoval, current, [...current, 'historical_effective_tool'])
    await expect(run(effectiveRemoval, '--dry-run')).rejects.toThrow(
      /effective tools changed outside the allowed director-brain addition/u,
    )
  }, 30_000)

  it('rejects same-ID descriptor degradation in catalog and effective tools', async () => {
    const catalogChanged = await createFixture()
    catalogChanged.env.FAKE_READ_DESCRIPTION = 'degraded replacement semantics'
    await expect(run(catalogChanged, '--dry-run')).rejects.toThrow(
      /tool catalog descriptor surface changed for existing tool: read/u,
    )

    const effectiveChanged = await createFixture()
    effectiveChanged.env.FAKE_READ_DESCRIPTION = 'degraded replacement semantics'
    // Model the catalog descriptor as intentionally upgraded in the baseline;
    // the session-effective descriptor must still match independently.
    const ids = [
      'aiworker_analyze_video', 'aiworker_director_brain', 'exec', 'read', 'session_status',
    ]
    const baseline = toolBaselineValue(effectiveChanged.fixtureSessionKey, ids)
    const readCatalog = baseline.catalogCapabilities.find(item => item.id === 'read')!
    const descriptorSurface = stable({
      label: null,
      description: 'degraded replacement semantics',
      rawDescription: null,
      optional: null,
      defaultProfiles: null,
      risk: null,
      tags: null,
    })
    readCatalog.descriptorSurfaceSha256 = digest(JSON.stringify(descriptorSurface))
    baseline.catalogSha256 = digest(JSON.stringify(baseline.catalogCapabilities))
    await writeFile(effectiveChanged.toolBaseline, `${JSON.stringify(baseline, null, 2)}\n`, {
      mode: 0o600,
    })
    await expect(run(effectiveChanged, '--dry-run')).rejects.toThrow(
      /effective tools descriptor surface changed for existing tool: read/u,
    )
  }, 15_000)

  it('requires the AI-worker tools while allowing the existing effective tool set', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'openclaw-effective-tools.')))
    roots.push(root)
    const inventory = join(root, 'tools-effective.json')
    await writeFile(inventory, `${JSON.stringify({
      groups: [
        { tools: [{ id: 'aiworker_director_brain' }, { id: 'session_status' }] },
        { tools: [{ id: 'aiworker_analyze_video' }] },
      ],
    })}\n`, { mode: 0o600 })

    await expect(execFileAsync(process.execPath, [
      convergenceHelper,
      'verify-effective',
      inventory,
      manifestFile,
    ])).resolves.toMatchObject({ stdout: '' })

    await writeFile(inventory, `${JSON.stringify({
      groups: [{ tools: [
        { id: 'session_status' },
        { id: 'aiworker_analyze_video' },
        { id: 'aiworker_director_brain' },
        { id: 'read' },
      ] }],
    })}\n`, { mode: 0o600 })
    await expect(execFileAsync(process.execPath, [
      convergenceHelper,
      'verify-effective',
      inventory,
      manifestFile,
    ])).resolves.toMatchObject({ stdout: '' })

    await writeFile(inventory, `${JSON.stringify({
      groups: [{ tools: [
        { id: 'session_status' },
        { id: 'aiworker_director_brain' },
        { id: 'read' },
      ] }],
    })}\n`, { mode: 0o600 })
    await expect(execFileAsync(process.execPath, [
      convergenceHelper,
      'verify-effective',
      inventory,
      manifestFile,
    ])).rejects.toThrow()

    await writeFile(inventory, `${JSON.stringify({
      groups: [{ tools: [
        { id: 'session_status' },
        { id: 'aiworker_analyze_video' },
        { id: 'aiworker_director_brain' },
        { name: 'read' },
      ] }],
    })}\n`, { mode: 0o600 })
    await expect(execFileAsync(process.execPath, [
      convergenceHelper,
      'verify-effective',
      inventory,
      manifestFile,
    ])).rejects.toThrow()
  })

  it('applies only compaction policy for the sole profile agent and preserves its tools', async () => {
    const entry = await createFixture()

    const result = await run(entry, '--apply')
    const installed = JSON.parse(await readFile(entry.config, 'utf8'))
    const target = installed.agents.list[0]
    const backups = await readdir(entry.backupRoot)

    expect(result.stdout).toContain('bounded transcript convergence')
    expect(installed.agents.defaults.model).toBe(entry.initial.agents.defaults.model)
    expect(installed.agents.defaults.temperature).toBe(0.2)
    expect(installed.agents.defaults.compaction).toEqual({
      reserveTokens: 4096,
      model: 'qwen36-tools-local/default_model',
      timeoutSeconds: 240,
      keepRecentTokens: 8192,
      maxHistoryShare: 0.75,
      truncateAfterCompaction: true,
      maxActiveTranscriptBytes: '128kb',
      notifyUser: false,
      customInstructions: 'Preserve every tool value.',
      identifierPolicy: 'strict',
      recentTurnsPreserve: 4,
      midTurnPrecheck: { minimumBytes: 4096, enabled: true },
    })
    expect(target.tools).toEqual(entry.initial.agents.list[0].tools)
    expect(installed.agents.defaults.compaction).not.toHaveProperty('identifierInstructions')
    expect(installed.agents.list).toHaveLength(1)
    expect(installed.plugins).toEqual(entry.initial.plugins)
    expect(installed.gateway).toEqual(entry.initial.gateway)
    expect(backups).toHaveLength(2)
    const rollback = backups.find(name => name.includes('before-runtime-convergence'))
    const proof = backups.find(name => name.includes('runtime-convergence-proof'))
    expect(rollback).toBeTruthy()
    expect(proof).toBeTruthy()
    expect((await stat(join(entry.backupRoot, rollback!))).mode & 0o777).toBe(0o600)
    expect((await stat(join(entry.backupRoot, proof!))).mode & 0o777).toBe(0o600)
    const calls = await readFile(entry.callLog, 'utf8')
    expect(calls.match(/config patch/gu)).toHaveLength(1)
    expect(calls).toContain('config rpc-patch')
    expect(calls.match(/config patch[^\n]*--dry-run/gu)).toHaveLength(1)
    expect(calls.match(/patch-approved-compaction=true/gu)).toHaveLength(2)
    expect(calls).not.toContain('patch-approved-compaction=false')
    expect(calls).not.toContain(entry.fixtureGatewayToken)
    expect(calls).not.toContain(entry.fixtureSessionKey)
    expect(result.stdout).not.toContain(entry.fixtureGatewayToken)
    expect(result.stderr).not.toContain(entry.fixtureGatewayToken)
    expect(result.stdout).not.toContain(entry.fixtureSessionKey)
    expect(result.stderr).not.toContain(entry.fixtureSessionKey)
    for (const marker of [
      'parent-token-must-not-leak',
      'parent-gateway-token-must-not-leak',
      'parent-openclaw-password-must-not-leak',
      'parent-gateway-password-must-not-leak',
    ]) {
      expect(result.stdout).not.toContain(marker)
      expect(result.stderr).not.toContain(marker)
      expect(calls).not.toContain(marker)
    }
    const auth = await readFile(entry.authLog, 'utf8')
    expect(auth).toContain('version=absent')
    expect(auth).toContain('gateway status --deep=resolved')
    expect(auth).toContain('plugins inspect aiworker-director-brain=resolved')
    expect(auth).toContain('gateway call tools.catalog=resolved')
    expect(auth).toContain('gateway call tools.effective=resolved')
    expect(auth).toContain('config validate=absent')
    expect(auth).toContain('config patch --file=absent')
    expect(auth).not.toContain('unexpected')
    expect(auth).not.toContain(entry.fixtureGatewayToken)
    expect(auth).not.toContain('must-not-leak')
    expect(await readFile(entry.config, 'utf8')).not.toContain(entry.fixtureGatewayToken)
    expect(await readFile(join(entry.backupRoot, rollback!), 'utf8'))
      .not.toContain(entry.fixtureGatewayToken)
    expect(await readFile(join(entry.backupRoot, proof!), 'utf8'))
      .not.toContain(entry.fixtureSessionKey)
    const liveArgv = await readFile(entry.rpcArgvLog, 'utf8')
    expect(liveArgv).not.toContain(entry.fixtureGatewayToken)
    expect(liveArgv).not.toContain(entry.fixtureSessionKey)
    const patchPath = /^config patch --file (\S+) --dry-run$/mu.exec(calls)?.[1]
    expect(patchPath).toBeTruthy()
    expect(await exists(resolve(patchPath!, '..'))).toBe(false)
    expect(await exists(entry.gatewayLog)).toBe(false)
  }, 15_000)

  it('performs a zero-write dry-run and an idempotent repeated apply', async () => {
    const entry = await createFixture()
    const original = await readFile(entry.config, 'utf8')

    const dryRun = await run(entry, '--dry-run')
    expect(dryRun.stdout).toContain('dry-run passed')
    expect(digest(await readFile(entry.config, 'utf8'))).toBe(digest(original))
    expect(await exists(entry.backupRoot)).toBe(false)
    const dryRunCalls = await readFile(entry.callLog, 'utf8')
    const patchPath = /^config patch --file (\S+) --dry-run$/mu.exec(dryRunCalls)?.[1]
    expect(patchPath?.startsWith(
      `${await realpath('/tmp')}/aiworker-openclaw-runtime-convergence.`,
    )).toBe(true)
    expect(dryRunCalls.match(/^config file$/gmu)).toHaveLength(1)
    expect(dryRunCalls.match(/^config validate$/gmu)).toHaveLength(1)
    expect(dryRunCalls.match(/^config patch /gmu)).toHaveLength(1)
    expect(dryRunCalls).not.toMatch(/^config patch (?!.*--dry-run$)/gmu)
    expect(await exists(entry.gatewayLog)).toBe(false)
    expect(await exists(entry.deploymentRunDir)).toBe(false)

    const firstApply = await run(entry, '--apply')
    const applied = await readFile(entry.config, 'utf8')
    const backups = await readdir(entry.backupRoot)
    const proofPath = /Verified session-scoped runtime convergence proof: (.+)$/mu
      .exec(firstApply.stdout)?.[1]
    expect(proofPath).toBeTruthy()
    expect(JSON.parse(await readFile(proofPath!, 'utf8')).schema)
      .toBe('video-autoworker-openclaw-runtime-convergence-proof/v1')
    const repeated = await run(
      entry,
      '--apply',
      '--runtime-convergence-proof',
      proofPath!,
    )
    expect(repeated.stdout).toContain('already current')
    expect(repeated.stdout).toContain('Reused verified session-scoped runtime convergence proof')
    expect(await readFile(entry.config, 'utf8')).toBe(applied)
    const repeatedFiles = await readdir(entry.backupRoot)
    expect(repeatedFiles.filter(name => name.includes('before-runtime-convergence')))
      .toEqual(backups.filter(name => name.includes('before-runtime-convergence')))
    expect(repeatedFiles.filter(name => name.includes('runtime-convergence-proof')))
      .toEqual(backups.filter(name => name.includes('runtime-convergence-proof')))
  }, 20_000)

  it.each([
    ['Gateway status PID mismatch', 'FAKE_STATUS_GATEWAY_PID', '999999'],
    ['missing persistence hook', 'FAKE_MISSING_PERSISTENCE_HOOK', '1'],
    ['Gateway was not freshly restarted after plugin install', 'AIWORKER_OPENCLAW_RUNTIME_TEST_GATEWAY_START_MS', '1'],
  ])('blocks apply on %s without config or backup writes', async (_label, variable, value) => {
    const entry = await createFixture()
    const before = await readFile(entry.config, 'utf8')
    entry.env[variable] = value

    await expect(run(entry, '--apply')).rejects.toMatchObject({
      stderr: expect.stringContaining('requires the installed 0.4.0 persistence hooks'),
    })
    expect(await readFile(entry.config, 'utf8')).toBe(before)
    expect(await exists(entry.backupRoot)).toBe(false)
    expect(await exists(entry.gatewayLog)).toBe(false)
  }, 15_000)

  it('fails closed when the configured Gateway SecretRef cannot be resolved', async () => {
    const entry = await createFixture()
    const config = JSON.parse(await readFile(entry.config, 'utf8'))
    config.secrets.providers['fixture-gateway-token'].command = 'relative-command-is-invalid'
    await writeFile(entry.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    const before = await readFile(entry.config, 'utf8')

    await expect(run(entry, '--apply')).rejects.toMatchObject({
      stderr: expect.stringContaining('Gateway runtime verification failed'),
    })
    expect(await readFile(entry.config, 'utf8')).toBe(before)
    expect(await exists(entry.backupRoot)).toBe(false)
    expect(await exists(entry.gatewayLog)).toBe(false)
  })

  it.each([
    ['plugin tree changes during initial proof', 'FAKE_MUTATE_PLUGIN_ON_CATALOG_CALL', '1'],
    ['config inode changes during initial proof', 'FAKE_REPLACE_CONFIG_ON_CATALOG_CALL', '1'],
    ['required video tool is absent initially', 'FAKE_REMOVE_VIDEO_ON_CATALOG_CALL', '1'],
    ['listener PID changes during initial proof', 'FAKE_LSOF_REPLACEMENT_CALL', '3'],
    ['plugin tree changes after initial proof', 'FAKE_MUTATE_PLUGIN_ON_CATALOG_CALL', '2'],
    ['config inode changes after initial proof', 'FAKE_REPLACE_CONFIG_ON_CATALOG_CALL', '2'],
    ['effective tools shrink after initial proof', 'FAKE_REMOVE_READ_ON_CATALOG_CALL', '2'],
    ['session-effective tools shrink after initial proof', 'FAKE_REMOVE_READ_ON_EFFECTIVE_CALL', '2'],
    ['listener PID changes after initial proof', 'FAKE_LSOF_REPLACEMENT_CALL', '6'],
  ])('rejects when %s before backup creation', async (_label, variable, value) => {
    const entry = await createFixture()
    const before = await readFile(entry.config, 'utf8')
    entry.env[variable] = value
    if (variable === 'FAKE_LSOF_REPLACEMENT_CALL') {
      entry.env.FAKE_REPLACEMENT_GATEWAY_PID = '999999'
    }

    await expect(run(entry, '--apply')).rejects.toThrow()
    expect(await readFile(entry.config, 'utf8')).toBe(before)
    expect(await exists(entry.backupRoot)).toBe(false)
    expect(await exists(entry.gatewayLog)).toBe(false)
  }, 15_000)

  it.each([
    ['effective tools shrink immediately before apply', 'FAKE_REMOVE_READ_ON_CATALOG_CALL', '3'],
    ['effective tools shrink after config hot reload', 'FAKE_REMOVE_READ_ON_CATALOG_CALL', '4'],
    ['session-effective tools shrink immediately before apply', 'FAKE_REMOVE_READ_ON_EFFECTIVE_CALL', '3'],
    ['session-effective tools shrink after config hot reload', 'FAKE_REMOVE_READ_ON_EFFECTIVE_CALL', '4'],
  ])('never accepts %s', async (_label, variable, value) => {
    const entry = await createFixture()
    const before = await readFile(entry.config, 'utf8')
    entry.env[variable] = value

    await expect(run(entry, '--apply')).rejects.toThrow()
    expect(await readFile(entry.config, 'utf8')).toBe(before)
    expect(await readdir(entry.backupRoot)).toHaveLength(1)
    expect(await exists(entry.gatewayLog)).toBe(false)
  }, 15_000)

  it.each([
    ['Gateway health is not active', 'FAKE_HOT_RELOAD_STATUS', 'failed'],
    ['config.patch requires a restart', 'FAKE_PATCH_REQUIRES_RESTART', '1'],
    ['config.patch returns a restart request', 'FAKE_PATCH_RESTART', '1'],
    ['Gateway logs a reload failure', 'FAKE_RELOAD_FAILURE_LOG', '1'],
    ['post-patch config hash is missing', 'FAKE_MISSING_POST_HASH', '1'],
    ['Gateway log cursor does not advance', 'FAKE_CURSOR_DOES_NOT_ADVANCE', '1'],
    ['post-patch config.get differs from config.patch', 'FAKE_POST_CONFIG_MISMATCH', '1'],
  ])('rejects %s and restores only its own exact patch', async (_label, variable, value) => {
    const entry = await createFixture()
    const before = await readFile(entry.config, 'utf8')
    entry.env[variable] = value

    await expect(run(entry, '--apply')).rejects.toMatchObject({
      stderr: expect.stringContaining('restoring the exact pre-apply'),
    })
    expect(await readFile(entry.config, 'utf8')).toBe(before)
    expect(await readdir(entry.backupRoot)).toHaveLength(1)
    expect(await exists(entry.gatewayLog)).toBe(false)
  }, 20_000)

  it('rejects a config.get response without the CAS base hash before patching', async () => {
    const entry = await createFixture()
    const before = await readFile(entry.config, 'utf8')
    entry.env.FAKE_MISSING_BASE_HASH = '1'

    await expect(run(entry, '--apply')).rejects.toMatchObject({
      stderr: expect.stringContaining('Gateway CAS patch was rejected'),
    })
    expect(await readFile(entry.config, 'utf8')).toBe(before)
    expect(await readdir(entry.backupRoot)).toHaveLength(1)
    expect(await exists(entry.gatewayLog)).toBe(false)
  }, 15_000)

  it('accepts only the exact current-HOME tilde path for the target profile config', async () => {
    const accepted = await createFixture()
    accepted.env.FAKE_ACTIVE_CONFIG_OUTPUT = '~/.openclaw-qwen-current/openclaw.json'
    const result = await run(accepted, '--dry-run')
    expect(result.stdout).toContain('dry-run passed')

    for (const source of [
      '~',
      '../.openclaw-qwen-current/openclaw.json',
      '.openclaw-qwen-current/openclaw.json',
      '~root/.openclaw-qwen-current/openclaw.json',
      '~other/.openclaw-qwen-current/openclaw.json',
      '~/../../outside/openclaw.json',
      '~/.openclaw-qwen-current/../outside/openclaw.json',
      '~//.openclaw-qwen-current/openclaw.json',
    ]) {
      const rejected = await createFixture()
      rejected.env.FAKE_ACTIVE_CONFIG_OUTPUT = source
      await expect(run(rejected, '--dry-run')).rejects.toMatchObject({
        stderr: expect.stringContaining('active config path is invalid'),
      })
      expect(await exists(rejected.backupRoot)).toBe(false)
    }

    const linkedAlias = await createFixture()
    const aliasPath = join(linkedAlias.root, 'active-config-alias.json')
    await symlink(linkedAlias.config, aliasPath)
    linkedAlias.env.FAKE_ACTIVE_CONFIG_OUTPUT = aliasPath
    await expect(run(linkedAlias, '--dry-run')).rejects.toMatchObject({
      stderr: expect.stringContaining('active config path is invalid'),
    })
    expect(await exists(linkedAlias.backupRoot)).toBe(false)
  }, 30_000)

  it('rolls both policies back atomically and makes repeated rollback a no-op', async () => {
    const entry = await createFixture()
    const original = await readFile(entry.config, 'utf8')
    const applied = await run(entry, '--apply')
    const backup = /Verified 0600 rollback backup: (.+)$/mu.exec(applied.stdout)?.[1]
    expect(backup).toBeTruthy()
    await rm(join(entry.state, 'extensions/aiworker-director-brain'), { recursive: true })

    const rollback = await run(entry, '--rollback', '--backup', backup as string)
    expect(rollback.stdout).toContain('Rolled back qwen-current runtime convergence')
    expect(await readFile(entry.config, 'utf8')).toBe(original)

    const repeated = await run(entry, '--rollback', '--backup', backup as string)
    expect(repeated.stdout).toContain('already matches')
    expect(await readFile(entry.config, 'utf8')).toBe(original)
    expect(await exists(entry.gatewayLog)).toBe(false)
  }, 15_000)

  it('rejects rollback and proof verification after the profile becomes multi-agent', async () => {
    const rollbackEntry = await createFixture()
    const rollbackBackup = join(rollbackEntry.home, 'single-agent-rollback.json')
    await writeFile(rollbackBackup, await readFile(rollbackEntry.config, 'utf8'), { mode: 0o600 })
    await addProfileAgent(rollbackEntry)
    const drifted = await readFile(rollbackEntry.config, 'utf8')

    await expect(run(
      rollbackEntry,
      '--rollback',
      '--backup',
      rollbackBackup,
    )).rejects.toThrow(/agents\.list must contain only the second-original profile agent/u)
    expect(await readFile(rollbackEntry.config, 'utf8')).toBe(drifted)

    const proofEntry = await createFixture()
    const applied = await run(proofEntry, '--apply')
    const proof = /Verified session-scoped runtime convergence proof: (.+)$/mu
      .exec(applied.stdout)?.[1]
    expect(proof).toBeTruthy()
    await addProfileAgent(proofEntry)
    await expect(execFileAsync(process.execPath, [
      convergenceHelper,
      'assert-convergence-proof',
      proof!,
      manifestFile,
      proofEntry.state,
      proofEntry.config,
    ])).rejects.toThrow(/agents\.list must contain only the second-original profile agent/u)
  }, 20_000)

  it('requires exact OpenClaw and optional plugin readiness gates', async () => {
    const incompatible = await createFixture()
    const incompatibleBefore = await readFile(incompatible.config, 'utf8')
    incompatible.env.FAKE_OPENCLAW_VERSION = '2026.8.0'
    await expect(run(incompatible, '--apply')).rejects.toMatchObject({
      stderr: expect.stringContaining('Unsupported OpenClaw version'),
    })
    expect(await readFile(incompatible.config, 'utf8')).toBe(incompatibleBefore)

    const pluginMissing = await createFixture()
    const missingBefore = await readFile(pluginMissing.config, 'utf8')
    await rm(join(pluginMissing.state, 'extensions/aiworker-director-brain'), { recursive: true })
    await expect(run(pluginMissing, '--apply')).rejects.toThrow()
    expect(await readFile(pluginMissing.config, 'utf8')).toBe(missingBefore)

    const summaryMissing = await createFixture()
    const summaryMissingBefore = await readFile(summaryMissing.config, 'utf8')
    await rm(join(
      summaryMissing.state,
      'extensions/aiworker-director-brain/lib/director-context-summary.js',
    ))
    await expect(run(summaryMissing, '--apply')).rejects.toThrow()
    expect(await readFile(summaryMissing.config, 'utf8')).toBe(summaryMissingBefore)

    const projectionMissing = await createFixture()
    const projectionMissingBefore = await readFile(projectionMissing.config, 'utf8')
    await rm(join(
      projectionMissing.state,
      'extensions/aiworker-director-brain/lib/transcript-tool-result-projection.js',
    ))
    await expect(run(projectionMissing, '--apply')).rejects.toThrow()
    expect(await readFile(projectionMissing.config, 'utf8')).toBe(projectionMissingBefore)

    const sensitiveNarrativeMissing = await createFixture()
    const sensitiveNarrativeMissingBefore = await readFile(
      sensitiveNarrativeMissing.config,
      'utf8',
    )
    await rm(join(
      sensitiveNarrativeMissing.state,
      'extensions/aiworker-director-brain/lib/sensitive-narrative-text.js',
    ))
    await expect(run(sensitiveNarrativeMissing, '--apply')).rejects.toThrow()
    expect(await readFile(sensitiveNarrativeMissing.config, 'utf8'))
      .toBe(sensitiveNarrativeMissingBefore)

    const oldPlugin = await createFixture()
    const oldPluginBefore = await readFile(oldPlugin.config, 'utf8')
    const oldManifestPath = join(
      oldPlugin.state,
      'extensions/aiworker-director-brain/openclaw.plugin.json',
    )
    const oldManifest = JSON.parse(await readFile(oldManifestPath, 'utf8'))
    oldManifest.version = '0.3.0'
    await writeFile(oldManifestPath, `${JSON.stringify(oldManifest, null, 2)}\n`, { mode: 0o600 })
    await expect(run(oldPlugin, '--apply')).rejects.toThrow()
    expect(await readFile(oldPlugin.config, 'utf8')).toBe(oldPluginBefore)
    expect(await exists(oldPlugin.backupRoot)).toBe(false)

    const oldVideoPlugin = await createFixture()
    const oldVideoBefore = await readFile(oldVideoPlugin.config, 'utf8')
    const oldVideoPackagePath = join(
      oldVideoPlugin.state,
      'extensions/aiworker-video-command/package.json',
    )
    const oldVideoPackage = JSON.parse(await readFile(oldVideoPackagePath, 'utf8'))
    oldVideoPackage.version = '0.5.13'
    await writeFile(
      oldVideoPackagePath,
      `${JSON.stringify(oldVideoPackage, null, 2)}\n`,
      { mode: 0o600 },
    )
    await expect(run(oldVideoPlugin, '--apply')).rejects.toMatchObject({
      stderr: expect.stringContaining('required plugin version is not ready: aiworker-video-command'),
    })
    expect(await readFile(oldVideoPlugin.config, 'utf8')).toBe(oldVideoBefore)
    expect(await exists(oldVideoPlugin.backupRoot)).toBe(false)

    const pluginNotReady = await createFixture()
    const notReady = JSON.parse(await readFile(pluginNotReady.config, 'utf8'))
    notReady.plugins.entries['aiworker-video-command'].config.releaseReady = false
    await writeFile(pluginNotReady.config, `${JSON.stringify(notReady, null, 2)}\n`, { mode: 0o600 })
    await expect(run(pluginNotReady, '--apply')).rejects.toThrow()
    expect(await exists(pluginNotReady.backupRoot)).toBe(false)
  }, 15_000)

  it('invalidates runtime proof when either pinned plugin tree changes', async () => {
    const entry = await createFixture()
    const applied = await run(entry, '--apply')
    const proof = /Verified session-scoped runtime convergence proof: (.+)$/mu
      .exec(applied.stdout)?.[1]
    expect(proof).toBeTruthy()

    const videoPackage = join(
      entry.state,
      'extensions/aiworker-video-command/package.json',
    )
    await writeFile(videoPackage, `${await readFile(videoPackage, 'utf8')}\n`, { mode: 0o600 })
    await expect(execFileAsync(process.execPath, [
      convergenceHelper,
      'assert-convergence-proof',
      proof!,
      manifestFile,
      entry.state,
      entry.config,
    ])).rejects.toMatchObject({
      stderr: expect.stringContaining('required plugin tree changed'),
    })
  }, 15_000)

  it('preserves unapproved patch-side mutations instead of risking a concurrent-write overwrite', async () => {
    for (const flag of ['FAKE_EXTRA_CONFIG_ON_APPLY', 'FAKE_EXTRA_META_ON_APPLY'] as const) {
      const entry = await createFixture()
      entry.env[flag] = '1'
      await expect(run(entry, '--apply')).rejects.toMatchObject({
        stderr: expect.stringContaining('MANUAL INSPECTION REQUIRED'),
      })
      const current = JSON.parse(await readFile(entry.config, 'utf8'))
      expect(current.agents.defaults.compaction.keepRecentTokens).toBe(8192)
      if (flag === 'FAKE_EXTRA_CONFIG_ON_APPLY') expect(current.gateway.port).toBe(19993)
      else expect(current.meta.owner).toBe('unexpected')
      expect(await exists(entry.gatewayLog)).toBe(false)
    }
  }, 15_000)

  it('preserves a late multi-agent drift and refuses to overwrite it during recovery', async () => {
    const entry = await createFixture()
    entry.env.FAKE_ADD_AGENT_ON_APPLY = '1'

    await expect(run(entry, '--apply')).rejects.toMatchObject({
      stderr: expect.stringContaining('MANUAL INSPECTION REQUIRED'),
    })
    const current = JSON.parse(await readFile(entry.config, 'utf8'))
    expect(current.agents.list.map((agent: { id: string }) => agent.id))
      .toEqual(['second-original', 'late-agent'])
    expect(current.agents.defaults.compaction.keepRecentTokens).toBe(8192)
    expect(current.agents.defaults.compaction).not.toHaveProperty('identifierInstructions')
    expect(await readdir(entry.backupRoot)).toHaveLength(1)
  }, 15_000)

  it('preserves a concurrent writer instead of overwriting it during recovery', async () => {
    const entry = await createFixture()
    entry.env.FAKE_CONCURRENT_WRITE_ON_VALIDATE_CALL = '2'

    await expect(run(entry, '--apply')).rejects.toMatchObject({
      stderr: expect.stringContaining('MANUAL INSPECTION REQUIRED'),
    })
    const current = JSON.parse(await readFile(entry.config, 'utf8'))
    expect(current.gateway.port).toBe(19991)
    expect(current.agents.defaults.compaction.recentTurnsPreserve).toBe(4)
    expect(current.agents.list[0].tools).toEqual(entry.initial.agents.list[0].tools)
    expect(await readdir(entry.backupRoot)).toHaveLength(1)
  })

  it('refuses a CAS race introduced during official patch preflight', async () => {
    const entry = await createFixture()
    entry.env.FAKE_MUTATE_ON_DRY_RUN = '1'

    await expect(run(entry, '--apply')).rejects.toMatchObject({
      stderr: expect.stringContaining('CAS refused'),
    })
    expect(await exists(entry.backupRoot)).toBe(false)
    expect(await exists(entry.gatewayLog)).toBe(false)
  })

  it('refuses a same-content inode replacement during official patch preflight', async () => {
    const entry = await createFixture()
    entry.env.FAKE_REPLACE_SAME_CONTENT_ON_DRY_RUN = '1'

    await expect(run(entry, '--apply')).rejects.toMatchObject({
      stderr: expect.stringContaining('CAS refused'),
    })
    expect(await exists(entry.backupRoot)).toBe(false)
    expect(await exists(entry.gatewayLog)).toBe(false)
  })

  it('does not touch config or backup while the shared deployment lock is held', async () => {
    const entry = await createFixture()
    const before = await readFile(entry.config, 'utf8')
    const lock = join(entry.deploymentRunDir, '.deployment.lock')
    await mkdir(lock, { recursive: true, mode: 0o700 })
    await writeFile(join(lock, 'pid'), `${JSON.stringify({
      schema: 'video-autoworker-shared-deployment-lock-owner/v1',
      pid: process.pid,
      nonce: 'a'.repeat(64),
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 })

    await expect(run(entry, '--apply')).rejects.toThrow()
    expect(await readFile(entry.config, 'utf8')).toBe(before)
    expect(await exists(entry.backupRoot)).toBe(false)
  })

  it('rejects unsafe active config, plugin, and backup paths before sensitive copies', async () => {
    const wrongConfig = await createFixture()
    const otherState = join(wrongConfig.root, 'other-state')
    const otherConfig = join(otherState, 'openclaw.json')
    await mkdir(otherState, { mode: 0o700 })
    await writeFile(otherConfig, '{}\n', { mode: 0o600 })
    wrongConfig.env.FAKE_ACTIVE_CONFIG_PATH = otherConfig
    await expect(run(wrongConfig, '--apply')).rejects.toThrow()
    expect(await exists(wrongConfig.backupRoot)).toBe(false)

    const pluginLink = await createFixture()
    const realManifest = join(pluginLink.root, 'manifest.json')
    const installedManifest = join(
      pluginLink.state,
      'extensions/aiworker-director-brain/openclaw.plugin.json',
    )
    await writeFile(realManifest, await readFile(installedManifest, 'utf8'), { mode: 0o600 })
    await rm(installedManifest)
    await symlink(realManifest, installedManifest)
    await expect(run(pluginLink, '--apply')).rejects.toThrow()
    expect(await exists(pluginLink.backupRoot)).toBe(false)

    const backupLink = await createFixture()
    const redirected = join(backupLink.root, 'redirected')
    await mkdir(redirected, { mode: 0o700 })
    await symlink(redirected, backupLink.backupRoot)
    await expect(run(backupLink, '--apply')).rejects.toThrow()
    expect(await readdir(redirected)).toEqual([])

    const backupInRepository = await createFixture()
    backupInRepository.env.AIWORKER_OPENCLAW_RUNTIME_BACKUP_ROOT = join(
      repositoryRoot,
      '.forbidden-runtime-config-backups',
    )
    await expect(run(backupInRepository, '--apply')).rejects.toThrow()
    expect(await exists(backupInRepository.env.AIWORKER_OPENCLAW_RUNTIME_BACKUP_ROOT)).toBe(false)

    const backupInState = await createFixture()
    backupInState.env.AIWORKER_OPENCLAW_RUNTIME_BACKUP_ROOT = join(backupInState.state, 'backups')
    await expect(run(backupInState, '--apply')).rejects.toThrow()
    expect(await exists(join(backupInState.state, 'backups'))).toBe(false)
  }, 15_000)

  it('suppresses sensitive config and CLI validation details', async () => {
    const entry = await createFixture()
    const marker = 'never-print-this-sensitive-marker'
    entry.env.FAKE_VALIDATE_FAIL = '1'
    entry.env.FAKE_SENSITIVE_MARKER = marker

    await expect(run(entry, '--apply')).rejects.toMatchObject({
      stdout: expect.not.stringContaining(marker),
      stderr: expect.not.stringContaining(marker),
    })
    expect(await exists(entry.backupRoot)).toBe(false)
    expect(await exists(entry.gatewayLog)).toBe(false)
  })
})
