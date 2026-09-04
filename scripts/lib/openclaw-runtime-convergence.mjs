#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fingerprintOpenClawToolInventory } from './openclaw-tool-capability-fingerprint.mjs'

const GATEWAY_PORT = 18889

function fail(message) {
  throw new Error(message)
}

function readJson(pathname, label) {
  try {
    const value = JSON.parse(fs.readFileSync(pathname, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      fail(`${label} must be a JSON object`)
    }
    return value
  } catch (error) {
    if (error instanceof Error && error.message === `${label} must be a JSON object`) throw error
    fail(`${label} is not valid JSON`)
  }
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  }
  return value
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}

function validateManifest(pathname) {
  const manifest = readJson(pathname, 'runtime convergence manifest')
  const expected = {
    schema: 'video-autoworker-openclaw-runtime-convergence/v1',
    openclawVersion: '2026.7.1-2',
    profile: 'qwen-current',
    compaction: {
      set: {
        model: 'qwen36-tools-local/default_model',
        timeoutSeconds: 240,
        keepRecentTokens: 8_192,
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
  }
  if (!same(manifest, expected)) {
    fail('runtime convergence manifest differs from the approved contract')
  }
  return manifest
}

function exclusiveProfileAgent(config, agentId) {
  const agents = config?.agents?.list
  if (!Array.isArray(agents)) fail('agents.list must be an array')
  if (agents.length !== 1 || agents[0]?.id !== agentId) {
    fail(`agents.list must contain only the ${agentId} profile agent`)
  }
  return agents[0]
}

function assertObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
  return value
}

function assertRequiredConfig(actual, required, label) {
  assertObject(actual, label)
  for (const [key, value] of Object.entries(required)) {
    if (!same(actual[key], value)) fail(`${label}.${key} is not ready`)
  }
}

function assertPhysicalFileInside(root, pathname, label) {
  const rootReal = fs.realpathSync(root)
  const fileReal = fs.realpathSync(pathname)
  const relative = path.relative(rootReal, fileReal)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail(`${label} is outside the qwen-current state directory`)
  }
  let current = pathname
  while (current !== root) {
    const entry = fs.lstatSync(current)
    if (entry.isSymbolicLink()) fail(`${label} contains a symbolic link`)
    current = path.dirname(current)
  }
  const entry = fs.lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`${label} is not a physical file`)
}

function validatePlugin(config, stateDir, descriptor) {
  const pluginConfig = config?.plugins?.entries?.[descriptor.id]
  if (pluginConfig?.enabled !== true) fail(`required plugin is not enabled: ${descriptor.id}`)
  assertRequiredConfig(
    pluginConfig.config,
    descriptor.requiredConfig,
    `required plugin config ${descriptor.id}`,
  )
  if (descriptor.requiredHookConfig) {
    assertRequiredConfig(
      pluginConfig.hooks,
      descriptor.requiredHookConfig,
      `required plugin hook config ${descriptor.id}`,
    )
  }
  const manifestPath = path.join(stateDir, 'extensions', descriptor.id, 'openclaw.plugin.json')
  assertPhysicalFileInside(stateDir, manifestPath, `${descriptor.id} plugin manifest`)
  const pluginManifest = readJson(manifestPath, `${descriptor.id} plugin manifest`)
  if (pluginManifest.id !== descriptor.id
    || (descriptor.version !== undefined && pluginManifest.version !== descriptor.version)
    || !Array.isArray(pluginManifest?.contracts?.tools)
    || !pluginManifest.contracts.tools.includes(descriptor.tool)
    || pluginManifest?.toolMetadata?.[descriptor.tool]?.optional !== true) {
    fail(`required optional plugin contract is not ready: ${descriptor.id}`)
  }
  if (descriptor.version !== undefined) {
    const packagePath = path.join(stateDir, 'extensions', descriptor.id, 'package.json')
    assertPhysicalFileInside(stateDir, packagePath, `${descriptor.id} package manifest`)
    const packageManifest = readJson(packagePath, `${descriptor.id} package manifest`)
    if (packageManifest.version !== descriptor.version) {
      fail(`required plugin version is not ready: ${descriptor.id}`)
    }
  }
  if (descriptor.requiredHooks) {
    const entryPath = path.join(stateDir, 'extensions', descriptor.id, 'index.js')
    const summaryPath = path.join(
      stateDir,
      'extensions',
      descriptor.id,
      'lib',
      'director-context-summary.js',
    )
    const projectionPath = path.join(
      stateDir,
      'extensions',
      descriptor.id,
      'lib',
      'transcript-tool-result-projection.js',
    )
    const routerPath = path.join(
      stateDir,
      'extensions',
      descriptor.id,
      'lib',
      'director-system-question-router.js',
    )
    const sensitiveNarrativePath = path.join(
      stateDir,
      'extensions',
      descriptor.id,
      'lib',
      'sensitive-narrative-text.js',
    )
    assertPhysicalFileInside(stateDir, entryPath, `${descriptor.id} plugin entry`)
    assertPhysicalFileInside(stateDir, summaryPath, `${descriptor.id} persistence summary`)
    assertPhysicalFileInside(stateDir, projectionPath, `${descriptor.id} transcript projection`)
    assertPhysicalFileInside(stateDir, routerPath, `${descriptor.id} system question router`)
    assertPhysicalFileInside(
      stateDir,
      sensitiveNarrativePath,
      `${descriptor.id} sensitive narrative filter`,
    )
    const entrySource = fs.readFileSync(entryPath, 'utf8')
    if (!descriptor.requiredHooks.every(hook => entrySource.includes(`api.on('${hook}'`))
      || entrySource.includes('api.registerCompactionProvider')) {
      fail('required persistence projection hooks are not ready')
    }
  }
}

function assertSource(configPath, stateDir, manifestPath, mode) {
  const manifest = validateManifest(manifestPath)
  const config = readJson(configPath, 'OpenClaw config')
  exclusiveProfileAgent(config, manifest.agent.id)
  if (!['rollback', 'capture-tool-baseline'].includes(mode)) {
    for (const descriptor of manifest.requiredPlugins) validatePlugin(config, stateDir, descriptor)
  }
}

function toolCapabilitiesFromInventory(value, label, agentId) {
  return fingerprintOpenClawToolInventory(value, { label, agentId })
}

function validateToolBaseline(value, manifest) {
  const expectedKeys = [
    'agentId', 'catalogCapabilities', 'catalogSha256', 'catalogToolIds',
    'effectiveCapabilities', 'effectiveSha256', 'effectiveToolIds',
    'profile', 'schema', 'sessionKeySha256',
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !same(Object.keys(value).toSorted(), expectedKeys)
    || value.schema !== 'video-autoworker-openclaw-tool-baseline/v3'
    || value.profile !== manifest.profile || value.agentId !== manifest.agent.id
    || !/^[a-f0-9]{64}$/u.test(value.sessionKeySha256)
    || !Array.isArray(value.catalogToolIds) || !Array.isArray(value.effectiveToolIds)
    || !Array.isArray(value.catalogCapabilities)
    || !Array.isArray(value.effectiveCapabilities)) {
    fail('pre-install tool baseline is invalid')
  }
  const catalogToolIds = value.catalogToolIds.toSorted()
  const effectiveToolIds = value.effectiveToolIds.toSorted()
  if (catalogToolIds.length === 0 || effectiveToolIds.length === 0
    || new Set(catalogToolIds).size !== catalogToolIds.length
    || new Set(effectiveToolIds).size !== effectiveToolIds.length
    || catalogToolIds.some(id => typeof id !== 'string' || id.length === 0)
    || effectiveToolIds.some(id => typeof id !== 'string' || id.length === 0)
    || !same(catalogToolIds, value.catalogToolIds)
    || !same(effectiveToolIds, value.effectiveToolIds)
    || !same(catalogToolIds, value.catalogCapabilities.map(item => item?.id))
    || !same(effectiveToolIds, value.effectiveCapabilities.map(item => item?.id))
    || value.catalogSha256 !== sha256(JSON.stringify(value.catalogCapabilities))
    || value.effectiveSha256 !== sha256(JSON.stringify(value.effectiveCapabilities))) {
    fail('pre-install tool baseline is invalid')
  }
  for (const capabilities of [value.catalogCapabilities, value.effectiveCapabilities]) {
    for (const capability of capabilities) {
      const keys = [
        'channelId', 'descriptorSurfaceSha256', 'id', 'pluginId', 'source',
      ]
      if (!capability || typeof capability !== 'object' || Array.isArray(capability)
        || !same(Object.keys(capability).toSorted(), keys)
        || typeof capability.id !== 'string' || capability.id.length === 0
        || !['core', 'plugin', 'channel', 'mcp'].includes(capability.source)
        || !/^[a-f0-9]{64}$/u.test(capability.descriptorSurfaceSha256)
        || (capability.pluginId !== null && typeof capability.pluginId !== 'string')
        || (capability.channelId !== null && typeof capability.channelId !== 'string')) {
        fail('pre-install tool baseline is invalid')
      }
    }
  }
  return {
    catalogToolIds,
    effectiveToolIds,
    catalogCapabilities: value.catalogCapabilities,
    effectiveCapabilities: value.effectiveCapabilities,
    sessionKeySha256: value.sessionKeySha256,
  }
}

function writeToolBaseline(
  catalogPath,
  effectivePath,
  manifestPath,
  outputPath,
  sessionKeySha256,
) {
  const manifest = validateManifest(manifestPath)
  if (!/^[a-f0-9]{64}$/u.test(sessionKeySha256)) {
    fail('runtime session key digest is invalid')
  }
  const catalog = readEvidenceJson(catalogPath, 'pre-install tool catalog evidence')
  const effective = readEvidenceJson(effectivePath, 'pre-install effective tool evidence')
  const catalogCapabilities = toolCapabilitiesFromInventory(
    catalog.value, 'pre-install tool catalog', manifest.agent.id,
  )
  const effectiveCapabilities = toolCapabilitiesFromInventory(
    effective.value, 'pre-install effective tools', manifest.agent.id,
  )
  const catalogToolIds = catalogCapabilities.map(item => item.id)
  const effectiveToolIds = effectiveCapabilities.map(item => item.id)
  normalizedAbsolute(outputPath, 'pre-install tool baseline')
  const entry = fs.lstatSync(outputPath)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (entry.mode & 0o7777) !== 0o600 || entry.nlink !== 1
    || fs.realpathSync(outputPath) !== outputPath || entry.size !== 0) {
    fail('pre-install tool baseline output is unsafe')
  }
  const value = stable({
    schema: 'video-autoworker-openclaw-tool-baseline/v3',
    profile: manifest.profile,
    agentId: manifest.agent.id,
    catalogToolIds,
    catalogCapabilities,
    catalogSha256: sha256(JSON.stringify(catalogCapabilities)),
    effectiveToolIds,
    effectiveCapabilities,
    effectiveSha256: sha256(JSON.stringify(effectiveCapabilities)),
    sessionKeySha256,
  })
  fs.writeFileSync(outputPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  readPhysicalFile(outputPath, 'pre-install tool baseline')
}

function assertNoToolRegression(
  baselinePath,
  manifest,
  catalogCapabilities,
  effectiveCapabilities,
  sessionKeySha256,
) {
  const baselineFile = readPhysicalFile(baselinePath, 'pre-install tool baseline')
  let baselineValue
  try { baselineValue = JSON.parse(baselineFile.content.toString('utf8')) } catch {
    fail('pre-install tool baseline is not valid JSON')
  }
  const baseline = validateToolBaseline(baselineValue, manifest)
  if (baseline.sessionKeySha256 !== sessionKeySha256) {
    fail('pre-install tool baseline is bound to a different runtime session')
  }
  const allowedAddition = manifest.requiredPlugins
    .find(plugin => plugin.id === 'aiworker-director-brain')?.tool
  const compare = (before, after, label) => {
    const afterById = new Map(after.map(item => [item.id, item]))
    const beforeById = new Map(before.map(item => [item.id, item]))
    const removed = before.filter(item => !afterById.has(item.id)).map(item => item.id)
    const added = after.filter(item => !beforeById.has(item.id)).map(item => item.id)
    if (removed.length > 0 || added.some(id => id !== allowedAddition)) {
      fail(`${label} changed outside the allowed director-brain addition`)
    }
    for (const item of before) {
      if (item.id === allowedAddition || !afterById.has(item.id)) continue
      if (!same(item, afterById.get(item.id))) {
        fail(`${label} descriptor surface changed for existing tool: ${item.id}`)
      }
    }
    return {
      beforeCount: before.length,
      afterCount: after.length,
      added,
      removed,
      sha256: sha256(JSON.stringify(after)),
    }
  }
  return {
    sha256: baselineFile.snapshot.sha256,
    sessionKeySha256,
    catalog: compare(baseline.catalogCapabilities, catalogCapabilities, 'tool catalog'),
    effective: compare(
      baseline.effectiveCapabilities, effectiveCapabilities, 'effective tools',
    ),
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function directorPluginDescriptor(manifest) {
  const matches = manifest.requiredPlugins.filter(descriptor => descriptor.id === 'aiworker-director-brain')
  if (matches.length !== 1 || matches[0].id !== 'aiworker-director-brain'
    || matches[0].version !== '0.4.0' || !Array.isArray(matches[0].requiredHooks)) {
    fail('director-brain runtime plugin descriptor is invalid')
  }
  return matches[0]
}

function secureStateDirectory(stateDir) {
  normalizedAbsolute(stateDir, 'qwen-current state directory')
  const entry = fs.lstatSync(stateDir)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (entry.mode & 0o077) !== 0 || fs.realpathSync(stateDir) !== stateDir) {
    fail('qwen-current state directory is unsafe')
  }
}

function pluginTreeEvidence(stateDir, descriptor) {
  secureStateDirectory(stateDir)
  const root = path.join(stateDir, 'extensions', descriptor.id)
  const rootReal = fs.realpathSync(root)
  const relativeRoot = path.relative(fs.realpathSync(stateDir), rootReal)
  if (!relativeRoot || relativeRoot.startsWith('..') || path.isAbsolute(relativeRoot)) {
    fail('director-brain plugin tree is outside qwen-current state')
  }
  const entries = []
  const rootEntry = fs.lstatSync(rootReal)
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() || rootEntry.uid !== process.getuid()
    || (rootEntry.mode & 0o077) !== 0) fail('director-brain plugin root is unsafe')
  let latestChangeMs = Math.max(rootEntry.mtimeMs, rootEntry.ctimeMs)
  const visit = (pathname, relative) => {
    const children = fs.readdirSync(pathname, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name, 'en'))
    for (const child of children) {
      if (/[/\\\u0000-\u001f\u007f]/u.test(child.name)) fail('plugin tree contains an unsafe name')
      const childPath = path.join(pathname, child.name)
      const childRelative = path.posix.join(relative, child.name)
      const entry = fs.lstatSync(childPath)
      if (entry.isSymbolicLink() || entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0) {
        fail('plugin tree contains an unsafe object')
      }
      latestChangeMs = Math.max(latestChangeMs, entry.mtimeMs, entry.ctimeMs)
      if (entry.isDirectory()) {
        entries.push({ path: childRelative, type: 'directory', mode: entry.mode & 0o7777 })
        visit(childPath, childRelative)
      } else if (entry.isFile()) {
        const content = fs.readFileSync(childPath)
        entries.push({
          path: childRelative,
          type: 'file',
          mode: entry.mode & 0o7777,
          size: content.length,
          sha256: sha256(content),
        })
      } else {
        fail('plugin tree contains an unsupported object')
      }
    }
  }
  visit(rootReal, '')
  if (entries.length === 0) fail('director-brain plugin tree is empty')
  return {
    treeSha256: sha256(JSON.stringify(stable(entries))),
    latestChangeMs,
  }
}

function requiredPluginTreeEvidence(stateDir, manifest) {
  return manifest.requiredPlugins.map(descriptor => ({
    id: descriptor.id,
    version: descriptor.version,
    ...pluginTreeEvidence(stateDir, descriptor),
  })).toSorted((left, right) => left.id.localeCompare(right.id))
}

function runPs(pid, field) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', `${field}=`], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    timeout: 5_000,
  })
  if (result.status !== 0 || result.signal || result.error) fail('Gateway process identity is unavailable')
  return result.stdout.trim()
}

function gatewayProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) fail('Gateway PID is invalid')
  const uid = Number(runPs(pid, 'uid'))
  const ppid = Number(runPs(pid, 'ppid'))
  let startTime = runPs(pid, 'lstart')
  const command = runPs(pid, 'command')
  let startTimeMs = Date.parse(startTime)
  if (process.env.AIWORKER_OPENCLAW_RUNTIME_TEST_MODE === '1'
    && process.env.AIWORKER_OPENCLAW_RUNTIME_TEST_GATEWAY_START_MS) {
    startTimeMs = Number(process.env.AIWORKER_OPENCLAW_RUNTIME_TEST_GATEWAY_START_MS)
    startTime = new Date(startTimeMs).toISOString()
  }
  if (uid !== process.getuid() || !Number.isSafeInteger(ppid) || ppid <= 0
    || !Number.isFinite(startTimeMs) || !command) {
    fail('Gateway process identity is invalid')
  }
  return { pid, uid, startTime, startTimeMs, argvSha256: sha256(command) }
}

function readEvidenceJson(pathname, label) {
  const file = readPhysicalFile(pathname, label)
  let value
  try { value = JSON.parse(file.content.toString('utf8')) } catch { fail(`${label} is not valid JSON`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a JSON object`)
  return { value, sha256: file.snapshot.sha256, snapshot: file.snapshot }
}

function validateRuntimeInspection(value, descriptor) {
  const tools = Array.isArray(value.tools) ? value.tools : []
  const toolNames = tools.flatMap(item => Array.isArray(item?.names) ? item.names : []).sort()
  const diagnostics = Array.isArray(value.diagnostics) ? value.diagnostics : []
  if (value?.plugin?.id !== descriptor.id || value.plugin.status !== 'loaded'
    || value.plugin.version !== descriptor.version || !same(toolNames, [descriptor.tool])
    || !Array.isArray(value.typedHooks)
    || !same(value.typedHooks.toSorted(), (descriptor.requiredHooks || []).toSorted())
    || diagnostics.some(item => item?.level === 'error' || item?.severity === 'error')) {
    fail('director-brain runtime inspection is invalid')
  }
}

function validateRuntimeCatalog(value, manifest, descriptor) {
  if (value.agentId !== manifest.agent.id || !Array.isArray(value.groups)
    || value.groups.some(group => !group || typeof group !== 'object'
      || !Array.isArray(group.tools))) {
    fail('director-brain runtime catalog is invalid')
  }
  const bindings = value.groups.flatMap(group => group.tools.map(tool => ({ group, tool })))
  if (bindings.some(({ tool }) => !tool || typeof tool !== 'object'
    || typeof tool.id !== 'string' || tool.id.length === 0)) {
    fail('director-brain runtime catalog is invalid')
  }
  const toolIds = bindings.map(({ tool }) => tool.id).toSorted()
  if (toolIds.length === 0 || new Set(toolIds).size !== toolIds.length) {
    fail('director-brain runtime catalog is invalid')
  }
  for (const required of manifest.requiredPlugins) {
    if (toolIds.filter(id => id === required.tool).length !== 1) {
      fail(`required runtime tool is missing: ${required.tool}`)
    }
  }
  const matches = bindings.filter(({ tool }) => tool.id === descriptor.tool)
  if (matches.length !== 1) fail('director-brain runtime catalog is invalid')
  const { group, tool } = matches[0]
  if (group?.pluginId !== descriptor.id || group?.source !== 'plugin'
    || tool?.pluginId !== descriptor.id || tool?.source !== 'plugin' || tool?.optional !== true) {
    fail('director-brain runtime catalog binding is invalid')
  }
  const capabilities = toolCapabilitiesFromInventory(
    value, 'director-brain runtime catalog', manifest.agent.id,
  )
  return {
    count: toolIds.length,
    ids: toolIds,
    capabilities,
    sha256: sha256(JSON.stringify(capabilities)),
  }
}

function validateEffectiveInventory(value, manifest) {
  if (value?.agentId !== manifest.agent.id || !Array.isArray(value?.groups)
    || value.groups.some(group => !group || typeof group !== 'object'
      || !Array.isArray(group.tools))) {
    fail('effective tool inventory is invalid')
  }
  if (value.notices !== undefined
    && (!Array.isArray(value.notices) || value.notices.length > 0)) {
    fail('effective tool inventory is incomplete')
  }
  const capabilities = toolCapabilitiesFromInventory(
    value, 'effective tool inventory', manifest.agent.id,
  )
  const toolIds = capabilities.map(item => item.id)
  const rawToolCount = value.groups.flatMap(group => group.tools).length
  if (toolIds.length === 0 || toolIds.length !== rawToolCount
    || new Set(toolIds).size !== toolIds.length) {
    fail('effective tool inventory is invalid')
  }
  for (const required of manifest.requiredPlugins) {
    if (toolIds.filter(id => id === required.tool).length !== 1) {
      fail(`required effective tool is missing: ${required.tool}`)
    }
  }
  return {
    count: toolIds.length,
    ids: toolIds,
    capabilities,
    sha256: sha256(JSON.stringify(capabilities)),
  }
}

function validateGatewayStatus(value, pid, port) {
  const listenerPids = (value?.port?.listeners || []).map(listener => listener?.pid)
  if (value?.service?.runtime?.pid !== pid
    || value.service.runtime.status !== 'running'
    || value.service.runtime.state !== 'active'
    || value?.gateway?.bindHost !== '127.0.0.1'
    || value.gateway.port !== port
    || value?.port?.port !== port
    || value.port.status !== 'busy'
    || listenerPids.length === 0
    || listenerPids.some(listenerPid => listenerPid !== pid)
    || value?.connections?.port !== port
    || value?.rpc?.ok !== true
    || value?.health?.healthy !== true
    || !Array.isArray(value.health.staleGatewayPids)
    || value.health.staleGatewayPids.length !== 0) {
    fail('Gateway status is not bound to the qwen-current listener')
  }
}

function verifyRuntimeHooks(
  stateDir,
  manifestPath,
  pidSource,
  gatewayStatusPath,
  inspectionPath,
  catalogPath,
  effectivePath,
  configPath,
  configSnapshotSource,
  toolBaselinePath,
  sessionKeySha256,
) {
  const manifest = validateManifest(manifestPath)
  const descriptor = directorPluginDescriptor(manifest)
  assertFileSnapshot(configPath, configSnapshotSource)
  exclusiveProfileAgent(readJson(configPath, 'OpenClaw config'), manifest.agent.id)
  const pid = Number(pidSource)
  const identityBefore = gatewayProcessIdentity(pid)
  const treesBefore = requiredPluginTreeEvidence(stateDir, manifest)
  const gatewayStatus = readEvidenceJson(gatewayStatusPath, 'Gateway status evidence')
  const inspection = readEvidenceJson(inspectionPath, 'plugin runtime inspection evidence')
  const catalog = readEvidenceJson(catalogPath, 'tool catalog evidence')
  const effective = readEvidenceJson(effectivePath, 'effective tool evidence')
  validateGatewayStatus(gatewayStatus.value, pid, GATEWAY_PORT)
  validateRuntimeInspection(inspection.value, descriptor)
  const inventory = validateRuntimeCatalog(catalog.value, manifest, descriptor)
  const effectiveInventory = validateEffectiveInventory(effective.value, manifest)
  const preInstallToolBaseline = assertNoToolRegression(
    toolBaselinePath,
    manifest,
    inventory.capabilities,
    effectiveInventory.capabilities,
    sessionKeySha256,
  )
  const identity = gatewayProcessIdentity(pid)
  const trees = requiredPluginTreeEvidence(stateDir, manifest)
  const latestPluginChangeMs = Math.max(...trees.map(tree => tree.latestChangeMs))
  const nextSecondAfterPlugin = (Math.floor(latestPluginChangeMs / 1_000) + 1) * 1_000
  assertFileSnapshot(configPath, configSnapshotSource)
  exclusiveProfileAgent(readJson(configPath, 'OpenClaw config'), manifest.agent.id)
  if (!same(identity, identityBefore) || !same(trees, treesBefore)
    || identity.startTimeMs > Date.now() + 1_000
    || identity.startTimeMs < nextSecondAfterPlugin) {
    fail('Gateway was not freshly started after the installed 0.4.0 plugin tree')
  }
  process.stdout.write(`${JSON.stringify(stable({
    gateway: {
      pid: identity.pid,
      uid: identity.uid,
      startTime: identity.startTime,
      argvSha256: identity.argvSha256,
      port: GATEWAY_PORT,
    },
    plugin: {
      id: descriptor.id,
      version: descriptor.version,
      treeSha256: trees.find(tree => tree.id === descriptor.id)?.treeSha256,
      hooks: descriptor.requiredHooks.toSorted(),
    },
    plugins: trees.map(({ id, version, treeSha256 }) => ({ id, version, treeSha256 })),
    toolInventory: inventory,
    effectiveToolInventory: effectiveInventory,
    preInstallToolBaseline,
  }))}\n`)
}

function mergeCompaction(existing, desired) {
  const current = existing === undefined ? {} : assertObject(existing, 'agents.defaults.compaction')
  const desiredPrecheck = desired.midTurnPrecheck
  const currentPrecheck = current.midTurnPrecheck === undefined
    ? {}
    : assertObject(current.midTurnPrecheck, 'agents.defaults.compaction.midTurnPrecheck')
  return {
    ...current,
    ...desired,
    midTurnPrecheck: {
      ...currentPrecheck,
      ...desiredPrecheck,
    },
  }
}

function render(configPath, manifestPath, patchPath, expectedPath) {
  const manifest = validateManifest(manifestPath)
  const config = readJson(configPath, 'OpenClaw config')
  const agents = assertObject(config.agents, 'agents')
  const defaults = agents.defaults === undefined ? {} : assertObject(agents.defaults, 'agents.defaults')
  exclusiveProfileAgent(config, manifest.agent.id)

  const expectedCompaction = mergeCompaction(defaults.compaction, manifest.compaction.set)
  for (const key of manifest.compaction.remove) delete expectedCompaction[key]
  const patchCompaction = structuredClone(manifest.compaction.set)
  for (const key of manifest.compaction.remove) patchCompaction[key] = null
  const patch = {
    agents: {
      defaults: { compaction: patchCompaction },
    },
  }
  const expected = structuredClone(config)
  expected.agents.defaults ??= {}
  expected.agents.defaults.compaction = expectedCompaction
  fs.writeFileSync(patchPath, `${JSON.stringify(patch, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(expectedPath, `${JSON.stringify(expected, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
}

function stripAutoManagedMeta(config) {
  const clone = structuredClone(config)
  const meta = clone?.meta
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    delete meta.lastTouchedVersion
    delete meta.lastTouchedAt
    if (Object.keys(meta).length === 0) delete clone.meta
  }
  return clone
}

function withoutManagedFields(config, manifest) {
  const clone = stripAutoManagedMeta(config)
  const defaults = clone?.agents?.defaults
  const compaction = defaults?.compaction
  if (compaction && typeof compaction === 'object' && !Array.isArray(compaction)) {
    const managedCompactionKeys = new Set([
      ...Object.keys(manifest.compaction.set),
      ...manifest.compaction.remove,
    ])
    for (const key of managedCompactionKeys) {
      if (key !== 'midTurnPrecheck') delete compaction[key]
    }
    const precheck = compaction.midTurnPrecheck
    if (precheck && typeof precheck === 'object' && !Array.isArray(precheck)) {
      for (const key of Object.keys(manifest.compaction.set.midTurnPrecheck)) delete precheck[key]
      if (Object.keys(precheck).length === 0) delete compaction.midTurnPrecheck
    }
    if (Object.keys(compaction).length === 0) delete defaults.compaction
  }
  exclusiveProfileAgent(clone, manifest.agent.id)
  return clone
}

function assertTarget(config, manifest) {
  const installedCompaction = config?.agents?.defaults?.compaction
  if (!installedCompaction || typeof installedCompaction !== 'object'
    || Array.isArray(installedCompaction)) {
    fail('approved compaction policy is missing')
  }
  for (const [key, expected] of Object.entries(manifest.compaction.set)) {
    if (key === 'midTurnPrecheck') {
      for (const [precheckKey, precheckValue] of Object.entries(expected)) {
        if (!same(installedCompaction.midTurnPrecheck?.[precheckKey], precheckValue)) {
          fail(`compaction.midTurnPrecheck.${precheckKey} was not installed exactly`)
        }
      }
    } else if (!same(installedCompaction[key], expected)) {
      fail(`compaction.${key} was not installed exactly`)
    }
  }
  for (const key of manifest.compaction.remove) {
    if (Object.hasOwn(installedCompaction, key)) {
      fail(`compaction.${key} was not removed`)
    }
  }

  exclusiveProfileAgent(config, manifest.agent.id)
}

function verifyDifference(beforePath, afterPath, manifestPath, requireTarget) {
  const manifest = validateManifest(manifestPath)
  const before = readJson(beforePath, 'before config')
  const after = readJson(afterPath, 'after config')
  if (!same(withoutManagedFields(before, manifest), withoutManagedFields(after, manifest))) {
    fail('config changed outside the unified runtime convergence fields')
  }
  if (requireTarget === 'yes') assertTarget(after, manifest)
}

function semanticEqual(leftPath, rightPath, manifestPath) {
  const manifest = validateManifest(manifestPath)
  const leftConfig = readJson(leftPath, 'left config')
  const rightConfig = readJson(rightPath, 'right config')
  exclusiveProfileAgent(leftConfig, manifest.agent.id)
  exclusiveProfileAgent(rightConfig, manifest.agent.id)
  const left = stripAutoManagedMeta(leftConfig)
  const right = stripAutoManagedMeta(rightConfig)
  if (!same(left, right)) process.exitCode = 1
}

function configScopeSnapshot(configPath, manifestPath, emit = true) {
  const manifest = validateManifest(manifestPath)
  const file = readEvidenceJson(configPath, 'OpenClaw config')
  exclusiveProfileAgent(file.value, manifest.agent.id)
  if (emit) process.stdout.write(`${JSON.stringify(file.snapshot)}\n`)
  return file.snapshot
}

function assertConfigScopeSnapshot(configPath, snapshotSource, manifestPath) {
  const current = configScopeSnapshot(configPath, manifestPath, false)
  if (!same(current, parseSnapshot(snapshotSource))) fail('file snapshot changed')
}

function readConfigBaseHash(pathname, manifestPath) {
  const value = readEvidenceJson(pathname, 'Gateway config.get evidence').value
  const manifest = validateManifest(manifestPath)
  if (value?.exists !== true || value.valid !== true || !/^[a-f0-9]{64}$/u.test(value.hash)
    || !value.config || typeof value.config !== 'object' || Array.isArray(value.config)) {
    fail('Gateway config.get evidence is invalid')
  }
  exclusiveProfileAgent(value.config, manifest.agent.id)
  process.stdout.write(`${value.hash}\n`)
}

function readLogCursor(pathname) {
  const value = readEvidenceJson(pathname, 'Gateway log cursor evidence').value
  if (!Number.isSafeInteger(value?.cursor) || value.cursor < 0
    || !Array.isArray(value.lines)) fail('Gateway log cursor evidence is invalid')
  process.stdout.write(`${value.cursor}\n`)
}

function verifyHotReload(
  healthPath,
  logsPath,
  patchResultPath,
  postConfigGetPath,
  manifestPath,
  pidSource,
  baseHash,
  cursorSource,
) {
  const manifest = validateManifest(manifestPath)
  const health = readEvidenceJson(healthPath, 'Gateway hot-reload health evidence').value
  const logs = readEvidenceJson(logsPath, 'Gateway hot-reload log evidence').value
  const patch = readEvidenceJson(patchResultPath, 'Gateway config.patch evidence').value
  const postConfigGet = readEvidenceJson(
    postConfigGetPath,
    'post-patch Gateway config.get evidence',
  ).value
  const pid = Number(pidSource)
  const cursor = Number(cursorSource)
  if (!Number.isSafeInteger(pid) || pid <= 0
    || !/^[a-f0-9]{64}$/u.test(baseHash)
    || !Number.isSafeInteger(cursor) || cursor < 0
    || health?.configReload?.hotReloadStatus !== 'active'
    || !Number.isSafeInteger(logs?.cursor) || logs.cursor <= cursor
    || !Array.isArray(logs.lines) || logs.lines.length === 0
    || patch?.ok !== true || patch?.noop === true
    || patch?.sentinel?.payload?.stats?.requiresRestart !== false
    || (patch.restart !== undefined && patch.restart !== null)
    || postConfigGet?.exists !== true || postConfigGet?.valid !== true
    || !/^[a-f0-9]{64}$/u.test(postConfigGet.hash)
    || postConfigGet.hash === baseHash
    || !same(postConfigGet.config, patch.config)) {
    fail('Gateway hot-reload proof is invalid')
  }
  assertTarget(patch.config, manifest)
  assertTarget(postConfigGet.config, manifest)
  const logText = logs.lines.join('\n')
  if (!/config hot reload applied \([^\n]*agents\.defaults\.compaction[^\n]*\)/u.test(logText)
    || /config reload failed|config hot-reload disabled|requires gateway restart|restart pending/iu.test(logText)) {
    fail('Gateway did not prove a clean compaction hot reload')
  }
  const compaction = stable(Object.fromEntries(
    Object.keys(manifest.compaction.set).map(key => [key, patch.config.agents.defaults.compaction[key]]),
  ))
  process.stdout.write(`${JSON.stringify(stable({
    schema: 'video-autoworker-openclaw-hot-reload-proof/v2',
    pid,
    hotReloadStatus: health.configReload.hotReloadStatus,
    restartPending: false,
    reloadFailure: false,
    compaction,
    baseHash,
    newHash: postConfigGet.hash,
    logCursorStart: cursor,
    logCursorEnd: logs.cursor,
    logSha256: sha256(JSON.stringify(logs.lines)),
  }))}\n`)
}

function verifyStartupLoaded(runtimePath, healthPath, manifestPath, configPath) {
  const runtime = readJson(runtimePath, 'runtime convergence evidence')
  const health = readEvidenceJson(healthPath, 'Gateway startup-load health evidence').value
  const manifest = validateManifest(manifestPath)
  const configFile = readEvidenceJson(configPath, 'OpenClaw config')
  const config = configFile.value
  assertTarget(config, manifest)
  const startTimeMs = Date.parse(runtime?.gateway?.startTime)
  const configMtimeMs = Number(BigInt(configFile.snapshot.mtimeNs) / 1_000_000n)
  if (!Number.isFinite(startTimeMs) || startTimeMs < configMtimeMs
    || health?.configReload?.hotReloadStatus !== 'active') {
    fail('Gateway startup does not prove the current compaction config was loaded')
  }
  const compaction = stable(Object.fromEntries(
    Object.keys(manifest.compaction.set).map(key => [key, config.agents.defaults.compaction[key]]),
  ))
  process.stdout.write(`${JSON.stringify(stable({
    schema: 'video-autoworker-openclaw-hot-reload-proof/v2',
    pid: runtime.gateway.pid,
    hotReloadStatus: health.configReload.hotReloadStatus,
    restartPending: false,
    reloadFailure: false,
    loadSource: 'gateway-startup-after-config',
    compaction,
    baseHash: null,
    newHash: configFile.snapshot.sha256,
    logCursorStart: null,
    logCursorEnd: null,
    logSha256: null,
  }))}\n`)
}

function validateHotReloadProof(value, configSha256) {
  if (value?.schema !== 'video-autoworker-openclaw-hot-reload-proof/v2'
    || value.hotReloadStatus !== 'active'
    || value.restartPending !== false
    || value.reloadFailure !== false
    || !/^[a-f0-9]{64}$/u.test(value.newHash)
    || value.newHash !== configSha256) return false
  if (value.loadSource === 'gateway-startup-after-config') {
    return value.baseHash === null
      && value.logCursorStart === null
      && value.logCursorEnd === null
      && value.logSha256 === null
  }
  return /^[a-f0-9]{64}$/u.test(value.baseHash)
    && value.baseHash !== value.newHash
    && Number.isSafeInteger(value.logCursorStart)
    && value.logCursorStart >= 0
    && Number.isSafeInteger(value.logCursorEnd)
    && value.logCursorEnd > value.logCursorStart
    && /^[a-f0-9]{64}$/u.test(value.logSha256)
}

function writeConvergenceProof(
  runtimePath,
  hotReloadPath,
  manifestPath,
  configPath,
  outputPath,
) {
  const manifest = validateManifest(manifestPath)
  const runtime = readJson(runtimePath, 'runtime convergence evidence')
  const hotReload = readJson(hotReloadPath, 'hot-reload convergence evidence')
  const configSnapshot = configScopeSnapshot(configPath, manifestPath, false)
  if (!validateHotReloadProof(hotReload, configSnapshot.sha256)
    || runtime?.gateway?.pid !== hotReload.pid
    || runtime?.preInstallToolBaseline?.sessionKeySha256 === undefined
    || !/^[a-f0-9]{64}$/u.test(runtime.preInstallToolBaseline.sessionKeySha256)) {
    fail('runtime convergence evidence is invalid')
  }
  const entry = fs.lstatSync(normalizedAbsolute(outputPath, 'runtime convergence proof'))
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || entry.nlink !== 1 || (entry.mode & 0o7777) !== 0o600 || entry.size !== 0) {
    fail('runtime convergence proof output is unsafe')
  }
  const proof = stable({
    schema: 'video-autoworker-openclaw-runtime-convergence-proof/v1',
    createdAt: new Date().toISOString(),
    profile: manifest.profile,
    agentId: manifest.agent.id,
    manifestSha256: publicSourceFileSha256(manifestPath, 'runtime convergence manifest'),
    configSnapshot,
    runtime,
    hotReload,
  })
  fs.writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 })
  readPhysicalFile(outputPath, 'runtime convergence proof')
}

export function assertConvergenceProof(proofPath, manifestPath, stateDir, configPath, emit = true) {
  const manifest = validateManifest(manifestPath)
  const proofFile = readPhysicalFile(proofPath, 'runtime convergence proof')
  let proof
  try { proof = JSON.parse(proofFile.content.toString('utf8')) } catch {
    fail('runtime convergence proof is not JSON')
  }
  if (proof?.schema !== 'video-autoworker-openclaw-runtime-convergence-proof/v1'
    || proof.profile !== manifest.profile || proof.agentId !== manifest.agent.id
    || proof.manifestSha256 !== publicSourceFileSha256(
      manifestPath, 'runtime convergence manifest',
    )
    || !Number.isFinite(Date.parse(proof.createdAt))
    || Date.now() - Date.parse(proof.createdAt) < -5_000
    || Date.now() - Date.parse(proof.createdAt) > 30 * 60 * 1_000
    || !validateHotReloadProof(proof.hotReload, proof.configSnapshot?.sha256)
    || proof.runtime?.gateway?.pid !== proof.hotReload.pid
    || !/^[a-f0-9]{64}$/u.test(proof.runtime?.preInstallToolBaseline?.sessionKeySha256)) {
    fail('runtime convergence proof is invalid or stale')
  }
  if (!same(configScopeSnapshot(configPath, manifestPath, false), proof.configSnapshot)) {
    fail('OpenClaw config changed after runtime convergence proof')
  }
  const currentPlugins = requiredPluginTreeEvidence(stateDir, manifest)
    .map(({ id, version, treeSha256 }) => ({ id, version, treeSha256 }))
  if (!same(currentPlugins, proof.runtime?.plugins)) {
    fail('required plugin tree changed after runtime convergence proof')
  }
  const identity = gatewayProcessIdentity(proof.runtime.gateway.pid)
  if (identity.argvSha256 !== proof.runtime.gateway.argvSha256
    || identity.startTime !== proof.runtime.gateway.startTime
    || identity.uid !== proof.runtime.gateway.uid) {
    fail('Gateway changed after runtime convergence proof')
  }
  const summary = stable({
    schema: proof.schema,
    sha256: proofFile.snapshot.sha256,
    createdAt: proof.createdAt,
    sessionKeySha256: proof.runtime.preInstallToolBaseline.sessionKeySha256,
    catalogSha256: proof.runtime.toolInventory.sha256,
    effectiveSha256: proof.runtime.effectiveToolInventory.sha256,
    pluginTreesSha256: sha256(JSON.stringify(proof.runtime.plugins)),
    gatewayPid: proof.runtime.gateway.pid,
  })
  if (emit) process.stdout.write(`${JSON.stringify(summary)}\n`)
  return summary
}

function verifyEffective(inventoryPath, manifestPath) {
  const manifest = validateManifest(manifestPath)
  const inventory = readJson(inventoryPath, 'tools.effective inventory')
  if (!Array.isArray(inventory.groups)
    || inventory.groups.some(group => !group || typeof group !== 'object'
      || !Array.isArray(group.tools))) {
    fail('tools.effective inventory is malformed')
  }
  const tools = inventory.groups.flatMap(group => group.tools)
  if (tools.some(tool => !tool || typeof tool !== 'object'
    || typeof tool.id !== 'string' || tool.id.length === 0)) {
    fail('tools.effective inventory is malformed')
  }
  const ids = tools.map(tool => tool.id)
  const required = manifest.requiredPlugins.map(plugin => plugin.tool)
  if (new Set(ids).size !== ids.length || required.some(id => !ids.includes(id))) {
    fail('tools.effective is missing a required AI-worker tool or contains duplicates')
  }
}

function assertBackup(pathname) {
  fileSnapshot(pathname, 'rollback backup')
  readJson(pathname, 'rollback backup')
}

function assertConfigBackup(pathname, manifestPath) {
  const manifest = validateManifest(manifestPath)
  const backup = readPhysicalFile(pathname, 'rollback backup')
  let value
  try { value = JSON.parse(backup.content.toString('utf8')) } catch {
    fail('rollback backup is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('rollback backup must be a JSON object')
  }
  exclusiveProfileAgent(value, manifest.agent.id)
}

function normalizedAbsolute(pathname, label) {
  if (!path.isAbsolute(pathname) || path.resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) {
    fail(`${label} must be one normalized absolute path`)
  }
  return pathname
}

function publicSourceFileSha256(pathname, label) {
  normalizedAbsolute(pathname, label)
  const entry = fs.lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (entry.mode & 0o022) !== 0 || fs.realpathSync(pathname) !== pathname) {
    fail(`${label} must be an owned physical non-writable source file`)
  }
  return sha256(fs.readFileSync(pathname))
}

function snapshotIdentity(entry) {
  return {
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    uid: Number(entry.uid),
    mode: Number(entry.mode & 0o7777n),
    nlink: entry.nlink.toString(),
    size: entry.size.toString(),
    mtimeNs: entry.mtimeNs.toString(),
    ctimeNs: entry.ctimeNs.toString(),
  }
}

function sameSnapshotIdentity(left, right) {
  return same(left, right)
}

function readPhysicalFile(pathname, label) {
  normalizedAbsolute(pathname, label)
  const entry = fs.lstatSync(pathname, { bigint: true })
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n
    || entry.uid !== BigInt(process.getuid()) || Number(entry.mode & 0o7777n) !== 0o600
    || fs.realpathSync(pathname) !== pathname) {
    fail(`${label} must be an owned physical 0600 regular file`)
  }
  const descriptor = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true })
    if (!sameSnapshotIdentity(snapshotIdentity(entry), snapshotIdentity(opened))) {
      fail(`${label} changed before read`)
    }
    const content = fs.readFileSync(descriptor)
    const after = fs.fstatSync(descriptor, { bigint: true })
    const current = fs.lstatSync(pathname, { bigint: true })
    if (!sameSnapshotIdentity(snapshotIdentity(opened), snapshotIdentity(after))
      || !sameSnapshotIdentity(snapshotIdentity(opened), snapshotIdentity(current))
      || BigInt(content.length) !== opened.size) {
      fail(`${label} changed during read`)
    }
    return {
      content,
      snapshot: {
        ...snapshotIdentity(opened),
        sha256: createHash('sha256').update(content).digest('hex'),
      },
    }
  } finally {
    fs.closeSync(descriptor)
  }
}

function fileSnapshot(pathname, label = 'file') {
  return readPhysicalFile(pathname, label).snapshot
}

function parseSnapshot(source) {
  let value
  try { value = JSON.parse(source) } catch { fail('file snapshot is invalid') }
  const keys = ['ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'sha256', 'size', 'uid']
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !same(Object.keys(value).sort(), keys)
    || !/^[a-f0-9]{64}$/u.test(value.sha256)) fail('file snapshot is invalid')
  return value
}

function assertFileSnapshot(pathname, source) {
  if (!same(fileSnapshot(pathname), parseSnapshot(source))) fail('file snapshot changed')
}

function fsyncDirectory(pathname) {
  const descriptor = fs.openSync(
    pathname,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  )
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function atomicReplace(source, destination, expectedSource, manifestPath) {
  const manifest = validateManifest(manifestPath)
  const expected = parseSnapshot(expectedSource)
  const sourceFile = readPhysicalFile(source, 'atomic replacement source')
  let sourceConfig
  try { sourceConfig = JSON.parse(sourceFile.content.toString('utf8')) } catch {
    fail('atomic replacement source is not valid JSON')
  }
  if (!sourceConfig || typeof sourceConfig !== 'object' || Array.isArray(sourceConfig)) {
    fail('atomic replacement source must be a JSON object')
  }
  exclusiveProfileAgent(sourceConfig, manifest.agent.id)
  assertConfigScopeSnapshot(destination, expectedSource, manifestPath)
  const directory = path.dirname(normalizedAbsolute(destination, 'atomic replacement destination'))
  const directoryEntry = fs.lstatSync(directory, { bigint: true })
  if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()
    || directoryEntry.uid !== BigInt(process.getuid())
    || Number(directoryEntry.mode & 0o077n) !== 0
    || fs.realpathSync(directory) !== directory) {
    fail('atomic replacement directory is unsafe')
  }
  const temporary = path.join(
    directory,
    `.openclaw-runtime-convergence.${process.pid}.${randomBytes(16).toString('hex')}`,
  )
  let descriptor
  try {
    descriptor = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    )
    fs.writeFileSync(descriptor, sourceFile.content)
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    assertConfigScopeSnapshot(destination, JSON.stringify(expected), manifestPath)
    fs.renameSync(temporary, destination)
    fsyncDirectory(directory)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    try { fs.unlinkSync(temporary) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right)
  const reverse = path.relative(right, left)
  const contains = value => value === '' || (!value.startsWith('..') && !path.isAbsolute(value))
  return contains(relative) || contains(reverse)
}

function prepareBackupRoot(input, home, repositoryRoot, stateDir) {
  if (!path.isAbsolute(input) || path.resolve(input) !== input) {
    fail('backup root must be one normalized absolute path')
  }
  if ([path.parse(input).root, path.resolve(home)].includes(input)
    || pathsOverlap(input, path.resolve(repositoryRoot))
    || pathsOverlap(input, path.resolve(stateDir))) {
    fail('backup root is overly broad')
  }
  const parsed = path.parse(input)
  let current = parsed.root
  for (const component of input.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component)
    try {
      const entry = fs.lstatSync(current)
      if (entry.isSymbolicLink() || !entry.isDirectory()) {
        fail(`backup root component is unsafe: ${current}`)
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
      fs.mkdirSync(current, { mode: 0o700 })
    }
  }
  const entry = fs.lstatSync(input)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (entry.mode & 0o7777) !== 0o700 || fs.realpathSync(input) !== input) {
    fail('backup root must be an owned physical mode-0700 directory')
  }
}

const isMain = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
const [command, ...args] = process.argv.slice(2)
if (!isMain) {
  // Imported by release-readiness and canary modules; do not run the CLI dispatcher.
} else if (command === 'validate-manifest' && args.length === 1) validateManifest(args[0])
else if (command === 'assert-source' && args.length === 4) assertSource(...args)
else if (command === 'write-tool-baseline' && args.length === 5) writeToolBaseline(...args)
else if (command === 'render' && args.length === 4) render(...args)
else if (command === 'verify-difference' && args.length === 4) verifyDifference(...args)
else if (command === 'semantic-equal' && args.length === 3) semanticEqual(...args)
else if (command === 'read-config-base-hash' && args.length === 2) readConfigBaseHash(...args)
else if (command === 'read-log-cursor' && args.length === 1) readLogCursor(args[0])
else if (command === 'verify-hot-reload' && args.length === 8) verifyHotReload(...args)
else if (command === 'verify-startup-loaded' && args.length === 4) verifyStartupLoaded(...args)
else if (command === 'write-convergence-proof' && args.length === 5) writeConvergenceProof(...args)
else if (command === 'assert-convergence-proof' && args.length === 4) assertConvergenceProof(...args)
else if (command === 'verify-effective' && args.length === 2) verifyEffective(...args)
else if (command === 'verify-runtime-hooks' && args.length === 11) verifyRuntimeHooks(...args)
else if (command === 'assert-backup' && args.length === 1) assertBackup(args[0])
else if (command === 'assert-config-backup' && args.length === 2) assertConfigBackup(...args)
else if (command === 'file-snapshot' && args.length === 1) {
  process.stdout.write(`${JSON.stringify(fileSnapshot(args[0], 'OpenClaw config'))}\n`)
} else if (command === 'assert-file-snapshot' && args.length === 2) assertFileSnapshot(...args)
else if (command === 'config-scope-snapshot' && args.length === 2) configScopeSnapshot(...args)
else if (command === 'assert-config-scope-snapshot' && args.length === 3) {
  assertConfigScopeSnapshot(...args)
} else if (command === 'atomic-replace' && args.length === 4) atomicReplace(...args)
else if (command === 'prepare-backup-root' && args.length === 4) prepareBackupRoot(...args)
else fail('invalid openclaw-runtime-convergence command')
