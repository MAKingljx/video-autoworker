import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import { mutationLimiter } from '@/lib/rate-limit'
import { n8nTaskIdentitySchema } from '@/lib/n8n-task-runs'
import { approveEditPlan, getEditPlanStatus, saveValidatedEditPlan } from '@/lib/editing/edit-task-service'

export const runtime = 'nodejs'

const postSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('propose'), plan: z.unknown() }).strict(),
  z.object({
    action: z.literal('approve'), planId: z.string().trim().min(1).max(160),
    revision: z.number().int().positive(), expectedPlanSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    taskId: n8nTaskIdentitySchema, bindingId: z.number().int().positive(),
  }).strict(),
])

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const planId = request.nextUrl.searchParams.get('planId') || ''
  const revision = Number(request.nextUrl.searchParams.get('revision'))
  if (!planId || planId.length > 160 || !Number.isSafeInteger(revision) || revision < 1) {
    return NextResponse.json({ error: '剪辑计划查询参数无效' }, { status: 400 })
  }
  try {
    const status = getEditPlanStatus(getDatabase(), planId, revision, {
      tenantId: auth.user.tenant_id, workspaceId: auth.user.workspace_id,
    })
    return status
      ? NextResponse.json(status, { headers: { 'Cache-Control': 'no-store' } })
      : NextResponse.json({ error: '未找到剪辑计划' }, { status: 404 })
  } catch {
    return NextResponse.json({ error: '剪辑计划状态暂不可用' }, { status: 503 })
  }
}

export async function POST(request: NextRequest) {
  const auth = requireN8nRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  // Planning is present for isolated validation, but no production scheduler
  // or verified Resolve write transport is registered yet.
  if (process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED !== '1') {
    return NextResponse.json({ code: 'VIDEO_EDIT_NOT_READY', error: '剪辑任务尚未开放' }, { status: 503 })
  }
  const limited = mutationLimiter(request)
  if (limited) return limited
  const parsed = postSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: '剪辑计划请求无效' }, { status: 400 })
  const scope = { tenantId: auth.user.tenant_id, workspaceId: auth.user.workspace_id }
  try {
    const db = getDatabase()
    if (parsed.data.action === 'propose') {
      const plan = saveValidatedEditPlan(db, parsed.data.plan, scope)
      return NextResponse.json({ planId: plan.planId, revision: plan.revision,
        planSha256: plan.planSha256, status: 'validated' }, { status: 201 })
    }
    const result = approveEditPlan(db, { ...parsed.data, approvedBy: auth.user.username }, scope)
    return NextResponse.json({
      planId: result.plan.planId, revision: result.plan.revision,
      planSha256: result.plan.planSha256, taskId: result.taskId,
      status: 'queued', duplicate: result.duplicate,
    }, { status: result.duplicate ? 200 : 201 })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'video_edit_request_failed'
    const status = code === 'video_edit_intake_paused' ? 423
      : code === 'video_edit_plan_not_found' ? 404
        : code === 'video_edit_plan_not_validated' ? 400 : 409
    return NextResponse.json({ code, error: '剪辑计划未变更，请检查计划版本、任务链及当前状态' }, { status })
  }
}
