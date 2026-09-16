'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Button } from '@/components/ui/button'
import {
  buildMaterialGraphLayout,
  type MaterialGraphDimension,
  type MaterialGraphEvidence,
  type MaterialGraphMaterial,
  type MaterialGraphSnapshot,
} from '@/lib/material-graph'

interface MaterialGraphPanelProps {
  projectId?: string
  onOpenMaterial: (material: MaterialGraphMaterial, evidence?: MaterialGraphEvidence) => void
}

type GraphScope = 'project' | 'all'

const GRAPH_WIDTH = 1000
const GRAPH_HEIGHT = 700
const MAX_VISIBLE_LABELS = 8
const MIN_ZOOM = 0.65
const MAX_ZOOM = 2
const EMPTY_MATERIALS: MaterialGraphMaterial[] = []

function dimensionLabel(dimension: MaterialGraphDimension): string {
  return dimension === 'scene' ? '场景' : '情绪'
}

function formatTime(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '--:--'
  const safe = Math.round(Math.max(0, seconds) * 10) / 10
  const wholeSeconds = Math.floor(safe)
  const hours = Math.floor(wholeSeconds / 3600)
  const minutes = Math.floor((wholeSeconds % 3600) / 60)
  const remainder = wholeSeconds % 60
  const fraction = Math.round((safe - wholeSeconds) * 10)
  const suffix = fraction > 0 ? `.${fraction}` : ''
  const base = `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}${suffix}`
  return hours > 0 ? `${String(hours).padStart(2, '0')}:${base}` : base
}

function formatTimeRange(evidence: MaterialGraphEvidence): string {
  if (evidence.start === null && evidence.end === null) return '未记录时间码'
  if (evidence.end === null) return `${formatTime(evidence.start)} 起`
  return `${formatTime(evidence.start)}–${formatTime(evidence.end)}`
}

function matchesQuery(material: MaterialGraphMaterial, query: string): boolean {
  if (!query) return true
  const haystack = [
    material.name,
    material.path,
    material.project,
    ...material.labels.scene,
    ...material.labels.emotion,
    ...material.evidence.flatMap(evidence => [evidence.pipeline, evidence.summary]),
  ].join(' ').toLocaleLowerCase('zh-CN')
  return haystack.includes(query.toLocaleLowerCase('zh-CN'))
}

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value))
}

export function MaterialGraphPanel({ projectId, onOpenMaterial }: MaterialGraphPanelProps) {
  const [scope, setScope] = useState<GraphScope>('project')
  const [dimension, setDimension] = useState<MaterialGraphDimension>('scene')
  const [snapshot, setSnapshot] = useState<MaterialGraphSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [highlightedLabel, setHighlightedLabel] = useState<string | null>(null)
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(null)
  const [selectedEvidenceId, setSelectedEvidenceId] = useState<string | null>(null)
  const [hoveredMaterialId, setHoveredMaterialId] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const requestGenerationRef = useRef(0)
  const abortRef = useRef<AbortController | null>(null)
  const dragRef = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null)

  const effectiveScope: GraphScope = scope === 'project' && projectId ? 'project' : 'all'

  const loadGraph = useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const generation = ++requestGenerationRef.current

    setLoading(true)
    setError(null)
    const url = effectiveScope === 'project'
      ? `/api/materials/graph?project=${encodeURIComponent(projectId || '')}`
      : '/api/materials/graph'

    try {
      const response = await fetch(url, { cache: 'no-store', signal: controller.signal })
      const data = await response.json().catch(() => ({})) as Partial<MaterialGraphSnapshot> & { error?: string }
      if (!response.ok) throw new Error(data.error || '无法加载素材关系图谱')
      if (!Array.isArray(data.materials) || !data.stats) throw new Error('素材关系图谱返回了无效数据')
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return
      setSnapshot(data as MaterialGraphSnapshot)
    } catch (loadError) {
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return
      setSnapshot(null)
      setError(loadError instanceof Error ? loadError.message : '无法加载素材关系图谱')
    } finally {
      if (!controller.signal.aborted && generation === requestGenerationRef.current) setLoading(false)
    }
  }, [effectiveScope, projectId])

  useEffect(() => {
    setSnapshot(null)
    setQuery('')
    setHighlightedLabel(null)
    setSelectedMaterialId(null)
    setSelectedEvidenceId(null)
    setHoveredMaterialId(null)
    setPan({ x: 0, y: 0 })
    setZoom(1)
    void loadGraph()
    return () => {
      requestGenerationRef.current += 1
      abortRef.current?.abort()
    }
  }, [loadGraph])

  const materials = useMemo(() => snapshot
    ? Array.from(new Map(snapshot.materials.map(material => [material.id, material])).values())
    : EMPTY_MATERIALS,
  [snapshot])
  const stats = snapshot?.stats
  const layout = useMemo(() => buildMaterialGraphLayout(materials, dimension), [dimension, materials])
  const nodePositions = useMemo(
    () => new Map(layout.nodes.map(node => [node.id, node])),
    [layout.nodes],
  )
  const normalizedQuery = query.trim()
  const visibleMaterials = useMemo(
    () => materials.filter(material => matchesQuery(material, normalizedQuery)),
    [materials, normalizedQuery],
  )
  const visibleIds = useMemo(() => new Set(visibleMaterials.map(material => material.id)), [visibleMaterials])
  const visibleEdges = useMemo(
    () => layout.edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
    [layout.edges, visibleIds],
  )
  const materialMap = useMemo(
    () => new Map(materials.map(material => [material.id, material])),
    [materials],
  )

  const labels = useMemo(() => {
    const counts = new Map<string, number>()
    for (const material of materials) {
      for (const label of new Set(material.labels[dimension])) {
        counts.set(label, (counts.get(label) || 0) + 1)
      }
    }
    return Array.from(counts, ([label, count]) => ({ label, count }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label, 'zh-CN'))
  }, [dimension, materials])
  const visibleLabels = labels.slice(0, MAX_VISIBLE_LABELS)
  const hiddenLabelCount = Math.max(0, labels.length - visibleLabels.length)

  useEffect(() => {
    setHighlightedLabel(null)
  }, [dimension])

  useEffect(() => {
    if (selectedMaterialId && !visibleIds.has(selectedMaterialId)) {
      setSelectedMaterialId(null)
      setSelectedEvidenceId(null)
    }
  }, [selectedMaterialId, visibleIds])

  const focusId = hoveredMaterialId || selectedMaterialId
  const relatedIds = useMemo(() => {
    if (!focusId) return new Set<string>()
    const related = new Set([focusId])
    for (const edge of visibleEdges) {
      if (edge.source === focusId) related.add(edge.target)
      if (edge.target === focusId) related.add(edge.source)
    }
    return related
  }, [focusId, visibleEdges])

  const selectedMaterial = selectedMaterialId ? materialMap.get(selectedMaterialId) || null : null
  const selectedEvidence = selectedMaterial
    ? selectedMaterial.evidence.find(evidence => evidence.id === selectedEvidenceId) || selectedMaterial.evidence[0]
    : undefined
  const hasDimensionLabels = materials.some(material => material.labels[dimension].length > 0)

  const selectMaterial = (material: MaterialGraphMaterial) => {
    setSelectedMaterialId(material.id)
    setSelectedEvidenceId(material.evidence[0]?.id || null)
  }

  const resetView = () => {
    setQuery('')
    setHighlightedLabel(null)
    setSelectedMaterialId(null)
    setSelectedEvidenceId(null)
    setHoveredMaterialId(null)
    setPan({ x: 0, y: 0 })
    setZoom(1)
  }

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if ((event.target as Element).closest('[data-material-node]')) return
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      panX: pan.x,
      panY: pan.y,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const unitX = bounds.width > 0 ? GRAPH_WIDTH / bounds.width : 1
    const unitY = bounds.height > 0 ? GRAPH_HEIGHT / bounds.height : 1
    setPan({
      x: drag.panX + ((event.clientX - drag.x) * unitX) / zoom,
      y: drag.panY + ((event.clientY - drag.y) * unitY) / zoom,
    })
  }

  const endDrag = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const attachGraphWheel = useCallback((element: SVGSVGElement | null) => {
    if (!element) return
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      setZoom(current => clampZoom(current + (event.deltaY < 0 ? 0.08 : -0.08)))
    }
    // React delegates wheel as passive; the graph must own this gesture to avoid page scrolling.
    element.addEventListener('wheel', handleWheel, { passive: false })
    return () => element.removeEventListener('wheel', handleWheel)
  }, [])

  return (
    <section className="min-w-0 rounded-lg border border-border bg-card" aria-label="素材关系图谱">
      <div className="flex flex-col gap-3 border-b border-border px-3.5 py-3 md:px-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-foreground">素材关系图谱</h2>
            <p className="mt-1 text-xs text-muted-foreground">一份完整视频对应一个小点，连线表示素材共享标签。</p>
            <p className="mt-0.5 text-[10px] text-muted-foreground">连线依据已有识别标签；情绪关联未经过本次人工审核。</p>
          </div>
          <div className="flex rounded-md border border-border p-0.5" aria-label="素材范围">
            <Button
              type="button"
              size="xs"
              variant={effectiveScope === 'project' ? 'default' : 'ghost'}
              aria-pressed={effectiveScope === 'project'}
              disabled={!projectId}
              onClick={() => setScope('project')}
            >
              当前作品
            </Button>
            <Button
              type="button"
              size="xs"
              variant={effectiveScope === 'all' ? 'default' : 'ghost'}
              aria-pressed={effectiveScope === 'all'}
              onClick={() => setScope('all')}
            >
              全部作品
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground">
            关联维度
            <select
              aria-label="关联维度"
              className="bg-transparent text-xs text-foreground outline-none"
              value={dimension}
              onChange={event => setDimension(event.target.value as MaterialGraphDimension)}
            >
              <option value="scene">场景</option>
              <option value="emotion">情绪</option>
            </select>
          </label>
          <label className="flex h-8 min-w-[10rem] flex-1 items-center gap-2 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground sm:max-w-64">
            <span aria-hidden="true">⌕</span>
            <input
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="找素材名称或标签"
              aria-label="搜索素材"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
          <Button type="button" size="xs" variant="ghost" onClick={resetView}>重置筛选与视图</Button>
        </div>

        {visibleLabels.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5" aria-label={`按${dimensionLabel(dimension)}标签高亮`}>
            <Button
              type="button"
              size="xs"
              variant={highlightedLabel === null ? 'secondary' : 'ghost'}
              aria-pressed={highlightedLabel === null}
              onClick={() => setHighlightedLabel(null)}
            >
              全部
            </Button>
            {visibleLabels.map(({ label, count }) => (
              <Button
                key={label}
                type="button"
                size="xs"
                variant={highlightedLabel === label ? 'default' : 'ghost'}
                aria-pressed={highlightedLabel === label}
                onClick={() => setHighlightedLabel(current => current === label ? null : label)}
              >
                {label} <span className="text-[10px] opacity-70">{count}</span>
              </Button>
            ))}
            {hiddenLabelCount > 0 && <span className="px-1 text-[10px] text-muted-foreground">另有 {hiddenLabelCount} 个标签</span>}
          </div>
        )}
      </div>

      {error ? (
        <div className="flex min-h-[440px] flex-col items-center justify-center gap-3 px-5 text-center" role="alert">
          <div>
            <p className="text-sm font-medium text-destructive">素材关系图谱加载失败</p>
            <p className="mt-1 text-xs text-muted-foreground">{error}</p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadGraph()}>重试</Button>
        </div>
      ) : loading ? (
        <div className="flex min-h-[440px] items-center justify-center text-sm text-muted-foreground" role="status">
          正在读取素材关系…
        </div>
      ) : materials.length === 0 ? (
        <div className="flex min-h-[440px] flex-col items-center justify-center px-5 text-center">
          <h3 className="text-sm font-medium text-foreground">暂无可绘制的完整视频素材</h3>
          <p className="mt-1 text-xs text-muted-foreground">当前范围内没有素材，切换范围后可以重新查看。</p>
        </div>
      ) : (
        <>
          {stats && (stats.truncated || stats.unmatchedScenes > 0 || stats.unreadablePipelines > 0) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-warning/25 bg-warning/5 px-4 py-2 text-[11px] text-warning" role="status">
              {stats.truncated && <span>数据量较大，当前仅展示接口返回的 {materials.length} 份素材。</span>}
              {stats.unmatchedScenes > 0 && <span>{stats.unmatchedScenes} 个识别场景未匹配到素材。</span>}
              {stats.unreadablePipelines > 0 && <span>{stats.unreadablePipelines} 条分析管线暂不可读。</span>}
            </div>
          )}
          {!hasDimensionLabels && (
            <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground" role="status">
              这些素材尚未识别出{dimensionLabel(dimension)}标签，因此当前没有可连接的关系。
            </div>
          )}
          <div className="relative h-[min(68vh,700px)] min-h-[440px] w-full overflow-hidden bg-background/40">
            <svg
              ref={attachGraphWheel}
              className="h-full w-full cursor-grab touch-none active:cursor-grabbing"
              viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
              preserveAspectRatio="xMidYMid meet"
              aria-label={`按${dimensionLabel(dimension)}关联的素材图，共 ${visibleMaterials.length} 个素材点`}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            >
              <g transform={`translate(${pan.x} ${pan.y}) scale(${zoom})`}>
                {layout.groups.map(group => (
                  <text
                    key={group.label}
                    x={group.x}
                    y={group.y}
                    textAnchor="middle"
                    fill="hsl(var(--muted-foreground))"
                    fontSize="15"
                    opacity={highlightedLabel && highlightedLabel !== group.label ? 0.35 : 0.8}
                    aria-hidden="true"
                  >
                    {group.label} · {group.count}
                  </text>
                ))}
                {visibleEdges.map(edge => {
                  const source = nodePositions.get(edge.source)
                  const target = nodePositions.get(edge.target)
                  if (!source || !target) return null
                  const focused = focusId ? edge.source === focusId || edge.target === focusId : false
                  const highlighted = highlightedLabel ? edge.sharedLabels.includes(highlightedLabel) : false
                  const dimmed = focusId ? !focused : Boolean(highlightedLabel && !highlighted)
                  return (
                    <line
                      key={`${edge.source}:${edge.target}:${edge.sharedLabels.join('|')}`}
                      data-testid="material-edge"
                      x1={source.x}
                      y1={source.y}
                      x2={target.x}
                      y2={target.y}
                      stroke={focused || highlighted ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))'}
                      strokeWidth={focused || highlighted ? 1.4 : 0.75}
                      opacity={dimmed ? 0.08 : focused || highlighted ? 0.72 : 0.32}
                      aria-hidden="true"
                    />
                  )
                })}
                {visibleMaterials.map(material => {
                  const position = nodePositions.get(material.id)
                  if (!position) return null
                  const selected = selectedMaterialId === material.id
                  const related = focusId ? relatedIds.has(material.id) : false
                  const highlighted = highlightedLabel ? material.labels[dimension].includes(highlightedLabel) : false
                  const emphasized = selected || related || highlighted
                  const dimmed = focusId ? !related : Boolean(highlightedLabel && !highlighted)
                  return (
                    <g
                      key={material.id}
                      data-testid="material-node"
                      data-material-node={material.id}
                      data-emphasized={emphasized ? 'true' : 'false'}
                      data-dimmed={dimmed ? 'true' : 'false'}
                      role="button"
                      tabIndex={0}
                      aria-label={`素材：${material.name}`}
                      aria-pressed={selected}
                      transform={`translate(${position.x} ${position.y})`}
                      className="cursor-pointer outline-none"
                      onClick={() => selectMaterial(material)}
                      onKeyDown={event => {
                        if (event.key !== 'Enter' && event.key !== ' ') return
                        event.preventDefault()
                        selectMaterial(material)
                      }}
                      onMouseEnter={() => setHoveredMaterialId(material.id)}
                      onMouseLeave={() => setHoveredMaterialId(current => current === material.id ? null : current)}
                      onFocus={() => setHoveredMaterialId(material.id)}
                      onBlur={() => setHoveredMaterialId(current => current === material.id ? null : current)}
                    >
                      <circle r="12" fill="transparent" />
                      {selected && <circle r="8" fill="hsl(var(--primary) / 0.12)" stroke="hsl(var(--primary) / 0.3)" />}
                      <circle
                        r="3"
                        fill={emphasized ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))'}
                        opacity={dimmed ? 0.22 : 1}
                      />
                      {(selected || hoveredMaterialId === material.id) && (
                        <text
                          y="20"
                          textAnchor="middle"
                          fill="hsl(var(--foreground))"
                          fontSize="11"
                          pointerEvents="none"
                        >
                          {material.name.length > 18 ? `${material.name.slice(0, 18)}…` : material.name}
                        </text>
                      )}
                    </g>
                  )
                })}
              </g>
            </svg>

            {visibleMaterials.length === 0 && (
              <div className="pointer-events-none absolute inset-0 grid place-items-center bg-background/65 text-sm text-muted-foreground">
                没有匹配搜索条件的素材
              </div>
            )}
            <p className="pointer-events-none absolute bottom-3 left-4 text-[10px] text-muted-foreground">
              点击小点查看素材 · 拖动平移 · 滚轮缩放
            </p>
            <div className="absolute bottom-3 right-3 flex items-center rounded-md border border-border bg-card/95 p-0.5">
              <Button type="button" size="icon-xs" variant="ghost" aria-label="缩小图谱" onClick={() => setZoom(current => clampZoom(current - 0.15))}>−</Button>
              <output className="w-12 text-center text-[10px] text-muted-foreground" aria-label="图谱缩放比例">{Math.round(zoom * 100)}%</output>
              <Button type="button" size="icon-xs" variant="ghost" aria-label="放大图谱" onClick={() => setZoom(current => clampZoom(current + 0.15))}>+</Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
            <span>{visibleMaterials.length} / {materials.length} 份素材 · {visibleEdges.length} 条{dimensionLabel(dimension)}关系</span>
            <span>区域文字仅作分组说明，不是图节点</span>
          </div>

          {selectedMaterial && (
            <aside className="border-t border-border bg-muted/20 px-4 py-3" aria-label="已选素材详情">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <h3 className="truncate text-sm font-medium text-foreground">{selectedMaterial.name}</h3>
                    <span className="text-[10px] text-muted-foreground">来源：{selectedMaterial.project}</span>
                  </div>
                  <p className="mt-1 truncate text-[10px] text-muted-foreground" title={selectedMaterial.path}>{selectedMaterial.path}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {selectedMaterial.labels.scene.map(label => (
                      <span key={`scene:${label}`} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">场景 · {label}</span>
                    ))}
                    {selectedMaterial.labels.emotion.map(label => (
                      <span key={`emotion:${label}`} className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">情绪 · {label}</span>
                    ))}
                    {selectedMaterial.labels.scene.length + selectedMaterial.labels.emotion.length === 0 && (
                      <span className="text-[10px] text-muted-foreground">尚无已识别标签</span>
                    )}
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onOpenMaterial(selectedMaterial, selectedEvidence)}
                >
                  回到素材预览{selectedEvidence ? ` · ${formatTimeRange(selectedEvidence)}` : ''}
                </Button>
              </div>

              {selectedMaterial.evidence.length > 0 ? (
                <div className="mt-3 grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3" aria-label="标签识别依据">
                  {selectedMaterial.evidence.slice(0, 6).map(evidence => {
                    const active = evidence.id === selectedEvidence?.id
                    return (
                      <button
                        key={evidence.id}
                        type="button"
                        aria-pressed={active}
                        aria-label={`选择依据：${evidence.pipeline} ${formatTimeRange(evidence)}`}
                        className={`min-w-0 rounded-md border px-2.5 py-2 text-left text-[11px] transition-colors ${active ? 'border-primary/50 bg-primary/10 text-foreground' : 'border-border bg-background text-muted-foreground hover:text-foreground'}`}
                        onClick={() => setSelectedEvidenceId(evidence.id)}
                      >
                        <span className="block truncate">{evidence.pipeline} · {formatTimeRange(evidence)}</span>
                        {evidence.summary && <span className="mt-0.5 block truncate text-[10px] opacity-80">{evidence.summary}</span>}
                      </button>
                    )
                  })}
                </div>
              ) : (
                <p className="mt-2 text-[10px] text-muted-foreground">这份素材没有可用的识别依据时间码。</p>
              )}
            </aside>
          )}
          <span className="sr-only" aria-live="polite">
            当前按{dimensionLabel(dimension)}关联 {visibleMaterials.length} 份素材；每个节点都是一份完整视频素材。
          </span>
        </>
      )}
    </section>
  )
}

export type { MaterialGraphPanelProps }
