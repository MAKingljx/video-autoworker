import { createHash } from 'node:crypto'

export const OPERATIONS_TRANSFER_PLAN_SCHEMA =
  'video-autoworker-operations-transfer-plan/v1'
export const OPERATIONS_RETRY_POLICY_SCHEMA =
  'video-autoworker-operations-transfer-retry-policy/v1'
export const OPERATIONS_TELEMETRY_SUMMARY_SCHEMA =
  'video-autoworker-operations-telemetry-summary/v1'
export const OPERATIONS_PREWARM_PLAN_SCHEMA =
  'video-autoworker-operations-read-only-prewarm/v1'
export const OPERATIONS_FACT_RECORD_SCHEMA =
  'video-autoworker-operations-latest-fact/v1'
export const OPERATIONS_FAILURE_RECORD_SCHEMA =
  'video-autoworker-operations-failure/v1'
export const OPERATIONS_MAINTENANCE_REQUEST_SCHEMA =
  'video-autoworker-operations-maintenance-request/v1'

const SHA256 = /^[a-f0-9]{64}$/u
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/u
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?\/)(?!.*\\)[^\u0000-\u001f\u007f]+$/u
const MODES = /^[0-7]{4}$/u
const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'blocked'])
const MAINTENANCE_ACTIONS = new Set([
  'doctor', 'inventory', 'prewarm-plan', 'record-fact', 'status', 'telemetry', 'transfer-plan',
])

function fail(code) {
  throw new Error(code)
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

function exactKeys(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

function integer(value, minimum = 0) {
  return Number.isSafeInteger(value) && value >= minimum
}

function normalizedManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schemaVersion !== 2 || manifest.algorithm !== 'sha256'
    || !Array.isArray(manifest.directories) || !Array.isArray(manifest.files)
    || !Array.isArray(manifest.symlinks)) fail('operations_transfer_manifest_invalid')
  const members = []
  for (const [kind, entries, expectedKeys] of [
    ['directory', manifest.directories, ['mode', 'path']],
    ['file', manifest.files, ['bytes', 'mode', 'path', 'sha256']],
    ['symlink', manifest.symlinks, ['mode', 'path', 'target']],
  ]) {
    for (const entry of entries) {
      if (!exactKeys(entry, expectedKeys) || typeof entry.path !== 'string'
        || !SAFE_PATH.test(entry.path) || !MODES.test(entry.mode)
        || (kind === 'file' && (!integer(entry.bytes) || !SHA256.test(entry.sha256)))
        || (kind === 'symlink' && (typeof entry.target !== 'string' || !entry.target
          || /[\u0000-\u001f\u007f]/u.test(entry.target)))) {
        fail('operations_transfer_manifest_invalid')
      }
      members.push({ kind, ...entry })
    }
  }
  members.sort((left, right) => left.path.localeCompare(right.path)
    || left.kind.localeCompare(right.kind))
  if (new Set(members.map(item => item.path)).size !== members.length) {
    fail('operations_transfer_manifest_duplicate')
  }
  return members
}

export function buildBoundedTransferRetryPolicy(options = {}) {
  const maxAttempts = options.maxAttempts ?? 1
  const baseDelayMs = options.baseDelayMs ?? 0
  const maximumDelayMs = options.maximumDelayMs ?? baseDelayMs
  const proxyMode = options.proxyMode ?? 'none'
  if (!integer(maxAttempts, 1) || maxAttempts > 5
    || !integer(baseDelayMs) || !integer(maximumDelayMs)
    || maximumDelayMs < baseDelayMs || maximumDelayMs > 60_000
    || (maxAttempts > 1 && baseDelayMs < 100)
    || !['none', 'process-scoped-verified'].includes(proxyMode)
    || (proxyMode === 'process-scoped-verified' && !SHA256.test(options.proxyIdentitySha256 || ''))
    || (proxyMode === 'none' && options.proxyIdentitySha256 !== undefined)) {
    fail('operations_transfer_retry_policy_invalid')
  }
  const delaysMs = Array.from({ length: maxAttempts - 1 }, (_, index) => (
    Math.min(maximumDelayMs, baseDelayMs * (2 ** index))
  ))
  return deepFreeze({
    schema: OPERATIONS_RETRY_POLICY_SCHEMA,
    maxAttempts,
    delaysMs,
    proxy: proxyMode === 'none'
      ? { mode: 'none', injected: false, identitySha256: null }
      : { mode: proxyMode, injected: true, identitySha256: options.proxyIdentitySha256 },
    tls: { verifyIdentity: true, downgradeAllowed: false },
    stopCodes: [
      'tls_identity_invalid', 'transfer_manifest_mismatch', 'transfer_path_unsafe',
    ],
  })
}

export function buildIncrementalTransferPlan(sourceManifest, donorManifest, options = {}) {
  const source = normalizedManifest(sourceManifest)
  const donor = normalizedManifest(donorManifest)
  const retryPolicy = buildBoundedTransferRetryPolicy(options.retryPolicy)
  const donorByPath = new Map(donor.map(item => [item.path, item]))
  const sourcePaths = new Set(source.map(item => item.path))
  const reuse = []
  const transfer = []
  for (const member of source) {
    const prior = donorByPath.get(member.path)
    const descriptor = { kind: member.kind, path: member.path }
    if (prior && canonicalJson(prior) === canonicalJson(member)) reuse.push(descriptor)
    else transfer.push(descriptor)
  }
  const unexpectedDonorMembers = donor
    .filter(item => !sourcePaths.has(item.path))
    .map(item => ({ kind: item.kind, path: item.path }))
  const transferBytes = source
    .filter(item => item.kind === 'file'
      && transfer.some(candidate => candidate.kind === 'file' && candidate.path === item.path))
    .reduce((total, item) => total + item.bytes, 0)
  const sourceBytes = source.filter(item => item.kind === 'file')
    .reduce((total, item) => total + item.bytes, 0)
  return deepFreeze({
    schema: OPERATIONS_TRANSFER_PLAN_SCHEMA,
    sourceManifestSha256: sha256(canonicalJson(sourceManifest)),
    donorManifestSha256: sha256(canonicalJson(donorManifest)),
    staging: { mustBeFresh: true, inPlaceMutationAllowed: false },
    retryPolicy,
    summary: {
      sourceMembers: source.length,
      reusedMembers: reuse.length,
      transferredMembers: transfer.length,
      sourceBytes,
      transferBytes,
      unexpectedDonorMembers: unexpectedDonorMembers.length,
    },
    reuse,
    transfer,
    unexpectedDonorMembers,
    completionRequiresFullManifestVerification: true,
  })
}

function normalizedTelemetryEvent(value) {
  if (!exactKeys(value, [
    'bytes', 'completedAtMs', 'phase', 'resources', 'retryCount', 'startedAtMs',
    'status', 'waitLockMs',
  ])
    || typeof value.phase !== 'string' || !SAFE_CODE.test(value.phase)
    || !TERMINAL_STATUSES.has(value.status)
    || !integer(value.startedAtMs) || !integer(value.completedAtMs)
    || value.completedAtMs < value.startedAtMs
    || !integer(value.retryCount) || !integer(value.waitLockMs) || !integer(value.bytes)
    || !Array.isArray(value.resources)) fail('operations_telemetry_event_invalid')
  const resources = value.resources.map(sample => {
    if (!exactKeys(sample, [
      'atMs', 'cpuPercent', 'memoryBytes', 'queueDepth', 'readBytes', 'writeBytes',
    ])
      || !integer(sample.atMs) || typeof sample.cpuPercent !== 'number'
      || !Number.isFinite(sample.cpuPercent) || sample.cpuPercent < 0
      || !integer(sample.memoryBytes) || !integer(sample.queueDepth)
      || !integer(sample.readBytes) || !integer(sample.writeBytes)) {
      fail('operations_resource_sample_invalid')
    }
    return { ...sample }
  })
  return { ...value, resources }
}

function average(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

export function summarizeOperationsTelemetry(values) {
  if (!Array.isArray(values) || values.length === 0) fail('operations_telemetry_invalid')
  const events = values.map(normalizedTelemetryEvent)
  const samples = events.flatMap(event => event.resources)
  const phases = events.map(event => ({
    phase: event.phase,
    status: event.status,
    durationMs: event.completedAtMs - event.startedAtMs,
    waitLockMs: event.waitLockMs,
    retryCount: event.retryCount,
    bytes: event.bytes,
    resourceSamples: event.resources.length,
  }))
  return deepFreeze({
    schema: OPERATIONS_TELEMETRY_SUMMARY_SCHEMA,
    phases,
    totals: {
      durationMs: phases.reduce((sum, phase) => sum + phase.durationMs, 0),
      waitLockMs: phases.reduce((sum, phase) => sum + phase.waitLockMs, 0),
      retries: phases.reduce((sum, phase) => sum + phase.retryCount, 0),
      bytes: phases.reduce((sum, phase) => sum + phase.bytes, 0),
    },
    resources: {
      samples: samples.length,
      averageCpuPercent: average(samples.map(sample => sample.cpuPercent)),
      peakCpuPercent: samples.length ? Math.max(...samples.map(sample => sample.cpuPercent)) : null,
      averageMemoryBytes: average(samples.map(sample => sample.memoryBytes)),
      peakMemoryBytes: samples.length ? Math.max(...samples.map(sample => sample.memoryBytes)) : null,
      peakQueueDepth: samples.length ? Math.max(...samples.map(sample => sample.queueDepth)) : null,
      readBytes: samples.reduce((sum, sample) => sum + sample.readBytes, 0),
      writeBytes: samples.reduce((sum, sample) => sum + sample.writeBytes, 0),
    },
    budgets: {
      cpuPercent: null,
      memoryBytes: null,
      ioBytesPerSecond: null,
      status: 'not-set',
    },
  })
}

export function buildReadOnlyPrewarmPlan(actions) {
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > 3) {
    fail('operations_prewarm_actions_invalid')
  }
  const allowed = new Set(['health', 'read-only-query', 'static-resource'])
  const normalized = actions.map(action => {
    if (!exactKeys(action, ['kind', 'targetId']) || !allowed.has(action.kind)
      || typeof action.targetId !== 'string' || !SAFE_ID.test(action.targetId)) {
      fail('operations_prewarm_action_invalid')
    }
    return { ...action, expectedWrites: 0 }
  })
  if (new Set(normalized.map(item => item.kind)).size !== normalized.length) {
    fail('operations_prewarm_action_duplicate')
  }
  return deepFreeze({
    schema: OPERATIONS_PREWARM_PLAN_SCHEMA,
    actions: normalized,
    safety: {
      approvalsAllowed: false,
      businessWritesAllowed: false,
      externalMessagesAllowed: false,
      modelTasksAllowed: false,
      schedulerAllowed: false,
    },
    objectives: { firstRequestP95Ms: null, status: 'not-set' },
  })
}

export function validateReadOnlyPrewarmResult(plan, result) {
  if (plan?.schema !== OPERATIONS_PREWARM_PLAN_SCHEMA
    || !exactKeys(result, [
      'approvals', 'businessWrites', 'externalMessages', 'modelTasks', 'observedActions',
      'schedulerRuns',
    ])
    || !Array.isArray(result.observedActions)
    || canonicalJson(result.observedActions) !== canonicalJson(plan.actions.map(item => item.kind))
    || ['approvals', 'businessWrites', 'externalMessages', 'modelTasks', 'schedulerRuns']
      .some(key => result[key] !== 0)) fail('operations_prewarm_result_unsafe')
  return deepFreeze({ ...result, safe: true })
}

export function buildOperationsFactRecord(value) {
  if (!exactKeys(value, [
    'evidenceSha256', 'factType', 'observedAt', 'revision', 'status', 'subjectId',
  ])
    || typeof value.subjectId !== 'string' || !SAFE_ID.test(value.subjectId)
    || typeof value.factType !== 'string' || !SAFE_CODE.test(value.factType)
    || typeof value.status !== 'string' || !SAFE_CODE.test(value.status)
    || !integer(value.observedAt) || !integer(value.revision, 1)
    || typeof value.evidenceSha256 !== 'string' || !SHA256.test(value.evidenceSha256)) {
    fail('operations_fact_record_invalid')
  }
  return deepFreeze({ schema: OPERATIONS_FACT_RECORD_SCHEMA, ...value })
}

export function selectLatestOperationsFact(values) {
  if (!Array.isArray(values) || values.length === 0) fail('operations_fact_records_invalid')
  const records = values.map(value => {
    if (value?.schema !== OPERATIONS_FACT_RECORD_SCHEMA) return buildOperationsFactRecord(value)
    const { schema: _schema, ...record } = value
    return buildOperationsFactRecord(record)
  })
  const subjects = new Set(records.map(item => `${item.subjectId}:${item.factType}`))
  if (subjects.size !== 1) fail('operations_fact_subject_mismatch')
  const sorted = records.toSorted((left, right) => right.revision - left.revision
    || right.observedAt - left.observedAt)
  if (sorted.length > 1 && sorted[0].revision === sorted[1].revision) {
    fail('operations_fact_revision_conflict')
  }
  return sorted[0]
}

export function buildOperationsFailureRecord(value) {
  if (!exactKeys(value, [
    'attemptId', 'errorCode', 'evidenceSha256', 'observedAt', 'phase', 'retryable',
  ])
    || typeof value.attemptId !== 'string' || !SAFE_ID.test(value.attemptId)
    || typeof value.phase !== 'string' || !SAFE_CODE.test(value.phase)
    || typeof value.errorCode !== 'string' || !SAFE_CODE.test(value.errorCode)
    || typeof value.retryable !== 'boolean' || !integer(value.observedAt)
    || typeof value.evidenceSha256 !== 'string' || !SHA256.test(value.evidenceSha256)) {
    fail('operations_failure_record_invalid')
  }
  return deepFreeze({ schema: OPERATIONS_FAILURE_RECORD_SCHEMA, ...value })
}

export function maintenanceLibraryRequest(value) {
  if (!exactKeys(value, ['action', 'inputSha256', 'requestedAt', 'requestId'])
    || typeof value.action !== 'string' || !MAINTENANCE_ACTIONS.has(value.action)
    || typeof value.inputSha256 !== 'string' || !SHA256.test(value.inputSha256)
    || typeof value.requestId !== 'string' || !SAFE_ID.test(value.requestId)
    || !integer(value.requestedAt)) fail('operations_maintenance_request_invalid')
  return deepFreeze({
    schema: OPERATIONS_MAINTENANCE_REQUEST_SCHEMA,
    ...value,
    execution: 'library-only',
    mutationAuthorized: false,
  })
}
