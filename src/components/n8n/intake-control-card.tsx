'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useFocusTrap } from '@/lib/use-focus-trap'
import { useMissionControl } from '@/store'

type IntakeMode = 'active' | 'draining' | 'paused'
type IntakeAction = 'drain' | 'resume'

interface IntakeControl {
  schema: 'video-autoworker-intake-control/v1'
  globalScope: true
  mode: IntakeMode
  accepting: boolean
  revision: number
  reason: string | null
  changedBy: { id: number; name: string } | null
  changedAt: number | null
  counts: {
    queued: number
    accepted: number
    running: number
    waiting: number
    active: number
  }
  canManage?: true
}

interface IntakeSafeControl {
  accepting: boolean
  canManage: false
}

interface IntakeResponse {
  control?: IntakeControl | IntakeSafeControl
  code?: string
  error?: string
}

function isDetailedIntakeControl(control: IntakeControl | IntakeSafeControl): control is IntakeControl {
  return 'schema' in control && 'revision' in control && 'counts' in control
}

interface IntakeControlCardProps {
  queueCounts: { waiting: number; running: number; attention: number }
  onChanged?: () => void
}

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return '尚未操作'
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp * 1_000))
}

function stateCopy(control: IntakeControl | null) {
  if (!control) return {
    title: '正在读取接收状态',
    detail: '任务查询与已有执行不受影响。',
  }
  if (control.mode === 'active') return {
    title: '正在接收新任务',
    detail: '所有工作区的 OpenClaw 与控制台可以继续提交任务。',
  }
  if (control.mode === 'draining') return {
    title: '已停止接收，正在排空',
    detail: '不会中断正在运行的 n8n execution；已有任务会继续完成。',
  }
  return {
    title: '已停止接收，平台任务已排空',
    detail: '可准备 3017 蓝绿切换；正式发版仍需通过运行时兼容与健康检查。',
  }
}

export function IntakeControlCard({ queueCounts, onChanged }: IntakeControlCardProps) {
  const currentUser = useMissionControl(state => state.currentUser)
  const mayRequestManagement = currentUser?.role === 'admin' || currentUser?.id === 0
  const [canManage, setCanManage] = useState(false)
  const [control, setControl] = useState<IntakeControl | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dialogAction, setDialogAction] = useState<IntakeAction | null>(null)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/n8n/intake-control', { cache: 'no-store' })
      const body = await response.json() as IntakeResponse
      if (!response.ok || !body.control) throw new Error(body.error || '读取任务接收状态失败')
      if (body.control.canManage !== true || !isDetailedIntakeControl(body.control)) {
        setCanManage(false)
        setControl(null)
        setError(null)
        return
      }
      setCanManage(true)
      setControl(body.control)
      setError(null)
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '读取任务接收状态失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!mayRequestManagement) {
      setCanManage(false)
      setControl(null)
      setLoading(false)
      return
    }
    void refresh()
    const interval = window.setInterval(() => void refresh(), 30_000)
    return () => window.clearInterval(interval)
  }, [mayRequestManagement, refresh])

  const copy = stateCopy(control)
  const tone = control?.mode === 'draining'
    ? 'border-warning/30 bg-warning/5'
    : control?.accepting === false
      ? 'border-border bg-secondary/35'
      : 'border-primary/20 bg-primary/[0.03]'

  if (!canManage) return null

  return (
    <>
      <section className={`border-b px-4 py-3 ${tone}`} aria-label="任务接收控制" data-intake-mode={control?.mode || 'loading'}>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${control?.mode === 'draining' ? 'bg-warning' : control?.accepting === false ? 'bg-muted-foreground' : 'bg-primary'}`} aria-hidden="true" />
              <h2 className="text-sm font-semibold text-foreground">{copy.title}</h2>
              {loading && <span className="text-2xs text-muted-foreground">刷新中…</span>}
            </div>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{copy.detail}</p>
            {control?.reason && (
              <p className="mt-1 truncate text-2xs text-muted-foreground" title={control.reason}>
                最近原因：{control.reason} · {control.changedBy?.name || '管理员'} · {formatTimestamp(control.changedAt)}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="rounded-md border border-border bg-background/70 px-2 py-1">平台活跃 {control?.counts.active ?? '—'}</span>
            <span className="rounded-md border border-border bg-background/70 px-2 py-1">队列等待 {queueCounts.waiting}</span>
            <span className="rounded-md border border-border bg-background/70 px-2 py-1">队列运行 {queueCounts.running}</span>
            {queueCounts.attention > 0 && (
              <span className="rounded-md border border-warning/30 bg-warning/10 px-2 py-1 text-warning">需处理 {queueCounts.attention}</span>
            )}
            {canManage && control && (
              <Button
                size="sm"
                variant={control.accepting ? 'outline' : 'secondary'}
                onClick={() => setDialogAction(control.accepting ? 'drain' : 'resume')}
              >
                {control.accepting ? '暂停全局接收' : '恢复全局接收'}
              </Button>
            )}
          </div>
        </div>
        {error && <p className="mt-2 text-xs text-destructive" role="alert">{error}</p>}
      </section>

      {dialogAction && control && (
        <IntakeControlDialog
          action={dialogAction}
          control={control}
          onClose={() => setDialogAction(null)}
          onApplied={next => {
            setControl(next)
            setError(null)
            setDialogAction(null)
            onChanged?.()
          }}
          onConflict={next => {
            setControl(next)
            setDialogAction(null)
            setError('接收状态已由其他管理员更新，请核对后重试。')
          }}
        />
      )}
    </>
  )
}

function IntakeControlDialog({
  action,
  control,
  onClose,
  onApplied,
  onConflict,
}: {
  action: IntakeAction
  control: IntakeControl
  onClose: () => void
  onApplied: (control: IntakeControl) => void
  onConflict: (control: IntakeControl) => void
}) {
  const dialogRef = useFocusTrap(onClose)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const validReason = reason.trim().length >= 8 && reason.trim().length <= 300
  const isDrain = action === 'drain'

  const submit = async () => {
    if (!validReason || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const response = await fetch('/api/n8n/intake-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          reason: reason.trim(),
          expectedRevision: control.revision,
        }),
      })
      const body = await response.json() as IntakeResponse
      if (response.status === 409 && body.code === 'INTAKE_STATE_CONFLICT' && body.control && isDetailedIntakeControl(body.control)) {
        onConflict(body.control)
        return
      }
      if (!response.ok || !body.control || !isDetailedIntakeControl(body.control)) {
        throw new Error(body.error || '更新任务接收状态失败')
      }
      onApplied(body.control)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : '更新任务接收状态失败')
      setSubmitting(false)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[140] flex items-center justify-center bg-background/70 p-4 backdrop-blur-[1px]"
      role="presentation"
      onMouseDown={event => {
        if (event.target === event.currentTarget && !submitting) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="intake-control-dialog-title"
        className="w-full max-w-lg rounded-xl border border-border bg-card p-5 shadow-2xl"
      >
        <h2 id="intake-control-dialog-title" className="text-base font-semibold text-foreground">
          {isDrain ? '暂停全局新任务接收' : '恢复全局新任务接收'}
        </h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          {isDrain
            ? '此操作影响所有工作区。新的 OpenClaw 和控制台提交将被拒绝；已有任务、状态查询、媒体节点和最终回调继续运行。'
            : '此操作影响所有工作区。恢复后只接收新的提交，不会重提、重试或唤醒已经结束的任务。'}
        </p>
        <div className="mt-4">
          <label className="block text-xs font-medium text-foreground" htmlFor="intake-control-reason">操作原因</label>
          <textarea
            id="intake-control-reason"
            aria-describedby="intake-control-reason-hint"
            autoFocus
            value={reason}
            onChange={event => setReason(event.target.value)}
            maxLength={300}
            rows={4}
            placeholder={isDrain ? '例如：准备发布 3017 兼容版本并执行蓝绿切换' : '例如：新版本健康检查通过，恢复接收新任务'}
            className="mt-2 w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60 focus:ring-2 focus:ring-primary/15"
          />
          <span id="intake-control-reason-hint" className={`mt-1 block text-2xs ${reason.length > 0 && !validReason ? 'text-warning' : 'text-muted-foreground'}`}>
            去除首尾空格后 8–300 个字符，用于操作审计。
          </span>
        </div>
        {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
        <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" size="sm" disabled={submitting} onClick={onClose}>取消</Button>
          <Button size="sm" disabled={!validReason || submitting} onClick={() => void submit()}>
            {submitting ? '正在提交…' : isDrain ? '确认暂停并排空' : '确认恢复接收'}
          </Button>
        </div>
      </div>
    </div>
  )
}
