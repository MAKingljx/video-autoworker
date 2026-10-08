import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import { mutationLimiter } from '@/lib/rate-limit'
import { videoEditingEnabled } from '@/lib/database-capabilities'
import { cancelApprovedEditTask } from '@/lib/editing/edit-task-service'
import { isEditReviewBrowser } from '@/lib/editing/edit-review'
import { n8nTaskIdentitySchema } from '@/lib/n8n-task-runs'

const schema = z.object({ action: z.literal('cancel'), taskId: n8nTaskIdentitySchema, expectedPlanSha256: z.string().regex(/^[a-f0-9]{64}$/u) }).strict()
export async function POST(request: NextRequest) {
  const auth = requireN8nRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  if (!videoEditingEnabled()) return NextResponse.json({ error: '剪辑任务尚未开放' }, { status: 503 })
  if (!isEditReviewBrowser(request)) return NextResponse.json({ error: '请在任务页面确认取消' }, { status: 403 })
  const limited = mutationLimiter(request); if (limited) return limited
  const body = schema.safeParse(await request.json().catch(() => null))
  if (!body.success) return NextResponse.json({ error: '取消请求无效' }, { status: 400 })
  try {
    return NextResponse.json(cancelApprovedEditTask(getDatabase(), body.data.taskId, body.data.expectedPlanSha256,
      { tenantId: auth.user.tenant_id, workspaceId: auth.user.workspace_id }))
  } catch (error) {
    return NextResponse.json({ code: error instanceof Error ? error.message : 'video_edit_cancel_failed',
      error: '任务正在执行或状态已变化，请先核对当前步骤' }, { status: 409 })
  }
}
