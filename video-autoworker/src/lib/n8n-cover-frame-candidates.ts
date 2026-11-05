import { randomBytes } from 'node:crypto'
import type Database from 'better-sqlite3'
import { getN8nVideoResultDetail, listN8nVideoResults, type N8nTaskScope } from '@/lib/n8n-task-runs'
import { getN8nVideoSource } from '@/lib/n8n-video-sources'
import { extractN8nCoverFrameCandidates } from '@/lib/n8n-cover-frame-extraction'

const MAX_SEGMENTS = 1
const SAMPLE_FRACTIONS = [0.2, 0.5, 0.8]
export interface CoverFrameCandidatePublic {
  frameRef: string
  segmentIndex: number
  timeRange: string
  frameTimeSeconds: number
  width: number
  height: number
  bytes: number
  sha256: string
  mimeType: 'image/jpeg'
  data: string
  summary: string
}

export interface N8nCoverFrameCandidateServices {
  listResults(db: Database.Database, scope: N8nTaskScope, options: { query: string; status: 'succeeded'; limit: number }):
    { results: Array<{ taskId: string; title: string }>; total: number }
  getResultDetail(db: Database.Database, taskId: string, scope: N8nTaskScope): null | {
    taskId: string; title: string; status: string; resultAvailable: boolean; learningResultInvalid?: boolean
    learningResult?: { status: string; totalSegments: number; failedSegments: Array<{ index: number }> } | null
    chapters: Array<{ index: number; startTime: string | null; endTime: string | null
      startSeconds: number | null; endSeconds: number | null; summary: string | null }>
  }
  getVideoSource(taskId: string): Promise<null | { taskId: string; name: string; path: string; bytes: number; modifiedAt: number; extension: string }>
  extractFrames(sourcePath: string, requestedSeconds: number[], signal?: AbortSignal): Promise<Array<{
    requestedSeconds: number; observedSourceSeconds: number | null; width: number; height: number
    bytes: number; sha256: string; data: Buffer
  }>>
}

function compactText(value: unknown, maximum: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, maximum)
}

export async function createN8nCoverFrameCandidates(
  db: Database.Database,
  scope: N8nTaskScope,
  input: { query: string; segmentIndexes: number[] },
  services: N8nCoverFrameCandidateServices = {
    listResults: listN8nVideoResults,
    getResultDetail: getN8nVideoResultDetail,
    getVideoSource: getN8nVideoSource,
    extractFrames: extractN8nCoverFrameCandidates,
  },
  options: { signal?: AbortSignal } = {},
): Promise<{ videoName: string; totalSegments: number; candidates: CoverFrameCandidatePublic[] }> {
  const query = compactText(input.query, 120)
  if (!query || input.query !== query
    || !Array.isArray(input.segmentIndexes) || input.segmentIndexes.length < 1
    || input.segmentIndexes.length > MAX_SEGMENTS
    || input.segmentIndexes.some(index => !Number.isSafeInteger(index) || index < 1)
    || new Set(input.segmentIndexes).size !== input.segmentIndexes.length) {
    throw new Error('cover_frame_request_invalid')
  }
  const matches = services.listResults(db, scope, { query, status: 'succeeded', limit: 100 })
  if (matches.total !== 1 || matches.results.length !== 1) {
    throw new Error(matches.total > 1 ? 'cover_frame_video_ambiguous' : 'cover_frame_video_not_found')
  }
  const match = matches.results[0]
  const detail = services.getResultDetail(db, match.taskId, scope)
  if (!detail || detail.status !== 'succeeded' || detail.title !== query || !detail.resultAvailable
    || detail.learningResultInvalid || !detail.learningResult
    || !['complete', 'partial'].includes(detail.learningResult.status)) {
    throw new Error('cover_frame_learning_result_unavailable')
  }
  const failed = new Set(detail.learningResult.failedSegments.map(segment => segment.index))
  const segments = input.segmentIndexes.map(index => {
    const segment = detail.chapters.find(item => item.index === index)
    if (!segment || failed.has(index) || !Number.isFinite(segment.startSeconds)
      || !Number.isFinite(segment.endSeconds) || Number(segment.startSeconds) < 0
      || Number(segment.endSeconds) <= Number(segment.startSeconds)) throw new Error('cover_frame_segment_unavailable')
    return { ...segment, start: Number(segment.startSeconds), end: Number(segment.endSeconds) }
  })
  const source = await services.getVideoSource(detail.taskId)
  if (!source || source.name !== detail.title) throw new Error('cover_frame_original_unavailable')
  const samples = segments.flatMap(segment => SAMPLE_FRACTIONS.map(fraction => ({
    index: segment.index,
    timeRange: compactText(`${segment.startTime || ''}-${segment.endTime || ''}`, 128),
    summary: compactText(segment.summary, 500),
    seconds: Math.round((segment.start + (segment.end - segment.start) * fraction) * 1_000) / 1_000,
  })))
  const frames = await services.extractFrames(source.path, samples.map(sample => sample.seconds), options.signal)
  if (frames.length !== samples.length) throw new Error('cover_frame_extraction_incomplete')
  const candidates = frames.map((frame, index) => {
    const sample = samples[index]
    const frameRef = randomBytes(16).toString('hex')
    return {
      frameRef, segmentIndex: sample.index, timeRange: sample.timeRange,
      frameTimeSeconds: frame.observedSourceSeconds ?? frame.requestedSeconds, width: frame.width, height: frame.height,
      bytes: frame.bytes, sha256: frame.sha256, mimeType: 'image/jpeg' as const,
      data: frame.data.toString('base64'), summary: sample.summary,
    }
  })
  return { videoName: detail.title, totalSegments: detail.learningResult.totalSegments, candidates }
}
