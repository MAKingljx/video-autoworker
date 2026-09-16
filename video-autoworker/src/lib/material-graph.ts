/** Read-only relationships between whole video materials, never tag/scene nodes. */
export const MATERIAL_GRAPH_DIMENSIONS = ['scene', 'emotion'] as const
export type MaterialGraphDimension = typeof MATERIAL_GRAPH_DIMENSIONS[number]
export type MaterialGraphLabels = Record<MaterialGraphDimension, string[]>

export interface MaterialGraphEvidence {
  id: string
  pipeline: string
  sceneId: number
  start: number | null
  end: number | null
  summary: string
  labels: MaterialGraphLabels
}

export interface MaterialGraphMaterial {
  id: string
  name: string
  path: string
  project: string
  labels: MaterialGraphLabels
  evidence: MaterialGraphEvidence[]
  evidenceCount: number
}

export interface MaterialGraphSnapshot {
  schemaVersion: 1
  generatedAt: string
  materials: MaterialGraphMaterial[]
  stats: {
    totalMaterials: number
    scannedScenes: number
    unmatchedScenes: number
    unreadablePipelines: number
    truncated: boolean
  }
}

export interface MaterialGraphEdge {
  source: string
  target: string
  sharedLabels: string[]
}

export interface MaterialGraphNode {
  id: string
  x: number
  y: number
}

export interface MaterialGraphLayout {
  nodes: MaterialGraphNode[]
  edges: MaterialGraphEdge[]
  groups: { label: string; count: number; x: number; y: number }[]
}

export const MATERIAL_GRAPH_MAX_MATERIALS = 300
export const MATERIAL_GRAPH_MAX_SCENES = 3_000
export const MATERIAL_GRAPH_MAX_EVIDENCE = 24
export const MATERIAL_GRAPH_MAX_EDGES = 1800

/** Only structured labels are used; prose/transcripts never become invented tags. */
export function normalizeMaterialGraphLabels(metadata: Record<string, unknown>): MaterialGraphLabels {
  const collect = (keys: string[]) => {
    const values = new Set<string>()
    for (const key of keys) {
      const input = metadata[key]
      for (const value of (Array.isArray(input) ? input : [input]).slice(0, 64)) {
        if (typeof value !== 'string') continue
        for (const part of value.normalize('NFKC').split(/[,，、;；\n|]+/u)) {
          const text = part.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN')
          if (!text || text.length > 40
            || /^(?:无|暂无|没有|未知|不确定|不适用|未识别|未检测到|未提供|none|unknown|n\/a)$/iu.test(text)
            || /^(?:没有|未检测到|未识别到|不存在)\s*\S+/u.test(text)) continue
          values.add(text)
          if (values.size >= 24) break
        }
        if (values.size >= 24) break
      }
      if (values.size >= 24) break
    }
    return [...values].sort((a, b) => a.localeCompare(b, 'zh-CN'))
  }
  return {
    scene: collect(['scene_tags', 'scene_types', 'scene_type', 'scene', '场景', 'locations', 'location', 'environment']),
    emotion: collect(['emotion', 'emotions', '情绪']),
  }
}

function hash(text: string): number {
  let result = 2166136261
  for (let i = 0; i < text.length; i++) result = Math.imul(result ^ text.charCodeAt(i), 16777619)
  return result >>> 0
}

/** Small, deterministic graph. Labels position materials but are never graph nodes. */
export function buildMaterialGraphLayout(
  materials: readonly MaterialGraphMaterial[],
  dimension: MaterialGraphDimension,
): MaterialGraphLayout {
  const unique = [...new Map(materials.map(item => [item.id, item])).values()]
    .sort((a, b) => a.id.localeCompare(b.id)).slice(0, MATERIAL_GRAPH_MAX_MATERIALS)
  const buckets = new Map<string, string[]>()
  for (const material of unique) {
    for (const label of new Set(material.labels[dimension])) {
      const members = buckets.get(label) || []
      members.push(material.id)
      buckets.set(label, members)
    }
  }
  const labels = [...buckets.keys()].sort((a, b) => (buckets.get(b)!.length - buckets.get(a)!.length) || a.localeCompare(b, 'zh-CN'))
  const ranked = labels.slice(0, 10)
  const centers = new Map(ranked.map((label, i) => {
    const angle = i * Math.PI * 2 / ranked.length - Math.PI / 2
    return [label, {
      x: ranked.length === 1 ? 500 : 500 + Math.cos(angle) * 300,
      y: ranked.length === 1 ? 340 : 340 + Math.sin(angle) * 200,
    }] as const
  }))
  const nodes = unique.map((material, i) => {
    const anchors = material.labels[dimension].flatMap(label => centers.has(label) ? [centers.get(label)!] : [])
    const center = anchors.length ? {
      x: anchors.reduce((sum, p) => sum + p.x, 0) / anchors.length,
      y: anchors.reduce((sum, p) => sum + p.y, 0) / anchors.length,
    } : { x: 500, y: 340 }
    const angle = hash(material.id) / 0xffffffff * Math.PI * 2
    const radius = anchors.length ? 25 + hash(`${material.id}:radius`) % 95 : 90 + Math.sqrt(i + 1) * 15
    return { id: material.id, x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius * .8 }
  })
  // Resolve crowded points without a simulation loop that continues consuming CPU.
  for (let pass = 0; pass < 20; pass++) {
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j]
      let dx = b.x - a.x, dy = b.y - a.y
      const distance = Math.hypot(dx, dy)
      if (distance >= 19) continue
      if (distance < .001) { dx = 1; dy = 1 }
      const push = (19 - distance) / (Math.hypot(dx, dy) || 1) * .27
      a.x -= dx * push; a.y -= dy * push; b.x += dx * push; b.y += dy * push
    }
    nodes.forEach(n => { n.x = Math.max(35, Math.min(965, n.x)); n.y = Math.max(45, Math.min(645, n.y)) })
  }
  const positions = new Map(nodes.map(n => [n.id, n]))
  const pairs = new Map<string, MaterialGraphEdge>()
  const addPair = (a: string, b: string, label: string) => {
    if (a === b) return
    const [source, target] = [a, b].sort(), key = `${source}\0${target}`
    if (!pairs.has(key) && pairs.size >= MATERIAL_GRAPH_MAX_EDGES) return
    const edge = pairs.get(key) || { source, target, sharedLabels: [] }
    if (!edge.sharedLabels.includes(label)) edge.sharedLabels.push(label)
    pairs.set(key, edge)
  }
  for (const label of labels) {
    const ids = buckets.get(label)!
    if (ids.length < 2) continue
    // A local spanning chain keeps each shared-label group connected; nearest links add context.
    const ordered = [...ids].sort((a, b) => positions.get(a)!.x - positions.get(b)!.x || a.localeCompare(b))
    ordered.slice(1).forEach((id, i) => addPair(ordered[i], id, label))
    for (const id of ids) {
      const p = positions.get(id)!
      const nearby = ids.filter(other => other !== id).sort((a, b) => {
        const left = positions.get(a)!, right = positions.get(b)!
        return Math.hypot(left.x - p.x, left.y - p.y) - Math.hypot(right.x - p.x, right.y - p.y) || a.localeCompare(b)
      })
      nearby.slice(0, 2).forEach(other => addPair(id, other, label))
    }
  }
  const edges = [...pairs.values()].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target))
  return {
    nodes, edges,
    groups: ranked.filter(label => buckets.get(label)!.length > 1).map(label => ({
      label, count: buckets.get(label)!.length, x: centers.get(label)!.x, y: Math.max(25, centers.get(label)!.y - 115),
    })),
  }
}
