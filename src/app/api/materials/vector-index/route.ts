import { NextRequest, NextResponse } from 'next/server'
import { authorizeMaterialsRequest } from '../route'
import { indexMaterialVectors } from '@/lib/openclaw-materials'
import { logSafeOperationError, projectSafeOperationError } from '@/lib/operational-errors'

export async function POST(request: NextRequest) {
  const auth = authorizeMaterialsRequest(request, 'admin')
  if ('response' in auth) return auth.response

  let body: { project?: string; maxChunks?: number }
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  try {
    const result = await indexMaterialVectors({
      project: body.project || undefined,
      maxChunks: Number(body.maxChunks || 0),
    })
    return NextResponse.json({ result }, {
      status: result.ok ? 200 : 207,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const failure = projectSafeOperationError(error, 'MATERIALS_VECTOR_INDEX_FAILED')
    logSafeOperationError('materials_vector_index', error, failure)
    return NextResponse.json({ code: failure.code, error: failure.summary }, { status: 502 })
  }
}
