import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createBeforeDispatchHandler } from '../lib/before-dispatch.js'
import { deriveTelegramSenderHash } from '../lib/dispatch-identity.js'
import { runVideoTask } from '../lib/runner.js'
import { SUPPORTED_VIDEO_EXTENSIONS } from '../lib/video-path-policy.js'

const QA_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u
const SUPPORTED_VIDEO_EXTENSION_SET = new Set(SUPPORTED_VIDEO_EXTENSIONS)
const OUTPUT_SCHEMA = 'aiworker-installed-plugin-isolated-qa/v1'
const REQUEST_MODES = new Set(['exact', 'natural'])

function receiptPattern(mode) {
  const prefix = mode === 'exact' ? 'video-command-' : 'video-natural-'
  return new RegExp(`^已提交，任务编号：(${prefix}[a-f0-9]{64})。结果请稍后查询。$`, 'u')
}

export function parseQaArguments(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined || values.has(name)) {
      throw new Error('invalid_arguments')
    }
    values.set(name, value)
  }
  const allowed = new Set(['--video-file', '--timestamp-ms', '--qa-id', '--mode'])
  if ([...values.keys()].some(name => !allowed.has(name)) || values.size !== allowed.size) {
    throw new Error('invalid_arguments')
  }
  const mode = values.get('--mode')
  if (!REQUEST_MODES.has(mode)) throw new Error('invalid_arguments')
  return {
    videoFile: values.get('--video-file'),
    timestampMs: Number(values.get('--timestamp-ms')),
    qaId: values.get('--qa-id'),
    mode,
  }
}

async function validateVideoFile(videoFile) {
  if (typeof videoFile !== 'string' || !isAbsolute(videoFile) || /[\r\n\0]/u.test(videoFile)) {
    throw new Error('invalid_video_file')
  }
  const canonicalPath = await realpath(videoFile)
  const details = await stat(canonicalPath)
  if (
    !details.isFile()
    || details.size <= 0
    || /["'`“”‘’]/u.test(canonicalPath)
    || !SUPPORTED_VIDEO_EXTENSION_SET.has(extname(canonicalPath).toLowerCase())
  ) throw new Error('invalid_video_file')
  return canonicalPath
}

function messageVideoPath(canonicalVideoFile) {
  return /\s/u.test(canonicalVideoFile) ? `"${canonicalVideoFile}"` : canonicalVideoFile
}

export function createSyntheticPrivateEvent({ canonicalVideoFile, timestampMs, qaId, mode }) {
  if (!REQUEST_MODES.has(mode)) throw new Error('invalid_request_mode')
  const sessionKey = `qa:${qaId}`
  const senderId = `qa:${qaId}`
  const videoPath = messageVideoPath(canonicalVideoFile)
  return {
    event: {
      content: mode === 'exact'
        ? `分析视频 ${videoPath}`
        : `帮我分析一下这个视频 ${videoPath}`,
      channel: 'telegram',
      isGroup: false,
      timestamp: timestampMs,
      sessionKey,
      senderId,
    },
    context: {
      channelId: 'telegram',
      accountId: 'qa-isolated',
      conversationId: `qa:${qaId}`,
      sessionKey,
      senderId,
    },
  }
}

export async function runIsolatedVideoCommandQa({
  videoFile,
  timestampMs,
  qaId,
  mode,
  runner = runVideoTask,
}) {
  const canonicalVideoFile = await validateVideoFile(videoFile)
  if (!Number.isSafeInteger(timestampMs) || timestampMs <= 0) {
    throw new Error('invalid_timestamp')
  }
  if (typeof qaId !== 'string' || !QA_ID_PATTERN.test(qaId)) {
    throw new Error('invalid_qa_id')
  }

  let submitCalls = 0
  let runnerResult
  const countedRunner = async input => {
    submitCalls += 1
    if (submitCalls > 1) throw new Error('multiple_submit_calls')
    runnerResult = await runner(input)
    return runnerResult
  }
  const { event, context } = createSyntheticPrivateEvent({
    canonicalVideoFile,
    timestampMs,
    qaId,
    mode,
  })
  const handler = createBeforeDispatchHandler({
    runner: countedRunner,
    allowedSenderSha256: deriveTelegramSenderHash(event.senderId),
  })
  const result = await handler(event, context)

  const match = result?.handled === true && typeof result.text === 'string'
    ? result.text.match(receiptPattern(mode))
    : null
  if (!match) throw new Error('invalid_dispatch_receipt')
  if (submitCalls !== 1) throw new Error('invalid_submit_count')
  if (runnerResult?.taskId !== match[1]) throw new Error('unexpected_task_identity')
  if (runnerResult?.status !== 'accepted') throw new Error('unexpected_status')
  if (runnerResult?.duplicate !== false) throw new Error('unexpected_duplicate')

  return {
    schema: OUTPUT_SCHEMA,
    ok: true,
    ingress: 'synthetic-telegram-dm',
    realTelegramIngressProven: false,
    productionTaskSubmitted: true,
    requestMode: mode,
    handled: true,
    submitCalls,
    taskId: match[1],
    status: runnerResult.status,
    duplicate: false,
    delivery: 'none',
    statusQueryByHarness: false,
  }
}

async function main() {
  const result = await runIsolatedVideoCommandQa(parseQaArguments(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => {
    const code = /^[a-z][a-z0-9_]{2,63}$/u.test(error?.message) ? error.message : 'qa_failed'
    process.stderr.write(`${JSON.stringify({
      schema: OUTPUT_SCHEMA,
      ok: false,
      ingress: 'synthetic-telegram-dm',
      realTelegramIngressProven: false,
      code,
    })}\n`)
    process.exitCode = 1
  })
}
