import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  buildV02Transformation,
  createActiveRollbackMarker,
  deriveTelegramOwnerSenderPolicy,
  fingerprintPluginPayload,
  selectCompatibleV02UpgradeBackup,
  selectTelegramDirectSession,
  validateDoctorReport,
  validateEffectiveTools,
  validateIndexRecord,
  validateKnownV02Tools,
  validateLiveGatewayToolCatalog,
  validateOtherProfileConfig,
  validatePluginSource,
  validatePluginPayloadMatch,
  validatePluginSenderHash,
  validatePreUpgradeIndexRecord,
  validateRestoredConfig,
  validateRuntimeReport,
  validateTelegramIngressPolicy,
} from '../../../scripts/validate-aiworker-video-command-upgrade.mjs'

const pluginId = 'aiworker-video-command'
const agentId = 'second-original'
const toolName = 'aiworker_analyze_video'
const baselineIds = ['apply_patch', 'edit', 'exec', 'memory_get', 'memory_search', 'process', 'read', 'web_fetch', 'web_search', 'write']
const telegramOwnerId = '123456789'
const allowedSenderSha256 = createHash('sha256')
  .update('aiworker-video-command:telegram-sender:v1\0')
  .update(telegramOwnerId)
  .digest('hex')
const temporaryRoots = []

function baselineConfig() {
  return {
    meta: { lastTouchedAt: 'before', stable: true },
    tools: { profile: 'coding' },
    agents: {
      list: [
        { id: 'main', tools: { allow: ['read'] } },
        { id: agentId, tools: {
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
    channels: { telegram: {} },
    bindings: [{ agentId, match: { channel: 'telegram' } }],
  }
}

function effectiveReport(profile = 'coding', ids = baselineIds) {
  return {
    agentId,
    profile,
    groups: [{ id: 'core', source: 'core', tools: ids.map(id => ({ id })) }],
  }
}

function v02Config() {
  const config = baselineConfig()
  config.meta.lastTouchedAt = 'after-v02'
  config.agents.list[1].tools = {
    allow: [...baselineIds, toolName],
    loopDetection: { enabled: true },
    profile: 'full',
  }
  return config
}

async function writeJson(pathname, value, mode = 0o600) {
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, { mode })
}

async function createCompatibleBackup(root, name = 'upgrade-20260810-010203.abc123') {
  const backupRoot = join(root, 'backups')
  const backupDir = join(backupRoot, name)
  const reports = join(backupDir, 'reports')
  const live = join(reports, 'live-gateway')
  const previous = join(backupDir, 'previous-plugin')
  const installedPath = join(root, 'profile', 'extensions', pluginId)
  await mkdir(backupRoot, { recursive: true, mode: 0o700 })
  await mkdir(backupDir, { mode: 0o700 })
  await mkdir(live, { recursive: true, mode: 0o700 })
  await mkdir(previous, { recursive: true, mode: 0o700 })
  await writeFile(join(backupDir, '.verified'), '', { mode: 0o600 })
  await writeJson(join(backupDir, 'openclaw.json'), baselineConfig())
  await writeJson(join(reports, 'live-tools-effective-baseline.json'), effectiveReport())
  await writeJson(join(live, 'live-tools-effective.json'), effectiveReport('full', [...baselineIds, toolName]))
  await writeJson(join(reports, 'final-index.json'), {
    source: 'path',
    sourcePath: join(root, 'repo', 'plugin'),
    installPath: installedPath,
    version: '0.2.0',
    installedAt: '2026-08-10T01:02:03.000Z',
  })
  await writeJson(join(previous, 'package.json'), { version: '0.1.0' }, 0o644)
  await writeJson(join(previous, 'openclaw.plugin.json'), { id: pluginId }, 0o644)
  return { backupRoot, backupDir, installedPath }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(pathname => rm(pathname, { recursive: true, force: true })))
})

describe('video-command 0.2 to 0.3 upgrade policy', () => {
  it('matches installed payload only to the audited canonical fingerprint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-payload-policy-'))
    temporaryRoots.push(root)
    const source = join(root, 'source')
    const installed = join(root, 'installed')
    const peerTarget = join(root, 'openclaw-peer')
    await mkdir(source)
    await mkdir(installed)
    await mkdir(peerTarget)
    await mkdir(join(installed, 'node_modules'))
    await symlink(peerTarget, join(installed, 'node_modules', 'openclaw'), 'dir')
    await writeFile(join(source, 'index.js'), 'export default {}\n')
    await writeFile(join(installed, 'index.js'), 'export default {}\n')
    const expectedFingerprint = await fingerprintPluginPayload(source)
    const peerRealPath = await realpath(peerTarget)
    await expect(validatePluginPayloadMatch({
      sourceRoot: source,
      installedRoot: installed,
      expectedFingerprint,
      expectedPeerLinkText: peerTarget,
      expectedPeerRealPath: peerRealPath,
    })).resolves.toMatchObject({ expectedFingerprint, installedFingerprint: expectedFingerprint })
    await writeFile(join(installed, 'node_modules', 'unexpected.txt'), 'tampered\n')
    await expect(validatePluginPayloadMatch({
      sourceRoot: source,
      installedRoot: installed,
      expectedFingerprint,
      expectedPeerLinkText: peerTarget,
      expectedPeerRealPath: peerRealPath,
    })).rejects.toThrow(/contain only/u)
  })

  it('derives the known 0.2 transformation while retaining the full pre-0.2 tools object', () => {
    const plan = buildV02Transformation(baselineConfig(), effectiveReport(), { pluginId, agentId, toolName })
    expect(plan.agentIndex).toBe(1)
    expect(plan.originalTools.allow).toContain('image')
    expect(plan.originalTools.profile).toBeUndefined()
    expect(plan.transformedTools).toEqual(v02Config().agents.list[1].tools)
  })

  it('proves current tools are exactly the known 0.2 transformation before restoration', () => {
    expect(() => validateKnownV02Tools(
      baselineConfig(), v02Config(), effectiveReport(), { pluginId, agentId, toolName },
    )).not.toThrow()
    const drifted = v02Config()
    drifted.agents.list[1].tools.allow.push('image')
    expect(() => validateKnownV02Tools(
      baselineConfig(), drifted, effectiveReport(), { pluginId, agentId, toolName },
    )).toThrow(/refusing blind restoration/u)
  })

  it('accepts only protected Telegram DM policy and one second-original binding', () => {
    for (const dmPolicy of [undefined, 'pairing', 'allowlist']) {
      const config = v02Config()
      if (dmPolicy !== undefined) config.channels.telegram.dmPolicy = dmPolicy
      expect(() => validateTelegramIngressPolicy(config, { agentId })).not.toThrow()
    }
    const open = v02Config()
    open.channels.telegram.dmPolicy = 'open'
    expect(() => validateTelegramIngressPolicy(open, { agentId })).toThrow(/open access is forbidden/u)
    const duplicate = v02Config()
    duplicate.bindings.push({ agentId, match: { channel: 'telegram', accountId: 'other' } })
    expect(() => validateTelegramIngressPolicy(duplicate, { agentId })).toThrow(/Exactly one/u)
    const missing = v02Config()
    missing.bindings = []
    expect(() => validateTelegramIngressPolicy(missing, { agentId })).toThrow(/Exactly one/u)
    const wrong = v02Config()
    wrong.bindings[0].agentId = 'main'
    expect(() => validateTelegramIngressPolicy(wrong, { agentId })).toThrow(/must target second-original/u)
    const duplicateAgent = v02Config()
    duplicateAgent.agents.list.push(structuredClone(duplicateAgent.agents.list[1]))
    expect(() => validateTelegramIngressPolicy(duplicateAgent, { agentId })).toThrow(/exactly one second-original/u)
  })

  it('derives only a redacted hash from one canonical Telegram command owner', () => {
    const config = v02Config()
    config.commands.ownerAllowFrom.push('discord:987654321')
    const plan = deriveTelegramOwnerSenderPolicy(config)
    expect(plan).toEqual({
      schemaVersion: 1,
      ownerCount: 1,
      allowedSenderSha256,
    })
    expect(JSON.stringify(plan)).not.toContain(telegramOwnerId)
  })

  it.each([
    ['missing owner list', config => { delete config.commands.ownerAllowFrom }],
    ['duplicate Telegram owners', config => { config.commands.ownerAllowFrom.push('telegram:987654321') }],
    ['Telegram wildcard', config => { config.commands.ownerAllowFrom = ['telegram:*'] }],
    ['other-channel wildcard', config => { config.commands.ownerAllowFrom.push('discord:*') }],
    ['non-numeric Telegram owner', config => { config.commands.ownerAllowFrom = ['telegram:owner'] }],
    ['non-canonical Telegram owner', config => { config.commands.ownerAllowFrom = [`tg:${telegramOwnerId}`] }],
    ['ambiguous unscoped owner', config => { config.commands.ownerAllowFrom.push('987654321') }],
  ])('rejects %s without exposing an owner id', (_label, mutate) => {
    const config = v02Config()
    mutate(config)
    let message = ''
    try {
      deriveTelegramOwnerSenderPolicy(config)
    } catch (error) {
      message = error.message
    }
    expect(message).toBeTruthy()
    expect(message).not.toContain(telegramOwnerId)
    expect(message).not.toContain('987654321')
  })

  it('requires plugin config to contain only the approved sender hash', () => {
    const config = v02Config()
    config.plugins.entries[pluginId].config = { allowedSenderSha256 }
    expect(() => validatePluginSenderHash(config, { pluginId, allowedSenderSha256 })).not.toThrow()
    config.plugins.entries[pluginId].config.extra = true
    expect(() => validatePluginSenderHash(config, { pluginId, allowedSenderSha256 })).toThrow(/only/u)
  })

  it('restores only the complete target tools object and preserves later unrelated config', () => {
    const current = v02Config()
    current.channels = { telegram: { enabled: true } }
    const restored = structuredClone(current)
    restored.meta.lastTouchedAt = 'after-v03'
    restored.meta.lastTouchedVersion = '2026.7.1-2'
    restored.agents.list[1].tools = structuredClone(baselineConfig().agents.list[1].tools)
    expect(() => validateRestoredConfig(
      current, restored, baselineConfig(), effectiveReport(), { pluginId, agentId, toolName },
    )).not.toThrow()
    const gated = structuredClone(restored)
    gated.plugins.entries[pluginId].config = { allowedSenderSha256 }
    expect(() => validateRestoredConfig(
      current,
      gated,
      baselineConfig(),
      effectiveReport(),
      { pluginId, agentId, toolName, allowedSenderSha256 },
    )).not.toThrow()
    restored.agents.list[0].tools.allow.push('exec')
    expect(() => validateRestoredConfig(
      current, restored, baselineConfig(), effectiveReport(), { pluginId, agentId, toolName },
    )).toThrow(/outside the exact/u)
  })

  it('requires 0.2 effective tools to be baseline plus the tool and 0.3 to be the exact baseline', () => {
    expect(() => validateEffectiveTools(effectiveReport(), effectiveReport('full', [...baselineIds, toolName]), {
      agentId, toolName, expectTool: true,
    })).not.toThrow()
    expect(() => validateEffectiveTools(effectiveReport(), effectiveReport('coding'), {
      agentId, toolName, expectTool: false,
    })).not.toThrow()
    expect(() => validateEffectiveTools(effectiveReport(), effectiveReport('coding', [...baselineIds, 'image']), {
      agentId, toolName, expectTool: false,
    })).toThrow(/baseline exactly/u)
  })

  it('selects exactly one compatible verified 0.2 upgrade backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-upgrade-policy-'))
    temporaryRoots.push(root)
    const fixture = await createCompatibleBackup(root)
    await expect(selectCompatibleV02UpgradeBackup(
      fixture.backupRoot,
      v02Config(),
      fixture.installedPath,
      { pluginId, agentId, toolName, baselineVersion: '0.1.0', oldVersion: '0.2.0' },
    )).resolves.toMatchObject({
      backupDir: fixture.backupDir,
      agentIndex: 1,
      restoreTools: baselineConfig().agents.list[1].tools,
    })
  })

  it('fails closed for no compatible backup, duplicate compatible backups, or current-tool drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'video-upgrade-policy-'))
    temporaryRoots.push(root)
    const fixture = await createCompatibleBackup(root)
    const options = { pluginId, agentId, toolName, baselineVersion: '0.1.0', oldVersion: '0.2.0' }
    const drifted = v02Config()
    drifted.agents.list[1].tools.allow.push('image')
    await expect(selectCompatibleV02UpgradeBackup(
      fixture.backupRoot, drifted, fixture.installedPath, options,
    )).rejects.toThrow(/found 0/u)
    await createCompatibleBackup(root, 'upgrade-20260810-020304.def456')
    await expect(selectCompatibleV02UpgradeBackup(
      fixture.backupRoot, v02Config(), fixture.installedPath, options,
    )).rejects.toThrow(/found 2/u)
  })

  it('requires hook-only 0.3 source and rejects any residual tool contract', () => {
    const packageJson = { version: '0.3.0', peerDependencies: { openclaw: '>=2026.7.1-2' } }
    const manifest = {
      id: pluginId,
      activation: { onStartup: true, onCapabilities: ['hook'] },
      configSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowedSenderSha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        },
      },
    }
    expect(() => validatePluginSource(packageJson, manifest, {
      pluginId, expectedVersion: '0.3.0', toolName,
    })).not.toThrow()
    manifest.contracts = { tools: [toolName] }
    expect(() => validatePluginSource(packageJson, manifest, {
      pluginId, expectedVersion: '0.3.0', toolName,
    })).toThrow(/must not declare/u)
  })

  it('distinguishes the exact 0.2 tool runtime from the exact 0.3 hook-only runtime', () => {
    const v02 = {
      plugin: { id: pluginId, status: 'loaded', version: '0.2.0' },
      typedHooks: [{ name: 'before_dispatch' }, { name: 'before_prompt_build' }, { name: 'before_tool_call' }],
      tools: [{ names: [toolName], optional: true }],
      diagnostics: [],
    }
    const v03 = {
      plugin: { id: pluginId, status: 'loaded', version: '0.3.0' },
      typedHooks: [{ name: 'before_dispatch' }],
      tools: [],
      diagnostics: [],
    }
    expect(() => validateRuntimeReport(v02, {
      pluginId, expectedVersion: '0.2.0', toolName, expectTool: true,
    })).not.toThrow()
    expect(() => validateRuntimeReport(v03, {
      pluginId, expectedVersion: '0.3.0', toolName, expectTool: false,
    })).not.toThrow()
    v03.typedHooks.push({ name: 'before_tool_call' })
    expect(() => validateRuntimeReport(v03, {
      pluginId, expectedVersion: '0.3.0', toolName, expectTool: false,
    })).toThrow(/only before_dispatch/u)
  })

  it('requires the 0.2 live catalog tool and its absence after 0.3', () => {
    const catalog = {
      agentId,
      profiles: [],
      groups: [{
        id: `plugin:${pluginId}`,
        source: 'plugin',
        pluginId,
        tools: [{ id: toolName, source: 'plugin', pluginId, optional: true }],
      }],
    }
    expect(() => validateLiveGatewayToolCatalog(catalog, {
      pluginId, agentId, toolName, expectTool: true,
    })).not.toThrow()
    expect(() => validateLiveGatewayToolCatalog({ agentId, profiles: [], groups: [] }, {
      pluginId, agentId, toolName, expectTool: false,
    })).not.toThrow()
  })

  it('selects exactly one Telegram direct session', () => {
    expect(selectTelegramDirectSession({
      count: 1,
      hasMore: false,
      nextOffset: null,
      totalCount: 1,
      sessions: [{ key: 'agent:second-original:telegram:direct:owner' }],
    }, { agentId })).toBe('agent:second-original:telegram:direct:owner')
  })

  it('pins index, rollback marker, doctor output, and other-profile isolation', async () => {
    expect(() => validateIndexRecord({
      source: 'path',
      sourcePath: '/canonical/plugin',
      installPath: '/profile/extensions/plugin',
      version: '0.3.0',
      installedAt: '2026-08-10T01:02:03.000Z',
    }, {
      expectedVersion: '0.3.0',
      expectedSourcePath: '/canonical/plugin',
      expectedInstallPath: '/profile/extensions/plugin',
    })).not.toThrow()
    await expect(validatePreUpgradeIndexRecord({
      source: 'path',
      sourcePath: '/canonical/plugin',
      installPath: '/profile/extensions/plugin',
      version: '0.2.0',
      installedAt: '2026-08-10T01:02:03.000Z',
    }, {
      expectedVersion: '0.2.0',
      canonicalSourcePath: '/canonical/plugin',
      backupRoot: '/safe/backups',
      expectedInstallPath: '/profile/extensions/plugin',
      pluginId,
    })).resolves.toMatchObject({ kind: 'canonical' })
    expect(createActiveRollbackMarker({
      pluginId,
      version: '0.2.0',
      sourcePath: '/safe/backups/upgrade-20260810-010203.abc123/previous-plugin',
      pluginFingerprint: 'a'.repeat(64),
      createdAt: '2026-08-10T01:02:03.000Z',
    })).toMatchObject({ schemaVersion: 1, version: '0.2.0' })
    expect(() => validateDoctorReport('No plugin issues detected.\n', pluginId)).not.toThrow()
    expect(() => validateDoctorReport([
      'Compatibility:',
      `- ${pluginId} is hook-only. This remains a supported compatibility path, but it has not migrated to explicit capability registration yet. [info]`,
      'Docs: https://docs.openclaw.ai/plugin',
      '',
    ].join('\n'), pluginId, { allowHookOnly: true })).not.toThrow()
    const other = { plugins: { allow: ['telegram'], entries: {} }, agents: { list: [] } }
    expect(() => validateOtherProfileConfig(other, { pluginId, toolName })).not.toThrow()
    other.tools = { alsoAllow: [toolName] }
    expect(() => validateOtherProfileConfig(other, { pluginId, toolName })).toThrow()
  })
})
