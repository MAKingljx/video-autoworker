import { describe, expect, it } from 'vitest'
import {
  buildRecoveryAssetInventory,
  buildRuntimeIdentityDoctor,
  operationsRecoveryBoundaryDeclaration,
  sanitizeOperationsAuditEvent,
} from '../../../scripts/lib/operations-governance.mjs'

const sha = (value: string) => value.repeat(64)
type Boundary = { kind: string, automaticDataRestore: boolean }
type InventoryItem = {
  assetId: string
  disposition: string
  removalCandidate: boolean
  retentionException: boolean
}
type DriftItem = { field: string }

describe('operations governance', () => {
  it('keeps recovery objectives unset and separates code, config, and data recovery', () => {
    const declaration = operationsRecoveryBoundaryDeclaration()
    expect(declaration.objectives).toEqual({
      rpoSeconds: null,
      rtoSeconds: null,
      status: 'not-set',
    })
    expect(declaration.boundaries.map((item: Boundary) => item.kind))
      .toEqual(['code', 'config', 'data'])
    expect(declaration.boundaries.every(
      (item: Boundary) => item.automaticDataRestore === false,
    )).toBe(true)
    expect(declaration.boundaries.find((item: Boundary) => item.kind === 'data'))
      .toMatchObject({ requiresExplicitAuthorization: true, preserveCurrentBusinessData: true })
  })

  it('retains current and two valid histories without authorizing deletion', () => {
    const inventory = buildRecoveryAssetInventory([
      ['current', 40, 'current', 'valid'],
      ['history-3', 30, 'history', 'valid'],
      ['history-2', 20, 'history', 'valid'],
      ['history-1', 10, 'history', 'valid'],
    ].map(([assetId, createdAt, state, validation]) => ({
      assetId,
      recoveryObject: 'mission-control-db',
      kind: 'data',
      state,
      validation,
      createdAt,
      references: [],
      path: `/private/${assetId}`,
    })), { generatedAt: 50 })
    expect(inventory.policy).toEqual({ validHistoryLimit: 2, deletionAuthorized: false })
    expect(inventory.objectives.status).toBe('not-set')
    expect(inventory.items.find((item: InventoryItem) => item.assetId === 'history-1'))
      .toMatchObject({ disposition: 'candidate-after-authorization', removalCandidate: true })
    expect(inventory.summary.removalCandidates).toBe(1)
    expect(JSON.stringify(inventory)).not.toContain('/private/')
  })

  it('preserves referenced histories and sends unverified assets to review', () => {
    const inventory = buildRecoveryAssetInventory([
      {
        assetId: 'current', recoveryObject: 'config', kind: 'config', state: 'current',
        validation: 'valid', createdAt: 40, references: [], path: '/private/current',
      },
      {
        assetId: 'new-2', recoveryObject: 'config', kind: 'config', state: 'history',
        validation: 'valid', createdAt: 30, references: [], path: '/private/new-2',
      },
      {
        assetId: 'new-1', recoveryObject: 'config', kind: 'config', state: 'history',
        validation: 'valid', createdAt: 20, references: [], path: '/private/new-1',
      },
      {
        assetId: 'donor', recoveryObject: 'config', kind: 'config', state: 'history',
        validation: 'valid', createdAt: 10, references: ['active-release'], path: '/private/donor',
      },
      {
        assetId: 'unknown', recoveryObject: 'config', kind: 'config', state: 'history',
        validation: 'unverified', createdAt: 5, references: [], path: '/private/unknown',
      },
    ], { generatedAt: 50 })
    expect(inventory.items.find((item: InventoryItem) => item.assetId === 'donor'))
      .toMatchObject({ disposition: 'retain', retentionException: true })
    expect(inventory.items.find((item: InventoryItem) => item.assetId === 'unknown'))
      .toMatchObject({ disposition: 'review-required', removalCandidate: false })
  })

  it('reports identity drift without exposing runtime paths', () => {
    const expected = {
      releaseId: 'release-a', pid: 42, manifestSha256: sha('a'), configSha256: sha('b'),
      cwd: '/private/release-a', database: { path: '/private/live.db', dev: '1', ino: '2' },
    }
    const observed = {
      ...expected,
      cwd: '/private/release-b',
      configSha256: sha('c'),
      database: { path: '/private/other.db', dev: '1', ino: '3' },
    }
    const doctor = buildRuntimeIdentityDoctor(expected, observed, { observedAt: 100 })
    expect(doctor.status).toBe('drifted')
    expect(doctor.drift.map((item: DriftItem) => item.field)).toEqual([
      'configSha256', 'cwdIdentitySha256', 'database.pathIdentitySha256', 'database.ino',
    ])
    expect(doctor.mutationPerformed).toBe(false)
    expect(JSON.stringify(doctor)).not.toContain('/private/')
  })

  it('emits only the centralized audit field set and rejects secret-bearing input', () => {
    const event = sanitizeOperationsAuditEvent({
      attemptId: 'attempt-1', operation: 'inventory', phase: 'inspect', status: 'succeeded',
      objectKind: 'data', objectIdentity: '/private/live.db', startedAt: 10,
      completedAt: 11, errorCode: null, ignored: 'not-persisted',
    })
    expect(Object.keys(event).sort()).toEqual([
      'attemptId', 'completedAt', 'errorCode', 'eventSha256', 'objectIdentitySha256',
      'objectKind', 'operation', 'phase', 'schema', 'startedAt', 'status',
    ])
    expect(JSON.stringify(event)).not.toContain('/private/live.db')
    expect(() => sanitizeOperationsAuditEvent({
      attemptId: 'attempt-1', operation: 'inventory', phase: 'inspect', status: 'failed',
      objectKind: 'data', objectIdentity: 'db', startedAt: 10, completedAt: 11,
      errorCode: 'failed', token: null,
    })).toThrow('operations_audit_event_invalid')
  })
})
