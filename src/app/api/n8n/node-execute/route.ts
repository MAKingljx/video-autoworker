import { createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/db'
import { checkN8nCallbackAdmission, resolveN8nRuntimeInstanceId } from '@/lib/n8n-runtime-affinity'
import { executeN8nModelRoute } from '@/lib/n8n-model-execution'
import { resolveN8nNodeRoute } from '@/lib/n8n-model-routing'
import { logSafeOperationError, projectSafeOperationError } from '@/lib/operational-errors'
import { checkOpenClawN8nCallbackRequest } from '@/lib/openclaw-loopback-auth'
import {
  completeN8nChildExecution,
  completeN8nTaskRun,
  createAndClaimN8nChildRunFromParent,
  failN8nChildExecution,
  failN8nTaskRun,
  getN8nTaskRunByTaskId,
  isScopedN8nParentExecutionOwner,
  N8nChildExecutionLeaseLostError,
  n8nExecutionOwnerSchema,
  n8nTaskIdentitySchema,
  pollN8nChildExecutionResult,
  runWithN8nChildExecutionHeartbeat,
} from '@/lib/n8n-task-runs'

export const runtime = 'nodejs'

const nodeRequestSchema = z.object({
  taskId: n8nTaskIdentitySchema,
  idempotencyKey: n8nTaskIdentitySchema,
  executionOwner: n8nExecutionOwnerSchema,
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
  const channel = checkOpenClawN8nCallbackRequest(request, '/api/n8n/node-execute')
  if (!channel.allowed) return NextResponse.json({ error: channel.error }, { status: channel.status })
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
  const admission = checkN8nCallbackAdmission(parent.routing)
  if (!admission.allowed) {
    return NextResponse.json({ taskId: parent.taskId, error: admission.error, code: admission.code }, { status: 409 })
  }

  const scope = { workspaceId: parent.workspaceId, tenantId: parent.tenantId }
  if (!isScopedN8nParentExecutionOwner(db, parent.taskId, parsed.data.executionOwner, scope)) {
    return NextResponse.json({ taskId: parent.taskId, error: 'n8n execution 不拥有该父任务' }, { status: 409 })
  }
  if (parsed.data.finalizeParent && parsed.data.nodeKey !== 'reviewer') {
    return NextResponse.json({
      taskId: parent.taskId,
      error: '只有受控 reviewer 节点可以完成父任务',
    }, { status: 409 })
  }
  const childTaskId = scopedId('node', parent.taskId, parsed.data.nodeKey)
  const childIdempotencyKey = scopedId('node-idem', parent.idempotencyKey, parsed.data.nodeKey)
  if (['succeeded', 'failed', 'cancelled'].includes(parent.status)) {
    if (parent.status === 'succeeded' && parsed.data.finalizeParent) {
      const child = getN8nTaskRunByTaskId(db, childTaskId)
      if (child?.status === 'succeeded'
        && child.idempotencyKey === childIdempotencyKey
        && child.bindingId === parent.bindingId
        && child.workspaceId === parent.workspaceId
        && child.tenantId === parent.tenantId
        && child.source === 'n8n-node'
        && child.output) {
        return NextResponse.json({
          taskId: parent.taskId,
          nodeTaskId: child.taskId,
          nodeKey: parsed.data.nodeKey,
          status: 'succeeded',
          output: parent.output || child.output,
          cached: true,
        })
      }
    }
    const terminalFailure = parent.error
      ? projectSafeOperationError(parent.error, 'N8N_MODEL_EXECUTION_FAILED')
      : null
    return NextResponse.json({
      taskId: parent.taskId,
      status: parent.status,
      ...(terminalFailure ? { code: terminalFailure.code } : {}),
      error: terminalFailure?.summary || '父任务已结束，拒绝迟到的模型节点回调',
    }, { status: 409 })
  }

  let resolved: ReturnType<typeof resolveN8nNodeRoute>
  try {
    resolved = resolveN8nNodeRoute(parent.routing, parsed.data.nodeKey)
  } catch (error) {
    const failure = projectSafeOperationError(error, 'N8N_MODEL_ROUTE_INVALID')
    logSafeOperationError('n8n_node_route_resolution', error, failure)
    failN8nTaskRun(db, parent.taskId, failure.persistedMessage)
    return NextResponse.json({
      taskId: parent.taskId,
      status: 'failed',
      code: failure.code,
      error: failure.summary,
    }, { status: 409 })
  }

  const delivery = parsed.data.finalizeParent ? parent.delivery : { mode: 'none' as const }
  const childClaimInput = {
    parentTaskId: parent.taskId,
    parentIdempotencyKey: parent.idempotencyKey,
    bindingId: parent.bindingId,
    childTaskId,
    childIdempotencyKey,
    source: 'n8n-node',
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
    // One extra attempt is reserved for a replacement process taking over an
    // execution whose previous process died before persisting its result.
    maxAttempts: 2,
    ownerInstanceId: resolveN8nRuntimeInstanceId(),
    executionOwner: parsed.data.executionOwner,
  } as const
  let owned = createAndClaimN8nChildRunFromParent(db, childClaimInput, scope)
  if (owned.outcome === 'running') {
    owned = await pollN8nChildExecutionResult(
      () => createAndClaimN8nChildRunFromParent(db, childClaimInput, scope),
      owned,
      { waitSeconds: 570 },
    )
  }

  if (owned.outcome !== 'claimed' || !owned.child || !owned.lease) {
    if (owned.outcome === 'succeeded' && owned.child) {
      if (parsed.data.finalizeParent) {
        const currentParent = getN8nTaskRunByTaskId(db, parent.taskId)
        if (currentParent?.status === 'running') completeN8nTaskRun(db, parent.taskId, owned.child.output || {})
      }
      return NextResponse.json({
        taskId: parent.taskId,
        nodeTaskId: owned.child.taskId,
        nodeKey: parsed.data.nodeKey,
        status: owned.child.status,
        output: owned.child.output,
        cached: true,
      })
    }
    const childFailure = owned.child?.error && owned.outcome !== 'running'
      ? projectSafeOperationError(owned.child.error, 'N8N_MODEL_EXECUTION_FAILED')
      : null
    return NextResponse.json({
      taskId: parent.taskId,
      nodeTaskId: owned.child?.taskId || childTaskId,
      nodeKey: parsed.data.nodeKey,
      status: owned.child?.status || owned.outcome,
      code: owned.outcome === 'running' ? 'N8N_CHILD_STILL_RUNNING' : childFailure?.code,
      retryable: owned.outcome === 'running',
      error: childFailure?.summary || (owned.outcome === 'running' ? '节点正在执行，请轮询持久化结果' : '模型节点状态不可执行'),
    }, {
      status: owned.outcome === 'running' ? 503 : 409,
      headers: owned.outcome === 'running' ? { 'Retry-After': '5', 'Cache-Control': 'no-store' } : undefined,
    })
  }

  try {
    const output = await runWithN8nChildExecutionHeartbeat(db, owned.lease, scope, () => (
      executeN8nModelRoute(resolved.route, {
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
    ))
    const completed = completeN8nChildExecution(db, owned.lease, output, scope, {
      parentTaskId: parsed.data.finalizeParent ? parent.taskId : undefined,
    })
    if (!completed.settled) {
      throw new N8nChildExecutionLeaseLostError()
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
    const failure = projectSafeOperationError(
      error,
      error instanceof N8nChildExecutionLeaseLostError
        ? 'N8N_CHILD_LEASE_LOST'
        : 'N8N_MODEL_EXECUTION_FAILED',
    )
    logSafeOperationError('n8n_node_execution', error, failure)
    if (error instanceof N8nChildExecutionLeaseLostError) {
      return NextResponse.json({
        taskId: parent.taskId,
        nodeTaskId: childTaskId,
        nodeKey: parsed.data.nodeKey,
        status: 'running',
        code: failure.code,
        error: failure.summary,
        retryable: true,
      }, { status: 409 })
    }
    const failed = failN8nChildExecution(db, owned.lease, failure.persistedMessage, scope)
    if (failed.settled) failN8nTaskRun(db, parent.taskId, failure.persistedMessage)
    return NextResponse.json({
      taskId: parent.taskId,
      nodeTaskId: childTaskId,
      nodeKey: parsed.data.nodeKey,
      status: 'failed',
      code: failure.code,
      error: failure.summary,
      retryable: !failed.settled,
    }, { status: failed.settled ? 502 : 409 })
  }
}
