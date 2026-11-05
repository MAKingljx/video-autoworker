import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/db'
import { getOpenClawN8nOperatorUser } from '@/lib/auth'
import { createN8nCoverFrameCandidates } from '@/lib/n8n-cover-frame-candidates'

export const runtime = 'nodejs'

const requestSchema = z.object({
  query: z.string().trim().min(1).max(120),
  segmentIndexes: z.array(z.number().int().positive()).length(1),
}).strict().superRefine((value, context) => {
  if (new Set(value.segmentIndexes).size !== value.segmentIndexes.length) {
    context.addIssue({ code: 'custom', path: ['segmentIndexes'], message: '片段编号重复' })
  }
})
const noStore = { 'Cache-Control': 'no-store' }

const safeError = (error: unknown): { errorCode: string; status: number } => {
  const code = error instanceof Error ? error.message : ''
  if (code === 'cover_frame_video_ambiguous') return { errorCode: 'N8N_COVER_FRAME_VIDEO_AMBIGUOUS', status: 409 }
  if (code === 'cover_frame_video_not_found') return { errorCode: 'N8N_COVER_FRAME_VIDEO_NOT_FOUND', status: 404 }
  if (code === 'cover_frame_learning_result_unavailable') return { errorCode: 'N8N_COVER_FRAME_LEARNING_RESULT_UNAVAILABLE', status: 404 }
  if (code === 'cover_frame_segment_unavailable') return { errorCode: 'N8N_COVER_FRAME_SEGMENT_UNAVAILABLE', status: 404 }
  if (code === 'cover_frame_original_unavailable') return { errorCode: 'N8N_COVER_FRAME_ORIGINAL_UNAVAILABLE', status: 404 }
  if (code.startsWith('cover_frame_')) {
    return { errorCode: 'N8N_COVER_FRAME_EXTRACTION_FAILED', status: 409 }
  }
  return { errorCode: 'N8N_COVER_FRAME_UNAVAILABLE', status: 503 }
}

export async function POST(request: NextRequest) {
  const user = getOpenClawN8nOperatorUser(request)
  if (!user) return NextResponse.json({ errorCode: 'openclaw_loopback_operator_required' }, { status: 403, headers: noStore })
  const body = await request.json().catch(() => null)
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ errorCode: 'cover_frame_request_invalid' }, { status: 400, headers: noStore })
  try {
    const result = await createN8nCoverFrameCandidates(
      getDatabase(), { workspaceId: user.workspace_id, tenantId: user.tenant_id }, parsed.data,
      undefined, { signal: request.signal },
    )
    return NextResponse.json(result, {
      headers: noStore,
    })
  } catch (error) {
    const safe = safeError(error)
    return NextResponse.json({ errorCode: safe.errorCode }, { status: safe.status,
      headers: noStore })
  }
}
