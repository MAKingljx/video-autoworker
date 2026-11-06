import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/db'
import { getOpenClawN8nOperatorUser } from '@/lib/auth'
import { createN8nCoverFrameCandidates } from '@/lib/n8n-cover-frame-candidates'
import { readN8nVideoCoverDirectory } from '@/lib/n8n-video-cover-workflow'

export const runtime = 'nodejs'

const query = z.string().trim().min(1).max(120)
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('segments'), query }).strict(),
  z.object({ action: z.literal('frames'), query, segmentIndex: z.number().int().positive() }).strict(),
])
const noStore = { 'Cache-Control': 'no-store' }

const safeError = (error: unknown): { errorCode: string; status: number } => {
  const code = error instanceof Error ? error.message : ''
  if (code === 'cover_workflow_video_ambiguous' || code === 'cover_frame_video_ambiguous') {
    return { errorCode: 'N8N_COVER_WORKFLOW_VIDEO_AMBIGUOUS', status: 409 }
  }
  if (code === 'cover_workflow_video_not_found' || code === 'cover_frame_video_not_found') {
    return { errorCode: 'N8N_COVER_WORKFLOW_VIDEO_NOT_FOUND', status: 404 }
  }
  if (code === 'cover_workflow_learning_result_unavailable' || code === 'cover_frame_learning_result_unavailable') {
    return { errorCode: 'N8N_COVER_WORKFLOW_LEARNING_RESULT_UNAVAILABLE', status: 404 }
  }
  if (code === 'cover_frame_segment_unavailable') return { errorCode: 'N8N_COVER_WORKFLOW_SEGMENT_UNAVAILABLE', status: 404 }
  if (code === 'cover_frame_original_unavailable') return { errorCode: 'N8N_COVER_WORKFLOW_ORIGINAL_UNAVAILABLE', status: 404 }
  if (code.startsWith('cover_')) return { errorCode: 'N8N_COVER_WORKFLOW_UNAVAILABLE', status: 409 }
  return { errorCode: 'N8N_COVER_WORKFLOW_UNAVAILABLE', status: 503 }
}

export async function POST(request: NextRequest) {
  const user = getOpenClawN8nOperatorUser(request)
  if (!user) return NextResponse.json({ errorCode: 'openclaw_loopback_operator_required' }, { status: 403, headers: noStore })
  const body = await request.json().catch(() => null)
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) return NextResponse.json({ errorCode: 'cover_workflow_request_invalid' }, { status: 400, headers: noStore })
  const scope = { workspaceId: user.workspace_id, tenantId: user.tenant_id }
  try {
    if (parsed.data.action === 'segments') {
      const result = readN8nVideoCoverDirectory(getDatabase(), scope, { query: parsed.data.query })
      return NextResponse.json({ action: 'segments', ...result }, { headers: noStore })
    }
    const result = await createN8nCoverFrameCandidates(
      getDatabase(), scope, { query: parsed.data.query, segmentIndexes: [parsed.data.segmentIndex] },
      undefined, { signal: request.signal },
    )
    return NextResponse.json(result, { headers: noStore })
  } catch (error) {
    const safe = safeError(error)
    return NextResponse.json({ errorCode: safe.errorCode }, { status: safe.status, headers: noStore })
  }
}
