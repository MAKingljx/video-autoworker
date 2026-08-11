import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { lstat, readFile, readdir, readlink, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const VERIFIED_MARKER = '.verified'
const UPGRADE_DIRECTORY = /^upgrade-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]+$/u
const VERIFIED_BACKUP_DIRECTORY = /^(?:(?:status-)?upgrade-)?([0-9]{8}-[0-9]{6})\.[A-Za-z0-9]+$/u
const ACTIVE_ROLLBACK_MARKER = '.active-rollback-source.json'
const TELEGRAM_OWNER = /^telegram:([1-9][0-9]*)$/u
const EXPLICIT_CHANNEL_OWNER = /^[a-z][a-z0-9_-]*:.+$/u
const TELEGRAM_SENDER_HASH_DOMAIN = 'aiworker-video-command:telegram-sender:v1\0'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

export async function fingerprintPluginPayload(root, { omitTopLevelNodeModules = false } = {}) {
  assertSafeAbsolutePath(root, 'Plugin payload root')
  const rootStat = await lstat(root)
  assert(
    rootStat.isDirectory() && !rootStat.isSymbolicLink(),
    'Plugin payload root must be a real directory.',
  )
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
    assert(stat.isDirectory(), `Unsupported plugin payload object: ${relativePath}`)
    hash.update('dir\0')
    const names = (await readdir(pathname)).sort()
      .filter(name => !(omitTopLevelNodeModules && relativePath === '.' && name === 'node_modules'))
    for (const name of names) {
      await visit(join(pathname, name), relativePath === '.' ? name : `${relativePath}/${name}`)
    }
  }

  await visit(root, '.')
  return hash.digest('hex')
}

export async function validateOfficialOpenClawPeerLink(installedRoot, {
  expectedLinkText,
  expectedRealPath,
} = {}) {
  assertSafeAbsolutePath(installedRoot, 'Installed plugin root')
  const nodeModulesPath = join(installedRoot, 'node_modules')
  const nodeModulesStat = await lstat(nodeModulesPath)
  assert(
    nodeModulesStat.isDirectory() && !nodeModulesStat.isSymbolicLink(),
    'Installed node_modules must be a real directory.',
  )
  const names = (await readdir(nodeModulesPath)).sort()
  assert(
    isDeepStrictEqual(names, ['openclaw']),
    'Installed node_modules must contain only the official openclaw peer link.',
  )
  const peerPath = join(nodeModulesPath, 'openclaw')
  const peerStat = await lstat(peerPath)
  assert(peerStat.isSymbolicLink(), 'Installed openclaw peer artifact must be a symbolic link.')
  const linkText = await readlink(peerPath)
  assert(linkText.length > 0 && !/[\u0000-\u001f\u007f]/u.test(linkText), 'OpenClaw peer link text is unsafe.')
  const peerRealPath = await realpath(peerPath)
  assertSafeAbsolutePath(peerRealPath, 'OpenClaw peer realpath')
  const realStat = await lstat(peerRealPath)
  assert(realStat.isDirectory() && !realStat.isSymbolicLink(), 'OpenClaw peer link must resolve to a real directory.')
  if (expectedLinkText !== undefined) {
    assert(linkText === expectedLinkText, 'OpenClaw peer link text changed during official install.')
  }
  if (expectedRealPath !== undefined) {
    assert(peerRealPath === expectedRealPath, 'OpenClaw peer link target changed during official install.')
  }
  return { schemaVersion: 1, linkText, realPath: peerRealPath }
}

export async function validatePluginPayloadMatch({
  sourceRoot,
  installedRoot,
  expectedFingerprint,
  expectedPeerLinkText,
  expectedPeerRealPath,
}) {
  assertSafeAbsolutePath(sourceRoot, 'Canonical plugin source')
  assertSafeAbsolutePath(installedRoot, 'Installed plugin root')
  assert(
    typeof expectedFingerprint === 'string' && /^[a-f0-9]{64}$/u.test(expectedFingerprint),
    'Expected plugin payload fingerprint must be lowercase SHA-256.',
  )
  assert(!await optionalLstat(join(sourceRoot, 'node_modules')), 'Canonical plugin source must not contain node_modules.')
  const peer = await validateOfficialOpenClawPeerLink(installedRoot, {
    expectedLinkText: expectedPeerLinkText,
    expectedRealPath: expectedPeerRealPath,
  })
  const [sourceFingerprint, installedFingerprint] = await Promise.all([
    fingerprintPluginPayload(sourceRoot),
    fingerprintPluginPayload(installedRoot, { omitTopLevelNodeModules: true }),
  ])
  assert(
    sourceFingerprint === expectedFingerprint,
    'Canonical plugin payload no longer matches the audited fingerprint.',
  )
  assert(
    installedFingerprint === expectedFingerprint,
    'Installed plugin payload does not match the audited canonical source.',
  )
  return {
    schemaVersion: 1,
    expectedFingerprint,
    sourceFingerprint,
    installedFingerprint,
    peer,
  }
}

function clone(value) {
  return structuredClone(value)
}

async function readJson(pathname, label) {
  let value
  try {
    value = JSON.parse(await readFile(pathname, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} must be a JSON object.`)
  return value
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

export function validateTelegramIngressPolicy(config, { agentId }) {
  const telegram = config?.channels?.telegram
  assert(telegram && typeof telegram === 'object' && !Array.isArray(telegram), 'channels.telegram must be configured.')
  const dmPolicy = telegram.dmPolicy
  assert(
    dmPolicy === undefined || dmPolicy === 'pairing' || dmPolicy === 'allowlist',
    'Telegram dmPolicy must be omitted, pairing, or allowlist; open access is forbidden.',
  )

  assert(Array.isArray(config?.bindings), 'OpenClaw bindings must be an array.')
  const telegramBindings = config.bindings.filter(binding => {
    const channel = binding?.match?.channel ?? binding?.channel
    return channel === 'telegram'
  })
  assert(telegramBindings.length === 1, 'Exactly one Telegram binding is required.')
  assert(
    telegramBindings[0]?.agentId === agentId,
    `The unique Telegram binding must target ${agentId}.`,
  )
  uniqueTargetAgent(config, agentId)
}

export function deriveTelegramOwnerSenderPolicy(config) {
  const owners = stringArray(
    config?.commands?.ownerAllowFrom,
    'commands.ownerAllowFrom',
    { required: true },
  )
  assert(owners.length > 0, 'commands.ownerAllowFrom must not be empty.')
  assert(
    owners.every(owner => EXPLICIT_CHANNEL_OWNER.test(owner)),
    'Every command owner must use an explicit canonical channel prefix.',
  )
  assert(
    owners.every(owner => !owner.includes('*')),
    'Command-owner wildcards are forbidden for every channel.',
  )
  const telegramLike = owners.filter(owner => /^(?:telegram|tg):/iu.test(owner))
  const canonicalTelegram = telegramLike.filter(owner => TELEGRAM_OWNER.test(owner))
  assert(
    telegramLike.length === 1 && canonicalTelegram.length === 1,
    'Exactly one Telegram command owner is required in canonical telegram:<numeric-id> form without a wildcard.',
  )
  const match = TELEGRAM_OWNER.exec(canonicalTelegram[0])
  const allowedSenderSha256 = createHash('sha256')
    .update(TELEGRAM_SENDER_HASH_DOMAIN)
    .update(match[1])
    .digest('hex')
  return {
    schemaVersion: 1,
    ownerCount: 1,
    allowedSenderSha256,
  }
}

export function validatePluginSenderHash(config, { pluginId, allowedSenderSha256 }) {
  assert(
    typeof allowedSenderSha256 === 'string' && /^[a-f0-9]{64}$/u.test(allowedSenderSha256),
    'Allowed Telegram sender hash must be lowercase SHA-256.',
  )
  const pluginEntry = config?.plugins?.entries?.[pluginId]
  assert(pluginEntry?.enabled === true, `${pluginId} must remain enabled.`)
  assert(
    isDeepStrictEqual(pluginEntry.config, { allowedSenderSha256 }),
    'Plugin config must contain only the approved Telegram sender hash.',
  )
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

async function assertRegularFileMode(pathname, expectedMode, label) {
  const stat = await lstat(pathname)
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file.`)
  assert((stat.mode & 0o777) === expectedMode, `${label} must have mode ${expectedMode.toString(8)}.`)
}

async function optionalLstat(pathname) {
  try {
    return await lstat(pathname)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function listVerifiedBackupEntries(backupRoot) {
  assertSafeAbsolutePath(backupRoot, 'Backup root')
  await assertDirectoryMode(backupRoot, 0o700, 'Backup root')

  const verified = []
  for (const entry of await readdir(backupRoot, { withFileTypes: true })) {
    const nameMatch = VERIFIED_BACKUP_DIRECTORY.exec(entry.name)
    if (!nameMatch) continue
    const candidate = join(backupRoot, entry.name)
    assert(entry.isDirectory() && !entry.isSymbolicLink(), 'Named plugin backup entries must be real directories.')
    await assertDirectoryMode(candidate, 0o700, 'Verified plugin backup')

    const markerPath = join(candidate, VERIFIED_MARKER)
    const markerStat = await optionalLstat(markerPath)
    if (!markerStat) continue
    assert(
      markerStat.isFile() && !markerStat.isSymbolicLink() && (markerStat.mode & 0o777) === 0o600,
      'Verified plugin backup markers must be regular mode-0600 files.',
    )

    const activeMarkerStat = await optionalLstat(join(candidate, ACTIVE_ROLLBACK_MARKER))
    if (activeMarkerStat) {
      assert(
        activeMarkerStat.isFile() && !activeMarkerStat.isSymbolicLink()
          && (activeMarkerStat.mode & 0o777) === 0o600,
        'Active rollback markers must be regular mode-0600 files.',
      )
    }
    const directoryStat = await lstat(candidate)
    verified.push({
      path: candidate,
      name: entry.name,
      sortKey: `${nameMatch[1]}\0${entry.name}`,
      directoryIdentity: `${directoryStat.dev}:${directoryStat.ino}`,
      markerIdentity: `${markerStat.dev}:${markerStat.ino}`,
      activeMarker: Boolean(activeMarkerStat),
    })
  }
  return verified.toSorted((left, right) => left.sortKey.localeCompare(right.sortKey))
}

function backupContainingPath(backupRoot, pathname) {
  assertSafeAbsolutePath(pathname, 'Active plugin source path')
  const pathRelative = relative(backupRoot, pathname)
  if (!pathRelative || pathRelative === '..' || pathRelative.startsWith(`..${sep}`) || isAbsolute(pathRelative)) {
    return null
  }
  return pathRelative.split(sep)[0]
}

export async function validateVerifiedBackupRetentionBaseline(backupRoot, maxBackups = 2) {
  assert(Number.isInteger(maxBackups) && maxBackups > 0, 'Backup retention limit must be a positive integer.')
  const verified = await listVerifiedBackupEntries(backupRoot)
  assert(
    verified.length <= maxBackups,
    `Verified plugin backup count ${verified.length} exceeds retention limit ${maxBackups}.`,
  )
  return { schemaVersion: 1, verifiedCount: verified.length, maxBackups }
}

export async function enforceVerifiedBackupRetention({
  backupRoot,
  currentBackup,
  activeSourcePath,
  maxBackups = 2,
}) {
  assert(Number.isInteger(maxBackups) && maxBackups > 0, 'Backup retention limit must be a positive integer.')
  assertSafeAbsolutePath(backupRoot, 'Backup root')
  assertSafeAbsolutePath(currentBackup, 'Current backup')
  assert(dirname(currentBackup) === backupRoot, 'Current backup must be a direct child of the backup root.')

  const verified = await listVerifiedBackupEntries(backupRoot)
  const current = verified.find(entry => entry.path === currentBackup)
  assert(current, 'Current backup must be fully verified before retention cleanup.')

  const activeBackupName = activeSourcePath
    ? backupContainingPath(backupRoot, activeSourcePath)
    : null
  const protectedNames = new Set([
    current.name,
    ...verified.filter(entry => entry.activeMarker).map(entry => entry.name),
    ...(activeBackupName ? [activeBackupName] : []),
  ])
  const removeCount = Math.max(0, verified.length - maxBackups)
  const removable = verified.filter(entry => !protectedNames.has(entry.name))
  assert(
    removable.length >= removeCount,
    'Backup retention cannot remove enough history without touching a protected recovery source.',
  )
  const selected = removable.slice(0, removeCount)

  for (const entry of selected) {
    const [directoryStat, markerStat, activeMarkerStat] = await Promise.all([
      lstat(entry.path),
      lstat(join(entry.path, VERIFIED_MARKER)),
      optionalLstat(join(entry.path, ACTIVE_ROLLBACK_MARKER)),
    ])
    assert(
      directoryStat.isDirectory() && !directoryStat.isSymbolicLink()
        && `${directoryStat.dev}:${directoryStat.ino}` === entry.directoryIdentity,
      'Backup directory identity changed before retention cleanup.',
    )
    assert(
      markerStat.isFile() && !markerStat.isSymbolicLink()
        && `${markerStat.dev}:${markerStat.ino}` === entry.markerIdentity,
      'Verified marker identity changed before retention cleanup.',
    )
    assert(!activeMarkerStat, 'A backup became an active rollback source before retention cleanup.')
    await rm(entry.path, { recursive: true, force: false })
  }

  const remaining = await listVerifiedBackupEntries(backupRoot)
  assert(remaining.length <= maxBackups, 'Verified plugin backup retention did not converge to the configured limit.')
  assert(
    remaining.some(entry => entry.path === currentBackup),
    'Current verified backup disappeared during retention cleanup.',
  )
  return {
    schemaVersion: 1,
    maxBackups,
    retained: remaining.map(entry => entry.name),
    removed: selected.map(entry => entry.name),
  }
}

export function buildV02Transformation(config, effectiveBaseline, {
  pluginId,
  agentId,
  toolName,
}) {
  const pluginAllow = stringArray(config?.plugins?.allow, 'plugins.allow', { required: true })
  assert(pluginAllow.length > 0, 'plugins.allow must be non-empty.')
  assert(pluginAllow.includes(pluginId), `plugins.allow must already contain ${pluginId}.`)
  assert(config?.plugins?.entries?.[pluginId]?.enabled === true, `${pluginId} must already be enabled.`)

  const { agent, index } = uniqueTargetAgent(config, agentId)
  assert(agent?.tools && typeof agent.tools === 'object' && !Array.isArray(agent.tools), `${agentId}.tools must be an object.`)
  const allow = stringArray(agent.tools.allow, `${agentId}.tools.allow`, { required: true })
  assert(allow.length > 0, `${agentId}.tools.allow must be non-empty.`)
  assert(!allow.includes(toolName), `${toolName} must not already be in the pre-0.2 tools object.`)
  assert(agent.tools.alsoAllow === undefined, `${agentId}.tools.alsoAllow must remain unset.`)
  assertToolNotGrantedOutsideTarget(config, agentId, toolName)

  const baselineIds = effectiveToolIds(effectiveBaseline, { agentId })
  assert(!baselineIds.includes(toolName), 'Pre-0.2 effective tools must not contain the optional tool.')
  const baselineSet = new Set(baselineIds)
  const effectiveAllow = allow.filter(id => baselineSet.has(id))
  assert(
    effectiveAllow.length === baselineIds.length,
    `${agentId}.tools.allow must contain every pre-0.2 effective tool.`,
  )

  return {
    agentIndex: index,
    originalTools: clone(agent.tools),
    effectiveAllow,
    transformedTools: {
      ...clone(agent.tools),
      profile: 'full',
      allow: [...effectiveAllow, toolName],
    },
  }
}

export function validateKnownV02Tools(baselineConfig, currentConfig, effectiveBaseline, options) {
  const plan = buildV02Transformation(baselineConfig, effectiveBaseline, options)
  validateTelegramIngressPolicy(currentConfig, options)
  const current = uniqueTargetAgent(currentConfig, options.agentId)
  assert(current.index === plan.agentIndex, 'The target agent index changed after the 0.2 upgrade.')
  assert(
    isDeepStrictEqual(current.agent?.tools, plan.transformedTools),
    'Current second-original tools are not the known 0.2 transformation; refusing blind restoration.',
  )
  assertToolNotGrantedOutsideTarget(currentConfig, options.agentId, options.toolName)
  return plan
}

export function validateRestoredConfig(currentBefore, restored, baselineConfig, effectiveBaseline, options) {
  const plan = validateKnownV02Tools(baselineConfig, currentBefore, effectiveBaseline, options)
  const restoredTarget = uniqueTargetAgent(restored, options.agentId)
  assert(restoredTarget.index === plan.agentIndex, 'The target agent index changed during 0.3 restoration.')

  const expected = clone(currentBefore)
  expected.agents.list[plan.agentIndex].tools = clone(plan.originalTools)
  if (options.allowedSenderSha256 !== undefined) {
    expected.plugins.entries[options.pluginId].config = {
      allowedSenderSha256: options.allowedSenderSha256,
    }
  }
  const normalizedRestored = clone(restored)
  for (const config of [expected, normalizedRestored]) {
    if (config.meta && typeof config.meta === 'object' && !Array.isArray(config.meta)) {
      delete config.meta.lastTouchedAt
      delete config.meta.lastTouchedVersion
      if (Object.keys(config.meta).length === 0) delete config.meta
    }
  }
  assert(
    isDeepStrictEqual(normalizedRestored, expected),
    'Config changed outside the exact second-original tools restoration.',
  )
  assert(
    isDeepStrictEqual(restoredTarget.agent.tools, plan.originalTools),
    'The complete pre-0.2 second-original tools object was not restored.',
  )
  assertToolNotGrantedOutsideTarget(restored, options.agentId, options.toolName)
  validateTelegramIngressPolicy(restored, options)
  if (options.allowedSenderSha256 !== undefined) {
    validatePluginSenderHash(restored, options)
  }
}

export function validateEffectiveTools(baseline, current, {
  agentId,
  toolName,
  expectTool,
}) {
  const baselineIds = effectiveToolIds(baseline, { agentId })
  assert(!baselineIds.includes(toolName), 'Pre-0.2 effective tools must not contain the optional tool.')
  const currentIds = effectiveToolIds(current, { agentId })
  const expectedIds = expectTool ? [...baselineIds, toolName].toSorted() : baselineIds
  assert(
    isDeepStrictEqual(currentIds, expectedIds),
    expectTool
      ? '0.2 effective tools must equal the pre-0.2 baseline plus only the optional tool.'
      : '0.3 effective tools must equal the pre-0.2 baseline exactly.',
  )
  assert(
    current.profile === (expectTool ? 'full' : baseline.profile),
    expectTool
      ? '0.2 effective tools must report profile full.'
      : '0.3 effective profile must equal the pre-0.2 baseline.',
  )
}

async function validateCompatibleBackup(backupDir, currentConfig, installedPath, options) {
  const baselineConfigPath = join(backupDir, 'openclaw.json')
  const effectiveBaselinePath = join(backupDir, 'reports', 'live-tools-effective-baseline.json')
  const effectiveV02Path = join(backupDir, 'reports', 'live-gateway', 'live-tools-effective.json')
  const finalIndexPath = join(backupDir, 'reports', 'final-index.json')
  const previousPackagePath = join(backupDir, 'previous-plugin', 'package.json')
  const previousManifestPath = join(backupDir, 'previous-plugin', 'openclaw.plugin.json')

  await assertDirectoryMode(backupDir, 0o700, 'Verified 0.2 upgrade backup')
  for (const [pathname, label] of [
    [join(backupDir, VERIFIED_MARKER), 'Verified marker'],
    [baselineConfigPath, 'Pre-0.2 profile config'],
    [effectiveBaselinePath, 'Pre-0.2 effective tools'],
    [effectiveV02Path, 'Verified 0.2 effective tools'],
    [finalIndexPath, 'Verified 0.2 install index'],
  ]) {
    await assertRegularFileMode(pathname, 0o600, label)
  }
  for (const [pathname, label] of [
    [previousPackagePath, 'Pre-0.2 package'],
    [previousManifestPath, 'Pre-0.2 manifest'],
  ]) {
    const stat = await lstat(pathname)
    assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file.`)
  }

  const [baselineConfig, effectiveBaseline, effectiveV02, finalIndex, previousPackage, previousManifest] = await Promise.all([
    readJson(baselineConfigPath, 'pre-0.2 profile config'),
    readJson(effectiveBaselinePath, 'pre-0.2 effective tools'),
    readJson(effectiveV02Path, 'verified 0.2 effective tools'),
    readJson(finalIndexPath, 'verified 0.2 install index'),
    readJson(previousPackagePath, 'pre-0.2 package'),
    readJson(previousManifestPath, 'pre-0.2 manifest'),
  ])

  assert(previousPackage.version === options.baselineVersion, `Verified baseline package must be ${options.baselineVersion}.`)
  assert(previousManifest.id === options.pluginId, 'Verified baseline plugin id mismatch.')
  assert(finalIndex.version === options.oldVersion, `Verified upgrade result must be ${options.oldVersion}.`)
  assert(finalIndex.installPath === installedPath, 'Verified upgrade install path mismatch.')
  assertSafeAbsolutePath(finalIndex.sourcePath, 'Verified upgrade sourcePath')
  validateEffectiveTools(effectiveBaseline, effectiveV02, {
    agentId: options.agentId,
    toolName: options.toolName,
    expectTool: true,
  })
  const plan = validateKnownV02Tools(baselineConfig, currentConfig, effectiveBaseline, options)

  return {
    schemaVersion: 1,
    backupDir,
    baselineConfigPath,
    effectiveBaselinePath,
    agentIndex: plan.agentIndex,
    restoreTools: plan.originalTools,
  }
}

export async function selectCompatibleV02UpgradeBackup(backupRoot, currentConfig, installedPath, options) {
  assertSafeAbsolutePath(backupRoot, 'Backup root')
  assertSafeAbsolutePath(installedPath, 'Installed plugin path')
  await assertDirectoryMode(backupRoot, 0o700, 'Backup root')

  const entries = await readdir(backupRoot, { withFileTypes: true })
  const verified = []
  for (const entry of entries) {
    if (!UPGRADE_DIRECTORY.test(entry.name)) continue
    const candidate = join(backupRoot, entry.name)
    assert(entry.isDirectory() && !entry.isSymbolicLink(), 'Upgrade backup entries must be real directories.')
    try {
      await assertRegularFileMode(join(candidate, VERIFIED_MARKER), 0o600, 'Verified marker')
      verified.push(candidate)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const compatible = []
  for (const candidate of verified) {
    try {
      compatible.push(await validateCompatibleBackup(candidate, currentConfig, installedPath, options))
    } catch (error) {
      if (error?.code === 'ENOENT') throw error
      if (/must have mode|must be a real|must be a regular|symlink/u.test(error.message)) throw error
    }
  }
  assert(
    compatible.length === 1,
    `Expected exactly one compatible verified 0.2 upgrade backup, found ${compatible.length}.`,
  )
  return compatible[0]
}
