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
    expect(normalizeRequest({ action: 'status', query: '地球之极', taskId: 'other' })).toBeNull()
  })
})
