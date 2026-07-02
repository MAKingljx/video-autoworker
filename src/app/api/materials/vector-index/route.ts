import { NextRequest, NextResponse } from 'next/server'
import { authorizeMaterialsRequest } from '../route'
import { indexMaterialVectors } from '@/lib/openclaw-materials'

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
    return NextResponse.json({
      error: error instanceof Error ? error.message : '向量索引失败',
    }, { status: 502 })
  }
}
