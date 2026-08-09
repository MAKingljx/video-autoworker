import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { createBeforeDispatchHandler } from '../lib/before-dispatch.js'
import { runVideoTask } from '../lib/runner.js'

const QA_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u
const RECEIPT_PATTERN = /^已提交：taskId=(video-command-[a-f0-9]{64})，status=([a-z][a-z0-9_-]{0,31})，duplicate=(true|false)。$/u
const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v'])
const OUTPUT_SCHEMA = 'aiworker-installed-plugin-isolated-qa/v1'

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
  const allowed = new Set(['--video-file', '--timestamp-ms', '--qa-id'])
  if ([...values.keys()].some(name => !allowed.has(name)) || values.size !== allowed.size) {
    throw new Error('invalid_arguments')
  }
  return {
    videoFile: values.get('--video-file'),
    timestampMs: Number(values.get('--timestamp-ms')),
    qaId: values.get('--qa-id'),
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
    || !SUPPORTED_VIDEO_EXTENSIONS.has(extname(canonicalPath).toLowerCase())
  ) throw new Error('invalid_video_file')
  return canonicalPath
}

export function createSyntheticPrivateEvent({ canonicalVideoFile, timestampMs, qaId }) {
  const sessionKey = `qa:${qaId}`
  const senderId = `qa:${qaId}`
  return {
    event: {
      content: `分析视频 ${canonicalVideoFile}`,
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
  const countedRunner = async input => {
    submitCalls += 1
    if (submitCalls > 1) throw new Error('multiple_submit_calls')
    return runner(input)
  }
  const handler = createBeforeDispatchHandler({ runner: countedRunner })
  const { event, context } = createSyntheticPrivateEvent({
    canonicalVideoFile,
    timestampMs,
    qaId,
  })
  const result = await handler(event, context)

  const match = result?.handled === true && typeof result.text === 'string'
    ? result.text.match(RECEIPT_PATTERN)
    : null
  if (!match) throw new Error('invalid_dispatch_receipt')
  if (submitCalls !== 1) throw new Error('invalid_submit_count')
  if (match[2] !== 'accepted') throw new Error('unexpected_status')
  if (match[3] !== 'false') throw new Error('unexpected_duplicate')

  return {
    schema: OUTPUT_SCHEMA,
    ok: true,
    ingress: 'synthetic-telegram-dm',
    realTelegramIngressProven: false,
    productionTaskSubmitted: true,
    handled: true,
    submitCalls,
    taskId: match[1],
    status: match[2],
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
