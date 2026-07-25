import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { requireN8nRole, triggerN8nWebhook } from '@/lib/n8n'
import { getN8nWorkflowBinding, updateN8nWorkflowRunStatus } from '@/lib/n8n-workflows'
import { mutationLimiter } from '@/lib/rate-limit'

export async function POST(request: NextRequest) {
  const auth = requireN8nRole(request, 'operator')
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status })
  const limited = mutationLimiter(request)
  if (limited) return limited

  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  const bindingId = Number(body?.bindingId)
  if (!Number.isInteger(bindingId) || bindingId <= 0) {
    return NextResponse.json({ error: '缺少有效的任务链 ID' }, { status: 400 })
  }
  const input = body?.input
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return NextResponse.json({ error: 'input 必须是 JSON 对象' }, { status: 400 })
  }

  const db = getDatabase()
  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  const binding = getN8nWorkflowBinding(db, bindingId, scope)
  if (!binding) return NextResponse.json({ error: '未找到任务链' }, { status: 404 })
  if (!binding.enabled) return NextResponse.json({ error: '任务链当前已停用' }, { status: 409 })

  const taskId = String(body?.taskId || randomUUID())
  const idempotencyKey = String(body?.idempotencyKey || taskId)
  const payload = {
    taskId,
    idempotencyKey,
    source: 'video-autoworker',
    requestedBy: auth.user.username,
    routing: {
      id: binding.id,
      name: binding.name,
      taskType: binding.taskType,
      agentRole: binding.agentRole,
      model: binding.model,
      timeoutSeconds: binding.timeoutSeconds,
      retryCount: binding.retryCount,
      config: binding.config,
    },
    input: input as Record<string, unknown>,
  }

  try {
    const result = await triggerN8nWebhook(binding.webhookPath, payload, {
      timeoutMs: Math.min(binding.timeoutSeconds * 1_000, 120_000),
      idempotencyKey,
    })
    const runStatus = result.statusCode === 202 ? 'accepted' : 'success'
    updateN8nWorkflowRunStatus(db, binding.id, runStatus, scope)
    try {
      logAuditEvent({ action: 'n8n_workflow_trigger', actor: auth.user.username, actor_id: auth.user.id, target_type: 'n8n_workflow_binding', target_id: binding.id, detail: { taskId, statusCode: result.statusCode, latencyMs: result.latencyMs } })
    } catch {
      // n8n already accepted the task; audit failure must not return a retryable 502.
    }
    return NextResponse.json({ taskId, result })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'n8n 任务执行失败'
    updateN8nWorkflowRunStatus(db, binding.id, `failed: ${message}`, scope)
    return NextResponse.json({ taskId, error: message }, { status: 502 })
  }
}
