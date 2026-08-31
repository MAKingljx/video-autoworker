import { NextRequest, NextResponse } from 'next/server'
import { authorizeMaterialsRequest } from '../route'
import { searchMaterials, type MaterialSearchMode } from '@/lib/openclaw-materials'
import { logSafeOperationError, projectSafeOperationError } from '@/lib/operational-errors'

export async function GET(request: NextRequest) {
  const auth = authorizeMaterialsRequest(request, 'viewer')
  if ('response' in auth) return auth.response

  const query = request.nextUrl.searchParams.get('q') || ''
  const project = request.nextUrl.searchParams.get('project') || undefined
  const mode = normalizeMode(request.nextUrl.searchParams.get('mode'))
  const limit = Number(request.nextUrl.searchParams.get('limit') || 20)

  try {
    const results = await searchMaterials({ query, project, mode, limit })
    return NextResponse.json(results, {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const failure = projectSafeOperationError(error, 'MATERIALS_SEARCH_FAILED')
    logSafeOperationError('materials_search', error, failure)
    return NextResponse.json({ code: failure.code, error: failure.summary }, { status: 502 })
  }
}

function normalizeMode(value: string | null): MaterialSearchMode {
  if (value === 'vector' || value === 'hybrid') return value
  return 'keyword'
}
