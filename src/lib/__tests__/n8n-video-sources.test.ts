import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getN8nVideoSource,
  listN8nVideoSources,
  resetN8nVideoSourceCacheForTests,
} from '@/lib/n8n-video-sources'

const roots: string[] = []

afterEach(async () => {
  delete process.env.AIWORKER_VIDEO_BATCH_DIR
  resetN8nVideoSourceCacheForTests()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'n8n-video-sources-'))
  roots.push(root)
  const states = join(root, 'states')
  const media = join(root, 'media')
  await mkdir(states)
  await mkdir(media)
  process.env.AIWORKER_VIDEO_BATCH_DIR = states
  return { root, states, media }
}

describe('n8n video source index', () => {
  it('maps a task to a verified video without exposing unrelated files', async () => {
    const { states, media } = await fixture()
    const video = join(media, 'S03E03.mp4')
    await writeFile(video, 'video-content')
    await writeFile(join(states, 'batch.json'), JSON.stringify({
      items: [{
        taskId: 'batch-a:video:003:abcdef123456',
        name: 'S03E03.mp4',
        sourcePath: video,
        sourceBytes: 13,
      }],
    }))

    const source = await getN8nVideoSource('batch-a:video:003:abcdef123456')
    expect(source).toMatchObject({ name: 'S03E03.mp4', bytes: 13, extension: '.mp4' })
    expect(await getN8nVideoSource('missing-task')).toBeNull()
  })

  it('rejects changed sources and symlinked state files', async () => {
    const { states, media } = await fixture()
    const video = join(media, 'changed.mp4')
    await writeFile(video, 'changed')
    const externalState = join(media, 'outside.json')
    await writeFile(externalState, JSON.stringify({
      items: [{ taskId: 'task-a', name: 'changed.mp4', sourcePath: video, sourceBytes: 999 }],
    }))
    await symlink(externalState, join(states, 'linked.json'))
    await writeFile(join(states, 'batch.json'), JSON.stringify({
      items: [{ taskId: 'task-b', name: 'changed.mp4', sourcePath: video, sourceBytes: 999 }],
    }))

    expect((await listN8nVideoSources()).size).toBe(0)
  })

  it('removes ambiguous task mappings instead of choosing an arbitrary source', async () => {
    const { states, media } = await fixture()
    const first = join(media, 'first.mp4')
    const second = join(media, 'second.mp4')
    await writeFile(first, 'first-video')
    await writeFile(second, 'second-video')
    await writeFile(join(states, 'batch-a.json'), JSON.stringify({
      items: [{ taskId: 'same-task', name: 'first.mp4', sourcePath: first, sourceBytes: 11 }],
    }))
    await writeFile(join(states, 'batch-b.json'), JSON.stringify({
      items: [{ taskId: 'same-task', name: 'second.mp4', sourcePath: second, sourceBytes: 12 }],
    }))

    expect(await getN8nVideoSource('same-task')).toBeNull()
  })
})
