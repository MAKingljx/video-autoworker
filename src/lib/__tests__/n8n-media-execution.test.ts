import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildMediaSegmentWindows,
  cleanupN8nMediaTask,
  compatibleReasoningPayload,
  mediaChildIdentity,
  mediaTaskWorkspace,
  mergeN8nMediaResults,
  videoModelGenerationProfile,
  visibleModelAnswer,
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

  it('removes private Qwen reasoning before persisting visual checkpoints', () => {
    expect(visibleModelAnswer('<think>internal reasoning</think>最终画面结论')).toBe('最终画面结论')
    expect(visibleModelAnswer('没有思考标记的结果')).toBe('没有思考标记的结果')
    expect(visibleModelAnswer('')).toBe('')
  })

  it('uses stage-specific Qwen reasoning without spending deep reasoning on every frame', () => {
    expect(videoModelGenerationProfile('vision', {})).toEqual({
      phase: 'vision', reasoningEffort: 'off', maxTokens: 1_536,
    })
    expect(videoModelGenerationProfile('chapter', {})).toEqual({
      phase: 'chapter', reasoningEffort: 'low', maxTokens: 1_024,
    })
    expect(videoModelGenerationProfile('final', {})).toEqual({
      phase: 'final', reasoningEffort: 'medium', maxTokens: 1_536,
    })
    expect(compatibleReasoningPayload('off')).toEqual({ enable_thinking: false })
    expect(compatibleReasoningPayload('medium')).toEqual({
      enable_thinking: true, reasoning_effort: 'medium',
    })
  })

  it('accepts bounded stage overrides and the legacy synthesis token setting', () => {
    expect(videoModelGenerationProfile('vision', {
      AIWORKER_VIDEO_VISION_REASONING_EFFORT: 'low',
      AIWORKER_VIDEO_VISION_MAX_TOKENS: '99999',
    })).toEqual({ phase: 'vision', reasoningEffort: 'low', maxTokens: 4_096 })
    expect(videoModelGenerationProfile('chapter', {
      AIWORKER_VIDEO_SYNTHESIS_MAX_TOKENS: '640',
    })).toEqual({ phase: 'chapter', reasoningEffort: 'low', maxTokens: 640 })
    expect(() => videoModelGenerationProfile('final', {
      AIWORKER_VIDEO_FINAL_REASONING_EFFORT: 'adaptive',
    })).toThrow('AIWORKER_VIDEO_FINAL_REASONING_EFFORT')
  })

  it('cleans only the exact finalized task workspace', async () => {
    const target = mediaTaskWorkspace('video-parent-target')
    const neighbor = mediaTaskWorkspace('video-parent-neighbor')
    await mkdir(target, { recursive: true })
    await mkdir(neighbor, { recursive: true })
    await writeFile(join(target, 'metadata.json'), 'target')
    await writeFile(join(neighbor, 'metadata.json'), 'neighbor')

    await cleanupN8nMediaTask('video-parent-target')

    await expect(stat(target)).rejects.toThrow()
    await expect(readFile(join(neighbor, 'metadata.json'), 'utf8')).resolves.toBe('neighbor')
  })
})
