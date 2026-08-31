#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
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
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_SCHEMA = 'video-autoworker-n8n-managed-workflow-backup/v1'
const RECEIPT_SCHEMA = 'video-autoworker-n8n-managed-workflow-restore-confirmation/v2'
const RESTORE_JOURNAL_SCHEMA = 'video-autoworker-n8n-managed-workflow-restore-journal/v1'
const DISASTER_RECEIPT_SCHEMA = 'video-autoworker-n8n-managed-workflow-disaster-recovery-confirmation/v1'
const DISASTER_JOURNAL_SCHEMA = 'video-autoworker-n8n-disaster-recovery-journal/v1'
const BOOTSTRAP_PREPARE_SCHEMA = 'video-autoworker-legacy-bootstrap-prepare/v1'
const BOOTSTRAP_CONFIRM_SCHEMA = 'video-autoworker-legacy-bootstrap-current-confirm/v1'
const BOOTSTRAP_SHUTDOWN_SCHEMA = 'video-autoworker-legacy-bootstrap-shutdown-requested/v1'
const BOOTSTRAP_SHUTDOWN_AUTHORIZATION = 'legacy-bootstrap-shutdown-requested/v1'
const BOOTSTRAP_PENDING_SCHEMA = 'video-autoworker-blue-green-bootstrap-pending/v4'
const LEGACY_FREEZE_EVIDENCE_SCHEMA = 'video-autoworker-legacy-freeze-evidence/v3'
const LEGACY_ROLLBACK_PROOF_SCHEMA = 'video-autoworker-legacy-bootstrap-rollback-proof/v2'
const N8N_WORKFLOW_PROTOCOL = 'slot-v1-execution-owner-v1'
const N8N_WORKFLOW_REPORT_SCHEMA = 'video-autoworker-n8n-workflow-compatibility/v2'
const N8N_TRANSITION_CLAIM_SCHEMA = 'video-autoworker-n8n-workflow-transition-bootstrap-claim/v1'
const N8N_TRANSITION_ATTESTATION_SCHEMA = 'video-autoworker-n8n-workflow-transition-attestation/v1'
const RECOVERY_BRANCH_SCHEMA = 'video-autoworker-legacy-bootstrap-recovery-branch/v2'
const scriptPath = fileURLToPath(import.meta.url)
const transitionAnchorPath = join(dirname(scriptPath), 'n8n-workflow-transition-anchor.mjs')
const SENTINEL_SCHEMA = 'video-autoworker-n8n-managed-workflow-sentinel/v1'
const MANAGED = Object.freeze([
  { id: 'aiworker-task-intake-v1', file: 'aiworker-task-intake-v1.json' },
  { id: 'aiworker-video-analysis-v1', file: 'aiworker-video-analysis-v1.json' },
])
const MANAGED_IDS = new Set(MANAGED.map(item => item.id))
const MAX_JSON_BYTES = 16 * 1024 * 1024
const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_RECEIPT_BYTES = 64 * 1024
const CONFIRMATION_TTL_SECONDS = 10 * 60
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/u

function nowSeconds() {
  if (process.env.NODE_ENV === 'test'
    && /^\d{10}$/u.test(process.env.AIWORKER_TEST_N8N_RECOVERY_NOW || '')) {
    return Number(process.env.AIWORKER_TEST_N8N_RECOVERY_NOW)
  }
  return Math.floor(Date.now() / 1000)
}

function fail(message) {
  throw new Error(`n8n managed workflow recovery failed: ${message}`)
}

function canonicalize(value) {
  if (Buffer.isBuffer(value)) return { $binarySha256: sha256(value), bytes: value.length }
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
    const token = source.slice(index).match(
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u,
    )?.[0]
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

function normalizedAbsolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label} must be one normalized absolute path`)
}

function assertPhysicalPath(pathname, label, allowMissingLeaf = false) {
  normalizedAbsolute(pathname, label)
  const root = parse(pathname).root
  const parts = relative(root, pathname).split('/').filter(Boolean)
  let current = root
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index])
    if (allowMissingLeaf && index === parts.length - 1) {
      try { lstatSync(current); fail(`${label} already exists`) } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      return
    }
    let entry
    try { entry = lstatSync(current) } catch { fail(`${label} path component is unavailable`) }
    if (entry.isSymbolicLink()) fail(`${label} path contains a symbolic link`)
  }
}

function safeEntry(pathname, label, type, requiredMode = null) {
  assertPhysicalPath(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if ((type === 'file' && !entry.isFile()) || (type === 'directory' && !entry.isDirectory())) {
    fail(`${label} is not a physical ${type}`)
  }
  if (entry.uid !== BigInt(process.getuid())) fail(`${label} is not owned by the current user`)
  if (type === 'file' && entry.nlink !== 1n) fail(`${label} has an unsafe hard-link count`)
  const mode = Number(entry.mode & 0o777n)
  if (requiredMode !== null && mode !== requiredMode) fail(`${label} mode must be ${requiredMode.toString(8)}`)
  return entry
}

function readJsonFile(pathname, label, mode, maximumBytes) {
  const before = safeEntry(pathname, label, 'file', mode)
  if (before.size > BigInt(maximumBytes)) fail(`${label} is too large`)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail(`${label} changed before open`)
    }
    const source = readFileSync(descriptor, 'utf8')
    if (Buffer.byteLength(source) !== Number(opened.size)) fail(`${label} changed during read`)
    return { value: strictJson(source, label, maximumBytes), source, entry: opened }
  } finally { closeSync(descriptor) }
}

function readReferencedJsonMode(reference, label, mode) {
  exactKeys(reference, ['dev', 'ino', 'path', 'sha256', 'size'], `${label} reference`)
  if (!/^\d+$/u.test(reference.dev) || !/^\d+$/u.test(reference.ino)
    || !Number.isSafeInteger(reference.size) || reference.size < 1 || !SHA256.test(reference.sha256)) {
    fail(`${label} reference is invalid`)
  }
  normalizedAbsolute(reference.path, `${label} path`)
  const loaded = readJsonFile(reference.path, label, mode, MAX_JSON_BYTES)
  if (loaded.entry.dev.toString() !== reference.dev || loaded.entry.ino.toString() !== reference.ino
    || Number(loaded.entry.size) !== reference.size || sha256(loaded.source) !== reference.sha256) {
    fail(`${label} reference identity changed`)
  }
  return loaded
}

function readReferencedJson(reference, label) {
  return readReferencedJsonMode(reference, label, 0o400)
}

function hashStableFile(pathname, label, maximumBytes = MAX_JSON_BYTES) {
  const before = safeEntry(pathname, label, 'file')
  if (before.size < 1n || before.size > BigInt(maximumBytes)) fail(`${label} size is invalid`)
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail(`${label} changed before open`)
    }
    const source = readFileSync(descriptor)
    const after = safeEntry(pathname, label, 'file')
    if (source.length !== Number(opened.size) || after.dev !== opened.dev
      || after.ino !== opened.ino || after.size !== opened.size) fail(`${label} changed during read`)
    return { sha256: sha256(source), entry: opened }
  } finally { closeSync(descriptor) }
}

function validateIdentity(value, label) {
  exactKeys(value, ['dev', 'ino', 'path'], label)
  normalizedAbsolute(value.path, `${label} path`)
  if (!/^\d+$/u.test(value.dev) || !/^\d+$/u.test(value.ino)) fail(`${label} is invalid`)
  return value
}

function validateCurrentFileIdentity(value, label) {
  validateIdentity(value, label)
  const entry = safeEntry(value.path, label, 'file')
  if (entry.dev.toString() !== value.dev || entry.ino.toString() !== value.ino) {
    fail(`${label} identity changed`)
  }
  return value
}

function validateDisasterRouter(value) {
  exactKeys(value, ['port', 'runDirectory', 'statePath'], 'pending router')
  validateIdentity(value.runDirectory, 'pending router run directory')
  const entry = safeEntry(value.runDirectory.path, 'pending router run directory', 'directory', 0o700)
  if (realpathSync(value.runDirectory.path) !== value.runDirectory.path
    || entry.dev.toString() !== value.runDirectory.dev
    || entry.ino.toString() !== value.runDirectory.ino) {
    fail('pending router run directory identity changed')
  }
  normalizedAbsolute(value.statePath, 'pending router state path')
  if (value.port !== 3017 || value.statePath !== join(value.runDirectory.path, 'router-state.json')) {
    fail('pending router binding is invalid')
  }
  return value
}

function validateDisasterRecoveryBranch(reference, bootstrapDirectory, receipt) {
  exactKeys(reference, ['dev', 'ino', 'path', 'sha256', 'size'], 'disaster recovery branch claim reference')
  if (reference.path !== join(bootstrapDirectory, 'recovery-branch.claim.json')) {
    fail('disaster recovery branch claim path is not canonical')
  }
  const loaded = readReferencedJson(reference, 'disaster recovery branch claim')
  const value = loaded.value
  exactKeys(value, [
    'attemptId', 'branch', 'claimedAt', 'schema', 'uid',
  ], 'disaster recovery branch claim')
  if (value.schema !== RECOVERY_BRANCH_SCHEMA || value.attemptId !== receipt.authorization.attemptId
    || value.branch !== 'restore'
    || value.uid !== process.getuid() || !Number.isSafeInteger(value.claimedAt)
    || value.claimedAt <= 0) {
    fail('disaster recovery branch claim binding is invalid')
  }
  return value
}

function validateDisasterWorkflowReport(reference, receipt, pending, bootstrapDirectory) {
  if (canonicalJson(reference) !== canonicalJson(receipt.authorization.workflowReport)) {
    fail('pending workflow report reference changed')
  }
  if (reference.path !== join(bootstrapDirectory, 'n8n-workflow-compatibility.receipt.json')) {
    fail('pending workflow report path is not canonical')
  }
  const loaded = readReferencedJson(reference, 'pending n8n workflow compatibility report')
  const report = loaded.value
  exactKeys(report, [
    'combinedSha256', 'databasePath', 'protocol', 'runtimeIdentitySha256',
    'schema', 'sourceCommit', 'workflows',
  ], 'pending n8n workflow compatibility report')
  if (report.schema !== N8N_WORKFLOW_REPORT_SCHEMA || report.protocol !== N8N_WORKFLOW_PROTOCOL
    || report.sourceCommit !== pending.baselineSourceCommit || report.databasePath !== pending.n8n.dbPath
    || !SHA256.test(report.runtimeIdentitySha256) || !SHA256.test(report.combinedSha256)
    || !Array.isArray(report.workflows) || report.workflows.length !== MANAGED.length) {
    fail('pending n8n workflow compatibility report is invalid')
  }
  for (let index = 0; index < MANAGED.length; index += 1) {
    const workflow = report.workflows[index]
    exactKeys(workflow, [
      'id', 'publishedVersionId', 'sha256', 'sourceSha256', 'sourceVersionId',
    ], `pending workflow compatibility report item ${index}`)
    if (workflow.id !== MANAGED[index].id
      || !/^[A-Za-z0-9-]{8,64}$/u.test(workflow.sourceVersionId)
      || !/^[A-Za-z0-9-]{8,64}$/u.test(workflow.publishedVersionId)
      || !SHA256.test(workflow.sourceSha256) || !SHA256.test(workflow.sha256)) {
      fail(`pending workflow compatibility report item ${index} is invalid`)
    }
  }
  const combinedSha256 = sha256([
    report.sourceCommit,
    report.runtimeIdentitySha256,
    ...report.workflows.map(workflow => [
      workflow.id,
      workflow.sourceVersionId,
      workflow.sourceSha256,
      workflow.publishedVersionId,
      workflow.sha256,
    ].join(':')),
  ].join('\n'))
  if (report.combinedSha256 !== combinedSha256 || pending.n8n.workflowDigest !== combinedSha256) {
    fail('pending n8n workflow compatibility digest changed')
  }
  return report
}

function anchorReferenceSubset(reference) {
  return {
    path: reference.path,
    dev: reference.dev,
    ino: reference.ino,
    size: reference.size,
    sha256: reference.sha256,
  }
}

function validateAnchorFileReference(reference, label, requiredMode = '400') {
  exactKeys(reference, [
    'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'path', 'sha256', 'size', 'uid',
  ], `${label} reference`)
  if (!/^\d+$/u.test(reference.dev) || !/^\d+$/u.test(reference.ino)
    || !/^\d+$/u.test(reference.mtimeNs) || !/^\d+$/u.test(reference.ctimeNs)
    || !Number.isSafeInteger(reference.size) || reference.size < 1
    || reference.uid !== process.getuid()
    || (requiredMode === null ? (Number.parseInt(reference.mode, 8) & 0o022) !== 0 : reference.mode !== requiredMode)
    || reference.nlink !== 1
    || !SHA256.test(reference.sha256)) fail(`${label} reference is invalid`)
  normalizedAbsolute(reference.path, `${label} path`)
  const loaded = hashStableFile(reference.path, label, MAX_JSON_BYTES)
  if (loaded.entry.dev.toString() !== reference.dev || loaded.entry.ino.toString() !== reference.ino
    || Number(loaded.entry.size) !== reference.size || loaded.entry.mtimeNs.toString() !== reference.mtimeNs
    || loaded.entry.ctimeNs.toString() !== reference.ctimeNs || Number(loaded.entry.uid) !== reference.uid
    || Number(loaded.entry.mode & 0o7777n).toString(8) !== reference.mode
    || Number(loaded.entry.nlink) !== reference.nlink || loaded.sha256 !== reference.sha256) {
    fail(`${label} reference identity changed`)
  }
  return loaded
}

function readAnchorReferencedJson(reference, label) {
  validateAnchorFileReference(reference, label)
  const loaded = readJsonFile(reference.path, label, 0o400, MAX_JSON_BYTES)
  return loaded
}

function validateDisasterTransition(
  binding,
  claimReference,
  receipt,
  pending,
  prepare,
  packageResult,
  packagePath,
  runtimeRelease,
  n8nVersion,
) {
  exactKeys(binding, [
    'anchor', 'attestation', 'claim', 'committedJournalHeadSha256', 'confirmation',
    'intent', 'journal', 'liveCombinedSha256', 'upgradeId',
  ], 'pending workflow transition binding')
  if (canonicalJson(binding) !== canonicalJson(receipt.authorization.transition)
    || canonicalJson(binding) !== canonicalJson(prepare.transition)) {
    fail('pending workflow transition binding changed')
  }
  validateAnchorFileReference(binding.anchor, 'pending transition anchor', null)
  for (const [name, reference] of [
    ['confirmation', binding.confirmation], ['intent', binding.intent],
  ]) readAnchorReferencedJson(reference, `pending transition ${name}`)
  readAnchorReferencedJson(binding.attestation, 'pending transition attestation')
  exactKeys(binding.journal, ['dev', 'ino', 'mode', 'path', 'uid'], 'pending transition journal')
  const journalEntry = safeEntry(binding.journal.path, 'pending transition journal', 'directory', 0o700)
  if (journalEntry.dev.toString() !== binding.journal.dev
    || journalEntry.ino.toString() !== binding.journal.ino
    || Number(journalEntry.uid) !== binding.journal.uid || binding.journal.mode !== '700'
    || realpathSync(binding.journal.path) !== binding.journal.path) {
    fail('pending transition journal identity changed')
  }
  exactKeys(claimReference, [
    'ctimeNs', 'dev', 'ino', 'mode', 'mtimeNs', 'nlink', 'path', 'sha256', 'size', 'uid',
  ], 'pending transition claim reference')
  if (canonicalJson(claimReference) !== canonicalJson(binding.claim)) {
    fail('pending transition claim reference changed')
  }
  const claimLoaded = readAnchorReferencedJson(claimReference, 'pending transition bootstrap claim')
  const claim = claimLoaded.value
  exactKeys(claim, ['bootstrap', 'claimedAt', 'schema', 'transition', 'uid', 'upgradeId'], 'transition bootstrap claim')
  exactKeys(claim.bootstrap, ['attemptId', 'request'], 'transition bootstrap binding')
  exactKeys(claim.bootstrap.request, ['database', 'preparePath', 'target'], 'transition bootstrap request')
  exactKeys(claim.bootstrap.request.target, ['manifestSha256', 'releaseId', 'releaseRoot', 'slot'], 'transition bootstrap target')
  exactKeys(claim.transition, [
    'attestation', 'committedJournalHeadSha256', 'liveCombinedSha256',
  ], 'transition committed binding')
  if (claim.schema !== N8N_TRANSITION_CLAIM_SCHEMA || claim.uid !== process.getuid()
    || !Number.isSafeInteger(claim.claimedAt) || !/^[a-f0-9-]{36}$/u.test(claim.upgradeId)
    || claim.upgradeId !== binding.upgradeId
    || claim.bootstrap.attemptId !== receipt.authorization.attemptId
    || claim.bootstrap.request.preparePath !== receipt.authorization.prepare.path
    || claim.bootstrap.request.database.path !== pending.databases.n8n.path
    || claim.bootstrap.request.database.dev !== pending.databases.n8n.dev
    || claim.bootstrap.request.database.ino !== pending.databases.n8n.ino
    || canonicalJson(claim.bootstrap.request.target) !== canonicalJson({
      slot: pending.slot,
      releaseId: pending.releaseId,
      releaseRoot: pending.releaseRoot,
      manifestSha256: pending.manifestSha256,
    })
    || !SHA256.test(claim.transition.committedJournalHeadSha256)
    || claim.transition.committedJournalHeadSha256 !== binding.committedJournalHeadSha256
    || claim.transition.liveCombinedSha256 !== pending.n8n.workflowDigest
    || claim.transition.liveCombinedSha256 !== binding.liveCombinedSha256
    || canonicalJson(claim.transition.attestation) !== canonicalJson(binding.attestation)) {
    fail('transition bootstrap claim is invalid')
  }

  const attestationLoaded = readAnchorReferencedJson(
    claim.transition.attestation, 'workflow transition attestation',
  )
  const attestation = attestationLoaded.value
  exactKeys(attestation, [
    'confirmation', 'confirmationTokenSha256', 'createdAt', 'deployed', 'intent', 'journal',
    'n8n', 'producer', 'rollback', 'schema', 'targetApplicationRelease', 'uid',
    'upgradeId', 'verifier',
  ], 'workflow transition attestation')
  if (attestation.schema !== N8N_TRANSITION_ATTESTATION_SCHEMA
    || attestation.upgradeId !== claim.upgradeId || attestation.uid !== process.getuid()
    || !Number.isSafeInteger(attestation.createdAt)) fail('workflow transition attestation is invalid')
  exactKeys(attestation.journal, ['completedThrough', 'directory', 'headSha256'], 'attested transition journal')
  if (attestation.journal.completedThrough !== 'VERIFIED'
    || !SHA256.test(attestation.journal.headSha256)
    || canonicalJson(attestation.journal.directory) !== canonicalJson(binding.journal)) {
    fail('workflow transition journal binding changed')
  }
  exactKeys(attestation.deployed, [
    'combinedSha256', 'report', 'runtimeIdentitySha256', 'workflows',
  ], 'attested deployed workflows')
  if (attestation.deployed.combinedSha256 !== pending.n8n.workflowDigest
    || canonicalJson(anchorReferenceSubset(attestation.deployed.report))
      !== canonicalJson(pending.n8n.workflowReport)) fail('attested deployed workflow binding changed')

  safeEntry(transitionAnchorPath, 'workflow transition anchor', 'file')
  const verified = spawnSync(process.execPath, [
    transitionAnchorPath,
    'verify-transition',
    '--intent', binding.intent.path,
    '--confirmation', binding.confirmation.path,
    '--journal-dir', binding.journal.path,
    '--attestation', claim.transition.attestation.path,
  ], { encoding: 'utf8', maxBuffer: MAX_JSON_BYTES, timeout: 30_000 })
  if (verified.error || verified.signal || verified.status !== 0) {
    fail('workflow transition anchor verification failed')
  }
  const verifiedResult = strictJson(verified.stdout.trim(), 'workflow transition verification', MAX_RECEIPT_BYTES)
  exactKeys(verifiedResult, [
    'attestationSha256', 'committed', 'liveCombinedSha256', 'schema', 'upgradeId',
  ], 'workflow transition verification')
  if (verifiedResult.schema !== N8N_TRANSITION_ATTESTATION_SCHEMA || verifiedResult.committed !== true
    || verifiedResult.upgradeId !== claim.upgradeId
    || verifiedResult.attestationSha256 !== claim.transition.attestation.sha256
    || verifiedResult.liveCombinedSha256 !== pending.n8n.workflowDigest) {
    fail('workflow transition verification result changed')
  }

  exactKeys(attestation.rollback, [
    'combinedSha256', 'database', 'directory', 'manifest', 'n8nVersion', 'sourceCommit', 'workflows',
  ], 'attested rollback package')
  const packageDirectory = safeEntry(packagePath, 'attested rollback package', 'directory', 0o500)
  const packageManifest = hashStableFile(
    join(packagePath, 'manifest.json'), 'attested rollback package manifest', MAX_MANIFEST_BYTES,
  )
  if (attestation.rollback.directory.path !== packagePath
    || attestation.rollback.directory.dev !== packageDirectory.dev.toString()
    || attestation.rollback.directory.ino !== packageDirectory.ino.toString()
    || attestation.rollback.manifest.path !== join(packagePath, 'manifest.json')
    || attestation.rollback.manifest.dev !== packageManifest.entry.dev.toString()
    || attestation.rollback.manifest.ino !== packageManifest.entry.ino.toString()
    || attestation.rollback.manifest.size !== Number(packageManifest.entry.size)
    || attestation.rollback.manifest.sha256 !== packageManifest.sha256
    || attestation.rollback.combinedSha256 !== packageResult.manifest.combinedSha256
    || attestation.rollback.sourceCommit !== packageResult.manifest.source.sourceCommit
    || attestation.rollback.n8nVersion !== packageResult.manifest.source.n8nVersion) {
    fail('disaster rollback package differs from the attested transition')
  }
  if (!Array.isArray(attestation.rollback.workflows)
    || canonicalJson(attestation.rollback.workflows.map(workflow => ({
      id: workflow.id,
      active: workflow.active,
      fileSha256: workflow.fileSha256,
      semanticSha256: workflow.semanticSha256,
    }))) !== canonicalJson(packageResult.reports.map(workflow => ({
      id: workflow.id,
      active: workflow.active,
      fileSha256: workflow.fileSha256,
      semanticSha256: workflow.semanticSha256,
    })))) fail('disaster rollback workflow set differs from the attested transition')

  exactKeys(attestation.n8n, [
    'release', 'runtimeSourceManifest', 'sourceCommit', 'sourceManifest', 'version',
  ], 'attested n8n runtime')
  if (attestation.n8n.release.path !== runtimeRelease
    || attestation.n8n.sourceCommit !== pending.baselineSourceCommit
    || attestation.n8n.version !== n8nVersion) fail('attested n8n runtime differs from disaster recovery')
  exactKeys(attestation.targetApplicationRelease, [
    'manifest', 'releaseId', 'releaseRoot', 'slot',
  ], 'attested application release')
  if (attestation.targetApplicationRelease.slot !== pending.slot
    || attestation.targetApplicationRelease.releaseId !== pending.releaseId
    || attestation.targetApplicationRelease.releaseRoot.path !== pending.releaseRoot
    || attestation.targetApplicationRelease.manifest.sha256 !== pending.manifestSha256) {
    fail('attested application release differs from pending v4')
  }
  return claim
}

function validateDisasterPending(
  pendingLoaded,
  receipt,
  prepare,
  confirmed,
  shutdown,
  bootstrapDirectory,
  packageResult,
  packagePath,
  runtimeRelease,
  n8nVersion,
) {
  const pending = pendingLoaded.value
  exactKeys(pending, [
    'attemptId', 'authorization', 'baselineSourceCommit', 'bootstrapClaim', 'createdAt', 'databases', 'evidence',
    'evidenceObservedAt', 'legacyCwd', 'legacyPid', 'legacyReleaseId', 'manifestSha256',
    'n8n', 'proof', 'releaseId', 'releaseRoot', 'router', 'schema', 'slot', 'transition',
  ], 'bootstrap pending v4')
  exactKeys(pending.authorization, ['confirm', 'prepare', 'shutdown'], 'pending authorization')
  exactKeys(pending.databases, ['mission', 'n8n'], 'pending databases')
  exactKeys(pending.n8n, [
    'dbPath', 'pid', 'workflowDigest', 'workflowProtocol', 'workflowReport', 'workflowSourceCommit',
  ], 'pending n8n')
  if (receipt.authorization.pending.path !== join(prepare.routing?.runDirectory?.path || '', 'bootstrap.pending.json')
    || dirname(receipt.authorization.prepare.path) !== bootstrapDirectory
    || receipt.authorization.prepare.path !== join(bootstrapDirectory, 'prepare.receipt.json')
    || receipt.authorization.confirm.path !== join(bootstrapDirectory, 'current-confirm.receipt.json')
    || receipt.authorization.shutdown.path !== join(bootstrapDirectory, 'shutdown-requested.receipt.json')) {
    fail('pending authorization is not one canonical bootstrap chain')
  }

  const references = [
    ['prepare', pending.authorization.prepare, receipt.authorization.prepare],
    ['confirm', pending.authorization.confirm, receipt.authorization.confirm],
    ['shutdown', pending.authorization.shutdown, receipt.authorization.shutdown],
    ['evidence', pending.evidence, prepare.evidence],
    ['proof', pending.proof, prepare.proof],
  ]
  for (const [name, actual, expected] of references) {
    exactKeys(actual, ['dev', 'ino', 'path', 'sha256', 'size'], `pending ${name} reference`)
    if (canonicalJson(actual) !== canonicalJson(expected)) fail(`pending ${name} reference changed`)
  }

  validateCurrentFileIdentity(pending.databases.mission, 'pending Mission Control database')
  validateCurrentFileIdentity(pending.databases.n8n, 'pending n8n database')
  validateDisasterRouter(pending.router)
  const evidenceLoaded = readReferencedJsonMode(pending.evidence, 'pending freeze evidence', 0o600)
  const proofLoaded = readReferencedJsonMode(pending.proof, 'pending rollback proof', 0o600)
  const evidence = evidenceLoaded.value
  const proof = proofLoaded.value
  if (evidence?.schema !== LEGACY_FREEZE_EVIDENCE_SCHEMA) fail('pending freeze evidence schema is invalid')
  if (proof?.schema !== LEGACY_ROLLBACK_PROOF_SCHEMA) fail('pending rollback proof schema is invalid')
  validateDisasterWorkflowReport(
    pending.n8n.workflowReport, receipt, pending, bootstrapDirectory,
  )
  validateDisasterTransition(
    pending.transition,
    pending.bootstrapClaim,
    receipt,
    pending,
    prepare,
    packageResult,
    packagePath,
    runtimeRelease,
    n8nVersion,
  )
  validateIdentity(evidence?.legacy?.database, 'evidenced Mission Control database')
  validateIdentity(evidence?.legacy?.cwd, 'evidenced legacy cwd')
  validateIdentity(evidence?.n8n?.database, 'evidenced n8n database')

  const prepareTarget = prepare?.target
  const evidenceTarget = evidence?.target
  exactKeys(prepareTarget, ['manifest', 'releaseId', 'releaseRoot', 'releaseRootIdentity', 'slot'], 'prepared target')
  exactKeys(prepareTarget.manifest, ['dev', 'ino', 'path', 'sha256', 'size'], 'prepared release manifest')
  exactKeys(prepareTarget.releaseRootIdentity, ['dev', 'ino', 'path'], 'prepared release root identity')
  exactKeys(evidenceTarget, ['manifestSha256', 'releaseId', 'releaseRoot', 'slot'], 'evidenced target')
  const expectedTarget = {
    slot: pending.slot,
    releaseId: pending.releaseId,
    releaseRoot: pending.releaseRoot,
    manifestSha256: pending.manifestSha256,
  }
  if (!prepareTarget || !evidenceTarget
    || canonicalJson(expectedTarget) !== canonicalJson({
      slot: prepareTarget.slot,
      releaseId: prepareTarget.releaseId,
      releaseRoot: prepareTarget.releaseRoot,
      manifestSha256: prepareTarget.manifest?.sha256,
    })
    || canonicalJson(expectedTarget) !== canonicalJson(evidenceTarget)) {
    fail('pending release target changed')
  }
  if (!['blue', 'green'].includes(pending.slot) || typeof pending.releaseId !== 'string'
    || pending.releaseId.length < 1 || pending.releaseId.length > 160
    || !SHA256.test(pending.manifestSha256)) fail('pending release identity is invalid')
  normalizedAbsolute(pending.releaseRoot, 'pending release root')
  const releaseRootEntry = safeEntry(pending.releaseRoot, 'pending release root', 'directory')
  if (realpathSync(pending.releaseRoot) !== pending.releaseRoot
    || prepareTarget.releaseRootIdentity.path !== pending.releaseRoot
    || prepareTarget.releaseRootIdentity.dev !== releaseRootEntry.dev.toString()
    || prepareTarget.releaseRootIdentity.ino !== releaseRootEntry.ino.toString()) {
    fail('pending release root identity changed')
  }
  const manifestPath = join(pending.releaseRoot, 'release-manifest.json')
  const currentManifest = hashStableFile(manifestPath, 'pending release manifest', MAX_MANIFEST_BYTES)
  if (prepareTarget.manifest.path !== manifestPath
    || prepareTarget.manifest.dev !== currentManifest.entry.dev.toString()
    || prepareTarget.manifest.ino !== currentManifest.entry.ino.toString()
    || prepareTarget.manifest.size !== Number(currentManifest.entry.size)
    || prepareTarget.manifest.sha256 !== currentManifest.sha256
    || pending.manifestSha256 !== currentManifest.sha256) fail('pending release manifest changed')

  if (pending.schema !== BOOTSTRAP_PENDING_SCHEMA || pending.attemptId !== receipt.authorization.attemptId
    || !Number.isSafeInteger(pending.createdAt) || pending.createdAt < shutdown.requestedAt
    || pending.baselineSourceCommit !== prepare.sourceCommit || !COMMIT.test(pending.baselineSourceCommit)
    || canonicalJson(pending.databases) !== canonicalJson(prepare.databases)
    || canonicalJson(pending.databases) !== canonicalJson({
      mission: evidence.legacy.database,
      n8n: evidence.n8n.database,
    })
    || canonicalJson(pending.router) !== canonicalJson(prepare.routing)
    || pending.evidenceObservedAt !== evidence.observedAt
    || !Number.isSafeInteger(pending.evidenceObservedAt)
    || pending.legacyPid !== evidence.legacy.pid || !Number.isSafeInteger(pending.legacyPid)
    || pending.legacyPid <= 0 || pending.legacyCwd !== evidence.legacy.cwd?.path
    || pending.legacyReleaseId !== evidence.legacy.releaseId
    || typeof pending.legacyReleaseId !== 'string' || pending.legacyReleaseId.length < 1
    || pending.n8n.pid !== evidence.n8n.pid || !Number.isSafeInteger(pending.n8n.pid)
    || pending.n8n.pid <= 0 || pending.n8n.dbPath !== pending.databases.n8n.path
    || pending.n8n.workflowProtocol !== N8N_WORKFLOW_PROTOCOL
    || pending.n8n.workflowSourceCommit !== prepare.sourceCommit
    || !SHA256.test(pending.n8n.workflowDigest)
    || canonicalJson(pending.proof) !== canonicalJson(receipt.authorization.proof)
    || canonicalJson(pending.proof) !== canonicalJson(prepare.proof)
    || confirmed.expiresAt !== receipt.authorization.originalConfirmationExpiresAt) {
    fail('bootstrap pending v4 binding is invalid')
  }
  return pending
}

function pathIdentity(pathname, label) {
  const entry = safeEntry(pathname, label, 'file')
  return {
    dev: `0x${entry.dev.toString(16)}`,
    ino: entry.ino.toString(),
    bytes: Number(entry.size),
    mtimeNs: entry.mtimeNs.toString(),
  }
}

function parseLsofRecords(source) {
  const records = []
  let record = null
  for (const line of source.split('\n')) {
    if (!line) continue
    const field = line[0]
    const value = line.slice(1)
    if (field === 'f') {
      record = { descriptor: value }
      records.push(record)
    } else if (record && field === 'D') record.dev = BigInt(value).toString()
    else if (record && field === 'i') record.ino = BigInt(value).toString()
    else if (record && field === 'n') record.path = value
  }
  return records
}

function captureDatabaseHandle(databaseIdentity, label) {
  let source
  try {
    source = execFileSync('/usr/sbin/lsof', [
      '-a', '-p', String(process.pid), '-FfDin',
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  } catch { fail(`${label} open file query failed`) }
  const matches = parseLsofRecords(source).filter(item =>
    /^\d+[A-Za-z]*$/u.test(item.descriptor || '')
    && item.dev === BigInt(databaseIdentity.dev).toString()
    && item.ino === BigInt(databaseIdentity.ino).toString())
  if (matches.length !== 1) fail(`${label} SQLite handle does not match the preflight database inode`)
  return { descriptor: matches[0].descriptor, dev: matches[0].dev, ino: matches[0].ino }
}

function runDatabaseTestHook(name) {
  if (process.env.NODE_ENV !== 'test' || process.env.AIWORKER_TEST_N8N_RECOVERY_IDENTITY !== '1') return
  const pathname = process.env[`AIWORKER_TEST_N8N_RECOVERY_${name}`]
  if (!pathname) return
  normalizedAbsolute(pathname, `test ${name} hook`)
  assertPhysicalPath(pathname, `test ${name} hook`)
  try { execFileSync(pathname, [], { stdio: 'ignore' }) } catch { fail(`test ${name} hook failed`) }
}

function parseArguments(argv) {
  const command = argv[0]
  const allowedByCommand = {
    backup: new Set(['--database', '--module-root', '--n8n-version', '--output', '--source-commit']),
    'verify-package': new Set(['--n8n-version', '--package', '--source-commit']),
    'verify-export': new Set(['--export', '--id', '--package']),
    'database-sentinel': new Set(['--database', '--module-root']),
    'verify-receipt': new Set([
      '--database', '--n8n-version', '--package', '--receipt', '--runtime-release', '--source-commit',
    ]),
    'restore-journal': new Set([
      '--database', '--n8n-version', '--operation', '--package', '--receipt', '--runtime-release',
      '--source-commit', '--workflow-id',
    ]),
    'verify-disaster-receipt': new Set([
      '--database', '--n8n-version', '--package', '--receipt', '--runtime-release', '--source-commit',
    ]),
    'disaster-journal': new Set([
      '--database', '--n8n-version', '--operation', '--package', '--receipt', '--runtime-release',
      '--source-commit', '--workflow-id',
    ]),
  }
  const allowed = allowedByCommand[command]
  if (!allowed) fail('unsupported managed workflow recovery command')
  const values = {}
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(name) || !value || Object.hasOwn(values, name)) fail(`invalid argument ${String(name)}`)
    values[name] = value
  }
  if (Object.keys(values).length !== allowed.size) fail(`missing arguments for ${command}`)
  return { command, values }
}

function loadDatabase(moduleRoot) {
  normalizedAbsolute(moduleRoot, '--module-root')
  assertPhysicalPath(moduleRoot, '--module-root')
  try {
    const scopedRequire = createRequire(import.meta.url)
    return scopedRequire(scopedRequire.resolve('better-sqlite3', { paths: [moduleRoot] }))
  } catch { fail('better-sqlite3 is unavailable from --module-root') }
}

function tableColumns(db, table) {
  return new Set(db.pragma(`table_info(${table})`).map(row => row.name))
}

function requireColumns(db, table, names) {
  const columns = tableColumns(db, table)
  if (!names.every(name => columns.has(name))) fail(`${table} schema is incompatible`)
  return columns
}

function storedJson(value, label, fallback) {
  if (value === null || value === undefined || value === '') return fallback
  if (typeof value !== 'string') fail(`${label} is not stored JSON text`)
  return strictJson(value, label)
}

function assertNoCredentials(value, label) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoCredentials(entry, `${label}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === 'credentials') fail(`${label} contains a credential reference`)
    assertNoCredentials(child, `${label}.${key}`)
  }
}

function normalizeSemantic(value, expectedId, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.id !== expectedId || typeof value.name !== 'string' || value.name.length < 1
    || value.name.length > 256 || !Array.isArray(value.nodes)
    || !value.connections || typeof value.connections !== 'object' || Array.isArray(value.connections)
    || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) {
    fail(`${label} workflow shape is invalid`)
  }
  const semantic = {
    id: value.id,
    name: value.name,
    nodes: value.nodes,
    connections: value.connections,
    settings: value.settings,
    staticData: value.staticData ?? null,
    pinData: value.pinData ?? null,
    nodeGroups: value.nodeGroups ?? [],
  }
  if (!Array.isArray(semantic.nodeGroups)) fail(`${label}.nodeGroups is invalid`)
  assertNoCredentials(semantic, label)
  return semantic
}

function workflowSnapshot(db, descriptor) {
  const entityColumns = requireColumns(db, 'workflow_entity', [
    'id', 'name', 'active', 'isArchived', 'nodes', 'connections', 'settings', 'versionId',
    'activeVersionId',
  ])
  requireColumns(db, 'workflow_history', [
    'versionId', 'workflowId', 'name', 'nodes', 'connections', 'nodeGroups',
  ])
  const row = db.prepare('SELECT * FROM workflow_entity WHERE id = ?').get(descriptor.id)
  if (!row || ![0, 1].includes(row.active) || row.isArchived !== 0
    || typeof row.versionId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/u.test(row.versionId)) {
    fail(`managed workflow ${descriptor.id} is missing or invalid`)
  }
  let contentRow = row
  let selectedVersionId = row.versionId
  let origin = 'current'
  if (row.active === 1) {
    if (typeof row.activeVersionId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/u.test(row.activeVersionId)) {
      fail(`managed workflow ${descriptor.id} lacks one active published version`)
    }
    contentRow = db.prepare(
      'SELECT * FROM workflow_history WHERE workflowId = ? AND versionId = ?',
    ).get(descriptor.id, row.activeVersionId)
    if (!contentRow) fail(`managed workflow ${descriptor.id} active history is missing`)
    selectedVersionId = row.activeVersionId
    origin = 'published'
  }
  const raw = {
    id: descriptor.id,
    name: contentRow.name ?? row.name,
    nodes: storedJson(contentRow.nodes, `${descriptor.id}.nodes`, []),
    connections: storedJson(contentRow.connections, `${descriptor.id}.connections`, {}),
    settings: storedJson(row.settings, `${descriptor.id}.settings`, {}),
    staticData: entityColumns.has('staticData')
      ? storedJson(row.staticData, `${descriptor.id}.staticData`, null) : null,
    pinData: entityColumns.has('pinData')
      ? storedJson(row.pinData, `${descriptor.id}.pinData`, null) : null,
    nodeGroups: contentRow.nodeGroups === undefined
      ? [] : storedJson(contentRow.nodeGroups, `${descriptor.id}.nodeGroups`, []),
  }
  const semantic = normalizeSemantic(raw, descriptor.id, descriptor.id)
  return {
    semantic,
    importValue: { ...semantic, active: false, versionId: selectedVersionId },
    active: row.active === 1,
    origin,
    currentVersionId: row.versionId,
    activeVersionId: row.activeVersionId ?? null,
    selectedVersionId,
  }
}

function writeImmutable(pathname, source) {
  const descriptor = openSync(pathname, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o400)
  try {
    writeFileSync(descriptor, source)
    fchmodSync(descriptor, 0o400)
    fsyncSync(descriptor)
  } finally { closeSync(descriptor) }
  durabilityTrace('file', pathname)
}

function syncDirectory(pathname, label) {
  safeEntry(pathname, label, 'directory')
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isDirectory()) fail(`${label} changed before sync`)
    fsyncSync(descriptor)
  } finally { closeSync(descriptor) }
  durabilityTrace('directory', pathname)
}

function durabilityTrace(kind, pathname) {
  if (process.env.NODE_ENV !== 'test' || !process.env.AIWORKER_TEST_N8N_FSYNC_TRACE) return
  const trace = process.env.AIWORKER_TEST_N8N_FSYNC_TRACE
  normalizedAbsolute(trace, 'fsync trace')
  writeFileSync(trace, `${kind}:${pathname}\n`, { flag: 'a', mode: 0o600 })
}

function createBackup(values) {
  const database = values['--database']
  const moduleRoot = values['--module-root']
  const output = values['--output']
  const sourceCommit = values['--source-commit']
  const n8nVersion = values['--n8n-version']
  normalizedAbsolute(database, '--database')
  normalizedAbsolute(output, '--output')
  if (!COMMIT.test(sourceCommit)) fail('--source-commit must be one full Git commit')
  if (!VERSION.test(n8nVersion)) fail('--n8n-version is invalid')
  const databaseBefore = pathIdentity(database, 'n8n database')
  assertPhysicalPath(output, '--output', true)
  const parent = safeEntry(dirname(output), 'backup parent', 'directory')
  if ((Number(parent.mode & 0o777n) & 0o077) !== 0) fail('backup parent must be private')
  const Database = loadDatabase(moduleRoot)
  let db
  let snapshots
  let handleBefore
  try {
    runDatabaseTestHook('BEFORE_DATABASE_OPEN')
    db = new Database(database, { readonly: true, fileMustExist: true })
    runDatabaseTestHook('AFTER_DATABASE_OPEN')
    handleBefore = captureDatabaseHandle(databaseBefore, 'n8n backup')
    db.pragma('query_only = ON')
    db.exec('BEGIN')
    if (db.pragma('quick_check', { simple: true }) !== 'ok') fail('SQLite quick_check did not return ok')
    snapshots = MANAGED.map(descriptor => workflowSnapshot(db, descriptor))
    const handleAfter = captureDatabaseHandle(databaseBefore, 'n8n backup')
    if (canonicalJson(handleAfter) !== canonicalJson(handleBefore)) fail('n8n backup SQLite handle drifted')
    db.exec('COMMIT')
  } catch (error) {
    try { db?.exec('ROLLBACK') } catch {}
    throw error
  } finally { try { db?.close() } catch {} }
  const databaseAfter = pathIdentity(database, 'n8n database')
  if (canonicalJson(databaseAfter) !== canonicalJson(databaseBefore)) fail('n8n database identity drifted during backup')

  let created = false
  try {
    mkdirSync(output, { mode: 0o700 })
    created = true
    const reports = []
    for (let index = 0; index < MANAGED.length; index += 1) {
      const descriptor = MANAGED[index]
      const snapshot = snapshots[index]
      const source = `${canonicalJson(snapshot.importValue)}\n`
      writeImmutable(join(output, descriptor.file), source)
      reports.push({
        id: descriptor.id,
        file: descriptor.file,
        active: snapshot.active,
        origin: snapshot.origin,
        currentVersionId: snapshot.currentVersionId,
        activeVersionId: snapshot.activeVersionId,
        selectedVersionId: snapshot.selectedVersionId,
        bytes: Buffer.byteLength(source),
        fileSha256: sha256(source),
        semanticSha256: sha256(canonicalJson(snapshot.semantic)),
      })
    }
    const createdAt = Math.floor(Date.now() / 1000)
    const manifest = {
      schema: PACKAGE_SCHEMA,
      createdAt,
      source: {
        sourceCommit,
        n8nVersion,
        databaseFileName: basename(database),
        databaseIdentity: databaseBefore,
        quickCheck: 'ok',
      },
      workflows: reports,
      combinedSha256: sha256(reports.map(report => [
        report.id, report.active ? 'active' : 'inactive', report.fileSha256, report.semanticSha256,
      ].join(':')).join('\n')),
    }
    const manifestSource = `${canonicalJson(manifest)}\n`
    writeImmutable(join(output, 'manifest.json'), manifestSource)
    const directoryDescriptor = openSync(output, constants.O_RDONLY)
    try { fsyncSync(directoryDescriptor) } finally { closeSync(directoryDescriptor) }
    chmodSync(output, 0o500)
    process.stdout.write(`${JSON.stringify({
      schema: PACKAGE_SCHEMA,
      package: output,
      manifestSha256: sha256(manifestSource),
      combinedSha256: manifest.combinedSha256,
      workflows: reports.map(({ id, active, semanticSha256 }) => ({ id, active, semanticSha256 })),
    })}\n`)
  } catch (error) {
    if (created) {
      try { chmodSync(output, 0o700); rmSync(output, { recursive: true, force: true }) } catch {}
    }
    throw error
  }
}

function validatePackage(packagePath, expectedCommit = null, expectedVersion = null) {
  normalizedAbsolute(packagePath, '--package')
  safeEntry(packagePath, 'recovery package', 'directory', 0o500)
  const expectedMembers = ['manifest.json', ...MANAGED.map(item => item.file)].sort()
  const actualMembers = readdirSync(packagePath).sort()
  if (canonicalJson(actualMembers) !== canonicalJson(expectedMembers)) fail('recovery package member set is invalid')
  const loaded = readJsonFile(join(packagePath, 'manifest.json'), 'recovery manifest', 0o400, MAX_MANIFEST_BYTES)
  const manifest = loaded.value
  exactKeys(manifest, ['combinedSha256', 'createdAt', 'schema', 'source', 'workflows'], 'recovery manifest')
  exactKeys(
    manifest.source,
    ['databaseFileName', 'databaseIdentity', 'n8nVersion', 'quickCheck', 'sourceCommit'],
    'recovery source',
  )
  exactKeys(manifest.source.databaseIdentity, ['bytes', 'dev', 'ino', 'mtimeNs'], 'source database identity')
  if (manifest.schema !== PACKAGE_SCHEMA || !Number.isSafeInteger(manifest.createdAt)
    || manifest.createdAt <= 0 || manifest.createdAt > Math.floor(Date.now() / 1000) + 30
    || !SHA256.test(manifest.combinedSha256)
    || !COMMIT.test(manifest.source.sourceCommit) || !VERSION.test(manifest.source.n8nVersion)
    || manifest.source.quickCheck !== 'ok' || typeof manifest.source.databaseFileName !== 'string'
    || !Array.isArray(manifest.workflows) || manifest.workflows.length !== MANAGED.length) {
    fail('recovery manifest identity is invalid')
  }
  if (typeof manifest.source.databaseIdentity.dev !== 'string'
    || typeof manifest.source.databaseIdentity.ino !== 'string'
    || !Number.isSafeInteger(manifest.source.databaseIdentity.bytes)
    || typeof manifest.source.databaseIdentity.mtimeNs !== 'string') {
    fail('source database identity is invalid')
  }
  if (expectedCommit !== null && manifest.source.sourceCommit !== expectedCommit) fail('package source commit differs')
  if (expectedVersion !== null && manifest.source.n8nVersion !== expectedVersion) fail('package n8n version differs')
  const reports = []
  for (const descriptor of MANAGED) {
    const report = manifest.workflows.find(item => item?.id === descriptor.id)
    exactKeys(report, [
      'active', 'activeVersionId', 'bytes', 'currentVersionId', 'file', 'fileSha256', 'id',
      'origin', 'selectedVersionId', 'semanticSha256',
    ], `manifest workflow ${descriptor.id}`)
    if (report.file !== descriptor.file || typeof report.active !== 'boolean'
      || !['current', 'published'].includes(report.origin) || !Number.isSafeInteger(report.bytes)
      || report.bytes < 1 || !SHA256.test(report.fileSha256) || !SHA256.test(report.semanticSha256)
      || !/^[A-Za-z0-9-]{8,64}$/u.test(report.currentVersionId)
      || !/^[A-Za-z0-9-]{8,64}$/u.test(report.selectedVersionId)
      || (report.activeVersionId !== null && !/^[A-Za-z0-9-]{8,64}$/u.test(report.activeVersionId))
      || (report.active && (report.origin !== 'published' || report.activeVersionId !== report.selectedVersionId))
      || (!report.active && report.origin !== 'current')) {
      fail(`manifest workflow ${descriptor.id} is invalid`)
    }
    const member = readJsonFile(join(packagePath, descriptor.file), descriptor.file, 0o400, MAX_JSON_BYTES)
    if (Buffer.byteLength(member.source) !== report.bytes || sha256(member.source) !== report.fileSha256) {
      fail(`package member ${descriptor.file} changed`)
    }
    exactKeys(member.value, [
      'active', 'connections', 'id', 'name', 'nodeGroups', 'nodes', 'pinData', 'settings',
      'staticData', 'versionId',
    ], `package member ${descriptor.file}`)
    const semantic = normalizeSemantic(member.value, descriptor.id, descriptor.file)
    if (member.value.active !== false || member.value.versionId !== report.selectedVersionId
      || sha256(canonicalJson(semantic)) !== report.semanticSha256) {
      fail(`package member ${descriptor.file} semantic digest is invalid`)
    }
    reports.push({ ...report, semantic })
  }
  const combined = sha256(reports.map(report => [
    report.id, report.active ? 'active' : 'inactive', report.fileSha256, report.semanticSha256,
  ].join(':')).join('\n'))
  if (combined !== manifest.combinedSha256) fail('recovery package combined digest is invalid')
  return { manifest, manifestSha256: sha256(loaded.source), reports }
}

function verifyPackage(values) {
  const sourceCommit = values['--source-commit']
  const n8nVersion = values['--n8n-version']
  if (!COMMIT.test(sourceCommit) || !VERSION.test(n8nVersion)) fail('expected source identity is invalid')
  const result = validatePackage(values['--package'], sourceCommit, n8nVersion)
  process.stdout.write(`${JSON.stringify({
    schema: PACKAGE_SCHEMA,
    manifestSha256: result.manifestSha256,
    combinedSha256: result.manifest.combinedSha256,
    workflows: result.reports.map(({ id, file, active, semanticSha256 }) => ({
      id, file, active, semanticSha256,
    })),
  })}\n`)
}

function verifyExport(values) {
  const descriptor = MANAGED.find(item => item.id === values['--id'])
  if (!descriptor) fail('--id is not one managed workflow ID')
  const packageResult = validatePackage(values['--package'])
  normalizedAbsolute(values['--export'], '--export')
  const exported = readJsonFile(values['--export'], 'n8n CLI export', 0o600, MAX_JSON_BYTES).value
  const candidate = Array.isArray(exported) && exported.length === 1 ? exported[0] : exported
  const semantic = normalizeSemantic(candidate, descriptor.id, 'n8n CLI export')
  const expected = packageResult.reports.find(item => item.id === descriptor.id)
  const digest = sha256(canonicalJson(semantic))
  if (digest !== expected.semanticSha256) fail(`restored workflow ${descriptor.id} semantic digest differs`)
  process.stdout.write(`${JSON.stringify({ id: descriptor.id, semanticSha256: digest })}\n`)
}

function databaseSentinel(values) {
  const database = values['--database']
  normalizedAbsolute(database, '--database')
  const before = pathIdentity(database, 'n8n database')
  const Database = loadDatabase(values['--module-root'])
  let db
  let handleBefore
  try {
    runDatabaseTestHook('BEFORE_DATABASE_OPEN')
    db = new Database(database, { readonly: true, fileMustExist: true })
    runDatabaseTestHook('AFTER_DATABASE_OPEN')
    handleBefore = captureDatabaseHandle(before, 'n8n sentinel')
    db.pragma('query_only = ON')
    db.exec('BEGIN')
    if (db.pragma('quick_check', { simple: true }) !== 'ok') fail('SQLite quick_check did not return ok')
    const existingTables = new Set(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    ).all().map(row => row.name))
    for (const required of ['workflow_entity', 'settings', 'execution_entity']) {
      if (!existingTables.has(required)) fail(`sentinel table ${required} is missing`)
    }
    const targets = [
      { table: 'workflow_entity', predicate: `id NOT IN (${MANAGED.map(() => '?').join(',')})` },
      { table: 'workflow_history', predicate: `workflowId NOT IN (${MANAGED.map(() => '?').join(',')})`, optional: true },
      { table: 'shared_workflow', predicate: `workflowId NOT IN (${MANAGED.map(() => '?').join(',')})`, optional: true },
      { table: 'settings', predicate: '1 = 1' },
      { table: 'execution_entity', predicate: '1 = 1' },
    ]
    const tables = []
    for (const target of targets) {
      if (!existingTables.has(target.table)) {
        if (target.optional) continue
        fail(`sentinel table ${target.table} is missing`)
      }
      const parameters = target.predicate.includes('?') ? [...MANAGED_IDS] : []
      const rows = db.prepare(`SELECT * FROM ${target.table} WHERE ${target.predicate}`).all(...parameters)
      const rowDigests = rows.map(row => sha256(canonicalJson(row))).sort()
      tables.push({ table: target.table, rows: rows.length, sha256: sha256(rowDigests.join('\n')) })
    }
    const handleAfter = captureDatabaseHandle(before, 'n8n sentinel')
    if (canonicalJson(handleAfter) !== canonicalJson(handleBefore)) fail('n8n sentinel SQLite handle drifted')
    db.exec('COMMIT')
    const after = pathIdentity(database, 'n8n database')
    if (before.dev !== after.dev || before.ino !== after.ino) fail('n8n database identity drifted during sentinel read')
    process.stdout.write(`${JSON.stringify({
      schema: SENTINEL_SCHEMA,
      tables,
      combinedSha256: sha256(canonicalJson(tables)),
    })}\n`)
  } catch (error) {
    try { db?.exec('ROLLBACK') } catch {}
    throw error
  } finally { try { db?.close() } catch {} }
}

function validateReceipt(values, allowExpired = false) {
  const packageResult = validatePackage(values['--package'])
  const sourceCommit = values['--source-commit']
  const n8nVersion = values['--n8n-version']
  if (!COMMIT.test(sourceCommit) || !VERSION.test(n8nVersion)
    || packageResult.manifest.source.sourceCommit !== sourceCommit
    || packageResult.manifest.source.n8nVersion !== n8nVersion) fail('restore source identity is invalid')
  const database = values['--database']
  normalizedAbsolute(database, '--database')
  const databaseIdentity = pathIdentity(database, 'n8n database')
  const runtimeRelease = values['--runtime-release']
  normalizedAbsolute(runtimeRelease, '--runtime-release')
  assertPhysicalPath(runtimeRelease, '--runtime-release')
  if (realpathSync(runtimeRelease) !== runtimeRelease) fail('--runtime-release must be one physical path')
  const loaded = readJsonFile(values['--receipt'], 'confirmation receipt', 0o400, MAX_RECEIPT_BYTES)
  const receipt = loaded.value
  exactKeys(receipt, [
    'action', 'authorization', 'expiresAt', 'issuedAt', 'nonce', 'packageManifestSha256',
    'schema', 'target', 'uid',
  ], 'confirmation receipt')
  exactKeys(receipt.target, [
    'databaseDev', 'databaseIno', 'n8nVersion', 'runtimeRelease', 'sourceCommit',
  ], 'confirmation target')
  exactKeys(receipt.authorization, [
    'attemptId', 'confirm', 'controllerSha256', 'kind', 'prepare', 'shutdown',
  ], 'confirmation authorization')
  if (receipt.authorization.kind !== BOOTSTRAP_SHUTDOWN_AUTHORIZATION
    || typeof receipt.authorization.attemptId !== 'string'
    || !/^[a-f0-9-]{36}$/u.test(receipt.authorization.attemptId)
    || !SHA256.test(receipt.authorization.controllerSha256)) {
    fail('confirmation authorization is invalid')
  }
  const prepareLoaded = readReferencedJson(receipt.authorization.prepare, 'bootstrap prepare receipt')
  const confirmLoaded = readReferencedJson(receipt.authorization.confirm, 'bootstrap current confirmation')
  const shutdownLoaded = readReferencedJson(receipt.authorization.shutdown, 'bootstrap shutdown receipt')
  const authorizationDirectory = dirname(receipt.authorization.prepare.path)
  if (basename(receipt.authorization.prepare.path) !== 'prepare.receipt.json'
    || basename(receipt.authorization.confirm.path) !== 'current-confirm.receipt.json'
    || basename(receipt.authorization.shutdown.path) !== 'shutdown-requested.receipt.json'
    || dirname(receipt.authorization.confirm.path) !== authorizationDirectory
    || dirname(receipt.authorization.shutdown.path) !== authorizationDirectory
    || dirname(values['--receipt']) !== authorizationDirectory
    || basename(values['--receipt']) !== 'n8n-restore-confirmation.receipt.json') {
    fail('confirmation authorization is not one canonical bootstrap attempt chain')
  }
  const prepare = prepareLoaded.value
  const confirmed = confirmLoaded.value
  const shutdown = shutdownLoaded.value
  const attemptId = receipt.authorization.attemptId
  if (prepare?.schema !== BOOTSTRAP_PREPARE_SCHEMA || prepare.attemptId !== attemptId
    || prepare.uid !== process.getuid() || prepare.sourceCommit !== sourceCommit
    || prepare.prepareToolSha256 !== receipt.authorization.controllerSha256
    || !prepare.databases?.n8n || typeof prepare.databases.n8n !== 'object'
    || prepare.databases.n8n.path !== database
    || BigInt(prepare.databases.n8n.dev) !== BigInt(databaseIdentity.dev)
    || BigInt(prepare.databases.n8n.ino) !== BigInt(databaseIdentity.ino)) {
    fail('bootstrap prepare receipt does not authorize this n8n database restore')
  }
  if (confirmed?.schema !== BOOTSTRAP_CONFIRM_SCHEMA || confirmed.attemptId !== attemptId
    || confirmed.uid !== process.getuid() || confirmed.sourceCommit !== sourceCommit
    || canonicalJson(confirmed.prepare) !== canonicalJson(receipt.authorization.prepare)
    || confirmed.previousReceiptSha256 !== receipt.authorization.prepare.sha256
    || !SHA256.test(confirmed.tokenSha256) || !Number.isSafeInteger(confirmed.confirmedAt)
    || !Number.isSafeInteger(confirmed.expiresAt) || confirmed.expiresAt <= confirmed.confirmedAt
    || confirmed.expiresAt - confirmed.confirmedAt > 120) {
    fail('bootstrap current confirmation does not authorize this restore')
  }
  if (shutdown?.schema !== BOOTSTRAP_SHUTDOWN_SCHEMA || shutdown.attemptId !== attemptId
    || shutdown.uid !== process.getuid() || shutdown.sourceCommit !== sourceCommit
    || canonicalJson(shutdown.prepare) !== canonicalJson(receipt.authorization.prepare)
    || canonicalJson(shutdown.confirm) !== canonicalJson(receipt.authorization.confirm)
    || shutdown.previousReceiptSha256 !== receipt.authorization.confirm.sha256
    || shutdown.tokenSha256 !== confirmed.tokenSha256 || !Number.isSafeInteger(shutdown.requestedAt)
    || shutdown.requestedAt < confirmed.confirmedAt || shutdown.requestedAt > confirmed.expiresAt) {
    fail('bootstrap shutdown receipt does not authorize this restore')
  }
  const now = nowSeconds()
  if (receipt.schema !== RECEIPT_SCHEMA || receipt.action !== 'restore-managed-n8n-workflows'
    || receipt.uid !== process.getuid() || !Number.isSafeInteger(receipt.issuedAt)
    || !Number.isSafeInteger(receipt.expiresAt) || receipt.issuedAt > now + 30
    || receipt.issuedAt < shutdown.requestedAt || receipt.expiresAt !== confirmed.expiresAt
    || receipt.expiresAt <= receipt.issuedAt
    || receipt.expiresAt - receipt.issuedAt > CONFIRMATION_TTL_SECONDS
    || !SHA256.test(receipt.nonce) || receipt.packageManifestSha256 !== packageResult.manifestSha256
    || receipt.target.databaseDev !== databaseIdentity.dev
    || receipt.target.databaseIno !== databaseIdentity.ino
    || receipt.target.sourceCommit !== sourceCommit || receipt.target.n8nVersion !== n8nVersion
    || receipt.target.runtimeRelease !== runtimeRelease) {
    fail('confirmation receipt is invalid, expired, or bound to another restore')
  }
  if (!allowExpired && now > receipt.expiresAt) {
    fail('confirmation receipt is invalid, expired, or bound to another restore')
  }
  const journalDirectory = join(authorizationDirectory, 'n8n-managed-workflow-restore-journal')
  return {
    receipt,
    receiptSha256: sha256(loaded.source),
    inputSha256: sha256(canonicalJson({
      packageManifestSha256: packageResult.manifestSha256,
      databaseDev: databaseIdentity.dev,
      databaseIno: databaseIdentity.ino,
      runtimeRelease,
      sourceCommit,
      n8nVersion,
    })),
    expired: now > receipt.expiresAt,
    journal: {
      directory: journalDirectory,
      claim: join(authorizationDirectory, 'n8n-managed-workflow-restore.CLAIMED.receipt.json'),
      events: join(journalDirectory, 'events'),
      completed: join(journalDirectory, 'COMMITTED.receipt.json'),
    },
  }
}

function verifyReceipt(values) {
  const validated = validateReceipt(values)
  process.stdout.write(`${JSON.stringify({
    schema: RECEIPT_SCHEMA,
    confirmedAt: validated.receipt.issuedAt,
    expiresAt: validated.receipt.expiresAt,
    packageManifestSha256: validated.receipt.packageManifestSha256,
  })}\n`)
}

function restoreEvents(validated) {
  const directory = validated.journal.events
  if (!existsSync(directory)) return []
  safeEntry(directory, 'restore journal events', 'directory', 0o700)
  const names = readdirSync(directory).sort()
  const events = []
  let previousSha256 = null
  let completedWorkflows = []
  let previousState = null
  let currentWorkflow = null
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] !== `${String(index).padStart(4, '0')}.receipt.json`) {
      fail('restore journal sequence has a gap')
    }
    const loaded = readJsonFile(
      join(directory, names[index]), 'restore journal event', 0o400, MAX_RECEIPT_BYTES,
    )
    const value = loaded.value
    exactKeys(value, [
      'at', 'completedWorkflows', 'currentWorkflow', 'index', 'inputSha256', 'previousSha256',
      'receiptSha256', 'schema', 'state',
    ], 'restore journal event')
    if (value.schema !== RESTORE_JOURNAL_SCHEMA || value.index !== index
      || value.receiptSha256 !== validated.receiptSha256
      || value.inputSha256 !== validated.inputSha256
      || value.previousSha256 !== previousSha256 || !Number.isSafeInteger(value.at)
      || !['CLAIMED', 'MUTATING', 'VERIFIED', 'COMMITTED'].includes(value.state)
      || !Array.isArray(value.completedWorkflows)
      || value.completedWorkflows.some(id => !MANAGED_IDS.has(id))
      || (value.currentWorkflow !== null && !MANAGED_IDS.has(value.currentWorkflow))
      || canonicalJson(value.completedWorkflows.slice().sort()) !== canonicalJson(value.completedWorkflows)
      || !completedWorkflows.every(id => value.completedWorkflows.includes(id))) {
      fail('restore journal chain is invalid')
    }
    if (index === 0 && (value.state !== 'CLAIMED' || value.completedWorkflows.length !== 0
      || value.currentWorkflow !== null)) {
      fail('restore journal does not start at CLAIMED')
    }
    if (index > 0) {
      const allowed = previousState === 'CLAIMED' ? ['MUTATING']
        : previousState === 'MUTATING' ? ['MUTATING', 'VERIFIED']
          : previousState === 'VERIFIED' ? ['COMMITTED'] : []
      if (!allowed.includes(value.state)) fail('restore journal state transition is invalid')
      if (value.state === 'MUTATING') {
        if (currentWorkflow === null) {
          const expected = MANAGED[completedWorkflows.length]?.id
          if (value.currentWorkflow !== expected
            || canonicalJson(value.completedWorkflows) !== canonicalJson(completedWorkflows)) {
            fail('restore journal workflow start is invalid')
          }
        } else if (value.currentWorkflow !== null
          || canonicalJson(value.completedWorkflows) !== canonicalJson([...completedWorkflows, currentWorkflow])) {
          fail('restore journal workflow completion is invalid')
        }
      } else if (value.currentWorkflow !== null
        || canonicalJson(value.completedWorkflows) !== canonicalJson(completedWorkflows)) {
        fail('restore journal terminal progress is invalid')
      }
    }
    if ((value.state === 'VERIFIED' || value.state === 'COMMITTED')
      && value.completedWorkflows.length !== MANAGED.length) {
      fail('restore journal verified too early')
    }
    completedWorkflows = value.completedWorkflows
    currentWorkflow = value.currentWorkflow
    previousState = value.state
    previousSha256 = sha256(loaded.source)
    events.push({ ...value, sha256: previousSha256 })
  }
  return events
}

function appendRestoreEvent(validated, state, completedWorkflows, currentWorkflow, previous) {
  const index = previous ? previous.index + 1 : 0
  const value = {
    schema: RESTORE_JOURNAL_SCHEMA,
    index,
    state,
    at: nowSeconds(),
    receiptSha256: validated.receiptSha256,
    inputSha256: validated.inputSha256,
    previousSha256: previous?.sha256 ?? null,
    completedWorkflows: [...completedWorkflows].sort(),
    currentWorkflow,
  }
  writeImmutable(
    join(validated.journal.events, `${String(index).padStart(4, '0')}.receipt.json`),
    `${canonicalJson(value)}\n`,
  )
  syncDirectory(validated.journal.events, 'restore journal events')
  return value
}

function readRestoreClaim(validated) {
  if (!existsSync(validated.journal.claim)) return null
  const loaded = readJsonFile(
    validated.journal.claim, 'restore claim marker', 0o400, MAX_RECEIPT_BYTES,
  )
  const value = loaded.value
  exactKeys(value, [
    'at', 'completedWorkflows', 'currentWorkflow', 'index', 'inputSha256', 'previousSha256',
    'receiptSha256', 'schema', 'state',
  ], 'restore claim marker')
  if (value.schema !== RESTORE_JOURNAL_SCHEMA || value.index !== 0 || value.state !== 'CLAIMED'
    || !Number.isSafeInteger(value.at) || value.receiptSha256 !== validated.receiptSha256
    || value.inputSha256 !== validated.inputSha256 || value.previousSha256 !== null
    || canonicalJson(value.completedWorkflows) !== '[]' || value.currentWorkflow !== null) {
    fail('restore claim marker is invalid')
  }
  return loaded
}

function validateRestoreJournalMembers(journal) {
  if (!existsSync(journal.directory)) return
  safeEntry(journal.directory, 'restore journal directory', 'directory', 0o700)
  const allowed = new Set(['events', 'COMMITTED.receipt.json'])
  for (const name of readdirSync(journal.directory)) {
    if (!allowed.has(name)) fail('restore journal contains an unknown member')
  }
}

function restoreJournal(values) {
  const validated = validateReceipt(values, true)
  const operation = values['--operation']
  const workflowId = values['--workflow-id']
  if (!['claim', 'start', 'workflow', 'verified', 'committed', 'status'].includes(operation)) {
    fail('invalid restore journal operation')
  }
  const journal = validated.journal
  safeEntry(dirname(journal.directory), 'restore journal parent', 'directory', 0o700)
  validateRestoreJournalMembers(journal)
  let claim = readRestoreClaim(validated)
  if (!claim) {
    if (existsSync(journal.completed)) fail('restore committed marker appeared before claim')
    if (existsSync(journal.events)) {
      safeEntry(journal.events, 'restore journal events', 'directory', 0o700)
      if (readdirSync(journal.events).length !== 0) {
        fail('restore journal events appeared before claim')
      }
    }
    if (operation !== 'claim') fail('restore has not been claimed')
    if (validated.expired) fail('restore claim expired')
    const claimed = {
      schema: RESTORE_JOURNAL_SCHEMA,
      index: 0,
      state: 'CLAIMED',
      at: nowSeconds(),
      receiptSha256: validated.receiptSha256,
      inputSha256: validated.inputSha256,
      previousSha256: null,
      completedWorkflows: [],
      currentWorkflow: null,
    }
    assertPhysicalPath(journal.claim, 'restore claim marker', true)
    writeImmutable(journal.claim, `${canonicalJson(claimed)}\n`)
    syncDirectory(dirname(journal.claim), 'restore claim parent')
    if (process.env.NODE_ENV === 'test'
      && process.env.AIWORKER_TEST_N8N_CRASH_AFTER_RESTORE_CLAIM === '1') {
      process.kill(process.pid, 'SIGKILL')
    }
    claim = readRestoreClaim(validated)
  }
  if (!existsSync(journal.directory)) {
    assertPhysicalPath(journal.directory, 'restore journal directory', true)
    mkdirSync(journal.directory, { mode: 0o700 })
    syncDirectory(dirname(journal.directory), 'restore journal parent')
  }
  validateRestoreJournalMembers(journal)
  if (!existsSync(journal.events)) {
    assertPhysicalPath(journal.events, 'restore journal events', true)
    mkdirSync(journal.events, { mode: 0o700 })
    syncDirectory(journal.directory, 'restore journal directory')
  }
  let events = restoreEvents(validated)
  if (events.length === 0) {
    writeImmutable(join(journal.events, '0000.receipt.json'), claim.source)
    syncDirectory(journal.events, 'restore journal events')
    events = restoreEvents(validated)
  }
  let last = events.at(-1)
  if (last?.state === 'COMMITTED') {
    if (!existsSync(journal.completed)) {
      writeImmutable(journal.completed, `${canonicalJson(last)}\n`)
      syncDirectory(journal.directory, 'restore journal directory')
    } else {
      const completed = readJsonFile(
        journal.completed, 'restore committed marker', 0o400, MAX_RECEIPT_BYTES,
      )
      if (completed.source !== `${canonicalJson(last)}\n`) {
        fail('restore committed marker differs from the journal')
      }
    }
    fail('completed restore cannot be replayed')
  }
  if (existsSync(journal.completed)) fail('restore committed marker appeared before commit')
  if (operation === 'start') {
    if (!MANAGED_IDS.has(workflowId)) fail('invalid restore workflow journal ID')
    if (!last || !['CLAIMED', 'MUTATING'].includes(last.state)) {
      fail('restore workflow stage is out of order')
    }
    if (last.completedWorkflows.includes(workflowId)) {
      fail('completed restore workflow cannot restart')
    }
    if (last.currentWorkflow === null) {
      if (MANAGED[last.completedWorkflows.length]?.id !== workflowId) {
        fail('restore workflows must start in fixed order')
      }
      appendRestoreEvent(validated, 'MUTATING', last.completedWorkflows, workflowId, last)
      events = restoreEvents(validated)
      last = events.at(-1)
    } else if (last.currentWorkflow !== workflowId) {
      fail('another restore workflow is already in progress')
    }
  } else if (operation === 'workflow') {
    if (!MANAGED_IDS.has(workflowId)) fail('invalid restore workflow journal ID')
    if (!last || last.state !== 'MUTATING') {
      fail('restore workflow stage is out of order')
    }
    if (!last.completedWorkflows.includes(workflowId)) {
      if (last.currentWorkflow !== workflowId) fail('restore workflow was not started')
      appendRestoreEvent(
        validated, 'MUTATING', [...last.completedWorkflows, workflowId], null, last,
      )
      events = restoreEvents(validated)
      last = events.at(-1)
    }
  } else if (operation === 'verified') {
    if (!last || !['MUTATING', 'VERIFIED'].includes(last.state)
      || last.completedWorkflows.length !== MANAGED.length || last.currentWorkflow !== null) {
      fail('restore cannot be verified before both workflows')
    }
    if (last.state === 'MUTATING') {
      appendRestoreEvent(validated, 'VERIFIED', last.completedWorkflows, null, last)
      events = restoreEvents(validated)
      last = events.at(-1)
    }
  } else if (operation === 'committed') {
    if (!last || last.state !== 'VERIFIED') fail('restore cannot commit before verification')
    appendRestoreEvent(validated, 'COMMITTED', last.completedWorkflows, null, last)
    const finalEvent = restoreEvents(validated).at(-1)
    writeImmutable(journal.completed, `${canonicalJson(finalEvent)}\n`)
    syncDirectory(journal.directory, 'restore journal directory')
    last = finalEvent
  }
  if (events.length > 0 || last) {
    const firstPath = join(journal.events, '0000.receipt.json')
    const firstSource = readFileSync(firstPath, 'utf8')
    if (claim.source !== firstSource) fail('restore claim marker differs from the journal')
  }
  process.stdout.write(`${JSON.stringify({
    state: last?.state ?? null,
    completedWorkflows: last?.completedWorkflows ?? [],
    currentWorkflow: last?.currentWorkflow ?? null,
    receiptSha256: validated.receiptSha256,
    inputSha256: validated.inputSha256,
  })}\n`)
}

function validateDisasterReceipt(values) {
  const packageResult = validatePackage(values['--package'])
  const sourceCommit = values['--source-commit']
  const n8nVersion = values['--n8n-version']
  if (!COMMIT.test(sourceCommit) || !VERSION.test(n8nVersion)
    || packageResult.manifest.source.sourceCommit !== sourceCommit
    || packageResult.manifest.source.n8nVersion !== n8nVersion) fail('disaster recovery source identity is invalid')
  const databaseIdentity = pathIdentity(values['--database'], 'n8n database')
  const runtimeRelease = values['--runtime-release']
  normalizedAbsolute(runtimeRelease, '--runtime-release')
  if (realpathSync(runtimeRelease) !== runtimeRelease) fail('--runtime-release must be physical')
  const loaded = readJsonFile(values['--receipt'], 'disaster recovery receipt', 0o400, MAX_RECEIPT_BYTES)
  const receipt = loaded.value
  exactKeys(receipt, [
    'action', 'authorization', 'expiresAt', 'issuedAt', 'journal', 'nonce',
    'packageManifestSha256', 'recoveryAttemptId', 'schema', 'scope', 'target', 'uid',
  ], 'disaster recovery receipt')
  exactKeys(receipt.target, ['databaseDev', 'databaseIno', 'n8nVersion', 'runtimeRelease', 'sourceCommit'], 'disaster target')
  exactKeys(receipt.authorization, [
    'attemptId', 'branchClaim', 'confirm', 'controllerSha256', 'kind', 'originalConfirmationExpiresAt',
    'pending', 'prepare', 'proof', 'shutdown', 'transition', 'workflowReport',
  ], 'disaster authorization')
  exactKeys(receipt.journal, ['claim', 'completed', 'directory', 'events', 'schema'], 'disaster journal')
  const recoveryDirectory = dirname(values['--receipt'])
  const bootstrapDirectory = dirname(dirname(recoveryDirectory))
  if (basename(values['--receipt']) !== 'n8n-disaster-recovery-confirmation.receipt.json'
    || basename(dirname(recoveryDirectory)) !== 'disaster-recovery-attempts'
    || basename(recoveryDirectory) !== receipt.recoveryAttemptId
    || receipt.journal.schema !== DISASTER_JOURNAL_SCHEMA
    || receipt.journal.directory !== recoveryDirectory
    || receipt.journal.claim !== join(recoveryDirectory, 'CLAIMED.receipt.json')
    || receipt.journal.events !== join(recoveryDirectory, 'events')
    || receipt.journal.completed !== join(recoveryDirectory, 'COMMITTED.receipt.json')) {
    fail('disaster recovery path or journal binding is invalid')
  }
  const prepareLoaded = readReferencedJson(receipt.authorization.prepare, 'bootstrap prepare receipt')
  const confirmLoaded = readReferencedJson(receipt.authorization.confirm, 'bootstrap current confirmation')
  const shutdownLoaded = readReferencedJson(receipt.authorization.shutdown, 'bootstrap shutdown receipt')
  const pendingLoaded = readReferencedJson(receipt.authorization.pending, 'bootstrap pending v4')
  if (dirname(receipt.authorization.prepare.path) !== bootstrapDirectory
    || dirname(receipt.authorization.confirm.path) !== bootstrapDirectory
    || dirname(receipt.authorization.shutdown.path) !== bootstrapDirectory) {
    fail('disaster recovery receipt is outside its bootstrap attempt')
  }
  const prepare = prepareLoaded.value
  const confirmed = confirmLoaded.value
  const shutdown = shutdownLoaded.value
  const attemptId = receipt.authorization.attemptId
  validateDisasterRecoveryBranch(receipt.authorization.branchClaim, bootstrapDirectory, receipt)
  if (receipt.authorization.kind !== 'legacy-bootstrap-disaster-recovery/v1'
    || prepare?.schema !== BOOTSTRAP_PREPARE_SCHEMA || prepare.attemptId !== attemptId
    || confirmed?.schema !== BOOTSTRAP_CONFIRM_SCHEMA || confirmed.attemptId !== attemptId
    || shutdown?.schema !== BOOTSTRAP_SHUTDOWN_SCHEMA || shutdown.attemptId !== attemptId
    || prepare.prepareToolSha256 !== receipt.authorization.controllerSha256
    || canonicalJson(prepare.proof) !== canonicalJson(receipt.authorization.proof)
    || confirmed.expiresAt !== receipt.authorization.originalConfirmationExpiresAt
    || canonicalJson(shutdown.prepare) !== canonicalJson(receipt.authorization.prepare)
    || canonicalJson(shutdown.confirm) !== canonicalJson(receipt.authorization.confirm)) {
    fail('disaster recovery bootstrap authorization chain is invalid')
  }
  const pending = validateDisasterPending(
    pendingLoaded,
    receipt,
    prepare,
    confirmed,
    shutdown,
    bootstrapDirectory,
    packageResult,
    values['--package'],
    runtimeRelease,
    n8nVersion,
  )
  if (receipt.schema !== DISASTER_RECEIPT_SCHEMA || receipt.action !== 'restore-managed-n8n-workflows'
    || receipt.scope !== 'n8n-managed-workflow-restore-only' || receipt.uid !== process.getuid()
    || !Number.isSafeInteger(receipt.issuedAt) || !Number.isSafeInteger(receipt.expiresAt)
    || receipt.expiresAt !== receipt.issuedAt + 120 || !SHA256.test(receipt.nonce)
    || receipt.packageManifestSha256 !== packageResult.manifestSha256
    || receipt.target.databaseDev !== databaseIdentity.dev || receipt.target.databaseIno !== databaseIdentity.ino
    || receipt.target.sourceCommit !== sourceCommit || receipt.target.n8nVersion !== n8nVersion
    || receipt.target.runtimeRelease !== runtimeRelease
    || prepare.databases?.n8n?.path !== values['--database']
    || BigInt(prepare.databases.n8n.dev) !== BigInt(databaseIdentity.dev)
    || BigInt(prepare.databases.n8n.ino) !== BigInt(databaseIdentity.ino)
    || pending.databases?.n8n?.path !== values['--database']
    || BigInt(pending.databases.n8n.dev) !== BigInt(databaseIdentity.dev)
    || BigInt(pending.databases.n8n.ino) !== BigInt(databaseIdentity.ino)) {
    fail('disaster recovery receipt target is invalid')
  }
  return {
    receipt,
    receiptSha256: sha256(loaded.source),
    inputSha256: sha256(canonicalJson({
      packageManifestSha256: packageResult.manifestSha256,
      databaseDev: databaseIdentity.dev,
      databaseIno: databaseIdentity.ino,
      runtimeRelease,
      sourceCommit,
      n8nVersion,
    })),
  }
}

function disasterEvents(validated) {
  const directory = validated.receipt.journal.events
  if (!existsSync(directory)) return []
  safeEntry(directory, 'disaster journal events', 'directory', 0o700)
  const names = readdirSync(directory).sort()
  const events = []
  let previousSha256 = null
  let completedWorkflows = []
  let previousState = null
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] !== `${String(index).padStart(4, '0')}.receipt.json`) fail('disaster journal sequence has a gap')
    const loaded = readJsonFile(join(directory, names[index]), 'disaster journal event', 0o400, MAX_RECEIPT_BYTES)
    const value = loaded.value
    exactKeys(value, [
      'at', 'completedWorkflows', 'index', 'inputSha256', 'previousSha256', 'receiptSha256', 'schema', 'state',
    ], 'disaster journal event')
    if (value.schema !== DISASTER_JOURNAL_SCHEMA || value.index !== index
      || value.receiptSha256 !== validated.receiptSha256 || value.inputSha256 !== validated.inputSha256
      || value.previousSha256 !== previousSha256 || !Number.isSafeInteger(value.at)
      || !['CLAIMED', 'MUTATING', 'VERIFIED', 'COMMITTED'].includes(value.state)
      || !Array.isArray(value.completedWorkflows)
      || value.completedWorkflows.some(id => !MANAGED_IDS.has(id))
      || canonicalJson(value.completedWorkflows.slice().sort()) !== canonicalJson(value.completedWorkflows)
      || !completedWorkflows.every(id => value.completedWorkflows.includes(id))) fail('disaster journal chain is invalid')
    if (index === 0 && (value.state !== 'CLAIMED' || value.completedWorkflows.length !== 0)) {
      fail('disaster journal does not start at CLAIMED')
    }
    if (index > 0) {
      const allowed = previousState === 'CLAIMED' ? ['MUTATING']
        : previousState === 'MUTATING' ? ['MUTATING', 'VERIFIED']
          : previousState === 'VERIFIED' ? ['COMMITTED'] : []
      if (!allowed.includes(value.state)) fail('disaster journal state transition is invalid')
      const expectedGrowth = value.state === 'MUTATING' ? completedWorkflows.length + 1 : completedWorkflows.length
      if (value.completedWorkflows.length !== expectedGrowth) fail('disaster journal workflow progress is invalid')
    }
    if (value.state === 'VERIFIED' || value.state === 'COMMITTED') {
      if (value.completedWorkflows.length !== MANAGED.length) fail('disaster journal verified too early')
    }
    completedWorkflows = value.completedWorkflows
    previousState = value.state
    previousSha256 = sha256(loaded.source)
    events.push({ ...value, sha256: previousSha256 })
  }
  return events
}

function appendDisasterEvent(validated, state, completedWorkflows, previous) {
  const index = previous ? previous.index + 1 : 0
  const value = {
    schema: DISASTER_JOURNAL_SCHEMA,
    index,
    state,
    at: nowSeconds(),
    receiptSha256: validated.receiptSha256,
    inputSha256: validated.inputSha256,
    previousSha256: previous?.sha256 ?? null,
    completedWorkflows: [...completedWorkflows].sort(),
  }
  writeImmutable(join(validated.receipt.journal.events, `${String(index).padStart(4, '0')}.receipt.json`),
    `${canonicalJson(value)}\n`)
  syncDirectory(validated.receipt.journal.events, 'disaster journal events')
  return value
}

function readDisasterClaim(validated) {
  const pathname = validated.receipt.journal.claim
  if (!existsSync(pathname)) return null
  const loaded = readJsonFile(pathname, 'disaster claim marker', 0o400, MAX_RECEIPT_BYTES)
  const value = loaded.value
  exactKeys(value, [
    'at', 'completedWorkflows', 'index', 'inputSha256', 'previousSha256', 'receiptSha256',
    'schema', 'state',
  ], 'disaster claim marker')
  if (value.schema !== DISASTER_JOURNAL_SCHEMA || value.index !== 0 || value.state !== 'CLAIMED'
    || !Number.isSafeInteger(value.at) || value.receiptSha256 !== validated.receiptSha256
    || value.inputSha256 !== validated.inputSha256 || value.previousSha256 !== null
    || canonicalJson(value.completedWorkflows) !== '[]') {
    fail('disaster claim marker is invalid')
  }
  return loaded
}

function disasterJournal(values) {
  const validated = validateDisasterReceipt(values)
  const operation = values['--operation']
  const workflowId = values['--workflow-id']
  if (!['claim', 'workflow', 'verified', 'committed', 'status'].includes(operation)) fail('invalid disaster journal operation')
  safeEntry(validated.receipt.journal.directory, 'disaster journal directory', 'directory', 0o700)
  let claim = readDisasterClaim(validated)
  if (!claim) {
    if (existsSync(validated.receipt.journal.events)) {
      safeEntry(validated.receipt.journal.events, 'disaster journal events', 'directory', 0o700)
      if (readdirSync(validated.receipt.journal.events).length !== 0) {
        fail('disaster journal events appeared before claim')
      }
    }
    if (operation !== 'claim') fail('disaster recovery has not been claimed')
    if (nowSeconds() >= validated.receipt.expiresAt) fail('disaster recovery claim expired')
    const claimed = {
      schema: DISASTER_JOURNAL_SCHEMA,
      index: 0,
      state: 'CLAIMED',
      at: nowSeconds(),
      receiptSha256: validated.receiptSha256,
      inputSha256: validated.inputSha256,
      previousSha256: null,
      completedWorkflows: [],
    }
    assertPhysicalPath(validated.receipt.journal.claim, 'disaster claim marker', true)
    writeImmutable(validated.receipt.journal.claim, `${canonicalJson(claimed)}\n`)
    syncDirectory(validated.receipt.journal.directory, 'disaster journal directory')
    if (process.env.NODE_ENV === 'test'
      && process.env.AIWORKER_TEST_N8N_CRASH_AFTER_DISASTER_CLAIM === '1') {
      process.kill(process.pid, 'SIGKILL')
    }
    claim = readDisasterClaim(validated)
  }
  if (!existsSync(validated.receipt.journal.events)) {
    assertPhysicalPath(validated.receipt.journal.events, 'disaster journal events', true)
    mkdirSync(validated.receipt.journal.events, { mode: 0o700 })
    syncDirectory(validated.receipt.journal.directory, 'disaster journal directory')
  }
  let events = disasterEvents(validated)
  if (events.length === 0) {
    writeImmutable(join(validated.receipt.journal.events, '0000.receipt.json'), claim.source)
    syncDirectory(validated.receipt.journal.events, 'disaster journal events')
    events = disasterEvents(validated)
  }
  let last = events.at(-1)
  if (last?.state === 'COMMITTED') {
    if (!existsSync(validated.receipt.journal.completed)) {
      writeImmutable(validated.receipt.journal.completed, `${canonicalJson(last)}\n`)
      syncDirectory(validated.receipt.journal.directory, 'disaster journal directory')
    } else {
      const completed = readJsonFile(
        validated.receipt.journal.completed,
        'disaster committed marker',
        0o400,
        MAX_RECEIPT_BYTES,
      )
      if (completed.source !== `${canonicalJson(last)}\n`) {
        fail('disaster committed marker differs from the journal')
      }
    }
    fail('completed disaster recovery cannot be replayed')
  }
  if (operation === 'workflow') {
    if (!MANAGED_IDS.has(workflowId)) fail('invalid disaster workflow journal ID')
    if (!last || !['CLAIMED', 'MUTATING'].includes(last.state)) fail('disaster workflow stage is out of order')
    if (!last.completedWorkflows.includes(workflowId)) {
      if (MANAGED[last.completedWorkflows.length]?.id !== workflowId) {
        fail('disaster workflows must be journaled in fixed order')
      }
      appendDisasterEvent(validated, 'MUTATING', [...last.completedWorkflows, workflowId], last)
      events = disasterEvents(validated); last = events.at(-1)
    }
  } else if (operation === 'verified') {
    if (!last || !['MUTATING', 'VERIFIED'].includes(last.state)
      || last.completedWorkflows.length !== MANAGED.length) {
      fail('disaster recovery cannot be verified before both workflows')
    }
    if (last.state === 'MUTATING') {
      appendDisasterEvent(validated, 'VERIFIED', last.completedWorkflows, last)
      events = disasterEvents(validated); last = events.at(-1)
    }
  } else if (operation === 'committed') {
    if (!last || last.state !== 'VERIFIED') fail('disaster recovery cannot commit before verification')
    appendDisasterEvent(validated, 'COMMITTED', last.completedWorkflows, last)
    const finalEvent = disasterEvents(validated).at(-1)
    writeImmutable(validated.receipt.journal.completed, `${canonicalJson(finalEvent)}\n`)
    syncDirectory(validated.receipt.journal.directory, 'disaster journal directory')
    last = finalEvent
  }
  if (events.length > 0 || last) {
    const firstPath = join(validated.receipt.journal.events, '0000.receipt.json')
    const firstSource = readFileSync(firstPath, 'utf8')
    if (claim.source !== firstSource) fail('disaster claim marker differs from the journal')
  }
  process.stdout.write(`${JSON.stringify({
    state: last?.state ?? null,
    completedWorkflows: last?.completedWorkflows ?? [],
    receiptSha256: validated.receiptSha256,
    inputSha256: validated.inputSha256,
  })}\n`)
}

function verifyDisasterReceipt(values) {
  const validated = validateDisasterReceipt(values)
  process.stdout.write(`${JSON.stringify({
    schema: DISASTER_RECEIPT_SCHEMA,
    claimExpiresAt: validated.receipt.expiresAt,
    receiptSha256: validated.receiptSha256,
    inputSha256: validated.inputSha256,
  })}\n`)
}

try {
  const { command, values } = parseArguments(process.argv.slice(2))
  if (command === 'backup') createBackup(values)
  else if (command === 'verify-package') verifyPackage(values)
  else if (command === 'verify-export') verifyExport(values)
  else if (command === 'database-sentinel') databaseSentinel(values)
  else if (command === 'restore-journal') restoreJournal(values)
  else if (command === 'verify-disaster-receipt') verifyDisasterReceipt(values)
  else if (command === 'disaster-journal') disasterJournal(values)
  else verifyReceipt(values)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'n8n managed workflow recovery failed'}\n`)
  process.exit(1)
}
