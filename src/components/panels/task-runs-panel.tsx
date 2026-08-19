'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

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
  completedAt: number | null
  updatedAt: number
  error: string | null
  resultAvailable: boolean
  batchId: string | null
  batchIndex: number | null
}

interface TaskRunListResponse {
  runs: TaskRunListItem[]
  total: number
  limit: number
  offset: number
  error?: string
}

const PAGE_SIZE = 50

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'accepted', label: '已接收' },
  { value: 'running', label: '执行中' },
  { value: 'succeeded', label: '已完成' },
  { value: 'failed', label: '失败' },
  { value: 'cancelled', label: '已取消' },
]

const STATUS_LABELS: Record<string, string> = Object.fromEntries(
  STATUS_OPTIONS.filter(option => option.value).map(option => [option.value, option.label]),
)

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

function formatDuration(run: TaskRunListItem): string {
  if (!run.startedAt) return '—'
  const end = run.completedAt || (run.status === 'running' ? Math.floor(Date.now() / 1_000) : run.updatedAt)
  const seconds = Math.max(0, end - run.startedAt)
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
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
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectedRun, setSelectedRun] = useState<TaskRunListItem | null>(null)
  const requestSequence = useRef(0)

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
      const response = await fetch(`/api/n8n/runs?${params.toString()}`, { cache: 'no-store' })
      const data = await response.json() as TaskRunListResponse
      if (!response.ok) throw new Error(data.error || '读取任务链记录失败')
      if (sequence !== requestSequence.current) return
      setRuns(Array.isArray(data.runs) ? data.runs : [])
      setTotal(Number(data.total) || 0)
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
    const failed = runs.filter(run => ['failed', 'cancelled'].includes(run.status)).length
    return { completed, active, failed }
  }, [runs])

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-md border border-border bg-card px-2 py-1">共 {total} 条</span>
          <span>本页执行中 {visibleSummary.active}</span>
          <span>已完成 {visibleSummary.completed}</span>
          {visibleSummary.failed > 0 && <span className="text-destructive">异常 {visibleSummary.failed}</span>}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="relative min-w-0 sm:w-64">
            <span className="sr-only">搜索任务链记录</span>
            <svg className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="m10.5 10.5 3 3" />
            </svg>
            <input
              value={search}
              onChange={event => setSearch(event.target.value)}
              maxLength={120}
              placeholder="按视频名、任务编号或任务链搜索"
              className="h-9 w-full rounded-md border border-border bg-card pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
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
              className="h-9 rounded-md border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
            >
              {STATUS_OPTIONS.map(option => (
                <option key={option.value || 'all'} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
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
      </div>

      {error && (
        <div role="alert" className="mx-4 mt-4 flex items-center justify-between rounded-md border border-destructive/25 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} className="rounded px-2 py-1 hover:bg-destructive/10" aria-label="关闭错误提示">×</button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="min-w-[880px] overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="sticky top-0 z-10 bg-surface-1 text-xs font-medium text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-4 py-3 font-medium">任务</th>
                <th className="px-3 py-3 font-medium">状态</th>
                <th className="px-3 py-3 font-medium">任务链</th>
                <th className="px-3 py-3 font-medium">尝试</th>
                <th className="px-3 py-3 font-medium">耗时</th>
                <th className="px-3 py-3 font-medium">最后更新</th>
                <th className="w-14 px-3 py-3"><span className="sr-only">查看</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                Array.from({ length: 6 }).map((_, index) => (
                  <tr key={index} className="border-b border-border/60 last:border-b-0">
                    <td colSpan={7} className="px-4 py-4">
                      <div className="h-4 w-full animate-pulse rounded bg-secondary" />
                    </td>
                  </tr>
                ))
              ) : runs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-16 text-center">
                    <div className="font-medium text-foreground">没有匹配的任务链记录</div>
                    <div className="mt-1 text-xs text-muted-foreground">可以调整搜索词或状态筛选条件</div>
                  </td>
                </tr>
              ) : runs.map(run => (
                <tr key={run.taskId} className="border-b border-border/60 transition-colors last:border-b-0 hover:bg-secondary/50">
                  <td className="max-w-md px-4 py-3">
                    <div className="truncate font-medium text-foreground" title={run.title}>{run.title}</div>
                    <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground" title={run.taskId}>{run.taskId}</div>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${statusClass(run.status)}`}>
                      {STATUS_LABELS[run.status] || run.status}
                    </span>
                  </td>
                  <td className="max-w-56 px-3 py-3">
                    <div className="truncate text-foreground" title={run.workflowName}>{run.workflowName}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{taskTypeLabel(run.taskType)} · {sourceLabel(run.source)}</div>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-muted-foreground">{run.attemptCount}/{run.maxAttempts}</td>
                  <td className="px-3 py-3 text-xs text-muted-foreground">{formatDuration(run)}</td>
                  <td className="whitespace-nowrap px-3 py-3 text-xs text-muted-foreground">{formatTimestamp(run.updatedAt)}</td>
                  <td className="px-3 py-3 text-right">
                    <Button variant="ghost" size="icon-xs" onClick={() => setSelectedRun(run)} aria-label={`查看 ${run.title} 的任务详情`}>
                      <svg className="h-4 w-4" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M6 3.5 10.5 8 6 12.5" />
                      </svg>
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border px-4 py-3 text-xs text-muted-foreground">
        <span>第 {page} / {pages} 页</span>
        <div className="flex gap-2">
          <Button variant="outline" size="xs" disabled={offset === 0 || loading} onClick={() => setOffset(current => Math.max(0, current - PAGE_SIZE))}>上一页</Button>
          <Button variant="outline" size="xs" disabled={offset + PAGE_SIZE >= total || loading} onClick={() => setOffset(current => current + PAGE_SIZE)}>下一页</Button>
        </div>
      </div>

      {selectedRun && (
        <div className="absolute inset-0 z-30 flex justify-end bg-background/65 backdrop-blur-[1px]" role="presentation" onMouseDown={event => {
          if (event.target === event.currentTarget) setSelectedRun(null)
        }}>
          <aside className="flex h-full w-full max-w-md flex-col border-l border-border bg-card shadow-xl" role="dialog" aria-modal="true" aria-label="任务链详情">
            <div className="flex items-start justify-between border-b border-border px-5 py-4">
              <div className="min-w-0 pr-3">
                <h3 className="truncate text-base font-semibold text-foreground">{selectedRun.title}</h3>
                <p className="mt-1 text-xs text-muted-foreground">只读运行摘要</p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => setSelectedRun(null)} aria-label="关闭任务详情">×</Button>
            </div>
            <div className="flex-1 space-y-5 overflow-y-auto p-5 text-sm">
              <DetailRow label="当前状态">
                <span className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${statusClass(selectedRun.status)}`}>
                  {STATUS_LABELS[selectedRun.status] || selectedRun.status}
                </span>
              </DetailRow>
              <DetailRow label="任务编号"><code className="break-all text-xs text-foreground">{selectedRun.taskId}</code></DetailRow>
              <DetailRow label="任务链"><span>{selectedRun.workflowName}</span></DetailRow>
              <DetailRow label="任务类型"><span>{taskTypeLabel(selectedRun.taskType)}</span></DetailRow>
              <DetailRow label="提交来源"><span>{sourceLabel(selectedRun.source)}</span></DetailRow>
              {selectedRun.batchId && <DetailRow label="批次编号"><code className="break-all text-xs">{selectedRun.batchId}</code></DetailRow>}
              {selectedRun.batchIndex && <DetailRow label="批次序号"><span>第 {selectedRun.batchIndex} 项</span></DetailRow>}
              <DetailRow label="执行尝试"><span>{selectedRun.attemptCount} / {selectedRun.maxAttempts}</span></DetailRow>
              <div className="grid grid-cols-2 gap-3">
                <TimeCard label="创建" value={formatTimestamp(selectedRun.createdAt)} />
                <TimeCard label="接收" value={formatTimestamp(selectedRun.acceptedAt)} />
                <TimeCard label="开始" value={formatTimestamp(selectedRun.startedAt)} />
                <TimeCard label="完成" value={formatTimestamp(selectedRun.completedAt)} />
              </div>
              <DetailRow label="执行耗时"><span>{formatDuration(selectedRun)}</span></DetailRow>
              <DetailRow label="结果状态"><span>{selectedRun.resultAvailable ? '分析结果已保存' : '暂无可用结果'}</span></DetailRow>
              {selectedRun.error && (
                <div className="rounded-md border border-destructive/25 bg-destructive/10 p-3 text-sm text-destructive">
                  <div className="mb-1 text-xs font-medium">错误摘要</div>
                  <p className="break-words">{selectedRun.error}</p>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}
    </div>
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
