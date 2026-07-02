'use client'

import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'

type SearchMode = 'keyword' | 'vector' | 'hybrid'
type SearchScope = 'all' | 'selected'

interface MaterialVideo {
  name: string
  path: string
  size: number
  modifiedAt: string
}

interface MaterialNote {
  name: string
  path: string
  modifiedAt: string
}

interface MaterialPipeline {
  name: string
  path: string
  indexPath: string
  modifiedAt: string
  frames: number
  audioSegments: number
  shotSegments: number
  sceneSegments: number
  visualDone: number
  visualPartial: number
  visualFailed: number
  visualPending: number
}

interface MaterialProject {
  id: string
  name: string
  path: string
  modifiedAt: string
  videos: MaterialVideo[]
  notes: MaterialNote[]
  pipelines: MaterialPipeline[]
  totals: {
    videos: number
    notes: number
    scenes: number
    visualDone: number
    visualPending: number
    vectorChunks: number
  }
}

interface MaterialsOverview {
  workspaceRoot: string
  botLearningRoot: string
  generatedAt: string
  vector: {
    exists: boolean
    path: string
    chunks: number
    indexedAt: string | null
    model: string | null
    dims: number | null
  }
  totals: {
    projects: number
    videos: number
    notes: number
    pipelines: number
    scenes: number
    visualDone: number
    visualPending: number
    vectorChunks: number
  }
  projects: MaterialProject[]
}

interface SearchResult {
  id: string
  project: string
  pipeline: string
  sceneId: number
  label: string
  start: number | null
  end: number | null
  score: number
  source: SearchMode
  snippet: string
  transcript: string
  visualSummary: string
  tags: string[]
}

interface SearchResponse {
  query: string
  mode: SearchMode
  vectorAvailable: boolean
  results: SearchResult[]
}

interface VectorIndexResult {
  ok: boolean
  dbPath: string
  model: string
  dims: number | null
  indexed: number
  skipped: number
  errors: string[]
  chunks: number
  project: string | null
  generatedAt: string
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '未记录'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}

function formatTimeRange(start: number | null, end: number | null): string {
  const format = (value: number | null) => {
    if (value === null || !Number.isFinite(value)) return '--:--'
    const seconds = Math.max(0, Math.round(value))
    return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  }
  return `${format(start)} - ${format(end)}`
}

function sourceLabel(source: SearchMode): string {
  if (source === 'vector') return '语义'
  if (source === 'hybrid') return '混合'
  return '关键词'
}

function completionRatio(done: number, total: number): number {
  if (!total) return 0
  return Math.round((done / total) * 100)
}

export function MaterialsPanel() {
  const [overview, setOverview] = useState<MaterialsOverview | null>(null)
  const [selectedProject, setSelectedProject] = useState<string>('')
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('keyword')
  const [searchScope, setSearchScope] = useState<SearchScope>('all')
  const [maxChunks, setMaxChunks] = useState(0)
  const [searchData, setSearchData] = useState<SearchResponse | null>(null)
  const [indexResult, setIndexResult] = useState<VectorIndexResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadOverview = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/materials', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || '无法加载素材库')
      setOverview(data)
      setSelectedProject(current => current || data.projects?.[0]?.id || '')
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法加载素材库')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const activeProject = useMemo(
    () => overview?.projects.find(project => project.id === selectedProject) || overview?.projects[0] || null,
    [overview, selectedProject],
  )

  const runSearch = async () => {
    const trimmed = query.trim()
    if (!trimmed) return
    setSearching(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        q: trimmed,
        mode,
        limit: '24',
      })
      if (searchScope === 'selected' && selectedProject) params.set('project', selectedProject)
      const res = await fetch(`/api/materials/search?${params.toString()}`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || '素材搜索失败')
      setSearchData(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : '素材搜索失败')
      setSearchData(null)
    } finally {
      setSearching(false)
    }
  }

  const runVectorIndex = async () => {
    setIndexing(true)
    setError(null)
    setIndexResult(null)
    try {
      const res = await fetch('/api/materials/vector-index', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: selectedProject || undefined,
          maxChunks,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok && !data?.result) throw new Error(data?.error || '向量索引失败')
      setIndexResult(data.result)
      await loadOverview()
    } catch (err) {
      setError(err instanceof Error ? err.message : '向量索引失败')
    } finally {
      setIndexing(false)
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-5">
      <section className="border-b border-border pb-5">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md border border-void-cyan/30 bg-void-cyan/10 px-2 py-1 text-[11px] font-semibold text-void-cyan">
                Qwen Video Learning
              </span>
              <span className="rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground">
                {overview?.vector.exists ? '向量库已创建' : '向量库待创建'}
              </span>
            </div>
            <h1 className="text-2xl font-semibold text-foreground">素材中心</h1>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              {overview?.botLearningRoot || '/Users/heisenbergs-1/AI-worker-second-original-workspace/bot-learning'}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void loadOverview()} disabled={loading || indexing}>
              刷新
            </Button>
            <Button size="sm" onClick={() => void runVectorIndex()} disabled={loading || indexing || !activeProject}>
              {indexing ? '索引中...' : '更新向量索引'}
            </Button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-lg border border-border bg-card px-5 py-10 text-sm text-muted-foreground">
          正在加载素材库...
        </div>
      ) : !overview ? (
        <div className="rounded-lg border border-border bg-card px-5 py-10 text-sm text-muted-foreground">
          没有读取到素材库。
        </div>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
            <Metric label="项目" value={overview.totals.projects} />
            <Metric label="视频" value={overview.totals.videos} />
            <Metric label="场景" value={overview.totals.scenes} />
            <Metric label="VL 完成" value={overview.totals.visualDone} />
            <Metric label="待标注" value={overview.totals.visualPending} />
            <Metric label="向量片段" value={overview.totals.vectorChunks} />
          </section>

          <section className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
            <aside className="space-y-3">
              <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center justify-between gap-3 border-b border-border pb-3">
                  <div>
                    <p className="text-[11px] uppercase text-muted-foreground">Projects</p>
                    <h2 className="mt-1 text-sm font-semibold text-foreground">素材项目</h2>
                  </div>
                  <span className="text-xs text-muted-foreground">{overview.projects.length}</span>
                </div>
                <div className="mt-3 space-y-2">
                  {overview.projects.map(project => {
                    const active = project.id === activeProject?.id
                    const totalScenes = project.totals.scenes
                    const ratio = completionRatio(project.totals.visualDone, totalScenes)
                    return (
                      <button
                        key={project.id}
                        type="button"
                        onClick={() => setSelectedProject(project.id)}
                        className={`w-full rounded-md border px-3 py-3 text-left transition-colors ${
                          active
                            ? 'border-void-cyan/45 bg-void-cyan/10'
                            : 'border-border bg-background/40 hover:border-void-cyan/25 hover:bg-secondary/30'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold text-foreground">{project.name}</p>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {project.totals.videos} 视频 / {totalScenes} 场景
                            </p>
                          </div>
                          <span className="rounded bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {ratio}%
                          </span>
                        </div>
                        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-void-cyan" style={{ width: `${ratio}%` }} />
                        </div>
                      </button>
                    )
                  })}
                </div>
              </div>

              <div className="rounded-lg border border-border bg-card p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] uppercase text-muted-foreground">Vector DB</p>
                    <h2 className="mt-1 text-sm font-semibold text-foreground">向量库</h2>
                  </div>
                  <span className="rounded bg-background px-2 py-1 text-xs text-muted-foreground">
                    {overview.vector.chunks} chunks
                  </span>
                </div>
                <div className="mt-3 space-y-2 text-xs text-muted-foreground">
                  <p className="break-all">{overview.vector.path}</p>
                  <p>模型：{overview.vector.model || 'nomic-embed-text'}</p>
                  <p>维度：{overview.vector.dims || 768}</p>
                  <p>更新：{formatDate(overview.vector.indexedAt)}</p>
                </div>
                <label className="mt-4 block text-xs text-muted-foreground">
                  单次上限
                  <input
                    type="number"
                    min={0}
                    value={maxChunks}
                    onChange={(event) => setMaxChunks(Math.max(0, Number(event.target.value || 0)))}
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground"
                  />
                </label>
                <p className="mt-2 text-[11px] text-muted-foreground">0 表示处理所选项目的全部待更新场景。</p>
              </div>
            </aside>

            <div className="space-y-5 min-w-0">
              {activeProject && (
                <ProjectDetail project={activeProject} />
              )}

              <section className="rounded-lg border border-border bg-card p-4 md:p-5">
                <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                  <div className="min-w-0 flex-1">
                    <label className="text-xs font-medium text-muted-foreground" htmlFor="material-search">
                      搜索素材
                    </label>
                    <input
                      id="material-search"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') void runSearch()
                      }}
                      placeholder="输入地点、人物、动作、画面、字幕..."
                      className="mt-2 h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-void-cyan/45"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-muted-foreground">范围</span>
                    <ModeButton active={searchScope === 'all'} onClick={() => setSearchScope('all')}>全部</ModeButton>
                    <ModeButton active={searchScope === 'selected'} onClick={() => setSearchScope('selected')}>当前项目</ModeButton>
                    <span className="mx-1 hidden h-5 w-px bg-border md:inline-block" />
                    <ModeButton active={mode === 'keyword'} onClick={() => setMode('keyword')}>关键词</ModeButton>
                    <ModeButton active={mode === 'vector'} onClick={() => setMode('vector')}>语义</ModeButton>
                    <ModeButton active={mode === 'hybrid'} onClick={() => setMode('hybrid')}>混合</ModeButton>
                    <Button size="sm" onClick={() => void runSearch()} disabled={searching || !query.trim()}>
                      {searching ? '搜索中...' : '搜索'}
                    </Button>
                  </div>
                </div>

                <div className="mt-4 space-y-3">
                  {searchData?.results.length === 0 && (
                    <div className="rounded-md border border-border bg-background/50 px-4 py-6 text-sm text-muted-foreground">
                      没有匹配结果。
                    </div>
                  )}

                  {searchData?.results.map(result => (
                    <article key={`${result.id}:${result.source}`} className="rounded-md border border-border bg-background/45 p-4">
                      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded bg-void-cyan/10 px-2 py-0.5 text-xs text-void-cyan">{sourceLabel(result.source)}</span>
                            <span className="text-xs text-muted-foreground">{result.project} / {result.pipeline}</span>
                            <span className="text-xs text-muted-foreground">{formatTimeRange(result.start, result.end)}</span>
                          </div>
                          <h3 className="mt-2 text-sm font-semibold text-foreground">{result.label}</h3>
                        </div>
                        <span className="rounded bg-card px-2 py-1 text-xs text-muted-foreground">
                          score {result.score.toFixed(2)}
                        </span>
                      </div>
                      {result.visualSummary && (
                        <p className="mt-3 text-sm leading-6 text-foreground/85">{result.visualSummary}</p>
                      )}
                      {result.snippet && (
                        <p className="mt-2 text-xs leading-5 text-muted-foreground">{result.snippet}</p>
                      )}
                      {result.tags.length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                          {result.tags.slice(0, 10).map(tag => (
                            <span key={tag} className="rounded border border-border bg-card px-2 py-0.5 text-[11px] text-muted-foreground">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </article>
                  ))}
                </div>
              </section>

              {indexResult && (
                <section className="rounded-lg border border-border bg-card p-4 text-sm">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="font-semibold text-foreground">向量索引结果</h2>
                    <span className={`rounded px-2 py-1 text-xs ${indexResult.ok ? 'bg-green-500/10 text-green-400' : 'bg-amber-500/10 text-amber-300'}`}>
                      {indexResult.ok ? '完成' : '有警告'}
                    </span>
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
                    <p>新增/更新：{indexResult.indexed}</p>
                    <p>跳过：{indexResult.skipped}</p>
                    <p>总片段：{indexResult.chunks}</p>
                    <p>维度：{indexResult.dims || '-'}</p>
                  </div>
                  {indexResult.errors.length > 0 && (
                    <pre className="mt-3 max-h-36 overflow-auto rounded-md bg-background p-3 text-xs text-amber-200">
                      {indexResult.errors.join('\n')}
                    </pre>
                  )}
                </section>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-foreground">{value.toLocaleString('zh-CN')}</p>
    </div>
  )
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`h-8 rounded-md border px-3 text-xs transition-colors ${
        active
          ? 'border-void-cyan/45 bg-void-cyan/10 text-void-cyan'
          : 'border-border bg-background text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function ProjectDetail({ project }: { project: MaterialProject }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4 md:p-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <p className="text-[11px] uppercase text-muted-foreground">Selected material</p>
          <h2 className="mt-1 truncate text-xl font-semibold text-foreground">{project.name}</h2>
          <p className="mt-1 break-all text-xs text-muted-foreground">{project.path}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge>{project.totals.videos} 视频</Badge>
          <Badge>{project.totals.notes} 笔记</Badge>
          <Badge>{project.totals.vectorChunks} 向量</Badge>
        </div>
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(280px,0.8fr)]">
        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border bg-background/60 text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Pipeline</th>
                <th className="px-3 py-2 font-medium">场景</th>
                <th className="px-3 py-2 font-medium">VL</th>
                <th className="px-3 py-2 font-medium">更新时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {project.pipelines.map(pipeline => {
                const ratio = completionRatio(pipeline.visualDone, pipeline.sceneSegments)
                return (
                  <tr key={pipeline.path} className="bg-card/40">
                    <td className="px-3 py-3">
                      <p className="font-medium text-foreground">{pipeline.name}</p>
                      <p className="mt-1 max-w-[360px] truncate text-xs text-muted-foreground">{pipeline.indexPath}</p>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground">
                      {pipeline.sceneSegments}
                    </td>
                    <td className="px-3 py-3">
                      <div className="min-w-24">
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span>{pipeline.visualDone}/{pipeline.sceneSegments}</span>
                          <span>{ratio}%</span>
                        </div>
                        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                          <div className="h-full rounded-full bg-green-400" style={{ width: `${ratio}%` }} />
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-xs text-muted-foreground">
                      {formatDate(pipeline.modifiedAt)}
                    </td>
                  </tr>
                )
              })}
              {project.pipelines.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-8 text-center text-sm text-muted-foreground">
                    暂无 pipeline 索引。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="space-y-3">
          <div className="rounded-md border border-border bg-background/40 p-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">视频</h3>
              <span className="text-xs text-muted-foreground">{project.videos.length}</span>
            </div>
            <div className="mt-3 max-h-48 space-y-2 overflow-auto">
              {project.videos.map(video => (
                <div key={video.path} className="rounded border border-border bg-card px-3 py-2">
                  <p className="truncate text-xs font-medium text-foreground">{video.name}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{formatBytes(video.size)} / {formatDate(video.modifiedAt)}</p>
                </div>
              ))}
              {project.videos.length === 0 && <p className="text-xs text-muted-foreground">暂无视频。</p>}
            </div>
          </div>

          <div className="rounded-md border border-border bg-background/40 p-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-foreground">学习笔记</h3>
              <span className="text-xs text-muted-foreground">{project.notes.length}</span>
            </div>
            <div className="mt-3 max-h-48 space-y-2 overflow-auto">
              {project.notes.slice(0, 12).map(note => (
                <div key={note.path} className="rounded border border-border bg-card px-3 py-2">
                  <p className="truncate text-xs font-medium text-foreground">{note.name}</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">{formatDate(note.modifiedAt)}</p>
                </div>
              ))}
              {project.notes.length === 0 && <p className="text-xs text-muted-foreground">暂无笔记。</p>}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function Badge({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md border border-border bg-background px-2 py-1 text-xs text-muted-foreground">
      {children}
    </span>
  )
}
