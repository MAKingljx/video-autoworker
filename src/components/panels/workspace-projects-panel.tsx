'use client'

import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useMissionControl } from '@/store'

interface WorkspaceProjectEntry {
  name: string
  path: string
  modified: number
  hasReadme: boolean
  hasNeed: boolean
  hasReport: boolean
}

interface WorkspaceMonthEntry {
  name: string
  path: string
  modified: number
  projectCount: number
  projects: WorkspaceProjectEntry[]
}

interface WorkspaceProjectsResponse {
  workspaceRoot: string
  workspaceName: string
  months: WorkspaceMonthEntry[]
  error?: string
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

function badge(label: string) {
  return (
    <span className="inline-flex items-center rounded-full border border-border bg-background/70 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
      {label}
    </span>
  )
}

export function WorkspaceProjectsPanel() {
  const { setShowProjectManagerModal } = useMissionControl()
  const [data, setData] = useState<WorkspaceProjectsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null)
  const [copiedPath, setCopiedPath] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      try {
        const response = await fetch('/api/local/workspace-projects', { cache: 'no-store' })
        const body = await response.json() as WorkspaceProjectsResponse
        if (!response.ok) throw new Error(body.error || 'Failed to load workspace projects')

        if (!cancelled) {
          setData(body)
          setSelectedMonth((current) => current && body.months.some((month) => month.name === current)
            ? current
            : body.months[0]?.name || null)
        }
      } catch (fetchError: any) {
        if (!cancelled) {
          setData(null)
          setError(fetchError?.message || 'Failed to load workspace projects')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    void load()
    return () => { cancelled = true }
  }, [])

  const activeMonth = useMemo(
    () => data?.months.find((month) => month.name === selectedMonth) || data?.months[0] || null,
    [data?.months, selectedMonth]
  )

  const openInEditor = (targetPath: string) => {
    const url = `vscode://file${encodeURI(targetPath)}`
    window.open(url, '_blank', 'noopener,noreferrer')
  }

  const copyPath = async (targetPath: string) => {
    try {
      await navigator.clipboard.writeText(targetPath)
      setCopiedPath(targetPath)
      setTimeout(() => {
        setCopiedPath((current) => current === targetPath ? null : current)
      }, 1200)
    } catch {
      // Ignore clipboard failures in browser environments without permission.
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      <section className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="border-b border-border bg-[radial-gradient(circle_at_top_left,rgba(34,211,238,0.12),transparent_35%),linear-gradient(135deg,rgba(255,255,255,0.02),rgba(0,0,0,0.08))] px-5 py-5 md:px-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground/70">Workspace summary</p>
              <h2 className="text-2xl font-semibold text-foreground">Projects</h2>
              <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                这个页面按工作区月份汇总项目目录。先点 <span className="text-foreground font-medium">03</span> 或 <span className="text-foreground font-medium">04</span>，
                再看对应月份里的具体项目文件夹。
              </p>
              {data?.workspaceRoot && (
                <p className="text-xs text-muted-foreground break-all">
                  Root: {data.workspaceRoot}
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => data?.workspaceRoot && openInEditor(data.workspaceRoot)} disabled={!data?.workspaceRoot}>
                Open root
              </Button>
              <Button variant="outline" size="sm" onClick={() => data?.workspaceRoot && copyPath(data.workspaceRoot)} disabled={!data?.workspaceRoot}>
                {copiedPath === data?.workspaceRoot ? 'Copied' : 'Copy path'}
              </Button>
              <Button size="sm" onClick={() => setShowProjectManagerModal(true)}>
                Manage DB projects
              </Button>
            </div>
          </div>
        </div>
      </section>

      {loading ? (
        <div className="rounded-xl border border-border bg-card px-5 py-10 text-sm text-muted-foreground">
          Loading workspace summary...
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-5 py-10 text-sm text-red-300">
          {error}
        </div>
      ) : !data || data.months.length === 0 ? (
        <div className="rounded-xl border border-border bg-card px-5 py-10 text-sm text-muted-foreground">
          No month folders were detected under this workspace.
        </div>
      ) : (
        <>
          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            {data.months.map((month) => {
              const isActive = month.name === activeMonth?.name
              return (
                <button
                  key={month.name}
                  type="button"
                  onClick={() => setSelectedMonth(month.name)}
                  className={`rounded-2xl border p-5 text-left transition-all ${
                    isActive
                      ? 'border-void-cyan/50 bg-void-cyan/10 shadow-[0_18px_40px_rgba(0,0,0,0.18)]'
                      : 'border-border bg-card hover:border-void-cyan/30 hover:bg-secondary/30'
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/70">Month</p>
                      <h3 className="mt-2 text-3xl font-semibold text-foreground">{month.name}</h3>
                    </div>
                    <span className={`rounded-full px-2 py-1 text-[11px] font-medium ${
                      isActive ? 'bg-void-cyan/20 text-void-cyan' : 'bg-background text-muted-foreground'
                    }`}>
                      {month.projectCount} projects
                    </span>
                  </div>
                  <p className="mt-4 text-xs leading-5 text-muted-foreground">
                    Updated {formatTime(month.modified)}
                  </p>
                  {month.projects[0] && (
                    <p className="mt-3 text-sm text-foreground/80 truncate">
                      First project: {month.projects[0].name}
                    </p>
                  )}
                </button>
              )
            })}
          </section>

          <section className="grid gap-6 xl:grid-cols-[280px_1fr]">
            <aside className="rounded-2xl border border-border bg-card p-4">
              <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                <div>
                  <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/70">Jump</p>
                  <h3 className="mt-1 text-sm font-semibold text-foreground">Months</h3>
                </div>
                <span className="text-xs text-muted-foreground">{data.workspaceName}</span>
              </div>

              <div className="mt-3 space-y-2">
                {data.months.map((month) => {
                  const isActive = month.name === activeMonth?.name
                  return (
                    <button
                      key={month.name}
                      type="button"
                      onClick={() => setSelectedMonth(month.name)}
                      className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                        isActive
                          ? 'border-void-cyan/40 bg-void-cyan/10'
                          : 'border-border hover:border-void-cyan/25 hover:bg-secondary/25'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-base font-semibold text-foreground">{month.name}</span>
                        <span className="text-xs text-muted-foreground">{month.projectCount}</span>
                      </div>
                      <p className="mt-1 truncate text-xs text-muted-foreground">{month.path}</p>
                    </button>
                  )
                })}
              </div>
            </aside>

            <div className="rounded-2xl border border-border bg-card p-4 md:p-5">
              {activeMonth ? (
                <>
                  <div className="flex flex-col gap-3 border-b border-border pb-4 md:flex-row md:items-start md:justify-between">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground/70">Selected month</p>
                      <h3 className="mt-1 text-xl font-semibold text-foreground">{activeMonth.name}</h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {activeMonth.projectCount} project folders under {activeMonth.path}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button variant="outline" size="sm" onClick={() => openInEditor(activeMonth.path)}>
                        Open month
                      </Button>
                      <Button variant="outline" size="sm" onClick={() => copyPath(activeMonth.path)}>
                        {copiedPath === activeMonth.path ? 'Copied' : 'Copy month path'}
                      </Button>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                    {activeMonth.projects.map((project) => (
                      <div key={project.path} className="rounded-2xl border border-border bg-background/40 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h4 className="truncate text-sm font-semibold text-foreground">{project.name}</h4>
                            <p className="mt-1 line-clamp-2 break-all text-xs text-muted-foreground">{project.path}</p>
                          </div>
                          <div className="h-2.5 w-2.5 shrink-0 rounded-full bg-void-cyan/70" />
                        </div>

                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {project.hasReadme && badge('README')}
                          {project.hasNeed && badge('need')}
                          {project.hasReport && badge('report')}
                          {!project.hasReadme && !project.hasNeed && !project.hasReport && badge('folder')}
                        </div>

                        <p className="mt-3 text-xs text-muted-foreground">
                          Updated {formatTime(project.modified)}
                        </p>

                        <div className="mt-4 flex gap-2">
                          <Button size="sm" onClick={() => openInEditor(project.path)}>
                            Open
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => copyPath(project.path)}>
                            {copiedPath === project.path ? 'Copied' : 'Copy path'}
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="py-10 text-sm text-muted-foreground">
                  Choose a month to view the folders inside it.
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}
