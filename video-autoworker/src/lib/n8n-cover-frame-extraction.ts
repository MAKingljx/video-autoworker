import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { extname, isAbsolute, join, resolve } from 'node:path'

const MAX_CANDIDATES = 3
const MAX_FRAME_BYTES = 3 * 1024 * 1024
const MAX_PIXELS = 24 * 1024 * 1024
const MAX_SIDE = 8192
const VIDEO_EXTENSIONS = new Set(['.m4v', '.mkv', '.mov', '.mp4', '.webm'])

export interface ExtractedCoverFrame {
  requestedSeconds: number
  observedSourceSeconds: number | null
  width: number
  height: number
  bytes: number
  sha256: string
  data: Buffer
}

function sourceIdentity(value: Awaited<ReturnType<typeof stat>>) {
  return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs, ctimeMs: value.ctimeMs }
}

function sameIdentity(left: ReturnType<typeof sourceIdentity>, right: ReturnType<typeof sourceIdentity>) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
}

async function verifySourceIdentity(sourcePath: string, expected: ReturnType<typeof sourceIdentity>) {
  if (await realpath(sourcePath) !== sourcePath) throw new Error('cover_frame_source_changed')
  const entry = await lstat(sourcePath)
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('cover_frame_source_changed')
  if (!sameIdentity(expected, sourceIdentity(await stat(sourcePath)))) throw new Error('cover_frame_source_changed')
}

function dimensions(data: Buffer): { width: number; height: number } | null {
  if (data.length < 16 || data[0] !== 0xff || data[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 < data.length) {
    if (data[offset] !== 0xff) return null
    while (offset < data.length && data[offset] === 0xff) offset += 1
    const marker = data[offset++]
    if (marker === 0xd9 || marker === 0xda) return null
    if ([0xd8, 0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7].includes(marker)) continue
    if (offset + 2 > data.length) return null
    const length = data.readUInt16BE(offset)
    if (length < 2 || offset + length > data.length) return null
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return null
      const height = data.readUInt16BE(offset + 3)
      const width = data.readUInt16BE(offset + 5)
      return width > 0 && height > 0 && Math.max(width, height) <= MAX_SIDE && width * height <= MAX_PIXELS
        ? { width, height } : null
    }
    offset += length
  }
  return null
}

function ffmpegPath(): string {
  const configured = String(process.env.AIWORKER_FFMPEG_BIN || '').trim()
  const result = resolve(configured || join(homedir(), 'ai-worker/bin/ffmpeg'))
  if (!isAbsolute(result)) throw new Error('cover_frame_decoder_unavailable')
  return result
}

function runFrameCommand(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(binary, args, { encoding: 'utf8', timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
      windowsHide: true, ...(signal ? { signal } : {}) }, (error, _stdout, stderr) => {
      if (error) { reject(new Error('cover_frame_decode_failed')); return }
      resolveOutput(String(stderr || ''))
    })
  })
}

/** Extract only selected timecodes from an application-verified original source. */
export async function extractN8nCoverFrameCandidates(
  sourcePath: string,
  requestedSeconds: number[],
  signal?: AbortSignal,
): Promise<ExtractedCoverFrame[]> {
  if (!isAbsolute(sourcePath) || resolve(sourcePath) !== sourcePath
    || !VIDEO_EXTENSIONS.has(extname(sourcePath).toLowerCase())
    || !Array.isArray(requestedSeconds) || requestedSeconds.length < 1 || requestedSeconds.length > MAX_CANDIDATES
    || requestedSeconds.some(value => !Number.isFinite(value) || value < 0 || value > 7_200)) {
    throw new Error('cover_frame_request_invalid')
  }
  const sourceReal = await realpath(sourcePath)
  if (sourceReal !== sourcePath) throw new Error('cover_frame_source_invalid')
  const beforeEntry = await lstat(sourcePath)
  const before = await stat(sourcePath)
  if (!beforeEntry.isFile() || beforeEntry.isSymbolicLink() || before.size <= 0) throw new Error('cover_frame_source_invalid')
  const identity = sourceIdentity(before)
  const ffmpeg = ffmpegPath()
  const binary = await stat(ffmpeg).catch(() => null)
  if (!binary?.isFile() || (binary.mode & 0o111) === 0) throw new Error('cover_frame_decoder_unavailable')
  const workspace = await mkdtemp(join(tmpdir(), 'aiworker-cover-frame-candidates-'))
  await chmod(workspace, 0o700)
  try {
    const output: ExtractedCoverFrame[] = []
    for (let index = 0; index < requestedSeconds.length; index += 1) {
      const requested = Math.round(requestedSeconds[index] * 1_000) / 1_000
      const file = join(workspace, `frame-${String(index + 1).padStart(2, '0')}.jpg`)
      const stderr = await runFrameCommand(ffmpeg, [
        '-nostdin', '-hide_banner', '-loglevel', 'info', '-n',
        '-protocol_whitelist', 'file', '-ss', requested.toFixed(3), '-copyts', '-i', sourcePath,
        '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1',
        '-vf', 'scale=w=min(1920\\,iw):h=-2:force_original_aspect_ratio=decrease,showinfo',
        '-fps_mode', 'passthrough', '-q:v', '3', file,
      ], signal)
      await verifySourceIdentity(sourcePath, identity)
      const fileEntry = await lstat(file)
      if (!fileEntry.isFile() || fileEntry.isSymbolicLink() || fileEntry.size <= 0
        || fileEntry.size > MAX_FRAME_BYTES) throw new Error('cover_frame_candidate_invalid')
      const data = await readFile(file)
      const size = dimensions(data)
      if (!size || data.length !== fileEntry.size || data[2] !== 0xff) throw new Error('cover_frame_candidate_invalid')
      const observed = /\bpts_time:([0-9.+-]+)/u.exec(stderr)?.[1]
      const observedSourceSeconds = observed === undefined ? null : Number(observed)
      if (observedSourceSeconds !== null && (!Number.isFinite(observedSourceSeconds)
        || Math.abs(observedSourceSeconds - requested) > 2)) throw new Error('cover_frame_timestamp_invalid')
      output.push({ requestedSeconds: requested, observedSourceSeconds, ...size,
        bytes: data.length, sha256: createHash('sha256').update(data).digest('hex'), data })
    }
    await verifySourceIdentity(sourcePath, identity)
    return output
  } finally { await rm(workspace, { recursive: true, force: true }) }
}
