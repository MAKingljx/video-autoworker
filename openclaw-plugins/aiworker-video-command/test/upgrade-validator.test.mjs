import { describe, expect, it } from 'vitest'

import {
  buildConfigPlan,
  createActiveRollbackMarker,
  validateConfigAfter,
  validateDoctorReport,
  validateIndexRecord,
  validateLiveGatewayToolCatalog,
  validateOtherProfileConfig,
  validatePluginSource,
  validatePreUpgradeIndexRecord,
  validateRuntimeReport,
} from '../../../scripts/validate-aiworker-video-command-upgrade.mjs'

const pluginId = 'aiworker-video-command'
const agentId = 'second-original'
const toolName = 'aiworker_analyze_video'

function productionLikeConfig() {
  return {
    meta: { lastTouchedAt: 'before', stable: true },
    tools: { profile: 'coding' },
    agents: {
      list: [
        { id: 'main', tools: { allow: ['read'] } },
        { id: agentId, tools: { allow: ['read', 'exec'] } },
      ],
    },
    plugins: {
      allow: ['telegram', pluginId],
      entries: { [pluginId]: { enabled: true } },
    },
  }
}

describe('video-command upgrade validator', () => {
  it('plans one per-agent alsoAllow append without changing the existing allow list', () => {
    const plan = buildConfigPlan(productionLikeConfig(), { pluginId, agentId, toolName })
    expect(plan).toEqual({
      agentIndex: 1,
      originalAllow: ['read', 'exec'],
      originalAlsoAllow: [],
      nextAlsoAllow: [toolName],
    })
  })

  it('accepts only the approved append plus OpenClaw touch metadata', () => {
    const before = productionLikeConfig()
    const after = structuredClone(before)
    after.meta.lastTouchedAt = 'after'
    after.meta.lastTouchedVersion = '2026.7.1-2'
    after.agents.list[1].tools.alsoAllow = [toolName]

    expect(() => validateConfigAfter(before, after, { pluginId, agentId, toolName })).not.toThrow()
    after.agents.list[1].tools.allow.push('process')
    expect(() => validateConfigAfter(before, after, { pluginId, agentId, toolName }))
      .toThrow(/outside the approved/u)
  })

  it.each([
    ['duplicate target agent', config => config.agents.list.push({ id: agentId, tools: { allow: ['read'] } })],
    ['global tool grant', config => { config.tools.alsoAllow = [toolName] }],
    ['other-agent tool grant', config => { config.agents.list[0].tools.alsoAllow = [toolName] }],
    ['tool in ordinary allow', config => { config.agents.list[1].tools.allow.push(toolName) }],
  ])('rejects %s', (_label, mutate) => {
    const config = productionLikeConfig()
    mutate(config)
    expect(() => buildConfigPlan(config, { pluginId, agentId, toolName })).toThrow()
  })

  it('requires the pinned 0.2.0 package and exact optional-tool declaration', () => {
    const packageJson = {
      version: '0.2.0',
      peerDependencies: { openclaw: '>=2026.7.1-2' },
    }
    const manifest = {
      id: pluginId,
      activation: { onStartup: true, onCapabilities: ['hook', 'tool'] },
      contracts: { tools: [toolName] },
      toolMetadata: { [toolName]: { optional: true } },
      configSchema: { type: 'object', additionalProperties: false },
    }
    expect(() => validatePluginSource(packageJson, manifest, {
      pluginId,
      expectedVersion: '0.2.0',
      toolName,
    })).not.toThrow()
    manifest.toolMetadata[toolName].optional = false
    expect(() => validatePluginSource(packageJson, manifest, {
      pluginId,
      expectedVersion: '0.2.0',
      toolName,
    })).toThrow(/optional/u)
  })

  it('requires loaded runtime hooks, one optional tool, and clean diagnostics', () => {
    const report = {
      plugin: { id: pluginId, status: 'loaded', version: '0.2.0' },
      typedHooks: [
        { name: 'before_dispatch' },
        { name: 'before_prompt_build' },
        { name: 'before_tool_call' },
      ],
      tools: [{ names: [toolName], optional: true }],
      diagnostics: [],
    }
    expect(() => validateRuntimeReport(report, {
      pluginId,
      expectedVersion: '0.2.0',
      toolName,
      expectTool: true,
    })).not.toThrow()
    report.typedHooks = report.typedHooks.filter(hook => hook.name !== 'before_tool_call')
    expect(() => validateRuntimeReport(report, {
      pluginId,
      expectedVersion: '0.2.0',
      toolName,
      expectTool: true,
    })).toThrow(/before_tool_call/u)
  })

  it('requires the 0.2.0-only tool in the live second-original Gateway catalog', () => {
    const report = {
      agentId,
      profiles: [],
      groups: [{
        id: `plugin:${pluginId}`,
        label: pluginId,
        source: 'plugin',
        pluginId,
        tools: [{ id: toolName, source: 'plugin', pluginId, optional: true }],
      }],
    }
    expect(() => validateLiveGatewayToolCatalog(report, {
      pluginId,
      agentId,
      toolName,
      expectTool: true,
    })).not.toThrow()
    report.agentId = 'main'
    expect(() => validateLiveGatewayToolCatalog(report, {
      pluginId,
      agentId,
      toolName,
      expectTool: true,
    })).toThrow(/second-original/u)
  })

  it('requires the rolled-back live Gateway catalog to omit the 0.2.0 tool', () => {
    expect(() => validateLiveGatewayToolCatalog({ agentId, profiles: [], groups: [] }, {
      pluginId,
      agentId,
      toolName,
      expectTool: false,
    })).not.toThrow()
    expect(() => validateLiveGatewayToolCatalog({
      agentId,
      profiles: [],
      groups: [{
        id: `plugin:${pluginId}`,
        source: 'plugin',
        pluginId,
        tools: [{ id: toolName, source: 'plugin', pluginId, optional: true }],
      }],
    }, {
      pluginId,
      agentId,
      toolName,
      expectTool: false,
    })).toThrow(/rolled-back/u)
  })

  it('pins the official path index record and accepts only known doctor output', () => {
    expect(() => validateIndexRecord({
      source: 'path',
      sourcePath: '/canonical/plugin',
      installPath: '/profile/extensions/plugin',
      version: '0.2.0',
      installedAt: '2026-08-10T01:02:03.000Z',
    }, {
      expectedVersion: '0.2.0',
      expectedSourcePath: '/canonical/plugin',
      expectedInstallPath: '/profile/extensions/plugin',
    })).not.toThrow()
    expect(() => validateDoctorReport('No plugin issues detected.\n', pluginId)).not.toThrow()
    expect(() => validateDoctorReport('unexpected warning\n', pluginId)).toThrow()
  })

  it('accepts the canonical pre-upgrade source and rejects arbitrary backup paths', async () => {
    const record = {
      source: 'path',
      sourcePath: '/canonical/plugin',
      installPath: '/profile/extensions/plugin',
      version: '0.1.0',
      installedAt: '2026-08-10T01:02:03.000Z',
    }
    const options = {
      expectedVersion: '0.1.0',
      canonicalSourcePath: '/canonical/plugin',
      backupRoot: '/safe/backups',
      expectedInstallPath: '/profile/extensions/plugin',
      pluginId,
    }

    await expect(validatePreUpgradeIndexRecord(record, options)).resolves.toEqual({
      kind: 'canonical',
      sourcePath: '/canonical/plugin',
    })
    await expect(validatePreUpgradeIndexRecord({
      ...record,
      sourcePath: '/safe/backups/unapproved/previous-plugin',
    }, options)).rejects.toThrow(/approved rollback backup path/u)
  })

  it('creates an exact active rollback marker and rejects non-SHA fingerprints', () => {
    expect(createActiveRollbackMarker({
      pluginId,
      version: '0.1.0',
      sourcePath: '/safe/backups/upgrade-20260810-010203.abc123/previous-plugin',
      pluginFingerprint: 'a'.repeat(64),
      createdAt: '2026-08-10T01:02:03.000Z',
    })).toEqual({
      schemaVersion: 1,
      pluginId,
      version: '0.1.0',
      sourcePath: '/safe/backups/upgrade-20260810-010203.abc123/previous-plugin',
      pluginFingerprint: 'a'.repeat(64),
      createdAt: '2026-08-10T01:02:03.000Z',
    })
    expect(() => createActiveRollbackMarker({
      pluginId,
      version: '0.1.0',
      sourcePath: '/safe/backups/upgrade-20260810-010203.abc123/previous-plugin',
      pluginFingerprint: 'not-a-sha',
    })).toThrow(/SHA-256/u)
  })

  it('fails closed when any other profile grants or configures the plugin tool', () => {
    const other = { plugins: { allow: ['telegram'], entries: {} }, agents: { list: [] } }
    expect(() => validateOtherProfileConfig(other, { pluginId, toolName })).not.toThrow()
    other.tools = { alsoAllow: [toolName] }
    expect(() => validateOtherProfileConfig(other, { pluginId, toolName })).toThrow()
    expect(() => validateOtherProfileConfig({ agents: { list: 'malformed' } }, { pluginId, toolName }))
      .toThrow(/must be an array/u)
  })
})
