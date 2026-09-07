#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  acceptedInstalledOpenClawPeer,
  canonicalOpenClawRuntimeCompatibilityCore,
  OPENCLAW_GATEWAY_RUNTIME_EXPORT,
  OPENCLAW_PACKAGE_NAME,
  OPENCLAW_RUNTIME_COMPATIBILITY_SCHEMA,
  OPENCLAW_RUNTIME_RPC_METHODS,
  OPENCLAW_RUNTIME_VERSION,
  OPENCLAW_SECRETREF_WRAPPER,
  openClawRuntimeCompatibilityDigest,
  validateOpenClawRuntimeCompatibility,
} from './lib/openclaw-runtime-contract.mjs'
import { isValidExecSecretReference } from './lib/openclaw-secret-reference.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const stable = value => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value
const canonical = value => JSON.stringify(stable(value))
function fail(message) { throw new Error(`OpenClaw runtime compatibility failed: ${message}`) }
function file(pathname, label, mode = null) {
  if (!isAbsolute(pathname) || resolve(pathname) !== pathname || realpathSync(pathname) !== pathname) fail(`${label} path`)
  const entry = lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (mode === null ? (entry.mode & 0o022) !== 0 : (entry.mode & 0o777) !== mode)) fail(`${label} identity`)
  return readFileSync(pathname)
}
function json(pathname, label, mode = null) {
  try { return JSON.parse(file(pathname, label, mode)) } catch { fail(`${label} JSON`) }
}
function args(argv) {
  const names = ['--repository-root', '--source-commit', '--openclaw-package-root', '--profile-config', '--video-plugin-root', '--director-plugin-root']
  const values = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!names.includes(argv[i]) || !argv[i + 1] || Object.hasOwn(values, argv[i])) fail('arguments')
    values[argv[i]] = argv[i + 1]
  }
  if (Object.keys(values).length !== names.length || !/^[a-f0-9]{40}$/u.test(values['--source-commit'])) fail('arguments')
  return values
}

export async function verifyOpenClawRuntimeCompatibility(values) {
  const repositoryRoot = realpathSync(values['--repository-root'])
  const sourceCommit = execFileSync('/usr/bin/git', [
    '-C', repositoryRoot, 'rev-parse', '--verify', 'HEAD^{commit}',
  ], { encoding: 'utf8' }).trim()
  if (sourceCommit !== values['--source-commit']) fail('source commit')
  const packageRoot = realpathSync(values['--openclaw-package-root'])
  const packageJsonPath = join(packageRoot, 'package.json')
  const packageSource = file(packageJsonPath, 'OpenClaw package')
  const packageValue = JSON.parse(packageSource)
  if (packageValue.name !== OPENCLAW_PACKAGE_NAME || packageValue.version !== OPENCLAW_RUNTIME_VERSION) fail('package identity')
  const scopedRequire = createRequire(packageJsonPath)
  const sdkPath = scopedRequire.resolve(OPENCLAW_GATEWAY_RUNTIME_EXPORT)
  const sdk = await import(pathToFileURL(sdkPath).href)
  if (typeof sdk.callGatewayFromCli !== 'function') fail('public Gateway SDK export')
  const plugins = {}
  for (const [key, id, expectedVersion, root] of [
    ['video', 'aiworker-video-command', '0.5.14', values['--video-plugin-root']],
    ['director', 'aiworker-director-brain', '0.4.0', values['--director-plugin-root']],
  ]) {
    const packageManifest = json(join(root, 'package.json'), `${key} package`)
    const pluginManifest = json(join(root, 'openclaw.plugin.json'), `${key} manifest`)
    const peer = packageManifest.peerDependencies?.openclaw
    if (packageManifest.version !== expectedVersion || pluginManifest.id !== id
      || pluginManifest.version !== expectedVersion || !acceptedInstalledOpenClawPeer(id, peer)) fail(`${key} plugin contract`)
    plugins[key] = { id, version: expectedVersion, peerPolicy: peer }
  }
  const config = json(values['--profile-config'], 'profile config', 0o600)
  if (!isValidExecSecretReference(config.gateway?.auth?.token, config.secrets?.providers)) fail('SecretRef contract')
  const wrapperPath = join(process.env.HOME, OPENCLAW_SECRETREF_WRAPPER.relativePath)
  const wrapperSource = file(wrapperPath, 'SecretRef wrapper', OPENCLAW_SECRETREF_WRAPPER.mode)
  if (sha256(wrapperSource) !== OPENCLAW_SECRETREF_WRAPPER.sha256) fail('SecretRef wrapper digest')
  const sourceContract = file(join(repositoryRoot, 'scripts/lib/openclaw-runtime-contract.mjs'), 'runtime contract', 0o644)
  const result = {
    schema: OPENCLAW_RUNTIME_COMPATIBILITY_SCHEMA,
    openclaw: {
      name: OPENCLAW_PACKAGE_NAME,
      version: OPENCLAW_RUNTIME_VERSION,
      packageJsonSha256: sha256(packageSource),
      gatewayRuntimeExport: OPENCLAW_GATEWAY_RUNTIME_EXPORT,
    },
    rpc: {
      methods: [...OPENCLAW_RUNTIME_RPC_METHODS],
      sharedStateMode: 'read-only',
    },
    plugins,
    secretRef: {
      wrapperSourceCommit: OPENCLAW_SECRETREF_WRAPPER.sourceCommit,
      wrapperSha256: OPENCLAW_SECRETREF_WRAPPER.sha256,
      commandRelativePath: OPENCLAW_SECRETREF_WRAPPER.relativePath,
      passEnv: [...OPENCLAW_SECRETREF_WRAPPER.passEnv],
      argumentCount: 3,
    },
    source: { commit: sourceCommit, contractSha256: sha256(sourceContract) },
  }
  const core = canonicalOpenClawRuntimeCompatibilityCore(result)
  return validateOpenClawRuntimeCompatibility({
    ...core,
    compatibilitySha256: openClawRuntimeCompatibilityDigest(core),
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  verifyOpenClawRuntimeCompatibility(args(process.argv.slice(2)))
    .then(value => process.stdout.write(`${canonical(value)}\n`))
    .catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })
}
