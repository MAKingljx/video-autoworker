import { execFile } from 'node:child_process'
import { lstat, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { EditPlan } from './edit-plan'

export async function verifyRenderedVideo(plan: EditPlan, outputPath: string) {
  const root = resolve(process.env.AIWORKER_RESOLVE_OUTPUT_DIR || join(homedir(), 'ai-worker/output/resolve'))
  if (!isAbsolute(outputPath) || resolve(outputPath) !== outputPath) throw new Error('video_edit_output_path_invalid')
  const path = await realpath(outputPath)
  const suffix = relative(await realpath(root), path)
  const info = await lstat(outputPath)
  if (!suffix || suffix.startsWith('..') || isAbsolute(suffix) || path !== outputPath
    || !info.isFile() || info.isSymbolicLink() || info.size <= 0) throw new Error('video_edit_output_outside_root')
  const result = await new Promise<string>((done, fail) => execFile(
    process.env.AIWORKER_FFPROBE_BIN || 'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
    { maxBuffer: 1024 * 1024, timeout: 30_000 },
    (error, stdout) => error ? fail(new Error('video_edit_output_probe_failed')) : done(stdout),
  ))
  const data = JSON.parse(result) as { streams?: Array<Record<string, unknown>>; format?: Record<string, unknown> }
  const video = data.streams?.find(s => s.codec_type === 'video')
  const audio = data.streams?.find(s => s.codec_type === 'audio')
  const duration = Number(data.format?.duration)
  const fps = plan.timelineFrameRate.numerator / plan.timelineFrameRate.denominator
  const endFrame = Math.max(...plan.clips.map(c => c.timelineStartFrame + c.sourceRange.endExclusive - c.sourceRange.start))
  const expectedDuration = endFrame / fps
  if (!video || !Number.isFinite(duration) || Math.abs(duration - expectedDuration) > Math.max(0.15, 2 / fps)) {
    throw new Error('video_edit_output_duration_mismatch')
  }
  if (plan.clips.some(c => c.mediaType !== 'video') && !audio) throw new Error('video_edit_output_audio_missing')
  for (const start of [0, Math.max(0, duration / 2), Math.max(0, duration - 0.2)]) {
    await new Promise<void>((done, fail) => execFile(process.env.AIWORKER_FFMPEG_BIN || 'ffmpeg',
      ['-nostdin', '-hide_banner', '-v', 'error', '-ss', String(start), '-i', path, '-map', '0:v:0', '-frames:v', '1', '-f', 'null', '-'],
      { maxBuffer: 256 * 1024, timeout: 30_000 }, error => error ? fail(new Error('video_edit_output_decode_failed')) : done()))
  }
  const after = await lstat(outputPath)
  if (after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs) {
    throw new Error('video_edit_output_changed_during_verification')
  }
  return { status: 'verified' as const, durationSeconds: duration, width: Number(video.width), height: Number(video.height),
    audioPresent: Boolean(audio), sampledFrames: 3, subtitleVisualReview: plan.output.autoSubtitles ? 'required' : 'not_requested' }
}
