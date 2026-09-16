import { describe, expect, it } from 'vitest'
import { buildMaterialGraphLayout, normalizeMaterialGraphLabels, type MaterialGraphMaterial } from '../material-graph'
import { buildMaterialGraphSnapshot, type MaterialGraphSource } from '../material-graph-source'

function material(id: string, scene: string[], emotion: string[]): MaterialGraphMaterial {
  return { id, name: `${id}.mp4`, path: `/library/${id}.mp4`, project: '旅行', labels: { scene, emotion }, evidence: [], evidenceCount: 0 }
}

function source(): MaterialGraphSource {
  return {
    generatedAt: '2026-09-13T00:00:00Z', totalMaterials: 2, unreadablePipelines: 0, truncated: false,
    projects: [{ id: '旅行', path: '/library/旅行', videoCount: 2, videos: [
      { name: 'a.mp4', path: '/library/旅行/raw-data/a.mp4' }, { name: 'b.mp4', path: '/library/旅行/raw-data/b.mp4' },
    ] }],
    scenes: [
      { id: 's1', project: '旅行', pipeline: 'pipeline', sceneId: 1, start: 2, end: 7, visualSummary: '雪山远景', metadata: { source_video: 'a.mp4', location: ['雪山'], emotion: ['孤独'] } },
      { id: 's2', project: '旅行', pipeline: 'pipeline', sceneId: 2, start: 8, end: 12, visualSummary: '沙丘', metadata: { source_video: 'a.mp4', location: ['沙漠'], emotion: ['震撼'] } },
    ],
  }
}

describe('material graph projection', () => {
  it('keeps one whole-video node for multiple scenes and keeps unanalysed videos', () => {
    const data = source()
    data.projects[0].videos.push({ ...data.projects[0].videos[0] })
    data.scenes.push({ ...data.scenes[0] })
    const result = buildMaterialGraphSnapshot(data)
    expect(result.materials).toHaveLength(2)
    expect(result.materials[0].labels.scene).toEqual(['沙漠', '雪山'])
    expect(result.materials[0].evidenceCount).toBe(2)
    expect(result.materials[1].labels).toEqual({ scene: [], emotion: [] })
  })

  it('does not guess the first file for an ambiguous scene or contradictory sources', () => {
    const data = source()
    data.scenes[0].metadata = { location: '雪山' }
    data.scenes[1].metadata.video_path = '/library/旅行/raw-data/b.mp4'
    const result = buildMaterialGraphSnapshot(data)
    expect(result.stats.unmatchedScenes).toBe(2)
    expect(result.materials.every(m => m.evidence.length === 0)).toBe(true)
  })

  it('uses a unique exact pipeline filename and rejects explicit outside sources', () => {
    const data = source()
    data.scenes[0].pipeline = 'pipeline-a'
    data.scenes[0].metadata = { location: '雪山' }
    data.scenes[1].metadata.source_video = '/outside/a.mp4'
    const result = buildMaterialGraphSnapshot(data)
    expect(result.materials[0].evidence).toHaveLength(1)
    expect(result.stats.unmatchedScenes).toBe(1)
  })

  it('never falls back to a single video when an explicit source is invalid', () => {
    const data = source()
    data.projects[0].videos = data.projects[0].videos.slice(0, 1)
    data.projects[0].videoCount = 1
    data.scenes[0].metadata.source_video = false
    data.scenes[1].project = 'another-project'
    expect(buildMaterialGraphSnapshot(data).stats.unmatchedScenes).toBe(2)
  })

  it('does not mistake a truncated multi-video project for a single-video project', () => {
    const data = source()
    data.projects[0].videos = data.projects[0].videos.slice(0, 1)
    data.scenes[0].metadata = { location: '雪山' }
    data.scenes = data.scenes.slice(0, 1)
    data.truncated = true
    const result = buildMaterialGraphSnapshot(data)
    expect(result.materials).toHaveLength(1)
    expect(result.materials[0].evidenceCount).toBe(0)
    expect(result.stats.unmatchedScenes).toBe(1)
    expect(result.stats.truncated).toBe(true)
  })

  it('keeps identity stable across scene order and does not use names as labels', () => {
    const data = source(), before = buildMaterialGraphSnapshot(data)
    data.scenes.reverse()
    expect(buildMaterialGraphSnapshot(data).materials.map(m => m.id)).toEqual(before.materials.map(m => m.id))
    expect(normalizeMaterialGraphLabels({ visual_summary: '雪山', searchable_tags: ['雪山'] }).scene).toEqual([])
  })

  it('normalizes structured labels while excluding absent, uncertain and malformed values', () => {
    expect(normalizeMaterialGraphLabels({
      location: [' 雪山 ', '雪山', '没有沙漠', { name: '冰川' }], emotion: '孤独、 温暖;未知',
    })).toEqual({ scene: ['雪山'], emotion: ['孤独', '温暖'] })
    expect(normalizeMaterialGraphLabels({ location: ['无锡', '无边沙漠'] }).scene).toHaveLength(2)
  })

  it('bounds evidence without dropping the video and reports limits', () => {
    const data = source()
    data.scenes = Array.from({ length: 40 }, (_, i) => ({ ...data.scenes[0], id: `s${i}`, sceneId: i }))
    data.totalMaterials = 301
    const result = buildMaterialGraphSnapshot(data)
    expect(result.materials[0].evidence).toHaveLength(24)
    expect(result.materials[0].evidenceCount).toBe(40)
    expect(result.stats.truncated).toBe(true)
  })
})

describe('material-only graph layout', () => {
  const items = [material('a', ['雪山', '沙漠'], ['孤独']), material('b', ['雪山'], ['温暖']), material('c', ['海岸'], ['孤独']), material('d', [], [])]

  it('creates only material nodes and material-to-material edges', () => {
    const scene = buildMaterialGraphLayout(items, 'scene')
    expect(scene.nodes.map(n => n.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(scene.edges).toEqual([{ source: 'a', target: 'b', sharedLabels: ['雪山'] }])
    expect(scene.groups.find(g => g.label === '雪山')?.count).toBe(2)
    expect(scene.nodes.some(n => n.id === '雪山')).toBe(false)
    expect(scene.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true)
  })

  it('changes relationships across dimensions without duplicating multi-tag videos', () => {
    const emotion = buildMaterialGraphLayout([...items, items[0]], 'emotion')
    expect(emotion.nodes.map(n => n.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(emotion.edges).toEqual([{ source: 'a', target: 'c', sharedLabels: ['孤独'] }])
  })

  it('is deterministic regardless of input ordering and handles empty sets', () => {
    expect(buildMaterialGraphLayout([...items].reverse(), 'scene')).toEqual(buildMaterialGraphLayout(items, 'scene'))
    expect(buildMaterialGraphLayout([], 'scene')).toEqual({ nodes: [], edges: [], groups: [] })
  })
})
