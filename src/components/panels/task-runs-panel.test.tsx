import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskRunsPanel } from './task-runs-panel'

const baseRun = {
  taskType: 'video-analysis',
  workflowName: '媒体分析任务链',
  source: 'video-autoworker',
  attemptCount: 1,
  maxAttempts: 3,
  createdAt: 1_700_000_000,
  acceptedAt: 1_700_000_010,
  startedAt: 1_700_000_020,
  processingStartedAt: 1_700_000_030,
  completedAt: null,
  updatedAt: 1_700_000_040,
  error: null,
  resultAvailable: false,
  batchId: null,
  batchIndex: null,
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response
}

afterEach(() => {
  document.body.style.overflow = ''
  vi.unstubAllGlobals()
})

describe('TaskRunsPanel', () => {
  it('keeps queue and history selections scoped to the active list', async () => {
    const queueItem = {
      ...baseRun,
      taskId: 'queue-1',
      title: '队列任务',
      status: 'running',
      queuePosition: 1,
      queueOrigin: 'durable+n8n',
      batchStatus: null,
      sourceAvailable: true,
      stale: true,
    }
    const historyItem = {
      ...baseRun,
      taskId: 'history-1',
      title: '历史任务',
      status: 'succeeded',
      completedAt: 1_700_000_120,
      resultAvailable: true,
    }

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('view=queue')) {
        return jsonResponse({
          queue: [queueItem],
          total: 1,
          counts: { waiting: 0, running: 1, attention: 1 },
          generatedAt: 1_700_000_040,
        })
      }
      return jsonResponse({ runs: [historyItem], total: 1, limit: 50, offset: 0 })
    }))

    render(<TaskRunsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: /队列任务/ }))
    expect(screen.getByRole('dialog', { name: '队列任务' })).toHaveAttribute('aria-modal', 'true')
    expect(document.body.style.overflow).toBe('hidden')
    const queueDetail = screen.getByRole('complementary', { name: '任务链详情' })
    expect(within(queueDetail).getByText('异常滞留')).toBeInTheDocument()
    expect(within(queueDetail).getByText('第 1 位')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '运行记录 1' }))
    expect(screen.queryByRole('complementary', { name: '任务链详情' })).not.toBeInTheDocument()
    expect(document.body.style.overflow).toBe('')

    fireEvent.click(screen.getByRole('button', { name: /历史任务/ }))
    const historyDetail = screen.getByRole('complementary', { name: '任务链详情' })
    expect(within(historyDetail).getByText('分析结果已保存')).toBeInTheDocument()

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })
})
