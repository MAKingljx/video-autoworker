'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import type { EditPlan } from '@/lib/editing/edit-plan'

interface EditingStatus {
  enabled: boolean
  schemaReady: boolean
  bindingId?: number | null
  canApprove?: boolean
  canCancel?: boolean
  errorCode?: string | null
  executor: { connected: boolean; studio: boolean; projectName?: string; resolveVersion?: string } | null
}
interface PlanStatus {
  planId: string
  revision: number
  planSha256: string
  planStatus: string
  objective?: string
  clipCount?: number
  taskId: string | null
  taskStatus: string | null
  operations: Array<{ operationId?: string; phase: string; stepId?: string; status: string; errorCode?: string | null }>
  plan?: EditPlan
  reviewToken?: string
}
interface RuntimeStatus { currentState: string; sourceCommit?: string; releaseId?: string }
const ACTIVE = new Set(['queued', 'accepted', 'running', 'waiting'])
const labels: Record<string, string> = { validated: '等待人工审核', approved: '已确认方案', queued: '排队中',
  accepted: '已受理', running: '剪辑中', waiting: '等待执行', succeeded: '已完成', failed: '失败',
  cancelled: '已取消', unknown: '结果未知，等待核对', cancel_requested: '正在取消' }
const phaseLabels: Record<string, string> = { inspect: '检查项目', snapshot: '保存恢复点', preflight: '检查素材与能力',
  import: '导入素材', assembly: '组织镜头', assemble: '组织镜头', timeline: '建立时间线',
  audio: '处理音量与音乐', subtitles: '生成字幕', render: '导出视频', verify: '核对成片', finalize: '完成验收' }

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...init })
  const data = await response.json().catch(() => { throw new Error('剪辑服务暂未返回完整状态，请刷新核对。') })
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : '剪辑服务暂不可用')
  return data as T
}
function planPath(item: Pick<PlanStatus, 'planId' | 'revision'>) {
  return `/api/editing/plans?${new URLSearchParams({ planId: item.planId, revision: String(item.revision) })}`
}
function timestamp(seconds: number) {
  const value = Math.max(0, seconds)
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${(value % 60).toFixed(1).padStart(4, '0')}`
}
function duration(plan: EditPlan) {
  const sourceFps = plan.sourceFrameRate.numerator / plan.sourceFrameRate.denominator
  const timelineFps = plan.timelineFrameRate.numerator / plan.timelineFrameRate.denominator
  return Math.max(0, ...plan.clips.map(clip => clip.timelineStartFrame / timelineFps
    + (clip.sourceRange.endExclusive - clip.sourceRange.start) / sourceFps))
}

export function EditingPanel() {
  const [status, setStatus] = useState<EditingStatus | null>(null)
  const [plans, setPlans] = useState<PlanStatus[]>([])
  const [selected, setSelected] = useState<Pick<PlanStatus, 'planId' | 'revision'> | null>(null)
  const [detail, setDetail] = useState<PlanStatus | null>(null)
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [visibleClips, setVisibleClips] = useState(30)
  const [confirmation, setConfirmation] = useState<{ action: 'approve' | 'cancel'; snapshot: PlanStatus } | null>(null)
  const taskKeys = useRef(new Map<string, string>())
  const detailSequence = useRef(0)
  const mounted = useRef(true)

  const refresh = useCallback(async () => {
    const results = await Promise.allSettled([
      request<EditingStatus>('/api/editing/status'),
      request<{ plans: PlanStatus[] }>('/api/editing/plans'),
      request<RuntimeStatus>('/api/runtime/current'),
    ])
    if (!mounted.current) return
    if (results[0].status === 'fulfilled') setStatus(results[0].value)
    else setError(results[0].reason instanceof Error ? results[0].reason.message : '剪辑状态暂不可用')
    if (results[1].status === 'fulfilled') {
      const list = results[1].value.plans || []
      setPlans(list)
      setSelected(current => current && list.some(item => item.planId === current.planId && item.revision === current.revision)
        ? current : list[0] ? { planId: list[0].planId, revision: list[0].revision } : null)
    }
    if (results[2].status === 'fulfilled') setRuntime(results[2].value)
    setLoading(false)
  }, [])

  const loadDetail = useCallback(async (item: Pick<PlanStatus, 'planId' | 'revision'>, signal?: AbortSignal) => {
    const sequence = ++detailSequence.current
    const result = await request<PlanStatus>(planPath(item), { signal })
    if (mounted.current && sequence === detailSequence.current && !signal?.aborted) setDetail(result)
    return result
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => { mounted.current = false }
  }, [refresh])
  useEffect(() => {
    setConfirmation(null); setVisibleClips(30); setDetail(null)
    if (!selected) return
    const controller = new AbortController()
    void loadDetail(selected, controller.signal).catch(cause => {
      if (!controller.signal.aborted && mounted.current) setError(cause instanceof Error ? cause.message : '方案暂不可用')
    })
    return () => controller.abort()
  }, [selected, loadDetail])
  useEffect(() => {
    if (!plans.some(item => ACTIVE.has(item.taskStatus || '') || item.operations?.some(operation => operation.status === 'unknown'))
      || busy || confirmation) return
    const timer = window.setInterval(() => {
      void refresh()
      if (selected) void loadDetail(selected).catch(() => {})
    }, 5000)
    return () => window.clearInterval(timer)
  }, [plans, selected, refresh, loadDetail, busy, confirmation])

  const plan = detail?.plan
  const canApprove = !!(status?.enabled && status.schemaReady && status.canApprove && status.bindingId
    && status.executor?.connected && status.executor.studio && detail?.planStatus === 'validated'
    && detail.reviewToken && plan && visibleClips >= plan.clips.length && !busy)
  const canCancel = !!(status?.canCancel && detail?.taskId && ACTIVE.has(detail.taskStatus || '') && !busy)

  async function confirmAction() {
    if (!confirmation || busy) return
    const { snapshot, action } = confirmation
    setBusy(true); setError(''); setNotice('')
    try {
      const current = await loadDetail(snapshot)
      if (current.planSha256 !== snapshot.planSha256 || current.revision !== snapshot.revision) {
        throw new Error('方案已更新，请重新核对镜头与导出设置后确认。')
      }
      if (action === 'approve') {
        if (current.planStatus !== 'validated' || !current.reviewToken || !status?.bindingId || !status.canApprove) {
          throw new Error('该方案暂不能确认执行，请刷新当前状态。')
        }
        const key = `${snapshot.planId}:${snapshot.revision}:${snapshot.planSha256}`
        let taskId = taskKeys.current.get(key)
        if (!taskId) { taskId = `edit-${crypto.randomUUID()}`; taskKeys.current.set(key, taskId) }
        await request('/api/editing/plans', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'approve', planId: snapshot.planId, revision: snapshot.revision,
            expectedPlanSha256: snapshot.planSha256, taskId, bindingId: status.bindingId, reviewToken: current.reviewToken }) })
        setNotice('方案已确认并受理，执行进度以任务状态为准。')
      } else {
        if (!current.taskId || !status?.canCancel) throw new Error('当前任务暂不能取消。')
        await request('/api/editing/tasks/action', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action: 'cancel', taskId: current.taskId, expectedPlanSha256: current.planSha256 }) })
        setNotice('已请求取消，等待执行器核对并退出；尚不能宣称已取消。')
      }
      await refresh(); await loadDetail(snapshot)
    } catch (cause) { setError(cause instanceof Error ? cause.message : '操作未完成，请核对状态。') }
    finally { if (mounted.current) { setBusy(false); setConfirmation(null) } }
  }

  return <div className="space-y-5 p-4 sm:p-6">
    <header className="flex items-start justify-between gap-3">
      <div><h2 className="text-lg font-semibold">视频剪辑审核</h2>
        <p className="mt-1 text-sm text-muted-foreground">GPT根据已学习内容提出方案，经你确认后由达芬奇执行。</p></div>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => { setError(''); void refresh(); if (selected) void loadDetail(selected).catch(() => {}) }}>刷新</Button>
    </header>
    {runtime && <p className="text-xs text-muted-foreground">运行版本：{runtime.currentState === 'ready'
      ? runtime.sourceCommit?.slice(0, 8) || '已核验' : runtime.currentState === 'drift' ? '版本状态需核对' : '尚无完整运行收据'}</p>}
    {error && <p role="alert" className="rounded-md border border-destructive/30 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="rounded-md border border-border p-3 text-sm">{notice}</p>}
    <div className="rounded-lg border border-border p-4 text-sm">
      {loading ? '正在读取剪辑状态…' : !status?.enabled || !status.schemaReady ? '正式剪辑尚未开放，可保留候选方案等待环境就绪。'
        : !status.executor?.connected ? '达芬奇尚未连接，执行前需要核对生产编辑节点。'
          : !status.executor.studio ? '当前达芬奇不是Studio版，正式自动剪辑暂不可执行。'
            : `达芬奇已连接${status.executor.projectName ? ` · ${status.executor.projectName}` : ''}`}
    </div>
    <div className="grid gap-5 lg:grid-cols-[240px_1fr]">
      <aside aria-label="候选剪辑方案" className="space-y-2">
        {!loading && plans.length === 0 && <p className="text-sm text-muted-foreground">暂无已保存候选方案。</p>}
        {plans.map(item => <button key={`${item.planId}:${item.revision}`} disabled={busy}
          onClick={() => setSelected({ planId: item.planId, revision: item.revision })}
          className={`w-full rounded-lg border p-3 text-left text-sm ${selected?.planId === item.planId && selected.revision === item.revision ? 'border-primary bg-primary/5' : 'border-border'}`}>
          <span className="block font-medium">{item.objective || '候选剪辑方案'}</span>
          <span className="mt-1 block text-xs text-muted-foreground">第 {item.revision} 版 · {item.clipCount ?? '待核对'} 个镜头 · {labels[item.taskStatus || item.planStatus] || '状态待核对'}</span>
        </button>)}
      </aside>
      <main className="min-w-0 space-y-4">
        {selected && !detail && <p className="text-sm text-muted-foreground">正在读取完整方案…</p>}
        {detail && plan && <>
          <section aria-label="方案目标" className="rounded-lg border border-border p-4">
            <h3 className="font-medium">{plan.objective}</h3>
            <p className="mt-2 text-sm text-muted-foreground">第 {plan.revision} 版 · {plan.clips.length} 个镜头 · 约 {Math.round(duration(plan))} 秒</p>
          </section>
          <section aria-label="镜头及选用依据" className="space-y-3">
            <h3 className="text-sm font-medium">镜头及选用依据</h3>
            {plan.clips.slice(0, visibleClips).map((clip, index) => <article key={clip.itemId} className="rounded-lg border border-border p-4 text-sm">
              <h4 className="font-medium">镜头 {index + 1} · {clip.mediaType === 'audio' ? '音频' : '画面'} · {timestamp(clip.sourceRange.start * plan.sourceFrameRate.denominator / plan.sourceFrameRate.numerator)}–{timestamp(clip.sourceRange.endExclusive * plan.sourceFrameRate.denominator / plan.sourceFrameRate.numerator)}</h4>
              <p className="mt-2 whitespace-pre-wrap">{clip.rationale}</p>
              <p className="mt-2 text-xs text-muted-foreground">{clip.evidence.length} 条来源依据 · {clip.evidence.every(item => item.completeness === 'complete') ? '证据完整' : '含未完整证据，需核对'}{clip.audioGainDb !== undefined ? ` · 音量 ${clip.audioGainDb} dB` : ''}</p>
            </article>)}
            {visibleClips < plan.clips.length && <Button variant="outline" onClick={() => setVisibleClips(value => value + 30)}>查看更多镜头（{Math.min(visibleClips, plan.clips.length)}/{plan.clips.length}）</Button>}
          </section>
          <section aria-label="字幕音乐和导出设置" className="rounded-lg border border-border p-4 text-sm">
            <h3 className="font-medium">字幕、音频与导出</h3>
            <p className="mt-2">字幕：{plan.output.autoSubtitles ? '已计划自动生成字幕' : '方案未启用自动字幕'}</p>
            <p className="mt-1">独立音频片段：{plan.clips.filter(clip => clip.mediaType === 'audio').length} 段；原声与音量按上述镜头设置。</p>
            <p className="mt-1">导出：{plan.output.preview ? '预览短片' : '成片'} · {plan.output.renderPreset || '使用已验证预设'}</p>
          </section>
          <section aria-label="执行进度" className="rounded-lg border border-border p-4 text-sm">
            <h3 className="font-medium">{labels[detail.taskStatus || detail.planStatus] || '状态待核对'}</h3>
            {detail.operations.some(item => item.status === 'unknown') && <p role="status" className="mt-2">存在结果未知的步骤，等待核对，请勿重新执行已完成操作。</p>}
            <ol className="mt-2 space-y-1">{detail.operations.map((item, index) => <li key={item.operationId || index}>
              {phaseLabels[item.phase] || '剪辑步骤'}：{labels[item.status] || '等待核对'}{item.status === 'failed' && '，需要处理失败原因'}</li>)}</ol>
          </section>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!canApprove} onClick={() => setConfirmation({ action: 'approve', snapshot: detail })}>审核后确认执行</Button>
            <Button variant="outline" disabled={!canCancel} onClick={() => setConfirmation({ action: 'cancel', snapshot: detail })}>请求取消任务</Button>
          </div>
          {visibleClips < plan.clips.length && <p className="text-xs text-muted-foreground">请展开完整镜头清单后再确认执行。</p>}
        </>}
      </main>
    </div>
    {confirmation && <div role="dialog" aria-modal="true" aria-labelledby="editing-confirmation-title" className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4">
      <div className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-lg">
        <h3 id="editing-confirmation-title" className="font-semibold">{confirmation.action === 'approve' ? '确认按已审核方案剪辑' : '确认请求取消任务'}</h3>
        <p className="mt-3 text-sm">{confirmation.action === 'approve'
          ? '将按当前镜头、音量、字幕和导出设置创建生产剪辑任务。方案变化时本次确认会被拒绝。'
          : '执行器将核对当前步骤后取消；结果未知的步骤不会自动重做。'}</p>
        <div className="mt-5 flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>返回审核</Button>
          <Button disabled={busy} onClick={() => void confirmAction()}>{busy ? '正在核对…' : confirmation.action === 'approve' ? '确认执行此方案' : '确认取消请求'}</Button></div>
      </div>
    </div>}
  </div>
}
