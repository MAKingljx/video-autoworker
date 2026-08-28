'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useFocusTrap } from '@/lib/use-focus-trap'
import {
  formatTaskRunDuration,
  formatTaskRunProcessingDuration,
  formatTaskRunQueueDuration,
  taskRunDurationBasis,
  taskRunFailureInsight,
} from '@/lib/task-run-presentation'

interface TaskRunListItem {
  taskId: string
  title: string
  taskType: string
  workflowName: string
  status: string
  source: string
  attemptCount: number
  maxAttempts: number
  createdAt: number
  acceptedAt: number | null
  startedAt: number | null
  processingStartedAt: number | null
  completedAt: number | null
  updatedAt: number
  error: string | null
  resultAvailable: boolean
  batchId: string | null
  batchIndex: number | null
}

interface TaskQueueItem extends TaskRunListItem {
  queuePosition: number
  queueOrigin: 'durable' | 'durable+n8n' | 'n8n'
  batchStatus: string | null
  sourceAvailable: boolean | null
  stale: boolean
}

interface TaskQueueResponse {
  queue: TaskQueueItem[]
  total: number
  counts: { waiting: number; running: number; attention: number }
  generatedAt: number
  error?: string
}

interface TaskRunListResponse {
  runs: TaskRunListItem[]
  total: number
  limit: number
  offset: number
  error?: string
}

const PAGE_SIZE = 50
const TASK_SPLIT_MIN_REM = 56
type TaskMasterView = 'queue' | 'history'

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'accepted', label: '已接收' },
  { value: 'running', label: '执行中' },
  { value: 'succeeded', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
]

const STATUS_LABELS: Record<string, string> = {
  ...Object.fromEntries(STATUS_OPTIONS.filter(option => option.value).map(option => [option.value, option.label])),
  staging: '准备素材',
  submitted: '已提交',
  waiting: '等待恢复',
  recovering: '恢复中',
  paused: '已暂停',
}

function statusClass(status: string): string {
  if (status === 'succeeded') return 'border-success/25 bg-success/10 text-success'
  if (status === 'failed' || status === 'cancelled') {
    return 'border-destructive/25 bg-destructive/10 text-destructive'
  }
  if (status === 'running' || status === 'accepted') {
    return 'border-primary/25 bg-primary/10 text-primary'
  }
  return 'border-border bg-secondary text-muted-foreground'
}

function queueStatusClass(item: TaskQueueItem): string {
  if (item.stale || item.sourceAvailable === false || ['waiting', 'recovering', 'paused'].includes(item.status)) {
    return 'border-warning/30 bg-warning/10 text-warning'
  }
  return statusClass(item.status)
}

function queueStatusLabel(item: TaskQueueItem): string {
  if (item.stale) return '异常滞留'
  if (item.sourceAvailable === false) return '源视频不可用'
  return STATUS_LABELS[item.status] || item.status
}

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return '—'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp * 1_000))
}

function sourceLabel(source: string): string {
  if (source === 'openclaw') return 'OpenClaw'
  if (source === 'video-autoworker') return 'Video AutoWorker'
  return source
}

function taskTypeLabel(taskType: string): string {
  if (taskType === 'video-analysis') return '视频分析'
  if (taskType === 'video-learning') return '视频学习'
  if (taskType === 'general') return '通用任务'
  return taskType
}

export function TaskRunsPanel() {
  const [runs, setRuns] = useState<TaskRunListItem[]>([])
  const [queue, setQueue] = useState<TaskQueueItem[]>([])
  const [queueCounts, setQueueCounts] = useState({ waiting: 0, running: 0, attention: 0 })
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [masterView, setMasterView] = useState<TaskMasterView>('queue')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [isSplitView, setIsSplitView] = useState(true)
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1_000))
  const requestSequence = useRef(0)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return undefined

    const rootFontSize = Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16
    const splitMinWidth = TASK_SPLIT_MIN_REM * rootFontSize
    const updateSplitView = (width = panel.getBoundingClientRect().width) => {
      setIsSplitView(width >= splitMinWidth)
    }

    updateSplitView()
    if (typeof ResizeObserver === 'undefined') {
      const updateOnWindowResize = () => updateSplitView()
      window.addEventListener('resize', updateOnWindowResize)
      return () => window.removeEventListener('resize', updateOnWindowResize)
    }

    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (entry) updateSplitView(entry.contentRect.width)
    })
    observer.observe(panel)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => setNowSeconds(Math.floor(Date.now() / 1_000)), 1_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setOffset(0)
      setQuery(search.trim())
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search])

  const fetchRuns = useCallback(async (background = false) => {
    const sequence = ++requestSequence.current
    if (background) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        view: 'list',
        limit: String(PAGE_SIZE),
        offset: String(offset),
      })
      if (status) params.set('status', status)
      if (query) params.set('query', query)
      const [response, queueResponse] = await Promise.all([
        fetch(`/api/n8n/runs?${params.toString()}`, { cache: 'no-store' }),
        fetch('/api/n8n/runs?view=queue', { cache: 'no-store' }),
      ])
      const data = await response.json() as TaskRunListResponse
      const queueData = await queueResponse.json() as TaskQueueResponse
      if (!response.ok) throw new Error(data.error || '读取任务链记录失败')
      if (!queueResponse.ok) throw new Error(queueData.error || '读取待执行队列失败')
      if (sequence !== requestSequence.current) return
      setRuns(Array.isArray(data.runs) ? data.runs : [])
      setTotal(Number(data.total) || 0)
      setQueue(Array.isArray(queueData.queue) ? queueData.queue : [])
      setQueueCounts(queueData.counts || { waiting: 0, running: 0, attention: 0 })
    } catch (fetchError) {
      if (sequence !== requestSequence.current) return
      setError(fetchError instanceof Error ? fetchError.message : '读取任务链记录失败')
    } finally {
      if (sequence === requestSequence.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [offset, query, status])

  useEffect(() => {
    void fetchRuns()
    const interval = window.setInterval(() => void fetchRuns(true), 30_000)
    return () => window.clearInterval(interval)
  }, [fetchRuns])

  const page = Math.floor(offset / PAGE_SIZE) + 1
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const visibleSummary = useMemo(() => {
    const completed = runs.filter(run => run.status === 'succeeded').length
    const active = runs.filter(run => ['queued', 'accepted', 'running'].includes(run.status)).length
    const failed = runs.filter(run => run.status === 'failed').length
    return { completed, active, failed }
  }, [runs])
  const selectedQueueItem = useMemo(
    () => masterView === 'queue'
      ? queue.find(item => item.taskId === selectedTaskId) || null
      : null,
    [masterView, queue, selectedTaskId],
  )
  const selectedRun = useMemo(
    () => selectedQueueItem
      || (masterView === 'history' ? runs.find(item => item.taskId === selectedTaskId) : null)
      || null,
    [masterView, runs, selectedQueueItem, selectedTaskId],
  )
  const selectedFailure = useMemo(
    () => taskRunFailureInsight(selectedRun?.error || null),
    [selectedRun],
  )

  useEffect(() => {
    if (!selectedTaskId || !isSplitView) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSelectedTaskId(null)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [isSplitView, selectedTaskId])

  return (
    <div ref={panelRef} className="@container relative flex h-full min-h-[42rem] flex-col overflow-hidden bg-background xl:min-h-0">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-md border border-border bg-card px-2 py-1">运行记录 {total} 条</span>
          <span>本页执行中 {visibleSummary.active}</span>
          <span>已完成 {visibleSummary.completed}</span>
          {visibleSummary.failed > 0 && (
            <button
              type="button"
              className="text-destructive hover:underline"
              onClick={() => {
                setStatus('failed')
                setOffset(0)
                setMasterView('history')
              }}
            >
              失败 {visibleSummary.failed}，查看原因
            </button>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void fetchRuns(true)}
          disabled={refreshing}
          aria-label="刷新任务链列表"
        >
          <svg className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M1.5 8a6.5 6.5 0 0 1 11.25-4.5M14.5 8a6.5 6.5 0 0 1-11.25 4.5" />
            <path d="M13.5 2v3h-3M2.5 14v-3h3" />
          </svg>
          刷新
        </Button>
      </div>

      {error && (
        <div role="alert" className="mx-4 mt-4 flex items-center justify-between rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="rounded px-2 py-1 hover:bg-destructive/10" aria-label="关闭错误提示">×</button>
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-1 @4xl:grid-cols-[360px_minmax(0,1fr)]">
        <section className="flex min-h-0 min-w-0 flex-col border-border bg-card @4xl:border-r" aria-label="任务链列表">
          <div className="border-b border-border p-3">
            <div className="grid grid-cols-2 gap-1 rounded-md border border-border bg-secondary p-1" role="tablist" aria-label="任务链列表视图">
              <MasterViewButton
                active={masterView === 'queue'}
                count={queue.length}
                onClick={() => {
                  setMasterView('queue')
                  setSelectedTaskId(null)
                }}
              >
                待执行
              </MasterViewButton>
              <MasterViewButton
                active={masterView === 'history'}
                count={total}
                onClick={() => {
                  setMasterView('history')
                  setSelectedTaskId(null)
                }}
              >
                运行记录
              </MasterViewButton>
            </div>

            {masterView === 'history' && (
              <div className="mt-3 grid gap-2">
                <label className="relative min-w-0">
                  <span className="sr-only">搜索任务链记录</span>
                  <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                    <circle cx="7" cy="7" r="4.5" />
                    <path d="m10.5 10.5 3 3" />
                  </svg>
                  <input
                    value={search}
                    onChange={event => setSearch(event.target.value)}
                    maxLength={120}
                    placeholder="搜索视频、编号或任务链"
                    className="h-9 w-full rounded-md border border-border bg-background pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
                  />
                </label>
                <label>
                  <span className="sr-only">按状态筛选</span>
                  <select
                    value={status}
                    onChange={event => {
                      setStatus(event.target.value)
                      setOffset(0)
                    }}
                    className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
                  >
                    {STATUS_OPTIONS.map(option => (
                      <option key={option.value || 'all'} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}

            {masterView === 'queue' && (
              <div className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>等待 {queueCounts.waiting}</span>
                <span>执行中 {queueCounts.running}</span>
                {queueCounts.attention > 0 && <span className="text-warning">需处理 {queueCounts.attention}</span>}
              </div>
            )}
          </div>

          <div className="min-h-0 max-h-[65dvh] flex-1 overflow-y-auto p-2.5 @4xl:max-h-none" data-task-master-scroll>
            {loading ? (
              <div className="space-y-2 p-1">
                {Array.from({ length: 6 }).map((_, index) => (
                  <div key={index} className="h-20 animate-pulse rounded-md bg-secondary" />
                ))}
              </div>
            ) : masterView === 'queue' ? (
              queue.length === 0 ? (
                <TaskRunEmpty title="当前没有待执行任务" detail="新加入的任务会显示在这里。" />
              ) : (
                <div className="space-y-2">
                  {queue.map(item => (
                    <TaskRunRailItem
                      key={item.taskId}
                      run={item}
                      queueItem={item}
                      active={item.taskId === selectedTaskId}
                      nowSeconds={nowSeconds}
                      onSelect={() => setSelectedTaskId(item.taskId)}
                    />
                  ))}
                </div>
              )
            ) : runs.length === 0 ? (
              <TaskRunEmpty title="没有匹配的运行记录" detail="可以调整搜索词或状态。" />
            ) : (
              <div className="space-y-2">
                {runs.map(run => (
                  <TaskRunRailItem
                    key={run.taskId}
                    run={run}
                    active={run.taskId === selectedTaskId}
                    nowSeconds={nowSeconds}
                    onSelect={() => setSelectedTaskId(run.taskId)}
                  />
                ))}
              </div>
            )}
          </div>

          {masterView === 'history' && (
            <div className="flex items-center justify-between border-t border-border px-3 py-2.5 text-xs text-muted-foreground">
              <span>第 {page} / {pages} 页</span>
              <div className="flex gap-2">
                <Button variant="outline" size="xs" disabled={offset === 0 || loading} onClick={() => setOffset(current => Math.max(0, current - PAGE_SIZE))}>上一页</Button>
                <Button variant="outline" size="xs" disabled={offset + PAGE_SIZE >= total || loading} onClick={() => setOffset(current => current + PAGE_SIZE)}>下一页</Button>
              </div>
            </div>
          )}
        </section>

        {selectedRun ? isSplitView ? (
          <div className="h-full min-h-0 overflow-hidden">
            <TaskRunDetailPane
              run={selectedRun}
              queueItem={selectedQueueItem}
              failure={selectedFailure}
              nowSeconds={nowSeconds}
              onClose={() => setSelectedTaskId(null)}
            />
          </div>
        ) : (
          <TaskRunMobileDialog
            run={selectedRun}
            queueItem={selectedQueueItem}
            failure={selectedFailure}
            nowSeconds={nowSeconds}
            onClose={() => setSelectedTaskId(null)}
          />
        ) : (
          <div className="hidden min-h-0 min-w-0 items-center justify-center bg-background p-8 text-center @4xl:flex" data-task-detail-empty>
            <div>
              <h3 className="text-sm font-semibold text-foreground">选择一条任务</h3>
              <p className="mt-1 text-xs text-muted-foreground">左侧列表用于导航，任务详情会固定显示在这里。</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function TaskRunMobileDialog({
  run,
  queueItem,
  failure,
  nowSeconds,
  onClose,
}: {
  run: TaskRunListItem
  queueItem: TaskQueueItem | null
  failure: ReturnType<typeof taskRunFailureInsight>
  nowSeconds: number
  onClose: () => void
}) {
  const dialogRef = useFocusTrap(onClose)

  useEffect(() => {
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [])

  return (
    <div
      className="fixed inset-0 z-[120] flex justify-end bg-background/65 backdrop-blur-[1px]"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-run-detail-title"
        className="h-full w-full max-w-md"
      >
        <TaskRunDetailPane
          run={run}
          queueItem={queueItem}
          failure={failure}
          nowSeconds={nowSeconds}
          onClose={onClose}
          titleId="task-run-detail-title"
        />
      </div>
    </div>
  )
}

function MasterViewButton({
  active,
  count,
  onClick,
  children,
}: {
  active: boolean
  count: number
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`flex items-center justify-center gap-2 rounded px-2.5 py-1.5 text-sm font-medium transition-colors ${
        active ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      <span>{children}</span>
      <span className="text-[10px]">{count}</span>
    </button>
  )
}

function TaskRunRailItem({
  run,
  queueItem,
  active,
  nowSeconds,
  onSelect,
}: {
  run: TaskRunListItem
  queueItem?: TaskQueueItem
  active: boolean
  nowSeconds: number
  onSelect: () => void
}) {
  const failure = taskRunFailureInsight(run.error)
  const statusTone = queueItem ? queueStatusClass(queueItem) : statusClass(run.status)
  const statusText = queueItem ? queueStatusLabel(queueItem) : STATUS_LABELS[run.status] || run.status

  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={`w-full rounded-md border p-3 text-left transition-colors ${
        active
          ? 'border-primary/40 bg-primary/10'
          : 'border-border bg-background/30 hover:border-primary/20 hover:bg-background/70'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground" title={run.title}>{run.title}</div>
          <div className="mt-1 truncate text-[11px] text-muted-foreground">
            {queueItem ? `队列 #${queueItem.queuePosition}` : run.workflowName}
          </div>
        </div>
        <span className={`inline-flex flex-none rounded-full border px-2 py-0.5 text-[10px] font-medium ${statusTone}`}>
          {statusText}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        {queueItem ? (
          <>
            <span>等待 {formatTaskRunQueueDuration(queueItem, nowSeconds)}</span>
            {queueItem.processingStartedAt && <span>处理 {formatTaskRunProcessingDuration(queueItem, nowSeconds)}</span>}
            {queueItem.batchIndex && <span>批次第 {queueItem.batchIndex} 项</span>}
          </>
        ) : (
          <>
            <span>{taskTypeLabel(run.taskType)}</span>
            <span>{formatTaskRunDuration(run, nowSeconds)}</span>
            <span>{formatTimestamp(run.updatedAt)}</span>
          </>
        )}
      </div>
      {failure && (
        <div className="mt-2 truncate text-[11px] text-destructive" title={`${failure.stage}：${failure.detail}`}>
          {failure.stage} · {failure.title}
        </div>
      )}
    </button>
  )
}

function TaskRunEmpty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="px-4 py-10 text-center">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
    </div>
  )
}

function TaskRunDetailPane({
  run,
  queueItem,
  failure,
  nowSeconds,
  onClose,
  titleId,
}: {
  run: TaskRunListItem
  queueItem: TaskQueueItem | null
  failure: ReturnType<typeof taskRunFailureInsight>
  nowSeconds: number
  onClose: () => void
  titleId?: string
}) {
  const detailStatusClass = queueItem ? queueStatusClass(queueItem) : statusClass(run.status)
  const detailStatusLabel = queueItem ? queueStatusLabel(queueItem) : STATUS_LABELS[run.status] || run.status

  return (
    <aside className="ml-auto flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-xl @4xl:max-w-none @4xl:shadow-none" aria-label="任务链详情" data-task-run-detail>
      <div className="flex items-start justify-between border-b border-border px-5 py-4">
        <div className="min-w-0 pr-3">
          <h3 id={titleId} className="truncate text-base font-semibold text-foreground">{run.title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">只读运行摘要</p>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="关闭任务详情">×</Button>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 text-sm">
        <DetailRow label="当前状态">
          <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${detailStatusClass}`}>
            {detailStatusLabel}
          </span>
        </DetailRow>
        {queueItem && (
          <>
            <DetailRow label="队列位置"><span>第 {queueItem.queuePosition} 位</span></DetailRow>
            <DetailRow label="队列来源"><span>{queueItem.queueOrigin}</span></DetailRow>
          </>
        )}
        <DetailRow label="任务编号"><code className="break-all text-xs text-foreground">{run.taskId}</code></DetailRow>
        <DetailRow label="任务链"><span>{run.workflowName}</span></DetailRow>
        <DetailRow label="任务类型"><span>{taskTypeLabel(run.taskType)}</span></DetailRow>
        <DetailRow label="提交来源"><span>{sourceLabel(run.source)}</span></DetailRow>
        {run.batchId && <DetailRow label="批次编号"><code className="break-all text-xs">{run.batchId}</code></DetailRow>}
        {run.batchIndex && <DetailRow label="批次序号"><span>第 {run.batchIndex} 项</span></DetailRow>}
        <DetailRow label="执行尝试"><span>{run.attemptCount} / {run.maxAttempts}</span></DetailRow>
        <div className="grid grid-cols-2 gap-3">
          <TimeCard label="创建" value={formatTimestamp(run.createdAt)} />
          <TimeCard label="接收" value={formatTimestamp(run.acceptedAt)} />
          <TimeCard label="处理开始" value={formatTimestamp(run.processingStartedAt)} />
          <TimeCard label="完成" value={formatTimestamp(run.completedAt)} />
        </div>
        <DetailRow label="总耗时">
          <span>{formatTaskRunDuration(run, nowSeconds)}</span>
          <p className="mt-1 text-xs text-muted-foreground">{taskRunDurationBasis(run)}</p>
        </DetailRow>
        <div className="grid grid-cols-2 gap-3">
          <TimeCard label="排队等待" value={formatTaskRunQueueDuration(run, nowSeconds)} />
          <TimeCard label="实际处理" value={formatTaskRunProcessingDuration(run, nowSeconds)} />
        </div>
        <DetailRow label="结果状态"><span>{run.resultAvailable ? '分析结果已保存' : '暂无可用结果'}</span></DetailRow>
        {failure && (
          <div className="rounded-md border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
            <div className="text-xs font-medium">{failure.stage}</div>
            <p className="mt-1 font-medium">{failure.title}</p>
            <p className="mt-1 break-words text-xs leading-5">{failure.detail}</p>
            <p className="mt-2 border-t border-destructive/15 pt-2 text-xs leading-5 text-foreground/75">
              {failure.suggestion}
            </p>
          </div>
        )}
      </div>
    </aside>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs text-muted-foreground">{label}</div>
      <div className="text-foreground">{children}</div>
    </div>
  )
}

function TimeCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-secondary/50 p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-xs text-foreground">{value}</div>
    </div>
  )
}
