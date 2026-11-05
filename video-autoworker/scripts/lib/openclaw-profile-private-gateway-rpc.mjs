import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  OPENCLAW_GATEWAY_RUNTIME_EXPORT,
  OPENCLAW_PACKAGE_NAME,
  OPENCLAW_RUNTIME_VERSION,
  isOpenClawConfigRevisionToken,
} from './openclaw-runtime-contract.mjs'
import { attachmentForProfile, validateImageCapabilityManifest } from './openclaw-image-capability-contract.mjs'

const MAX_RESULT_BYTES = 8 * 1024 * 1024
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/u
const OPERATIONS = new Set(['catalog', 'effective', 'health', 'config-get', 'config-patch'])

function fail() {
  throw new Error('openclaw_profile_private_gateway_rpc_failed')
}

function requiredEnv(name) {
  const value = process.env[name] || ''
  if (value.length === 0 || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) fail()
  return value
}

function absolute(value) {
  if (!value || !path.isAbsolute(value) || path.resolve(value) !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail()
  return value
}

function profileBinding() {
  const profile = requiredEnv('AIWORKER_OPENCLAW_CAPABILITY_PROFILE')
  const agentId = requiredEnv('AIWORKER_OPENCLAW_CAPABILITY_AGENT')
  const port = Number(requiredEnv('AIWORKER_OPENCLAW_CAPABILITY_PORT'))
  if (!IDENTIFIER.test(profile) || !IDENTIFIER.test(agentId) || !Number.isSafeInteger(port)
    || port < 1024 || port > 65535) fail()
  const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ops/openclaw/image-capability-attachments.json')
  const file = fs.lstatSync(manifestPath)
  if (!file.isFile() || file.isSymbolicLink() || file.uid !== process.getuid() || (file.mode & 0o022) !== 0) fail()
  let manifest
  try { manifest = validateImageCapabilityManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8'))) } catch { fail() }
  const attachment = attachmentForProfile(manifest, profile)
  if (attachment.agentId !== agentId || attachment.gatewayPort !== port) fail()
  return { profile, agentId, port }
}

function readOpenClawPackageRoot() {
  const entry = fs.realpathSync(absolute(process.env.OPENCLAW_BIN || ''))
  let current = path.dirname(entry)
  for (let depth = 0; depth < 4; depth += 1) {
    const packagePath = path.join(current, 'package.json')
    if (fs.existsSync(packagePath)) {
      const file = fs.lstatSync(packagePath)
      if (!file.isFile() || file.isSymbolicLink()) fail()
      const manifest = JSON.parse(fs.readFileSync(packagePath, 'utf8'))
      if (manifest?.name === OPENCLAW_PACKAGE_NAME && manifest?.version === OPENCLAW_RUNTIME_VERSION) return current
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  fail()
}

async function callGateway() {
  const root = readOpenClawPackageRoot()
  const scopedRequire = createRequire(path.join(root, 'package.json'))
  let exported
  try { exported = scopedRequire.resolve(OPENCLAW_GATEWAY_RUNTIME_EXPORT) } catch { fail() }
  const loaded = await import(pathToFileURL(exported).href)
  if (typeof loaded.callGatewayFromCli !== 'function') fail()
  return loaded.callGatewayFromCli
}

function safeOutput(pathname, data, sensitive = []) {
  pathname = absolute(pathname)
  const entry = fs.lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid() || entry.nlink !== 1
    || (entry.mode & 0o7777) !== 0o600 || entry.size !== 0 || fs.realpathSync(pathname) !== pathname
    || Buffer.byteLength(data) > MAX_RESULT_BYTES || sensitive.some(value => value && data.includes(value))) fail()
  const descriptor = fs.openSync(pathname, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW)
  try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function validateConfigPatchReplacePaths(binding, patch, replacePaths) {
  if (!Array.isArray(replacePaths) || replacePaths.length > 1
    || replacePaths.some(item => typeof item !== 'string' || item.length === 0 || item.length > 256)) fail()
  if (replacePaths.length === 0) return []
  if (!plainObject(patch.agents)) fail()
  const hasList = Object.hasOwn(patch.agents, 'list')
  const hasEntries = Object.hasOwn(patch.agents, 'entries')
  if (hasList === hasEntries) fail()
  const expected = hasList
    ? 'agents.list[].tools.alsoAllow'
    : `agents.entries.${binding.agentId}.tools.alsoAllow`
  if (replacePaths[0] !== expected) fail()
  if (expected.startsWith('agents.list')) {
    if (!Array.isArray(patch.agents.list)
      || !patch.agents.list.some(agent => plainObject(agent) && agent.id === binding.agentId
        && plainObject(agent.tools) && Array.isArray(agent.tools.alsoAllow))) fail()
  } else {
    const agent = patch.agents.entries?.[binding.agentId]
    if (!plainObject(patch.agents.entries) || !plainObject(agent)
      || !plainObject(agent.tools) || !Array.isArray(agent.tools.alsoAllow)) fail()
  }
  return [...replacePaths]
}

function requestedReplacePaths(binding, patch) {
  const raw = process.env.AIWORKER_OPENCLAW_CAPABILITY_REPLACE_PATHS || ''
  if (raw.length === 0) return []
  if (raw.length > 1024 || /[\u0000-\u001f\u007f]/u.test(raw)) fail()
  let replacePaths
  try { replacePaths = JSON.parse(raw) } catch { fail() }
  return validateConfigPatchReplacePaths(binding, patch, replacePaths)
}

function request(operation, binding) {
  if (operation === 'catalog') return { method: 'tools.catalog', params: { agentId: binding.agentId, includePlugins: true } }
  if (operation === 'effective') return {
    method: 'tools.effective', params: { agentId: binding.agentId, sessionKey: requiredEnv('AIWORKER_OPENCLAW_CAPABILITY_SESSION_KEY') },
  }
  if (operation === 'health') return { method: 'health', params: { probe: true } }
  if (operation === 'config-get') return { method: 'config.get', params: {} }
  if (operation === 'config-patch') {
    const baseHash = requiredEnv('AIWORKER_OPENCLAW_CAPABILITY_CONFIG_REVISION')
    const patchPath = absolute(requiredEnv('AIWORKER_OPENCLAW_CAPABILITY_PATCH_FILE'))
    const entry = fs.lstatSync(patchPath)
    if (!isOpenClawConfigRevisionToken(baseHash) || !entry.isFile() || entry.isSymbolicLink()
      || entry.uid !== process.getuid() || entry.nlink !== 1 || (entry.mode & 0o077) !== 0
      || entry.size <= 0 || entry.size > 1024 * 1024) fail()
    const raw = fs.readFileSync(patchPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail()
    const replacePaths = requestedReplacePaths(binding, parsed)
    return { method: 'config.patch', params: {
      raw, baseHash, ...(replacePaths.length > 0 ? { replacePaths } : {}),
    } }
  }
  fail()
}

async function main() {
  const [operation, outputPath, ...extra] = process.argv.slice(2)
  if (!OPERATIONS.has(operation) || !outputPath || extra.length !== 0) fail()
  const binding = profileBinding()
  const token = requiredEnv('OPENCLAW_GATEWAY_TOKEN')
  const sessionKey = process.env.AIWORKER_OPENCLAW_CAPABILITY_SESSION_KEY || ''
  const invoke = await callGateway()
  let result
  try {
    const invocation = request(operation, binding)
    result = await invoke(invocation.method, {
      url: `ws://127.0.0.1:${binding.port}`,
      token,
      timeout: 20_000,
    }, invocation.params, { expectFinal: true, sharedStateMode: 'read-only' })
  } catch { fail() }
  const output = `${JSON.stringify(result)}\n`
  safeOutput(outputPath, output, [token, sessionKey])
}

let isMain = false
try { isMain = fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { /* imported */ }
if (isMain) {
  main().catch(() => {
    process.stderr.write('Profile-scoped private Gateway RPC failed without exposing credentials.\n')
    process.exitCode = 1
  })
}
