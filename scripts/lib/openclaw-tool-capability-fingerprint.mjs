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

const PROFILE_FILTER_NOTICE = 'browser-filtered-by-profile'
const HASH = /^[a-f0-9]{64}$/u

export function validateNormalizedOpenClawToolPolicyNotices(value, {
  kind = 'catalog', label = 'OpenClaw tool inventory',
} = {}) {
  const keys = ['id', 'messageSha256', 'profileSha256', 'severity']
  if (!['catalog', 'effective'].includes(kind) || !Array.isArray(value)
    || value.length > 1 || (kind === 'catalog' && value.length !== 0)
    || value.some(notice => !notice || typeof notice !== 'object' || Array.isArray(notice)
      || JSON.stringify(Object.keys(notice).sort()) !== JSON.stringify(keys)
      || notice.id !== PROFILE_FILTER_NOTICE || notice.severity !== 'info'
      || typeof notice.messageSha256 !== 'string' || !HASH.test(notice.messageSha256)
      || typeof notice.profileSha256 !== 'string' || !HASH.test(notice.profileSha256))) {
    throw new Error(`${label} policy context is invalid`)
  }
  return value
}

/** Retain the one complete, informational profile decision; reject omissions. */
export function normalizeOpenClawToolPolicyNotices(value, {
  kind = 'catalog', label = 'OpenClaw tool inventory',
} = {}) {
  const notices = value?.notices ?? []
  if (value?.notices === null || !Array.isArray(notices)
    || notices.length > 1 || (kind === 'catalog' && notices.length !== 0)) {
    throw new Error(`${label} is incomplete`)
  }
  if (notices.length === 0) return validateNormalizedOpenClawToolPolicyNotices([], { kind, label })
  const notice = notices[0]
  if (kind !== 'effective' || !notice || typeof notice !== 'object' || Array.isArray(notice)
    || JSON.stringify(Object.keys(notice).sort()) !== JSON.stringify(['id', 'message', 'severity'])
    || notice.id !== PROFILE_FILTER_NOTICE || notice.severity !== 'info'
    || typeof notice.message !== 'string' || notice.message.trim().length === 0
    || Buffer.byteLength(notice.message) > 4_096
    || typeof value.profile !== 'string' || value.profile.trim().length === 0
    || Buffer.byteLength(value.profile) > 1_024
    || !Array.isArray(value.groups) || value.groups.some(group => !Array.isArray(group?.tools))
    || value.groups.some(group => group.tools.some(tool => tool?.id === 'browser'))) {
    throw new Error(`${label} is incomplete`)
  }
  return validateNormalizedOpenClawToolPolicyNotices([{
    id: notice.id,
    severity: notice.severity,
    messageSha256: sha256(notice.message),
    profileSha256: sha256(value.profile),
  }], { kind, label })
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
  kind = 'catalog',
} = {}) {
  if (typeof agentId !== 'string' || agentId.length === 0 || value?.agentId !== agentId) {
    throw new Error(`${label} is bound to the wrong agent`)
  }
  if (!Array.isArray(value?.groups)
    || value.groups.some(group => !group || typeof group !== 'object'
      || !Array.isArray(group.tools))) {
    throw new Error(`${label} is invalid`)
  }
  const bindings = value.groups.flatMap(group => group.tools.map(tool => ({ group, tool })))
  const ids = bindings.map(({ tool }) => tool?.id)
  if (ids.length === 0 || ids.some(id => typeof id !== 'string' || id.length === 0)
    || new Set(ids).size !== ids.length) {
    throw new Error(`${label} is invalid`)
  }
  const descriptors = bindings.map(({ group, tool }) => {
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
    return {
      id: tool.id,
      source,
      pluginId,
      channelId,
      descriptorSurface,
    }
  })
  const policyNotices = normalizeOpenClawToolPolicyNotices(value, { kind, label })
  return descriptors.map(({ descriptorSurface, ...identity }) => stable({
    ...identity,
    // Empty notices retain the previous byte-for-byte fingerprint. A supported
    // policy notice becomes part of the evidence, rather than being discarded.
    descriptorSurfaceSha256: sha256(JSON.stringify(policyNotices.length === 0 ? descriptorSurface : stable({
      schema: 'video-autoworker-openclaw-policy-bound-tool/v1',
      descriptorSurface,
      policyNotices,
    }))),
  })).toSorted((left, right) => left.id.localeCompare(right.id))
}
