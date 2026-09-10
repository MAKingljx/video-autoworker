import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireN8nRole } from '@/lib/n8n'
import { runDirectorCommand } from '@/lib/director-evidence-outbox'
import { isDirectorBrainScope } from '@/lib/director-brain-scope'
import { mutationLimiter } from '@/lib/rate-limit'
import { logger } from '@/lib/logger'

export const runtime = 'nodejs'

const requestSchema = z.object({
  command: z.enum(['operate', 'review']),
  input: z.record(z.string(), z.unknown()),
}).strict()

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
  const parsed = requestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: '导演脑应用请求无效' }, {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    })
  }
  const startedAt = Date.now()
  try {
    const result = await runDirectorCommand(parsed.data.command, parsed.data.input)
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    logger.warn({
      code: runtimeDiagnosticCode(error),
      command: parsed.data.command,
      elapsedMs: Math.max(0, Date.now() - startedAt),
    }, 'Director brain application operation failed')
    return unavailable()
  }
}
