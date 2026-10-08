import { describe, expect, it } from 'vitest'
import { normalizeN8nMediaConfig, parseN8nMediaConfig, setN8nLearningWindow, snapshotN8nMediaRouting } from '@/lib/n8n-media-config'
import { n8nWorkflowBindingInputSchema } from '@/lib/n8n-workflows'

describe('shared learning window configuration', () => {
  it('keeps the default at five and accepts integer windows including three', () => {
    expect(parseN8nMediaConfig({}).segmentSeconds).toBe(5)
    for (const seconds of [1, 3, 5, 60, 300]) {
      expect(setN8nLearningWindow({}, String(seconds)).media).toMatchObject({ segmentSeconds: seconds })
    }
  })

  it.each(['', ' ', 'bad', 0, -1, 3.5, 301, null, true, Infinity])('rejects invalid window %s at save and execution', value => {
    const config = { media: { segmentSeconds: value } }
    expect(() => parseN8nMediaConfig(config)).toThrow()
    expect(n8nWorkflowBindingInputSchema.safeParse({ name: '学习', webhookPath: 'webhook/video', taskType: 'video-analysis', config }).success).toBe(false)
  })

  it('rejects invalid media objects, unknown fields and overlap reaching the window', () => {
    for (const media of [null, [], 3, { typo: 3 }, { segmentSeconds: 3, segmentOverlapSeconds: 3 }]) {
      expect(() => parseN8nMediaConfig({ media })).toThrow()
    }
    expect(parseN8nMediaConfig({ media: { segmentSeconds: 3, segmentOverlapSeconds: 2 } }).segmentSeconds).toBe(3)
  })

  it('has one authoritative media configuration and preserves unrelated settings', () => {
    const original = { segmentSeconds: 60, segmentOverlapSeconds: 5, modelRouting: { nodes: { vision: { routeId: 'vision' } } }, media: { language: 'en', segmentSeconds: 5, maxFileBytes: 100, frameWidth: 640 } }
    const next = setN8nLearningWindow(original, 3)
    expect(next).not.toHaveProperty('segmentSeconds')
    expect(next).not.toHaveProperty('segmentOverlapSeconds')
    expect(next.modelRouting).toEqual(original.modelRouting)
    expect(next.media).toMatchObject({ segmentSeconds: 3, language: 'en', frameWidth: 640 })
    expect(next.media).not.toHaveProperty('maxFileBytes')
    expect(original.media.segmentSeconds).toBe(5)
    expect(normalizeN8nMediaConfig(next)).toEqual(next)
    expect(setN8nLearningWindow({ media: { segmentSeconds: 0, language: 'en' } }, 5).media).toMatchObject({ segmentSeconds: 5, language: 'en' })
  })

  it('freezes effective defaults in new video routing and leaves general routing untouched', () => {
    const binding = { taskType: 'video-analysis', config: { media: { segmentSeconds: 5 } } }
    const admitted = snapshotN8nMediaRouting(binding)
    binding.config.media.segmentSeconds = 3
    expect(admitted.config).toMatchObject({ media: { segmentSeconds: 5, segmentOverlapSeconds: 0 } })
    expect(snapshotN8nMediaRouting({ taskType: 'video-analysis' }).config).toMatchObject({ media: { segmentSeconds: 5 } })
    const general = { taskType: 'general', config: { media: { custom: true } } }
    expect(snapshotN8nMediaRouting(general)).toBe(general)
  })
})
