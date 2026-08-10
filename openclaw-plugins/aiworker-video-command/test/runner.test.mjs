import { describe, expect, it, vi } from 'vitest'

import { createVideoTaskRunner } from '../lib/runner.js'

const SCRIPT_PATH = '/opt/aiworker/skills/aiworker-task-flow/scripts/submit-task.mjs'
const NODE_PATH = '/opt/aiworker/node'

describe('createVideoTaskRunner', () => {
  it('uses an argument array and explicit video, identity, delivery, and wait options', async () => {
    const execute = vi.fn(async () => ({
      stdout: '{"taskId":"task-1","status":"accepted","duplicate":false}\n',
      stderr: '',
    }))
    const runner = createVideoTaskRunner({ execute, scriptPath: SCRIPT_PATH, nodePath: NODE_PATH })
    const videoPath = '/tmp/clip;$(touch should-not-run).mp4'

    await expect(runner({ videoPath, taskId: 'task-1' })).resolves.toEqual({
      taskId: 'task-1', status: 'accepted', duplicate: false,
    })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][0]).toBe(NODE_PATH)
    expect(execute.mock.calls[0][1]).toEqual([
      SCRIPT_PATH,
      '--video-file', videoPath,
      '--task-id', 'task-1',
      '--idempotency-key', 'task-1',
      '--delivery', 'none',
      '--wait-seconds', '0',
      '--no-trigger-recovery',
    ])
  })

  it('stops after a timed-out submission and never queries or resubmits', async () => {
    const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true })
    const execute = vi.fn().mockRejectedValueOnce(timeout)
    const runner = createVideoTaskRunner({ execute, scriptPath: SCRIPT_PATH, nodePath: NODE_PATH })

    await expect(runner({ videoPath: '/tmp/demo.mp4', taskId: 'task-2' }))
      .rejects.toThrow('submit_unconfirmed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][1]).toContain('--video-file')
    expect(execute.mock.calls[0][1]).not.toContain('--status')
  })

  it('maps the dedicated trigger-ambiguity exit to an unconfirmed receipt without retrying', async () => {
    const unconfirmed = Object.assign(new Error('video_trigger_unconfirmed'), { code: 75 })
    const execute = vi.fn().mockRejectedValueOnce(unconfirmed)
    const runner = createVideoTaskRunner({ execute, scriptPath: SCRIPT_PATH, nodePath: NODE_PATH })

    await expect(runner({ videoPath: '/tmp/demo.mp4', taskId: 'task-unconfirmed' }))
      .rejects.toThrow('submit_unconfirmed')
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0][1]).not.toContain('--status')
  })

  it('keeps ordinary preflight failures distinct from an ambiguous trigger', async () => {
    const failure = Object.assign(new Error('preflight failed'), { code: 2 })
    const execute = vi.fn().mockRejectedValueOnce(failure)
    const runner = createVideoTaskRunner({ execute, scriptPath: SCRIPT_PATH, nodePath: NODE_PATH })

    await expect(runner({ videoPath: '/tmp/demo.mp4', taskId: 'task-preflight' }))
      .rejects.toThrow('submit_failed')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it('rejects multiline, mismatched, or malformed command output', async () => {
    for (const stdout of [
      '{"taskId":"task-3","status":"accepted","duplicate":false}\nextra\n',
      '{"taskId":"another-task","status":"accepted","duplicate":false}\n',
      '{"taskId":"task-3","status":"accepted"}\n',
    ]) {
      const execute = vi.fn(async () => ({ stdout, stderr: '' }))
      const runner = createVideoTaskRunner({ execute, scriptPath: SCRIPT_PATH, nodePath: NODE_PATH })
      await expect(runner({ videoPath: '/tmp/demo.mp4', taskId: 'task-3' }))
        .rejects.toThrow('submit_failed')
    }
  })

  it.each([
    ['queued', false],
    ['running', false],
    ['succeeded', false],
    ['failed', false],
    ['banana', false],
    ['failed', true],
    ['banana', true],
  ])('fails closed for status=%s duplicate=%s', async (status, duplicate) => {
    const execute = vi.fn(async () => ({
      stdout: `${JSON.stringify({ taskId: 'task-4', status, duplicate })}\n`,
      stderr: '',
    }))
    const runner = createVideoTaskRunner({ execute, scriptPath: SCRIPT_PATH, nodePath: NODE_PATH })
    await expect(runner({ videoPath: '/tmp/demo.mp4', taskId: 'task-4' }))
      .rejects.toThrow('submit_failed')
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it.each(['queued', 'accepted', 'running', 'succeeded'])(
    'accepts an existing task in %s state',
    async status => {
      const execute = vi.fn(async () => ({
        stdout: `${JSON.stringify({ taskId: 'task-5', status, duplicate: true })}\n`,
        stderr: '',
      }))
      const runner = createVideoTaskRunner({ execute, scriptPath: SCRIPT_PATH, nodePath: NODE_PATH })
      await expect(runner({ videoPath: '/tmp/demo.mp4', taskId: 'task-5' })).resolves.toEqual({
        taskId: 'task-5', status, duplicate: true,
      })
    },
  )
})
