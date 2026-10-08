#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertCanonicalMainlineGitSource } from './lib/canonical-release-source.mjs'
import { readOpenClawAgentEntries, writeOpenClawAgentEntries } from './lib/openclaw-agent-config.mjs'
import { OPENCLAW_RUNTIME_VERSION } from './lib/openclaw-runtime-contract.mjs'
import { acquireSharedDeploymentLockSync, assertSharedDeploymentLockAvailableSync } from './lib/shared-deployment-lock.mjs'

const ID = 'aiworker-editing', TOOL = 'aiworker_edit_video'
const FILES = ['index.js', 'package.json', 'openclaw.plugin.json', 'lib/client.js', 'lib/tool.js', 'lib/registration.js']
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const encode = value => `${JSON.stringify(value, null, 2)}\n`
const requireValue = (condition, code) => { if (!condition) throw new Error(code) }
function entry(pathname, kind = 'file', privateMode = false) {
  requireValue(isAbsolute(pathname) && resolve(pathname) === pathname, 'editing_install_path_invalid')
  const value = lstatSync(pathname)
  requireValue(!value.isSymbolicLink() && realpathSync(pathname) === pathname && value.uid === process.getuid()
    && !(value.mode & (privateMode ? 0o077 : 0o022))
    && (kind === 'file' ? value.isFile() && value.nlink === 1 : value.isDirectory()), 'editing_install_path_unsafe')
  return value
}
function privateJson(pathname) {
  const value = entry(pathname, 'file', true)
  requireValue(value.size <= 1024 * 1024, 'editing_install_configuration_limit')
  return JSON.parse(readFileSync(pathname, 'utf8'))
}
function privateDirectory(pathname) {
  if (!existsSync(pathname)) { privateDirectory(dirname(pathname)); mkdirSync(pathname, { mode: 0o700 }) }
  entry(pathname, 'directory', true)
}
function atomicJson(pathname, value, expectedSha256 = null) {
  if (existsSync(pathname)) entry(pathname, 'file', true)
  const before = existsSync(pathname) ? sha(readFileSync(pathname)) : null
  requireValue(before === expectedSha256, 'editing_config_cas_failed')
  const temporary = `${pathname}.new-${randomUUID()}`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(descriptor, encode(value)); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  try {
    requireValue((existsSync(pathname) ? sha(readFileSync(pathname)) : null) === before, 'editing_config_cas_failed')
    renameSync(temporary, pathname)
    requireValue(sha(readFileSync(pathname)) === sha(encode(value)), 'editing_configuration_readback_failed')
  } finally { if (existsSync(temporary)) rmSync(temporary) }
}
function projection(config) {
  const main = readOpenClawAgentEntries(config).find(agent => agent.id === 'main')
  requireValue(main, 'editing_main_agent_missing')
  return { entry: config.plugins?.entries?.[ID] ?? null,
    allow: config.plugins?.allow ?? null, paths: config.plugins?.load?.paths ?? null,
    mainAllow: main.tools?.allow ?? null, mainAlsoAllow: main.tools?.alsoAllow ?? null }
}
function assertScope(config) {
  const agents = readOpenClawAgentEntries(config)
  requireValue(agents.filter(agent => agent.id === 'main').length === 1, 'editing_main_agent_scope_invalid')
  const hasTool = values => Array.isArray(values) && values.some(value => value === ID || value === TOOL)
  requireValue(!hasTool(config.tools?.allow) && !hasTool(config.tools?.alsoAllow), 'editing_global_grant_rejected')
  requireValue(agents.filter(agent => agent.id !== 'main').every(agent => !hasTool(agent.tools?.allow)
    && !hasTool(agent.tools?.alsoAllow)), 'editing_cross_agent_grant_rejected')
  const previous = config.plugins?.entries?.[ID]
  requireValue(!previous || Object.keys(previous).every(key => ['enabled', 'config'].includes(key))
    && Object.keys(previous.config || {}).every(key => key === 'releaseReady'), 'editing_unowned_plugin_configuration')
}
export function renderEditingConfiguration(config, target) {
  assertScope(config)
  const result = structuredClone(config), agents = readOpenClawAgentEntries(result)
  const main = agents.find(agent => agent.id === 'main')
  requireValue(![result.tools?.deny, main.tools?.deny].some(values => Array.isArray(values)
    && values.some(value => [ID, TOOL, 'group:plugins'].includes(value))), 'editing_tool_policy_denied')
  result.plugins ??= {}; result.plugins.entries ??= {}; result.plugins.load ??= {}
  requireValue(result.plugins.allow === undefined || Array.isArray(result.plugins.allow), 'editing_plugin_allow_invalid')
  requireValue(result.plugins.load.paths === undefined || Array.isArray(result.plugins.load.paths), 'editing_plugin_paths_invalid')
  result.plugins.entries[ID] = { enabled: true, config: { releaseReady: true } }
  if (result.plugins.allow) result.plugins.allow = [...new Set([...result.plugins.allow, ID])]
  result.plugins.load.paths = [...new Set([...(result.plugins.load.paths || []), target])]
  main.tools ??= {}
  requireValue(main.tools.alsoAllow === undefined || Array.isArray(main.tools.alsoAllow), 'editing_agent_allow_invalid')
  main.tools.alsoAllow = [...new Set([...(main.tools.alsoAllow || []), TOOL])]
  if (main.tools.allow !== undefined) {
    requireValue(Array.isArray(main.tools.allow), 'editing_agent_allow_invalid')
    main.tools.allow = [...new Set([...main.tools.allow, TOOL])]
  }
  writeOpenClawAgentEntries(result, agents); assertScope(result)
  return result
}
function restoreProjection(config, saved) {
  const result = structuredClone(config), agents = readOpenClawAgentEntries(result)
  const main = agents.find(agent => agent.id === 'main'); requireValue(main, 'editing_main_agent_missing')
  const restore = (object, key, value) => { if (value === null) delete object[key]; else object[key] = structuredClone(value) }
  result.plugins ??= {}; result.plugins.entries ??= {}; result.plugins.load ??= {}; main.tools ??= {}
  restore(result.plugins.entries, ID, saved.entry); restore(result.plugins, 'allow', saved.allow)
  restore(result.plugins.load, 'paths', saved.paths); restore(main.tools, 'allow', saved.mainAllow)
  restore(main.tools, 'alsoAllow', saved.mainAlsoAllow)
  writeOpenClawAgentEntries(result, agents); assertScope(result); return result
}
function payloadInventory(directory) {
  entry(directory, 'directory')
  const files = {}, links = {}; let count = 0, bytes = 0
  const visit = (current, prefix = '') => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name), member = prefix ? `${prefix}/${name}` : name, value = lstatSync(path)
      requireValue(++count <= 128 && !['.git', '.PhoenixBrain'].includes(name), 'editing_payload_members_invalid')
      if (value.isSymbolicLink()) {
        requireValue(member === 'node_modules/openclaw', 'editing_payload_link_rejected')
        links[member] = readlinkSync(path); continue
      }
      entry(path, value.isDirectory() ? 'directory' : 'file')
      if (value.isDirectory()) visit(path, member)
      else { requireValue(FILES.includes(member), 'editing_payload_unknown_member')
        bytes += value.size; requireValue(bytes <= 2 * 1024 * 1024, 'editing_payload_limit'); files[member] = sha(readFileSync(path)) }
    }
  }
  visit(directory)
  return { files, links }
}
function copyPayload(from, to) {
  privateDirectory(to)
  const inventory = payloadInventory(from)
  for (const name of Object.keys(inventory.files)) {
    privateDirectory(dirname(join(to, name))); writeFileSync(join(to, name), readFileSync(join(from, name)), { mode: 0o600 })
  }
  for (const [name, target] of Object.entries(inventory.links)) { privateDirectory(dirname(join(to, name))); symlinkSync(target, join(to, name)) }
  requireValue(encode(payloadInventory(to)) === encode(inventory), 'editing_payload_copy_mismatch')
  return inventory
}
function verifyBackup(pathname) {
  entry(pathname, 'directory', true)
  const recovery = privateJson(join(pathname, 'recovery.json'))
  requireValue(recovery.schema === 'aiworker-editing-recovery/v1' && recovery.profile === 'gpt-main'
    && sha(encode(recovery.before)) === recovery.beforeSha256, 'editing_recovery_invalid')
  requireValue(recovery.payload === null ? !existsSync(join(pathname, 'payload'))
    : encode(payloadInventory(join(pathname, 'payload'))) === encode(recovery.payload), 'editing_recovery_payload_invalid')
  return recovery
}
function otherProfiles(home) {
  return Object.fromEntries(['qwen-current', 'qwen-weixin-new', 'image-studio'].map(profile => {
    const path = join(home, `.openclaw-${profile}`, 'openclaw.json')
    if (existsSync(path)) entry(path, 'file', true)
    return [profile, existsSync(path) ? sha(readFileSync(path)) : null]
  }))
}

export function installEditingPlugin({ mode, sourceCommit, home = homedir(), backup = null,
  sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..') },
{ verifySource = assertCanonicalMainlineGitSource } = {}) {
  requireValue(['prepare', 'apply', 'rollback'].includes(mode) && /^[a-f0-9]{40}$/u.test(sourceCommit || ''), 'editing_install_arguments_invalid')
  requireValue(process.versions.node.split('.')[0] === '22', 'editing_node22_required')
  verifySource(sourceRoot, sourceCommit)
  const state = join(home, '.openclaw-gpt-main'), configPath = join(state, 'openclaw.json')
  const target = join(state, 'extensions', ID), source = join(sourceRoot, 'openclaw-plugins', ID)
  const config = privateJson(configPath); assertScope(config)
  const sourceFiles = Object.fromEntries(FILES.map(name => { const path = join(source, name); entry(path); return [name, sha(readFileSync(path))] }))
  const manifest = JSON.parse(readFileSync(join(source, 'openclaw.plugin.json'), 'utf8'))
  requireValue(manifest.id === ID && manifest.version === '0.1.0' && encode(manifest.contracts.tools) === encode([TOOL]), 'editing_source_contract_invalid')
  const sdk = dirname(realpathSync(join(home, 'ai-worker/bin/openclaw')))
  requireValue(sdk.startsWith(`${home}/ai-worker/node/`) && JSON.parse(readFileSync(join(sdk, 'package.json'), 'utf8')).version === OPENCLAW_RUNTIME_VERSION,
    'editing_sdk_identity_invalid')
  const desired = renderEditingConfiguration(config, target)
  if (existsSync(target)) requireValue(payloadInventory(target).links['node_modules/openclaw'] === sdk,
    'editing_installed_sdk_link_invalid')
  const runDir = join(home, 'ai-worker/state/video-autoworker/blue-green')
  assertSharedDeploymentLockAvailableSync(runDir)
  if (mode === 'prepare') return { currentState: 'PREPARED', profile: 'gpt-main', agentId: 'main', tool: TOOL,
    sourceCommit, payloadSha256: sha(encode(sourceFiles)), configurationProjectionSha256: sha(encode(projection(desired))),
    nextAction: 'authorize_scoped_plugin_install', gatewayChanged: false }
  const otherBefore = otherProfiles(home), beforeConfigHash = sha(readFileSync(configPath))
  const lock = acquireSharedDeploymentLockSync({ runDirectory: runDir })
  try {
    if (mode === 'rollback') {
      requireValue(backup && dirname(backup) === join(home, 'ai-worker/backups/aiworker-editing/gpt-main'), 'editing_recovery_path_invalid')
      const recovery = verifyBackup(backup)
      requireValue(sha(encode(projection(config))) === recovery.afterSha256, 'editing_recovery_configuration_drift')
      requireValue(existsSync(target) && encode(payloadInventory(target)) === encode(recovery.installedPayload), 'editing_recovery_payload_drift')
      const old = `${target}.retired-${randomUUID()}`; renameSync(target, old)
      try {
        if (recovery.payload) copyPayload(join(backup, 'payload'), target)
        atomicJson(configPath, restoreProjection(config, recovery.before), beforeConfigHash)
      } catch (error) { if (existsSync(target)) rmSync(target, { recursive: true }); renameSync(old, target); throw error }
      rmSync(old, { recursive: true })
      requireValue(encode(otherProfiles(home)) === encode(otherBefore), 'editing_other_profile_changed')
      return { currentState: 'ROLLED_BACK_PENDING_GATEWAY_VALIDATION', profile: 'gpt-main', gatewayChanged: false }
    }
    const backups = join(home, 'ai-worker/backups/aiworker-editing/gpt-main'); privateDirectory(backups)
    const backupPath = join(backups, `${Date.now()}-${randomUUID()}`); privateDirectory(backupPath)
    const previousPayload = existsSync(target) ? copyPayload(target, join(backupPath, 'payload')) : null
    const staged = `${target}.staged-${randomUUID()}`; privateDirectory(dirname(target)); privateDirectory(staged)
    for (const name of FILES) { privateDirectory(dirname(join(staged, name))); writeFileSync(join(staged, name), readFileSync(join(source, name)), { mode: 0o600 }) }
    privateDirectory(join(staged, 'node_modules')); symlinkSync(sdk, join(staged, 'node_modules/openclaw'))
    const installedPayload = payloadInventory(staged)
    const recovery = { schema: 'aiworker-editing-recovery/v1', profile: 'gpt-main', sourceCommit,
      before: projection(config), beforeSha256: sha(encode(projection(config))), afterSha256: sha(encode(projection(desired))),
      payload: previousPayload, installedPayload }
    atomicJson(join(backupPath, 'recovery.json'), recovery); verifyBackup(backupPath)
    requireValue(sha(readFileSync(configPath)) === beforeConfigHash, 'editing_config_cas_failed')
    const retired = existsSync(target) ? `${target}.retired-${randomUUID()}` : null
    if (retired) renameSync(target, retired)
    try {
      renameSync(staged, target); atomicJson(configPath, desired, beforeConfigHash)
      requireValue(encode(payloadInventory(target)) === encode(installedPayload)
        && encode(projection(privateJson(configPath))) === encode(projection(desired)), 'editing_install_readback_failed')
    } catch (error) {
      if (existsSync(target)) rmSync(target, { recursive: true }); if (retired) renameSync(retired, target)
      if (sha(readFileSync(configPath)) === sha(encode(desired))) atomicJson(configPath, config, sha(encode(desired)))
      throw error
    } finally { if (existsSync(staged)) rmSync(staged, { recursive: true }) }
    if (retired) rmSync(retired, { recursive: true })
    requireValue(encode(otherProfiles(home)) === encode(otherBefore), 'editing_other_profile_changed')
    const histories = readdirSync(backups).sort()
    for (const name of histories) verifyBackup(join(backups, name))
    for (const name of histories.slice(0, -2)) rmSync(join(backups, name), { recursive: true })
    return { currentState: 'INSTALLED_PENDING_GATEWAY_VALIDATION', profile: 'gpt-main', agentId: 'main', tool: TOOL,
      sourceCommit, payloadSha256: sha(encode(installedPayload)), recoveryBackup: backupPath,
      nextAction: 'official_config_validation_and_gpt_main_runtime_acceptance', gatewayChanged: false }
  } finally { lock.release() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const values = new Map()
    for (let index = 2; index < process.argv.length; index += 2) {
      const key = process.argv[index], value = process.argv[index + 1]
      requireValue(['--mode', '--source-commit', '--backup'].includes(key) && value && !values.has(key), 'editing_install_arguments_invalid')
      values.set(key, value)
    }
    process.stdout.write(`${encode(installEditingPlugin({ mode: values.get('--mode'), sourceCommit: values.get('--source-commit'), backup: values.get('--backup') }))}`)
  } catch (error) { process.stderr.write(`${encode({ currentState: 'BLOCKED',
    errorCode: /^[a-z0-9_]{1,120}$/u.test(error.message) ? error.message : 'editing_install_preflight_failed',
    nextAction: 'inspect_scoped_installer_preflight' })}`); process.exitCode = 1 }
}
