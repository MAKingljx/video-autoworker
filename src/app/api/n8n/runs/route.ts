import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import {
  getScopedN8nTaskRunByTaskId,
  listN8nTaskRuns,
  n8nTaskIdentitySchema,
} from '@/lib/n8n-task-runs'

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  const db = getDatabase()
  const rawTaskId = request.nextUrl.searchParams.get('taskId')
  if (rawTaskId !== null) {
    const taskId = n8nTaskIdentitySchema.safeParse(rawTaskId)
    if (!taskId.success) {
      return NextResponse.json({ error: 'taskId 无效' }, { status: 400 })
    }
    const run = getScopedN8nTaskRunByTaskId(db, taskId.data, scope)
    return NextResponse.json({ runs: run ? [run] : [] }, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const limit = Number(request.nextUrl.searchParams.get('limit') || 50)
  return NextResponse.json({ runs: listN8nTaskRuns(db, scope, limit) }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
