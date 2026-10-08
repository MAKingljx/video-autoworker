import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import { n8nTaskIdentitySchema } from '@/lib/n8n-task-runs'
import { inspectVideoRecovery, recoverVideoTask } from '@/lib/n8n-video-recovery'
import { mutationLimiter } from '@/lib/rate-limit'

export const runtime = 'nodejs'

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const id = n8nTaskIdentitySchema.safeParse(request.nextUrl.searchParams.get('taskId'))
  if (!id.success) return NextResponse.json({ error: '任务编号无效' }, { status: 400 })
  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  const inspection = await inspectVideoRecovery(getDatabase(), id.data, scope, auth.user.id)
  if (!inspection) return NextResponse.json({ error: '未找到任务' }, { status: 404 })
  const probe = new Request(new URL('/api/n8n/runs/recovery', request.url), { method: 'POST', headers: request.headers })
  const operator = requireN8nRole(probe, 'operator')
  const canRecover = !('error' in operator) && operator.user.workspace_id === scope.workspaceId && operator.user.tenant_id === scope.tenantId
  return NextResponse.json({ inspection: { ...inspection, inspectionToken: canRecover ? inspection.inspectionToken : null }, canRecover }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

const recoverySchema = z.object({ taskId: n8nTaskIdentitySchema, inspectionToken: z.string().min(1).max(4096),
  confirm: z.literal(true) }).strict()

export async function POST(request: NextRequest) {
  const auth = requireN8nRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const parsed = recoverySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: '请先检查任务并确认恢复' }, { status: 400 })
  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  try {
    const result = await recoverVideoTask(getDatabase(), parsed.data, scope, auth.user.id)
    try { logAuditEvent({ action: 'n8n_video_recovery', actor: auth.user.username, actor_id: auth.user.id,
      target_type: 'n8n_task_run', detail: { taskId: result.taskId, currentState: result.currentState } }) } catch { /* Do not repeat committed recovery. */ }
    return NextResponse.json(result, { status: 202, headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const code = error instanceof Error && /^recovery_[a-z_]+$/u.test(error.message) ? error.message : 'recovery_not_ready'
    return NextResponse.json({ code, error: '任务状态或恢复条件已变化，请重新检查；未创建新任务' }, { status: 409 })
  }
}
