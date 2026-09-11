import { describe, expect, it } from 'vitest'
import {
  buildBoundedTransferRetryPolicy,
  buildIncrementalTransferPlan,
  buildOperationsFailureRecord,
  buildOperationsFactRecord,
  buildReadOnlyPrewarmPlan,
  maintenanceLibraryRequest,
  selectLatestOperationsFact,
  summarizeOperationsTelemetry,
  validateReadOnlyPrewarmResult,
} from '../../../scripts/lib/operations-maintenance.mjs'

const sha = (value: string) => value.repeat(64)
const manifest = (fileSha: string, bytes = 10) => ({
  schemaVersion: 2,
  algorithm: 'sha256',
  directories: [{ path: 'server', mode: '0755' }],
  files: [{ path: 'server/app.js', mode: '0644', bytes, sha256: fileSha }],
  symlinks: [{ path: 'server/current', mode: '0755', target: 'app.js' }],
})

describe('operations maintenance contracts', () => {
  it('plans content-based transfer reuse and keeps TLS strict without a proxy by default', () => {
    const source = manifest(sha('a'))
    const donor = manifest(sha('b'), 8)
    const plan = buildIncrementalTransferPlan(source, donor)
    expect(plan.summary).toMatchObject({
      sourceMembers: 3,
      reusedMembers: 2,
      transferredMembers: 1,
      sourceBytes: 10,
      transferBytes: 10,
    })
    expect(plan.retryPolicy).toMatchObject({
      maxAttempts: 1,
      delaysMs: [],
      proxy: { mode: 'none', injected: false, identitySha256: null },
      tls: { verifyIdentity: true, downgradeAllowed: false },
    })
    expect(plan.staging).toEqual({ mustBeFresh: true, inPlaceMutationAllowed: false })
    expect(plan.completionRequiresFullManifestVerification).toBe(true)
  })

  it('builds bounded exponential retry only for an explicit process-scoped proxy', () => {
    expect(buildBoundedTransferRetryPolicy({
      maxAttempts: 4,
      baseDelayMs: 500,
      maximumDelayMs: 1_500,
      proxyMode: 'process-scoped-verified',
      proxyIdentitySha256: sha('c'),
    })).toMatchObject({ delaysMs: [500, 1_000, 1_500] })
    expect(() => buildBoundedTransferRetryPolicy({
      maxAttempts: 6,
      baseDelayMs: 100,
      maximumDelayMs: 1_000,
    })).toThrow('operations_transfer_retry_policy_invalid')
  })

  it('summarizes measured phase and resource data without inventing budgets', () => {
    const summary = summarizeOperationsTelemetry([{
      phase: 'transfer', status: 'succeeded', startedAtMs: 100, completedAtMs: 350,
      retryCount: 1, waitLockMs: 20, bytes: 2_200_000,
      resources: [
        { atMs: 120, cpuPercent: 20, memoryBytes: 100, readBytes: 10, writeBytes: 20, queueDepth: 1 },
        { atMs: 300, cpuPercent: 40, memoryBytes: 150, readBytes: 30, writeBytes: 40, queueDepth: 2 },
      ],
    }])
    expect(summary.phases[0]).toMatchObject({ durationMs: 250, resourceSamples: 2 })
    expect(summary.resources).toMatchObject({
      averageCpuPercent: 30,
      peakCpuPercent: 40,
      peakMemoryBytes: 150,
      peakQueueDepth: 2,
    })
    expect(summary.budgets).toEqual({
      cpuPercent: null, memoryBytes: null, ioBytesPerSecond: null, status: 'not-set',
    })
  })

  it('permits only declared read-only prewarm actions and requires zero side effects', () => {
    const plan = buildReadOnlyPrewarmPlan([
      { kind: 'health', targetId: 'candidate-health' },
      { kind: 'static-resource', targetId: 'candidate-static' },
      { kind: 'read-only-query', targetId: 'candidate-query' },
    ])
    expect(plan.objectives).toEqual({ firstRequestP95Ms: null, status: 'not-set' })
    expect(validateReadOnlyPrewarmResult(plan, {
      observedActions: ['health', 'static-resource', 'read-only-query'],
      businessWrites: 0, externalMessages: 0, modelTasks: 0, approvals: 0, schedulerRuns: 0,
    })).toMatchObject({ safe: true })
    expect(() => validateReadOnlyPrewarmResult(plan, {
      observedActions: ['health', 'static-resource', 'read-only-query'],
      businessWrites: 1, externalMessages: 0, modelTasks: 0, approvals: 0, schedulerRuns: 0,
    })).toThrow('operations_prewarm_result_unsafe')
  })

  it('keeps the latest fact distinct from append-only failure evidence', () => {
    const older = buildOperationsFactRecord({
      subjectId: 'production-app', factType: 'active-release', status: 'release-a',
      observedAt: 10, revision: 1, evidenceSha256: sha('a'),
    })
    const latest = buildOperationsFactRecord({
      subjectId: 'production-app', factType: 'active-release', status: 'release-b',
      observedAt: 20, revision: 2, evidenceSha256: sha('b'),
    })
    expect(selectLatestOperationsFact([older, latest])).toEqual(latest)
    expect(buildOperationsFailureRecord({
      attemptId: 'attempt-1', phase: 'transfer', errorCode: 'connection_lost',
      observedAt: 15, retryable: true, evidenceSha256: sha('c'),
    })).toMatchObject({ retryable: true, phase: 'transfer' })
  })

  it('offers a library-only maintenance request without mutation authority', () => {
    expect(maintenanceLibraryRequest({
      requestId: 'request-1', action: 'doctor', requestedAt: 10, inputSha256: sha('d'),
    })).toMatchObject({ execution: 'library-only', mutationAuthorized: false })
    expect(() => maintenanceLibraryRequest({
      requestId: 'request-2', action: 'delete', requestedAt: 10, inputSha256: sha('d'),
    })).toThrow('operations_maintenance_request_invalid')
  })
})
