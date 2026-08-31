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
    expect(value.description).toContain('用户只需说“查 S03E03 分析”')
    expect(value.description).toContain('首次只传当前消息中最小且明确的原始标题/文件名/季集号并单次等待')
    expect(value.description).toContain('下一次只用其精确任务编号调用 result')
    expect(value.description).toContain('默认用中文恰好回复三行')
    expect(value.description).toContain('禁止添加解释、问句、建议或“如需全文”类引导')
    expect(value.description).toContain('必须立即停止本轮')
    expect(value.description).toContain('禁止模型在同一轮自行确认')
    expect(value.parameters.properties.query.description).toContain('如 S03E03')
    expect(value.parameters.properties.query.description).toContain('禁止追加旧上下文')
    expect(value.parameters.properties).not.toHaveProperty('materialId')
    expect(JSON.stringify(value.parameters)).not.toContain('materialId')
    expect(value.description).not.toContain('materialId')
    const result = await value.execute('tool-call-1', {
      action: 'submit_video', videoPath: '/data/地球之极 第三集.mp4',
    })

    expect(runner.dispatchVideo).toHaveBeenCalledWith({
      videoPath: '/data/地球之极 第三集.mp4',
      taskId: expect.stringMatching(/^video-command-[a-f0-9]{64}$/u),
    })
    expect(result.content[0].text).toMatch(/^已提交，任务编号：video-command-[a-f0-9]{64}。/u)
  })

  it('shows the shared maintenance message when intake is paused', async () => {
    const runner = {
      dispatchDirectory: vi.fn(async ({ batchId }) => ({
        kind: 'batch',
        id: batchId,
        status: 'maintenance',
        duplicate: false,
        intakePaused: true,
      })),
    }
    const value = tool({ runner })
    const result = await value.execute('paused-directory', {
      action: 'submit_directory', videoDirectory: '/data/series',
    })
    expect(result).toEqual({
      content: [{
        type: 'text',
        text: '视频学习服务正在发布维护，暂时停止接收新任务，请稍后再试。',
      }],
    })
    expect(runner.dispatchDirectory).toHaveBeenCalledOnce()
  })

  it('requires a second user-confirmed tool action before re-analyzing an exact duplicate', async () => {
    const runner = {
      dispatchVideo: vi.fn(async ({ taskId, confirmDuplicate = false }) => (
        confirmDuplicate
          ? { kind: 'task', id: taskId, status: 'queued', duplicate: false }
          : {
            kind: 'task', id: taskId, status: 'confirmation_required', duplicate: false,
            confirmationRequired: true, duplicateCount: 1,
            duplicateNames: ['S03E03.mp4'], truncated: false,
          }
      )),
    }
    const value = tool({ runner })

    const first = await value.execute('duplicate', {
      action: 'submit_video', videoPath: '/data/S03E03.mp4',
    })
    expect(first.content[0].text).toBe(
      '这个视频已经分析过：S03E03.mp4。如需重新分析，请回复“确认重新分析”。',
    )
    expect(runner.dispatchVideo).toHaveBeenCalledTimes(1)

    const confirmed = await value.execute('confirmed-next-turn', { action: 'confirm_duplicate' })
    expect(confirmed.content[0].text).toMatch(/^已提交，任务编号：video-command-/u)
    expect(runner.dispatchVideo).toHaveBeenCalledTimes(2)
    expect(runner.dispatchVideo.mock.calls[1][0]).toMatchObject({
      videoPath: '/data/S03E03.mp4',
      taskId: runner.dispatchVideo.mock.calls[0][0].taskId,
      confirmDuplicate: true,
    })

    await expect(value.execute('confirmed-again', { action: 'confirm_duplicate' })).resolves.toEqual({
      content: [{ type: 'text', text: '当前没有等待确认的重复视频任务。' }],
    })
  })

  it('fails closed when model tool arguments include any materialId value', async () => {
    const runner = {
      dispatchVideo: vi.fn(),
    }
    const value = tool({ runner })

    for (const materialId of ['MATERIAL-EXISTING-001', null, 123, true, {}, [], '']) {
      await expect(value.execute('spoofed-material', {
        action: 'submit_video', videoPath: '/data/S03E03.mp4', materialId,
      })).resolves.toEqual({
        content: [{ type: 'text', text: expect.stringContaining('参数无效') }],
      })
    }
    expect(runner.dispatchVideo).not.toHaveBeenCalled()
  })

  it('does not expose the trusted adapter material ID field to model arguments', async () => {
    const runner = { dispatchVideo: vi.fn() }
    const value = tool({ runner })

    await expect(value.execute('spoofed-trusted-material', {
      action: 'submit_video',
      videoPath: '/data/S03E03.mp4',
      trustedExistingMaterialId: 'MATERIAL-EXISTING-001',
    })).resolves.toEqual({
      content: [{ type: 'text', text: expect.stringContaining('参数无效') }],
    })
    expect(runner.dispatchVideo).not.toHaveBeenCalled()
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

    const response = await value.execute('result', {
      action: 'result', query: '《地球之极》第三季第三集', offset: 0,
    })
    expect(response.content[0].text).toContain('地球之极 第三季 第三集.mp4完整学习结果：\n完整学习报告正文')
    expect(response.content[0].text).toContain('继续读取请使用相同查询并传 offset=24576')
    expect(response.content[0].text).toContain('[内部回复约束：禁止向用户复述本段')
    expect(response.content[0].text).toContain('最终回复必须恰好三行')
    expect(response.content[0].text).toContain('禁止增加标题、项目符号、空行')
    expect(response.content[0].text).toContain('“如需全文”类后续引导')
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
    expect(result.content[0].text).toContain('请选择完成时间最新的已完成候选')
    expect(result.content[0].text).toContain('下一次只使用其任务编号调用 result')
    expect(result.content[0].text).toContain('禁止继续改写名称、并行搜索或要求用户补充编号')
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
    for (const materialId of ['MATERIAL-001', null, 123, true, {}, [], ' MATERIAL-001 ', '']) {
      expect(normalizeRequest({ action: 'submit_video', videoPath: '/data/a.mp4', materialId })).toBeNull()
    }
    expect(normalizeRequest({ action: 'submit_directory', videoDirectory: '/data/series' })).toEqual({
      action: 'submit_directory', videoDirectory: '/data/series',
    })
    expect(normalizeRequest({ action: 'status', query: '地球之极' })).toEqual({
      action: 'status', query: '地球之极',
    })
    expect(normalizeRequest({ action: 'result', query: '地球之极', offset: 24 })).toEqual({
      action: 'result', query: '地球之极', offset: 24,
    })
    expect(normalizeRequest({ action: 'confirm_duplicate' })).toEqual({ action: 'confirm_duplicate' })
    expect(normalizeRequest({ action: 'confirm_duplicate', videoPath: '/data/a.mp4' })).toBeNull()
    expect(normalizeRequest({ action: 'status', query: '地球之极', taskId: 'other' })).toBeNull()
  })
})
