// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getMaterialsGraph, searchMaterials } from '../openclaw-materials'

let root: string, outside: string, index: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'graph-fixture-#'))
  outside = await mkdtemp(path.join(os.tmpdir(), 'graph-outside-'))
  const project = path.join(root, 'bot-learning', '雪山示例')
  await mkdir(path.join(project, 'raw-data'), { recursive: true })
  await mkdir(path.join(project, 'pipeline'), { recursive: true })
  await writeFile(path.join(project, 'raw-data', '雪山.mp4'), 'fixture-video')
  index = path.join(project, 'pipeline', 'material_index.sqlite')
  const db = new Database(index)
  db.exec(`CREATE TABLE scene_segments(id INTEGER PRIMARY KEY,label TEXT,start REAL,end REAL,keyframes_json TEXT,transcript TEXT,material_tags_json TEXT);
    CREATE TABLE visual_labels(scene_id INTEGER,status TEXT,result_json TEXT,raw_response TEXT);`)
  db.prepare('INSERT INTO scene_segments VALUES(?,?,?,?,?,?,?)').run(1, '山间远景', 1, 3, '[]', '测试转写', '[]')
  db.prepare('INSERT INTO visual_labels VALUES(?,?,?,?)').run(1, 'done', JSON.stringify({ location: ['雪山'], emotion: ['孤独'], visual_summary: '雪山上的旅人' }), '')
  db.close()
  vi.stubEnv('MC_MATERIALS_WORKSPACE_ROOT', root)
  vi.stubEnv('MC_OPENCLAW_PROFILE_TARGET', 'local')
  vi.stubEnv('MC_MATERIALS_REMOTE_PYTHON', '/usr/bin/python3')
})
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })])
})
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')

describe('material graph real read-only reader', () => {
  it('reads real SQLite labels, preserves database bytes and project-scoped reads', async () => {
    const before = await digest(index)
    const graph = await getMaterialsGraph({ project: '雪山示例' })
    expect(graph.materials).toHaveLength(1)
    expect(graph.materials[0].labels).toEqual({ scene: ['雪山'], emotion: ['孤独'] })
    expect(graph.materials[0].evidence[0].start).toBe(1)
    expect(await digest(index)).toBe(before)
    expect((await getMaterialsGraph({ project: '不存在' })).materials).toEqual([])
    const search = await searchMaterials({ query: '雪山', project: '雪山示例', mode: 'keyword' })
    expect(search.results[0].visualSummary).toBe('雪山上的旅人')
  })

  it('reports unreadable/outside indexes without silently losing readable videos', async () => {
    const project = path.dirname(path.dirname(index))
    await mkdir(path.join(project, 'pipeline-broken'))
    await writeFile(path.join(project, 'pipeline-broken', 'material_index.sqlite'), 'broken')
    await mkdir(path.join(project, 'pipeline-outside'))
    await writeFile(path.join(outside, 'material_index.sqlite'), 'outside')
    await symlink(path.join(outside, 'material_index.sqlite'), path.join(project, 'pipeline-outside', 'material_index.sqlite'))
    await symlink(outside, path.join(root, 'bot-learning', 'outside-project'))
    const graph = await getMaterialsGraph()
    expect(graph.materials).toHaveLength(1)
    expect(graph.stats.unreadablePipelines).toBe(2)
    expect(graph.materials[0].evidenceCount).toBe(1)
  })
})
