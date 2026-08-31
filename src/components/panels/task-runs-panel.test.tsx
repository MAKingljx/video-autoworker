import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskRunsPanel } from './task-runs-panel'
import { useMissionControl } from '@/store'

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
  act(() => useMissionControl.setState({ currentUser: null }))
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
      if (url.includes('/api/n8n/intake-control')) {
        return jsonResponse({
          control: {
            schema: 'video-autoworker-intake-control/v1',
            globalScope: true,
            mode: 'active',
            accepting: true,
            revision: 0,
            reason: null,
            changedBy: null,
            changedAt: null,
            counts: { queued: 0, accepted: 0, running: 0, waiting: 0, active: 0 },
          },
        })
      }
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

  it('lets an administrator pause new intake with an audited reason', async () => {
    useMissionControl.setState({
      currentUser: {
        id: 9,
        username: 'admin',
        display_name: '管理员',
        role: 'admin',
        workspace_id: 1,
        tenant_id: 1,
      },
    })
    let control: {
      schema: 'video-autoworker-intake-control/v1'
      globalScope: true
      mode: 'active' | 'draining' | 'paused'
      accepting: boolean
      revision: number
      reason: string | null
      changedBy: { id: number; name: string } | null
      changedAt: number | null
      counts: { queued: number; accepted: number; running: number; waiting: number; active: number }
      canManage: true
    } = {
      schema: 'video-autoworker-intake-control/v1',
      globalScope: true,
      mode: 'active',
      accepting: true,
      revision: 4,
      reason: null,
      changedBy: null,
      changedAt: null,
      counts: { queued: 0, accepted: 0, running: 0, waiting: 0, active: 0 },
      canManage: true,
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/n8n/intake-control')) {
        if (init?.method === 'POST') {
          control = {
            ...control,
            mode: 'paused',
            accepting: false,
            revision: 5,
            reason: '准备发布兼容版本并进行蓝绿切换',
            changedBy: { id: 9, name: 'admin' },
            changedAt: 1_700_000_100,
          }
        }
        return jsonResponse({ control })
      }
      if (url.includes('view=queue')) {
        return jsonResponse({
          queue: [],
          total: 0,
          counts: { waiting: 0, running: 0, attention: 0 },
          generatedAt: 1_700_000_040,
        })
      }
      return jsonResponse({ runs: [], total: 0, limit: 50, offset: 0 })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<TaskRunsPanel />)

    fireEvent.click(await screen.findByRole('button', { name: '暂停全局接收' }))
    const dialog = screen.getByRole('dialog', { name: '暂停全局新任务接收' })
    fireEvent.change(within(dialog).getByLabelText('操作原因'), {
      target: { value: '准备发布兼容版本并进行蓝绿切换' },
    })
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: '确认暂停并排空' }))
      // The dialog intentionally starts an async mutation without returning
      // its promise from the click handler. Flush the mutation plus the two
      // list refreshes triggered by onChanged before leaving act().
      await vi.waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(6))
      for (let index = 0; index < 8; index += 1) await Promise.resolve()
    })

    await screen.findByText('已停止接收，平台任务已排空')
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(post).toBeTruthy()
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      action: 'drain',
      reason: '准备发布兼容版本并进行蓝绿切换',
      expectedRevision: 4,
    })
  })

  it('does not expose global intake controls to a non-owner tenant administrator', async () => {
    useMissionControl.setState({
      currentUser: {
        id: 19,
        username: 'tenant-admin',
        display_name: '租户管理员',
        role: 'admin',
        workspace_id: 8,
        tenant_id: 7,
      },
    })
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/api/n8n/intake-control')) {
        return jsonResponse({ control: { accepting: false, canManage: false } })
      }
      if (url.includes('view=queue')) {
        return jsonResponse({
          queue: [],
          total: 0,
          counts: { waiting: 0, running: 0, attention: 0 },
          generatedAt: 1_700_000_040,
        })
      }
      return jsonResponse({ runs: [], total: 0, limit: 50, offset: 0 })
    })
    vi.stubGlobal('fetch', fetchMock)

    render(<TaskRunsPanel />)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/n8n/intake-control', { cache: 'no-store' })
    })
    expect(screen.queryByRole('button', { name: '恢复全局接收' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '暂停全局接收' })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('任务接收控制')).not.toBeInTheDocument()
  })
})
