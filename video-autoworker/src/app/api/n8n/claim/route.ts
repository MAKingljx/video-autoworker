import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/db'
import { checkN8nCallbackAdmission } from '@/lib/n8n-runtime-affinity'
import { checkOpenClawN8nCallbackRequest } from '@/lib/openclaw-loopback-auth'
import {
  claimScopedN8nTaskRun,
  getN8nTaskRunByTaskId,
  n8nExecutionOwnerSchema,
  n8nTaskIdentitySchema,
} from '@/lib/n8n-task-runs'

export const runtime = 'nodejs'

const claimRequestSchema = z.object({
  taskId: n8nTaskIdentitySchema,
  idempotencyKey: n8nTaskIdentitySchema,
  bindingId: z.number().int().positive(),
  workspaceId: z.number().int().positive(),
  tenantId: z.number().int().positive(),
  executionOwner: n8nExecutionOwnerSchema,
}).strict()

export async function POST(request: NextRequest) {
  const channel = checkOpenClawN8nCallbackRequest(request, '/api/n8n/claim')
  if (!channel.allowed) return NextResponse.json({ error: channel.error }, { status: channel.status })
  const body = await request.json().catch(() => null)
  const parsed = claimRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '父任务认领请求无效', issues: parsed.error.issues }, { status: 400 })
  }

  const { taskId, idempotencyKey, bindingId, workspaceId, tenantId, executionOwner } = parsed.data
  const db = getDatabase()
  const parent = getN8nTaskRunByTaskId(db, taskId)
  if (!parent) return NextResponse.json({ error: '未找到可认领的父任务' }, { status: 404 })
  const admission = checkN8nCallbackAdmission(parent.routing)
  if (!admission.allowed) {
    return NextResponse.json({ taskId, error: admission.error, code: admission.code }, { status: 409 })
  }
  const result = claimScopedN8nTaskRun(
    db,
    { taskId, idempotencyKey, bindingId, executionOwner },
    { workspaceId, tenantId },
  )

  if (result.outcome === 'claimed' || result.outcome === 'owned' || result.outcome === 'running') {
    const ownsDelivery = result.outcome === 'claimed' || result.outcome === 'owned'
    return NextResponse.json({
      taskId,
      status: 'running',
      claimed: ownsDelivery,
      resumed: result.outcome === 'owned',
      duplicate: !ownsDelivery,
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
