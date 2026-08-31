import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/db'
import {
  analyzeN8nVideoFrames,
  mediaChildIdentity,
  mergeN8nMediaResults,
  prepareN8nMedia,
  synthesizeN8nMediaResults,
  transcribeN8nMedia,
  type N8nMediaStage,
} from '@/lib/n8n-media-execution'
import { retryN8nMediaCleanupDebt } from '@/lib/n8n-media-cleanup'
import { verifyN8nWebhookSecret } from '@/lib/n8n'
import { checkN8nCallbackAdmission, resolveN8nRuntimeInstanceId } from '@/lib/n8n-runtime-affinity'
import {
  completeN8nChildExecution,
  completeN8nFinalizeRun,
  createAndClaimN8nChildRunFromParent,
  ensureN8nMediaCleanupDebt,
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
import { n8nMaterialIdentitySchema } from '@/lib/n8n-media-identity'
import { logSafeOperationError, SafeOperationError, projectSafeOperationError } from '@/lib/operational-errors'

export const runtime = 'nodejs'

const mediaRequestSchema = z.object({
  taskId: n8nTaskIdentitySchema,
  idempotencyKey: n8nTaskIdentitySchema,
  executionOwner: n8nExecutionOwnerSchema,
  stage: z.enum(['prepare', 'audio', 'vision', 'finalize']),
  input: z.record(z.string(), z.unknown()).default({}),
}).strict()

function stageOutput(
  stage: N8nMediaStage,
  taskId: string,
  routing: Record<string, unknown>,
  taskInput: Record<string, unknown>,
) {
  if (stage === 'prepare') return prepareN8nMedia(taskId, routing, taskInput)
  if (stage === 'audio') return transcribeN8nMedia(taskId, routing)
  if (stage === 'vision') return analyzeN8nVideoFrames(taskId, routing, taskInput)
  throw new Error(`不支持直接执行阶段：${stage}`)
}

function mediaDependencyFailure(
  label: string,
  run: ReturnType<typeof getN8nTaskRunByTaskId>,
): string | null {
  if (!run) return `${label}分析节点尚未成功完成（节点记录不存在）`
  if (run.status === 'succeeded' && run.output) return null
  const attempts = `${run.attemptCount}/${run.maxAttempts}`
  const detail = run.error ? `，错误：${run.error.slice(0, 1_200)}` : ''
  return `${label}分析节点尚未成功完成（状态：${run.status}，尝试：${attempts}${detail}）`
}

function exhaustedChildError(
  stage: N8nMediaStage,
  error: string,
  attemptCount: number,
  maxAttempts: number,
): string {
  return `${stage}: ${error}（子任务重试次数已用尽 ${attemptCount}/${maxAttempts}）`.slice(0, 2_000)
}

async function retryableFinalizeCleanupResponse(input: {
  db: ReturnType<typeof getDatabase>
  taskId: string
  childTaskId: string
  output: Record<string, unknown> | null
  cached: boolean
}): Promise<NextResponse | null> {
  try {
    const scheduled = ensureN8nMediaCleanupDebt(input.db, input.taskId)
    const attempt = scheduled.scheduled
      ? await retryN8nMediaCleanupDebt(input.db, input.taskId, { force: true })
      : { outcome: 'rejected' as const, error: '无法建立受控媒体清理债务' }
    if (attempt.outcome === 'cleaned') return null
  } catch {
    // Parent and finalize child are already committed. Preserve their terminal
    // state even if the best-effort retry bookkeeping itself is unavailable.
  }

  // The business result is already durable. A 5xx asks n8n to retry only the
  // idempotent workspace cleanup; the durable debt also lets the janitor retry
  // without downgrading the committed parent/child terminal state.
  return NextResponse.json({
    taskId: input.taskId,
    nodeTaskId: input.childTaskId,
    stage: 'finalize',
    status: 'succeeded',
    output: input.output,
    cached: input.cached,
    cleanupPending: true,
    retryable: true,
    error: '最终结果已提交，媒体临时目录清理待重试',
  }, { status: 502 })
}

export async function POST(request: NextRequest) {
  if (!verifyN8nWebhookSecret(request.headers.get('X-AIWorker-Webhook-Secret'))) {
    return NextResponse.json({ error: 'n8n 媒体节点回调认证失败' }, { status: 401 })
  }
  const body = await request.json().catch(() => null)
  const parsed = mediaRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json({ error: '媒体节点请求无效', issues: parsed.error.issues }, { status: 400 })
  }

  const db = getDatabase()
  const observedParent = getN8nTaskRunByTaskId(db, parsed.data.taskId)
  if (!observedParent) return NextResponse.json({ error: '未找到父任务运行记录' }, { status: 404 })
  if (observedParent.idempotencyKey !== parsed.data.idempotencyKey) {
    return NextResponse.json({ error: '幂等键与父任务不匹配' }, { status: 409 })
  }
  const admission = checkN8nCallbackAdmission(observedParent.routing)
  if (!admission.allowed) {
    return NextResponse.json({ taskId: observedParent.taskId, error: admission.error, code: admission.code }, { status: 409 })
  }
  if (String(observedParent.routing.taskType || '') !== 'video-analysis') {
    return NextResponse.json({ error: '当前父任务不是视频分析任务链' }, { status: 409 })
  }

  const stage = parsed.data.stage
  const scope = { workspaceId: observedParent.workspaceId, tenantId: observedParent.tenantId }
  if (!isScopedN8nParentExecutionOwner(db, observedParent.taskId, parsed.data.executionOwner, scope)) {
    return NextResponse.json({ taskId: observedParent.taskId, error: 'n8n execution 不拥有该父任务' }, { status: 409 })
  }
  if (['succeeded', 'failed', 'cancelled'].includes(observedParent.status)) {
    if (observedParent.status === 'succeeded' && stage === 'finalize') {
      const finalChildTaskId = mediaChildIdentity('task', observedParent.taskId, 'finalize')
      const finalChild = getN8nTaskRunByTaskId(db, finalChildTaskId)
      const expectedIdempotencyKey = mediaChildIdentity('idem', observedParent.idempotencyKey, 'finalize')
      if (finalChild?.status === 'succeeded'
        && finalChild.idempotencyKey === expectedIdempotencyKey
        && finalChild.bindingId === observedParent.bindingId
        && finalChild.workspaceId === observedParent.workspaceId
        && finalChild.tenantId === observedParent.tenantId
        && finalChild.source === 'n8n-media-node'
        && finalChild.output) {
        const finalized = completeN8nFinalizeRun(db, {
          parentTaskId: observedParent.taskId,
          childTaskId: finalChild.taskId,
        })
        if (finalized.outcome === 'cached') {
          const cleanupPending = await retryableFinalizeCleanupResponse({
            db,
            taskId: observedParent.taskId,
            childTaskId: finalChild.taskId,
            output: finalized.output,
            cached: true,
          })
          if (cleanupPending) return cleanupPending
          return NextResponse.json({
            taskId: observedParent.taskId,
            nodeTaskId: finalChild.taskId,
            stage,
            status: 'succeeded',
            output: finalized.output,
            cached: true,
          })
        }
      }
    }
    const terminalFailure = observedParent.error
      ? projectSafeOperationError(observedParent.error, 'N8N_MEDIA_STAGE_FAILED')
      : null
    return NextResponse.json({
      taskId: observedParent.taskId,
      status: observedParent.status,
      ...(terminalFailure ? { code: terminalFailure.code } : {}),
      error: terminalFailure?.summary || '父任务已结束，拒绝迟到的媒体节点回调',
    }, { status: 409 })
  }
  if (stage === 'prepare') {
    const parentVideoKey = typeof observedParent.input.videoKey === 'string' ? observedParent.input.videoKey : ''
    const requestedVideoKey = typeof parsed.data.input.videoKey === 'string' ? parsed.data.input.videoKey : ''
    if (!parentVideoKey || requestedVideoKey !== parentVideoKey) {
      return NextResponse.json({ error: '视频标识与父任务不匹配' }, { status: 409 })
    }
  }
  const candidateParent = observedParent
  const childTaskId = mediaChildIdentity('task', candidateParent.taskId, stage)
  const childClaimInput = {
    parentTaskId: parsed.data.taskId,
    parentIdempotencyKey: parsed.data.idempotencyKey,
    bindingId: candidateParent.bindingId,
    childTaskId,
    childIdempotencyKey: mediaChildIdentity('idem', candidateParent.idempotencyKey, stage),
    source: 'n8n-media-node',
    routing: {
      ...candidateParent.routing,
      mediaStage: stage,
      memoryMode: 'none',
    },
    taskInput: parsed.data.input,
    delivery: { mode: 'none' },
    maxAttempts: 2,
    ownerInstanceId: resolveN8nRuntimeInstanceId(),
    executionOwner: parsed.data.executionOwner,
  } as const
  let guarded = createAndClaimN8nChildRunFromParent(db, childClaimInput, scope)
  if (guarded.outcome === 'running') {
    guarded = await pollN8nChildExecutionResult(
      () => createAndClaimN8nChildRunFromParent(db, childClaimInput, scope),
      guarded,
      { waitSeconds: 4 * 60 * 60 - 30 },
    )
  }
  if (guarded.outcome === 'not_found') {
    return NextResponse.json({ error: '未找到父任务运行记录' }, { status: 404 })
  }
  if (guarded.outcome === 'terminal') {
    const terminalFailure = guarded.parent?.error
      ? projectSafeOperationError(guarded.parent.error, 'N8N_MEDIA_STAGE_FAILED')
      : null
    return NextResponse.json({
      taskId: guarded.parent?.taskId || parsed.data.taskId,
      status: guarded.parent?.status || 'failed',
      ...(terminalFailure ? { code: terminalFailure.code } : {}),
      error: terminalFailure?.summary || '父任务已结束，拒绝迟到的媒体节点回调',
    }, { status: 409 })
  }
  if (guarded.outcome === 'rejected' || !guarded.parent || !guarded.child) {
    return NextResponse.json({ error: '父任务身份或状态不允许创建媒体节点' }, { status: 409 })
  }
  const parent = guarded.parent
  if (guarded.outcome !== 'claimed' || !guarded.lease) {
    if (guarded.outcome === 'succeeded') {
      if (stage === 'finalize') {
        const finalized = completeN8nFinalizeRun(db, {
          parentTaskId: parent.taskId,
          childTaskId: guarded.child.taskId,
        })
        if (finalized.outcome === 'completed' || finalized.outcome === 'cached') {
          const cleanupPending = await retryableFinalizeCleanupResponse({
            db,
            taskId: parent.taskId,
            childTaskId: guarded.child.taskId,
            output: finalized.output,
            cached: true,
          })
          if (cleanupPending) return cleanupPending
          return NextResponse.json({
            taskId: parent.taskId,
            nodeTaskId: guarded.child.taskId,
            stage,
            status: 'succeeded',
            output: finalized.output,
            cached: true,
          })
        }
        const finalizeFailure = finalized.parent?.error
          ? projectSafeOperationError(finalized.parent.error, 'N8N_MEDIA_STAGE_FAILED')
          : null
        return NextResponse.json({
          taskId: parent.taskId,
          status: finalized.parent?.status || 'failed',
          ...(finalizeFailure ? { code: finalizeFailure.code } : {}),
          error: finalizeFailure?.summary || '最终媒体节点无法补全父任务状态',
        }, { status: 409 })
      }
      return NextResponse.json({
        taskId: parent.taskId,
        nodeTaskId: guarded.child.taskId,
        stage,
        status: guarded.child.status,
        output: guarded.child.output,
        cached: true,
      })
    }
    if (guarded.outcome === 'running') {
      return NextResponse.json({
        taskId: parent.taskId,
        nodeTaskId: guarded.child.taskId,
        stage,
        status: guarded.child.status,
        code: 'N8N_CHILD_STILL_RUNNING',
        retryable: true,
        error: '媒体节点正在执行，请轮询持久化结果',
      }, { status: 503, headers: { 'Retry-After': '10', 'Cache-Control': 'no-store' } })
    }
    if (guarded.outcome === 'exhausted') {
      const exhaustedFailure = projectSafeOperationError(
        guarded.child.error,
        'N8N_MEDIA_STAGE_FAILED',
      )
      failN8nTaskRun(
        db,
        parent.taskId,
        exhaustedChildError(
          stage,
          exhaustedFailure.persistedMessage,
          guarded.child.attemptCount,
          guarded.child.maxAttempts,
        ),
      )
      return NextResponse.json({
        taskId: parent.taskId,
        nodeTaskId: guarded.child.taskId,
        stage,
        status: guarded.child.status,
        code: exhaustedFailure.code,
        error: exhaustedFailure.summary,
        attemptCount: guarded.child.attemptCount,
        maxAttempts: guarded.child.maxAttempts,
        retryable: false,
      }, { status: 409 })
    }
    return NextResponse.json({ error: '媒体节点状态不可执行' }, { status: 409 })
  }

  try {
    const output = await runWithN8nChildExecutionHeartbeat(db, guarded.lease, scope, async () => {
      if (stage !== 'finalize') return stageOutput(stage, parent.taskId, parent.routing, parent.input)
      const prepareRun = getN8nTaskRunByTaskId(db, mediaChildIdentity('task', parent.taskId, 'prepare'))
      const audioRun = getN8nTaskRunByTaskId(db, mediaChildIdentity('task', parent.taskId, 'audio'))
      const visionRun = getN8nTaskRunByTaskId(db, mediaChildIdentity('task', parent.taskId, 'vision'))
      const prepareFailure = mediaDependencyFailure('准备', prepareRun)
      if (prepareFailure || !prepareRun || !prepareRun.output) {
        throw new SafeOperationError('N8N_MEDIA_DEPENDENCY_FAILED', prepareFailure || '准备节点尚未成功完成')
      }
      const audioFailure = mediaDependencyFailure('音频', audioRun)
      if (audioFailure || !audioRun || !audioRun.output) {
        throw new SafeOperationError('N8N_MEDIA_DEPENDENCY_FAILED', audioFailure || '音频分析节点尚未成功完成')
      }
      const visionFailure = mediaDependencyFailure('画面', visionRun)
      if (visionFailure || !visionRun || !visionRun.output) {
        throw new SafeOperationError('N8N_MEDIA_DEPENDENCY_FAILED', visionFailure || '画面分析节点尚未成功完成')
      }
      const merged = mergeN8nMediaResults(audioRun.output, visionRun.output)
      const synthesized = await synthesizeN8nMediaResults(
        parent.taskId,
        parent.routing,
        parent.input,
        merged,
      )
      const rawMaterialId = parent.input.materialId
      const materialIdResult = rawMaterialId === undefined
        ? null
        : n8nMaterialIdentitySchema.safeParse(rawMaterialId)
      if (materialIdResult && !materialIdResult.success) {
        throw new Error('父任务素材稳定标识无效')
      }
      const materialId = materialIdResult?.success ? materialIdResult.data : null
      const mediaDurationSeconds = Number(prepareRun.output.durationSeconds)
      if (!Number.isFinite(mediaDurationSeconds) || mediaDurationSeconds <= 0) {
        throw new Error('准备节点缺少导演脑证据投影所需的媒体时长')
      }
      return {
        ...synthesized,
        ...(materialId ? { materialId } : {}),
        mediaDurationSeconds,
        analysisVersion: 'video-analysis-v1',
      }
    })
    let finalOutput = output
    if (stage === 'finalize') {
      const finalized = completeN8nFinalizeRun(db, {
        parentTaskId: parent.taskId,
        childTaskId,
        output,
        executionLease: guarded.lease,
      })
      if (finalized.outcome !== 'completed' && finalized.outcome !== 'cached') {
        const finalizeFailure = finalized.parent?.error
          ? projectSafeOperationError(finalized.parent.error, 'N8N_MEDIA_STAGE_FAILED')
          : null
        return NextResponse.json({
          taskId: parent.taskId,
          status: finalized.parent?.status || 'failed',
          ...(finalizeFailure ? { code: finalizeFailure.code } : {}),
          error: finalizeFailure?.summary || '合并结果已生成，但父任务状态无法原子提交',
        }, { status: 409 })
      }
      finalOutput = finalized.output || output
      const cleanupPending = await retryableFinalizeCleanupResponse({
        db,
        taskId: parent.taskId,
        childTaskId,
        output: finalOutput,
        cached: finalized.outcome === 'cached',
      })
      if (cleanupPending) return cleanupPending
    } else {
      const completed = completeN8nChildExecution(db, guarded.lease, output, scope)
      if (!completed.settled) throw new N8nChildExecutionLeaseLostError()
    }

    return NextResponse.json({
      taskId: parent.taskId,
      nodeTaskId: childTaskId,
      stage,
      status: 'succeeded',
      memoryMode: 'none',
      output: finalOutput,
    })
  } catch (error) {
    const failure = projectSafeOperationError(
      error,
      error instanceof N8nChildExecutionLeaseLostError
        ? 'N8N_CHILD_LEASE_LOST'
        : 'N8N_MEDIA_STAGE_FAILED',
    )
    logSafeOperationError('n8n_media_execution', error, failure)
    if (error instanceof N8nChildExecutionLeaseLostError) {
      return NextResponse.json({
        taskId: parent.taskId,
        nodeTaskId: childTaskId,
        stage,
        status: 'running',
        code: failure.code,
        error: failure.summary,
        retryable: true,
      }, { status: 409 })
    }
    const failed = failN8nChildExecution(db, guarded.lease, failure.persistedMessage, scope)
    const retryable = !failed.settled || guarded.child.attemptCount < guarded.child.maxAttempts
    if (!retryable) {
      failN8nTaskRun(
        db,
        parent.taskId,
        exhaustedChildError(stage, failure.persistedMessage, guarded.child.attemptCount, guarded.child.maxAttempts),
      )
    }
    return NextResponse.json({
      taskId: parent.taskId,
      nodeTaskId: childTaskId,
      stage,
      status: 'failed',
      code: failure.code,
      error: failure.summary,
      retryable,
      attemptCount: guarded.child.attemptCount,
      maxAttempts: guarded.child.maxAttempts,
    }, { status: failed.settled ? 502 : 409 })
  }
}
