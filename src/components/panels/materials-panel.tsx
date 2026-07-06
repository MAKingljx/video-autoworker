'use client'

import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

interface MaterialPreviewFrame {
  path: string
  time: number | null
  timeLabel: string | null
  width?: number | null
  height?: number | null
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
  previewFrames: MaterialPreviewFrame[]
  metadata: Record<string, unknown>
}

interface SearchResponse {
  query: string
  mode: SearchMode
  generatedAt: string
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

interface ResultVideoMatch {
  video: MaterialVideo | null
  confident: boolean
}

function compareProjects(left: MaterialProject, right: MaterialProject): number {
  const leftWeight = (left.totals.videos > 0 ? 1000 : 0) + (left.totals.scenes > 0 ? 100 : 0) + left.totals.scenes
  const rightWeight = (right.totals.videos > 0 ? 1000 : 0) + (right.totals.scenes > 0 ? 100 : 0) + right.totals.scenes
  if (leftWeight !== rightWeight) return rightWeight - leftWeight
  return left.name.localeCompare(right.name, 'zh-CN')
}

function preferredProjectId(projects: MaterialProject[]): string {
  const preferred = [...projects].sort(compareProjects)[0]
  return preferred?.id || ''
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
  if (source === 'vector') return '通义语义'
  if (source === 'hybrid') return '混合'
  return '关键词'
}

function completionRatio(done: number, total: number): number {
  if (!total) return 0
  return Math.round((done / total) * 100)
}

function assetUrl(filePath: string): string {
  return `/api/materials/asset?path=${encodeURIComponent(filePath)}`
}

function resultTitle(result: SearchResult): string {
  return result.visualSummary || result.label
}

function metadataText(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key]
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value
      .map(item => String(item).trim())
      .filter(Boolean)
      .join(' / ')
  }
  return ''
}

function metadataList(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key]
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean)
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function normalizeForMatch(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
}

function chineseNumberToken(value: number): string {
  const direct = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  if (value > 0 && value < 10) return direct[value]
  if (value === 10) return '十'
  if (value < 20) return `十${direct[value - 10]}`
  if (value < 100) {
    const tens = Math.floor(value / 10)
    const ones = value % 10
    return `${direct[tens]}十${ones ? direct[ones] : ''}`
  }
  return String(value)
}

function episodeTokensFromText(value: string): string[] {
  const tokens = new Set<string>()
  const lower = value.toLowerCase()
  const addEpisodeNumber = (raw: string) => {
    const number = Number(raw)
    if (!Number.isFinite(number) || number <= 0) return
    tokens.add(String(number))
    tokens.add(String(number).padStart(2, '0'))
    tokens.add(chineseNumberToken(number))
  }

  lower.replace(/ep(?:isode)?[-_\s]?(\d{1,3})/g, (_match, raw) => {
    addEpisodeNumber(raw)
    return _match
  })
  lower.replace(/第(\d{1,3})[集季期篇]?/g, (_match, raw) => {
    addEpisodeNumber(raw)
    return _match
  })

  for (const chinese of ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二']) {
    if (value.includes(chinese)) tokens.add(chinese)
  }

  return Array.from(tokens).filter(Boolean)
}

function matchResultVideo(project: MaterialProject, result: SearchResult): MaterialVideo | null {
  if (project.videos.length === 0) return null
  if (project.videos.length === 1) return project.videos[0]

  const candidates = episodeTokensFromText(`${result.pipeline} ${result.label} ${result.visualSummary}`)
  if (candidates.length === 0) return null

  const scored = project.videos
    .map(video => {
      const haystack = normalizeForMatch(video.name)
      let score = 0
      for (const token of candidates) {
        const normalized = normalizeForMatch(token)
        if (!normalized) continue
        if (haystack.includes(normalized)) score += token.length >= 2 ? 3 : 2
      }
      return { score, video }
    })
    .sort((left, right) => right.score - left.score)

  if (scored[0]?.score && scored[0].score > (scored[1]?.score || 0)) {
    return scored[0].video
  }
  return null
}

function resolveResultVideo(project: MaterialProject, result: SearchResult, currentVideoPath: string): ResultVideoMatch {
  if (project.videos.length === 0) return { video: null, confident: false }
  if (project.videos.length === 1) return { video: project.videos[0], confident: true }

  const matchedVideo = matchResultVideo(project, result)
  if (matchedVideo) return { video: matchedVideo, confident: true }

  const currentVideo = project.videos.find(video => video.path === currentVideoPath)
  if (currentVideo) return { video: currentVideo, confident: false }
  return { video: project.videos[0], confident: false }
}

function videoDisplayTitle(name: string): string {
  return name.replace(/\.[^.]+$/, '')
}

function videoEpisodeBadge(name: string): string {
  const tokens = episodeTokensFromText(name)
  const numeric = tokens.find(token => /^\d+$/.test(token) && !token.startsWith('0')) || tokens.find(token => /^\d+$/.test(token))
  if (numeric) return `EP${numeric.padStart(2, '0')}`
  const chinese = tokens.find(token => /[一二三四五六七八九十]/.test(token))
  if (chinese) return `第${chinese}集`
  return 'VIDEO'
}

function seekVideo(video: HTMLVideoElement, seconds: number) {
  const apply = () => {
    const maxTime = Number.isFinite(video.duration) && video.duration > 0 ? Math.max(0, video.duration - 0.25) : seconds
    video.currentTime = Math.max(0, Math.min(seconds, maxTime))
    void video.play().catch(() => {})
  }

  if (video.readyState >= 1) {
    apply()
    return
  }

  const handleLoaded = () => {
    video.removeEventListener('loadedmetadata', handleLoaded)
    apply()
  }
  video.addEventListener('loadedmetadata', handleLoaded)
  video.load()
}

export function MaterialsPanel() {
  const [overview, setOverview] = useState<MaterialsOverview | null>(null)
  const [selectedProject, setSelectedProject] = useState<string>('')
  const [selectedVideoPath, setSelectedVideoPath] = useState<string>('')
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<SearchMode>('hybrid')
  const [searchScope, setSearchScope] = useState<SearchScope>('selected')
  const [maxChunks, setMaxChunks] = useState(0)
  const [searchData, setSearchData] = useState<SearchResponse | null>(null)
  const [focusedResultId, setFocusedResultId] = useState<string | null>(null)
  const [indexResult, setIndexResult] = useState<VectorIndexResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [indexing, setIndexing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playerNotice, setPlayerNotice] = useState<string | null>(null)
  const [pendingCue, setPendingCue] = useState<{ projectId: string; videoPath: string; seconds: number } | null>(null)
  const playerRef = useRef<HTMLVideoElement | null>(null)

  const loadOverview = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/materials', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || '无法加载素材库')
      setOverview(data)
      setSelectedProject(current => current || preferredProjectId(data.projects || []))
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法加载素材库')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadOverview()
  }, [loadOverview])

  const orderedProjects = useMemo(
    () => [...(overview?.projects || [])].sort(compareProjects),
    [overview?.projects],
  )

  const projectMap = useMemo(
    () => new Map(orderedProjects.map(project => [project.id, project])),
    [orderedProjects],
  )

  const activeProject = useMemo(
    () => orderedProjects.find(project => project.id === selectedProject) || orderedProjects[0] || null,
    [orderedProjects, selectedProject],
  )

  useEffect(() => {
    if (!activeProject) {
      setSelectedVideoPath('')
      return
    }
    setSelectedVideoPath(current => activeProject.videos.some(video => video.path === current) ? current : activeProject.videos[0]?.path || '')
  }, [activeProject])

  const selectedVideo = useMemo(
    () => activeProject?.videos.find(video => video.path === selectedVideoPath) || activeProject?.videos[0] || null,
    [activeProject, selectedVideoPath],
  )

  const focusedResult = useMemo(
    () => searchData?.results.find(result => result.id === focusedResultId) || searchData?.results[0] || null,
    [focusedResultId, searchData?.results],
  )

  useEffect(() => {
    setFocusedResultId(searchData?.results[0]?.id || null)
  }, [searchData?.query, searchData?.generatedAt, searchData?.results])

  useEffect(() => {
    if (!pendingCue || !activeProject || !selectedVideo) return
    if (activeProject.id !== pendingCue.projectId) return
    if (selectedVideo.path !== pendingCue.videoPath) return
    if (!playerRef.current) return
    seekVideo(playerRef.current, pendingCue.seconds)
    setPendingCue(null)
  }, [activeProject, pendingCue, selectedVideo])

  useEffect(() => {
    if (!playerNotice) return undefined
    const timer = window.setTimeout(() => setPlayerNotice(null), 3500)
    return () => window.clearTimeout(timer)
  }, [playerNotice])

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

  const cueResult = useCallback((result: SearchResult, options: { switchProject?: boolean } = {}) => {
    const project = projectMap.get(result.project)
    if (!project) return

    const shouldSwitchProject = options.switchProject || project.id !== activeProject?.id
    const match = resolveResultVideo(project, result, shouldSwitchProject ? '' : selectedVideoPath)

    setFocusedResultId(result.id)
    setSelectedProject(project.id)

    if (match.video) {
      setSelectedVideoPath(match.video.path)
    }

    if (result.start !== null && match.video) {
      setPendingCue({
        projectId: project.id,
        videoPath: match.video.path,
        seconds: result.start,
      })
      setPlayerNotice(
        match.confident
          ? `已准备 ${project.name} · ${match.video.name} 的 ${formatTimeRange(result.start, result.end)}`
          : '已切到对应项目，并把时间码送入播放器，请确认当前视频片源。',
      )
    } else if (shouldSwitchProject) {
      setPlayerNotice(`已切到项目：${project.name}`)
    }
  }, [activeProject?.id, projectMap, selectedVideoPath])

  const cueCurrentVideo = useCallback((result: SearchResult) => {
    if (!activeProject || !selectedVideo || result.start === null) return
    setFocusedResultId(result.id)
    setPendingCue({
      projectId: activeProject.id,
      videoPath: selectedVideo.path,
      seconds: result.start,
    })
    setPlayerNotice(`已在当前视频准备 ${formatTimeRange(result.start, result.end)} 片段`)
  }, [activeProject, selectedVideo])

  const focusProject = useCallback((projectId: string) => {
    setSelectedProject(projectId)
  }, [])

  return (
    <div className="space-y-4 p-4 md:p-5">
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
          <section className="rounded-lg border border-border bg-card p-3.5 md:p-4">
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-lg font-semibold text-foreground">素材工作台</h1>
                    {activeProject && <Badge subtle>{activeProject.name}</Badge>}
                    {searchData && <Badge subtle>{searchData.results.length} 个命中</Badge>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge subtle>{searchScope === 'selected' && activeProject ? '当前项目搜索' : '全库搜索'}</Badge>
                    <Badge subtle>{mode === 'keyword' ? '关键词' : mode === 'vector' ? '通义语义' : '混合检索'}</Badge>
                    <Badge subtle>{overview.vector.exists ? `${overview.vector.chunks} 个片段已入库` : '向量库待建立'}</Badge>
                    <Badge subtle>{overview.vector.model || 'nomic-embed-text'}</Badge>
                    <Badge subtle>{formatDate(overview.vector.indexedAt)}</Badge>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" size="sm" onClick={() => void loadOverview()} disabled={loading || indexing}>
                    刷新素材
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => void runVectorIndex()} disabled={loading || indexing || !activeProject}>
                    {indexing ? '索引中...' : '更新向量索引'}
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <input
                    id="material-search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void runSearch()
                    }}
                    placeholder="搜索地点、人物、动作、字幕、画面氛围"
                    className="h-11 w-full rounded-lg border border-border bg-background px-4 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40"
                  />
                </div>
                <Button className="h-11 px-5" onClick={() => void runSearch()} disabled={searching || !query.trim()}>
                  {searching ? '搜索中...' : '搜索素材'}
                </Button>
              </div>

              <div className="flex flex-col gap-2.5 border-t border-border pt-2.5 xl:flex-row xl:items-center xl:justify-between">
                <div className="flex flex-wrap items-center gap-2">
                  <ModeButton active={searchScope === 'selected'} onClick={() => setSearchScope('selected')}>当前项目</ModeButton>
                  <ModeButton active={searchScope === 'all'} onClick={() => setSearchScope('all')}>全部项目</ModeButton>
                  <div className="mx-1 hidden h-4 w-px bg-border xl:block" />
                  <ModeButton active={mode === 'keyword'} onClick={() => setMode('keyword')}>关键词</ModeButton>
                  <ModeButton active={mode === 'vector'} onClick={() => setMode('vector')}>通义语义</ModeButton>
                  <ModeButton active={mode === 'hybrid'} onClick={() => setMode('hybrid')}>混合</ModeButton>
                </div>

                <div className="flex min-w-0 gap-1.5 overflow-x-auto pb-1 xl:justify-end">
                  {orderedProjects.map(project => (
                    <ProjectTabButton
                      key={project.id}
                      project={project}
                      active={project.id === activeProject?.id}
                      onSelect={() => focusProject(project.id)}
                    />
                  ))}
                </div>
              </div>
            </div>
          </section>

          {activeProject ? (
            <ProjectWorkbench
              project={activeProject}
              selectedVideo={selectedVideo}
              selectedVideoPath={selectedVideoPath}
              onSelectVideo={setSelectedVideoPath}
              playerNotice={playerNotice}
              playerRef={playerRef}
              focusedResult={focusedResult && focusedResult.project === activeProject.id ? focusedResult : null}
              onCueFocusedResult={focusedResult && focusedResult.project === activeProject.id ? () => cueCurrentVideo(focusedResult) : undefined}
            />
          ) : (
            <EmptyState title="暂无项目" description="当前素材库里还没有可用项目。" />
          )}

          <section className="rounded-lg border border-border bg-card p-3.5 md:p-4">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <h2 className="text-base font-semibold text-foreground">通义识别结果</h2>
                <p className="mt-1 text-xs text-muted-foreground">命中镜头继续往下挑，焦点细节放右侧。</p>
              </div>
              {searchData && (
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <Badge subtle>{sourceLabel(searchData.mode)}</Badge>
                  <Badge subtle>{searchData.query}</Badge>
                </div>
              )}
            </div>

            <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.12fr)_312px]">
              <div className="space-y-3">
                {!searchData && (
                  <EmptyState
                    title="先搜一遍素材"
                    description="建议先在当前项目里搜索，确认通义识别结果能否把镜头带出来，再决定要不要扩到全库。"
                  />
                )}
                {searchData?.results.length === 0 && (
                  <EmptyState
                    title="没有匹配结果"
                    description="可以换一个更具体的地点、人物或动作描述，或者切到混合搜索。"
                  />
                )}
                {searchData?.results.map(result => (
                  <SearchResultCard
                    key={`${result.id}:${result.source}`}
                    result={result}
                    active={focusedResult?.id === result.id}
                    activeProjectId={activeProject?.id || ''}
                    selectedVideo={selectedVideo}
                    onFocus={() => setFocusedResultId(result.id)}
                    onCueCurrent={() => cueCurrentVideo(result)}
                    onSwitchProject={() => cueResult(result, { switchProject: true })}
                  />
                ))}
              </div>

              <RecognitionFocusPanel
                result={focusedResult}
                project={focusedResult ? projectMap.get(focusedResult.project) || null : null}
                activeProjectId={activeProject?.id || ''}
                selectedVideo={selectedVideo}
                onCueCurrent={focusedResult ? () => cueCurrentVideo(focusedResult) : undefined}
                onSwitchProject={focusedResult ? () => cueResult(focusedResult, { switchProject: true }) : undefined}
              />
            </div>
          </section>

          {indexResult && (
            <section className="rounded-lg border border-border bg-card p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="font-semibold text-foreground">向量索引结果</h2>
                <span className={`rounded px-2 py-1 text-xs ${indexResult.ok ? 'bg-background text-muted-foreground' : 'bg-amber-500/10 text-amber-300'}`}>
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
        </>
      )}
    </div>
  )
}

function ProjectTabButton({
  project,
  active,
  onSelect,
}: {
  project: MaterialProject
  active: boolean
  onSelect: () => void
}) {
  const ratio = completionRatio(project.totals.visualDone, project.totals.scenes)

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`min-w-[160px] max-w-[188px] flex-none rounded-md border px-2.5 py-2 text-left transition-colors ${
        active
          ? 'border-primary/40 bg-primary/10'
          : 'border-border bg-background/20 hover:border-primary/20 hover:bg-background/40'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{project.name}</p>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            {project.totals.videos} 视频 · {project.totals.scenes} 场景
          </p>
        </div>
        <span className="rounded border border-border bg-background/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {ratio}%
        </span>
      </div>
    </button>
  )
}

function ProjectWorkbench({
  project,
  selectedVideo,
  selectedVideoPath,
  onSelectVideo,
  playerNotice,
  playerRef,
  focusedResult,
  onCueFocusedResult,
}: {
  project: MaterialProject
  selectedVideo: MaterialVideo | null
  selectedVideoPath: string
  onSelectVideo: (path: string) => void
  playerNotice: string | null
  playerRef: { current: HTMLVideoElement | null }
  focusedResult: SearchResult | null
  onCueFocusedResult?: () => void
}) {
  const focusedVideoMatch = focusedResult ? matchResultVideo(project, focusedResult) : null

  return (
    <section className="rounded-lg border border-border bg-card p-3.5 md:p-4">
      <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge subtle>{project.totals.videos} 条视频</Badge>
            <Badge subtle>{project.totals.scenes} 场景</Badge>
            <Badge subtle>{project.totals.visualDone} 通义完成</Badge>
          </div>
          <h2 className="mt-1 truncate text-lg font-semibold text-foreground">{project.name}</h2>
        </div>
        {focusedVideoMatch && focusedResult && (
          <Badge subtle>
            当前焦点命中 {videoDisplayTitle(focusedVideoMatch.name)} · {formatTimeRange(focusedResult.start, focusedResult.end)}
          </Badge>
        )}
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_304px]">
        <div className="space-y-3">
          <div className="overflow-hidden rounded-lg border border-border bg-background/25">
            <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-semibold text-foreground">
                  {selectedVideo ? videoDisplayTitle(selectedVideo.name) : '视频播放器'}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {selectedVideo ? `${formatBytes(selectedVideo.size)} · ${formatDate(selectedVideo.modifiedAt)}` : '从右侧视频列表切一个片源进来'}
                </p>
              </div>
              {selectedVideo && <Badge subtle>{videoEpisodeBadge(selectedVideo.name)}</Badge>}
            </div>

            {selectedVideo ? (
              <>
                <div className="aspect-video bg-black">
                  <video
                    ref={playerRef}
                    key={selectedVideoPath}
                    controls
                    preload="metadata"
                    playsInline
                    className="h-full w-full bg-black object-contain"
                    src={assetUrl(selectedVideo.path)}
                  />
                </div>
                <div className="space-y-2 px-3 py-2.5">
                  {focusedResult && (
                    <div className="rounded-md border border-border bg-card px-3 py-2">
                      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between">
                        <div className="min-w-0">
                          <p className="text-[11px] tracking-wide text-muted-foreground">当前搜索焦点</p>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <span className="truncate text-sm font-medium text-foreground">{resultTitle(focusedResult)}</span>
                            <span className="text-xs text-muted-foreground">{formatTimeRange(focusedResult.start, focusedResult.end)}</span>
                          </div>
                        </div>
                        {onCueFocusedResult && selectedVideo && focusedResult.start !== null && (
                          <Button size="xs" variant="outline" onClick={onCueFocusedResult}>
                            在当前视频试播
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                  {playerNotice && (
                    <div className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                      {playerNotice}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="px-4 py-12 text-sm text-muted-foreground">
                这个项目还没有可播放视频。
              </div>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-background/25">
          <div className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5">
            <div>
              <h3 className="text-sm font-semibold text-foreground">视频列表</h3>
            </div>
            <span className="text-xs text-muted-foreground">{project.videos.length}</span>
          </div>

          <div className="max-h-[720px] space-y-1.5 overflow-auto p-2.5">
            {project.videos.map(video => {
              const isSelected = selectedVideoPath === video.path
              const isFocusMatch = focusedVideoMatch?.path === video.path
              return (
                <VideoListItem
                  key={video.path}
                  video={video}
                  selected={isSelected}
                  focusResult={isFocusMatch ? focusedResult : null}
                  onSelect={() => onSelectVideo(video.path)}
                  onCueFocus={isSelected && isFocusMatch && onCueFocusedResult ? onCueFocusedResult : undefined}
                />
              )
            })}
            {project.videos.length === 0 && (
              <div className="rounded-md border border-border bg-card px-3 py-6 text-sm text-muted-foreground">
                暂无视频。
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-3.5 grid gap-3.5 xl:grid-cols-2">
        <details className="rounded-lg border border-border bg-background/25 p-4">
          <summary className="cursor-pointer list-none">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">识别进度</h3>
                <p className="mt-1 text-xs text-muted-foreground">放到下面，只在需要时展开。</p>
              </div>
              <span className="text-xs text-muted-foreground">{project.pipelines.length} 条</span>
            </div>
          </summary>
          <div className="mt-3 grid gap-2">
            {project.pipelines.map(pipeline => (
              <PipelineCard key={pipeline.path} pipeline={pipeline} />
            ))}
            {project.pipelines.length === 0 && (
              <div className="rounded-md border border-border bg-card px-3 py-6 text-center text-sm text-muted-foreground">
                暂无 pipeline 索引。
              </div>
            )}
          </div>
        </details>

        <details className="rounded-lg border border-border bg-background/25 p-4">
          <summary className="cursor-pointer list-none">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-foreground">学习笔记</h3>
                <p className="mt-1 text-xs text-muted-foreground">留作复盘，不抢素材挑选流程。</p>
              </div>
              <span className="text-xs text-muted-foreground">{project.notes.length}</span>
            </div>
          </summary>
          <div className="mt-3 max-h-64 space-y-2 overflow-auto">
            {project.notes.slice(0, 18).map(note => (
              <div key={note.path} className="rounded border border-border bg-card px-3 py-2">
                <p className="truncate text-xs font-medium text-foreground">{note.name}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">{formatDate(note.modifiedAt)}</p>
              </div>
            ))}
            {project.notes.length === 0 && <p className="text-xs text-muted-foreground">暂无笔记。</p>}
          </div>
        </details>
      </div>
    </section>
  )
}

function PipelineCard({ pipeline }: { pipeline: MaterialPipeline }) {
  const ratio = completionRatio(pipeline.visualDone, pipeline.sceneSegments)

  return (
    <div className="rounded-md border border-border bg-card px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-foreground">{pipeline.name}</div>
          <div className="mt-1 text-xs text-muted-foreground">
            {pipeline.sceneSegments} 场景 · 已完成 {pipeline.visualDone} · 待补 {pipeline.visualPending}
          </div>
        </div>
        <span className="text-xs text-muted-foreground">{ratio}%</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${ratio}%` }} />
      </div>
      <div className="mt-2 text-[11px] text-muted-foreground">{formatDate(pipeline.modifiedAt)}</div>
    </div>
  )
}

function VideoListItem({
  video,
  selected,
  focusResult,
  onSelect,
  onCueFocus,
}: {
  video: MaterialVideo
  selected: boolean
  focusResult: SearchResult | null
  onSelect: () => void
  onCueFocus?: () => void
}) {
  const previewFrame = focusResult?.previewFrames[0] || null
  const focusText = focusResult
    ? `${resultTitle(focusResult)} · ${formatTimeRange(focusResult.start, focusResult.end)}`
    : null

  return (
    <div
      className={`rounded-md border p-2 transition-colors ${
        selected
          ? 'border-primary/40 bg-primary/10'
          : 'border-border bg-card hover:border-primary/20 hover:bg-background/40'
      }`}
    >
      <div className="flex gap-2">
        <div className="relative w-[124px] flex-none overflow-hidden rounded-md border border-border bg-zinc-950">
          {previewFrame ? (
            <img
              src={assetUrl(previewFrame.path)}
              alt={`${video.name} 预览`}
              className="aspect-video h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="aspect-video bg-[linear-gradient(135deg,rgba(24,24,27,1),rgba(9,9,11,1))]">
              <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.12),transparent_42%)]" />
            </div>
          )}

          <div className="absolute left-1.5 top-1.5 rounded-md border border-white/15 bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white">
            {videoEpisodeBadge(video.name)}
          </div>
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-col gap-1.5">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">{videoDisplayTitle(video.name)}</div>
              <div className="mt-0.5 text-[11px] text-muted-foreground">
                {formatBytes(video.size)} · {formatDate(video.modifiedAt)}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {selected && <Badge>当前播放</Badge>}
              {focusResult && <Badge subtle>搜索焦点</Badge>}
              {focusResult?.start !== null && focusResult && (
                <Badge subtle>{formatTimeRange(focusResult.start, focusResult.end)}</Badge>
              )}
            </div>
          </div>

          {focusText && (
            <p className="mt-2 text-[11px] leading-5 text-muted-foreground">{focusText}</p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button size="xs" variant={selected ? 'secondary' : 'outline'} onClick={onSelect}>
              {selected ? '当前视频' : '切到这个视频'}
            </Button>
            {onCueFocus && (
              <Button size="xs" variant="outline" onClick={onCueFocus}>
                试播当前焦点
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function SearchResultCard({
  result,
  active,
  activeProjectId,
  selectedVideo,
  onFocus,
  onCueCurrent,
  onSwitchProject,
}: {
  result: SearchResult
  active: boolean
  activeProjectId: string
  selectedVideo: MaterialVideo | null
  onFocus: () => void
  onCueCurrent: () => void
  onSwitchProject: () => void
}) {
  const location = metadataText(result.metadata, 'location')
  const people = metadataList(result.metadata, 'people')
  const actions = metadataList(result.metadata, 'actions')

  return (
    <article
      className={`rounded-md border p-3.5 transition-colors ${
        active
          ? 'border-primary/35 bg-background/45'
          : 'border-border bg-background/20 hover:border-primary/20 hover:bg-background/30'
      }`}
    >
      <button type="button" onClick={onFocus} className="block w-full text-left">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge subtle>{sourceLabel(result.source)}</Badge>
          <span>{result.project}</span>
          <span>{formatTimeRange(result.start, result.end)}</span>
          <span>{result.pipeline}</span>
        </div>

        <div className="mt-2.5 flex flex-col gap-3 lg:flex-row">
          {result.previewFrames.length > 0 && (
            <div className="lg:w-[124px] lg:flex-none">
              {result.previewFrames.slice(0, 1).map(frame => (
                <div key={`${result.id}:${frame.path}:${frame.timeLabel || ''}`} className="overflow-hidden rounded-md border border-border bg-card">
                  <img
                    src={assetUrl(frame.path)}
                    alt={`${result.label} ${frame.timeLabel || ''}`}
                    className="aspect-video h-full w-full object-cover"
                    loading="lazy"
                  />
                </div>
              ))}
            </div>
          )}

          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-semibold text-foreground">{resultTitle(result)}</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{result.snippet || result.transcript || result.label}</p>
            <div className="mt-1.5 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
              <MetaLine label="地点" value={location || '未提取'} />
              <MetaLine label="人物" value={people.slice(0, 3).join(' / ') || '未提取'} />
              <MetaLine label="动作" value={actions.slice(0, 3).join(' / ') || '未提取'} />
              <MetaLine label="标签" value={result.tags.slice(0, 3).join(' / ') || '未提取'} />
            </div>
          </div>
        </div>
      </button>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {result.tags.slice(0, 3).map(tag => (
          <Badge key={`${result.id}:${tag}`} subtle>{tag}</Badge>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="xs" variant="outline" onClick={onFocus}>
          查看识别
        </Button>
        {activeProjectId === result.project && selectedVideo && result.start !== null ? (
          <Button size="xs" variant={active ? 'secondary' : 'outline'} onClick={onCueCurrent}>
            在当前视频试播
          </Button>
        ) : (
          <Button size="xs" variant={active ? 'secondary' : 'outline'} onClick={onSwitchProject}>
            切到该项目
          </Button>
        )}
      </div>
    </article>
  )
}

function RecognitionFocusPanel({
  result,
  project,
  activeProjectId,
  selectedVideo,
  onCueCurrent,
  onSwitchProject,
}: {
  result: SearchResult | null
  project: MaterialProject | null
  activeProjectId: string
  selectedVideo: MaterialVideo | null
  onCueCurrent?: () => void
  onSwitchProject?: () => void
}) {
  if (!result) {
    return (
      <section className="rounded-lg border border-border bg-background/25 p-4">
        <h3 className="text-sm font-semibold text-foreground">通义识别焦点</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          先执行一次搜索，再从结果里选一个场景，这里会展开通义识别摘要、地点、人物、动作和字幕。
        </p>
      </section>
    )
  }

  const location = metadataText(result.metadata, 'location')
  const people = metadataList(result.metadata, 'people')
  const actions = metadataList(result.metadata, 'actions')
  const objects = metadataList(result.metadata, 'objects')
  const ocr = metadataList(result.metadata, 'ocr')
  const materialValue = metadataList(result.metadata, 'material_value')
  const emotion = metadataList(result.metadata, 'emotion')

  return (
    <section className="rounded-lg border border-border bg-background/25 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">通义识别焦点</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {result.project} · {result.pipeline} · {formatTimeRange(result.start, result.end)}
          </p>
        </div>
        <Badge subtle>{result.tags.slice(0, 2).join(' / ') || '焦点详情'}</Badge>
      </div>

      {result.previewFrames.length > 0 && (
        <div className="mt-4 grid grid-cols-2 gap-2">
          {result.previewFrames.slice(0, 4).map(frame => (
            <div key={`${result.id}:${frame.path}:${frame.timeLabel || ''}`} className="overflow-hidden rounded-md border border-border bg-card">
              <img
                src={assetUrl(frame.path)}
                alt={`${result.label} ${frame.timeLabel || ''}`}
                className="aspect-video h-full w-full object-cover"
                loading="lazy"
              />
            </div>
          ))}
        </div>
      )}

      <div className="mt-4 space-y-3">
        <FocusField label="通义摘要" value={resultTitle(result)} />
        <FocusField label="场景标签" value={result.tags.join(' / ') || '未提取'} />
        <FocusField label="地点 / 人物 / 动作" value={[location, people.join(' / '), actions.join(' / ')].filter(Boolean).join(' | ') || '未提取'} />
        <FocusField label="OCR / 字幕" value={ocr.join(' / ') || result.transcript || '未提取'} />
        <FocusField label="物体 / 素材价值 / 情绪" value={[objects.join(' / '), materialValue.join(' / '), emotion.join(' / ')].filter(Boolean).join(' | ') || '未提取'} />
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {activeProjectId === result.project && selectedVideo && result.start !== null ? (
          <Button size="xs" onClick={onCueCurrent}>
            在当前视频试播
          </Button>
        ) : (
          <Button size="xs" variant="secondary" onClick={onSwitchProject}>
            切到该项目
          </Button>
        )}
        {project && <Badge subtle>{project.totals.videos} 个视频可选</Badge>}
      </div>
    </section>
  )
}

function FocusField({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-3 py-2.5">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm leading-6 text-foreground">{value}</div>
    </div>
  )
}

function MetaLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="text-muted-foreground">{label}：</span>
      <span className="text-foreground/90">{value}</span>
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
          ? 'border-primary/40 bg-primary/10 text-primary'
          : 'border-border bg-background text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}

function Badge({ children, subtle = false }: { children: ReactNode; subtle?: boolean }) {
  return (
    <span className={`rounded-md border px-2 py-1 text-xs ${subtle ? 'border-border bg-background/50 text-muted-foreground' : 'border-border bg-background text-muted-foreground'}`}>
      {children}
    </span>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/25 px-4 py-8">
      <div className="text-sm font-medium text-foreground">{title}</div>
      <div className="mt-2 text-sm leading-6 text-muted-foreground">{description}</div>
    </div>
  )
}
