import { describe, expect, it, vi } from 'vitest'

import {
  createQwenClassifier,
  parseQwenClassifierResult,
} from '../lib/qwen-video-classifier.js'

describe('Qwen one-shot classifier', () => {
  it('uses one no-tool completion pinned to second-original without a model override', async () => {
    const complete = vi.fn(async () => ({
      text: '{"action":"dispatch_single","value":"/data/test.mp4"}',
      agentId: 'second-original',
    }))
    const classifier = createQwenClassifier({ complete, timeoutMs: 1_000 })

    await expect(classifier('学习视频 /data/test.mp4')).resolves.toEqual({
      action: 'dispatch_single', value: '/data/test.mp4',
    })
    expect(complete).toHaveBeenCalledOnce()
    expect(complete.mock.calls[0][0].agentId).toBe('second-original')
    expect(complete.mock.calls[0][0]).not.toHaveProperty('model')
    expect(complete.mock.calls[0][0]).not.toHaveProperty('tools')
    expect(complete.mock.calls[0][0].temperature).toBe(0)
    expect(complete.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal)
    expect(complete.mock.calls[0][0].systemPrompt).toContain('最小且唯一的标题、文件名、季集号或关键词（例如 S03E03）')
    expect(complete.mock.calls[0][0].systemPrompt).toContain('不得加入旧上下文、改写或补全')
    expect(complete.mock.calls[0][0].systemPrompt).toContain('directorWork 只能用于 dispatch_single')
    expect(complete.mock.calls[0][0].systemPrompt).toContain('必须从当前消息逐字复制')
  })

  it('accepts a title or keyword copied from the current message for status search', () => {
    expect(parseQwenClassifierResult(
      '{"action":"status_search","value":"《地球之极》第三季第三集"}',
    )).toEqual({
      action: 'status_search', value: '《地球之极》第三季第三集',
    })
  })

  it('accepts an optional director-work name only for a single-video dispatch', () => {
    expect(parseQwenClassifierResult(
      '{"action":"dispatch_single","value":"/data/test.mp4","directorWork":"导演脑验收片"}',
    )).toEqual({
      action: 'dispatch_single', value: '/data/test.mp4', directorWork: '导演脑验收片',
    })
    const longestName = '片'.repeat(240)
    expect(parseQwenClassifierResult(JSON.stringify({
      action: 'dispatch_single', value: '/data/test.mp4', directorWork: longestName,
    })).directorWork).toBe(longestName)
    expect(() => parseQwenClassifierResult(JSON.stringify({
      action: 'dispatch_single', value: '/data/test.mp4', directorWork: `${longestName}片`,
    }))).toThrow('classifier_invalid')
  })

  it('accepts the separate complete-report classification', () => {
    expect(parseQwenClassifierResult(
      '{"action":"result_search","value":"《地球之极》第三季第三集"}',
    )).toEqual({
      action: 'result_search', value: '《地球之极》第三季第三集',
    })
  })

  it.each([
    ['markdown', '```json\n{"action":"pass","value":""}\n```'],
    ['multiline', '{"action":"pass",\n"value":""}'],
    ['null', 'null'],
    ['unknown action', '{"action":"execute","value":"/data/test.mp4"}'],
    ['extra field', '{"action":"pass","value":"","extra":true}'],
    ['director work on another action', '{"action":"dispatch_directory","value":"/data","directorWork":"验收片"}'],
    ['blank director work', '{"action":"dispatch_single","value":"/data/test.mp4","directorWork":" "}'],
    ['nonempty pass', '{"action":"pass","value":"x"}'],
  ])('rejects %s output', (_name, text) => {
    expect(() => parseQwenClassifierResult(text)).toThrow('classifier_invalid')
  })

  it('converts provider errors into one classifier failure', async () => {
    const classifier = createQwenClassifier({
      complete: vi.fn(async () => { throw new Error('provider secret') }),
      timeoutMs: 1_000,
    })
    await expect(classifier('学习视频 /data/test.mp4')).rejects.toThrow('classifier_failed')
  })

  it('fails closed when the host attributes the completion to another agent', async () => {
    const classifier = createQwenClassifier({
      complete: vi.fn(async () => ({
        text: '{"action":"pass","value":""}',
        agentId: 'main',
      })),
      timeoutMs: 1_000,
    })
    await expect(classifier('学习视频 /data/test.mp4')).rejects.toThrow('classifier_failed')
  })
})
