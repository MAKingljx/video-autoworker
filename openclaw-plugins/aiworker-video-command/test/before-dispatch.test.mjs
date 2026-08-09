import { describe, expect, it, vi } from 'vitest'

import { createBeforeDispatchHandler } from '../lib/before-dispatch.js'

function event(overrides = {}) {
  return {
    content: '分析视频 /Users/Shared/中文 素材/样片 (终版).mp4',
    body: 'structured agent body',
    channel: 'telegram',
    isGroup: false,
    sessionKey: 'session-key',
    senderId: 'sender-id',
    timestamp: 1_786_240_000_123,
    ...overrides,
  }
}

const context = {
  channelId: 'telegram',
  accountId: 'account-id',
  conversationId: 'conversation-id',
  sessionKey: 'session-key',
  senderId: 'sender-id',
}

describe('before_dispatch handler', () => {
  it('handles a valid Telegram command and returns only safe task fields', async () => {
    const runner = vi.fn(async ({ taskId }) => ({ taskId, status: 'accepted', duplicate: false }))
    const handler = createBeforeDispatchHandler({ runner })
    const result = await handler(event(), context)

    expect(result.handled).toBe(true)
    expect(result.text).toMatch(
      /^已提交：taskId=video-command-[a-f0-9]{64}，status=accepted，duplicate=false。$/u,
    )
    expect(result.text).not.toContain('/Users/Shared')
    expect(result.text).not.toContain('account-id')
    expect(runner).toHaveBeenCalledTimes(1)
    expect(runner.mock.calls[0][0].videoPath).toBe('/Users/Shared/中文 素材/样片 (终版).mp4')
  })

  it('returns void for nonmatches and other channels', async () => {
    const runner = vi.fn()
    const handler = createBeforeDispatchHandler({ runner })

    await expect(handler(event({ content: '你好' }), context)).resolves.toBeUndefined()
    await expect(handler(
      event({ channel: 'whatsapp' }),
      { ...context, channelId: 'whatsapp' },
    )).resolves.toBeUndefined()
    expect(runner).not.toHaveBeenCalled()
  })

  it('fails closed for group or unclassified Telegram commands', async () => {
    const runner = vi.fn()
    const handler = createBeforeDispatchHandler({ runner })

    for (const isGroup of [true, undefined]) {
      const result = await handler(event({ isGroup }), context)
      expect(result).toEqual({ handled: true, text: '未提交：仅支持 Telegram 私聊。' })
    }

    await expect(handler(
      event({ content: '普通群聊消息', isGroup: true }),
      context,
    )).resolves.toBeUndefined()
    expect(runner).not.toHaveBeenCalled()
  })

  it('uses command content and never parses the structured body', async () => {
    const runner = vi.fn()
    const handler = createBeforeDispatchHandler({ runner })
    const result = await handler(event({
      content: '普通消息',
      body: '分析视频 /tmp/should-not-run.mp4',
    }), context)

    expect(result).toBeUndefined()
    expect(runner).not.toHaveBeenCalled()
  })

  it('fails closed without a finite timestamp and never submits', async () => {
    const runner = vi.fn()
    const handler = createBeforeDispatchHandler({ runner })

    for (const timestamp of [undefined, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await handler(event({ timestamp }), context)
      expect(result).toEqual({ handled: true, text: '提交失败：缺少有效消息时间。' })
    }
    expect(runner).not.toHaveBeenCalled()
  })

  it('fails closed when event and context identity fields conflict', async () => {
    const runner = vi.fn()
    const handler = createBeforeDispatchHandler({ runner })
    const result = await handler(event({ sessionKey: 'different-session' }), context)

    expect(result).toEqual({ handled: true, text: '提交失败：消息上下文不一致。' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('handles invalid command-shaped input but does not submit it', async () => {
    const runner = vi.fn()
    const handler = createBeforeDispatchHandler({ runner })
    const result = await handler(event({ content: '分析视频 ../demo.mp4' }), context)

    expect(result).toEqual({ handled: true, text: '未提交：命令格式无效。' })
    expect(runner).not.toHaveBeenCalled()
  })

  it('does not expose runner errors, paths, commands, or stderr', async () => {
    const runner = vi.fn(async () => {
      throw new Error('stderr: /private/video.mp4 --secret token-value')
    })
    const handler = createBeforeDispatchHandler({ runner })
    const result = await handler(event(), context)

    expect(result).toEqual({ handled: true, text: '提交失败：暂时无法确认任务状态。' })
    expect(result.text).not.toContain('/private')
    expect(result.text).not.toContain('token-value')
  })
})
