#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync,
  linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PREPARED_SCHEMA = 'video-autoworker-legacy-preinstall-prepared/v1'
const VERIFIED_SCHEMA = 'video-autoworker-legacy-preinstall-verified/v1'
const ACTION_SCHEMA = 'video-autoworker-legacy-preinstall-action/v1'
const POSTVERIFY_ACTION_SCHEMA = 'video-autoworker-legacy-preinstall-postverify-action/v1'
const TERMINAL_SCHEMA = 'video-autoworker-legacy-preinstall-terminal-claim/v1'
const OWNER_SCHEMA = 'video-autoworker-legacy-preinstall-transition-owner/v1'
const COMPONENT_RESULT_SCHEMA = 'video-autoworker-legacy-preinstall-component-result/v1'
const COMPONENT_EVENT_SCHEMA = 'video-autoworker-legacy-preinstall-component-event/v1'
const COMPONENT_RESERVATION_SCHEMA = 'video-autoworker-legacy-preinstall-component-reservation/v1'
const COMPONENT_CANCELLATION_SCHEMA = 'video-autoworker-legacy-preinstall-component-cancellation/v1'
const INSTALLER_RESULT_SCHEMA = 'video-autoworker-installer-result/v1'
const FINAL_GATE_SCHEMA = 'video-autoworker-shared-runtime-final-gate/v1'
const FINALIZE_SCHEMA = 'video-autoworker-legacy-preinstall-finalize-claim/v1'
const EVIDENCE_SCHEMA = 'video-autoworker-legacy-freeze-evidence/v3'
const PROOF_SCHEMA = 'video-autoworker-legacy-bootstrap-rollback-proof/v2'
const READINESS_SCHEMA = 'video-autoworker-director-video-preflight/v1'
const MAX_BYTES = 1024 * 1024
const LEASE_SECONDS = 240
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u
const REVISION_FILE = /^install-prepared\.r(\d{6})\.receipt\.json$/u
const COMPONENT_EVENT_FILE = /^install-component-event\.(\d{6})\.receipt\.json$/u
const COMPONENT_RESERVATION_FILE = /^install-component-reservation\.(\d{6})\.receipt\.json$/u
const COMPONENTS = ['task-flow', 'video-command', 'director-brain']
const scriptPath = realpathSync(fileURLToPath(import.meta.url))
const repositoryRoot = realpathSync(join(dirname(scriptPath), '..'))
const managedEvidenceVerifier = join(repositoryRoot, 'scripts/generate-legacy-freeze-evidence.mjs')
const managedTransitionAnchor = join(repositoryRoot, 'scripts/n8n-workflow-transition-anchor.mjs')
const managedReadinessVerifier = join(repositoryRoot, 'scripts/verify-director-video-release-readiness.mjs')
const managedSharedRuntimeGate = join(repositoryRoot, 'scripts/verify-shared-runtime-install-gate.mjs')
const managedComponentInstallers = {
  'task-flow': join(repositoryRoot, 'scripts/install-aiworker-task-flow-skill.sh'),
  'video-command': join(repositoryRoot, 'scripts/install-aiworker-video-command-plugin.sh'),
  'director-brain': join(repositoryRoot, 'scripts/install-aiworker-director-brain.sh'),
}
const testMode = process.env.NODE_ENV === 'test'
  && process.env.AIWORKER_TEST_LEGACY_PREINSTALL === '1'

function fail(message) {
  throw new Error(`legacy preinstall controller failed: ${message}`)
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

function nowSeconds() {
  if (testMode) {
    const overridden = Number(process.env.AIWORKER_TEST_LEGACY_PREINSTALL_NOW)
    if (Number.isSafeInteger(overridden) && overridden > 0) return overridden
  }
  return Math.floor(Date.now() / 1000)
}

function commandFailpoint(name) {
  if (testMode && process.env.AIWORKER_TEST_LEGACY_PREINSTALL_COMMAND_FAILPOINT === name) {
    process.kill(process.pid, 'SIGKILL')
  }
}

function processStartToken(pid) {
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8', timeout: 5_000, maxBuffer: 4096,
  })
  return result.status === 0 ? result.stdout.trim() : ''
}

function strictJson(source, label) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > MAX_BYTES) fail(`${label} is too large`)
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

function assertNoSymlink(pathname, label, allowMissing = false) {
  assertAbsolute(pathname, label)
  const root = parse(pathname).root
  let current = root
  for (const part of relative(root, pathname).split('/').filter(Boolean)) {
    current = join(current, part)
    let entry
    try { entry = lstatSync(current, { bigint: true }) } catch (error) {
      if (allowMissing && error?.code === 'ENOENT') return
      fail(`${label} path component is unavailable`)
    }
    if (entry.isSymbolicLink()) fail(`${label} path contains a symlink`)
  }
}

function safeEntry(pathname, label, kind, mode = null) {
  assertNoSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if (kind === 'file' && (!entry.isFile() || entry.nlink !== 1n)) fail(`${label} is not a safe regular file`)
  if (kind === 'directory' && !entry.isDirectory()) fail(`${label} is not a directory`)
  if (entry.uid !== BigInt(process.getuid())) fail(`${label} owner is invalid`)
  const actualMode = Number(entry.mode & 0o7777n)
  if (mode === null ? (actualMode & 0o022) !== 0 : actualMode !== mode) fail(`${label} mode is unsafe`)
  if (kind === 'file' && (entry.size <= 0n || entry.size > BigInt(MAX_BYTES))) fail(`${label} size is invalid`)
  return entry
}

function readStableFile(pathname, label, mode) {
  const entry = safeEntry(pathname, label, 'file', mode)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size
      || opened.nlink !== 1n) fail(`${label} changed before read`)
    const source = readFileSync(descriptor)
    const after = lstatSync(pathname, { bigint: true })
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.nlink !== 1n) fail(`${label} changed during read`)
    return {
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

function reference(pathname, label, mode) {
  return readStableFile(pathname, label, mode).reference
}

function readJson(pathname, label, mode) {
  const loaded = readStableFile(pathname, label, mode)
  return {
    value: strictJson(loaded.source.toString('utf8'), label),
    reference: loaded.reference,
  }
}

function sameReference(actual, expected, label) {
  exactKeys(expected, ['dev', 'ino', 'path', 'sha256', 'size'], `${label} reference`)
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} reference changed`)
}

function directoryReference(pathname, label, mode = 0o700) {
  const entry = safeEntry(pathname, label, 'directory', mode)
  if (realpathSync(pathname) !== pathname) fail(`${label} must be physical`)
  return { path: pathname, dev: entry.dev.toString(), ino: entry.ino.toString() }
}

function fsyncDirectory(pathname) {
  const descriptor = openSync(pathname, constants.O_RDONLY)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

const IMMUTABLE_PREINSTALL_NAME = /^(?:install-prepared\.r\d{6}\.receipt\.json|install-action\.r\d{6}\.claim\.json|install-postverify-action\.r\d{6}\.claim\.json|install-verified\.r\d{6}\.receipt\.json|install-readiness\.r\d{6}\.report\.json|install-component-(?:reservation|result|event)\.\d{6}\.receipt\.json|install-finalize-claim\.receipt\.json|install-terminal-claim\.receipt\.json|preinstall-owner-claim\.json)$/u
const IMMUTABLE_TEMPORARY_NAME = /^\.(?<final>(?:install-prepared\.r\d{6}\.receipt\.json|install-action\.r\d{6}\.claim\.json|install-postverify-action\.r\d{6}\.claim\.json|install-verified\.r\d{6}\.receipt\.json|install-readiness\.r\d{6}\.report\.json|install-component-(?:reservation|result|event)\.\d{6}\.receipt\.json|install-finalize-claim\.receipt\.json|install-terminal-claim\.receipt\.json|preinstall-owner-claim\.json))\.(?<nonce>[a-f0-9-]{36})\.tmp$/u

function recoverImmutableCrashResidue(parent) {
  safeEntry(parent, 'immutable preinstall namespace', 'directory', 0o700)
  let changed = false
  for (const name of readdirSync(parent).filter(item => item.startsWith('.')).sort()) {
    const match = IMMUTABLE_TEMPORARY_NAME.exec(name)
    if (!match?.groups || !UUID.test(match.groups.nonce)
      || !IMMUTABLE_PREINSTALL_NAME.test(match.groups.final)) {
      fail('preinstall state directory contains an unknown temporary member')
    }
    const temporary = join(parent, name)
    const final = join(parent, match.groups.final)
    const temporaryEntry = lstatSync(temporary, { bigint: true })
    const temporaryMode = Number(temporaryEntry.mode & 0o7777n)
    if (!temporaryEntry.isFile() || temporaryEntry.isSymbolicLink()
      || temporaryEntry.uid !== BigInt(process.getuid()) || temporaryMode !== 0o400
      || ![1n, 2n].includes(temporaryEntry.nlink)) {
      fail('preinstall temporary publication residue is unsafe')
    }
    if (!existsSync(final)) {
      if (temporaryEntry.nlink !== 1n) {
        fail('preinstall temporary publication residue has an unknown hard link')
      }
      unlinkSync(temporary)
      changed = true
      continue
    }
    const finalEntry = lstatSync(final, { bigint: true })
    const finalMode = Number(finalEntry.mode & 0o7777n)
    if (!finalEntry.isFile() || finalEntry.isSymbolicLink()
      || finalEntry.uid !== BigInt(process.getuid()) || finalMode !== 0o400
      || finalEntry.dev !== temporaryEntry.dev || finalEntry.ino !== temporaryEntry.ino
      || finalEntry.nlink !== 2n || temporaryEntry.nlink !== 2n) {
      fail('preinstall linked publication residue conflicts with the final receipt')
    }
    unlinkSync(temporary)
    changed = true
  }
  if (changed) fsyncDirectory(parent)
}

function ensureDirectory(pathname, label) {
  assertNoSymlink(dirname(pathname), `${label} parent`)
  try { mkdirSync(pathname, { mode: 0o700 }) } catch (error) {
    if (error?.code !== 'EEXIST') fail(`unable to create ${label}`)
  }
  safeEntry(pathname, label, 'directory', 0o700)
  if (realpathSync(pathname) !== pathname) fail(`${label} must be physical`)
  fsyncDirectory(dirname(pathname))
}

function writeImmutable(pathname, value, label) {
  assertNoSymlink(pathname, label, true)
  const parent = dirname(pathname)
  safeEntry(parent, `${label} parent`, 'directory', 0o700)
  recoverImmutableCrashResidue(parent)
  const source = Buffer.from(`${canonicalJson(value)}\n`)
  const temporary = join(parent, `.${basename(pathname)}.${randomUUID()}.tmp`)
  let descriptor
  try {
    descriptor = openSync(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400)
    let offset = 0
    while (offset < source.length) offset += writeSync(descriptor, source, offset, source.length - offset)
    fsyncSync(descriptor)
    chmodSync(temporary, 0o400)
    if (testMode && process.env.AIWORKER_TEST_LEGACY_PREINSTALL_FAILPOINT === 'after-temp-fsync') {
      process.kill(process.pid, 'SIGKILL')
    }
    closeSync(descriptor)
    descriptor = undefined
    linkSync(temporary, pathname)
    if (testMode && process.env.AIWORKER_TEST_LEGACY_PREINSTALL_FAILPOINT === 'after-link') {
      process.kill(process.pid, 'SIGKILL')
    }
    unlinkSync(temporary)
  } catch (error) {
    try { if (descriptor !== undefined) closeSync(descriptor) } catch {}
    try { unlinkSync(temporary) } catch {}
    if (error?.code === 'EEXIST') return null
    fail(`unable to publish ${label}`)
  }
  fsyncDirectory(parent)
  return reference(pathname, label, 0o400)
}

export function publishPreinstallImmutableForTest(pathname, value) {
  if (!testMode) fail('test immutable publisher is forbidden outside isolated tests')
  return writeImmutable(pathname, value, 'test immutable preinstall receipt')
}

function managedPath(name, productionPath) {
  const override = process.env[name]
  if (override !== undefined) {
    if (!testMode) fail(`${name} override is forbidden outside isolated tests`)
    assertAbsolute(override, name)
    return override
  }
  return productionPath
}

function childEnvironment() {
  const environment = { ...process.env }
  if (!testMode) {
    environment.NODE_ENV = 'production'
    for (const name of Object.keys(environment)) {
      if (name.startsWith('AIWORKER_TEST_')) delete environment[name]
    }
  }
  return environment
}

function runJson(command, args, label) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: childEnvironment(),
    encoding: 'utf8',
    maxBuffer: MAX_BYTES,
    timeout: 120_000,
  })
  if (result.error || result.signal || result.status !== 0) {
    fail(`${label} failed${result.stderr?.trim() ? `: ${result.stderr.trim()}` : ''}`)
  }
  return strictJson(result.stdout.trim(), label)
}

function committedJournalHead(journalPath) {
  const names = readdirSync(journalPath).filter(name => /^\d{6}-[A-Za-z0-9_-]+\.json$/u.test(name)).sort()
  const last = names.at(-1)
  if (!last || !last.endsWith('-COMMITTED.json')) fail('workflow transition journal is not committed')
  return reference(join(journalPath, last), 'committed workflow journal head', 0o400).sha256
}

function verifyTransition(paths) {
  const anchor = managedPath('AIWORKER_TEST_LEGACY_PREINSTALL_TRANSITION_ANCHOR', managedTransitionAnchor)
  const output = runJson(process.execPath, [
    anchor, 'verify-transition',
    '--intent', paths.intent,
    '--confirmation', paths.confirmation,
    '--journal-dir', paths.journal,
    '--attestation', paths.attestation,
  ], 'workflow transition verification')
  if (output?.committed !== true || !SHA256.test(output.attestationSha256 || '')
    || !SHA256.test(output.liveCombinedSha256 || '') || typeof output.upgradeId !== 'string') {
    fail('workflow transition verification result is invalid')
  }
  const intent = reference(paths.intent, 'workflow transition intent', 0o400)
  const confirmation = reference(paths.confirmation, 'workflow transition confirmation', 0o400)
  const attestation = reference(paths.attestation, 'workflow transition attestation', 0o400)
  if (attestation.sha256 !== output.attestationSha256) fail('workflow transition attestation changed')
  const journal = directoryReference(paths.journal, 'workflow transition journal')
  return {
    anchor: reference(anchor, 'workflow transition anchor', null),
    intent,
    confirmation,
    journal,
    attestation,
    upgradeId: output.upgradeId,
    committedJournalHeadSha256: committedJournalHead(paths.journal),
    liveCombinedSha256: output.liveCombinedSha256,
  }
}

function databaseIdentity(value, label) {
  exactKeys(value, ['dev', 'ino', 'path'], label)
  const entry = safeEntry(value.path, label, 'file', 0o600)
  if (entry.dev.toString() !== value.dev || entry.ino.toString() !== value.ino) {
    fail(`${label} identity changed`)
  }
  return value
}

function evidenceContext(evidencePath, proofPath, sourceCommit) {
  if (!COMMIT.test(sourceCommit)) fail('source commit is invalid')
  const evidenceLoaded = readJson(evidencePath, 'legacy freeze evidence', 0o600)
  const proofLoaded = readJson(proofPath, 'legacy rollback proof', 0o600)
  const evidence = evidenceLoaded.value
  const proof = proofLoaded.value
  if (evidence?.schema !== EVIDENCE_SCHEMA || proof?.schema !== PROOF_SCHEMA
    || !Number.isSafeInteger(evidence.observedAt) || !evidence.target
    || evidence.target.releaseId !== `${sourceCommit}-runtime`
    || evidence.rollback?.path !== proofLoaded.reference.path
    || evidence.rollback?.dev !== proofLoaded.reference.dev
    || evidence.rollback?.ino !== proofLoaded.reference.ino
    || evidence.rollback?.sha256 !== proofLoaded.reference.sha256
    || evidence.frozen?.schema !== 'video-autoworker-legacy-freeze-guard/v1'
    || !Number.isSafeInteger(evidence.frozen.expiresAt)
    || !SHA256.test(evidence.frozen.guardNonceSha256 || '')
    || !SHA256.test(evidence.frozen.legacyBindingSha256 || '')) {
    fail('legacy evidence or rollback proof binding is invalid')
  }
  const target = {
    slot: evidence.target.slot,
    releaseId: evidence.target.releaseId,
    releaseRoot: evidence.target.releaseRoot,
    manifestSha256: evidence.target.manifestSha256,
  }
  if (!['blue', 'green'].includes(target.slot) || !SHA256.test(target.manifestSha256 || '')) {
    fail('legacy evidence target is invalid')
  }
  assertNoSymlink(target.releaseRoot, 'target release root')
  if (realpathSync(target.releaseRoot) !== target.releaseRoot) fail('target release root is not physical')
  const manifest = reference(join(target.releaseRoot, 'release-manifest.json'), 'target release manifest', null)
  if (manifest.sha256 !== target.manifestSha256) fail('target release manifest changed')
  const databases = {
    mission: databaseIdentity(evidence.legacy?.database, 'Mission Control database'),
    n8n: databaseIdentity(evidence.n8n?.database, 'n8n database'),
  }
  const now = nowSeconds()
  const expiresAt = Math.min(now + LEASE_SECONDS, evidence.observedAt + 300, evidence.frozen.expiresAt)
  if (evidence.observedAt > now + 30 || expiresAt <= now) fail('legacy evidence or freeze guard expired')
  const verifier = managedPath('AIWORKER_TEST_LEGACY_PREINSTALL_EVIDENCE_VERIFIER', managedEvidenceVerifier)
  const descriptor = openSync(evidencePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let result
  try {
    result = spawnSync(process.execPath, [
      verifier, '--verify-evidence-fd', '3', '--output', evidencePath,
      '--slot', target.slot, '--release-id', target.releaseId,
      '--standalone-root', target.releaseRoot, '--rollback-proof', proofPath,
    ], {
      cwd: repositoryRoot,
      env: childEnvironment(),
      encoding: 'utf8',
      maxBuffer: MAX_BYTES,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe', descriptor],
    })
  } finally { closeSync(descriptor) }
  if (result.error || result.signal || result.status !== 0
    || result.stdout.trim() !== evidenceLoaded.reference.sha256) {
    fail('live freeze evidence verification failed')
  }
  return {
    sourceCommit,
    target,
    databases,
    evidence: evidenceLoaded.reference,
    proof: proofLoaded.reference,
    evidenceObservedAt: evidence.observedAt,
    expiresAt,
    guard: {
      expiresAt: evidence.frozen.expiresAt,
      guardNonceSha256: evidence.frozen.guardNonceSha256,
      legacyBindingSha256: evidence.frozen.legacyBindingSha256,
      sha256: sha256(canonicalJson(evidence.frozen)),
    },
    runtimeSnapshotSha256: sha256(canonicalJson({
      legacy: evidence.legacy,
      n8n: evidence.n8n,
      counts: evidence.counts,
      queueDigestSha256: evidence.queueDigestSha256,
      supervisor: evidence.supervisor,
      frozen: evidence.frozen,
    })),
    verifier: reference(verifier, 'legacy freeze evidence verifier', null),
  }
}

function assertTransitionMatches(transition, context) {
  const attestation = readJson(transition.attestation.path, 'workflow transition attestation', 0o400).value
  const application = attestation?.targetApplicationRelease
  const reportReference = attestation?.deployed?.report
  if (attestation?.upgradeId !== transition.upgradeId
    || attestation?.deployed?.combinedSha256 !== transition.liveCombinedSha256
    || attestation?.n8n?.sourceCommit !== context.sourceCommit
    || application?.slot !== context.target.slot
    || application?.releaseId !== context.target.releaseId
    || application?.releaseRoot?.path !== context.target.releaseRoot
    || application?.manifest?.sha256 !== context.target.manifestSha256
    || !reportReference?.path) fail('committed workflow transition target changed')
  const report = readJson(reportReference.path, 'live workflow report', 0o400)
  sameReference(report.reference, reportReference, 'live workflow report')
  if (report.value?.databasePath !== context.databases.n8n.path
    || report.value?.sourceCommit !== context.sourceCommit
    || report.value?.combinedSha256 !== transition.liveCombinedSha256) {
    fail('committed workflow transition live database binding changed')
  }
}

function preinstallRoot(attemptDirectory, create = false) {
  safeEntry(attemptDirectory, 'preinstall attempt directory', 'directory', 0o700)
  const pathname = join(attemptDirectory, 'preinstall')
  if (create && !existsSync(pathname)) ensureDirectory(pathname, 'preinstall state directory')
  safeEntry(pathname, 'preinstall state directory', 'directory', 0o700)
  return pathname
}

function revisionPath(root, revision) {
  return join(root, `install-prepared.r${String(revision).padStart(6, '0')}.receipt.json`)
}

function verifiedPath(root, revision) {
  return join(root, `install-verified.r${String(revision).padStart(6, '0')}.receipt.json`)
}

function actionPath(root, revision) {
  return join(root, `install-action.r${String(revision).padStart(6, '0')}.claim.json`)
}

function postverifyActionPath(root, revision) {
  return join(root, `install-postverify-action.r${String(revision).padStart(6, '0')}.claim.json`)
}

function reportPath(root, revision) {
  return join(root, `install-readiness.r${String(revision).padStart(6, '0')}.report.json`)
}

function terminalPath(root) { return join(root, 'install-terminal-claim.receipt.json') }
function finalizePath(root) { return join(root, 'install-finalize-claim.receipt.json') }
function componentEventPath(root, sequence) {
  return join(root, `install-component-event.${String(sequence).padStart(6, '0')}.receipt.json`)
}
function componentReservationPath(root, sequence) {
  return join(root, `install-component-reservation.${String(sequence).padStart(6, '0')}.receipt.json`)
}
function componentResultPath(root, sequence) {
  return join(root, `install-component-result.${String(sequence).padStart(6, '0')}.receipt.json`)
}

function revisionFiles(root) {
  recoverImmutableCrashResidue(root)
  const names = readdirSync(root)
  const allowed = /^(?:install-prepared\.r\d{6}\.receipt\.json|install-action\.r\d{6}\.claim\.json|install-postverify-action\.r\d{6}\.claim\.json|install-verified\.r\d{6}\.receipt\.json|install-readiness\.r\d{6}\.report\.json|install-component-(?:reservation|result|event)\.\d{6}\.receipt\.json|install-finalize-claim\.receipt\.json|install-terminal-claim\.receipt\.json)$/u
  for (const name of names) {
    if (name === 'orchestrator') {
      const artifactRoot = join(root, name)
      safeEntry(artifactRoot, 'preinstall orchestrator artifact directory', 'directory', 0o700)
      if (realpathSync(artifactRoot) !== artifactRoot) {
        fail('preinstall orchestrator artifact directory must be physical')
      }
      const allowedArtifact = /^(?:protected-pids\.before|(?:task-flow|video-command|director-brain)\.(?:apply|rollback)\.raw|(?:task-flow|video-command|director-brain)\.cancel-probe\.[a-f0-9-]{36}|runtime-convergence\.(?:apply|rollback)\.raw|qwen-current-(?:fresh|recovery)-restart\.(?:claim|result))\.json$/u
      for (const artifact of readdirSync(artifactRoot)) {
        if (!allowedArtifact.test(artifact)) {
          fail('preinstall orchestrator artifact directory contains an unknown member')
        }
        safeEntry(join(artifactRoot, artifact), `preinstall orchestrator artifact ${artifact}`,
          'file', 0o600)
      }
    } else if (!allowed.test(name)) fail('preinstall state directory contains an unknown member')
  }
  return names.filter(name => REVISION_FILE.test(name)).sort()
}

function validatePrepared(loaded, requireFresh = true) {
  const value = loaded.value
  exactKeys(value, [
    'bootstrapClaimPath', 'controllerSha256', 'databases', 'evidence', 'evidenceObservedAt', 'expiresAt', 'guard',
    'installAttemptId', 'issuedAt', 'previous', 'proof', 'revision', 'runtimeSnapshotSha256',
    'schema', 'sourceCommit', 'target', 'transition', 'transitionOwner', 'uid', 'verifier',
  ], 'preinstall prepared receipt')
  if (value.schema !== PREPARED_SCHEMA || !UUID.test(value.installAttemptId || '')
    || value.uid !== process.getuid() || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.issuedAt) || !Number.isSafeInteger(value.expiresAt)
    || value.expiresAt <= value.issuedAt || value.expiresAt - value.issuedAt > LEASE_SECONDS
    || !SHA256.test(value.controllerSha256 || '') || !SHA256.test(value.runtimeSnapshotSha256 || '')
    || value.controllerSha256 !== reference(
      scriptPath, 'legacy preinstall controller', null,
    ).sha256) fail('preinstall prepared receipt is invalid')
  assertAbsolute(value.bootstrapClaimPath, 'prepared bootstrap claim path')
  if (basename(value.bootstrapClaimPath) !== 'bootstrap-claim.json') {
    fail('prepared bootstrap claim path is invalid')
  }
  if (!COMMIT.test(value.sourceCommit) || value.target?.releaseId !== `${value.sourceCommit}-runtime`
    || !['blue', 'green'].includes(value.target?.slot) || !SHA256.test(value.target?.manifestSha256 || '')) {
    fail('preinstall prepared target is invalid')
  }
  databaseIdentity(value.databases?.mission, 'prepared Mission Control database')
  databaseIdentity(value.databases?.n8n, 'prepared n8n database')
  const owner = readJson(value.transitionOwner?.path, 'preinstall transition owner', 0o400)
  sameReference(owner.reference, value.transitionOwner, 'preinstall transition owner')
  validateTransitionOwner(owner, {
    attemptDirectory: directoryReference(dirname(dirname(loaded.reference.path)), 'preinstall attempt directory'),
    bootstrapClaimPath: value.bootstrapClaimPath,
    sourceCommit: value.sourceCommit,
    target: value.target,
    databases: value.databases,
    transition: {
      attestationSha256: value.transition?.attestation?.sha256,
      committedJournalHeadSha256: value.transition?.committedJournalHeadSha256,
      liveCombinedSha256: value.transition?.liveCombinedSha256,
    },
  }, value.installAttemptId)
  sameReference(reference(value.evidence.path, 'prepared legacy evidence', 0o600), value.evidence, 'prepared legacy evidence')
  sameReference(reference(value.proof.path, 'prepared rollback proof', 0o600), value.proof, 'prepared rollback proof')
  if (value.revision === 1) {
    if (value.previous !== null) fail('initial preinstall revision has a previous receipt')
  } else {
    exactKeys(value.previous, ['installAttemptId', 'preparedSha256', 'revision'], 'previous preinstall revision')
    if (value.previous.installAttemptId !== value.installAttemptId
      || value.previous.revision !== value.revision - 1 || !SHA256.test(value.previous.preparedSha256 || '')) {
      fail('previous preinstall revision is invalid')
    }
  }
  if (requireFresh && nowSeconds() >= value.expiresAt) fail('preinstall lease expired')
  return value
}

function readAction(root, revision, installAttemptId) {
  const pathname = actionPath(root, revision)
  if (!existsSync(pathname)) return null
  const loaded = readJson(pathname, `preinstall revision ${revision} action`, 0o400)
  const value = loaded.value
  exactKeys(value, [
    'choice', 'claimedAt', 'installAttemptId', 'payload', 'revision', 'schema', 'uid',
  ], 'preinstall action claim')
  if (value.schema !== ACTION_SCHEMA || !['renew', 'verify', 'abandon'].includes(value.choice)
    || value.installAttemptId !== installAttemptId || value.revision !== revision
    || value.uid !== process.getuid() || !Number.isSafeInteger(value.claimedAt)) {
    fail('preinstall action claim is invalid')
  }
  return loaded
}

function readPostverifyAction(root, revision, installAttemptId) {
  const pathname = postverifyActionPath(root, revision)
  if (!existsSync(pathname)) return null
  const loaded = readJson(pathname, `preinstall revision ${revision} postverify action`, 0o400)
  const value = loaded.value
  exactKeys(value, [
    'choice', 'claimedAt', 'installAttemptId', 'payload', 'revision', 'schema', 'uid',
  ], 'preinstall postverify action claim')
  if (value.schema !== POSTVERIFY_ACTION_SCHEMA
    || !['renew', 'abandon', 'bootstrap-handoff'].includes(value.choice)
    || value.installAttemptId !== installAttemptId || value.revision !== revision
    || value.uid !== process.getuid() || !Number.isSafeInteger(value.claimedAt)) {
    fail('preinstall postverify action claim is invalid')
  }
  return loaded
}

function validateReservation(loaded, current, sequence) {
  const value = loaded.value
  if (loaded.reference.path !== componentReservationPath(dirname(loaded.reference.path), sequence)) {
    fail('preinstall component reservation path is invalid')
  }
  exactKeys(value, [
    'activity', 'component', 'gateSha256', 'installAttemptId', 'operation', 'prepared',
    'installerOwner', 'rawResultPath', 'reservedAt', 'revision', 'schema', 'sequence', 'statusIdentitySha256',
    'targetStateSha256', 'uid',
  ], 'preinstall component reservation')
  if (value.schema !== COMPONENT_RESERVATION_SCHEMA || value.sequence !== sequence
    || value.installAttemptId !== current.installAttemptId
    || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision > current.revision
    || value.uid !== process.getuid() || !Number.isSafeInteger(value.reservedAt)
    || !COMPONENTS.includes(value.component) || !['install', 'rollback'].includes(value.operation)
    || !SHA256.test(value.statusIdentitySha256 || '') || !SHA256.test(value.gateSha256 || '')
    || !SHA256.test(value.targetStateSha256 || '')
    || value.gateSha256 !== reference(managedSharedRuntimeGate,
      'shared runtime install gate', null).sha256) {
    fail('preinstall component reservation is invalid')
  }
  if (value.prepared?.path !== revisionPath(dirname(loaded.reference.path), value.revision)) {
    fail('preinstall component reservation prepared revision changed')
  }
  exactKeys(value.installerOwner, ['pid', 'startToken'], 'preinstall component installer owner')
  if (!Number.isSafeInteger(value.installerOwner.pid) || value.installerOwner.pid < 1
    || typeof value.installerOwner.startToken !== 'string'
    || value.installerOwner.startToken.length < 8 || value.installerOwner.startToken.length > 128) {
    fail('preinstall component installer owner is invalid')
  }
  sameReference(reference(value.prepared.path, 'reserved prepared receipt', 0o400),
    value.prepared, 'reserved prepared receipt')
  assertAbsolute(value.rawResultPath, 'reserved raw installer result path')
  exactKeys(value.activity, [
    'activeMediaNodes', 'activeN8nExecutions', 'activeTasks', 'attentionStale',
    'mission', 'n8n', 'pendingOutbox', 'running', 'snapshotSha256', 'waiting',
  ], 'preinstall component reservation activity')
  if (canonicalJson(value.activity.mission) !== canonicalJson(current.databases.mission)
    || canonicalJson(value.activity.n8n) !== canonicalJson(current.databases.n8n)
    || !SHA256.test(value.activity.snapshotSha256 || '')
    || ['activeMediaNodes', 'activeN8nExecutions', 'activeTasks', 'pendingOutbox', 'running', 'waiting']
      .some(name => value.activity[name] !== 0)
    || !Number.isSafeInteger(value.activity.attentionStale)
    || value.activity.attentionStale < 0) {
    fail('preinstall component reservation activity is invalid')
  }
  return value
}

function validateComponentResult(loaded, current, reservation, expectedOperation = null) {
  const value = loaded.value
  exactKeys(value, [
    'afterManifestSha256', 'backup', 'beforeManifestSha256', 'completedAt',
    'component', 'installAttemptId', 'operation', 'rawResult', 'requiresFreshRestart',
    'reservation', 'schema', 'sourceCommit', 'status', 'targetReleaseId',
  ], 'preinstall component result')
  if (value.schema !== COMPONENT_RESULT_SCHEMA || !COMPONENTS.includes(value.component)
    || !['install', 'rollback'].includes(value.operation)
    || (expectedOperation !== null && value.operation !== expectedOperation)
    || value.installAttemptId !== current.installAttemptId
    || value.sourceCommit !== current.sourceCommit
    || value.targetReleaseId !== current.target.releaseId
    || !Number.isSafeInteger(value.completedAt) || typeof value.requiresFreshRestart !== 'boolean'
    || !['applied', 'noop', 'restored'].includes(value.status)
    || !SHA256.test(value.beforeManifestSha256 || '')
    || !SHA256.test(value.afterManifestSha256 || '')) {
    fail('preinstall component result is invalid')
  }
  if (canonicalJson(value.reservation) !== canonicalJson(reservation.reference)) {
    fail('preinstall component result reservation changed')
  }
  sameReference(reference(value.rawResult.path, 'raw installer result', 0o600),
    value.rawResult, 'raw installer result')
  if (value.backup !== null) {
    exactKeys(value.backup, ['manifest', 'manifestSha256', 'path'], 'preinstall component backup')
    assertAbsolute(value.backup.path, 'preinstall component backup path')
    sameReference(reference(value.backup.manifest.path,
      'preinstall component backup manifest', 0o600), value.backup.manifest,
    'preinstall component backup manifest')
    if (value.backup.manifest.path !== join(value.backup.path, 'MANIFEST.sha256')
      || value.backup.manifestSha256 !== value.backup.manifest.sha256) {
      fail('preinstall component backup binding is invalid')
    }
  }
  return value
}

function validateComponentCancellation(loaded, current, reservation) {
  const value = loaded.value
  exactKeys(value, [
    'component', 'installAttemptId', 'observedAt', 'probe', 'rawResult', 'reason', 'reservation',
    'reservedOperation', 'schema', 'sourceCommit', 'status', 'targetReleaseId',
    'targetStateSha256',
  ], 'preinstall component cancellation')
  if (value.schema !== COMPONENT_CANCELLATION_SCHEMA
    || value.component !== reservation.value.component
    || value.reservedOperation !== reservation.value.operation
    || value.installAttemptId !== current.installAttemptId
    || value.sourceCommit !== current.sourceCommit
    || value.targetReleaseId !== current.target.releaseId
    || value.status !== 'unchanged'
    || !['installer-failed', 'invalid-raw-result', 'lease-expired'].includes(value.reason)
    || value.targetStateSha256 !== reservation.value.targetStateSha256
    || !Number.isSafeInteger(value.observedAt)
    || canonicalJson(value.reservation) !== canonicalJson(reservation.reference)) {
    fail('preinstall component cancellation is invalid')
  }
  sameReference(reference(value.probe.path, 'component cancellation probe', 0o600),
    value.probe, 'component cancellation probe')
  if (value.rawResult !== null) {
    sameReference(reference(value.rawResult.path, 'cancelled raw installer result', 0o600),
      value.rawResult, 'cancelled raw installer result')
  }
  return value
}

function loadComponentJournal(root, current) {
  const names = readdirSync(root).filter(name => COMPONENT_EVENT_FILE.test(name)).sort()
  const events = []
  const installed = new Map()
  const rolledBack = new Map()
  const cancelled = []
  let previous = null
  for (const [index, name] of names.entries()) {
    const sequence = Number(COMPONENT_EVENT_FILE.exec(name)?.[1])
    if (sequence !== index + 1) fail('preinstall component journal is not contiguous')
    const loaded = readJson(join(root, name), `preinstall component event ${sequence}`, 0o400)
    const value = loaded.value
    exactKeys(value, [
      'component', 'installAttemptId', 'operation', 'previous', 'rawResult', 'recordedAt',
      'reservation', 'result',
      'revision', 'schema', 'sequence', 'uid',
    ], 'preinstall component event')
    if (value.schema !== COMPONENT_EVENT_SCHEMA || value.sequence !== sequence
      || value.installAttemptId !== current.installAttemptId || value.uid !== process.getuid()
      || !Number.isSafeInteger(value.revision) || value.revision < 1
      || !Number.isSafeInteger(value.recordedAt)
      || canonicalJson(value.previous) !== canonicalJson(previous?.reference ?? null)) {
      fail('preinstall component event chain is invalid')
    }
    const reservation = readJson(value.reservation?.path, 'preinstall component reservation', 0o400)
    sameReference(reservation.reference, value.reservation, 'preinstall component reservation')
    validateReservation(reservation, current, sequence)
    if (value.revision !== reservation.value.revision
      || value.component !== reservation.value.component
      || ![reservation.value.operation, 'cancel'].includes(value.operation)) {
      fail('preinstall component event reservation binding changed')
    }
    const result = readJson(value.result?.path, 'preinstall component result', 0o400)
    sameReference(result.reference, value.result, 'preinstall component result')
    let resultValue
    if (value.operation === 'cancel') {
      if (value.component !== reservation.value.component) {
        fail('preinstall component cancellation event changed')
      }
      resultValue = validateComponentCancellation(result, current, reservation)
      if (canonicalJson(value.rawResult) !== canonicalJson(resultValue.rawResult)) {
        fail('preinstall component cancellation raw result changed')
      }
      cancelled.push({ event: loaded, result, reservation })
    } else {
      resultValue = validateComponentResult(result, current, reservation, value.operation)
      if (canonicalJson(value.rawResult) !== canonicalJson(resultValue.rawResult)) {
        fail('preinstall component event raw result changed')
      }
      if (resultValue.component !== value.component) fail('preinstall component event result changed')
    }
    if (value.operation === 'install') {
      if (rolledBack.size !== 0 || value.component !== COMPONENTS[installed.size]
        || installed.has(value.component)) fail('preinstall component install order is invalid')
      installed.set(value.component, { event: loaded, result })
    } else if (value.operation === 'rollback') {
      const pending = [...installed.keys()].filter(component => !rolledBack.has(component))
      const expected = pending.at(-1)
      const installation = installed.get(value.component)
      if (!installation || value.component !== expected || rolledBack.has(value.component)
        || resultValue.beforeManifestSha256 !== installation.result.value.afterManifestSha256
        || resultValue.afterManifestSha256 !== installation.result.value.beforeManifestSha256
        || canonicalJson(resultValue.backup)
          !== canonicalJson(installation.result.value.backup)) {
        fail('preinstall component rollback order or binding is invalid')
      }
      rolledBack.set(value.component, { event: loaded, result })
    }
    events.push({ ...loaded, result, reservation })
    previous = loaded
  }
  const reservationNames = readdirSync(root).filter(name => COMPONENT_RESERVATION_FILE.test(name)).sort()
  if (reservationNames.length > events.length + 1) fail('preinstall component reservations are not contiguous')
  for (const [index, name] of reservationNames.entries()) {
    if (Number(COMPONENT_RESERVATION_FILE.exec(name)?.[1]) !== index + 1) {
      fail('preinstall component reservations are not contiguous')
    }
  }
  let activeReservation = null
  if (reservationNames.length === events.length + 1) {
    const sequence = events.length + 1
    const loaded = readJson(join(root, reservationNames.at(-1)),
      'active preinstall component reservation', 0o400)
    validateReservation(loaded, current, sequence)
    activeReservation = loaded
  }
  return { events, installed, rolledBack, cancelled, head: previous?.reference ?? null, activeReservation }
}

function readFinalize(root, current, components) {
  const pathname = finalizePath(root)
  if (!existsSync(pathname)) return null
  const loaded = readJson(pathname, 'preinstall finalize claim', 0o400)
  const value = loaded.value
  exactKeys(value, [
    'choice', 'claimedAt', 'handoffCore', 'installAttemptId', 'journalHead', 'revision', 'schema', 'uid',
  ], 'preinstall finalize claim')
  if (value.schema !== FINALIZE_SCHEMA || !['bootstrap-handoff', 'rollback'].includes(value.choice)
    || value.installAttemptId !== current.installAttemptId || value.uid !== process.getuid()
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !Number.isSafeInteger(value.claimedAt)) fail('preinstall finalize claim is invalid')
  if ((value.choice === 'bootstrap-handoff' && (!value.handoffCore || typeof value.handoffCore !== 'object'))
    || (value.choice === 'rollback' && value.handoffCore !== null)) {
    fail('preinstall finalize handoff core is invalid')
  }
  const firstRollbackIndex = components.events.findIndex(event => event.value.operation === 'rollback')
  const rollbackBaseHead = firstRollbackIndex === -1
    ? components.head : components.events[firstRollbackIndex - 1]?.reference ?? null
  const expectedHead = value.choice === 'bootstrap-handoff' ? components.head : rollbackBaseHead
  if (canonicalJson(value.journalHead) !== canonicalJson(expectedHead)) {
    fail('preinstall finalize component journal head changed')
  }
  return loaded
}

function claimFinalize(state, choice, handoffCore = null) {
  if (state.components.activeReservation) {
    fail('preinstall component reservation blocks finalize')
  }
  if (state.finalize) {
    if (state.finalize.value.choice !== choice) fail('preinstall finalize CAS selected another branch')
    if (handoffCore !== null
      && canonicalJson(state.finalize.value.handoffCore) !== canonicalJson(handoffCore)) {
      fail('preinstall finalize handoff core changed')
    }
    return { ...state.finalize, resumed: true }
  }
  const claim = {
    schema: FINALIZE_SCHEMA,
    choice,
    installAttemptId: state.current.installAttemptId,
    revision: state.current.revision,
    uid: process.getuid(),
    claimedAt: nowSeconds(),
    journalHead: state.components.head,
    handoffCore,
  }
  const written = writeImmutable(finalizePath(state.root), claim, 'preinstall finalize claim')
  if (!written) fail('preinstall finalize CAS lost')
  return { value: claim, reference: written, resumed: false }
}

function loadState(attemptDirectory, options = {}) {
  const root = preinstallRoot(attemptDirectory)
  const files = revisionFiles(root)
  if (files.length === 0) fail('preinstall attempt has no prepared lease')
  for (const [index, name] of files.entries()) {
    const match = REVISION_FILE.exec(name)
    const revision = Number(match?.[1])
    if (revision !== index + 1) fail('preinstall revision chain is not contiguous')
  }
  let previous = null
  let currentLoaded
  let current
  for (const name of files) {
    const loaded = readJson(join(root, name), `preinstall revision ${name}`, 0o400)
    const value = validatePrepared(loaded, false)
    if (previous) {
      if (value.installAttemptId !== previous.value.installAttemptId
        || value.previous?.revision !== previous.value.revision
        || value.previous?.preparedSha256 !== previous.reference.sha256) {
        fail('preinstall revision CAS chain changed')
      }
    }
    previous = loaded
    currentLoaded = loaded
    current = value
  }
  for (let revision = 1; revision < current.revision; revision += 1) {
    const action = readAction(root, revision, current.installAttemptId)
    const postverifyAction = readPostverifyAction(root, revision, current.installAttemptId)
    const successor = readJson(revisionPath(root, revision + 1),
      `preinstall revision ${revision + 1}`, 0o400)
    const renewal = action?.value.choice === 'renew' ? action : postverifyAction
    if (renewal?.value.choice !== 'renew'
      || (postverifyAction && action?.value.choice !== 'verify')
      || canonicalJson(renewal.value.payload?.successor) !== canonicalJson(successor.value)) {
      fail('preinstall revision was not advanced by its CAS action')
    }
  }
  const currentAction = readAction(root, current.revision, current.installAttemptId)
  const currentPostverifyAction = readPostverifyAction(root, current.revision, current.installAttemptId)
  const verificationFile = verifiedPath(root, current.revision)
  const verified = existsSync(verificationFile)
    ? readJson(verificationFile, 'preinstall verification receipt', 0o400) : null
  if (verified) {
    const value = verified.value
    exactKeys(value, [
      'gatewayActivation', 'installAttemptId', 'payloads', 'prepared', 'readiness', 'revision',
      'runtimeConvergenceProof', 'schema', 'uid', 'verifiedAt',
    ], 'preinstall verification receipt')
    if (value.schema !== VERIFIED_SCHEMA || value.installAttemptId !== current.installAttemptId
      || value.revision !== current.revision || value.uid !== process.getuid()
      || !Number.isSafeInteger(value.verifiedAt) || value.verifiedAt < current.issuedAt
      || canonicalJson(value.prepared) !== canonicalJson(currentLoaded.reference)) {
      fail('preinstall verification receipt is invalid')
    }
    exactKeys(value.payloads, [
      'directorBrainManifestSha256', 'runtimeConvergenceProofSha256',
      'taskFlowManifestSha256', 'videoCommandManifestSha256',
    ], 'verified preinstall payloads')
    if (Object.values(value.payloads).some(item => !SHA256.test(item))) {
      fail('verified preinstall payload digests are invalid')
    }
    sameReference(reference(value.readiness.path, 'preinstall readiness report', 0o400), value.readiness,
      'preinstall readiness report')
    sameReference(reference(value.runtimeConvergenceProof.path, 'runtime convergence proof', 0o600),
      value.runtimeConvergenceProof, 'runtime convergence proof')
    exactKeys(value.gatewayActivation, ['convergence', 'gateway', 'restart'],
      'verified Gateway activation')
    sameReference(reference(value.gatewayActivation.restart.path, 'Gateway fresh restart evidence', 0o600),
      value.gatewayActivation.restart, 'Gateway fresh restart evidence')
    if (canonicalJson(value.gatewayActivation.convergence)
      !== canonicalJson(value.runtimeConvergenceProof)) fail('verified Gateway convergence changed')
    if (currentAction?.value.choice !== 'verify'
      || value.verifiedAt !== currentAction.value.claimedAt
      || canonicalJson(currentAction.value.payload?.readiness)
        !== canonicalJson(readJson(value.readiness.path, 'preinstall readiness report', 0o400).value)
      || canonicalJson(currentAction.value.payload?.runtimeConvergenceProof)
        !== canonicalJson(value.runtimeConvergenceProof)
      || canonicalJson(currentAction.value.payload?.gatewayActivation)
        !== canonicalJson(value.gatewayActivation)) {
      fail('preinstall verification action chain is invalid')
    }
  } else if (currentPostverifyAction) {
    fail('unverified preinstall lease has a postverify action')
  }
  const components = loadComponentJournal(root, current)
  const finalize = readFinalize(root, current, components)
  if (components.rolledBack.size > 0 && finalize?.value.choice !== 'rollback') {
    fail('preinstall component rollback has no matching finalize claim')
  }
  const terminal = existsSync(terminalPath(root))
    ? readJson(terminalPath(root), 'preinstall terminal claim', 0o400) : null
  if (terminal) {
    const value = terminal.value
    exactKeys(value, [
      'choice', 'claimedAt', 'handoff', 'handoffPayloadSha256', 'installAttemptId', 'prepared',
      'revision', 'schema', 'uid', 'verification',
    ], 'preinstall terminal claim')
    if (value.schema !== TERMINAL_SCHEMA || !['abandon', 'bootstrap-handoff'].includes(value.choice)
      || value.installAttemptId !== current.installAttemptId || value.revision !== current.revision
      || value.uid !== process.getuid() || !Number.isSafeInteger(value.claimedAt)
      || canonicalJson(value.prepared) !== canonicalJson(currentLoaded.reference)
      || (value.choice === 'bootstrap-handoff'
        ? canonicalJson(value.verification) !== canonicalJson(verified?.reference)
        : value.verification !== null)
      || (value.choice === 'bootstrap-handoff'
        ? canonicalJson(value.handoff) !== canonicalJson(currentPostverifyAction?.reference)
        : value.handoff !== null)
      || (value.choice === 'bootstrap-handoff'
        ? value.handoffPayloadSha256 !== sha256(canonicalJson(currentPostverifyAction?.value.payload))
        : value.handoffPayloadSha256 !== null)
      || (verified && currentPostverifyAction?.value.choice !== value.choice)) {
      fail('preinstall terminal claim is invalid')
    }
    if ((value.choice === 'bootstrap-handoff' && finalize?.value.choice !== 'bootstrap-handoff')
      || (value.choice === 'abandon' && finalize?.value.choice !== 'rollback')) {
      fail('preinstall terminal claim conflicts with finalize choice')
    }
    if (components.activeReservation) fail('terminal preinstall has an active component reservation')
  }
  if (options.requireUsable && (terminal || finalize || currentAction || currentPostverifyAction)) {
    fail('preinstall lease already selected another action or terminal branch')
  }
  if (options.requireFresh) validatePrepared(currentLoaded, true)
  const state = {
    root, current, currentLoaded, currentAction, currentPostverifyAction, verified, terminal,
    components, finalize,
  }
  if (finalize?.value.choice === 'bootstrap-handoff') {
    if (!verified) fail('bootstrap handoff finalize has no verification')
    validateHandoffCore(state, finalize.value.handoffCore)
  }
  return state
}

function transitionPaths(values) {
  return {
    intent: values['--transition-intent'],
    confirmation: values['--transition-confirmation'],
    journal: values['--transition-journal'],
    attestation: values['--transition-attestation'],
  }
}

function transitionOwnerBinding(context, transition, attemptDirectory, bootstrapClaimPath) {
  return {
    attemptDirectory: directoryReference(attemptDirectory, 'preinstall attempt directory'),
    bootstrapClaimPath,
    sourceCommit: context.sourceCommit,
    target: context.target,
    databases: context.databases,
    transition: {
      attestationSha256: transition.attestation.sha256,
      committedJournalHeadSha256: transition.committedJournalHeadSha256,
      liveCombinedSha256: transition.liveCombinedSha256,
    },
  }
}

function validateTransitionOwner(loaded, expectedBinding, expectedInstallAttemptId = null) {
  const value = loaded.value
  exactKeys(value, [
    'attemptDirectory', 'bootstrapClaimPath', 'claimedAt', 'databases', 'installAttemptId',
    'schema', 'sourceCommit', 'target', 'transition', 'uid',
  ], 'preinstall transition owner')
  if (value.schema !== OWNER_SCHEMA || value.uid !== process.getuid()
    || !UUID.test(value.installAttemptId || '') || !Number.isSafeInteger(value.claimedAt)
    || (expectedInstallAttemptId !== null && value.installAttemptId !== expectedInstallAttemptId)
    || canonicalJson({
      attemptDirectory: value.attemptDirectory,
      bootstrapClaimPath: value.bootstrapClaimPath,
      sourceCommit: value.sourceCommit,
      target: value.target,
      databases: value.databases,
      transition: value.transition,
    }) !== canonicalJson(expectedBinding)) {
    fail('workflow transition preinstall owner is bound to another attempt')
  }
  return value
}

function claimTransitionOwner(context, transition, attemptDirectory, bootstrapClaimPath) {
  const binding = transitionOwnerBinding(context, transition, attemptDirectory, bootstrapClaimPath)
  const pathname = join(dirname(transition.intent.path), 'preinstall-owner-claim.json')
  recoverImmutableCrashResidue(dirname(pathname))
  if (existsSync(pathname)) {
    const loaded = readJson(pathname, 'preinstall transition owner', 0o400)
    const value = validateTransitionOwner(loaded, binding)
    return { value, reference: loaded.reference, resumed: true }
  }
  const value = {
    schema: OWNER_SCHEMA,
    installAttemptId: randomUUID(),
    uid: process.getuid(),
    claimedAt: nowSeconds(),
    ...binding,
  }
  const written = writeImmutable(pathname, value, 'preinstall transition owner')
  if (!written) {
    const winner = readJson(pathname, 'preinstall transition owner', 0o400)
    return { value: validateTransitionOwner(winner, binding), reference: winner.reference, resumed: true }
  }
  return { value, reference: written, resumed: false }
}

function buildPrepared(
  context, transition, transitionOwner, bootstrapClaimPath, installAttemptId, revision, previous,
) {
  return {
    schema: PREPARED_SCHEMA,
    installAttemptId,
    revision,
    uid: process.getuid(),
    issuedAt: nowSeconds(),
    expiresAt: context.expiresAt,
    sourceCommit: context.sourceCommit,
    target: context.target,
    databases: context.databases,
    evidence: context.evidence,
    proof: context.proof,
    evidenceObservedAt: context.evidenceObservedAt,
    guard: context.guard,
    runtimeSnapshotSha256: context.runtimeSnapshotSha256,
    verifier: context.verifier,
    transition,
    transitionOwner,
    bootstrapClaimPath,
    controllerSha256: reference(scriptPath, 'legacy preinstall controller', null).sha256,
    previous,
  }
}

function prepare(values) {
  const attemptDirectory = values['--attempt-dir']
  const root = preinstallRoot(attemptDirectory, true)
  const context = evidenceContext(values['--evidence'], values['--proof'], values['--source-commit'])
  const transition = verifyTransition(transitionPaths(values))
  assertTransitionMatches(transition, context)
  const claimPath = values['--transition-claim']
  if (claimPath !== join(dirname(transition.intent.path), 'bootstrap-claim.json')) {
    fail('bootstrap claim path is not the transition fixed sidecar')
  }
  assertNoSymlink(claimPath, 'future bootstrap claim', true)
  if (existsSync(claimPath)) fail('workflow transition is already claimed for bootstrap')
  const owner = claimTransitionOwner(context, transition, attemptDirectory, claimPath)
  if (revisionFiles(root).length !== 0 || existsSync(terminalPath(root))) {
    const state = loadState(attemptDirectory)
    if (state.current.revision !== 1 || state.current.installAttemptId !== owner.value.installAttemptId
      || state.currentAction || state.currentPostverifyAction || state.verified || state.terminal
      || canonicalJson(state.current.target) !== canonicalJson(context.target)
      || canonicalJson(state.current.databases) !== canonicalJson(context.databases)
      || canonicalJson(state.current.evidence) !== canonicalJson(context.evidence)
      || canonicalJson(state.current.proof) !== canonicalJson(context.proof)
      || canonicalJson(state.current.transitionOwner) !== canonicalJson(owner.reference)
      || state.current.transition.committedJournalHeadSha256
        !== transition.committedJournalHeadSha256
      || state.current.transition.liveCombinedSha256 !== transition.liveCombinedSha256) {
      fail('preinstall attempt already exists with another operation')
    }
    process.stdout.write(`${canonicalJson({
      phase: 'INSTALL_PREPARED', installAttemptId: state.current.installAttemptId,
      revision: 1, expiresAt: state.current.expiresAt, prepared: state.currentLoaded.reference,
      resumed: true,
    })}\n`)
    return
  }
  const receipt = buildPrepared(
    context, transition, owner.reference, claimPath, owner.value.installAttemptId, 1, null,
  )
  const pathname = revisionPath(root, 1)
  const written = writeImmutable(pathname, receipt, 'initial preinstall prepared receipt')
  if (!written) fail('another preinstall attempt won the initial CAS')
  commandFailpoint('after-prepare-publish')
  process.stdout.write(`${canonicalJson({
    phase: 'INSTALL_PREPARED', installAttemptId: receipt.installAttemptId,
    revision: 1, expiresAt: receipt.expiresAt, prepared: written,
  })}\n`)
}

function renew(values) {
  const state = loadState(values['--attempt-dir'])
  const expectedRevision = Number(values['--expected-revision'])
  if (values['--install-attempt-id'] === state.current.installAttemptId
    && expectedRevision === state.current.revision - 1) {
    const action = readAction(state.root, expectedRevision, state.current.installAttemptId)
    const postverifyAction = readPostverifyAction(
      state.root, expectedRevision, state.current.installAttemptId,
    )
    const renewal = action?.value.choice === 'renew' ? action : postverifyAction
    if (renewal?.value.choice === 'renew'
      && canonicalJson(renewal.value.payload?.successor) === canonicalJson(state.current)) {
      process.stdout.write(`${canonicalJson({
        phase: 'INSTALL_PREPARED', installAttemptId: state.current.installAttemptId,
        revision: state.current.revision, expiresAt: state.current.expiresAt,
        prepared: state.currentLoaded.reference,
        superseded: reference(revisionPath(state.root, expectedRevision),
          'superseded preinstall prepared receipt', 0o400),
        resumed: true,
      })}\n`)
      return
    }
  }
  if (values['--install-attempt-id'] !== state.current.installAttemptId
    || expectedRevision !== state.current.revision) {
    fail('preinstall renew CAS lost')
  }
  if (state.finalize) fail('preinstall renew CAS lost to finalize branch')
  if (state.components.activeReservation) fail('preinstall renew is blocked by a component reservation')
  if (state.terminal) fail('preinstall renew CAS lost to a terminal branch')
  const pendingRenewal = state.verified ? state.currentPostverifyAction : state.currentAction
  if (pendingRenewal) {
    if (pendingRenewal.value.choice !== 'renew') fail('preinstall renew CAS lost to another action')
    const successor = pendingRenewal.value.payload?.successor
    if (!successor || successor.installAttemptId !== state.current.installAttemptId
      || successor.revision !== state.current.revision + 1) fail('pending preinstall renewal is invalid')
    const pathname = revisionPath(state.root, successor.revision)
    const written = writeImmutable(pathname, successor, 'renewed preinstall prepared receipt')
    if (!written) {
      const existing = readJson(pathname, 'renewed preinstall prepared receipt', 0o400)
      if (canonicalJson(existing.value) !== canonicalJson(successor)) {
        fail('pending preinstall renewal successor changed')
      }
    }
    const next = loadState(values['--attempt-dir'])
    process.stdout.write(`${canonicalJson({
      phase: 'INSTALL_PREPARED', installAttemptId: next.current.installAttemptId,
      revision: next.current.revision, expiresAt: next.current.expiresAt,
      prepared: next.currentLoaded.reference, superseded: state.currentLoaded.reference,
      resumed: true,
    })}\n`)
    return
  }
  const context = evidenceContext(values['--evidence'], values['--proof'], state.current.sourceCommit)
  const transition = verifyTransition({
    intent: state.current.transition.intent.path,
    confirmation: state.current.transition.confirmation.path,
    journal: state.current.transition.journal.path,
    attestation: state.current.transition.attestation.path,
  })
  assertTransitionMatches(transition, context)
  if (canonicalJson(context.target) !== canonicalJson(state.current.target)
    || canonicalJson(context.databases) !== canonicalJson(state.current.databases)
    || transition.committedJournalHeadSha256 !== state.current.transition.committedJournalHeadSha256
    || transition.liveCombinedSha256 !== state.current.transition.liveCombinedSha256
    || context.evidenceObservedAt <= state.current.evidenceObservedAt) {
    fail('preinstall renewal target, databases, transition, or evidence did not remain monotonic')
  }
  const revision = state.current.revision + 1
  const receipt = buildPrepared(
    context, transition, state.current.transitionOwner, state.current.bootstrapClaimPath,
    state.current.installAttemptId, revision, {
    installAttemptId: state.current.installAttemptId,
    revision: state.current.revision,
    preparedSha256: state.currentLoaded.reference.sha256,
    },
  )
  const action = {
    schema: state.verified ? POSTVERIFY_ACTION_SCHEMA : ACTION_SCHEMA,
    choice: 'renew',
    installAttemptId: state.current.installAttemptId,
    revision: state.current.revision,
    uid: process.getuid(),
    claimedAt: nowSeconds(),
    payload: { successor: receipt },
  }
  const renewalActionPath = state.verified
    ? postverifyActionPath(state.root, state.current.revision)
    : actionPath(state.root, state.current.revision)
  if (state.verified && state.currentAction?.value.choice !== 'verify') {
    fail('verified preinstall action chain is invalid')
  }
  if (!writeImmutable(renewalActionPath, action,
    'preinstall renewal action')) fail('preinstall renew CAS lost')
  const written = writeImmutable(revisionPath(state.root, revision), receipt,
    'renewed preinstall prepared receipt')
  if (!written) fail('preinstall renewal successor already exists')
  commandFailpoint('after-renew-publish')
  process.stdout.write(`${canonicalJson({
    phase: 'INSTALL_PREPARED', installAttemptId: receipt.installAttemptId,
    revision, expiresAt: receipt.expiresAt, prepared: written,
    superseded: state.currentLoaded.reference, resumed: false,
  })}\n`)
}

function runReadiness(state, values) {
  const verifier = managedPath('AIWORKER_TEST_LEGACY_PREINSTALL_READINESS_VERIFIER', managedReadinessVerifier)
  const result = runJson(process.execPath, [
    verifier,
    '--repository-root', repositoryRoot,
    '--releases-root', values['--releases-root'],
    '--release-id', state.current.target.releaseId,
    '--release-root', state.current.target.releaseRoot,
    '--profile-state-root', values['--profile-state-root'],
    '--workspace-root', values['--workspace-root'],
    '--runtime-convergence-proof', values['--runtime-convergence-proof'],
    '--repository-release-mode', 'head',
    '--verification-phase', 'pre-bootstrap',
  ], 'director/video preinstall readiness')
  if (result?.schema !== READINESS_SCHEMA || result.phase !== 'pre-bootstrap' || result.ok !== true
    || result.commit !== state.current.sourceCommit
    || result.app?.releaseId !== state.current.target.releaseId
    || result.app?.root !== state.current.target.releaseRoot
    || result.app?.manifestSha256 !== state.current.target.manifestSha256
    || result.contracts?.directorWork !== true || result.contracts?.outboxClosure !== true
    || result.contracts?.sessionScopedRuntimeConvergence !== true
    || !result.payloads?.videoCommand?.manifestSha256
    || !result.payloads?.taskFlow?.manifestSha256
    || !result.payloads?.directorBrain?.manifestSha256
    || result.runtimeConvergence?.schema !== 'video-autoworker-openclaw-runtime-convergence-proof/v1') {
    fail('director/video preinstall readiness result is invalid')
  }
  return result
}

function gatewayActivationEvidence(restartPath, convergencePath) {
  const restart = readJson(restartPath, 'Gateway fresh restart evidence', 0o600)
  const convergence = readJson(convergencePath, 'runtime convergence proof', 0o600)
  const restartValue = restart.value
  const proof = convergence.value
  if (restartValue?.schema !== 'video-autoworker-legacy-preinstall-protected-pids/v1'
    || restartValue.phase !== 'restarted'
    || !Number.isSafeInteger(restartValue.beforePid) || restartValue.beforePid < 1
    || !Number.isSafeInteger(restartValue.afterPid) || restartValue.afterPid < 1
    || restartValue.beforePid === restartValue.afterPid
    || proof?.schema !== 'video-autoworker-openclaw-runtime-convergence-proof/v1'
    || proof.runtime?.gateway?.pid !== restartValue.afterPid
    || !SHA256.test(proof.runtime?.toolInventory?.sha256 || '')
    || !SHA256.test(proof.runtime?.effectiveToolInventory?.sha256 || '')
    || !Array.isArray(proof.runtime?.plugins) || proof.runtime.plugins.length === 0) {
    fail('Gateway activation evidence is invalid')
  }
  return {
    restart: restart.reference,
    convergence: convergence.reference,
    gateway: {
      pid: restartValue.afterPid,
      catalogSha256: proof.runtime.toolInventory.sha256,
      effectiveSha256: proof.runtime.effectiveToolInventory.sha256,
      pluginTreesSha256: sha256(canonicalJson(proof.runtime.plugins)),
    },
  }
}

function completeVerification(state, action, resumed) {
  const readiness = action.value.payload?.readiness
  const runtimeConvergenceProof = action.value.payload?.runtimeConvergenceProof
  const gatewayActivation = action.value.payload?.gatewayActivation
  if (!readiness || !runtimeConvergenceProof || !gatewayActivation) {
    fail('pending preinstall verification is invalid')
  }
  const readinessOutput = reportPath(state.root, state.current.revision)
  const reportWritten = writeImmutable(readinessOutput, readiness, 'preinstall readiness report')
  const readinessReference = reportWritten
    || reference(readinessOutput, 'preinstall readiness report', 0o400)
  if (!reportWritten) {
    const existing = readJson(readinessOutput, 'preinstall readiness report', 0o400)
    if (canonicalJson(existing.value) !== canonicalJson(readiness)) {
      fail('preinstall readiness report changed during retry')
    }
  }
  sameReference(reference(runtimeConvergenceProof.path, 'runtime convergence proof', 0o600),
    runtimeConvergenceProof, 'runtime convergence proof')
  const receipt = {
    schema: VERIFIED_SCHEMA,
    installAttemptId: state.current.installAttemptId,
    revision: state.current.revision,
    uid: process.getuid(),
    verifiedAt: action.value.claimedAt,
    prepared: state.currentLoaded.reference,
    readiness: readinessReference,
    runtimeConvergenceProof,
    gatewayActivation,
    payloads: {
      videoCommandManifestSha256: readiness.payloads.videoCommand.manifestSha256,
      taskFlowManifestSha256: readiness.payloads.taskFlow.manifestSha256,
      directorBrainManifestSha256: readiness.payloads.directorBrain.manifestSha256,
      runtimeConvergenceProofSha256: runtimeConvergenceProof.sha256,
    },
  }
  const written = writeImmutable(verifiedPath(state.root, state.current.revision), receipt,
    'preinstall verification receipt')
  let verified = written
  if (!verified) {
    const existing = readJson(verifiedPath(state.root, state.current.revision),
      'preinstall verification receipt', 0o400)
    if (canonicalJson(existing.value) !== canonicalJson(receipt)) {
      fail('preinstall verification receipt changed during retry')
    }
    verified = existing.reference
  }
  commandFailpoint('after-verify-publish')
  process.stdout.write(`${canonicalJson({
    phase: 'INSTALL_VERIFIED', installAttemptId: state.current.installAttemptId,
    revision: state.current.revision, expiresAt: state.current.expiresAt,
    verified, resumed,
  })}\n`)
}

function verify(values) {
  const state = loadState(values['--attempt-dir'])
  if (values['--install-attempt-id'] !== state.current.installAttemptId
    || Number(values['--expected-revision']) !== state.current.revision) fail('preinstall verify CAS lost')
  if (state.terminal) fail('preinstall verify CAS lost to a terminal branch')
  if (state.components.activeReservation) fail('preinstall verify is blocked by a component reservation')
  if (state.finalize || state.components.rolledBack.size !== 0
    || state.components.installed.size !== COMPONENTS.length) {
    fail('preinstall verify requires all component installs and no finalize branch')
  }
  if (state.verified) {
    process.stdout.write(`${canonicalJson({
      phase: 'INSTALL_VERIFIED', installAttemptId: state.current.installAttemptId,
      revision: state.current.revision, expiresAt: state.current.expiresAt,
      verified: state.verified.reference, resumed: true,
    })}\n`)
    return
  }
  if (state.currentAction) {
    if (state.currentAction.value.choice !== 'verify') fail('preinstall verify CAS lost to another action')
    const expectedProof = state.currentAction.value.payload?.runtimeConvergenceProof
    const actualProof = reference(values['--runtime-convergence-proof'], 'runtime convergence proof', 0o600)
    if (canonicalJson(actualProof) !== canonicalJson(expectedProof)) {
      fail('preinstall verify retry uses another runtime convergence proof')
    }
    const expectedRestart = state.currentAction.value.payload?.gatewayActivation?.restart
    const actualRestart = reference(values['--gateway-restart-evidence'],
      'Gateway fresh restart evidence', 0o600)
    if (canonicalJson(actualRestart) !== canonicalJson(expectedRestart)) {
      fail('preinstall verify retry uses another Gateway restart evidence')
    }
    completeVerification(state, state.currentAction, true)
    return
  }
  validatePrepared(state.currentLoaded, true)
  const currentContext = evidenceContext(
    state.current.evidence.path, state.current.proof.path, state.current.sourceCommit,
  )
  if (currentContext.runtimeSnapshotSha256 !== state.current.runtimeSnapshotSha256) {
    fail('preinstall runtime snapshot changed before readiness verification')
  }
  const readiness = runReadiness(state, values)
  const afterReadiness = evidenceContext(
    state.current.evidence.path, state.current.proof.path, state.current.sourceCommit,
  )
  if (afterReadiness.runtimeSnapshotSha256 !== state.current.runtimeSnapshotSha256
    || canonicalJson(afterReadiness.databases) !== canonicalJson(state.current.databases)
    || canonicalJson(afterReadiness.target) !== canonicalJson(state.current.target)) {
    fail('preinstall live binding changed during readiness verification')
  }
  const runtimeConvergenceProof = reference(
    values['--runtime-convergence-proof'], 'runtime convergence proof', 0o600,
  )
  const gatewayActivation = gatewayActivationEvidence(
    values['--gateway-restart-evidence'], values['--runtime-convergence-proof'],
  )
  const action = {
    schema: ACTION_SCHEMA,
    choice: 'verify',
    installAttemptId: state.current.installAttemptId,
    revision: state.current.revision,
    uid: process.getuid(),
    claimedAt: nowSeconds(),
    payload: { readiness, runtimeConvergenceProof, gatewayActivation },
  }
  if (action.claimedAt >= state.current.expiresAt) fail('preinstall lease expired during readiness verification')
  const written = writeImmutable(actionPath(state.root, state.current.revision), action,
    'preinstall verification action')
  if (!written) fail('preinstall verify CAS lost')
  completeVerification(state, { value: action, reference: written }, false)
}

function claimTerminal(attemptDirectory, installAttemptId, expectedRevision, choice) {
  let state = loadState(attemptDirectory, { requireUsable: false })
  if (state.components.activeReservation) {
    fail('preinstall terminal action is blocked by a component reservation')
  }
  if (state.terminal) {
    if (state.terminal.value.choice === 'abandon' && existsSync(state.current.bootstrapClaimPath)) {
      fail('abandoned preinstall attempt conflicts with an existing bootstrap claim')
    }
    if (state.terminal.value.choice === choice
      && state.terminal.value.installAttemptId === installAttemptId
      && state.terminal.value.revision === expectedRevision) return { state, resumed: true }
    fail('preinstall terminal CAS selected another branch')
  }
  assertNoSymlink(state.current.bootstrapClaimPath, 'future bootstrap claim', true)
  if (existsSync(state.current.bootstrapClaimPath)) {
    fail('workflow transition was claimed without a matching preinstall handoff')
  }
  if (state.current.installAttemptId !== installAttemptId
    || state.current.revision !== expectedRevision) fail('preinstall terminal CAS lost')
  if (!state.finalize) {
    if (choice !== 'abandon') fail('bootstrap handoff requires a prior finalize claim')
    claimFinalize(state, 'rollback')
    state = loadState(attemptDirectory, { requireUsable: false })
  }
  if ((choice === 'bootstrap-handoff' && state.finalize.value.choice !== 'bootstrap-handoff')
    || (choice === 'abandon' && state.finalize.value.choice !== 'rollback')) {
    fail('preinstall terminal CAS lost to another finalize branch')
  }
  if (choice === 'bootstrap-handoff'
    && (state.components.installed.size !== COMPONENTS.length
      || state.components.rolledBack.size !== 0)) {
    fail('bootstrap handoff requires all component installs')
  }
  if (choice === 'abandon'
    && state.components.rolledBack.size !== state.components.installed.size) {
    fail('preinstall abandon requires complete reverse rollback')
  }
  if (choice === 'bootstrap-handoff' && !state.verified) {
    fail('bootstrap handoff requires INSTALL_VERIFIED')
  }
  if (!state.verified) {
    if (choice !== 'abandon') fail('unverified preinstall can only be abandoned')
    if (state.currentAction) {
      if (state.currentAction.value.choice !== 'abandon') {
        fail('preinstall terminal CAS lost to another action')
      }
    } else {
      const action = {
        schema: ACTION_SCHEMA,
        choice: 'abandon',
        installAttemptId,
        revision: expectedRevision,
        uid: process.getuid(),
        claimedAt: nowSeconds(),
        payload: null,
      }
      if (!writeImmutable(actionPath(state.root, expectedRevision), action,
        'preinstall abandon action')) fail('preinstall terminal CAS lost')
    }
  } else {
    if (state.currentAction?.value.choice !== 'verify') {
      fail('verified preinstall action chain is invalid')
    }
    if (state.currentPostverifyAction) {
      if (state.currentPostverifyAction.value.choice !== choice) {
        fail('preinstall terminal CAS lost to another postverify action')
      }
    } else {
      const action = {
        schema: POSTVERIFY_ACTION_SCHEMA,
        choice,
        installAttemptId,
        revision: expectedRevision,
        uid: process.getuid(),
        claimedAt: nowSeconds(),
        payload: null,
      }
      if (!writeImmutable(postverifyActionPath(state.root, expectedRevision), action,
        'preinstall terminal postverify action')) fail('preinstall terminal CAS lost')
    }
  }
  const claim = {
    schema: TERMINAL_SCHEMA,
    choice,
    installAttemptId,
    revision: expectedRevision,
    uid: process.getuid(),
    claimedAt: nowSeconds(),
    prepared: state.currentLoaded.reference,
    verification: choice === 'bootstrap-handoff' ? state.verified.reference : null,
    handoff: choice === 'bootstrap-handoff' ? state.currentPostverifyAction.reference : null,
    handoffPayloadSha256: choice === 'bootstrap-handoff'
      ? sha256(canonicalJson(state.currentPostverifyAction.value.payload)) : null,
  }
  const written = writeImmutable(terminalPath(state.root), claim, 'preinstall terminal claim')
  if (!written) {
    const winner = loadState(attemptDirectory)
    if (winner.terminal?.value.choice !== choice
      || winner.terminal.value.installAttemptId !== installAttemptId
      || winner.terminal.value.revision !== expectedRevision) {
      fail('preinstall terminal CAS selected another branch')
    }
    return { state: winner, resumed: true }
  }
  commandFailpoint('after-terminal-publish')
  const claimedState = loadState(attemptDirectory)
  if (choice === 'abandon' && existsSync(state.current.bootstrapClaimPath)) {
    fail('bootstrap claim raced with preinstall abandon')
  }
  return { state: claimedState, resumed: false }
}

function abandon(values) {
  const claimed = claimTerminal(
    values['--attempt-dir'], values['--install-attempt-id'],
    Number(values['--expected-revision']), 'abandon',
  )
  process.stdout.write(`${canonicalJson({
    phase: 'INSTALL_ABANDONED', installAttemptId: values['--install-attempt-id'],
    revision: Number(values['--expected-revision']), terminal: claimed.state.terminal.reference,
    resumed: claimed.resumed,
  })}\n`)
}

function validateFinalGateReceipt(
  state, value, requireFresh = false, expectedFinalize = state.finalize?.reference ?? null,
) {
  exactKeys(value, [
    'activity', 'finalize', 'installAttemptId', 'mode', 'observedAt', 'revision', 'schema',
    'sourceCommit', 'statusIdentitySha256', 'targetReleaseId', 'verifier',
  ], 'shared runtime final gate receipt')
  if (value.schema !== FINAL_GATE_SCHEMA || value.mode !== 'legacy-preinstall'
    || value.installAttemptId !== state.current.installAttemptId
    || value.revision !== state.current.revision
    || value.sourceCommit !== state.current.sourceCommit
    || value.targetReleaseId !== state.current.target.releaseId
    || !Number.isSafeInteger(value.observedAt)
    || !SHA256.test(value.statusIdentitySha256 || '')) {
    fail('shared runtime final gate receipt is invalid')
  }
  if (canonicalJson(value.finalize) !== canonicalJson(expectedFinalize)) {
    fail('shared runtime final gate finalize binding changed')
  }
  sameReference(reference(value.verifier.path, 'shared runtime final gate verifier', null),
    value.verifier, 'shared runtime final gate verifier')
  const expectedGate = managedPath('AIWORKER_TEST_LEGACY_PREINSTALL_FINAL_GATE', managedSharedRuntimeGate)
  if (value.verifier.sha256 !== reference(expectedGate,
    'shared runtime install gate', null).sha256) fail('shared runtime final gate verifier changed')
  exactKeys(value.activity, [
    'activeMediaNodes', 'activeN8nExecutions', 'activeTasks', 'attentionStale',
    'mission', 'n8n', 'pendingOutbox', 'running', 'snapshotSha256', 'waiting',
  ], 'shared runtime final gate activity')
  if (canonicalJson(value.activity.mission) !== canonicalJson(state.current.databases.mission)
    || canonicalJson(value.activity.n8n) !== canonicalJson(state.current.databases.n8n)
    || !SHA256.test(value.activity.snapshotSha256 || '')
    || ['activeMediaNodes', 'activeN8nExecutions', 'activeTasks', 'pendingOutbox', 'running', 'waiting']
      .some(name => value.activity[name] !== 0)
    || !Number.isSafeInteger(value.activity.attentionStale)
    || value.activity.attentionStale < 0) fail('shared runtime final gate is not idle')
  const snapshot = { ...value.activity }
  delete snapshot.snapshotSha256
  if (value.activity.snapshotSha256 !== sha256(canonicalJson(snapshot))) {
    fail('shared runtime final gate snapshot digest changed')
  }
  if (requireFresh) {
    const now = nowSeconds()
    if (value.observedAt > now + 5 || now - value.observedAt > 30) {
      fail('shared runtime final gate receipt is stale')
    }
  }
  return value
}

function runFinalGate(state, videoBatchRoot) {
  validatePrepared(state.currentLoaded, state.finalize?.value.choice !== 'bootstrap-handoff')
  if (state.components.activeReservation) fail('active component reservation blocks final gate')
  const gate = managedPath('AIWORKER_TEST_LEGACY_PREINSTALL_FINAL_GATE', managedSharedRuntimeGate)
  const receipt = runJson(process.execPath, [
    gate,
    '--mission-control-db-path', state.current.databases.mission.path,
    '--n8n-db-path', state.current.databases.n8n.path,
    '--legacy-preinstall-attempt-dir', dirname(state.root),
    '--video-batch-root', videoBatchRoot,
    '--expected-source-commit', state.current.sourceCommit,
    '--expected-release-id', state.current.target.releaseId,
    '--phase', 'final',
    ...(state.finalize ? ['--expected-finalize-sha256', state.finalize.reference.sha256] : []),
  ], 'shared runtime final gate')
  const expectedStatusIdentitySha256 = sha256(statusIdentity(
    inspectPreinstallAttempt(dirname(state.root), { verifyLive: false }),
  ))
  if (receipt?.statusIdentitySha256 !== expectedStatusIdentitySha256) {
    fail('shared runtime final gate status identity changed')
  }
  return validateFinalGateReceipt(state, {
    ...receipt,
    verifier: reference(gate, 'shared runtime final gate verifier', null),
  }, true)
}

function buildHandoffCore(state, readiness, initialFinalGate) {
  return {
    componentJournalHead: state.components.head,
    verification: state.verified.reference,
    readiness: readiness.readiness,
    runtimeConvergenceProof: readiness.runtimeConvergenceProof,
    freshReadinessSha256: readiness.freshReadinessSha256,
    payloads: readiness.payloads,
    gatewayActivation: state.verified.value.gatewayActivation,
    initialFinalGate,
    binding: {
      sourceCommit: state.current.sourceCommit,
      target: state.current.target,
      databases: state.current.databases,
      transition: {
        attestationSha256: state.current.transition.attestation.sha256,
        committedJournalHeadSha256: state.current.transition.committedJournalHeadSha256,
        liveCombinedSha256: state.current.transition.liveCombinedSha256,
      },
    },
  }
}

function handoffPayload(state, finalGate) {
  return {
    ...state.finalize.value.handoffCore,
    finalize: state.finalize.reference,
    finalGate,
  }
}

function validateHandoffCore(state, core) {
  exactKeys(core, [
    'binding', 'componentJournalHead', 'freshReadinessSha256', 'gatewayActivation',
    'initialFinalGate', 'payloads', 'readiness', 'runtimeConvergenceProof', 'verification',
  ], 'preinstall bootstrap handoff core')
  if (!SHA256.test(core.freshReadinessSha256 || '')
    || canonicalJson(core.verification) !== canonicalJson(state.verified.reference)
    || canonicalJson(core.componentJournalHead) !== canonicalJson(state.components.head)
    || canonicalJson(core.readiness) !== canonicalJson(state.verified.value.readiness)
    || canonicalJson(core.gatewayActivation) !== canonicalJson(state.verified.value.gatewayActivation)
    || canonicalJson(core.binding) !== canonicalJson({
      sourceCommit: state.current.sourceCommit,
      target: state.current.target,
      databases: state.current.databases,
      transition: {
        attestationSha256: state.current.transition.attestation.sha256,
        committedJournalHeadSha256: state.current.transition.committedJournalHeadSha256,
        liveCombinedSha256: state.current.transition.liveCombinedSha256,
      },
    })
    || canonicalJson(core.payloads) !== canonicalJson({
      videoCommandManifestSha256: state.verified.value.payloads.videoCommandManifestSha256,
      taskFlowManifestSha256: state.verified.value.payloads.taskFlowManifestSha256,
      directorBrainManifestSha256: state.verified.value.payloads.directorBrainManifestSha256,
    })) fail('preinstall bootstrap handoff core changed')
  validateFinalGateReceipt(state, core.initialFinalGate, false, null)
  return core
}

function validateHandoffPayload(state, payload, runtimeConvergenceProofPath) {
  exactKeys(payload, [
    'binding', 'componentJournalHead', 'finalGate', 'finalize', 'freshReadinessSha256',
    'gatewayActivation', 'initialFinalGate', 'payloads', 'readiness', 'runtimeConvergenceProof', 'verification',
  ], 'preinstall bootstrap handoff payload')
  validateHandoffCore(state, state.finalize.value.handoffCore)
  if (canonicalJson(payload) !== canonicalJson(handoffPayload(state, payload.finalGate))
    || !SHA256.test(payload.freshReadinessSha256 || '')
    || canonicalJson(payload.verification) !== canonicalJson(state.verified.reference)
    || canonicalJson(payload.finalize) !== canonicalJson(state.finalize?.reference)
    || canonicalJson(payload.componentJournalHead) !== canonicalJson(state.components.head)
    || canonicalJson(payload.readiness) !== canonicalJson(state.verified.value.readiness)
    || canonicalJson(payload.gatewayActivation)
      !== canonicalJson(state.verified.value.gatewayActivation)
    || canonicalJson(payload.binding) !== canonicalJson({
      sourceCommit: state.current.sourceCommit,
      target: state.current.target,
      databases: state.current.databases,
      transition: {
        attestationSha256: state.current.transition.attestation.sha256,
        committedJournalHeadSha256: state.current.transition.committedJournalHeadSha256,
        liveCombinedSha256: state.current.transition.liveCombinedSha256,
      },
    })
    || canonicalJson(payload.payloads) !== canonicalJson({
      videoCommandManifestSha256: state.verified.value.payloads.videoCommandManifestSha256,
      taskFlowManifestSha256: state.verified.value.payloads.taskFlowManifestSha256,
      directorBrainManifestSha256: state.verified.value.payloads.directorBrainManifestSha256,
    })) {
    fail('preinstall bootstrap handoff payload changed')
  }
  const proof = reference(runtimeConvergenceProofPath, 'fresh runtime convergence proof', 0o600)
  if (canonicalJson(proof) !== canonicalJson(payload.runtimeConvergenceProof)) {
    fail('preinstall bootstrap handoff retry uses another runtime convergence proof')
  }
  validateFinalGateReceipt(state, payload.finalGate, false)
  return payload
}

export function claimBootstrapHandoff({
  attemptDirectory, installAttemptId, expectedRevision, runtimeConvergenceProofPath,
  videoBatchRoot,
}) {
  let state = loadState(attemptDirectory)
  if (!state.verified || state.current.installAttemptId !== installAttemptId
    || state.current.revision !== expectedRevision) {
    fail('preinstall bootstrap handoff CAS lost')
  }
  if (state.terminal) {
    validateHandoffPayload(state, state.currentPostverifyAction?.value.payload,
      runtimeConvergenceProofPath)
    const claimed = claimTerminal(attemptDirectory, installAttemptId, expectedRevision,
      'bootstrap-handoff')
    return {
      ...claimed,
      readiness: {
        installAttemptId,
        revision: expectedRevision,
        terminal: claimed.state.terminal.reference,
        ...claimed.state.currentPostverifyAction.value.payload,
      },
    }
  }
  if (state.currentPostverifyAction) {
    if (state.currentPostverifyAction.value.choice !== 'bootstrap-handoff') {
      fail('preinstall bootstrap handoff CAS lost to another postverify action')
    }
    validateHandoffPayload(state, state.currentPostverifyAction.value.payload,
      runtimeConvergenceProofPath)
    if (state.finalize?.value.choice !== 'bootstrap-handoff') {
      fail('preinstall bootstrap handoff action has no matching finalize claim')
    }
  } else {
    const readiness = reverifyPreinstallReadiness(attemptDirectory, runtimeConvergenceProofPath)
    state = loadState(attemptDirectory)
    if (!state.finalize) {
      const initialFinalGate = runFinalGate(state, videoBatchRoot)
      state = loadState(attemptDirectory)
      const finalized = claimFinalize(
        state, 'bootstrap-handoff', buildHandoffCore(state, readiness, initialFinalGate),
      )
      if (!finalized.resumed) commandFailpoint('after-handoff-finalize-publish')
    } else if (state.finalize.value.choice !== 'bootstrap-handoff') {
      fail('preinstall bootstrap handoff CAS lost to another finalize branch')
    }
    state = loadState(attemptDirectory)
    validateHandoffCore(state, state.finalize.value.handoffCore)
    const freshReadiness = reverifyPreinstallReadiness(attemptDirectory, runtimeConvergenceProofPath)
    if (canonicalJson(freshReadiness.payloads)
      !== canonicalJson(state.finalize.value.handoffCore.payloads)
      || canonicalJson(freshReadiness.runtimeConvergenceProof)
        !== canonicalJson(state.finalize.value.handoffCore.runtimeConvergenceProof)) {
      fail('preinstall bootstrap handoff recovery readiness changed')
    }
    const finalGate = runFinalGate(state, videoBatchRoot)
    state = loadState(attemptDirectory)
    const action = {
      schema: POSTVERIFY_ACTION_SCHEMA,
      choice: 'bootstrap-handoff',
      installAttemptId,
      revision: expectedRevision,
      uid: process.getuid(),
      claimedAt: nowSeconds(),
      payload: handoffPayload(state, finalGate),
    }
    if (!writeImmutable(postverifyActionPath(state.root, expectedRevision), action,
      'preinstall bootstrap handoff action')) {
      fail('preinstall bootstrap handoff CAS lost')
    }
  }
  const claimed = claimTerminal(attemptDirectory, installAttemptId, expectedRevision,
    'bootstrap-handoff')
  return {
    ...claimed,
    readiness: {
      installAttemptId,
      revision: expectedRevision,
      terminal: claimed.state.terminal.reference,
      ...claimed.state.currentPostverifyAction.value.payload,
    },
  }
}

function statusIdentity(value) {
  return canonicalJson({
    phase: value.phase,
    installAttemptId: value.installAttemptId,
    revision: value.revision,
    prepared: value.prepared,
    verification: value.verification,
    terminal: value.terminal,
    finalize: value.finalize,
    components: value.components,
    bindings: value.bindings,
  })
}

function reserveComponent(values) {
  let state = loadState(values['--attempt-dir'])
  const installAttemptId = values['--install-attempt-id']
  const revision = Number(values['--expected-revision'])
  const component = values['--component']
  const operation = values['--operation']
  const rawResultPath = values['--raw-result-output']
  const targetStateSha256 = values['--target-state-sha256']
  if (!SHA256.test(targetStateSha256 || '')) fail('reserved target state digest is invalid')
  const installerPid = Number(values['--installer-pid'])
  const installerStartToken = values['--installer-start-token']
  if (!Number.isSafeInteger(installerPid) || installerPid < 1
    || typeof installerStartToken !== 'string' || installerStartToken.length < 8
    || installerStartToken.length > 128
    || processStartToken(installerPid) !== installerStartToken) {
    fail('reserved installer owner is not alive or changed')
  }
  if (state.current.installAttemptId !== installAttemptId || state.current.revision !== revision) {
    fail('preinstall component reservation CAS lost')
  }
  const sequence = state.components.events.length + 1
  const existing = state.components.activeReservation
  if (existing) {
    const value = existing.value
    if (value.component !== component || value.operation !== operation
      || value.rawResultPath !== rawResultPath
      || value.targetStateSha256 !== targetStateSha256
      || value.statusIdentitySha256 !== values['--status-identity-sha256']) {
      fail('preinstall component reservation belongs to another operation')
    }
    process.stdout.write(`${canonicalJson({
      phase: 'COMPONENT_RESERVED', component, operation,
      reservation: existing.reference, resumed: true,
    })}\n`)
    return
  }
  if (state.terminal || state.currentPostverifyAction) {
    fail('preinstall component reservation is unavailable after a terminal action')
  }
  const observedStatus = inspectPreinstallAttempt(values['--attempt-dir'], { verifyLive: false })
  if (sha256(statusIdentity(observedStatus)) !== values['--status-identity-sha256']) {
    fail('preinstall component reservation status identity changed')
  }
  const expected = operation === 'install'
    ? COMPONENTS[state.components.installed.size]
    : [...state.components.installed.keys()]
      .filter(name => !state.components.rolledBack.has(name)).at(-1)
  if (component !== expected) fail('preinstall component reservation order is invalid')
  if (operation === 'install') {
    validatePrepared(state.currentLoaded, true)
    if (state.finalize || state.verified || state.currentAction
      || state.components.rolledBack.size !== 0) {
      fail('preinstall component install reservation phase is invalid')
    }
  } else {
    if (!state.finalize) {
      claimFinalize(state, 'rollback')
      state = loadState(values['--attempt-dir'])
    }
    if (state.finalize.value.choice !== 'rollback') {
      fail('preinstall component rollback reservation phase is invalid')
    }
  }
  assertAbsolute(rawResultPath, 'reserved raw installer result path')
  const artifactRoot = join(state.root, 'orchestrator')
  safeEntry(artifactRoot, 'preinstall orchestrator artifact directory', 'directory', 0o700)
  if (dirname(rawResultPath) !== artifactRoot || existsSync(rawResultPath)) {
    fail('reserved raw installer result output is not a new managed artifact')
  }
  const numeric = name => {
    const value = Number(values[name])
    if (!Number.isSafeInteger(value) || value < 0) fail('component reservation activity is invalid')
    return value
  }
  const activity = {
    mission: state.current.databases.mission,
    n8n: state.current.databases.n8n,
    activeTasks: numeric('--active-tasks'),
    activeMediaNodes: numeric('--active-media-nodes'),
    activeN8nExecutions: numeric('--active-n8n-executions'),
    waiting: numeric('--waiting'),
    running: numeric('--running'),
    attentionStale: numeric('--attention-stale'),
    pendingOutbox: numeric('--pending-outbox'),
    snapshotSha256: values['--snapshot-sha256'],
  }
  const expectedSnapshotSha256 = sha256(canonicalJson({
    mission: activity.mission, n8n: activity.n8n,
    activeTasks: activity.activeTasks, activeMediaNodes: activity.activeMediaNodes,
    activeN8nExecutions: activity.activeN8nExecutions, waiting: activity.waiting,
    running: activity.running, attentionStale: activity.attentionStale,
    pendingOutbox: activity.pendingOutbox,
  }))
  if (activity.snapshotSha256 !== expectedSnapshotSha256
    || [activity.activeTasks, activity.activeMediaNodes, activity.activeN8nExecutions,
      activity.waiting, activity.running, activity.pendingOutbox].some(value => value !== 0)) {
    fail('component reservation live activity is not idle')
  }
  const reservation = {
    schema: COMPONENT_RESERVATION_SCHEMA,
    sequence,
    installAttemptId,
    revision,
    uid: process.getuid(),
    reservedAt: nowSeconds(),
    component,
    operation,
    prepared: state.currentLoaded.reference,
    statusIdentitySha256: values['--status-identity-sha256'],
    gateSha256: reference(managedSharedRuntimeGate, 'shared runtime install gate', null).sha256,
    installerOwner: {
      pid: installerPid,
      startToken: installerStartToken,
    },
    rawResultPath,
    targetStateSha256,
    activity,
  }
  const written = writeImmutable(componentReservationPath(state.root, sequence), reservation,
    'preinstall component reservation')
  if (!written) fail('preinstall component reservation CAS lost')
  process.stdout.write(`${canonicalJson({
    phase: 'COMPONENT_RESERVED', component, operation, reservation: written, resumed: false,
  })}\n`)
}

function normalizeRawInstallerResult(state, reservation, raw) {
  const value = raw.value
  exactKeys(value, [
    'afterManifestSha256', 'backup', 'beforeManifestSha256', 'completedAt', 'component',
    'operation', 'requiresFreshRestart', 'schema', 'sourceCommit', 'status', 'targetReleaseId',
  ], 'raw installer result')
  const expectedRawOperation = reservation.value.operation === 'install' ? 'apply' : 'rollback'
  if (value.schema !== INSTALLER_RESULT_SCHEMA || value.component !== reservation.value.component
    || value.operation !== expectedRawOperation
    || value.sourceCommit !== state.current.sourceCommit
    || value.targetReleaseId !== state.current.target.releaseId
    || !['applied', 'noop', 'restored'].includes(value.status)
    || !SHA256.test(value.beforeManifestSha256 || '')
    || !SHA256.test(value.afterManifestSha256 || '')
    || typeof value.requiresFreshRestart !== 'boolean'
    || !Number.isSafeInteger(value.completedAt)) fail('raw installer result binding is invalid')
  if (expectedRawOperation === 'apply') {
    if (value.status === 'restored'
      || (value.status === 'noop' && (value.beforeManifestSha256 !== value.afterManifestSha256
        || value.backup !== null || value.requiresFreshRestart))
      || (value.status === 'applied' && (value.beforeManifestSha256 === value.afterManifestSha256
        || value.backup === null))) fail('raw installer apply result invariant is invalid')
  } else if (value.status !== 'restored' || value.requiresFreshRestart) {
    fail('raw installer rollback result invariant is invalid')
  }
  const expectedRestart = reservation.value.component !== 'task-flow'
    && expectedRawOperation === 'apply' && value.status === 'applied'
  if (value.requiresFreshRestart !== expectedRestart) {
    fail('raw installer restart contract is invalid')
  }
  let backup = null
  if (value.backup !== null) {
    exactKeys(value.backup, ['manifestSha256', 'path'], 'raw installer backup')
    if (!SHA256.test(value.backup.manifestSha256 || '')) fail('raw installer backup digest is invalid')
    const backupDirectory = directoryReference(value.backup.path, 'raw installer backup')
    const manifest = reference(join(backupDirectory.path, 'MANIFEST.sha256'),
      'raw installer backup manifest', 0o600)
    if (manifest.sha256 !== value.backup.manifestSha256) {
      fail('raw installer backup manifest changed')
    }
    backup = { path: backupDirectory.path, manifestSha256: manifest.sha256, manifest }
  }
  return {
    schema: COMPONENT_RESULT_SCHEMA,
    component: value.component,
    operation: reservation.value.operation,
    status: value.status,
    installAttemptId: state.current.installAttemptId,
    sourceCommit: value.sourceCommit,
    targetReleaseId: value.targetReleaseId,
    beforeManifestSha256: value.beforeManifestSha256,
    afterManifestSha256: value.afterManifestSha256,
    backup,
    requiresFreshRestart: value.requiresFreshRestart,
    completedAt: value.completedAt,
    rawResult: raw.reference,
    reservation: reservation.reference,
  }
}

function recordComponent(values) {
  let state = loadState(values['--attempt-dir'])
  if (values['--install-attempt-id'] !== state.current.installAttemptId
    || Number(values['--expected-revision']) !== state.current.revision) {
    fail('preinstall component journal CAS lost')
  }
  const raw = readJson(values['--raw-result'], 'raw installer result', 0o600)
  const operation = values['--operation']
  const component = values['--component']

  const existing = state.components.events.find(event => event.value.operation === operation
    && event.value.component === component)
  if (existing) {
    if (canonicalJson(existing.value.rawResult) !== canonicalJson(raw.reference)) {
      fail('raw installer result retry changed')
    }
    process.stdout.write(`${canonicalJson({
      phase: operation === 'install' ? 'COMPONENT_INSTALLED' : 'COMPONENT_ROLLED_BACK',
      component, event: existing.reference, resumed: true,
    })}\n`)
    return
  }

  const reservation = state.components.activeReservation
  if (!reservation || reservation.value.component !== component
    || reservation.value.operation !== operation
    || reservation.value.rawResultPath !== values['--raw-result']
    || reservation.value.revision !== state.current.revision) {
    fail('raw installer result has no matching active reservation')
  }
  const sequence = state.components.events.length + 1
  const normalizedValue = normalizeRawInstallerResult(state, reservation, raw)
  const normalizedPath = componentResultPath(state.root, sequence)
  const normalizedWritten = writeImmutable(normalizedPath, normalizedValue,
    'preinstall normalized component result')
  if (!normalizedWritten) {
    const existingResult = readJson(normalizedPath, 'preinstall normalized component result', 0o400)
    if (canonicalJson(existingResult.value) !== canonicalJson(normalizedValue)) {
      fail('preinstall normalized component result changed during retry')
    }
  }
  const normalizedReference = normalizedWritten
    || reference(normalizedPath, 'preinstall normalized component result', 0o400)
  const event = {
    schema: COMPONENT_EVENT_SCHEMA,
    sequence,
    installAttemptId: state.current.installAttemptId,
    revision: state.current.revision,
    uid: process.getuid(),
    recordedAt: nowSeconds(),
    operation,
    component,
    reservation: reservation.reference,
    rawResult: raw.reference,
    result: normalizedReference,
    previous: state.components.head,
  }
  const written = writeImmutable(componentEventPath(state.root, sequence), event,
    'preinstall component event')
  if (!written) fail('preinstall component journal CAS lost')
  process.stdout.write(`${canonicalJson({
    phase: operation === 'install' ? 'COMPONENT_INSTALLED' : 'COMPONENT_ROLLED_BACK',
    component, event: written, resumed: false,
  })}\n`)
}

function cancelComponent(values) {
  const state = loadState(values['--attempt-dir'])
  const installAttemptId = values['--install-attempt-id']
  const revision = Number(values['--expected-revision'])
  const component = values['--component']
  const operation = values['--operation']
  const reservationSha256 = values['--reservation-sha256']
  const reason = values['--reason']
  if (!['installer-failed', 'invalid-raw-result', 'lease-expired'].includes(reason)) {
    fail('preinstall component cancellation reason is invalid')
  }
  if (state.current.installAttemptId !== installAttemptId || state.current.revision !== revision) {
    fail('preinstall component cancellation CAS lost')
  }
  const prior = state.components.cancelled.find(item => item.reservation.reference.sha256
    === reservationSha256)
  if (prior) {
    const value = prior.result.value
    if (value.component !== component || value.reservedOperation !== operation
      || value.reason !== reason || value.probe.path !== values['--probe']) {
      fail('preinstall component cancellation retry changed')
    }
    process.stdout.write(`${canonicalJson({
      phase: 'COMPONENT_CANCELLED', component, operation,
      event: prior.event.reference, resumed: true,
    })}\n`)
    return
  }
  const reservation = state.components.activeReservation
  if (!reservation || reservation.reference.sha256 !== reservationSha256
    || reservation.value.component !== component || reservation.value.operation !== operation) {
    fail('preinstall component cancellation has no matching active reservation')
  }
  const probe = readJson(values['--probe'], 'component cancellation probe', 0o600)
  const probeValue = probe.value
  exactKeys(probeValue, [
    'component', 'observedAt', 'reservationSha256', 'schema', 'sourceCommit',
    'targetReleaseId', 'targetStateSha256', 'verifier',
  ], 'component cancellation probe')
  const managedInstaller = managedComponentInstallers[component]
  if (probeValue.schema !== 'video-autoworker-component-target-probe/v1'
    || probeValue.component !== component || probeValue.reservationSha256 !== reservationSha256
    || probeValue.sourceCommit !== state.current.sourceCommit
    || probeValue.targetReleaseId !== state.current.target.releaseId
    || !Number.isSafeInteger(probeValue.observedAt)
    || probeValue.observedAt > nowSeconds() + 5 || nowSeconds() - probeValue.observedAt > 30
    || canonicalJson(probeValue.verifier)
      !== canonicalJson(reference(managedInstaller, 'managed component installer', null))) {
    fail('component cancellation probe binding is invalid')
  }
  const targetStateSha256 = probeValue.targetStateSha256
  if (targetStateSha256 !== reservation.value.targetStateSha256) {
    fail('preinstall component cancellation observed a changed target')
  }
  if (processStartToken(reservation.value.installerOwner.pid)
    === reservation.value.installerOwner.startToken) {
    fail('preinstall component cancellation is blocked while the reserved installer is alive')
  }
  const rawPath = reservation.value.rawResultPath
  let rawResult = null
  if (existsSync(rawPath)) {
    const stable = readStableFile(rawPath, 'cancelled raw installer result', 0o600)
    rawResult = stable.reference
    let valid = false
    try {
      const raw = { value: strictJson(stable.source.toString('utf8'), 'raw installer result'),
        reference: stable.reference }
      normalizeRawInstallerResult(state, reservation, raw)
      valid = true
    } catch { /* an invalid immutable result may be cancelled only while the target is unchanged */ }
    if (valid) fail('valid raw installer result must be recorded, not cancelled')
    if (reason !== 'invalid-raw-result') fail('existing invalid raw result requires invalid-raw-result reason')
  } else if (reason === 'invalid-raw-result') {
    fail('invalid-raw-result cancellation requires an existing raw result')
  }
  if (reason === 'lease-expired' && nowSeconds() < state.current.expiresAt) {
    fail('lease-expired cancellation requires an expired lease')
  }
  const sequence = state.components.events.length + 1
  const resultPath = componentResultPath(state.root, sequence)
  const existingCancellation = existsSync(resultPath)
    ? readJson(resultPath, 'preinstall component cancellation', 0o400) : null
  const cancellation = {
    schema: COMPONENT_CANCELLATION_SCHEMA,
    component,
    reservedOperation: operation,
    status: 'unchanged',
    reason,
    installAttemptId,
    sourceCommit: state.current.sourceCommit,
    targetReleaseId: state.current.target.releaseId,
    targetStateSha256,
    observedAt: existingCancellation?.value.observedAt ?? nowSeconds(),
    probe: probe.reference,
    reservation: reservation.reference,
    rawResult,
  }
  if (existingCancellation) validateComponentCancellation(existingCancellation, state.current, reservation)
  const resultWritten = writeImmutable(resultPath, cancellation, 'preinstall component cancellation')
  let result = resultWritten
  if (!result) {
    const existing = readJson(resultPath, 'preinstall component cancellation', 0o400)
    if (canonicalJson(existing.value) !== canonicalJson(cancellation)) {
      fail('preinstall component cancellation result changed during retry')
    }
    result = existing.reference
  }
  commandFailpoint('after-cancellation-result-publish')
  const event = {
    schema: COMPONENT_EVENT_SCHEMA,
    sequence,
    installAttemptId,
    revision,
    uid: process.getuid(),
    recordedAt: nowSeconds(),
    operation: 'cancel',
    component,
    reservation: reservation.reference,
    rawResult,
    result,
    previous: state.components.head,
  }
  const written = writeImmutable(componentEventPath(state.root, sequence), event,
    'preinstall component cancellation event')
  if (!written) fail('preinstall component cancellation event CAS lost')
  process.stdout.write(`${canonicalJson({
    phase: 'COMPONENT_CANCELLED', component, operation, event: written, resumed: false,
  })}\n`)
}

export function reverifyPreinstallReadiness(attemptDirectory, runtimeConvergenceProofPath) {
  const state = loadState(attemptDirectory)
  if (!state.verified || state.terminal?.value.choice === 'abandon') {
    fail('INSTALL_VERIFIED authorization is unavailable')
  }
  const recoveringFinalizedHandoff = state.finalize?.value.choice === 'bootstrap-handoff'
  validatePrepared(state.currentLoaded, !recoveringFinalizedHandoff)
  if (state.components.activeReservation) {
    fail('INSTALL_VERIFIED is blocked by a component reservation')
  }
  const transition = verifyTransition({
    intent: state.current.transition.intent.path,
    confirmation: state.current.transition.confirmation.path,
    journal: state.current.transition.journal.path,
    attestation: state.current.transition.attestation.path,
  })
  if (!recoveringFinalizedHandoff) {
    const context = evidenceContext(
      state.current.evidence.path, state.current.proof.path, state.current.sourceCommit,
    )
    assertTransitionMatches(transition, context)
    if (context.runtimeSnapshotSha256 !== state.current.runtimeSnapshotSha256
      || canonicalJson(context.databases) !== canonicalJson(state.current.databases)
      || canonicalJson(context.target) !== canonicalJson(state.current.target)) {
      fail('live preinstall binding changed before handoff')
    }
  }
  if (transition.committedJournalHeadSha256
      !== state.current.transition.committedJournalHeadSha256
    || transition.liveCombinedSha256 !== state.current.transition.liveCombinedSha256) {
    fail('live preinstall binding changed before handoff')
  }
  const report = readJson(state.verified.value.readiness.path, 'preinstall readiness report', 0o400)
  const profileStateRoot = dirname(dirname(report.value?.payloads?.videoCommand?.root || ''))
  const workspaceRoot = dirname(dirname(report.value?.payloads?.taskFlow?.root || ''))
  const releasesRoot = dirname(dirname(state.current.target.releaseRoot))
  for (const [pathname, label] of [
    [profileStateRoot, 'derived profile state root'],
    [workspaceRoot, 'derived workspace root'],
    [releasesRoot, 'derived releases root'],
  ]) assertAbsolute(pathname, label)
  const current = runReadiness(state, {
    '--releases-root': releasesRoot,
    '--profile-state-root': profileStateRoot,
    '--workspace-root': workspaceRoot,
    '--runtime-convergence-proof': runtimeConvergenceProofPath,
  })
  const currentPayloads = {
    videoCommandManifestSha256: current.payloads?.videoCommand?.manifestSha256,
    taskFlowManifestSha256: current.payloads?.taskFlow?.manifestSha256,
    directorBrainManifestSha256: current.payloads?.directorBrain?.manifestSha256,
  }
  if (canonicalJson(currentPayloads) !== canonicalJson({
    videoCommandManifestSha256: state.verified.value.payloads.videoCommandManifestSha256,
    taskFlowManifestSha256: state.verified.value.payloads.taskFlowManifestSha256,
    directorBrainManifestSha256: state.verified.value.payloads.directorBrainManifestSha256,
  }) || current.commit !== state.current.sourceCommit
    || current.app?.releaseId !== state.current.target.releaseId
    || current.app?.manifestSha256 !== state.current.target.manifestSha256
    || current.contracts?.directorWork !== true || current.contracts?.outboxClosure !== true
    || current.contracts?.sessionScopedRuntimeConvergence !== true) {
    fail('installed payload or runtime convergence readiness drifted after INSTALL_VERIFIED')
  }
  const runtimeConvergenceProof = reference(
    runtimeConvergenceProofPath, 'fresh runtime convergence proof', 0o600,
  )
  return {
    installAttemptId: state.current.installAttemptId,
    revision: state.current.revision,
    verification: state.verified.reference,
    readiness: report.reference,
    terminal: state.terminal?.reference ?? null,
    freshReadinessSha256: sha256(canonicalJson(current)),
    runtimeConvergenceProof,
    payloads: currentPayloads,
  }
}

function handoff(values) {
  const claimed = claimBootstrapHandoff({
    attemptDirectory: values['--attempt-dir'],
    installAttemptId: values['--install-attempt-id'],
    expectedRevision: Number(values['--expected-revision']),
    runtimeConvergenceProofPath: values['--runtime-convergence-proof'],
    videoBatchRoot: values['--video-batch-root'],
  })
  process.stdout.write(`${canonicalJson({
    phase: 'BOOTSTRAP_HANDOFF', installAttemptId: values['--install-attempt-id'],
    revision: Number(values['--expected-revision']), terminal: claimed.state.terminal.reference,
    verification: claimed.state.verified.reference, resumed: claimed.resumed,
  })}\n`)
}

function status(values) {
  process.stdout.write(`${canonicalJson(inspectPreinstallAttempt(values['--attempt-dir']))}\n`)
}

export function inspectPreinstallAttempt(attemptDirectory, { verifyLive = true } = {}) {
  const state = loadState(attemptDirectory)
  if (verifyLive && !state.terminal) {
    const recoveringFinalizedHandoff = state.finalize?.value.choice === 'bootstrap-handoff'
    const recoveringExpiredJournal = nowSeconds() >= state.current.expiresAt
      && state.components.events.length > 0
    const transition = verifyTransition({
      intent: state.current.transition.intent.path,
      confirmation: state.current.transition.confirmation.path,
      journal: state.current.transition.journal.path,
      attestation: state.current.transition.attestation.path,
    })
    if (!recoveringFinalizedHandoff && !recoveringExpiredJournal) {
      const context = evidenceContext(
        state.current.evidence.path, state.current.proof.path, state.current.sourceCommit,
      )
      assertTransitionMatches(transition, context)
      if (canonicalJson(context.target) !== canonicalJson(state.current.target)
        || canonicalJson(context.databases) !== canonicalJson(state.current.databases)
        || context.runtimeSnapshotSha256 !== state.current.runtimeSnapshotSha256) {
        fail('live preinstall lease binding changed')
      }
    }
    if (transition.committedJournalHeadSha256
        !== state.current.transition.committedJournalHeadSha256
      || transition.liveCombinedSha256 !== state.current.transition.liveCombinedSha256) {
      fail('live preinstall lease binding changed')
    }
  }
  let phase = state.verified ? 'INSTALL_VERIFIED' : 'INSTALL_PREPARED'
  if (state.currentAction?.value.choice === 'renew') phase = 'INSTALL_RENEW_PENDING'
  if (state.currentAction?.value.choice === 'verify' && !state.verified) phase = 'INSTALL_VERIFY_PENDING'
  if (state.currentAction?.value.choice === 'abandon') phase = 'INSTALL_ABANDON_PENDING'
  if (state.currentPostverifyAction?.value.choice === 'renew') phase = 'INSTALL_RENEW_PENDING'
  if (state.currentPostverifyAction?.value.choice === 'abandon') phase = 'INSTALL_ABANDON_PENDING'
  if (state.currentPostverifyAction?.value.choice === 'bootstrap-handoff') phase = 'BOOTSTRAP_HANDOFF_PENDING'
  if (state.finalize?.value.choice === 'bootstrap-handoff' && !state.currentPostverifyAction) {
    phase = 'BOOTSTRAP_HANDOFF_FINALIZING'
  }
  if (state.finalize?.value.choice === 'rollback') phase = 'INSTALL_ROLLBACK_PENDING'
  if (state.terminal?.value.choice === 'abandon') phase = 'INSTALL_ABANDONED'
  if (state.terminal?.value.choice === 'bootstrap-handoff') phase = 'BOOTSTRAP_HANDOFF'
  return {
    phase,
    installAttemptId: state.current.installAttemptId,
    revision: state.current.revision,
    expiresAt: state.current.expiresAt,
    expired: nowSeconds() >= state.current.expiresAt,
    prepared: state.currentLoaded.reference,
    verification: state.verified?.reference ?? null,
    terminal: state.terminal?.reference ?? null,
    finalize: state.finalize?.reference ?? null,
    components: {
      installed: [...state.components.installed.keys()],
      rolledBack: [...state.components.rolledBack.keys()],
      cancelled: state.components.cancelled.map(item => ({
        component: item.reservation.value.component,
        operation: item.reservation.value.operation,
        reservationSha256: item.reservation.reference.sha256,
      })),
      journalHead: state.components.head,
    },
    reservation: state.components.activeReservation ? {
      reference: state.components.activeReservation.reference,
      component: state.components.activeReservation.value.component,
      operation: state.components.activeReservation.value.operation,
      rawResultPath: state.components.activeReservation.value.rawResultPath,
      statusIdentitySha256: state.components.activeReservation.value.statusIdentitySha256,
      targetStateSha256: state.components.activeReservation.value.targetStateSha256,
    } : null,
    bindings: {
      sourceCommit: state.current.sourceCommit,
      target: state.current.target,
      databases: state.current.databases,
      evidence: state.current.evidence,
      proof: state.current.proof,
      evidenceObservedAt: state.current.evidenceObservedAt,
      guard: state.current.guard,
      runtimeSnapshotSha256: state.current.runtimeSnapshotSha256,
      transition: state.current.transition,
    },
  }
}

function parseArguments(argv) {
  const command = argv[0]
  const common = ['--attempt-dir']
  const allowed = {
    prepare: [...common, '--evidence', '--proof', '--source-commit', '--transition-intent',
      '--transition-confirmation', '--transition-journal', '--transition-attestation', '--transition-claim'],
    renew: [...common, '--install-attempt-id', '--expected-revision', '--evidence', '--proof'],
    verify: [...common, '--install-attempt-id', '--expected-revision', '--releases-root',
      '--profile-state-root', '--workspace-root', '--runtime-convergence-proof',
      '--gateway-restart-evidence'],
    abandon: [...common, '--install-attempt-id', '--expected-revision'],
    handoff: [...common, '--install-attempt-id', '--expected-revision', '--runtime-convergence-proof',
      '--video-batch-root'],
    'reserve-component': [...common, '--install-attempt-id', '--expected-revision',
      '--operation', '--component', '--raw-result-output', '--status-identity-sha256',
      '--target-state-sha256', '--installer-pid', '--installer-start-token',
      '--active-tasks', '--active-media-nodes', '--active-n8n-executions', '--waiting',
      '--running', '--attention-stale', '--pending-outbox', '--snapshot-sha256'],
    'record-component': [...common, '--install-attempt-id', '--expected-revision',
      '--operation', '--component', '--raw-result'],
    'cancel-component': [...common, '--install-attempt-id', '--expected-revision',
      '--operation', '--component', '--reservation-sha256', '--probe', '--reason'],
    status: common,
  }[command]
  if (!allowed) fail('expected prepare, renew, verify, reserve-component, record-component, cancel-component, abandon, handoff, or status')
  const values = {}
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!allowed.includes(name) || value === undefined || Object.hasOwn(values, name)) {
      fail(`${command} arguments are invalid`)
    }
    values[name] = value
  }
  if (Object.keys(values).length !== allowed.length) fail(`${command} arguments are incomplete`)
  for (const [name, value] of Object.entries(values)) {
    if (!['--source-commit', '--install-attempt-id', '--expected-revision', '--operation', '--component',
      '--status-identity-sha256', '--snapshot-sha256', '--active-tasks', '--active-media-nodes',
      '--active-n8n-executions', '--waiting', '--running', '--attention-stale', '--pending-outbox',
      '--reservation-sha256', '--target-state-sha256', '--reason', '--installer-pid',
      '--installer-start-token'].includes(name)) {
      assertAbsolute(value, name)
    }
  }
  if (values['--expected-revision'] !== undefined
    && (!/^\d+$/u.test(values['--expected-revision']) || Number(values['--expected-revision']) < 1)) {
    fail('expected revision is invalid')
  }
  if (['reserve-component', 'record-component', 'cancel-component'].includes(command)
    && (!['install', 'rollback'].includes(values['--operation'])
      || !COMPONENTS.includes(values['--component']))) {
    fail('record-component operation or component is invalid')
  }
  return { command, values }
}

export async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArguments(argv)
  if (command === 'prepare') return prepare(values)
  if (command === 'renew') return renew(values)
  if (command === 'verify') return verify(values)
  if (command === 'reserve-component') return reserveComponent(values)
  if (command === 'record-component') return recordComponent(values)
  if (command === 'cancel-component') return cancelComponent(values)
  if (command === 'abandon') return abandon(values)
  if (command === 'handoff') return handoff(values)
  return status(values)
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
