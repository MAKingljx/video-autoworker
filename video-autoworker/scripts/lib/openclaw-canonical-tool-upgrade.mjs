import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { URL, fileURLToPath, pathToFileURL } from 'node:url'
import { createTaskChainTool } from '../../openclaw-plugins/aiworker-video-command/lib/task-chain-tool.js'
import { readGitProductFile, resolveGitSourceLayout } from './git-source-layout.mjs'
import { fingerprintOpenClawToolInventory } from './openclaw-tool-capability-fingerprint.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const toolPath = 'openclaw-plugins/aiworker-video-command/lib/task-chain-tool.js'
const pluginId = 'aiworker-video-command'
const toolId = 'aiworker_analyze_video'
const declaration = Object.freeze({
  fromVersion: '0.5.16', toVersion: '0.5.17',
  sourceCommit: '96f6dafce48a7ecc43ecc6d218fbbc1af3543fa6',
  sourceSha256: '450873716ecf72dcf943482648f5efbb394961da8f643ee9c62a1263a7354ddb',
})
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const equal = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right))
const digest = value => createHash('sha256').update(value).digest('hex')

// Match OpenClaw 2026.9.2's one-paragraph inventory display, not a second tool definition.
export function canonicalVideoInventorySummary(description) {
  if (typeof description !== 'string' || /[\r\n]/u.test(description)) throw new Error('canonical video description must be one paragraph')
  const value = description.replace(/\s+/gu, ' ').trim()
  if (value.length <= 120) return value
  let sliced = ''
  for (const char of value) {
    if (sliced.length + char.length > 117) break
    sliced += char
  }
  const boundary = sliced.lastIndexOf(' ')
  return `${(boundary >= 48 ? sliced.slice(0, boundary) : sliced).trimEnd()}...`
}

// Only annotation changes, added optional properties and wider enums are allowed.
// Unrecognized validation changes fail closed instead of guessing schema implication.
export function assertBackwardCompatibleToolSchema(before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') throw new Error('tool schema changed incompatibly')
  const annotations = new Set(['description', 'title', 'examples'])
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (annotations.has(key)) continue
    if (key === 'properties') {
      for (const [name, schema] of Object.entries(before.properties ?? {})) {
        assertBackwardCompatibleToolSchema(schema, after.properties?.[name])
      }
    } else if (key === 'enum') {
      if (!Array.isArray(before.enum) || !Array.isArray(after.enum)
        || before.enum.some(value => !after.enum.some(next => equal(value, next)))) throw new Error('tool schema removed enum capability')
    } else if (key === 'required') {
      if ((after.required ?? []).some(value => !(before.required ?? []).includes(value))) throw new Error('tool schema added required input')
    } else if (!equal(before[key], after[key])) throw new Error(`tool schema changed validation: ${key}`)
  }
}

let definitionsPromise
export async function loadCanonicalVideoToolUpgradeDefinitions() {
  definitionsPromise ??= (async () => {
    const { gitRoot } = resolveGitSourceLayout(root)
    const source = readGitProductFile(gitRoot, declaration.sourceCommit, toolPath).toString('utf8')
    if (digest(source) !== declaration.sourceSha256) throw new Error('historical video tool source binding failed')
    const previousPackage = JSON.parse(readGitProductFile(gitRoot, declaration.sourceCommit,
      'openclaw-plugins/aiworker-video-command/package.json').toString('utf8'))
    const currentPackage = JSON.parse(readFileSync(new URL('../../openclaw-plugins/aiworker-video-command/package.json', import.meta.url), 'utf8'))
    if (previousPackage.version !== declaration.fromVersion || currentPackage.version !== declaration.toVersion) throw new Error('undeclared video tool version transition')
    // Load the hash-pinned historical factory without creating another checkout.
    // Its relative utility imports use the existing canonical plugin directory;
    // neither factory executes tools, starts processes, or accesses business data.
    const moduleUrl = pathToFileURL(`${root}${toolPath}`)
    const linked = source.replace(/from\s+'(\.\/[^']+)'/gu, (_match, relative) => `from ${JSON.stringify(new URL(relative, moduleUrl).href)}`)
    const previousModule = await import(`data:text/javascript;base64,${Buffer.from(linked).toString('base64')}`)
    const context = { agentId: 'second-original' }
    const before = previousModule.createTaskChainTool({ context })
    const after = createTaskChainTool({ context })
    if (before.name !== toolId || after.name !== toolId || before.executionMode !== after.executionMode) throw new Error('video tool execution contract changed')
    assertBackwardCompatibleToolSchema(before.parameters, after.parameters)
    return { before, after, declaration }
  })()
  return definitionsPromise
}

function inventoryWithDefinition(inventory, definition, kind) {
  const copy = structuredClone(inventory)
  const matches = copy.groups.flatMap(group => group.tools.filter(tool => tool.id === toolId))
  if (matches.length !== 1) throw new Error('canonical video inventory binding failed')
  matches[0].label = definition.label
  matches[0].description = canonicalVideoInventorySummary(definition.description)
  if (kind === 'effective') matches[0].rawDescription = definition.description
  else delete matches[0].rawDescription
  return copy
}

/** Reconstruct the old fingerprint with unchanged permissions and canonical old prose. */
export async function verifyCanonicalVideoToolUpgrade({ before, after, inventory, kind, agentId }) {
  if (before?.id !== toolId || after?.id !== toolId || agentId !== 'second-original'
    || !['catalog', 'effective'].includes(kind)
    || before.source !== 'plugin' || after.source !== 'plugin'
    || before.pluginId !== pluginId || after.pluginId !== pluginId
    || before.channelId !== null || after.channelId !== null) throw new Error('canonical video upgrade identity mismatch')
  const definitions = await loadCanonicalVideoToolUpgradeDefinitions()
  const fingerprint = definition => fingerprintOpenClawToolInventory(
    inventoryWithDefinition(inventory, definition, kind), { kind, agentId },
  ).find(tool => tool.id === toolId)
  // Keeping every non-description field from the observed inventory in both
  // fingerprints makes optional/profile/risk/tag/owner drift fail against the
  // original baseline. Policy notices remain bound by the shared fingerprinter.
  if (!equal(fingerprint(definitions.after), after)) throw new Error('video descriptor does not match canonical source')
  if (!equal(fingerprint(definitions.before), before)) throw new Error('video descriptor is outside the declared previous definition or permissions changed')
  return {
    toolId, kind, ...declaration,
    beforeDescriptorSha256: before.descriptorSurfaceSha256,
    afterDescriptorSha256: after.descriptorSurfaceSha256,
    canonicalSchemaSha256: digest(JSON.stringify(stable(definitions.after.parameters))),
  }
}
