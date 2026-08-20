'use client'

import type { ReactNode } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

type ResultStatus = 'all' | 'queued' | 'accepted' | 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface AnalysisMaterialVideo {
  projectId: string
  projectName: string
  name: string
  path: string
}

interface VideoResultListItem {
  taskId: string
  title: string
  status: string
  source: string
  createdAt: number
  completedAt: number | null
  updatedAt: number
  batchId: string | null
  batchIndex: number | null
  summary: string | null
  chapterCount: number
  timelineCount: number
  resultAvailable: boolean
}

interface VideoResultChapter {
  index: number
  startTime: string | null
  endTime: string | null
  startSeconds: number | null
  endSeconds: number | null
  summary: string | null
}

interface VideoResultTimelineItem {
  index: number
  timeRange: string | null
  startSeconds: number | null
  endSeconds: number | null
  transcript: string | null
  visualAnalysis: string | null
}

interface VideoResultDetail extends VideoResultListItem {
  chapters: VideoResultChapter[]
  timeline: VideoResultTimelineItem[]
  transcript: string | null
  visualAnalysis: string | null
  fullReport: string | null
  mediaAvailable: boolean
}

interface VideoResultListResponse {
  results: VideoResultListItem[]
  total: number
  limit: number
  offset: number
}

interface VideoSearchHit {
  id: string
  taskId: string
  title: string
  status: string
  completedAt: number | null
  kind: 'timeline' | 'chapter' | 'title' | 'summary' | 'transcript' | 'visual' | 'report'
  label: string
  snippet: string
  matchedFields: string[]
  timeRange: string | null
  startSeconds: number | null
  endSeconds: number | null
  mediaAvailable: boolean
}

interface VideoSearchResponse {
  query: string
  hits: VideoSearchHit[]
  total: number
  videoCount: number
  segmentCount: number
  playableVideos: number
  truncated: boolean
  error?: string
}

const PAGE_SIZE = 24
const SEARCH_PAGE_SIZE = 16
const SEARCH_SNIPPET_LENGTH = 280
const SUMMARY_PREVIEW_LENGTH = 900

function formatDate(value: number | null | undefined): string {
  if (!value) return '未记录'
  const milliseconds = value > 10_000_000_000 ? value : value * 1_000
  const date = new Date(milliseconds)
  if (Number.isNaN(date.getTime())) return '未记录'
  return date.toLocaleString('zh-CN', { hour12: false })
}

function formatClock(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(rounded / 3_600)
  const minutes = Math.floor((rounded % 3_600) / 60)
  const remainder = rounded % 60
  return hours > 0
    ? [hours, minutes, remainder].map(value => String(value).padStart(2, '0')).join(':')
    : [minutes, remainder].map(value => String(value).padStart(2, '0')).join(':')
}

function statusLabel(status: string): string {
  return ({
    queued: '排队中',
    accepted: '已受理',
    running: '分析中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
  } as Record<string, string>)[status] || status
}

function statusClass(status: string): string {
  if (status === 'succeeded') return 'border-success/25 bg-success/10 text-success'
  if (status === 'failed' || status === 'cancelled') return 'border-destructive/25 bg-destructive/10 text-destructive'
  if (status === 'queued' || status === 'accepted' || status === 'running') {
    return 'border-primary/25 bg-primary/10 text-primary'
  }
  return 'border-border bg-background text-muted-foreground'
}

function normalizedVideoName(value: string): string {
  return value
    .replace(/\.[^.]+$/, '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function assetUrl(path: string): string {
  return `/api/materials/asset?path=${encodeURIComponent(path)}`
}

function seekVideo(video: HTMLVideoElement, seconds: number) {
  const apply = () => {
    const maximum = Number.isFinite(video.duration) && video.duration > 0
      ? Math.max(0, video.duration - 0.25)
      : seconds
    video.currentTime = Math.max(0, Math.min(seconds, maximum))
    void video.play().catch(() => undefined)
  }
  if (video.readyState >= 1) apply()
  else {
    video.addEventListener('loadedmetadata', apply, { once: true })
    video.preload = 'metadata'
    video.load()
  }
}

export function VideoAnalysisResultsPanel({
  videos,
}: {
  videos: AnalysisMaterialVideo[]
}) {
  const [results, setResults] = useState<VideoResultListItem[]>([])
  const [total, setTotal] = useState(0)
  const [offset, setOffset] = useState(0)
  const [status, setStatus] = useState<ResultStatus>('all')
  const [searchInput, setSearchInput] = useState('')
  const [query, setQuery] = useState('')
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null)
  const [detail, setDetail] = useState<VideoResultDetail | null>(null)
  const [searchResult, setSearchResult] = useState<VideoSearchResponse | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [searchLoading, setSearchLoading] = useState(false)
  const [visibleSearchHits, setVisibleSearchHits] = useState(SEARCH_PAGE_SIZE)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playerError, setPlayerError] = useState<string | null>(null)
  const [pendingSeek, setPendingSeek] = useState<{ taskId: string; seconds: number } | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const playerRef = useRef<HTMLVideoElement | null>(null)

  const loadResults = useCallback(async (signal?: AbortSignal) => {
    setListLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({
        view: 'video-results',
        limit: String(PAGE_SIZE),
        offset: String(offset),
      })
      if (status !== 'all') params.set('status', status)
      if (query) params.set('query', query)
      const response = await fetch(`/api/n8n/runs?${params.toString()}`, {
        cache: 'no-store',
        signal,
      })
      const payload = await response.json().catch(() => ({})) as Partial<VideoResultListResponse> & { error?: string }
      if (!response.ok) throw new Error(payload.error || '无法加载视频分析结果')
      const nextResults = Array.isArray(payload.results) ? payload.results : []
      setResults(nextResults)
      setTotal(Number(payload.total) || 0)
      setSelectedTaskId(current => (
        current && nextResults.some(item => item.taskId === current)
          ? current
          : nextResults[0]?.taskId || null
      ))
    } catch (loadError) {
      if ((loadError as Error).name === 'AbortError') return
      setResults([])
      setTotal(0)
      setSelectedTaskId(null)
      setError(loadError instanceof Error ? loadError.message : '无法加载视频分析结果')
    } finally {
      if (!signal?.aborted) setListLoading(false)
    }
  }, [offset, query, status])

  useEffect(() => {
    const controller = new AbortController()
    void loadResults(controller.signal)
    return () => controller.abort()
  }, [loadResults, refreshKey])

  useEffect(() => {
    if (!query) {
      setSearchResult(null)
      setSearchLoading(false)
      return undefined
    }
    const controller = new AbortController()
    setSearchLoading(true)
    setError(null)
    const params = new URLSearchParams({ q: query, limit: '120' })
    void fetch(`/api/n8n/video-library?${params.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async response => {
      const payload = await response.json().catch(() => ({})) as VideoSearchResponse
      if (!response.ok) throw new Error(payload.error || '无法检索学习内容')
      setSearchResult(payload)
      setSelectedTaskId(current => (
        current && payload.hits.some(hit => hit.taskId === current)
          ? current
          : payload.hits[0]?.taskId || current
      ))
    }).catch(searchError => {
      if ((searchError as Error).name === 'AbortError') return
      setSearchResult(null)
      setError(searchError instanceof Error ? searchError.message : '无法检索学习内容')
    }).finally(() => {
      if (!controller.signal.aborted) setSearchLoading(false)
    })
    return () => controller.abort()
  }, [query, refreshKey])

  useEffect(() => {
    if (!selectedTaskId) {
      setDetail(null)
      return undefined
    }
    const controller = new AbortController()
    setDetailLoading(true)
    setError(null)
    const params = new URLSearchParams({ view: 'video-results', taskId: selectedTaskId })
    void fetch(`/api/n8n/runs?${params.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    }).then(async response => {
      const payload = await response.json().catch(() => ({})) as { result?: VideoResultDetail; error?: string }
      if (!response.ok || !payload.result) throw new Error(payload.error || '无法加载视频分析明细')
      setDetail(payload.result)
      setPlayerError(null)
    }).catch(detailError => {
      if ((detailError as Error).name === 'AbortError') return
      setDetail(null)
      setError(detailError instanceof Error ? detailError.message : '无法加载视频分析明细')
    }).finally(() => {
      if (!controller.signal.aborted) setDetailLoading(false)
    })
    return () => controller.abort()
  }, [selectedTaskId, refreshKey])

  const matchedVideo = useMemo(() => {
    if (!detail) return null
    const target = normalizedVideoName(detail.title)
    const matches = videos.filter(video => normalizedVideoName(video.name) === target)
    return matches.length === 1 ? matches[0] : null
  }, [detail, videos])

  const playableSource = useMemo(() => {
    if (!detail) return null
    if (detail.mediaAvailable) {
      return {
        url: `/api/n8n/video-library/asset?taskId=${encodeURIComponent(detail.taskId)}`,
        label: `任务原片 · ${detail.title}`,
      }
    }
    if (matchedVideo) {
      return {
        url: assetUrl(matchedVideo.path),
        label: `${matchedVideo.projectName} · ${matchedVideo.name}`,
      }
    }
    return null
  }, [detail, matchedVideo])

  const applySearch = () => {
    setOffset(0)
    setVisibleSearchHits(SEARCH_PAGE_SIZE)
    setPendingSeek(null)
    setQuery(searchInput.trim())
  }

  const openSearchHit = (hit: VideoSearchHit) => {
    setSelectedTaskId(hit.taskId)
    setPendingSeek(hit.startSeconds === null ? null : { taskId: hit.taskId, seconds: hit.startSeconds })
  }

  const playPendingSeek = () => {
    if (!detail || !pendingSeek || pendingSeek.taskId !== detail.taskId || !playerRef.current) return
    seekVideo(playerRef.current, pendingSeek.seconds)
    setPendingSeek(null)
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1

  return (
    <div className="space-y-4">
      <section className="rounded-lg border border-border bg-card p-3.5 md:p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <h2 className="text-base font-semibold text-foreground">学习内容库</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              检索标题、章节、逐段语音、画面证据和完整报告，并直接定位原片时间点。
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              value={searchInput}
              onChange={event => setSearchInput(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') applySearch() }}
              placeholder="搜索人物、地点、对白、画面或主题"
              className="h-9 min-w-0 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/60 focus:border-primary/40 sm:w-80"
            />
            <select
              value={status}
              onChange={event => {
                setStatus(event.target.value as ResultStatus)
                setOffset(0)
              }}
              className="h-9 rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary/40"
              aria-label="分析状态"
            >
              <option value="all">全部状态</option>
              <option value="succeeded">已完成</option>
              <option value="running">分析中</option>
              <option value="queued">排队中</option>
              <option value="failed">失败</option>
              <option value="cancelled">已取消</option>
            </select>
            <Button size="sm" onClick={applySearch}>检索内容</Button>
            <Button variant="outline" size="sm" onClick={() => setRefreshKey(value => value + 1)}>
              刷新
            </Button>
          </div>
        </div>
        {query && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
            <span className="rounded border border-border bg-background px-2 py-1">关键词：{query}</span>
            {searchResult && (
              <>
                <span>{searchResult.videoCount} 部视频</span>
                <span>{searchResult.segmentCount} 个可定位片段</span>
                <span>{searchResult.total} 条内容命中</span>
                <span>{searchResult.playableVideos} 部原片可播放</span>
                {searchResult.truncated && <span>已显示最相关结果</span>}
              </>
            )}
          </div>
        )}
      </section>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <section className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-3.5 py-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground">{query ? '内容命中' : '视频学习档案'}</h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {query ? `覆盖 ${searchResult?.videoCount || 0} 部视频` : `共 ${total} 条`}
              </p>
            </div>
            <span className="text-[11px] text-muted-foreground">
              {query
                ? `${Math.min(visibleSearchHits, searchResult?.hits.length || 0)}/${searchResult?.total || 0}`
                : `${currentPage}/${totalPages} 页`}
            </span>
          </div>
          <div className="max-h-[760px] space-y-2 overflow-y-auto p-2.5">
            {query ? (
              <>
                {searchLoading && !searchResult && (
                  <EmptyState title="正在检索" description="正在查找章节、语音、画面和报告内容。" />
                )}
                {!searchLoading && searchResult?.hits.length === 0 && (
                  <EmptyState title="没有命中内容" description="可以换一个人物、地点、动作、对白或主题关键词。" />
                )}
                {searchResult?.hits.slice(0, visibleSearchHits).map(hit => (
                  <VideoSearchHitCard
                    key={hit.id}
                    hit={hit}
                    active={hit.taskId === selectedTaskId}
                    onOpen={() => openSearchHit(hit)}
                  />
                ))}
              </>
            ) : (
              <>
                {listLoading && results.length === 0 && (
                  <EmptyState title="正在加载" description="正在读取视频学习档案。" />
                )}
                {!listLoading && results.length === 0 && (
                  <EmptyState title="暂无结果" description="当前条件下没有视频学习记录。" />
                )}
                {results.map(item => (
              <button
                type="button"
                key={item.taskId}
                onClick={() => {
                  setPendingSeek(null)
                  setSelectedTaskId(item.taskId)
                }}
                aria-label={`打开 ${item.title} 的学习档案`}
                className={`w-full rounded-md border p-3 text-left transition-colors ${
                  item.taskId === selectedTaskId
                    ? 'border-primary/40 bg-primary/10'
                    : 'border-border bg-background/20 hover:border-primary/20 hover:bg-background/50'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium text-foreground">{item.title}</p>
                  <StatusBadge status={item.status} />
                </div>
                <p className="mt-2 line-clamp-2 text-xs leading-5 text-muted-foreground">
                  {item.summary || (item.resultAvailable ? '结果已保存，点击查看明细。' : '尚未生成正式结果。')}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground/80">
                  <span>{formatDate(item.completedAt || item.updatedAt)}</span>
                  <span>{item.chapterCount} 章</span>
                  <span>{item.timelineCount} 段证据</span>
                </div>
              </button>
                ))}
              </>
            )}
          </div>
          <div className="flex items-center justify-between border-t border-border p-2.5">
            {query ? (
              <div className="flex w-full flex-col items-center gap-2">
                <p className="text-center text-[11px] text-muted-foreground">
                  点击命中内容可打开学习档案；带时间码且原片可用时可确认后从该处播放。
                </p>
                <div className="flex items-center gap-2">
                  {visibleSearchHits > SEARCH_PAGE_SIZE && (
                    <Button variant="outline" size="sm" onClick={() => setVisibleSearchHits(SEARCH_PAGE_SIZE)}>
                      收起结果
                    </Button>
                  )}
                  {Boolean(searchResult && visibleSearchHits < searchResult.hits.length) && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setVisibleSearchHits(value => value + SEARCH_PAGE_SIZE)}
                    >
                      显示更多
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <>
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0 || listLoading}
              onClick={() => setOffset(value => Math.max(0, value - PAGE_SIZE))}
            >
              上一页
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={offset + PAGE_SIZE >= total || listLoading}
              onClick={() => setOffset(value => value + PAGE_SIZE)}
            >
              下一页
            </Button>
              </>
            )}
          </div>
        </section>

        <section className="min-h-[560px] rounded-lg border border-border bg-card p-3.5 md:p-4">
          {detailLoading && !detail ? (
            <EmptyState title="正在加载明细" description="正在整理章节与音画证据。" />
          ) : !detail ? (
            <EmptyState title="请选择视频" description="从左侧选择一条正式分析记录。" />
          ) : (
            <div className="space-y-5">
              <header className="border-b border-border pb-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={detail.status} />
                      {detail.batchId && (
                        <span className="rounded border border-border bg-background px-2 py-1 text-[10px] text-muted-foreground">
                          批次第 {detail.batchIndex || '-'} 项
                        </span>
                      )}
                      <span className="rounded border border-border bg-background px-2 py-1 text-[10px] text-muted-foreground">
                        {playableSource ? '原片可播放' : '仅学习档案'}
                      </span>
                    </div>
                    <h2 className="mt-2 break-words text-xl font-semibold text-foreground">{detail.title}</h2>
                    <p className="mt-1 break-all text-[11px] text-muted-foreground">任务编号：{detail.taskId}</p>
                  </div>
                  <div className="text-xs text-muted-foreground md:text-right">
                    <p>完成：{formatDate(detail.completedAt)}</p>
                    <p className="mt-1">更新：{formatDate(detail.updatedAt)}</p>
                  </div>
                </div>
              </header>

              {playableSource ? (
                <div className="overflow-hidden rounded-lg border border-border bg-black">
                  <video
                    ref={playerRef}
                    key={`${detail.taskId}:${playableSource.url}`}
                    controls
                    preload="none"
                    className="aspect-video w-full bg-black object-contain"
                    src={playableSource.url}
                    onError={() => setPlayerError('原片暂时无法加载，学习内容仍可继续查看。')}
                  />
                  {pendingSeek?.taskId === detail.taskId && (
                    <div className="flex flex-col gap-2 border-t border-primary/20 bg-primary/10 px-3 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-foreground/80">
                        已定位命中片段 {formatClock(pendingSeek.seconds)}，确认后再读取原片。
                      </span>
                      <button
                        type="button"
                        onClick={playPendingSeek}
                        className="flex-none font-medium text-primary hover:underline"
                      >
                        从 {formatClock(pendingSeek.seconds)} 播放
                      </button>
                    </div>
                  )}
                  <div className="border-t border-white/10 bg-background px-3 py-2 text-[11px] text-muted-foreground">
                    {playableSource.label}
                  </div>
                  {playerError && <div className="border-t border-destructive/20 bg-destructive/10 px-3 py-2 text-xs text-destructive">{playerError}</div>}
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-border bg-background/30 px-4 py-5 text-sm text-muted-foreground">
                  原片当前不在可播放索引中；章节、时间线、语音、画面证据与完整报告仍可检索和查看。
                </div>
              )}

              <ResultSection title="分析摘要" count={detail.summary ? 1 : 0}>
                <ExpandableText
                  key={`${detail.taskId}:summary`}
                  text={detail.summary}
                  emptyText="该任务尚未生成摘要。"
                  previewLength={SUMMARY_PREVIEW_LENGTH}
                />
              </ResultSection>

              <DeferredResultSection
                key={`${detail.taskId}:chapters`}
                title="章节结构"
                count={detail.chapters.length}
                description="按章节查看叙事结构和对应原片时间段"
              >
                {detail.chapters.length ? (
                  <div className="space-y-2.5">
                    {detail.chapters.map(chapter => (
                      <article key={`${chapter.index}:${chapter.startTime}`} className="rounded-md border border-border bg-background/30 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <h4 className="text-sm font-medium text-foreground">第 {chapter.index} 章</h4>
                          <div className="flex items-center gap-2">
                            <span className="text-[11px] text-muted-foreground">
                              {chapter.startTime || '--:--'} — {chapter.endTime || '--:--'}
                            </span>
                            {playableSource && chapter.startSeconds !== null && (
                              <button
                                type="button"
                                onClick={() => playerRef.current && seekVideo(playerRef.current, chapter.startSeconds!)}
                                className="text-xs text-primary hover:underline"
                              >
                                播放本章
                              </button>
                            )}
                          </div>
                        </div>
                        <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">
                          {chapter.summary || '该章节未生成可展示的正式总结，请查看对应时间线的音画证据。'}
                        </p>
                      </article>
                    ))}
                  </div>
                ) : <InlineEmpty text="没有结构化章节。" />}
              </DeferredResultSection>

              <DeferredResultSection
                key={`${detail.taskId}:timeline`}
                title="逐段时间线与音画证据"
                count={detail.timeline.length}
                description="展开后查看逐段语音、画面证据并定位原片"
              >
                {detail.timeline.length ? (
                  <div className="space-y-2.5">
                    {detail.timeline.map(segment => (
                      <article key={`${segment.index}:${segment.timeRange}`} className="rounded-md border border-border bg-background/30 p-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-medium text-foreground">
                            {segment.timeRange || `片段 ${segment.index}`}
                          </span>
                          {playableSource && segment.startSeconds !== null && (
                            <button
                              type="button"
                              onClick={() => playerRef.current && seekVideo(playerRef.current, segment.startSeconds!)}
                              className="text-xs text-primary hover:underline"
                            >
                              在播放器定位
                            </button>
                          )}
                        </div>
                        <div className="mt-2 grid gap-2 lg:grid-cols-2">
                          <EvidenceBlock label="语音" text={segment.transcript} />
                          <EvidenceBlock label="画面" text={segment.visualAnalysis} />
                        </div>
                      </article>
                    ))}
                  </div>
                ) : <InlineEmpty text="没有逐段时间线。" />}
              </DeferredResultSection>

              <DeferredResultSection
                key={`${detail.taskId}:evidence`}
                title="完整音画材料"
                count={Number(Boolean(detail.transcript)) + Number(Boolean(detail.visualAnalysis))}
                description="按需读取完整语音转写和画面分析"
              >
                <div className="grid gap-3 lg:grid-cols-2">
                  <LongEvidence title="完整语音转写" text={detail.transcript} />
                  <LongEvidence title="完整画面分析" text={detail.visualAnalysis} />
                </div>
              </DeferredResultSection>

              <DeferredResultSection
                key={`${detail.taskId}:report`}
                title="完整分析报告"
                count={detail.fullReport ? 1 : 0}
                description="按需展开模型生成的正式分析报告"
              >
                {detail.fullReport ? (
                  <pre className="max-h-[640px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background/40 p-3 font-sans text-sm leading-7 text-foreground/90">
                    {detail.fullReport}
                  </pre>
                ) : <InlineEmpty text="没有可读取的完整报告。" />}
              </DeferredResultSection>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`flex-none rounded border px-2 py-1 text-[10px] font-medium ${statusClass(status)}`}>
      {statusLabel(status)}
    </span>
  )
}

function VideoSearchHitCard({
  hit,
  active,
  onOpen,
}: {
  hit: VideoSearchHit
  active: boolean
  onOpen: () => void
}) {
  const canSeek = hit.startSeconds !== null
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`打开 ${hit.title} 的${hit.label}${canSeek && hit.mediaAvailable ? '并定位原片' : ''}`}
      className={`w-full rounded-md border p-3 text-left transition-colors ${
        active
          ? 'border-primary/40 bg-primary/10'
          : 'border-border bg-background/20 hover:border-primary/20 hover:bg-background/50'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="min-w-0 truncate text-sm font-medium text-foreground" title={hit.title}>{hit.title}</p>
        <StatusBadge status={hit.status} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="rounded border border-border bg-card px-1.5 py-0.5">{hit.label}</span>
        {hit.timeRange && <span>{hit.timeRange}</span>}
        {hit.matchedFields.length > 0 && <span>命中：{hit.matchedFields.join('、')}</span>}
      </div>
      <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs leading-5 text-foreground/80">
        {hit.snippet
          ? hit.snippet.length > SEARCH_SNIPPET_LENGTH
            ? `${hit.snippet.slice(0, SEARCH_SNIPPET_LENGTH).trimEnd()}…`
            : hit.snippet
          : '打开学习档案查看完整内容。'}
      </p>
      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{formatDate(hit.completedAt)}</span>
        <span className={canSeek && hit.mediaAvailable ? 'text-primary' : undefined}>
          {canSeek
            ? hit.mediaAvailable ? '定位片段' : '原片当前不可用'
            : '查看档案'}
        </span>
      </div>
    </button>
  )
}

function ResultSection({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: ReactNode
}) {
  return (
    <section>
      <div className="mb-2.5 flex items-center gap-2">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        <span className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {count}
        </span>
      </div>
      {children}
    </section>
  )
}

function DeferredResultSection({
  title,
  count,
  description,
  children,
}: {
  title: string
  count: number
  description: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <section className="rounded-lg border border-border bg-background/20">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        className="flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left hover:bg-background/40"
      >
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground">{title}</span>
            <span className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {count}
            </span>
          </span>
          <span className="mt-1 block text-[11px] text-muted-foreground">{description}</span>
        </span>
        <span className="flex-none text-xs font-medium text-primary">{open ? '收起' : '展开'}</span>
      </button>
      {open && <div className="border-t border-border p-3.5">{children}</div>}
    </section>
  )
}

function ExpandableText({
  text,
  emptyText,
  previewLength,
}: {
  text: string | null
  emptyText: string
  previewLength: number
}) {
  const [expanded, setExpanded] = useState(false)
  if (!text) return <p className="text-sm leading-7 text-muted-foreground">{emptyText}</p>
  const truncated = text.length > previewLength
  const visibleText = truncated && !expanded ? `${text.slice(0, previewLength).trimEnd()}…` : text
  return (
    <div>
      <p className="whitespace-pre-wrap text-sm leading-7 text-foreground/90">{visibleText}</p>
      {truncated && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded(value => !value)}
          className="mt-2 text-xs font-medium text-primary hover:underline"
        >
          {expanded ? '收起摘要' : '展开完整摘要'}
        </button>
      )}
    </div>
  )
}

function EvidenceBlock({ label, text }: { label: string; text: string | null }) {
  return (
    <div className="rounded border border-border/70 bg-card px-3 py-2.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1.5 whitespace-pre-wrap text-xs leading-5 text-foreground/80">{text || '无可用证据'}</p>
    </div>
  )
}

function LongEvidence({ title, text }: { title: string; text: string | null }) {
  return (
    <details className="rounded-md border border-border bg-background/30" open={Boolean(text && text.length < 2_000)}>
      <summary className="cursor-pointer px-3 py-2.5 text-sm font-medium text-foreground">{title}</summary>
      <div className="max-h-96 overflow-auto border-t border-border px-3 py-3">
        <p className="whitespace-pre-wrap text-xs leading-6 text-muted-foreground">{text || '无可用内容'}</p>
      </div>
    </details>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-md border border-dashed border-border px-4 py-10 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  )
}

function InlineEmpty({ text }: { text: string }) {
  return <p className="rounded-md border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">{text}</p>
}
