import { describe, expect, it, vi } from 'vitest'

import {
  readSegmentDirectory,
  SEGMENT_DIRECTORY_PAGE_SIZE,
  SEGMENT_DIRECTORY_PREVIEW_BYTES,
} from '../lib/segment-directory-reader.js'

const taskId = `video-command-${'a'.repeat(64)}`

function runner(total, changes = () => ({})) {
  return {
    taskResult: vi.fn(async ({ query, view, segmentOffset, segmentLimit }) => {
      expect(view).toBe('segments')
      expect(query === 'S03E03' || query === taskId).toBe(true)
      const items = Array.from({ length: Math.min(segmentLimit, total - segmentOffset) }, (_, itemOffset) => {
        const index = segmentOffset + itemOffset + 1
        return {
          index,
          timeRange: `00:00:${String(index - 1).padStart(2, '0')}-00:00:${String(index).padStart(2, '0')}`,
          preview: `片段${index}${'摘要'.repeat(100)}`,
        }
      })
      return {
        kind: 'segments', taskId, name: 'S03E03.mp4', status: 'succeeded', source: 'segment_summary',
        totalSegments: total, segmentOffset, segmentLimit, items,
        nextSegmentOffset: segmentOffset + items.length < total ? segmentOffset + items.length : null,
        ...changes({ query, segmentOffset, segmentLimit, items }),
      }
    }),
  }
}

describe('adaptive segment directory reader', () => {
  it('reads a 25-segment request across 20-item transport pages without exposing that page size', async () => {
    const value = runner(45)
    const result = await readSegmentDirectory({ runner: value, query: 'S03E03', limit: 25 })

    expect(result.items).toHaveLength(25)
    expect(result.items.at(-1)?.index).toBe(25)
    expect(result.nextSegmentOffset).toBe(25)
    expect(result.directoryComplete).toBe(false)
    expect(result.pagesRead).toBe(2)
    expect(value.taskResult.mock.calls.map(([input]) => input).sort((left, right) => left.segmentOffset - right.segmentOffset)).toEqual([
      { query: 'S03E03', view: 'segments', segmentOffset: 0, segmentLimit: SEGMENT_DIRECTORY_PAGE_SIZE },
      { query: taskId, view: 'segments', segmentOffset: 20, segmentLimit: 5 },
    ])
  })

  it('reads the full available directory when no caller limit is supplied', async () => {
    const value = runner(45)
    const result = await readSegmentDirectory({ runner: value, query: 'S03E03' })

    expect(result.items).toHaveLength(45)
    expect(result.directoryComplete).toBe(true)
    expect(result.nextSegmentOffset).toBeNull()
    expect(result.pagesRead).toBe(3)
  })

  it('preserves every segment identity while compacting only previews to the shared context budget', async () => {
    const value = runner(210)
    const result = await readSegmentDirectory({ runner: value, query: 'S03E03' })

    expect(result.items).toHaveLength(210)
    expect(result.items.map(item => item.index)).toEqual(Array.from({ length: 210 }, (_, index) => index + 1))
    expect(result.directoryPreviewCompacted).toBe(true)
    expect(result.items.every(item => Buffer.byteLength(item.preview, 'utf8') <= Math.floor(SEGMENT_DIRECTORY_PREVIEW_BYTES / 210))).toBe(true)
  })

  it('rejects a page whose task identity or continuation changes while reading', async () => {
    const changedIdentity = runner(25, ({ segmentOffset }) => segmentOffset === 20
      ? { taskId: `video-command-${'b'.repeat(64)}` } : {})
    await expect(readSegmentDirectory({ runner: changedIdentity, query: 'S03E03' }))
      .rejects.toThrow('segment_directory_changed')

    const badContinuation = runner(25, ({ segmentOffset }) => segmentOffset === 0
      ? { nextSegmentOffset: 19 } : {})
    await expect(readSegmentDirectory({ runner: badContinuation, query: 'S03E03' }))
      .rejects.toThrow('segment_directory_pagination_inconsistent')
  })

  it('honors an already-cancelled read before dispatching any page', async () => {
    const controller = new AbortController()
    controller.abort()
    const value = runner(25)
    await expect(readSegmentDirectory({ runner: value, query: 'S03E03', signal: controller.signal }))
      .rejects.toThrow('segment_directory_read_cancelled')
    expect(value.taskResult).not.toHaveBeenCalled()
  })
})
