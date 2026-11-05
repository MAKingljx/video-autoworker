#!/usr/bin/env node
// Apply only the qwen-current Feishu delivery policy through OpenClaw's
// official config interface. Gateway restart is intentionally owned by the
// caller that coordinates the plugin switch; this component never restarts a
// service, sends a message, or touches model/task/image configuration.
import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = path.join(ROOT, 'ops/openclaw/qwen-current-feishu-delivery-policy.json')
const PROFILE = 'qwen-current'
const SCHEMA = 'video-autoworker-openclaw-feishu-delivery-policy/v1'
const RECEIPT_SCHEMA = 'video-autoworker-openclaw-feishu-delivery-policy-receipt/v1'

function fail(code) {
  throw new Error(`qwen_current_feishu_delivery_policy_${code}`)
}

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

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function safeDirectory(directory, mode) {
  const entry = fs.lstatSync(directory)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (mode !== undefined && (entry.mode & 0o7777) !== mode) || fs.realpathSync(directory) !== directory) {
    fail('unsafe_directory')
  }
}

function safeFile(filename, mode = 0o600) {
  const entry = fs.lstatSync(filename)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (entry.mode & 0o7777) !== mode || fs.realpathSync(filename) !== filename) {
    fail('unsafe_file')
  }
}

function readJson(filename, label, mode = 0o600) {
  safeFile(filename, mode)
  try {
    const value = JSON.parse(fs.readFileSync(filename, 'utf8'))
    if (!plainObject(value)) fail(`${label}_invalid`)
    return value
  } catch (error) {
    if (error instanceof Error && error.message === `qwen_current_feishu_delivery_policy_${label}_invalid`) throw error
    fail(`${label}_invalid`)
  }
}

function parseArgs(values) {
  if (values.length === 1 && ['--help', '-h'].includes(values[0])) return { help: true }
  const parsed = { mode: '', backup: '' }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--dry-run' || value === '--apply' || value === '--rollback') {
      if (parsed.mode) fail('arguments_invalid')
      parsed.mode = value.slice(2)
    } else if (value === '--backup') {
      const backup = values[++index]
      if (!backup || parsed.backup) fail('arguments_invalid')
      parsed.backup = backup
    } else {
      fail('arguments_invalid')
    }
  }
  if (!parsed.mode || (parsed.mode === 'rollback') !== Boolean(parsed.backup)
    || (parsed.backup && !path.isAbsolute(parsed.backup))) fail('arguments_invalid')
  return parsed
}

function usage() {
  process.stdout.write(
    'Usage: apply-qwen-current-feishu-delivery-policy.mjs (--dry-run|--apply|--rollback --backup <absolute-path>)\n',
  )
}

function manifest() {
  const value = readJson(MANIFEST_PATH, 'manifest', 0o644)
  const expected = {
    schema: SCHEMA,
    profile: PROFILE,
    channel: 'feishu',
    streaming: { mode: 'off' },
  }
  if (!same(value, expected)) fail('manifest_invalid')
  return value
}

function stateDirectory() {
  const home = process.env.HOME
  if (!home || !path.isAbsolute(home)) fail('home_invalid')
  const directory = process.env.AIWORKER_OPENCLAW_QWEN_STATE_DIR || path.join(home, '.openclaw-qwen-current')
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) fail('state_directory_invalid')
  safeDirectory(directory, 0o700)
  return directory
}

function runOpenClaw(args, options = {}) {
  const binary = process.env.OPENCLAW_BIN || 'openclaw'
  const env = { ...process.env }
  for (const key of ['OPENCLAW_PROFILE', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH']) delete env[key]
  const result = spawnSync(binary, ['--profile', PROFILE, ...args], {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    maxBuffer: 512 * 1024,
    shell: false,
    env,
  })
  if (result.error || result.signal || result.status !== 0) fail(`openclaw_${options.phase ?? 'command'}_failed`)
  return result.stdout.trim()
}

function configPath(stateDir) {
  const expected = path.join(stateDir, 'openclaw.json')
  safeFile(expected)
  const reported = runOpenClaw(['config', 'file'], { phase: 'config_file' })
  if (!reported || !path.isAbsolute(reported) || path.normalize(reported) !== reported
    || fs.realpathSync(reported) !== expected) fail('config_path_mismatch')
  return expected
}

function validateConfigShape(config) {
  if (!plainObject(config.channels) || !plainObject(config.channels.feishu)) fail('feishu_config_missing')
  const streaming = config.channels.feishu.streaming
  if (streaming !== undefined && !plainObject(streaming)) fail('feishu_streaming_invalid')
  return streaming
}

function policyPatch(value) {
  return { channels: { feishu: { streaming: value } } }
}

function desiredConfig(config, policy) {
  validateConfigShape(config)
  const next = structuredClone(config)
  next.channels.feishu.streaming = {
    ...(plainObject(next.channels.feishu.streaming) ? next.channels.feishu.streaming : {}),
    ...policy.streaming,
  }
  return next
}

function withoutPolicy(config) {
  const clone = structuredClone(config)
  if (plainObject(clone.meta)) {
    delete clone.meta.lastTouchedAt
    delete clone.meta.lastTouchedVersion
    if (Object.keys(clone.meta).length === 0) delete clone.meta
  }
  if (plainObject(clone.channels?.feishu)) {
    delete clone.channels.feishu.streaming
    if (Object.keys(clone.channels.feishu).length === 0) delete clone.channels.feishu
    if (Object.keys(clone.channels).length === 0) delete clone.channels
  }
  return clone
}

function feishuWithoutPolicy(config) {
  const feishu = config?.channels?.feishu
  if (!plainObject(feishu)) return null
  const clone = structuredClone(feishu)
  delete clone.streaming
  return clone
}

function assertExpected(config, policy) {
  validateConfigShape(config)
  if (config.channels.feishu.streaming?.mode !== policy.streaming.mode) fail('policy_not_applied')
}

function privateTempDirectory() {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aiworker-feishu-delivery-policy-')))
  fs.chmodSync(directory, 0o700)
  safeDirectory(directory, 0o700)
  return directory
}

function writePatch(directory, patch) {
  const filename = path.join(directory, 'patch.json')
  fs.writeFileSync(filename, `${JSON.stringify(patch, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  safeFile(filename)
  return filename
}

function backupRoot() {
  const home = process.env.HOME
  const requested = process.env.AIWORKER_OPENCLAW_FEISHU_POLICY_BACKUP_ROOT
    || path.join(home, 'ai-worker', 'backups', 'openclaw-feishu-delivery-policy')
  fs.mkdirSync(requested, { recursive: true, mode: 0o700 })
  const directory = fs.realpathSync(requested)
  fs.chmodSync(directory, 0o700)
  safeDirectory(directory, 0o700)
  return directory
}

function physicalInside(root, candidate) {
  const relative = path.relative(fs.realpathSync(root), fs.realpathSync(candidate))
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function createBackup(root, configPathname) {
  const filename = path.join(root, `qwen-current-before-feishu-delivery.${Date.now()}.${randomUUID()}.json`)
  const source = fs.readFileSync(configPathname)
  fs.writeFileSync(filename, source, { flag: 'wx', mode: 0o600 })
  safeFile(filename)
  return filename
}

function retainTwoBackups(root) {
  const files = fs.readdirSync(root)
    .filter(name => /^qwen-current-before-feishu-delivery\.[0-9]+\.[0-9a-f-]{36}\.json$/u.test(name))
    .map(name => ({ name, pathname: path.join(root, name), mtime: fs.statSync(path.join(root, name)).mtimeMs }))
    .sort((left, right) => right.mtime - left.mtime || right.name.localeCompare(left.name))
  for (const item of files.slice(2)) {
    safeFile(item.pathname)
    fs.rmSync(item.pathname)
  }
}

function runPatch(patch, dryRun) {
  const directory = privateTempDirectory()
  try {
    const filename = writePatch(directory, patch)
    runOpenClaw(['config', 'patch', '--file', filename, ...(dryRun ? ['--dry-run'] : [])], {
      phase: dryRun ? 'dry_run_patch' : 'apply_patch',
    })
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

function runValidate() {
  runOpenClaw(['config', 'validate'], { phase: 'validate' })
}

function receipt({ currentState, config, backup, policy }) {
  return {
    schema: RECEIPT_SCHEMA,
    currentState,
    profile: PROFILE,
    channel: policy.channel,
    streaming: policy.streaming,
    configSha256: sha256(JSON.stringify(stable(config))),
    ...(backup ? { backup: { sha256: sha256(fs.readFileSync(backup)) } } : {}),
    nextAction: 'coordinated_gateway_restart_required',
  }
}

function apply(policy) {
  const stateDir = stateDirectory()
  const pathname = configPath(stateDir)
  const before = readJson(pathname, 'config')
  const desired = desiredConfig(before, policy)
  runPatch(policyPatch(policy.streaming), true)
  if (same(before, desired)) return receipt({ currentState: 'ALREADY_CURRENT', config: before, policy })
  const root = backupRoot()
  const backup = createBackup(root, pathname)
  try {
    runPatch(policyPatch(policy.streaming), false)
    runValidate()
    const after = readJson(pathname, 'config')
    if (!same(withoutPolicy(before), withoutPolicy(after))) {
      fail('scope_drift')
    }
    assertExpected(after, policy)
    retainTwoBackups(root)
    return receipt({ currentState: 'APPLIED', config: after, backup, policy })
  } catch (error) {
    const current = readJson(pathname, 'config')
    if (same(feishuWithoutPolicy(before), feishuWithoutPolicy(current))) {
      const previousStreaming = before.channels.feishu.streaming
      runPatch({ channels: { feishu: { streaming: previousStreaming === undefined ? null : previousStreaming } } }, false)
      runValidate()
    }
    throw error
  }
}

function rollback(backupPath, policy) {
  const root = backupRoot()
  if (!physicalInside(root, backupPath)) fail('backup_outside_root')
  safeFile(backupPath)
  const stateDir = stateDirectory()
  const pathname = configPath(stateDir)
  const before = readJson(pathname, 'config')
  const backup = readJson(backupPath, 'backup')
  validateConfigShape(backup)
  if (!same(withoutPolicy(before), withoutPolicy(backup))) fail('rollback_scope_drift')
  const previousStreaming = backup.channels.feishu.streaming
  runPatch({ channels: { feishu: { streaming: previousStreaming === undefined ? null : previousStreaming } } }, false)
  runValidate()
  const after = readJson(pathname, 'config')
  if (!same(after.channels.feishu.streaming, previousStreaming)) fail('rollback_readback_failed')
  return receipt({ currentState: 'ROLLED_BACK', config: after, backup: backupPath, policy })
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()
  const policy = manifest()
  if (args.mode === 'dry-run') {
    const stateDir = stateDirectory()
    const pathname = configPath(stateDir)
    const before = readJson(pathname, 'config')
    validateConfigShape(before)
    runPatch(policyPatch(policy.streaming), true)
    process.stdout.write(`${JSON.stringify(receipt({ currentState: 'DRY_RUN_PASSED', config: desiredConfig(before, policy), policy }))}\n`)
    return
  }
  const result = args.mode === 'apply' ? apply(policy) : rollback(args.backup, policy)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

try {
  main()
} catch (error) {
  const message = error instanceof Error ? error.message : 'qwen_current_feishu_delivery_policy_failed'
  process.stderr.write(`${message}\n`)
  process.exitCode = 1
}
