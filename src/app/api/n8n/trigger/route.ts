import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, logAuditEvent } from '@/lib/db'
import { requireN8nRole, triggerN8nWebhook } from '@/lib/n8n'
import {
  createN8nTaskRun,
  failN8nTaskRun,
  markN8nTaskAccepted,
  n8nTaskDeliverySchema,
  n8nTaskIdentitySchema,
} from '@/lib/n8n-task-runs'
import {
  loadN8nModelRegistry,
  n8nTaskRoutingOverrideSchema,
  validateTaskRouteIds,
} from '@/lib/n8n-model-routing'
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

  const taskIdResult = n8nTaskIdentitySchema.safeParse(body?.taskId || randomUUID())
  if (!taskIdResult.success) {
    return NextResponse.json({ error: 'taskId 无效', issues: taskIdResult.error.issues }, { status: 400 })
  }
  const idempotencyResult = n8nTaskIdentitySchema.safeParse(body?.idempotencyKey || taskIdResult.data)
  if (!idempotencyResult.success) {
    return NextResponse.json({ error: 'idempotencyKey 无效', issues: idempotencyResult.error.issues }, { status: 400 })
  }
  const deliveryResult = n8nTaskDeliverySchema.safeParse(body?.delivery || { mode: 'none' })
  if (!deliveryResult.success) {
    return NextResponse.json({ error: 'delivery 无效', issues: deliveryResult.error.issues }, { status: 400 })
  }
  const source = body?.source === undefined ? 'video-autoworker' : String(body.source).trim()
  if (!['video-autoworker', 'openclaw'].includes(source)) {
    return NextResponse.json({ error: 'source 只能是 video-autoworker 或 openclaw' }, { status: 400 })
  }
  const taskRoutingResult = n8nTaskRoutingOverrideSchema.safeParse(body?.routing || { nodes: {} })
  if (!taskRoutingResult.success) {
    return NextResponse.json({ error: '模型路由覆盖无效', issues: taskRoutingResult.error.issues }, { status: 400 })
  }
  if (body?.routing !== undefined) {
    const registry = loadN8nModelRegistry()
    if (registry.errors.length) {
      return NextResponse.json({ error: `模型注册表无效：${registry.errors.join('；')}` }, { status: 503 })
    }
    const missingRoutes = validateTaskRouteIds(taskRoutingResult.data, registry)
    if (missingRoutes.length) {
      return NextResponse.json({ error: `模型路由未登记：${missingRoutes.join('、')}` }, { status: 400 })
    }
  }

  const taskId = taskIdResult.data
  const idempotencyKey = idempotencyResult.data
  const routing = {
    id: binding.id,
    name: binding.name,
    taskType: binding.taskType,
    agentRole: binding.agentRole,
    model: binding.model,
    timeoutSeconds: binding.timeoutSeconds,
    retryCount: binding.retryCount,
    config: binding.config,
    ...(body?.routing === undefined ? {} : { taskRouting: taskRoutingResult.data }),
  }
  const created = createN8nTaskRun(db, {
    taskId,
    idempotencyKey,
    bindingId: binding.id,
    source,
    requestedBy: auth.user.username,
    routing,
    taskInput: input as Record<string, unknown>,
    delivery: deliveryResult.data,
    maxAttempts: binding.retryCount + 1,
  }, scope)

  if (!created.created) {
    const status = created.run.status === 'succeeded' ? 200 : 202
    return NextResponse.json({
      taskId: created.run.taskId,
      duplicate: true,
      status: created.run.status,
      output: created.run.status === 'succeeded' ? created.run.output : undefined,
    }, { status })
  }

  const payload = {
    taskId,
    idempotencyKey,
    source,
    requestedBy: auth.user.username,
    routing,
    input: input as Record<string, unknown>,
    delivery: deliveryResult.data,
  }

  try {
    const result = await triggerN8nWebhook(binding.webhookPath, payload, {
      timeoutMs: Math.min(binding.timeoutSeconds * 1_000, 120_000),
      idempotencyKey,
    })
    const runStatus = result.statusCode === 202 ? 'accepted' : 'success'
    markN8nTaskAccepted(db, taskId)
    updateN8nWorkflowRunStatus(db, binding.id, runStatus, scope)
    try {
      logAuditEvent({ action: 'n8n_workflow_trigger', actor: auth.user.username, actor_id: auth.user.id, target_type: 'n8n_workflow_binding', target_id: binding.id, detail: { taskId, statusCode: result.statusCode, latencyMs: result.latencyMs } })
    } catch {
      // n8n already accepted the task; audit failure must not return a retryable 502.
    }
    return NextResponse.json({ taskId, status: 'accepted', result }, { status: 202 })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'n8n 任务执行失败'
    failN8nTaskRun(db, taskId, message)
    updateN8nWorkflowRunStatus(db, binding.id, `failed: ${message}`, scope)
    return NextResponse.json({ taskId, error: message }, { status: 502 })
  }
}
