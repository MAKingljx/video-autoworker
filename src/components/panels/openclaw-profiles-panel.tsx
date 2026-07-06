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

type ProfileConfigFileId =
  | 'openclaw-json'
  | 'workspace-rules'
  | 'workspace-memory'
  | 'workspace-today-memory'
  | 'profile-wiki-rules'

type ProfileConfigKind = 'json' | 'markdown'

interface ProfileConfigFile {
  id: ProfileConfigFileId
  label: string
  description: string
  path: string
  kind: ProfileConfigKind
  canCreate: boolean
  backupKeep: number
}

interface ProfileConfigState {
  profile: string
  fileId: ProfileConfigFileId
  label: string
  description: string
  kind: ProfileConfigKind
  path: string
  raw: string
  hash: string
  rawSize: number
  exists: boolean
  canCreate: boolean
  backupKeep: number
  files: ProfileConfigFile[]
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
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null)
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

  const selectedProfile = useMemo(
    () => profiles.find(profile => profile.id === selectedProfileId) || profiles[0] || null,
    [profiles, selectedProfileId],
  )

  const activeConfigPanel = selectedProfile && configPanel?.profile === selectedProfile.id ? configPanel : null
  const hasUnsavedConfig = Boolean(configPanel && configDraft !== configPanel.raw)

  useEffect(() => {
    if (profiles.length === 0) {
      setSelectedProfileId(null)
      return
    }

    setSelectedProfileId(current => {
      if (current && profiles.some(profile => profile.id === current)) return current
      return profiles[0]?.id || null
    })
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

  const openConfig = useCallback(async (
    profile: Pick<OpenClawProfile, 'id'>,
    fileId?: ProfileConfigFileId,
    options: { force?: boolean } = {},
  ) => {
    const requestedFileId = fileId || (configPanel?.profile === profile.id ? configPanel.fileId : 'openclaw-json')
    if (!options.force && hasUnsavedConfig && window.confirm && !window.confirm('当前配置有未保存内容，切换会丢失这些修改，确定继续？')) {
      return false
    }
    setConfigLoading(profile.id)
    setConfigMessage(null)
    setError(null)
    try {
      const res = await fetch(
        `/api/openclaw/profiles/config?profile=${encodeURIComponent(profile.id)}&fileId=${encodeURIComponent(requestedFileId)}`,
        { cache: 'no-store' },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || '无法读取配置')
      const config = data.config as ProfileConfigState
      setConfigPanel(config)
      setConfigDraft(config.raw)
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取配置')
      return false
    } finally {
      setConfigLoading(null)
    }
  }, [configDraft, configPanel, hasUnsavedConfig])

  useEffect(() => {
    if (!selectedProfileId) return
    if (configPanel?.profile === selectedProfileId) return
    void openConfig({ id: selectedProfileId }, undefined, { force: true })
  }, [configPanel?.profile, openConfig, selectedProfileId])

  const selectProfile = (profile: OpenClawProfile) => {
    if (profile.id === selectedProfileId) {
      if (!configPanel || configPanel.profile !== profile.id) {
        void openConfig(profile)
      }
      return
    }
    if (hasUnsavedConfig && !window.confirm('当前配置有未保存内容，切换配置档会丢失这些修改，确定继续？')) {
      return
    }
    setSelectedProfileId(profile.id)
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
          fileId: configPanel.fileId,
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
      showConfigMessage(true, result.backup?.name ? `已保存，备份 ${result.backup.name}` : '已保存，新文件已创建')
      await openConfig({ id: configPanel.profile } as OpenClawProfile, undefined, { force: true })
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
          fileId: configPanel.fileId,
          backupName: backup.name,
          hash: configPanel.hash,
        }),
      })
      const data = await res.json().catch(() => ({}))
      const result = data.result
      if (!res.ok || !result?.ok) throw new Error(result?.error || data?.error || '恢复失败')
      showConfigMessage(true, `已恢复 ${backup.name}`)
      await openConfig({ id: configPanel.profile } as OpenClawProfile, undefined, { force: true })
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
    if (configPanel.kind === 'markdown') {
      const size = new Blob([configDraft]).size
      if (size > 2_000_000) return { ok: false, text: '文件过大，最多允许 2MB' }
      return { ok: true, text: '文本格式正常' }
    }
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

  const editorState = !activeConfigPanel ? '待载入' : hasUnsavedConfig ? '有未保存修改' : '已同步'

  return (
    <div className="w-full max-w-none space-y-4 p-3 md:p-4 lg:p-5">
      <section className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-foreground">OpenClaw 配置档</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              按运行状态、配置文件与备份顺序集中处理 gpt-main、qwen-current、qwen-weixin-new。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={generateReport} variant="outline" size="sm" disabled={reportLoading}>
              {reportLoading ? '生成中' : '生成验收报告'}
            </Button>
            <Button onClick={fetchProfiles} variant="secondary" size="sm" disabled={refreshing}>
              {refreshing ? '刷新中' : '刷新状态'}
            </Button>
          </div>
        </div>

        <div className="mt-4 grid gap-2 sm:grid-cols-2 2xl:grid-cols-4">
          <SummaryStat
            label="在线配置档"
            value={`${totals.online}/${totals.total}`}
            hint={totals.failed ? `${totals.failed} 个需要排查` : '当前无异常告警'}
            tone={totals.failed ? 'warn' : 'success'}
          />
          <SummaryStat
            label="当前配置档"
            value={selectedProfile?.label || '未选择'}
            hint={selectedProfile ? `${selectedProfile.channel} · :${selectedProfile.gatewayPort}` : '等待载入'}
            tone={selectedProfile ? 'info' : 'muted'}
          />
          <SummaryStat
            label="当前文件"
            value={activeConfigPanel?.label || '未载入'}
            hint={activeConfigPanel ? pathTail(activeConfigPanel.path, 3) : '选择后自动读取'}
            tone={activeConfigPanel ? 'info' : 'muted'}
          />
          <SummaryStat
            label="编辑状态"
            value={editorState}
            hint={localDraftValidation?.text || '等待配置读取'}
            tone={!activeConfigPanel ? 'muted' : hasUnsavedConfig || !localDraftValidation?.ok ? 'warn' : 'success'}
          />
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {lastResult && (
        <details
          open={!lastResult.ok}
          className={`rounded-lg border px-4 py-3 ${
            lastResult.ok ? 'border-green-500/30 bg-green-500/10' : 'border-red-500/30 bg-red-500/10'
          }`}
        >
          <summary className="cursor-pointer list-none">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-foreground">
                  最近操作 · {lastResult.profile} · {actionLabels[lastResult.action]}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {Math.round(lastResult.durationMs / 1000)} 秒 · {lastResult.ok ? '执行完成' : '执行失败'}
                </div>
              </div>
              <span className={`text-xs font-medium ${lastResult.ok ? 'text-green-400' : 'text-red-300'}`}>
                {lastResult.ok ? '展开查看结果' : '优先检查'}
              </span>
            </div>
          </summary>
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
        </details>
      )}

      {report && (
        <details
          open={report.issues.length > 0}
          className={`rounded-lg border px-4 py-3 ${
            report.issues.length ? 'border-amber-500/30 bg-amber-500/10' : 'border-green-500/30 bg-green-500/10'
          }`}
        >
          <summary className="cursor-pointer list-none">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-foreground">验收报告</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {new Date(report.generatedAt).toLocaleString()} · {report.issues.length ? `${report.issues.length} 个待处理项` : '无阻塞问题'}
                </div>
              </div>
              <span className={`text-xs font-medium ${report.issues.length ? 'text-amber-300' : 'text-green-400'}`}>
                {report.issues.length ? '展开排查' : '展开查看'}
              </span>
            </div>
          </summary>
          <div className="mt-3 flex justify-end">
            <Button size="xs" variant="outline" onClick={copyReport}>复制 Markdown</Button>
          </div>
          <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded border border-border/70 bg-background/60 p-3 text-xs text-muted-foreground">
            {report.markdown}
          </pre>
        </details>
      )}

      {configMessage && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${configMessage.ok ? 'border-green-500/30 bg-green-500/10 text-green-300' : 'border-red-500/30 bg-red-500/10 text-red-300'}`}>
          {configMessage.text}
        </div>
      )}

      {loading ? (
        <div className="text-center text-xs text-muted-foreground py-10">正在加载配置档...</div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[288px_minmax(0,1fr)] 2xl:grid-cols-[304px_minmax(0,1fr)]">
          <aside className="overflow-hidden rounded-lg border border-border bg-card lg:sticky lg:top-4 lg:self-start">
            <div className="border-b border-border px-3 py-3">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-semibold text-foreground">配置档列表</div>
                <span className="text-2xs text-muted-foreground">{profiles.length} 项</span>
              </div>
              <div className="mt-1 text-2xs text-muted-foreground">
                先看运行态，再进入主配置、规则、记忆与备份处理。
              </div>
            </div>
            <div className="divide-y divide-border">
              {profiles.map(profile => (
                <ProfileRailItem
                  key={profile.id}
                  profile={profile}
                  active={selectedProfile?.id === profile.id}
                  loading={configLoading === profile.id}
                  onSelect={selectProfile}
                />
              ))}
            </div>
          </aside>

          <div className="min-w-0 space-y-4">
            {selectedProfile ? (
              <>
                <ProfileOverview
                  profile={selectedProfile}
                  running={running}
                  onRun={runAction}
                />

                {activeConfigPanel ? (
                  <section className="overflow-hidden rounded-lg border border-border bg-card">
                    <div className="border-b border-border p-4">
                      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="text-sm font-semibold text-foreground">
                              {activeConfigPanel.profile} · {activeConfigPanel.label}
                            </h3>
                            <FileStateBadge
                              text={activeConfigPanel.validation.ok ? (activeConfigPanel.kind === 'json' ? 'JSON 校验通过' : '文本可保存') : '校验失败'}
                              tone={activeConfigPanel.validation.ok ? 'success' : 'danger'}
                            />
                            <FileStateBadge
                              text={activeConfigPanel.kind === 'json' ? 'JSON' : 'Markdown'}
                              tone="muted"
                            />
                            <FileStateBadge
                              text={activeConfigPanel.exists ? '文件已存在' : activeConfigPanel.canCreate ? '保存时创建' : '文件缺失'}
                              tone={activeConfigPanel.exists ? 'success' : 'warn'}
                            />
                          </div>
                          <p className="mt-2 text-xs text-muted-foreground">{activeConfigPanel.description}</p>
                          <div className="mt-3 grid gap-2 md:grid-cols-2">
                            <SidebarRow label="完整路径" value={activeConfigPanel.path} mono wide />
                            <SidebarRow label="备份保留" value={`最近 ${activeConfigPanel.backupKeep} 版`} />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-[220px_minmax(0,1fr)_300px] 2xl:grid-cols-[240px_minmax(0,1fr)_320px]">
                      <aside className="border-b border-border bg-background/20 p-3 xl:border-b-0 xl:border-r">
                        <div className="flex items-center justify-between gap-2">
                          <div className="text-xs font-semibold text-foreground">核心文件</div>
                          <span className="text-2xs text-muted-foreground">{activeConfigPanel.files.length} 项</span>
                        </div>
                        <div className="mt-3 space-y-2">
                          {activeConfigPanel.files.map(file => {
                            const active = file.id === activeConfigPanel.fileId
                            return (
                              <button
                                key={file.id}
                                type="button"
                                onClick={() => openConfig({ id: activeConfigPanel.profile }, file.id)}
                                disabled={configSaving || configLoading === activeConfigPanel.profile}
                                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                                  active
                                    ? 'border-primary/50 bg-primary/10'
                                    : 'border-border bg-background/50 hover:border-primary/20 hover:bg-background'
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className={`text-xs font-medium ${active ? 'text-primary' : 'text-foreground'}`}>
                                    {file.label}
                                  </div>
                                  {active && (
                                    <span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-2xs text-primary">
                                      当前
                                    </span>
                                  )}
                                </div>
                                <div className="mt-1 line-clamp-2 text-2xs text-muted-foreground">
                                  {file.description}
                                </div>
                                <div className="mt-2 truncate font-mono text-2xs text-muted-foreground" title={file.path}>
                                  {pathTail(file.path, 3)}
                                </div>
                              </button>
                            )
                          })}
                        </div>
                      </aside>

                      <div className="min-w-0 border-b border-border p-4 xl:border-b-0 xl:border-r">
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className={localDraftValidation?.ok ? 'text-green-400' : 'text-red-300'}>
                            {localDraftValidation?.text}
                          </span>
                          <span className="font-mono text-muted-foreground">{Math.max(0, Math.round(configDraft.length / 1024))} KB</span>
                        </div>
                        {!activeConfigPanel.validation.ok && (
                          <div className="rounded border border-red-500/20 bg-red-500/10 p-2 text-xs text-red-300">
                            {activeConfigPanel.validation.issues.join('；')}
                          </div>
                        )}
                        {activeConfigPanel.kind === 'json' && (
                          <div className="rounded border border-amber-500/20 bg-amber-500/10 p-2 text-xs text-amber-200">
                            敏感字段会以 <span className="font-mono">--------</span> 显示；保持该占位符保存时会自动保留远端原值。
                          </div>
                        )}
                        <textarea
                          value={configDraft}
                          onChange={event => setConfigDraft(event.target.value)}
                          className="h-[620px] w-full resize-y rounded-lg border border-border bg-background p-3 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-primary/50"
                          spellCheck={false}
                        />
                      </div>

                      <aside className="space-y-3 p-4">
                        <div className="rounded-lg border border-border bg-background/40 p-3">
                          <div className="text-xs font-semibold text-foreground">当前文件操作</div>
                          <div className="mt-1 text-2xs text-muted-foreground">从这里重新读取、校验并保存当前文件。</div>
                          <div className="mt-3 space-y-2">
                            <SidebarRow label="文件状态" value={editorState} />
                            <SidebarRow label="文件格式" value={activeConfigPanel.kind === 'json' ? 'JSON' : 'Markdown'} />
                            <SidebarRow label="远端状态" value={activeConfigPanel.exists ? '文件已存在' : activeConfigPanel.canCreate ? '允许创建' : '未找到'} />
                            <SidebarRow label="备份策略" value={`保留 ${activeConfigPanel.backupKeep} 版`} />
                          </div>
                          <div className="mt-3 grid grid-cols-2 gap-2">
                            <Button
                              size="xs"
                              variant="outline"
                              onClick={() => openConfig({ id: activeConfigPanel.profile } as OpenClawProfile)}
                              disabled={Boolean(configLoading) || configSaving}
                            >
                              重新读取
                            </Button>
                            <Button
                              size="xs"
                              variant="default"
                              onClick={saveConfig}
                              disabled={configSaving || !localDraftValidation?.ok || configDraft === activeConfigPanel.raw}
                            >
                              {configSaving ? '保存中' : '保存文件'}
                            </Button>
                          </div>
                        </div>

                        <div className="rounded-lg border border-border bg-background/40 p-3">
                          <div className="text-xs font-semibold text-foreground">轻量备份</div>
                          <div className="mt-1 text-2xs text-muted-foreground">每次保存自动留档，便于回滚。</div>
                          <div className="mt-3 space-y-2">
                            {activeConfigPanel.backups.length === 0 && (
                              <div className="text-xs text-muted-foreground">暂无备份</div>
                            )}
                            {activeConfigPanel.backups.map(backup => (
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
                ) : (
                  <section className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
                    {configLoading === selectedProfile.id ? '正在读取核心配置...' : '选择左侧配置档后，将在这里展开核心配置。'}
                  </section>
                )}
              </>
            ) : (
              <section className="rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
                暂无可用 OpenClaw 配置档。
              </section>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function ProfileRailItem({ profile, active, loading, onSelect }: {
  profile: OpenClawProfile
  active: boolean
  loading: boolean
  onSelect: (profile: OpenClawProfile) => void
}) {
  const statusClass = statusColor(profile.status, profile.connectivity)
  const railStatusClass = active
    ? statusClass
    : {
        dot: 'bg-muted-foreground/30',
        badge: 'border-border bg-background/40 text-muted-foreground',
      }
  const checkedAt = profile.checkedAt
    ? new Date(profile.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : '未检查'
  const compactMeta = [profile.channel, profile.agent, `:${profile.gatewayPort}`].join(' · ')
  const runtimeLabel = loading
    ? '探活读取中'
    : profile.connectivity === 'ok'
      ? profile.latencyMs != null
        ? `探活 ${profile.latencyMs}ms`
        : '探活正常'
      : runtimeSummary(profile)

  return (
    <button
      type="button"
      onClick={() => onSelect(profile)}
      className={`w-full px-3 py-2.5 text-left transition-colors ${
        active ? 'bg-primary/10' : 'hover:bg-secondary/50'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${railStatusClass.dot}`} />
            <h3 className="text-sm font-semibold text-foreground truncate">{profile.label}</h3>
          </div>
          <div className="mt-0.5 font-mono text-2xs text-muted-foreground truncate">{profile.id}</div>
        </div>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-2xs font-semibold uppercase ${railStatusClass.badge}`}>
          {statusLabels[profile.status]}
        </span>
      </div>

      <div className="mt-2 space-y-1.5">
        <div className="truncate text-2xs text-muted-foreground" title={compactMeta}>
          {compactMeta}
        </div>
        <div className="flex items-center justify-between gap-2 text-2xs">
          <span className="truncate text-foreground" title={runtimeLabel}>
            {runtimeLabel}
          </span>
          <span className="shrink-0 text-muted-foreground">{checkedAt}</span>
        </div>
      </div>
    </button>
  )
}

function ProfileOverview({ profile, running, onRun }: {
  profile: OpenClawProfile
  running: string | null
  onRun: (profile: OpenClawProfile, action: ProfileAction) => void
}) {
  const statusClass = statusColor(profile.status, profile.connectivity)
  const checkedAt = profile.checkedAt ? new Date(profile.checkedAt).toLocaleString() : '从未'
  const runtimeTone =
    profile.status === 'online' && profile.connectivity === 'ok'
      ? 'success'
      : profile.status === 'error' || profile.connectivity === 'failed'
        ? 'danger'
        : profile.status === 'offline'
          ? 'warn'
          : 'muted'

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`h-2.5 w-2.5 rounded-full ${statusClass.dot}`} />
            <h3 className="text-base font-semibold text-foreground">{profile.label}</h3>
            <span className={`rounded border px-2 py-0.5 text-2xs font-semibold uppercase ${statusClass.badge}`}>
              {statusLabels[profile.status]}
            </span>
          </div>
          <div className="mt-1 truncate font-mono text-xs text-muted-foreground">{profile.id}</div>
        </div>
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
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 2xl:grid-cols-4">
        <RuntimeMetric
          label="运行状态"
          value={runtimeSummary(profile)}
          hint={`${statusLabels[profile.status]} · ${profile.connectivity === 'ok' ? `${profile.latencyMs}ms` : '待排查'}`}
          tone={runtimeTone}
        />
        <RuntimeMetric
          label="端口 / PID"
          value={`:${profile.gatewayPort} / ${profile.pid ? String(profile.pid) : '-'}`}
          hint={profile.listening.join(', ') || '暂无监听地址'}
          tone="info"
          mono
        />
        <RuntimeMetric
          label="业务入口"
          value={profile.channel}
          hint={`智能体 ${profile.agent}`}
          tone="info"
        />
        <RuntimeMetric
          label="版本"
          value={profile.gatewayVersion || '-'}
          hint={`CLI ${profile.cliVersion || '-'} · ${checkedAt}`}
          tone="muted"
        />
      </div>

      <dl className="mt-4 grid gap-3 text-xs md:grid-cols-2">
        <Field label="工作区" value={profile.workspace} mono wide />
        <Field label="主配置路径" value={profile.configPath || '-'} mono wide />
        <Field label="LaunchAgent" value={profile.launchAgent} mono />
        <Field label="监听地址" value={profile.listening.join(', ') || '-'} mono />
        <Field label="模型" value={profile.model} mono wide />
        <Field label="最近检查" value={`${checkedAt} · ${profile.latencyMs}ms`} wide />
      </dl>

      {profile.error && (
        <div className="mt-4 rounded border border-red-500/20 bg-red-500/10 p-2 text-xs text-red-300 whitespace-pre-wrap">
          {profile.error}
        </div>
      )}
    </section>
  )
}

function Field({ label, value, wide, mono }: { label: string; value: string; wide?: boolean; mono?: boolean }) {
  return (
    <div className={wide ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <dt className="text-2xs text-muted-foreground/70">{label}</dt>
      <dd className={`mt-0.5 truncate text-foreground ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </dd>
    </div>
  )
}

function SummaryStat({
  label,
  value,
  hint,
  tone = 'muted',
}: {
  label: string
  value: string
  hint: string
  tone?: Tone
}) {
  const colors = toneColor(tone)

  return (
    <div className={`rounded-lg border p-3 ${colors.card}`}>
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className={`mt-1 truncate text-sm font-semibold ${colors.value}`} title={value}>
        {value}
      </div>
      <div className={`mt-1 truncate text-2xs ${colors.hint}`} title={hint}>
        {hint}
      </div>
    </div>
  )
}

function RuntimeMetric({
  label,
  value,
  hint,
  tone = 'muted',
  mono = false,
}: {
  label: string
  value: string
  hint: string
  tone?: Tone
  mono?: boolean
}) {
  const colors = toneColor(tone)

  return (
    <div className={`rounded-lg border p-3 ${colors.card}`}>
      <div className="text-2xs text-muted-foreground">{label}</div>
      <div className={`mt-1 truncate text-sm font-semibold ${colors.value} ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </div>
      <div className={`mt-1 truncate text-2xs ${colors.hint}`} title={hint}>
        {hint}
      </div>
    </div>
  )
}

function FileStateBadge({ text, tone = 'muted' }: { text: string; tone?: Tone }) {
  return (
    <span className={`rounded border px-2 py-0.5 text-2xs ${toneColor(tone).badge}`}>
      {text}
    </span>
  )
}

function SidebarRow({
  label,
  value,
  mono = false,
  wide = false,
}: {
  label: string
  value: string
  mono?: boolean
  wide?: boolean
}) {
  return (
    <div className={wide ? 'col-span-2 min-w-0' : 'min-w-0'}>
      <div className="text-2xs text-muted-foreground/70">{label}</div>
      <div className={`mt-0.5 truncate text-xs text-foreground ${mono ? 'font-mono' : ''}`} title={value}>
        {value}
      </div>
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

function runtimeSummary(profile: OpenClawProfile) {
  if (profile.status === 'online' && profile.connectivity === 'ok') return '运行正常'
  if (profile.status === 'error' || profile.connectivity === 'failed') return '探活失败'
  if (profile.status === 'offline') return '服务离线'
  return '状态待确认'
}

function pathTail(value: string, depth = 2) {
  const parts = value.split('/').filter(Boolean)
  if (parts.length <= depth) return value
  return `.../${parts.slice(-depth).join('/')}`
}

type Tone = 'success' | 'warn' | 'danger' | 'muted' | 'info'

function toneColor(tone: Tone) {
  switch (tone) {
    case 'success':
      return {
        card: 'border-green-500/30 bg-green-500/10',
        value: 'text-green-300',
        hint: 'text-green-200/80',
        badge: 'border-green-500/30 bg-green-500/10 text-green-400',
      }
    case 'warn':
      return {
        card: 'border-amber-500/30 bg-amber-500/10',
        value: 'text-amber-200',
        hint: 'text-amber-200/80',
        badge: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
      }
    case 'danger':
      return {
        card: 'border-red-500/30 bg-red-500/10',
        value: 'text-red-200',
        hint: 'text-red-200/80',
        badge: 'border-red-500/30 bg-red-500/10 text-red-300',
      }
    case 'info':
      return {
        card: 'border-primary/30 bg-primary/10',
        value: 'text-primary',
        hint: 'text-primary/80',
        badge: 'border-primary/30 bg-primary/10 text-primary',
      }
    default:
      return {
        card: 'border-border bg-background/40',
        value: 'text-foreground',
        hint: 'text-muted-foreground',
        badge: 'border-border bg-background/50 text-muted-foreground',
      }
  }
}
