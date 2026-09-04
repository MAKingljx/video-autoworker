import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildExactUtf8JsonPayload,
  buildProjectionDisabledDirectorEntry,
  buildStressPluginEntry,
  DEFAULT_TOOL_RESULT_BYTES,
  MATRIX_CELLS,
  normalizedCatalogToolIds,
  normalizedToolIds,
  parseBoundedInteger,
  stressPluginManifest,
  validateCellObservation,
  validateMatrixReport,
} from './lib/openclaw-same-turn-ab-canary.mjs'

const requiredTools = [
  'aiworker_analyze_video',
  'aiworker_director_brain',
  'aiworker_same_turn_stress',
  'session_status',
].toSorted()

const toolFingerprint = requiredTools.map(id => ({
  id,
  source: id.startsWith('aiworker_') ? 'plugin' : 'core',
  pluginId: id.startsWith('aiworker_') ? `fixture-${id}` : null,
  channelId: null,
  descriptorSurfaceSha256: `sha256-${id}`,
}))

function acceptedCell(descriptor) {
  return {
    ...descriptor,
    evidenceClass: 'live-model-real-openclaw-loop',
    realOpenClawLoop: true,
    completedToolResults: 10,
    currentTurnRawResultChainCompleted: true,
    stressFinalReplyMatched: true,
    toolResultBytes: Array(10).fill(DEFAULT_TOOL_RESULT_BYTES),
    persistedToolResultBytes: Array(10).fill(
      descriptor.projection ? 96 : DEFAULT_TOOL_RESULT_BYTES,
    ),
    sameTurnModelCalls: 11,
    sameTurnPeakRequestBytes: 250_000,
    nextTurnRequestBytes: descriptor.projection ? 45_000 : 290_000,
    transcriptBytesAfterStress: descriptor.projection ? 12_000 : 260_000,
    stopReason: 'stop',
    effectiveToolIdsBefore: requiredTools,
    effectiveToolIdsAfter: requiredTools,
    catalogToolIdsBefore: requiredTools,
    catalogToolIdsAfter: requiredTools,
    effectiveToolFingerprintBefore: toolFingerprint,
    effectiveToolFingerprintAfter: toolFingerprint,
    catalogToolFingerprintBefore: toolFingerprint,
    catalogToolFingerprintAfter: toolFingerprint,
  }
}

test('matrix contains exactly the requested 2x2 cells', () => {
  assert.deepEqual(MATRIX_CELLS, [
    { id: 'precheck-off_projection-off', precheck: false, projection: false },
    { id: 'precheck-off_projection-on', precheck: false, projection: true },
    { id: 'precheck-on_projection-off', precheck: true, projection: false },
    { id: 'precheck-on_projection-on', precheck: true, projection: true },
  ])
})

test('stress payload has exact UTF-8 byte size', () => {
  const payload = buildExactUtf8JsonPayload({
    sequence: 7,
    nextNonce: 'abcdef',
    targetBytes: DEFAULT_TOOL_RESULT_BYTES,
  })
  assert.equal(Buffer.byteLength(payload, 'utf8'), DEFAULT_TOOL_RESULT_BYTES)
  assert.equal(JSON.parse(payload).sequence, 7)
})

test('stress plugin enforces nonce sequencing and writes size-only audit', () => {
  const source = buildStressPluginEntry()
  assert.match(source, /executionMode: 'sequential'/u)
  assert.match(source, /sequence_or_nonce_mismatch/u)
  assert.match(source, /same-turn-stress-audit\.jsonl/u)
  assert.match(source, /Buffer\.byteLength\(payload, 'utf8'\)/u)
  const auditLine = source.split('\n').find(line => line.includes('appendFileSync(auditPath'))
  assert.match(auditLine, /sequence, bytes/u)
  assert.doesNotMatch(auditLine, /padding|nextNonce|observation/u)
  assert.deepEqual(stressPluginManifest().contracts.tools, ['aiworker_same_turn_stress'])
})

test('projection-off director entry keeps tool and reply hook but omits persistence hooks', () => {
  const source = buildProjectionDisabledDirectorEntry()
  assert.match(source, /createDirectorBrainTool/u)
  assert.match(source, /before_agent_reply/u)
  assert.doesNotMatch(source, /tool_result_persist/u)
  assert.doesNotMatch(source, /before_message_write/u)
})

test('inventory normalization is stable and deduplicated', () => {
  const value = {
    groups: [
      { tools: [{ id: 'z' }, { id: 'a' }] },
      { tools: [{ id: 'a' }, { id: 'm' }] },
    ],
  }
  assert.deepEqual(normalizedToolIds(value), ['a', 'm', 'z'])
  assert.deepEqual(normalizedCatalogToolIds(value), ['a', 'm', 'z'])
})

test('integer parser rejects stress values outside the required bounds', () => {
  assert.equal(parseBoundedInteger(undefined, {
    name: 'calls', defaultValue: 10, minimum: 8, maximum: 12,
  }), 10)
  assert.throws(() => parseBoundedInteger('7', {
    name: 'calls', defaultValue: 10, minimum: 8, maximum: 12,
  }), /between 8 and 12/u)
})

test('cell validation requires projection-on to finish every requested call normally', () => {
  const normal = acceptedCell(MATRIX_CELLS[1])
  assert.deepEqual(validateCellObservation(normal, {
    requestedCalls: 10,
    requestedResultBytes: DEFAULT_TOOL_RESULT_BYTES,
    requiredToolIds: requiredTools,
  }), { valid: true, reasons: [] })

  const length = {
    ...acceptedCell(MATRIX_CELLS[1]),
    completedToolResults: 8,
    currentTurnRawResultChainCompleted: false,
    stressFinalReplyMatched: false,
    toolResultBytes: Array(8).fill(DEFAULT_TOOL_RESULT_BYTES),
    persistedToolResultBytes: Array(8).fill(96),
    sameTurnModelCalls: 9,
    stopReason: 'length',
  }
  const rejected = validateCellObservation(length, {
    requestedCalls: 10,
    requestedResultBytes: DEFAULT_TOOL_RESULT_BYTES,
    requiredToolIds: requiredTools,
  })
  assert.equal(rejected.valid, false)
  assert.ok(rejected.reasons.includes('projection-on-stress-loop-incomplete'))
  assert.ok(rejected.reasons.includes('projection-on-stopped-before-normal-completion'))

  const projectionOffControl = { ...length, ...MATRIX_CELLS[0],
    persistedToolResultBytes: Array(8).fill(DEFAULT_TOOL_RESULT_BYTES) }
  assert.equal(validateCellObservation(projectionOffControl, {
    requestedCalls: 10,
    requestedResultBytes: DEFAULT_TOOL_RESULT_BYTES,
    requiredToolIds: requiredTools,
  }).valid, true)
})

test('cell validation rejects reduced tools, changed semantics, and mock evidence', () => {
  const cell = {
    ...acceptedCell(MATRIX_CELLS[1]),
    evidenceClass: 'scripted-structural-only',
    effectiveToolIdsAfter: requiredTools.slice(1),
    effectiveToolFingerprintAfter: toolFingerprint.map((entry, index) => (
      index === 0 ? { ...entry, descriptorSurfaceSha256: 'changed' } : entry
    )),
  }
  const result = validateCellObservation(cell, {
    requestedCalls: 10,
    requestedResultBytes: DEFAULT_TOOL_RESULT_BYTES,
    requiredToolIds: requiredTools,
  })
  assert.equal(result.valid, false)
  assert.ok(result.reasons.includes('not-live-model-evidence'))
  assert.ok(result.reasons.includes('effective-tools-changed'))
  assert.ok(result.reasons.includes('effective-tool-capabilities-changed'))
})

test('matrix validation requires exact runtime and identical full tool inventories', () => {
  const cells = MATRIX_CELLS.map(descriptor => ({ ...acceptedCell(descriptor), valid: true }))
  const report = {
    schemaVersion: 1,
    evidenceClass: 'live-model-real-openclaw-loop',
    nodeVersion: 'v22.22.3',
    openclawVersion: '2026.7.1-2',
    expectedOpenclawVersion: '2026.7.1-2',
    cells,
  }
  assert.deepEqual(validateMatrixReport(report), { accepted: true, reasons: [] })
  report.cells[3] = {
    ...report.cells[3],
    effectiveToolFingerprintBefore: toolFingerprint.map((entry, index) => (
      index === 0 ? { ...entry, pluginId: 'substituted-plugin' } : entry
    )),
  }
  const rejected = validateMatrixReport(report)
  assert.equal(rejected.accepted, false)
  assert.ok(rejected.reasons.includes(
    'precheck-on_projection-on:effective-tool-capability-fingerprint-differs',
  ))
})

test('matrix rejects a projection-on false positive that regresses calls or the user answer', () => {
  const cells = MATRIX_CELLS.map(descriptor => ({ ...acceptedCell(descriptor), valid: true }))
  cells[1] = {
    ...cells[1],
    completedToolResults: 8,
    currentTurnRawResultChainCompleted: false,
    stressFinalReplyMatched: false,
    stopReason: 'length',
    persistedToolResultBytes: Array(8).fill(96),
  }
  Object.assign(cells[1], validateCellObservation(cells[1], {
    requestedCalls: 10,
    requestedResultBytes: DEFAULT_TOOL_RESULT_BYTES,
    requiredToolIds: requiredTools,
  }))
  const report = {
    schemaVersion: 1,
    evidenceClass: 'live-model-real-openclaw-loop',
    nodeVersion: 'v22.22.3',
    openclawVersion: '2026.7.1-2',
    expectedOpenclawVersion: '2026.7.1-2',
    cells,
  }
  const rejected = validateMatrixReport(report)
  assert.equal(rejected.accepted, false)
  assert.ok(rejected.reasons.includes('precheck-off_projection-on:invalid'))
  assert.ok(rejected.reasons.includes('precheck-off:projection-completed-fewer-calls'))
  assert.ok(rejected.reasons.includes('precheck-off:projection-user-answer-regressed'))
})
