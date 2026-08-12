#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  fingerprintPluginPayload,
  validateOfficialOpenClawPeerLink,
} from './lib/aiworker-video-command-upgrade-policy.mjs'

const GIT_SHA = /^[a-f0-9]{40}$/u
const SHA256 = /^[a-f0-9]{64}$/u
const BACKUP_NAME = /^status-upgrade-[0-9]{8}-[0-9]{6}\.[A-Za-z0-9]+$/u
const PREVIOUS_VERSION = '0.4.0'
const CANDIDATE_VERSION = '0.4.1'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function assertAbsolute(pathname, label) {
  assert(typeof pathname === 'string' && pathname.length > 0, `${label} is required.`)
  assert(!/[\u0000-\u001f\u007f]/u.test(pathname), `${label} contains control characters.`)
  assert(isAbsolute(pathname) && resolve(pathname) === pathname, `${label} must be normalized and absolute.`)
}

async function readJson(pathname, label) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(pathname, 'utf8'))
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`)
  }
  assert(parsed && typeof parsed === 'object' && !Array.isArray(parsed), `${label} must be an object.`)
  return parsed
}

async function assertReal(pathname, kind, label, expectedMode) {
  assertAbsolute(pathname, label)
  const entry = await lstat(pathname)
  assert(!entry.isSymbolicLink(), `${label} must not be a symlink.`)
  assert(kind === 'file' ? entry.isFile() : entry.isDirectory(), `${label} has the wrong type.`)
  assert(await realpath(pathname) === pathname, `${label} must not resolve through a symlink.`)
  if (expectedMode !== undefined) {
    assert((entry.mode & 0o777) === expectedMode, `${label} must have mode ${expectedMode.toString(8)}.`)
  }
  return entry
}

export function validateStatusUpgradeVersion(candidateVersion, manifestVersion = candidateVersion) {
  assert(candidateVersion === CANDIDATE_VERSION,
    `Status-query patch candidate version must be exactly ${CANDIDATE_VERSION}.`)
  assert(manifestVersion === candidateVersion,
    'Plugin package and manifest versions must match exactly.')
  return candidateVersion
}

export async function fingerprintConfig(pathname) {
  const entry = await assertReal(pathname, 'file', 'qwen-current config', 0o600)
  return createHash('sha256')
    .update(`${entry.mode & 0o777}\0`)
    .update(await readFile(pathname))
    .digest('hex')
}

export async function fingerprintInstalledPayload(pathname, peer = {}) {
  await assertReal(pathname, 'directory', 'Installed plugin payload')
  const inspectedPeer = await validateOfficialOpenClawPeerLink(pathname, {
    expectedLinkText: peer.linkText,
    expectedRealPath: peer.realPath,
  })
  return {
    fingerprint: await fingerprintPluginPayload(pathname, { omitTopLevelNodeModules: true }),
    peer: inspectedPeer,
  }
}

function exactKeys(value, expected, label) {
  assert(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} has unexpected or missing fields.`,
  )
}

export function buildBackupMetadata({
  pluginId,
  candidateVersion,
  targetSha,
  canonicalSourcePath,
  installedPath,
  sourcePayloadSha256,
  previousPayloadSha256,
  configSha256,
  peerLinkText,
  peerRealPath,
  createdAt = new Date().toISOString(),
}) {
  assert(pluginId === 'aiworker-video-command', 'Unexpected plugin id.')
  validateStatusUpgradeVersion(candidateVersion)
  assert(GIT_SHA.test(targetSha), 'Target SHA must be explicit lowercase 40-hex.')
  for (const [value, label] of [
    [canonicalSourcePath, 'Canonical source path'],
    [installedPath, 'Installed path'],
    [peerRealPath, 'OpenClaw peer real path'],
  ]) assertAbsolute(value, label)
  for (const [value, label] of [
    [sourcePayloadSha256, 'Source payload fingerprint'],
    [previousPayloadSha256, 'Previous payload fingerprint'],
    [configSha256, 'Config fingerprint'],
  ]) assert(SHA256.test(value), `${label} must be lowercase SHA-256.`)
  assert(typeof peerLinkText === 'string' && peerLinkText.length > 0, 'OpenClaw peer link text is required.')
  assert(Number.isFinite(Date.parse(createdAt)), 'Backup creation timestamp is invalid.')
  return {
    schemaVersion: 1,
    pluginId,
    previousVersion: PREVIOUS_VERSION,
    candidateVersion,
    targetSha,
    canonicalSourcePath,
    installedPath,
    sourcePayloadSha256,
    previousPayloadSha256,
    configSha256,
    peerLinkText,
    peerRealPath,
    createdAt,
  }
}

export async function validateStatusUpgradeBackup({
  backupRoot,
  backupDir,
  targetSha,
  candidateVersion,
  canonicalSourcePath,
  installedPath,
}) {
  await assertReal(backupRoot, 'directory', 'Plugin backup root', 0o700)
  await assertReal(backupDir, 'directory', 'Status-upgrade backup', 0o700)
  assert(dirname(backupDir) === backupRoot && BACKUP_NAME.test(backupDir.slice(backupRoot.length + 1)),
    'Status-upgrade backup is outside the approved direct-child family.')
  await assertReal(join(backupDir, '.verified'), 'file', 'Verified marker', 0o600)
  await assertReal(join(backupDir, 'metadata.json'), 'file', 'Backup metadata', 0o600)
  await assertReal(join(backupDir, 'openclaw.json'), 'file', 'Backed-up config', 0o600)
  const previousPlugin = join(backupDir, 'previous-plugin')
  await assertReal(previousPlugin, 'directory', 'Backed-up plugin')

  const metadata = await readJson(join(backupDir, 'metadata.json'), 'Backup metadata')
  exactKeys(metadata, [
    'schemaVersion', 'pluginId', 'previousVersion', 'candidateVersion', 'targetSha',
    'canonicalSourcePath', 'installedPath', 'sourcePayloadSha256', 'previousPayloadSha256',
    'configSha256', 'peerLinkText', 'peerRealPath', 'createdAt',
  ], 'Backup metadata')
  const expected = buildBackupMetadata({ ...metadata })
  assert(JSON.stringify(metadata) === JSON.stringify(expected), 'Backup metadata is not canonical.')
  assert(metadata.targetSha === targetSha, 'Backup target SHA differs from the approved target.')
  assert(metadata.candidateVersion === candidateVersion, 'Backup candidate version mismatch.')
  assert(metadata.canonicalSourcePath === canonicalSourcePath, 'Backup canonical source path mismatch.')
  assert(metadata.installedPath === installedPath, 'Backup installed path mismatch.')

  const sourceFingerprint = await fingerprintPluginPayload(canonicalSourcePath)
  assert(sourceFingerprint === metadata.sourcePayloadSha256, 'Canonical source payload changed after audit.')
  const previous = await fingerprintInstalledPayload(previousPlugin, {
    linkText: metadata.peerLinkText,
    realPath: metadata.peerRealPath,
  })
  assert(previous.fingerprint === metadata.previousPayloadSha256, 'Backed-up 0.4.0 payload changed after audit.')
  assert(await fingerprintConfig(join(backupDir, 'openclaw.json')) === metadata.configSha256,
    'Backed-up qwen-current config changed after audit.')
  const packageJson = await readJson(join(previousPlugin, 'package.json'), 'Previous plugin package')
  assert(packageJson.version === PREVIOUS_VERSION, `Rollback payload must be ${PREVIOUS_VERSION}.`)
  return { schemaVersion: 1, metadata, previousPlugin }
}

async function main() {
  const [command, ...args] = process.argv.slice(2)
  switch (command) {
    case 'version':
      process.stdout.write(`${validateStatusUpgradeVersion(args[0], args[1])}\n`)
      break
    case 'config-fingerprint':
      process.stdout.write(`${await fingerprintConfig(args[0])}\n`)
      break
    case 'installed-payload': {
      const result = await fingerprintInstalledPayload(args[0], {
        linkText: args[1] || undefined,
        realPath: args[2] || undefined,
      })
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      break
    }
    case 'metadata': {
      const [pluginId, candidateVersion, targetSha, canonicalSourcePath, installedPath,
        sourcePayloadSha256, previousPayloadSha256, configSha256, peerLinkText, peerRealPath] = args
      process.stdout.write(`${JSON.stringify(buildBackupMetadata({
        pluginId, candidateVersion, targetSha, canonicalSourcePath, installedPath,
        sourcePayloadSha256, previousPayloadSha256, configSha256, peerLinkText, peerRealPath,
      }), null, 2)}\n`)
      break
    }
    case 'backup': {
      const [backupRoot, backupDir, targetSha, candidateVersion, canonicalSourcePath, installedPath] = args
      process.stdout.write(`${JSON.stringify(await validateStatusUpgradeBackup({
        backupRoot, backupDir, targetSha, candidateVersion, canonicalSourcePath, installedPath,
      }), null, 2)}\n`)
      break
    }
    default:
      throw new Error('Unknown status-upgrade validator command.')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  })
}
