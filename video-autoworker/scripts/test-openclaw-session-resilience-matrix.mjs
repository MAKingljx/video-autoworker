#!/usr/bin/env node

import {
  runMockCompactionFailureDegradation,
  runMockDuplicateCompactionAttempt,
  runMockFailureRecovery,
  runMockMainModelFailureRecovery,
  runMockMatrix,
  runMockPollutedSessionMigration,
  runMockScreenshotStressMatrix,
  runMockTechniqueLogicDialogue,
  runMockToolResultInflation,
} from './lib/openclaw-session-resilience-test-matrix.mjs'

const cases = runMockMatrix()
const failureRecovery = runMockFailureRecovery()
const duplicateCompactionAttempt = runMockDuplicateCompactionAttempt()
const pollutedSessionMigration = runMockPollutedSessionMigration()
const toolResultInflation = runMockToolResultInflation()
const mainModelFailureRecovery = runMockMainModelFailureRecovery()
const techniqueLogicDialogue = runMockTechniqueLogicDialogue()
const screenshotStressCases = runMockScreenshotStressMatrix()
const compactionFailureDegradation = runMockCompactionFailureDegradation()
const includeDetails = process.argv.includes('--details')
const totalHarnessElapsedMs = Number(cases
  .reduce((total, entry) => total + entry.harnessElapsedMs, 0).toFixed(3))
const policyComparisons = cases.filter(entry => (
  entry.level === 'over-threshold' && entry.input.turns === 2
)).map(entry => ({
  threshold: entry.input.threshold,
  keepRecentTokens: entry.input.keepRecentTokens,
  inputBytes: entry.input.initialBytes,
  inputEstimatedTokens: entry.input.estimatedTokens,
  firstTurnHarnessMs: entry.turns[0].harnessElapsedMs,
  secondTurnHarnessMs: entry.turns[1].harnessElapsedMs,
  totalHarnessMs: entry.harnessElapsedMs,
  secondTurnCompactionDelta: entry.turns[1].compactionDelta,
  checkpointTokens: entry.turns[0].checkpointTokens,
  finalBytes: entry.outcome.finalBytes,
  finalEstimatedTokens: entry.outcome.finalEstimatedTokens,
  compactionCount: entry.outcome.compactionCount,
}))
const failureRecoveryOk = failureRecovery.failed.failedAttempts.length === 3
  && failureRecovery.failed.failedAttempts.every(attempt => (
    attempt.checkpointWrites === 0
    && attempt.rotations === 0
    && attempt.mainModelCalls === 0
    && attempt.taskDispatches === 0
    && attempt.deliveryEvents === 0
  ))
  && failureRecovery.failed.compactionCount === 0
  && failureRecovery.failed.checkpointCount === 0
  && failureRecovery.failed.rotationCount === 0
  && failureRecovery.failed.mainModelCalls === 0
  && !failureRecovery.failed.partialRotation
  && !failureRecovery.failed.repeatedSideEffects
  && failureRecovery.recovered.compactionCount === 1
  && failureRecovery.continuation.compactionDelta === 0
const duplicateCompactionAttemptOk = duplicateCompactionAttempt.first.compactionDelta === 1
  && duplicateCompactionAttempt.first.checkpointDelta === 1
  && duplicateCompactionAttempt.first.rotationDelta === 1
  && duplicateCompactionAttempt.duplicate.duplicate
  && duplicateCompactionAttempt.duplicate.compactionDelta === 0
  && duplicateCompactionAttempt.duplicate.checkpointDelta === 0
  && duplicateCompactionAttempt.duplicate.rotationDelta === 0
const pollutedSessionMigrationOk = pollutedSessionMigration.oldSessionUnchanged
  && pollutedSessionMigration.oldSessionSealed
  && pollutedSessionMigration.distinctSessionIdentity
  && !pollutedSessionMigration.oldSessionCompacted
  && !pollutedSessionMigration.oldSessionRotated
  && pollutedSessionMigration.oldSessionCheckpointWrites === 0
  && pollutedSessionMigration.newSessionStartsFresh
  && pollutedSessionMigration.newSessionActive
  && !pollutedSessionMigration.sensitiveMaterialMigrated
  && pollutedSessionMigration.internalIdentifiersOmitted
  && pollutedSessionMigration.storyContextPreserved
  && pollutedSessionMigration.taskDispatches === 0
  && pollutedSessionMigration.deliveryEvents === 0
const toolResultInflationOk = toolResultInflation.firstCrossingPair !== null
  && toolResultInflation.shouldCompact
  && toolResultInflation.outcome.compactionCount === 1
  && toolResultInflation.outcome.checkpointCount === 1
  && toolResultInflation.outcome.rotationCount === 1
  && toolResultInflation.outcome.mainModelCalls === 1
  && toolResultInflation.outcome.answerConcise
  && toolResultInflation.outcome.answerRetainsStoryContext
  && !toolResultInflation.outcome.sensitiveFieldNameLeaked
  && !toolResultInflation.outcome.sensitiveValueLeaked
  && !toolResultInflation.outcome.internalIdentifierLeaked
const mainModelFailureRecoveryOk = mainModelFailureRecovery.failed.compactionCount === 1
  && mainModelFailureRecovery.failed.checkpointCount === 1
  && mainModelFailureRecovery.failed.rotationCount === 1
  && mainModelFailureRecovery.failed.answerWrites === 0
  && mainModelFailureRecovery.failed.taskDispatches === 0
  && mainModelFailureRecovery.failed.deliveryEvents === 0
  && mainModelFailureRecovery.recovered.compactionDelta === 0
  && mainModelFailureRecovery.recovered.checkpointDelta === 0
  && mainModelFailureRecovery.recovered.rotationDelta === 0
  && mainModelFailureRecovery.recovered.answerWrites === 1
  && mainModelFailureRecovery.recovered.taskDispatches === 0
  && mainModelFailureRecovery.recovered.deliveryEvents === 0
  && mainModelFailureRecovery.recovered.answerConcise
  && mainModelFailureRecovery.recovered.answerRetainsStoryContext
  && !mainModelFailureRecovery.recovered.sensitiveMaterialLeaked
  && !mainModelFailureRecovery.recovered.internalIdentifierLeaked
const techniqueLogicDialogueOk = techniqueLogicDialogue.first.compactionDelta === 1
  && techniqueLogicDialogue.first.valid
  && techniqueLogicDialogue.afterCompaction.compactionDelta === 0
  && techniqueLogicDialogue.afterCompaction.valid
const screenshotStressOk = screenshotStressCases.length === 72
  && screenshotStressCases.every(entry => entry.ok)
const compactionFailureDegradationOk = compactionFailureDegradation.status === 'failed-closed'
  && compactionFailureDegradation.repeatedAttempts === 3
  && compactionFailureDegradation.transcriptUnchanged
  && compactionFailureDegradation.checkpointWrites === 0
  && compactionFailureDegradation.rotations === 0
  && compactionFailureDegradation.mainModelCalls === 0
  && compactionFailureDegradation.taskDispatches === 0
  && compactionFailureDegradation.deliveryEvents === 0
  && compactionFailureDegradation.userVisibleFailureWrites === 1
  && compactionFailureDegradation.messageConcise
  && !compactionFailureDegradation.sensitiveMaterialLeaked
  && !compactionFailureDegradation.internalIdentifierLeaked
const result = {
  schema: 'video-autoworker-openclaw-session-resilience-mock-matrix/v1',
  evidenceClass: 'deterministic-local-mock',
  warning: 'Harness timings are local test cost, not Qwen/OpenClaw model latency.',
  ok: cases.every(entry => (
    [0, 1, 3, 4].includes(entry.input.recentTurnsPreserve)
    && typeof entry.input.midTurnPrecheckEnabled === 'boolean'
    && (['light', 'medium'].includes(entry.level) || entry.input.toolPairs >= 19)
    && entry.outcome.noRepeatedCompaction
    && entry.outcome.storyContextRetained
    && entry.outcome.conciseChineseAnswers
    && !entry.outcome.sensitiveFieldNameLeaked
    && !entry.outcome.sensitiveValueLeaked
    && entry.outcome.internalIdentifiersOmitted
    && entry.outcome.requiredEffectiveToolsPresent
    && entry.outcome.generalToolCapabilitiesPreserved
    && entry.outcome.toolCapabilitiesReduced === false
  ))
    && failureRecoveryOk
    && duplicateCompactionAttemptOk
    && pollutedSessionMigrationOk
    && toolResultInflationOk
    && mainModelFailureRecoveryOk
    && techniqueLogicDialogueOk
    && screenshotStressOk
    && compactionFailureDegradationOk,
  summary: {
    caseCount: cases.length,
    screenshotStressCaseCount: screenshotStressCases.length,
    totalHarnessElapsedMs,
    thresholds: [...new Set(cases.map(entry => entry.input.threshold))],
    keepRecentTokens: [...new Set(cases.map(entry => entry.input.keepRecentTokens))],
    recentTurnsPreserve: [...new Set(cases.map(entry => entry.input.recentTurnsPreserve))],
    midTurnPrecheckEnabled: [...new Set(cases
      .map(entry => entry.input.midTurnPrecheckEnabled))],
    turns: [...new Set(cases.map(entry => entry.input.turns))],
    levels: [...new Set(cases.map(entry => entry.level))],
    contracts: {
      repeatedFailureZeroSideEffects: failureRecoveryOk,
      duplicateCompactionAttemptDeduplicated: duplicateCompactionAttemptOk,
      pollutedSessionSealedAndMigratedFresh: pollutedSessionMigrationOk,
      toolResultsCrossThresholdOnce: toolResultInflationOk,
      mainModelRetryReusesCompaction: mainModelFailureRecoveryOk,
      techniqueLogicFirstAndContinuation: techniqueLogicDialogueOk,
      screenshotStressMatrix: screenshotStressOk,
      compactionFailureDegradesSafely: compactionFailureDegradationOk,
    },
  },
  policyComparisons,
  ...(includeDetails ? { cases } : {}),
  failureRecovery,
  compactionFailureDegradation,
}

console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
