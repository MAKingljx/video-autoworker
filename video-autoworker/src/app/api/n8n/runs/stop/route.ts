import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import { n8nTaskIdentitySchema } from '@/lib/n8n-task-runs'
import { advanceScopedVideoStop, inspectScopedSingleVideoStop, readScopedVideoStopIntent,
  requestScopedSingleVideoStop } from '@/lib/n8n-video-stop'
import { mutationLimiter } from '@/lib/rate-limit'

export const runtime = 'nodejs'
const headers = { 'Cache-Control': 'no-store' }
const requestSchema = z.object({ taskId: n8nTaskIdentitySchema, confirm: z.literal(true),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict()

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const taskId = n8nTaskIdentitySchema.safeParse(request.nextUrl.searchParams.get('taskId'))
  if (!taskId.success) return NextResponse.json({ error: '任务编号无效' }, { status: 400, headers })
  try {
    const db = getDatabase()
    const scope = { tenantId: auth.user.tenant_id, workspaceId: auth.user.workspace_id }
    const view = request.nextUrl.searchParams.get('view')
    if (view !== null && view !== 'request') return NextResponse.json({ error: '停止查询方式无效' }, { status: 400, headers })
    if (view === 'request') {
      const bindingId = Number(request.nextUrl.searchParams.get('bindingId'))
      const inspection = readScopedVideoStopIntent(db, taskId.data, bindingId, scope)
      return NextResponse.json({ inspection }, { headers })
    }
    const inspection = await inspectScopedSingleVideoStop(db, taskId.data, scope)
    if (inspection) return NextResponse.json({ inspection }, { headers })
    return NextResponse.json({ error: '未找到视频任务' }, { status: 404, headers })
  } catch (error) {
    const code = error instanceof Error && /^stop_[a-z_]+$/u.test(error.message) ? error.message : 'stop_state_unconfirmed'
    return NextResponse.json({ code, error: '停止目标或原队列身份尚未确认，未修改任务或素材' }, { status: 409, headers })
  }
}

/** A request acknowledges intent only. Execution proofs are never browser input. */
export async function POST(request: NextRequest) {
  const auth = requireN8nRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: '请先读取任务状态并确认停止' }, { status: 400, headers })
  try {
    const db = getDatabase()
    const scope = { tenantId: auth.user.tenant_id, workspaceId: auth.user.workspace_id }
    const requested = await requestScopedSingleVideoStop(db, parsed.data, scope, auth.user.id)
    const result = requested.stop && requested.stop.currentState !== 'stopped'
      ? { ...requested, ...advanceScopedVideoStop(db, parsed.data.taskId, requested.stop.requestId, scope) }
      : requested
    try { logAuditEvent({ action: 'n8n_video_stop_requested', actor: auth.user.username, actor_id: auth.user.id,
      target_type: 'n8n_task_run', detail: { taskId: parsed.data.taskId,
        requestId: result.stop?.requestId || null, outcome: result.outcome } }) } catch { /* Lost audit response must not repeat a committed stop. */ }
    return NextResponse.json({ taskId: parsed.data.taskId, ...result }, {
      status: result.outcome === 'already_terminal' || result.stop?.currentState === 'stopped' ? 200 : 202, headers,
    })
  } catch (error) {
    const code = error instanceof Error && /^stop_[a-z_]+$/u.test(error.message) ? error.message : 'stop_not_ready'
    return NextResponse.json({ code, error: '视频状态已变化或停止条件不明，请重新检查；未宣称执行已经停止' }, {
      status: code === 'stop_task_not_found' ? 404 : 409, headers,
    })
  }
}
