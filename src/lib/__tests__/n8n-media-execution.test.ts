import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  analyzeN8nVideoFrames,
  buildMediaSegmentWindows,
  cleanupN8nMediaTask,
  compatibleReasoningPayload,
  mediaChildIdentity,
  mediaTaskWorkspace,
  mergeN8nMediaResults,
  videoModelGenerationProfile,
  visibleModelAnswer,
} from '@/lib/n8n-media-execution'
import { buildDirectorBrainEvidenceProjection } from '../../../openclaw-skills/aiworker-task-flow/lib/director-brain-evidence.mjs'

describe('n8n stateless media helpers', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'aiworker-media-test-'))
    process.env.AIWORKER_MEDIA_WORK_DIR = join(root, 'work')
    process.env.AIWORKER_MEDIA_INGEST_DIR = join(root, 'inbox')
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    delete process.env.AIWORKER_MODEL_ROUTES_JSON
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

  it('preserves a sub-second final window through director evidence projection', async () => {
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify({
      version: 1,
      resources: [],
      routes: [{
        id: 'vision-tail-test',
        label: '尾段视觉路由',
        description: '',
        location: 'local',
        transport: 'openai-compatible',
        model: 'default_model',
        baseUrl: 'http://127.0.0.1:18091/v1',
        enabled: true,
        capabilities: ['text', 'vision'],
      }],
    })
    const taskId = 'video-subsecond-tail'
    const workspace = mediaTaskWorkspace(taskId)
    const windows = buildMediaSegmentWindows(120.5, 60)
    await mkdir(workspace, { recursive: true })
    const segments = await Promise.all(windows.map(async window => {
      const frame = `frame-${String(window.index).padStart(3, '0')}.jpg`
      await writeFile(join(workspace, frame), `frame-${window.index}`)
      return { ...window, audioFile: null, frameFiles: [frame] }
    }))
    await writeFile(join(workspace, 'metadata.json'), JSON.stringify({
      taskId,
      kind: 'prepared-video',
      durationSeconds: 120.5,
      sourceBytes: 100,
      audioAvailable: false,
      frameCount: 3,
      segmentCount: 3,
      segmentSeconds: 60,
      memoryMode: 'none',
      preparedAt: new Date().toISOString(),
      segments,
    }))
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '可复核画面事实' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const vision = await analyzeN8nVideoFrames(taskId, {
      config: { modelRouting: { nodes: { vision: { routeId: 'vision-tail-test' } } } },
    }, { prompt: '分析尾段' })
    const timeline = (vision.segments as Array<Record<string, unknown>>).map(segment => ({
      index: segment.index,
      timeRange: segment.timeRange,
      visualAnalysis: segment.analysis,
      confidence: 0,
    }))
    expect(timeline.at(-1)?.timeRange).toBe('00:02:00.000-00:02:00.500')

    const projection = buildDirectorBrainEvidenceProjection({
      schemaVersion: 1,
      projectId: 'PROJ-VIDEO-AUTOWORKER',
      workId: 'WORK-TAIL',
      taskId,
      materialId: 'MATERIAL-TAIL',
      mediaDurationSeconds: 120.5,
      analysisVersion: 'analysis-v1',
      status: 'succeeded',
      taskType: 'video-analysis',
      sourceAuthority: 'video-autoworker-final-result-v1',
      output: { summary: '全片摘要', timeline },
    })
    expect(projection.items.at(-1)).toMatchObject({
      '起始时间码': '00:02:00.000',
      '结束时间码': '00:02:00.500',
    })
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
      confidence: 0,
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

  it('switches a failed visual route to its declared fallback once per task', async () => {
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify({
      version: 1,
      resources: [],
      routes: [
        {
          id: 'vision-primary',
          label: '主视觉路由',
          description: '',
          location: 'local',
          transport: 'openai-compatible',
          model: 'qwen38-27b-vl',
          baseUrl: 'http://127.0.0.1:18094/v1',
          enabled: true,
          capabilities: ['text', 'vision'],
        },
        {
          id: 'vision-fallback',
          label: '备用视觉路由',
          description: '',
          location: 'local',
          transport: 'openai-compatible',
          model: 'default_model',
          baseUrl: 'http://127.0.0.1:18091/v1',
          enabled: true,
          capabilities: ['text', 'vision'],
        },
      ],
    })
    const taskId = 'video-fallback-test'
    const workspace = mediaTaskWorkspace(taskId)
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'frame-001.jpg'), 'frame-one')
    await writeFile(join(workspace, 'frame-002.jpg'), 'frame-two')
    await writeFile(join(workspace, 'metadata.json'), JSON.stringify({
      taskId,
      kind: 'prepared-video',
      durationSeconds: 120,
      sourceBytes: 100,
      audioAvailable: true,
      frameCount: 2,
      segmentCount: 2,
      segmentSeconds: 60,
      memoryMode: 'none',
      preparedAt: new Date().toISOString(),
      segments: [
        { index: 1, startSeconds: 0, durationSeconds: 60, audioFile: null, frameFiles: ['frame-001.jpg'] },
        { index: 2, startSeconds: 60, durationSeconds: 60, audioFile: null, frameFiles: ['frame-002.jpg'] },
      ],
    }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes(':18094/')) {
        return new Response(JSON.stringify({ error: { message: '主视觉服务不可用' } }), { status: 503 })
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: '<think>内部推理</think>备用路由画面结果' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    const result = await analyzeN8nVideoFrames(taskId, {
      config: {
        modelRouting: {
          nodes: {
            vision: { routeId: 'vision-primary', fallbackRouteIds: ['vision-fallback'] },
          },
        },
      },
    }, { prompt: '测试视频画面' })

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes(':18094/'))).toHaveLength(1)
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes(':18091/'))).toHaveLength(2)
    expect(result).toMatchObject({
      routeId: 'vision-fallback',
      routeCandidates: ['vision-primary', 'vision-fallback'],
      fallbackUsed: true,
      segmentCount: 2,
      model: 'default_model',
    })
    expect((result.segments as Array<Record<string, unknown>>).map(segment => segment.routeId))
      .toEqual(['vision-fallback', 'vision-fallback'])
    expect(result.analysis).toContain('备用路由画面结果')
    expect(result.analysis).not.toContain('<think>')
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
    await writeFile(join(target, 'metadata.json'), JSON.stringify({
      taskId: 'video-parent-target', kind: 'prepared-video',
    }))
    await writeFile(join(neighbor, 'metadata.json'), 'neighbor')

    await cleanupN8nMediaTask('video-parent-target')

    await expect(stat(target)).rejects.toThrow()
    await expect(readFile(join(neighbor, 'metadata.json'), 'utf8')).resolves.toBe('neighbor')
  })

  it('fails closed for invalid identities, symlink workspaces, and mismatched metadata', async () => {
    await expect(cleanupN8nMediaTask('../../outside')).rejects.toThrow(/任务标识无效/)

    const outside = join(root, 'outside')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'keep.txt'), 'keep')
    const linkedTask = 'video-parent-linked'
    await mkdir(process.env.AIWORKER_MEDIA_WORK_DIR!, { recursive: true })
    await symlink(outside, mediaTaskWorkspace(linkedTask))
    await expect(cleanupN8nMediaTask(linkedTask)).rejects.toThrow(/类型不安全/)
    await expect(readFile(join(outside, 'keep.txt'), 'utf8')).resolves.toBe('keep')

    const mismatchedTask = 'video-parent-mismatch'
    const mismatchedWorkspace = mediaTaskWorkspace(mismatchedTask)
    await mkdir(mismatchedWorkspace, { recursive: true })
    await writeFile(join(mismatchedWorkspace, 'metadata.json'), JSON.stringify({
      taskId: 'video-parent-other', kind: 'prepared-video',
    }))
    await expect(cleanupN8nMediaTask(mismatchedTask)).rejects.toThrow(/不匹配/)
    await expect(stat(mismatchedWorkspace)).resolves.toBeTruthy()
  })
})
