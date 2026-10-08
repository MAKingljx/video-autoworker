import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import { updateN8nWorkflowLearningWindow } from '@/lib/n8n-workflows'
import { VIDEO_LEARNING_SEGMENT_MIN_SECONDS, VIDEO_LEARNING_SEGMENT_MAX_SECONDS } from '@/lib/n8n-media-config'
import { mutationLimiter } from '@/lib/rate-limit'

const seconds = z.number().int().min(VIDEO_LEARNING_SEGMENT_MIN_SECONDS).max(VIDEO_LEARNING_SEGMENT_MAX_SECONDS)
const requestSchema = z.object({
  bindingId: z.number().int().positive(), segmentSeconds: seconds, expectedSegmentSeconds: seconds,
}).strict()

export async function PUT(request: NextRequest) {
  const auth = requireN8nRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited
  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: '学习窗口必须是1到300秒之间的整数' }, { status: 400 })
  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  let result: ReturnType<typeof updateN8nWorkflowLearningWindow>
  try {
    result = updateN8nWorkflowLearningWindow(getDatabase(), parsed.data.bindingId,
      parsed.data.segmentSeconds, parsed.data.expectedSegmentSeconds, scope)
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: '现有学习配置无效，请检查任务链配置' }, { status: 400 })
    throw error
  }
  if (result.outcome === 'not_found') return NextResponse.json({ error: '未找到任务链' }, { status: 404 })
  if (result.outcome === 'unsupported') return NextResponse.json({ error: '只有视频学习任务链支持学习窗口' }, { status: 400 })
  if (result.outcome === 'conflict') return NextResponse.json({ error: '学习窗口已被修改，请刷新后再保存' }, { status: 409 })
  if (result.outcome === 'updated') {
    try {
      logAuditEvent({
        action: 'n8n_learning_window_update', target_type: 'n8n_workflow_binding', target_id: parsed.data.bindingId,
        actor: auth.user.username, actor_id: auth.user.id,
        detail: { before: parsed.data.expectedSegmentSeconds, after: parsed.data.segmentSeconds },
      })
    } catch {
      // The scoped setting already committed; keep retries from obscuring it.
    }
  }
  return NextResponse.json({ binding: result.binding, changed: result.outcome === 'updated' }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
