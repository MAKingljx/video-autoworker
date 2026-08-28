import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/db'
import {
  analyzeN8nVideoFrames,
  cleanupN8nMediaTask,
  mediaChildIdentity,
  mergeN8nMediaResults,
  prepareN8nMedia,
  synthesizeN8nMediaResults,
  transcribeN8nMedia,
  type N8nMediaStage,
} from '@/lib/n8n-media-execution'
import { verifyN8nWebhookSecret } from '@/lib/n8n'
import {
  claimN8nTaskRun,
  completeN8nFinalizeRun,
  completeN8nTaskRun,
  createN8nMediaChildRunFromParent,
  failN8nTaskRun,
  getN8nTaskRunByTaskId,
  markN8nTaskAccepted,
  n8nTaskIdentitySchema,
} from '@/lib/n8n-task-runs'

export const runtime = 'nodejs'

const mediaRequestSchema = z.object({
  taskId: n8nTaskIdentitySchema,
  idempotencyKey: n8nTaskIdentitySchema,
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
  if (['failed', 'cancelled'].includes(observedParent.status)) {
    return NextResponse.json({
      taskId: observedParent.taskId,
      status: observedParent.status,
      error: observedParent.error || '父任务已结束，拒绝迟到的媒体节点回调',
    }, { status: 409 })
  }
  if (observedParent.status === 'succeeded') {
    return NextResponse.json({
      taskId: observedParent.taskId,
      status: observedParent.status,
      output: observedParent.output,
      cached: true,
    })
  }
  if (String(observedParent.routing.taskType || '') !== 'video-analysis') {
    return NextResponse.json({ error: '当前父任务不是视频分析任务链' }, { status: 409 })
  }

  const stage = parsed.data.stage
  if (stage === 'prepare') {
    const parentVideoKey = typeof observedParent.input.videoKey === 'string' ? observedParent.input.videoKey : ''
    const requestedVideoKey = typeof parsed.data.input.videoKey === 'string' ? parsed.data.input.videoKey : ''
    if (!parentVideoKey || requestedVideoKey !== parentVideoKey) {
      return NextResponse.json({ error: '视频标识与父任务不匹配' }, { status: 409 })
    }
  }
  const guarded = createN8nMediaChildRunFromParent(db, {
    parentTaskId: parsed.data.taskId,
    parentIdempotencyKey: parsed.data.idempotencyKey,
    stage,
    taskInput: parsed.data.input,
  })
  if (guarded.outcome === 'not_found') {
    return NextResponse.json({ error: '未找到父任务运行记录' }, { status: 404 })
  }
  if (guarded.outcome === 'terminal') {
    if (guarded.parent?.status === 'succeeded') {
      return NextResponse.json({
        taskId: guarded.parent.taskId,
        status: guarded.parent.status,
        output: guarded.parent.output,
        cached: true,
      })
    }
    return NextResponse.json({
      taskId: guarded.parent?.taskId || parsed.data.taskId,
      status: guarded.parent?.status || 'failed',
      error: guarded.parent?.error || '父任务已结束，拒绝迟到的媒体节点回调',
    }, { status: 409 })
  }
  if (guarded.outcome === 'rejected' || !guarded.parent || !guarded.child) {
    return NextResponse.json({ error: '父任务身份或状态不允许创建媒体节点' }, { status: 409 })
  }
  const parent = guarded.parent
  const childTaskId = guarded.child.taskId
  const child = { created: guarded.outcome === 'created', run: guarded.child }

  if (!child.created) {
    if (child.run.status === 'succeeded') {
      if (stage === 'finalize') {
        const finalized = completeN8nFinalizeRun(db, {
          parentTaskId: parent.taskId,
          childTaskId: child.run.taskId,
        })
        if (finalized.outcome === 'completed' || finalized.outcome === 'cached') {
          return NextResponse.json({
            taskId: parent.taskId,
            nodeTaskId: child.run.taskId,
            stage,
            status: 'succeeded',
            output: finalized.output,
            cached: true,
          })
        }
        return NextResponse.json({
          taskId: parent.taskId,
          status: finalized.parent?.status || 'failed',
          error: finalized.parent?.error || '最终媒体节点无法补全父任务状态',
        }, { status: 409 })
      }
      return NextResponse.json({
        taskId: parent.taskId,
        nodeTaskId: child.run.taskId,
        stage,
        status: child.run.status,
        output: child.run.output,
        cached: true,
      })
    }
    if (child.run.status === 'running') {
      return NextResponse.json({
        taskId: parent.taskId,
        nodeTaskId: child.run.taskId,
        stage,
        status: child.run.status,
        error: child.run.error || '媒体节点正在执行',
      }, { status: 202 })
    }
    if (child.run.status === 'failed' && child.run.attemptCount >= child.run.maxAttempts) {
      failN8nTaskRun(
        db,
        parent.taskId,
        exhaustedChildError(
          stage,
          child.run.error || '媒体节点重试次数已用尽',
          child.run.attemptCount,
          child.run.maxAttempts,
        ),
      )
      return NextResponse.json({
        taskId: parent.taskId,
        nodeTaskId: child.run.taskId,
        stage,
        status: child.run.status,
        error: child.run.error || '媒体节点重试次数已用尽',
        attemptCount: child.run.attemptCount,
        maxAttempts: child.run.maxAttempts,
        retryable: false,
      }, { status: 409 })
    }
  }

  if (child.created) markN8nTaskAccepted(db, childTaskId)
  const claimed = claimN8nTaskRun(db, childTaskId)
  if (!claimed.claimed || !claimed.run) {
    return NextResponse.json({ error: '媒体节点状态不可执行' }, { status: 409 })
  }

  try {
    let output: Record<string, unknown>
    if (stage === 'finalize') {
      const audioRun = getN8nTaskRunByTaskId(db, mediaChildIdentity('task', parent.taskId, 'audio'))
      const visionRun = getN8nTaskRunByTaskId(db, mediaChildIdentity('task', parent.taskId, 'vision'))
      const audioFailure = mediaDependencyFailure('音频', audioRun)
      if (audioFailure || !audioRun || !audioRun.output) {
        throw new Error(audioFailure || '音频分析节点尚未成功完成')
      }
      const visionFailure = mediaDependencyFailure('画面', visionRun)
      if (visionFailure || !visionRun || !visionRun.output) {
        throw new Error(visionFailure || '画面分析节点尚未成功完成')
      }
      const merged = mergeN8nMediaResults(audioRun.output, visionRun.output)
      output = await synthesizeN8nMediaResults(parent.taskId, parent.routing, parent.input, merged)
    } else {
      output = await stageOutput(stage, parent.taskId, parent.routing, parent.input)
    }
    if (stage === 'finalize') await cleanupN8nMediaTask(parent.taskId)
    let finalOutput = output
    if (stage === 'finalize') {
      const finalized = completeN8nFinalizeRun(db, {
        parentTaskId: parent.taskId,
        childTaskId,
        output,
      })
      if (finalized.outcome !== 'completed' && finalized.outcome !== 'cached') {
        return NextResponse.json({
          taskId: parent.taskId,
          status: finalized.parent?.status || 'failed',
          error: finalized.parent?.error || '合并结果已生成，但父任务状态无法原子提交',
        }, { status: 409 })
      }
      finalOutput = finalized.output || output
    } else {
      completeN8nTaskRun(db, childTaskId, output)
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
    const message = error instanceof Error ? error.message.slice(0, 2_000) : '媒体节点执行失败'
    failN8nTaskRun(db, childTaskId, message)
    const retryable = claimed.run.attemptCount < claimed.run.maxAttempts
    if (!retryable) {
      failN8nTaskRun(
        db,
        parent.taskId,
        exhaustedChildError(stage, message, claimed.run.attemptCount, claimed.run.maxAttempts),
      )
    }
    return NextResponse.json({
      taskId: parent.taskId,
      nodeTaskId: childTaskId,
      stage,
      status: 'failed',
      error: message,
      retryable,
      attemptCount: claimed.run.attemptCount,
      maxAttempts: claimed.run.maxAttempts,
    }, { status: 502 })
  }
}
