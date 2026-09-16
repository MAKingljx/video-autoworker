import { describe, expect, it, vi } from 'vitest'

import {
  createSavedSummaryDirectReplyHandler,
  parseSavedSummaryRequest,
} from '../lib/saved-summary-direct-dispatch.js'

const title = '《地球之极》第七季第12集'

function event(content) {
  return {
    ctx: {
      commandText: content,
      OriginatingChannel: 'feishu',
      ChatType: 'direct',
      AgentId: 'second-original',
      InboundAccessAuthorized: true,
    },
    originatingChannel: 'feishu',
    originatingChatType: 'direct',
    sessionKey: 'agent:second-original:feishu:direct:test-user',
  }
}

function dispatcher() {
  const sent = []
  return {
    sent,
    sendFinalReply: vi.fn(payload => {
      sent.push(payload.text)
      return true
    }),
    getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: sent.length })),
  }
}

function pagedRunner(total) {
  return {
    taskResult: vi.fn(async ({ view, segmentOffset = 0, segmentIndex }) => {
      if (view === 'segments') {
        const items = Array.from({ length: Math.min(20, total - segmentOffset) }, (_, index) => {
          const value = segmentOffset + index + 1
          return {
            index: value,
            timeRange: `00:${String(value - 1).padStart(2, '0')}:00-00:${String(value).padStart(2, '0')}:00`,
            preview: `预览${value}`,
          }
        })
        return {
          kind: 'segments', taskId: 'video-command-test', name: title, status: 'succeeded',
          totalSegments: total, segmentOffset, segmentLimit: 20, items,
          nextSegmentOffset: segmentOffset + items.length >= total ? null : segmentOffset + items.length,
        }
      }
      return {
        kind: 'segment', taskId: 'video-command-test', name: title, status: 'succeeded',
        segment: {
          index: segmentIndex,
          timeRange: `00:${String(segmentIndex - 1).padStart(2, '0')}:00-00:${String(segmentIndex).padStart(2, '0')}:00`,
          summary: `已保存摘要${segmentIndex}`,
        },
      }
    }),
  }
}

describe('saved summary direct delivery', () => {
  it('parses a requested count without hard-coding 20', () => {
    expect(parseSavedSummaryRequest(`请直读${title}前35个片段原文，逐条发送`)).toEqual({
      query: title,
      count: 35,
    })
  })

  it('parses a single saved segment request', () => {
    expect(parseSavedSummaryRequest(`读取${title}片段3已保存原文`)).toEqual({
      query: title,
      segmentIndex: 3,
      count: 1,
    })
  })

  it('resolves a latest-task request without requiring a fixed title', () => {
    expect(parseSavedSummaryRequest('请把最近一次已保存片段摘要逐条发给我')).toEqual({
      query: null,
      latest: true,
      count: null,
    })
  })

  it('reads the actual total through pages and sends every segment separately', async () => {
    const runner = pagedRunner(23)
    const send = dispatcher()
    const recordProcessed = vi.fn()
    const markIdle = vi.fn()
    const handler = createSavedSummaryDirectReplyHandler({ runner })

    const result = await handler(
      event(`请直读${title}已保存摘要，按条发送`),
      { dispatcher: send, recordProcessed, markIdle },
    )

    expect(result).toMatchObject({ handled: true, queuedFinal: true })
    expect(send.sendFinalReply).toHaveBeenCalledTimes(23)
    expect(send.sent[0]).toContain('片段 1')
    expect(send.sent[0]).toContain('已保存摘要1')
    expect(send.sent[22]).toContain('片段 23')
    expect(runner.taskResult).toHaveBeenCalledTimes(25)
    expect(recordProcessed).toHaveBeenCalledWith('completed', {
      reason: 'saved_summary_direct_delivery',
    })
    expect(markIdle).toHaveBeenCalledWith('message_completed')
  })

  it('honors any requested count and stops at that count', async () => {
    const runner = pagedRunner(80)
    const send = dispatcher()
    const handler = createSavedSummaryDirectReplyHandler({ runner })

    await handler(
      event(`请读取${title}前35条已保存片段摘要，一条一条发`),
      { dispatcher: send },
    )

    expect(send.sendFinalReply).toHaveBeenCalledTimes(35)
    expect(send.sent.at(-1)).toContain('片段 35')
  })

  it('handles a single segment without reading a directory or invoking a model', async () => {
    const runner = pagedRunner(23)
    const send = dispatcher()
    const handler = createSavedSummaryDirectReplyHandler({ runner })

    await handler(event(`只读${title}片段3原文`), { dispatcher: send })

    expect(send.sendFinalReply).toHaveBeenCalledOnce()
    expect(send.sent[0]).toContain('已保存摘要3')
    expect(runner.taskResult).toHaveBeenCalledWith({
      query: title, view: 'segment', segmentIndex: 3,
    })
  })

  it('uses the channel text adapter so Feishu sends independent messages instead of merging a stream card', async () => {
    const runner = pagedRunner(2)
    const send = dispatcher()
    const sendText = vi.fn(async () => ({ ok: true }))
    const handler = createSavedSummaryDirectReplyHandler({ runner, sendText })
    const value = await handler({
      ...event(`请直读${title}前2个已保存片段摘要，逐条发送`),
      originatingTo: 'oc_test_conversation',
      originatingAccountId: 'default',
    }, { dispatcher: send, cfg: {} })

    expect(value).toMatchObject({ handled: true, queuedFinal: true })
    expect(sendText).toHaveBeenCalledTimes(2)
    expect(sendText.mock.calls.map(call => call[0].text)).toEqual([
      expect.stringContaining('已保存摘要1'),
      expect.stringContaining('已保存摘要2'),
    ])
    expect(send.sendFinalReply).not.toHaveBeenCalled()
  })

  it('chooses the newest succeeded task for a latest-task request', async () => {
    const runner = {
      taskResult: vi.fn(async ({ query, view, segmentOffset = 0, segmentIndex }) => {
        if (query === '已完成') return {
          kind: 'matches',
          matches: [
            { taskId: 'video-command-old', status: 'succeeded', completedAt: '2026-01-01T00:00:00Z' },
            { taskId: 'video-command-new', status: 'succeeded', completedAt: '2026-02-01T00:00:00Z' },
          ],
        }
        if (view === 'segments') return {
          kind: 'segments', taskId: query, name: title, status: 'succeeded', totalSegments: 1,
          segmentOffset, segmentLimit: 20, items: [{ index: 1, timeRange: '00:00-00:01' }],
          nextSegmentOffset: null,
        }
        return {
          kind: 'segment', taskId: query, name: title, status: 'succeeded',
          segment: { index: segmentIndex, timeRange: '00:00-00:01', summary: '最新已保存摘要' },
        }
      }),
    }
    const send = dispatcher()
    const handler = createSavedSummaryDirectReplyHandler({ runner })

    await handler(event('请把最近一次已保存片段摘要逐条发给我'), { dispatcher: send })

    expect(send.sent).toEqual(['片段 1（00:00-00:01）\n最新已保存摘要'])
    expect(runner.taskResult).toHaveBeenCalledWith({
      query: 'video-command-new', view: 'segments', segmentOffset: 0, segmentLimit: 20,
    })
  })

  it('ignores non-Feishu or non-direct-read requests', async () => {
    const runner = pagedRunner(2)
    const send = dispatcher()
    const handler = createSavedSummaryDirectReplyHandler({ runner })

    const ordinary = await handler({
      ...event(`请总结${title}的内容`),
      originatingChannel: 'telegram',
    }, { dispatcher: send })
    const projectSummary = parseSavedSummaryRequest(
      `读取${title}已保存片段摘要，生成一段项目级摘要`,
    )
    const missingQuery = await handler(event('请直读前20个片段摘要'), { dispatcher: send })

    expect(ordinary).toBeUndefined()
    expect(projectSummary).toBeNull()
    expect(missingQuery).toBeUndefined()
    expect(send.sendFinalReply).not.toHaveBeenCalled()
    expect(runner.taskResult).not.toHaveBeenCalled()
  })
})
