#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'

const INTENT_SCHEMA = 'video-autoworker-n8n-workflow-upgrade-intent/v1'
const CONFIRMATION_SCHEMA = 'video-autoworker-n8n-workflow-current-confirmation/v1'
const CAPABILITY_SCHEMA = 'video-autoworker-n8n-workflow-import-capability/v1'
const JOURNAL_SCHEMA = 'video-autoworker-n8n-workflow-upgrade-journal/v1'
const ATTESTATION_SCHEMA = 'video-autoworker-n8n-workflow-transition-attestation/v1'
const BOOTSTRAP_CLAIM_SCHEMA = 'video-autoworker-n8n-workflow-transition-bootstrap-claim/v1'
const PACKAGE_SCHEMA = 'video-autoworker-n8n-managed-workflow-backup/v1'
const LIVE_REPORT_SCHEMA = 'video-autoworker-n8n-workflow-compatibility/v2'
const PROTOCOL = 'slot-v1-execution-owner-v1'
const CONFIRMATION_TTL_SECONDS = 120
const MAX_JSON_BYTES = 16 * 1024 * 1024
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u
const WORKFLOWS = Object.freeze([
  { id: 'aiworker-task-intake-v1', sourceFile: 'aiworker-task-intake.json', backupFile: 'aiworker-task-intake-v1.json' },
  { id: 'aiworker-video-analysis-v1', sourceFile: 'aiworker-video-analysis.json', backupFile: 'aiworker-video-analysis-v1.json' },
])
const RUNTIME_SOURCE_PATHS = Object.freeze([
  'scripts/n8n-start.sh',
  'scripts/n8n-stop.sh',
  'scripts/n8n-status.sh',
  'scripts/n8n-import-workflows.sh',
  'scripts/n8n-maintenance-lock.mjs',
  'scripts/n8n-workflow-transition-anchor.mjs',
  'scripts/n8n-backup-managed-workflows.mjs',
  'scripts/n8n-restore-managed-workflows.sh',
  'ops/n8n/.env.example',
  'ops/n8n/lib/common.sh',
  'ops/n8n/package.json',
  'ops/n8n/package-lock.json',
  'ops/n8n/workflows/aiworker-task-intake.json',
  'ops/n8n/workflows/aiworker-video-analysis.json',
])
const ACTIONS = Object.freeze([
  'unpublish-existing-managed-workflows',
  'import-fixed-id-managed-workflows',
  'publish-managed-workflows',
])

function nowSeconds() {
  if (process.env.NODE_ENV === 'test' && /^\d{10}$/u.test(process.env.AIWORKER_TEST_TRANSITION_NOW || '')) {
    return Number(process.env.AIWORKER_TEST_TRANSITION_NOW)
  }
  return Math.floor(Date.now() / 1000)
}

function fail(message) {
  throw new Error(`n8n workflow transition anchor failed: ${message}`)
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

function strictJson(source, label, maximumBytes = MAX_JSON_BYTES) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > maximumBytes) fail(`${label} is too large`)
  let index = 0
  const whitespace = () => { while (/\s/u.test(source[index] || '')) index += 1 }
  const stringValue = () => {
    const start = index++
    let escaped = false
    while (index < source.length) {
      const character = source[index++]
      if (escaped) { escaped = false; continue }
      if (character === '\\') { escaped = true; continue }
      if (character === '"') {
        try { return JSON.parse(source.slice(start, index)) } catch { fail(`${label} contains an invalid string`) }
      }
      if (character.charCodeAt(0) < 0x20) fail(`${label} contains an invalid control character`)
    }
    fail(`${label} contains an unterminated string`)
  }
  const value = () => {
    whitespace()
    if (source[index] === '"') return stringValue()
    if (source[index] === '{') {
      index += 1
      whitespace()
      const output = {}
      const keys = new Set()
      if (source[index] === '}') { index += 1; return output }
      while (index < source.length) {
        whitespace()
        if (source[index] !== '"') fail(`${label} object key is invalid`)
        const key = stringValue()
        if (keys.has(key)) fail(`${label} contains a duplicate JSON key`)
        keys.add(key)
        whitespace()
        if (source[index++] !== ':') fail(`${label} object separator is invalid`)
        output[key] = value()
        whitespace()
        if (source[index] === '}') { index += 1; return output }
        if (source[index++] !== ',') fail(`${label} object delimiter is invalid`)
      }
      fail(`${label} object is unterminated`)
    }
    if (source[index] === '[') {
      index += 1
      whitespace()
      const output = []
      if (source[index] === ']') { index += 1; return output }
      while (index < source.length) {
        output.push(value())
        whitespace()
        if (source[index] === ']') { index += 1; return output }
        if (source[index++] !== ',') fail(`${label} array delimiter is invalid`)
      }
      fail(`${label} array is unterminated`)
    }
    const token = source.slice(index).match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u)?.[0]
    if (!token) fail(`${label} value is invalid`)
    index += token.length
    if (token === 'true') return true
    if (token === 'false') return false
    if (token === 'null') return null
    const number = Number(token)
    if (!Number.isFinite(number)) fail(`${label} number is invalid`)
    return number
  }
  const parsed = value()
  whitespace()
  if (index !== source.length) fail(`${label} has trailing content`)
  return parsed
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    fail(`${label} fields are invalid`)
  }
}

function absolutePath(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} must be one normalized absolute path`)
}

function noSymlink(pathname, label, allowMissingLeaf = false) {
  absolutePath(pathname, label)
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
    if (entry.isSymbolicLink()) fail(`${label} path contains a symbolic link`)
  }
  if (allowMissingLeaf) fail(`${label} already exists`)
}

function safeDirectory(pathname, label, requiredMode = null) {
  noSymlink(pathname, label)
  const entry = statSync(pathname, { bigint: true })
  const mode = Number(entry.mode & 0o7777n)
  if (!entry.isDirectory() || entry.uid !== BigInt(process.getuid()) || (mode & 0o077) !== 0) {
    fail(`${label} must be one owner-private physical directory`)
  }
  if (requiredMode !== null && mode !== requiredMode) fail(`${label} mode must be ${requiredMode.toString(8)}`)
  return { path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString(), uid: Number(entry.uid), mode: mode.toString(8) }
}

function controlledDirectory(pathname, label) {
  noSymlink(pathname, label)
  const entry = statSync(pathname, { bigint: true })
  const mode = Number(entry.mode & 0o7777n)
  if (!entry.isDirectory() || entry.uid !== BigInt(process.getuid()) || (mode & 0o022) !== 0) {
    fail(`${label} must be one controlled physical directory`)
  }
  return { path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString(), uid: Number(entry.uid), mode: mode.toString(8) }
}

function fileSnapshot(pathname, label, requiredMode = null, includeSha = true) {
  noSymlink(pathname, label)
  const entry = statSync(pathname, { bigint: true })
  const mode = Number(entry.mode & 0o7777n)
  if (!entry.isFile() || entry.uid !== BigInt(process.getuid()) || entry.nlink !== 1n || (mode & 0o022) !== 0) {
    fail(`${label} must be one controlled regular file with one link`)
  }
  if (requiredMode !== null && mode !== requiredMode) fail(`${label} mode must be ${requiredMode.toString(8)}`)
  const source = includeSha ? readFileSync(pathname) : null
  const after = statSync(pathname, { bigint: true })
  if (entry.dev !== after.dev || entry.ino !== after.ino || entry.size !== after.size
    || entry.mtimeNs !== after.mtimeNs || entry.ctimeNs !== after.ctimeNs) fail(`${label} changed while it was read`)
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    size: Number(entry.size),
    mtimeNs: entry.mtimeNs.toString(),
    ctimeNs: entry.ctimeNs.toString(),
    uid: Number(entry.uid),
    mode: mode.toString(8),
    nlink: Number(entry.nlink),
    ...(includeSha ? { sha256: sha256(source) } : {}),
  }
}

function sameReference(actual, expected, label) {
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} reference changed`)
}

function readJsonFile(pathname, label, requiredMode = null) {
  const reference = fileSnapshot(pathname, label, requiredMode)
  const source = readFileSync(pathname, 'utf8')
  return { value: strictJson(source, label), source, reference }
}

function fsyncDirectory(pathname, label, expected = null) {
  const before = safeDirectory(pathname, label)
  if (expected && (before.dev !== expected.dev || before.ino !== expected.ino)) {
    fail(`${label} identity changed before directory sync`)
  }
  const descriptor = openSync(pathname,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (!opened.isDirectory() || opened.uid !== BigInt(process.getuid())
      || opened.dev.toString() !== before.dev || opened.ino.toString() !== before.ino) {
      fail(`${label} identity changed while opening for directory sync`)
    }
    fsyncSync(descriptor)
    const after = safeDirectory(pathname, label)
    if (after.dev !== before.dev || after.ino !== before.ino) {
      fail(`${label} identity changed during directory sync`)
    }
  } finally { closeSync(descriptor) }
}

function createDirectoryDurable(pathname, label) {
  const parentPath = dirname(pathname)
  const parent = safeDirectory(parentPath, `${label} parent`, 0o700)
  noSymlink(pathname, label, true)
  mkdirSync(pathname, { mode: 0o700 })
  chmodSync(pathname, 0o700)
  fsyncDirectory(pathname, label)
  fsyncDirectory(parentPath, `${label} parent`, parent)
}

function renameDurable(source, destination, label) {
  noSymlink(source, `${label} source`)
  noSymlink(destination, `${label} destination`, true)
  const sourceEntry = lstatSync(source, { bigint: true })
  const sourceParentPath = dirname(source)
  const destinationParentPath = dirname(destination)
  const sourceParent = safeDirectory(sourceParentPath, `${label} source parent`)
  const destinationParent = safeDirectory(destinationParentPath, `${label} destination parent`)
  if (sourceParent.dev !== destinationParent.dev) fail(`${label} must stay on one filesystem`)
  renameSync(source, destination)
  const published = lstatSync(destination, { bigint: true })
  if (published.isSymbolicLink() || published.dev !== sourceEntry.dev || published.ino !== sourceEntry.ino) {
    fail(`${label} identity changed during rename`)
  }
  fsyncDirectory(destinationParentPath, `${label} destination parent`, destinationParent)
  if (sourceParentPath !== destinationParentPath) {
    fsyncDirectory(sourceParentPath, `${label} source parent`, sourceParent)
  }
}

function unlinkDurable(pathname, expected, label) {
  noSymlink(pathname, label)
  const parentPath = dirname(pathname)
  const parent = safeDirectory(parentPath, `${label} parent`)
  const before = lstatSync(pathname, { bigint: true })
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.nlink !== 1n || opened.dev.toString() !== expected.dev
      || opened.ino.toString() !== expected.ino) fail(`${label} identity changed before unlink`)
    unlinkSync(pathname)
    fsyncDirectory(parentPath, `${label} parent`, parent)
  } finally { closeSync(descriptor) }
}

function writeImmutable(pathname, value) {
  noSymlink(pathname, 'immutable output', true)
  const parentPath = dirname(pathname)
  const parent = safeDirectory(parentPath, 'immutable output parent')
  const source = `${canonicalJson(value)}\n`
  const descriptor = openSync(pathname, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
  try {
    writeFileSync(descriptor, source)
    fchmodSync(descriptor, 0o400)
    fsyncSync(descriptor)
  } finally { closeSync(descriptor) }
  const reference = fileSnapshot(pathname, 'immutable output', 0o400)
  fsyncDirectory(parentPath, 'immutable output parent', parent)
  return { source, reference }
}

function parseArguments(argv) {
  const command = argv[0]
  const commandFlags = {
    'prepare-intent': ['--upgrade-id', '--database', '--rollback-package', '--runtime-root', '--target-commit', '--slot', '--release-id', '--application-release-root', '--output'],
    'current-confirm': ['--intent', '--confirmation-token-file', '--confirmation-receipt-id', '--confirmation-output', '--capability-output'],
    'claim-import': ['--intent', '--confirmation', '--confirmation-token-file', '--capability', '--journal-dir'],
    'begin-mutation': ['--intent', '--confirmation', '--journal-dir'],
    'workflow-status': ['--intent', '--confirmation', '--journal-dir', '--id'],
    'verify-target': ['--intent', '--confirmation', '--journal-dir', '--id'],
    'record-workflow': ['--intent', '--confirmation', '--journal-dir', '--id'],
    'attest-transition': ['--intent', '--confirmation', '--journal-dir', '--live-report', '--verifier', '--output'],
    'verify-transition': ['--intent', '--confirmation', '--journal-dir', '--attestation'],
    'claim-bootstrap': ['--intent', '--confirmation', '--journal-dir', '--attestation', '--prepare-path', '--slot', '--release-id', '--release-root', '--manifest-sha256', '--output'],
    'assert-offline': ['--intent', '--confirmation', '--journal-dir'],
    'assert-tooling': ['--intent', '--importer'],
  }
  const names = commandFlags[command]
  if (!names) fail('unknown command')
  const values = {}
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!names.includes(name) || !value || Object.hasOwn(values, name)) fail(`${command} arguments are invalid`)
    values[name] = value
  }
  if (Object.keys(values).length !== names.length) fail(`${command} requires ${names.join(', ')}`)
  return { command, values }
}

function parseManifest(source, label) {
  const result = {}
  for (const line of source.trimEnd().split('\n')) {
    const separator = line.indexOf('=')
    if (separator <= 0) fail(`${label} has an invalid line`)
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)
    if (!value || Object.hasOwn(result, key)) fail(`${label} has duplicate or empty fields`)
    result[key] = value
  }
  return result
}

function normalizeSemantic(value, expectedId, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.id !== expectedId
    || typeof value.name !== 'string' || !Array.isArray(value.nodes)
    || !value.connections || typeof value.connections !== 'object' || Array.isArray(value.connections)
    || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) {
    fail(`${label} workflow contract is invalid`)
  }
  return {
    id: value.id,
    name: value.name,
    nodes: value.nodes,
    connections: value.connections,
    settings: value.settings,
    staticData: value.staticData ?? null,
    pinData: value.pinData ?? null,
    nodeGroups: Array.isArray(value.nodeGroups) ? value.nodeGroups : [],
  }
}

function validateRollbackPackage(packagePath) {
  const directory = safeDirectory(packagePath, 'rollback package', 0o500)
  const expectedMembers = ['manifest.json', ...WORKFLOWS.map(item => item.backupFile)].sort()
  if (canonicalJson(readdirSync(packagePath).sort()) !== canonicalJson(expectedMembers)) fail('rollback package member set is invalid')
  const loaded = readJsonFile(join(packagePath, 'manifest.json'), 'rollback manifest', 0o400)
  const manifest = loaded.value
  exactKeys(manifest, ['combinedSha256', 'createdAt', 'schema', 'source', 'workflows'], 'rollback manifest')
  exactKeys(manifest.source, ['databaseFileName', 'databaseIdentity', 'n8nVersion', 'quickCheck', 'sourceCommit'], 'rollback source')
  exactKeys(manifest.source.databaseIdentity, ['bytes', 'dev', 'ino', 'mtimeNs'], 'rollback database identity')
  if (manifest.schema !== PACKAGE_SCHEMA || !Number.isSafeInteger(manifest.createdAt) || manifest.createdAt <= 0
    || !COMMIT.test(manifest.source.sourceCommit)
    || !VERSION.test(manifest.source.n8nVersion) || manifest.source.quickCheck !== 'ok'
    || !SHA256.test(manifest.combinedSha256) || !Array.isArray(manifest.workflows)
    || canonicalJson(manifest.workflows.map(item => item?.id)) !== canonicalJson(WORKFLOWS.map(item => item.id))
    || typeof manifest.source.databaseFileName !== 'string'
    || !/^(?:0x[a-f0-9]+|\d+)$/u.test(manifest.source.databaseIdentity.dev)
    || !/^\d+$/u.test(manifest.source.databaseIdentity.ino)
    || !/^\d+$/u.test(manifest.source.databaseIdentity.mtimeNs)
    || !Number.isSafeInteger(manifest.source.databaseIdentity.bytes)) fail('rollback manifest identity is invalid')
  const workflows = WORKFLOWS.map(descriptor => {
    const report = manifest.workflows.find(item => item?.id === descriptor.id)
    exactKeys(report, ['active', 'activeVersionId', 'bytes', 'currentVersionId', 'file', 'fileSha256', 'id', 'origin', 'selectedVersionId', 'semanticSha256'], `rollback workflow ${descriptor.id}`)
    if (report.file !== descriptor.backupFile || typeof report.active !== 'boolean'
      || !['current', 'published'].includes(report.origin)
      || !/^[A-Za-z0-9-]{8,64}$/u.test(report.currentVersionId)
      || !/^[A-Za-z0-9-]{8,64}$/u.test(report.selectedVersionId)
      || (report.activeVersionId !== null && !/^[A-Za-z0-9-]{8,64}$/u.test(report.activeVersionId))
      || (report.active && (report.origin !== 'published' || report.activeVersionId !== report.selectedVersionId))
      || (!report.active && report.origin !== 'current')
      || !Number.isSafeInteger(report.bytes) || report.bytes < 1
      || !SHA256.test(report.fileSha256) || !SHA256.test(report.semanticSha256)) fail(`rollback workflow ${descriptor.id} is invalid`)
    const member = readJsonFile(join(packagePath, descriptor.backupFile), `rollback workflow ${descriptor.id}`, 0o400)
    exactKeys(member.value, ['active', 'connections', 'id', 'name', 'nodeGroups', 'nodes', 'pinData', 'settings', 'staticData', 'versionId'], `rollback member ${descriptor.id}`)
    const semantic = normalizeSemantic(member.value, descriptor.id, `rollback workflow ${descriptor.id}`)
    if (member.reference.size !== report.bytes || member.reference.sha256 !== report.fileSha256
      || member.value.active !== false || member.value.versionId !== report.selectedVersionId
      || sha256(canonicalJson(semantic)) !== report.semanticSha256) fail(`rollback workflow ${descriptor.id} digest is invalid`)
    return {
      id: descriptor.id,
      active: report.active,
      file: member.reference,
      semanticSha256: report.semanticSha256,
      fileSha256: report.fileSha256,
    }
  })
  const combined = sha256(manifest.workflows.map(report => [
    report.id, report.active ? 'active' : 'inactive', report.fileSha256, report.semanticSha256,
  ].join(':')).join('\n'))
  if (combined !== manifest.combinedSha256) fail('rollback package combined digest is invalid')
  return {
    directory,
    manifest: loaded.reference,
    sourceCommit: manifest.source.sourceCommit,
    n8nVersion: manifest.source.n8nVersion,
    database: {
      fileName: manifest.source.databaseFileName,
      identity: {
        dev: BigInt(manifest.source.databaseIdentity.dev).toString(),
        ino: BigInt(manifest.source.databaseIdentity.ino).toString(),
        bytes: manifest.source.databaseIdentity.bytes,
        mtimeNs: BigInt(manifest.source.databaseIdentity.mtimeNs).toString(),
      },
    },
    combinedSha256: combined,
    workflows,
  }
}

function databaseFamily(database) {
  absolutePath(database, '--database')
  const members = [{ suffix: '', ...fileSnapshot(database, 'authoritative n8n database') }]
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const pathname = `${database}${suffix}`
    if (existsSync(pathname)) members.push({ suffix, ...fileSnapshot(pathname, `n8n database ${suffix}`) })
  }
  return members
}

function validateRuntime(runtimeRoot, targetCommit) {
  noSymlink(runtimeRoot, 'target n8n runtime')
  const physical = realpathSync(runtimeRoot)
  if (physical !== runtimeRoot || basename(runtimeRoot) !== targetCommit) fail('target n8n runtime root is not the target commit release')
  const root = safeDirectory(runtimeRoot, 'target n8n runtime')
  const sourceCommit = fileSnapshot(join(runtimeRoot, 'SOURCE_COMMIT'), 'runtime SOURCE_COMMIT')
  if (readFileSync(sourceCommit.path, 'utf8') !== `${targetCommit}\n`) fail('runtime SOURCE_COMMIT differs from target commit')
  const sourceManifest = fileSnapshot(join(runtimeRoot, 'SOURCE_MANIFEST'), 'runtime SOURCE_MANIFEST')
  const sourceFields = parseManifest(readFileSync(sourceManifest.path, 'utf8'), 'runtime SOURCE_MANIFEST')
  const expectedManifestFields = [
    'built_at', 'n8n_version', 'package_lock_sha256', 'runtime_source_manifest_sha256',
    'source_commit', 'source_origin', 'video_workflow_sha256', 'workflow_sha256',
  ]
  if (canonicalJson(Object.keys(sourceFields).sort()) !== canonicalJson(expectedManifestFields)) {
    fail('runtime SOURCE_MANIFEST fields are invalid')
  }
  const runtimeSourceManifest = fileSnapshot(join(runtimeRoot, 'RUNTIME_SOURCE_SHA256SUMS'), 'runtime source manifest')
  const manifestLines = readFileSync(runtimeSourceManifest.path, 'utf8').trimEnd().split('\n')
  const runtimeSourceFiles = []
  for (let index = 0; index < manifestLines.length; index += 1) {
    const match = manifestLines[index].match(/^([a-f0-9]{64})  ([A-Za-z0-9._/-]+)$/u)
    if (!match || match[2] !== RUNTIME_SOURCE_PATHS[index]
      || match[2].startsWith('/') || match[2].split('/').includes('..')) {
      fail('runtime source manifest member list is invalid')
    }
    const member = fileSnapshot(join(runtimeRoot, match[2]), `runtime source ${match[2]}`)
    if (member.sha256 !== match[1]) fail(`runtime source member changed: ${match[2]}`)
    runtimeSourceFiles.push({ name: match[2], file: member })
  }
  if (runtimeSourceFiles.length !== RUNTIME_SOURCE_PATHS.length) fail('runtime source manifest is incomplete')
  const packageFile = fileSnapshot(join(runtimeRoot, 'ops/n8n/node_modules/n8n/package.json'), 'runtime n8n package')
  const packageValue = strictJson(readFileSync(packageFile.path, 'utf8'), 'runtime n8n package')
  if (sourceFields.source_commit !== targetCommit || !VERSION.test(sourceFields.n8n_version)
    || !SHA256.test(sourceFields.package_lock_sha256)
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(sourceFields.built_at)
    || !sourceFields.source_origin || /[\r\n]/u.test(sourceFields.source_origin)
    || packageValue?.version !== sourceFields.n8n_version
    || sourceFields.runtime_source_manifest_sha256 !== runtimeSourceManifest.sha256) fail('target n8n runtime source identity is invalid')
  const workflows = WORKFLOWS.map(descriptor => {
    const pathname = join(runtimeRoot, 'ops/n8n/workflows', descriptor.sourceFile)
    const source = fileSnapshot(pathname, `target workflow ${descriptor.id}`)
    const value = strictJson(readFileSync(pathname, 'utf8'), `target workflow ${descriptor.id}`)
    const semanticSha256 = sha256(canonicalJson(normalizeSemantic(value, descriptor.id, `target workflow ${descriptor.id}`)))
    const manifestField = descriptor.id === WORKFLOWS[0].id ? 'workflow_sha256' : 'video_workflow_sha256'
    if (sourceFields[manifestField] !== source.sha256) fail(`target workflow ${descriptor.id} differs from SOURCE_MANIFEST`)
    return { id: descriptor.id, source: source, sourceSha256: source.sha256, semanticSha256 }
  })
  return {
    root,
    sourceCommit,
    sourceManifest,
    runtimeSourceManifest,
    runtimeSourceFiles,
    tooling: {
      importer: runtimeSourceFiles.find(item => item.name === 'scripts/n8n-import-workflows.sh').file,
      transitionAnchor: runtimeSourceFiles.find(item => item.name === 'scripts/n8n-workflow-transition-anchor.mjs').file,
    },
    n8nPackage: packageFile,
    n8nVersion: sourceFields.n8n_version,
    workflows,
  }
}

function validateApplicationRelease(releaseRoot, slot, releaseId, targetCommit) {
  if (!['blue', 'green'].includes(slot)) fail('target application slot must be blue or green')
  if (releaseId !== `${targetCommit}-runtime`) fail('target application release ID must match the target commit')
  noSymlink(releaseRoot, 'target application release')
  if (realpathSync(releaseRoot) !== releaseRoot || basename(releaseRoot) !== 'standalone'
    || basename(dirname(releaseRoot)) !== releaseId) {
    fail('target application release root is not the canonical immutable release')
  }
  return {
    slot,
    releaseId,
    releaseRoot: controlledDirectory(releaseRoot, 'target application release'),
    manifest: fileSnapshot(join(releaseRoot, 'release-manifest.json'), 'target application release manifest'),
  }
}

function validateIntent(pathname, allowDatabaseMutation = false) {
  const loaded = readJsonFile(pathname, 'upgrade intent', 0o400)
  const value = loaded.value
  exactKeys(value, ['actions', 'confirmationPolicy', 'createdAt', 'database', 'rollback', 'runtime', 'schema', 'target', 'uid', 'upgradeId'], 'upgrade intent')
  if (value.schema !== INTENT_SCHEMA || !UUID.test(value.upgradeId) || value.uid !== process.getuid()
    || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0
    || canonicalJson(value.actions) !== canonicalJson(ACTIONS)) fail('upgrade intent identity is invalid')
  exactKeys(value.confirmationPolicy, ['capabilityTtlSeconds', 'required', 'tokenDigest', 'tokenProvision'], 'intent confirmation policy')
  exactKeys(value.target, ['application', 'commit', 'workflows'], 'intent target')
  exactKeys(value.target.application, ['manifest', 'releaseId', 'releaseRoot', 'slot'], 'intent application target')
  if (value.confirmationPolicy.required !== true || value.confirmationPolicy.capabilityTtlSeconds !== CONFIRMATION_TTL_SECONDS
    || value.confirmationPolicy.tokenDigest !== 'sha256'
    || value.confirmationPolicy.tokenProvision !== 'external-current-confirm-only') fail('intent confirmation policy is invalid')
  const rollback = validateRollbackPackage(value.rollback.directory.path)
  if (canonicalJson(rollback) !== canonicalJson(value.rollback)) fail('rollback package changed after intent')
  const rollbackDatabase = rollback.database.identity
  const baselineDatabase = value.database[0]
  if (rollback.database.fileName !== basename(baselineDatabase.path)
    || rollbackDatabase.dev !== baselineDatabase.dev || rollbackDatabase.ino !== baselineDatabase.ino
    || rollbackDatabase.bytes !== baselineDatabase.size || rollbackDatabase.mtimeNs !== baselineDatabase.mtimeNs) {
    fail('intent rollback package does not match the authoritative database baseline')
  }
  if (allowDatabaseMutation) {
    const currentDatabase = fileSnapshot(value.database[0].path, 'authoritative n8n database')
    for (const field of ['path', 'dev', 'ino', 'uid', 'nlink']) {
      if (currentDatabase[field] !== baselineDatabase[field]) fail('authoritative n8n database identity changed')
    }
  } else {
    sameReference(databaseFamily(value.database[0].path), value.database, 'authoritative n8n database family')
  }
  const runtime = validateRuntime(value.runtime.root.path, value.target.commit)
  if (canonicalJson(runtime) !== canonicalJson(value.runtime)) fail('target n8n runtime changed after intent')
  if (rollback.sourceCommit !== value.target.commit || rollback.n8nVersion !== runtime.n8nVersion) {
    fail('intent rollback package does not match the target runtime')
  }
  const application = validateApplicationRelease(
    value.target.application.releaseRoot.path,
    value.target.application.slot,
    value.target.application.releaseId,
    value.target.commit,
  )
  if (!COMMIT.test(value.target.commit)
    || canonicalJson(value.target.workflows) !== canonicalJson(runtime.workflows)
    || canonicalJson(value.target.application) !== canonicalJson(application)) fail('intent target is invalid')
  return { ...loaded, value }
}

function prepareIntent(values) {
  if (!UUID.test(values['--upgrade-id'])) fail('--upgrade-id must be one UUID')
  if (!COMMIT.test(values['--target-commit'])) fail('--target-commit must be one full Git commit')
  const rollback = validateRollbackPackage(values['--rollback-package'])
  const database = databaseFamily(values['--database'])
  const runtime = validateRuntime(values['--runtime-root'], values['--target-commit'])
  const application = validateApplicationRelease(
    values['--application-release-root'],
    values['--slot'],
    values['--release-id'],
    values['--target-commit'],
  )
  const rollbackDatabase = rollback.database.identity
  // The backup sourceCommit identifies the managed backup/restore tooling and
  // target runtime contract, not the historical workflow payload. Old payload
  // identity is carried independently by the package's per-workflow digests.
  if (rollback.sourceCommit !== values['--target-commit'] || rollback.n8nVersion !== runtime.n8nVersion) {
    fail('rollback package source commit and n8n version must match the target runtime')
  }
  if (rollback.database.fileName !== basename(values['--database'])
    || rollbackDatabase.dev !== database[0].dev || rollbackDatabase.ino !== database[0].ino
    || rollbackDatabase.bytes !== database[0].size || rollbackDatabase.mtimeNs !== database[0].mtimeNs) {
    fail('rollback package is not a snapshot of the authoritative n8n database')
  }
  if (values['--output'] !== join(dirname(values['--output']), 'upgrade-intent.json')) {
    fail('upgrade intent must use the fixed transition filename')
  }
  const intent = {
    schema: INTENT_SCHEMA,
    upgradeId: values['--upgrade-id'],
    uid: process.getuid(),
    createdAt: nowSeconds(),
    database,
    rollback,
    runtime,
    target: { commit: values['--target-commit'], workflows: runtime.workflows, application },
    actions: ACTIONS,
    confirmationPolicy: {
      required: true,
      capabilityTtlSeconds: CONFIRMATION_TTL_SECONDS,
      tokenDigest: 'sha256',
      tokenProvision: 'external-current-confirm-only',
    },
  }
  const written = writeImmutable(values['--output'], intent)
  process.stdout.write(`${JSON.stringify({ schema: INTENT_SCHEMA, upgradeId: intent.upgradeId, intent: written.reference })}\n`)
}

function readToken(pathname) {
  const reference = fileSnapshot(pathname, 'confirmation token file', 0o400)
  const token = readFileSync(pathname, 'utf8').trim()
  if (!SHA256.test(token)) fail('confirmation token file must contain one externally supplied 64-hex token')
  return { reference, tokenSha256: sha256(token) }
}

function validateConfirmation(pathname, intentLoaded, allowExpired = false) {
  const loaded = readJsonFile(pathname, 'current confirmation', 0o400)
  const value = loaded.value
  exactKeys(value, ['confirmedAt', 'expiresAt', 'intent', 'receiptId', 'schema', 'tokenSha256', 'uid', 'upgradeId'], 'current confirmation')
  if (value.schema !== CONFIRMATION_SCHEMA || value.upgradeId !== intentLoaded.value.upgradeId
    || !UUID.test(value.receiptId) || value.uid !== process.getuid() || !SHA256.test(value.tokenSha256)
    || canonicalJson(value.intent) !== canonicalJson(intentLoaded.reference)
    || value.expiresAt !== value.confirmedAt + CONFIRMATION_TTL_SECONDS) fail('current confirmation identity is invalid')
  const now = nowSeconds()
  if (!allowExpired && (value.confirmedAt > now + 5 || value.expiresAt < now)) fail('current confirmation capability expired')
  return loaded
}

function currentConfirm(values) {
  const intent = validateIntent(values['--intent'])
  if (!UUID.test(values['--confirmation-receipt-id'])) fail('--confirmation-receipt-id must be one UUID')
  const token = readToken(values['--confirmation-token-file'])
  const transitionDirectory = dirname(intent.reference.path)
  if (dirname(values['--confirmation-token-file']) !== transitionDirectory
    || values['--confirmation-output'] !== join(transitionDirectory, 'current-confirmation.json')
    || values['--capability-output'] !== join(transitionDirectory, 'import-capability.json')) {
    fail('confirmation artifacts must use the fixed transition paths')
  }
  const confirmedAt = nowSeconds()
  const receipt = {
    schema: CONFIRMATION_SCHEMA,
    upgradeId: intent.value.upgradeId,
    receiptId: values['--confirmation-receipt-id'],
    uid: process.getuid(),
    confirmedAt,
    expiresAt: confirmedAt + CONFIRMATION_TTL_SECONDS,
    intent: intent.reference,
    tokenSha256: token.tokenSha256,
  }
  const confirmation = writeImmutable(values['--confirmation-output'], receipt)
  const capability = {
    schema: CAPABILITY_SCHEMA,
    upgradeId: intent.value.upgradeId,
    uid: process.getuid(),
    issuedAt: confirmedAt,
    expiresAt: receipt.expiresAt,
    intent: intent.reference,
    confirmation: confirmation.reference,
    token: token.reference,
    tokenSha256: token.tokenSha256,
    action: 'claim-managed-workflow-import',
  }
  const capabilityWritten = writeImmutable(values['--capability-output'], capability)
  process.stdout.write(`${JSON.stringify({ schema: CONFIRMATION_SCHEMA, confirmation: confirmation.reference, capability: capabilityWritten.reference, expiresAt: receipt.expiresAt })}\n`)
}

function eventFiles(journalDir) {
  const members = readdirSync(journalDir)
  const events = members.filter(name => /^\d{6}-[A-Za-z0-9_-]+\.json$/u.test(name)).sort()
  const allowed = new Set(['capability.consumed.json', ...events])
  if (members.some(name => !allowed.has(name))) fail('upgrade journal contains an unknown member')
  return events
}

function readJournal(journalDir, intent, confirmation) {
  safeDirectory(journalDir, 'upgrade journal', 0o700)
  const files = eventFiles(journalDir)
  const events = []
  let previous = '0'.repeat(64)
  for (const [index, name] of files.entries()) {
    const loaded = readJsonFile(join(journalDir, name), `journal event ${name}`, 0o400)
    const event = loaded.value
    exactKeys(event, ['at', 'confirmationSha256', 'index', 'intentSha256', 'payload', 'previousSha256', 'schema', 'state', 'tokenSha256', 'uid', 'upgradeId'], `journal event ${name}`)
    if (event.schema !== JOURNAL_SCHEMA || event.index !== index + 1 || event.previousSha256 !== previous
      || event.upgradeId !== intent.value.upgradeId || event.uid !== process.getuid()
      || event.intentSha256 !== intent.reference.sha256 || event.confirmationSha256 !== confirmation.reference.sha256
      || event.tokenSha256 !== confirmation.value.tokenSha256 || !Number.isSafeInteger(event.at)) fail(`journal event ${name} chain is invalid`)
    previous = loaded.reference.sha256
    events.push({ ...event, file: loaded.reference })
  }
  return { events, headSha256: previous }
}

function expectedNextState(events) {
  const sequence = ['CLAIMED', 'MUTATING', `WORKFLOW_${WORKFLOWS[0].id}`, `WORKFLOW_${WORKFLOWS[1].id}`, 'VERIFIED', 'COMMITTED']
  for (let index = 0; index < events.length; index += 1) {
    if (events[index].state !== sequence[index]) fail('upgrade journal state sequence is invalid')
  }
  return sequence[events.length] ?? null
}

function appendEvent(journalDir, journal, intent, confirmation, state, payload) {
  if (expectedNextState(journal.events) !== state) fail(`journal cannot append state ${state}`)
  const index = journal.events.length + 1
  const safeState = state.replace(/[^A-Za-z0-9_-]/gu, '_')
  const event = {
    schema: JOURNAL_SCHEMA,
    index,
    state,
    at: nowSeconds(),
    upgradeId: intent.value.upgradeId,
    uid: process.getuid(),
    intentSha256: intent.reference.sha256,
    confirmationSha256: confirmation.reference.sha256,
    tokenSha256: confirmation.value.tokenSha256,
    previousSha256: journal.headSha256,
    payload,
  }
  return writeImmutable(join(journalDir, `${String(index).padStart(6, '0')}-${safeState}.json`), event)
}

function validateCapability(pathname, intent, confirmation, token) {
  const loaded = readJsonFile(pathname, 'import capability', 0o400)
  validateCapabilityValue(loaded.value, intent, confirmation)
  if (loaded.value.tokenSha256 !== token.tokenSha256
    || canonicalJson(loaded.value.token) !== canonicalJson(token.reference)) fail('import capability token identity is invalid')
  return loaded
}

function validateCapabilityValue(value, intent, confirmation) {
  exactKeys(value, ['action', 'confirmation', 'expiresAt', 'intent', 'issuedAt', 'schema', 'token', 'tokenSha256', 'uid', 'upgradeId'], 'import capability')
  if (value.schema !== CAPABILITY_SCHEMA || value.action !== 'claim-managed-workflow-import'
    || value.upgradeId !== intent.value.upgradeId || value.uid !== process.getuid()
    || canonicalJson(value.intent) !== canonicalJson(intent.reference)
    || canonicalJson(value.confirmation) !== canonicalJson(confirmation.reference)
    || value.tokenSha256 !== confirmation.value.tokenSha256
    || value.expiresAt !== confirmation.value.expiresAt || value.issuedAt !== confirmation.value.confirmedAt) fail('import capability identity is invalid')
}

function context(values, allowExpired = true) {
  const intent = validateIntent(values['--intent'], true)
  const confirmation = validateConfirmation(values['--confirmation'], intent, allowExpired)
  if (values['--journal-dir'] !== join(dirname(intent.reference.path), 'journal')) {
    fail('upgrade journal must use the fixed transition path')
  }
  const journal = readJournal(values['--journal-dir'], intent, confirmation)
  expectedNextState(journal.events)
  return { intent, confirmation, journal }
}

function testFailpoint(name) {
  if (process.env.NODE_ENV === 'test' && process.env.AIWORKER_TEST_TRANSITION_FAILPOINT === name) {
    fail(`test failpoint ${name}`)
  }
}

function lsofNoMatches(args, label) {
  const result = spawnSync('/usr/sbin/lsof', args, { encoding: 'utf8' })
  if (result.error || result.status === null || ![0, 1].includes(result.status)) {
    fail(`${label} query failed`)
  }
  if (result.status === 0 || result.stdout.trim()) fail(`${label} is still open or listening`)
}

function assertOfflineIdentity(intent) {
  const database = intent.value.database[0]
  const current = fileSnapshot(database.path, 'authoritative n8n database')
  for (const field of ['path', 'dev', 'ino', 'uid', 'nlink']) {
    if (current[field] !== database[field]) fail('authoritative n8n database identity changed')
  }
  const databasePaths = [database.path]
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (existsSync(`${database.path}${suffix}`)) databasePaths.push(`${database.path}${suffix}`)
  }
  lsofNoMatches(['-nP', '-t', '--', ...databasePaths], 'authoritative n8n database family')
  lsofNoMatches(['-nP', '-t', '-iTCP:5678', '-sTCP:LISTEN'], 'n8n port 5678')
  const launchTarget = `gui/${process.getuid()}/com.video-autoworker.n8n`
  const launch = spawnSync('/bin/launchctl', ['print', launchTarget], { encoding: 'utf8' })
  if (launch.error || launch.status === null) fail('n8n LaunchAgent query failed')
  if (launch.status === 0) fail('managed n8n LaunchAgent is still loaded')
  return {
    checkedAt: nowSeconds(),
    database: { path: current.path, dev: current.dev, ino: current.ino },
    port: 5678,
    launchTarget,
    state: 'offline',
  }
}

function claimImport(values) {
  const resuming = existsSync(values['--journal-dir'])
  const intent = validateIntent(values['--intent'], resuming)
  const confirmation = validateConfirmation(values['--confirmation'], intent, resuming)
  const offline = assertOfflineIdentity(intent)
  if (resuming) {
    let journal = readJournal(values['--journal-dir'], intent, confirmation)
    const consumedPath = join(values['--journal-dir'], 'capability.consumed.json')
    if (!existsSync(consumedPath)) {
      if (journal.events.length !== 0) fail('upgrade journal has events without a consumed capability')
      const token = readToken(values['--confirmation-token-file'])
      const capability = validateCapability(values['--capability'], intent, confirmation, token)
      renameDurable(values['--capability'], consumedPath, 'import capability consumption')
      const moved = fileSnapshot(consumedPath, 'consumed import capability', 0o400)
      if (capability.reference.dev !== moved.dev || capability.reference.ino !== moved.ino
        || capability.reference.sha256 !== moved.sha256) fail('capability identity changed while its claim was recovered')
    }
    const consumed = readJsonFile(consumedPath, 'consumed import capability', 0o400)
    validateCapabilityValue(consumed.value, intent, confirmation)
    if (existsSync(values['--capability'])) fail('claimed workflow transition retained its original capability')
    if (journal.events.length === 0) {
      const event = appendEvent(values['--journal-dir'], journal, intent, confirmation, 'CLAIMED', {
        capability: consumed.reference,
        claimedDatabase: intent.value.database,
        actions: ACTIONS,
      })
      journal = readJournal(values['--journal-dir'], intent, confirmation)
      if (journal.events[0]?.file.sha256 !== event.reference.sha256) fail('recovered claim event changed')
    }
    if (journal.events.some(event => event.state === 'COMMITTED')) fail('committed workflow transition cannot be replayed')
    if (journal.events[0]?.payload?.capability?.dev !== consumed.reference.dev
      || journal.events[0]?.payload?.capability?.ino !== consumed.reference.ino
      || journal.events[0]?.payload?.capability?.sha256 !== consumed.reference.sha256) {
      fail('claimed capability does not match the journal')
    }
    if (existsSync(values['--confirmation-token-file'])) {
      const token = readToken(values['--confirmation-token-file'])
      if (token.tokenSha256 !== consumed.value.tokenSha256
        || canonicalJson(token.reference) !== canonicalJson(consumed.value.token)) {
        fail('retained confirmation token does not match the consumed capability')
      }
      unlinkDurable(values['--confirmation-token-file'], token.reference, 'confirmation token')
    }
    process.stdout.write(`${JSON.stringify({ schema: JOURNAL_SCHEMA, resumed: true, nextState: expectedNextState(journal.events), headSha256: journal.headSha256, offline })}\n`)
    return
  }
  const token = readToken(values['--confirmation-token-file'])
  const capability = validateCapability(values['--capability'], intent, confirmation, token)
  safeDirectory(dirname(values['--journal-dir']), 'journal parent', 0o700)
  if (statSync(dirname(values['--journal-dir']), { bigint: true }).dev !== statSync(dirname(values['--capability']), { bigint: true }).dev) {
    fail('capability and journal must use one filesystem for atomic consumption')
  }
  createDirectoryDurable(values['--journal-dir'], 'upgrade journal')
  testFailpoint('after-journal-mkdir')
  const consumed = join(values['--journal-dir'], 'capability.consumed.json')
  renameDurable(values['--capability'], consumed, 'import capability consumption')
  testFailpoint('after-capability-consumed')
  const consumedReference = fileSnapshot(consumed, 'consumed import capability', 0o400)
  if (capability.reference.dev !== consumedReference.dev || capability.reference.ino !== consumedReference.ino
    || capability.reference.sha256 !== consumedReference.sha256) fail('capability identity changed while it was consumed')
  const journal = { events: [], headSha256: '0'.repeat(64) }
  const event = appendEvent(values['--journal-dir'], journal, intent, confirmation, 'CLAIMED', {
    capability: consumedReference,
    claimedDatabase: intent.value.database,
    actions: ACTIONS,
  })
  unlinkDurable(values['--confirmation-token-file'], token.reference, 'confirmation token')
  process.stdout.write(`${JSON.stringify({ schema: JOURNAL_SCHEMA, resumed: false, state: 'CLAIMED', event: event.reference })}\n`)
}

function beginMutation(values) {
  const state = context(values)
  const next = expectedNextState(state.journal.events)
  if (next === 'MUTATING') validateConfirmation(values['--confirmation'], state.intent, false)
  const offline = assertOfflineIdentity(state.intent)
  if (next !== 'MUTATING') {
    if (state.journal.events.some(event => event.state === 'MUTATING') && next !== null && next !== 'COMMITTED') {
      process.stdout.write(`${JSON.stringify({ schema: JOURNAL_SCHEMA, resumed: true, nextState: next, offline })}\n`)
      return
    }
    fail('workflow transition cannot begin mutation in its current state')
  }
  const event = appendEvent(values['--journal-dir'], state.journal, state.intent, state.confirmation, 'MUTATING', { actions: ACTIONS })
  process.stdout.write(`${JSON.stringify({ schema: JOURNAL_SCHEMA, state: 'MUTATING', event: event.reference })}\n`)
}

function assertOfflineCommand(values) {
  const state = context(values)
  if (!state.journal.events.some(event => event.state === 'MUTATING')) fail('workflow mutation has not begun')
  const offline = assertOfflineIdentity(state.intent)
  process.stdout.write(`${JSON.stringify(offline)}\n`)
}

function assertTooling(values) {
  const intent = validateIntent(values['--intent'])
  const importer = fileSnapshot(values['--importer'], 'running workflow importer')
  const producer = fileSnapshot(realpathSync(process.argv[1]), 'running transition anchor')
  if (canonicalJson(importer) !== canonicalJson(intent.value.runtime.tooling.importer)
    || canonicalJson(producer) !== canonicalJson(intent.value.runtime.tooling.transitionAnchor)) {
    fail('running importer or transition anchor does not match the confirmed target runtime')
  }
  process.stdout.write(`${JSON.stringify({ importerSha256: importer.sha256, transitionAnchorSha256: producer.sha256 })}\n`)
}

function workflowDescriptor(id) {
  const descriptor = WORKFLOWS.find(item => item.id === id)
  if (!descriptor) fail('--id is not one managed workflow ID')
  return descriptor
}

function workflowStatus(values) {
  workflowDescriptor(values['--id'])
  const state = context(values)
  if (!state.journal.events.some(event => event.state === 'MUTATING')) fail('workflow mutation has not been claimed')
  const complete = state.journal.events.some(event => event.state === `WORKFLOW_${values['--id']}`)
  process.stdout.write(`${JSON.stringify({ id: values['--id'], complete })}\n`)
}

function verifyTarget(values) {
  workflowDescriptor(values['--id'])
  const state = context(values)
  if (!state.journal.events.some(event => event.state === 'MUTATING')) fail('workflow mutation has not been claimed')
  const runtime = validateRuntime(state.intent.value.runtime.root.path, state.intent.value.target.commit)
  if (canonicalJson(runtime) !== canonicalJson(state.intent.value.runtime)) fail('target runtime changed during workflow import')
  const workflow = runtime.workflows.find(item => item.id === values['--id'])
  process.stdout.write(`${JSON.stringify({ id: workflow.id, path: workflow.source.path, sourceSha256: workflow.sourceSha256 })}\n`)
}

function recordWorkflow(values) {
  workflowDescriptor(values['--id'])
  const state = context(values)
  const expected = expectedNextState(state.journal.events)
  const eventState = `WORKFLOW_${values['--id']}`
  if (state.journal.events.some(event => event.state === eventState)) {
    process.stdout.write(`${JSON.stringify({ schema: JOURNAL_SCHEMA, id: values['--id'], resumed: true })}\n`)
    return
  }
  if (expected !== eventState) fail(`workflow ${values['--id']} is out of journal order`)
  const runtime = validateRuntime(state.intent.value.runtime.root.path, state.intent.value.target.commit)
  const workflow = runtime.workflows.find(item => item.id === values['--id'])
  const event = appendEvent(values['--journal-dir'], state.journal, state.intent, state.confirmation, eventState, {
    id: workflow.id,
    source: workflow.source,
    sourceSha256: workflow.sourceSha256,
    semanticSha256: workflow.semanticSha256,
  })
  process.stdout.write(`${JSON.stringify({ schema: JOURNAL_SCHEMA, id: workflow.id, event: event.reference })}\n`)
}

function validateLiveReport(pathname, intent) {
  const loaded = readJsonFile(pathname, 'live workflow verification report', 0o400)
  const report = loaded.value
  exactKeys(report, ['combinedSha256', 'databasePath', 'protocol', 'runtimeIdentitySha256', 'schema', 'sourceCommit', 'workflows'], 'live workflow verification report')
  if (report.schema !== LIVE_REPORT_SCHEMA || report.protocol !== PROTOCOL
    || report.sourceCommit !== intent.value.target.commit || report.databasePath !== intent.value.database[0].path
    || !SHA256.test(report.runtimeIdentitySha256) || !SHA256.test(report.combinedSha256)
    || !Array.isArray(report.workflows) || report.workflows.length !== WORKFLOWS.length) fail('live workflow verification report identity is invalid')
  const workflows = WORKFLOWS.map(descriptor => {
    const item = report.workflows.find(candidate => candidate?.id === descriptor.id)
    exactKeys(item, ['id', 'publishedVersionId', 'sha256', 'sourceSha256', 'sourceVersionId'], `live workflow ${descriptor.id}`)
    const target = intent.value.target.workflows.find(candidate => candidate.id === descriptor.id)
    if (item.sourceSha256 !== target.sourceSha256 || !SHA256.test(item.sha256)
      || typeof item.publishedVersionId !== 'string' || typeof item.sourceVersionId !== 'string') fail(`live workflow ${descriptor.id} is invalid`)
    return { ...item }
  })
  const combined = sha256([
    report.sourceCommit,
    report.runtimeIdentitySha256,
    ...workflows.map(item => [item.id, item.sourceVersionId, item.sourceSha256, item.publishedVersionId, item.sha256].join(':')),
  ].join('\n'))
  if (combined !== report.combinedSha256) fail('live workflow report combined digest is invalid')
  return { loaded, report, workflows }
}

function attestTransition(values) {
  let state = context(values)
  let next = expectedNextState(state.journal.events)
  const wasResumed = next !== 'VERIFIED'
  if (!['VERIFIED', 'COMMITTED', null].includes(next)) fail('all managed workflow journal events are required before attestation')
  const expectedOutput = join(dirname(state.intent.reference.path), 'transition-attestation.json')
  if (values['--output'] !== expectedOutput) fail('transition attestation must use the fixed transition path')
  const live = validateLiveReport(values['--live-report'], state.intent)
  const runtime = validateRuntime(state.intent.value.runtime.root.path, state.intent.value.target.commit)
  if (canonicalJson(runtime) !== canonicalJson(state.intent.value.runtime)) fail('target runtime changed before attestation')
  const application = validateApplicationRelease(
    state.intent.value.target.application.releaseRoot.path,
    state.intent.value.target.application.slot,
    state.intent.value.target.application.releaseId,
    state.intent.value.target.commit,
  )
  if (canonicalJson(application) !== canonicalJson(state.intent.value.target.application)) {
    fail('target application release changed before attestation')
  }
  const verifier = fileSnapshot(values['--verifier'], 'workflow verifier')
  const producer = fileSnapshot(realpathSync(process.argv[1]), 'transition producer')
  const verifiedPayload = {
    liveReport: live.loaded.reference,
    liveCombinedSha256: live.report.combinedSha256,
    workflows: live.workflows.map(item => ({ id: item.id, liveSha256: item.sha256, publishedVersionId: item.publishedVersionId })),
  }
  if (next === 'VERIFIED') {
    appendEvent(values['--journal-dir'], state.journal, state.intent, state.confirmation, 'VERIFIED', verifiedPayload)
    testFailpoint('after-verified')
    state = context(values)
    next = expectedNextState(state.journal.events)
  }
  const verifiedEvent = state.journal.events.find(event => event.state === 'VERIFIED')
  if (!verifiedEvent || canonicalJson(verifiedEvent.payload) !== canonicalJson(verifiedPayload)) {
    fail('verified journal event does not match the requested live report')
  }
  const attestation = {
    schema: ATTESTATION_SCHEMA,
    upgradeId: state.intent.value.upgradeId,
    uid: process.getuid(),
    createdAt: nowSeconds(),
    intent: state.intent.reference,
    confirmation: state.confirmation.reference,
    confirmationTokenSha256: state.confirmation.value.tokenSha256,
    journal: { directory: safeDirectory(values['--journal-dir'], 'upgrade journal', 0o700), completedThrough: 'VERIFIED', headSha256: verifiedEvent.file.sha256 },
    rollback: state.intent.value.rollback,
    deployed: {
      report: live.loaded.reference,
      runtimeIdentitySha256: live.report.runtimeIdentitySha256,
      combinedSha256: live.report.combinedSha256,
      workflows: live.workflows.map(item => ({ id: item.id, publishedVersionId: item.publishedVersionId, liveSha256: item.sha256, sourceSha256: item.sourceSha256 })),
    },
    targetApplicationRelease: application,
    n8n: {
      release: runtime.root,
      sourceCommit: state.intent.value.target.commit,
      sourceManifest: runtime.sourceManifest,
      runtimeSourceManifest: runtime.runtimeSourceManifest,
      version: runtime.n8nVersion,
    },
    producer: { path: producer.path, sha256: producer.sha256 },
    verifier: { path: verifier.path, sha256: verifier.sha256 },
  }
  let written
  if (existsSync(values['--output'])) {
    const loaded = readJsonFile(values['--output'], 'transition attestation', 0o400)
    const { createdAt, ...storedIdentity } = loaded.value
    const { createdAt: expectedCreatedAt, ...expectedIdentity } = attestation
    if (!Number.isSafeInteger(createdAt) || createdAt <= 0 || createdAt > nowSeconds() + 5
      || !Number.isSafeInteger(expectedCreatedAt)
      || canonicalJson(storedIdentity) !== canonicalJson(expectedIdentity)) {
      fail('existing transition attestation does not match the verified transition')
    }
    written = loaded
  } else {
    written = writeImmutable(values['--output'], attestation)
    testFailpoint('after-attestation')
  }
  if (next === 'COMMITTED') {
    appendEvent(values['--journal-dir'], state.journal, state.intent, state.confirmation, 'COMMITTED', { attestation: written.reference })
  } else if (next === null) {
    const committed = state.journal.events.at(-1)
    if (committed?.payload?.attestation?.path !== written.reference.path
      || committed?.payload?.attestation?.sha256 !== written.reference.sha256) {
      fail('committed journal references a different transition attestation')
    }
  } else {
    fail('transition attestation cannot commit from its current journal state')
  }
  process.stdout.write(`${JSON.stringify({ schema: ATTESTATION_SCHEMA, attestation: written.reference, verifiedEvent: verifiedEvent.file, resumed: wasResumed })}\n`)
}

function verifyTransition(values, quiet = false) {
  const state = context(values)
  if (expectedNextState(state.journal.events) !== null || state.journal.events.at(-1)?.state !== 'COMMITTED') fail('workflow transition journal is not committed')
  const loaded = readJsonFile(values['--attestation'], 'transition attestation', 0o400)
  const attestation = loaded.value
  exactKeys(attestation, ['confirmation', 'confirmationTokenSha256', 'createdAt', 'deployed', 'intent', 'journal', 'n8n', 'producer', 'rollback', 'schema', 'targetApplicationRelease', 'uid', 'upgradeId', 'verifier'], 'transition attestation')
  exactKeys(attestation.deployed, ['combinedSha256', 'report', 'runtimeIdentitySha256', 'workflows'], 'attested deployment')
  exactKeys(attestation.journal, ['completedThrough', 'directory', 'headSha256'], 'attested journal')
  exactKeys(attestation.n8n, ['release', 'runtimeSourceManifest', 'sourceCommit', 'sourceManifest', 'version'], 'attested n8n runtime')
  exactKeys(attestation.targetApplicationRelease, ['manifest', 'releaseId', 'releaseRoot', 'slot'], 'attested application release')
  exactKeys(attestation.producer, ['path', 'sha256'], 'attested producer')
  exactKeys(attestation.verifier, ['path', 'sha256'], 'attested verifier')
  if (attestation.schema !== ATTESTATION_SCHEMA || attestation.upgradeId !== state.intent.value.upgradeId
    || attestation.uid !== process.getuid() || attestation.confirmationTokenSha256 !== state.confirmation.value.tokenSha256
    || canonicalJson(attestation.intent) !== canonicalJson(state.intent.reference)
    || canonicalJson(attestation.confirmation) !== canonicalJson(state.confirmation.reference)
    || canonicalJson(attestation.rollback) !== canonicalJson(state.intent.value.rollback)) fail('transition attestation identity is invalid')
  const application = validateApplicationRelease(
    attestation.targetApplicationRelease.releaseRoot.path,
    attestation.targetApplicationRelease.slot,
    attestation.targetApplicationRelease.releaseId,
    state.intent.value.target.commit,
  )
  if (canonicalJson(application) !== canonicalJson(attestation.targetApplicationRelease)
    || canonicalJson(application) !== canonicalJson(state.intent.value.target.application)) {
    fail('attested target application release changed')
  }
  if (fileSnapshot(attestation.producer.path, 'transition producer').sha256 !== attestation.producer.sha256
    || fileSnapshot(attestation.verifier.path, 'workflow verifier').sha256 !== attestation.verifier.sha256) fail('transition producer or verifier changed')
  const live = validateLiveReport(attestation.deployed.report.path, state.intent)
  sameReference(live.loaded.reference, attestation.deployed.report, 'deployed workflow report')
  const expectedDeployed = {
    report: live.loaded.reference,
    runtimeIdentitySha256: live.report.runtimeIdentitySha256,
    combinedSha256: live.report.combinedSha256,
    workflows: live.workflows.map(item => ({
      id: item.id,
      publishedVersionId: item.publishedVersionId,
      liveSha256: item.sha256,
      sourceSha256: item.sourceSha256,
    })),
  }
  if (canonicalJson(attestation.deployed) !== canonicalJson(expectedDeployed)) fail('attested deployed workflow identity changed')
  const runtime = validateRuntime(state.intent.value.runtime.root.path, state.intent.value.target.commit)
  if (canonicalJson(runtime.root) !== canonicalJson(attestation.n8n.release)
    || canonicalJson(runtime.sourceManifest) !== canonicalJson(attestation.n8n.sourceManifest)
    || canonicalJson(runtime.runtimeSourceManifest) !== canonicalJson(attestation.n8n.runtimeSourceManifest)
    || runtime.n8nVersion !== attestation.n8n.version || attestation.n8n.sourceCommit !== state.intent.value.target.commit) fail('attested n8n runtime changed')
  const committed = state.journal.events.at(-1)
  if (committed.payload?.attestation?.path !== loaded.reference.path
    || committed.payload?.attestation?.sha256 !== loaded.reference.sha256
    || canonicalJson(attestation.journal.directory) !== canonicalJson(safeDirectory(values['--journal-dir'], 'upgrade journal', 0o700))
    || attestation.journal.headSha256 !== committed.previousSha256
    || attestation.journal.completedThrough !== 'VERIFIED') fail('transition attestation is not the committed journal anchor')
  const result = { schema: ATTESTATION_SCHEMA, upgradeId: attestation.upgradeId, committed: true, liveCombinedSha256: live.report.combinedSha256, attestationSha256: loaded.reference.sha256 }
  if (!quiet) process.stdout.write(`${JSON.stringify(result)}\n`)
  return { result, state, attestation: loaded, live }
}

function claimBootstrap(values) {
  const transition = verifyTransition(values, true)
  if (!['blue', 'green'].includes(values['--slot'])) fail('--slot must be blue or green')
  if (values['--release-id'] !== `${transition.state.intent.value.target.commit}-runtime`) {
    fail('--release-id must match the transition target commit')
  }
  if (!SHA256.test(values['--manifest-sha256'])) fail('--manifest-sha256 is invalid')
  absolutePath(values['--prepare-path'], '--prepare-path')
  noSymlink(values['--release-root'], 'bootstrap target release')
  if (realpathSync(values['--release-root']) !== values['--release-root']) fail('bootstrap target release root is not physical')
  const expectedManifestPath = join(values['--release-root'], 'release-manifest.json')
  const application = transition.attestation.value.targetApplicationRelease
  if (values['--slot'] !== application.slot || values['--release-id'] !== application.releaseId
    || values['--release-root'] !== application.releaseRoot.path
    || application.manifest.path !== expectedManifestPath
    || application.manifest.sha256 !== values['--manifest-sha256']) {
    fail('bootstrap target does not match the attested application release')
  }
  const transitionDirectory = dirname(transition.state.intent.reference.path)
  safeDirectory(transitionDirectory, 'workflow transition directory', 0o700)
  const expectedOutput = join(transitionDirectory, 'bootstrap-claim.json')
  if (values['--output'] !== expectedOutput) fail('bootstrap claim output must use the fixed transition sidecar path')
  if (existsSync(values['--output'])) {
    if (existsSync(values['--prepare-path'])) {
      fileSnapshot(values['--prepare-path'], 'existing bootstrap prepare receipt', 0o400)
    } else {
      noSymlink(values['--prepare-path'], 'future bootstrap prepare receipt', true)
    }
  } else {
    noSymlink(values['--prepare-path'], 'future bootstrap prepare receipt', true)
  }
  const requested = {
    preparePath: values['--prepare-path'],
    database: transition.state.intent.value.database[0],
    target: {
      slot: values['--slot'],
      releaseId: values['--release-id'],
      releaseRoot: values['--release-root'],
      manifestSha256: values['--manifest-sha256'],
    },
  }
  if (existsSync(values['--output'])) {
    const existing = readJsonFile(values['--output'], 'bootstrap transition claim', 0o400)
    exactKeys(existing.value, ['bootstrap', 'claimedAt', 'schema', 'transition', 'uid', 'upgradeId'], 'bootstrap transition claim')
    if (existing.value.schema !== BOOTSTRAP_CLAIM_SCHEMA
      || existing.value.upgradeId !== transition.state.intent.value.upgradeId
      || existing.value.uid !== process.getuid()
      || !UUID.test(existing.value.bootstrap?.attemptId)
      || canonicalJson(existing.value.bootstrap?.request) !== canonicalJson(requested)
      || existing.value.transition?.attestation?.sha256 !== transition.attestation.reference.sha256
      || existing.value.transition?.committedJournalHeadSha256 !== transition.state.journal.headSha256
      || existing.value.transition?.liveCombinedSha256 !== transition.live.report.combinedSha256) {
      fail('workflow transition was already claimed by a different bootstrap request')
    }
    process.stdout.write(`${JSON.stringify({ schema: BOOTSTRAP_CLAIM_SCHEMA, claim: existing.reference, bootstrapAttemptId: existing.value.bootstrap.attemptId, resumed: true })}\n`)
    return
  }
  const claim = {
    schema: BOOTSTRAP_CLAIM_SCHEMA,
    upgradeId: transition.state.intent.value.upgradeId,
    uid: process.getuid(),
    claimedAt: nowSeconds(),
    transition: {
      attestation: transition.attestation.reference,
      committedJournalHeadSha256: transition.state.journal.headSha256,
      liveCombinedSha256: transition.live.report.combinedSha256,
    },
    bootstrap: {
      attemptId: randomUUID(),
      request: requested,
    },
  }
  const written = writeImmutable(values['--output'], claim)
  process.stdout.write(`${JSON.stringify({ schema: BOOTSTRAP_CLAIM_SCHEMA, claim: written.reference, bootstrapAttemptId: claim.bootstrap.attemptId, resumed: false })}\n`)
}

try {
  const { command, values } = parseArguments(process.argv.slice(2))
  if (command === 'prepare-intent') prepareIntent(values)
  else if (command === 'current-confirm') currentConfirm(values)
  else if (command === 'claim-import') claimImport(values)
  else if (command === 'begin-mutation') beginMutation(values)
  else if (command === 'workflow-status') workflowStatus(values)
  else if (command === 'verify-target') verifyTarget(values)
  else if (command === 'record-workflow') recordWorkflow(values)
  else if (command === 'attest-transition') attestTransition(values)
  else if (command === 'verify-transition') verifyTransition(values)
  else if (command === 'claim-bootstrap') claimBootstrap(values)
  else if (command === 'assert-offline') assertOfflineCommand(values)
  else assertTooling(values)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'n8n workflow transition anchor failed'}\n`)
  process.exit(1)
}
