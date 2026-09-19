import { describe, expect, it } from 'vitest'
import {
  assertEditPlanIntegrity,
  createEditPlan,
  editPlanIdempotencyKey,
  frameRangeSeconds,
  preflightEditPlan,
} from '@/lib/editing/edit-plan'
import {
  executeResolveOperation,
  operationPayloadSha256,
  preflightResolveExecutor,
  resolveOperationId,
} from '@/lib/editing/resolve-executor'

const hash = 'a'.repeat(64)

function plan() {
  return createEditPlan({
    schemaVersion: 1,
    planId: 'plan-test-001',
    revision: 1,
    status: 'validated',
    scope: { tenantId: 1, workspaceId: 1 },
    sourceTaskIds: ['video-task-001'],
    objective: '生成测试粗剪',
    sourceFrameRate: { numerator: 24, denominator: 1 },
    timelineFrameRate: { numerator: 24, denominator: 1 },
    base: {
      editorNodeId: 'resolve-node-test',
      resolveVersion: '21.1.0',
      projectUniqueId: 'project-test',
      timelineUniqueId: 'timeline-base',
      timelineName: 'Assembly',
      projectFingerprint: hash,
      timelineFingerprint: hash,
    },
    clips: [{
      itemId: 'item-001',
      asset: { assetId: 'asset-001', contentSha256: hash, revision: 'asset-rev-1' },
      evidence: [{
        evidenceId: 'evidence-001',
        assetId: 'asset-001',
        revision: 'summary-rev-1',
        source: 'saved-summary',
        sourceRange: { start: 0, endExclusive: 48 },
        completeness: 'complete',
      }],
      sourceRange: { start: 24, endExclusive: 72 },
      timelineStartFrame: 0,
      trackIndex: 1,
      mediaType: 'av',
      rationale: '测试片段',
    }],
    output: { preview: true, renderPreset: 'preview-h264' },
    capabilitiesRequired: ['project.read', 'timeline.duplicate', 'timeline.append'],
    createdAt: 1_700_000_000,
    updatedAt: 1_700_000_000,
  })
}

describe('Resolve edit plan contract', () => {
  it('creates a stable digest and rejects tampering', () => {
    const value = plan()
    expect(assertEditPlanIntegrity(value)).toEqual(value)
    expect(() => assertEditPlanIntegrity({ ...value, objective: 'tampered' })).toThrow('edit_plan_integrity_mismatch')
    expect(frameRangeSeconds({ start: 24, endExclusive: 72 }, { numerator: 24, denominator: 1 })).toBe(2)
  })

  it('keeps operation identity stable across retries', () => {
    const value = plan()
    expect(editPlanIdempotencyKey(value, 'edit', 'item-001'))
      .toBe(editPlanIdempotencyKey(value, 'edit', 'item-001'))
    expect(resolveOperationId(value, 'video-task-001', 'edit', 'item-001'))
      .toMatch(/^resolve-operation:[0-9a-f]{64}$/u)
    expect(operationPayloadSha256({ z: 1, a: 2 })).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('blocks mismatched node, project or capability before writing', () => {
    const value = plan()
    const snapshot = {
      connected: true,
      nodeId: 'resolve-node-other',
      resolveVersion: '21.1.0',
      studio: true,
      capabilities: ['project.read', 'timeline.duplicate', 'timeline.append'],
      projectUniqueId: 'project-test',
      timelineUniqueId: 'timeline-base',
    }
    expect(preflightEditPlan(value, snapshot).code).toBe('resolve_node_identity_mismatch')
    expect(preflightResolveExecutor(value, {
      ...snapshot,
      nodeId: value.base.editorNodeId,
      processIdentity: 'wrong',
    }).code).toBe('resolve_process_identity_mismatch')
  })

  it('returns unknown when the transport fails after the call boundary', async () => {
    const value = plan()
    const operation = {
      operationId: resolveOperationId(value, 'video-task-001', 'edit', 'item-001'),
      taskId: 'video-task-001',
      planId: value.planId,
      planRevision: value.revision,
      phase: 'edit' as const,
      stepId: 'item-001',
      payloadSha256: operationPayloadSha256(value.clips[0]),
      status: 'pending' as const,
      executorNodeId: value.base.editorNodeId,
      resolveVersion: value.base.resolveVersion,
      timelineUniqueId: value.base.timelineUniqueId,
    }
    const transport = {
      inspect: async () => ({
        connected: true,
        nodeId: value.base.editorNodeId,
        resolveVersion: value.base.resolveVersion,
        studio: true,
        capabilities: value.capabilitiesRequired,
        projectUniqueId: value.base.projectUniqueId,
        timelineUniqueId: value.base.timelineUniqueId,
        processIdentity: value.base.editorNodeId + ':resolve:' + value.base.resolveVersion,
      }),
      apply: async () => { throw new Error('resolve_transport_connection_lost') },
      cancel: async () => undefined,
    }
    await expect(executeResolveOperation(value, operation, transport)).resolves.toMatchObject({
      status: 'unknown',
      errorCode: 'resolve_transport_connection_lost',
    })
  })
})
