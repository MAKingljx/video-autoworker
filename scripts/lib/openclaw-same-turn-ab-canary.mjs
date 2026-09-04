import { createHash } from 'node:crypto'

export const DEFAULT_EXPECTED_OPENCLAW_VERSION = '2026.7.1-2'
export const DEFAULT_TOOL_CALLS = 10
export const DEFAULT_TOOL_RESULT_BYTES = 24 * 1024
export const MIN_TOOL_CALLS = 8
export const MAX_TOOL_CALLS = 12
export const MIN_TOOL_RESULT_BYTES = 20 * 1024
export const MAX_TOOL_RESULT_BYTES = 32 * 1024

export const MATRIX_CELLS = Object.freeze([
  Object.freeze({ id: 'precheck-off_projection-off', precheck: false, projection: false }),
  Object.freeze({ id: 'precheck-off_projection-on', precheck: false, projection: true }),
  Object.freeze({ id: 'precheck-on_projection-off', precheck: true, projection: false }),
  Object.freeze({ id: 'precheck-on_projection-on', precheck: true, projection: true }),
])

export function parseBoundedInteger(value, {
  name,
  defaultValue,
  minimum,
  maximum,
}) {
  const parsed = value === undefined || value === '' ? defaultValue : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

export function normalizedToolIds(inventory) {
  const groups = Array.isArray(inventory?.groups) ? inventory.groups : []
  return [...new Set(groups.flatMap(group => (
    Array.isArray(group?.tools) ? group.tools : []
  )).map(tool => tool?.id).filter(Boolean))].toSorted()
}

export function normalizedCatalogToolIds(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : []
  return [...new Set(groups.flatMap(group => (
    Array.isArray(group?.tools) ? group.tools : []
  )).map(tool => tool?.id).filter(Boolean))].toSorted()
}

export function sameStringArray(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function buildExactUtf8JsonPayload({ sequence, nextNonce, targetBytes }) {
  const base = {
    ok: true,
    sequence,
    nextNonce,
    observation: `same-turn-stress-${sequence}`,
    padding: '',
  }
  const empty = JSON.stringify(base)
  const remaining = targetBytes - Buffer.byteLength(empty, 'utf8')
  if (remaining < 0) throw new Error('targetBytes is too small for the stress payload envelope')
  base.padding = 'x'.repeat(remaining)
  const payload = JSON.stringify(base)
  if (Buffer.byteLength(payload, 'utf8') !== targetBytes) {
    throw new Error('failed to build an exact-size UTF-8 stress payload')
  }
  return payload
}

export function nextStressNonce(runSalt, sequence) {
  return sha256(`${runSalt}:${sequence}`).slice(0, 24)
}

export function buildProjectionDisabledDirectorEntry() {
  return [
    "import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'",
    "import { createDirectorBrainTool, DEFAULT_TARGET_AGENT_ID, DIRECTOR_BRAIN_TOOL_NAME } from './lib/director-brain-tool.js'",
    "import { createDirectorBrainSystemQuestionHandler } from './lib/director-system-question-router.js'",
    '',
    'export default definePluginEntry({',
    "  id: 'aiworker-director-brain',",
    "  name: 'AI-worker Director Brain',",
    "  description: 'OpenClaw access to work-scoped director context, global techniques, and shared extraction workflows.',",
    '  register(api) {',
    '    const releaseReady = api.pluginConfig?.releaseReady === true',
    '    const targetAgentId = api.pluginConfig?.targetAgentId?.trim() || DEFAULT_TARGET_AGENT_ID',
    '    api.registerTool(context => createDirectorBrainTool({ context, releaseReady, targetAgentId }), {',
    '      names: [DIRECTOR_BRAIN_TOOL_NAME],',
    '      optional: true,',
    '    })',
    "    api.on('before_agent_reply', createDirectorBrainSystemQuestionHandler({ releaseReady, targetAgentId }), {",
    '      priority: 200,',
    "      eligibleTriggers: ['user'],",
    '      timeoutMs: 35_000,',
    '    })',
    '  },',
    '})',
    '',
  ].join('\n')
}

export function buildStressPluginEntry() {
  return [
    "import { createHash } from 'node:crypto'",
    "import { appendFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry'",
    '',
    "const TOOL_NAME = 'aiworker_same_turn_stress'",
    "const textResult = text => ({ content: [{ type: 'text', text }] })",
    'const exactPayload = ({ sequence, nextNonce, targetBytes }) => {',
    "  const base = { ok: true, sequence, nextNonce, observation: `same-turn-stress-${sequence}`, padding: '' }",
    "  const remaining = targetBytes - Buffer.byteLength(JSON.stringify(base), 'utf8')",
    "  if (remaining < 0) throw new Error('stress_payload_target_too_small')",
    "  base.padding = 'x'.repeat(remaining)",
    '  const payload = JSON.stringify(base)',
    "  if (Buffer.byteLength(payload, 'utf8') !== targetBytes) throw new Error('stress_payload_size_mismatch')",
    '  return payload',
    '}',
    '',
    'export default definePluginEntry({',
    "  id: 'aiworker-same-turn-stress',",
    "  name: 'AI-worker Same-turn Stress Canary',",
    "  description: 'Isolated canary-only sequential large-result tool.',",
    '  register(api) {',
    '    const targetAgentId = api.pluginConfig?.targetAgentId',
    '    const totalCalls = api.pluginConfig?.totalCalls',
    '    const resultBytes = api.pluginConfig?.resultBytes',
    '    const runSalt = api.pluginConfig?.runSalt',
    "    const auditPath = join(process.env.OPENCLAW_STATE_DIR, 'same-turn-stress-audit.jsonl')",
    '    let expectedSequence = 1',
    "    let expectedNonce = 'START'",
    '    api.registerTool(context => {',
    '      if (context?.agentId !== targetAgentId) return null',
    '      return {',
    '        name: TOOL_NAME,',
    "        label: 'Same-turn stress canary',",
    "        description: 'Canary only. Call sequentially with the exact sequence and nonce returned by the previous result. Never call in parallel or skip a sequence.',",
    '        parameters: {',
    "          type: 'object',",
    '          additionalProperties: false,',
    "          required: ['sequence', 'nonce'],",
    '          properties: {',
    "            sequence: { type: 'integer', minimum: 1, maximum: totalCalls },",
    "            nonce: { type: 'string', minLength: 1, maxLength: 64 },",
    '          },',
    '        },',
    "        executionMode: 'sequential',",
    '        async execute(_toolCallId, params) {',
    '          if (params?.sequence !== expectedSequence || params?.nonce !== expectedNonce) {',
    "            return textResult(JSON.stringify({ ok: false, error: 'sequence_or_nonce_mismatch', expectedSequence, expectedNonce }))",
    '          }',
    '          const sequence = expectedSequence',
    '          const nextNonce = sequence === totalCalls',
    "            ? 'COMPLETE'",
    "            : createHash('sha256').update(`${runSalt}:${sequence}`).digest('hex').slice(0, 24)",
    '          expectedSequence += 1',
    '          expectedNonce = nextNonce',
    '          const payload = exactPayload({ sequence, nextNonce, targetBytes: resultBytes })',
    "          appendFileSync(auditPath, `${JSON.stringify({ sequence, bytes: Buffer.byteLength(payload, 'utf8') })}\\n`, { mode: 0o600 })",
    '          return textResult(payload)',
    '        },',
    '      }',
    '    }, { names: [TOOL_NAME], optional: true })',
    '  },',
    '})',
    '',
  ].join('\n')
}

export function stressPluginManifest() {
  return {
    id: 'aiworker-same-turn-stress',
    name: 'AI-worker Same-turn Stress Canary',
    version: '0.0.0-canary',
    description: 'Isolated canary-only sequential large-result tool.',
    activation: { onStartup: true, onCapabilities: ['tool'] },
    contracts: { tools: ['aiworker_same_turn_stress'] },
    toolMetadata: { aiworker_same_turn_stress: { optional: true } },
    configSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['targetAgentId', 'totalCalls', 'resultBytes', 'runSalt'],
      properties: {
        targetAgentId: { type: 'string', minLength: 1, maxLength: 128 },
        totalCalls: { type: 'integer', minimum: MIN_TOOL_CALLS, maximum: MAX_TOOL_CALLS },
        resultBytes: {
          type: 'integer',
          minimum: MIN_TOOL_RESULT_BYTES,
          maximum: MAX_TOOL_RESULT_BYTES,
        },
        runSalt: { type: 'string', minLength: 16, maxLength: 128 },
      },
    },
  }
}

export function validateCellObservation(cell, {
  requestedCalls,
  requestedResultBytes,
  requiredToolIds,
}) {
  const reasons = []
  if (cell.evidenceClass !== 'live-model-real-openclaw-loop') reasons.push('not-live-model-evidence')
  if (cell.realOpenClawLoop !== true) reasons.push('real-loop-not-verified')
  if (cell.completedToolResults < MIN_TOOL_CALLS) reasons.push('fewer-than-eight-tool-results')
  if (cell.completedToolResults > requestedCalls) reasons.push('too-many-tool-results')
  const completedNormally = cell.completedToolResults === requestedCalls
    && cell.currentTurnRawResultChainCompleted === true
    && cell.stressFinalReplyMatched === true
  const observedLengthStop = cell.completedToolResults >= MIN_TOOL_CALLS
    && cell.stopReason === 'length'
  const observedOverflowStop = cell.completedToolResults >= MIN_TOOL_CALLS
    && cell.stopReason === 'error'
    && cell.contextOverflowDetected === true
  if (cell.projection && !completedNormally) {
    reasons.push('projection-on-stress-loop-incomplete')
  } else if (!cell.projection && !completedNormally && !observedLengthStop && !observedOverflowStop) {
    reasons.push('stress-loop-not-completed-or-overflow-stopped')
  }
  if (cell.projection && ['length', 'error'].includes(cell.stopReason)) {
    reasons.push('projection-on-stopped-before-normal-completion')
  }
  if (!cell.toolResultBytes.every(value => value === requestedResultBytes)) {
    reasons.push('tool-result-size-mismatch')
  }
  if (cell.persistedToolResultBytes.length !== cell.completedToolResults) {
    reasons.push('persisted-tool-result-count-mismatch')
  }
  if (cell.projection) {
    if (!cell.persistedToolResultBytes.every(value => value < requestedResultBytes)) {
      reasons.push('projection-did-not-reduce-persisted-results')
    }
  } else if (!cell.persistedToolResultBytes.every(value => (
    value > 0 && value <= requestedResultBytes
  ))) {
    reasons.push('projection-off-persisted-result-size-invalid')
  }
  if (cell.sameTurnModelCalls < cell.completedToolResults + 1) {
    reasons.push('tool-calls-were-not-observed-as-sequential-model-steps')
  }
  if (!requiredToolIds.every(id => cell.effectiveToolIdsBefore.includes(id))) {
    reasons.push('required-tool-missing')
  }
  if (!Array.isArray(cell.effectiveToolFingerprintBefore)
    || cell.effectiveToolFingerprintBefore.length === 0
    || !Array.isArray(cell.catalogToolFingerprintBefore)
    || cell.catalogToolFingerprintBefore.length === 0) {
    reasons.push('tool-capability-fingerprint-missing')
  }
  if (!sameStringArray(cell.effectiveToolIdsBefore, cell.effectiveToolIdsAfter)) {
    reasons.push('effective-tools-changed')
  }
  if (!sameStringArray(cell.catalogToolIdsBefore, cell.catalogToolIdsAfter)) {
    reasons.push('catalog-tools-changed')
  }
  if (!sameStringArray(
    cell.effectiveToolFingerprintBefore,
    cell.effectiveToolFingerprintAfter,
  )) {
    reasons.push('effective-tool-capabilities-changed')
  }
  if (!sameStringArray(
    cell.catalogToolFingerprintBefore,
    cell.catalogToolFingerprintAfter,
  )) {
    reasons.push('catalog-tool-capabilities-changed')
  }
  if (!Number.isSafeInteger(cell.sameTurnPeakRequestBytes) || cell.sameTurnPeakRequestBytes <= 0) {
    reasons.push('same-turn-peak-missing')
  }
  if (!Number.isSafeInteger(cell.nextTurnRequestBytes) || cell.nextTurnRequestBytes <= 0) {
    reasons.push('next-turn-request-size-missing')
  }
  if (!Number.isSafeInteger(cell.transcriptBytesAfterStress) || cell.transcriptBytesAfterStress <= 0) {
    reasons.push('transcript-size-missing')
  }
  if (typeof cell.stopReason !== 'string' || cell.stopReason.length === 0) {
    reasons.push('stop-reason-missing')
  }
  return { valid: reasons.length === 0, reasons }
}

export function validateMatrixReport(report) {
  const reasons = []
  if (report.schemaVersion !== 1) reasons.push('unsupported-schema')
  if (report.evidenceClass !== 'live-model-real-openclaw-loop') reasons.push('not-live-model-evidence')
  if (report.nodeVersion !== 'v22.22.3') reasons.push('node-version-mismatch')
  if (report.openclawVersion !== report.expectedOpenclawVersion) reasons.push('openclaw-version-mismatch')
  if (!Array.isArray(report.cells) || report.cells.length !== MATRIX_CELLS.length) {
    reasons.push('matrix-incomplete')
    return { accepted: false, reasons }
  }
  const expectedIds = MATRIX_CELLS.map(cell => cell.id)
  const actualIds = report.cells.map(cell => cell.id)
  if (!sameStringArray(actualIds, expectedIds)) reasons.push('matrix-cell-order-or-id-mismatch')
  const baselineEffective = report.cells[0]?.effectiveToolIdsBefore || []
  const baselineCatalog = report.cells[0]?.catalogToolIdsBefore || []
  const baselineEffectiveFingerprint = report.cells[0]?.effectiveToolFingerprintBefore || []
  const baselineCatalogFingerprint = report.cells[0]?.catalogToolFingerprintBefore || []
  for (const cell of report.cells) {
    if (cell.valid !== true) reasons.push(`${cell.id}:invalid`)
    if (!sameStringArray(cell.effectiveToolIdsBefore, baselineEffective)) {
      reasons.push(`${cell.id}:effective-tool-set-differs`)
    }
    if (!sameStringArray(cell.catalogToolIdsBefore, baselineCatalog)) {
      reasons.push(`${cell.id}:catalog-tool-set-differs`)
    }
    if (!sameStringArray(cell.effectiveToolFingerprintBefore, baselineEffectiveFingerprint)) {
      reasons.push(`${cell.id}:effective-tool-capability-fingerprint-differs`)
    }
    if (!sameStringArray(cell.catalogToolFingerprintBefore, baselineCatalogFingerprint)) {
      reasons.push(`${cell.id}:catalog-tool-capability-fingerprint-differs`)
    }
  }
  for (const precheck of [false, true]) {
    const projectionOff = report.cells.find(cell => (
      cell.precheck === precheck && cell.projection === false
    ))
    const projectionOn = report.cells.find(cell => (
      cell.precheck === precheck && cell.projection === true
    ))
    const offMaximum = Math.max(0, ...(projectionOff?.persistedToolResultBytes || []))
    const onMaximum = Math.max(0, ...(projectionOn?.persistedToolResultBytes || []))
    if (!(onMaximum > 0 && offMaximum > onMaximum)) {
      reasons.push(`precheck-${precheck ? 'on' : 'off'}:projection-persisted-effect-unproven`)
    }
    if ((projectionOn?.completedToolResults ?? -1) < (projectionOff?.completedToolResults ?? 0)) {
      reasons.push(`precheck-${precheck ? 'on' : 'off'}:projection-completed-fewer-calls`)
    }
    if (projectionOff?.stressFinalReplyMatched === true
      && projectionOn?.stressFinalReplyMatched !== true) {
      reasons.push(`precheck-${precheck ? 'on' : 'off'}:projection-user-answer-regressed`)
    }
    if (projectionOff?.currentTurnRawResultChainCompleted === true
      && projectionOn?.currentTurnRawResultChainCompleted !== true) {
      reasons.push(`precheck-${precheck ? 'on' : 'off'}:projection-raw-chain-regressed`)
    }
  }
  return { accepted: reasons.length === 0, reasons }
}
