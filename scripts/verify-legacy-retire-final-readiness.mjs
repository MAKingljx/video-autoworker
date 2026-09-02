#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveGatewayTokenFromConfigPath } from './lib/openclaw-secret-reference.mjs'

const SCRIPT_PATH = realpathSync(fileURLToPath(import.meta.url))
const REPOSITORY_ROOT = realpathSync(join(dirname(SCRIPT_PATH), '..'))
const REPORT_SCHEMA = 'video-autoworker-legacy-retire-final-readiness/v1'
const VERIFY_SCHEMA = 'video-autoworker-legacy-retire-final-readiness-verification/v1'
const PREPARED_SCHEMA = 'video-autoworker-legacy-media-orphan-runtime-receipt/v1'
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const MAX_JSON_BYTES = 16 * 1024 * 1024
const TEST_MODE = process.env.NODE_ENV === 'test'
  && process.env.AIWORKER_TEST_LEGACY_FINAL_READINESS === '1'
const MANAGED_OPENCLAW = join(homedir(), 'ai-worker', 'bin', 'openclaw')
const MANAGED = Object.freeze({
  blueGreen: join(REPOSITORY_ROOT, 'scripts/deploy-blue-green.sh'),
  transition: join(REPOSITORY_ROOT, 'scripts/n8n-workflow-transition-anchor.mjs'),
  workflows: join(REPOSITORY_ROOT, 'scripts/verify-n8n-blue-green-workflows.mjs'),
  director: join(REPOSITORY_ROOT, 'scripts/verify-director-video-release-readiness.mjs'),
})

function fail(message) {
  throw new Error(`legacy retire final-readiness failed: ${message}`)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

function canonicalJson(value) { return JSON.stringify(canonicalize(value)) }
function sha256(value) { return createHash('sha256').update(value).digest('hex') }

function normalizedAbsolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} must be one normalized absolute path`)
  return pathname
}

function assertNoSymlink(pathname, label, allowMissingLeaf = false) {
  normalizedAbsolute(pathname, label)
  const root = parse(pathname).root
  const parts = relative(root, pathname).split('/').filter(Boolean)
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index])
    let entry
    try { entry = lstatSync(current, { bigint: true }) } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && error?.code === 'ENOENT') return
      fail(`${label} path component is unavailable`)
    }
    if (entry.isSymbolicLink()) fail(`${label} path contains a symlink`)
  }
}

function safeEntry(pathname, label, kind, mode = null, maximumBytes = MAX_JSON_BYTES) {
  assertNoSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if (kind === 'file' && (!entry.isFile() || entry.nlink !== 1n)) fail(`${label} is not one regular file`)
  if (kind === 'directory' && !entry.isDirectory()) fail(`${label} is not a directory`)
  if (entry.uid !== BigInt(process.getuid())) fail(`${label} owner is invalid`)
  const actualMode = Number(entry.mode & 0o7777n)
  if (mode === null ? (actualMode & 0o022) !== 0 : actualMode !== mode) fail(`${label} mode is unsafe`)
  if (kind === 'file' && (entry.size <= 0n || entry.size > BigInt(maximumBytes))) {
    fail(`${label} size is invalid`)
  }
  return entry
}

function fileSha256(pathname, label, mode = null, maximumBytes = MAX_JSON_BYTES) {
  const entry = safeEntry(pathname, label, 'file', mode, maximumBytes)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size
      || opened.nlink !== 1n) fail(`${label} changed before hashing`)
    const source = readFileSync(descriptor)
    const afterFd = fstatSync(descriptor, { bigint: true })
    const afterPath = lstatSync(pathname, { bigint: true })
    if (source.length !== Number(opened.size) || afterFd.dev !== opened.dev
      || afterFd.ino !== opened.ino || afterFd.size !== opened.size
      || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino
      || afterPath.size !== opened.size || afterPath.nlink !== 1n) {
      fail(`${label} changed while hashing`)
    }
    return sha256(source)
  } finally { closeSync(descriptor) }
}

function fullFileReference(pathname, label, mode = null, maximumBytes = MAX_JSON_BYTES) {
  const entry = safeEntry(pathname, label, 'file', mode, maximumBytes)
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    size: Number(entry.size),
    mtimeNs: entry.mtimeNs.toString(),
    ctimeNs: entry.ctimeNs.toString(),
    uid: Number(entry.uid),
    mode: Number(entry.mode & 0o7777n),
    nlink: Number(entry.nlink),
    sha256: fileSha256(pathname, label, mode, maximumBytes),
  }
}

function verifyFullFileReference(reference, label, mode = null, maximumBytes = MAX_JSON_BYTES) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)
    || canonicalJson(Object.keys(reference).sort()) !== canonicalJson([
      'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'path', 'sha256', 'size', 'uid',
    ].sort()) || !SHA256.test(reference.sha256)) fail(`${label} reference is invalid`)
  const actual = fullFileReference(reference.path, label, mode, maximumBytes)
  if (canonicalJson(actual) !== canonicalJson(reference)) fail(`${label} reference changed`)
  return reference
}

function directoryReference(pathname, label) {
  const entry = safeEntry(pathname, label, 'directory')
  if (realpathSync(pathname) !== pathname) fail(`${label} is not physical`)
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    uid: Number(entry.uid),
    mode: Number(entry.mode & 0o7777n),
  }
}

function verifyDirectoryReference(reference, label) {
  if (!reference || typeof reference !== 'object' || Array.isArray(reference)
    || canonicalJson(Object.keys(reference).sort()) !== canonicalJson(['dev', 'ino', 'mode', 'path', 'uid'])) {
    fail(`${label} reference is invalid`)
  }
  if (canonicalJson(directoryReference(reference.path, label)) !== canonicalJson(reference)) {
    fail(`${label} reference changed`)
  }
  return reference
}

function readJson(pathname, label, mode = null) {
  const reference = fullFileReference(pathname, label, mode)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev.toString() !== reference.dev || opened.ino.toString() !== reference.ino) {
      fail(`${label} changed before read`)
    }
    const source = readFileSync(descriptor, 'utf8')
    let value
    try { value = JSON.parse(source) } catch { fail(`${label} is not JSON`) }
    if (sha256(source) !== reference.sha256
      || canonicalJson(fullFileReference(pathname, label, mode)) !== canonicalJson(reference)) {
      fail(`${label} changed during read`)
    }
    return { value, reference }
  } finally { closeSync(descriptor) }
}

function fsyncDirectory(pathname) {
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function writeImmutableJson(pathname, value) {
  assertNoSymlink(pathname, 'final-readiness output', true)
  if (existsSync(pathname)) fail('final-readiness output already exists')
  const parent = dirname(pathname)
  safeEntry(parent, 'final-readiness output directory', 'directory')
  const temporary = join(parent, `.${basename(pathname)}.${randomBytes(16).toString('hex')}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    writeFileSync(descriptor, `${canonicalJson(value)}\n`, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    chmodSync(temporary, 0o400)
    const verifyFd = openSync(temporary, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { fsyncSync(verifyFd) } finally { closeSync(verifyFd) }
    renameSync(temporary, pathname)
    fsyncDirectory(parent)
    return readJson(pathname, 'final-readiness report', 0o400)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch {}
    throw error
  }
}

function productionEnvironment() {
  const environment = { ...process.env }
  if (!TEST_MODE) {
    environment.NODE_ENV = 'production'
    for (const name of Object.keys(environment)) {
      if (name.startsWith('AIWORKER_TEST_')) delete environment[name]
    }
  }
  return environment
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPOSITORY_ROOT,
    env: options.env || productionEnvironment(),
    encoding: 'utf8',
    input: options.input,
    maxBuffer: MAX_JSON_BYTES,
    timeout: options.timeout || 60_000,
  })
  if (result.error || result.signal || result.status !== 0) {
    fail(`${label} failed${result.stderr?.trim() ? `: ${result.stderr.trim().slice(0, 500)}` : ''}`)
  }
  return result.stdout
}

function parseJsonOutput(source, label) {
  let value
  try { value = JSON.parse(source) } catch { fail(`${label} output is not JSON`) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} output is invalid`)
  return value
}

function lsofRecords(pid) {
  const source = run('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd,txt', '-FfDin'], `PID ${pid} identity`)
  const records = []
  let current = null
  for (const line of source.split('\n')) {
    if (line.startsWith('f')) { current = { descriptor: line.slice(1) }; records.push(current) }
    else if (current && line.startsWith('D')) current.dev = BigInt(line.slice(1)).toString()
    else if (current && line.startsWith('i')) current.ino = BigInt(line.slice(1)).toString()
    else if (current && line.startsWith('n')) current.path = line.slice(1)
  }
  return records
}

function listenerPid(port) {
  const source = run('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], `${port} listener`)
  const values = [...new Set(source.split('\n').filter(line => /^p[1-9][0-9]*$/u.test(line))
    .map(line => Number(line.slice(1))))]
  if (values.length !== 1) fail(`port ${port} does not have exactly one listener`)
  return values[0]
}

function pathIdentity(pathname, label, kind) {
  const entry = safeEntry(pathname, label, kind, null, Number.MAX_SAFE_INTEGER)
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    uid: Number(entry.uid),
    mode: Number(entry.mode & 0o7777n),
  }
}

function processIdentity(pid, label) {
  const ps = (field) => run('/bin/ps', ['-p', String(pid), '-o', `${field}=`], `${label} ${field}`).trim()
  const uid = Number(ps('uid'))
  const ppid = Number(ps('ppid'))
  const startTime = ps('lstart')
  const argv = ps('command')
  const records = lsofRecords(pid)
  const cwdRecord = records.filter(record => record.descriptor === 'cwd')
  const executableRecords = records.filter(record => record.descriptor === 'txt' && record.path?.startsWith('/'))
  if (!Number.isSafeInteger(uid) || uid !== process.getuid() || !Number.isSafeInteger(ppid) || ppid <= 0
    || !startTime || !argv || cwdRecord.length !== 1 || executableRecords.length < 1) {
    fail(`${label} process identity is invalid`)
  }
  const cwd = pathIdentity(cwdRecord[0].path, `${label} cwd`, 'directory')
  if (cwd.dev !== cwdRecord[0].dev || cwd.ino !== cwdRecord[0].ino) fail(`${label} cwd open identity differs`)
  const executableRecord = executableRecords[0]
  const executable = pathIdentity(executableRecord.path, `${label} executable`, 'file')
  if (executable.dev !== executableRecord.dev || executable.ino !== executableRecord.ino) {
    fail(`${label} executable open identity differs`)
  }
  return { pid, ppid, uid, startTime, argvSha256: sha256(argv), cwd, executable }
}

function databaseIdentity(value, label) {
  if (!value?.path || !/^\d+$/u.test(String(value.dev)) || !/^\d+$/u.test(String(value.ino))) {
    fail(`${label} prepared identity is invalid`)
  }
  const current = pathIdentity(value.path, label, 'file')
  if (current.dev !== String(value.dev) || current.ino !== String(value.ino)) fail(`${label} identity changed`)
  return current
}

function preparedBinding(pathname) {
  const loaded = readJson(pathname, 'prepared runtime guard receipt', 0o400)
  const value = loaded.value
  if (value?.schema !== PREPARED_SCHEMA || typeof value.nonce !== 'string' || !value.nonce
    || !value.runtimeBefore?.protectedPids || !value.runtimeBefore?.orphan) {
    fail('prepared runtime guard receipt contract is invalid')
  }
  const missionValue = value.runtimeBefore.mission || value.runtimeBefore.legacy?.database
  const n8nValue = value.runtimeBefore.n8nDatabase || value.runtimeBefore.n8n?.database
  const protectedPids = value.runtimeBefore.protectedPids
  for (const port of ['18091', '18789', '18989']) {
    if (!Number.isSafeInteger(protectedPids[port]) || protectedPids[port] <= 0) {
      fail(`prepared protected listener ${port} is invalid`)
    }
  }
  return {
    loaded,
    value,
    projection: {
      receipt: loaded.reference,
      nonceSha256: sha256(value.nonce),
      intentSha256: value.intent?.sha256,
      databases: {
        mission: databaseIdentity(missionValue, 'Mission Control database'),
        n8n: databaseIdentity(n8nValue, 'n8n database'),
      },
      unchangedPids: Object.fromEntries(['18091', '18789', '18989'].map(port => [port, protectedPids[port]])),
    },
  }
}

function resolveGatewayToken(profileConfig) {
  const token = resolveGatewayTokenFromConfigPath(profileConfig)
  if (!token) {
    fail('qwen-current Gateway token cannot be resolved')
  }
  return token
}

function baseOpenClawEnvironment() {
  const environment = productionEnvironment()
  for (const name of ['OPENCLAW_PROFILE', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_HOME', 'OPENCLAW_INCLUDE_ROOTS']) {
    delete environment[name]
  }
  for (const name of ['OPENCLAW_GATEWAY_TOKEN', 'GATEWAY_TOKEN', 'OPENCLAW_GATEWAY_PASSWORD', 'GATEWAY_PASSWORD']) {
    delete environment[name]
  }
  return environment
}

function gatewayAuthenticatedEnvironment(profileConfig) {
  const environment = baseOpenClawEnvironment()
  environment.OPENCLAW_GATEWAY_TOKEN = resolveGatewayToken(profileConfig)
  return environment
}

function validateDirectorInspection(value) {
  const plugin = value?.plugin
  const tools = Array.isArray(value?.tools) ? value.tools : []
  const toolNames = tools.flatMap(item => Array.isArray(item?.names) ? item.names : []).sort()
  const diagnostics = Array.isArray(value?.diagnostics) ? value.diagnostics : []
  if (plugin?.id !== 'aiworker-director-brain' || plugin.status !== 'loaded' || plugin.version !== '0.3.1'
    || canonicalJson(toolNames) !== canonicalJson(['aiworker_director_brain'])
    || !Array.isArray(value?.typedHooks) || value.typedHooks.length !== 0
    || diagnostics.some(item => item?.level === 'error' || item?.severity === 'error')) {
    fail('director-brain runtime inspection is invalid')
  }
  return { id: plugin.id, status: plugin.status, version: plugin.version, toolNames, typedHooks: [] }
}

function validateDirectorCatalog(value, agentId) {
  const matches = (value?.groups || []).flatMap(group => (group?.tools || []).map(tool => ({ group, tool })))
    .filter(({ tool }) => tool?.id === 'aiworker_director_brain')
  if (value?.agentId !== agentId || matches.length !== 1) fail('director-brain tool catalog is invalid')
  const { group, tool } = matches[0]
  if (group?.pluginId !== 'aiworker-director-brain' || group?.source !== 'plugin'
    || tool?.pluginId !== 'aiworker-director-brain' || tool?.source !== 'plugin'
    || tool?.optional !== true) fail('director-brain tool catalog binding is invalid')
  return { agentId, id: tool.id, pluginId: tool.pluginId, source: tool.source, optional: tool.optional }
}

function validateDirectorHealth(value) {
  if (value?.ok !== true || value.action !== 'health' || value.tableCount !== 11
    || value.remoteContractVerified !== true || typeof value.brainName !== 'string'
    || typeof value.projectId !== 'string' || typeof value.environment !== 'string'
    || !SHA256.test(value.schemaFingerprint || '')) fail('director-brain health is invalid')
  return {
    ok: true,
    action: 'health',
    brainName: value.brainName,
    projectId: value.projectId,
    environment: value.environment,
    tableCount: value.tableCount,
    remoteContractVerified: true,
    schemaFingerprint: value.schemaFingerprint,
  }
}

export function captureDirectorControlPlane(inputs) {
  const profileConfig = join(inputs.profileStateRoot.path, 'openclaw.json')
  const openclawEnvironment = baseOpenClawEnvironment()
  const gatewayEnvironment = gatewayAuthenticatedEnvironment(profileConfig)
  run(inputs.openclawBin.path, ['--profile', 'qwen-current', 'gateway', 'status', '--deep', '--require-rpc', '--json'],
    'qwen-current Gateway RPC verification', { env: gatewayEnvironment })
  const inspection = validateDirectorInspection(parseJsonOutput(run(inputs.openclawBin.path, [
    '--profile', 'qwen-current', 'plugins', 'inspect', 'aiworker-director-brain', '--runtime', '--json',
  ], 'director-brain runtime inspection', { env: openclawEnvironment }), 'director-brain runtime inspection'))
  const catalog = validateDirectorCatalog(parseJsonOutput(run(inputs.openclawBin.path, [
    '--profile', 'qwen-current', 'gateway', 'call', 'tools.catalog',
    '--params', JSON.stringify({ agentId: inputs.agentId, includePlugins: true }),
    '--timeout', '20000', '--json',
  ], 'director-brain tool catalog', { env: gatewayEnvironment }), 'director-brain tool catalog'), inputs.agentId)
  const installedCli = join(inputs.profileStateRoot.path, 'extensions', 'aiworker-director-brain',
    'runtime', 'scripts', 'feishu-director-brain.mjs')
  const health = validateDirectorHealth(parseJsonOutput(run(process.execPath, [installedCli, 'operate'],
    'director-brain health', { input: '{"action":"health"}\n', timeout: 30_000, env: openclawEnvironment }), 'director-brain health'))
  return { gatewayRpc: true, inspection, catalog, health }
}

function captureProduction(inputs) {
  const blueGreen = parseJsonOutput(
    run(MANAGED.blueGreen, ['attest-current'], 'blue-green current attestation'),
    'blue-green current attestation',
  )
  if (blueGreen.schema !== 'video-autoworker-transition-release-evidence/v1'
    || !blueGreen.payload || !SHA256.test(blueGreen.evidenceSha256 || '')
    || sha256(JSON.stringify(blueGreen.payload)) !== blueGreen.evidenceSha256
    || !blueGreen.payload.releaseId?.startsWith(inputs.expectedCommit)
    || blueGreen.payload.route?.releaseId !== blueGreen.payload.releaseId
    || blueGreen.payload.readiness?.incompatiblePending !== 0
    || blueGreen.payload.readiness?.active !== 0) fail('blue-green current attestation is incompatible')

  const transition = parseJsonOutput(run(process.execPath, [
    MANAGED.transition, 'verify-transition',
    '--intent', inputs.transitionIntent.path,
    '--confirmation', inputs.transitionConfirmation.path,
    '--journal-dir', inputs.transitionJournal.path,
    '--attestation', inputs.transitionAttestation.path,
  ], 'n8n transition verification'), 'n8n transition verification')
  if (transition.schema !== 'video-autoworker-n8n-workflow-transition-attestation/v1'
    || transition.committed !== true || !SHA256.test(transition.attestationSha256 || '')
    || !SHA256.test(transition.liveCombinedSha256 || '')) fail('n8n transition verification is invalid')

  const n8nPid = listenerPid(5678)
  const n8nWebhookPid = listenerPid(5679)
  const workflows = parseJsonOutput(run(process.execPath, [
    MANAGED.workflows,
    '--database', inputs.n8nDatabase.path,
    '--repository', REPOSITORY_ROOT,
    '--expected-commit', inputs.expectedCommit,
    '--module-root', REPOSITORY_ROOT,
    '--pid', String(n8nPid),
    '--port', '5678',
  ], 'live n8n workflow verification'), 'live n8n workflow verification')
  if (workflows.schema !== 'video-autoworker-n8n-workflow-compatibility/v2'
    || workflows.sourceCommit !== inputs.expectedCommit || workflows.databasePath !== inputs.n8nDatabase.path
    || workflows.combinedSha256 !== transition.liveCombinedSha256
    || !SHA256.test(workflows.runtimeIdentitySha256 || '')) fail('live n8n workflow verification is incompatible')

  const directorControlPlane = captureDirectorControlPlane(inputs)

  const listeners = Object.fromEntries([3017, 5678, 5679, 18889, 18091, 18789, 18989]
    .map(port => [String(port), listenerPid(port)]))
  const unchangedServices = {}
  for (const port of ['18091', '18789', '18989']) {
    if (listeners[port] !== inputs.unchangedPids[port]) fail(`protected listener ${port} changed after prepare`)
    unchangedServices[port] = processIdentity(listeners[port], `protected ${port}`)
  }
  return {
    blueGreen,
    n8n: {
      transition,
      workflows,
      listeners: { '5678': listeners['5678'], '5679': listeners['5679'] },
      primary: processIdentity(n8nPid, 'n8n primary'),
      webhook: n8nWebhookPid === n8nPid ? { sameAsPrimary: true } : processIdentity(n8nWebhookPid, 'n8n webhook'),
    },
    director: {
      ...directorControlPlane,
      process: processIdentity(listeners['18889'], 'qwen-current Gateway'),
    },
    router: processIdentity(listeners['3017'], 'standalone router'),
    unchangedServices,
    zeroWork: {
      queueWaiting: 0,
      queueRunning: 0,
      incompatibleOutbox: blueGreen.payload.readiness.incompatiblePending,
      active: blueGreen.payload.readiness.active,
    },
  }
}

function captureRuntime(inputs) {
  if (TEST_MODE && process.env.AIWORKER_TEST_LEGACY_FINAL_READINESS_CAPTURE) {
    const command = normalizedAbsolute(
      process.env.AIWORKER_TEST_LEGACY_FINAL_READINESS_CAPTURE,
      'test final-readiness capture',
    )
    return parseJsonOutput(run(command, [canonicalJson(inputs)], 'test final-readiness capture'),
      'test final-readiness capture')
  }
  return captureProduction(inputs)
}

function inputBinding(values, prepared) {
  const expectedCommit = values['--expected-commit']
  if (!COMMIT.test(expectedCommit || '')) fail('expected commit is invalid')
  const n8nDatabase = prepared.projection.databases.n8n
  if (values['--n8n-database'] !== n8nDatabase.path) fail('n8n database differs from prepared receipt')
  const profileStateRoot = directoryReference(values['--profile-state-root'], 'qwen-current profile root')
  const workspaceRoot = directoryReference(values['--workspace-root'], 'qwen-current workspace root')
  if (!TEST_MODE && values['--openclaw-bin'] !== MANAGED_OPENCLAW) {
    fail('OpenClaw executable is not the managed production entry')
  }
  const openclawBin = fullFileReference(values['--openclaw-bin'], 'managed OpenClaw executable')
  if ((openclawBin.mode & 0o111) === 0) fail('managed OpenClaw entry is not executable')
  const agentId = values['--agent-id']
  if (typeof agentId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(agentId)) fail('agent ID is invalid')
  return {
    expectedCommit,
    transitionIntent: fullFileReference(values['--transition-intent'], 'transition intent', 0o400),
    transitionConfirmation: fullFileReference(values['--transition-confirmation'], 'transition confirmation', 0o400),
    transitionJournal: directoryReference(values['--transition-journal'], 'transition journal'),
    transitionAttestation: fullFileReference(values['--transition-attestation'], 'transition attestation', 0o400),
    n8nDatabase,
    profileStateRoot,
    workspaceRoot,
    openclawBin,
    agentId,
    unchangedPids: prepared.projection.unchangedPids,
  }
}

function validateInputs(inputs) {
  if (!COMMIT.test(inputs?.expectedCommit || '') || typeof inputs.agentId !== 'string'
    || !inputs.n8nDatabase || !inputs.unchangedPids) fail('final-readiness input binding is invalid')
  verifyFullFileReference(inputs.transitionIntent, 'transition intent', 0o400)
  verifyFullFileReference(inputs.transitionConfirmation, 'transition confirmation', 0o400)
  verifyDirectoryReference(inputs.transitionJournal, 'transition journal')
  verifyFullFileReference(inputs.transitionAttestation, 'transition attestation', 0o400)
  verifyDirectoryReference(inputs.profileStateRoot, 'qwen-current profile root')
  verifyDirectoryReference(inputs.workspaceRoot, 'qwen-current workspace root')
  verifyFullFileReference(inputs.openclawBin, 'managed OpenClaw executable')
  if ((!TEST_MODE && inputs.openclawBin.path !== MANAGED_OPENCLAW)
    || (inputs.openclawBin.mode & 0o111) === 0) {
    fail('managed OpenClaw executable binding is invalid')
  }
  databaseIdentity(inputs.n8nDatabase, 'n8n database')
  for (const port of ['18091', '18789', '18989']) {
    if (!Number.isSafeInteger(inputs.unchangedPids[port]) || inputs.unchangedPids[port] <= 0) {
      fail('final-readiness protected listener binding is invalid')
    }
  }
  return inputs
}

function reportPayload(value) {
  const clone = structuredClone(value)
  delete clone.payloadSha256
  return clone
}

function validateReport(pathname, preparedPath) {
  const loaded = readJson(pathname, 'final-readiness report', 0o400)
  const value = loaded.value
  if (value?.schema !== REPORT_SCHEMA || value.uid !== process.getuid()
    || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0
    || !value.prepared || !value.inputs || !value.snapshot || !value.verifiers
    || !SHA256.test(value.payloadSha256 || '')
    || sha256(canonicalJson(reportPayload(value))) !== value.payloadSha256) {
    fail('final-readiness report contract is invalid')
  }
  verifyFullFileReference(value.producer, 'final-readiness producer')
  if (value.producer.path !== SCRIPT_PATH) fail('final-readiness producer path is not managed')
  for (const [name, pathnameValue] of Object.entries(MANAGED)) {
    verifyFullFileReference(value.verifiers[name], `managed ${name} verifier`)
    if (value.verifiers[name].path !== pathnameValue) fail(`managed ${name} verifier path changed`)
  }
  verifyFullFileReference(value.prepared.receipt, 'prepared runtime guard receipt', 0o400)
  if (value.prepared.receipt.path !== preparedPath) fail('final-readiness report binds another prepared receipt')
  const prepared = preparedBinding(preparedPath)
  if (canonicalJson(prepared.projection) !== canonicalJson(value.prepared)) {
    fail('final-readiness prepared binding changed')
  }
  validateInputs(value.inputs)
  return { loaded, value, prepared }
}

function revalidateCapturedDependencies(value, preparedPath) {
  validateInputs(value.inputs)
  verifyFullFileReference(value.producer, 'final-readiness producer')
  if (value.producer.path !== SCRIPT_PATH) fail('final-readiness producer path is not managed')
  for (const [name, pathname] of Object.entries(MANAGED)) {
    verifyFullFileReference(value.verifiers[name], `managed ${name} verifier`)
    if (value.verifiers[name].path !== pathname) fail(`managed ${name} verifier path changed`)
  }
  const prepared = preparedBinding(preparedPath)
  if (canonicalJson(prepared.projection) !== canonicalJson(value.prepared)) {
    fail('final-readiness prepared binding changed after runtime capture')
  }
}

function parseArguments(argv) {
  const command = argv[0]
  const required = command === 'create' ? [
    '--output', '--prepared-receipt', '--transition-intent', '--transition-confirmation',
    '--transition-journal', '--transition-attestation', '--n8n-database', '--expected-commit',
  ] : command === 'verify-live' ? ['--report', '--prepared-receipt'] : null
  if (!required) fail('expected create or verify-live')
  const optional = command === 'create'
    ? ['--profile-state-root', '--workspace-root', '--agent-id', '--openclaw-bin']
    : []
  const allowed = new Set([...required, ...optional])
  const values = {}
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(name) || !value || Object.hasOwn(values, name)) fail(`${command} arguments are invalid`)
    values[name] = value
  }
  if (!required.every(name => Object.hasOwn(values, name))) fail(`${command} arguments are incomplete`)
  if (command === 'create') {
    values['--profile-state-root'] ||= join(homedir(), '.openclaw-qwen-current')
    values['--workspace-root'] ||= join(homedir(), 'AI-worker-second-original-workspace')
    values['--agent-id'] ||= 'second-original'
    values['--openclaw-bin'] ||= MANAGED_OPENCLAW
  }
  for (const [name, value] of Object.entries(values)) {
    if (!['--expected-commit', '--agent-id'].includes(name)) normalizedAbsolute(value, name)
  }
  return { command, values }
}

export function createFinalReadiness(values) {
  const prepared = preparedBinding(values['--prepared-receipt'])
  const inputs = inputBinding(values, prepared)
  const producer = fullFileReference(SCRIPT_PATH, 'final-readiness producer')
  const verifiers = Object.fromEntries(Object.entries(MANAGED)
    .map(([name, pathname]) => [name, fullFileReference(pathname, `managed ${name} verifier`)]))
  const first = captureRuntime(inputs)
  const second = captureRuntime(inputs)
  if (canonicalJson(first) !== canonicalJson(second)) fail('final runtime changed between readiness samples')
  const report = {
    schema: REPORT_SCHEMA,
    createdAt: Math.floor(Date.now() / 1000),
    uid: process.getuid(),
    producer,
    prepared: prepared.projection,
    inputs,
    verifiers,
    snapshot: second,
  }
  revalidateCapturedDependencies(report, values['--prepared-receipt'])
  report.payloadSha256 = sha256(canonicalJson(report))
  const output = values['--output']
  if (existsSync(output)) {
    const existing = validateReport(output, values['--prepared-receipt'])
    if (canonicalJson(existing.value.inputs) !== canonicalJson(inputs)
      || canonicalJson(existing.value.snapshot) !== canonicalJson(second)) {
      fail('existing final-readiness report belongs to another runtime')
    }
    return { resumed: true, report: existing.loaded.reference, snapshotSha256: sha256(canonicalJson(second)) }
  }
  const written = writeImmutableJson(output, report)
  return { resumed: false, report: written.reference, snapshotSha256: sha256(canonicalJson(second)) }
}

export function verifyLiveFinalReadiness(values) {
  const report = validateReport(values['--report'], values['--prepared-receipt'])
  const first = captureRuntime(report.value.inputs)
  const second = captureRuntime(report.value.inputs)
  if (canonicalJson(first) !== canonicalJson(second)
    || canonicalJson(second) !== canonicalJson(report.value.snapshot)) {
    fail('live final runtime differs from the immutable readiness report')
  }
  revalidateCapturedDependencies(report.value, values['--prepared-receipt'])
  const finalReport = validateReport(values['--report'], values['--prepared-receipt'])
  if (canonicalJson(finalReport.loaded.reference) !== canonicalJson(report.loaded.reference)) {
    fail('final-readiness report changed after runtime capture')
  }
  const reference = fullFileReference(values['--report'], 'final-readiness report', 0o400)
  return {
    schema: VERIFY_SCHEMA,
    ok: true,
    report: reference,
    snapshot: second,
    snapshotSha256: sha256(canonicalJson(second)),
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArguments(argv)
  const result = command === 'create' ? createFinalReadiness(values) : verifyLiveFinalReadiness(values)
  process.stdout.write(`${canonicalJson({
    schema: command === 'create' ? REPORT_SCHEMA : VERIFY_SCHEMA,
    ok: true,
    ...result,
  })}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
