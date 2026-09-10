'use client'

import { useState, useEffect, useCallback } from 'react'
import { Button } from '@/components/ui/button'
import { Loader } from '@/components/ui/loader'

interface RuntimeStatus {
  id: string
  name: string
  description: string
  installed: boolean
  version: string | null
  running: boolean
  authRequired: boolean
  authHint: string
  authenticated: boolean
}

interface InstallJob {
  id: string
  runtime: string
  status: 'pending' | 'running' | 'success' | 'failed'
  output: string
  error: string | null
}

interface Props {
  showFeedback: (ok: boolean, text: string) => void
}

export function AgentRuntimesSection({ showFeedback }: Props) {
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([])
  const [isDocker, setIsDocker] = useState(false)
  const [loading, setLoading] = useState(true)
  const [activeJobs, setActiveJobs] = useState<Record<string, InstallJob>>({})
  const [expandedOutput, setExpandedOutput] = useState<string | null>(null)

  const fetchRuntimes = useCallback(async () => {
    try {
      const res = await fetch('/api/agent-runtimes')
      if (!res.ok) return
      const data = await res.json()
      setRuntimes(data.runtimes || [])
      setIsDocker(data.isDocker || false)
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { fetchRuntimes() }, [fetchRuntimes])

  // Poll active jobs
  useEffect(() => {
    const running = Object.values(activeJobs).filter(j => j.status === 'running' || j.status === 'pending')
    if (running.length === 0) return

    const interval = setInterval(async () => {
      for (const job of running) {
        try {
          const res = await fetch('/api/agent-runtimes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'job-status', jobId: job.id }),
          })
          if (!res.ok) continue
          const data = await res.json()
          if (data.job) {
            setActiveJobs(prev => ({ ...prev, [data.job.runtime]: data.job }))
            if (data.job.status === 'success') {
              showFeedback(true, `${data.job.runtime} 安装成功`)
              fetchRuntimes()
            } else if (data.job.status === 'failed') {
              showFeedback(false, `${data.job.runtime} 安装失败`)
              fetchRuntimes()
            }
          }
        } catch {
          // ignore
        }
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [activeJobs, fetchRuntimes, showFeedback])

  const handleInstall = async (runtimeId: string) => {
    try {
      const res = await fetch('/api/agent-runtimes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'install', runtime: runtimeId, mode: 'local' }),
      })
      if (!res.ok) {
        showFeedback(false, '启动安装失败')
        return
      }
      const data = await res.json()
      if (data.job) {
        setActiveJobs(prev => ({ ...prev, [runtimeId]: data.job }))
      }
    } catch {
      showFeedback(false, '启动安装失败')
    }
  }

  const handleCopyCompose = async (runtimeId: string) => {
    try {
      const res = await fetch('/api/agent-runtimes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'docker-compose', runtime: runtimeId }),
      })
      if (!res.ok) return
      const data = await res.json()
      await navigator.clipboard.writeText(data.yaml)
      showFeedback(true, 'Docker Compose 片段已复制')
    } catch {
      showFeedback(false, '复制失败')
    }
  }

  const handleDetect = async (runtimeId: string) => {
    try {
      const res = await fetch('/api/agent-runtimes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'detect', runtime: runtimeId }),
      })
      if (!res.ok) return
      await fetchRuntimes()
      showFeedback(true, 'Detection refreshed')
    } catch {
      showFeedback(false, 'Detection failed')
    }
  }

  if (loading) {
    return (
      <div className="p-4 rounded-lg border border-border/30 bg-surface-1/20">
        <h3 className="text-sm font-medium mb-3">OpenClaw 运行时</h3>
        <div className="flex items-center justify-center py-4"><Loader /></div>
      </div>
    )
  }

  return (
    <div className="p-4 rounded-lg border border-border/30 bg-surface-1/20">
      <h3 className="text-sm font-medium mb-1">OpenClaw 运行时</h3>
      <p className="text-xs text-muted-foreground mb-3">
        管理 OpenClaw 网关、本地千问执行节点和远端配置入口。
      </p>

      {isDocker && (
        <div className="mb-3 p-2 rounded border border-void-cyan/20 bg-void-cyan/5 text-xs text-muted-foreground">
          当前运行在 Docker 中，可直接安装，生产环境也可使用 Sidecar 服务。
        </div>
      )}

      <div className="space-y-3">
        {runtimes.map((rt) => {
          const job = activeJobs[rt.id]
          const isInstalling = job?.status === 'running' || job?.status === 'pending'

          return (
            <div key={rt.id} className="p-3 rounded-lg border border-border/20 bg-surface-1/10">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{rt.name}</span>
                  {rt.installed ? (
                    <span className="text-2xs px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                      {rt.version ? `v${rt.version}` : '已安装'}
                    </span>
                  ) : (
                    <span className="text-2xs px-1.5 py-0.5 rounded-full bg-muted/30 text-muted-foreground border border-border/20">
                      未安装
                    </span>
                  )}
                  {rt.installed && (
                    <span className={`text-2xs px-1.5 py-0.5 rounded-full border ${
                      rt.running
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                        : 'bg-muted/20 text-muted-foreground/60 border-border/20'
                    }`}>
                      {rt.running ? '运行中' : '已停止'}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDetect(rt.id)}
                    className="text-2xs h-6 px-2"
                  >
                    刷新
                  </Button>
                  {!rt.installed && !isInstalling && (
                    <>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleInstall(rt.id)}
                        className="text-2xs h-6 px-2"
                      >
                        安装
                      </Button>
                      {isDocker && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCopyCompose(rt.id)}
                          className="text-2xs h-6 px-2"
                        >
                          Sidecar YAML
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>

              <p className="text-xs text-muted-foreground/70">{rt.description}</p>

              {/* Auth status */}
              {rt.installed && rt.authRequired && (
                <p className={`text-2xs mt-1 ${rt.authenticated ? 'text-emerald-400/70' : 'text-amber-400'}`}>
                  {rt.authenticated ? '已认证' : rt.authHint}
                </p>
              )}

              {/* Active install job output */}
              {job && (
                <div className="mt-2">
                  {isInstalling && (
                    <div className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                      <Loader /> 安装中...
                    </div>
                  )}
                  {job.status === 'failed' && (
                    <p className="text-2xs text-red-400">失败：{job.error || '未知错误'}</p>
                  )}
                  {job.status === 'success' && (
                    <p className="text-2xs text-emerald-400">安装成功</p>
                  )}
                  {job.output && (
                    <button
                      onClick={() => setExpandedOutput(expandedOutput === rt.id ? null : rt.id)}
                      className="text-2xs text-muted-foreground/50 hover:text-muted-foreground underline mt-1"
                    >
                      {expandedOutput === rt.id ? '隐藏输出' : '显示输出'}
                    </button>
                  )}
                  {expandedOutput === rt.id && job.output && (
                    <pre className="mt-1 p-2 rounded bg-black/20 text-2xs text-muted-foreground/70 max-h-32 overflow-auto whitespace-pre-wrap">
                      {job.output}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
