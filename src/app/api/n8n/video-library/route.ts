import { NextRequest, NextResponse } from 'next/server'
import { getDatabase } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import { searchN8nVideoResults } from '@/lib/n8n-task-runs'
import { listN8nVideoSources } from '@/lib/n8n-video-sources'

export async function GET(request: NextRequest) {
  const auth = requireN8nRole(request, 'viewer')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const query = String(request.nextUrl.searchParams.get('q') || '').trim()
  if (!query) return NextResponse.json({ error: '请输入检索关键词' }, { status: 400 })
  if (query.length > 120) return NextResponse.json({ error: '关键词最多 120 个字符' }, { status: 400 })
  const rawLimit = Number(request.nextUrl.searchParams.get('limit') || 80)
  const result = searchN8nVideoResults(
    getDatabase(),
    { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id },
    query,
    Number.isFinite(rawLimit) ? rawLimit : 80,
  )
  const sources = await listN8nVideoSources()
  const playableVideos = new Set(result.hits.filter(hit => sources.has(hit.taskId)).map(hit => hit.taskId)).size
  return NextResponse.json({
    ...result,
    playableVideos,
    hits: result.hits.map(hit => ({ ...hit, mediaAvailable: sources.has(hit.taskId) })),
  }, {
    headers: { 'Cache-Control': 'no-store' },
  })
}
