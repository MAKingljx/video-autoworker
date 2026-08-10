#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const ALLOWED_META_CHANGES = new Set(['lastTouchedAt', 'lastTouchedVersion'])
const REQUIRED_NEW_HOOKS = [
  'before_dispatch',
  'before_prompt_build',
  'before_tool_call',
]
const ACTIVE_ROLLBACK_MARKER = '.active-rollback-source.json'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function clone(value) {
  return structuredClone(value)
}

async function fingerprintPluginPayload(root) {
  const hash = createHash('sha256')

  async function visit(pathname, relativePath) {
    const stat = await lstat(pathname)
    hash.update(`${relativePath}\0`)
    if (stat.isSymbolicLink()) {
      hash.update(`link\0${await readlink(pathname)}\0`)
      return
    }
    if (stat.isFile()) {
      hash.update('file\0')
      hash.update(await readFile(pathname))
      hash.update('\0')
      return
    }
    assert(stat.isDirectory(), `Unsupported filesystem object: ${relativePath}`)
    hash.update('dir\0')
    for (const name of (await readdir(pathname)).sort()) {
      await visit(join(pathname, name), relativePath === '.' ? name : `${relativePath}/${name}`)
    }
  }

  await visit(root, '.')
  return hash.digest('hex')
}

function assertSafeAbsolutePath(pathname, label) {
  assert(typeof pathname === 'string' && pathname.length > 0, `${label} must be a non-empty string.`)
  assert(!/[\u0000-\u001f\u007f]/u.test(pathname), `${label} must not contain control characters.`)
  assert(isAbsolute(pathname) && resolve(pathname) === pathname, `${label} must be a normalized absolute path.`)
}

async function assertDirectoryMode(pathname, expectedMode, label) {
  const stat = await lstat(pathname)
  assert(stat.isDirectory() && !stat.isSymbolicLink(), `${label} must be a real directory.`)
  assert((stat.mode & 0o777) === expectedMode, `${label} must have mode ${expectedMode.toString(8)}.`)
}

async function assertRealDirectory(pathname, label) {
  const stat = await lstat(pathname)
  assert(stat.isDirectory() && !stat.isSymbolicLink(), `${label} must be a real directory.`)
}

async function assertRegularFileMode(pathname, expectedMode, label) {
  const stat = await lstat(pathname)
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file.`)
  assert((stat.mode & 0o777) === expectedMode, `${label} must have mode ${expectedMode.toString(8)}.`)
}

async function readJson(pathname, label) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(pathname, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${label} must be a JSON object.`)
  return parsed
}

function stringArray(value, label, { required = false } = {}) {
  if (value === undefined && !required) return []
  assert(Array.isArray(value), `${label} must be an array.`)
  assert(value.every(item => typeof item === 'string' && item.trim()), `${label} must contain non-empty strings.`)
  assert(new Set(value).size === value.length, `${label} must not contain duplicates.`)
  return value
}

function agents(config) {
  assert(Array.isArray(config?.agents?.list), 'agents.list must be an array.')
  return config.agents.list
}

function uniqueTargetAgent(config, agentId) {
  const matches = agents(config).map((agent, index) => ({ agent, index }))
    .filter(({ agent }) => agent?.id === agentId)
  assert(matches.length === 1, `agents.list must contain exactly one ${agentId} agent.`)
  return matches[0]
}

function assertToolNotGrantedOutsideTarget(config, agentId, toolName) {
  for (const [label, value] of [
    ['tools.allow', config?.tools?.allow],
    ['tools.alsoAllow', config?.tools?.alsoAllow],
  ]) {
    if (value === undefined) continue
    assert(!stringArray(value, label).includes(toolName), `${label} must not grant ${toolName}.`)
  }

  for (const agent of agents(config)) {
    if (agent?.id === agentId) continue
    for (const key of ['allow', 'alsoAllow']) {
      const value = agent?.tools?.[key]
      if (value === undefined) continue
      assert(
        !stringArray(value, `agents.${agent?.id ?? 'unknown'}.tools.${key}`).includes(toolName),
        `Only ${agentId} may grant ${toolName}.`,
      )
    }
  }
}

export function buildConfigPlan(config, effectiveBaseline, {
  pluginId,
  agentId,
  toolName,
}) {
  const pluginAllow = stringArray(config?.plugins?.allow, 'plugins.allow', { required: true })
  assert(pluginAllow.length > 0, 'plugins.allow must be non-empty.')
  assert(pluginAllow.includes(pluginId), `plugins.allow must already contain ${pluginId}.`)
  assert(config?.plugins?.entries?.[pluginId]?.enabled === true, `${pluginId} must already be enabled.`)

  const { agent, index } = uniqueTargetAgent(config, agentId)
  const allow = stringArray(agent?.tools?.allow, `${agentId}.tools.allow`, { required: true })
  assert(allow.length > 0, `${agentId}.tools.allow must be non-empty.`)
  assert(!allow.includes(toolName), `${toolName} must not be added to tools.allow.`)
  assert(agent?.tools?.alsoAllow === undefined, `${agentId}.tools.alsoAllow must remain unset.`)
  assertToolNotGrantedOutsideTarget(config, agentId, toolName)

  const baselineIds = effectiveToolIds(effectiveBaseline, { agentId })
  assert(!baselineIds.includes(toolName), 'Effective baseline must not contain the candidate tool.')
  const baselineSet = new Set(baselineIds)
  const effectiveAllow = allow.filter(id => baselineSet.has(id))
  assert(
    effectiveAllow.length === baselineIds.length,
    `${agentId}.tools.allow must contain every effective baseline tool.`,
  )

  return {
    agentIndex: index,
    originalAllow: [...allow],
    originalProfile: agent?.tools?.profile,
    effectiveAllow,
    removedInactiveAllow: allow.filter(id => !baselineSet.has(id)),
    nextTools: {
      ...clone(agent.tools),
      profile: 'full',
      allow: [...effectiveAllow, toolName],
    },
  }
}

function withoutAllowedMetaChanges(config) {
  const copy = clone(config)
  if (!copy.meta || typeof copy.meta !== 'object' || Array.isArray(copy.meta)) return copy
  for (const key of ALLOWED_META_CHANGES) delete copy.meta[key]
  if (Object.keys(copy.meta).length === 0) delete copy.meta
  return copy
}

export function validateConfigAfter(before, after, effectiveBaseline, options) {
  const plan = buildConfigPlan(before, effectiveBaseline, options)
  const target = uniqueTargetAgent(after, options.agentId)
  assert(target.index === plan.agentIndex, 'The target agent index changed during upgrade.')

  const expected = clone(before)
  expected.agents.list[plan.agentIndex].tools = {
    ...expected.agents.list[plan.agentIndex].tools,
    profile: 'full',
    allow: [...plan.effectiveAllow, options.toolName],
  }

  assert(
    isDeepStrictEqual(withoutAllowedMetaChanges(after), withoutAllowedMetaChanges(expected)),
    'Config changed outside the approved target profile and tools.allow update.',
  )
  assert(
    isDeepStrictEqual(after.plugins?.allow, before.plugins?.allow),
    'plugins.allow changed during upgrade.',
  )
  assert(
    isDeepStrictEqual(target.agent?.tools?.allow, [...plan.effectiveAllow, options.toolName]),
    'tools.allow must equal the effective baseline plus the approved tool.',
  )
  assert(
    target.agent?.tools?.profile === 'full' && target.agent?.tools?.alsoAllow === undefined,
    'The target agent must use profile full without tools.alsoAllow.',
  )
  assertToolNotGrantedOutsideTarget(after, options.agentId, options.toolName)
}

function effectiveToolIds(report, { agentId }) {
  assert(report && typeof report === 'object' && !Array.isArray(report), 'Effective tools report must be an object.')
  assert(report.agentId === agentId, `Effective tools report must target ${agentId}.`)
  assert(typeof report.profile === 'string' && report.profile.length > 0, 'Effective tools report profile is required.')
  assert(Array.isArray(report.groups), 'Effective tools report groups must be an array.')
  const ids = report.groups.flatMap(group => {
    assert(Array.isArray(group?.tools), 'Effective tools group tools must be an array.')
    return group.tools.map(tool => {
      assert(typeof tool?.id === 'string' && tool.id.length > 0, 'Effective tool id is required.')
      return tool.id
    })
  })
  assert(new Set(ids).size === ids.length, 'Effective tools must not contain duplicate ids.')
  return ids.toSorted()
}

export function selectTelegramDirectSession(report, { agentId }) {
  assert(report && typeof report === 'object' && !Array.isArray(report), 'Sessions report must be an object.')
  assert(Array.isArray(report.sessions), 'Sessions report must contain sessions.')
  assert(report.count === 1 && report.sessions.length === 1, 'Expected one returned Telegram direct session.')
  assert(report.hasMore === false, 'Telegram direct session query must not be paginated.')
  assert(
    report.totalCount === 1 && report.nextOffset === null,
    'Expected exactly one Telegram direct session across all pages.',
  )
  const prefix = `agent:${agentId}:telegram:direct:`
  const matches = report.sessions.filter(session => typeof session?.key === 'string' && session.key.startsWith(prefix))
  assert(matches.length === 1, `Expected exactly one ${agentId} Telegram direct session.`)
  return matches[0].key
}

export function validateEffectiveTools(baseline, current, {
  agentId,
  toolName,
  expectTool,
}) {
  const baselineIds = effectiveToolIds(baseline, { agentId })
  assert(!baselineIds.includes(toolName), 'Effective baseline must not contain the candidate tool.')
  const currentIds = effectiveToolIds(current, { agentId })
  const expectedIds = expectTool ? [...baselineIds, toolName].toSorted() : baselineIds
  assert(
    isDeepStrictEqual(currentIds, expectedIds),
    expectTool
      ? 'Effective tools must equal the baseline plus only the candidate tool.'
      : 'Rolled-back effective tools must equal the original baseline exactly.',
  )
  if (expectTool) {
    assert(current.profile === 'full', 'Upgraded effective tools must report profile full.')
  } else {
    assert(current.profile === baseline.profile, 'Rolled-back effective profile must equal the baseline.')
  }
}

export function validatePluginSource(packageJson, manifest, {
  pluginId,
  expectedVersion,
  toolName,
}) {
  assert(packageJson?.version === expectedVersion, `Plugin package version must be ${expectedVersion}.`)
  assert(packageJson?.peerDependencies?.openclaw === '>=2026.7.1-2', 'OpenClaw peer dependency must require 2026.7.1-2.')
  assert(manifest?.id === pluginId, 'Plugin manifest id mismatch.')
  assert(manifest?.activation?.onStartup === true, 'Plugin manifest must activate on startup.')
  assert(
    isDeepStrictEqual(manifest?.activation?.onCapabilities, ['hook', 'tool']),
    'Plugin manifest must activate for exactly hook and tool capabilities.',
  )
  assert(
    isDeepStrictEqual(manifest?.contracts?.tools, [toolName]),
    'Plugin manifest must declare exactly the approved optional tool.',
  )
  assert(
    isDeepStrictEqual(manifest?.toolMetadata?.[toolName], { optional: true }),
    'Plugin manifest must mark the approved tool optional.',
  )
  assert(manifest?.configSchema?.type === 'object', 'Plugin config schema must be an object.')
  assert(manifest?.configSchema?.additionalProperties === false, 'Plugin config schema must reject additional properties.')
}

function diagnosticIsError(item) {
  return item?.level === 'error' || item?.severity === 'error'
}

export function validateRuntimeReport(report, {
  pluginId,
  expectedVersion,
  toolName,
  expectTool,
}) {
  assert(report?.plugin?.id === pluginId, 'Runtime inspection plugin id mismatch.')
  assert(report?.plugin?.status === 'loaded', 'Runtime inspection did not load the plugin.')
  assert(report?.plugin?.version === expectedVersion, `Runtime plugin version must be ${expectedVersion}.`)
  assert(Array.isArray(report.typedHooks), 'Runtime typedHooks must be an array.')
  const hookNames = report.typedHooks.map(hook => hook?.name).filter(Boolean).sort()
  assert(hookNames.includes('before_dispatch'), 'Runtime inspection is missing before_dispatch.')
  if (expectTool) {
    for (const hookName of REQUIRED_NEW_HOOKS) {
      assert(hookNames.includes(hookName), `Runtime inspection is missing ${hookName}.`)
    }
  }

  assert(Array.isArray(report.tools), 'Runtime tools must be an array.')
  const matchingTools = report.tools.filter(tool => Array.isArray(tool?.names) && tool.names.includes(toolName))
  if (expectTool) {
    assert(matchingTools.length === 1, 'Runtime inspection must register the approved tool exactly once.')
    assert(matchingTools[0].optional === true, 'Runtime tool registration must remain optional.')
  } else {
    assert(matchingTools.length === 0, 'The old runtime must not expose the new optional tool.')
  }

  assert(Array.isArray(report.diagnostics), 'Runtime diagnostics must be an array.')
  assert(!report.diagnostics.some(diagnosticIsError), 'Runtime inspection reported an error diagnostic.')
}

export function validateLiveGatewayToolCatalog(report, {
  pluginId,
  agentId,
  toolName,
  expectTool,
}) {
  assert(report && typeof report === 'object' && !Array.isArray(report), 'Live Gateway tool catalog must be an object.')
  assert(report.agentId === agentId, `Live Gateway tool catalog must target ${agentId}.`)
  assert(Array.isArray(report.groups), 'Live Gateway tool catalog groups must be an array.')

  const pluginGroups = report.groups.filter(group => group?.pluginId === pluginId)
  const matchingTools = report.groups.flatMap(group => {
    assert(Array.isArray(group?.tools), 'Live Gateway tool catalog group tools must be an array.')
    return group.tools.filter(tool => tool?.id === toolName)
  })

  if (expectTool) {
    assert(pluginGroups.length === 1, 'Live Gateway must expose exactly one target plugin group.')
    assert(pluginGroups[0].source === 'plugin', 'Live Gateway target group must come from a plugin.')
    assert(matchingTools.length === 1, 'Live Gateway must expose the approved tool exactly once.')
    assert(matchingTools[0].source === 'plugin', 'Live Gateway target tool must come from a plugin.')
    assert(matchingTools[0].pluginId === pluginId, 'Live Gateway target tool plugin id mismatch.')
    assert(matchingTools[0].optional === true, 'Live Gateway target tool must remain optional.')
  } else {
    assert(matchingTools.length === 0, 'The rolled-back live Gateway must not expose the 0.2.0 tool.')
  }
}

export function validateIndexRecord(record, {
  expectedVersion,
  expectedSourcePath,
  expectedInstallPath,
}) {
  assert(record?.source === 'path', 'Install index source must remain path.')
  assert(record?.sourcePath === expectedSourcePath, 'Install index sourcePath mismatch.')
  assert(record?.installPath === expectedInstallPath, 'Install index installPath mismatch.')
  assert(record?.version === expectedVersion, `Install index version must be ${expectedVersion}.`)
  assert(
    typeof record?.installedAt === 'string' && Number.isFinite(Date.parse(record.installedAt)),
    'Install index installedAt must be a valid timestamp.',
  )
}

export function createActiveRollbackMarker({
  pluginId,
  version,
  sourcePath,
  pluginFingerprint,
  createdAt = new Date().toISOString(),
}) {
  assert(typeof pluginId === 'string' && pluginId.length > 0, 'Active rollback marker plugin id is required.')
  assert(typeof version === 'string' && version.length > 0, 'Active rollback marker version is required.')
  assertSafeAbsolutePath(sourcePath, 'Active rollback sourcePath')
  assert(/^[a-f0-9]{64}$/u.test(pluginFingerprint), 'Active rollback marker fingerprint must be SHA-256.')
  assert(Number.isFinite(Date.parse(createdAt)), 'Active rollback marker timestamp is invalid.')
  return {
    schemaVersion: 1,
    pluginId,
    version,
    sourcePath,
    pluginFingerprint,
    createdAt,
  }
}

async function validateActiveRollbackSource({
  sourcePath,
  backupRoot,
  installedPath,
  pluginId,
  expectedVersion,
}) {
  assertSafeAbsolutePath(sourcePath, 'Install index sourcePath')
  assertSafeAbsolutePath(backupRoot, 'Backup root')
  assertSafeAbsolutePath(installedPath, 'Installed plugin path')

  const backupRelative = relative(backupRoot, sourcePath)
  const parts = backupRelative.split(sep)
  assert(
    parts.length === 2
      && /^upgrade-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]+$/u.test(parts[0])
      && parts[1] === 'previous-plugin',
    'Non-canonical install source is not an approved rollback backup path.',
  )

  const backupDir = dirname(sourcePath)
  assert(dirname(backupDir) === backupRoot, 'Rollback backup must be an immediate child of the backup root.')
  await assertDirectoryMode(backupRoot, 0o700, 'Backup root')
  await assertDirectoryMode(backupDir, 0o700, 'Rollback backup directory')
  await assertRealDirectory(sourcePath, 'Rollback plugin source')
  await assertRealDirectory(installedPath, 'Installed plugin directory')

  const markerPath = join(backupDir, ACTIVE_ROLLBACK_MARKER)
  await assertRegularFileMode(markerPath, 0o600, 'Active rollback marker')
  for (const [pathname, label] of [
    [join(sourcePath, 'package.json'), 'Rollback package.json'],
    [join(sourcePath, 'openclaw.plugin.json'), 'Rollback plugin manifest'],
  ]) {
    const stat = await lstat(pathname)
    assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file.`)
  }

  const marker = await readJson(markerPath, 'active rollback marker')
  const expectedMarker = createActiveRollbackMarker({
    pluginId,
    version: expectedVersion,
    sourcePath,
    pluginFingerprint: marker.pluginFingerprint,
    createdAt: marker.createdAt,
  })
  assert(isDeepStrictEqual(marker, expectedMarker), 'Active rollback marker has unexpected fields or values.')

  const packageJson = await readJson(join(sourcePath, 'package.json'), 'rollback package.json')
  const manifest = await readJson(join(sourcePath, 'openclaw.plugin.json'), 'rollback plugin manifest')
  assert(packageJson.version === expectedVersion, `Rollback source version must be ${expectedVersion}.`)
  assert(manifest.id === pluginId, 'Rollback source plugin id mismatch.')

  const [sourceFingerprint, installedFingerprint] = await Promise.all([
    fingerprintPluginPayload(sourcePath),
    fingerprintPluginPayload(installedPath),
  ])
  assert(sourceFingerprint === installedFingerprint, 'Rollback source and installed plugin fingerprints differ.')
  assert(sourceFingerprint === marker.pluginFingerprint, 'Active rollback marker fingerprint mismatch.')
  return { kind: 'rollback', sourcePath, markerPath }
}

export async function validatePreUpgradeIndexRecord(record, {
  expectedVersion,
  canonicalSourcePath,
  backupRoot,
  expectedInstallPath,
  pluginId,
}) {
  validateIndexRecord(record, {
    expectedVersion,
    expectedSourcePath: record?.sourcePath,
    expectedInstallPath,
  })
  assertSafeAbsolutePath(canonicalSourcePath, 'Canonical plugin sourcePath')
  if (record.sourcePath === canonicalSourcePath) {
    return { kind: 'canonical', sourcePath: canonicalSourcePath }
  }
  return validateActiveRollbackSource({
    sourcePath: record.sourcePath,
    backupRoot,
    installedPath: expectedInstallPath,
    pluginId,
    expectedVersion,
  })
}

export function validateDoctorReport(raw, pluginId, { allowLegacyHookOnly = false } = {}) {
  const lines = raw.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  if (lines.length === 1 && lines[0] === 'No plugin issues detected.') return
  if (allowLegacyHookOnly) {
    const expected = [
      'Compatibility:',
      `- ${pluginId} is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet. [info]`,
      'Docs: https://docs.openclaw.ai/plugin',
    ]
    if (isDeepStrictEqual(lines, expected)) return
  }
  throw new Error('Plugin doctor reported an unexpected issue.')
}

export function validateOtherProfileConfig(config, { pluginId, toolName }) {
  const pluginAllow = config?.plugins?.allow
  if (pluginAllow !== undefined) {
    assert(!stringArray(pluginAllow, 'other profile plugins.allow').includes(pluginId), 'Another profile allows the target plugin.')
  }
  const pluginEntries = config?.plugins?.entries
  if (pluginEntries !== undefined) {
    assert(pluginEntries && typeof pluginEntries === 'object' && !Array.isArray(pluginEntries), 'Other profile plugin entries must be an object.')
  }
  assert(
    !Object.hasOwn(pluginEntries ?? {}, pluginId),
    'Another profile configures the target plugin.',
  )
  for (const [label, value] of [
    ['other profile tools.allow', config?.tools?.allow],
    ['other profile tools.alsoAllow', config?.tools?.alsoAllow],
  ]) {
    if (value !== undefined) assert(!stringArray(value, label).includes(toolName), 'Another profile grants the target tool.')
  }
  const otherAgents = config?.agents?.list
  if (otherAgents !== undefined) assert(Array.isArray(otherAgents), 'Other profile agents.list must be an array.')
  for (const agent of otherAgents ?? []) {
    for (const key of ['allow', 'alsoAllow']) {
      const value = agent?.tools?.[key]
      if (value !== undefined) {
        assert(
          !stringArray(value, `other profile agent tools.${key}`).includes(toolName),
          'Another profile agent grants the target tool.',
        )
      }
    }
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'source': {
      const [packagePath, manifestPath, pluginId, expectedVersion, toolName] = args
      assert(packagePath && manifestPath && pluginId && expectedVersion && toolName, 'source arguments are incomplete.')
      validatePluginSource(
        await readJson(packagePath, 'package.json'),
        await readJson(manifestPath, 'plugin manifest'),
        { pluginId, expectedVersion, toolName },
      )
      break
    }
    case 'config-plan': {
      const [configPath, effectiveBaselinePath, pluginId, agentId, toolName] = args
      const plan = buildConfigPlan(
        await readJson(configPath, 'profile config'),
        await readJson(effectiveBaselinePath, 'effective tools baseline'),
        { pluginId, agentId, toolName },
      )
      process.stdout.write(`${plan.agentIndex}\t${JSON.stringify(plan.nextTools)}\n`)
      break
    }
    case 'config-after': {
      const [beforePath, afterPath, effectiveBaselinePath, pluginId, agentId, toolName] = args
      validateConfigAfter(
        await readJson(beforePath, 'pre-upgrade config'),
        await readJson(afterPath, 'post-upgrade config'),
        await readJson(effectiveBaselinePath, 'effective tools baseline'),
        { pluginId, agentId, toolName },
      )
      break
    }
    case 'runtime-old':
    case 'runtime-new': {
      const [reportPath, pluginId, expectedVersion, toolName] = args
      validateRuntimeReport(await readJson(reportPath, 'runtime report'), {
        pluginId,
        expectedVersion,
        toolName,
        expectTool: command === 'runtime-new',
      })
      break
    }
    case 'live-old':
    case 'live-new': {
      const [reportPath, pluginId, agentId, toolName] = args
      assert(reportPath && pluginId && agentId && toolName, 'live Gateway arguments are incomplete.')
      validateLiveGatewayToolCatalog(await readJson(reportPath, 'live Gateway tool catalog'), {
        pluginId,
        agentId,
        toolName,
        expectTool: command === 'live-new',
      })
      break
    }
    case 'session-select': {
      const [reportPath, agentId] = args
      assert(reportPath && agentId, 'session-select arguments are incomplete.')
      process.stdout.write(`${selectTelegramDirectSession(
        await readJson(reportPath, 'sessions report'),
        { agentId },
      )}\n`)
      break
    }
    case 'effective-old':
    case 'effective-new': {
      const [baselinePath, currentPath, agentId, toolName] = args
      assert(baselinePath && currentPath && agentId && toolName, 'effective tools arguments are incomplete.')
      validateEffectiveTools(
        await readJson(baselinePath, 'effective tools baseline'),
        await readJson(currentPath, 'current effective tools'),
        { agentId, toolName, expectTool: command === 'effective-new' },
      )
      break
    }
    case 'index': {
      const [recordPath, expectedVersion, expectedSourcePath, expectedInstallPath] = args
      validateIndexRecord(await readJson(recordPath, 'install index record'), {
        expectedVersion,
        expectedSourcePath,
        expectedInstallPath,
      })
      break
    }
    case 'index-preflight': {
      const [recordPath, expectedVersion, canonicalSourcePath, backupRoot, expectedInstallPath, pluginId] = args
      assert(
        recordPath && expectedVersion && canonicalSourcePath && backupRoot && expectedInstallPath && pluginId,
        'index-preflight arguments are incomplete.',
      )
      const result = await validatePreUpgradeIndexRecord(await readJson(recordPath, 'install index record'), {
        expectedVersion,
        canonicalSourcePath,
        backupRoot,
        expectedInstallPath,
        pluginId,
      })
      process.stdout.write(`${result.kind}\n`)
      break
    }
    case 'marker-create': {
      const [pluginId, version, sourcePath, pluginFingerprint] = args
      assert(pluginId && version && sourcePath && pluginFingerprint, 'marker-create arguments are incomplete.')
      process.stdout.write(`${JSON.stringify(createActiveRollbackMarker({
        pluginId,
        version,
        sourcePath,
        pluginFingerprint,
      }), null, 2)}\n`)
      break
    }
    case 'doctor-old':
    case 'doctor-new': {
      const [reportPath, pluginId] = args
      assert(reportPath && pluginId, 'doctor arguments are incomplete.')
      validateDoctorReport(await readFile(reportPath, 'utf8'), pluginId, {
        allowLegacyHookOnly: command === 'doctor-old',
      })
      break
    }
    case 'other-profile': {
      const [configPath, pluginId, toolName] = args
      validateOtherProfileConfig(await readJson(configPath, 'other profile config'), { pluginId, toolName })
      break
    }
    default:
      throw new Error('Unknown validator command.')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
