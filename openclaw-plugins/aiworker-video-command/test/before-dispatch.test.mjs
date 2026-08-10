import { describe, expect, it, vi } from 'vitest'

import { createBeforeDispatchHandler } from '../lib/before-dispatch.js'
import { deriveTelegramSenderHash } from '../lib/dispatch-identity.js'
import { MANAGED_VIDEO_EXPLANATION_TEXT } from '../lib/video-request-router.js'

function event(overrides = {}) {
  return {
    content: '分析视频 "/Users/Shared/中文 素材/样片 (终版).mp4"',
    body: 'structured agent body',
    channel: 'telegram',
    isGroup: false,
    sessionKey: 'agent:second-original:telegram:direct:owner',
    senderId: 'sender-id',
    timestamp: 1_786_240_000_123,
    ...overrides,
  }
}

const context = {
  channelId: 'telegram',
  accountId: 'account-id',
  conversationId: 'conversation-id',
  sessionKey: 'agent:second-original:telegram:direct:owner',
  senderId: 'sender-id',
}

function acceptedRunner() {
  return vi.fn(async ({ taskId }) => ({ taskId, status: 'accepted', duplicate: false }))
}

function createHandler(runner, senderId = event().senderId) {
  return createBeforeDispatchHandler({
    runner,
    allowedSenderSha256: deriveTelegramSenderHash(senderId),
  })
}

describe('before_dispatch handler', () => {
  it('submits an exact command once and returns only safe task fields', async () => {
    const runner = acceptedRunner()
    const handler = createHandler(runner)
    const result = await handler(event(), context)

    expect(result.handled).toBe(true)
    expect(result.text).toMatch(
      /^已提交，任务编号：video-command-[a-f0-9]{64}。结果请稍后查询。$/u,
    )
    expect(result.text).not.toContain('/Users/Shared')
    expect(result.text).not.toContain('account-id')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledWith({
      videoPath: '/Users/Shared/中文 素材/样片 (终版).mp4',
      taskId: expect.stringMatching(/^video-command-[a-f0-9]{64}$/u),
    })
  })

  it('submits an affirmative natural-language request through the same runner', async () => {
    const runner = acceptedRunner()
    const handler = createHandler(runner)
    const result = await handler(event({
      content: '帮我分析一下这个视频 `/Users/Shared/中文 素材/样片 (终版).mp4`',
    }), context)

    expect(result.text).toMatch(
      /^已提交，任务编号：video-natural-[a-f0-9]{64}。结果请稍后查询。$/u,
    )
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledWith({
      videoPath: '/Users/Shared/中文 素材/样片 (终版).mp4',
      taskId: expect.stringMatching(/^video-natural-[a-f0-9]{64}$/u),
    })
  })

  it.each([
    '只分析一下这个视频 /tmp/a.mp4',
    '仅分析这个视频 /tmp/a.mp4',
  ])('keeps an exclusive full-video wording affirmative: %s', async content => {
    const runner = acceptedRunner()
    const handler = createHandler(runner)

    await expect(handler(event({ content }), context)).resolves.toEqual({
      handled: true,
      text: expect.stringMatching(/^已提交，任务编号：video-natural-[a-f0-9]{64}。结果请稍后查询。$/u),
    })
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner).toHaveBeenCalledWith({
      videoPath: '/tmp/a.mp4',
      taskId: expect.stringMatching(/^video-natural-[a-f0-9]{64}$/u),
    })
  })

  it.each([
    '帮我分析一下这个视频 /tmp/demo.mp4，不要等待',
    '帮我分析一下这个视频 /tmp/demo.mp4，不要一直盯着',
    '帮我分析一下这个视频 /tmp/demo.mp4，不要回投',
    '帮我分析一下这个视频 /tmp/demo.mp4，不用回复结果',
    '帮我分析一下这个视频 /tmp/demo.mp4，先提交再说',
    '不要等待，帮我分析一下这个视频 /tmp/demo.mp4',
    '不要一直盯着，帮我分析一下这个视频 /tmp/demo.mp4',
    '不要回投，帮我分析一下这个视频 /tmp/demo.mp4',
    '不用回复结果，帮我分析一下这个视频 /tmp/demo.mp4',
  ])('treats asynchronous interaction preferences as one valid submit: %s', async content => {
    const runner = acceptedRunner()
    const handler = createHandler(runner)

    await expect(handler(event({ content }), context)).resolves.toEqual({
      handled: true,
      text: expect.stringMatching(/^已提交，任务编号：video-natural-[a-f0-9]{64}。结果请稍后查询。$/u),
    })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('derives one replay-stable idempotency identity per inbound message', async () => {
    const runner = vi.fn(async ({ taskId }, index) => ({
      taskId,
      status: 'accepted',
      duplicate: index > 0,
    }))
    const handler = createHandler(runner)
    const inbound = event({ content: '请帮我分析这个视频 /tmp/demo.mp4' })

    await handler(inbound, context)
    await handler(inbound, context)

    expect(runner).toHaveBeenCalledTimes(2)
    expect(runner.mock.calls[0][0].taskId).toBe(runner.mock.calls[1][0].taskId)
    expect(runner.mock.calls[0][0].taskId).toMatch(/^video-natural-[a-f0-9]{64}$/u)
    expect(runner.mock.calls[0][0].videoPath).toBe('/tmp/demo.mp4')
    expect(runner.mock.calls[1][0].videoPath).toBe('/tmp/demo.mp4')
  })

  it('passes only unrelated input to the normal model dispatcher', async () => {
    const runner = vi.fn()
    const handler = createHandler(runner)

    await expect(handler(event({ content: '你好' }), context)).resolves.toBeUndefined()
    for (const content of [
      '请分析视频号的运营数据',
      '帮我分析视频会议安排',
      '分析视频编码原理',
    ]) {
      await expect(handler(event({ content }), context)).resolves.toBeUndefined()
    }
    expect(runner).not.toHaveBeenCalled()
  })

  it.each([
    ['先告诉我如何分析这个视频 /tmp/demo.mp4', MANAGED_VIDEO_EXPLANATION_TEXT],
    ['这个视频能分析吗 /tmp/demo.mp4', MANAGED_VIDEO_EXPLANATION_TEXT],
    ['帮我分析这个视频，但不要执行 /tmp/demo.mp4', '好的，本次不会提交视频任务。需要执行时，请重新发送明确请求和一个本机绝对视频路径。'],
    ['如果我确认了再分析这个视频 /tmp/demo.mp4', '好的，本次不会提交视频任务。需要执行时，请重新发送明确请求和一个本机绝对视频路径。'],
    ['比如用“帮我分析 /tmp/demo.mp4”作为示例', '好的，本次不会提交视频任务。需要执行时，请重新发送明确请求和一个本机绝对视频路径。'],
    ['刚才我说帮我分析这个视频 /tmp/demo.mp4', '好的，本次不会提交视频任务。需要执行时，请重新发送明确请求和一个本机绝对视频路径。'],
  ])('handles video conversation without invoking the model or runner: %s', async (content, text) => {
    const runner = vi.fn()
    const handler = createHandler(runner)

    await expect(handler(event({ content }), context)).resolves.toEqual({ handled: true, text })
    expect(runner).not.toHaveBeenCalled()
  })

  it.each([
    ['分析视频', '未提交：视频命令或路径无效。'],
    ['分析视频\u00a0/tmp/demo.mp4', '未提交：视频命令或路径无效。'],
    ['分析视频\u3000/tmp/demo.mp4', '未提交：视频命令或路径无效。'],
    ['帮我分析一下这个视频', '未提交：请提供一个绝对视频路径。'],
    ['帮我分析 /tmp/a.mp4 和 /tmp/b.mp4', '未提交：一次只能分析一个视频。'],
    ['帮我分析这个视频 ../demo.mp4', '未提交：请提供一个绝对视频路径。'],
    ['帮我分析这个视频 https://example.com/a.mp4', '未提交：只支持本机绝对视频路径。'],
    ['帮我分析这个视频 /tmp/demo.avi', '未提交：视频路径或格式无效。'],
    ['只分析画面 /tmp/demo.mp4', '未提交：当前只支持完整音画分析。'],
    ['仅分析音频 /tmp/demo.mp4', '未提交：当前只支持完整音画分析。'],
    ['分析视频 ../demo.mp4', '未提交：视频命令或路径无效。'],
  ])('short-rejects missing, multiple, or invalid paths: %s', async (content, text) => {
    const runner = vi.fn()
    const handler = createHandler(runner)

    await expect(handler(event({ content }), context)).resolves.toEqual({ handled: true, text })
    expect(runner).not.toHaveBeenCalled()
  })

  it('leaves every request on non-Telegram channels to the normal dispatcher', async () => {
    const runner = vi.fn()
    const handler = createHandler(runner)

    await expect(handler(
      event({ channel: 'whatsapp', content: '帮我分析这个视频 /tmp/demo.mp4' }),
      { ...context, channelId: 'whatsapp' },
    )).resolves.toBeUndefined()
    expect(runner).not.toHaveBeenCalled()
  })

  it('fails closed for group or unclassified Telegram execution requests', async () => {
    const runner = vi.fn()
    const handler = createHandler(runner)

    for (const isGroup of [true, undefined]) {
      await expect(handler(event({ isGroup }), context)).resolves.toEqual({
        handled: true,
        text: '未提交：仅支持 Telegram 私聊。',
      })
    }
    await expect(handler(
      event({ content: '普通群聊消息', isGroup: true }),
      context,
    )).resolves.toBeUndefined()
    expect(runner).not.toHaveBeenCalled()
  })

  it('leaves Telegram group explanations and negative examples outside the DM-only hook contract', async () => {
    const runner = vi.fn()
    const handler = createHandler(runner)

    for (const content of [
      '这个视频怎么分析',
      '不要执行这个视频 /tmp/demo.mp4',
      '比如用“帮我分析 /tmp/demo.mp4”作为示例',
    ]) {
      await expect(handler(event({ content, isGroup: true }), context)).resolves.toBeUndefined()
    }
    expect(runner).not.toHaveBeenCalled()
  })

  it('requires consistent Telegram message identity', async () => {
    const runner = vi.fn()
    const handler = createHandler(runner)

    await expect(handler(event({ sessionKey: 'different-session' }), context)).resolves.toEqual({
      handled: true,
      text: '提交失败：消息上下文不一致。',
    })
    await expect(handler(
      event({ senderId: undefined }),
      { ...context, senderId: undefined },
    )).resolves.toEqual({
      handled: true,
      text: '提交失败：缺少可信消息身份。',
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('requires the configured sender hash before any video submission', async () => {
    const runner = vi.fn()
    const missingPolicy = createBeforeDispatchHandler({ runner })
    const otherSenderPolicy = createHandler(runner, 'different-sender')

    for (const handler of [missingPolicy, otherSenderPolicy]) {
      await expect(handler(event(), context)).resolves.toEqual({
        handled: true,
        text: '未提交：当前发送者没有视频派发权限。',
      })
    }
    expect(runner).not.toHaveBeenCalled()
  })

  it('uses a domain-separated stable sender hash without exposing the sender id', () => {
    const digest = deriveTelegramSenderHash('123456789')
    expect(digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(digest).toBe(deriveTelegramSenderHash(' 123456789 '))
    expect(digest).not.toContain('123456789')
    expect(() => deriveTelegramSenderHash('  ')).toThrow('non-empty sender id is required')
  })

  it('uses the duplicate flag only to choose a human short receipt', async () => {
    const runner = vi.fn(async ({ taskId }) => ({
      taskId,
      status: 'accepted',
      duplicate: true,
    }))
    const handler = createHandler(runner)

    await expect(handler(event(), context)).resolves.toEqual({
      handled: true,
      text: expect.stringMatching(
        /^任务已存在，任务编号：video-command-[a-f0-9]{64}。结果请稍后查询。$/u,
      ),
    })
    expect(runner).toHaveBeenCalledTimes(1)
  })

  it('fails closed without a finite timestamp and never submits', async () => {
    const runner = vi.fn()
    const handler = createHandler(runner)

    for (const timestamp of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(handler(event({ timestamp }), context)).resolves.toEqual({
        handled: true,
        text: '提交失败：缺少有效消息时间。',
      })
    }
    expect(runner).not.toHaveBeenCalled()
  })

  it('uses content only and never parses a structured agent body', async () => {
    const runner = vi.fn()
    const handler = createHandler(runner)

    await expect(handler(event({
      content: '普通消息',
      body: '分析视频 /tmp/should-not-run.mp4',
    }), context)).resolves.toBeUndefined()
    expect(runner).not.toHaveBeenCalled()
  })

  it('does not retry or expose runner and receipt failures', async () => {
    for (const runner of [
      vi.fn(async () => {
        throw new Error('stderr: /private/video.mp4 --secret token-value')
      }),
      vi.fn(async ({ taskId }) => ({ taskId: `${taskId}-wrong`, status: 'accepted' })),
      vi.fn(async ({ taskId }) => ({ taskId, status: 'failed', duplicate: false })),
      vi.fn(async ({ taskId }) => ({ taskId, status: 'failed', duplicate: true })),
    ]) {
      const handler = createHandler(runner)
      const result = await handler(event(), context)
      expect(result).toEqual({ handled: true, text: '提交失败：暂时无法确认任务状态。' })
      expect(result.text).not.toMatch(/private|token-value/u)
      expect(runner).toHaveBeenCalledTimes(1)
    }
  })

  it('returns the stable task number after an unconfirmed submit timeout', async () => {
    const runner = vi.fn(async () => {
      throw new Error('submit_unconfirmed')
    })
    const handler = createHandler(runner)

    const result = await handler(event(), context)

    expect(result).toEqual({
      handled: true,
      text: expect.stringMatching(
        /^提交状态暂未确认，任务编号：video-command-[a-f0-9]{64}。请稍后查询。$/u,
      ),
    })
    expect(runner).toHaveBeenCalledTimes(1)
  })
})
