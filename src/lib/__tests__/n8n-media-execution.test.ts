import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildMediaSegmentWindows,
  cleanupExpiredN8nMediaTasks,
  mediaChildIdentity,
  mergeN8nMediaResults,
} from '@/lib/n8n-media-execution'

describe('n8n stateless media helpers', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiworker-media-test-'))
    process.env.AIWORKER_MEDIA_WORK_DIR = join(root, 'work')
    process.env.AIWORKER_MEDIA_INGEST_DIR = join(root, 'inbox')
  })

  afterEach(async () => {
    delete process.env.AIWORKER_MEDIA_WORK_DIR
    delete process.env.AIWORKER_MEDIA_INGEST_DIR
    await rm(root, { recursive: true, force: true })
  })

  it('builds deterministic bounded child identities', () => {
    const first = mediaChildIdentity('task', 'video-parent-1', 'vision')
    const second = mediaChildIdentity('task', 'video-parent-1', 'vision')
    expect(first).toBe(second)
    expect(first.length).toBeLessThanOrEqual(120)
    expect(first).toMatch(/^media-task:/)
  })

  it('splits long media into one-minute windows with a bounded final remainder', () => {
    expect(buildMediaSegmentWindows(125, 60)).toEqual([
      { index: 1, startSeconds: 0, durationSeconds: 60 },
      { index: 2, startSeconds: 60, durationSeconds: 60 },
      { index: 3, startSeconds: 120, durationSeconds: 5 },
    ])
  })

  it('merges worker output without creating a memory-bearing synthesis node', () => {
    const merged = mergeN8nMediaResults(
      {
        transcript: '这是一段语音。', model: 'large-v3-turbo', memoryMode: 'none',
        segments: [{ index: 1, timeRange: '00:00:00-00:01:00', transcript: '这是一段语音。' }],
      },
      {
        analysis: '画面中有人走进房间。', model: 'default_model', memoryMode: 'none',
        segments: [{ index: 1, timeRange: '00:00:00-00:01:00', analysis: '画面中有人走进房间。' }],
      },
    )
    expect(merged).toMatchObject({
      taskType: 'video-analysis',
      memoryMode: 'none',
      persistence: 'operational-task-record-only',
      workers: {
        audio: { model: 'large-v3-turbo', memoryMode: 'none' },
        vision: { model: 'default_model', memoryMode: 'none' },
      },
    })
    expect(merged.combinedText).toContain('这是一段语音。')
    expect(merged.combinedText).toContain('画面中有人走进房间。')
    expect(merged.timeline).toEqual([{
      index: 1,
      timeRange: '00:00:00-00:01:00',
      transcript: '这是一段语音。',
      visualAnalysis: '画面中有人走进房间。',
    }])
  })

  it('removes only expired managed workspaces and inbox media', async () => {
    const work = process.env.AIWORKER_MEDIA_WORK_DIR!
    const inbox = process.env.AIWORKER_MEDIA_INGEST_DIR!
    const managedDir = join(work, 'a'.repeat(64))
    const ignoredDir = join(work, 'operator-notes')
    const managedVideo = join(inbox, '123e4567-e89b-42d3-a456-426614174000.mp4')
    const ignoredFile = join(inbox, 'keep.txt')
    await mkdir(managedDir, { recursive: true })
    await mkdir(ignoredDir, { recursive: true })
    await mkdir(inbox, { recursive: true })
    await writeFile(join(managedDir, 'metadata.json'), '{}')
    await writeFile(managedVideo, 'video')
    await writeFile(ignoredFile, 'keep')
    const old = new Date(Date.now() - 25 * 60 * 60 * 1_000)
    await utimes(managedDir, old, old)
    await utimes(managedVideo, old, old)

    expect(await cleanupExpiredN8nMediaTasks()).toBe(2)
    await expect(stat(managedDir)).rejects.toThrow()
    await expect(stat(managedVideo)).rejects.toThrow()
    expect((await readFile(ignoredFile, 'utf8'))).toBe('keep')
    expect((await stat(ignoredDir)).isDirectory()).toBe(true)
  })
})
