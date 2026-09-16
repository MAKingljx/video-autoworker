import { createHash } from 'node:crypto'
import path from 'node:path'
import {
  MATERIAL_GRAPH_MAX_EVIDENCE, MATERIAL_GRAPH_MAX_MATERIALS, normalizeMaterialGraphLabels,
  type MaterialGraphMaterial, type MaterialGraphSnapshot,
} from './material-graph'

export interface MaterialGraphSource {
  generatedAt: string
  projects: { id: string; path: string; videoCount: number; videos: { name: string; path: string }[] }[]
  scenes: {
    id: string; project: string; pipeline: string; sceneId: number
    start: number | null; end: number | null; visualSummary: string; metadata: Record<string, unknown>
  }[]
  totalMaterials: number
  unreadablePipelines: number
  truncated: boolean
}

function finiteTime(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

/** Never assign a scene to the first/current video in a multi-video project. */
function resolveVideo(
  project: MaterialGraphSource['projects'][number],
  scene: MaterialGraphSource['scenes'][number],
) {
  const hints = ['source_video', 'video_path', 'source_path', 'video_name', 'videoName', 'sourceVideo']
    .filter(key => scene.metadata[key] !== undefined && scene.metadata[key] !== null)
    .map(key => scene.metadata[key])
  if (hints.length) {
    const resolved = hints.map(hint => {
      if (typeof hint !== 'string' || !hint.trim()) return null
      const name = hint.trim()
      const matches = project.videos.filter(video => path.isAbsolute(name)
        ? path.normalize(video.path) === path.normalize(name)
        : name.includes('/') || name.includes('\\')
          ? path.normalize(video.path) === path.resolve(project.path, name)
          : video.name === name)
      return matches.length === 1 ? matches[0] : null
    })
    if (resolved.some(item => !item) || new Set(resolved.map(item => item?.path)).size !== 1) return null
    return resolved[0]
  }
  if (project.videoCount === 1 && project.videos.length === 1) return project.videos[0]
  const stem = scene.pipeline.replace(/^pipeline[-_. ]+/u, '')
  if (!stem || stem === 'pipeline') return null
  const matches = project.videos.filter(video => path.parse(video.name).name === stem)
  return matches.length === 1 ? matches[0] : null
}

export function buildMaterialGraphSnapshot(source: MaterialGraphSource): MaterialGraphSnapshot {
  const materials: MaterialGraphMaterial[] = []
  const byPath = new Map<string, MaterialGraphMaterial>()
  const projects = new Map(source.projects.map(project => [project.id, {
    ...project,
    videos: [...new Map(project.videos.map(video => [path.normalize(video.path), video])).values()],
  }]))
  for (const project of source.projects) for (const video of project.videos) {
    const key = `${project.id}\0${path.normalize(video.path)}`
    if (byPath.has(key) || materials.length >= MATERIAL_GRAPH_MAX_MATERIALS) continue
    const material: MaterialGraphMaterial = {
      id: `material-${createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
      name: video.name, path: video.path, project: project.id,
      labels: { scene: [], emotion: [] }, evidence: [], evidenceCount: 0,
    }
    materials.push(material); byPath.set(key, material)
  }
  let unmatchedScenes = 0
  const seenScenes = new Set<string>()
  for (const scene of source.scenes) {
    const sceneKey = `${scene.project}\0${scene.pipeline}\0${scene.sceneId}`
    if (seenScenes.has(sceneKey)) continue
    seenScenes.add(sceneKey)
    const project = projects.get(scene.project)
    const video = project && resolveVideo(project, scene)
    const material = video && byPath.get(`${scene.project}\0${path.normalize(video.path)}`)
    if (!material) { unmatchedScenes++; continue }
    const labels = normalizeMaterialGraphLabels(scene.metadata)
    for (const dimension of ['scene', 'emotion'] as const) {
      material.labels[dimension] = [...new Set([...material.labels[dimension], ...labels[dimension]])]
        .sort((a, b) => a.localeCompare(b, 'zh-CN')).slice(0, 64)
    }
    material.evidenceCount++
    if (material.evidence.length >= MATERIAL_GRAPH_MAX_EVIDENCE) continue
    const start = finiteTime(scene.start), rawEnd = finiteTime(scene.end)
    material.evidence.push({
      id: scene.id, pipeline: scene.pipeline, sceneId: scene.sceneId,
      start, end: start !== null && rawEnd !== null && rawEnd >= start ? rawEnd : null,
      summary: typeof scene.visualSummary === 'string' ? scene.visualSummary.slice(0, 700) : '', labels,
    })
  }
  return {
    schemaVersion: 1, generatedAt: source.generatedAt, materials,
    stats: {
      totalMaterials: source.totalMaterials, scannedScenes: seenScenes.size, unmatchedScenes,
      unreadablePipelines: source.unreadablePipelines,
      truncated: source.truncated || source.totalMaterials > materials.length,
    },
  }
}
