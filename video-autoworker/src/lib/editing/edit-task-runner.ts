import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { videoEditingEnabled, inspectVideoEditingSchema } from '@/lib/database-capabilities'
import { completeN8nTaskRun, failN8nTaskRun, type N8nTaskScope } from '@/lib/n8n-task-runs'
import { beginEditOperation, claimApprovedEditTask, requireApprovedTask, settleEditOperation } from './edit-task-service'
import { executeResolveOperation, operationPayloadSha256, resolveOperationId, resolveOperationPayload, type ResolveExecutorOperation, type ResolveExecutorTransport } from './resolve-executor'
import { createUnixResolveExecutorTransport } from './resolve-executor-transport'
import type { EditPlan } from './edit-plan'
import { verifyRenderedVideo } from './render-quality'

const inFlight = new Set<string>()
export function editingSocketPath() {
  return process.env.AIWORKER_RESOLVE_SOCKET || join(homedir(), 'ai-worker/state/resolve-executor/executor.sock')
}

export function editTaskSteps(plan: EditPlan) {
  const steps: Array<{ phase: ResolveExecutorOperation['phase']; stepId: string }> = [
    { phase: plan.base.timelineUniqueId ? 'duplicate_timeline' : 'create_timeline', stepId: 'work-copy' },
  ]
  for (const assetId of [...new Set(plan.clips.filter(c => !c.asset.resolveMediaPoolItemUniqueId).map(c => c.asset.assetId))]) {
    steps.push({ phase: 'import_media', stepId: assetId })
  }
  steps.push(...plan.clips.map(c => ({ phase: 'edit' as const, stepId: c.itemId })))
  if (plan.output.autoSubtitles) steps.push({ phase: 'subtitles', stepId: 'captions' })
  if (plan.output.outputPathRef) steps.push({ phase: 'queue_render', stepId: 'export-queue' }, { phase: 'start_render', stepId: 'export-start' })
  steps.push({ phase: 'verify', stepId: 'timeline-readback' })
  return steps
}

/** One bounded operation per drain. The existing task row is the only queue;
 * persistent operation intents decide whether a write or only readback is safe. */
export async function advanceVideoEditTask(db: Database.Database, taskId: string, scope: N8nTaskScope,
  transport: ResolveExecutorTransport = createUnixResolveExecutorTransport({ socketPath: editingSocketPath() })) {
  if (inFlight.has(taskId)) return { state: 'busy' }
  inFlight.add(taskId)
  try {
    const owner = 'n8n-execution:video-edit-' + createHash('sha256').update(taskId).digest('hex').slice(0, 40)
    const claim = claimApprovedEditTask(db, taskId, owner, scope)
    if (!['claimed', 'owned'].includes(claim.outcome)) return { state: claim.outcome }
    const { plan } = requireApprovedTask(db, taskId, scope)
    let latest: Record<string, unknown> = {}
    let rendered: Record<string, unknown> | null = null
    for (const step of editTaskSteps(plan)) {
      const operationId = resolveOperationId(plan, taskId, step.phase, step.stepId)
      const row = db.prepare('SELECT status,result_json,error_code FROM video_edit_operations WHERE operation_id = ?').get(operationId) as
        { status: 'running' | 'unknown' | 'failed' | 'succeeded'; result_json: string | null; error_code: string | null } | undefined
      const storedResult = row?.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : {}
      if (row?.status === 'succeeded') {
        latest = { ...latest, ...storedResult }
        if (step.phase === 'start_render') rendered = storedResult
        continue
      }
      if (row?.status === 'failed') {
        failN8nTaskRun(db, taskId, row.error_code || 'video_edit_operation_failed')
        return { state: 'failed', errorCode: row.error_code }
      }
      const operation: ResolveExecutorOperation = {
        operationId, taskId, planId: plan.planId, planRevision: plan.revision, ...step,
        payloadSha256: operationPayloadSha256(resolveOperationPayload(plan, step)),
        status: row?.status || 'pending', executorNodeId: plan.base.editorNodeId, resolveVersion: plan.base.resolveVersion,
        ...(typeof latest.timelineUniqueId === 'string' ? { timelineUniqueId: latest.timelineUniqueId } : {}),
        ...(typeof latest.timelineFingerprint === 'string' ? { timelineFingerprint: latest.timelineFingerprint } : {}),
        ...(row ? { result: storedResult } : {}),
      }
      const intent = beginEditOperation(db, operation, owner, scope)
      // Only this exact successful first intent may write. Durable running or
      // unknown rows always enter the executor's read-only reconciliation path.
      operation.status = intent.outcome === 'write_granted' ? 'pending' : row?.status || 'unknown'
      const result = await executeResolveOperation(plan, operation, transport)
      const status = result.status === 'cancelled' ? 'failed' : result.status
      settleEditOperation(db, { operationId, taskId, executionOwner: owner, status,
        result: result.result, errorCode: result.errorCode,
        ...(['succeeded', 'failed'].includes(status) ? { evidenceSha256: operationPayloadSha256(result) } : {}),
      }, scope)
      if (status === 'failed') failN8nTaskRun(db, taskId, result.errorCode || 'video_edit_operation_failed')
      return { state: status, phase: step.phase, errorCode: result.errorCode || null }
    }
    let quality: Record<string, unknown> | undefined
    if (plan.output.outputPathRef) {
      if (!rendered || typeof rendered.outputPath !== 'string') throw new Error('video_edit_render_evidence_missing')
      quality = await verifyRenderedVideo(plan, rendered.outputPath)
    }
    completeN8nTaskRun(db, taskId, { taskType: 'video-edit', planId: plan.planId, revision: plan.revision,
      planSha256: plan.planSha256, timeline: latest, render: rendered, quality: quality || null })
    return { state: 'succeeded' }
  } finally { inFlight.delete(taskId) }
}

export async function drainVideoEditTasks(db: Database.Database) {
  if (!videoEditingEnabled()) return { scanned: 0, state: 'disabled' }
  inspectVideoEditingSchema(db, true)
  const rows = db.prepare(`SELECT r.task_id,r.tenant_id,r.workspace_id FROM n8n_task_runs r
    JOIN video_edit_plans p ON p.task_id=r.task_id AND p.tenant_id=r.tenant_id AND p.workspace_id=r.workspace_id
    WHERE json_extract(r.routing,'$.taskType')='video-edit' AND p.status='approved' AND r.status IN ('queued','accepted','running')
    ORDER BY CASE WHEN r.status='running' THEN 0 ELSE 1 END,r.created_at,r.task_id LIMIT 1`).all() as
    Array<{ task_id: string; tenant_id: number; workspace_id: number }>
  const results = []
  for (const row of rows) {
    try { results.push(await advanceVideoEditTask(db, row.task_id, { tenantId: row.tenant_id, workspaceId: row.workspace_id })) }
    catch (error) { results.push({ state: 'needs_attention', errorCode: error instanceof Error ? error.message : 'video_edit_unavailable' }) }
  }
  return { scanned: rows.length, results }
}
