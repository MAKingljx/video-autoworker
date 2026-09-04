#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import {
  lstatSync, readFileSync, readdirSync, realpathSync,
} from 'node:fs'
import { homedir } from 'node:os'
import {
  dirname, isAbsolute, join, posix, relative, resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

import { auditStandaloneArtifact } from './check-standalone-artifact.mjs'
import { assertConvergenceProof } from './lib/openclaw-runtime-convergence.mjs'
import {
  DIRECTOR_EXTRACTION_PROVENANCE_NAME,
  isStandaloneArtifactContentBinding,
  sourceClosureForGitCommit,
  STANDALONE_BUILD_SOURCE_ANCHOR_SCHEMA,
  STANDALONE_PROVENANCE_SCHEMA,
} from './lib/director-extraction-release-provenance.mjs'

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHA256 = /^[a-f0-9]{64}$/u
const GIT_COMMIT = /^[a-f0-9]{40}$/u
const RELEASE_ID = /^([a-f0-9]{7,40})(?:-runtime)?$/u
const EXPECTED_APP_VERSION = '2.0.1'
const EXPECTED_VIDEO_COMMAND_VERSION = '0.5.14'
const EXPECTED_DIRECTOR_BRAIN_VERSION = '0.4.0'
const OUTBOX_CLOSURE_CONSTANTS = Object.freeze({
  DIRECTOR_BRAIN_CLI_SHA256: 'scripts/feishu-director-brain.mjs',
  DIRECTOR_BRAIN_SERVICE_SHA256: 'scripts/lib/feishu-director-brain.mjs',
  DIRECTOR_BRAIN_SENSITIVE_VALUE_SCANNER_SHA256:
    'scripts/lib/sensitive-value-scanner.mjs',
  DIRECTOR_BRAIN_SCHEMA_SHA256: 'ops/feishu-director-brain/schema.json',
  DIRECTOR_EVIDENCE_TRANSFORMER_SHA256:
    'openclaw-skills/aiworker-task-flow/scripts/project-director-evidence.mjs',
  DIRECTOR_EVIDENCE_LIBRARY_SHA256:
    'openclaw-skills/aiworker-task-flow/lib/director-brain-evidence.mjs',
  DIRECTOR_EVIDENCE_APP_PROJECTION_SEMANTICS_SHA256:
    'src/lib/director-evidence-projection-semantics.ts',
  DIRECTOR_EVIDENCE_DELIVERY_CORE_SHA256:
    'src/lib/director-evidence-delivery-core.ts',
})

function fail(message) {
  throw new Error(`director_video_release_not_ready:${message}`)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  const encoded = JSON.stringify(value)
  return encoded === undefined ? 'null' : encoded
}

function fileSha256(pathname) {
  return sha256(readFileSync(pathname))
}

function assertPhysicalDirectory(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname)) fail(`${label}_path_invalid`)
  let entry
  let physical
  try {
    entry = lstatSync(pathname)
    physical = realpathSync.native(pathname)
  } catch {
    fail(`${label}_missing`)
  }
  if (!entry.isDirectory() || entry.isSymbolicLink() || physical !== resolve(pathname)) {
    fail(`${label}_unsafe`)
  }
  if ((entry.mode & 0o0022) !== 0) fail(`${label}_writable_by_others`)
  return physical
}

function safeFile(pathname, label) {
  let entry
  try {
    entry = lstatSync(pathname)
  } catch {
    fail(`${label}_missing`)
  }
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o6022) !== 0) {
    fail(`${label}_unsafe`)
  }
  return entry
}

function walkTree(root) {
  const directories = []
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const pathname = join(directory, entry.name)
      const member = relative(root, pathname).split('\\').join('/')
      const stats = lstatSync(pathname)
      if (entry.isSymbolicLink() || stats.isSymbolicLink()) fail(`payload_symlink:${member}`)
      if ((stats.mode & 0o0022) !== 0) fail(`payload_writable_by_others:${member}`)
      if (entry.isDirectory()) {
        directories.push(member)
        visit(pathname)
      } else if (entry.isFile()) {
        if ((stats.mode & 0o6000) !== 0) fail(`payload_setid_file:${member}`)
        files.push({ path: member, sha256: fileSha256(pathname) })
      } else {
        fail(`payload_unsupported_member:${member}`)
      }
    }
  }
  visit(root)
  directories.sort()
  files.sort((left, right) => left.path.localeCompare(right.path))
  return { directories, files }
}

function manifestDigest(manifest) {
  return sha256(JSON.stringify(manifest))
}

function selectedSourceManifest(repositoryRoot, members) {
  const files = members.map(member => {
    const pathname = join(repositoryRoot, member.source)
    safeFile(pathname, `source_${member.source.replaceAll('/', '_')}`)
    return { path: member.target, sha256: fileSha256(pathname) }
  }).sort((left, right) => left.path.localeCompare(right.path))
  const directorySet = new Set()
  for (const file of files) {
    let cursor = posix.dirname(file.path)
    while (cursor !== '.') {
      directorySet.add(cursor)
      cursor = posix.dirname(cursor)
    }
  }
  return { directories: [...directorySet].sort(), files }
}

function recursiveSourceMembers(repositoryRoot, sourceRelative, targetPrefix = '') {
  const sourceRoot = assertPhysicalDirectory(join(repositoryRoot, sourceRelative), 'source_tree')
  return walkTree(sourceRoot).files.map(file => ({
    source: posix.join(sourceRelative, file.path),
    target: targetPrefix ? posix.join(targetPrefix, file.path) : file.path,
  }))
}

function videoCommandMembers(repositoryRoot) {
  const base = 'openclaw-plugins/aiworker-video-command'
  return [
    'index.js', 'openclaw.plugin.json', 'package.json',
    ...walkTree(join(repositoryRoot, base, 'lib')).files.map(file => `lib/${file.path}`),
    ...walkTree(join(repositoryRoot, base, 'scripts')).files.map(file => `scripts/${file.path}`),
  ].map(member => ({ source: `${base}/${member}`, target: member }))
}

function taskFlowMembers(repositoryRoot) {
  const base = 'openclaw-skills/aiworker-task-flow'
  const members = [{ source: `${base}/SKILL.md`, target: 'SKILL.md' }]
  for (const directory of ['scripts', 'lib']) {
    const root = assertPhysicalDirectory(join(repositoryRoot, base, directory), `task_flow_${directory}`)
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.mjs')) {
        members.push({ source: `${base}/${directory}/${entry.name}`, target: `${directory}/${entry.name}` })
      }
    }
  }
  return members
}

function directorBrainPluginMembers(repositoryRoot) {
  const base = 'openclaw-plugins/aiworker-director-brain'
  return [
    { source: `${base}/index.js`, target: 'index.js' },
    { source: `${base}/openclaw.plugin.json`, target: 'openclaw.plugin.json' },
    { source: `${base}/package.json`, target: 'package.json' },
    ...recursiveSourceMembers(repositoryRoot, `${base}/lib`, 'lib'),
    {
      source: 'scripts/feishu-director-brain.mjs',
      target: 'runtime/scripts/feishu-director-brain.mjs',
    },
    {
      source: 'scripts/lib/feishu-director-brain.mjs',
      target: 'runtime/scripts/lib/feishu-director-brain.mjs',
    },
    {
      source: 'scripts/lib/sensitive-value-scanner.mjs',
      target: 'runtime/scripts/lib/sensitive-value-scanner.mjs',
    },
    {
      source: 'ops/feishu-director-brain/schema.json',
      target: 'runtime/ops/feishu-director-brain/schema.json',
    },
  ]
}

function assertManifestMatches(repositoryRoot, installedRoot, members, label) {
  const physicalRoot = assertPhysicalDirectory(installedRoot, label)
  const expected = selectedSourceManifest(repositoryRoot, members)
  const actual = walkTree(physicalRoot)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label}_manifest_mismatch`)
  return {
    root: physicalRoot,
    manifestSha256: manifestDigest(actual),
    files: actual.files.length,
  }
}

function readVersion(pathname, label) {
  safeFile(pathname, label)
  let value
  try {
    value = JSON.parse(readFileSync(pathname, 'utf8'))?.version
  } catch {
    fail(`${label}_invalid`)
  }
  if (typeof value !== 'string' || !value) fail(`${label}_invalid`)
  return value
}

function readJsonObject(pathname, label) {
  safeFile(pathname, label)
  try {
    const value = JSON.parse(readFileSync(pathname, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}_invalid`)
    return value
  } catch (error) {
    if (error instanceof Error && error.message.includes(`${label}_invalid`)) throw error
    fail(`${label}_invalid`)
  }
}

function assertDirectorBrainPluginContract(root) {
  const manifest = readJsonObject(
    join(root, 'openclaw.plugin.json'),
    'director_brain_manifest',
  )
  const packageManifest = readJsonObject(
    join(root, 'package.json'),
    'director_brain_package',
  )
  const capabilities = manifest?.activation?.onCapabilities
  if (manifest.id !== 'aiworker-director-brain'
    || manifest?.activation?.onStartup !== true
    || JSON.stringify(capabilities) !== JSON.stringify(['hook', 'tool'])
    || JSON.stringify(manifest?.contracts?.tools) !== JSON.stringify(['aiworker_director_brain'])
    || manifest?.toolMetadata?.aiworker_director_brain?.optional !== true
    || packageManifest?.peerDependencies?.openclaw !== '2026.7.1-2') {
    fail('director_brain_plugin_contract_mismatch')
  }
}

function assertVersionPair(root, expected, label) {
  const packageVersion = readVersion(join(root, 'package.json'), `${label}_package`)
  const manifestVersion = readVersion(join(root, 'openclaw.plugin.json'), `${label}_manifest`)
  if (packageVersion !== expected || manifestVersion !== expected) fail(`${label}_version_mismatch`)
  return packageVersion
}

function parseOutboxClosure(repositoryRoot) {
  const sourcePath = join(repositoryRoot, 'src/lib/director-evidence-outbox.ts')
  safeFile(sourcePath, 'outbox_source')
  const source = readFileSync(sourcePath, 'utf8')
  const result = {}
  for (const [constant, member] of Object.entries(OUTBOX_CLOSURE_CONSTANTS)) {
    const match = source.match(new RegExp(`const ${constant} = '([a-f0-9]{64})'`, 'u'))
    const actual = fileSha256(join(repositoryRoot, member))
    if (!match || match[1] !== actual) fail(`outbox_closure_mismatch:${constant}`)
    result[constant] = actual
  }
  return result
}

function parseProjectionContract(repositoryRoot, closure) {
  const source = readFileSync(join(repositoryRoot, 'src/lib/director-evidence-outbox.ts'), 'utf8')
  const authority = source.match(
    /export const DIRECTOR_EVIDENCE_PROJECTION_CONTRACT_AUTHORITY\s*=\s*'([^']+)'/u,
  )?.[1]
  const schemaVersion = Number(source.match(
    /export const DIRECTOR_EVIDENCE_PROJECTION_SCHEMA_VERSION\s*=\s*(\d+)/u,
  )?.[1])
  if (authority !== 'director-evidence-projection-contract-v1'
    || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) {
    fail('projection_contract_source_invalid')
  }
  const contract = {
    authority,
    schemaVersion,
    directorBrainCliSha256: closure.DIRECTOR_BRAIN_CLI_SHA256,
    directorBrainServiceSha256: closure.DIRECTOR_BRAIN_SERVICE_SHA256,
    directorBrainSensitiveValueScannerSha256:
      closure.DIRECTOR_BRAIN_SENSITIVE_VALUE_SCANNER_SHA256,
    directorBrainSchemaSha256: closure.DIRECTOR_BRAIN_SCHEMA_SHA256,
    evidenceTransformerSha256: closure.DIRECTOR_EVIDENCE_TRANSFORMER_SHA256,
    evidenceLibrarySha256: closure.DIRECTOR_EVIDENCE_LIBRARY_SHA256,
    appProjectionSemanticsSha256:
      closure.DIRECTOR_EVIDENCE_APP_PROJECTION_SEMANTICS_SHA256,
    deliveryCoreSha256: closure.DIRECTOR_EVIDENCE_DELIVERY_CORE_SHA256,
  }
  return {
    authority,
    schemaVersion,
    currentDigest: sha256(canonicalJson(contract)),
  }
}

function physicalDatabaseFile(pathname) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname)) fail('live_database_path_invalid')
  safeFile(pathname, 'live_database')
  let physical
  try {
    physical = realpathSync.native(pathname)
  } catch {
    fail('live_database_missing')
  }
  if (physical !== resolve(pathname)) fail('live_database_unsafe')
  return physical
}

function extractionProjectionVersion(repositoryRoot) {
  const source = readFileSync(join(
    repositoryRoot, 'src/lib/director-extraction-state.ts',
  ), 'utf8')
  const version = source.match(
    /DIRECTOR_EXTRACTION_PROJECTION_VERSION\s*=\s*'([^']+)'/u,
  )?.[1]
  if (version !== 'feishu-candidate-projection-v2') {
    fail('extraction_projection_boundary_source_invalid')
  }
  return version
}

function parsedJsonObject(value) {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function inspectDirectorExtractionIntegrity({
  repositoryRoot,
  liveDbPath,
  scope,
}) {
  const repository = assertPhysicalDirectory(repositoryRoot, 'repository')
  const databasePath = physicalDatabaseFile(liveDbPath)
  if (!scope || !Number.isSafeInteger(scope.tenantId) || scope.tenantId < 1
    || !Number.isSafeInteger(scope.workspaceId) || scope.workspaceId < 1) {
    fail('director_scope_invalid')
  }
  const expectedProjectionVersion = extractionProjectionVersion(repository)
  let Database
  try {
    Database = createRequire(join(repository, 'package.json'))('better-sqlite3')
  } catch {
    fail('live_database_driver_unavailable')
  }
  let database
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true })
    database.pragma('query_only = ON')
    const phases = database.prepare(`
      SELECT phase.*, checkpoint.phase AS checkpoint_phase,
        checkpoint.input_sha256, checkpoint.phase_input,
        checkpoint.output_sha256, checkpoint.candidate_output,
        projection.receipt_json AS projection_receipt_json,
        projection.receipt_sha256 AS projection_receipt_sha256,
        source.task_id AS source_task_id, source.tenant_id AS source_tenant_id,
        source.workspace_id AS source_workspace_id, source.status AS source_status,
        source.binding_id AS source_binding_id, binding.task_type AS source_task_type
      FROM n8n_task_runs phase
      LEFT JOIN director_extraction_checkpoints checkpoint
        ON checkpoint.phase_task_id = phase.task_id
      LEFT JOIN director_extraction_projection_receipts projection
        ON projection.phase_task_id = phase.task_id
      LEFT JOIN n8n_task_runs source
        ON source.task_id = json_extract(phase.input, '$.parentTaskId')
       AND source.tenant_id = phase.tenant_id
       AND source.workspace_id = phase.workspace_id
      LEFT JOIN n8n_workflow_bindings binding
        ON binding.id = source.binding_id
       AND binding.tenant_id = source.tenant_id
       AND binding.workspace_id = source.workspace_id
      WHERE phase.tenant_id = ? AND phase.workspace_id = ?
        AND phase.source = 'n8n-node'
        AND json_valid(phase.input) = 1
        AND json_extract(phase.input, '$.childKind') = 'director-extraction'
    `).all(scope.tenantId, scope.workspaceId)
    const report = {
      schema: 'video-autoworker-director-extraction-readiness/v1',
      expectedProjectionVersion,
      sources: Number(database.prepare(`
        SELECT COUNT(*) FROM n8n_task_runs source
        JOIN n8n_workflow_bindings binding ON binding.id = source.binding_id
          AND binding.tenant_id = source.tenant_id
          AND binding.workspace_id = source.workspace_id
        WHERE source.tenant_id = ? AND source.workspace_id = ?
          AND source.status = 'succeeded' AND binding.task_type = 'video-analysis'
          AND json_valid(source.input) = 1
          AND json_extract(source.input, '$.directorEvidence.workId') IS NOT NULL
      `).pluck().get(scope.tenantId, scope.workspaceId) || 0),
      phases: phases.length,
      sourcesWithoutPhase: Number(database.prepare(`
        SELECT COUNT(*) FROM n8n_task_runs source
        JOIN n8n_workflow_bindings binding ON binding.id = source.binding_id
          AND binding.tenant_id = source.tenant_id
          AND binding.workspace_id = source.workspace_id
        WHERE source.tenant_id = ? AND source.workspace_id = ?
          AND source.status = 'succeeded' AND binding.task_type = 'video-analysis'
          AND json_valid(source.input) = 1
          AND json_extract(source.input, '$.directorEvidence.workId') IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM n8n_task_runs phase
            WHERE phase.tenant_id = source.tenant_id
              AND phase.workspace_id = source.workspace_id
              AND phase.source = 'n8n-node'
              AND json_valid(phase.input) = 1
              AND json_extract(phase.input, '$.childKind') = 'director-extraction'
              AND json_extract(phase.input, '$.parentTaskId') = source.task_id
          )
      `).pluck().get(scope.tenantId, scope.workspaceId) || 0),
      activePhases: 0,
      invalidPhaseBindings: 0,
      invalidCheckpoints: 0,
      invalidProjectionReceipts: 0,
      invalidReviewReceipts: 0,
      missingPredecessorReviews: 0,
      incompatibleProjectionBoundary: 0,
    }
    const bySource = new Map()
    for (const row of phases) {
      const input = parsedJsonObject(row.input)
      const phase = input?.directorPhase
      if (row.status === 'queued' || row.status === 'running') report.activePhases++
      const routing = parsedJsonObject(row.routing)
      if (!input || input.taskType !== 'video-analysis'
        || input.childKind !== 'director-extraction'
        || !['perception', 'understanding', 'judgment', 'case', 'technique'].includes(phase)
        || row.source_task_id !== input.parentTaskId
        || row.source_tenant_id !== scope.tenantId
        || row.source_workspace_id !== scope.workspaceId
        || row.source_status !== 'succeeded'
        || row.source_binding_id !== row.binding_id
        || row.source_task_type !== 'video-analysis'
        || routing?.taskType !== 'video-analysis'
        || routing?.childKind !== 'director-extraction'
        || routing?.directorPhase !== phase
        || routing?.parentTaskId !== row.source_task_id) {
        report.invalidPhaseBindings++
        continue
      }
      const sourcePhases = bySource.get(row.source_task_id) || new Map()
      sourcePhases.set(phase, row)
      bySource.set(row.source_task_id, sourcePhases)
      const phaseInput = parsedJsonObject(row.phase_input)
      const candidateOutput = parsedJsonObject(row.candidate_output)
      const checkpointValid = row.checkpoint_phase === phase
        && phaseInput?.phase === phase
        && candidateOutput?.phase === phase
        && Array.isArray(candidateOutput?.candidates)
        && row.input_sha256 === sha256(canonicalJson(phaseInput))
        && row.output_sha256 === sha256(canonicalJson(candidateOutput))
      if ((row.status === 'succeeded' && !checkpointValid)
        || (row.checkpoint_phase !== null && !checkpointValid)) {
        report.invalidCheckpoints++
      }
      if (checkpointValid && phaseInput.projectionVersion !== expectedProjectionVersion) {
        report.incompatibleProjectionBoundary++
      }
      const projection = parsedJsonObject(row.projection_receipt_json)
      const projectionValid = projection?.phase === phase
        && Array.isArray(projection?.entries) && projection.entries.length > 0
        && row.projection_receipt_sha256 === sha256(canonicalJson(projection))
      if ((row.status === 'succeeded' && !projectionValid)
        || (row.projection_receipt_json !== null && !projectionValid)) {
        report.invalidProjectionReceipts++
      }
    }
    const phaseOrder = ['perception', 'understanding', 'judgment', 'case', 'technique']
    for (const sourcePhases of bySource.values()) {
      for (let index = 1; index < phaseOrder.length; index++) {
        if (!sourcePhases.has(phaseOrder[index])) continue
        const prior = sourcePhases.get(phaseOrder[index - 1])
        const review = prior && database.prepare(`
          SELECT 1 FROM director_extraction_review_receipts
          WHERE phase_task_id = ? AND receipt_type = 'candidate_review'
        `).get(prior.task_id)
        if (!review) report.missingPredecessorReviews++
        if (phaseOrder[index] === 'judgment') {
          const intent = prior && database.prepare(`
            SELECT 1 FROM director_extraction_review_receipts
            WHERE phase_task_id = ? AND receipt_type = 'intent_review'
          `).get(prior.task_id)
          if (!intent) report.missingPredecessorReviews++
        }
      }
    }
    const reviews = database.prepare(`
      SELECT review.*, phase.status AS phase_status,
        projection.phase_task_id AS projected_phase_task_id
      FROM director_extraction_review_receipts review
      LEFT JOIN n8n_task_runs phase ON phase.task_id = review.phase_task_id
      LEFT JOIN director_extraction_projection_receipts projection
        ON projection.phase_task_id = review.phase_task_id
      WHERE phase.tenant_id = ? AND phase.workspace_id = ?
    `).all(scope.tenantId, scope.workspaceId)
    for (const row of reviews) {
      const references = parsedJsonObject(row.reviewed_references)
      const expected = references && sha256(canonicalJson({
        phaseTaskId: row.phase_task_id,
        receiptType: row.receipt_type,
        reviewedReferences: references,
        errorCode: row.error_code,
      }))
      if (!references || expected !== row.receipt_sha256 || row.phase_status !== 'succeeded'
        || !row.projected_phase_task_id
        || (row.receipt_type === 'candidate_rejection') !== Boolean(row.error_code)) {
        report.invalidReviewReceipts++
      }
    }
    return report
  } catch (error) {
    if (error instanceof Error
      && error.message.startsWith('director_video_release_not_ready:')) throw error
    fail('extraction_integrity_inspection_failed')
  } finally {
    try { database?.close() } catch { /* read-only close failure is reported by the process */ }
  }
}

export function assertDirectorExtractionReleaseReady(extraction) {
  for (const field of [
    'activePhases',
    'sourcesWithoutPhase',
    'invalidPhaseBindings',
    'invalidCheckpoints',
    'invalidProjectionReceipts',
    'invalidReviewReceipts',
    'missingPredecessorReviews',
    'incompatibleProjectionBoundary',
  ]) {
    if (!Number.isSafeInteger(extraction?.[field]) || extraction[field] !== 0) {
      fail(`extraction_${field}:${String(extraction?.[field])}`)
    }
  }
}

function directorBrainScope(source = process.env) {
  const tenantId = Number(source.MC_OPENCLAW_TENANT_ID)
  const workspaceId = Number(source.MC_OPENCLAW_WORKSPACE_ID)
  if (!Number.isSafeInteger(tenantId) || tenantId < 1
    || !Number.isSafeInteger(workspaceId) || workspaceId < 1) {
    fail('director_scope_invalid')
  }
  return { tenantId, workspaceId }
}

function validDirectorEvidenceReceipt(outbox, row) {
  if (!row || row.receipt_task_id !== outbox.task_id
    || !['delivery', 'verified_read_recovery'].includes(row.receipt_origin)
    || row.receipt_projection_contract_digest !== outbox.projection_contract_digest
    || !Number.isSafeInteger(row.receipt_created_at) || row.receipt_created_at < 0) return false
  let receipt
  try {
    receipt = JSON.parse(row.receipt_json)
  } catch {
    return false
  }
  const sourceIdentitySha256 = sha256(canonicalJson({
    authority: 'video-autoworker-director-evidence-source-identity-v1',
    taskId: outbox.task_id,
    bindingId: outbox.binding_id,
    tenantId: outbox.tenant_id,
    workspaceId: outbox.workspace_id,
    workId: outbox.work_id,
    queryDigest: outbox.query_digest,
    projectionContractDigest: outbox.projection_contract_digest,
    idempotencyKey: outbox.idempotency_key,
    resultSha256: outbox.result_sha256,
  }))
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).sort().join(',')
      !== 'authority,entries,projectId,projectionSha256,schemaVersion,sourceIdentitySha256,workId'
    || receipt.authority !== 'video-autoworker-director-evidence-delivery-v1'
    || receipt.schemaVersion !== 1
    || receipt.projectId !== 'PROJ-VIDEO-AUTOWORKER'
    || receipt.workId !== outbox.work_id
    || receipt.sourceIdentitySha256 !== sourceIdentitySha256
    || typeof receipt.projectionSha256 !== 'string' || !SHA256.test(receipt.projectionSha256)
    || !Array.isArray(receipt.entries) || receipt.entries.length < 1 || receipt.entries.length > 241
    || row.source_identity_sha256 !== sourceIdentitySha256
    || row.receipt_sha256 !== sha256(canonicalJson(receipt))) return false
  const stableIds = new Set()
  for (const entry of receipt.entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || Object.keys(entry).sort().join(',') !== 'endSeconds,stableId,startSeconds'
      || typeof entry.stableId !== 'string' || !/^[A-Za-z0-9._:-]{1,160}$/u.test(entry.stableId)
      || stableIds.has(entry.stableId)
      || typeof entry.startSeconds !== 'number' || !Number.isFinite(entry.startSeconds)
      || typeof entry.endSeconds !== 'number' || !Number.isFinite(entry.endSeconds)
      || entry.startSeconds < 0 || entry.endSeconds <= entry.startSeconds) return false
    stableIds.add(entry.stableId)
  }
  return true
}

export function inspectDirectorEvidenceOutboxCompatibility({
  repositoryRoot,
  liveDbPath,
  currentDigest,
  scope,
}) {
  const repository = assertPhysicalDirectory(repositoryRoot, 'repository')
  const databasePath = physicalDatabaseFile(liveDbPath)
  if (typeof currentDigest !== 'string' || !SHA256.test(currentDigest)) {
    fail('projection_contract_digest_invalid')
  }
  if (!scope || !Number.isSafeInteger(scope.tenantId) || scope.tenantId < 1
    || !Number.isSafeInteger(scope.workspaceId) || scope.workspaceId < 1) {
    fail('director_scope_invalid')
  }
  let Database
  try {
    Database = createRequire(join(repository, 'package.json'))('better-sqlite3')
  } catch {
    fail('sqlite_runtime_unavailable')
  }
  let database
  try {
    database = new Database(databasePath, { readonly: true, fileMustExist: true })
    database.pragma('query_only = ON')
    const table = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'n8n_director_evidence_outbox'
    `).get()
    if (!table || typeof table.sql !== 'string'
      || !table.sql.includes('projection_contract_digest')) {
      fail('projection_outbox_schema_invalid')
    }
    const row = database.prepare(`
      SELECT COUNT(*) AS pending,
        COALESCE(SUM(CASE WHEN projection_contract_digest <> ? THEN 1 ELSE 0 END), 0)
          AS incompatible_pending
      FROM n8n_director_evidence_outbox
      WHERE status = 'pending'
    `).get(currentDigest)
    const pending = Number(row?.pending)
    const incompatiblePending = Number(row?.incompatible_pending)
    if (!Number.isSafeInteger(pending) || pending < 0
      || !Number.isSafeInteger(incompatiblePending) || incompatiblePending < 0
      || incompatiblePending > pending) fail('projection_outbox_counts_invalid')
    const deliveredRows = database.prepare(`
      SELECT outbox.*,
        receipt.task_id AS receipt_task_id,
        receipt.source_identity_sha256,
        receipt.projection_contract_digest AS receipt_projection_contract_digest,
        receipt.receipt_json,
        receipt.receipt_sha256,
        receipt.origin AS receipt_origin,
        receipt.created_at AS receipt_created_at
      FROM n8n_director_evidence_outbox outbox
      JOIN n8n_task_runs root ON root.task_id = outbox.task_id
      LEFT JOIN n8n_director_evidence_projection_receipts receipt
        ON receipt.task_id = outbox.task_id
      WHERE outbox.status = 'delivered'
    `).all()
    const deliveredWithoutValidReceipt = deliveredRows.reduce(
      (count, delivered) => count + (validDirectorEvidenceReceipt(delivered, delivered) ? 0 : 1),
      0,
    )
    const outOfScopeOutbox = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM n8n_director_evidence_outbox outbox
      LEFT JOIN n8n_task_runs root ON root.task_id = outbox.task_id
      WHERE root.task_id IS NULL
        OR outbox.tenant_id <> ? OR outbox.workspace_id <> ?
        OR root.tenant_id IS NOT outbox.tenant_id OR root.workspace_id IS NOT outbox.workspace_id
        OR root.binding_id IS NOT outbox.binding_id
        OR json_extract(root.input, '$.directorEvidence.workId') IS NOT outbox.work_id
        OR json_extract(root.input, '$.directorEvidence.queryDigest') IS NOT outbox.query_digest
    `).get(scope.tenantId, scope.workspaceId)?.count)
    const outOfScopeExtraction = Number(database.prepare(`
      SELECT COUNT(*) AS count FROM n8n_task_runs
      WHERE source = 'n8n-node' AND json_valid(input) = 1
        AND json_extract(input, '$.childKind') = 'director-extraction'
        AND (tenant_id <> ? OR workspace_id <> ?)
    `).get(scope.tenantId, scope.workspaceId)?.count)
    if (!Number.isSafeInteger(deliveredWithoutValidReceipt) || deliveredWithoutValidReceipt < 0
      || !Number.isSafeInteger(outOfScopeOutbox) || outOfScopeOutbox < 0
      || !Number.isSafeInteger(outOfScopeExtraction) || outOfScopeExtraction < 0) {
      fail('projection_outbox_counts_invalid')
    }
    return {
      schema: 'video-autoworker-director-evidence-outbox-readiness/v1',
      currentDigest,
      pending,
      incompatiblePending,
      deliveredWithoutValidReceipt,
      outOfScopeOutbox,
      outOfScopeExtraction,
    }
  } catch (error) {
    if (error instanceof Error
      && error.message.startsWith('director_video_release_not_ready:')) throw error
    fail('projection_outbox_inspection_failed')
  } finally {
    try { database?.close() } catch { /* read-only close failure is reported by the process */ }
  }
}

export function assertDirectorEvidenceOutboxReleaseReady(projectionOutbox) {
  if (projectionOutbox.incompatiblePending !== 0) {
    fail(`projection_contract_incompatible_pending:${projectionOutbox.incompatiblePending}`)
  }
  if (projectionOutbox.deliveredWithoutValidReceipt !== 0) {
    fail(`projection_receipt_invalid_delivered:${projectionOutbox.deliveredWithoutValidReceipt}`)
  }
  if (projectionOutbox.outOfScopeOutbox !== 0) {
    fail(`projection_outbox_scope_violation:${projectionOutbox.outOfScopeOutbox}`)
  }
  if (projectionOutbox.outOfScopeExtraction !== 0) {
    fail(`projection_extraction_scope_violation:${projectionOutbox.outOfScopeExtraction}`)
  }
}

function assertTaskFlowDirectorWork(repositoryRoot, installedTaskFlowRoot) {
  const source = readFileSync(join(repositoryRoot,
    'openclaw-skills/aiworker-task-flow/scripts/submit-task.mjs'), 'utf8')
  const installed = readFileSync(join(installedTaskFlowRoot, 'scripts/submit-task.mjs'), 'utf8')
  for (const contract of [
    "const directorWork = option('--director-work')",
    'assertOptionalDirectorWork(directorWork',
    'directorWork,',
  ]) {
    if (!source.includes(contract) || !installed.includes(contract)) {
      fail('task_flow_director_work_contract_missing')
    }
  }
  return true
}

export function verifyInstalledReleasePayloads({
  repositoryRoot,
  profileStateRoot,
  workspaceRoot,
}) {
  const repository = assertPhysicalDirectory(repositoryRoot, 'repository')
  const profile = assertPhysicalDirectory(profileStateRoot, 'profile_state')
  const workspace = assertPhysicalDirectory(workspaceRoot, 'workspace')
  const videoRoot = join(profile, 'extensions', 'aiworker-video-command')
  const taskFlowRoot = join(workspace, 'skills', 'aiworker-task-flow')
  const directorPluginRoot = join(profile, 'extensions', 'aiworker-director-brain')
  const directorSkillRoot = join(workspace, 'skills', 'aiworker-director-brain')

  const videoCommand = assertManifestMatches(
    repository, videoRoot, videoCommandMembers(repository), 'video_command',
  )
  videoCommand.version = assertVersionPair(
    videoRoot, EXPECTED_VIDEO_COMMAND_VERSION, 'video_command',
  )
  const taskFlow = assertManifestMatches(
    repository, taskFlowRoot, taskFlowMembers(repository), 'task_flow',
  )
  const directorBrain = assertManifestMatches(
    repository, directorPluginRoot, directorBrainPluginMembers(repository), 'director_brain',
  )
  directorBrain.version = assertVersionPair(
    directorPluginRoot, EXPECTED_DIRECTOR_BRAIN_VERSION, 'director_brain',
  )
  assertDirectorBrainPluginContract(directorPluginRoot)
  const directorSkillMembers = recursiveSourceMembers(
    repository, 'openclaw-skills/aiworker-director-brain', '',
  )
  const directorSkill = assertManifestMatches(
    repository, directorSkillRoot, directorSkillMembers, 'director_brain_skill',
  )
  assertTaskFlowDirectorWork(repository, taskFlowRoot)
  const closure = parseOutboxClosure(repository)
  const projectionContract = parseProjectionContract(repository, closure)
  return { videoCommand, taskFlow, directorBrain, directorSkill, closure, projectionContract }
}

function gitOutput(repositoryRoot, args) {
  try {
    return execFileSync('git', ['-C', repositoryRoot, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    fail('git_identity_invalid')
  }
}

function gitSucceeds(repositoryRoot, args) {
  try {
    execFileSync('git', ['-C', repositoryRoot, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

export function assertRepositoryRelease(repositoryRoot, releaseId, mode = 'head') {
  const match = RELEASE_ID.exec(releaseId)
  if (!match) fail('release_id_invalid')
  if (!['head', 'ancestor'].includes(mode)) fail('repository_release_mode_invalid')
  const head = gitOutput(repositoryRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])
  const resolved = gitOutput(repositoryRoot, ['rev-parse', '--verify', `${match[1]}^{commit}`])
  const branch = gitOutput(repositoryRoot, ['symbolic-ref', '--short', '-q', 'HEAD'])
  const status = gitOutput(repositoryRoot, ['status', '--porcelain', '--untracked-files=normal'])
  const remote = gitOutput(repositoryRoot, ['remote', 'get-url', 'origin'])
  const releaseAccepted = mode === 'head'
    ? resolved === head
    : gitSucceeds(repositoryRoot, ['merge-base', '--is-ancestor', resolved, head])
  if (!GIT_COMMIT.test(head) || !GIT_COMMIT.test(resolved) || !releaseAccepted
    || branch !== 'main' || status) {
    fail('repository_release_mismatch')
  }
  if (![
    'https://github.com/MAKingljx/video-autoworker',
    'https://github.com/MAKingljx/video-autoworker.git',
    'git@github.com:MAKingljx/video-autoworker.git',
  ].includes(remote)) fail('repository_remote_mismatch')
  return resolved
}

export function verifyDirectorExtractionReleaseProvenance({
  repositoryRoot,
  releaseRoot,
  commit,
  artifactContent = null,
}) {
  const provenancePath = join(releaseRoot, DIRECTOR_EXTRACTION_PROVENANCE_NAME)
  safeFile(provenancePath, 'app_release_provenance')
  const provenance = parsedJsonObject(readFileSync(provenancePath, 'utf8'))
  if (!provenance
    || provenance.schema !== STANDALONE_PROVENANCE_SCHEMA
    || provenance.gitCommit !== commit
    || provenance.gitDirty !== false
    || provenance.buildSourceAnchor?.schema !== STANDALONE_BUILD_SOURCE_ANCHOR_SCHEMA
    || provenance.buildSourceAnchor?.gitCommit !== commit
    || provenance.buildSourceAnchor?.gitDirty !== false
    || typeof provenance.buildSourceAnchor?.sourceClosureSha256 !== 'string'
    || !SHA256.test(provenance.buildSourceAnchor.sourceClosureSha256)
    || typeof provenance.buildSourceAnchor?.buildNonce !== 'string'
    || !SHA256.test(provenance.buildSourceAnchor.buildNonce)
    || !isStandaloneArtifactContentBinding(provenance.artifactContent)) {
    fail('app_release_provenance_invalid')
  }
  let expectedClosure
  try {
    expectedClosure = sourceClosureForGitCommit(repositoryRoot, commit)
  } catch {
    fail('app_release_source_closure_unavailable')
  }
  if (canonicalJson(provenance.sourceClosure) !== canonicalJson(expectedClosure)) {
    fail('app_release_source_closure_mismatch')
  }
  if (provenance.buildSourceAnchor.sourceClosureSha256
    !== sha256(canonicalJson(expectedClosure))) {
    fail('app_release_build_source_anchor_mismatch')
  }
  const releaseManifestPath = join(releaseRoot, 'release-manifest.json')
  safeFile(releaseManifestPath, 'app_release_manifest')
  const releaseManifest = parsedJsonObject(readFileSync(releaseManifestPath, 'utf8'))
  if (releaseManifest?.schemaVersion !== 2
    || !isStandaloneArtifactContentBinding(releaseManifest.artifactContent)
    || canonicalJson(releaseManifest.artifactContent)
      !== canonicalJson(provenance.artifactContent)
    || (artifactContent && canonicalJson(artifactContent)
      !== canonicalJson(provenance.artifactContent))) {
    fail('app_release_artifact_content_binding_invalid')
  }
  const member = Array.isArray(releaseManifest?.files)
    ? releaseManifest.files.find(item => item?.path === DIRECTOR_EXTRACTION_PROVENANCE_NAME)
    : null
  if (!member || member.sha256 !== fileSha256(provenancePath)) {
    fail('app_release_provenance_not_manifested')
  }
  return {
    schema: provenance.schema,
    gitCommit: provenance.gitCommit,
    sourceFiles: expectedClosure.files.length,
    sha256: fileSha256(provenancePath),
    artifactContent: provenance.artifactContent,
  }
}

export async function verifyDirectorVideoReleasePreflight({
  repositoryRoot,
  releasesRoot,
  releaseRoot,
  releaseId,
  profileStateRoot,
  workspaceRoot,
  runtimeConvergenceProofPath,
  repositoryReleaseMode = 'head',
}) {
  const repository = assertPhysicalDirectory(repositoryRoot, 'repository')
  const releases = assertPhysicalDirectory(releasesRoot, 'releases')
  const release = assertPhysicalDirectory(releaseRoot, 'app_release')
  if (release !== join(releases, releaseId, 'standalone')) fail('app_release_boundary_mismatch')
  const commit = assertRepositoryRelease(repository, releaseId, repositoryReleaseMode)
  const artifactAudit = await auditStandaloneArtifact(release)
  const provenance = verifyDirectorExtractionReleaseProvenance({
    repositoryRoot: repository,
    releaseRoot: release,
    commit,
    artifactContent: artifactAudit.artifactContent,
  })
  const appVersion = readVersion(join(release, 'package.json'), 'app_package')
  const sourceVersion = readVersion(join(repository, 'package.json'), 'source_package')
  if (appVersion !== EXPECTED_APP_VERSION || sourceVersion !== EXPECTED_APP_VERSION) {
    fail('app_version_mismatch')
  }
  const payloads = verifyInstalledReleasePayloads({
    repositoryRoot: repository,
    profileStateRoot,
    workspaceRoot,
  })
  let runtimeConvergence
  try {
    runtimeConvergence = assertConvergenceProof(
      runtimeConvergenceProofPath,
      join(repository, 'ops/openclaw/qwen-current-runtime-convergence.manifest.json'),
      profileStateRoot,
      join(profileStateRoot, 'openclaw.json'),
      false,
    )
  } catch {
    fail('runtime_convergence_proof_invalid')
  }
  const releaseManifestPath = join(release, 'release-manifest.json')
  safeFile(releaseManifestPath, 'app_release_manifest')
  return {
    schema: 'video-autoworker-director-video-preflight/v1',
    phase: 'pre-bootstrap',
    ok: true,
    commit,
    app: {
      releaseId,
      version: appVersion,
      root: release,
      manifestSha256: fileSha256(releaseManifestPath),
    },
    payloads,
    provenance,
    runtimeConvergence,
    contracts: {
      directorWork: true,
      outboxClosure: true,
      extractionSourceProvenance: true,
      standaloneArtifactContentBound: true,
      sessionScopedRuntimeConvergence: true,
    },
  }
}

export async function verifyDirectorVideoReleaseReadiness(options) {
  const preflight = await verifyDirectorVideoReleasePreflight(options)
  const projectionOutbox = inspectDirectorEvidenceOutboxCompatibility({
    repositoryRoot: options.repositoryRoot,
    liveDbPath: options.liveDbPath,
    currentDigest: preflight.payloads.projectionContract.currentDigest,
    scope: options.scope,
  })
  assertDirectorEvidenceOutboxReleaseReady(projectionOutbox)
  const extraction = inspectDirectorExtractionIntegrity({
    repositoryRoot: options.repositoryRoot,
    liveDbPath: options.liveDbPath,
    scope: options.scope,
  })
  assertDirectorExtractionReleaseReady(extraction)
  return {
    schema: 'video-autoworker-director-video-readiness/v1',
    ok: true,
    commit: preflight.commit,
    app: preflight.app,
    payloads: preflight.payloads,
    provenance: preflight.provenance,
    runtimeConvergence: preflight.runtimeConvergence,
    projectionOutbox,
    extraction,
    contracts: {
      directorWork: true,
      outboxClosure: true,
      extractionSourceProvenance: true,
      standaloneArtifactContentBound: true,
      projectionContractCompatible: true,
      extractionLifecycleComplete: true,
      sessionScopedRuntimeConvergence: true,
    },
  }
}

function parseArguments(argv) {
  const values = new Map()
  const allowed = new Set([
    '--repository-root', '--releases-root', '--release-root', '--release-id',
    '--profile-state-root', '--workspace-root', '--live-db-path', '--repository-release-mode',
    '--runtime-convergence-proof', '--verification-phase',
  ])
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(key) || value === undefined || value.startsWith('--') || values.has(key)) {
      fail('arguments_invalid')
    }
    values.set(key, value)
  }
  const repositoryRoot = values.get('--repository-root') || MODULE_ROOT
  const releasesRoot = values.get('--releases-root') || join(repositoryRoot, '.runtime', 'releases')
  const releaseId = values.get('--release-id')
  const releaseRoot = values.get('--release-root')
  const profileStateRoot = values.get('--profile-state-root') || join(homedir(), '.openclaw-qwen-current')
  const workspaceRoot = values.get('--workspace-root') || join(homedir(), 'AI-worker-second-original-workspace')
  const liveDbPath = values.get('--live-db-path')
  const repositoryReleaseMode = values.get('--repository-release-mode') || 'head'
  const runtimeConvergenceProofPath = values.get('--runtime-convergence-proof')
    || process.env.AIWORKER_OPENCLAW_RUNTIME_CONVERGENCE_PROOF
  const verificationPhase = values.get('--verification-phase') || 'full'
  if (!['pre-bootstrap', 'full'].includes(verificationPhase)
    || !releaseId || !releaseRoot || !runtimeConvergenceProofPath
    || (verificationPhase === 'full' && !liveDbPath)) {
    fail('arguments_invalid')
  }
  return {
    repositoryRoot, releasesRoot, releaseRoot, releaseId, profileStateRoot, workspaceRoot,
    liveDbPath, scope: directorBrainScope(), runtimeConvergenceProofPath,
    repositoryReleaseMode, verificationPhase,
  }
}

const invokedPath = process.argv[1] ? realpathSync.native(process.argv[1]) : null
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2))
    const result = options.verificationPhase === 'pre-bootstrap'
      ? await verifyDirectorVideoReleasePreflight(options)
      : await verifyDirectorVideoReleaseReadiness(options)
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'director_video_release_not_ready:unknown'
    process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`)
    process.exitCode = 1
  }
}
