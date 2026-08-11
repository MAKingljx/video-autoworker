import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createBeforeDispatchHandler } from '../lib/before-dispatch.js'
import { deriveTelegramSenderHash } from '../lib/dispatch-identity.js'
import { runVideoStatus } from '../lib/status-runner.js'
import { isVideoTaskId } from '../lib/video-task-id.js'

const QA_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u
const MIN_TIMESTAMP_MS = 1_577_836_800_000
const MAX_TIMESTAMP_MS = 4_102_444_800_000
const OUTPUT_SCHEMA = 'aiworker-installed-video-status-qa/v1'

const STATUS_CATEGORY = Object.freeze({
  queued: 'waiting',
  accepted: 'waiting',
  running: 'running',
  succeeded: 'succeeded',
  failed: 'failed',
  cancelled: 'failed',
})

function validateInputs({ taskId, timestampMs, qaId }) {
  if (!isVideoTaskId(taskId)) throw new Error('invalid_task_id')
  if (
    !Number.isSafeInteger(timestampMs)
    || timestampMs < MIN_TIMESTAMP_MS
    || timestampMs > MAX_TIMESTAMP_MS
  ) {
    throw new Error('invalid_timestamp')
  }
  if (typeof qaId !== 'string' || !QA_ID_PATTERN.test(qaId)) {
    throw new Error('invalid_qa_id')
  }
  return { taskId, timestampMs, qaId }
}

export function parseStatusQaArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined || values.has(name)) {
      throw new Error('invalid_arguments')
    }
    values.set(name, value)
  }
  const allowed = new Set(['--task-id', '--timestamp-ms', '--qa-id'])
  if ([...values.keys()].some(name => !allowed.has(name)) || values.size !== allowed.size) {
    throw new Error('invalid_arguments')
  }
  return validateInputs({
    taskId: values.get('--task-id'),
    timestampMs: Number(values.get('--timestamp-ms')),
    qaId: values.get('--qa-id'),
  })
}

export function createSyntheticStatusEvent({ taskId, timestampMs, qaId }) {
  validateInputs({ taskId, timestampMs, qaId })
  const sessionKey = `qa-status:${qaId}`
  const senderId = `qa-status:${qaId}`
  return {
    event: {
      content: `查询任务 ${taskId} 的状态`,
      channel: 'telegram',
      isGroup: false,
      timestamp: timestampMs,
      sessionKey,
      senderId,
    },
    context: {
      channelId: 'telegram',
      accountId: 'qa-status-isolated',
      conversationId: `qa-status:${qaId}`,
      sessionKey,
      senderId,
    },
  }
}

function replyCategory(text) {
  if (text === '任务已受理，正在等待处理。') return 'waiting'
  if (text === '任务正在处理中。') return 'running'
  if (text?.startsWith('任务已完成。')) return 'completed'
  if (text === '任务处理失败。') return 'failed'
  return null
}

function expectedReplyCategory(statusCategory) {
  if (statusCategory === 'succeeded') return 'completed'
  return statusCategory
}

export async function runInstalledVideoStatusQa({
  taskId,
  timestampMs,
  qaId,
  statusRunner = runVideoStatus,
}) {
  validateInputs({ taskId, timestampMs, qaId })

  let statusCalls = 0
  let submitCalls = 0
  let statusResult
  const countedStatusRunner = async input => {
    statusCalls += 1
    if (statusCalls > 1) throw new Error('multiple_status_calls')
    statusResult = await statusRunner(input)
    return statusResult
  }
  const forbiddenSubmitRunner = async () => {
    submitCalls += 1
    throw new Error('unexpected_submit_call')
  }
  const { event, context } = createSyntheticStatusEvent({ taskId, timestampMs, qaId })
  const handler = createBeforeDispatchHandler({
    runner: forbiddenSubmitRunner,
    statusRunner: countedStatusRunner,
    allowedSenderSha256: deriveTelegramSenderHash(event.senderId),
  })
  const result = await handler(event, context)

  if (submitCalls !== 0) throw new Error('unexpected_submit_call')
  if (statusCalls !== 1) throw new Error('invalid_status_count')
  if (result?.handled !== true || typeof result.text !== 'string') {
    throw new Error('invalid_status_reply')
  }
  if (result.text === '暂时无法查询任务状态。') throw new Error('status_query_failed')

  const statusCategory = STATUS_CATEGORY[statusResult?.status]
  const responseCategory = replyCategory(result.text)
  if (
    !statusCategory
    || !responseCategory
    || responseCategory !== expectedReplyCategory(statusCategory)
  ) {
    throw new Error('invalid_status_reply')
  }

  return {
    schema: OUTPUT_SCHEMA,
    ok: true,
    ingress: 'synthetic-telegram-dm',
    realTelegramIngressProven: false,
    productionTaskRead: true,
    productionTaskSubmitted: false,
    handled: true,
    statusCalls,
    submitCalls,
    statusCategory,
    replyCategory: responseCategory,
  }
}

async function main() {
  const result = await runInstalledVideoStatusQa(
    parseStatusQaArguments(process.argv.slice(2)),
  )
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const code = /^[a-z][a-z0-9_]{2,63}$/u.test(error?.message)
      ? error.message
      : 'qa_failed'
    process.stderr.write(`${JSON.stringify({
      schema: OUTPUT_SCHEMA,
      ok: false,
      ingress: 'synthetic-telegram-dm',
      realTelegramIngressProven: false,
      productionTaskRead: false,
      productionTaskSubmitted: false,
      code,
    })}\n`)
    process.exitCode = 1
  })
}
