#!/usr/bin/env node

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  projectOfflineQueue,
  scanOfflineDurableBatchStates,
} from './lib/runtime-safe-offline-queue.mjs'

export { projectOfflineQueue, scanOfflineDurableBatchStates }

const PREPARE_SCHEMA = 'video-autoworker-legacy-bootstrap-prepare/v1'
const CONFIRM_SCHEMA = 'video-autoworker-legacy-bootstrap-current-confirm/v1'
const TOKEN_SCHEMA = 'video-autoworker-legacy-bootstrap-capability/v1'
const SHUTDOWN_SCHEMA = 'video-autoworker-legacy-bootstrap-shutdown-requested/v1'
const N8N_RESTORE_SCHEMA = 'video-autoworker-n8n-managed-workflow-restore-confirmation/v2'
const N8N_DISASTER_SCHEMA = 'video-autoworker-n8n-managed-workflow-disaster-recovery-confirmation/v1'
const RESUME_SCHEMA = 'video-autoworker-legacy-bootstrap-resume-authorization/v1'
const RESUME_TOKEN_SCHEMA = 'video-autoworker-legacy-bootstrap-resume-capability/v2'
const RESUME_CONSUMED_SCHEMA = 'video-autoworker-legacy-bootstrap-resume-consumed/v1'
const RECOVERY_BRANCH_SCHEMA = 'video-autoworker-legacy-bootstrap-recovery-branch/v2'
const EVIDENCE_SCHEMA = 'video-autoworker-legacy-freeze-evidence/v3'
const PROOF_SCHEMA = 'video-autoworker-legacy-bootstrap-rollback-proof/v2'
const GUARD_SCHEMA = 'video-autoworker-legacy-freeze-guard/v1'
const MAX_JSON_BYTES = 1024 * 1024
const MAX_TOKEN_BYTES = 16 * 1024
const PREPARE_TTL_SECONDS = 600
const CONFIRM_TTL_SECONDS = 120
const DISASTER_CLAIM_TTL_SECONDS = 120
const RESUME_TTL_SECONDS = 120
const MANAGED_N8N_VERSION = '2.31.6'
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u
const RECEIPTS = Object.freeze({
  prepare: 'prepare.receipt.json',
  confirm: 'current-confirm.receipt.json',
  token: 'current-confirm.token.json',
  shutdown: 'shutdown-requested.receipt.json',
  n8nRestore: 'n8n-restore-confirmation.receipt.json',
})
const scriptPath = realpathSync(fileURLToPath(import.meta.url))
const repositoryRoot = realpathSync(join(dirname(scriptPath), '..'))
const managedVerifierPath = join(repositoryRoot, 'scripts/generate-legacy-freeze-evidence.mjs')
const managedWorkflowVerifierPath = join(repositoryRoot, 'scripts/verify-n8n-blue-green-workflows.mjs')
const managedTransitionAnchorPath = join(repositoryRoot, 'scripts/n8n-workflow-transition-anchor.mjs')
const testMode = process.env.NODE_ENV === 'test'
  && process.env.AIWORKER_TEST_LEGACY_BOOTSTRAP === '1'

function fail(message) {
  throw new Error(`legacy bootstrap controller failed: ${message}`)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function currentTime() {
  if (process.env.NODE_ENV === 'test' && process.env.AIWORKER_TEST_LEGACY_BOOTSTRAP === '1') {
    const overridden = Number(process.env.AIWORKER_TEST_LEGACY_BOOTSTRAP_NOW)
    if (Number.isSafeInteger(overridden) && overridden > 0) return overridden
  }
  return Math.floor(Date.now() / 1000)
}

function strictJson(source, label, maximumBytes = MAX_JSON_BYTES) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > maximumBytes) fail(`${label} is too large`)
  let index = 0
  const whitespace = () => { while (/\s/u.test(source[index] || '')) index += 1 }
  const stringValue = () => {
    const start = index
    index += 1
    let escaped = false
    while (index < source.length) {
      const character = source[index]
      index += 1
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
    const character = source[index]
    if (character === '"') return stringValue()
    if (character === '{') {
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
        if (source[index] !== ':') fail(`${label} object separator is invalid`)
        index += 1
        output[key] = value()
        whitespace()
        if (source[index] === '}') { index += 1; return output }
        if (source[index] !== ',') fail(`${label} object delimiter is invalid`)
        index += 1
      }
      fail(`${label} object is unterminated`)
    }
    if (character === '[') {
      index += 1
      whitespace()
      const output = []
      if (source[index] === ']') { index += 1; return output }
      while (index < source.length) {
        output.push(value())
        whitespace()
        if (source[index] === ']') { index += 1; return output }
        if (source[index] !== ',') fail(`${label} array delimiter is invalid`)
        index += 1
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

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    fail(`${label} fields are invalid`)
  }
}

function assertAbsolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} must be one normalized absolute path`)
}

function assertNoSymlink(pathname, label) {
  assertAbsolute(pathname, label)
  const root = parse(pathname).root
  let current = root
  for (const part of relative(root, pathname).split('/').filter(Boolean)) {
    current = join(current, part)
    let entry
    try { entry = lstatSync(current, { bigint: true }) } catch { fail(`${label} path component is unavailable`) }
    if (entry.isSymbolicLink()) fail(`${label} path contains a symlink`)
  }
}

function safeEntry(pathname, label, kind, options = {}) {
  assertNoSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if (kind === 'file' && !entry.isFile()) fail(`${label} is not a regular file`)
  if (kind === 'directory' && !entry.isDirectory()) fail(`${label} is not a directory`)
  if (entry.uid !== BigInt(process.getuid())) fail(`${label} owner is invalid`)
  if (kind === 'file' && entry.nlink !== 1n) fail(`${label} link count is unsafe`)
  const mode = Number(entry.mode & 0o7777n)
  if (options.mode !== undefined ? mode !== options.mode : (mode & 0o022) !== 0) {
    fail(`${label} mode is unsafe`)
  }
  if (options.maximumBytes !== undefined && entry.size > BigInt(options.maximumBytes)) {
    fail(`${label} is too large`)
  }
  if (options.nonempty === true && entry.size === 0n) fail(`${label} is empty`)
  return entry
}

function fileReference(pathname, label, options = {}) {
  const entry = safeEntry(pathname, label, 'file', options)
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    size: Number(entry.size),
  }
}

function hashFileStable(pathname, label, options = {}) {
  const before = safeEntry(pathname, label, 'file', options)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size
      || opened.nlink !== 1n) fail(`${label} changed before hashing`)
    const digest = createHash('sha256')
    const block = Buffer.allocUnsafe(1024 * 1024)
    let position = 0n
    while (position < opened.size) {
      const length = readSync(descriptor, block, 0,
        Math.min(block.length, Number(opened.size - position)), Number(position))
      if (length <= 0) fail(`${label} short read`)
      digest.update(block.subarray(0, length))
      position += BigInt(length)
    }
    const afterFd = fstatSync(descriptor, { bigint: true })
    const afterPath = lstatSync(pathname, { bigint: true })
    if (afterFd.dev !== opened.dev || afterFd.ino !== opened.ino || afterFd.size !== opened.size
      || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino || afterPath.size !== opened.size
      || afterPath.nlink !== 1n) fail(`${label} changed while hashing`)
    return digest.digest('hex')
  } finally { closeSync(descriptor) }
}

function readJson(pathname, label, options = {}) {
  const maximumBytes = options.maximumBytes ?? MAX_JSON_BYTES
  const entry = safeEntry(pathname, label, 'file', {
    mode: options.mode,
    maximumBytes,
    nonempty: true,
  })
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size
      || opened.nlink !== 1n) fail(`${label} changed before open`)
    const source = readFileSync(descriptor, 'utf8')
    const after = lstatSync(pathname, { bigint: true })
    if (Buffer.byteLength(source) !== Number(opened.size) || after.dev !== opened.dev
      || after.ino !== opened.ino || after.size !== opened.size || after.nlink !== 1n) {
      fail(`${label} changed during read`)
    }
    return {
      value: strictJson(source, label, maximumBytes),
      source,
      reference: {
        path: pathname,
        dev: opened.dev.toString(),
        ino: opened.ino.toString(),
        size: Number(opened.size),
        sha256: sha256(source),
      },
    }
  } finally { closeSync(descriptor) }
}

function readText(pathname, label, options = {}) {
  const maximumBytes = options.maximumBytes ?? MAX_JSON_BYTES
  const entry = safeEntry(pathname, label, 'file', {
    mode: options.mode, maximumBytes, nonempty: true,
  })
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size
      || opened.nlink !== 1n) fail(`${label} changed before open`)
    const source = readFileSync(descriptor, 'utf8')
    const after = lstatSync(pathname, { bigint: true })
    if (Buffer.byteLength(source) !== Number(opened.size) || after.dev !== opened.dev
      || after.ino !== opened.ino || after.size !== opened.size || after.nlink !== 1n) {
      fail(`${label} changed during read`)
    }
    return source
  } finally { closeSync(descriptor) }
}

function verifyReference(reference, label, options = {}) {
  exactKeys(reference, ['dev', 'ino', 'path', 'sha256', 'size'], `${label} reference`)
  if (!/^\d+$/u.test(reference.dev) || !/^\d+$/u.test(reference.ino)
    || !Number.isSafeInteger(reference.size) || reference.size <= 0 || !SHA256.test(reference.sha256)) {
    fail(`${label} reference is invalid`)
  }
  const actual = fileReference(reference.path, label, {
    mode: options.mode,
    maximumBytes: options.maximumBytes,
    nonempty: true,
  })
  if (actual.dev !== reference.dev || actual.ino !== reference.ino || actual.size !== reference.size
    || hashFileStable(reference.path, label, options) !== reference.sha256) {
    fail(`${label} identity changed`)
  }
}

function directoryIdentity(pathname, label) {
  const entry = safeEntry(pathname, label, 'directory')
  const physical = realpathSync(pathname)
  if (physical !== pathname) fail(`${label} is not a physical path`)
  return { path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString() }
}

function validateDirectoryIdentity(value, label) {
  validateFileIdentity(value, label)
  const actual = directoryIdentity(value.path, label)
  if (canonicalJson(actual) !== canonicalJson(value)) fail(`${label} identity changed`)
  return value
}

function verifierPath() {
  const override = process.env.AIWORKER_TEST_LEGACY_BOOTSTRAP_VERIFIER
  if (override !== undefined) {
    if (!testMode) fail('live verifier override is forbidden outside the isolated test mode')
    assertAbsolute(override, 'test live verifier')
    return override
  }
  return managedVerifierPath
}

function assertManagedVerifierAtHead(pathname) {
  if (testMode && pathname !== managedVerifierPath) return
  if (pathname !== managedVerifierPath) fail('production live verifier path is not managed')
  let tracked
  let committed
  try {
    tracked = execFileSync('/usr/bin/git', [
      '-C', repositoryRoot, 'ls-files', '--error-unmatch', '--',
      'scripts/generate-legacy-freeze-evidence.mjs',
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 }).trim()
    committed = execFileSync('/usr/bin/git', [
      '-C', repositoryRoot, 'show', 'HEAD:scripts/generate-legacy-freeze-evidence.mjs',
    ], { maxBuffer: MAX_JSON_BYTES })
  } catch {
    fail('managed live verifier is not tracked at HEAD')
  }
  if (tracked !== 'scripts/generate-legacy-freeze-evidence.mjs'
    || sha256(committed) !== hashFileStable(pathname, 'managed live verifier', { maximumBytes: MAX_JSON_BYTES })) {
    fail('managed live verifier differs from HEAD')
  }
}

function captureVerifierReference() {
  const pathname = verifierPath()
  safeEntry(pathname, 'live verifier', 'file', { maximumBytes: MAX_JSON_BYTES, nonempty: true })
  assertManagedVerifierAtHead(pathname)
  const reference = fileReference(pathname, 'live verifier', { maximumBytes: MAX_JSON_BYTES, nonempty: true })
  return { ...reference, sha256: hashFileStable(pathname, 'live verifier', { maximumBytes: MAX_JSON_BYTES }) }
}

function assertManagedTransitionAnchorAtHead(pathname) {
  const override = process.env.AIWORKER_TEST_LEGACY_BOOTSTRAP_TRANSITION_CLAIM
  if (testMode && override !== undefined) return
  if (pathname !== managedTransitionAnchorPath) fail('production workflow transition anchor path is not managed')
  let tracked
  let committed
  try {
    tracked = execFileSync('/usr/bin/git', [
      '-C', repositoryRoot, 'ls-files', '--error-unmatch', '--',
      'scripts/n8n-workflow-transition-anchor.mjs',
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 }).trim()
    committed = execFileSync('/usr/bin/git', [
      '-C', repositoryRoot, 'show', 'HEAD:scripts/n8n-workflow-transition-anchor.mjs',
    ], { maxBuffer: MAX_JSON_BYTES })
  } catch {
    fail('managed workflow transition anchor is not tracked at HEAD')
  }
  if (tracked !== 'scripts/n8n-workflow-transition-anchor.mjs'
    || sha256(committed) !== hashFileStable(pathname, 'managed workflow transition anchor', {
      maximumBytes: MAX_JSON_BYTES,
    })) {
    fail('managed workflow transition anchor differs from HEAD')
  }
}

function fullReference(pathname, label, mode = 0o400) {
  const entry = safeEntry(pathname, label, 'file', {
    ...(mode === null ? {} : { mode }), maximumBytes: MAX_JSON_BYTES, nonempty: true,
  })
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    size: Number(entry.size),
    mtimeNs: entry.mtimeNs.toString(),
    ctimeNs: entry.ctimeNs.toString(),
    uid: Number(entry.uid),
    mode: Number(entry.mode & 0o7777n).toString(8),
    nlink: Number(entry.nlink),
    sha256: hashFileStable(pathname, label, {
      ...(mode === null ? {} : { mode }), maximumBytes: MAX_JSON_BYTES,
    }),
  }
}

function validateFullReference(reference, label, mode = 0o400) {
  exactKeys(reference, [
    'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'path', 'sha256', 'size', 'uid',
  ], `${label} full reference`)
  const actual = fullReference(reference.path, label, mode)
  if (canonicalJson(actual) !== canonicalJson(reference)) fail(`${label} full reference changed`)
  return reference
}

function fullDirectoryReference(pathname, label) {
  const entry = safeEntry(pathname, label, 'directory')
  if (realpathSync(pathname) !== pathname) fail(`${label} is not a physical path`)
  return {
    path: pathname,
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    uid: Number(entry.uid),
    mode: Number(entry.mode & 0o7777n).toString(8),
  }
}

function validateFullDirectoryReference(reference, label) {
  exactKeys(reference, ['dev', 'ino', 'mode', 'path', 'uid'], `${label} full reference`)
  if (canonicalJson(reference) !== canonicalJson(fullDirectoryReference(reference.path, label))) {
    fail(`${label} full reference changed`)
  }
  return reference
}

function validateTransitionClaim(claimLoaded, expected) {
  const value = claimLoaded.value
  exactKeys(value, ['bootstrap', 'claimedAt', 'schema', 'transition', 'uid', 'upgradeId'], 'workflow transition bootstrap claim')
  exactKeys(value.bootstrap, ['attemptId', 'request'], 'workflow transition bootstrap request')
  exactKeys(value.bootstrap.request, ['database', 'preparePath', 'target'], 'workflow transition bootstrap request binding')
  exactKeys(value.bootstrap.request.target, [
    'manifestSha256', 'releaseId', 'releaseRoot', 'slot',
  ], 'workflow transition bootstrap target')
  exactKeys(value.transition, [
    'attestation', 'committedJournalHeadSha256', 'liveCombinedSha256',
  ], 'workflow transition committed binding')
  if (value.schema !== 'video-autoworker-n8n-workflow-transition-bootstrap-claim/v1'
    || value.uid !== process.getuid() || !/^[a-f0-9-]{36}$/u.test(value.bootstrap.attemptId)
    || !Number.isSafeInteger(value.claimedAt) || value.claimedAt <= 0
    || typeof value.upgradeId !== 'string' || !/^[a-f0-9-]{36}$/u.test(value.upgradeId)
    || value.bootstrap.request.preparePath !== expected.preparePath
    || canonicalJson(value.bootstrap.request.target) !== canonicalJson(expected.target)
    || value.bootstrap.request.database?.path !== expected.database.path
    || value.bootstrap.request.database?.dev !== expected.database.dev
    || value.bootstrap.request.database?.ino !== expected.database.ino
    || value.transition.attestation?.path !== expected.attestation.path
    || value.transition.attestation?.sha256 !== expected.attestation.sha256
    || !SHA256.test(value.transition.committedJournalHeadSha256)
    || !SHA256.test(value.transition.liveCombinedSha256)) {
    fail('workflow transition bootstrap claim is bound to another operation')
  }
  return value
}

function transitionAnchorEnvironment() {
  const environment = { ...process.env }
  if (!testMode) {
    environment.NODE_ENV = 'production'
    for (const name of Object.keys(environment)) {
      if (name.startsWith('AIWORKER_TEST_')) delete environment[name]
    }
  }
  return environment
}

function invokeTransitionClaim(binding, target, database, preparePath) {
  const testClaim = process.env.AIWORKER_TEST_LEGACY_BOOTSTRAP_TRANSITION_CLAIM
  if (testClaim !== undefined) {
    if (!testMode) fail('workflow transition claim override is forbidden outside isolated tests')
    if (testClaim !== binding.claim.path) fail('test workflow transition claim path changed')
    const loaded = readJson(testClaim, 'test workflow transition bootstrap claim', {
      mode: 0o400, maximumBytes: MAX_JSON_BYTES,
    })
    validateTransitionClaim(loaded, { target, database, preparePath, attestation: binding.attestation })
    return { claim: fullReference(testClaim, 'test workflow transition bootstrap claim'), bootstrapAttemptId: loaded.value.bootstrap.attemptId }
  }
  assertManagedTransitionAnchorAtHead(managedTransitionAnchorPath)
  const result = spawnSync(process.execPath, [
    managedTransitionAnchorPath, 'claim-bootstrap',
    '--intent', binding.intent.path,
    '--confirmation', binding.confirmation.path,
    '--journal-dir', binding.journal.path,
    '--attestation', binding.attestation.path,
    '--prepare-path', preparePath,
    '--slot', target.slot,
    '--release-id', target.releaseId,
    '--release-root', target.releaseRoot,
    '--manifest-sha256', target.manifestSha256,
    '--output', binding.claim.path,
  ], {
    cwd: repositoryRoot,
    env: transitionAnchorEnvironment(),
    encoding: 'utf8',
    maxBuffer: MAX_JSON_BYTES,
    timeout: 30_000,
  })
  if (result.error || result.signal || result.status !== 0) {
    fail(`workflow transition bootstrap claim failed${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ''}`)
  }
  let output
  try { output = strictJson(result.stdout, 'workflow transition bootstrap claim result') } catch {
    fail('workflow transition bootstrap claim result is invalid')
  }
  exactKeys(output, ['bootstrapAttemptId', 'claim', 'resumed', 'schema'], 'workflow transition bootstrap claim result')
  if (output.schema !== 'video-autoworker-n8n-workflow-transition-bootstrap-claim/v1'
    || typeof output.resumed !== 'boolean' || !/^[a-f0-9-]{36}$/u.test(output.bootstrapAttemptId)) {
    fail('workflow transition bootstrap claim result is invalid')
  }
  validateFullReference(output.claim, 'workflow transition bootstrap claim')
  const loaded = readJson(binding.claim.path, 'workflow transition bootstrap claim', {
    mode: 0o400, maximumBytes: MAX_JSON_BYTES,
  })
  validateTransitionClaim(loaded, { target, database, preparePath, attestation: binding.attestation })
  if (loaded.value.bootstrap.attemptId !== output.bootstrapAttemptId
    || output.claim?.path !== loaded.reference.path || output.claim?.sha256 !== loaded.reference.sha256) {
    fail('workflow transition bootstrap claim result changed')
  }
  return { claim: loaded.reference, bootstrapAttemptId: output.bootstrapAttemptId }
}

function captureTransitionBinding(values, target, database, preparePath) {
  const intent = fullReference(values['--transition-intent'], 'workflow transition intent')
  const confirmation = fullReference(values['--transition-confirmation'], 'workflow transition confirmation')
  const attestation = fullReference(values['--transition-attestation'], 'workflow transition attestation')
  const journal = fullDirectoryReference(values['--transition-journal'], 'workflow transition journal')
  assertAbsolute(values['--transition-claim'], 'workflow transition bootstrap claim')
  const anchor = fullReference(managedTransitionAnchorPath, 'workflow transition anchor', null)
  assertManagedTransitionAnchorAtHead(managedTransitionAnchorPath)
  const base = {
    anchor,
    intent,
    confirmation,
    journal,
    attestation,
    claim: { path: values['--transition-claim'] },
  }
  const claimed = invokeTransitionClaim(base, target, database, preparePath)
  const claimLoaded = readJson(values['--transition-claim'], 'workflow transition bootstrap claim', {
    mode: 0o400, maximumBytes: MAX_JSON_BYTES,
  })
  const claim = validateTransitionClaim(claimLoaded, { target, database, preparePath, attestation })
  if (claim.bootstrap.attemptId !== claimed.bootstrapAttemptId) fail('workflow transition bootstrap attempt ID changed')
  return {
    anchor,
    intent,
    confirmation,
    journal,
    attestation,
    claim: claimed.claim,
    upgradeId: claim.upgradeId,
    committedJournalHeadSha256: claim.transition.committedJournalHeadSha256,
    liveCombinedSha256: claim.transition.liveCombinedSha256,
  }
}

function validateTransitionBinding(value, target, database, preparePath) {
  exactKeys(value, [
    'anchor', 'attestation', 'claim', 'committedJournalHeadSha256', 'confirmation',
    'intent', 'journal', 'liveCombinedSha256', 'upgradeId',
  ], 'prepared workflow transition')
  validateFullReference(value.anchor, 'prepared workflow transition anchor', null)
  for (const [name, reference] of [
    ['intent', value.intent], ['confirmation', value.confirmation],
    ['attestation', value.attestation], ['claim', value.claim],
  ]) validateFullReference(reference, `prepared workflow transition ${name}`)
  validateFullDirectoryReference(value.journal, 'prepared workflow transition journal')
  if (value.anchor.path !== managedTransitionAnchorPath
    || value.anchor.sha256 !== hashFileStable(managedTransitionAnchorPath, 'workflow transition anchor', {
      maximumBytes: MAX_JSON_BYTES,
    })) fail('prepared workflow transition anchor changed')
  assertManagedTransitionAnchorAtHead(value.anchor.path)
  const claimLoaded = readJson(value.claim.path, 'prepared workflow transition bootstrap claim', {
    mode: 0o400, maximumBytes: MAX_JSON_BYTES,
  })
  const claim = validateTransitionClaim(claimLoaded, {
    target, database, preparePath, attestation: value.attestation,
  })
  const attestation = readJson(value.attestation.path, 'prepared workflow transition attestation', {
    mode: 0o400, maximumBytes: MAX_JSON_BYTES,
  }).value
  if (attestation?.producer?.sha256 !== value.anchor.sha256
    || typeof attestation?.producer?.path !== 'string' || !attestation.producer.path.startsWith('/')) {
    fail('workflow transition producer is not byte-identical to the Git-managed anchor')
  }
  if (claim.upgradeId !== value.upgradeId
    || claim.transition.committedJournalHeadSha256 !== value.committedJournalHeadSha256
    || claim.transition.liveCombinedSha256 !== value.liveCombinedSha256) {
    fail('prepared workflow transition committed binding changed')
  }
  const replay = invokeTransitionClaim(value, target, database, preparePath)
  if (replay.bootstrapAttemptId !== claim.bootstrap.attemptId
    || canonicalJson(replay.claim) !== canonicalJson(value.claim)) {
    fail('prepared workflow transition bootstrap claim changed')
  }
  return value
}

function validateRouting(value) {
  exactKeys(value, ['port', 'runDirectory', 'statePath'], 'prepared routing')
  if (value.port !== 3017) fail('prepared router port must be 3017')
  validateDirectoryIdentity(value.runDirectory, 'prepared router run directory')
  assertAbsolute(value.statePath, 'prepared router state path')
  if (value.statePath !== join(value.runDirectory.path, 'router-state.json')) {
    fail('prepared router state path is not canonical for the run directory')
  }
  if (existsSync(value.statePath)) assertNoSymlink(value.statePath, 'prepared router state path')
  return value
}

function writeExclusiveReceipt(pathname, value, mode) {
  assertAbsolute(pathname, 'receipt output')
  const parent = dirname(pathname)
  safeEntry(parent, 'attempt directory', 'directory', { mode: 0o700 })
  if (existsSync(pathname)) fail(`${basename(pathname)} already exists`)
  const temporary = join(parent, `.${basename(pathname)}.${randomUUID()}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    const source = Buffer.from(`${canonicalJson(value)}\n`)
    let offset = 0
    while (offset < source.length) offset += writeSync(descriptor, source, offset, source.length - offset)
    fsyncSync(descriptor)
    chmodSync(temporary, mode)
    closeSync(descriptor)
    descriptor = undefined
    linkSync(temporary, pathname)
    unlinkSync(temporary)
    safeEntry(pathname, 'published receipt', 'file', { mode, maximumBytes: MAX_JSON_BYTES, nonempty: true })
    const parentFd = openSync(parent, constants.O_RDONLY)
    try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
  } catch (error) {
    try { if (descriptor !== undefined) closeSync(descriptor) } catch {}
    try { unlinkSync(temporary) } catch {}
    if (error instanceof Error && error.message.startsWith('legacy bootstrap controller failed:')) throw error
    fail(`unable to publish ${basename(pathname)} exclusively`)
  }
  return readJson(pathname, basename(pathname), { mode }).reference
}

function unlinkConsumed(pathname) {
  unlinkSync(pathname)
  const parentFd = openSync(dirname(pathname), constants.O_RDONLY)
  try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
}

function parseArguments(argv) {
  const command = argv[0]
  const allowed = {
    prepare: [
      '--attempt-dir', '--evidence', '--proof', '--source-commit', '--router-run-dir',
      '--router-state', '--router-port', '--mission-db', '--n8n-db', '--transition-intent',
      '--transition-confirmation', '--transition-journal', '--transition-attestation',
      '--transition-claim',
    ],
    'current-confirm': ['--prepare'],
    apply: ['--prepare', '--confirm', '--token'],
    'derive-n8n-restore-confirmation': [
      '--prepare', '--confirm', '--shutdown', '--package', '--runtime-release', '--database',
    ],
    'derive-n8n-disaster-recovery-confirmation': [
      '--prepare', '--confirm', '--shutdown', '--pending', '--proof', '--package',
      '--runtime-release', '--database', '--recovery-attempt-dir',
    ],
    'derive-bootstrap-resume': [
      '--prepare', '--confirm', '--shutdown', '--pending', '--runtime-release', '--n8n-pid',
      '--recovery-attempt-dir',
    ],
    'verify-bootstrap-resume': ['--receipt', '--token'],
    'consume-bootstrap-resume': ['--receipt', '--token'],
    status: ['--attempt-dir'],
  }[command]
  if (!allowed) fail('expected prepare, current-confirm, apply, derive/verify/consume recovery, or status')
  const values = {}
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!allowed.includes(name) || !value || Object.hasOwn(values, name)) fail(`${command} arguments are invalid`)
    values[name] = value
  }
  if (Object.keys(values).length !== allowed.length) fail(`${command} arguments are incomplete`)
  for (const [name, value] of Object.entries(values)) {
    if (!['--source-commit', '--router-port', '--n8n-pid'].includes(name)) assertAbsolute(value, name)
  }
  return { command, values }
}

function validateFileIdentity(value, label) {
  exactKeys(value, ['dev', 'ino', 'path'], label)
  assertAbsolute(value.path, `${label} path`)
  if (!/^\d+$/u.test(value.dev) || !/^\d+$/u.test(value.ino)) fail(`${label} is invalid`)
  return value
}

function validateProcess(value, label, extraKeys) {
  exactKeys(value, [
    'argvSha256', 'cwd', 'database', 'executable', 'pid', 'ppid', 'startTime', 'uid', ...extraKeys,
  ], label)
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.ppid)
    || value.ppid <= 0 || !Number.isSafeInteger(value.uid) || value.uid < 0
    || typeof value.startTime !== 'string' || !value.startTime || !SHA256.test(value.argvSha256)) {
    fail(`${label} process identity is invalid`)
  }
  validateFileIdentity(value.cwd, `${label} cwd`)
  validateFileIdentity(value.database, `${label} database`)
  validateFileIdentity(value.executable, `${label} executable`)
}

function validateFrozen(value, evidence, now) {
  const baseKeys = [
    'argvSha256', 'database', 'expiresAt', 'guardNonceSha256', 'issuedAt', 'mode', 'n8nDatabase', 'pid', 'schema',
    'scriptSha256', 'socket', 'startedAt', 'uid', 'legacyBindingSha256',
  ]
  const keys = Object.hasOwn(value || {}, 'ready') ? [...baseKeys, 'ready'] : baseKeys
  exactKeys(value, keys, 'freeze guard')
  if (value.schema !== GUARD_SCHEMA || value.mode !== 'dual'
    || (Object.hasOwn(value, 'ready') && value.ready !== true)
    || !Number.isSafeInteger(value.pid) || value.pid <= 0 || value.uid !== process.getuid()
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.issuedAt > now || value.expiresAt <= now || value.expiresAt - value.issuedAt < 30
    || value.expiresAt - value.issuedAt > 1800 || typeof value.startedAt !== 'string' || !value.startedAt
    || !['argvSha256', 'guardNonceSha256', 'legacyBindingSha256', 'scriptSha256']
      .every(name => SHA256.test(value[name]))) fail('freeze guard contract is invalid or expired')
  validateFileIdentity(value.database, 'freeze guard database')
  validateFileIdentity(value.n8nDatabase, 'freeze guard n8n database')
  validateFileIdentity(value.socket, 'freeze guard socket')
  if (canonicalJson(value.database) !== canonicalJson(evidence.legacy.database)) {
    fail('freeze guard is not bound to the evidenced Mission Control database')
  }
  if (canonicalJson(value.n8nDatabase) !== canonicalJson(evidence.n8n.database)) {
    fail('freeze guard is not bound to the evidenced n8n database')
  }
  const expectedLegacyBinding = sha256(canonicalJson({
    pid: evidence.legacy.pid,
    uid: evidence.legacy.uid,
    startedAt: evidence.legacy.startTime,
    argvSha256: evidence.legacy.argvSha256,
    database: evidence.legacy.database,
    port: evidence.legacy.routerPort,
  }))
  if (value.legacyBindingSha256 !== expectedLegacyBinding) fail('freeze guard legacy binding changed')
  return value
}

function validateTarget(value, label) {
  exactKeys(value, ['manifestSha256', 'releaseId', 'releaseRoot', 'slot'], label)
  if (!['blue', 'green'].includes(value.slot) || !RELEASE_ID.test(value.releaseId)
    || !SHA256.test(value.manifestSha256)) fail(`${label} is invalid`)
  assertAbsolute(value.releaseRoot, `${label} release root`)
  safeEntry(value.releaseRoot, `${label} release root`, 'directory')
  if (realpathSync(value.releaseRoot) !== value.releaseRoot) fail(`${label} release root is not physical`)
  const manifestPath = join(value.releaseRoot, 'release-manifest.json')
  const manifest = fileReference(manifestPath, `${label} release manifest`, { nonempty: true })
  const digest = hashFileStable(manifestPath, `${label} release manifest`)
  if (digest !== value.manifestSha256) fail(`${label} release manifest digest changed`)
  return {
    slot: value.slot,
    releaseId: value.releaseId,
    releaseRoot: value.releaseRoot,
    releaseRootIdentity: (() => {
      const entry = safeEntry(value.releaseRoot, `${label} release root`, 'directory')
      return { path: value.releaseRoot, dev: entry.dev.toString(), ino: entry.ino.toString() }
    })(),
    manifest: { ...manifest, sha256: digest },
  }
}

function validateDatabaseIdentity(value, label) {
  validateFileIdentity(value, `${label} evidence identity`)
  const entry = safeEntry(value.path, label, 'file', { nonempty: true })
  if ((Number(entry.mode & 0o7777n) & 0o077) !== 0) fail(`${label} is not owner-private`)
  if (entry.dev.toString() !== value.dev || entry.ino.toString() !== value.ino) {
    fail(`${label} identity changed`)
  }
  return value
}

function validateEvidence(loaded, now) {
  const value = loaded.value
  exactKeys(value, [
    'counts', 'frozen', 'generatorSha256', 'legacy', 'n8n', 'observedAt',
    'queueDigestSha256', 'rollback', 'schema', 'supervisor', 'target',
  ], 'freeze evidence')
  if (value.schema !== EVIDENCE_SCHEMA || !SHA256.test(value.generatorSha256)
    || !SHA256.test(value.queueDigestSha256) || !Number.isSafeInteger(value.observedAt)
    || value.observedAt > now + 30) fail('freeze evidence contract is invalid')
  validateProcess(value.legacy, 'legacy', ['releaseId', 'routerPort'])
  validateProcess(value.n8n, 'n8n', ['launchPid', 'port'])
  if (!RELEASE_ID.test(value.legacy.releaseId) || value.legacy.routerPort !== 3017
    || !Number.isSafeInteger(value.n8n.launchPid) || value.n8n.launchPid <= 0
    || value.n8n.ppid !== value.n8n.launchPid || value.n8n.port !== 5678) {
    fail('evidenced runtime ports or process relationship are invalid')
  }
  exactKeys(value.counts, ['mediaNodes', 'n8nActiveExecutions', 'queueRunning', 'queueWaiting'], 'evidence counts')
  if (Object.values(value.counts).some(count => !Number.isSafeInteger(count) || count !== 0)) {
    fail('evidence is not a zero-work snapshot')
  }
  exactKeys(value.supervisor, ['disabled', 'loaded', 'lockAbsent', 'workerPids'], 'evidence supervisor')
  if (value.supervisor.disabled !== true || value.supervisor.loaded !== false
    || value.supervisor.lockAbsent !== true || !Array.isArray(value.supervisor.workerPids)
    || value.supervisor.workerPids.length !== 0) fail('evidence supervisor is not quiesced')
  exactKeys(value.rollback, ['dev', 'ino', 'path', 'sha256'], 'evidence rollback reference')
  if (!/^\d+$/u.test(value.rollback.dev) || !/^\d+$/u.test(value.rollback.ino)
    || !SHA256.test(value.rollback.sha256)) fail('evidence rollback reference is invalid')
  const target = validateTarget(value.target, 'evidence target')
  const guard = validateFrozen(value.frozen, value, now)
  validateDatabaseIdentity(value.legacy.database, 'Mission Control database')
  validateDatabaseIdentity(value.n8n.database, 'n8n database')
  return { value, target, guard }
}

function runtimeSnapshot(evidence) {
  return {
    legacy: evidence.legacy,
    n8n: evidence.n8n,
    counts: evidence.counts,
    queueDigestSha256: evidence.queueDigestSha256,
    supervisor: evidence.supervisor,
    frozen: evidence.frozen,
  }
}

function runLiveVerification(prepared, phase) {
  verifyReference(prepared.verifier, 'prepared live verifier', { maximumBytes: MAX_JSON_BYTES })
  assertManagedVerifierAtHead(prepared.verifier.path)
  validateRouting(prepared.routing)
  const childEnvironment = { ...process.env }
  if (!testMode) {
    childEnvironment.NODE_ENV = 'production'
    for (const name of Object.keys(childEnvironment)) {
      if (name.startsWith('AIWORKER_TEST_')) delete childEnvironment[name]
    }
  }
  const evidenceFd = openSync(prepared.evidence.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(evidenceFd, { bigint: true })
    if (opened.dev.toString() !== prepared.evidence.dev || opened.ino.toString() !== prepared.evidence.ino
      || Number(opened.size) !== prepared.evidence.size || opened.nlink !== 1n) {
      fail('prepared freeze evidence changed before live verification')
    }
    const result = spawnSync(process.execPath, [
      prepared.verifier.path, '--verify-evidence-fd', '3',
      '--output', prepared.evidence.path,
      '--slot', prepared.target.slot,
      '--release-id', prepared.target.releaseId,
      '--standalone-root', prepared.target.releaseRoot,
      '--rollback-proof', prepared.proof.path,
    ], {
      cwd: repositoryRoot,
      env: childEnvironment,
      encoding: 'utf8',
      maxBuffer: MAX_JSON_BYTES,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe', evidenceFd],
    })
    if (result.error || result.signal || result.status !== 0
      || result.stdout.trim() !== prepared.evidence.sha256) {
      fail(`live verifier failed during ${phase}`)
    }
  } finally { closeSync(evidenceFd) }
  return { observedAt: currentTime(), snapshotSha256: prepared.runtimeSnapshotSha256 }
}

function validateProof(loaded, evidenceLoaded, evidence, now) {
  const value = loaded.value
  exactKeys(value, [
    'backups', 'createdAt', 'generatorSha256', 'guardSha256', 'host', 'queueDigestSha256',
    'runtimeIdentitySha256', 'schema', 'sources', 'target', 'uid',
  ], 'rollback proof')
  if (value.schema !== PROOF_SCHEMA || !SHA256.test(value.generatorSha256)
    || !SHA256.test(value.guardSha256) || !SHA256.test(value.runtimeIdentitySha256)
    || value.uid !== process.getuid() || typeof value.host !== 'string' || !value.host
    || !Number.isSafeInteger(value.createdAt) || value.createdAt > now + 30 || now - value.createdAt > 3600
    || value.queueDigestSha256 !== evidence.value.queueDigestSha256) fail('rollback proof contract is invalid')
  exactKeys(value.target, ['manifestSha256', 'releaseId', 'slot'], 'rollback target')
  if (canonicalJson(value.target) !== canonicalJson({
    slot: evidence.target.slot,
    releaseId: evidence.target.releaseId,
    manifestSha256: evidence.target.manifest.sha256,
  })) fail('rollback proof target does not match evidence')
  exactKeys(value.sources, ['mission', 'n8n'], 'rollback proof sources')
  for (const [name, expected] of [
    ['mission', evidence.value.legacy.database], ['n8n', evidence.value.n8n.database],
  ]) {
    validateFileIdentity(value.sources[name], `rollback ${name} source`)
    if (canonicalJson(value.sources[name]) !== canonicalJson(expected)) fail(`rollback ${name} source changed`)
  }
  exactKeys(value.backups, ['mission', 'n8n'], 'rollback proof backups')
  for (const name of ['mission', 'n8n']) {
    exactKeys(value.backups[name], ['path', 'sha256'], `rollback ${name} backup`)
    if (!SHA256.test(value.backups[name].sha256)) fail(`rollback ${name} backup digest is invalid`)
    const entry = safeEntry(value.backups[name].path, `rollback ${name} backup`, 'file', { mode: 0o600, nonempty: true })
    if (entry.nlink !== 1n || hashFileStable(value.backups[name].path, `rollback ${name} backup`, { mode: 0o600 })
      !== value.backups[name].sha256) fail(`rollback ${name} backup changed`)
  }
  const snapshot = {
    legacy: evidence.value.legacy,
    n8n: evidence.value.n8n,
    counts: evidence.value.counts,
    queueDigestSha256: evidence.value.queueDigestSha256,
    supervisor: evidence.value.supervisor,
    frozen: evidence.value.frozen,
  }
  if (value.guardSha256 !== sha256(canonicalJson(evidence.value.frozen))
    || value.runtimeIdentitySha256 !== sha256(canonicalJson(snapshot))) {
    fail('rollback proof guard or runtime binding changed')
  }
  if (evidence.value.rollback.path !== loaded.reference.path
    || evidence.value.rollback.dev !== loaded.reference.dev
    || evidence.value.rollback.ino !== loaded.reference.ino
    || evidence.value.rollback.sha256 !== loaded.reference.sha256) {
    fail('freeze evidence is not bound to this rollback proof')
  }
  if (evidenceLoaded.reference.sha256 !== sha256(evidenceLoaded.source)) fail('freeze evidence digest is invalid')
  return value
}

function sourceCommitForRelease(commit, releaseId) {
  if (!COMMIT.test(commit)) fail('source commit must be one full lowercase Git commit')
  if (releaseId !== `${commit}-runtime`) fail('source commit is not bound to one full immutable target release ID')
  return commit
}

function validatePrepareReceipt(loaded, requireFresh) {
  const value = loaded.value
  exactKeys(value, [
    'attemptId', 'createdAt', 'databases', 'evidence', 'evidenceExpiresAt', 'expiresAt', 'guard',
    'prepareToolSha256', 'previousReceiptSha256', 'proof', 'routing', 'schema', 'sourceCommit',
    'runtimeSnapshotSha256', 'target', 'transition', 'uid', 'verifier',
  ], 'prepare receipt')
  if (value.schema !== PREPARE_SCHEMA || typeof value.attemptId !== 'string'
    || !/^[a-f0-9-]{36}$/u.test(value.attemptId) || value.uid !== process.getuid()
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.expiresAt)
    || !Number.isSafeInteger(value.evidenceExpiresAt)
    || value.expiresAt <= value.createdAt || value.expiresAt - value.createdAt > PREPARE_TTL_SECONDS
    || value.previousReceiptSha256 !== null || !SHA256.test(value.prepareToolSha256)
    || !SHA256.test(value.runtimeSnapshotSha256)
    || value.prepareToolSha256 !== hashFileStable(scriptPath, 'bootstrap controller')) {
    fail('prepare receipt contract is invalid')
  }
  exactKeys(value.databases, ['mission', 'n8n'], 'prepare databases')
  validateFileIdentity(value.databases.mission, 'prepared Mission Control database')
  validateFileIdentity(value.databases.n8n, 'prepared n8n database')
  exactKeys(value.guard, [
    'expiresAt', 'guardNonceSha256', 'legacyBindingSha256', 'schema', 'sha256',
  ], 'prepared guard')
  if (value.guard.schema !== GUARD_SCHEMA || !SHA256.test(value.guard.sha256)
    || !SHA256.test(value.guard.guardNonceSha256) || !SHA256.test(value.guard.legacyBindingSha256)
    || !Number.isSafeInteger(value.guard.expiresAt)) fail('prepared guard binding is invalid')
  verifyReference(value.evidence, 'prepared freeze evidence', { mode: 0o600, maximumBytes: MAX_JSON_BYTES })
  verifyReference(value.proof, 'prepared rollback proof', { mode: 0o600, maximumBytes: MAX_JSON_BYTES })
  verifyReference(value.verifier, 'prepared live verifier', { maximumBytes: MAX_JSON_BYTES })
  assertManagedVerifierAtHead(value.verifier.path)
  validateRouting(value.routing)
  const evidenceLoaded = readJson(value.evidence.path, 'prepared freeze evidence', { mode: 0o600 })
  const evidence = validateEvidence(evidenceLoaded, requireFresh ? currentTime() : value.createdAt)
  const proofLoaded = readJson(value.proof.path, 'prepared rollback proof', { mode: 0o600 })
  validateProof(proofLoaded, evidenceLoaded, evidence, requireFresh ? currentTime() : value.createdAt)
  const target = validateTarget({
    slot: value.target.slot,
    releaseId: value.target.releaseId,
    releaseRoot: value.target.releaseRoot,
    manifestSha256: value.target.manifest.sha256,
  }, 'prepared target')
  exactKeys(value.target, ['manifest', 'releaseId', 'releaseRoot', 'releaseRootIdentity', 'slot'], 'prepared target')
  exactKeys(value.target.releaseRootIdentity, ['dev', 'ino', 'path'], 'prepared release root identity')
  if (canonicalJson(target) !== canonicalJson(value.target)) fail('prepared target identity changed')
  validateTransitionBinding(
    value.transition,
    {
      slot: value.target.slot,
      releaseId: value.target.releaseId,
      releaseRoot: value.target.releaseRoot,
      manifestSha256: value.target.manifest.sha256,
    },
    value.databases.n8n,
    loaded.reference.path,
  )
  if (canonicalJson(value.databases) !== canonicalJson({
    mission: evidence.value.legacy.database,
    n8n: evidence.value.n8n.database,
  })) fail('prepared database identities changed')
  if (value.evidenceExpiresAt !== evidence.value.observedAt + 300
    || value.expiresAt > value.evidenceExpiresAt) fail('prepared evidence expiry is invalid')
  if (value.runtimeSnapshotSha256 !== sha256(canonicalJson(runtimeSnapshot(evidence.value)))) {
    fail('prepared runtime snapshot binding changed')
  }
  if (value.guard.expiresAt !== evidence.guard.expiresAt
    || value.guard.guardNonceSha256 !== evidence.guard.guardNonceSha256
    || value.guard.legacyBindingSha256 !== evidence.guard.legacyBindingSha256
    || value.guard.sha256 !== sha256(canonicalJson(evidence.guard))) fail('prepared guard changed')
  sourceCommitForRelease(value.sourceCommit, value.target.releaseId)
  const now = currentTime()
  if (requireFresh && (now > value.expiresAt || now >= value.guard.expiresAt
    || now >= value.evidenceExpiresAt)) {
    fail('prepare receipt, evidence, or guard expired')
  }
  return value
}

function prepare(values) {
  const attemptDirectory = values['--attempt-dir']
  safeEntry(attemptDirectory, 'attempt directory', 'directory', { mode: 0o700 })
  if (readdirSync(attemptDirectory).length !== 0) fail('attempt directory must be empty')
  const evidenceLoaded = readJson(values['--evidence'], 'freeze evidence', { mode: 0o600 })
  const now = currentTime()
  const evidence = validateEvidence(evidenceLoaded, now)
  const evidenceExpiresAt = evidence.value.observedAt + 300
  if (now >= evidenceExpiresAt) fail('freeze evidence expired')
  const proofLoaded = readJson(values['--proof'], 'rollback proof', { mode: 0o600 })
  validateProof(proofLoaded, evidenceLoaded, evidence, now)
  const sourceCommit = sourceCommitForRelease(values['--source-commit'], evidence.target.releaseId)
  const mission = fileReference(values['--mission-db'], 'explicit Mission Control database', { nonempty: true })
  const n8n = fileReference(values['--n8n-db'], 'explicit n8n database', { nonempty: true })
  for (const database of [mission, n8n]) delete database.size
  if (canonicalJson({ mission, n8n }) !== canonicalJson({
    mission: evidence.value.legacy.database,
    n8n: evidence.value.n8n.database,
  })) fail('explicit database identities do not match the freeze evidence')
  const routerPort = Number(values['--router-port'])
  if (!Number.isSafeInteger(routerPort) || routerPort !== 3017) fail('router port must be 3017')
  const routing = validateRouting({
    port: routerPort,
    runDirectory: directoryIdentity(values['--router-run-dir'], 'router run directory'),
    statePath: values['--router-state'],
  })
  const verifier = captureVerifierReference()
  const output = join(attemptDirectory, RECEIPTS.prepare)
  const transition = captureTransitionBinding(
    values,
    {
      slot: evidence.target.slot,
      releaseId: evidence.target.releaseId,
      releaseRoot: evidence.target.releaseRoot,
      manifestSha256: evidence.target.manifest.sha256,
    },
    evidence.value.n8n.database,
    output,
  )
  const transitionClaim = readJson(
    transition.claim.path,
    'workflow transition bootstrap claim',
    { mode: 0o400, maximumBytes: MAX_JSON_BYTES },
  ).value
  const expiresAt = Math.min(now + PREPARE_TTL_SECONDS, evidenceExpiresAt, evidence.guard.expiresAt)
  if (expiresAt <= now) fail('prepare cannot outlive the evidence or guard')
  const receipt = {
    schema: PREPARE_SCHEMA,
    attemptId: transitionClaim.bootstrap.attemptId,
    uid: process.getuid(),
    createdAt: now,
    expiresAt,
    evidenceExpiresAt,
    prepareToolSha256: hashFileStable(scriptPath, 'bootstrap controller'),
    runtimeSnapshotSha256: sha256(canonicalJson(runtimeSnapshot(evidence.value))),
    sourceCommit,
    target: evidence.target,
    databases: {
      mission: evidence.value.legacy.database,
      n8n: evidence.value.n8n.database,
    },
    routing,
    verifier,
    transition,
    guard: {
      schema: evidence.guard.schema,
      expiresAt: evidence.guard.expiresAt,
      guardNonceSha256: evidence.guard.guardNonceSha256,
      legacyBindingSha256: evidence.guard.legacyBindingSha256,
      sha256: sha256(canonicalJson(evidence.guard)),
    },
    evidence: evidenceLoaded.reference,
    proof: proofLoaded.reference,
    previousReceiptSha256: null,
  }
  const reference = writeExclusiveReceipt(output, receipt, 0o400)
  process.stdout.write(`${canonicalJson({ mode: 'prepare', attemptId: receipt.attemptId,
    expiresAt, prepare: reference })}\n`)
}

function currentConfirm(values) {
  const preparePath = values['--prepare']
  if (basename(preparePath) !== RECEIPTS.prepare) fail('prepare receipt filename is invalid')
  const attemptDirectory = dirname(preparePath)
  safeEntry(attemptDirectory, 'attempt directory', 'directory', { mode: 0o700 })
  const confirmPath = join(attemptDirectory, RECEIPTS.confirm)
  const tokenPath = join(attemptDirectory, RECEIPTS.token)
  if (existsSync(confirmPath) || existsSync(tokenPath) || existsSync(join(attemptDirectory, RECEIPTS.shutdown))) {
    fail('current confirmation already exists or the attempt already advanced')
  }
  const prepared = readJson(preparePath, 'prepare receipt', { mode: 0o400 })
  const prepareReceipt = validatePrepareReceipt(prepared, true)
  const live = runLiveVerification(prepareReceipt, 'current-confirm')
  const now = currentTime()
  const expiresAt = Math.min(
    now + CONFIRM_TTL_SECONDS,
    prepareReceipt.expiresAt,
    prepareReceipt.evidenceExpiresAt,
    prepareReceipt.guard.expiresAt,
  )
  if (expiresAt <= now) fail('current confirmation has no valid lifetime')
  const capability = randomBytes(32).toString('hex')
  const targetSha256 = sha256(canonicalJson(prepareReceipt.target))
  const confirmReceipt = {
    schema: CONFIRM_SCHEMA,
    attemptId: prepareReceipt.attemptId,
    uid: process.getuid(),
    confirmedAt: now,
    expiresAt,
    prepare: prepared.reference,
    evidenceSha256: prepareReceipt.evidence.sha256,
    proofSha256: prepareReceipt.proof.sha256,
    sourceCommit: prepareReceipt.sourceCommit,
    targetSha256,
    guardSha256: prepareReceipt.guard.sha256,
    liveObservedAt: live.observedAt,
    liveSnapshotSha256: live.snapshotSha256,
    tokenSha256: sha256(capability),
    previousReceiptSha256: prepared.reference.sha256,
  }
  const confirmSource = `${canonicalJson(confirmReceipt)}\n`
  const token = {
    schema: TOKEN_SCHEMA,
    attemptId: prepareReceipt.attemptId,
    capability,
    expiresAt,
    prepareSha256: prepared.reference.sha256,
    confirmReceiptSha256: sha256(confirmSource),
    targetSha256,
  }
  try {
    writeExclusiveReceipt(tokenPath, token, 0o600)
    const reference = writeExclusiveReceipt(confirmPath, confirmReceipt, 0o400)
    process.stdout.write(`${canonicalJson({ mode: 'current-confirm', attemptId: prepareReceipt.attemptId,
      expiresAt, confirm: reference, tokenFile: tokenPath })}\n`)
  } catch (error) {
    try { if (!existsSync(confirmPath) && existsSync(tokenPath)) unlinkConsumed(tokenPath) } catch {}
    throw error
  }
}

function validateConfirmReceipt(loaded, prepared, prepareLoaded, requireFresh) {
  const value = loaded.value
  exactKeys(value, [
    'attemptId', 'confirmedAt', 'evidenceSha256', 'expiresAt', 'guardSha256', 'prepare',
    'liveObservedAt', 'liveSnapshotSha256', 'previousReceiptSha256', 'proofSha256', 'schema',
    'sourceCommit', 'targetSha256', 'tokenSha256', 'uid',
  ], 'current confirmation receipt')
  verifyReference(value.prepare, 'confirmed prepare receipt', { mode: 0o400, maximumBytes: MAX_JSON_BYTES })
  if (value.schema !== CONFIRM_SCHEMA || value.attemptId !== prepared.attemptId
    || value.uid !== process.getuid() || value.prepare.path !== prepareLoaded.reference.path
    || value.prepare.sha256 !== prepareLoaded.reference.sha256
    || value.previousReceiptSha256 !== prepareLoaded.reference.sha256
    || value.evidenceSha256 !== prepared.evidence.sha256 || value.proofSha256 !== prepared.proof.sha256
    || value.sourceCommit !== prepared.sourceCommit || value.guardSha256 !== prepared.guard.sha256
    || value.targetSha256 !== sha256(canonicalJson(prepared.target)) || !SHA256.test(value.tokenSha256)
    || value.liveSnapshotSha256 !== prepared.runtimeSnapshotSha256
    || !Number.isSafeInteger(value.liveObservedAt)
    || !Number.isSafeInteger(value.confirmedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= value.confirmedAt || value.expiresAt - value.confirmedAt > CONFIRM_TTL_SECONDS
    || value.expiresAt > prepared.expiresAt || value.expiresAt > prepared.evidenceExpiresAt
    || value.expiresAt > prepared.guard.expiresAt) {
    fail('current confirmation binding is invalid')
  }
  if (requireFresh && currentTime() > value.expiresAt) fail('current confirmation expired')
  return value
}

function validateCapability(tokenLoaded, confirmed, prepared, prepareLoaded, confirmLoaded, requireFresh) {
  const token = tokenLoaded.value
  exactKeys(token, [
    'attemptId', 'capability', 'confirmReceiptSha256', 'expiresAt', 'prepareSha256',
    'schema', 'targetSha256',
  ], 'current confirmation capability')
  if (token.schema !== TOKEN_SCHEMA || token.attemptId !== prepared.attemptId
    || !SHA256.test(token.capability) || sha256(token.capability) !== confirmed.tokenSha256
    || token.expiresAt !== confirmed.expiresAt || token.prepareSha256 !== prepareLoaded.reference.sha256
    || token.confirmReceiptSha256 !== confirmLoaded.reference.sha256
    || token.targetSha256 !== confirmed.targetSha256
    || (requireFresh && currentTime() > token.expiresAt)) {
    fail('current confirmation capability is invalid, expired, or bound to another target')
  }
  return token
}

function apply(values) {
  const preparePath = values['--prepare']
  const confirmPath = values['--confirm']
  const tokenPath = values['--token']
  if (basename(preparePath) !== RECEIPTS.prepare || basename(confirmPath) !== RECEIPTS.confirm
    || basename(tokenPath) !== RECEIPTS.token || dirname(preparePath) !== dirname(confirmPath)
    || dirname(preparePath) !== dirname(tokenPath)) fail('apply artifacts must be the canonical files of one attempt')
  const attemptDirectory = dirname(preparePath)
  safeEntry(attemptDirectory, 'attempt directory', 'directory', { mode: 0o700 })
  const shutdownPath = join(attemptDirectory, RECEIPTS.shutdown)
  if (existsSync(shutdownPath)) fail('shutdown request already exists; capability replay refused')
  const prepareLoaded = readJson(preparePath, 'prepare receipt', { mode: 0o400 })
  const prepared = validatePrepareReceipt(prepareLoaded, true)
  const confirmLoaded = readJson(confirmPath, 'current confirmation receipt', { mode: 0o400 })
  const confirmed = validateConfirmReceipt(confirmLoaded, prepared, prepareLoaded, true)
  const tokenLoaded = readJson(tokenPath, 'current confirmation capability', {
    mode: 0o600,
    maximumBytes: MAX_TOKEN_BYTES,
  })
  const capability = validateCapability(tokenLoaded, confirmed, prepared, prepareLoaded, confirmLoaded, true)
  const live = runLiveVerification(prepared, 'apply')
  const requestedAt = currentTime()
  if (requestedAt > capability.expiresAt || requestedAt > prepared.expiresAt
    || requestedAt >= prepared.evidenceExpiresAt || requestedAt >= prepared.guard.expiresAt) {
    fail('current confirmation expired during the final live verification')
  }
  const receipt = {
    schema: SHUTDOWN_SCHEMA,
    attemptId: prepared.attemptId,
    uid: process.getuid(),
    requestedAt,
    sourceCommit: prepared.sourceCommit,
    targetSha256: confirmed.targetSha256,
    prepare: prepareLoaded.reference,
    confirm: confirmLoaded.reference,
    evidenceSha256: prepared.evidence.sha256,
    proofSha256: prepared.proof.sha256,
    guardSha256: prepared.guard.sha256,
    liveObservedAt: live.observedAt,
    liveSnapshotSha256: live.snapshotSha256,
    tokenSha256: confirmed.tokenSha256,
    previousReceiptSha256: confirmLoaded.reference.sha256,
  }
  const reference = writeExclusiveReceipt(shutdownPath, receipt, 0o400)
  unlinkConsumed(tokenPath)
  process.stdout.write(`${canonicalJson({ mode: 'apply', phase: 'SHUTDOWN_REQUESTED',
    attemptId: prepared.attemptId, receipt: reference, serviceActionsPerformed: false })}\n`)
}

function validateShutdownReceipt(loaded, prepared, prepareLoaded, confirmed, confirmLoaded) {
  const value = loaded.value
  exactKeys(value, [
    'attemptId', 'confirm', 'evidenceSha256', 'guardSha256', 'liveObservedAt',
    'liveSnapshotSha256', 'prepare', 'previousReceiptSha256', 'proofSha256', 'requestedAt',
    'schema', 'sourceCommit', 'targetSha256', 'tokenSha256', 'uid',
  ], 'shutdown request receipt')
  verifyReference(value.prepare, 'shutdown prepare receipt', { mode: 0o400, maximumBytes: MAX_JSON_BYTES })
  verifyReference(value.confirm, 'shutdown current confirmation receipt', {
    mode: 0o400, maximumBytes: MAX_JSON_BYTES,
  })
  if (value.schema !== SHUTDOWN_SCHEMA || value.attemptId !== prepared.attemptId
    || value.uid !== process.getuid() || value.previousReceiptSha256 !== confirmLoaded.reference.sha256
    || canonicalJson(value.prepare) !== canonicalJson(prepareLoaded.reference)
    || canonicalJson(value.confirm) !== canonicalJson(confirmLoaded.reference)
    || value.targetSha256 !== confirmed.targetSha256 || value.tokenSha256 !== confirmed.tokenSha256
    || value.evidenceSha256 !== prepared.evidence.sha256 || value.proofSha256 !== prepared.proof.sha256
    || value.guardSha256 !== prepared.guard.sha256 || value.sourceCommit !== prepared.sourceCommit
    || value.liveSnapshotSha256 !== prepared.runtimeSnapshotSha256
    || !Number.isSafeInteger(value.liveObservedAt) || !Number.isSafeInteger(value.requestedAt)
    || value.requestedAt < confirmed.confirmedAt || value.requestedAt > confirmed.expiresAt) {
    fail('shutdown request receipt chain is invalid')
  }
  return value
}

function validateWorkflowCompatibilityReport(reference, prepared, expectedDigest) {
  verifyReference(reference, 'pending n8n workflow compatibility report', {
    mode: 0o400, maximumBytes: MAX_JSON_BYTES,
  })
  const loaded = readJson(reference.path, 'pending n8n workflow compatibility report', {
    mode: 0o400, maximumBytes: MAX_JSON_BYTES,
  })
  if (canonicalJson(loaded.reference) !== canonicalJson(reference)) {
    fail('pending n8n workflow compatibility report reference changed')
  }
  const value = loaded.value
  exactKeys(value, [
    'combinedSha256', 'databasePath', 'protocol', 'runtimeIdentitySha256', 'schema',
    'sourceCommit', 'workflows',
  ], 'pending n8n workflow compatibility report')
  if (value.schema !== 'video-autoworker-n8n-workflow-compatibility/v2'
    || value.protocol !== 'slot-v1-execution-owner-v1'
    || value.sourceCommit !== prepared.sourceCommit
    || value.databasePath !== prepared.databases.n8n.path
    || !SHA256.test(value.runtimeIdentitySha256) || !SHA256.test(value.combinedSha256)
    || value.combinedSha256 !== expectedDigest || !Array.isArray(value.workflows)
    || value.workflows.length !== 2) fail('pending n8n workflow compatibility report binding is invalid')
  const expectedIds = ['aiworker-task-intake-v1', 'aiworker-video-analysis-v1']
  for (const [index, workflow] of value.workflows.entries()) {
    exactKeys(workflow, [
      'id', 'publishedVersionId', 'sha256', 'sourceSha256', 'sourceVersionId',
    ], 'pending n8n workflow report item')
    if (workflow.id !== expectedIds[index]
      || ![workflow.publishedVersionId, workflow.sourceVersionId]
        .every(item => typeof item === 'string' && /^[A-Za-z0-9-]{8,64}$/u.test(item))
      || !SHA256.test(workflow.sha256) || !SHA256.test(workflow.sourceSha256)) {
      fail('pending n8n workflow report item is invalid')
    }
  }
  const recomputed = sha256([
    value.sourceCommit,
    value.runtimeIdentitySha256,
    ...value.workflows.map(item => [
      item.id, item.sourceVersionId, item.sourceSha256, item.publishedVersionId, item.sha256,
    ].join(':')),
  ].join('\n'))
  if (recomputed !== value.combinedSha256) fail('pending n8n workflow compatibility digest is invalid')
  return loaded.reference
}

function validatePendingV4(loaded, prepared, prepareLoaded, confirmed, confirmLoaded, shutdownLoaded) {
  const value = loaded.value
  exactKeys(value, [
    'attemptId', 'authorization', 'baselineSourceCommit', 'bootstrapClaim', 'createdAt', 'databases', 'evidence',
    'evidenceObservedAt', 'legacyCwd', 'legacyPid', 'legacyReleaseId', 'manifestSha256',
    'n8n', 'proof', 'releaseId', 'releaseRoot', 'router', 'schema', 'slot', 'transition',
  ], 'bootstrap pending v4')
  exactKeys(value.authorization, ['confirm', 'prepare', 'shutdown'], 'pending authorization')
  exactKeys(value.databases, ['mission', 'n8n'], 'pending databases')
  exactKeys(value.n8n, [
    'dbPath', 'pid', 'workflowDigest', 'workflowProtocol', 'workflowReport', 'workflowSourceCommit',
  ], 'pending n8n')
  for (const [name, reference, expected] of [
    ['prepare', value.authorization.prepare, prepareLoaded.reference],
    ['confirm', value.authorization.confirm, confirmLoaded.reference],
    ['shutdown', value.authorization.shutdown, shutdownLoaded.reference],
    ['evidence', value.evidence, prepared.evidence],
    ['proof', value.proof, prepared.proof],
  ]) {
    exactKeys(reference, ['dev', 'ino', 'path', 'sha256', 'size'], `pending ${name} reference`)
    if (canonicalJson(reference) !== canonicalJson(expected)) fail(`pending ${name} reference changed`)
  }
  validateFullReference(value.bootstrapClaim, 'pending bootstrap claim')
  if (canonicalJson(value.bootstrapClaim) !== canonicalJson(prepared.transition.claim)) {
    fail('pending bootstrap claim reference changed')
  }
  validateFileIdentity(value.databases.mission, 'pending Mission Control database')
  validateFileIdentity(value.databases.n8n, 'pending n8n database')
  validateRouting(value.router)
  const evidenceLoaded = readJson(prepared.evidence.path, 'prepared freeze evidence', { mode: 0o600 })
  const evidence = validateEvidence(evidenceLoaded, prepared.createdAt).value
  validateWorkflowCompatibilityReport(value.n8n.workflowReport, prepared, value.n8n.workflowDigest)
  const transitionAttestation = readJson(
    prepared.transition.attestation.path,
    'prepared workflow transition attestation',
    { mode: 0o400, maximumBytes: MAX_JSON_BYTES },
  ).value
  if (transitionAttestation?.deployed?.report?.path !== value.n8n.workflowReport.path
    || transitionAttestation?.deployed?.report?.sha256 !== value.n8n.workflowReport.sha256
    || transitionAttestation?.deployed?.combinedSha256 !== value.n8n.workflowDigest
    || prepared.transition.liveCombinedSha256 !== value.n8n.workflowDigest
    || canonicalJson(value.transition) !== canonicalJson(prepared.transition)) {
    fail('bootstrap pending workflow transition binding is invalid')
  }
  if (value.schema !== 'video-autoworker-blue-green-bootstrap-pending/v4'
    || value.attemptId !== prepared.attemptId || !Number.isSafeInteger(value.createdAt)
    || value.createdAt < confirmed.confirmedAt || value.createdAt < shutdownLoaded.value.requestedAt
    || value.slot !== prepared.target.slot || value.releaseId !== prepared.target.releaseId
    || value.releaseRoot !== prepared.target.releaseRoot
    || value.manifestSha256 !== prepared.target.manifest.sha256
    || value.baselineSourceCommit !== prepared.sourceCommit
    || canonicalJson(value.databases) !== canonicalJson(prepared.databases)
    || canonicalJson(value.router) !== canonicalJson(prepared.routing)
    || value.evidenceObservedAt !== evidence.observedAt
    || value.legacyPid !== evidence.legacy.pid || value.legacyCwd !== evidence.legacy.cwd.path
    || value.legacyReleaseId !== evidence.legacy.releaseId
    || value.n8n.pid !== evidence.n8n.pid || value.n8n.dbPath !== prepared.databases.n8n.path
    || value.n8n.workflowProtocol !== 'slot-v1-execution-owner-v1'
    || value.n8n.workflowSourceCommit !== prepared.sourceCommit
    || !SHA256.test(value.n8n.workflowDigest)) {
    fail('bootstrap pending v4 binding is invalid')
  }
  return value
}

function assertProcessAbsent(pid, label) {
  try { process.kill(pid, 0) } catch (error) {
    if (error?.code === 'ESRCH') return
    fail(`unable to prove ${label} is absent`)
  }
  fail(`${label} is still running or its PID was reused`)
}

function assertEvidencedLegacyStopped(prepared, pending) {
  const evidence = readJson(prepared.evidence.path, 'prepared freeze evidence', { mode: 0o600 })
  if (evidence.value?.legacy?.pid !== pending.legacyPid) {
    fail('pending legacy PID is not bound to the prepared evidence')
  }
  const descriptor = openSync(prepared.evidence.path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let result
  try {
    result = spawnSync(process.execPath, [
      managedVerifierPath, '--probe-legacy-state-fd', '3', '--router-port', '3017',
    ], {
      encoding: 'utf8',
      maxBuffer: MAX_JSON_BYTES,
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe', descriptor],
    })
  } finally {
    closeSync(descriptor)
  }
  if (result.error || result.signal || result.status !== 0 || result.stdout.trim() !== 'stopped') {
    fail('unable to prove the evidenced legacy process stopped and router port 3017 is unclaimed')
  }
}

function assertLsofEmpty(argumentsValue, label) {
  const result = spawnSync('/usr/sbin/lsof', argumentsValue, {
    encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000,
  })
  if (result.error || result.signal || ![0, 1].includes(result.status)) fail(`${label} query failed`)
  if (result.stdout.trim()) fail(`${label} is still active`)
}

function assertDisasterStopped(prepared, pending, database) {
  if (testMode && process.env.AIWORKER_TEST_LEGACY_BOOTSTRAP_DISASTER_STOPPED === '1') return
  assertEvidencedLegacyStopped(prepared, pending)
  assertProcessAbsent(pending.n8n.pid, 'evidenced n8n process')
  const launchd = spawnSync('/bin/launchctl', [
    'print', `gui/${process.getuid()}/com.video-autoworker.n8n`,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: 10_000 })
  if (launchd.error || launchd.signal) fail('unable to query the n8n LaunchAgent')
  if (launchd.status === 0) fail('n8n LaunchAgent is still loaded')
  assertLsofEmpty(['-nP', '-iTCP:3017', '-sTCP:LISTEN', '-t'], 'legacy/router port 3017')
  assertLsofEmpty(['-nP', '-iTCP:5678', '-sTCP:LISTEN', '-t'], 'n8n port 5678')
  assertLsofEmpty(['-nP', '-t', '--', database.path], 'n8n database open-file set')
}

function transitionRollbackPackage(prepared) {
  const intent = readJson(prepared.transition.intent.path, 'workflow transition intent', {
    mode: 0o400, maximumBytes: MAX_JSON_BYTES,
  }).value
  const rollback = intent?.rollback
  if (!rollback || typeof rollback !== 'object' || !rollback.directory || !rollback.manifest
    || !Array.isArray(rollback.workflows) || rollback.workflows.length !== 2
    || !SHA256.test(rollback.combinedSha256) || !COMMIT.test(rollback.sourceCommit)
    || !VERSION.test(rollback.n8nVersion)) {
    fail('workflow transition rollback package binding is invalid')
  }
  if (rollback.sourceCommit !== prepared.sourceCommit) {
    fail('workflow transition rollback package is not produced by the target managed runtime')
  }
  return rollback
}

function validateRestorePackage(packagePath, prepared) {
  safeEntry(packagePath, 'n8n recovery package', 'directory', { mode: 0o500 })
  if (realpathSync(packagePath) !== packagePath) fail('n8n recovery package is not physical')
  const pinned = transitionRollbackPackage(prepared)
  const packageIdentity = directoryIdentity(packagePath, 'n8n recovery package')
  if (packageIdentity.path !== pinned.directory.path
    || packageIdentity.dev !== pinned.directory.dev || packageIdentity.ino !== pinned.directory.ino) {
    fail('n8n recovery package differs from the pre-write transition intent')
  }
  const manifestPath = join(packagePath, 'manifest.json')
  const loaded = readJson(manifestPath, 'n8n recovery manifest', {
    mode: 0o400, maximumBytes: MAX_JSON_BYTES,
  })
  exactKeys(loaded.value, ['combinedSha256', 'createdAt', 'schema', 'source', 'workflows'], 'n8n recovery manifest')
  exactKeys(loaded.value.source, [
    'databaseFileName', 'databaseIdentity', 'n8nVersion', 'quickCheck', 'sourceCommit',
  ], 'n8n recovery source')
  if (loaded.value.schema !== 'video-autoworker-n8n-managed-workflow-backup/v1'
    || loaded.value.source.sourceCommit !== pinned.sourceCommit
    || !VERSION.test(loaded.value.source.n8nVersion)
    || loaded.value.source.n8nVersion !== pinned.n8nVersion
    || loaded.value.source.quickCheck !== 'ok'
    || !SHA256.test(loaded.value.combinedSha256)
    || loaded.value.combinedSha256 !== pinned.combinedSha256
    || !Array.isArray(loaded.value.workflows) || loaded.value.workflows.length !== 2) {
    fail('n8n recovery package manifest is invalid or differs from the transition intent')
  }
  if (loaded.reference.path !== pinned.manifest.path || loaded.reference.sha256 !== pinned.manifest.sha256) {
    fail('n8n recovery package manifest reference differs from the transition intent')
  }
  for (const expected of pinned.workflows) {
    const actual = loaded.value.workflows.find(item => item?.id === expected.id)
    if (!actual || actual.active !== expected.active
      || actual.fileSha256 !== expected.fileSha256
      || actual.semanticSha256 !== expected.semanticSha256) {
      fail(`n8n recovery workflow ${expected.id} differs from the transition intent`)
    }
  }
  return { manifestSha256: loaded.reference.sha256, n8nVersion: loaded.value.source.n8nVersion }
}

function validateRuntimeRelease(pathname, sourceCommit, n8nVersion) {
  const identity = directoryIdentity(pathname, 'n8n runtime release')
  if (basename(pathname) !== sourceCommit || basename(dirname(pathname)) !== 'releases') {
    fail('n8n runtime release path is not bound to the prepared source commit')
  }
  const source = readText(join(pathname, 'SOURCE_COMMIT'), 'n8n runtime source commit')
  if (source.trim() !== sourceCommit) fail('n8n runtime SOURCE_COMMIT differs')
  const packageJson = readJson(
    join(pathname, 'ops/n8n/node_modules/n8n/package.json'),
    'n8n runtime package metadata',
    { maximumBytes: MAX_JSON_BYTES },
  )
  if (!packageJson.value || typeof packageJson.value !== 'object'
    || packageJson.value.version !== n8nVersion) fail('n8n runtime version differs from the recovery package')
  const sourceManifestPath = join(pathname, 'SOURCE_MANIFEST')
  const sourceManifest = readText(sourceManifestPath, 'n8n runtime source manifest').split(/\r?\n/u)
  if (!sourceManifest.includes(`source_commit=${sourceCommit}`)
    || !sourceManifest.includes(`n8n_version=${n8nVersion}`)) {
    fail('n8n runtime source manifest binding differs')
  }
  return identity
}

function deriveN8nRestoreConfirmation(values) {
  const preparePath = values['--prepare']
  const confirmPath = values['--confirm']
  const shutdownPath = values['--shutdown']
  const attemptDirectory = dirname(preparePath)
  if (basename(preparePath) !== RECEIPTS.prepare || basename(confirmPath) !== RECEIPTS.confirm
    || basename(shutdownPath) !== RECEIPTS.shutdown || dirname(confirmPath) !== attemptDirectory
    || dirname(shutdownPath) !== attemptDirectory) {
    fail('n8n restore authorization must use one canonical bootstrap attempt')
  }
  safeEntry(attemptDirectory, 'attempt directory', 'directory', { mode: 0o700 })
  if (existsSync(join(attemptDirectory, RECEIPTS.token))) fail('bootstrap capability was not consumed')
  const prepareLoaded = readJson(preparePath, 'prepare receipt', { mode: 0o400 })
  const prepared = validatePrepareReceipt(prepareLoaded, false)
  const confirmLoaded = readJson(confirmPath, 'current confirmation receipt', { mode: 0o400 })
  const confirmed = validateConfirmReceipt(confirmLoaded, prepared, prepareLoaded, false)
  const now = currentTime()
  if (now >= confirmed.expiresAt) fail('current confirmation expired before n8n restore authorization')
  const shutdownLoaded = readJson(shutdownPath, 'shutdown request receipt', { mode: 0o400 })
  validateShutdownReceipt(shutdownLoaded, prepared, prepareLoaded, confirmed, confirmLoaded)
  const explicitDatabase = fileReference(values['--database'], 'explicit n8n restore database', { nonempty: true })
  if (explicitDatabase.path !== prepared.databases.n8n.path
    || explicitDatabase.dev !== prepared.databases.n8n.dev
    || explicitDatabase.ino !== prepared.databases.n8n.ino) {
    fail('n8n restore database differs from the prepared physical identity')
  }
  const recoveryPackage = validateRestorePackage(values['--package'], prepared)
  validateRuntimeRelease(values['--runtime-release'], prepared.sourceCommit, recoveryPackage.n8nVersion)
  const receipt = {
    schema: N8N_RESTORE_SCHEMA,
    action: 'restore-managed-n8n-workflows',
    issuedAt: now,
    expiresAt: confirmed.expiresAt,
    uid: process.getuid(),
    nonce: randomBytes(32).toString('hex'),
    packageManifestSha256: recoveryPackage.manifestSha256,
    target: {
      databaseDev: `0x${BigInt(prepared.databases.n8n.dev).toString(16)}`,
      databaseIno: prepared.databases.n8n.ino,
      sourceCommit: prepared.sourceCommit,
      n8nVersion: recoveryPackage.n8nVersion,
      runtimeRelease: values['--runtime-release'],
    },
    authorization: {
      kind: 'legacy-bootstrap-shutdown-requested/v1',
      attemptId: prepared.attemptId,
      prepare: prepareLoaded.reference,
      confirm: confirmLoaded.reference,
      shutdown: shutdownLoaded.reference,
      controllerSha256: prepared.prepareToolSha256,
    },
  }
  const output = join(attemptDirectory, RECEIPTS.n8nRestore)
  const reference = writeExclusiveReceipt(output, receipt, 0o400)
  process.stdout.write(`${canonicalJson({
    mode: 'derive-n8n-restore-confirmation', attemptId: prepared.attemptId,
    expiresAt: confirmed.expiresAt, receipt: reference, serviceActionsPerformed: false,
  })}\n`)
}

function validateRecoveryAttemptDirectory(pathname, attemptDirectory, branch) {
  const attemptId = basename(pathname)
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(attemptId)) {
    fail('disaster recovery attempt directory must end in one lowercase UUID')
  }
  const parent = dirname(pathname)
  if (parent !== join(attemptDirectory, 'disaster-recovery-attempts')) {
    fail('disaster recovery attempt directory is outside the canonical bootstrap attempt')
  }
  safeEntry(attemptDirectory, 'bootstrap attempt directory', 'directory', { mode: 0o700 })
  safeEntry(parent, 'disaster recovery attempts directory', 'directory', { mode: 0o700 })
  safeEntry(pathname, 'disaster recovery attempt directory', 'directory', { mode: 0o700 })
  if (realpathSync(parent) !== parent || realpathSync(pathname) !== pathname) {
    fail('disaster recovery attempt path is not physical')
  }
  const allowed = branch === 'restore'
    ? new Set([
      'n8n-disaster-recovery-confirmation.receipt.json',
      'CLAIMED.receipt.json',
      'COMMITTED.receipt.json',
      'events',
    ])
    : new Set(['resume.receipt.json', 'resume.token.json', 'resume.consumed.json', 'guard.log'])
  for (const entry of readdirSync(pathname, { withFileTypes: true })) {
    if (!allowed.has(entry.name)) fail('disaster recovery attempt directory contains an unknown artifact')
    if (entry.name === 'events' ? !entry.isDirectory() : !entry.isFile()) {
      fail('disaster recovery attempt directory contains an invalid artifact')
    }
  }
  return attemptId
}

function claimRecoveryBranch(attemptDirectory, branch, attemptId) {
  const pathname = join(attemptDirectory, 'recovery-branch.claim.json')
  if (existsSync(pathname)) {
    const loaded = readJson(pathname, 'bootstrap recovery branch claim', {
      mode: 0o400, maximumBytes: MAX_JSON_BYTES,
    })
    exactKeys(loaded.value, [
      'attemptId', 'branch', 'claimedAt', 'schema', 'uid',
    ], 'bootstrap recovery branch claim')
    if (loaded.value.schema !== RECOVERY_BRANCH_SCHEMA
      || loaded.value.uid !== process.getuid() || loaded.value.attemptId === undefined
      || loaded.value.branch !== branch) {
      fail('bootstrap recovery already selected the other restore/resume branch')
    }
    if (loaded.value.attemptId !== attemptId) fail('bootstrap recovery branch belongs to another bootstrap attempt')
    return loaded.reference
  }
  return writeExclusiveReceipt(pathname, {
    schema: RECOVERY_BRANCH_SCHEMA,
    attemptId,
    branch,
    claimedAt: currentTime(),
    uid: process.getuid(),
  }, 0o400)
}

function validateRecoveryBranch(reference, attemptDirectory, branch, attemptId) {
  verifyReference(reference, 'bootstrap recovery branch claim', {
    mode: 0o400, maximumBytes: MAX_JSON_BYTES,
  })
  if (reference.path !== join(attemptDirectory, 'recovery-branch.claim.json')) {
    fail('bootstrap recovery branch claim path is not canonical')
  }
  const value = readJson(reference.path, 'bootstrap recovery branch claim', {
    mode: 0o400, maximumBytes: MAX_JSON_BYTES,
  }).value
  exactKeys(value, [
    'attemptId', 'branch', 'claimedAt', 'schema', 'uid',
  ], 'bootstrap recovery branch claim')
  if (value.schema !== RECOVERY_BRANCH_SCHEMA || value.attemptId !== attemptId
    || value.branch !== branch
    || value.uid !== process.getuid() || !Number.isSafeInteger(value.claimedAt) || value.claimedAt <= 0) {
    fail('bootstrap recovery branch claim binding is invalid')
  }
  return value
}

function deriveN8nDisasterRecoveryConfirmation(values) {
  const preparePath = values['--prepare']
  const confirmPath = values['--confirm']
  const shutdownPath = values['--shutdown']
  const attemptDirectory = dirname(preparePath)
  if (basename(preparePath) !== RECEIPTS.prepare || basename(confirmPath) !== RECEIPTS.confirm
    || basename(shutdownPath) !== RECEIPTS.shutdown || dirname(confirmPath) !== attemptDirectory
    || dirname(shutdownPath) !== attemptDirectory) {
    fail('disaster recovery authorization must use one canonical bootstrap attempt')
  }
  if (existsSync(join(attemptDirectory, RECEIPTS.token))) fail('bootstrap capability was not consumed')
  const recoveryAttemptId = validateRecoveryAttemptDirectory(
    values['--recovery-attempt-dir'], attemptDirectory, 'restore',
  )
  const prepareLoaded = readJson(preparePath, 'prepare receipt', { mode: 0o400 })
  const prepared = validatePrepareReceipt(prepareLoaded, false)
  const confirmLoaded = readJson(confirmPath, 'current confirmation receipt', { mode: 0o400 })
  const confirmed = validateConfirmReceipt(confirmLoaded, prepared, prepareLoaded, false)
  const shutdownLoaded = readJson(shutdownPath, 'shutdown request receipt', { mode: 0o400 })
  validateShutdownReceipt(shutdownLoaded, prepared, prepareLoaded, confirmed, confirmLoaded)
  const pendingLoaded = readJson(values['--pending'], 'bootstrap pending v4', {
    mode: 0o400, maximumBytes: MAX_JSON_BYTES,
  })
  const pending = validatePendingV4(
    pendingLoaded, prepared, prepareLoaded, confirmed, confirmLoaded, shutdownLoaded,
  )
  if (values['--proof'] !== prepared.proof.path) fail('explicit rollback proof path changed')
  verifyReference(prepared.proof, 'disaster recovery rollback proof', {
    mode: 0o600, maximumBytes: MAX_JSON_BYTES,
  })
  const databaseReference = fileReference(
    values['--database'], 'disaster recovery n8n database', { nonempty: true },
  )
  if (databaseReference.path !== prepared.databases.n8n.path
    || databaseReference.dev !== prepared.databases.n8n.dev
    || databaseReference.ino !== prepared.databases.n8n.ino) {
    fail('disaster recovery n8n database physical identity changed')
  }
  validateDatabaseIdentity(prepared.databases.mission, 'disaster recovery Mission Control database')
  validateDatabaseIdentity(prepared.databases.n8n, 'disaster recovery n8n database')
  assertDisasterStopped(prepared, pending, prepared.databases.n8n)
  const recoveryPackage = validateRestorePackage(values['--package'], prepared)
  validateRuntimeRelease(values['--runtime-release'], prepared.sourceCommit, recoveryPackage.n8nVersion)
  const issuedAt = currentTime()
  const recoveryDirectory = values['--recovery-attempt-dir']
  const branchClaim = claimRecoveryBranch(
    attemptDirectory, 'restore', prepared.attemptId,
  )
  const receipt = {
    schema: N8N_DISASTER_SCHEMA,
    action: 'restore-managed-n8n-workflows',
    scope: 'n8n-managed-workflow-restore-only',
    recoveryAttemptId,
    issuedAt,
    expiresAt: issuedAt + DISASTER_CLAIM_TTL_SECONDS,
    uid: process.getuid(),
    nonce: randomBytes(32).toString('hex'),
    packageManifestSha256: recoveryPackage.manifestSha256,
    target: {
      databaseDev: `0x${BigInt(prepared.databases.n8n.dev).toString(16)}`,
      databaseIno: prepared.databases.n8n.ino,
      sourceCommit: prepared.sourceCommit,
      n8nVersion: recoveryPackage.n8nVersion,
      runtimeRelease: values['--runtime-release'],
    },
    authorization: {
      kind: 'legacy-bootstrap-disaster-recovery/v1',
      attemptId: prepared.attemptId,
      prepare: prepareLoaded.reference,
      confirm: confirmLoaded.reference,
      shutdown: shutdownLoaded.reference,
      pending: pendingLoaded.reference,
      workflowReport: pending.n8n.workflowReport,
      proof: prepared.proof,
      controllerSha256: prepared.prepareToolSha256,
      originalConfirmationExpiresAt: confirmed.expiresAt,
      branchClaim,
      transition: prepared.transition,
    },
    journal: {
      schema: 'video-autoworker-n8n-disaster-recovery-journal/v1',
      directory: recoveryDirectory,
      claim: join(recoveryDirectory, 'CLAIMED.receipt.json'),
      events: join(recoveryDirectory, 'events'),
      completed: join(recoveryDirectory, 'COMMITTED.receipt.json'),
    },
  }
  const output = join(recoveryDirectory, 'n8n-disaster-recovery-confirmation.receipt.json')
  let reference
  if (existsSync(output)) {
    const existing = readJson(output, 'existing n8n disaster recovery receipt', { mode: 0o400 })
    const value = existing.value
    if (value.schema !== N8N_DISASTER_SCHEMA || value.recoveryAttemptId !== recoveryAttemptId
      || value.authorization?.attemptId !== prepared.attemptId
      || canonicalJson(value.authorization?.branchClaim) !== canonicalJson(branchClaim)
      || canonicalJson(value.target) !== canonicalJson(receipt.target)
      || canonicalJson(value.journal) !== canonicalJson(receipt.journal)
      || value.packageManifestSha256 !== receipt.packageManifestSha256) {
      fail('existing n8n disaster recovery receipt is bound to another operation')
    }
    reference = existing.reference
  } else {
    reference = writeExclusiveReceipt(output, receipt, 0o400)
  }
  process.stdout.write(`${canonicalJson({
    mode: 'derive-n8n-disaster-recovery-confirmation', attemptId: prepared.attemptId,
    recoveryAttemptId, claimExpiresAt: receipt.expiresAt, receipt: reference,
    serviceActionsPerformed: false,
  })}\n`)
}

function validateResumeSnapshot(value, prepared, runtimeRelease, n8nPid) {
  exactKeys(value, [
    'counts', 'n8nPid', 'observedAt', 'previousQueueDigestSha256', 'queueDigestSha256',
    'runtimeRelease', 'workflow',
  ], 'bootstrap resume snapshot')
  exactKeys(value.counts, [
    'mediaNodes', 'n8nActiveExecutions', 'queueRunning', 'queueWaiting',
  ], 'bootstrap resume counts')
  exactKeys(value.runtimeRelease, ['dev', 'ino', 'path'], 'bootstrap resume runtime release')
  exactKeys(value.workflow, [
    'combinedSha256', 'protocol', 'runtimeIdentitySha256', 'sourceCommit',
  ], 'bootstrap resume workflow')
  if (!Number.isSafeInteger(value.observedAt) || value.observedAt <= 0
    || value.n8nPid !== n8nPid || value.runtimeRelease.path !== runtimeRelease
    || value.workflow.protocol !== 'slot-v1-execution-owner-v1'
    || value.workflow.sourceCommit !== prepared.sourceCommit
    || !SHA256.test(value.workflow.combinedSha256)
    || !SHA256.test(value.workflow.runtimeIdentitySha256)
    || !SHA256.test(value.previousQueueDigestSha256) || !SHA256.test(value.queueDigestSha256)
    || Object.values(value.counts).some(count => !Number.isSafeInteger(count) || count !== 0)) {
    fail('bootstrap resume snapshot is not a zero-work managed runtime')
  }
  const actualRelease = directoryIdentity(runtimeRelease, 'bootstrap resume n8n runtime release')
  if (canonicalJson(actualRelease) !== canonicalJson(value.runtimeRelease)) {
    fail('bootstrap resume n8n runtime release identity changed')
  }
  return value
}

function offlineQueueProjection(db, now) {
  const batchRoot = resolve(String(process.env.AIWORKER_VIDEO_BATCH_DIR || '').trim()
    || join(homedir(), 'ai-worker/state/video-autoworker/video-batches'))
  const durable = existsSync(batchRoot) ? scanOfflineDurableBatchStates(batchRoot) : []
  const rows = db.prepare(`
    SELECT task_id AS taskId, status, updated_at AS updatedAt
    FROM n8n_task_runs
    WHERE status IN ('queued', 'accepted', 'running', 'staging', 'submitted', 'waiting', 'recovering', 'paused')
    ORDER BY created_at, id
  `).all()
  return projectOfflineQueue(rows, durable, now)
}

function captureResumeSnapshot(prepared, pending, runtimeRelease, n8nPid) {
  const testSnapshot = process.env.AIWORKER_TEST_LEGACY_BOOTSTRAP_RESUME_SNAPSHOT
  if (testMode && process.env.AIWORKER_TEST_LEGACY_BOOTSTRAP_RESUME === '1') {
    if (!testSnapshot) fail('test bootstrap resume snapshot is required')
    assertAbsolute(testSnapshot, 'test bootstrap resume snapshot')
    return validateResumeSnapshot(
      readJson(testSnapshot, 'test bootstrap resume snapshot', { mode: 0o600 }).value,
      prepared, runtimeRelease, n8nPid,
    )
  }
  if (testSnapshot !== undefined || process.env.AIWORKER_TEST_LEGACY_BOOTSTRAP_RESUME !== undefined) {
    fail('bootstrap resume test override is forbidden outside the isolated test mode')
  }
  assertEvidencedLegacyStopped(prepared, pending)
  assertLsofEmpty(['-nP', '-iTCP:3017', '-sTCP:LISTEN', '-t'], 'legacy/router port 3017')
  validateDatabaseIdentity(prepared.databases.mission, 'bootstrap resume Mission Control database')
  validateDatabaseIdentity(prepared.databases.n8n, 'bootstrap resume n8n database')
  validateRuntimeRelease(runtimeRelease, prepared.sourceCommit, MANAGED_N8N_VERSION)
  if (!Number.isSafeInteger(n8nPid) || n8nPid <= 0) fail('bootstrap resume n8n PID is invalid')
  try { process.kill(n8nPid, 0) } catch { fail('bootstrap resume n8n PID is not running') }
  const expectedCwd = join(runtimeRelease, 'ops/n8n')
  const cwdQuery = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(n8nPid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8', maxBuffer: MAX_JSON_BYTES, timeout: 10_000,
  })
  if (cwdQuery.error || cwdQuery.signal || cwdQuery.status !== 0
    || !cwdQuery.stdout.split('\n').includes(`n${expectedCwd}`)) {
    fail('bootstrap resume n8n PID is outside the managed runtime release')
  }
  const verifierEntry = safeEntry(managedWorkflowVerifierPath, 'managed workflow verifier', 'file', { nonempty: true })
  if (verifierEntry.nlink !== 1n) fail('managed workflow verifier link count is unsafe')
  let tracked
  try {
    tracked = execFileSync('/usr/bin/git', [
      '-C', repositoryRoot, 'show', `${prepared.sourceCommit}:scripts/verify-n8n-blue-green-workflows.mjs`,
    ])
  } catch { fail('managed workflow verifier is unavailable in the prepared commit') }
  if (sha256(tracked) !== hashFileStable(managedWorkflowVerifierPath, 'managed workflow verifier')) {
    fail('managed workflow verifier differs from the prepared commit')
  }
  const verifierEnvironment = { ...process.env, NODE_ENV: 'production' }
  for (const name of Object.keys(verifierEnvironment)) {
    if (name.startsWith('AIWORKER_TEST_')) delete verifierEnvironment[name]
  }
  const verified = spawnSync(process.execPath, [
    managedWorkflowVerifierPath,
    '--database', prepared.databases.n8n.path,
    '--repository', repositoryRoot,
    '--expected-commit', prepared.sourceCommit,
    '--module-root', repositoryRoot,
    '--pid', String(n8nPid),
    '--port', '5678',
  ], {
    cwd: repositoryRoot, env: verifierEnvironment, encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024, timeout: 30_000,
  })
  if (verified.error || verified.signal || verified.status !== 0) {
    fail('bootstrap resume managed n8n workflow verification failed')
  }
  let workflow
  try { workflow = strictJson(verified.stdout, 'bootstrap resume workflow result') } catch {
    fail('bootstrap resume workflow result is invalid')
  }
  exactKeys(workflow, [
    'combinedSha256', 'databasePath', 'protocol', 'runtimeIdentitySha256', 'schema',
    'sourceCommit', 'workflows',
  ], 'bootstrap resume workflow result')
  if (workflow.schema !== 'video-autoworker-n8n-workflow-compatibility/v2'
    || workflow.databasePath !== prepared.databases.n8n.path
    || workflow.protocol !== 'slot-v1-execution-owner-v1'
    || workflow.sourceCommit !== prepared.sourceCommit
    || !SHA256.test(workflow.combinedSha256) || !SHA256.test(workflow.runtimeIdentitySha256)) {
    fail('bootstrap resume workflow result is bound to another runtime')
  }
  const scopedRequire = createRequire(import.meta.url)
  const Database = scopedRequire(scopedRequire.resolve('better-sqlite3', { paths: [repositoryRoot] }))
  let mission
  let n8n
  let counts
  try {
    mission = new Database(prepared.databases.mission.path, { readonly: true, fileMustExist: true })
    mission.pragma('query_only = ON')
    if (mission.pragma('quick_check', { simple: true }) !== 'ok') fail('bootstrap resume Mission Control quick_check failed')
    const aggregate = mission.prepare(`
      SELECT SUM(CASE WHEN source = 'n8n-media-node'
          AND status IN ('queued', 'accepted', 'running') THEN 1 ELSE 0 END) AS mediaNodes
      FROM n8n_task_runs
    `).get()
    const queue = offlineQueueProjection(mission, currentTime())
    n8n = new Database(prepared.databases.n8n.path, { readonly: true, fileMustExist: true })
    n8n.pragma('query_only = ON')
    if (n8n.pragma('quick_check', { simple: true }) !== 'ok') fail('bootstrap resume n8n quick_check failed')
    const active = n8n.prepare(`
      SELECT COUNT(*) AS count FROM execution_entity
      WHERE status IN ('new', 'running', 'waiting') AND "stoppedAt" IS NULL
    `).get()
    counts = {
      mediaNodes: Number(aggregate.mediaNodes || 0),
      n8nActiveExecutions: Number(active.count || 0),
      queueWaiting: queue.waiting,
      queueRunning: queue.running,
      queueDigestSha256: queue.digest,
    }
  } finally {
    try { n8n?.close() } catch {}
    try { mission?.close() } catch {}
  }
  validateDatabaseIdentity(prepared.databases.mission, 'bootstrap resume Mission Control database')
  validateDatabaseIdentity(prepared.databases.n8n, 'bootstrap resume n8n database')
  const snapshot = {
    observedAt: currentTime(),
    n8nPid,
    runtimeRelease: directoryIdentity(runtimeRelease, 'bootstrap resume n8n runtime release'),
    workflow: {
      protocol: workflow.protocol,
      sourceCommit: workflow.sourceCommit,
      runtimeIdentitySha256: workflow.runtimeIdentitySha256,
      combinedSha256: workflow.combinedSha256,
    },
    previousQueueDigestSha256: (() => {
      const evidence = readJson(prepared.evidence.path, 'bootstrap resume freeze evidence', { mode: 0o600 }).value
      if (!SHA256.test(evidence?.queueDigestSha256)) fail('bootstrap resume prior queue digest is invalid')
      return evidence.queueDigestSha256
    })(),
    queueDigestSha256: counts.queueDigestSha256,
    counts: {
      mediaNodes: counts.mediaNodes,
      n8nActiveExecutions: counts.n8nActiveExecutions,
      queueWaiting: counts.queueWaiting,
      queueRunning: counts.queueRunning,
    },
  }
  return validateResumeSnapshot(snapshot, prepared, runtimeRelease, n8nPid)
}

function loadResumeChain(values) {
  const receiptPath = values['--receipt']
  const tokenPath = values['--token']
  if (basename(receiptPath) !== 'resume.receipt.json' || basename(tokenPath) !== 'resume.token.json'
    || dirname(receiptPath) !== dirname(tokenPath)) fail('bootstrap resume artifacts are not one canonical attempt')
  const receiptLoaded = readJson(receiptPath, 'bootstrap resume receipt', { mode: 0o400 })
  const receipt = receiptLoaded.value
  exactKeys(receipt, [
    'action', 'authorization', 'databases', 'expiresAt', 'issuedAt', 'nonceSha256',
    'recoveryAttemptId', 'routing', 'runtime', 'schema', 'target', 'uid',
  ], 'bootstrap resume receipt')
  exactKeys(receipt.authorization, [
    'attemptId', 'branchClaim', 'confirm', 'controllerSha256', 'evidence',
    'originalConfirmationExpiresAt', 'pending', 'prepare', 'proof', 'shutdown', 'transition',
    'workflowReport',
  ], 'bootstrap resume authorization')
  const prepareLoaded = readJson(receipt.authorization.prepare.path, 'resume prepare receipt', { mode: 0o400 })
  const prepared = validatePrepareReceipt(prepareLoaded, false)
  const confirmLoaded = readJson(receipt.authorization.confirm.path, 'resume confirmation receipt', { mode: 0o400 })
  const confirmed = validateConfirmReceipt(confirmLoaded, prepared, prepareLoaded, false)
  const shutdownLoaded = readJson(receipt.authorization.shutdown.path, 'resume shutdown receipt', { mode: 0o400 })
  validateShutdownReceipt(shutdownLoaded, prepared, prepareLoaded, confirmed, confirmLoaded)
  const pendingLoaded = readJson(receipt.authorization.pending.path, 'resume bootstrap pending v4', { mode: 0o400 })
  const pending = validatePendingV4(
    pendingLoaded, prepared, prepareLoaded, confirmed, confirmLoaded, shutdownLoaded,
  )
  validateRecoveryBranch(
    receipt.authorization.branchClaim,
    dirname(receipt.authorization.prepare.path),
    'resume',
    prepared.attemptId,
  )
  for (const [name, reference, expected] of [
    ['prepare', receipt.authorization.prepare, prepareLoaded.reference],
    ['confirm', receipt.authorization.confirm, confirmLoaded.reference],
    ['shutdown', receipt.authorization.shutdown, shutdownLoaded.reference],
    ['pending', receipt.authorization.pending, pendingLoaded.reference],
    ['workflow report', receipt.authorization.workflowReport, pending.n8n.workflowReport],
    ['evidence', receipt.authorization.evidence, prepared.evidence],
    ['proof', receipt.authorization.proof, prepared.proof],
  ]) {
    if (canonicalJson(reference) !== canonicalJson(expected)) fail(`bootstrap resume ${name} reference changed`)
  }
  if (receipt.schema !== RESUME_SCHEMA || receipt.action !== 'resume-bootstrap'
    || receipt.uid !== process.getuid() || receipt.authorization.attemptId !== prepared.attemptId
    || receipt.authorization.controllerSha256 !== prepared.prepareToolSha256
    || receipt.authorization.originalConfirmationExpiresAt !== confirmed.expiresAt
    || !Number.isSafeInteger(receipt.issuedAt) || !Number.isSafeInteger(receipt.expiresAt)
    || receipt.expiresAt !== receipt.issuedAt + RESUME_TTL_SECONDS
    || !SHA256.test(receipt.nonceSha256)
    || canonicalJson(receipt.databases) !== canonicalJson(prepared.databases)
    || canonicalJson(receipt.routing) !== canonicalJson(prepared.routing)
    || canonicalJson(receipt.target) !== canonicalJson(prepared.target)
    || canonicalJson(receipt.authorization.transition) !== canonicalJson(prepared.transition)) {
    fail('bootstrap resume receipt binding is invalid')
  }
  const tokenLoaded = readJson(tokenPath, 'bootstrap resume capability', {
    mode: 0o600, maximumBytes: MAX_TOKEN_BYTES,
  })
  const token = tokenLoaded.value
  exactKeys(token, [
    'attemptId', 'capability', 'expiresAt', 'issuedAt', 'receiptSha256', 'recoveryAttemptId', 'schema',
  ], 'bootstrap resume capability')
  if (token.schema !== RESUME_TOKEN_SCHEMA || token.attemptId !== prepared.attemptId
    || token.recoveryAttemptId !== receipt.recoveryAttemptId || token.expiresAt !== receipt.expiresAt
    || token.issuedAt !== receipt.issuedAt
    || token.receiptSha256 !== receiptLoaded.reference.sha256 || !SHA256.test(token.capability)
    || sha256(token.capability) !== receipt.nonceSha256) fail('bootstrap resume capability is invalid')
  return { receiptLoaded, receipt, tokenLoaded, prepared, pending }
}

function deriveBootstrapResume(values) {
  const preparePath = values['--prepare']
  const confirmPath = values['--confirm']
  const shutdownPath = values['--shutdown']
  const attemptDirectory = dirname(preparePath)
  if (basename(preparePath) !== RECEIPTS.prepare || basename(confirmPath) !== RECEIPTS.confirm
    || basename(shutdownPath) !== RECEIPTS.shutdown || dirname(confirmPath) !== attemptDirectory
    || dirname(shutdownPath) !== attemptDirectory) fail('bootstrap resume must use one canonical bootstrap attempt')
  if (existsSync(join(attemptDirectory, RECEIPTS.token))) fail('bootstrap capability was not consumed')
  const recoveryAttemptId = validateRecoveryAttemptDirectory(
    values['--recovery-attempt-dir'], attemptDirectory, 'resume',
  )
  const prepareLoaded = readJson(preparePath, 'resume prepare receipt', { mode: 0o400 })
  const prepared = validatePrepareReceipt(prepareLoaded, false)
  const confirmLoaded = readJson(confirmPath, 'resume current confirmation receipt', { mode: 0o400 })
  const confirmed = validateConfirmReceipt(confirmLoaded, prepared, prepareLoaded, false)
  const shutdownLoaded = readJson(shutdownPath, 'resume shutdown receipt', { mode: 0o400 })
  validateShutdownReceipt(shutdownLoaded, prepared, prepareLoaded, confirmed, confirmLoaded)
  const pendingLoaded = readJson(values['--pending'], 'resume bootstrap pending v4', { mode: 0o400 })
  const pending = validatePendingV4(
    pendingLoaded, prepared, prepareLoaded, confirmed, confirmLoaded, shutdownLoaded,
  )
  verifyReference(prepared.evidence, 'resume freeze evidence', { mode: 0o600, maximumBytes: MAX_JSON_BYTES })
  verifyReference(prepared.proof, 'resume rollback proof', { mode: 0o600, maximumBytes: MAX_JSON_BYTES })
  const branchClaim = claimRecoveryBranch(
    attemptDirectory, 'resume', prepared.attemptId,
  )
  const recoveryDirectory = values['--recovery-attempt-dir']
  const receiptPath = join(recoveryDirectory, 'resume.receipt.json')
  const tokenPath = join(recoveryDirectory, 'resume.token.json')
  const consumedPath = join(recoveryDirectory, 'resume.consumed.json')
  if (existsSync(receiptPath) && !existsSync(tokenPath)) {
    if (!existsSync(consumedPath)) fail('bootstrap resume receipt exists without its capability or consumed receipt')
    const existing = readJson(receiptPath, 'existing bootstrap resume receipt', { mode: 0o400 })
    const consumed = readJson(consumedPath, 'existing bootstrap resume consumed receipt', { mode: 0o400 })
    if (existing.value.schema !== RESUME_SCHEMA
      || existing.value.recoveryAttemptId !== recoveryAttemptId
      || existing.value.authorization?.attemptId !== prepared.attemptId
      || canonicalJson(existing.value.authorization?.branchClaim) !== canonicalJson(branchClaim)
      || consumed.value.schema !== RESUME_CONSUMED_SCHEMA
      || consumed.value.attemptId !== prepared.attemptId
      || consumed.value.recoveryAttemptId !== recoveryAttemptId
      || canonicalJson(consumed.value.resume) !== canonicalJson(existing.reference)) {
      fail('existing consumed bootstrap resume is bound to another operation')
    }
    process.stdout.write(`${canonicalJson({
      mode: 'derive-bootstrap-resume', attemptId: prepared.attemptId, recoveryAttemptId,
      expiresAt: existing.value.expiresAt, receipt: existing.reference,
      tokenFile: null, alreadyConsumed: true, serviceActionsPerformed: false,
    })}\n`)
    return
  }
  let issuedAt
  let capability
  let existingToken = null
  if (existsSync(tokenPath)) {
    existingToken = readJson(tokenPath, 'existing bootstrap resume capability', {
      mode: 0o600, maximumBytes: MAX_TOKEN_BYTES,
    })
    const token = existingToken.value
    exactKeys(token, [
      'attemptId', 'capability', 'expiresAt', 'issuedAt', 'receiptSha256', 'recoveryAttemptId', 'schema',
    ], 'existing bootstrap resume capability')
    if (token.schema !== RESUME_TOKEN_SCHEMA || token.attemptId !== prepared.attemptId
      || token.recoveryAttemptId !== recoveryAttemptId || !Number.isSafeInteger(token.issuedAt)
      || token.issuedAt <= 0 || token.expiresAt !== token.issuedAt + RESUME_TTL_SECONDS
      || !SHA256.test(token.capability) || !SHA256.test(token.receiptSha256)) {
      fail('existing bootstrap resume capability is invalid')
    }
    issuedAt = token.issuedAt
    capability = token.capability
  } else {
    issuedAt = currentTime()
    capability = randomBytes(32).toString('hex')
  }
  const n8nPid = Number(values['--n8n-pid'])
  const runtime = captureResumeSnapshot(prepared, pending, values['--runtime-release'], n8nPid)
  runtime.observedAt = issuedAt
  const receipt = {
    schema: RESUME_SCHEMA,
    action: 'resume-bootstrap',
    recoveryAttemptId,
    issuedAt,
    expiresAt: issuedAt + RESUME_TTL_SECONDS,
    uid: process.getuid(),
    nonceSha256: sha256(capability),
    target: prepared.target,
    databases: prepared.databases,
    routing: prepared.routing,
    runtime,
    authorization: {
      attemptId: prepared.attemptId,
      prepare: prepareLoaded.reference,
      confirm: confirmLoaded.reference,
      shutdown: shutdownLoaded.reference,
      pending: pendingLoaded.reference,
      workflowReport: pending.n8n.workflowReport,
      evidence: prepared.evidence,
      proof: prepared.proof,
      controllerSha256: prepared.prepareToolSha256,
      originalConfirmationExpiresAt: confirmed.expiresAt,
      branchClaim,
      transition: prepared.transition,
    },
  }
  const receiptSha256 = sha256(`${canonicalJson(receipt)}\n`)
  try {
    if (existingToken) {
      if (existingToken.value.receiptSha256 !== receiptSha256) {
        fail('existing bootstrap resume capability no longer matches the authorized runtime')
      }
    } else {
      writeExclusiveReceipt(tokenPath, {
        schema: RESUME_TOKEN_SCHEMA,
        attemptId: prepared.attemptId,
        recoveryAttemptId,
        capability,
        issuedAt,
        expiresAt: receipt.expiresAt,
        receiptSha256,
      }, 0o600)
    }
    let reference
    if (existsSync(receiptPath)) {
      const existing = readJson(receiptPath, 'existing bootstrap resume receipt', { mode: 0o400 })
      if (existing.reference.sha256 !== receiptSha256
        || canonicalJson(existing.value) !== canonicalJson(receipt)) {
        fail('existing bootstrap resume receipt no longer matches its capability')
      }
      reference = existing.reference
    } else {
      reference = writeExclusiveReceipt(receiptPath, receipt, 0o400)
    }
    process.stdout.write(`${canonicalJson({
      mode: 'derive-bootstrap-resume', attemptId: prepared.attemptId, recoveryAttemptId,
      expiresAt: receipt.expiresAt, receipt: reference, tokenFile: tokenPath,
      serviceActionsPerformed: false,
    })}\n`)
  } catch (error) {
    try { if (!existsSync(receiptPath) && existsSync(tokenPath)) unlinkConsumed(tokenPath) } catch {}
    throw error
  }
}

function verifyBootstrapResume(values, consume) {
  const chain = loadResumeChain(values)
  const now = currentTime()
  if (now >= chain.receipt.expiresAt) fail('bootstrap resume capability expired')
  const current = captureResumeSnapshot(
    chain.prepared, chain.pending, chain.receipt.runtime.runtimeRelease.path, chain.receipt.runtime.n8nPid,
  )
  const original = { ...chain.receipt.runtime }
  delete original.observedAt
  const observed = { ...current }
  delete observed.observedAt
  if (canonicalJson(original) !== canonicalJson(observed)) fail('bootstrap resume runtime changed after authorization')
  if (consume) {
    const consumedPath = join(dirname(values['--receipt']), 'resume.consumed.json')
    const consumed = {
      schema: RESUME_CONSUMED_SCHEMA,
      attemptId: chain.prepared.attemptId,
      recoveryAttemptId: chain.receipt.recoveryAttemptId,
      consumedAt: now,
      resume: chain.receiptLoaded.reference,
      tokenSha256: chain.tokenLoaded.reference.sha256,
      runtimeSnapshotSha256: sha256(canonicalJson(observed)),
    }
    const reference = writeExclusiveReceipt(consumedPath, consumed, 0o400)
    unlinkConsumed(values['--token'])
    process.stdout.write(`${canonicalJson({
      mode: 'consume-bootstrap-resume', consumed: reference, databases: chain.receipt.databases,
      expiresAt: chain.receipt.expiresAt,
    })}\n`)
    return
  }
  process.stdout.write(`${canonicalJson({
    mode: 'verify-bootstrap-resume', databases: chain.receipt.databases,
    expiresAt: chain.receipt.expiresAt,
  })}\n`)
}

function status(values) {
  const attemptDirectory = values['--attempt-dir']
  safeEntry(attemptDirectory, 'attempt directory', 'directory', { mode: 0o700 })
  const preparePath = join(attemptDirectory, RECEIPTS.prepare)
  if (!existsSync(preparePath)) {
    if (readdirSync(attemptDirectory).length !== 0) fail('attempt directory contains no valid prepare receipt')
    process.stdout.write(`${canonicalJson({ phase: 'EMPTY', attemptDirectory })}\n`)
    return
  }
  const prepareLoaded = readJson(preparePath, 'prepare receipt', { mode: 0o400 })
  const prepared = validatePrepareReceipt(prepareLoaded, false)
  let phase = 'PREPARED'
  let expiresAt = prepared.expiresAt
  const confirmPath = join(attemptDirectory, RECEIPTS.confirm)
  const tokenPath = join(attemptDirectory, RECEIPTS.token)
  const shutdownPath = join(attemptDirectory, RECEIPTS.shutdown)
  if (existsSync(confirmPath)) {
    const confirmLoaded = readJson(confirmPath, 'current confirmation receipt', { mode: 0o400 })
    const confirmed = validateConfirmReceipt(confirmLoaded, prepared, prepareLoaded, false)
    phase = 'CURRENT_CONFIRMED'
    expiresAt = confirmed.expiresAt
    if (existsSync(tokenPath)) validateCapability(
      readJson(tokenPath, 'current confirmation capability', { mode: 0o600, maximumBytes: MAX_TOKEN_BYTES }),
      confirmed, prepared, prepareLoaded, confirmLoaded, false,
    )
    if (existsSync(shutdownPath)) {
      const shutdown = readJson(shutdownPath, 'shutdown request receipt', { mode: 0o400 })
      exactKeys(shutdown.value, [
        'attemptId', 'confirm', 'evidenceSha256', 'guardSha256', 'prepare', 'previousReceiptSha256',
        'liveObservedAt', 'liveSnapshotSha256', 'proofSha256', 'requestedAt', 'schema',
        'sourceCommit', 'targetSha256', 'tokenSha256', 'uid',
      ], 'shutdown request receipt')
      if (shutdown.value.schema !== SHUTDOWN_SCHEMA || shutdown.value.attemptId !== prepared.attemptId
        || shutdown.value.previousReceiptSha256 !== confirmLoaded.reference.sha256
        || canonicalJson(shutdown.value.prepare) !== canonicalJson(prepareLoaded.reference)
        || canonicalJson(shutdown.value.confirm) !== canonicalJson(confirmLoaded.reference)
        || shutdown.value.targetSha256 !== confirmed.targetSha256
        || shutdown.value.tokenSha256 !== confirmed.tokenSha256
        || shutdown.value.evidenceSha256 !== prepared.evidence.sha256
        || shutdown.value.proofSha256 !== prepared.proof.sha256
        || shutdown.value.guardSha256 !== prepared.guard.sha256
        || shutdown.value.sourceCommit !== prepared.sourceCommit
        || shutdown.value.uid !== process.getuid()
        || shutdown.value.liveSnapshotSha256 !== prepared.runtimeSnapshotSha256
        || !Number.isSafeInteger(shutdown.value.requestedAt)
        || shutdown.value.requestedAt < confirmed.confirmedAt
        || shutdown.value.requestedAt > confirmed.expiresAt
        || !Number.isSafeInteger(shutdown.value.liveObservedAt)
        || !SHA256.test(shutdown.value.liveSnapshotSha256)
        || existsSync(tokenPath)) fail('shutdown request receipt chain is invalid')
      phase = 'SHUTDOWN_REQUESTED'
      expiresAt = confirmed.expiresAt
    }
  } else if (existsSync(tokenPath) || existsSync(shutdownPath)) {
    fail('attempt receipt chain is incomplete')
  }
  process.stdout.write(`${canonicalJson({
    phase,
    attemptId: prepared.attemptId,
    expiresAt,
    expired: currentTime() >= expiresAt,
    tokenPresent: existsSync(tokenPath),
    bindings: {
      sourceCommit: prepared.sourceCommit,
      target: prepared.target,
      evidence: prepared.evidence,
      proof: prepared.proof,
      transition: prepared.transition,
      databases: prepared.databases,
      routing: prepared.routing,
    },
  })}\n`)
}

export async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArguments(argv)
  if (command === 'prepare') return prepare(values)
  if (command === 'current-confirm') return currentConfirm(values)
  if (command === 'apply') return apply(values)
  if (command === 'derive-n8n-restore-confirmation') return deriveN8nRestoreConfirmation(values)
  if (command === 'derive-n8n-disaster-recovery-confirmation') {
    return deriveN8nDisasterRecoveryConfirmation(values)
  }
  if (command === 'derive-bootstrap-resume') return deriveBootstrapResume(values)
  if (command === 'verify-bootstrap-resume') return verifyBootstrapResume(values, false)
  if (command === 'consume-bootstrap-resume') return verifyBootstrapResume(values, true)
  return status(values)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
