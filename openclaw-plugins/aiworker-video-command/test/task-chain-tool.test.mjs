import { describe, expect, it, vi } from 'vitest'

import {
  createTaskChainTool,
  normalizeRequest,
  TASK_CHAIN_TOOL_NAME,
} from '../lib/task-chain-tool.js'

const context = {
  agentId: 'second-original',
  sessionKey: 'agent:second-original:telegram:direct:999',
}

function tool(options = {}) {
  return createTaskChainTool({ context, ...options })
}

describe('AI-worker direct task-chain tool', () => {
  it('is directly available to second-original without sender ownership checks', async () => {
    const runner = {
      dispatchVideo: vi.fn(async ({ taskId }) => ({
        kind: 'task', id: taskId, status: 'queued', duplicate: false,
      })),
    }
    const value = tool({ runner })

    expect(value.name).toBe(TASK_CHAIN_TOOL_NAME)
    expect(value.description).toContain('不要要求用户记 slash 命令')
    const result = await value.execute('tool-call-1', {
      action: 'submit_video', videoPath: '/data/地球之极 第三集.mp4',
    })

    expect(runner.dispatchVideo).toHaveBeenCalledWith({
      videoPath: '/data/地球之极 第三集.mp4',
      taskId: expect.stringMatching(/^video-command-[a-f0-9]{64}$/u),
    })
    expect(result.content[0].text).toMatch(/^已提交，任务编号：video-command-[a-f0-9]{64}。/u)
  })

  it('submits a directory with a stable batch id and does not expose the tool to other agents', async () => {
    const runner = {
      dispatchDirectory: vi.fn(async ({ batchId }) => ({
        kind: 'batch', id: batchId, status: 'queued', duplicate: false,
      })),
    }
    const value = tool({ runner })
    const first = await value.execute('first', {
      action: 'submit_directory', videoDirectory: '/data/地球之极 第三季',
    })
    const second = await value.execute('second', {
      action: 'submit_directory', videoDirectory: '/data/地球之极 第三季',
    })

    expect(runner.dispatchDirectory.mock.calls[0][0].batchId)
      .toBe(runner.dispatchDirectory.mock.calls[1][0].batchId)
    expect(first.content[0].text).toMatch(/^已加入学习队列，批次编号：video-batch-[a-f0-9]{64}。/u)
    expect(second.content[0].text).toMatch(/^已加入学习队列，批次编号：video-batch-[a-f0-9]{64}。/u)
    expect(createTaskChainTool({ context: { agentId: 'main' }, runner })).toBeNull()
  })

  it('looks up exact ids directly and title queries through the controlled registry', async () => {
    const taskId = `video-command-${'a'.repeat(64)}`
    const runner = {
      taskStatus: vi.fn(async () => ({ kind: 'task', id: taskId, status: 'running', summary: null })),
      searchStatus: vi.fn(async () => ({
        matches: [{ kind: 'task', taskId, name: '地球之极 第三季 第三集.mp4', status: 'running' }],
        total: 1,
        truncated: false,
      })),
    }
    const value = tool({ runner })

    await expect(value.execute('status-id', { action: 'status', query: taskId }))
      .resolves.toEqual({ content: [{ type: 'text', text: '任务正在处理中。' }] })
    await expect(value.execute('status-title', { action: 'status', query: '《地球之极》第三季第三集' }))
      .resolves.toEqual({ content: [{ type: 'text', text: '任务正在处理中。' }] })
    expect(runner.taskStatus).toHaveBeenCalledTimes(2)
    expect(runner.searchStatus).toHaveBeenCalledOnce()
  })

  it('returns one matched directory item without re-submitting its batch', async () => {
    const batchId = `video-batch-${'b'.repeat(64)}`
    const runner = {
      searchStatus: vi.fn(async () => ({
        matches: [{
          kind: 'batch',
          batchId,
          index: 3,
          name: '地球之极 第三季 第十一集.mp4',
          status: 'queued',
        }],
        total: 1,
        truncated: false,
      })),
      batchItemStatus: vi.fn(async () => ({
        kind: 'batch_item',
        id: batchId,
        index: 3,
        name: '地球之极 第三季 第十一集.mp4',
        status: 'queued',
        batchStatus: 'running',
        total: 3,
        counts: { running: 1, queued: 2 },
      })),
      dispatchDirectory: vi.fn(),
    }
    const value = tool({ runner })

    await expect(value.execute('batch-item-status', {
      action: 'status', query: '地球之极 第三季 第十一集',
    })).resolves.toEqual({
      content: [{
        type: 'text',
        text: '地球之极 第三季 第十一集.mp4：已排队；所在批次处理中，已结束 0/3。',
      }],
    })
    expect(runner.searchStatus).toHaveBeenCalledOnce()
    expect(runner.batchItemStatus).toHaveBeenCalledWith({ batchId, index: 3 })
    expect(runner.dispatchDirectory).not.toHaveBeenCalled()
  })

  it('reads a complete report through the dedicated result action without status or file search', async () => {
    const runner = {
      taskResult: vi.fn(async ({ query, offset }) => ({
        kind: 'report',
        taskId: `video-command-${'c'.repeat(64)}`,
        name: '地球之极 第三季 第三集.mp4',
        status: 'succeeded',
        report: {
          source: 'summary', text: '完整学习报告正文', offset, nextOffset: 24576, totalBytes: 30000,
        },
        query,
      })),
      taskStatus: vi.fn(),
      searchStatus: vi.fn(),
    }
    const value = tool({ runner })

    await expect(value.execute('result', {
      action: 'result', query: '《地球之极》第三季第三集', offset: 0,
    })).resolves.toEqual({
      content: [{
        type: 'text',
        text: '地球之极 第三季 第三集.mp4完整学习结果：\n完整学习报告正文\n\n报告较长；继续读取请使用相同查询并传 offset=24576。',
      }],
    })
    expect(runner.taskResult).toHaveBeenCalledWith({ query: '《地球之极》第三季第三集', offset: 0 })
    expect(runner.taskStatus).not.toHaveBeenCalled()
    expect(runner.searchStatus).not.toHaveBeenCalled()
  })

  it('returns actionable metadata for ambiguous result candidates', async () => {
    const newerTaskId = `video-command-${'e'.repeat(64)}`
    const olderTaskId = `video-natural-${'f'.repeat(64)}`
    const runner = {
      taskResult: vi.fn(async () => ({
        kind: 'matches',
        matches: [
          {
            kind: 'task', taskId: newerTaskId, batchId: null, index: null,
            name: '地球之极 S03E03.mp4', status: 'succeeded',
            completedAt: '2026-08-19T07:00:00.000Z', updatedAt: '2026-08-19T07:01:00.000Z',
          },
          {
            kind: 'task', taskId: olderTaskId, batchId: null, index: null,
            name: '地球之极 S03E03.mp4', status: 'succeeded',
            completedAt: '2026-08-18T07:00:00.000Z', updatedAt: '2026-08-18T07:01:00.000Z',
          },
        ],
        total: 2,
        truncated: false,
      })),
    }
    const value = tool({ runner })

    const result = await value.execute('result-candidates', { action: 'result', query: 'S03E03' })
    expect(result.content[0].text).toContain('找到 2 条匹配视频')
    expect(result.content[0].text).toContain(`任务编号：${newerTaskId}`)
    expect(result.content[0].text).toContain('完成时间：2026-08-19T07:00:00.000Z')
    expect(result.content[0].text).toContain('无需用户补充编号')
    expect(result.content[0].text).not.toContain('请补充视频标题')
  })

  it('rejects malformed tool parameters before any runner call', async () => {
    const runner = {
      dispatchVideo: vi.fn(), dispatchDirectory: vi.fn(), searchStatus: vi.fn(),
    }
    const value = tool({ runner })

    await expect(value.execute('invalid', { action: 'submit_video', videoPath: 'relative.mp4' }))
      .resolves.toEqual({ content: [{ type: 'text', text: expect.stringContaining('参数无效') }] })
    await expect(value.execute('invalid-extra', {
      action: 'status', query: '地球之极', videoPath: '/data/a.mp4',
    })).resolves.toEqual({ content: [{ type: 'text', text: expect.stringContaining('参数无效') }] })
    expect(runner.dispatchVideo).not.toHaveBeenCalled()
    expect(runner.dispatchDirectory).not.toHaveBeenCalled()
    expect(runner.searchStatus).not.toHaveBeenCalled()
  })

  it('keeps the release gate as maintenance state rather than an identity check', async () => {
    const runner = { dispatchVideo: vi.fn() }
    const value = tool({ runner, releaseReady: false })

    await expect(value.execute('maintenance', {
      action: 'submit_video', videoPath: '/data/a.mp4',
    })).resolves.toEqual({
      content: [{ type: 'text', text: '视频学习服务正在发布维护，请稍后再试。' }],
    })
    expect(runner.dispatchVideo).not.toHaveBeenCalled()
  })

  it('normalizes only one valid parameter shape for each action', () => {
    expect(normalizeRequest({ action: 'submit_video', videoPath: '/data/a.mp4' })).toEqual({
      action: 'submit_video', videoPath: '/data/a.mp4',
    })
    expect(normalizeRequest({ action: 'submit_directory', videoDirectory: '/data/series' })).toEqual({
      action: 'submit_directory', videoDirectory: '/data/series',
    })
    expect(normalizeRequest({ action: 'status', query: '地球之极' })).toEqual({
      action: 'status', query: '地球之极',
    })
    expect(normalizeRequest({ action: 'result', query: '地球之极', offset: 24 })).toEqual({
      action: 'result', query: '地球之极', offset: 24,
    })
    expect(normalizeRequest({ action: 'status', query: '地球之极', taskId: 'other' })).toBeNull()
  })
})
