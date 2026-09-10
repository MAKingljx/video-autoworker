export const LEGACY_PREINSTALL_HANDOFF_CORE_KEYS = Object.freeze([
  'binding',
  'componentJournalHead',
  'freshReadinessSha256',
  'gatewayActivation',
  'initialFinalGate',
  'payloads',
  'readiness',
  'runtimeConvergenceProof',
  'verification',
])

export const LEGACY_PREINSTALL_HANDOFF_PAYLOAD_KEYS = Object.freeze([
  ...LEGACY_PREINSTALL_HANDOFF_CORE_KEYS,
  'finalize',
  'finalGate',
])

export const LEGACY_PREINSTALL_FINALIZE_KEYS = Object.freeze([
  'choice',
  'claimedAt',
  'handoffCore',
  'installAttemptId',
  'journalHead',
  'revision',
  'schema',
  'uid',
])

export function projectLegacyPreinstallHandoffCore(payload) {
  return Object.fromEntries(LEGACY_PREINSTALL_HANDOFF_CORE_KEYS.map(key => [key, payload?.[key]]))
}

export function buildLegacyPreinstallHandoffPayload(handoffCore, finalize, finalGate) {
  return { ...handoffCore, finalize, finalGate }
}
