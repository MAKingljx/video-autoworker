import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/db'
import { verifyN8nWebhookSecret } from '@/lib/n8n'
import {
  claimScopedN8nVideoTaskRun,
  n8nTaskIdentitySchema,
} from '@/lib/n8n-task-runs'

export const runtime = 'nodejs'

const claimRequestSchema = z.object({
  taskId: n8nTaskIdentitySchema,
  idempotencyKey: n8nTaskIdentitySchema,
  bindingId: z.number().int().positive(),
  workspaceId: z.number().int().positive(),
  tenantId: z.number().int().positive(),
}).strict()

export async function POST(request: NextRequest) {
  if (!verifyN8nWebhookSecret(request.headers.get('X-AIWorker-Webhook-Secret'))) {
    return NextResponse.json({ error: 'n8n 父任务认领认证失败' }, { status: 401 })
  }

  const body = await request.json().catch(() => null)
  const parsed = claimRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '父任务认领请求无效', issues: parsed.error.issues }, { status: 400 })
  }

  const { taskId, idempotencyKey, bindingId, workspaceId, tenantId } = parsed.data
  const result = claimScopedN8nVideoTaskRun(
    getDatabase(),
    { taskId, idempotencyKey, bindingId },
    { workspaceId, tenantId },
  )

  if (result.outcome === 'claimed' || result.outcome === 'running') {
    return NextResponse.json({
      taskId,
      status: 'running',
      claimed: result.outcome === 'claimed',
      duplicate: result.outcome === 'running',
    }, { headers: { 'Cache-Control': 'no-store' } })
  }
  if (result.outcome === 'not_found') {
    return NextResponse.json({ error: '未找到可认领的父任务' }, { status: 404 })
  }
  if (result.outcome === 'terminal') {
    return NextResponse.json({
      taskId,
      status: result.run?.status || 'terminal',
      error: result.run?.error || '父任务已进入终态',
    }, { status: 409 })
  }
  return NextResponse.json({ error: '父任务身份、作用域或任务链类型不匹配' }, { status: 409 })
}
