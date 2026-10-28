import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import { n8nTaskIdentitySchema } from '@/lib/n8n-task-runs'
import { acknowledgeScopedVideoBatchStop } from '@/lib/n8n-video-stop'
import { mutationLimiter } from '@/lib/rate-limit'

export const runtime = 'nodejs'
const schema = z.object({ taskId: n8nTaskIdentitySchema, requestId: z.string().regex(/^[a-f0-9]{64}$/u),
  workerLease: z.object({ pid: z.number().int().positive(), token: z.uuid() }).strict(),
}).strict()

export async function POST(request: NextRequest) {
  const auth = requireN8nRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ code: 'stop_batch_ack_invalid', error: '队列停止确认身份无效' }, { status: 400 })
  try {
    const result = await acknowledgeScopedVideoBatchStop(getDatabase(), parsed.data,
      { tenantId: auth.user.tenant_id, workspaceId: auth.user.workspace_id })
    try { logAuditEvent({ action: 'n8n_video_batch_stop_ack', actor: auth.user.username, actor_id: auth.user.id,
      target_type: 'n8n_task_run', detail: { taskId: parsed.data.taskId, requestId: parsed.data.requestId,
        currentState: result.stop.currentState } }) } catch { /* Never repeat a committed acknowledgement for audit delivery. */ }
    return NextResponse.json({ taskId: parsed.data.taskId, ...result }, {
      status: result.stop.currentState === 'stopped' ? 200 : 202, headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const code = error instanceof Error && /^stop_[a-z_]+$/u.test(error.message) ? error.message : 'stop_batch_ack_unconfirmed'
    return NextResponse.json({ code, error: '原队列锁、目标或退出证据尚未确认，保留原停止请求及素材' }, {
      status: code === 'stop_request_not_found' ? 404 : 409, headers: { 'Cache-Control': 'no-store' },
    })
  }
}
