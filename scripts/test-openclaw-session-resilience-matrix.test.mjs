import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  BASELINE_EFFECTIVE_TOOLS,
  MATRIX_KEEP_RECENT_TOKENS,
  MATRIX_MID_TURN_PRECHECK,
  MATRIX_RECENT_TURNS_PRESERVE,
  MATRIX_THRESHOLDS,
  MATRIX_TURN_COUNTS,
  estimateTokens,
  matrixLevels,
  runMockCompactionFailureDegradation,
  runMockCase,
  runMockDuplicateCompactionAttempt,
  runMockFailureRecovery,
  runMockMainModelFailureRecovery,
  runMockMatrix,
  runMockPollutedSessionMigration,
  runMockScreenshotStressMatrix,
  runMockTechniqueLogicDialogue,
  runMockToolResultInflation,
  validatesTechniqueLogicAnswer,
} from './lib/openclaw-session-resilience-test-matrix.mjs'
import {
  GENERAL_COMPACTION_ANCHORS,
  GENERAL_COMPACTION_OMNIBUS_PROMPT,
} from './lib/openclaw-general-compaction-anchors.mjs'

const richCanaryPath = fileURLToPath(
  new URL('./test-openclaw-session-resilience-rich-canary.mjs', import.meta.url),
)
const matrixCliPath = fileURLToPath(
  new URL('./test-openclaw-session-resilience-matrix.mjs', import.meta.url),
)
const runtimeManifestPath = fileURLToPath(
  new URL('../ops/openclaw/qwen-current-runtime-convergence.manifest.json', import.meta.url),
)
const convergenceHelperPath = fileURLToPath(
  new URL('./lib/openclaw-runtime-convergence.mjs', import.meta.url),
)

test('covers every threshold, retention, load level, and 1/2/3/8/12/16/20-turn combination', () => {
  const matrix = runMockMatrix()
  assert.equal(matrix.length, 2 * 3 * 4 * 2 * 6 * 7)
  assert.deepEqual([...new Set(matrix.map(entry => entry.input.threshold))], MATRIX_THRESHOLDS)
  assert.deepEqual(
    [...new Set(matrix.map(entry => entry.input.keepRecentTokens))],
    MATRIX_KEEP_RECENT_TOKENS,
  )
  assert.deepEqual([...new Set(matrix.map(entry => entry.input.turns))], MATRIX_TURN_COUNTS)
  assert.deepEqual(
    [...new Set(matrix.map(entry => entry.input.recentTurnsPreserve))],
    MATRIX_RECENT_TURNS_PRESERVE,
  )
  assert.deepEqual(
    [...new Set(matrix.map(entry => entry.input.midTurnPrecheckEnabled))],
    MATRIX_MID_TURN_PRECHECK,
  )
  assert.deepEqual(
    [...new Set(matrix.map(entry => entry.level))],
    ['light', 'medium', 'below-boundary', 'boundary', 'heavy', 'over-threshold'],
  )
  const cli = spawnSync(process.execPath, [matrixCliPath], {
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.equal(cli.status, 0, cli.stderr)
  const output = JSON.parse(cli.stdout)
  assert.equal(output.ok, true)
  assert.equal(output.summary.caseCount, 2_016)
  assert.deepEqual(output.summary.recentTurnsPreserve, MATRIX_RECENT_TURNS_PRESERVE)
  assert.deepEqual(output.summary.midTurnPrecheckEnabled, MATRIX_MID_TURN_PRECHECK)
  assert.equal(output.summary.screenshotStressCaseCount, 72)
  assert.deepEqual(output.summary.contracts, {
    repeatedFailureZeroSideEffects: true,
    duplicateCompactionAttemptDeduplicated: true,
    pollutedSessionSealedAndMigratedFresh: true,
    toolResultsCrossThresholdOnce: true,
    mainModelRetryReusesCompaction: true,
    techniqueLogicFirstAndContinuation: true,
    screenshotStressMatrix: true,
    compactionFailureDegradesSafely: true,
  })
})

test('uses 19+ tool pairs near the boundary and covers preserved-turn values 0/1/3/4', () => {
  const matrix = runMockMatrix()
  assert.ok(matrix
    .filter(entry => ['below-boundary', 'boundary', 'heavy', 'over-threshold'].includes(entry.level))
    .every(entry => entry.input.toolPairs >= 19))
  assert.deepEqual(
    [...new Set(matrix.map(entry => entry.input.recentTurnsPreserve))],
    [0, 1, 3, 4],
  )
  assert.throws(() => runMockCase({
    initialBytes: 131_072,
    keepRecentTokens: 8_192,
    threshold: 98_304,
    turns: 1,
    recentTurnsPreserve: 2,
  }), /unsupported recentTurnsPreserve/u)
})

test('does not compact light/medium first turns and compacts boundary/heavier first turns', () => {
  for (const threshold of MATRIX_THRESHOLDS) {
    for (const level of matrixLevels(threshold)) {
      const result = runMockCase({
        initialBytes: level.bytes,
        keepRecentTokens: 8_192,
        threshold,
        turns: 1,
      })
      assert.equal(
        result.turns[0].compactionDelta,
        ['boundary', 'heavy', 'over-threshold'].includes(level.level) ? 1 : 0,
      )
    }
  }
})

test('treats threshold minus one as below boundary and the exact threshold as inclusive', () => {
  for (const threshold of MATRIX_THRESHOLDS) {
    const below = runMockCase({
      initialBytes: threshold - 1,
      keepRecentTokens: 8_192,
      threshold,
      turns: 1,
    })
    const boundary = runMockCase({
      initialBytes: threshold,
      keepRecentTokens: 8_192,
      threshold,
      turns: 1,
    })
    assert.equal(below.turns[0].compactionDelta, 0)
    assert.equal(boundary.turns[0].compactionDelta, 1)
  }
})

test('compacts exactly once on the first turn after crossing the threshold', () => {
  for (const threshold of MATRIX_THRESHOLDS) {
    const result = runMockCase({
      initialBytes: threshold - 1,
      keepRecentTokens: 8_192,
      threshold,
      turns: 20,
    })
    assert.deepEqual(result.turns.slice(0, 3).map(turn => turn.compactionDelta), [0, 1, 0])
    assert.equal(result.outcome.compactionCount, 1)
    assert.equal(result.outcome.checkpointCount, 1)
    assert.equal(result.outcome.rotationCount, 1)
  }
})

test('keeps deterministic fixture answers concise without treating the mock as semantic proof', () => {
  const matrix = runMockMatrix()
  assert.ok(matrix.every(entry => entry.outcome.conciseChineseAnswers))
  assert.ok(matrix.every(entry => entry.outcome.storyContextRetained))
  assert.ok(matrix.every(entry => entry.outcome.semanticContinuityGuaranteedByMock === false))
  assert.ok(matrix.flatMap(entry => entry.turns).every(turn => /小林/u.test(turn.answer)))
})

test('models the screenshot question as a canonical explain reread, not summary recall', () => {
  const result = runMockTechniqueLogicDialogue()
  assert.equal(result.prompt, '导演脑提炼技法的底层逻辑是什么？')
  assert.equal(result.source, 'canonical-director-brain')
  assert.equal(result.first.compactionDelta, 1)
  assert.equal(result.afterCompaction.compactionDelta, 0)
  assert.deepEqual(result.first.toolCalls, [{
    name: 'aiworker_director_brain',
    arguments: { action: 'explain', topic: 'technique_learning' },
  }])
  assert.deepEqual(result.afterCompaction.toolCalls, result.first.toolCalls)
  assert.deepEqual(result.first.fallbackToolCalls, [])
  assert.deepEqual(result.afterCompaction.fallbackToolCalls, [])
  assert.equal(result.first.valid, true)
  assert.equal(result.afterCompaction.valid, true)
  assert.equal(validatesTechniqueLogicAnswer(result.first.answer), true)
  assert.equal(validatesTechniqueLogicAnswer(result.afterCompaction.answer), true)
})

test('does not enter a second compaction loop after a successful reduction', () => {
  const result = runMockCase({
    initialBytes: 214_156,
    keepRecentTokens: 8_192,
    threshold: 98_304,
    turns: 3,
  })
  assert.deepEqual(result.turns.map(turn => turn.compactionDelta), [1, 0, 0])
  assert.equal(result.outcome.compactionCount, 1)
  assert.equal(result.outcome.checkpointCount, 1)
  assert.equal(result.outcome.rotationCount, 1)
  assert.equal(result.outcome.noRepeatedCompaction, true)
  assert.ok(runMockMatrix().every(entry => (
    entry.outcome.noRepeatedCompaction && entry.outcome.compactionCount <= 1
  )))
})

test('compares 8192/4096/1024 retention and 98304/81920 thresholds without changing targets', () => {
  const retained = MATRIX_KEEP_RECENT_TOKENS.map(keepRecentTokens => runMockCase({
    initialBytes: 214_156,
    keepRecentTokens,
    threshold: 98_304,
    turns: 2,
  }))
  assert.ok(retained[0].turns[0].checkpointTokens.tokensAfter
    >= retained[1].turns[0].checkpointTokens.tokensAfter)
  assert.ok(retained[1].turns[0].checkpointTokens.tokensAfter
    >= retained[2].turns[0].checkpointTokens.tokensAfter)

  const at90KiB = MATRIX_THRESHOLDS.map(threshold => runMockCase({
    initialBytes: 90 * 1_024,
    keepRecentTokens: 8_192,
    threshold,
    turns: 2,
  }))
  assert.equal(at90KiB[0].turns[0].compactionDelta, 1)
  assert.equal(at90KiB[1].turns[0].compactionDelta, 0)
})

test('preserves the full tool baseline and separately rejects sensitive context material', () => {
  const result = runMockCase({
    initialBytes: 214_156,
    keepRecentTokens: 8_192,
    threshold: 98_304,
    turns: 20,
  })
  assert.deepEqual(result.outcome.effectiveTools, BASELINE_EFFECTIVE_TOOLS)
  assert.equal(result.outcome.requiredEffectiveToolsPresent, true)
  assert.equal(result.outcome.generalToolCapabilitiesPreserved, true)
  assert.equal(result.outcome.toolCapabilitiesReduced, false)
  assert.equal(result.outcome.sensitiveFieldNameLeaked, false)
  assert.equal(result.outcome.sensitiveValueLeaked, false)
  assert.equal(result.outcome.internalIdentifiersOmitted, true)
  assert.equal(result.outcome.answerInternalIdentifierLeaked, false)
  assert.equal(result.outcome.checkpointInternalIdentifierLeaked, false)
})

test('crosses the threshold through actual tool-result byte growth and compacts once', () => {
  const result = runMockToolResultInflation()
  assert.equal(result.input.toolPairs, 20)
  assert.equal(result.results.length, 20)
  assert.ok(result.results.every(entry => entry.payloadBytes >= 4_096))
  assert.ok(result.firstCrossingPair > 1)
  assert.equal(result.shouldCompact, true)
  assert.equal(result.outcome.compactionCount, 1)
  assert.equal(result.outcome.checkpointCount, 1)
  assert.equal(result.outcome.rotationCount, 1)
  assert.equal(result.outcome.mainModelCalls, 1)
  assert.equal(result.outcome.answerConcise, true)
  assert.equal(result.outcome.answerRetainsStoryContext, true)
  assert.equal(result.outcome.sensitiveFieldNameLeaked, false)
  assert.equal(result.outcome.sensitiveValueLeaked, false)
  assert.equal(result.outcome.internalIdentifierLeaked, false)
})

test('stress replays 1/2/8 turns after 19/28 tool results of 16/64 KiB without leakage or a second compaction', () => {
  const cases = runMockScreenshotStressMatrix()
  assert.equal(cases.length, 72)
  assert.deepEqual([...new Set(cases.map(entry => entry.input.turns))], [1, 2, 8])
  assert.deepEqual([...new Set(cases.map(entry => entry.input.toolPairs))], [19, 28])
  assert.deepEqual(
    [...new Set(cases.map(entry => entry.input.minimumResultBytes))],
    [16_384, 65_536],
  )
  assert.ok(cases.every(entry => entry.payloadBytes >= entry.input.toolPairs
    * entry.input.minimumResultBytes))
  assert.ok(cases.every(entry => entry.firstCrossingPair !== null))
  assert.ok(cases.every(entry => entry.compactionDeltas[0] === 1))
  assert.ok(cases.filter(entry => entry.input.turns >= 2)
    .every(entry => entry.compactionDeltas[1] === 0))
  assert.ok(cases.every(entry => entry.compactionDeltas.slice(1).every(delta => delta === 0)))
  assert.ok(cases.every(entry => entry.ok))
})

test('degrades a repeated compaction timeout to one concise fail-closed response', () => {
  const result = runMockCompactionFailureDegradation()
  assert.deepEqual(result, {
    status: 'failed-closed',
    reason: 'compaction-timeout',
    repeatedAttempts: 3,
    transcriptUnchanged: true,
    checkpointWrites: 0,
    rotations: 0,
    mainModelCalls: 0,
    taskDispatches: 0,
    deliveryEvents: 0,
    userVisibleFailureWrites: 1,
    message: '当前会话上下文过长，本轮未能安全恢复；未执行任何外部操作，请开启新会话后重试。',
    messageConcise: true,
    sensitiveMaterialLeaked: false,
    internalIdentifierLeaked: false,
  })
})

test('recovers after compaction timeout without partial checkpoint, rotation, or second loop', () => {
  const result = runMockFailureRecovery()
  assert.deepEqual(result.failed, {
    status: 'failed',
    reason: 'compaction-timeout',
    transcriptBytesBefore: 214_156,
    transcriptBytesAfter: 214_156,
    compactionCount: 0,
    checkpointCount: 0,
    rotationCount: 0,
    mainModelCalls: 0,
    partialRotation: false,
    repeatedAttempts: 3,
    repeatedSideEffects: false,
    failedAttempts: [1, 2, 3].map(attempt => ({
      attempt,
      attemptId: 'compaction-attempt-stable-0001',
      status: 'failed',
      reason: 'compaction-timeout',
      stateVersion: 0,
      checkpointWrites: 0,
      rotations: 0,
      mainModelCalls: 0,
      taskDispatches: 0,
      deliveryEvents: 0,
    })),
  })
  assert.equal(result.recovered.status, 'ok')
  assert.equal(result.recovered.providerReloadedForNextTurn, true)
  assert.equal(result.recovered.compactionCount, 1)
  assert.equal(result.recovered.checkpointCount, 1)
  assert.equal(result.recovered.rotationCount, 1)
  assert.equal(result.recovered.mainModelCalls, 1)
  assert.ok(result.recovered.transcriptBytesAfter < result.threshold)
  assert.equal(result.continuation.compactionDelta, 0)
  assert.equal(result.continuation.answerRetainsStoryContext, true)
  assert.equal(result.continuation.mainModelCalls, 2)
  assert.equal(estimateTokens(result.failed.transcriptBytesAfter), 53_539)
})

test('retries a failed main-model call without repeating compaction or external side effects', () => {
  const result = runMockMainModelFailureRecovery()
  assert.deepEqual(result.failed, {
    status: 'failed',
    reason: 'main-model-timeout',
    compactionCount: 1,
    checkpointCount: 1,
    rotationCount: 1,
    mainModelCalls: 1,
    answerWrites: 0,
    taskDispatches: 0,
    deliveryEvents: 0,
  })
  assert.equal(result.recovered.status, 'ok')
  assert.equal(result.recovered.compactionDelta, 0)
  assert.equal(result.recovered.checkpointDelta, 0)
  assert.equal(result.recovered.rotationDelta, 0)
  assert.equal(result.recovered.mainModelCalls, 2)
  assert.equal(result.recovered.answerWrites, 1)
  assert.equal(result.recovered.taskDispatches, 0)
  assert.equal(result.recovered.deliveryEvents, 0)
  assert.equal(result.recovered.answerConcise, true)
  assert.equal(result.recovered.answerRetainsStoryContext, true)
  assert.equal(result.recovered.sensitiveMaterialLeaked, false)
  assert.equal(result.recovered.internalIdentifierLeaked, false)
})

test('deduplicates a replayed compaction attempt without another checkpoint or rotation', () => {
  const result = runMockDuplicateCompactionAttempt()
  assert.deepEqual(result.first, {
    duplicate: false,
    compactionDelta: 1,
    checkpointDelta: 1,
    rotationDelta: 1,
  })
  assert.deepEqual(result.duplicate, {
    duplicate: true,
    compactionDelta: 0,
    checkpointDelta: 0,
    rotationDelta: 0,
  })
  assert.equal(result.state.compactionCount, 1)
  assert.equal(result.state.checkpointCount, 1)
  assert.equal(result.state.rotationCount, 1)
})

test('migrates a polluted session by sealing the old identity and seeding a distinct clean session', () => {
  const result = runMockPollutedSessionMigration()
  assert.deepEqual(result, {
    oldSessionUnchanged: true,
    oldSessionSealed: true,
    distinctSessionIdentity: true,
    oldSessionCompacted: false,
    oldSessionRotated: false,
    oldSessionCheckpointWrites: 0,
    newSessionStartsFresh: true,
    newSessionActive: true,
    sensitiveMaterialMigrated: false,
    internalIdentifiersOmitted: true,
    storyContextPreserved: true,
    taskDispatches: 0,
    deliveryEvents: 0,
  })
})

test('rich canary exposes the comparison inputs and per-turn evidence without production paths', () => {
  const source = readFileSync(richCanaryPath, 'utf8')
  assert.match(source, /process\.env\.CANARY_MIDTURN_PRECHECK \|\| '0'/u)
  assert.doesNotMatch(source, /process\.env\.CANARY_MIDTURN_PRECHECK \|\| '1'/u)
  for (const marker of [
    'CANARY_KEEP_RECENT_TOKENS',
    'CANARY_MAX_ACTIVE_TRANSCRIPT_BYTES',
    'CANARY_TURNS',
    'CANARY_MINIMUM_TOOL_PAIRS',
    'CANARY_TRANSCRIPT_PROJECTION_MAX_BYTES',
    'COMPACTION_SAFETY_INSTRUCTIONS',
    'checkpointTokens',
    'stopReason',
    'finalReply',
    'persistedTranscriptBytesAfter',
    'splitTurnCheckpointCount',
    'recentTurnsRecoveryCount',
    'recoveryAttemptCount',
    'builtinCheckpointVerified',
    'builtinSafeguardVerified',
    'COMPACTION_STRATEGY',
    'REQUIRED_EFFECTIVE_TOOL_IDS',
    'requiredEffectiveToolsPresent',
    'effectiveToolSetUnchanged',
    'completeCatalogSetUnchanged',
    'codingCatalogSetUnchanged',
    'fullCatalogSetUnchanged',
    'catalogRemovedToolIds',
    'catalogAddedToolIds',
    'CANARY_MIDTURN_PRECHECK',
    'completeTurnCompactionPolicy',
    'noRepeatedCompactionAcrossTurns',
    'activeTranscriptWithinConfiguredLimit',
    'activeBranchEvidenceVerified',
    'activeTranscriptBytesBefore',
    'activeTranscriptBytesAfter',
    'preflightEvidence',
    'successorRotation',
    'toolCapabilitiesReduced',
    'businessToolsReleaseReady',
    'answerMatchesTurnSemantics',
    'answerSensitiveFieldNameLeaked',
    'answerSensitiveValueLeaked',
    'checkpointSensitiveFieldNameLeaked',
    'checkpointSensitiveValueLeaked',
    'answerInternalIdentifierLeaked',
    'checkpointInternalIdentifierLeaked',
    'activeTranscriptSensitiveFieldNameLeaked',
    'activeTranscriptSensitiveValueLeaked',
    'activeTranscriptInternalIdentifierLeaked',
    'checkpointSuccessorsResolved',
    'serializedCheckpointPayloads',
    'generalAnchorContractApplied',
    'generalAnchorMessagesSeeded',
    'missingSemanticAnchors',
    'GENERAL_COMPACTION_TURN_PROMPTS',
    'SYNTHETIC_TECHNIQUE_LOGIC_CONTEXT',
    'techniqueContextSeeded',
    'userBoundedToolTurns',
    'completedToolTurns',
    'projectedToolCallTurns',
    'validToolCallProjections',
    'projectedToolTurns',
    'validPersistedResultProjections',
    'futureCleanHistoryShapeSafe',
    'actualGatewayHookWritesVerified',
    'currentTurnRawToolResultVisibilityVerified',
    'blindSemanticProjectionVerified',
    'CANONICAL_EXPLAIN_PROMPT',
    'FIXTURE_CANONICAL_TECHNIQUE_ANSWER',
    'CANARY_CANONICAL_SOURCE_MODE',
    'FIXTURE_CANONICAL_MODE',
    'LIVE_CANONICAL_MODE',
    'liveCanonicalAuthorityVerified',
    'fixtureDoesNotProveFeishuAuthority',
    'productionAcceptanceEligible',
    'productionAccepted',
    'currentTurnToolRoute',
    'canonicalToolRouteVerified',
    'fallbackToolCalls',
    'canonicalRereadCoverage',
    'AIWORKER_RESILIENCE_CANARY_LARGE_RESULT',
    'deterministicFullToolResultBytes',
    'appendFutureCleanToolHistoryThroughHooks',
    'completeProjectedPairs',
    'legacySingleTurnRisk',
    'preexisting-unprojected-tool-history',
    'legacy-polluted-cannot-auto-recover',
    'sessions.reset-exact-polluted-session-after-deployment',
    'answerAvoidsInternalTerms',
    'sensitiveLeakage',
    "call('tools.effective'",
    "call('tools.catalog'",
    "child.kill('SIGKILL')",
  ]) {
    assert.ok(source.includes(marker), `missing ${marker}`)
  }
  assert.ok(source.includes('OPENCLAW_STATE_DIR: stateDir'))
  assert.ok(source.includes("const COMPACTION_STRATEGY = 'builtin-safeguard'"))
  assert.ok(!source.includes("provider: DIRECTOR_PROVIDER_ID"))
  assert.ok(!source.includes("identifierPolicy: 'off'"))
  assert.ok(source.includes("for (const pluginId of ['aiworker-director-brain', 'aiworker-video-command'])"))
  assert.ok(source.includes("allow: ['aiworker-director-brain', 'aiworker-video-command']"))
  assert.ok(source.includes("alsoAllow: ['aiworker_analyze_video', 'aiworker_director_brain']"))
  assert.equal((source.match(/config: \{ releaseReady: true/g) || []).length, 1)
  assert.equal((source.match(/config: \{ releaseReady: false/g) || []).length, 1)
  assert.ok(source.includes("'session_status'"))
  assert.ok(source.includes("profile: 'full'"))
  assert.ok(source.includes('REQUIRED_EFFECTIVE_TOOL_IDS'))
  assert.ok(source.includes('toolCapabilitiesReduced: !effectiveToolSetUnchanged'))
  assert.ok(source.includes('checkpointUsesBuiltinSafeguard'))
  assert.ok(source.includes('createdCheckpoints.every(checkpointUsesBuiltinSafeguard)'))
  assert.ok(source.includes('SYNTHETIC_SENSITIVE_FIELDS'))
  assert.ok(source.includes('SYNTHETIC_SENSITIVE_FIELD_NAMES'))
  assert.ok(source.includes('SYNTHETIC_SENSITIVE_VALUES'))
  assert.ok(source.includes('SYNTHETIC_INTERNAL_IDENTIFIERS'))
  assert.ok(source.includes('prompts[turnIndex % prompts.length]'))
  assert.ok(source.includes("role: 'user'"))
  assert.ok(source.includes('历史边界标记，不包含当前问题答案'))
  assert.ok(!source.includes('请依据此前工具返回的观察'))
  assert.ok(source.includes('privateMetadata: {'))
  assert.ok(source.includes('...SYNTHETIC_SENSITIVE_FIELDS'))
  assert.ok(source.includes('internalIdentifiers: SYNTHETIC_INTERNAL_IDENTIFIERS'))
  assert.ok(!source.includes('syntheticInternalIdentifiers:'))
  assert.ok(source.indexOf('const techniqueContextId = randomUUID()')
    > source.indexOf("if (index > 128) throw new Error('failed to reach target transcript size')"))
  assert.ok(!source.includes('techniqueLearning:'))
  assert.ok(!source.includes('COMPACTION_IDENTIFIER_INSTRUCTIONS'))
  assert.ok(!source.includes('SAFE_INTERNAL_TASK_ID'))
  assert.ok(!source.includes('identifierInstructions:'))
  assert.ok(source.includes('Retain safe user goals, facts, decisions, constraints'))
  assert.ok(source.includes('Exclude tool-call and tool-result structures'))
  assert.ok(source.includes('Preserve the safe semantic anchors'))
  assert.ok(!source.includes('apiKey, privateKey, connectionString'))
  assert.ok(!source.includes('answerSensitiveReferenceLeaked'))
  assert.ok(!source.includes('checkpointSensitiveReferenceLeaked'))
  assert.ok(!source.includes('answerSensitiveMaterialLeaked'))
  assert.ok(!source.includes('checkpointSensitiveMaterialLeaked'))
  assert.ok(source.includes('HISTORY_MODE === FUTURE_CLEAN_HISTORY_MODE'))
  assert.ok(source.includes('maximumObservedToolResultBytes <= TRANSCRIPT_PROJECTION_MAX_BYTES'))
  assert.ok(source.includes('attempts === 1'))
  assert.ok(source.includes('globalThis.__aiworkerResilienceCanaryPayloadUsed'))
  assert.ok(source.includes("toolRoute.calls[0].arguments.action === 'explain'"))
  assert.match(source, /readDirectorBrainSystemAnswer\(\s*'technique_learning'/u)
  assert.ok(source.includes('HISTORY_MODE === LEGACY_POLLUTED_HISTORY_MODE'))
  assert.ok(source.includes("const FUTURE_CLEAN_HISTORY_MODE = 'future-clean'"))
  assert.ok(source.includes("const LEGACY_POLLUTED_HISTORY_MODE = 'legacy-polluted'"))
  assert.ok(source.includes('migrationRequired: legacyMigrationRequired'))
  assert.match(source, /let liveCanonicalAuthorityVerified = false/u)
  assert.match(source, /canonicalTechniqueAnswer = await readDirectorBrainSystemAnswer\([\s\S]+liveCanonicalAuthorityVerified = true/u)
  assert.ok(source.indexOf('await startGateway()')
    > source.indexOf('liveCanonicalAuthorityVerified = true'))
  assert.match(source, /liveAuthorityVerified: liveCanonicalAuthorityVerified/u)
  assert.match(source, /fixtureDoesNotProveFeishuAuthority: CANONICAL_SOURCE_MODE === FIXTURE_CANONICAL_MODE/u)
  assert.match(source, /const productionAcceptanceEligible = futureCleanAcceptanceEligible\s+&& canonicalRereadCoverage\.liveAuthorityVerified === true/u)
  assert.match(source, /const productionAccepted = productionAcceptanceEligible && futureCleanAccepted/u)
  assert.ok(source.includes('future-clean-fixture-accepted-not-production-evidence'))
  assert.doesNotMatch(source, /\.openclaw-qwen-current|AI-worker-second-original-workspace/u)
})

test('real-canary prompts do not disclose the expected historical answers', () => {
  for (const leakedAnswer of [
    '缓存键冲突',
    '租户前缀',
    '周六零点',
    '哺乳动物',
    '上游减排',
    '接口契约测试',
  ]) {
    assert.doesNotMatch(GENERAL_COMPACTION_OMNIBUS_PROMPT, new RegExp(leakedAnswer, 'u'))
  }
  const exclusiveAnswers = [
    '已审核证据',
    '缓存键冲突',
    '周六零点',
    '哺乳动物',
    '上游减排',
    '接口契约测试',
  ]
  GENERAL_COMPACTION_ANCHORS.forEach((anchor, index) => {
    assert.doesNotMatch(anchor.prompt, new RegExp(exclusiveAnswers[index], 'u'))
  })
})

test('runtime manifest pins the bounded transcript policy and verifies persistence hooks', () => {
  const manifest = JSON.parse(readFileSync(runtimeManifestPath, 'utf8'))
  assert.deepEqual(manifest.compaction, {
    set: {
      model: 'qwen36-tools-local/default_model',
      timeoutSeconds: 240,
      keepRecentTokens: 8192,
      recentTurnsPreserve: 4,
      truncateAfterCompaction: true,
      maxActiveTranscriptBytes: '128kb',
      midTurnPrecheck: { enabled: true },
    },
    remove: ['identifierInstructions'],
  })
  assert.deepEqual(manifest.agent, { id: 'second-original' })
  assert.equal(Object.hasOwn(manifest, 'expectedEffectiveTools'), false)
  const directorPlugin = manifest.requiredPlugins.find(entry => (
    entry.id === 'aiworker-director-brain'
  ))
  assert.equal(directorPlugin.version, '0.4.0')
  const videoPlugin = manifest.requiredPlugins.find(entry => (
    entry.id === 'aiworker-video-command'
  ))
  assert.equal(videoPlugin.version, '0.5.14')
  assert.deepEqual(
    directorPlugin.requiredHooks.toSorted(),
    ['before_agent_reply', 'before_message_write', 'tool_result_persist'],
  )
  assert.deepEqual(directorPlugin.requiredHookConfig, { allowConversationAccess: true })

  const helper = readFileSync(convergenceHelperPath, 'utf8')
  assert.ok(helper.includes('function verifyRuntimeHooks('))
  assert.ok(helper.includes('validateRuntimeInspection(inspection.value, descriptor)'))
  assert.ok(helper.includes('validateRuntimeCatalog(catalog.value, manifest, descriptor)'))
  assert.ok(helper.includes('requiredHooks.toSorted()'))
  assert.ok(helper.includes('requiredPluginTreeEvidence(stateDir, manifest)'))
  assert.ok(helper.includes('defaults: { compaction: patchCompaction }'))
  assert.ok(helper.includes('expected.agents.defaults.compaction = expectedCompaction'))
  assert.ok(helper.includes("command === 'verify-runtime-hooks'"))
})

test('rich canary rejects unsupported retention before starting a Gateway', () => {
  const result = spawnSync(process.execPath, [richCanaryPath], {
    env: { ...process.env, CANARY_KEEP_RECENT_TOKENS: '2048' },
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must be 1024, 4096, or 8192/u)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /gateway.*listening/iu)
})

test('rich canary reserves eight-turn acceptance for future-clean history', () => {
  const result = spawnSync(process.execPath, [richCanaryPath], {
    env: {
      ...process.env,
      CANARY_HISTORY_MODE: 'legacy-polluted',
      CANARY_TURNS: '8',
    },
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /run 8 turns only for future-clean/u)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /gateway.*listening/iu)
})

test('rich canary accepts production value 4 and rejects unsupported preserved-turn values', () => {
  const source = readFileSync(richCanaryPath, 'utf8')
  assert.ok(source.includes('if (![0, 1, 3, 4].includes(RECENT_TURNS_PRESERVE))'))
  assert.ok(source.includes('?? 4'))
  assert.ok(!source.includes('fixes CANARY_RECENT_TURNS_PRESERVE at 0'))
  const result = spawnSync(process.execPath, [richCanaryPath], {
    env: {
      ...process.env,
      CANARY_HISTORY_MODE: 'future-clean',
      CANARY_RECENT_TURNS_PRESERVE: '2',
    },
    encoding: 'utf8',
    timeout: 5_000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /must be 0, 1, 3, or 4/u)
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /gateway.*listening/iu)
})
