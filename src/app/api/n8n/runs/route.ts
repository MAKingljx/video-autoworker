import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import {
  getN8nVideoResultDetail,
  getScopedN8nTaskRunByTaskId,
  listN8nVideoResults,
  listN8nTaskRunSummaries,
  listN8nTaskRuns,
  n8nTaskIdentitySchema,
  n8nTaskRunListStatusSchema,
} from '@/lib/n8n-task-runs'
import { getN8nVideoSource } from '@/lib/n8n-video-sources'

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  const db = getDatabase()
  const rawTaskId = request.nextUrl.searchParams.get('taskId')
  const view = request.nextUrl.searchParams.get('view')
  if (view === 'video-results') {
    if (rawTaskId !== null) {
      const taskId = n8nTaskIdentitySchema.safeParse(rawTaskId)
      if (!taskId.success) {
        return NextResponse.json({ error: 'taskId 无效' }, { status: 400 })
      }
      const result = getN8nVideoResultDetail(db, taskId.data, scope)
      if (!result) return NextResponse.json({ error: '未找到视频分析结果' }, { status: 404 })
      const mediaAvailable = Boolean(await getN8nVideoSource(taskId.data))
      return NextResponse.json({ result: { ...result, mediaAvailable } }, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }
    const rawStatus = request.nextUrl.searchParams.get('status')
    const status = rawStatus ? n8nTaskRunListStatusSchema.safeParse(rawStatus) : null
    if (status && !status.success) {
      return NextResponse.json({ error: 'status 无效' }, { status: 400 })
    }
    const query = String(request.nextUrl.searchParams.get('query') || '').trim()
    if (query.length > 120) {
      return NextResponse.json({ error: 'query 最多 120 个字符' }, { status: 400 })
    }
    const limit = Number(request.nextUrl.searchParams.get('limit') || 25)
    const offset = Number(request.nextUrl.searchParams.get('offset') || 0)
    return NextResponse.json(listN8nVideoResults(db, scope, {
      limit: Number.isFinite(limit) ? limit : 25,
      offset: Number.isFinite(offset) ? offset : 0,
      ...(status?.success ? { status: status.data } : {}),
      ...(query ? { query } : {}),
    }), {
      headers: { 'Cache-Control': 'no-store' },
    })
  }
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

  if (view === 'list') {
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
