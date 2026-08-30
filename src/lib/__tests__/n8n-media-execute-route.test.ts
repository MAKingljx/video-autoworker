import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyN8nWebhookSecret: vi.fn(),
  getDatabase: vi.fn(),
  createN8nMediaChildRunFromParent: vi.fn(),
  getN8nTaskRunByTaskId: vi.fn(),
  markN8nTaskAccepted: vi.fn(),
  claimN8nTaskRun: vi.fn(),
  completeN8nFinalizeRun: vi.fn(),
  completeN8nTaskRun: vi.fn(),
  failN8nTaskRun: vi.fn(),
  prepareN8nMedia: vi.fn(),
  transcribeN8nMedia: vi.fn(),
  analyzeN8nVideoFrames: vi.fn(),
  mergeN8nMediaResults: vi.fn(),
  synthesizeN8nMediaResults: vi.fn(),
  cleanupN8nMediaTask: vi.fn(),
  ensureN8nMediaCleanupDebt: vi.fn(),
  retryN8nMediaCleanupDebt: vi.fn(),
}))

vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n', () => ({ verifyN8nWebhookSecret: mocks.verifyN8nWebhookSecret }))
vi.mock('@/lib/n8n-media-execution', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-media-execution')>()
  return {
    ...actual,
    prepareN8nMedia: mocks.prepareN8nMedia,
    transcribeN8nMedia: mocks.transcribeN8nMedia,
    analyzeN8nVideoFrames: mocks.analyzeN8nVideoFrames,
    mergeN8nMediaResults: mocks.mergeN8nMediaResults,
    synthesizeN8nMediaResults: mocks.synthesizeN8nMediaResults,
    cleanupN8nMediaTask: mocks.cleanupN8nMediaTask,
  }
})
vi.mock('@/lib/n8n-task-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-task-runs')>()
  return {
    ...actual,
    createN8nMediaChildRunFromParent: mocks.createN8nMediaChildRunFromParent,
    getN8nTaskRunByTaskId: mocks.getN8nTaskRunByTaskId,
    markN8nTaskAccepted: mocks.markN8nTaskAccepted,
    claimN8nTaskRun: mocks.claimN8nTaskRun,
    completeN8nFinalizeRun: mocks.completeN8nFinalizeRun,
    completeN8nTaskRun: mocks.completeN8nTaskRun,
    failN8nTaskRun: mocks.failN8nTaskRun,
    ensureN8nMediaCleanupDebt: mocks.ensureN8nMediaCleanupDebt,
  }
})
vi.mock('@/lib/n8n-media-cleanup', () => ({
  retryN8nMediaCleanupDebt: mocks.retryN8nMediaCleanupDebt,
}))

import { POST } from '@/app/api/n8n/media-execute/route'

const parent = {
  id: 1,
  taskId: 'video-parent-1',
  idempotencyKey: 'video-idem-1',
  bindingId: 9,
  status: 'accepted',
  source: 'openclaw',
  requestedBy: 'local-desktop',
  routing: { taskType: 'video-analysis', config: {} },
  input: {
    prompt: '分析视频',
    videoKey: '123e4567-e89b-42d3-a456-426614174000.mp4',
    materialId: 'MATERIAL-EXISTING-001',
  },
  delivery: { mode: 'none' as const },
  output: null,
  error: null,
  attemptCount: 0,
  maxAttempts: 2,
  workspaceId: 2,
  tenantId: 3,
  createdAt: 1,
  acceptedAt: 1,
  startedAt: null,
  completedAt: null,
  updatedAt: 1,
}

function request(
  stage: 'prepare' | 'audio' | 'vision' | 'finalize',
  secret = 'shared-secret',
  input = stage === 'prepare' ? parent.input : {},
) {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/media-execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AIWorker-Webhook-Secret': secret },
    body: JSON.stringify({
      taskId: parent.taskId,
      idempotencyKey: parent.idempotencyKey,
      stage,
      input,
    }),
  })
}

describe('n8n media node execution route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.verifyN8nWebhookSecret.mockReturnValue(true)
    mocks.getDatabase.mockReturnValue({})
    mocks.getN8nTaskRunByTaskId.mockImplementation((_db, taskId: string) => {
      if (taskId === parent.taskId) return parent
      if (taskId.includes(':prepare:')) return { ...parent, taskId, status: 'succeeded', output: { durationSeconds: 4 } }
      if (taskId.includes(':audio:')) return { ...parent, taskId, status: 'succeeded', output: { transcript: '音频结果', model: 'large-v3-turbo' } }
      if (taskId.includes(':vision:')) return { ...parent, taskId, status: 'succeeded', output: { analysis: '画面结果', model: 'default_model' } }
      return null
    })
    mocks.createN8nMediaChildRunFromParent.mockImplementation((_db, input) => {
      const digest = createHash('sha256')
        .update(`${input.parentTaskId}:${input.stage}`)
        .digest('hex')
        .slice(0, 24)
      return {
        outcome: 'created',
        parent,
        child: {
          ...parent,
          taskId: `media-task:${input.parentTaskId}:${input.stage}:${digest}`,
          idempotencyKey: `media-idem:${input.parentIdempotencyKey}:${input.stage}:${digest}`,
          status: 'queued',
        },
      }
    })
    mocks.claimN8nTaskRun.mockImplementation((_db, taskId) => ({
      claimed: true,
      run: { ...parent, taskId, status: 'running', attemptCount: 1 },
    }))
    mocks.completeN8nFinalizeRun.mockImplementation((_db, input) => ({
      outcome: 'completed',
      parent: { ...parent, status: 'succeeded', output: input.output },
      child: { ...parent, taskId: input.childTaskId, status: 'succeeded', output: input.output },
      output: input.output,
    }))
    mocks.prepareN8nMedia.mockResolvedValue({
      kind: 'prepared-video', durationSeconds: 4, sourceBytes: 100, audioAvailable: true, frameCount: 4, segmentCount: 1, segmentSeconds: 60, memoryMode: 'none',
    })
    mocks.mergeN8nMediaResults.mockReturnValue({ combinedText: '合并结果', memoryMode: 'none' })
    mocks.synthesizeN8nMediaResults.mockResolvedValue({ combinedText: '最终汇总', memoryMode: 'none' })
    mocks.cleanupN8nMediaTask.mockResolvedValue(undefined)
    mocks.ensureN8nMediaCleanupDebt.mockReturnValue({ scheduled: true, reason: 'finalize_succeeded' })
    mocks.retryN8nMediaCleanupDebt.mockResolvedValue({ outcome: 'cleaned', debt: null, error: null })
  })

  it('rejects a callback without the shared secret', async () => {
    mocks.verifyN8nWebhookSecret.mockReturnValue(false)
    const response = await POST(request('prepare', 'wrong'))
    expect(response.status).toBe(401)
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })

  it.each(['failed', 'cancelled'])('rejects a late callback after the parent is %s', async status => {
    mocks.getN8nTaskRunByTaskId.mockImplementation((_db, taskId: string) => (
      taskId === parent.taskId ? { ...parent, status, error: 'parent terminal' } : null
    ))

    const response = await POST(request('prepare'))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      taskId: parent.taskId,
      status,
      error: 'parent terminal',
    })
    expect(mocks.createN8nMediaChildRunFromParent).not.toHaveBeenCalled()
    expect(mocks.claimN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.prepareN8nMedia).not.toHaveBeenCalled()
  })

  it('rejects a callback when reconciliation wins after the preliminary parent read', async () => {
    mocks.createN8nMediaChildRunFromParent.mockReturnValue({
      outcome: 'terminal',
      parent: { ...parent, status: 'failed', error: '[VIDEO_CALLBACK_LEASE_EXPIRED] expired' },
      child: null,
    })

    const response = await POST(request('prepare'))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      taskId: parent.taskId,
      status: 'failed',
      error: expect.stringContaining('VIDEO_CALLBACK_LEASE_EXPIRED'),
    })
    expect(mocks.createN8nMediaChildRunFromParent).toHaveBeenCalledTimes(1)
    expect(mocks.claimN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.prepareN8nMedia).not.toHaveBeenCalled()
  })

  it('prepares the controlled video as a stateless child run', async () => {
    const response = await POST(request('prepare'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ stage: 'prepare', status: 'succeeded', memoryMode: 'none' })
    expect(mocks.createN8nMediaChildRunFromParent).toHaveBeenCalledWith({}, {
      parentTaskId: parent.taskId,
      parentIdempotencyKey: parent.idempotencyKey,
      stage: 'prepare',
      taskInput: parent.input,
    })
    expect(mocks.prepareN8nMedia).toHaveBeenCalledWith(parent.taskId, parent.routing, parent.input)
    expect(mocks.completeN8nTaskRun).toHaveBeenCalledTimes(1)
  })

  it('does not sweep an unrelated expired controlled inbox file before prepare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiworker-media-route-test-'))
    const inbox = join(root, 'inbox')
    const work = join(root, 'work')
    const historicalVideo = join(inbox, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4')
    const previousInbox = process.env.AIWORKER_MEDIA_INGEST_DIR
    const previousWork = process.env.AIWORKER_MEDIA_WORK_DIR
    try {
      await mkdir(inbox, { recursive: true })
      await mkdir(work, { recursive: true })
      await writeFile(historicalVideo, 'historical-video')
      const expired = new Date(Date.now() - 25 * 60 * 60 * 1_000)
      await utimes(historicalVideo, expired, expired)
      const before = await stat(historicalVideo)
      const beforeHash = createHash('sha256').update(await readFile(historicalVideo)).digest('hex')
      process.env.AIWORKER_MEDIA_INGEST_DIR = inbox
      process.env.AIWORKER_MEDIA_WORK_DIR = work

      const response = await POST(request('prepare'))

      expect(response.status).toBe(200)
      const after = await stat(historicalVideo)
      expect(await readFile(historicalVideo, 'utf8')).toBe('historical-video')
      expect(createHash('sha256').update(await readFile(historicalVideo)).digest('hex')).toBe(beforeHash)
      expect(after.ino).toBe(before.ino)
      expect(after.size).toBe(before.size)
      expect(after.mtimeMs).toBe(before.mtimeMs)
    } finally {
      if (previousInbox === undefined) delete process.env.AIWORKER_MEDIA_INGEST_DIR
      else process.env.AIWORKER_MEDIA_INGEST_DIR = previousInbox
      if (previousWork === undefined) delete process.env.AIWORKER_MEDIA_WORK_DIR
      else process.env.AIWORKER_MEDIA_WORK_DIR = previousWork
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a prepare video key that is not owned by the parent task', async () => {
    const otherVideoKey = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.mp4'
    const response = await POST(request('prepare', 'shared-secret', {
      ...parent.input,
      videoKey: otherVideoKey,
    }))

    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: '视频标识与父任务不匹配' })
    expect(mocks.createN8nMediaChildRunFromParent).not.toHaveBeenCalled()
    expect(mocks.prepareN8nMedia).not.toHaveBeenCalled()
  })

  it('merges persisted audio and vision outputs before completing the parent', async () => {
    const response = await POST(request('finalize'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      stage: 'finalize',
      output: { combinedText: '最终汇总', memoryMode: 'none' },
    })
    expect(mocks.mergeN8nMediaResults).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: '音频结果' }),
      expect.objectContaining({ analysis: '画面结果' }),
    )
    expect(mocks.synthesizeN8nMediaResults).toHaveBeenCalledWith(
      parent.taskId,
      parent.routing,
      parent.input,
      expect.objectContaining({ combinedText: '合并结果' }),
    )
    expect(mocks.completeN8nFinalizeRun).toHaveBeenCalledWith({}, expect.objectContaining({
      parentTaskId: parent.taskId,
      childTaskId: expect.stringContaining(':finalize:'),
      output: {
        combinedText: '最终汇总',
        memoryMode: 'none',
        materialId: parent.input.materialId,
        mediaDurationSeconds: 4,
        analysisVersion: 'video-analysis-v1',
      },
    }))
    expect(mocks.completeN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.ensureN8nMediaCleanupDebt).toHaveBeenCalledWith({}, parent.taskId)
    expect(mocks.retryN8nMediaCleanupDebt).toHaveBeenCalledWith({}, parent.taskId, { force: true })
    expect(mocks.completeN8nFinalizeRun.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.retryN8nMediaCleanupDebt.mock.invocationCallOrder[0])
  })

  it('never promotes a temporary inbox video key to a material ID', async () => {
    const legacyParent = {
      ...parent,
      input: { prompt: parent.input.prompt, videoKey: parent.input.videoKey },
    }
    mocks.createN8nMediaChildRunFromParent.mockReturnValue({
      outcome: 'created',
      parent: legacyParent,
      child: {
        ...legacyParent,
        taskId: 'media-task:video-parent-1:finalize:legacy',
        idempotencyKey: 'media-idem:video-parent-1:finalize:legacy',
        status: 'queued',
      },
    })

    const response = await POST(request('finalize'))
    expect(response.status).toBe(200)
    expect(mocks.completeN8nFinalizeRun).toHaveBeenCalledWith({}, expect.objectContaining({
      output: expect.not.objectContaining({ materialId: expect.anything() }),
    }))
  })

  it('fails closed when a persisted optional material ID is malformed', async () => {
    const invalidParent = {
      ...parent,
      input: { ...parent.input, materialId: '/private/source/video.mp4' },
    }
    mocks.createN8nMediaChildRunFromParent.mockReturnValue({
      outcome: 'created',
      parent: invalidParent,
      child: {
        ...invalidParent,
        taskId: 'media-task:video-parent-1:finalize:invalid-material',
        idempotencyKey: 'media-idem:video-parent-1:finalize:invalid-material',
        status: 'queued',
      },
    })

    const response = await POST(request('finalize'))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/素材稳定标识无效/u),
    })
    expect(mocks.completeN8nFinalizeRun).not.toHaveBeenCalled()
  })

  it('repairs the parent atomically when a cached finalize child already succeeded', async () => {
    const persistedOutput = { combinedText: 'persisted finalize result', memoryMode: 'none' }
    mocks.createN8nMediaChildRunFromParent.mockReturnValue({
      outcome: 'existing',
      parent,
      child: {
        ...parent,
        taskId: 'media-task:video-parent-1:finalize:cached',
        status: 'succeeded',
        output: persistedOutput,
      },
    })
    mocks.completeN8nFinalizeRun.mockReturnValue({
      outcome: 'completed',
      parent: { ...parent, status: 'succeeded', output: persistedOutput },
      child: {
        ...parent,
        taskId: 'media-task:video-parent-1:finalize:cached',
        status: 'succeeded',
        output: persistedOutput,
      },
      output: persistedOutput,
    })

    const response = await POST(request('finalize'))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      taskId: parent.taskId,
      stage: 'finalize',
      status: 'succeeded',
      output: persistedOutput,
      cached: true,
    })
    expect(mocks.completeN8nFinalizeRun).toHaveBeenCalledWith({}, {
      parentTaskId: parent.taskId,
      childTaskId: 'media-task:video-parent-1:finalize:cached',
    })
    expect(mocks.synthesizeN8nMediaResults).not.toHaveBeenCalled()
    expect(mocks.claimN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.retryN8nMediaCleanupDebt).toHaveBeenCalledWith({}, parent.taskId, { force: true })
  })

  it('retries only cleanup when the parent was already committed before a process exit', async () => {
    const persistedOutput = { combinedText: 'durable finalize result', memoryMode: 'none' }
    mocks.getN8nTaskRunByTaskId.mockImplementation((_db, taskId: string) => (
      taskId === parent.taskId
        ? { ...parent, status: 'succeeded', output: persistedOutput }
        : null
    ))
    mocks.retryN8nMediaCleanupDebt
      .mockResolvedValueOnce({ outcome: 'pending', debt: { attemptCount: 1 }, error: 'first cleanup attempt failed' })
      .mockResolvedValueOnce({ outcome: 'cleaned', debt: null, error: null })

    const pending = await POST(request('finalize'))
    expect(pending.status).toBe(502)
    expect(await pending.json()).toMatchObject({
      taskId: parent.taskId,
      status: 'succeeded',
      output: persistedOutput,
      cached: true,
      cleanupPending: true,
      retryable: true,
    })
    expect(mocks.createN8nMediaChildRunFromParent).not.toHaveBeenCalled()
    expect(mocks.failN8nTaskRun).not.toHaveBeenCalled()

    const recovered = await POST(request('finalize'))
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({
      taskId: parent.taskId,
      status: 'succeeded',
      output: persistedOutput,
      cached: true,
    })
    expect(mocks.retryN8nMediaCleanupDebt).toHaveBeenCalledTimes(2)
    expect(mocks.failN8nTaskRun).not.toHaveBeenCalled()
  })

  it('fails only the child while the worker error remains retryable', async () => {
    mocks.prepareN8nMedia.mockRejectedValue(new Error('视频容器探测失败'))
    const response = await POST(request('prepare'))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      stage: 'prepare',
      status: 'failed',
      retryable: true,
      attemptCount: 1,
      maxAttempts: 2,
    })
    expect(mocks.failN8nTaskRun).toHaveBeenCalledTimes(1)
    expect(mocks.failN8nTaskRun).toHaveBeenCalledWith(
      {},
      expect.stringContaining(':prepare:'),
      '视频容器探测失败',
    )
  })

  it('fails the parent only after the child reaches its attempt limit', async () => {
    mocks.claimN8nTaskRun.mockReturnValue({
      claimed: true,
      run: { ...parent, taskId: 'media-task:video-parent-1:prepare', status: 'running', attemptCount: 2, maxAttempts: 2 },
    })
    mocks.prepareN8nMedia.mockRejectedValue(new Error('视频容器探测失败'))
    const response = await POST(request('prepare'))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ stage: 'prepare', status: 'failed', retryable: false })
    expect(mocks.failN8nTaskRun).toHaveBeenCalledTimes(2)
    expect(mocks.failN8nTaskRun).toHaveBeenNthCalledWith(
      2,
      {},
      parent.taskId,
      expect.stringContaining('重试次数已用尽 2/2'),
    )
  })

  it('surfaces persisted dependency failure details during finalize', async () => {
    mocks.getN8nTaskRunByTaskId.mockImplementation((_db, taskId: string) => {
      if (taskId === parent.taskId) return parent
      if (taskId.includes(':prepare:')) return {
        ...parent,
        taskId,
        status: 'succeeded',
        output: { durationSeconds: 4 },
      }
      if (taskId.includes(':audio:')) return {
        ...parent,
        taskId,
        status: 'succeeded',
        output: { transcript: '音频结果', model: 'large-v3-turbo' },
      }
      if (taskId.includes(':vision:')) return {
        ...parent,
        taskId,
        status: 'failed',
        output: null,
        error: 'vision: fetch failed（模型服务 HTTP 503）',
        attemptCount: 2,
        maxAttempts: 2,
      }
      return null
    })
    const response = await POST(request('finalize'))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ stage: 'finalize', status: 'failed', retryable: true })
    expect(mocks.failN8nTaskRun).toHaveBeenCalledWith(
      {},
      expect.stringContaining(':finalize:'),
      expect.stringContaining('画面分析节点尚未成功完成（状态：failed，尝试：2/2，错误：vision: fetch failed'),
    )
    expect(mocks.failN8nTaskRun).toHaveBeenCalledTimes(1)
  })

  it('keeps the committed result succeeded when media cleanup fails', async () => {
    mocks.retryN8nMediaCleanupDebt.mockResolvedValue({
      outcome: 'pending', debt: { attemptCount: 1 }, error: '媒体临时目录清理失败',
    })
    const response = await POST(request('finalize'))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({
      stage: 'finalize',
      status: 'succeeded',
      cleanupPending: true,
      retryable: true,
    })
    expect(mocks.completeN8nFinalizeRun).toHaveBeenCalledTimes(1)
    expect(mocks.completeN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.failN8nTaskRun).not.toHaveBeenCalled()
  })

  it('does not clean media when the atomic finalize commit is rejected', async () => {
    mocks.completeN8nFinalizeRun.mockReturnValue({
      outcome: 'rejected',
      parent: { ...parent, status: 'accepted', error: null },
      child: { ...parent, status: 'running', error: null },
      output: null,
    })

    const response = await POST(request('finalize'))

    expect(response.status).toBe(409)
    expect(mocks.retryN8nMediaCleanupDebt).not.toHaveBeenCalled()
    expect(mocks.failN8nTaskRun).not.toHaveBeenCalled()
  })
})
