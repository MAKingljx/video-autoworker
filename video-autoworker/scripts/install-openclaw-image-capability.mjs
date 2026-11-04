#!/usr/bin/env node
// Attach the one H1 image application to a declared OpenClaw profile. This
// installer never creates an image queue, model runtime, channel, or task
// chain; it installs only the thin capability adapter and profile config.
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { readOpenClawAgentEntries, writeOpenClawAgentEntries } from './lib/openclaw-agent-config.mjs'
import { fingerprintOpenClawToolInventory } from './lib/openclaw-tool-capability-fingerprint.mjs'
import {
  attachmentEvidence,
  attachmentForProfile,
  assertImageCapabilityPluginManifest,
  isImageCapabilityAttached,
  renderImageCapabilityPatch,
  resolveAttachmentStateRoot,
  validateImageCapabilityManifest,
} from './lib/openclaw-image-capability-contract.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = path.join(ROOT, 'ops/openclaw/image-capability-attachments.json')
const PLUGIN_ROOT = path.join(ROOT, 'openclaw-plugins/aiworker-image-command')
const SECRET_HELPER = path.join(ROOT, 'scripts/lib/openclaw-secret-reference.mjs')
const RPC_HELPER = path.join(ROOT, 'scripts/lib/openclaw-profile-private-gateway-rpc.mjs')
const COMMIT = /^[a-f0-9]{40}$/u

function fail(code) {
  throw new Error(`image_capability_install_${code}`)
}

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

function safeFile(filename, { mode, readOnly = false } = {}) {
  const entry = fs.lstatSync(filename)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (mode !== undefined && (entry.mode & 0o7777) !== mode)
    || (readOnly && (entry.mode & 0o022) !== 0) || fs.realpathSync(filename) !== filename) {
    fail('unsafe_file')
  }
  return entry
}

function safeCommand(filename) {
  const entry = fs.lstatSync(filename)
  const resolved = fs.realpathSync(filename)
  const target = fs.lstatSync(resolved)
  try { fs.accessSync(resolved, fs.constants.X_OK) } catch { fail('unsafe_command') }
  if ((!entry.isFile() && !entry.isSymbolicLink()) || entry.uid !== process.getuid() || !target.isFile() || target.isSymbolicLink()
    || target.uid !== process.getuid() || (target.mode & 0o022) !== 0) {
    fail('unsafe_command')
  }
  return resolved
}

function safeDirectory(directory, { mode } = {}) {
  const entry = fs.lstatSync(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (mode !== undefined && (entry.mode & 0o7777) !== mode) || fs.realpathSync(directory) !== directory) {
    fail('unsafe_directory')
  }
  return entry
}

function physicalInside(parent, candidate) {
  const parentReal = fs.realpathSync(parent)
  const candidateReal = fs.realpathSync(candidate)
  const suffix = path.relative(parentReal, candidateReal)
  return suffix !== '' && !suffix.startsWith(`..${path.sep}`) && suffix !== '..' && !path.isAbsolute(suffix)
}

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.chmodSync(directory, 0o700)
  safeDirectory(directory, { mode: 0o700 })
  return directory
}

function atomicWrite(filename, data, mode = 0o600) {
  const parent = path.dirname(filename)
  safeDirectory(parent, { mode: 0o700 })
  const temporary = path.join(parent, `.${path.basename(filename)}.${process.pid}.${randomUUID()}`)
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT
    | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode)
  try { fs.writeFileSync(descriptor, data); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  fs.renameSync(temporary, filename)
  fs.chmodSync(filename, mode)
  safeFile(filename, { mode })
}

function readJson(filename, options = {}) {
  safeFile(filename, options)
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')) } catch { fail('json_invalid') }
}

function run(binary, args, { env, cwd, timeout = 120_000 } = {}) {
  const result = spawnSync(binary, args, {
    cwd, env, encoding: 'utf8', timeout, maxBuffer: 1024 * 1024, shell: false,
  })
  if (result.error || result.signal || result.status !== 0) fail('component_command_failed')
  return result.stdout
}

function parseArguments(values) {
  const parsed = { mode: '', profile: '', sourceCommit: '' }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--dry-run' || value === '--apply') {
      if (parsed.mode) fail('arguments_invalid')
      parsed.mode = value.slice(2)
    } else if (value === '--profile' || value === '--source-commit') {
      const next = values[++index]
      if (!next || parsed[value === '--profile' ? 'profile' : 'sourceCommit']) fail('arguments_invalid')
      parsed[value === '--profile' ? 'profile' : 'sourceCommit'] = next
    } else fail('arguments_invalid')
  }
  if (!parsed.mode || !/^[a-z][a-z0-9_-]{0,63}$/u.test(parsed.profile) || !COMMIT.test(parsed.sourceCommit)) {
    fail('arguments_invalid')
  }
  return parsed
}

function sourceCommit(expected) {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', timeout: 10_000 })
  if (result.status !== 0 || result.error || !COMMIT.test(result.stdout.trim()) || result.stdout.trim() !== expected) {
    fail('source_commit_invalid')
  }
  const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: ROOT, encoding: 'utf8', timeout: 10_000,
  })
  if (status.status !== 0 || status.error || status.stdout.trim() !== '') fail('source_tree_dirty')
}

function sourceTreeDigest(root) {
  safeDirectory(root)
  const entries = []
  const visit = (directory, relative) => {
    for (const child of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
      if (!child.name || /[\\/\u0000-\u001f\u007f]/u.test(child.name)) fail('source_member_invalid')
      const filename = path.join(directory, child.name)
      const item = path.posix.join(relative, child.name)
      const entry = fs.lstatSync(filename)
      if (entry.isSymbolicLink() || entry.uid !== process.getuid() || (entry.mode & 0o022) !== 0) fail('source_member_invalid')
      if (entry.isDirectory()) {
        entries.push({ path: item, type: 'directory', mode: entry.mode & 0o7777 })
        visit(filename, item)
      } else if (entry.isFile()) {
        const content = fs.readFileSync(filename)
        entries.push({ path: item, type: 'file', mode: entry.mode & 0o7777, size: content.length, sha256: sha256(content) })
      } else fail('source_member_invalid')
    }
  }
  visit(root, '')
  return sha256(JSON.stringify(entries))
}

function sourceManifest(manifest) {
  safeDirectory(PLUGIN_ROOT)
  const pluginManifest = readJson(path.join(PLUGIN_ROOT, 'openclaw.plugin.json'), { readOnly: true })
  const packageManifest = readJson(path.join(PLUGIN_ROOT, 'package.json'), { readOnly: true })
  assertImageCapabilityPluginManifest(pluginManifest, manifest)
  if (packageManifest?.version !== pluginManifest.version) fail('source_package_invalid')
  return { pluginManifest, treeSha256: sourceTreeDigest(PLUGIN_ROOT) }
}

function profilePaths(home, attachment) {
  const stateDir = resolveAttachmentStateRoot(home, attachment)
  safeDirectory(stateDir, { mode: 0o700 })
  const config = path.join(stateDir, 'openclaw.json')
  safeFile(config, { mode: 0o600 })
  const extensions = path.join(stateDir, 'extensions')
  safeDirectory(extensions)
  if (!physicalInside(stateDir, extensions)) fail('extensions_outside_state')
  return { stateDir, config, extensions, plugin: path.join(extensions, 'aiworker-image-command') }
}

function acquireInstallLock(paths, attachment) {
  const lock = path.join(paths.stateDir, '.aiworker-image-capability-install.lock')
  const owner = path.join(lock, 'owner.json')
  const create = () => {
    fs.mkdirSync(lock, { mode: 0o700 })
    fs.chmodSync(lock, 0o700)
    safeDirectory(lock, { mode: 0o700 })
    atomicWrite(owner, `${JSON.stringify({ pid: process.pid, profile: attachment.profile, createdAt: new Date().toISOString() })}\n`)
  }
  try { create() } catch (error) {
    if (error?.code !== 'EEXIST') fail('install_lock_unavailable')
    try {
      safeDirectory(lock, { mode: 0o700 })
      const prior = readJson(owner, { mode: 0o600 })
      if (!Number.isSafeInteger(prior?.pid) || prior.pid <= 1 || prior.profile !== attachment.profile) fail('install_lock_invalid')
      try { process.kill(prior.pid, 0); fail('install_in_progress') }
      catch (probe) { if (probe?.code !== 'ESRCH') throw probe }
      fs.rmSync(lock, { recursive: true, force: true })
      create()
    } catch (recovery) {
      if (recovery?.message?.startsWith('image_capability_install_')) throw recovery
      fail('install_lock_unavailable')
    }
  }
  return () => {
    try {
      safeDirectory(lock, { mode: 0o700 })
      const current = readJson(owner, { mode: 0o600 })
      if (current?.pid === process.pid && current?.profile === attachment.profile) fs.rmSync(lock, { recursive: true, force: true })
    } catch { /* preserve unknown lock evidence */ }
  }
}

function toolInventory(value, attachment, kind) {
  const result = fingerprintOpenClawToolInventory(value, {
    agentId: attachment.agentId, kind, label: `OpenClaw ${attachment.profile} ${kind} tools`,
  })
  return result
}

function compareInventories(before, after, plugin, label) {
  const beforeById = new Map(before.map(item => [item.id, item]))
  const afterById = new Map(after.map(item => [item.id, item]))
  const removed = before.filter(item => !afterById.has(item.id))
  const added = after.filter(item => !beforeById.has(item.id))
  if (removed.length !== 0 || added.length !== 1 || added[0].id !== plugin.tool
    || added[0].source !== 'plugin' || added[0].pluginId !== plugin.id) {
    fail(`${label}_tool_delta_invalid`)
  }
  for (const entry of before) {
    if (JSON.stringify(entry) !== JSON.stringify(afterById.get(entry.id))) fail(`${label}_tool_changed`)
  }
  return sha256(JSON.stringify(after))
}

function assertImageToolLoaded(inventory, plugin, label) {
  const matches = inventory.filter(item => item.id === plugin.tool)
  if (matches.length !== 1 || matches[0].source !== 'plugin' || matches[0].pluginId !== plugin.id) {
    fail(`${label}_image_tool_missing`)
  }
  return sha256(JSON.stringify(inventory))
}

function baseEnvironment(home, openclaw) {
  return {
    HOME: home,
    PATH: `${path.dirname(openclaw)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
  }
}

function gatewayToken(home, config) {
  const output = spawnSync(process.execPath, [SECRET_HELPER, config], {
    env: { HOME: home, PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024,
  })
  const token = output.status === 0 ? output.stdout.trim() : ''
  if (!/^(?:[a-f0-9]{48}|[a-f0-9]{64})$/u.test(token)) fail('gateway_token_unavailable')
  return token
}

function createEmptyPrivateFile(directory, name) {
  const target = path.join(directory, `${name}.${randomUUID()}.json`)
  const descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT
    | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  fs.closeSync(descriptor)
  safeFile(target, { mode: 0o600 })
  return target
}

function gatewayRpc({ work, home, openclaw, attachment, operation, token, patch, sessionKey }) {
  const output = createEmptyPrivateFile(work, `rpc-${operation}`)
  const environment = {
    ...baseEnvironment(home, openclaw),
    OPENCLAW_BIN: openclaw,
    OPENCLAW_GATEWAY_TOKEN: token,
    AIWORKER_OPENCLAW_CAPABILITY_PROFILE: attachment.profile,
    AIWORKER_OPENCLAW_CAPABILITY_AGENT: attachment.agentId,
    AIWORKER_OPENCLAW_CAPABILITY_PORT: String(attachment.gatewayPort),
    ...(sessionKey ? { AIWORKER_OPENCLAW_CAPABILITY_SESSION_KEY: sessionKey } : {}),
  }
  if (patch) {
    Object.assign(environment, {
      AIWORKER_OPENCLAW_CAPABILITY_CONFIG_REVISION: patch.baseHash,
      AIWORKER_OPENCLAW_CAPABILITY_PATCH_FILE: patch.path,
    })
  }
  try {
    run(process.execPath, [RPC_HELPER, operation, output], { env: environment, cwd: ROOT, timeout: 45_000 })
    return readJson(output, { mode: 0o600 })
  } finally {
    fs.unlinkSync(output)
  }
}

function gatewayConfig(value) {
  if (!value?.exists || value.valid !== true || typeof value.hash !== 'string'
    || !value.hash.startsWith('hmac-sha256:v1:') || !value.config || typeof value.config !== 'object'
    || Array.isArray(value.config)) fail('gateway_config_invalid')
  return value
}

function installedPlugin(paths, manifest) {
  try {
    safeDirectory(paths.plugin)
    if (!physicalInside(paths.extensions, paths.plugin)) return false
    const plugin = readJson(path.join(paths.plugin, 'openclaw.plugin.json'))
    const packageJson = readJson(path.join(paths.plugin, 'package.json'))
    assertImageCapabilityPluginManifest(plugin, manifest)
    return packageJson?.version === plugin.version
  } catch { return false }
}

function backupDirectory(home, attachment) {
  const root = privateDirectory(path.join(home, 'ai-worker/backups/openclaw-image-capabilities', attachment.profile))
  const backup = fs.mkdtempSync(path.join(root, 'current-'))
  fs.chmodSync(backup, 0o700)
  safeDirectory(backup, { mode: 0o700 })
  return backup
}

function createBackup(home, paths, attachment, sourceCommitValue) {
  const backup = backupDirectory(home, attachment)
  const previousPlugin = fs.existsSync(paths.plugin) && !fs.lstatSync(paths.plugin).isSymbolicLink()
  fs.copyFileSync(paths.config, path.join(backup, 'openclaw.json'), fs.constants.COPYFILE_EXCL)
  fs.chmodSync(path.join(backup, 'openclaw.json'), 0o600)
  safeFile(path.join(backup, 'openclaw.json'), { mode: 0o600 })
  if (previousPlugin) fs.cpSync(paths.plugin, path.join(backup, 'previous-plugin'), { recursive: true, preserveTimestamps: true, dereference: false })
  atomicWrite(path.join(backup, 'metadata.json'), `${JSON.stringify({
    schema: 'aiworker-openclaw-image-capability-backup/v1', profile: attachment.profile,
    sourceCommit: sourceCommitValue, configSha256: sha256(fs.readFileSync(paths.config)), previousPlugin,
  })}\n`)
  return { path: backup, previousPlugin }
}

function restoreBackup(paths, backup, home, openclaw, attachment) {
  const configBackup = path.join(backup.path, 'openclaw.json')
  safeFile(configBackup, { mode: 0o600 })
  atomicWrite(paths.config, fs.readFileSync(configBackup))
  if (fs.existsSync(paths.plugin) || fs.lstatSync(paths.extensions).isDirectory()) {
    if (fs.existsSync(paths.plugin)) {
      safeDirectory(paths.plugin)
      if (!physicalInside(paths.extensions, paths.plugin)) fail('plugin_outside_extensions')
      fs.rmSync(paths.plugin, { recursive: true, force: true })
    }
  }
  if (backup.previousPlugin) {
    const previous = path.join(backup.path, 'previous-plugin')
    safeDirectory(previous)
    fs.cpSync(previous, paths.plugin, { recursive: true, preserveTimestamps: true, dereference: false })
  }
  run(openclaw, ['--profile', attachment.profile, 'gateway', 'restart', '--wait', '90s', '--json'], {
    env: baseEnvironment(home, openclaw), cwd: ROOT, timeout: 120_000,
  })
}

function retainLatestBackups(home, attachment) {
  const root = path.join(home, 'ai-worker/backups/openclaw-image-capabilities', attachment.profile)
  safeDirectory(root, { mode: 0o700 })
  const backups = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.startsWith('current-'))
    .map(entry => path.join(root, entry.name)).sort()
  for (const stale of backups.slice(0, Math.max(0, backups.length - 2))) {
    const metadata = path.join(stale, 'metadata.json')
    safeDirectory(stale, { mode: 0o700 })
    safeFile(metadata, { mode: 0o600 })
    if (!physicalInside(root, stale)) fail('backup_outside_root')
    fs.rmSync(stale, { recursive: true, force: true })
  }
}

function receiptDirectory(home) {
  return privateDirectory(path.join(home, 'ai-worker/state/openclaw-image-capabilities'))
}

function writeReceipt(home, attachment, value) {
  const directory = receiptDirectory(home)
  atomicWrite(path.join(directory, `${attachment.profile}.json`), `${JSON.stringify(value, null, 2)}\n`)
}

function withoutAttachment(config, manifest, attachment) {
  const next = structuredClone(config)
  const plugin = manifest.plugin
  const agent = readOpenClawAgentEntries(next).find(item => item.id === attachment.agentId)
  if (!agent) fail('agent_binding_invalid')
  if (agent.tools && typeof agent.tools === 'object' && !Array.isArray(agent.tools)
    && Array.isArray(agent.tools.alsoAllow)) {
    agent.tools.alsoAllow = agent.tools.alsoAllow.filter(item => item !== plugin.tool)
    if (agent.tools.alsoAllow.length === 0) delete agent.tools.alsoAllow
    if (Object.keys(agent.tools).length === 0) delete agent.tools
  }
  writeOpenClawAgentEntries(next, [agent])
  if (next.plugins && typeof next.plugins === 'object' && !Array.isArray(next.plugins)) {
    if (Array.isArray(next.plugins.allow)) next.plugins.allow = next.plugins.allow.filter(item => item !== plugin.id)
    if (next.plugins.entries && typeof next.plugins.entries === 'object' && !Array.isArray(next.plugins.entries)) {
      delete next.plugins.entries[plugin.id]
    }
  }
  if (next.meta && typeof next.meta === 'object' && !Array.isArray(next.meta)) {
    delete next.meta.lastTouchedVersion
    delete next.meta.lastTouchedAt
    if (Object.keys(next.meta).length === 0) delete next.meta
  }
  return next
}

function allowedConfigDelta(before, current, manifest, attachment) {
  try {
    return isImageCapabilityAttached(current, manifest, attachment)
      && JSON.stringify(stable(withoutAttachment(before, manifest, attachment)))
        === JSON.stringify(stable(withoutAttachment(current, manifest, attachment)))
  } catch { return false }
}

function main() {
  const options = parseArguments(process.argv.slice(2))
  const home = os.homedir()
  if (!path.isAbsolute(home) || path.resolve(home) !== home) fail('home_invalid')
  sourceCommit(options.sourceCommit)
  const manifest = validateImageCapabilityManifest(readJson(MANIFEST_PATH, { readOnly: true }))
  const attachment = attachmentForProfile(manifest, options.profile)
  const source = sourceManifest(manifest)
  const paths = profilePaths(home, attachment)
  const openclaw = safeCommand(path.join(home, 'ai-worker/bin/openclaw'))
  const beforeConfig = readJson(paths.config, { mode: 0o600 })
  const patch = renderImageCapabilityPatch(beforeConfig, manifest, attachment)
  const patchText = `${JSON.stringify(patch, null, 2)}\n`
  const alreadyAttached = isImageCapabilityAttached(beforeConfig, manifest, attachment)
  const alreadyInstalled = installedPlugin(paths, manifest)
  const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiworker-image-capability-')))
  fs.chmodSync(work, 0o700)
  const releaseInstallLock = acquireInstallLock(paths, attachment)
  let backup
  let token = ''
  try {
    const patchPath = path.join(work, 'config.patch.json')
    atomicWrite(patchPath, patchText)
    run(openclaw, ['--profile', attachment.profile, 'config', 'validate'], { env: baseEnvironment(home, openclaw), cwd: ROOT })
    run(openclaw, ['--profile', attachment.profile, 'config', 'patch', '--file', patchPath, '--dry-run'], {
      env: baseEnvironment(home, openclaw), cwd: ROOT,
    })
    if (options.mode === 'dry-run') {
      writeReceipt(home, attachment, {
        schema: 'aiworker-openclaw-image-capability-receipt/v1', currentState: 'DRY_RUN_PASSED',
        sourceCommit: options.sourceCommit, pluginSourceSha256: source.treeSha256,
        attachment: attachmentEvidence(beforeConfig, manifest, attachment),
        pluginInstalled: alreadyInstalled, nextAction: alreadyAttached && alreadyInstalled ? 'none' : 'apply',
      })
      return
    }
    if (alreadyAttached && alreadyInstalled) {
      token = gatewayToken(home, paths.config)
      const sessionKey = `agent:${attachment.agentId}:image-capability-verify-${randomUUID()}`
      const catalog = toolInventory(gatewayRpc({ work, home, openclaw, attachment, operation: 'catalog', token }), attachment, 'catalog')
      const effective = toolInventory(gatewayRpc({ work, home, openclaw, attachment,
        operation: 'effective', token, sessionKey }), attachment, 'effective')
      writeReceipt(home, attachment, {
        schema: 'aiworker-openclaw-image-capability-receipt/v1', currentState: 'ALREADY_CURRENT',
        sourceCommit: options.sourceCommit, pluginSourceSha256: source.treeSha256,
        attachment: attachmentEvidence(beforeConfig, manifest, attachment),
        pluginInstalled: true, toolInventory: {
          catalogSha256: assertImageToolLoaded(catalog, manifest.plugin, 'catalog'),
          effectiveSha256: assertImageToolLoaded(effective, manifest.plugin, 'effective'),
        }, nextAction: 'none',
      })
      return
    }
    token = gatewayToken(home, paths.config)
    const sessionKey = `agent:${attachment.agentId}:image-capability-install-${randomUUID()}`
    const beforeCatalog = toolInventory(gatewayRpc({ work, home, openclaw, attachment,
      operation: 'catalog', token }), attachment, 'catalog')
    const beforeEffective = toolInventory(gatewayRpc({ work, home, openclaw, attachment,
      operation: 'effective', token, sessionKey }), attachment, 'effective')
    backup = createBackup(home, paths, attachment, options.sourceCommit)
    run(openclaw, ['--profile', attachment.profile, 'plugins', 'install', '--force', '--accept-capabilities', PLUGIN_ROOT], {
      env: baseEnvironment(home, openclaw), cwd: ROOT, timeout: 180_000,
    })
    if (!installedPlugin(paths, manifest)) fail('plugin_install_invalid')
    const live = gatewayConfig(gatewayRpc({ work, home, openclaw, attachment,
      operation: 'config-get', token }))
    const livePatch = renderImageCapabilityPatch(live.config, manifest, attachment)
    const livePatchPath = path.join(work, 'config.live.patch.json')
    atomicWrite(livePatchPath, `${JSON.stringify(livePatch, null, 2)}\n`)
    run(openclaw, ['--profile', attachment.profile, 'config', 'patch', '--file', livePatchPath, '--dry-run'], {
      env: baseEnvironment(home, openclaw), cwd: ROOT,
    })
    const patched = gatewayRpc({ work, home, openclaw, attachment, operation: 'config-patch', token,
      patch: { baseHash: live.hash, path: livePatchPath } })
    if (patched?.ok !== true || !isImageCapabilityAttached(patched.config, manifest, attachment)) fail('config_patch_invalid')
    run(openclaw, ['--profile', attachment.profile, 'gateway', 'restart', '--wait', '90s', '--json'], {
      env: baseEnvironment(home, openclaw), cwd: ROOT, timeout: 120_000,
    })
    run(openclaw, ['--profile', attachment.profile, 'config', 'validate'], { env: baseEnvironment(home, openclaw), cwd: ROOT })
    const afterConfig = readJson(paths.config, { mode: 0o600 })
    if (!isImageCapabilityAttached(afterConfig, manifest, attachment) || !installedPlugin(paths, manifest)) {
      fail('post_restart_contract_invalid')
    }
    const afterCatalog = toolInventory(gatewayRpc({ work, home, openclaw, attachment,
      operation: 'catalog', token }), attachment, 'catalog')
    const afterEffective = toolInventory(gatewayRpc({ work, home, openclaw, attachment,
      operation: 'effective', token, sessionKey }), attachment, 'effective')
    const catalogSha256 = compareInventories(beforeCatalog, afterCatalog, manifest.plugin, 'catalog')
    const effectiveSha256 = compareInventories(beforeEffective, afterEffective, manifest.plugin, 'effective')
    retainLatestBackups(home, attachment)
    writeReceipt(home, attachment, {
      schema: 'aiworker-openclaw-image-capability-receipt/v1', currentState: 'SERVICE_HEALTHY',
      sourceCommit: options.sourceCommit, pluginSourceSha256: source.treeSha256,
      attachment: attachmentEvidence(afterConfig, manifest, attachment),
      pluginInstalled: true, configBeforeSha256: sha256(JSON.stringify(stable(beforeConfig))),
      configAfterSha256: sha256(JSON.stringify(stable(afterConfig))), toolInventory: { catalogSha256, effectiveSha256 },
      backupPath: backup.path, nextAction: 'real_dialogue_validation',
    })
  } catch (error) {
    let recovery = 'not_required'
    if (backup) {
      try {
        const current = readJson(paths.config, { mode: 0o600 })
        if (allowedConfigDelta(beforeConfig, current, manifest, attachment)) {
          restoreBackup(paths, backup, home, openclaw, attachment)
          recovery = 'restored'
        } else recovery = 'reconcile_required'
      } catch { recovery = 'reconcile_required' }
    }
    writeReceipt(home, attachment, {
      schema: 'aiworker-openclaw-image-capability-receipt/v1', currentState: recovery === 'restored' ? 'FAILED_RESTORED' : 'RECONCILE_REQUIRED',
      sourceCommit: options.sourceCommit, pluginSourceSha256: source.treeSha256,
      profile: attachment.profile, errorCode: error.message,
      ...(backup ? { backupPath: backup.path } : {}), nextAction: recovery === 'restored' ? 'inspect_and_retry' : 'manual_read_only_reconcile',
    })
    throw error
  } finally {
    token = ''
    fs.rmSync(work, { recursive: true, force: true })
    releaseInstallLock()
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try { main() } catch (error) {
    process.stderr.write(`OpenClaw image capability installation failed safely: ${error.message}\n`)
    process.exitCode = 1
  }
}
