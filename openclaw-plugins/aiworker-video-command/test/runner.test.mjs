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
    ])
  })

  it('recovers a timed-out submission by status query without resubmitting', async () => {
    const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', killed: true })
    const execute = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce({
        stdout: '{"taskId":"task-2","status":"running","attemptCount":1}\n',
        stderr: '',
      })
    const runner = createVideoTaskRunner({ execute, scriptPath: SCRIPT_PATH, nodePath: NODE_PATH })

    await expect(runner({ videoPath: '/tmp/demo.mp4', taskId: 'task-2' })).resolves.toEqual({
      taskId: 'task-2', status: 'running', duplicate: true,
    })
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute.mock.calls[1][1]).toEqual([SCRIPT_PATH, '--status', 'task-2'])
    expect(execute.mock.calls.filter(call => call[1].includes('--video-file'))).toHaveLength(1)
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
})
