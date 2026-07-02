import { NextRequest, NextResponse } from 'next/server'
import { authorizeMaterialsRequest } from '../route'
import { searchMaterials, type MaterialSearchMode } from '@/lib/openclaw-materials'

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
    return NextResponse.json({
      error: error instanceof Error ? error.message : '素材搜索失败',
    }, { status: 502 })
  }
}

function normalizeMode(value: string | null): MaterialSearchMode {
  if (value === 'vector' || value === 'hybrid') return value
  return 'keyword'
}
