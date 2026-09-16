import { NextRequest, NextResponse } from 'next/server'
import { authorizeMaterialsRequest } from '../route'
import { getMaterialsGraph } from '@/lib/openclaw-materials'
import { logSafeOperationError, projectSafeOperationError } from '@/lib/operational-errors'
import { MATERIALS_GRAPH_ERROR } from '@/lib/material-graph-errors'

export async function GET(request: NextRequest) {
  const auth = authorizeMaterialsRequest(request, 'viewer')
  if ('response' in auth) return auth.response
  const project = request.nextUrl.searchParams.get('project')?.trim() || undefined
  if (project && (project.length > 256 || /[\x00-\x1f/\\]/u.test(project) || project === '.' || project === '..')) {
    return NextResponse.json({ error: '作品筛选无效', code: 'MATERIAL_GRAPH_PROJECT_INVALID' }, { status: 400 })
  }
  try {
    return NextResponse.json(await getMaterialsGraph({ project }), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    const failure = projectSafeOperationError(error, 'MATERIALS_OVERVIEW_FAILED')
    logSafeOperationError('materials_graph', error, failure)
    return NextResponse.json(MATERIALS_GRAPH_ERROR, { status: 502 })
  }
}
