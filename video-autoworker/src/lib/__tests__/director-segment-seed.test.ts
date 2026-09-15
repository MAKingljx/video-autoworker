import { describe, expect, it } from 'vitest'
import { buildDirectorExtractionHistorySeed } from '@/lib/director-extraction-seed'
import { splitDirectorExtractionPhaseInput } from '@/lib/director-extraction-segments'
import { DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES } from '@/lib/director-extraction-learning'

function fixture(count: number) {
  const clock = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`
  const segments = Array.from({ length: count }, (_, offset) => {
    const summary = `第${offset + 1}段人物讨论路线。${'保留已经验证的片段事实。'.repeat(140)}`
    return {
      schema: 'video-autoworker-segment-summary', version: 1, index: offset + 1,
      startTime: clock(offset), endTime: clock(offset + 1), timeRange: `${clock(offset)}-${clock(offset + 1)}`,
      inputSha256: (offset + 1).toString(16).padStart(64, '0'), summary, confidence: 0.9,
      directorPerception: {
        summary, people: ['小林'], locations: [], actions: [], objects: [], environment: [],
        ocr: [], shotTypes: [], cameraMovement: [], composition: [], emotion: [],
        sound: { speechSummary: '讨论路线的选择。', ambientSound: null, music: null, emotion: null },
      },
    }
  })
  return {
    workId: 'WORK-SEGMENT-TEST', sourceTaskId: 'TASK-SEGMENT-TEST', sourceResultSha256: 'a'.repeat(64),
    output: {
      taskType: 'video-analysis', materialId: 'MAT-SEGMENT-TEST', analysisVersion: 'video-analysis-v3',
      mediaDurationSeconds: count * 60, summary: `已生成${count}段独立摘要。`,
      synthesis: { mode: 'segment-summaries', version: 1 },
      segmentSummaries: segments,
      chapters: segments.map(s => ({ index: s.index, startTime: s.startTime, endTime: s.endTime, summary: s.summary, confidence: s.confidence })),
      timeline: segments.map(s => ({ index: s.index, timeRange: s.timeRange, visualAnalysis: '人物站在路边。',
        transcript: '不得复制的原始转写', confidence: 0.9, segmentSummaryIndex: s.index, segmentSummaryInputSha256: s.inputSha256 })),
    },
  }
}

describe('segmented summaries in director evidence seeds', () => {
  it('retains all 200 summaries and sound facts while model inputs stay bounded', () => {
    const seed = buildDirectorExtractionHistorySeed(fixture(200))
    expect(seed.chapters).toHaveLength(200)
    expect(seed.timeline).toHaveLength(200)
    expect(seed.timeline[199].segmentPerception?.sound.speechSummary).toBe('讨论路线的选择。')
    expect(seed.timeline[199].visualSummary).toBe('人物站在路边。')
    expect(JSON.stringify(seed)).not.toContain('不得复制的原始转写')
    expect(Buffer.byteLength(JSON.stringify(seed))).toBeGreaterThan(256 * 1024)
    const batches = splitDirectorExtractionPhaseInput({ evidence: seed })
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.every(b => Buffer.byteLength(JSON.stringify(b)) <= DIRECTOR_EXTRACTION_PHASE_INPUT_MAX_BYTES)).toBe(true)
    expect(batches.flatMap(b => (b.evidence as typeof seed).timeline)).toHaveLength(200)
  })

  it('rejects a summary bound to another timeline interval or input version', () => {
    const time = fixture(2)
    time.output.segmentSummaries[0].timeRange = '00:02:00-00:03:00'
    expect(() => buildDirectorExtractionHistorySeed(time)).toThrow('binding_mismatch')
    const version = fixture(2)
    version.output.timeline[0].segmentSummaryInputSha256 = 'f'.repeat(64)
    expect(() => buildDirectorExtractionHistorySeed(version)).toThrow('binding_mismatch')
  })

  it('does not accept partial or duplicate segment identities', () => {
    const missing = fixture(2)
    missing.output.segmentSummaries.pop()
    expect(() => buildDirectorExtractionHistorySeed(missing)).toThrow('count_invalid')
    const duplicate = fixture(2)
    duplicate.output.segmentSummaries[1].index = 1
    expect(() => buildDirectorExtractionHistorySeed(duplicate)).toThrow('identity_invalid')
  })
})
