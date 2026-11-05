import { createHash } from 'node:crypto'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'

import { readOpenClawAgentEntries, writeOpenClawAgentEntries } from './openclaw-agent-config.mjs'

export const IMAGE_CAPABILITY_SCHEMA = 'aiworker-openclaw-image-capabilities/v2'
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/u
const VERSION = /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/u
const LEGACY_IMAGE_PLUGIN_LOAD_PATH = /(?:^|\/)ai-worker\/services\/openclaw-image-command\/releases\/[a-f0-9]{40}$/u

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (plainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}

function same(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right))
}

function fail(message) {
  throw new Error(`image_capability_${message}`)
}

function list(value, label) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)
    || new Set(value).size !== value.length) fail(`${label}_invalid`)
  return value
}

function relativeMediaRoot(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value) && !isAbsolute(value) && normalize(value) === value
    && !value.split(sep).includes('..') && value.split(sep).every(Boolean)
}

export function clone(value) {
  return structuredClone(value)
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function validateImageCapabilityManifest(value) {
  if (!plainObject(value) || value.schema !== IMAGE_CAPABILITY_SCHEMA
    || !plainObject(value.plugin) || !Array.isArray(value.attachments)
    || Object.keys(value).some(key => !['schema', 'plugin', 'attachments'].includes(key))) {
    fail('manifest_invalid')
  }
  const plugin = value.plugin
  if (Object.keys(plugin).sort().join(',') !== 'id,retiredTools,tools,version'
    || !IDENTIFIER.test(plugin.id) || !VERSION.test(plugin.version)
    || value.attachments.length === 0 || value.attachments.length > 16) fail('manifest_invalid')
  const tools = list(plugin.tools, 'plugin_tools')
  const retiredTools = list(plugin.retiredTools, 'plugin_retired_tools')
  if (tools.some(tool => !IDENTIFIER.test(tool)) || retiredTools.some(tool => !IDENTIFIER.test(tool))
    || retiredTools.some(tool => tools.includes(tool))) fail('manifest_invalid')
  const profiles = new Set()
  const agents = new Set()
  const roots = new Set()
  const stateRoots = new Set()
  const gatewayPorts = new Set()
  const attachments = value.attachments.map(attachment => {
    if (!plainObject(attachment) || Object.keys(attachment).sort().join(',') !== 'agentId,gatewayPort,legacyScope,mediaRoot,profile,stateRoot'
      || !IDENTIFIER.test(attachment.profile) || !IDENTIFIER.test(attachment.agentId)
      || !relativeMediaRoot(attachment.stateRoot) || !relativeMediaRoot(attachment.mediaRoot)
      || !Number.isSafeInteger(attachment.gatewayPort) || attachment.gatewayPort < 1024 || attachment.gatewayPort > 65535
      || typeof attachment.legacyScope !== 'boolean'
      || profiles.has(attachment.profile) || agents.has(`${attachment.profile}\0${attachment.agentId}`)
      || roots.has(attachment.mediaRoot) || stateRoots.has(attachment.stateRoot)
      || gatewayPorts.has(attachment.gatewayPort)) fail('attachment_invalid')
    profiles.add(attachment.profile)
    agents.add(`${attachment.profile}\0${attachment.agentId}`)
    roots.add(attachment.mediaRoot)
    stateRoots.add(attachment.stateRoot)
    gatewayPorts.add(attachment.gatewayPort)
    return Object.freeze({ ...attachment })
  })
  const legacy = attachments.filter(attachment => attachment.legacyScope)
  if (legacy.length !== 1 || legacy[0].profile !== 'image-studio' || legacy[0].agentId !== 'image-studio') {
    fail('legacy_attachment_invalid')
  }
  return Object.freeze({ schema: value.schema, plugin: Object.freeze({ ...plugin, tools: Object.freeze([...tools]),
    retiredTools: Object.freeze([...retiredTools]) }),
    attachments: Object.freeze(attachments) })
}

export function attachmentForProfile(manifest, profile) {
  const validated = validateImageCapabilityManifest(manifest)
  if (!IDENTIFIER.test(profile)) fail('profile_invalid')
  const attachment = validated.attachments.find(item => item.profile === profile)
  if (!attachment) fail('profile_not_declared')
  return attachment
}

export function resolveAttachmentMediaRoot(home, attachment) {
  if (typeof home !== 'string' || !isAbsolute(home) || normalize(home) !== home
    || /[\u0000-\u001f\u007f]/u.test(home)) fail('home_invalid')
  if (!attachment || !relativeMediaRoot(attachment.mediaRoot)) fail('attachment_invalid')
  const root = join(home, attachment.mediaRoot)
  if (relative(home, root).startsWith(`..${sep}`) || relative(home, root) === '') fail('media_root_invalid')
  return root
}

export function resolveAttachmentStateRoot(home, attachment) {
  if (typeof home !== 'string' || !isAbsolute(home) || normalize(home) !== home
    || /[\u0000-\u001f\u007f]/u.test(home)) fail('home_invalid')
  if (!attachment || !relativeMediaRoot(attachment.stateRoot)) fail('attachment_invalid')
  const root = join(home, attachment.stateRoot)
  if (relative(home, root).startsWith(`..${sep}`) || relative(home, root) === '') fail('state_root_invalid')
  return root
}

export function imageReferenceRoots(home, manifest) {
  const validated = validateImageCapabilityManifest(manifest)
  return [join(home, 'ai-worker/output/covers'), ...validated.attachments.map(item => resolveAttachmentMediaRoot(home, item))]
}

function profileAgent(config, attachment) {
  if (!plainObject(config) || !plainObject(config.agents)) fail('config_invalid')
  const agents = readOpenClawAgentEntries(config)
  if (agents.length !== 1 || agents[0]?.id !== attachment.agentId) fail('agent_binding_invalid')
  return agents[0]
}

function assertConfigShape(config, manifest, attachment) {
  profileAgent(config, attachment)
  if (!plainObject(config.plugins)) fail('plugins_invalid')
  list(config.plugins.allow, 'plugin_allowlist')
  if (!plainObject(config.plugins.entries)) fail('plugin_entries_invalid')
  if (attachment.legacyScope && (attachment.profile !== 'image-studio' || attachment.agentId !== 'image-studio')) {
    fail('legacy_attachment_invalid')
  }
  return validateImageCapabilityManifest(manifest).plugin
}

function legacyImagePluginLoadPaths(config, attachment) {
  if (!attachment.legacyScope) return []
  const paths = config.plugins?.load?.paths
  if (paths === undefined) return []
  if (!Array.isArray(paths) || paths.some(value => typeof value !== 'string' || value.length === 0 || value.length > 4_096)) {
    fail('plugin_load_paths_invalid')
  }
  return paths.filter(value => LEGACY_IMAGE_PLUGIN_LOAD_PATH.test(value))
}

export function isImageCapabilityAttached(config, manifest, attachment) {
  try {
    const plugin = assertConfigShape(config, manifest, attachment)
    const agent = profileAgent(config, attachment)
    const tools = plainObject(agent.tools) ? agent.tools : {}
    const entry = config.plugins.entries[plugin.id]
    const targetBindingValid = attachment.legacyScope
      ? entry?.config?.targetAgentId === undefined
      : entry?.config?.targetAgentId === attachment.agentId
    const legacySourceRetired = legacyImagePluginLoadPaths(config, attachment).length === 0
    return plugin.tools.every(tool => tools.alsoAllow?.includes(tool) === true)
      && plugin.retiredTools.every(tool => tools.alsoAllow?.includes(tool) !== true)
      && config.plugins.allow.includes(plugin.id)
      && entry?.enabled === true
      && entry.config?.releaseReady === true
      && targetBindingValid
      && legacySourceRetired
  } catch {
    return false
  }
}

// This is the only configuration surface owned by an attachment. The image
// application service retains queueing, idempotency, cancellation and media
// policy; no profile receives a separate task chain.
export function renderImageCapabilityConfig(config, manifest, attachment) {
  const plugin = assertConfigShape(config, manifest, attachment)
  const next = clone(config)
  const agent = profileAgent(next, attachment)
  const existingTools = agent.tools === undefined ? {} : agent.tools
  if (!plainObject(existingTools)) fail('agent_tools_invalid')
  const existingAllow = existingTools.alsoAllow === undefined ? [] : list(existingTools.alsoAllow, 'agent_tool_allowlist')
  const keptAllow = existingAllow.filter(tool => !plugin.retiredTools.includes(tool))
  agent.tools = {
    ...existingTools,
    alsoAllow: [...keptAllow, ...plugin.tools.filter(tool => !keptAllow.includes(tool))],
  }
  writeOpenClawAgentEntries(next, [agent])

  const pluginAllow = list(next.plugins.allow, 'plugin_allowlist')
  next.plugins.allow = pluginAllow.includes(plugin.id) ? [...pluginAllow] : [...pluginAllow, plugin.id]
  const existing = next.plugins.entries[plugin.id]
  if (existing !== undefined && !plainObject(existing)) fail('plugin_entry_invalid')
  const existingConfig = existing?.config === undefined ? {} : existing.config
  if (!plainObject(existingConfig)) fail('plugin_config_invalid')
  if (existingConfig.targetAgentId !== undefined && existingConfig.targetAgentId !== attachment.agentId) {
    fail('plugin_agent_conflict')
  }
  if (existingConfig.releaseReady !== undefined && existingConfig.releaseReady !== true) {
    fail('plugin_readiness_conflict')
  }
  const capabilityConfig = { ...existingConfig, releaseReady: true }
  // The existing image-studio profile has a trusted, profile-local default
  // binding. Omitting the redundant field lets its first install validate
  // before OpenClaw has loaded this plugin's optional config schema.
  if (attachment.legacyScope) delete capabilityConfig.targetAgentId
  else capabilityConfig.targetAgentId = attachment.agentId
  next.plugins.entries[plugin.id] = {
    ...existing,
    enabled: true,
    config: capabilityConfig,
  }
  const retiredLoadPaths = legacyImagePluginLoadPaths(next, attachment)
  if (retiredLoadPaths.length > 0) {
    next.plugins.load.paths = next.plugins.load.paths.filter(value => !retiredLoadPaths.includes(value))
    if (next.plugins.load.paths.length === 0 && Object.keys(next.plugins.load).length === 1) delete next.plugins.load
  }
  return next
}

export function renderImageCapabilityPatch(config, manifest, attachment) {
  const next = renderImageCapabilityConfig(config, manifest, attachment)
  const legacyLayout = Object.hasOwn(config.agents, 'list')
  const agentPatch = legacyLayout
    ? { list: next.agents.list }
    : { entries: { [attachment.agentId]: next.agents.entries[attachment.agentId] } }
  const plugin = validateImageCapabilityManifest(manifest).plugin
  const patch = {
    agents: agentPatch,
    plugins: {
      allow: next.plugins.allow,
      entries: { [plugin.id]: next.plugins.entries[plugin.id] },
    },
  }
  if (!same(config.plugins.load, next.plugins.load)) {
    patch.plugins.load = next.plugins.load === undefined ? null : { paths: next.plugins.load.paths }
  }
  return patch
}

// OpenClaw protects destructive array changes behind an explicit path-level
// acknowledgement. This component only needs that acknowledgement while
// retiring one of its own legacy tools; unrelated agent arrays remain outside
// its ownership boundary.
export function imageCapabilityReplacePaths(config, manifest, attachment) {
  const plugin = assertConfigShape(config, manifest, attachment)
  const agent = profileAgent(config, attachment)
  const tools = agent.tools === undefined ? {} : agent.tools
  if (!plainObject(tools)) fail('agent_tools_invalid')
  const allowed = tools.alsoAllow === undefined ? [] : list(tools.alsoAllow, 'agent_tool_allowlist')
  const replacePaths = []
  if (plugin.retiredTools.some(tool => allowed.includes(tool))) {
    replacePaths.push(Object.hasOwn(config.agents, 'list')
      ? 'agents.list[].tools.alsoAllow'
      : `agents.entries.${attachment.agentId}.tools.alsoAllow`)
  }
  if (legacyImagePluginLoadPaths(config, attachment).length > 0) replacePaths.push('plugins.load.paths')
  return replacePaths
}

export function assertImageCapabilityPluginManifest(value, manifest) {
  const plugin = validateImageCapabilityManifest(manifest).plugin
  if (!plainObject(value) || value.id !== plugin.id || value.version !== plugin.version
    || !same(value?.contracts?.tools, plugin.tools)
    || !plainObject(value?.toolMetadata)
    || !plugin.tools.every(tool => value.toolMetadata?.[tool]?.optional === true)
    || Object.keys(value.toolMetadata).some(tool => !plugin.tools.includes(tool))) {
    fail('plugin_manifest_invalid')
  }
  return value
}

export function attachmentEvidence(config, manifest, attachment) {
  const next = renderImageCapabilityConfig(config, manifest, attachment)
  const plugin = validateImageCapabilityManifest(manifest).plugin
  return {
    schema: 'aiworker-openclaw-image-capability-attachment/v1',
    profile: attachment.profile,
    agentId: attachment.agentId,
    pluginId: plugin.id,
    pluginVersion: plugin.version,
    toolIds: plugin.tools,
    attached: isImageCapabilityAttached(next, manifest, attachment),
    configSha256: sha256(JSON.stringify(stable(next))),
  }
}
