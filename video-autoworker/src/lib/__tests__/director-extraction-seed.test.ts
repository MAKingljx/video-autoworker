import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildDirectorExtractionHistorySeed,
  directorExtractionSeedDigest,
} from '@/lib/director-extraction-seed'

interface PerceptionFixture {
  summary: string
  people: unknown
  locations: unknown
  actions: unknown
  objects: unknown
  environment: unknown
  ocr: unknown
  shotTypes: unknown
  cameraMovement: unknown
  composition: unknown
  emotion: unknown
  extra?: unknown
}

interface HistorySourceFixture {
  workId: string
  sourceTaskId: string
  sourceResultSha256: string
  output: {
    taskType: string
    materialId: string
    analysisVersion: string
    mediaDurationSeconds: number
    summary?: string
    combinedText?: string
    transcript: string
    audio: { transcript: string }
    chapters: Array<Record<string, unknown>>
    timeline: Array<{
      index: number
      timeRange: string
      transcript: string
      visualAnalysis: string
      confidence: number
      perception?: PerceptionFixture
    }>
    directorPerception?: PerceptionFixture & {
      sound: {
        speechSummary: unknown
        ambientSound: unknown
        music: unknown
        emotion: unknown
      }
    }
  }
}

function source(): HistorySourceFixture {
  return {
    workId: 'WORK-EARTH-001',
    sourceTaskId: 'earth-pole-s1e1',
    sourceResultSha256: 'a'.repeat(64),
    output: {
      taskType: 'video-analysis',
      materialId: 'MAT-EARTH-S1E1',
      analysisVersion: 'video-analysis-v3',
      mediaDurationSeconds: 2220,
      summary: '高原旅程与人物选择。',
      transcript: '不应进入提炼种子',
      audio: { transcript: '完整转写也不应进入提炼种子' },
      chapters: [{
        index: 1,
        startTime: '00:00:00',
        endTime: '00:05:00',
        summary: '进入高原',
        confidence: 0.9,
      }],
      timeline: [{
        index: 1,
        timeRange: '00:00:00-00:01:00',
        transcript: '逐分钟转写不应复制',
        visualAnalysis: '人物沿山路前行。',
        confidence: 0.8,
      }],
    },
  }
}

function perception(overrides: Partial<PerceptionFixture> = {}): PerceptionFixture {
  return {
    summary: '人物沿山路前行。',
    people: ['小林'],
    locations: ['高原山路'],
    actions: ['步行'],
    objects: ['背包'],
    environment: ['薄雾'],
    ocr: ['海拔 4200 米'],
    shotTypes: ['全景'],
    cameraMovement: ['跟拍'],
    composition: ['人物位于画面左侧'],
    emotion: ['克制'],
    ...overrides,
  }
}

function structuredSource(): HistorySourceFixture {
  const value = source()
  value.output.timeline[0]!.perception = perception({
    people: ['小林', ' 小林 '],
    locations: ['高原山路', '/Volumes/private/raw.mov'],
    ocr: ['https://example.test/private', 'api_key=top-secret-value'],
  })
  value.output.directorPerception = {
    ...perception({ summary: value.output.summary, people: ['小林', '小林'] }),
    sound: {
      speechSummary: '人物讨论路线，不保留逐字稿。',
      ambientSound: '风声；源文件 /Users/operator/raw.wav',
      music: null,
      emotion: '紧张，Authorization: Bearer secret-token-value',
    },
  }
  return value
}

describe('director extraction historical seed', () => {
  it('builds a deterministic bounded seed without transcript or runtime secrets', () => {
    const seed = buildDirectorExtractionHistorySeed(source())
    const serialized = JSON.stringify(seed)

    expect(seed).toMatchObject({
      schemaVersion: 2,
      projectId: 'PROJ-VIDEO-AUTOWORKER',
      workId: 'WORK-EARTH-001',
      sourceTaskId: 'earth-pole-s1e1',
    })
    expect(seed.timeline[0]?.visualSummary).toBe('人物沿山路前行。')
    expect(seed.timeline[0]?.perception).toBeNull()
    expect(seed.directorPerception).toBeNull()
    expect(serialized).not.toMatch(/逐分钟转写|完整转写|transcript/u)
    expect(directorExtractionSeedDigest(seed)).toBe(directorExtractionSeedDigest(seed))
  })

  it('includes bounded visual and sound perception while redacting sensitive values', () => {
    const seed = buildDirectorExtractionHistorySeed(structuredSource())
    const serialized = JSON.stringify(seed)

    expect(seed.timeline[0]?.perception?.people).toEqual(['小林'])
    expect(seed.directorPerception?.people).toEqual(['小林'])
    expect(seed.timeline[0]?.perception?.locations[1]).toBe('[path]')
    expect(seed.timeline[0]?.perception?.ocr).toEqual(['[link]', '[credential]'])
    expect(seed.directorPerception?.sound.speechSummary).toBe('人物讨论路线，不保留逐字稿。')
    expect(seed.directorPerception?.sound.ambientSound).toMatch(/\[path\]/u)
    expect(seed.directorPerception?.sound.emotion).toMatch(/\[credential\]/u)
    expect(serialized).not.toMatch(
      /\/Volumes\/private|\/Users\/operator|https:\/\/example\.test|top-secret-value|secret-token-value/u,
    )
  })

  it('redacts paths, links and credentials from selected summaries', () => {
    const value = source()
    value.output.summary = [
      '来自 /Users/operator/private/a.mov、https://example.test/private，',
      'api_key=summary-secret',
    ].join('')
    const summary = buildDirectorExtractionHistorySeed(value).summary

    expect(summary).toMatch(/\[path\]/u)
    expect(summary).toMatch(/\[link\]/u)
    expect(summary).toMatch(/\[credential\]/u)
    expect(summary).not.toMatch(/\/Users\/|https:\/\/|summary-secret/u)
  })

  it('redacts shared credential formats without removing ordinary terminology', () => {
    const secrets = [
      'Bearer bearer_value_12345',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signature_value_123',
      `ghu_${'U'.repeat(24)}`,
      `ghr_${'R'.repeat(24)}`,
      `github_pat_${'P'.repeat(24)}`,
      ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-'),
      'access_token=assigned-token-12345',
    ]
    for (const secret of secrets) {
      const value = source()
      value.output.summary = `摘要 ${secret}`
      const summary = buildDirectorExtractionHistorySeed(value).summary
      expect(summary, secret).toContain('[credential]')
      expect(summary, secret).not.toContain(secret)
    }

    const ordinary = source()
    ordinary.output.summary = '讨论 token 预算与故事的 key moment。'
    expect(buildDirectorExtractionHistorySeed(ordinary).summary).toBe(ordinary.output.summary)
  })

  it('fails closed on malformed structured perception', () => {
    const invalidList = structuredSource()
    invalidList.output.timeline[0]!.perception!.people = '小林'
    expect(() => buildDirectorExtractionHistorySeed(invalidList))
      .toThrow(/director_extraction_timeline_perception_1_people_invalid/u)

    const unexpected = structuredSource()
    unexpected.output.timeline[0]!.perception!.extra = []
    expect(() => buildDirectorExtractionHistorySeed(unexpected))
      .toThrow(/director_extraction_timeline_perception_1_field_unexpected:extra/u)

    const malformedSound = structuredSource()
    malformedSound.output.directorPerception!.sound.music = []
    expect(() => buildDirectorExtractionHistorySeed(malformedSound))
      .toThrow(/director_extraction_director_perception_sound_music_invalid/u)
  })

  it('rejects structured field count and text limits instead of truncating', () => {
    const tooMany = structuredSource()
    tooMany.output.timeline[0]!.perception!.people = Array.from(
      { length: 21 },
      (_, index) => `人物 ${index + 1}`,
    )
    expect(() => buildDirectorExtractionHistorySeed(tooMany))
      .toThrow(/director_extraction_timeline_perception_1_people_too_many/u)

    const itemTooLong = structuredSource()
    itemTooLong.output.timeline[0]!.perception!.people = ['人'.repeat(161)]
    expect(() => buildDirectorExtractionHistorySeed(itemTooLong))
      .toThrow(/director_extraction_timeline_perception_1_people_1_too_long/u)

    const soundTooLong = structuredSource()
    soundTooLong.output.directorPerception!.sound.speechSummary = '声'.repeat(1_001)
    expect(() => buildDirectorExtractionHistorySeed(soundTooLong))
      .toThrow(/director_extraction_director_perception_sound_speechSummary_too_long/u)
  })

  it('rejects structured summaries that conflict with governed summaries', () => {
    const timelineMismatch = structuredSource()
    timelineMismatch.output.timeline[0]!.perception!.summary = '另一个画面。'
    expect(() => buildDirectorExtractionHistorySeed(timelineMismatch))
      .toThrow(/director_extraction_timeline_perception_1_summary_mismatch/u)

    const directorMismatch = structuredSource()
    directorMismatch.output.directorPerception!.summary = '另一个全片摘要。'
    expect(() => buildDirectorExtractionHistorySeed(directorMismatch))
      .toThrow(/director_extraction_director_perception_summary_mismatch/u)
  })

  it('fails closed on non-video results and absent governed evidence', () => {
    const nonVideo = source()
    nonVideo.output.taskType = 'general'
    expect(() => buildDirectorExtractionHistorySeed(nonVideo))
      .toThrow(/director_extraction_task_type_invalid/u)

    const withoutEvidence = source()
    withoutEvidence.output.chapters = []
    withoutEvidence.output.timeline = []
    expect(() => buildDirectorExtractionHistorySeed(withoutEvidence))
      .toThrow(/director_extraction_evidence_missing/u)
  })

  it('never falls back to combinedText when the governed summary is missing', () => {
    const value = source()
    delete value.output.summary
    value.output.combinedText = '语音：这是完整原始逐字转写'
    expect(() => buildDirectorExtractionHistorySeed(value))
      .toThrow(/director_extraction_summary_missing/u)
  })

  it('rejects an oversized seed after all per-field limits are applied', () => {
    const value = source()
    value.output.chapters = []
    value.output.timeline = Array.from({ length: 100 }, (_, index) => ({
      index: index + 1,
      timeRange: `00:00:${String(index).padStart(2, '0')}`,
      transcript: '不得复制',
      visualAnalysis: `镜头 ${index + 1}：${'画'.repeat(3_000)}`,
      confidence: 0.9,
    }))
    expect(() => buildDirectorExtractionHistorySeed(value))
      .toThrow(/director_extraction_seed_too_large/u)
  })

  it('lives in the application layer without an OpenClaw skill dependency', () => {
    const implementation = readFileSync(
      join(process.cwd(), 'src/lib/director-extraction-seed.ts'),
      'utf8',
    )
    expect(implementation).not.toContain('openclaw-skills')
  })
})
