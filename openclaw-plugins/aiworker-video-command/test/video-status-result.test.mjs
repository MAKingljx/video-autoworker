import { describe, expect, it } from 'vitest'

import { formatVideoStatusReply, normalizeVideoStatusResult } from '../lib/video-status-result.js'

const TASK_ID = `video-command-${'c'.repeat(64)}`

describe('video status result', () => {
  it.each([
    ['queued', '任务已受理，正在等待处理。'],
    ['accepted', '任务已受理，正在等待处理。'],
    ['running', '任务正在处理中。'],
    ['succeeded', '任务已完成。'],
    ['failed', '任务处理失败。'],
    ['cancelled', '任务处理失败。'],
  ])('formats status=%s without repeating a long task id', (status, reply) => {
    const result = { taskId: TASK_ID, status }
    expect(formatVideoStatusReply(result, TASK_ID)).toBe(reply)
    expect(formatVideoStatusReply(result, TASK_ID)).not.toContain(TASK_ID)
  })

  it('adds only a normalized and bounded output.summary on success', () => {
    const summary = `# 报告\n**一句话结论** ${'画面内容'.repeat(40)}`
    const normalized = normalizeVideoStatusResult({
      taskId: TASK_ID,
      status: 'succeeded',
      output: { summary },
    }, TASK_ID)
    const reply = formatVideoStatusReply(normalized, TASK_ID)

    expect(reply).toMatch(/^任务已完成。摘要：报告 一句话结论 画面内容/u)
    expect(reply).toMatch(/…$/u)
    expect(reply.length).toBeLessThanOrEqual(134)
  })

  it('rejects an unnormalized result at the formatter boundary', () => {
    expect(() => formatVideoStatusReply({
      taskId: TASK_ID,
      status: 'succeeded',
      output: { summary: 'raw output must not cross this boundary' },
    }, TASK_ID)).toThrow('invalid_normalized_video_status_result')
  })

  it('rejects invalid metadata even when task and status look plausible', () => {
    expect(() => normalizeVideoStatusResult({
      taskId: TASK_ID,
      status: 'running',
      attemptCount: -1,
    }, TASK_ID)).toThrow('invalid_video_status_result')
    expect(() => normalizeVideoStatusResult({
      taskId: TASK_ID,
      status: 'running',
      error: { secret: true },
    }, TASK_ID)).toThrow('invalid_video_status_result')
  })
})
