import { describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { readN8nVideoCoverDirectory, type N8nVideoCoverWorkflowServices } from '@/lib/n8n-video-cover-workflow'

const scope = { workspaceId: 7, tenantId: 9 }
const query = '北美火车短片.mp4'
const taskId = 'video-command-test'

function fixture(overrides: Partial<N8nVideoCoverWorkflowServices> = {}) {
  const listResults = vi.fn(() => ({ results: [{ taskId, title: query }], total: 1 }))
  const getResultDetail = vi.fn(() => ({
    taskId, title: query, status: 'succeeded', resultAvailable: true, learningResultInvalid: false,
    learningResult: { status: 'partial', totalSegments: 3, failedSegments: [{ index: 2 }] },
    chapters: [
      { index: 1, startTime: '00:00:00.000', endTime: '00:00:05.000', startSeconds: 0, endSeconds: 5, summary: '蒸汽火车进站，司机在驾驶室观察前方。' },
      { index: 2, startTime: '00:00:05.000', endTime: '00:00:10.000', startSeconds: 5, endSeconds: 10, summary: '这一段学习失败。' },
      { index: 3, startTime: '00:00:10.000', endTime: '00:00:15.000', startSeconds: 10, endSeconds: 15, summary: '老式火车穿过山谷，人物与环境同框。' },
    ],
  }))
  return { listResults, getResultDetail, services: { listResults, getResultDetail, ...overrides } as N8nVideoCoverWorkflowServices }
}

describe('n8n video cover workflow directory', () => {
  it('returns a task-id-free saved-summary directory and marks failed segments unavailable', () => {
    const f = fixture()
    const result = readN8nVideoCoverDirectory({} as Database.Database, scope, { query }, f.services)
    expect(f.listResults).toHaveBeenCalledWith(expect.anything(), scope, { query, status: 'succeeded', limit: 100 })
    expect(result).toMatchObject({ videoName: query, totalSegments: 3, directoryPreviewCompacted: false })
    expect(result.items).toEqual([
      expect.objectContaining({ index: 1, available: true }),
      expect.objectContaining({ index: 2, available: false }),
      expect.objectContaining({ index: 3, available: true }),
    ])
    expect(JSON.stringify(result)).not.toContain(taskId)
  })

  it('fails closed for ambiguous, invalid, or malformed learned-video state', () => {
    const ambiguous = fixture({ listResults: vi.fn(() => ({ results: [{ taskId, title: query }, { taskId: 'other', title: query }], total: 2 })) })
    expect(() => readN8nVideoCoverDirectory({} as Database.Database, scope, { query }, ambiguous.services)).toThrow('cover_workflow_video_ambiguous')

    const malformed = fixture({ getResultDetail: vi.fn(() => ({
      taskId, title: query, status: 'succeeded', resultAvailable: true,
      learningResult: { status: 'complete', totalSegments: 1, failedSegments: [] },
      chapters: [{ index: 2, startTime: null, endTime: null, startSeconds: null, endSeconds: null, summary: null }],
    })) })
    expect(() => readN8nVideoCoverDirectory({} as Database.Database, scope, { query }, malformed.services)).toThrow('cover_workflow_learning_result_unavailable')
    expect(() => readN8nVideoCoverDirectory({} as Database.Database, scope, { query: ' bad ' }, fixture().services)).toThrow('cover_workflow_request_invalid')
  })

  it('retains every identity while compacting Chinese previews by bytes rather than characters', () => {
    const f = fixture({ getResultDetail: vi.fn(() => ({
      taskId, title: query, status: 'succeeded', resultAvailable: true, learningResultInvalid: false,
      learningResult: { status: 'complete', totalSegments: 2, failedSegments: [] },
      chapters: [1, 2].map(index => ({ index, startTime: '00:00:00.000', endTime: '00:00:05.000',
        startSeconds: 0, endSeconds: 5, summary: '蒸汽火车'.repeat(20_000) })),
    })) })
    const result = readN8nVideoCoverDirectory({} as Database.Database, scope, { query }, f.services)
    expect(result.items.map(item => item.index)).toEqual([1, 2])
    expect(result.directoryPreviewCompacted).toBe(true)
    expect(Buffer.byteLength(result.items.map(item => item.summary).join(''), 'utf8')).toBeLessThanOrEqual(24 * 1024)
  })
})
