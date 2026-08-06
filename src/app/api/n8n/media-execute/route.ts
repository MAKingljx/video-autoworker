import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getDatabase } from '@/lib/db'
import {
  analyzeN8nVideoFrames,
  cleanupExpiredN8nMediaTasks,
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
  completeN8nTaskRun,
  createN8nTaskRun,
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
  stageInput: Record<string, unknown>,
) {
  if (stage === 'prepare') return prepareN8nMedia(taskId, routing, stageInput)
  if (stage === 'audio') return transcribeN8nMedia(taskId, routing)
  if (stage === 'vision') return analyzeN8nVideoFrames(taskId, routing, taskInput)
  throw new Error(`不支持直接执行阶段：${stage}`)
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
  const parent = getN8nTaskRunByTaskId(db, parsed.data.taskId)
  if (!parent) return NextResponse.json({ error: '未找到父任务运行记录' }, { status: 404 })
  if (parent.idempotencyKey !== parsed.data.idempotencyKey) {
    return NextResponse.json({ error: '幂等键与父任务不匹配' }, { status: 409 })
  }
  if (parent.status === 'succeeded') {
    return NextResponse.json({ taskId: parent.taskId, status: parent.status, output: parent.output, cached: true })
  }
  if (String(parent.routing.taskType || '') !== 'video-analysis') {
    return NextResponse.json({ error: '当前父任务不是视频分析任务链' }, { status: 409 })
  }

  const stage = parsed.data.stage
  const childTaskId = mediaChildIdentity('task', parent.taskId, stage)
  const childIdempotencyKey = mediaChildIdentity('idem', parent.idempotencyKey, stage)
  const scope = { workspaceId: parent.workspaceId, tenantId: parent.tenantId }
  const child = createN8nTaskRun(db, {
    taskId: childTaskId,
    idempotencyKey: childIdempotencyKey,
    bindingId: parent.bindingId,
    source: 'n8n-media-node',
    requestedBy: parent.requestedBy,
    routing: {
      ...parent.routing,
      mediaStage: stage,
      memoryMode: 'none',
    },
    taskInput: parsed.data.input,
    delivery: { mode: 'none' },
    maxAttempts: 2,
  }, scope)

  if (!child.created) {
    if (child.run.status === 'succeeded') {
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
      return NextResponse.json({
        taskId: parent.taskId,
        nodeTaskId: child.run.taskId,
        stage,
        status: child.run.status,
        error: child.run.error || '媒体节点重试次数已用尽',
      }, { status: 409 })
    }
  }

  if (child.created) markN8nTaskAccepted(db, childTaskId)
  const claimed = claimN8nTaskRun(db, childTaskId)
  if (!claimed.claimed || !claimed.run) {
    return NextResponse.json({ error: '媒体节点状态不可执行' }, { status: 409 })
  }

  try {
    if (stage === 'prepare') await cleanupExpiredN8nMediaTasks().catch(() => undefined)
    let output: Record<string, unknown>
    if (stage === 'finalize') {
      const audioRun = getN8nTaskRunByTaskId(db, mediaChildIdentity('task', parent.taskId, 'audio'))
      const visionRun = getN8nTaskRunByTaskId(db, mediaChildIdentity('task', parent.taskId, 'vision'))
      if (audioRun?.status !== 'succeeded' || !audioRun.output) throw new Error('音频分析节点尚未成功完成')
      if (visionRun?.status !== 'succeeded' || !visionRun.output) throw new Error('画面分析节点尚未成功完成')
      const merged = mergeN8nMediaResults(audioRun.output, visionRun.output)
      output = await synthesizeN8nMediaResults(parent.taskId, parent.routing, parent.input, merged)
    } else {
      output = await stageOutput(stage, parent.taskId, parent.routing, parent.input, parsed.data.input)
    }
    if (stage === 'finalize') await cleanupN8nMediaTask(parent.taskId)
    completeN8nTaskRun(db, childTaskId, output)

    if (stage === 'finalize') {
      const currentParent = getN8nTaskRunByTaskId(db, parent.taskId)
      const parentClaim = currentParent?.status === 'running'
        ? { claimed: true, run: currentParent }
        : claimN8nTaskRun(db, parent.taskId)
      if (!parentClaim.claimed || !parentClaim.run) throw new Error('合并结果已生成，但父任务状态无法提交')
      completeN8nTaskRun(db, parent.taskId, output)
    }

    return NextResponse.json({
      taskId: parent.taskId,
      nodeTaskId: childTaskId,
      stage,
      status: 'succeeded',
      memoryMode: 'none',
      output,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : '媒体节点执行失败'
    failN8nTaskRun(db, childTaskId, message)
    failN8nTaskRun(db, parent.taskId, `${stage}: ${message}`)
    const retryable = claimed.run.attemptCount < claimed.run.maxAttempts
    return NextResponse.json({
      taskId: parent.taskId,
      nodeTaskId: childTaskId,
      stage,
      status: 'failed',
      error: message,
      retryable,
    }, { status: 502 })
  }
}
