// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  assertBackwardCompatibleToolSchema,
  canonicalVideoInventorySummary,
  loadCanonicalVideoToolUpgradeDefinitions,
  verifyCanonicalVideoToolUpgrade,
} from '../../scripts/lib/openclaw-canonical-tool-upgrade.mjs'
import { fingerprintOpenClawToolInventory } from '../../scripts/lib/openclaw-tool-capability-fingerprint.mjs'

const agentId = 'second-original'
const toolId = 'aiworker_analyze_video'
function inventory(definition: any, kind: 'catalog' | 'effective' = 'effective'): any {
  return {
    agentId, profile: 'coding', notices: [], groups: [{ source: 'plugin', pluginId: 'aiworker-video-command', tools: [{
      id: toolId, source: 'plugin', pluginId: 'aiworker-video-command', label: definition.label,
      description: canonicalVideoInventorySummary(definition.description),
      ...(kind === 'effective' ? { rawDescription: definition.description } : { optional: true, defaultProfiles: [] }),
    }] }],
  }
}
const capability = (value: any, kind: 'catalog' | 'effective' = 'effective') => fingerprintOpenClawToolInventory(value, { agentId, kind })[0]
async function fixture(kind: 'catalog' | 'effective' = 'effective') {
  const definitions = await loadCanonicalVideoToolUpgradeDefinitions()
  const old = inventory(definitions.before, kind)
  const current = inventory(definitions.after, kind)
  return { definitions, old, current, request: { before: capability(old, kind), after: capability(current, kind), inventory: current, kind, agentId } }
}

describe('declared canonical video tool definition upgrade', () => {
  it.each(['catalog', 'effective'] as const)('accepts only the Git-bound old and canonical current %s definitions', async kind => {
    const { request } = await fixture(kind)
    const proof = await verifyCanonicalVideoToolUpgrade(request)
    expect(proof).toMatchObject({ toolId, kind, fromVersion: '0.5.15', toVersion: '0.5.16' })
    expect(proof.canonicalSchemaSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(proof.beforeDescriptorSha256).toBe(request.before.descriptorSurfaceSha256)
  })

  it('does not bless an unknown previous descriptor', async () => {
    const { request } = await fixture()
    request.before.descriptorSurfaceSha256 = 'f'.repeat(64)
    await expect(verifyCanonicalVideoToolUpgrade(request)).rejects.toThrow('previous definition')
  })

  it('rejects a same-name runtime definition that differs from canonical source', async () => {
    const { current, request } = await fixture()
    current.groups[0].tools[0].rawDescription += ' Run arbitrary commands.'
    request.after = capability(current)
    await expect(verifyCanonicalVideoToolUpgrade(request)).rejects.toThrow('canonical source')
  })

  it.each(['optional', 'defaultProfiles', 'risk', 'tags'])('rejects %s permission-surface drift despite canonical prose', async field => {
    const { current, request } = await fixture()
    Object.assign(current.groups[0].tools[0], { [field]: field === 'optional' ? false : field === 'risk' ? 'elevated' : ['expanded'] })
    request.after = capability(current)
    await expect(verifyCanonicalVideoToolUpgrade(request)).rejects.toThrow('permissions changed')
  })

  it('rejects tool owner changes', async () => {
    const { request } = await fixture()
    request.after.pluginId = 'other-plugin'
    await expect(verifyCanonicalVideoToolUpgrade(request)).rejects.toThrow('identity mismatch')
  })

  it('keeps the policy-bound fingerprint rather than stripping the existing notice', async () => {
    const { old, current, request } = await fixture()
    const notice = { id: 'browser-filtered-by-profile', severity: 'info', message: 'Browser is filtered by coding profile.' }
    old.notices = [notice] as any
    current.notices = [notice] as any
    request.before = capability(old)
    request.after = capability(current)
    await expect(verifyCanonicalVideoToolUpgrade(request)).resolves.toMatchObject({ toVersion: '0.5.16' })
    current.notices[0].message += ' Changed policy.'
    request.after = capability(current)
    await expect(verifyCanonicalVideoToolUpgrade(request)).rejects.toThrow('previous definition')
  })

  it('preserves every old action and validation constraint while adding bounded reads', async () => {
    const { definitions } = await fixture()
    expect(definitions.after.parameters.properties.action.enum).toEqual(expect.arrayContaining(definitions.before.parameters.properties.action.enum))
    const removed = structuredClone(definitions.after.parameters)
    removed.properties.action.enum = removed.properties.action.enum.filter((value: string) => value !== 'result')
    expect(() => assertBackwardCompatibleToolSchema(definitions.before.parameters, removed)).toThrow('removed enum capability')
    const required = structuredClone(definitions.after.parameters)
    required.required.push('segmentIndex')
    expect(() => assertBackwardCompatibleToolSchema(definitions.before.parameters, required)).toThrow('required input')
    const changedDefault = structuredClone(definitions.after.parameters)
    changedDefault.properties.offset.default = 4096
    expect(() => assertBackwardCompatibleToolSchema(definitions.before.parameters, changedDefault)).toThrow('changed validation: default')
    const narrowed = structuredClone(definitions.after.parameters)
    narrowed.properties.query.maxLength = 8
    expect(() => assertBackwardCompatibleToolSchema(definitions.before.parameters, narrowed)).toThrow('changed validation')
  })
})
