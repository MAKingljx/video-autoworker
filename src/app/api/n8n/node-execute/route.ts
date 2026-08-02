import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/db'
import { verifyN8nWebhookSecret } from '@/lib/n8n'
import { executeN8nModelRoute, n8nModelExecutionError } from '@/lib/n8n-model-execution'
import { resolveN8nNodeRoute } from '@/lib/n8n-model-routing'
import {
  claimN8nTaskRun,
  completeN8nTaskRun,
  createN8nTaskRun,
  failN8nTaskRun,
  getN8nTaskRunByTaskId,
  markN8nTaskAccepted,
  n8nTaskIdentitySchema,
} from '@/lib/n8n-task-runs'

export const runtime = 'nodejs'

const nodeRequestSchema = z.object({
  taskId: n8nTaskIdentitySchema,
  idempotencyKey: n8nTaskIdentitySchema,
  nodeKey: z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9._:-]+$/),
  input: z.record(z.string(), z.unknown()),
  finalizeParent: z.boolean().default(false),
}).strict()

function scopedId(prefix: string, taskId: string, nodeKey: string): string {
  const readable = `${prefix}:${taskId}:${nodeKey}`
  if (readable.length <= 120) return readable
  const digest = createHash('sha256').update(readable).digest('hex').slice(0, 24)
  return `${prefix}:${taskId.slice(0, 70)}:${digest}`
}

function nodeSessionKey(
  parentTaskId: string,
  nodeKey: string,
  route: ReturnType<typeof resolveN8nNodeRoute>['route'],
): string {
  const agentId = route.transport === 'openclaw' ? route.agentId : 'model-api'
  const digest = createHash('sha256').update(`${parentTaskId}:${nodeKey}`).digest('hex').slice(0, 20)
  return `agent:${agentId}:aiworker-node-${nodeKey}-${digest}`
}

export async function POST(request: NextRequest) {
  if (!verifyN8nWebhookSecret(request.headers.get('X-AIWorker-Webhook-Secret'))) {
    return NextResponse.json({ error: 'n8n 节点回调认证失败' }, { status: 401 })
  }
  const body = await request.json().catch(() => null)
  const parsed = nodeRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '模型节点请求无效', issues: parsed.error.issues }, { status: 400 })
  }

  const db = getDatabase()
  const parent = getN8nTaskRunByTaskId(db, parsed.data.taskId)
  if (!parent) return NextResponse.json({ error: '未找到父任务运行记录' }, { status: 404 })
  if (parent.idempotencyKey !== parsed.data.idempotencyKey) {
    return NextResponse.json({ error: '幂等键与父任务不匹配' }, { status: 409 })
  }
  if (parent.status === 'failed') {
    return NextResponse.json({ taskId: parent.taskId, status: parent.status, error: parent.error || '父任务已失败' }, { status: 409 })
  }
  if (parent.status === 'succeeded') {
    return NextResponse.json({ taskId: parent.taskId, status: parent.status, output: parent.output, cached: true })
  }

  let resolved: ReturnType<typeof resolveN8nNodeRoute>
  try {
    resolved = resolveN8nNodeRoute(parent.routing, parsed.data.nodeKey)
  } catch (error) {
    const message = n8nModelExecutionError(error)
    failN8nTaskRun(db, parent.taskId, message)
    return NextResponse.json({ taskId: parent.taskId, status: 'failed', error: message }, { status: 409 })
  }

  const scope = { workspaceId: parent.workspaceId, tenantId: parent.tenantId }
  const childTaskId = scopedId('node', parent.taskId, parsed.data.nodeKey)
  const childIdempotencyKey = scopedId('node-idem', parent.idempotencyKey, parsed.data.nodeKey)
  const delivery = parsed.data.finalizeParent ? parent.delivery : { mode: 'none' as const }
  const child = createN8nTaskRun(db, {
    taskId: childTaskId,
    idempotencyKey: childIdempotencyKey,
    bindingId: parent.bindingId,
    source: 'n8n-node',
    requestedBy: parent.requestedBy,
    routing: {
      ...parent.routing,
      nodeKey: parsed.data.nodeKey,
      resolvedRoute: {
        id: resolved.route.id,
        location: resolved.route.location,
        transport: resolved.route.transport,
        model: resolved.route.model,
        source: resolved.source,
      },
    },
    taskInput: parsed.data.input,
    delivery,
    // A node is never replayed after an execution error. n8n may safely repeat
    // the HTTP request only to retrieve a result that was already persisted.
    maxAttempts: 1,
  }, scope)

  if (!child.created) {
    if (child.run.status === 'succeeded') {
      return NextResponse.json({
        taskId: parent.taskId,
        nodeTaskId: child.run.taskId,
        nodeKey: parsed.data.nodeKey,
        status: child.run.status,
        output: child.run.output,
        cached: true,
      })
    }
    return NextResponse.json({
      taskId: parent.taskId,
      nodeTaskId: child.run.taskId,
      nodeKey: parsed.data.nodeKey,
      status: child.run.status,
      error: child.run.error || '节点正在执行或已失败',
    }, { status: child.run.status === 'running' ? 202 : 409 })
  }

  markN8nTaskAccepted(db, childTaskId)
  const claimed = claimN8nTaskRun(db, childTaskId)
  if (!claimed.claimed || !claimed.run) {
    return NextResponse.json({ error: '模型节点状态不可执行' }, { status: 409 })
  }

  try {
    const output = await executeN8nModelRoute(resolved.route, {
      nodeKey: parsed.data.nodeKey,
      instruction: resolved.instruction,
      input: parsed.data.input,
      sessionKey: parsed.data.finalizeParent && parent.delivery.sessionKey
        ? parent.delivery.sessionKey
        : nodeSessionKey(parent.taskId, parsed.data.nodeKey, resolved.route),
      delivery,
      // The binding timeout only covers the initial webhook acknowledgement.
      // Each asynchronous model node uses its own registered execution limit.
      timeoutSeconds: Math.max(5, Math.min(600, resolved.route.timeoutSeconds)),
    })
    completeN8nTaskRun(db, childTaskId, output)

    if (parsed.data.finalizeParent) {
      const currentParent = getN8nTaskRunByTaskId(db, parent.taskId)
      if (currentParent?.status !== 'succeeded') {
        const parentClaim = currentParent?.status === 'running'
          ? { claimed: true, run: currentParent }
          : claimN8nTaskRun(db, parent.taskId)
        if (!parentClaim.claimed || !parentClaim.run) {
          throw new Error('最终节点完成，但父任务状态无法提交')
        }
        completeN8nTaskRun(db, parent.taskId, output)
      }
    }

    return NextResponse.json({
      taskId: parent.taskId,
      nodeTaskId: childTaskId,
      nodeKey: parsed.data.nodeKey,
      status: 'succeeded',
      route: {
        id: resolved.route.id,
        location: resolved.route.location,
        transport: resolved.route.transport,
        model: resolved.route.model,
        source: resolved.source,
      },
      output,
    })
  } catch (error) {
    const message = n8nModelExecutionError(error)
    failN8nTaskRun(db, childTaskId, message)
    failN8nTaskRun(db, parent.taskId, `${parsed.data.nodeKey}: ${message}`)
    return NextResponse.json({
      taskId: parent.taskId,
      nodeTaskId: childTaskId,
      nodeKey: parsed.data.nodeKey,
      status: 'failed',
      error: message,
      retryable: false,
    }, { status: 502 })
  }
}
