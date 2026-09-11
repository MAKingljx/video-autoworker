import { createHash } from 'node:crypto'

export const OPERATIONS_RECOVERY_BOUNDARY_SCHEMA =
  'video-autoworker-operations-recovery-boundary/v1'
export const OPERATIONS_RECOVERY_INVENTORY_SCHEMA =
  'video-autoworker-operations-recovery-inventory/v1'
export const OPERATIONS_RUNTIME_DOCTOR_SCHEMA =
  'video-autoworker-operations-runtime-doctor/v1'
export const OPERATIONS_AUDIT_EVENT_SCHEMA =
  'video-autoworker-operations-audit-event/v1'

const SHA256 = /^[a-f0-9]{64}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u
const KINDS = new Set(['code', 'config', 'data'])
const VALIDATIONS = new Set(['valid', 'invalid', 'unverified'])
const STATES = new Set(['current', 'history'])
const AUDIT_STATUSES = new Set(['started', 'succeeded', 'failed', 'blocked'])
const FORBIDDEN_AUDIT_KEY = /(token|password|secret|credential|conversation|message|content|row|payload)/iu

function fail(code) {
  throw new Error(code)
}

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function safeInteger(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum
}

function identitySha256(value, label) {
  if (typeof value !== 'string' || !value || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`operations_${label}_invalid`)
  }
  return sha256(value)
}

export function operationsRecoveryBoundaryDeclaration() {
  return deepFreeze({
    schema: OPERATIONS_RECOVERY_BOUNDARY_SCHEMA,
    objectives: { rpoSeconds: null, rtoSeconds: null, status: 'not-set' },
    boundaries: [
      {
        kind: 'code',
        recovery: 'immutable-release-switch',
        automaticDataRestore: false,
        preserveCurrentBusinessData: true,
        requiresExplicitAuthorization: false,
      },
      {
        kind: 'config',
        recovery: 'exact-scoped-backup-restore',
        automaticDataRestore: false,
        preserveCurrentBusinessData: true,
        requiresExplicitAuthorization: true,
      },
      {
        kind: 'data',
        recovery: 'declared-compensation-or-authorized-restore',
        automaticDataRestore: false,
        preserveCurrentBusinessData: true,
        requiresExplicitAuthorization: true,
      },
    ],
  })
}

function normalizedAsset(value) {
  if (!exactKeys(value, [
    'assetId', 'createdAt', 'kind', 'path', 'recoveryObject', 'references', 'state',
    'validation',
  ])
    || typeof value.assetId !== 'string' || !SAFE_ID.test(value.assetId)
    || typeof value.recoveryObject !== 'string' || !SAFE_ID.test(value.recoveryObject)
    || !KINDS.has(value.kind) || !STATES.has(value.state)
    || !VALIDATIONS.has(value.validation) || !safeInteger(value.createdAt)
    || !Array.isArray(value.references)
    || value.references.some(item => typeof item !== 'string' || !SAFE_ID.test(item))
    || new Set(value.references).size !== value.references.length) {
    fail('operations_recovery_asset_invalid')
  }
  return {
    assetId: value.assetId,
    recoveryObject: value.recoveryObject,
    kind: value.kind,
    state: value.state,
    validation: value.validation,
    createdAt: value.createdAt,
    references: [...value.references].sort(),
    pathIdentitySha256: identitySha256(value.path, 'recovery_asset_path'),
  }
}

export function buildRecoveryAssetInventory(values, options = {}) {
  if (!Array.isArray(values) || values.length === 0
    || (options.generatedAt !== undefined && !safeInteger(options.generatedAt))) {
    fail('operations_recovery_inventory_invalid')
  }
  const assets = values.map(normalizedAsset)
  if (new Set(assets.map(item => item.assetId)).size !== assets.length) {
    fail('operations_recovery_asset_duplicate')
  }
  const byObject = new Map()
  for (const asset of assets) {
    const group = byObject.get(asset.recoveryObject) || []
    group.push(asset)
    byObject.set(asset.recoveryObject, group)
  }
  const items = []
  for (const group of byObject.values()) {
    if (group.filter(item => item.state === 'current').length > 1) {
      fail('operations_recovery_current_duplicate')
    }
    const newestValidHistory = new Set(group
      .filter(item => item.state === 'history' && item.validation === 'valid')
      .sort((left, right) => right.createdAt - left.createdAt
        || left.assetId.localeCompare(right.assetId))
      .slice(0, 2)
      .map(item => item.assetId))
    for (const asset of group) {
      let disposition
      let reason
      let removalCandidate = false
      let retentionException = false
      if (asset.state === 'current') {
        disposition = 'retain'
        reason = 'current'
      } else if (asset.references.length > 0) {
        disposition = 'retain'
        reason = 'referenced'
        retentionException = !newestValidHistory.has(asset.assetId)
      } else if (asset.validation !== 'valid') {
        disposition = 'review-required'
        reason = asset.validation
      } else if (newestValidHistory.has(asset.assetId)) {
        disposition = 'retain'
        reason = 'newest-valid-history'
      } else {
        disposition = 'candidate-after-authorization'
        reason = 'valid-history-over-limit'
        removalCandidate = true
      }
      items.push({ ...asset, disposition, reason, removalCandidate, retentionException })
    }
  }
  items.sort((left, right) => left.recoveryObject.localeCompare(right.recoveryObject)
    || right.createdAt - left.createdAt || left.assetId.localeCompare(right.assetId))
  return deepFreeze({
    schema: OPERATIONS_RECOVERY_INVENTORY_SCHEMA,
    generatedAt: options.generatedAt ?? Math.floor(Date.now() / 1_000),
    policy: { validHistoryLimit: 2, deletionAuthorized: false },
    objectives: { rpoSeconds: null, rtoSeconds: null, status: 'not-set' },
    summary: {
      assets: items.length,
      removalCandidates: items.filter(item => item.removalCandidate).length,
      reviewRequired: items.filter(item => item.disposition === 'review-required').length,
      retentionExceptions: items.filter(item => item.retentionException).length,
    },
    items,
  })
}

function normalizedRuntimeIdentity(value, label) {
  if (!exactKeys(value, [
    'configSha256', 'cwd', 'database', 'manifestSha256', 'pid', 'releaseId',
  ])
    || typeof value.releaseId !== 'string' || !SAFE_ID.test(value.releaseId)
    || !safeInteger(value.pid, 1)
    || typeof value.manifestSha256 !== 'string' || !SHA256.test(value.manifestSha256)
    || typeof value.configSha256 !== 'string' || !SHA256.test(value.configSha256)
    || !exactKeys(value.database, ['dev', 'ino', 'path'])
    || !/^\d+$/u.test(value.database.dev) || !/^\d+$/u.test(value.database.ino)) {
    fail(`operations_runtime_${label}_invalid`)
  }
  return {
    releaseId: value.releaseId,
    pid: value.pid,
    manifestSha256: value.manifestSha256,
    configSha256: value.configSha256,
    cwdIdentitySha256: identitySha256(value.cwd, `${label}_cwd`),
    database: {
      pathIdentitySha256: identitySha256(value.database.path, `${label}_database_path`),
      dev: value.database.dev,
      ino: value.database.ino,
    },
  }
}

export function buildRuntimeIdentityDoctor(expectedSource, observedSource, options = {}) {
  const expected = normalizedRuntimeIdentity(expectedSource, 'expected')
  const observed = normalizedRuntimeIdentity(observedSource, 'observed')
  const fields = [
    ['releaseId', expected.releaseId, observed.releaseId],
    ['pid', expected.pid, observed.pid],
    ['manifestSha256', expected.manifestSha256, observed.manifestSha256],
    ['configSha256', expected.configSha256, observed.configSha256],
    ['cwdIdentitySha256', expected.cwdIdentitySha256, observed.cwdIdentitySha256],
    ['database.pathIdentitySha256', expected.database.pathIdentitySha256,
      observed.database.pathIdentitySha256],
    ['database.dev', expected.database.dev, observed.database.dev],
    ['database.ino', expected.database.ino, observed.database.ino],
  ]
  const drift = fields.filter(([, left, right]) => left !== right)
    .map(([field, expectedValue, observedValue]) => ({
      field, expected: expectedValue, observed: observedValue,
    }))
  return deepFreeze({
    schema: OPERATIONS_RUNTIME_DOCTOR_SCHEMA,
    observedAt: options.observedAt ?? Math.floor(Date.now() / 1_000),
    status: drift.length === 0 ? 'aligned' : 'drifted',
    expected,
    observed,
    drift,
    mutationPerformed: false,
  })
}

export function sanitizeOperationsAuditEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => FORBIDDEN_AUDIT_KEY.test(key))
    || typeof value.attemptId !== 'string' || !SAFE_ID.test(value.attemptId)
    || typeof value.operation !== 'string' || !SAFE_CODE.test(value.operation)
    || typeof value.phase !== 'string' || !SAFE_CODE.test(value.phase)
    || !AUDIT_STATUSES.has(value.status)
    || typeof value.objectKind !== 'string' || !KINDS.has(value.objectKind)
    || typeof value.objectIdentity !== 'string'
    || !safeInteger(value.startedAt)
    || (value.completedAt !== null && !safeInteger(value.completedAt))
    || (value.errorCode !== null
      && (typeof value.errorCode !== 'string' || !SAFE_CODE.test(value.errorCode)))) {
    fail('operations_audit_event_invalid')
  }
  const event = {
    schema: OPERATIONS_AUDIT_EVENT_SCHEMA,
    attemptId: value.attemptId,
    operation: value.operation,
    phase: value.phase,
    status: value.status,
    objectKind: value.objectKind,
    objectIdentitySha256: identitySha256(value.objectIdentity, 'audit_object_identity'),
    startedAt: value.startedAt,
    completedAt: value.completedAt,
    errorCode: value.errorCode,
  }
  return deepFreeze({ ...event, eventSha256: sha256(canonicalJson(event)) })
}
