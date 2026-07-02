'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'

type ProfileStatus = 'online' | 'offline' | 'error' | 'unknown'
type ProfileAction = 'restart' | 'model-test' | 'agent-test'

interface OpenClawProfile {
  id: string
  label: string
  gatewayPort: number
  launchAgent: string
  agent: string
  workspace: string
  model: string
  channel: string
  configPath?: string
  status: ProfileStatus
  pid: number | null
  cliVersion: string | null
  gatewayVersion: string | null
  connectivity: 'ok' | 'failed' | 'unknown'
  listening: string[]
  checkedAt: string
  latencyMs: number
  error?: string
}

interface ActionResult {
  profile: string
  action: ProfileAction
  ok: boolean
  startedAt: string
  finishedAt: string
  durationMs: number
  summary: string
  output: string
}

interface ProfileConfigBackup {
  name: string
  path: string
  size: number
  mtimeMs: number
  createdAt: string
}

interface ProfileConfigState {
  profile: string
  path: string
  raw: string
  hash: string
  rawSize: number
  backups: ProfileConfigBackup[]
  validation: {
    ok: boolean
    issues: string[]
  }
}

interface AcceptanceReport {
  generatedAt: string
  markdown: string
  issues: string[]
}

const actionLabels: Record<ProfileAction, string> = {
  restart: '重启',
  'model-test': '模型测试',
  'agent-test': '智能体测试',
}

const statusLabels: Record<ProfileStatus, string> = {
  online: '在线',
  offline: '离线',
  error: '异常',
  unknown: '未知',
}

export function OpenClawProfilesPanel() {
  const [profiles, setProfiles] = useState<OpenClawProfile[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [running, setRunning] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<ActionResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [configPanel, setConfigPanel] = useState<ProfileConfigState | null>(null)
  const [configDraft, setConfigDraft] = useState('')
  const [configLoading, setConfigLoading] = useState<string | null>(null)
  const [configSaving, setConfigSaving] = useState(false)
  const [configMessage, setConfigMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [report, setReport] = useState<AcceptanceReport | null>(null)
  const [reportLoading, setReportLoading] = useState(false)

  const fetchProfiles = useCallback(async () => {
    setRefreshing(true)
    setError(null)
    try {
      const res = await fetch('/api/openclaw/profiles', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || '无法加载配置档状态')
      setProfiles(Array.isArray(data?.profiles) ? data.profiles : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法加载配置档状态')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    fetchProfiles()
  }, [fetchProfiles])

  const totals = useMemo(() => {
    const online = profiles.filter(profile => profile.status === 'online').length
    const failed = profiles.filter(profile => profile.status === 'error' || profile.connectivity === 'failed').length
    return { online, failed, total: profiles.length }
  }, [profiles])

  const showConfigMessage = useCallback((ok: boolean, text: string) => {
    setConfigMessage({ ok, text })
    setTimeout(() => setConfigMessage(null), 4500)
  }, [])

  const runAction = async (profile: OpenClawProfile, action: ProfileAction) => {
    const key = `${profile.id}:${action}`
    setRunning(key)
    setLastResult(null)
    setError(null)
    try {
      const res = await fetch('/api/openclaw/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: profile.id, action }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok && !data?.result) throw new Error(data?.error || '配置档操作失败')
      setLastResult(data.result)
      await fetchProfiles()
    } catch (err) {
      setError(err instanceof Error ? err.message : '配置档操作失败')
    } finally {
      setRunning(null)
    }
  }

  const openConfig = async (profile: OpenClawProfile) => {
    setConfigLoading(profile.id)
    setConfigMessage(null)
    setError(null)
    try {
      const res = await fetch(`/api/openclaw/profiles/config?profile=${encodeURIComponent(profile.id)}`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || '无法读取配置')
      const config = data.config as ProfileConfigState
      setConfigPanel(config)
      setConfigDraft(config.raw)
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取配置')
    } finally {
      setConfigLoading(null)
    }
  }

  const saveConfig = async () => {
    if (!configPanel || configSaving) return
    setConfigSaving(true)
    setConfigMessage(null)
    try {
      const res = await fetch('/api/openclaw/profiles/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: configPanel.profile,
          raw: configDraft,
          hash: configPanel.hash,
        }),
      })
      const data = await res.json().catch(() => ({}))
      const result = data.result
      if (!res.ok || !result?.ok) {
        const issues = Array.isArray(result?.validation?.issues) ? `：${result.validation.issues.join('；')}` : ''
        throw new Error(result?.error || data?.error || `保存失败${issues}`)
      }
      showConfigMessage(true, `已保存，备份 ${result.backup?.name || '已创建'}`)
      await openConfig({ id: configPanel.profile } as OpenClawProfile)
    } catch (err) {
      showConfigMessage(false, err instanceof Error ? err.message : '保存失败')
    } finally {
      setConfigSaving(false)
    }
  }

  const restoreConfig = async (backup: ProfileConfigBackup) => {
    if (!configPanel || configSaving) return
    const ok = window.confirm(`恢复 ${configPanel.profile} 到备份 ${backup.name}？`)
    if (!ok) return

    setConfigSaving(true)
    setConfigMessage(null)
    try {
      const res = await fetch('/api/openclaw/profiles/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profile: configPanel.profile,
          backupName: backup.name,
          hash: configPanel.hash,
        }),
      })
      const data = await res.json().catch(() => ({}))
      const result = data.result
      if (!res.ok || !result?.ok) throw new Error(result?.error || data?.error || '恢复失败')
      showConfigMessage(true, `已恢复 ${backup.name}`)
      await openConfig({ id: configPanel.profile } as OpenClawProfile)
    } catch (err) {
      showConfigMessage(false, err instanceof Error ? err.message : '恢复失败')
    } finally {
      setConfigSaving(false)
    }
  }

  const generateReport = async () => {
    setReportLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/openclaw/profiles/report', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || '无法生成验收报告')
      setReport(data.report)
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法生成验收报告')
    } finally {
      setReportLoading(false)
    }
  }

  const copyReport = async () => {
    if (!report?.markdown) return
    try {
      await navigator.clipboard.writeText(report.markdown)
      showConfigMessage(true, '验收报告已复制')
    } catch {
      showConfigMessage(false, '复制失败')
    }
  }

  const localDraftValidation = useMemo(() => {
    if (!configPanel) return null
    try {
      const parsed = JSON.parse(configDraft)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, text: 'JSON 根节点必须是对象' }
      }
      return { ok: true, text: 'JSON 格式正常' }
    } catch (err) {
      return { ok: false, text: err instanceof Error ? err.message : 'JSON 格式错误' }
    }
  }, [configDraft, configPanel])

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">OpenClaw 配置档</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            gpt-main、qwen-current 与 qwen-weixin-new 控制面板
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {totals.online}/{totals.total} 在线{totals.failed ? ` · ${totals.failed} 个需要关注` : ''}
          </span>
          <Button onClick={generateReport} variant="outline" size="sm" disabled={reportLoading}>
            {reportLoading ? '生成中' : '验收报告'}
          </Button>
          <Button onClick={fetchProfiles} variant="secondary" size="sm" disabled={refreshing}>
            {refreshing ? '刷新中' : '刷新'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {lastResult && (
        <div className={`rounded-lg border px-4 py-3 ${lastResult.ok ? 'border-green-500/30 bg-green-500/10' : 'border-red-500/30 bg-red-500/10'}`}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-foreground">
                {lastResult.profile} · {actionLabels[lastResult.action]}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {Math.round(lastResult.durationMs / 1000)} 秒 · {lastResult.ok ? '已完成' : '失败'}
              </div>
            </div>
            <span className={`text-xs font-medium ${lastResult.ok ? 'text-green-400' : 'text-red-300'}`}>
              {lastResult.ok ? '正常' : '失败'}
            </span>
          </div>
          <div className="mt-3 whitespace-pre-wrap rounded border border-border/70 bg-background/60 p-3 text-sm text-foreground">
            {lastResult.summary || '操作已完成，但没有返回摘要。'}
          </div>
          {lastResult.output && lastResult.output.trim() !== lastResult.summary.trim() && (
            <details className="mt-2 rounded border border-border/60 bg-background/40 p-3">
              <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                查看原始命令输出
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
                {lastResult.output}
              </pre>
            </details>
          )}
        </div>
      )}

      {report && (
        <section className={`rounded-lg border px-4 py-3 ${report.issues.length ? 'border-amber-500/30 bg-amber-500/10' : 'border-green-500/30 bg-green-500/10'}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-foreground">首版验收报告</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {new Date(report.generatedAt).toLocaleString()} · {report.issues.length ? `${report.issues.length} 个问题` : '无阻塞问题'}
              </div>
            </div>
            <Button size="xs" variant="outline" onClick={copyReport}>复制 Markdown</Button>
          </div>
          <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border/70 bg-background/60 p-3 text-xs text-muted-foreground">
            {report.markdown}
          </pre>
        </section>
      )}

      {configMessage && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${configMessage.ok ? 'border-green-500/30 bg-green-500/10 text-green-300' : 'border-red-500/30 bg-red-500/10 text-red-300'}`}>
          {configMessage.text}
        </div>
      )}

      {loading ? (
        <div className="text-center text-xs text-muted-foreground py-10">正在加载配置档...</div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          {profiles.map(profile => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              running={running}
              onRun={runAction}
              onOpenConfig={openConfig}
              configLoading={configLoading}
            />
          ))}
        </div>
      )}

      {configPanel && (
        <section className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="flex flex-col gap-3 border-b border-border p-4 md:flex-row md:items-start md:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">{configPanel.profile} 配置</h3>
                <span className={`rounded border px-2 py-0.5 text-2xs ${configPanel.validation.ok ? 'border-green-500/30 text-green-400' : 'border-red-500/30 text-red-300'}`}>
                  {configPanel.validation.ok ? 'Zod 校验通过' : '校验失败'}
                </span>
              </div>
              <div className="mt-1 truncate font-mono text-2xs text-muted-foreground" title={configPanel.path}>
                {configPanel.path}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button size="xs" variant="outline" onClick={() => openConfig({ id: configPanel.profile } as OpenClawProfile)} disabled={Boolean(configLoading) || configSaving}>
                重新读取
              </Button>
              <Button size="xs" variant="default" onClick={saveConfig} disabled={configSaving || !localDraftValidation?.ok || configDraft === configPanel.raw}>
                {configSaving ? '保存中' : '保存配置'}
              </Button>
              <Button size="xs" variant="ghost" onClick={() => setConfigPanel(null)} disabled={configSaving}>
                关闭
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_280px]">
            <div className="min-w-0 space-y-2">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className={localDraftValidation?.ok ? 'text-green-400' : 'text-red-300'}>
                  {localDraftValidation?.text}
                </span>
                <span className="font-mono text-muted-foreground">{Math.round(configDraft.length / 1024)} KB</span>
              </div>
              {!configPanel.validation.ok && (
                <div className="rounded border border-red-500/20 bg-red-500/10 p-2 text-xs text-red-300">
                  {configPanel.validation.issues.join('；')}
                </div>
              )}
              <textarea
                value={configDraft}
                onChange={event => setConfigDraft(event.target.value)}
                className="h-[520px] w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-primary/50"
                spellCheck={false}
              />
            </div>

            <aside className="space-y-3">
              <div className="rounded-lg border border-border bg-background/40 p-3">
                <div className="text-xs font-semibold text-foreground">轻量备份</div>
                <div className="mt-1 text-2xs text-muted-foreground">保留最新 2 版</div>
                <div className="mt-3 space-y-2">
                  {configPanel.backups.length === 0 && (
                    <div className="text-xs text-muted-foreground">暂无备份</div>
                  )}
                  {configPanel.backups.map(backup => (
                    <div key={backup.name} className="rounded border border-border/80 p-2">
                      <div className="truncate font-mono text-2xs text-foreground" title={backup.name}>{backup.name}</div>
                      <div className="mt-1 text-2xs text-muted-foreground">
                        {new Date(backup.createdAt).toLocaleString()} · {Math.max(1, Math.round(backup.size / 1024))} KB
                      </div>
                      <Button
                        className="mt-2 w-full"
                        size="xs"
                        variant="outline"
                        onClick={() => restoreConfig(backup)}
                        disabled={configSaving}
                      >
                        恢复
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </aside>
          </div>
        </section>
      )}
    </div>
  )
}

function ProfileCard({ profile, running, onRun, onOpenConfig, configLoading }: {
  profile: OpenClawProfile
  running: string | null
  onRun: (profile: OpenClawProfile, action: ProfileAction) => void
  onOpenConfig: (profile: OpenClawProfile) => void
  configLoading: string | null
}) {
  const statusClass = statusColor(profile.status, profile.connectivity)
  const checkedAt = profile.checkedAt ? new Date(profile.checkedAt).toLocaleString() : '从未'

  return (
    <section className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${statusClass.dot}`} />
            <h3 className="text-sm font-semibold text-foreground truncate">{profile.label}</h3>
          </div>
          <div className="mt-1 text-xs text-muted-foreground font-mono truncate">{profile.id}</div>
        </div>
        <span className={`shrink-0 rounded border px-2 py-0.5 text-2xs font-semibold uppercase ${statusClass.badge}`}>
          {statusLabels[profile.status]}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
        <Field label="端口" value={String(profile.gatewayPort)} mono />
        <Field label="PID" value={profile.pid ? String(profile.pid) : '-'} mono />
        <Field label="智能体" value={profile.agent} mono />
        <Field label="频道" value={profile.channel} />
        <Field label="模型" value={profile.model} mono wide />
        <Field label="工作区" value={profile.workspace} mono wide />
        <Field label="CLI" value={profile.cliVersion || '-'} wide />
        <Field label="网关" value={profile.gatewayVersion || '-'} wide />
        <Field label="监听" value={profile.listening.join(', ') || '-'} mono wide />
        <Field label="检查时间" value={`${checkedAt} · ${profile.latencyMs}ms`} wide />
      </dl>

      {profile.error && (
        <div className="rounded border border-red-500/20 bg-red-500/10 p-2 text-xs text-red-300 whitespace-pre-wrap">
          {profile.error}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2">
        {(['restart', 'model-test', 'agent-test'] as ProfileAction[]).map(action => {
          const key = `${profile.id}:${action}`
          const isRunning = running === key
          const disabled = Boolean(running)
          return (
            <Button
              key={action}
              size="xs"
              variant={action === 'restart' ? 'outline' : 'secondary'}
              disabled={disabled}
              onClick={() => onRun(profile, action)}
              title={actionLabels[action]}
            >
              {isRunning ? '执行中' : actionLabels[action]}
            </Button>
          )
        })}
      </div>
      <Button
        size="xs"
        variant="outline"
        className="w-full"
        onClick={() => onOpenConfig(profile)}
        disabled={Boolean(running) || configLoading === profile.id}
      >
        {configLoading === profile.id ? '读取中' : '配置'}
      </Button>
    </section>
  )
}

function Field({ label, value, wide, mono }: { label: string; value: string; wide?: boolean; mono?: boolean }) {
  return (
    <div className={wide ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <dt className="text-2xs uppercase tracking-wide text-muted-foreground/70">{label}</dt>
      <dd className={`mt-0.5 truncate text-foreground ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </dd>
    </div>
  )
}

function statusColor(status: ProfileStatus, connectivity: OpenClawProfile['connectivity']) {
  if (status === 'online' && connectivity === 'ok') {
    return {
      dot: 'bg-green-500',
      badge: 'border-green-500/30 bg-green-500/15 text-green-400',
    }
  }
  if (status === 'error' || connectivity === 'failed') {
    return {
      dot: 'bg-red-500',
      badge: 'border-red-500/30 bg-red-500/15 text-red-300',
    }
  }
  if (status === 'offline') {
    return {
      dot: 'bg-amber-500',
      badge: 'border-amber-500/30 bg-amber-500/15 text-amber-300',
    }
  }
  return {
    dot: 'bg-muted-foreground/40',
    badge: 'border-border bg-secondary text-muted-foreground',
  }
}
