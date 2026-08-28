import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import {
  n8nTaskIdentitySchema,
  reconcileScopedN8nVideoTaskRun,
} from '@/lib/n8n-task-runs'
import { mutationLimiter } from '@/lib/rate-limit'

const reconcileRequestSchema = z.object({
  taskId: n8nTaskIdentitySchema,
}).strict()

export async function POST(request: NextRequest) {
  const auth = requireN8nRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited

  const body = await request.json().catch(() => null)
  const parsed = reconcileRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '任务标识无效', issues: parsed.error.issues }, { status: 400 })
  }

  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  const result = reconcileScopedN8nVideoTaskRun(getDatabase(), parsed.data.taskId, scope)
  if (result.outcome === 'not_found') {
    return NextResponse.json({ error: '未找到任务运行记录' }, { status: 404 })
  }
  if (result.outcome === 'ineligible') {
    return NextResponse.json({
      taskId: parsed.data.taskId,
      error: '任务不是可收敛的视频运行状态',
    }, { status: 409 })
  }

  if (result.outcome === 'reconciled') {
    try {
      logAuditEvent({
        action: 'n8n_video_run_reconcile',
        actor: auth.user.username,
        actor_id: auth.user.id,
        target_type: 'n8n_task_run',
        target_id: result.run?.id,
        detail: { task_id: parsed.data.taskId, code: result.code, previous_status: 'accepted_or_running' },
      })
    } catch {
      // The run is already terminal; audit failure must not invite a retry.
    }
  }

  return NextResponse.json({
    taskId: parsed.data.taskId,
    status: result.run?.status,
    error: result.run?.error,
    reconciled: result.outcome === 'reconciled',
    code: result.code,
  }, { headers: { 'Cache-Control': 'no-store' } })
}
