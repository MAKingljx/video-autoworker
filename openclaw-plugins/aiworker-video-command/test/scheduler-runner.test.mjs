import { describe, expect, it, vi } from 'vitest'

import { createSchedulerRunner } from '../lib/scheduler-runner.js'

const taskId = `video-natural-${'a'.repeat(64)}`
const batchId = `video-batch-${'b'.repeat(64)}`

function fixture(stdoutValue) {
  const execute = vi.fn(async () => ({ stdout: `${JSON.stringify(stdoutValue)}\n`, stderr: '' }))
  return {
    execute,
    runner: createSchedulerRunner({
      execute,
      scriptPath: '/installed/submit-task.mjs',
      nodePath: '/node',
    }),
  }
}

describe('0.5 scheduler runner', () => {
  it('accepts only the new fresh queued single dispatch contract', async () => {
    const { execute, runner } = fixture({ taskId, status: 'queued', duplicate: false })
    await expect(runner.dispatchVideo({ videoPath: '/data/test.mp4', taskId })).resolves.toEqual({
      kind: 'task', id: taskId, status: 'queued', duplicate: false,
    })
    expect(execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs',
      '--video-file', '/data/test.mp4',
      '--task-id', taskId,
      '--idempotency-key', taskId,
      '--delivery', 'none',
      '--wait-seconds', '0',
      '--no-trigger-recovery',
    ])
  })

  it('rejects a fresh accepted result but accepts a duplicate running result', async () => {
    const fresh = fixture({ taskId, status: 'accepted', duplicate: false }).runner
    const duplicate = fixture({ taskId, status: 'running', duplicate: true }).runner
    await expect(fresh.dispatchVideo({ videoPath: '/data/test.mp4', taskId })).rejects.toThrow(
      'invalid_fresh_dispatch_status',
    )
    await expect(duplicate.dispatchVideo({ videoPath: '/data/test.mp4', taskId })).resolves.toMatchObject({
      status: 'running', duplicate: true,
    })
  })

  it('dispatches directories with one fixed batch argument vector', async () => {
    const { execute, runner } = fixture({ batchId, status: 'queued', duplicate: false })
    await expect(runner.dispatchDirectory({ videoDirectory: '/data/series', batchId })).resolves.toMatchObject({
      kind: 'batch', id: batchId,
    })
    expect(execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs',
      '--video-dir', '/data/series',
      '--batch-id', batchId,
      '--delivery', 'none',
    ])
  })

  it('runs exactly one task or batch status command', async () => {
    const task = fixture({ taskId, status: 'running', output: null }).runner
    const batchFixture = fixture({
      batchId,
      status: 'running',
      total: 2,
      counts: { succeeded: 1, running: 1 },
    })
    await expect(task.taskStatus({ taskId })).resolves.toMatchObject({ kind: 'task', status: 'running' })
    await expect(batchFixture.runner.batchStatus({ batchId })).resolves.toMatchObject({
      kind: 'batch', total: 2, counts: { succeeded: 1, running: 1 },
    })
    expect(batchFixture.execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs', '--batch-status', batchId,
    ])
  })

  it('accepts the persistent lane recovering state', async () => {
    const recovering = fixture({
      batchId,
      status: 'recovering',
      total: 2,
      counts: { queued: 1, succeeded: 1 },
    }).runner
    await expect(recovering.batchStatus({ batchId })).resolves.toMatchObject({
      kind: 'batch', status: 'recovering', total: 2,
    })
  })

  it('runs one bounded all-state search without constructing a task or batch query', async () => {
    const { execute, runner } = fixture({
      matches: [{
        kind: 'task',
        taskId,
        batchId: 'single:internal-only',
        name: '地球之极 第三季 第三集.mp4',
        status: 'running',
        batchStatus: 'running',
        updatedAt: '2026-08-16T12:00:00.000Z',
      }],
      total: 1,
      truncated: false,
    })
    await expect(runner.searchStatus({ query: '《地球之极》第三季第三集进度' })).resolves.toEqual({
      matches: [{
        kind: 'task',
        taskId,
        name: '地球之极 第三季 第三集.mp4',
        status: 'running',
      }],
      total: 1,
      truncated: false,
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs', '--search-status', '《地球之极》第三季第三集进度',
    ])
  })

  it('rejects malformed search output and invalid query text before spawning', async () => {
    const malformed = fixture({
      matches: [{ kind: 'batch', batchId, name: 'one.mp4', status: 'queued', batchStatus: 'queued' }],
      total: 2,
      truncated: false,
    }).runner
    await expect(malformed.searchStatus({ query: 'one' })).rejects.toThrow('invalid_search_result')

    const execute = vi.fn()
    const runner = createSchedulerRunner({ execute, scriptPath: '/script', nodePath: '/node' })
    await expect(runner.searchStatus({ query: 'one\ntwo' })).rejects.toThrow('invalid_search_query')
    expect(execute).not.toHaveBeenCalled()
  })

  it('fails closed on malformed, multiline, or mismatched output', async () => {
    const mismatched = fixture({ taskId: `video-natural-${'c'.repeat(64)}`, status: 'queued', duplicate: false }).runner
    await expect(mismatched.dispatchVideo({ videoPath: '/data/test.mp4', taskId })).rejects.toThrow(
      'invalid_dispatch_result',
    )
    const execute = vi.fn(async () => ({ stdout: '{}\n{}\n', stderr: 'secret' }))
    const runner = createSchedulerRunner({ execute, scriptPath: '/script', nodePath: '/node' })
    await expect(runner.taskStatus({ taskId })).rejects.toThrow('invalid_output')
  })
})
