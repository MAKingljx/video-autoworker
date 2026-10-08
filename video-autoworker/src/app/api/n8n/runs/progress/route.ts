import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import { n8nTaskIdentitySchema } from '@/lib/n8n-task-runs'
import { getScopedLearningProgress } from '@/lib/n8n-learning-progress'

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const taskId = n8nTaskIdentitySchema.safeParse(request.nextUrl.searchParams.get('taskId'))
  if (!taskId.success) return NextResponse.json({ error: '任务编号无效' }, { status: 400 })
  const progress = await getScopedLearningProgress(getDatabase(), taskId.data, {
    tenantId: auth.user.tenant_id, workspaceId: auth.user.workspace_id,
  })
  return progress ? NextResponse.json({ progress }, { headers: { 'Cache-Control': 'no-store' } })
    : NextResponse.json({ error: '未找到视频学习任务' }, { status: 404 })
}
