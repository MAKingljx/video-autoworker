import { randomUUID } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { getDatabase, logAuditEvent } from '@/lib/db'
import {
  isN8nWebhookDispatchError,
  isN8nWebhookSecretConfigured,
  requireN8nRole,
  triggerN8nWebhook,
  validateN8nWebhookDispatchConfiguration,
} from '@/lib/n8n'
import {
  getN8nTaskRunByIdempotencyKey,
  n8nTaskDeliverySchema,
  n8nTaskIdentitySchema,
  type N8nTaskRun,
} from '@/lib/n8n-task-runs'
import {
  createN8nTaskRunWithIntakeGate,
  getN8nIntakeControl,
} from '@/lib/n8n-intake-control'
import {
  acquireN8nTaskDispatchOwnership,
  settleN8nTaskDispatchFailure,
  settleN8nTaskDispatchSuccess,
} from '@/lib/n8n-task-dispatch'
import {
  loadN8nModelRegistry,
  n8nTaskRoutingOverrideSchema,
  validateTaskRouteIds,
} from '@/lib/n8n-model-routing'
import { getN8nWorkflowBinding, updateN8nWorkflowRunStatus } from '@/lib/n8n-workflows'
import { mutationLimiter } from '@/lib/rate-limit'
import { n8nMaterialIdentitySchema } from '@/lib/n8n-media-identity'
import { resolveN8nRuntimeAffinity } from '@/lib/n8n-runtime-affinity'
import { logSafeOperationError, projectSafeOperationError } from '@/lib/operational-errors'
import {
  directorEvidenceBindingFromInput,
  directorWorkQueryDigest,
  resolveDirectorWorkBinding,
  sameDirectorEvidenceBinding,
} from '@/lib/director-evidence-outbox'
import {
  acquireSharedDeploymentLock,
  type SharedDeploymentLockResult,
} from '@/lib/shared-deployment-lock'

function resolveN8nLoopbackCallbackUrl(configuredValue: string, pathname: string, label: string): string {
  const configured = String(configuredValue || '').trim()
  const port = Number(process.env.PORT || 3017)
  if (!configured && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error('Video AutoWorker 服务端口无效')
  }
  const candidate = configured || `http://127.0.0.1:${port}${pathname}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new Error(`n8n ${label}回调地址无效`)
  }
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  if (
    url.protocol !== 'http:'
    || !loopback
    || Boolean(url.username || url.password || url.search || url.hash)
    || url.pathname !== pathname
  ) {
    throw new Error(`n8n ${label}回调地址必须是本机回环 HTTP 接口 ${pathname}`)
  }
  return url.toString()
}

export function resolveN8nNodeCallbackUrl(): string {
  return resolveN8nLoopbackCallbackUrl(
    String(process.env.AIWORKER_N8N_NODE_CALLBACK_URL || ''),
    '/api/n8n/node-execute',
    '模型节点',
  )
}

export function resolveN8nMediaCallbackUrl(): string {
  return resolveN8nLoopbackCallbackUrl(
    String(process.env.AIWORKER_N8N_MEDIA_CALLBACK_URL || ''),
    '/api/n8n/media-execute',
    '媒体节点',
  )
}

export function resolveN8nClaimCallbackUrl(): string {
  return resolveN8nLoopbackCallbackUrl(
    String(process.env.AIWORKER_N8N_CLAIM_CALLBACK_URL || ''),
    '/api/n8n/claim',
    '父任务认领',
  )
}

function existingDispatchResponse(
  run: N8nTaskRun | null,
  error?: string,
  duplicate = true,
): NextResponse {
  if (!run) {
    const failure = projectSafeOperationError(error, 'N8N_DISPATCH_FAILED')
    return NextResponse.json({ code: failure.code, error: failure.summary }, { status: 502 })
  }
  if (run.status === 'queued') {
    return NextResponse.json({
      taskId: run.taskId,
      ...(duplicate ? { duplicate: true } : {}),
      status: 'queued',
      dispatchInProgress: true,
    }, { status: 202, headers: { 'Cache-Control': 'no-store' } })
  }
  if (['accepted', 'running'].includes(run.status)) {
    return NextResponse.json({
      taskId: run.taskId,
      ...(duplicate ? { duplicate: true } : {}),
      status: run.status,
    }, { status: 202 })
  }
  if (run.status === 'succeeded') {
    return NextResponse.json({
      taskId: run.taskId,
      ...(duplicate ? { duplicate: true } : {}),
      status: run.status,
      output: run.output,
    })
  }
  const failure = projectSafeOperationError(run.error || error, 'N8N_DISPATCH_FAILED')
  return NextResponse.json({
    taskId: run.taskId,
    ...(duplicate ? { duplicate: true } : {}),
    status: run.status,
    code: failure.code,
    error: failure.summary,
  }, { status: 409 })
}

function intakeDrainingResponse(): NextResponse {
  return NextResponse.json({
    code: 'N8N_INTAKE_DRAINING',
    error: '系统正在维护，当前未接收新任务；已运行任务不受影响',
    retryable: true,
    retryAfterSeconds: 30,
  }, { status: 423, headers: { 'Cache-Control': 'no-store' } })
}

function deploymentBusyResponse(): NextResponse {
  return NextResponse.json({
    code: 'DEPLOYMENT_IN_PROGRESS',
    error: '共享导演组件正在发布或补偿，请稍后使用原任务标识重试',
    retryable: true,
    retryAfterSeconds: 30,
  }, { status: 423, headers: { 'Cache-Control': 'no-store' } })
}

function deploymentLockUnavailableResponse(error: unknown): NextResponse {
  const failure = projectSafeOperationError(error, 'DEPLOYMENT_LOCK_UNAVAILABLE')
  logSafeOperationError('shared_deployment_lock_acquire', error, failure)
  return NextResponse.json({
    code: failure.code,
    error: failure.summary,
    retryable: true,
    retryAfterSeconds: 30,
  }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
}

function deploymentLockReleaseFailedResponse(
  error: unknown,
  run?: N8nTaskRun | null,
): NextResponse {
  const failure = projectSafeOperationError(error, 'DEPLOYMENT_LOCK_RELEASE_FAILED')
  logSafeOperationError('shared_deployment_lock_release', error, failure)
  return NextResponse.json({
    code: failure.code,
    error: run
      ? '任务已安全持久化，但共享发布锁释放失败；请使用原任务标识重试并人工检查锁目录'
      : failure.summary,
    retryable: true,
    retryAfterSeconds: 30,
    ...(run ? { taskId: run.taskId, status: run.status } : {}),
  }, { status: 503, headers: { 'Cache-Control': 'no-store' } })
}

function directorWorkFailureResponse(error: unknown): NextResponse {
  const code = error instanceof Error ? error.message : 'director_work_resolution_failed'
  if (code === 'director_work_not_found') {
    return NextResponse.json({
      code: 'DIRECTOR_WORK_NOT_FOUND',
      error: '未找到已生效的导演脑作品',
    }, { status: 404 })
  }
  if (code === 'work_resolution_ambiguous') {
    return NextResponse.json({
      code: 'DIRECTOR_WORK_AMBIGUOUS',
      error: '作品名称匹配到多条记录，请使用更准确的名称或别名',
    }, { status: 409 })
  }
  if (code === 'director_work_query_invalid') {
    return NextResponse.json({
      code: 'DIRECTOR_WORK_INVALID',
      error: '作品名称或别名无效',
    }, { status: 400 })
  }
  if (code === 'director_evidence_binding_mismatch') {
    return NextResponse.json({
      code: 'DIRECTOR_WORK_BINDING_MISMATCH',
      error: '该幂等任务已绑定其他导演脑作品或素材，未重新派发',
    }, { status: 409 })
  }
  const failure = projectSafeOperationError(error, 'DIRECTOR_WORK_RESOLUTION_FAILED')
  logSafeOperationError('director_work_resolution', error, failure)
  return NextResponse.json({ code: failure.code, error: failure.summary }, { status: 503 })
}

function sameDirectorTaskBinding(
  left: Record<string, unknown> | null | undefined,
  right: Record<string, unknown> | null | undefined,
): boolean {
  const leftBinding = directorEvidenceBindingFromInput(left)
  const rightBinding = directorEvidenceBindingFromInput(right)
  if (!leftBinding && !rightBinding) return true
  return sameDirectorEvidenceBinding(left, right)
    && left?.materialId === right?.materialId
}

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
  if (!isN8nWebhookSecretConfigured()) {
    return NextResponse.json({
      error: '尚未配置 N8N_WEBHOOK_SECRET，无法安全触发 n8n 工作流',
    }, { status: 503 })
  }

  const db = getDatabase()
  const scope = { workspaceId: auth.user.workspace_id, tenantId: auth.user.tenant_id }
  const binding = getN8nWorkflowBinding(db, bindingId, scope)
  if (!binding) return NextResponse.json({ error: '未找到任务链' }, { status: 404 })
  if (!binding.enabled) return NextResponse.json({ error: '任务链当前已停用' }, { status: 409 })
  try {
    validateN8nWebhookDispatchConfiguration(binding.webhookPath)
  } catch (error) {
    const failure = projectSafeOperationError(error, 'N8N_WEBHOOK_CONFIG_INVALID')
    logSafeOperationError('n8n_webhook_configuration', error, failure)
    return NextResponse.json({ code: failure.code, error: failure.summary }, { status: 503 })
  }

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
  if (binding.taskType === 'video-analysis' && deliveryResult.data.mode !== 'none') {
    return NextResponse.json({
      error: '视频分析工作节点不进入 OpenClaw 会话；请由 OpenClaw 等待任务结果后在当前会话回复',
    }, { status: 400 })
  }
  const inputRecord = input as Record<string, unknown>
  if (Object.hasOwn(inputRecord, 'directorEvidence') || Object.hasOwn(inputRecord, 'directorWork')) {
    return NextResponse.json({ error: '导演脑作品绑定只能由服务端可信入口生成' }, { status: 400 })
  }
  if (body?.directorWork !== undefined && binding.taskType !== 'video-analysis') {
    return NextResponse.json({ error: '导演脑作品绑定仅适用于视频分析任务' }, { status: 400 })
  }
  if (body?.directorWork !== undefined && !Object.hasOwn(inputRecord, 'materialId')) {
    return NextResponse.json({
      code: 'DIRECTOR_MATERIAL_ID_REQUIRED',
      error: '使用导演脑作品绑定时必须提供有效的 input.materialId',
    }, { status: 400 })
  }
  let normalizedInput = { ...inputRecord }
  if (binding.taskType === 'video-analysis' && Object.hasOwn(inputRecord, 'materialId')) {
    const materialIdResult = n8nMaterialIdentitySchema.safeParse(
      inputRecord.materialId,
    )
    if (!materialIdResult.success) {
      return NextResponse.json({
        error: 'materialId 无效',
        issues: materialIdResult.error.issues,
      }, { status: 400 })
    }
    normalizedInput = { ...normalizedInput, materialId: materialIdResult.data }
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
  type AdmissionPreparation = {
    ok: true
    trustedTaskInput: Record<string, unknown>
    routing: Parameters<typeof createN8nTaskRunWithIntakeGate>[1]['routing']
    admission: ReturnType<typeof createN8nTaskRunWithIntakeGate>
  } | { ok: false; response: NextResponse }

  const prepareAdmission = (
    directorEvidence: Awaited<ReturnType<typeof resolveDirectorWorkBinding>> | null,
  ): AdmissionPreparation => {
    const trustedTaskInput = {
      ...normalizedInput,
      ...(directorEvidence ? { directorEvidence } : {}),
    }
    let nodeCallbackUrl: string
    let mediaCallbackUrl: string
    let claimCallbackUrl: string
    let runtimeAffinity: ReturnType<typeof resolveN8nRuntimeAffinity>
    try {
      nodeCallbackUrl = resolveN8nNodeCallbackUrl()
      mediaCallbackUrl = resolveN8nMediaCallbackUrl()
      claimCallbackUrl = resolveN8nClaimCallbackUrl()
      runtimeAffinity = resolveN8nRuntimeAffinity()
    } catch (error) {
      const failure = projectSafeOperationError(error, 'N8N_CALLBACK_CONFIG_INVALID')
      logSafeOperationError('n8n_callback_configuration', error, failure)
      return {
        ok: false,
        response: NextResponse.json({ code: failure.code, error: failure.summary }, { status: 503 }),
      }
    }
    const routing = {
      id: binding.id,
      name: binding.name,
      taskType: binding.taskType,
      agentRole: binding.agentRole,
      model: binding.model,
      timeoutSeconds: binding.timeoutSeconds,
      retryCount: binding.retryCount,
      nodeCallbackUrl,
      mediaCallbackUrl,
      claimCallbackUrl,
      claimScope: scope,
      config: binding.config,
      ...(runtimeAffinity || {}),
      ...(binding.taskType === 'video-analysis' ? { memoryMode: 'none' } : {}),
      ...(body?.routing === undefined ? {} : { taskRouting: taskRoutingResult.data }),
    }
    const admission = createN8nTaskRunWithIntakeGate(db, {
      taskId,
      idempotencyKey,
      bindingId: binding.id,
      source,
      requestedBy: auth.user.username,
      routing,
      taskInput: trustedTaskInput,
      delivery: deliveryResult.data,
      maxAttempts: binding.retryCount + 1,
    }, scope)
    return { ok: true, trustedTaskInput, routing, admission }
  }

  let prepared: AdmissionPreparation | null = null
  let directorEvidence: Awaited<ReturnType<typeof resolveDirectorWorkBinding>> | null = null
  if (body?.directorWork !== undefined) {
    let queryDigest: string
    try {
      queryDigest = directorWorkQueryDigest(body.directorWork)
    } catch (error) {
      return directorWorkFailureResponse(error)
    }

    const matchesRequest = (run: N8nTaskRun): boolean => {
      const existingBinding = directorEvidenceBindingFromInput(run.input)
      return run.taskId === taskId
        && run.idempotencyKey === idempotencyKey
        && run.bindingId === binding.id
        && Boolean(existingBinding
        && existingBinding.queryDigest === queryDigest
        && run.input.materialId === normalizedInput.materialId)
    }
    let existingRun = getN8nTaskRunByIdempotencyKey(db, idempotencyKey, scope)
    if (existingRun) {
      if (!matchesRequest(existingRun)) {
        return directorWorkFailureResponse(new Error('director_evidence_binding_mismatch'))
      }
      directorEvidence = directorEvidenceBindingFromInput(existingRun.input)
    } else {
      let directorLease: SharedDeploymentLockResult
      try {
        directorLease = await acquireSharedDeploymentLock()
      } catch (error) {
        return deploymentLockUnavailableResponse(error)
      }
      if (!directorLease.acquired) return deploymentBusyResponse()

      let lockedResponse: NextResponse | null = null
      let lockedError: unknown
      let releaseError: unknown
      try {
        // A competing exact request may have committed while this caller was
        // waiting for the shared lock. Re-read before contacting Feishu.
        existingRun = getN8nTaskRunByIdempotencyKey(db, idempotencyKey, scope)
        if (existingRun) {
          if (!matchesRequest(existingRun)) {
            lockedResponse = directorWorkFailureResponse(
              new Error('director_evidence_binding_mismatch'),
            )
          } else {
            directorEvidence = directorEvidenceBindingFromInput(existingRun.input)
          }
        } else if (!getN8nIntakeControl(db).accepting) {
          lockedResponse = intakeDrainingResponse()
        } else {
          try {
            directorEvidence = await resolveDirectorWorkBinding(body.directorWork)
          } catch (error) {
            lockedResponse = directorWorkFailureResponse(error)
          }
        }
        if (!lockedResponse) prepared = prepareAdmission(directorEvidence)
      } catch (error) {
        lockedError = error
      } finally {
        try {
          directorLease.lease.release()
        } catch (error) {
          releaseError = error
        }
      }
      if (releaseError) {
        return deploymentLockReleaseFailedResponse(
          releaseError,
          prepared?.ok && prepared.admission.outcome !== 'blocked'
            ? prepared.admission.run
            : null,
        )
      }
      if (lockedError) throw lockedError
      if (lockedResponse) return lockedResponse
    }
  }

  prepared ||= prepareAdmission(directorEvidence)
  if (!prepared.ok) return prepared.response
  const { admission, routing, trustedTaskInput } = prepared
  if (admission.outcome === 'blocked') {
    return intakeDrainingResponse()
  }
  const created = { created: admission.outcome === 'created', run: admission.run }

  if (!created.created && !sameDirectorTaskBinding(created.run.input, trustedTaskInput)) {
    return NextResponse.json({
      taskId: created.run.taskId,
      duplicate: true,
      status: created.run.status,
      error: '幂等任务身份或导演脑作品绑定与当前请求不匹配，未重新派发',
    }, { status: 409 })
  }

  if (body?.directorWork !== undefined && !created.created && (
    created.run.taskId !== taskId
    || created.run.idempotencyKey !== idempotencyKey
    || created.run.bindingId !== binding.id
  )) {
    return NextResponse.json({
      taskId: created.run.taskId,
      duplicate: true,
      status: created.run.status,
      error: '幂等任务身份或导演脑作品绑定与当前请求不匹配，未重新派发',
    }, { status: 409 })
  }

  if (!created.created && created.run.status !== 'queued') {
    const status = created.run.status === 'succeeded'
      ? 200
      : ['failed', 'cancelled'].includes(created.run.status) ? 409 : 202
    return NextResponse.json({
      taskId: created.run.taskId,
      duplicate: true,
      status: created.run.status,
      output: created.run.status === 'succeeded' ? created.run.output : undefined,
    }, { status })
  }

  if (!created.created && (
    created.run.taskId !== taskId
    || created.run.idempotencyKey !== idempotencyKey
    || created.run.bindingId !== binding.id
  )) {
    return NextResponse.json({
      taskId: created.run.taskId,
      duplicate: true,
      status: created.run.status,
      error: 'queued 幂等任务身份与当前请求不匹配，未重新派发',
    }, { status: 409 })
  }

  const dispatchRun = created.run
  const dispatchTaskId = created.created ? taskId : dispatchRun.taskId
  const dispatchIdempotencyKey = created.created ? idempotencyKey : dispatchRun.idempotencyKey
  const ownership = acquireN8nTaskDispatchOwnership(db, dispatchTaskId, scope)
  if (ownership.outcome !== 'acquired') {
    return existingDispatchResponse(ownership.run)
  }
  const dispatchToken = ownership.token
  const payload = created.created
    ? {
        taskId,
        idempotencyKey,
        source,
        requestedBy: auth.user.username,
        routing,
        input: trustedTaskInput,
        delivery: deliveryResult.data,
      }
    : {
        taskId: dispatchRun.taskId,
        idempotencyKey: dispatchRun.idempotencyKey,
        source: dispatchRun.source,
        requestedBy: dispatchRun.requestedBy,
        routing: dispatchRun.routing,
        input: dispatchRun.input,
        delivery: dispatchRun.delivery,
      }

  let webhookAccepted = false
  try {
    const result = await triggerN8nWebhook(binding.webhookPath, payload, {
      timeoutMs: Math.min(binding.timeoutSeconds * 1_000, 120_000),
      idempotencyKey: dispatchIdempotencyKey,
    })
    webhookAccepted = true
    const runStatus = result.statusCode === 202 ? 'accepted' : 'success'
    const resolution = settleN8nTaskDispatchSuccess(
      db, dispatchTaskId, dispatchToken, scope,
    )
    if (resolution.outcome !== 'accepted') {
      if (resolution.outcome === 'claimed') {
        updateN8nWorkflowRunStatus(db, binding.id, 'running', scope)
      }
      return existingDispatchResponse(
        resolution.run,
        undefined,
        resolution.outcome === 'stale' || !created.created,
      )
    }
    updateN8nWorkflowRunStatus(db, binding.id, runStatus, scope)
    try {
      logAuditEvent({ action: 'n8n_workflow_trigger', actor: auth.user.username, actor_id: auth.user.id, target_type: 'n8n_workflow_binding', target_id: binding.id, detail: { taskId: dispatchTaskId, statusCode: result.statusCode, latencyMs: result.latencyMs, resumedQueued: !created.created } })
    } catch {
      // n8n already accepted the task; audit failure must not return a retryable 502.
    }
    return NextResponse.json({
      taskId: dispatchTaskId,
      status: 'accepted',
      result,
      ...(!created.created ? { duplicate: true, resumedQueued: true } : {}),
    }, { status: 202 })
  } catch (error) {
    const rejected = isN8nWebhookDispatchError(error) && error.outcome === 'rejected'
    const failure = projectSafeOperationError(
      error,
      rejected ? 'N8N_WEBHOOK_REJECTED' : 'N8N_DISPATCH_FAILED',
    )
    logSafeOperationError('n8n_task_dispatch', error, failure)
    if (webhookAccepted) {
      // The remote acceptance is known. Never reinterpret a later local DB or
      // workflow-status error as a webhook rejection and fail the queued run.
      return NextResponse.json({
        code: 'N8N_DISPATCH_SETTLEMENT_FAILED',
        taskId: dispatchTaskId,
        error: 'n8n 已接受任务，但本地派发状态确认失败；请使用原任务标识继续查询',
      }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
    }
    if (!rejected) {
      // n8n may have durably accepted the webhook before the response timed
      // out or was lost. Keep both the queued parent and its dispatch lease;
      // the claim callback may still advance the parent, and an exact retry
      // may safely reuse the same idempotency key after the lease expires.
      return NextResponse.json({
        code: 'N8N_DISPATCH_OUTCOME_UNKNOWN',
        taskId: dispatchTaskId,
        status: 'queued',
        dispatchOutcome: 'outcome_unknown',
        retryable: true,
        ...(!created.created ? { duplicate: true } : {}),
      }, { status: 202, headers: { 'Cache-Control': 'no-store' } })
    }
    const resolution = settleN8nTaskDispatchFailure(
      db, dispatchTaskId, dispatchToken, failure.persistedMessage, scope,
    )
    if (resolution.outcome === 'failed') {
      updateN8nWorkflowRunStatus(db, binding.id, `failed: ${failure.persistedMessage}`, scope)
      return NextResponse.json({
        taskId: dispatchTaskId,
        status: 'failed',
        code: failure.code,
        error: failure.summary,
      }, { status: 502 })
    }
    if (resolution.outcome === 'claimed') {
      updateN8nWorkflowRunStatus(db, binding.id, 'running', scope)
      return NextResponse.json({
        taskId: dispatchTaskId,
        status: 'running',
        acceptedAfterAmbiguousResponse: true,
      }, { status: 202 })
    }
    if (resolution.run?.status === 'succeeded') {
      updateN8nWorkflowRunStatus(db, binding.id, 'success', scope)
      return NextResponse.json({
        taskId: dispatchTaskId,
        status: 'succeeded',
        output: resolution.run.output,
      })
    }
    return existingDispatchResponse(
      resolution.run,
      failure.persistedMessage,
      resolution.outcome === 'stale',
    )
  }
}
