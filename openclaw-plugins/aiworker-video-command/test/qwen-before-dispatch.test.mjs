import { describe, expect, it, vi } from 'vitest'

import { deriveTelegramSenderHash } from '../lib/dispatch-identity.js'
import {
  createQwenBeforeDispatchHandler,
  isClassifierCandidate,
  validateDecision,
} from '../lib/qwen-before-dispatch.js'

const senderId = 'telegram:123456'
const allowedSenderSha256 = deriveTelegramSenderHash(senderId)
const sessionKey = 'agent:second-original:telegram:direct:123456'

function event(overrides = {}) {
  return {
    content: '帮我学习视频 "/data/地球之极 第二集.mp4"',
    channel: 'telegram',
    isGroup: false,
    sessionKey,
    senderId,
    timestamp: 1_786_240_000_123,
    ...overrides,
  }
}

const context = {
  channelId: 'telegram',
  sessionKey,
  senderId,
  accountId: 'account',
  conversationId: 'conversation',
}

function handler({ classifier, runner, senderHash = allowedSenderSha256, releaseReady = true } = {}) {
  return createQwenBeforeDispatchHandler({
    classifier: classifier ?? vi.fn(async () => ({
      action: 'dispatch_single', value: '/data/地球之极 第二集.mp4',
    })),
    runner: runner ?? {},
    allowedSenderSha256: senderHash,
    releaseReady,
  })
}

describe('hook-owned Qwen video scheduler', () => {
  it('passes ordinary chat without calling the classifier', async () => {
    const classifier = vi.fn()
    expect(handler({ classifier })(event({ content: '你好' }), context)).toBeUndefined()
    expect(classifier).not.toHaveBeenCalled()
  })

  it('lets a path-only non-action question pass, but fails closed if Qwen passes an execution shape', async () => {
    const classifier = vi.fn(async () => ({ action: 'pass', value: '' }))
    const beforeDispatch = handler({ classifier })

    await expect(beforeDispatch(event({ content: '这个文件 /data/test.mp4 是什么' }), context))
      .resolves.toBeUndefined()
    await expect(beforeDispatch(event({
      content: '请帮我学习 /data/test.mp4',
      timestamp: event().timestamp + 1,
    }), context)).resolves.toEqual({
      handled: true,
      text: '未执行：暂时无法理解这个视频请求。',
    })
  })

  it('classifies one authorized Telegram DM then dispatches one file', async () => {
    const classifier = vi.fn(async () => ({
      action: 'dispatch_single', value: '/data/地球之极 第二集.mp4',
    }))
    const runner = {
      dispatchVideo: vi.fn(async ({ taskId }) => ({
        kind: 'task', id: taskId, status: 'queued', duplicate: false,
      })),
    }
    const result = await handler({ classifier, runner })(event(), context)

    expect(classifier).toHaveBeenCalledOnce()
    expect(runner.dispatchVideo).toHaveBeenCalledOnce()
    expect(runner.dispatchVideo).toHaveBeenCalledWith({
      videoPath: '/data/地球之极 第二集.mp4',
      taskId: expect.stringMatching(/^video-natural-[a-f0-9]{64}$/u),
    })
    expect(result).toEqual({
      handled: true,
      text: expect.stringMatching(/^已提交，任务编号：video-natural-[a-f0-9]{64}。结果请稍后查询。$/u),
    })
  })

  it('keeps authorized video requests closed while the release gate is disabled', async () => {
    const classifier = vi.fn()
    const runner = { dispatchVideo: vi.fn(), taskStatus: vi.fn() }

    await expect(handler({ classifier, runner, releaseReady: false })(event(), context)).resolves.toEqual({
      handled: true,
      text: '视频学习服务正在发布维护，请稍后再试。',
    })
    expect(classifier).not.toHaveBeenCalled()
    expect(runner.dispatchVideo).not.toHaveBeenCalled()
    expect(runner.taskStatus).not.toHaveBeenCalled()
  })

  it('shares one promise, classifier call, runner call and stable id for an inbound replay', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    const classifier = vi.fn(async () => ({ action: 'dispatch_single', value: '/data/test.mp4' }))
    const runner = {
      dispatchVideo: vi.fn(async ({ taskId }) => {
        await gate
        return { kind: 'task', id: taskId, status: 'queued', duplicate: false }
      }),
    }
    const beforeDispatch = handler({ classifier, runner })
    const inbound = event({ content: '学习视频 /data/test.mp4' })
    const first = beforeDispatch(inbound, context)
    const second = beforeDispatch(inbound, context)

    expect(first).toBe(second)
    release()
    const [left, right] = await Promise.all([first, second])
    expect(left).toEqual(right)
    expect(classifier).toHaveBeenCalledOnce()
    expect(runner.dispatchVideo).toHaveBeenCalledOnce()
  })

  it('dispatches a directory once and returns a batch receipt', async () => {
    const classifier = vi.fn(async () => ({ action: 'dispatch_directory', value: '/data/series-one' }))
    const runner = {
      dispatchDirectory: vi.fn(async ({ batchId }) => ({
        kind: 'batch', id: batchId, status: 'queued', duplicate: false,
      })),
    }
    const result = await handler({ classifier, runner })(event({
      content: '学习这个视频目录 "/data/series-one"',
    }), context)

    expect(runner.dispatchDirectory).toHaveBeenCalledWith({
      videoDirectory: '/data/series-one',
      batchId: expect.stringMatching(/^video-batch-[a-f0-9]{64}$/u),
    })
    expect(result.text).toMatch(/^已加入学习队列，批次编号：video-batch-[a-f0-9]{64}。/u)
  })

  it('reads task or batch status exactly once by an explicit full id', async () => {
    const taskId = `video-natural-${'a'.repeat(64)}`
    const batchId = `video-batch-${'b'.repeat(64)}`
    const runner = {
      taskStatus: vi.fn(async () => ({ kind: 'task', id: taskId, status: 'running', summary: null })),
      batchStatus: vi.fn(async () => ({
        kind: 'batch', id: batchId, status: 'running', total: 3, counts: { succeeded: 1 },
      })),
    }

    await handler({ classifier: vi.fn(async () => ({ action: 'status_task', value: taskId })), runner })(
      event({ content: `查询任务进度 ${taskId}` }), context,
    )
    await handler({ classifier: vi.fn(async () => ({ action: 'status_batch', value: batchId })), runner })(
      event({ content: `查询批次进度 ${batchId}` }), context,
    )

    expect(runner.taskStatus).toHaveBeenCalledOnce()
    expect(runner.batchStatus).toHaveBeenCalledOnce()
  })

  it('formats an automatic batch recovery without exposing raw state details', async () => {
    const batchId = `video-batch-${'c'.repeat(64)}`
    const runner = {
      batchStatus: vi.fn(async () => ({
        kind: 'batch', id: batchId, status: 'recovering', total: 3,
        counts: { succeeded: 1, failed: 0 },
      })),
    }
    const result = await handler({
      classifier: vi.fn(async () => ({ action: 'status_batch', value: batchId })),
      runner,
    })(event({ content: `查询批次进度 ${batchId}` }), context)

    expect(result).toEqual({ handled: true, text: '批次恢复中；已结束 1/3。' })
    expect(runner.batchStatus).toHaveBeenCalledOnce()
  })

  it.each([
    ['classifier throw', vi.fn(async () => { throw new Error('secret') })],
    ['invalid decision', vi.fn(async () => ({ action: 'dispatch_single', value: '/data/other.mp4' }))],
  ])('fails closed inside the hook on %s', async (_name, classifier) => {
    const runner = { dispatchVideo: vi.fn() }
    const result = await handler({ classifier, runner })(event(), context)
    expect(result).toEqual({ handled: true, text: '未执行：暂时无法理解这个视频请求。' })
    expect(runner.dispatchVideo).not.toHaveBeenCalled()
  })

  it('returns the stable task id as unconfirmed and redacts a runner exception', async () => {
    const runner = { dispatchVideo: vi.fn(async () => { throw new Error('/secret/path stderr') }) }
    const result = await handler({ runner })(event(), context)
    expect(result).toEqual({
      handled: true,
      text: expect.stringMatching(
        /^提交状态未确认，任务编号：video-natural-[a-f0-9]{64}。请稍后按编号查询，不要重复提交。$/u,
      ),
    })
    expect(JSON.stringify(result)).not.toContain('/secret/path')
  })

  it('returns the stable batch id as unconfirmed without retrying or querying', async () => {
    const classifier = vi.fn(async () => ({
      action: 'dispatch_directory', value: '/data/series-one',
    }))
    const runner = {
      dispatchDirectory: vi.fn(async () => { throw new Error('ambiguous enqueue') }),
      batchStatus: vi.fn(),
    }
    const result = await handler({ classifier, runner })(event({
      content: '学习这个视频目录 "/data/series-one"',
    }), context)

    expect(runner.dispatchDirectory).toHaveBeenCalledOnce()
    expect(runner.batchStatus).not.toHaveBeenCalled()
    expect(result.text).toMatch(
      /^入队状态未确认，批次编号：video-batch-[a-f0-9]{64}。/u,
    )
  })

  it('does not let an untrusted, group, non-target, or inconsistent DM reach Qwen', async () => {
    const classifier = vi.fn()
    const beforeDispatch = handler({ classifier })
    const cases = [
      [event({ isGroup: true }), context, '未执行：仅支持 Telegram 私聊。'],
      [event(), { ...context, sessionKey: 'different' }, '未执行：消息上下文不一致。'],
      [event({ sessionKey: 'agent:other:telegram:direct:123456' }), {
        ...context, sessionKey: 'agent:other:telegram:direct:123456',
      }, null],
      [event({ senderId: 'telegram:999' }), { ...context, senderId: 'telegram:999' }, {
        handled: true, text: '未执行：当前发送者没有视频调度权限。',
      }.text],
    ]
    for (const [inbound, ctx, expectedText] of cases) {
      const result = await beforeDispatch(inbound, ctx)
      expect(result).toEqual(expectedText === null ? undefined : { handled: true, text: expectedText })
    }
    expect(classifier).not.toHaveBeenCalled()
  })

  it('uses host validation to reject negative, altered, multiple and mode-confused values', () => {
    expect(validateDecision(
      { action: 'dispatch_single', value: '/data/test.mp4' },
      '不要执行，学习视频 /data/test.mp4',
    )).toEqual({ action: 'respond' })
    expect(validateDecision(
      { action: 'dispatch_single', value: '/data/other.mp4' },
      '学习视频 /data/test.mp4',
    )).toBeNull()
    expect(validateDecision(
      { action: 'dispatch_single', value: '/data/a.mp4' },
      '学习视频 /data/a.mp4 和 /data/b.mp4',
    )).toBeNull()
    expect(validateDecision(
      { action: 'dispatch_directory', value: '/data/series' },
      '学习视频 /data/series',
    )).toBeNull()
    expect(validateDecision(
      { action: 'dispatch_single', value: '/data/a.mp4' },
      '只分析画面 /data/a.mp4',
    )).toEqual({ action: 'respond' })
    expect(validateDecision(
      { action: 'dispatch_single', value: '/data/a.mp4' },
      '只分析这个视频 /data/a.mp4',
    )).toEqual({ action: 'dispatch_single', videoPath: '/data/a.mp4' })
    expect(validateDecision(
      { action: 'dispatch_single', value: '/data/series episode.mp4' },
      '学习视频 /data/series episode.mp4',
    )).toBeNull()
    expect(validateDecision(
      { action: 'dispatch_single', value: '/tmp/a.mp4' },
      '学习视频 abc/tmp/a.mp4',
    )).toBeNull()
  })

  it('keeps the structural candidate gate broad but excludes ordinary chat', () => {
    expect(isClassifierCandidate('请学习视频 /data/a.mp4')).toBe(true)
    expect(isClassifierCandidate('请帮我学习 /data/a.mp4')).toBe(true)
    expect(isClassifierCandidate(`查询任务进度 video-natural-${'a'.repeat(64)}`)).toBe(true)
    expect(isClassifierCandidate('今天天气如何')).toBe(false)
  })
})
