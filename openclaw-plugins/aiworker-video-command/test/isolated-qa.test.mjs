import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  createSyntheticPrivateEvent,
  parseQaArguments,
  runIsolatedVideoCommandQa,
} from '../scripts/run-isolated-video-command-qa.mjs'

const temporaryDirectories = []

async function qaVideo() {
  const directory = await mkdtemp(join(tmpdir(), 'aiworker-video-command-qa-'))
  temporaryDirectories.push(directory)
  const videoFile = join(directory, 'qa.mp4')
  await writeFile(videoFile, 'controlled-video-fixture')
  return realpath(videoFile)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('isolated video-command QA harness', () => {
  it('builds one deterministic private Telegram event and returns a redacted receipt', async () => {
    const videoFile = await qaVideo()
    const calls = []
    const result = await runIsolatedVideoCommandQa({
      videoFile,
      timestampMs: 1_786_238_400_000,
      qaId: 'release-qa-1',
      runner: async input => {
        calls.push(input)
        return {
          taskId: input.taskId,
          status: 'accepted',
          duplicate: false,
        }
      },
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ videoPath: videoFile })
    expect(calls[0].taskId).toMatch(/^video-command-[a-f0-9]{64}$/u)
    expect(result).toMatchObject({
      schema: 'aiworker-installed-plugin-isolated-qa/v1',
      ok: true,
      ingress: 'synthetic-telegram-dm',
      realTelegramIngressProven: false,
      productionTaskSubmitted: true,
      handled: true,
      submitCalls: 1,
      status: 'accepted',
      duplicate: false,
      delivery: 'none',
      statusQueryByHarness: false,
    })
    expect(JSON.stringify(result)).not.toContain(videoFile)
  })

  it('uses matching private Telegram-shaped event and context fields', () => {
    expect(createSyntheticPrivateEvent({
      canonicalVideoFile: '/tmp/qa.mp4',
      timestampMs: 1_786_238_400_000,
      qaId: 'release-qa-1',
    })).toEqual({
      event: {
        content: '分析视频 /tmp/qa.mp4',
        channel: 'telegram',
        isGroup: false,
        timestamp: 1_786_238_400_000,
        sessionKey: 'qa:release-qa-1',
        senderId: 'qa:release-qa-1',
      },
      context: {
        channelId: 'telegram',
        accountId: 'qa-isolated',
        conversationId: 'qa:release-qa-1',
        sessionKey: 'qa:release-qa-1',
        senderId: 'qa:release-qa-1',
      },
    })
  })

  it('parses only the three exact CLI arguments', () => {
    expect(parseQaArguments([
      '--video-file', '/tmp/qa.mp4',
      '--timestamp-ms', '1786238400000',
      '--qa-id', 'release-qa-1',
    ])).toEqual({
      videoFile: '/tmp/qa.mp4',
      timestampMs: 1_786_238_400_000,
      qaId: 'release-qa-1',
    })
    expect(() => parseQaArguments(['--video-file', '/tmp/qa.mp4'])).toThrow('invalid_arguments')
  })

  it('rejects a non-receipt without retrying the handler', async () => {
    const videoFile = await qaVideo()
    let calls = 0
    await expect(runIsolatedVideoCommandQa({
      videoFile,
      timestampMs: 1_786_238_400_000,
      qaId: 'release-qa-2',
      runner: async () => {
        calls += 1
        throw new Error('submit_failed')
      },
    })).rejects.toThrow('invalid_dispatch_receipt')
    expect(calls).toBe(1)
  })
})
