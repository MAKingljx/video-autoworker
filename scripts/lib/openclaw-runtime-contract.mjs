import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const OPENCLAW_RUNTIME_VERSION = '2026.9.2'
export const OPENCLAW_PACKAGE_NAME = 'openclaw'
export const OPENCLAW_GATEWAY_RUNTIME_EXPORT = 'openclaw/plugin-sdk/gateway-runtime'
export const OPENCLAW_SOURCE_PLUGIN_PEER = '>=2026.9.2'
export const OPENCLAW_RUNTIME_COMPATIBILITY_SCHEMA = 'video-autoworker-openclaw-runtime-compatibility/v1'
export const OPENCLAW_RUNTIME_RPC_METHODS = Object.freeze([
  'tools.catalog', 'tools.effective', 'health', 'logs.tail', 'config.get', 'config.patch',
])

const LEGACY_INSTALLED_PEERS = Object.freeze({
  'aiworker-director-brain': new Set(['2026.7.1-2']),
  'aiworker-video-command': new Set(['>=2026.7.1-2']),
})

export function acceptedInstalledOpenClawPeer(pluginId, peer) {
  return peer === OPENCLAW_SOURCE_PLUGIN_PEER
    || LEGACY_INSTALLED_PEERS[pluginId]?.has(peer) === true
}

export const OPENCLAW_SECRETREF_WRAPPER = Object.freeze({
  relativePath: 'ai-worker/bin/aiworker-openclaw-keychain-secretref',
  sourceCommit: '627208bb723ed7a040e02ab0adf89210ac3f0ee2',
  sha256: 'f545f740273bd520e4c3ddcd755c180ae0f955c84a81ed4de2b5ae7c0f4172a7',
  mode: 0o700,
  passEnv: Object.freeze(['HOME']),
})

const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u
const CONFIG_REVISION_TOKEN_PATTERN = /^hmac-sha256:v1:[A-Za-z0-9_-]{43}$/u

export function isOpenClawConfigRevisionToken(value) {
  return typeof value === 'string' && CONFIG_REVISION_TOKEN_PATTERN.test(value)
}

function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key))
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

/**
 * Validate and return the exact stable DTO covered by compatibilitySha256.
 * Volatile live evidence must remain outside this object.
 */
export function canonicalOpenClawRuntimeCompatibilityCore(value) {
  if (!exactKeys(value, ['schema', 'openclaw', 'rpc', 'plugins', 'secretRef', 'source'])
    || value.schema !== OPENCLAW_RUNTIME_COMPATIBILITY_SCHEMA
    || !exactKeys(value.openclaw, ['name', 'version', 'packageJsonSha256', 'gatewayRuntimeExport'])
    || value.openclaw.name !== OPENCLAW_PACKAGE_NAME
    || value.openclaw.version !== OPENCLAW_RUNTIME_VERSION
    || !SHA256_PATTERN.test(value.openclaw.packageJsonSha256 || '')
    || value.openclaw.gatewayRuntimeExport !== OPENCLAW_GATEWAY_RUNTIME_EXPORT
    || !exactKeys(value.rpc, ['methods', 'sharedStateMode'])
    || !Array.isArray(value.rpc.methods)
    || value.rpc.methods.length !== OPENCLAW_RUNTIME_RPC_METHODS.length
    || !value.rpc.methods.every((method, index) => method === OPENCLAW_RUNTIME_RPC_METHODS[index])
    || value.rpc.sharedStateMode !== 'read-only'
    || !exactKeys(value.plugins, ['video', 'director'])
    || !exactKeys(value.plugins.video, ['id', 'version', 'peerPolicy'])
    || value.plugins.video.id !== 'aiworker-video-command'
    || value.plugins.video.version !== '0.5.14'
    || !acceptedInstalledOpenClawPeer(value.plugins.video.id, value.plugins.video.peerPolicy)
    || !exactKeys(value.plugins.director, ['id', 'version', 'peerPolicy'])
    || value.plugins.director.id !== 'aiworker-director-brain'
    || value.plugins.director.version !== '0.4.0'
    || !acceptedInstalledOpenClawPeer(value.plugins.director.id, value.plugins.director.peerPolicy)
    || !exactKeys(value.secretRef, [
      'wrapperSourceCommit', 'wrapperSha256', 'commandRelativePath', 'passEnv', 'argumentCount',
    ])
    || value.secretRef.wrapperSourceCommit !== OPENCLAW_SECRETREF_WRAPPER.sourceCommit
    || value.secretRef.wrapperSha256 !== OPENCLAW_SECRETREF_WRAPPER.sha256
    || value.secretRef.commandRelativePath !== OPENCLAW_SECRETREF_WRAPPER.relativePath
    || !Array.isArray(value.secretRef.passEnv)
    || value.secretRef.passEnv.length !== OPENCLAW_SECRETREF_WRAPPER.passEnv.length
    || !value.secretRef.passEnv.every((name, index) => name === OPENCLAW_SECRETREF_WRAPPER.passEnv[index])
    || value.secretRef.argumentCount !== 3
    || !exactKeys(value.source, ['commit', 'contractSha256'])
    || !COMMIT_PATTERN.test(value.source.commit || '')
    || !SHA256_PATTERN.test(value.source.contractSha256 || '')) {
    throw new Error('OpenClaw runtime compatibility DTO is invalid')
  }
  return canonical(value)
}

export function openClawRuntimeCompatibilityDigest(value) {
  const core = canonicalOpenClawRuntimeCompatibilityCore(value)
  return createHash('sha256').update(JSON.stringify(core)).digest('hex')
}

export function validateOpenClawRuntimeCompatibility(value) {
  if (!exactKeys(value, [
    'schema', 'openclaw', 'rpc', 'plugins', 'secretRef', 'source', 'compatibilitySha256',
  ]) || !SHA256_PATTERN.test(value.compatibilitySha256 || '')) {
    throw new Error('OpenClaw runtime compatibility result is invalid')
  }
  const { compatibilitySha256, ...core } = value
  if (openClawRuntimeCompatibilityDigest(core) !== compatibilitySha256) {
    throw new Error('OpenClaw runtime compatibility digest is invalid')
  }
  return canonical(value)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'runtime-version') process.stdout.write(`${OPENCLAW_RUNTIME_VERSION}\n`)
  else if (process.argv[2] === 'source-plugin-peer') process.stdout.write(`${OPENCLAW_SOURCE_PLUGIN_PEER}\n`)
  else process.exitCode = 2
}
