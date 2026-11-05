import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { extractN8nCoverFrameCandidates } from '@/lib/n8n-cover-frame-extraction'

const execFileAsync = promisify(execFile)
const configuredFfmpeg = String(process.env.AIWORKER_FFMPEG_BIN || '').trim()
const ffmpegCandidates = configuredFfmpeg
  ? [configuredFfmpeg]
  : [join(homedir(), 'ai-worker/bin/ffmpeg'), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']
const ffmpeg = ffmpegCandidates.find(candidate => {
  try { accessSync(candidate, constants.X_OK); return true } catch { return false }
}) || ffmpegCandidates[0]
const ffmpegAvailable = ffmpegCandidates.some(candidate => {
  try { accessSync(candidate, constants.X_OK); return true } catch { return false }
})

describe('original video cover frame extraction', () => {
  it.skipIf(!ffmpegAvailable)('extracts three bounded JPEG candidates from the exact source timecodes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiworker-cover-extraction-test-'))
    const previousFfmpeg = process.env.AIWORKER_FFMPEG_BIN
    const sourcePath = join(directory, 'sample.mp4')
    try {
      process.env.AIWORKER_FFMPEG_BIN = ffmpeg
      await execFileAsync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
        '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', sourcePath,
      ], { timeout: 30_000, maxBuffer: 1024 * 1024 })
      const frames = await extractN8nCoverFrameCandidates(await realpath(sourcePath), [1, 3, 5])
      expect(frames).toHaveLength(3)
      expect(frames.map(frame => frame.requestedSeconds)).toEqual([1, 3, 5])
      for (const frame of frames) {
        expect(frame.observedSourceSeconds).not.toBeNull()
        expect(frame.width).toBe(640)
        expect(frame.height).toBe(360)
        expect(frame.bytes).toBe(frame.data.length)
        expect(frame.bytes).toBeLessThanOrEqual(3 * 1024 * 1024)
        expect(frame.sha256).toMatch(/^[a-f0-9]{64}$/u)
        expect(frame.data.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]))
      }
    } finally {
      if (previousFfmpeg === undefined) delete process.env.AIWORKER_FFMPEG_BIN
      else process.env.AIWORKER_FFMPEG_BIN = previousFfmpeg
      await rm(directory, { recursive: true, force: true })
    }
  })
})
