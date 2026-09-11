import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import { isDirectorBrainScope } from '@/lib/director-brain-scope'
import { mutationLimiter } from '@/lib/rate-limit'
import { directorExtractionHttpFailure } from '@/lib/director-extraction-errors'
import {
  cancelDirectorLearningReview,
  confirmDirectorLearningReview,
  listDirectorLearningReviews,
  prepareDirectorLearningReview,
} from '@/lib/director-extraction-review-application'

export const runtime = 'nodejs'

const selectionShape = {
  requestId: z.string().trim().min(8).max(160).regex(/^[A-Za-z0-9._:-]+$/u),
  reviewId: z.string().regex(/^[a-f0-9]{64}$/u),
  reviewRevision: z.number().int().nonnegative().safe(),
  decision: z.enum(['approve', 'reject']),
  candidateIds: z.array(z.string().regex(/^[a-f0-9]{64}$/u)).min(1).max(50)
    .refine(values => new Set(values).size === values.length),
} as const

const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({
    action: z.literal('prepare'),
    ...selectionShape,
  }).strict(),
  z.object({
    action: z.literal('confirm'),
    ...selectionShape,
    batchId: z.string().regex(/^DRB-[a-f0-9]{32}$/u),
    confirmationCode: z.string().regex(/^[A-Z0-9]{6,12}$/u),
    count: z.number().int().min(1).max(50),
  }).strict(),
  z.object({
    action: z.literal('cancel'),
    batchId: z.string().regex(/^DRB-[a-f0-9]{32}$/u),
    confirmationCode: z.string().regex(/^[A-Z0-9]{6,12}$/u),
  }).strict(),
])

function actorKey(user: { id: number; username: string }): string {
  return `platform:${user.id}:${String(user.username || '').normalize('NFKC').slice(0, 120)}`
}

export async function POST(request: NextRequest) {
  const auth = requireN8nRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  if (!isDirectorBrainScope(scope)) {
    return NextResponse.json({
      ok: false,
      code: 'director_brain_scope_forbidden',
      error: '当前工作区不属于已配置的导演脑',
    }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
  }
  const limited = mutationLimiter(request)
  if (limited) return limited
  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({
      ok: false,
      action: 'invalid',
      outcome: 'conflict',
      code: 'director_extraction_review_request_invalid',
      error: '学习审核请求无效',
    }, { status: 400, headers: { 'Cache-Control': 'no-store' } })
  }
  const db = getDatabase()
  try {
    if (parsed.data.action === 'list') {
      const reviews = await listDirectorLearningReviews(db, scope)
      return NextResponse.json({ ok: true, action: 'list', reviews }, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }
    if (parsed.data.action === 'prepare') {
      const result = await prepareDirectorLearningReview(
        db, scope, actorKey(auth.user), parsed.data,
      )
      return NextResponse.json({ ok: true, action: 'prepare', ...result }, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }
    if (parsed.data.action === 'cancel') {
      const result = cancelDirectorLearningReview(
        db, scope, actorKey(auth.user), parsed.data,
      )
      return NextResponse.json({ ok: true, action: 'cancel', ...result }, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }
    const result = await confirmDirectorLearningReview(
      db, scope, actorKey(auth.user), parsed.data,
    )
    return NextResponse.json({
      ok: result.outcome === 'completed',
      action: 'confirm',
      ...result,
    }, {
      status: result.outcome === 'completed' ? 200 : result.outcome === 'conflict' ? 409 : 503,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    const failure = directorExtractionHttpFailure(error)
    return NextResponse.json({
      ok: false,
      action: parsed.data.action,
      ...(parsed.data.action === 'confirm'
        ? { outcome: failure.status === 409 ? 'conflict' : 'unknown' } : {}),
      code: failure.code,
      error: failure.message,
    }, { status: failure.status, headers: { 'Cache-Control': 'no-store' } })
  }
}
