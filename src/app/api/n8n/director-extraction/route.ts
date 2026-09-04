import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/db'
import { requireN8nRole } from '@/lib/n8n'
import {
  backfillDirectorExtractionForWork,
  getDirectorExtractionStatusForWork,
  startDirectorExtractionForWork,
} from '@/lib/director-extraction-application'
import { projectDirectorExtractionStatus } from '@/lib/director-extraction-runs'
import { directorExtractionHttpFailure } from '@/lib/director-extraction-errors'
import { mutationLimiter } from '@/lib/rate-limit'
import { isDirectorBrainScope } from '@/lib/director-brain-scope'
import { isDirectorExtractionAcceptedStatus } from '@/lib/director-extraction-state'

export const runtime = 'nodejs'

const workIdSchema = z.string().trim().min(1).max(160)
  .regex(/^[A-Za-z0-9._:-]+$/u)
const sourceQuerySchema = z.string().trim().min(1).max(120)
const objectiveSchema = z.string().trim().min(1).max(500)

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('start_extraction'),
    workId: workIdSchema,
    sourceQuery: sourceQuerySchema.optional(),
    objective: objectiveSchema.optional(),
  }).strict(),
  z.object({
    action: z.literal('extraction_status'),
    workId: workIdSchema,
  }).strict(),
  z.object({
    action: z.literal('backfill_extraction'),
    workId: workIdSchema,
  }).strict(),
])

function errorResponse(error: unknown): NextResponse {
  const failure = directorExtractionHttpFailure(error)
  return NextResponse.json({ ok: false, code: failure.code, error: failure.message }, {
    status: failure.status,
    headers: { 'Cache-Control': 'no-store' },
  })
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
    }, { status: 403 })
  }
  const limited = mutationLimiter(request)
  if (limited) return limited
  const body = await request.json().catch(() => null)
  const parsed = requestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: '导演提炼请求无效' }, { status: 400 })
  }
  const db = getDatabase()
  try {
    if (parsed.data.action === 'extraction_status') {
      const status = getDirectorExtractionStatusForWork(db, scope, parsed.data.workId)
      if (!status) {
        return NextResponse.json({
          ok: true,
          action: parsed.data.action,
          found: false,
          message: '这部作品还没有开始导演知识提炼',
        }, { headers: { 'Cache-Control': 'no-store' } })
      }
      return NextResponse.json({ ok: true, action: parsed.data.action, found: true, ...status }, {
        headers: { 'Cache-Control': 'no-store' },
      })
    }

    if (parsed.data.action === 'backfill_extraction') {
      const result = await backfillDirectorExtractionForWork(db, scope, parsed.data)
      return NextResponse.json({
        ok: true,
        action: parsed.data.action,
        accepted: Number(result.registered || 0) > 0,
        ...result,
      }, {
        status: Number(result.registered || 0) > 0 ? 202 : 200,
        headers: { 'Cache-Control': 'no-store' },
      })
    }

    const job = await startDirectorExtractionForWork(db, scope, parsed.data)
    const accepted = isDirectorExtractionAcceptedStatus(job.status)
    return NextResponse.json({
      ok: true,
      action: parsed.data.action,
      accepted,
      ...projectDirectorExtractionStatus(db, job),
    }, {
      status: accepted ? 202 : 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    return errorResponse(error)
  }
}
