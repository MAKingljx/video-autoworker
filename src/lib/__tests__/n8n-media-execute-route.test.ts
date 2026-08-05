import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  verifyN8nWebhookSecret: vi.fn(),
  getDatabase: vi.fn(),
  createN8nTaskRun: vi.fn(),
  getN8nTaskRunByTaskId: vi.fn(),
  markN8nTaskAccepted: vi.fn(),
  claimN8nTaskRun: vi.fn(),
  completeN8nTaskRun: vi.fn(),
  failN8nTaskRun: vi.fn(),
  prepareN8nMedia: vi.fn(),
  transcribeN8nMedia: vi.fn(),
  analyzeN8nVideoFrames: vi.fn(),
  mergeN8nMediaResults: vi.fn(),
  cleanupN8nMediaTask: vi.fn(),
  cleanupExpiredN8nMediaTasks: vi.fn(),
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
    cleanupN8nMediaTask: mocks.cleanupN8nMediaTask,
    cleanupExpiredN8nMediaTasks: mocks.cleanupExpiredN8nMediaTasks,
  }
})
vi.mock('@/lib/n8n-task-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-task-runs')>()
  return {
    ...actual,
    createN8nTaskRun: mocks.createN8nTaskRun,
    getN8nTaskRunByTaskId: mocks.getN8nTaskRunByTaskId,
    markN8nTaskAccepted: mocks.markN8nTaskAccepted,
    claimN8nTaskRun: mocks.claimN8nTaskRun,
    completeN8nTaskRun: mocks.completeN8nTaskRun,
    failN8nTaskRun: mocks.failN8nTaskRun,
  }
})

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
  input: { prompt: '分析视频', videoKey: '123e4567-e89b-42d3-a456-426614174000.mp4' },
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

function request(stage: 'prepare' | 'audio' | 'vision' | 'finalize', secret = 'shared-secret') {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/media-execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-AIWorker-Webhook-Secret': secret },
    body: JSON.stringify({
      taskId: parent.taskId,
      idempotencyKey: parent.idempotencyKey,
      stage,
      input: stage === 'prepare' ? parent.input : {},
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
      if (taskId.includes(':audio:')) return { ...parent, taskId, status: 'succeeded', output: { transcript: '音频结果', model: 'large-v3-turbo' } }
      if (taskId.includes(':vision:')) return { ...parent, taskId, status: 'succeeded', output: { analysis: '画面结果', model: 'default_model' } }
      return null
    })
    mocks.createN8nTaskRun.mockImplementation((_db, input) => ({
      created: true,
      run: { ...parent, taskId: input.taskId, idempotencyKey: input.idempotencyKey, status: 'queued' },
    }))
    mocks.claimN8nTaskRun.mockImplementation((_db, taskId) => ({
      claimed: true,
      run: { ...parent, taskId, status: 'running', attemptCount: 1 },
    }))
    mocks.prepareN8nMedia.mockResolvedValue({
      kind: 'prepared-video', durationSeconds: 4, sourceBytes: 100, audioAvailable: true, frameCount: 4, memoryMode: 'none',
    })
    mocks.mergeN8nMediaResults.mockReturnValue({ combinedText: '合并结果', memoryMode: 'none' })
    mocks.cleanupExpiredN8nMediaTasks.mockResolvedValue(0)
    mocks.cleanupN8nMediaTask.mockResolvedValue(undefined)
  })

  it('rejects a callback without the shared secret', async () => {
    mocks.verifyN8nWebhookSecret.mockReturnValue(false)
    const response = await POST(request('prepare', 'wrong'))
    expect(response.status).toBe(401)
    expect(mocks.getDatabase).not.toHaveBeenCalled()
  })

  it('prepares the controlled video as a stateless child run', async () => {
    const response = await POST(request('prepare'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ stage: 'prepare', status: 'succeeded', memoryMode: 'none' })
    expect(mocks.createN8nTaskRun).toHaveBeenCalledWith({}, expect.objectContaining({
      source: 'n8n-media-node',
      delivery: { mode: 'none' },
      maxAttempts: 1,
      routing: expect.objectContaining({ mediaStage: 'prepare', memoryMode: 'none' }),
    }), { workspaceId: 2, tenantId: 3 })
    expect(mocks.prepareN8nMedia).toHaveBeenCalledWith(parent.taskId, parent.routing, parent.input)
    expect(mocks.completeN8nTaskRun).toHaveBeenCalledTimes(1)
  })

  it('merges persisted audio and vision outputs before completing the parent', async () => {
    const response = await POST(request('finalize'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      stage: 'finalize',
      output: { combinedText: '合并结果', memoryMode: 'none' },
    })
    expect(mocks.mergeN8nMediaResults).toHaveBeenCalledWith(
      expect.objectContaining({ transcript: '音频结果' }),
      expect.objectContaining({ analysis: '画面结果' }),
    )
    expect(mocks.completeN8nTaskRun).toHaveBeenCalledTimes(2)
    expect(mocks.cleanupN8nMediaTask).toHaveBeenCalledWith(parent.taskId)
  })

  it('fails the child and parent when a worker errors', async () => {
    mocks.prepareN8nMedia.mockRejectedValue(new Error('视频容器探测失败'))
    const response = await POST(request('prepare'))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ stage: 'prepare', status: 'failed', retryable: false })
    expect(mocks.failN8nTaskRun).toHaveBeenCalledTimes(2)
  })

  it('does not report final success when media cleanup fails', async () => {
    mocks.cleanupN8nMediaTask.mockRejectedValue(new Error('媒体临时目录清理失败'))
    const response = await POST(request('finalize'))
    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ stage: 'finalize', status: 'failed' })
    expect(mocks.completeN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.failN8nTaskRun).toHaveBeenCalledTimes(2)
  })
})
