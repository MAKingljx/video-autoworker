import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { OPENCLAW_RUNTIME_VERSION } from './openclaw-runtime-contract.mjs'

export const RECOGNIZED_LEGACY_OPENCLAW_VERSION = '2026.9.2'
const hash = value => createHash('sha256').update(value).digest('hex')
const fail = message => { throw new Error(message) }
const testMode = () => process.env.NODE_ENV === 'test' && process.env.AIWORKER_OPENCLAW_RUNTIME_TEST_MODE === '1'
const physicalDirectory = (pathname, label) => {
  if (!path.isAbsolute(pathname) || path.resolve(pathname) !== pathname) fail(`${label} is not absolute`)
  const entry = fs.lstatSync(pathname)
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid()
    || (entry.mode & 0o022) !== 0 || fs.realpathSync(pathname) !== pathname) fail(`${label} is unsafe`)
  return entry
}
function ancestry(root, descendant) {
  physicalDirectory(root, 'OpenClaw SDK managed root')
  const relative = path.relative(root, descendant)
  if (relative.startsWith('..') || path.isAbsolute(relative)) fail('OpenClaw SDK ancestry is unsafe')
  let current = root
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    physicalDirectory(current, 'OpenClaw SDK ancestry')
  }
}
function fileEvidence(pathname, label, maximum = 1024 * 1024) {
  const entry = fs.lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== process.getuid()
    || (entry.mode & 0o022) !== 0 || entry.size < 1 || entry.size > maximum
    || fs.realpathSync(pathname) !== pathname) fail(`${label} is unsafe`)
  const fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const before = fs.fstatSync(fd)
    if (before.dev !== entry.dev || before.ino !== entry.ino || before.size !== entry.size) fail(`${label} changed while reading`)
    const bytes = fs.readFileSync(fd)
    const after = fs.fstatSync(fd)
    if (after.dev !== entry.dev || after.ino !== entry.ino || after.size !== entry.size
      || after.mtimeMs !== entry.mtimeMs || after.ctimeMs !== entry.ctimeMs) fail(`${label} changed while reading`)
    return { bytes, stat: entry }
  } finally { fs.closeSync(fd) }
}
function packageEvidence(root, expectedVersion) {
  const rootStat = physicalDirectory(root, 'OpenClaw SDK root')
  const evidence = fileEvidence(path.join(root, 'package.json'), 'OpenClaw SDK package')
  let value
  try { value = JSON.parse(evidence.bytes) } catch { fail('OpenClaw SDK package is invalid JSON') }
  if (value.name !== 'openclaw' || value.version !== expectedVersion) fail('OpenClaw SDK package identity is invalid')
  return { root, name: value.name, version: value.version, rootMode: rootStat.mode & 0o7777,
    packageMode: evidence.stat.mode & 0o7777, packageSize: evidence.bytes.length, packageSha256: hash(evidence.bytes),
    latestChangeMs: Math.max(rootStat.mtimeMs, rootStat.ctimeMs, evidence.stat.mtimeMs, evidence.stat.ctimeMs) }
}
function fixtureRoot() {
  if (!testMode() || !process.env.AIWORKER_TEST_OPENCLAW_MANAGED_NODE_ROOT) return null
  const root = process.env.AIWORKER_TEST_OPENCLAW_MANAGED_NODE_ROOT
  physicalDirectory(root, 'test managed Node root')
  return root
}
function legacyNodeRoot(home) {
  const fixture = fixtureRoot()
  if (fixture) return fixture
  const current = path.join(home, 'ai-worker/node/current')
  const currentEntry = fs.lstatSync(current)
  if (currentEntry.uid !== process.getuid() || (!currentEntry.isSymbolicLink() && !currentEntry.isDirectory())) {
    fail('OpenClaw SDK legacy managed Node binding is unsafe')
  }
  const root = fs.realpathSync(current)
  const parent = path.join(home, 'ai-worker/node')
  if (path.dirname(root) !== parent || !/^node-v\d+\.\d+\.\d+-darwin-(?:arm64|x64)$/u.test(path.basename(root))) {
    fail('OpenClaw SDK legacy managed Node root is invalid')
  }
  ancestry(parent, root)
  return root
}

/** Resolve the installed SDK from the owned CLI binding, never from the
 * business process.execPath. The business release coordinator remains Node22. */
export function resolveManagedOpenClawSdk({ expectedVersion = OPENCLAW_RUNTIME_VERSION, cliPath,
  home = homedir() } = {}) {
  if (home !== homedir() && !testMode()) fail('OpenClaw SDK home override is test-only')
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/u.test(expectedVersion)) fail('OpenClaw SDK version is invalid')
  const fixture = fixtureRoot()
  if (fixture) {
    const root = process.env.AIWORKER_TEST_OPENCLAW_SDK_ROOT || path.join(fixture, 'lib/node_modules/openclaw')
    ancestry(process.env.AIWORKER_TEST_OPENCLAW_SDK_ROOT ? root : fixture, root)
    return { ...packageEvidence(root, expectedVersion), cliBinding: { kind: 'isolated-fixture' } }
  }
  const expectedCli = path.join(home, 'ai-worker/bin/openclaw')
  const requested = cliPath || expectedCli
  if (requested !== expectedCli) fail('OpenClaw SDK CLI binding is outside the managed entry')
  ancestry(home, path.dirname(expectedCli))
  const aliasStat = fs.lstatSync(expectedCli)
  if (!aliasStat.isSymbolicLink() || aliasStat.uid !== process.getuid()) fail('OpenClaw SDK CLI binding is unsafe')
  const root = path.join(home, 'ai-worker/services/openclaw-runtime/releases', expectedVersion, 'install/lib/node_modules/openclaw')
  ancestry(home, root)
  const cli = fs.realpathSync(expectedCli)
  if (cli !== path.join(root, '.aiworker-cli-entry.sh')) fail('OpenClaw SDK CLI target is invalid')
  const wrapper = fileEvidence(cli, 'OpenClaw SDK CLI wrapper', 64 * 1024)
  if (!(wrapper.stat.mode & 0o100)) fail('OpenClaw SDK CLI wrapper is not executable')
  const wrapperText = wrapper.bytes.toString('utf8')
  const match = /^#!\/bin\/sh\nset -eu\nexec (\/[^\s'"`$]+) (\/[^\s'"`$]+) "\$@"\n$/u.exec(wrapperText)
  const runtimeRoot = path.join(home, 'ai-worker/services/openclaw-runtime/runtimes')
  const node = match?.[1]
  const nodeRoot = node ? path.dirname(path.dirname(node)) : ''
  if (!match || match[2] !== path.join(root, 'openclaw.mjs') || path.dirname(nodeRoot) !== runtimeRoot
    || !/^node-v24\.\d+\.\d+-darwin-(?:arm64|x64)$/u.test(path.basename(nodeRoot))
    || node !== path.join(nodeRoot, 'bin/node')) fail('OpenClaw SDK CLI wrapper binding is invalid')
  ancestry(home, path.dirname(node))
  const nodeStat = fs.lstatSync(node)
  if (!nodeStat.isFile() || nodeStat.isSymbolicLink() || nodeStat.uid !== process.getuid()
    || (nodeStat.mode & 0o022) || !(nodeStat.mode & 0o100)) fail('OpenClaw SDK CLI runtime is unsafe')
  const entry = fileEvidence(path.join(root, 'openclaw.mjs'), 'OpenClaw SDK CLI entry')
  const aliasAfter = fs.lstatSync(expectedCli)
  if (aliasAfter.dev !== aliasStat.dev || aliasAfter.ino !== aliasStat.ino || fs.realpathSync(expectedCli) !== cli) {
    fail('OpenClaw SDK CLI binding changed while reading')
  }
  return { ...packageEvidence(root, expectedVersion), cliBinding: { kind: 'managed-cli', path: expectedCli,
    target: cli, wrapperSha256: hash(wrapper.bytes), entrySha256: hash(entry.bytes), runtimeNodePath: node } }
}

/** Legacy evidence is an explicit before-state only. Strict callers never
 * accept it as the current runtime, and its original link/package stay bound. */
export function inspectManagedOpenClawSdkLink(pathname, expectedVersion = OPENCLAW_RUNTIME_VERSION, options = {}) {
  const entry = fs.lstatSync(pathname)
  if (!entry.isSymbolicLink() || entry.uid !== process.getuid()) fail('OpenClaw SDK link is unsafe')
  const current = resolveManagedOpenClawSdk({ expectedVersion })
  const target = fs.readlinkSync(pathname)
  let observed = current
  let currentState = 'current'
  if (target !== current.root) {
    if (options.allowRecognizedLegacy !== true) fail('OpenClaw SDK link target is invalid')
    const oldNode = legacyNodeRoot(homedir())
    const oldRoot = path.join(oldNode, 'lib/node_modules/openclaw')
    if (target !== oldRoot) fail('OpenClaw SDK link target is invalid')
    ancestry(oldNode, oldRoot)
    observed = packageEvidence(oldRoot, RECOGNIZED_LEGACY_OPENCLAW_VERSION)
    currentState = 'legacy-needed-update'
  }
  if (fs.realpathSync(pathname) !== observed.root) fail('OpenClaw SDK link target is invalid')
  const after = fs.lstatSync(pathname)
  if (after.dev !== entry.dev || after.ino !== entry.ino || after.mtimeMs !== entry.mtimeMs
    || after.ctimeMs !== entry.ctimeMs || fs.readlinkSync(pathname) !== target) fail('OpenClaw SDK link changed while reading')
  const { latestChangeMs: _currentTime, ...expectedSdkIdentity } = current
  return { currentState, expectedSdkRoot: current.root, expectedSdkIdentity,
    evidence: { path: 'node_modules/openclaw', type: 'symlink', mode: entry.mode & 0o7777,
      target, targetSha256: hash(target), sdk: { name: observed.name, version: observed.version,
        rootMode: observed.rootMode, packageMode: observed.packageMode, packageSize: observed.packageSize,
        packageSha256: observed.packageSha256 } },
    latestChangeMs: Math.max(entry.mtimeMs, entry.ctimeMs, observed.latestChangeMs) }
}

/** Caller owns the plugin installation lock and backup. Preserve the old
 * before-evidence in a separate receipt; never edit a historical manifest. */
function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0))
  try {
    fs.fsyncSync(fd)
    return true
  } catch (error) {
    if (['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS'].includes(error?.code)) return false
    throw error
  } finally { fs.closeSync(fd) }
}

export function rebindManagedOpenClawSdkLink(pathname, receiptPath) {
  const current = resolveManagedOpenClawSdk()
  const parent = path.dirname(pathname)
  if (path.basename(pathname) !== 'openclaw' || path.basename(parent) !== 'node_modules') fail('OpenClaw SDK rebind path is invalid')
  const pluginRoot = path.dirname(parent)
  physicalDirectory(pluginRoot, 'OpenClaw SDK plugin root')
  if (!path.isAbsolute(receiptPath) || path.resolve(receiptPath) !== receiptPath) fail('OpenClaw SDK receipt path is invalid')
  const receiptDirectory = path.dirname(receiptPath)
  physicalDirectory(receiptDirectory, 'OpenClaw SDK receipt directory')
  let before = null
  if (fs.existsSync(pathname) || fs.lstatSync(pathname, { throwIfNoEntry: false })) {
    before = inspectManagedOpenClawSdkLink(pathname, OPENCLAW_RUNTIME_VERSION, { allowRecognizedLegacy: true })
  }
  // Reserve and persist original evidence before any dependency-tree mutation.
  // An existing receipt must be a zero-mutation refusal.
  const fd = fs.openSync(receiptPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  const reservation = fs.fstatSync(fd)
  const prepared = { schema: 'aiworker-openclaw-sdk-rebind/v1', currentState: 'REBIND_PREPARED',
    changed: before?.currentState !== 'current', before: before?.evidence || null,
    after: null, expectedSdkIdentity: before?.expectedSdkIdentity || current }
  try { fs.writeFileSync(fd, JSON.stringify(prepared) + '\n'); fs.fsyncSync(fd) }
  finally { fs.closeSync(fd) }
  const receiptDirectorySynced = syncDirectory(receiptDirectory)
  let pluginDirectorySynced = true
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { mode: 0o700 })
    pluginDirectorySynced = syncDirectory(pluginRoot)
  }
  physicalDirectory(parent, 'OpenClaw SDK dependency directory')
  const temporary = path.join(parent, `.openclaw-sdk-${randomUUID()}`)
  const receiptTemporary = path.join(receiptDirectory, `.openclaw-sdk-receipt-${randomUUID()}`)
  try {
    if (before?.currentState !== 'current') {
      fs.symlinkSync(current.root, temporary)
      fs.renameSync(temporary, pathname)
    }
    const dependencyDirectorySynced = syncDirectory(parent)
    const after = inspectManagedOpenClawSdkLink(pathname)
    const receipt = { schema: prepared.schema, currentState: 'current', changed: prepared.changed,
      before: prepared.before, after: after.evidence, expectedSdkIdentity: after.expectedSdkIdentity,
      directoryFsyncSupported: receiptDirectorySynced && pluginDirectorySynced && dependencyDirectorySynced }
    // Publish after-evidence atomically. If writing fails, the complete durable
    // before receipt remains available for assessment of the owned operation.
    const finalFd = fs.openSync(receiptTemporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    try { fs.writeFileSync(finalFd, JSON.stringify(receipt) + '\n'); fs.fsyncSync(finalFd) }
    finally { fs.closeSync(finalFd) }
    const actual = fs.lstatSync(receiptPath)
    if (!actual.isFile() || actual.dev !== reservation.dev || actual.ino !== reservation.ino
      || actual.uid !== process.getuid() || (actual.mode & 0o7777) !== 0o600) fail('OpenClaw SDK receipt reservation changed')
    fs.renameSync(receiptTemporary, receiptPath)
    syncDirectory(receiptDirectory)
    return receipt
  } finally {
    for (const item of [temporary, receiptTemporary]) {
      if (fs.lstatSync(item, { throwIfNoEntry: false })) fs.unlinkSync(item)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'current-root' && args.length === 0) process.stdout.write(resolveManagedOpenClawSdk().root + '\n')
  else if (command === 'assert-current' && args.length === 0) resolveManagedOpenClawSdk()
  else if (command === 'rebind-link' && args.length === 2) rebindManagedOpenClawSdkLink(...args)
  else fail('OpenClaw managed SDK command is invalid')
}
