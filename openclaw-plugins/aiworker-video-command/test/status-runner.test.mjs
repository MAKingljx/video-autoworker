import { describe, expect, it, vi } from 'vitest'

import { createVideoStatusRunner } from '../lib/status-runner.js'

const SCRIPT_PATH = '/opt/aiworker/skills/aiworker-task-flow/scripts/submit-task.mjs'
const NODE_PATH = '/opt/aiworker/node'
const TASK_ID = `video-natural-${'a'.repeat(64)}`

describe('createVideoStatusRunner', () => {
  it('calls the installed status command exactly once with an argument array', async () => {
    const execute = vi.fn(async () => ({
      stdout: `${JSON.stringify({
        taskId: TASK_ID,
        status: 'running',
        attemptCount: 1,
        maxAttempts: 3,
        updatedAt: '2026-08-11T12:00:00.000Z',
      })}\n`,
      stderr: '',
    }))
    const runner = createVideoStatusRunner({ execute, scriptPath: SCRIPT_PATH, nodePath: NODE_PATH })

    await expect(runner({ taskId: TASK_ID })).resolves.toEqual({
      taskId: TASK_ID,
      status: 'running',
      summary: null,
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute).toHaveBeenCalledWith(
      NODE_PATH,
      [SCRIPT_PATH, '--status', TASK_ID],
      { timeout: 15_000 },
    )
    expect(execute.mock.calls[0][1]).not.toContain('--video-file')
    expect(execute.mock.calls[0][1]).not.toContain('--task-id')
  })

  it.each([
    '{"taskId":"wrong","status":"running"}\n',
    `${JSON.stringify({ taskId: TASK_ID, status: 'banana' })}\n`,
    `${JSON.stringify({ taskId: TASK_ID, status: 'running' })}\nextra\n`,
    'not-json\n',
    '[]\n',
  ])('rejects malformed, mismatched, multiline, or unknown output', async stdout => {
    const execute = vi.fn(async () => ({ stdout, stderr: '' }))
    const runner = createVideoStatusRunner({ execute, scriptPath: SCRIPT_PATH, nodePath: NODE_PATH })

    await expect(runner({ taskId: TASK_ID })).rejects.toThrow('status_failed')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('rejects an invalid task id before starting a child process', async () => {
    const execute = vi.fn()
    const runner = createVideoStatusRunner({ execute, scriptPath: SCRIPT_PATH, nodePath: NODE_PATH })

    await expect(runner({ taskId: 'task;--video-file=/tmp/evil.mp4' }))
      .rejects.toThrow('status_failed')
    expect(execute).not.toHaveBeenCalled()
  })

  it('returns only a safe bounded summary for a completed task', async () => {
    const execute = vi.fn(async () => ({
      stdout: `${JSON.stringify({
        taskId: TASK_ID,
        status: 'succeeded',
        output: { summary: '# 报告\n**结论** 纯蓝画面' },
        error: null,
      })}\n`,
      stderr: '',
    }))
    const runner = createVideoStatusRunner({ execute, scriptPath: SCRIPT_PATH, nodePath: NODE_PATH })

    await expect(runner({ taskId: TASK_ID })).resolves.toEqual({
      taskId: TASK_ID,
      status: 'succeeded',
      summary: '报告 结论 纯蓝画面',
    })
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('does not retry after a timeout or command failure', async () => {
    const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
    const execute = vi.fn().mockRejectedValueOnce(timeout)
    const runner = createVideoStatusRunner({ execute, scriptPath: SCRIPT_PATH, nodePath: NODE_PATH })

    await expect(runner({ taskId: TASK_ID })).rejects.toThrow('status_failed')
    expect(execute).toHaveBeenCalledTimes(1)
  })
})
