import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listN8nActiveTaskRunSummaries: vi.fn(),
  listScopedN8nTaskRunStatusSummaries: vi.fn(),
  listN8nVideoQueueItems: vi.fn(),
  listN8nWorkflowBindings: vi.fn(),
}))

vi.mock('@/lib/n8n-task-runs', () => ({
  listN8nActiveTaskRunSummaries: mocks.listN8nActiveTaskRunSummaries,
  listScopedN8nTaskRunStatusSummaries: mocks.listScopedN8nTaskRunStatusSummaries,
}))
vi.mock('@/lib/n8n-video-sources', () => ({
  listN8nVideoQueueItems: mocks.listN8nVideoQueueItems,
}))
vi.mock('@/lib/n8n-workflows', () => ({
  listN8nWorkflowBindings: mocks.listN8nWorkflowBindings,
}))

import { listN8nTaskQueue } from '@/lib/n8n-task-queue'

describe('n8n task queue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.listN8nWorkflowBindings.mockReturnValue([{
      id: 2,
      name: '视频分析链',
      taskType: 'video-analysis',
      retryCount: 1,
    }])
    mocks.listN8nVideoQueueItems.mockResolvedValue([
      {
        taskId: 'queued-video',
        name: '待处理.mp4',
        status: 'queued',
        batchId: 'batch-a',
        batchIndex: 2,
        batchStatus: 'running',
        bindingId: 2,
        createdAt: 100,
        updatedAt: 120,
        submittedAt: null,
        error: null,
        sourceAvailable: true,
        queuePosition: 1,
      },
      {
        taskId: 'other-workspace-video',
        name: '不应显示.mp4',
        status: 'queued',
        batchId: 'batch-private',
        batchIndex: 1,
        batchStatus: 'queued',
        bindingId: 99,
        createdAt: 90,
        updatedAt: 90,
        submittedAt: null,
        error: null,
        sourceAvailable: true,
        queuePosition: 1,
      },
    ])
    const acceptedRun = {
      taskId: 'queued-video',
      title: '待处理.mp4',
      taskType: 'video-analysis',
      workflowName: '视频分析链',
      status: 'accepted',
      source: 'openclaw',
      attemptCount: 0,
      maxAttempts: 2,
      createdAt: 100,
      acceptedAt: 115,
      startedAt: null,
      processingStartedAt: null,
      completedAt: null,
      updatedAt: 120,
      error: null,
      resultAvailable: false,
      batchId: 'batch-a',
      batchIndex: 2,
    }
    mocks.listScopedN8nTaskRunStatusSummaries.mockReturnValue([acceptedRun])
    mocks.listN8nActiveTaskRunSummaries.mockReturnValue([
      acceptedRun,
      {
        taskId: 'stale-run',
        title: '历史滞留任务',
        taskType: 'video-analysis',
        workflowName: '视频分析链',
        status: 'accepted',
        source: 'openclaw',
        attemptCount: 0,
        maxAttempts: 1,
        createdAt: 10,
        acceptedAt: 10,
        startedAt: null,
        processingStartedAt: null,
        completedAt: null,
        updatedAt: 10,
        error: null,
        resultAvailable: false,
        batchId: null,
        batchIndex: null,
      },
    ])
  })

  it('merges durable and n8n queues, scopes bindings and flags stale orphan runs', async () => {
    const result = await listN8nTaskQueue(
      {} as never,
      { workspaceId: 2, tenantId: 3 },
      100_000,
    )

    expect(result.total).toBe(2)
    expect(result.queue).toMatchObject([
      {
        taskId: 'queued-video',
        status: 'accepted',
        queueOrigin: 'durable+n8n',
        queuePosition: 1,
        stale: false,
      },
      {
        taskId: 'stale-run',
        queueOrigin: 'n8n',
        queuePosition: 2,
        stale: true,
      },
    ])
    expect(result.counts).toEqual({ waiting: 1, running: 0, attention: 1 })
    expect(JSON.stringify(result)).not.toContain('不应显示')
    expect(mocks.listScopedN8nTaskRunStatusSummaries).toHaveBeenCalledWith(
      {}, { workspaceId: 2, tenantId: 3 }, ['queued-video'],
    )
  })

  it('suppresses durable items when the platform has already reached a terminal state', async () => {
    const durable = (taskId: string, status: string, index: number) => ({
      taskId,
      name: `${taskId}.mp4`,
      status,
      batchId: 'batch-terminal',
      batchIndex: index,
      batchStatus: 'running',
      bindingId: 2,
      createdAt: 100 + index,
      updatedAt: 120 + index,
      submittedAt: 110 + index,
      error: '本地旧错误',
      sourceAvailable: true,
      queuePosition: index,
    })
    const platform = (taskId: string, status: string) => ({
      taskId,
      title: `${taskId}.mp4`,
      taskType: 'video-analysis',
      workflowName: '视频分析链',
      status,
      source: 'openclaw',
      attemptCount: 2,
      maxAttempts: 2,
      createdAt: 100,
      acceptedAt: 101,
      startedAt: 102,
      processingStartedAt: 103,
      completedAt: 200,
      updatedAt: 200,
      error: status === 'failed' ? 'vision: fetch failed' : null,
      resultAvailable: status === 'succeeded',
      batchId: 'batch-terminal',
      batchIndex: 1,
    })
    mocks.listN8nVideoQueueItems.mockResolvedValue([
      durable('local-accepted-platform-failed', 'accepted', 1),
      durable('local-running-platform-succeeded', 'running', 2),
      durable('local-only-queued', 'queued', 3),
    ])
    mocks.listScopedN8nTaskRunStatusSummaries.mockReturnValue([
      platform('local-accepted-platform-failed', 'failed'),
      platform('local-running-platform-succeeded', 'succeeded'),
    ])
    mocks.listN8nActiveTaskRunSummaries.mockReturnValue([])

    const result = await listN8nTaskQueue(
      {} as never,
      { workspaceId: 2, tenantId: 3 },
      1_000,
    )

    expect(result.queue).toMatchObject([{
      taskId: 'local-only-queued',
      status: 'queued',
      queueOrigin: 'durable',
    }])
    expect(result.total).toBe(1)
    expect(result.counts).toEqual({ waiting: 1, running: 0, attention: 0 })
  })
})
