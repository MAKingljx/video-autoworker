import { createHash } from 'node:crypto'

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  }
  return value
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Fingerprint the descriptor surface exposed by one agent-bound OpenClaw
 * inventory. OpenClaw 2026.7.1-2 tools.catalog/tools.effective do not expose
 * input schemas, implementations or side-effect contracts; callers must not
 * present this value as proof that those hidden contracts are unchanged.
 */
export function fingerprintOpenClawToolInventory(value, {
  agentId,
  label = 'OpenClaw tool inventory',
} = {}) {
  if (typeof agentId !== 'string' || agentId.length === 0 || value?.agentId !== agentId) {
    throw new Error(`${label} is bound to the wrong agent`)
  }
  if (!Array.isArray(value?.groups)
    || value.groups.some(group => !group || typeof group !== 'object'
      || !Array.isArray(group.tools))) {
    throw new Error(`${label} is invalid`)
  }
  if (value.notices !== undefined
    && (!Array.isArray(value.notices) || value.notices.length > 0)) {
    throw new Error(`${label} is incomplete`)
  }
  const bindings = value.groups.flatMap(group => group.tools.map(tool => ({ group, tool })))
  const ids = bindings.map(({ tool }) => tool?.id)
  if (ids.length === 0 || ids.some(id => typeof id !== 'string' || id.length === 0)
    || new Set(ids).size !== ids.length) {
    throw new Error(`${label} is invalid`)
  }
  return bindings.map(({ group, tool }) => {
    if (!tool || typeof tool !== 'object' || Array.isArray(tool)) {
      throw new Error(`${label} is invalid`)
    }
    const source = tool.source ?? group.source
    const pluginId = tool.pluginId ?? group.pluginId ?? null
    const channelId = tool.channelId ?? group.channelId ?? null
    if (!['core', 'plugin', 'channel', 'mcp'].includes(source)
      || (pluginId !== null && (typeof pluginId !== 'string' || pluginId.length === 0))
      || (channelId !== null && (typeof channelId !== 'string' || channelId.length === 0))) {
      throw new Error(`${label} has an invalid tool owner`)
    }
    const descriptorSurface = stable({
      label: typeof tool.label === 'string' ? tool.label : null,
      description: typeof tool.description === 'string' ? tool.description : null,
      rawDescription: typeof tool.rawDescription === 'string' ? tool.rawDescription : null,
      optional: typeof tool.optional === 'boolean' ? tool.optional : null,
      defaultProfiles: Array.isArray(tool.defaultProfiles)
        ? tool.defaultProfiles.map(item => String(item)).toSorted()
        : null,
      risk: tool.risk ?? null,
      tags: Array.isArray(tool.tags) ? tool.tags.map(item => String(item)).toSorted() : null,
    })
    return stable({
      id: tool.id,
      source,
      pluginId,
      channelId,
      descriptorSurfaceSha256: sha256(JSON.stringify(descriptorSurface)),
    })
  }).toSorted((left, right) => left.id.localeCompare(right.id))
}
