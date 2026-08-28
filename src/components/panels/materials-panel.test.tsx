import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MaterialsPanel } from './materials-panel'

function project(id: string, name: string, scenes: number) {
  return {
    id,
    name,
    path: `/materials/${id}`,
    modifiedAt: '2026-08-28T00:00:00.000Z',
    videos: [{
      name: `${name}-ep01.mp4`,
      path: `/materials/${id}/${name}-ep01.mp4`,
      size: 1_024,
      modifiedAt: '2026-08-28T00:00:00.000Z',
    }],
    notes: [],
    pipelines: [],
    totals: {
      videos: 1,
      notes: 0,
      scenes,
      visualDone: scenes,
      visualPending: 0,
      vectorChunks: scenes,
    },
  }
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    json: async () => body,
  } as Response
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('MaterialsPanel', () => {
  it('opens recognition results after search and clears stale results when navigating to another project', async () => {
    const projects = [project('project-a', '项目甲', 4), project('project-b', '项目乙', 2)]

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.startsWith('/api/materials/search?')) {
        return jsonResponse({
          query: '人物',
          mode: 'hybrid',
          generatedAt: '2026-08-28T00:00:01.000Z',
          vectorAvailable: true,
          results: [{
            id: 'result-1',
            project: 'project-a',
            pipeline: 'episode-1',
            sceneId: 1,
            label: '人物进入画面',
            start: 10,
            end: 14,
            score: 0.9,
            source: 'hybrid',
            snippet: '人物进入画面',
            transcript: '',
            visualSummary: '人物进入画面',
            tags: ['人物'],
            previewFrames: [],
            metadata: {},
          }],
        })
      }
      return jsonResponse({
        workspaceRoot: '/materials',
        botLearningRoot: '/learning',
        generatedAt: '2026-08-28T00:00:00.000Z',
        vector: {
          exists: true,
          path: '/materials/vector.db',
          chunks: 6,
          indexedAt: '2026-08-28T00:00:00.000Z',
          model: 'embedding-model',
          dims: 1_024,
        },
        totals: {
          projects: 2,
          videos: 2,
          notes: 0,
          pipelines: 0,
          scenes: 6,
          visualDone: 6,
          visualPending: 0,
          vectorChunks: 6,
        },
        projects,
      })
    }))

    render(<MaterialsPanel />)

    fireEvent.change(await screen.findByPlaceholderText('搜索地点、人物、动作、字幕、画面氛围'), {
      target: { value: '人物' },
    })
    fireEvent.click(screen.getByRole('button', { name: '搜索素材' }))

    expect(await screen.findByRole('heading', { name: '通义识别结果' })).toBeInTheDocument()
    expect(screen.getAllByText('人物进入画面').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: /项目乙/ }))

    expect(await screen.findByRole('heading', { name: '项目乙' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: '通义识别结果' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '识别结果' })).toBeInTheDocument()
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
  })
})
