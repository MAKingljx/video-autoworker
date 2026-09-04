import { performance } from 'node:perf_hooks'

export const MATRIX_THRESHOLDS = Object.freeze([81_920, 98_304])
export const MATRIX_KEEP_RECENT_TOKENS = Object.freeze([8_192, 4_096, 1_024])
export const MATRIX_RECENT_TURNS_PRESERVE = Object.freeze([0, 1, 3, 4])
export const MATRIX_MID_TURN_PRECHECK = Object.freeze([false, true])
export const MATRIX_TURN_COUNTS = Object.freeze([1, 2, 3, 8, 12, 16, 20])
export const REQUIRED_TOOL_PAIRS = 19
export const REQUIRED_EFFECTIVE_TOOLS = Object.freeze([
  'aiworker_analyze_video',
  'aiworker_director_brain',
  'session_status',
])
export const GENERAL_TOOL_CAPABILITIES = Object.freeze([
  'browser',
  'edit',
  'exec',
  'read',
  'web_fetch',
  'web_search',
  'write',
])
export const BASELINE_EFFECTIVE_TOOLS = Object.freeze([
  ...GENERAL_TOOL_CAPABILITIES,
  ...REQUIRED_EFFECTIVE_TOOLS,
].toSorted())

const SYNTHETIC_SENSITIVE_VALUE = 'sk-local-mock-never-emit-1234567890'
const SYNTHETIC_SENSITIVE_REFERENCE = 'KEYCHAIN_REF_REDACTED'
const SYNTHETIC_AUTHORIZATION = 'Bearer local-mock-authorization-never-emit'
const SYNTHETIC_CONNECTION_STRING = 'postgresql://mock:never-emit@127.0.0.1/test'
const SYNTHETIC_SENSITIVE_FIELD_NAMES = Object.freeze([
  'sensitiveFields',
  'apiKey',
  'credentialReference',
  'authorization',
  'connectionString',
])
const SYNTHETIC_SENSITIVE_VALUES = Object.freeze([
  SYNTHETIC_SENSITIVE_VALUE,
  SYNTHETIC_SENSITIVE_REFERENCE,
  SYNTHETIC_AUTHORIZATION,
  SYNTHETIC_CONNECTION_STRING,
])
const SYNTHETIC_INTERNAL_IDENTIFIERS = Object.freeze({
  taskId: 'task-vaw-canary-20260904-0001',
  runId: 'run-vaw-canary-20260904-0001',
  uuid: '550e8400-e29b-41d4-a716-446655440000',
  hex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  recordId: 'recSyntheticCanary001',
  tableId: 'tblSyntheticCanary001',
  snakeCaseId: 'director_run_state_internal_001',
})
const SENSITIVE_FIELD_NAME = /sensitive|credential|secret|token|password|authorization|cookie|api.?key|private.?key|connection.?string|keychain|secret.?store/iu
const TURN_GROWTH_BYTES = 1_024
const MOCK_TECHNIQUE_LOGIC_ANSWER = '导演脑从已审核素材证据和判断案例中追溯为什么这样判断，按证据→人物与故事→判断与叙事→案例→技法沉淀，并受导演意图约束、经人工审核后复用。'
const COMPACTION_FAILURE_MESSAGE = '当前会话上下文过长，本轮未能安全恢复；未执行任何外部操作，请开启新会话后重试。'

export function estimateTokens(bytes) {
  return Math.ceil(bytes / 4)
}

export function matrixLevels(threshold) {
  return Object.freeze([
    { level: 'light', bytes: 32_768, toolPairs: 4 },
    { level: 'medium', bytes: threshold - 4_096, toolPairs: 12 },
    { level: 'below-boundary', bytes: threshold - 1, toolPairs: 19 },
    { level: 'boundary', bytes: threshold, toolPairs: 19 },
    { level: 'heavy', bytes: 131_072, toolPairs: 24 },
    { level: 'over-threshold', bytes: 214_156, toolPairs: 28 },
  ])
}

export function buildSyntheticRichTranscript({ bytes, toolPairs = REQUIRED_TOOL_PAIRS }) {
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('bytes must be a positive integer')
  if (!Number.isSafeInteger(toolPairs) || toolPairs < 1) {
    throw new Error('toolPairs must be a positive integer')
  }
  return {
    bytes,
    estimatedTokens: estimateTokens(bytes),
    toolPairs,
    facts: {
      person: '小林',
      conflict: '村民质疑水质数据与小林的专业自信发生冲突',
      change: '小林从坚持己见转为重新采样并共同验证',
    },
    internalIdentifiers: SYNTHETIC_INTERNAL_IDENTIFIERS,
    sensitiveFields: {
      apiKey: SYNTHETIC_SENSITIVE_VALUE,
      credentialReference: SYNTHETIC_SENSITIVE_REFERENCE,
      authorization: SYNTHETIC_AUTHORIZATION,
      nested: { connectionString: SYNTHETIC_CONNECTION_STRING },
    },
  }
}

function containsSyntheticMarker(value, markers) {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value)
  const text = typeof serialized === 'string' ? serialized : ''
  return markers.some(marker => text.includes(marker))
}

function containsSyntheticSensitiveMaterial(value) {
  return containsSyntheticMarker(value, SYNTHETIC_SENSITIVE_FIELD_NAMES)
    || containsSyntheticMarker(value, SYNTHETIC_SENSITIVE_VALUES)
}

function containsInternalIdentifiers(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return Object.values(SYNTHETIC_INTERNAL_IDENTIFIERS).some(identifier => text.includes(identifier))
}

function compactTranscript(state, keepRecentTokens) {
  const tokensBefore = estimateTokens(state.bytes)
  const summaryTokens = 1_536
  const tokensAfter = Math.max(
    summaryTokens,
    Math.min(Math.ceil(tokensBefore * 0.38), keepRecentTokens + summaryTokens),
  )
  return {
    ...state,
    bytes: tokensAfter * 4,
    estimatedTokens: tokensAfter,
    compactionCount: state.compactionCount + 1,
    checkpointCount: state.checkpointCount + 1,
    rotationCount: state.rotationCount + 1,
    lastCheckpoint: { tokensBefore, tokensAfter },
    summary: `人物：${state.facts.person}；冲突：${state.facts.conflict}；变化：${state.facts.change}。`,
  }
}

function answerForTurn(turn, facts) {
  if (turn === 1) return `${facts.person}面对${facts.conflict}，核心矛盾是专业自信与公开验证之间的张力。`
  if (turn === 2) return `${facts.person}由坚持原判断转为重新采样并邀请村民共同验证水质。`
  return `${facts.person}用重新采样回应村民对水质的质疑，使冲突转为可共同核验的问题。`
}

export function isConciseChineseAnswer(answer) {
  const sentenceCount = answer.split(/[。！？!?]+/u).filter(Boolean).length
  return Array.from(answer).length <= 90 && sentenceCount === 1
}

export function retainsStoryContext(answer) {
  return /小林/u.test(answer) && /村民|水质|质疑|冲突/u.test(answer)
}

export function validatesTechniqueLogicAnswer(answer) {
  return isConciseChineseAnswer(answer)
    && /已审核/u.test(answer)
    && /为什么.*判断|判断.*原因/u.test(answer)
    && /证据/u.test(answer)
    && /人物/u.test(answer)
    && /故事/u.test(answer)
    && /判断/u.test(answer)
    && /叙事/u.test(answer)
    && /案例/u.test(answer)
    && /技法/u.test(answer)
    && /导演意图/u.test(answer)
    && /人工审核/u.test(answer)
    && !/workflow|workId|record.?id|checkpoint|compaction|API|JSON|内部ID/iu.test(answer)
    && !containsSyntheticSensitiveMaterial(answer)
    && !containsInternalIdentifiers(answer)
}

export function runMockTechniqueLogicDialogue() {
  const first = MOCK_TECHNIQUE_LOGIC_ANSWER
  const afterCompaction = MOCK_TECHNIQUE_LOGIC_ANSWER
  const canonicalCall = {
    name: 'aiworker_director_brain',
    arguments: { action: 'explain', topic: 'technique_learning' },
  }
  return {
    prompt: '导演脑提炼技法的底层逻辑是什么？',
    source: 'canonical-director-brain',
    first: {
      phase: 'first-over-threshold-turn',
      compactionDelta: 1,
      toolCalls: [canonicalCall],
      fallbackToolCalls: [],
      answer: first,
      valid: validatesTechniqueLogicAnswer(first),
    },
    afterCompaction: {
      phase: 'post-compaction-continuation',
      compactionDelta: 0,
      toolCalls: [canonicalCall],
      fallbackToolCalls: [],
      answer: afterCompaction,
      valid: validatesTechniqueLogicAnswer(afterCompaction),
    },
  }
}

export function runMockCase({
  initialBytes,
  keepRecentTokens,
  threshold,
  turns,
  recentTurnsPreserve = 0,
  midTurnPrecheckEnabled = false,
  toolPairs = REQUIRED_TOOL_PAIRS,
}) {
  if (!MATRIX_RECENT_TURNS_PRESERVE.includes(recentTurnsPreserve)) {
    throw new Error('unsupported recentTurnsPreserve')
  }
  if (!MATRIX_MID_TURN_PRECHECK.includes(midTurnPrecheckEnabled)) {
    throw new Error('unsupported midTurnPrecheckEnabled')
  }
  if (!MATRIX_KEEP_RECENT_TOKENS.includes(keepRecentTokens)) {
    throw new Error('unsupported keepRecentTokens')
  }
  if (!MATRIX_THRESHOLDS.includes(threshold)) throw new Error('unsupported threshold')
  if (!MATRIX_TURN_COUNTS.includes(turns)) throw new Error('unsupported turn count')

  const startedAt = performance.now()
  const source = buildSyntheticRichTranscript({ bytes: initialBytes, toolPairs })
  let state = {
    ...source,
    compactionCount: 0,
    checkpointCount: 0,
    rotationCount: 0,
    mainModelCalls: 0,
    summary: '',
  }
  const turnResults = []
  for (let turn = 1; turn <= turns; turn += 1) {
    const turnStartedAt = performance.now()
    const before = state
    const shouldCompact = before.bytes >= threshold
    if (shouldCompact) state = compactTranscript(state, keepRecentTokens)
    const compactionDelta = state.compactionCount - before.compactionCount
    const answer = answerForTurn(turn, state.facts)
    state = {
      ...state,
      bytes: state.bytes + TURN_GROWTH_BYTES,
      estimatedTokens: estimateTokens(state.bytes + TURN_GROWTH_BYTES),
      mainModelCalls: state.mainModelCalls + 1,
    }
    turnResults.push({
      turn,
      shouldCompact,
      compactionDelta,
      repeatedCompaction: compactionDelta > 1,
      transcriptBytesBefore: before.bytes,
      transcriptBytesAfter: state.bytes,
      estimatedTokensBefore: estimateTokens(before.bytes),
      estimatedTokensAfter: state.estimatedTokens,
      checkpointTokens: compactionDelta === 1 ? state.lastCheckpoint : null,
      answer,
      answerConcise: isConciseChineseAnswer(answer),
      answerRetainsStoryContext: retainsStoryContext(answer),
      sensitiveFieldNameLeaked: containsSyntheticMarker(answer, SYNTHETIC_SENSITIVE_FIELD_NAMES)
        || containsSyntheticMarker(state.summary, SYNTHETIC_SENSITIVE_FIELD_NAMES),
      sensitiveValueLeaked: containsSyntheticMarker(answer, SYNTHETIC_SENSITIVE_VALUES)
        || containsSyntheticMarker(state.summary, SYNTHETIC_SENSITIVE_VALUES),
      answerInternalIdentifierLeaked: containsInternalIdentifiers(answer),
      checkpointInternalIdentifierLeaked: containsInternalIdentifiers(state.summary),
      internalIdentifiersOmitted: state.compactionCount === 0
        || (!containsInternalIdentifiers(state.summary) && !containsInternalIdentifiers(answer)),
      harnessElapsedMs: Number((performance.now() - turnStartedAt).toFixed(3)),
    })
  }
  const effectiveTools = [...BASELINE_EFFECTIVE_TOOLS]
  return {
    input: {
      initialBytes,
      estimatedTokens: source.estimatedTokens,
      toolPairs,
      turns,
      threshold,
      keepRecentTokens,
      recentTurnsPreserve,
      midTurnPrecheckEnabled,
    },
    turns: turnResults,
    outcome: {
      compactionCount: state.compactionCount,
      checkpointCount: state.checkpointCount,
      rotationCount: state.rotationCount,
      mainModelCalls: state.mainModelCalls,
      finalBytes: state.bytes,
      finalEstimatedTokens: state.estimatedTokens,
      noRepeatedCompaction: turnResults.every(result => !result.repeatedCompaction),
      storyContextRetained: turnResults.every(result => result.answerRetainsStoryContext),
      conciseChineseAnswers: turnResults.every(result => result.answerConcise),
      sensitiveFieldNameLeaked: turnResults.some(result => result.sensitiveFieldNameLeaked),
      sensitiveValueLeaked: turnResults.some(result => result.sensitiveValueLeaked),
      answerInternalIdentifierLeaked: turnResults
        .some(result => result.answerInternalIdentifierLeaked),
      checkpointInternalIdentifierLeaked: turnResults
        .some(result => result.checkpointInternalIdentifierLeaked),
      internalIdentifiersOmitted: turnResults.every(result => result.internalIdentifiersOmitted),
      effectiveTools,
      requiredEffectiveToolsPresent: REQUIRED_EFFECTIVE_TOOLS
        .every(tool => effectiveTools.includes(tool)),
      generalToolCapabilitiesPreserved: GENERAL_TOOL_CAPABILITIES
        .every(tool => effectiveTools.includes(tool)),
      toolCapabilitiesReduced: false,
      semanticContinuityGuaranteedByMock: false,
    },
    harnessElapsedMs: Number((performance.now() - startedAt).toFixed(3)),
  }
}

export function runMockToolResultInflation({
  initialBytes = 32_768,
  keepRecentTokens = 8_192,
  threshold = 98_304,
  toolPairs = 20,
  minimumResultBytes = 4_096,
} = {}) {
  if (!Number.isSafeInteger(toolPairs) || toolPairs < 1) throw new Error('invalid tool pair count')
  if (!Number.isSafeInteger(minimumResultBytes) || minimumResultBytes < 1) {
    throw new Error('invalid tool result size')
  }
  let state = {
    ...buildSyntheticRichTranscript({ bytes: initialBytes, toolPairs }),
    compactionCount: 0,
    checkpointCount: 0,
    rotationCount: 0,
    mainModelCalls: 0,
    summary: '',
  }
  const results = []
  let firstCrossingPair = null
  for (let pair = 1; pair <= toolPairs; pair += 1) {
    const payload = {
      facts: state.facts,
      internalIdentifiers: state.internalIdentifiers,
      sensitiveFields: state.sensitiveFields,
      observations: 'x'.repeat(minimumResultBytes),
    }
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
    const beforeBytes = state.bytes
    state = { ...state, bytes: state.bytes + payloadBytes }
    if (firstCrossingPair === null && state.bytes >= threshold) firstCrossingPair = pair
    results.push({ pair, beforeBytes, payloadBytes, afterBytes: state.bytes })
  }
  const bytesBeforePrecheck = state.bytes
  const shouldCompact = bytesBeforePrecheck >= threshold
  if (shouldCompact) state = compactTranscript(state, keepRecentTokens)
  const answer = answerForTurn(1, state.facts)
  state = {
    ...state,
    bytes: state.bytes + TURN_GROWTH_BYTES,
    mainModelCalls: state.mainModelCalls + 1,
  }
  return {
    input: { initialBytes, keepRecentTokens, threshold, toolPairs, minimumResultBytes },
    results,
    firstCrossingPair,
    bytesBeforePrecheck,
    shouldCompact,
    outcome: {
      compactionCount: state.compactionCount,
      checkpointCount: state.checkpointCount,
      rotationCount: state.rotationCount,
      mainModelCalls: state.mainModelCalls,
      finalBytes: state.bytes,
      answer,
      answerConcise: isConciseChineseAnswer(answer),
      answerRetainsStoryContext: retainsStoryContext(answer),
      sensitiveFieldNameLeaked: containsSyntheticMarker(state.summary, SYNTHETIC_SENSITIVE_FIELD_NAMES)
        || containsSyntheticMarker(answer, SYNTHETIC_SENSITIVE_FIELD_NAMES),
      sensitiveValueLeaked: containsSyntheticMarker(state.summary, SYNTHETIC_SENSITIVE_VALUES)
        || containsSyntheticMarker(answer, SYNTHETIC_SENSITIVE_VALUES),
      internalIdentifierLeaked: containsInternalIdentifiers(state.summary)
        || containsInternalIdentifiers(answer),
    },
  }
}

export function runMockScreenshotStressMatrix() {
  const cases = []
  for (const turns of [1, 2, 8]) {
    for (const threshold of MATRIX_THRESHOLDS) {
      for (const keepRecentTokens of MATRIX_KEEP_RECENT_TOKENS) {
        for (const toolPairs of [19, 28]) {
          for (const minimumResultBytes of [16_384, 65_536]) {
            const inflation = runMockToolResultInflation({
              initialBytes: 32_768,
              keepRecentTokens,
              threshold,
              toolPairs,
              minimumResultBytes,
            })
            const dialogue = runMockCase({
              initialBytes: inflation.bytesBeforePrecheck,
              keepRecentTokens,
              threshold,
              turns,
              toolPairs,
            })
            const expectedCompactionDeltas = [1, ...Array.from({ length: turns - 1 }, () => 0)]
            cases.push({
              input: { turns, threshold, keepRecentTokens, toolPairs, minimumResultBytes },
              payloadBytes: inflation.results.reduce((total, result) => total + result.payloadBytes, 0),
              firstCrossingPair: inflation.firstCrossingPair,
              compactionDeltas: dialogue.turns.map(turn => turn.compactionDelta),
              ok: inflation.shouldCompact
                && inflation.outcome.compactionCount === 1
                && inflation.outcome.checkpointCount === 1
                && inflation.outcome.rotationCount === 1
                && dialogue.outcome.compactionCount === 1
                && dialogue.outcome.checkpointCount === 1
                && dialogue.outcome.rotationCount === 1
                && JSON.stringify(dialogue.turns.map(turn => turn.compactionDelta))
                  === JSON.stringify(expectedCompactionDeltas)
                && dialogue.outcome.conciseChineseAnswers
                && dialogue.outcome.storyContextRetained
                && !dialogue.outcome.sensitiveFieldNameLeaked
                && !dialogue.outcome.sensitiveValueLeaked
                && dialogue.outcome.internalIdentifiersOmitted,
            })
          }
        }
      }
    }
  }
  return cases
}

export function runMockCompactionFailureDegradation() {
  const recovery = runMockFailureRecovery()
  return {
    status: 'failed-closed',
    reason: recovery.failed.reason,
    repeatedAttempts: recovery.failed.repeatedAttempts,
    transcriptUnchanged: recovery.failed.transcriptBytesAfter
      === recovery.failed.transcriptBytesBefore,
    checkpointWrites: recovery.failed.checkpointCount,
    rotations: recovery.failed.rotationCount,
    mainModelCalls: recovery.failed.mainModelCalls,
    taskDispatches: recovery.failed.failedAttempts
      .reduce((total, attempt) => total + attempt.taskDispatches, 0),
    deliveryEvents: recovery.failed.failedAttempts
      .reduce((total, attempt) => total + attempt.deliveryEvents, 0),
    userVisibleFailureWrites: 1,
    message: COMPACTION_FAILURE_MESSAGE,
    messageConcise: isConciseChineseAnswer(COMPACTION_FAILURE_MESSAGE),
    sensitiveMaterialLeaked: containsSyntheticSensitiveMaterial(COMPACTION_FAILURE_MESSAGE),
    internalIdentifierLeaked: containsInternalIdentifiers(COMPACTION_FAILURE_MESSAGE),
  }
}

export function runMockMainModelFailureRecovery({
  initialBytes = 214_156,
  keepRecentTokens = 8_192,
  threshold = 98_304,
} = {}) {
  let state = {
    ...buildSyntheticRichTranscript({ bytes: initialBytes }),
    compactionCount: 0,
    checkpointCount: 0,
    rotationCount: 0,
    mainModelCalls: 0,
    summary: '',
  }
  if (state.bytes >= threshold) state = compactTranscript(state, keepRecentTokens)
  const beforeFailure = { ...state }
  state = { ...state, mainModelCalls: 1 }
  const failed = {
    status: 'failed',
    reason: 'main-model-timeout',
    compactionCount: state.compactionCount,
    checkpointCount: state.checkpointCount,
    rotationCount: state.rotationCount,
    mainModelCalls: state.mainModelCalls,
    answerWrites: 0,
    taskDispatches: 0,
    deliveryEvents: 0,
  }
  const retryAnswer = answerForTurn(1, state.facts)
  state = {
    ...state,
    bytes: state.bytes + TURN_GROWTH_BYTES,
    mainModelCalls: state.mainModelCalls + 1,
  }
  const recovered = {
    status: 'ok',
    compactionDelta: state.compactionCount - beforeFailure.compactionCount,
    checkpointDelta: state.checkpointCount - beforeFailure.checkpointCount,
    rotationDelta: state.rotationCount - beforeFailure.rotationCount,
    mainModelCalls: state.mainModelCalls,
    answerWrites: 1,
    taskDispatches: 0,
    deliveryEvents: 0,
    answer: retryAnswer,
    answerConcise: isConciseChineseAnswer(retryAnswer),
    answerRetainsStoryContext: retainsStoryContext(retryAnswer),
    sensitiveMaterialLeaked: containsSyntheticSensitiveMaterial(retryAnswer)
      || containsSyntheticSensitiveMaterial(state.summary),
    internalIdentifierLeaked: containsInternalIdentifiers(retryAnswer)
      || containsInternalIdentifiers(state.summary),
  }
  return { failed, recovered, threshold, keepRecentTokens }
}

export function runMockMatrix() {
  const cases = []
  for (const threshold of MATRIX_THRESHOLDS) {
    for (const keepRecentTokens of MATRIX_KEEP_RECENT_TOKENS) {
      for (const recentTurnsPreserve of MATRIX_RECENT_TURNS_PRESERVE) {
        for (const midTurnPrecheckEnabled of MATRIX_MID_TURN_PRECHECK) {
          for (const { level, bytes, toolPairs } of matrixLevels(threshold)) {
            for (const turns of MATRIX_TURN_COUNTS) {
              cases.push({
                level,
                ...runMockCase({
                  initialBytes: bytes,
                  keepRecentTokens,
                  threshold,
                  turns,
                  recentTurnsPreserve,
                  midTurnPrecheckEnabled,
                  toolPairs,
                }),
              })
            }
          }
        }
      }
    }
  }
  return cases
}

export function runMockFailureRecovery({
  initialBytes = 214_156,
  keepRecentTokens = 8_192,
  threshold = 98_304,
} = {}) {
  const source = buildSyntheticRichTranscript({ bytes: initialBytes })
  let state = {
    ...source,
    compactionCount: 0,
    checkpointCount: 0,
    rotationCount: 0,
    mainModelCalls: 0,
    summary: '',
  }
  const failedAttempts = [1, 2, 3].map(attempt => ({
    attempt,
    attemptId: 'compaction-attempt-stable-0001',
    status: 'failed',
    reason: 'compaction-timeout',
    stateVersion: 0,
    checkpointWrites: state.checkpointCount,
    rotations: state.rotationCount,
    mainModelCalls: state.mainModelCalls,
    taskDispatches: 0,
    deliveryEvents: 0,
  }))
  const failed = {
    status: 'failed',
    reason: 'compaction-timeout',
    transcriptBytesBefore: state.bytes,
    transcriptBytesAfter: state.bytes,
    compactionCount: state.compactionCount,
    checkpointCount: state.checkpointCount,
    rotationCount: state.rotationCount,
    mainModelCalls: state.mainModelCalls,
    partialRotation: false,
    repeatedAttempts: failedAttempts.length,
    repeatedSideEffects: false,
    failedAttempts,
  }

  state = compactTranscript(state, keepRecentTokens)
  const recoveredAnswer = answerForTurn(1, state.facts)
  state = {
    ...state,
    bytes: state.bytes + TURN_GROWTH_BYTES,
    estimatedTokens: estimateTokens(state.bytes + TURN_GROWTH_BYTES),
    mainModelCalls: 1,
  }
  const recovered = {
    status: 'ok',
    providerReloadedForNextTurn: true,
    transcriptBytesAfter: state.bytes,
    compactionCount: state.compactionCount,
    checkpointCount: state.checkpointCount,
    rotationCount: state.rotationCount,
    mainModelCalls: state.mainModelCalls,
    answer: recoveredAnswer,
    answerRetainsStoryContext: retainsStoryContext(recoveredAnswer),
  }

  const countBeforeContinuation = state.compactionCount
  const continuedAnswer = answerForTurn(2, state.facts)
  state = {
    ...state,
    bytes: state.bytes + TURN_GROWTH_BYTES,
    estimatedTokens: estimateTokens(state.bytes + TURN_GROWTH_BYTES),
    mainModelCalls: 2,
  }
  const continuation = {
    status: 'ok',
    compactionDelta: state.compactionCount - countBeforeContinuation,
    compactionCount: state.compactionCount,
    checkpointCount: state.checkpointCount,
    rotationCount: state.rotationCount,
    mainModelCalls: state.mainModelCalls,
    transcriptBytesAfter: state.bytes,
    answer: continuedAnswer,
    answerRetainsStoryContext: retainsStoryContext(continuedAnswer),
  }
  return { failed, recovered, continuation, threshold, keepRecentTokens }
}

export function runMockDuplicateCompactionAttempt() {
  let state = {
    ...buildSyntheticRichTranscript({ bytes: 214_156 }),
    compactionCount: 0,
    checkpointCount: 0,
    rotationCount: 0,
    mainModelCalls: 0,
    summary: '',
  }
  const completedAttemptIds = new Set()
  const apply = attemptId => {
    const before = {
      compactionCount: state.compactionCount,
      checkpointCount: state.checkpointCount,
      rotationCount: state.rotationCount,
    }
    if (!completedAttemptIds.has(attemptId)) {
      state = compactTranscript(state, 8_192)
      completedAttemptIds.add(attemptId)
    }
    return {
      duplicate: before.compactionCount === state.compactionCount,
      compactionDelta: state.compactionCount - before.compactionCount,
      checkpointDelta: state.checkpointCount - before.checkpointCount,
      rotationDelta: state.rotationCount - before.rotationCount,
    }
  }
  const first = apply('compaction-attempt-stable-0001')
  const duplicate = apply('compaction-attempt-stable-0001')
  return { first, duplicate, state }
}

function sanitizeMigrationSeed(value) {
  if (Array.isArray(value)) {
    return value.map(sanitizeMigrationSeed).filter(item => item !== undefined)
  }
  if (!value || typeof value !== 'object') {
    return containsSyntheticSensitiveMaterial(value) ? undefined : value
  }
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => {
    if (SENSITIVE_FIELD_NAME.test(key) || hasSensitiveDescendantField(item)) return []
    const sanitized = sanitizeMigrationSeed(item)
    return sanitized === undefined ? [] : [[key, sanitized]]
  }))
}

function hasSensitiveDescendantField(value) {
  if (Array.isArray(value)) return value.some(hasSensitiveDescendantField)
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, item]) => (
    SENSITIVE_FIELD_NAME.test(key) || hasSensitiveDescendantField(item)
  ))
}

export function runMockPollutedSessionMigration() {
  const oldSession = {
    sessionKey: 'agent:second-original:legacy-polluted',
    lifecycle: 'sealed',
    acceptsWrites: false,
    revision: 41,
    compactionCount: 0,
    checkpointCount: 0,
    rotationCount: 0,
    transcript: buildSyntheticRichTranscript({ bytes: 214_156 }),
  }
  const oldBefore = JSON.stringify(oldSession)
  const sanitizedSeed = sanitizeMigrationSeed({
    facts: oldSession.transcript.facts,
    sensitiveFields: oldSession.transcript.sensitiveFields,
  })
  const newSession = {
    sessionKey: 'agent:second-original:fresh-after-pollution',
    lifecycle: 'active',
    acceptsWrites: true,
    revision: 0,
    compactionCount: 0,
    checkpointCount: 0,
    rotationCount: 0,
    seed: sanitizedSeed,
  }
  return {
    oldSessionUnchanged: JSON.stringify(oldSession) === oldBefore,
    oldSessionSealed: oldSession.lifecycle === 'sealed' && oldSession.acceptsWrites === false,
    distinctSessionIdentity: newSession.sessionKey !== oldSession.sessionKey,
    oldSessionCompacted: oldSession.compactionCount > 0,
    oldSessionRotated: oldSession.rotationCount > 0,
    oldSessionCheckpointWrites: oldSession.checkpointCount,
    newSessionStartsFresh: newSession.revision === 0
      && newSession.compactionCount === 0
      && newSession.checkpointCount === 0,
    newSessionActive: newSession.lifecycle === 'active' && newSession.acceptsWrites === true,
    sensitiveMaterialMigrated: containsSyntheticSensitiveMaterial(newSession.seed),
    internalIdentifiersOmitted: !containsInternalIdentifiers(newSession.seed),
    storyContextPreserved: retainsStoryContext(JSON.stringify(newSession.seed)),
    taskDispatches: 0,
    deliveryEvents: 0,
  }
}
