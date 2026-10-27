import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import { n8nTaskIdentitySchema } from '@/lib/n8n-task-runs'
import { dispatchQueuedVideoSegmentRepair, inspectVideoRecovery, inspectVideoSegmentRepair, recoverVideoTask, repairVideoSegments } from '@/lib/n8n-video-recovery'
import { mutationLimiter } from '@/lib/rate-limit'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const id = n8nTaskIdentitySchema.safeParse(request.nextUrl.searchParams.get('taskId'))
  if (!id.success) return NextResponse.json({ error: '任务编号无效' }, { status: 400 })
  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  const mode = request.nextUrl.searchParams.get('mode')
  if (mode !== null && mode !== 'repair-segments') return NextResponse.json({ error: '恢复方式无效' }, { status: 400 })
  const rawIndexes = request.nextUrl.searchParams.get('segmentIndexes')
  const indexes = rawIndexes === null ? undefined : rawIndexes.split(',').map(Number)
  if (indexes && (!mode || !repairIndexes.safeParse(indexes).success)) return NextResponse.json({ error: '待补学片段编号无效' }, { status: 400 })
  const inspection = mode === 'repair-segments'
    ? await inspectVideoSegmentRepair(getDatabase(), id.data, scope, auth.user.id, indexes)
    : await inspectVideoRecovery(getDatabase(), id.data, scope, auth.user.id)
  if (!inspection) return NextResponse.json({ error: '未找到任务' }, { status: 404 })
  const probe = new Request(new URL('/api/n8n/runs/recovery', request.url), { method: 'POST', headers: request.headers })
  const operator = requireN8nRole(probe, 'operator')
  const canRecover = !('error' in operator) && operator.user.workspace_id === scope.workspaceId && operator.user.tenant_id === scope.tenantId
  return NextResponse.json({ inspection: { ...inspection, inspectionToken: canRecover ? inspection.inspectionToken : null }, canRecover }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

const repairIndexes = z.array(z.number().int().positive().max(100_000)).min(1).max(1000)
const recoverySchema = z.object({ taskId: n8nTaskIdentitySchema, inspectionToken: z.string().min(1).max(4096),
  confirm: z.literal(true), mode: z.literal('repair-segments').optional(), segmentIndexes: repairIndexes.optional(),
}).strict().refine(value => !value.segmentIndexes || value.mode === 'repair-segments')
const dispatchRepairSchema = z.object({ action: z.literal('dispatch-repair'), taskId: n8nTaskIdentitySchema,
  requestId: z.string().regex(/^[a-f0-9]{64}$/u), workerLease: z.object({
    pid: z.number().int().positive(), token: z.uuid(),
  }).strict(),
}).strict()

export async function POST(request: NextRequest) {
  const auth = requireN8nRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const body = await request.json().catch(() => null)
  const queuedDispatch = dispatchRepairSchema.safeParse(body)
  const parsed = recoverySchema.safeParse(body)
  if (!queuedDispatch.success && !parsed.success) return NextResponse.json({ error: '请先检查任务并确认恢复' }, { status: 400 })
  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  try {
    let result
    if (queuedDispatch.success) result = await dispatchQueuedVideoSegmentRepair(getDatabase(), queuedDispatch.data, scope)
    else if (parsed.success && parsed.data.mode === 'repair-segments') {
      result = await repairVideoSegments(getDatabase(), parsed.data, scope, auth.user.id)
    } else if (parsed.success) result = await recoverVideoTask(getDatabase(), parsed.data, scope, auth.user.id)
    else return NextResponse.json({ error: '恢复请求无效' }, { status: 400 })
    try { logAuditEvent({ action: 'n8n_video_recovery', actor: auth.user.username, actor_id: auth.user.id,
      target_type: 'n8n_task_run', detail: { taskId: result.taskId, currentState: result.currentState } }) } catch { /* Do not repeat committed recovery. */ }
    return NextResponse.json(result, { status: 202, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const code = error instanceof Error && /^recovery_[a-z_]+$/u.test(error.message) ? error.message : 'recovery_not_ready'
    return NextResponse.json({ code, error: '任务状态或恢复条件已变化，请重新检查；未创建新任务' }, { status: 409 })
  }
}
