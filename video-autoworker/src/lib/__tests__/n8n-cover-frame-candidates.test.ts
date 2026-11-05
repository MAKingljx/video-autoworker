import { describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { createN8nCoverFrameCandidates, type N8nCoverFrameCandidateServices } from '@/lib/n8n-cover-frame-candidates'

const scope = { workspaceId: 7, tenantId: 9 }
const query = '北美火车短片.mp4'
const taskId = 'video-command-test'
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3, 4])

function fixture(overrides: Partial<N8nCoverFrameCandidateServices> = {}) {
  const listResults = vi.fn(() => ({ results: [{ taskId, title: query }], total: 1 }))
  const getResultDetail = vi.fn(() => ({
    taskId, title: query, status: 'succeeded', resultAvailable: true, learningResultInvalid: false,
    learningResult: { status: 'complete', totalSegments: 25, completedSegments: 25, failedSegments: [] },
    chapters: [{ index: 3, startTime: '00:00:10.000', endTime: '00:00:15.000',
      startSeconds: 10, endSeconds: 15, summary: '列车进站' }],
  }))
  const getVideoSource = vi.fn(async () => ({ taskId, name: query, path: '/controlled/source.mp4', bytes: 1234,
    modifiedAt: 1000, extension: '.mp4' }))
  const extractFrames = vi.fn(async (_path: string, times: number[]) => times.map(requestedSeconds => ({
    requestedSeconds, observedSourceSeconds: requestedSeconds, width: 1920, height: 1080,
    bytes: jpeg.length, sha256: 'a'.repeat(64), data: jpeg,
  })))
  return {
    listResults, getResultDetail, getVideoSource, extractFrames,
    services: { listResults, getResultDetail, getVideoSource, extractFrames, ...overrides } as N8nCoverFrameCandidateServices,
  }
}

describe('n8n cover frame candidates', () => {
  it('maps a unique completed video and selected learned segment to bounded real-source frames', async () => {
    const f = fixture()
    const result = await createN8nCoverFrameCandidates({} as Database.Database, scope,
      { query, segmentIndexes: [3] }, f.services)
    expect(f.listResults).toHaveBeenCalledWith(expect.anything(), scope, { query, status: 'succeeded', limit: 100 })
    expect(f.extractFrames).toHaveBeenCalledWith('/controlled/source.mp4', [11, 12.5, 14], undefined)
    expect(result.videoName).toBe(query)
    expect(result.totalSegments).toBe(25)
    expect(result.candidates).toHaveLength(3)
    expect(result.candidates.every(frame => /^[a-f0-9]{32}$/u.test(frame.frameRef))).toBe(true)
    expect(result.candidates[1]).toMatchObject({ segmentIndex: 3, frameTimeSeconds: 12.5, timeRange: '00:00:10.000-00:00:15.000' })
    expect(JSON.stringify(result)).not.toContain('/controlled/source.mp4')
    expect(JSON.stringify(result)).not.toContain(taskId)
  })

  it('refuses duplicate or non-directory segment selections before reading a video', async () => {
    const f = fixture()
    await expect(createN8nCoverFrameCandidates({} as Database.Database, scope,
      { query, segmentIndexes: [3, 3] }, f.services)).rejects.toThrow('cover_frame_request_invalid')
    expect(f.listResults).not.toHaveBeenCalled()
    await expect(createN8nCoverFrameCandidates({} as Database.Database, scope,
      { query, segmentIndexes: [3, 4] }, f.services)).rejects.toThrow('cover_frame_request_invalid')
    expect(f.listResults).not.toHaveBeenCalled()
  })

  it('fails closed for ambiguous titles, failed learning and sources from another video', async () => {
    const ambiguous = fixture({ listResults: vi.fn(() => ({ results: [
      { taskId, title: query }, { taskId: 'other', title: query },
    ], total: 2 })) })
    await expect(createN8nCoverFrameCandidates({} as Database.Database, scope,
      { query, segmentIndexes: [3] }, ambiguous.services)).rejects.toThrow('cover_frame_video_ambiguous')

    const incomplete = fixture({ getResultDetail: vi.fn(() => ({
      taskId, title: query, status: 'succeeded', resultAvailable: true, learningResultInvalid: false,
      learningResult: { status: 'partial', totalSegments: 25, completedSegments: 24, failedSegments: [{ index: 3 }] },
      chapters: [{ index: 3, startTime: '00:00:10.000', endTime: '00:00:15.000',
        startSeconds: 10, endSeconds: 15, summary: '列车进站' }],
    })) })
    await expect(createN8nCoverFrameCandidates({} as Database.Database, scope,
      { query, segmentIndexes: [3] }, incomplete.services)).rejects.toThrow('cover_frame_segment_unavailable')

    const wrongSource = fixture({ getVideoSource: vi.fn(async () => ({ taskId, name: 'other.mp4', path: '/x', bytes: 1,
      modifiedAt: 1, extension: '.mp4' })) })
    await expect(createN8nCoverFrameCandidates({} as Database.Database, scope,
      { query, segmentIndexes: [3] }, wrongSource.services)).rejects.toThrow('cover_frame_original_unavailable')
  })
})
