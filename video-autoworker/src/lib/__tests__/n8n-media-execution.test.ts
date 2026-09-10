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
  parseDirectorSynthesisAnswer,
  parseVisualPerceptionAnswer,
  synthesizeN8nMediaResults,
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

  function perceptionJson(summary: string) {
    return JSON.stringify({
      summary,
      people: ['向导'],
      locations: ['冰面'],
      actions: ['观察裂缝'],
      objects: ['登山杖'],
      environment: ['冰雪覆盖'],
      ocr: [],
      shotTypes: ['中景'],
      cameraMovement: ['固定镜头'],
      composition: ['人物居中'],
      emotion: ['谨慎'],
    })
  }

  function directorPerception(summary: string) {
    return {
      ...JSON.parse(perceptionJson(summary)),
      sound: {
        speechSummary: '同行者讨论安全路线',
        ambientSound: '持续风声',
        music: null,
        emotion: '紧张克制',
      },
    }
  }

  function synthesisRouting() {
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify({
      version: 1,
      resources: [],
      routes: [{
        id: 'final-summary-test', label: '全片汇总测试', description: '',
        location: 'local', transport: 'openai-compatible', model: 'final-test-model',
        baseUrl: 'http://127.0.0.1:18103/v1', enabled: true,
        capabilities: ['text', 'vision'],
      }],
    })
    return { config: { modelRouting: { nodes: { vision: { routeId: 'final-summary-test' } } } } }
  }

  async function seedSynthesisCheckpoints(
    taskId: string,
    finalSummary: Record<string, unknown>,
  ) {
    const checkpointRoot = join(mediaTaskWorkspace(taskId), 'checkpoints')
    await mkdir(checkpointRoot, { recursive: true })
    await writeFile(join(checkpointRoot, 'chapter-001.json'), JSON.stringify({
      index: 1,
      startTime: '00:00:00.000',
      endTime: '00:01:00.000',
      summary: '向导发现冰面裂缝并决定绕行。',
      confidence: 0,
    }))
    await writeFile(join(checkpointRoot, 'final-summary.json'), JSON.stringify(finalSummary))
    return checkpointRoot
  }

  function synthesisInput() {
    return {
      timeline: [{
        timeRange: '00:00:00.000-00:01:00.000',
        transcript: '前方冰面不安全。',
        visualAnalysis: '向导观察裂缝后停下。',
        confidence: 0,
      }],
      combinedText: '逐分钟证据',
    }
  }

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
      choices: [{ message: { content: perceptionJson('可复核画面事实') } }],
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

  it('parses strict structured visual perception without inventing missing fields', () => {
    const parsed = parseVisualPerceptionAnswer(`\`\`\`json\n${perceptionJson('人物停下观察')}\n\`\`\``)
    expect(parsed).toMatchObject({
      summary: '人物停下观察',
      people: ['向导'],
      locations: ['冰面'],
      actions: ['观察裂缝'],
      ocr: [],
    })
    expect(() => parseVisualPerceptionAnswer('只有自然语言')).toThrow('无法解析的结构化结果')
    expect(() => parseVisualPerceptionAnswer(JSON.stringify({
      summary: '缺少必需数组', people: [],
    }))).toThrow('不符合结构化感知契约')
  })

  it('parses a bounded whole-video director perception with governed sound summaries', () => {
    const parsed = parseDirectorSynthesisAnswer(JSON.stringify({
      ...JSON.parse(perceptionJson('人物发现危险后选择绕行')),
      sound: {
        speechSummary: '同行者讨论安全路线',
        ambientSound: '持续风声',
        music: null,
        emotion: '紧张克制',
      },
    }))
    expect(parsed.summary).toBe('人物发现危险后选择绕行')
    expect(parsed.sound).toEqual({
      speechSummary: '同行者讨论安全路线',
      ambientSound: '持续风声',
      music: null,
      emotion: '紧张克制',
    })
    expect(() => parseDirectorSynthesisAnswer(JSON.stringify({
      ...JSON.parse(perceptionJson('缺少声音对象')),
    }))).toThrow('不符合导演感知契约')

    const longWholeVideoSummary = '全片叙事信息。'.repeat(1_000)
    expect(parseDirectorSynthesisAnswer(JSON.stringify({
      ...JSON.parse(perceptionJson(longWholeVideoSummary)),
      sound: {
        speechSummary: null,
        ambientSound: null,
        music: null,
        emotion: null,
      },
    })).summary).toBe(longWholeVideoSummary)
    expect(() => parseVisualPerceptionAnswer(
      perceptionJson(longWholeVideoSummary),
    )).toThrow('不符合结构化感知契约')
  })

  it('recomputes a legacy final-summary checkpoint that has no director perception', async () => {
    const taskId = 'video-legacy-final-summary'
    const checkpointRoot = await seedSynthesisCheckpoints(taskId, {
      summary: '旧版只有文本汇总。',
    })
    const replacement = directorPerception('新版结构化导演感知。')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(replacement) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await synthesizeN8nMediaResults(
      taskId,
      synthesisRouting(),
      { prompt: '保持事实边界' },
      synthesisInput(),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({
      summary: replacement.summary,
      directorPerception: replacement,
    })
    const stored = JSON.parse(await readFile(join(checkpointRoot, 'final-summary.json'), 'utf8'))
    expect(stored).toMatchObject({
      schema: 'video-autoworker-final-summary-checkpoint',
      version: 1,
      summary: replacement.summary,
      directorPerception: replacement,
    })
  })

  it('recomputes a versioned final-summary checkpoint with incomplete director perception', async () => {
    const taskId = 'video-incomplete-final-summary'
    await seedSynthesisCheckpoints(taskId, {
      schema: 'video-autoworker-final-summary-checkpoint',
      version: 1,
      summary: '结构版本正确但内容不完整。',
      directorPerception: { summary: '结构版本正确但内容不完整。' },
    })
    const replacement = directorPerception('完整校验后自动重算。')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(replacement) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    const result = await synthesizeN8nMediaResults(
      taskId,
      synthesisRouting(),
      { prompt: '保持事实边界' },
      synthesisInput(),
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result.directorPerception).toEqual(replacement)
  })

  it('keeps the historical final-summary checkpoint intact when recomputation fails', async () => {
    const taskId = 'video-failed-final-summary-recompute'
    const legacy = { summary: '仍需保留的旧版汇总。' }
    const checkpointRoot = await seedSynthesisCheckpoints(taskId, legacy)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: '汇总模型暂时不可用' },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } }))

    await expect(synthesizeN8nMediaResults(
      taskId,
      synthesisRouting(),
      { prompt: '保持事实边界' },
      synthesisInput(),
    )).rejects.toThrow()

    await expect(readFile(join(checkpointRoot, 'final-summary.json'), 'utf8'))
      .resolves.toBe(JSON.stringify(legacy))
  })

  it('reuses only a fully valid versioned final-summary checkpoint', async () => {
    const taskId = 'video-valid-final-summary'
    const perception = directorPerception('可安全复用的导演感知。')
    await seedSynthesisCheckpoints(taskId, {
      schema: 'video-autoworker-final-summary-checkpoint',
      version: 1,
      summary: perception.summary,
      directorPerception: perception,
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const result = await synthesizeN8nMediaResults(
      taskId,
      synthesisRouting(),
      { prompt: '保持事实边界' },
      synthesisInput(),
    )

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      summary: perception.summary,
      directorPerception: perception,
    })
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
        choices: [{ message: { content: `<think>内部推理</think>${perceptionJson('备用路由画面结果')}` } }],
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

  it('uses the fallback when the primary returns HTTP 200 with invalid structured output', async () => {
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify({
      version: 1,
      resources: [],
      routes: [
        {
          id: 'vision-invalid-primary', label: '结构错误主路由', description: '',
          location: 'local', transport: 'openai-compatible', model: 'primary',
          baseUrl: 'http://127.0.0.1:18101/v1', enabled: true,
          capabilities: ['text', 'vision'],
        },
        {
          id: 'vision-valid-fallback', label: '结构正确备用路由', description: '',
          location: 'local', transport: 'openai-compatible', model: 'fallback',
          baseUrl: 'http://127.0.0.1:18102/v1', enabled: true,
          capabilities: ['text', 'vision'],
        },
      ],
    })
    const taskId = 'video-structured-fallback-test'
    const workspace = mediaTaskWorkspace(taskId)
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'frame-001.jpg'), 'frame-one')
    await writeFile(join(workspace, 'metadata.json'), JSON.stringify({
      taskId,
      kind: 'prepared-video',
      durationSeconds: 60,
      sourceBytes: 100,
      audioAvailable: false,
      frameCount: 1,
      segmentCount: 1,
      segmentSeconds: 60,
      memoryMode: 'none',
      preparedAt: new Date().toISOString(),
      segments: [{
        index: 1, startSeconds: 0, durationSeconds: 60,
        audioFile: null, frameFiles: ['frame-001.jpg'],
      }],
    }))
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async input => (
      String(input).includes(':18101/')
        ? new Response(JSON.stringify({
            choices: [{ message: { content: '这不是结构化 JSON' } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({
            choices: [{ message: { content: perceptionJson('备用路由修复结构错误') } }],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    ))

    const result = await analyzeN8nVideoFrames(taskId, {
      config: { modelRouting: { nodes: { vision: {
        routeId: 'vision-invalid-primary', fallbackRouteIds: ['vision-valid-fallback'],
      } } } },
    }, { prompt: '验证结构化回退' })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      routeId: 'vision-valid-fallback', fallbackUsed: true, model: 'fallback',
    })
    expect(result.analysis).toContain('备用路由修复结构错误')
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
