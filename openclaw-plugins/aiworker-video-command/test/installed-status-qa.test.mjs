import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'

import {
  createSyntheticStatusEvent,
  parseStatusQaArguments,
  runInstalledVideoStatusQa,
} from '../scripts/run-installed-video-status-qa.mjs'

const execFileAsync = promisify(execFile)
const TASK_ID = `video-natural-${'a'.repeat(64)}`
const TIMESTAMP_MS = 1_786_238_400_000

describe('installed video-status QA harness', () => {
  it('parses only one complete task id and the controlled QA identity fields', () => {
    expect(parseStatusQaArguments([
      '--task-id', TASK_ID,
      '--timestamp-ms', String(TIMESTAMP_MS),
      '--qa-id', 'status-qa-1',
    ])).toEqual({
      taskId: TASK_ID,
      timestampMs: TIMESTAMP_MS,
      qaId: 'status-qa-1',
    })

    expect(() => parseStatusQaArguments(['--task-id', TASK_ID])).toThrow('invalid_arguments')
    expect(() => parseStatusQaArguments([
      '--task-id', TASK_ID,
      '--task-id', TASK_ID,
      '--timestamp-ms', String(TIMESTAMP_MS),
      '--qa-id', 'status-qa-1',
    ])).toThrow('invalid_arguments')
    expect(() => parseStatusQaArguments([
      '--task-id', 'task-1',
      '--timestamp-ms', String(TIMESTAMP_MS),
      '--qa-id', 'status-qa-1',
    ])).toThrow('invalid_task_id')
  })

  it('constructs one matching synthetic Telegram private-message shape', () => {
    expect(createSyntheticStatusEvent({
      taskId: TASK_ID,
      timestampMs: TIMESTAMP_MS,
      qaId: 'status-qa-1',
    })).toEqual({
      event: {
        content: `查询任务 ${TASK_ID} 的状态`,
        channel: 'telegram',
        isGroup: false,
        timestamp: TIMESTAMP_MS,
        sessionKey: 'qa-status:status-qa-1',
        senderId: 'qa-status:status-qa-1',
      },
      context: {
        channelId: 'telegram',
        accountId: 'qa-status-isolated',
        conversationId: 'qa-status:status-qa-1',
        sessionKey: 'qa-status:status-qa-1',
        senderId: 'qa-status:status-qa-1',
      },
    })
  })

  it.each([
    ['queued', 'waiting', 'waiting'],
    ['accepted', 'waiting', 'waiting'],
    ['running', 'running', 'running'],
    ['succeeded', 'succeeded', 'completed'],
    ['failed', 'failed', 'failed'],
    ['cancelled', 'failed', 'failed'],
  ])('performs one read and zero submissions for status=%s', async (
    status,
    statusCategory,
    replyCategory,
  ) => {
    const statusRunner = vi.fn(async ({ taskId }) => ({
      taskId,
      status,
      summary: status === 'succeeded' ? '受控摘要，不得进入 QA 输出。' : null,
    }))
    const result = await runInstalledVideoStatusQa({
      taskId: TASK_ID,
      timestampMs: TIMESTAMP_MS,
      qaId: `status-${status}`,
      statusRunner,
    })

    expect(statusRunner).toHaveBeenCalledTimes(1)
    expect(statusRunner).toHaveBeenCalledWith({ taskId: TASK_ID })
    expect(result).toEqual({
      schema: 'aiworker-installed-video-status-qa/v1',
      ok: true,
      ingress: 'synthetic-telegram-dm',
      realTelegramIngressProven: false,
      productionTaskRead: true,
      productionTaskSubmitted: false,
      handled: true,
      statusCalls: 1,
      submitCalls: 0,
      statusCategory,
      replyCategory,
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(TASK_ID)
    expect(serialized).not.toContain('受控摘要')
    expect(serialized).not.toMatch(/content|output|\/Users\/|\/tmp\//u)
  })

  it('does not retry or submit when the real status read fails', async () => {
    const statusRunner = vi.fn(async () => {
      throw new Error(`private failure for ${TASK_ID}`)
    })

    await expect(runInstalledVideoStatusQa({
      taskId: TASK_ID,
      timestampMs: TIMESTAMP_MS,
      qaId: 'status-error',
      statusRunner,
    })).rejects.toThrow('status_query_failed')
    expect(statusRunner).toHaveBeenCalledTimes(1)
  })

  it('fails before any read for invalid semantic arguments', async () => {
    const statusRunner = vi.fn()
    await expect(runInstalledVideoStatusQa({
      taskId: TASK_ID,
      timestampMs: 1,
      qaId: 'status-invalid',
      statusRunner,
    })).rejects.toThrow('invalid_timestamp')
    expect(statusRunner).not.toHaveBeenCalled()
  })

  it('prints only a redacted error envelope for CLI argument failure', async () => {
    const script = resolve(
      process.cwd(),
      'openclaw-plugins/aiworker-video-command/scripts/run-installed-video-status-qa.mjs',
    )
    let failure
    try {
      await execFileAsync(process.execPath, [script, '--task-id', `private-${TASK_ID}`])
    } catch (error) {
      failure = error
    }

    expect(failure?.code).toBe(1)
    const payload = JSON.parse(failure.stderr.trim())
    expect(payload).toEqual({
      schema: 'aiworker-installed-video-status-qa/v1',
      ok: false,
      ingress: 'synthetic-telegram-dm',
      realTelegramIngressProven: false,
      productionTaskRead: false,
      productionTaskSubmitted: false,
      code: 'invalid_arguments',
    })
    expect(failure.stderr).not.toContain(TASK_ID)
  })
})
