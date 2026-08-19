import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import {
  getScopedN8nTaskRunByTaskId,
  listN8nTaskRunSummaries,
  listN8nTaskRuns,
  n8nTaskIdentitySchema,
  n8nTaskRunListStatusSchema,
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

  if (request.nextUrl.searchParams.get('view') === 'list') {
    const rawStatus = request.nextUrl.searchParams.get('status')
    const status = rawStatus ? n8nTaskRunListStatusSchema.safeParse(rawStatus) : null
    if (status && !status.success) {
      return NextResponse.json({ error: 'status 无效' }, { status: 400 })
    }
    const query = String(request.nextUrl.searchParams.get('query') || '').trim()
    if (query.length > 120) {
      return NextResponse.json({ error: 'query 最多 120 个字符' }, { status: 400 })
    }
    const limit = Number(request.nextUrl.searchParams.get('limit') || 50)
    const offset = Number(request.nextUrl.searchParams.get('offset') || 0)
    const result = listN8nTaskRunSummaries(db, scope, {
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
      ...(status?.success ? { status: status.data } : {}),
      ...(query ? { query } : {}),
    })
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }

  const limit = Number(request.nextUrl.searchParams.get('limit') || 50)
  return NextResponse.json({ runs: listN8nTaskRuns(db, scope, limit) }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
