import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const DIRECTOR_PROJECTION_COMPATIBILITY_PATH =
  'src/lib/director-projection-contract-compatibility.json'
export const DIRECTOR_PROJECTION_COMPATIBILITY_SCHEMA =
  'video-autoworker-director-projection-compatibility/v1'

const SHA256 = /^[a-f0-9]{64}$/u
const TRANSITION_ID = /^[a-z0-9][a-z0-9-]{0,79}$/u
const ALLOWED_CHANGED_MEMBERS = new Set([
  'appProjectionSemanticsSha256',
  'deliveryCoreSha256',
  'directorBrainServiceSha256',
])
const CONTRACT_MEMBER_KEYS = Object.freeze([
  'appProjectionSemanticsSha256',
  'deliveryCoreSha256',
  'directorBrainCliSha256',
  'directorBrainSchemaSha256',
  'directorBrainSensitiveValueScannerSha256',
  'directorBrainServiceSha256',
  'evidenceLibrarySha256',
  'evidenceTransformerSha256',
].sort())

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

export function directorProjectionContractDigest(closure) {
  const contract = {
    authority: 'director-evidence-projection-contract-v1',
    schemaVersion: 1,
    ...Object.fromEntries(CONTRACT_MEMBER_KEYS.map(key => [key, closure?.[key]])),
  }
  return createHash('sha256').update(canonicalJson(contract)).digest('hex')
}

function parsedObject(source, label) {
  let value
  try {
    value = JSON.parse(source)
  } catch {
    throw new Error(`${label}_invalid`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label}_invalid`)
  }
  return value
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

function validClosure(value) {
  return exactKeys(value, CONTRACT_MEMBER_KEYS)
    && CONTRACT_MEMBER_KEYS.every(key => SHA256.test(value[key]))
}

function validateRegressionEvidence(value) {
  if (!Array.isArray(value) || value.length < 3 || value.length > 12) return false
  const paths = new Set()
  for (const item of value) {
    if (!exactKeys(item, ['path', 'sha256'])
      || typeof item.path !== 'string'
      || !/^(?:openclaw-plugins|src|scripts)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/u
        .test(item.path)
      || item.path.split('/').some(segment => segment === '.' || segment === '..')
      || !/\.test\.(?:mjs|ts)$/u.test(item.path)
      || !SHA256.test(item.sha256)
      || paths.has(item.path)) return false
    paths.add(item.path)
  }
  return true
}

export function validateDirectorProjectionContractCompatibility(value, options = {}) {
  if (!exactKeys(value, [
    'changedClosureMembers', 'fromContract', 'recovery', 'regressionEvidence', 'rollback',
    'schema', 'toContract', 'transitionId', 'unchanged',
  ])
    || value.schema !== DIRECTOR_PROJECTION_COMPATIBILITY_SCHEMA
    || typeof value.transitionId !== 'string' || !TRANSITION_ID.test(value.transitionId)
    || !exactKeys(value.fromContract, ['closure', 'digest'])
    || !validClosure(value.fromContract.closure)
    || !SHA256.test(value.fromContract.digest)
    || directorProjectionContractDigest(value.fromContract.closure) !== value.fromContract.digest
    || !exactKeys(value.toContract, ['digest']) || !SHA256.test(value.toContract.digest)
    || !Array.isArray(value.changedClosureMembers)
    || value.changedClosureMembers.length < 1
    || value.changedClosureMembers.length > ALLOWED_CHANGED_MEMBERS.size
    || new Set(value.changedClosureMembers).size !== value.changedClosureMembers.length
    || value.changedClosureMembers.some(key => !ALLOWED_CHANGED_MEMBERS.has(key))
    || !exactKeys(value.unchanged, [
      'outboxIdentity', 'projectionAuthority', 'projectionSchemaVersion', 'receiptSchemaVersion',
      'sourceIdentity', 'stableEvidenceIdentity', 'wireProtocol',
    ])
    || value.unchanged.projectionAuthority !== 'director-evidence-projection-contract-v1'
    || value.unchanged.projectionSchemaVersion !== 1
    || value.unchanged.receiptSchemaVersion !== 1
    || value.unchanged.outboxIdentity !== true
    || value.unchanged.sourceIdentity !== true
    || value.unchanged.stableEvidenceIdentity !== true
    || value.unchanged.wireProtocol !== true
    || !exactKeys(value.recovery, [
      'compatibleSourceDigests', 'mode', 'preserveOutboxIdentity',
      'remoteWrites', 'requiredConflictCode',
    ])
    || value.recovery.mode !== 'verified-read-only'
    || value.recovery.preserveOutboxIdentity !== true
    || value.recovery.remoteWrites !== false
    || value.recovery.requiredConflictCode !== 'director_evidence_projection_receipt_invalid'
    || !Array.isArray(value.recovery.compatibleSourceDigests)
    || JSON.stringify(value.recovery.compatibleSourceDigests) !== JSON.stringify([
      value.fromContract.digest,
    ])
    || !exactKeys(value.rollback, [
      'automaticCompensationBeforeReturn', 'direction', 'explicitReverse',
    ])
    || value.rollback.direction !== 'forward-only'
    || value.rollback.automaticCompensationBeforeReturn !== true
    || value.rollback.explicitReverse !== false
    || !validateRegressionEvidence(value.regressionEvidence)) {
    throw new Error('director_projection_contract_compatibility_invalid')
  }

  const currentClosure = options.currentClosure
  if (currentClosure !== undefined) {
    if (!validClosure(currentClosure)) {
      throw new Error('director_projection_contract_current_closure_invalid')
    }
    const currentDigest = directorProjectionContractDigest(currentClosure)
    if (currentDigest !== value.toContract.digest
      || (options.currentDigest !== undefined && options.currentDigest !== currentDigest)) {
      throw new Error('director_projection_contract_target_mismatch')
    }
    const changed = CONTRACT_MEMBER_KEYS.filter(
      key => value.fromContract.closure[key] !== currentClosure[key],
    ).sort()
    if (JSON.stringify(changed) !== JSON.stringify([...value.changedClosureMembers].sort())) {
      throw new Error('director_projection_contract_change_scope_mismatch')
    }
  }
  if (options.sourceDigest !== undefined && options.sourceDigest !== value.fromContract.digest) {
    throw new Error('director_projection_contract_source_mismatch')
  }
  return value
}

export function getDirectorProjectionReadCompatibleDigests(
  declaration,
  currentContract,
) {
  if (!exactKeys(currentContract, ['closure', 'digest'])
    || !SHA256.test(currentContract.digest)) {
    throw new Error('director_projection_contract_current_invalid')
  }
  const validated = validateDirectorProjectionContractCompatibility(declaration, {
    currentClosure: currentContract.closure,
    currentDigest: currentContract.digest,
  })
  return Object.freeze([...validated.recovery.compatibleSourceDigests])
}

export function loadDirectorProjectionContractCompatibility(repositoryRoot, options = {}) {
  let source
  try {
    source = options.gitCommit
      ? execFileSync('git', [
        '-C', repositoryRoot, 'show',
        `${options.gitCommit}:${DIRECTOR_PROJECTION_COMPATIBILITY_PATH}`,
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      : readFileSync(join(repositoryRoot, DIRECTOR_PROJECTION_COMPATIBILITY_PATH), 'utf8')
  } catch {
    if (options.optional === true) return null
    throw new Error('director_projection_contract_compatibility_missing')
  }
  const compatibility = validateDirectorProjectionContractCompatibility(
    parsedObject(source, 'director_projection_contract_compatibility'),
    options,
  )
  for (const evidence of compatibility.regressionEvidence) {
    let contents
    try {
      contents = options.gitCommit
        ? execFileSync('git', [
          '-C', repositoryRoot, 'show', `${options.gitCommit}:${evidence.path}`,
        ], { encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'] })
        : readFileSync(join(repositoryRoot, evidence.path))
    } catch {
      throw new Error('director_projection_contract_regression_evidence_missing')
    }
    if (createHash('sha256').update(contents).digest('hex') !== evidence.sha256) {
      throw new Error('director_projection_contract_regression_evidence_mismatch')
    }
  }
  return compatibility
}

export function directorProjectionCompatibilitySha256(value) {
  validateDirectorProjectionContractCompatibility(value)
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}
