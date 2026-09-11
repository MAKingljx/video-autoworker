import { NextRequest, NextResponse } from 'next/server'
import { requireN8nRole } from '@/lib/n8n'
import { runDirectorCommand } from '@/lib/director-evidence-outbox'
import { isDirectorBrainScope } from '@/lib/director-brain-scope'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'
import { getDatabase } from '@/lib/db'
import {
  cancelDirectorReviewBatch,
  claimDirectorReviewBatch,
  prepareDirectorReviewBatch,
  recordDirectorReviewBatchItem,
} from '@/lib/director-review-batches'
import {
  directorBrainCommandPort,
  executeDirectorBrainApplicationRequest,
  parseDirectorBrainApplicationRequest,
  type DirectorReviewBatchApplicationInput,
} from '@/lib/director-brain-application-port'

export const runtime = 'nodejs'

function unavailable(): NextResponse {
  return NextResponse.json({
    ok: false,
    code: 'director_brain_application_service_unavailable',
    error: '导演脑服务暂时不可用，请稍后再试',
  }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
}

function runtimeDiagnosticCode(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  return new Set([
    'director_command_input_invalid',
    'director_command_input_too_large',
    'director_command_output_too_large',
    'director_command_result_invalid',
    'director_command_spawn_failed',
    'director_command_stdin_failed',
    'director_command_timeout',
  ]).has(code) ? code : 'director_brain_operation_failed'
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
  const parsed = parseDirectorBrainApplicationRequest(await request.json().catch(() => null))
  if (!parsed) {
    return NextResponse.json({ ok: false, error: '导演脑应用请求无效' }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  const startedAt = Date.now()
  try {
    const reviewBatch = async (input: DirectorReviewBatchApplicationInput) => {
      const db = getDatabase()
      const batch = input.action === 'prepare'
        ? prepareDirectorReviewBatch(db, scope, input)
        : input.action === 'claim'
          ? claimDirectorReviewBatch(db, scope, input)
          : input.action === 'record'
            ? recordDirectorReviewBatchItem(db, scope, input)
            : cancelDirectorReviewBatch(db, scope, input)
      return { ok: true, action: 'review_batch', operation: input.action, batch }
    }
    const result = await executeDirectorBrainApplicationRequest(
      directorBrainCommandPort(runDirectorCommand, reviewBatch), parsed,
    )
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    logger.warn({
      code: runtimeDiagnosticCode(error),
      command: parsed.command,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    }, 'Director brain application operation failed')
    return unavailable()
  }
}
