#!/usr/bin/env node

import { isDeepStrictEqual } from 'node:util'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  buildV02Transformation,
  deriveTelegramOwnerSenderPolicy,
  enforceVerifiedBackupRetention,
  fingerprintPluginPayload,
  selectCompatibleV02UpgradeBackup,
  validateEffectiveTools,
  validateKnownV02Tools,
  validatePluginSenderHash,
  validatePluginPayloadMatch,
  validateOfficialOpenClawPeerLink,
  validateRestoredConfig,
  validateTelegramIngressPolicy,
  validateVerifiedBackupRetentionBaseline,
} from './lib/aiworker-video-command-upgrade-policy.mjs'

const REQUIRED_V02_HOOKS = [
  'before_dispatch',
  'before_prompt_build',
  'before_tool_call',
]
const ACTIVE_ROLLBACK_MARKER = '.active-rollback-source.json'

export {
  buildV02Transformation,
  deriveTelegramOwnerSenderPolicy,
  enforceVerifiedBackupRetention,
  fingerprintPluginPayload,
  selectCompatibleV02UpgradeBackup,
  validateEffectiveTools,
  validateKnownV02Tools,
  validatePluginSenderHash,
  validatePluginPayloadMatch,
  validateOfficialOpenClawPeerLink,
  validateRestoredConfig,
  validateTelegramIngressPolicy,
  validateVerifiedBackupRetentionBaseline,
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
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
    isDeepStrictEqual(manifest?.activation?.onCapabilities, ['hook']),
    '0.3 plugin manifest must activate for exactly the hook capability.',
  )
  assert(manifest?.contracts === undefined, '0.3 plugin manifest must not declare capability contracts.')
  assert(manifest?.toolMetadata === undefined, '0.3 plugin manifest must not declare tool metadata.')
  assert(toolName && typeof toolName === 'string', 'Removed tool name must be explicit for validation.')
  assert(manifest?.configSchema?.type === 'object', 'Plugin config schema must be an object.')
  assert(manifest?.configSchema?.additionalProperties === false, 'Plugin config schema must reject additional properties.')
  assert(
    isDeepStrictEqual(manifest?.configSchema?.properties?.allowedSenderSha256, {
      type: 'string',
      pattern: '^[a-f0-9]{64}$',
    }),
    '0.3 plugin schema must declare the lowercase SHA-256 sender gate.',
  )
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
  const hookNames = report.typedHooks.map(hook => hook?.name).filter(Boolean).toSorted()
  const expectedHooks = (expectTool ? REQUIRED_V02_HOOKS : ['before_dispatch']).toSorted()
  assert(
    isDeepStrictEqual(hookNames, expectedHooks),
    expectTool
      ? '0.2 runtime must expose exactly its three known hooks.'
      : '0.3 runtime must expose only before_dispatch.',
  )

  assert(Array.isArray(report.tools), 'Runtime tools must be an array.')
  const matchingTools = report.tools.filter(tool => Array.isArray(tool?.names) && tool.names.includes(toolName))
  if (expectTool) {
    assert(matchingTools.length === 1, 'Runtime inspection must register the approved tool exactly once.')
    assert(matchingTools[0].optional === true, 'Runtime tool registration must remain optional.')
  } else {
    assert(report.tools.length === 0, '0.3 runtime must not register any tool.')
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
    assert(matchingTools.length === 0, 'The 0.3 live Gateway must not expose the removed 0.2 tool.')
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

export function validateDoctorReport(raw, pluginId, { allowHookOnly = false } = {}) {
  const lines = raw.split(/\r?\n/u).map(line => line.trim()).filter(Boolean)
  if (lines.length === 1 && lines[0] === 'No plugin issues detected.') return
  if (allowHookOnly) {
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
    case 'baseline-select': {
      const [backupRoot, currentConfigPath, installedPath, pluginId, agentId, toolName, baselineVersion, oldVersion] = args
      assert(
        backupRoot && currentConfigPath && installedPath && pluginId && agentId
          && toolName && baselineVersion && oldVersion,
        'baseline-select arguments are incomplete.',
      )
      const plan = await selectCompatibleV02UpgradeBackup(
        backupRoot,
        await readJson(currentConfigPath, 'current profile config'),
        installedPath,
        { pluginId, agentId, toolName, baselineVersion, oldVersion },
      )
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
      break
    }
    case 'backup-retention-baseline': {
      const [backupRoot, maxBackupsText = '2'] = args
      assert(backupRoot, 'backup-retention-baseline arguments are incomplete.')
      process.stdout.write(`${JSON.stringify(await validateVerifiedBackupRetentionBaseline(
        backupRoot,
        Number(maxBackupsText),
      ), null, 2)}\n`)
      break
    }
    case 'backup-retention-enforce': {
      const [backupRoot, currentBackup, indexRecordPath, maxBackupsText = '2'] = args
      assert(
        backupRoot && currentBackup && indexRecordPath,
        'backup-retention-enforce arguments are incomplete.',
      )
      const indexRecord = await readJson(indexRecordPath, 'final install index record')
      process.stdout.write(`${JSON.stringify(await enforceVerifiedBackupRetention({
        backupRoot,
        currentBackup,
        activeSourcePath: indexRecord.sourcePath,
        maxBackups: Number(maxBackupsText),
      }), null, 2)}\n`)
      break
    }
    case 'payload-fingerprint': {
      const [pluginRoot] = args
      assert(pluginRoot, 'payload-fingerprint arguments are incomplete.')
      process.stdout.write(`${await fingerprintPluginPayload(pluginRoot)}\n`)
      break
    }
    case 'payload-match': {
      const [
        sourceRoot,
        installedRoot,
        expectedFingerprint,
        expectedPeerLinkText,
        expectedPeerRealPath,
      ] = args
      assert(
        sourceRoot && installedRoot && expectedFingerprint
          && expectedPeerLinkText && expectedPeerRealPath,
        'payload-match arguments are incomplete.',
      )
      process.stdout.write(`${JSON.stringify(await validatePluginPayloadMatch({
        sourceRoot,
        installedRoot,
        expectedFingerprint,
        expectedPeerLinkText,
        expectedPeerRealPath,
      }), null, 2)}\n`)
      break
    }
    case 'peer-link': {
      const [installedRoot] = args
      assert(installedRoot, 'peer-link arguments are incomplete.')
      process.stdout.write(`${JSON.stringify(await validateOfficialOpenClawPeerLink(
        installedRoot,
      ), null, 2)}\n`)
      break
    }
    case 'config-known-v02': {
      const [baselineConfigPath, currentConfigPath, effectiveBaselinePath, pluginId, agentId, toolName] = args
      assert(
        baselineConfigPath && currentConfigPath && effectiveBaselinePath && pluginId && agentId && toolName,
        'config-known-v02 arguments are incomplete.',
      )
      validateKnownV02Tools(
        await readJson(baselineConfigPath, 'pre-0.2 profile config'),
        await readJson(currentConfigPath, 'current profile config'),
        await readJson(effectiveBaselinePath, 'effective tools baseline'),
        { pluginId, agentId, toolName },
      )
      break
    }
    case 'config-restored': {
      const [
        currentBeforePath,
        restoredPath,
        baselineConfigPath,
        effectiveBaselinePath,
        pluginId,
        agentId,
        toolName,
        allowedSenderSha256,
      ] = args
      assert(
        currentBeforePath && restoredPath && baselineConfigPath && effectiveBaselinePath
          && pluginId && agentId && toolName,
        'config-restored arguments are incomplete.',
      )
      validateRestoredConfig(
        await readJson(currentBeforePath, 'pre-0.3 current config'),
        await readJson(restoredPath, 'restored 0.3 config'),
        await readJson(baselineConfigPath, 'pre-0.2 profile config'),
        await readJson(effectiveBaselinePath, 'pre-0.2 effective tools'),
        { pluginId, agentId, toolName, allowedSenderSha256 },
      )
      break
    }
    case 'owner-sender-plan': {
      const [configPath] = args
      assert(configPath, 'owner-sender-plan arguments are incomplete.')
      process.stdout.write(`${JSON.stringify(deriveTelegramOwnerSenderPolicy(
        await readJson(configPath, 'profile config'),
      ), null, 2)}\n`)
      break
    }
    case 'sender-hash-config': {
      const [configPath, pluginId, allowedSenderSha256] = args
      assert(configPath && pluginId && allowedSenderSha256, 'sender-hash-config arguments are incomplete.')
      validatePluginSenderHash(
        await readJson(configPath, 'profile config'),
        { pluginId, allowedSenderSha256 },
      )
      break
    }
    case 'telegram-policy': {
      const [configPath, agentId] = args
      assert(configPath && agentId, 'telegram-policy arguments are incomplete.')
      validateTelegramIngressPolicy(
        await readJson(configPath, 'profile config'),
        { agentId },
      )
      break
    }
    case 'runtime-v02':
    case 'runtime-v03': {
      const [reportPath, pluginId, expectedVersion, toolName] = args
      validateRuntimeReport(await readJson(reportPath, 'runtime report'), {
        pluginId,
        expectedVersion,
        toolName,
        expectTool: command === 'runtime-v02',
      })
      break
    }
    case 'live-v02':
    case 'live-v03': {
      const [reportPath, pluginId, agentId, toolName] = args
      assert(reportPath && pluginId && agentId && toolName, 'live Gateway arguments are incomplete.')
      validateLiveGatewayToolCatalog(await readJson(reportPath, 'live Gateway tool catalog'), {
        pluginId,
        agentId,
        toolName,
        expectTool: command === 'live-v02',
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
    case 'effective-v02':
    case 'effective-v03': {
      const [baselinePath, currentPath, agentId, toolName] = args
      assert(baselinePath && currentPath && agentId && toolName, 'effective tools arguments are incomplete.')
      validateEffectiveTools(
        await readJson(baselinePath, 'effective tools baseline'),
        await readJson(currentPath, 'current effective tools'),
        { agentId, toolName, expectTool: command === 'effective-v02' },
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
    case 'doctor-v02':
    case 'doctor-v03': {
      const [reportPath, pluginId] = args
      assert(reportPath && pluginId, 'doctor arguments are incomplete.')
      validateDoctorReport(await readFile(reportPath, 'utf8'), pluginId, {
        allowHookOnly: command === 'doctor-v03',
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
