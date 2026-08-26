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

  it('returns a bounded duplicate confirmation contract without creating a task', async () => {
    const { execute, runner } = fixture({
      taskId,
      status: 'confirmation_required',
      duplicate: false,
      confirmationRequired: true,
      duplicateCount: 1,
      duplicateNames: ['S03E03.mp4'],
      truncated: false,
    })
    await expect(runner.dispatchVideo({ videoPath: '/data/S03E03.mp4', taskId })).resolves.toEqual({
      kind: 'task',
      id: taskId,
      status: 'confirmation_required',
      duplicate: false,
      confirmationRequired: true,
      duplicateCount: 1,
      duplicateNames: ['S03E03.mp4'],
      truncated: false,
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('adds the duplicate confirmation flag only after the caller confirms', async () => {
    const { execute, runner } = fixture({ taskId, status: 'queued', duplicate: false })
    await runner.dispatchVideo({ videoPath: '/data/S03E03.mp4', taskId, confirmDuplicate: true })
    expect(execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs',
      '--video-file', '/data/S03E03.mp4',
      '--task-id', taskId,
      '--idempotency-key', taskId,
      '--delivery', 'none',
      '--wait-seconds', '0',
      '--no-trigger-recovery',
      '--confirm-duplicate',
    ])
  })

  it('runs exactly one task or batch status command', async () => {
    const taskFixture = fixture({ taskId, status: 'running', output: null })
    const task = taskFixture.runner
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
    expect(taskFixture.execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs', '--status-brief', taskId,
    ])
  })

  it('reads the uniquely matched item from its batch state without submitting work', async () => {
    const { execute, runner } = fixture({
      batchId,
      status: 'running',
      total: 2,
      counts: { running: 1, queued: 1 },
      items: [
        { index: 1, name: '地球之极 第三季 第三集.mp4', status: 'running' },
        { index: 2, name: '地球之极 第三季 第十一集.mp4', status: 'queued' },
      ],
    })

    await expect(runner.batchItemStatus({ batchId, index: 2 })).resolves.toEqual({
      kind: 'batch_item',
      id: batchId,
      index: 2,
      name: '地球之极 第三季 第十一集.mp4',
      status: 'queued',
      batchStatus: 'running',
      total: 2,
      counts: { running: 1, queued: 1 },
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0][1]).toEqual([
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

  it('accepts explicit batch state availability failures without treating them as transport errors', async () => {
    const missing = fixture({
      batchId,
      status: 'not_registered',
      stateAvailable: false,
      total: 0,
      counts: {},
      items: [],
    }).runner
    const unavailable = fixture({
      batchId,
      status: 'unavailable',
      stateAvailable: false,
      total: 0,
      counts: {},
      items: [],
    }).runner

    await expect(missing.batchStatus({ batchId })).resolves.toEqual({
      kind: 'batch',
      id: batchId,
      status: 'not_registered',
      total: 0,
      counts: {},
      items: [],
      stateAvailable: false,
    })
    await expect(unavailable.batchStatus({ batchId })).resolves.toMatchObject({
      kind: 'batch',
      id: batchId,
      status: 'unavailable',
      stateAvailable: false,
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

  it('reads one UTF-8 bounded final-report page through the dedicated result command', async () => {
    const { execute, runner } = fixture({
      kind: 'report',
      taskId,
      name: '地球之极 第三季 第三集.mp4',
      status: 'succeeded',
      report: {
        source: 'summary',
        text: '完整学习报告',
        offset: 0,
        nextOffset: null,
        totalBytes: Buffer.byteLength('完整学习报告', 'utf8'),
      },
    })
    await expect(runner.taskResult({ query: '《地球之极》第三季第三集', offset: 0 })).resolves.toEqual({
      kind: 'report',
      taskId,
      name: '地球之极 第三季 第三集.mp4',
      status: 'succeeded',
      report: {
        source: 'summary',
        text: '完整学习报告',
        offset: 0,
        nextOffset: null,
        totalBytes: Buffer.byteLength('完整学习报告', 'utf8'),
      },
    })
    expect(execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs', '--result', '《地球之极》第三季第三集', '--result-offset', '0',
    ])
  })

  it('preserves identifiers and timestamps for ambiguous result candidates', async () => {
    const secondTaskId = `video-command-${'c'.repeat(64)}`
    const batchTaskId = `${batchId}:video:002:${'d'.repeat(12)}`
    const { runner } = fixture({
      kind: 'matches',
      matches: [
        {
          kind: 'task',
          taskId: secondTaskId,
          batchId: null,
          index: null,
          name: '地球之极 S03E03.mp4',
          status: 'succeeded',
          completedAt: '2026-08-19T07:00:00.000Z',
          updatedAt: '2026-08-19T07:01:00.000Z',
        },
        {
          kind: 'batch',
          taskId: batchTaskId,
          batchId,
          index: 2,
          name: '地球之极 S03E03.mp4',
          status: 'succeeded',
          completedAt: '2026-08-18T07:00:00.000Z',
          updatedAt: '2026-08-18T07:01:00.000Z',
        },
      ],
      total: 2,
      truncated: false,
    })

    await expect(runner.taskResult({ query: 'S03E03', offset: 0 })).resolves.toEqual({
      kind: 'matches',
      matches: [
        {
          kind: 'task', taskId: secondTaskId, batchId: null, index: null,
          name: '地球之极 S03E03.mp4', status: 'succeeded',
          completedAt: '2026-08-19T07:00:00.000Z', updatedAt: '2026-08-19T07:01:00.000Z',
        },
        {
          kind: 'batch', taskId: batchTaskId, batchId, index: 2,
          name: '地球之极 S03E03.mp4', status: 'succeeded',
          completedAt: '2026-08-18T07:00:00.000Z', updatedAt: '2026-08-18T07:01:00.000Z',
        },
      ],
      total: 2,
      truncated: false,
    })
  })

  it('rejects result output that exceeds the plugin process boundary or changes the requested offset', async () => {
    const overlong = fixture({
      kind: 'report', taskId, name: null, status: 'succeeded',
      report: {
        source: 'summary', text: 'x'.repeat(24 * 1024 + 1), offset: 0, nextOffset: null, totalBytes: 24 * 1024 + 1,
      },
    }).runner
    await expect(overlong.taskResult({ query: taskId, offset: 0 })).rejects.toThrow('invalid_result_report')

    const wrongOffset = fixture({
      kind: 'report', taskId, name: null, status: 'succeeded',
      report: { source: 'summary', text: 'ok', offset: 1, nextOffset: null, totalBytes: 3 },
    }).runner
    await expect(wrongOffset.taskResult({ query: taskId, offset: 0 })).rejects.toThrow('invalid_task_result')
  })

  it('preserves a matched directory item index for an item-level status read', async () => {
    const { runner } = fixture({
      matches: [{
        kind: 'batch',
        batchId,
        index: 2,
        name: '地球之极 第三季 第十一集.mp4',
        status: 'queued',
        batchStatus: 'running',
      }],
      total: 1,
      truncated: false,
    })

    await expect(runner.searchStatus({ query: '地球之极 第三季 第十一集' })).resolves.toEqual({
      matches: [{
        kind: 'batch',
        batchId,
        index: 2,
        name: '地球之极 第三季 第十一集.mp4',
        status: 'queued',
      }],
      total: 1,
      truncated: false,
    })
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
