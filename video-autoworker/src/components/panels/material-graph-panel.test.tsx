import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { MaterialGraphMaterial, MaterialGraphSnapshot } from '@/lib/material-graph'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MaterialGraphPanel } from './material-graph-panel'

it('owns wheel zoom without scrolling the containing page', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => response(snapshot())))
  render(<MaterialGraphPanel projectId="project-a" onOpenMaterial={vi.fn()} />)
  const graph = await screen.findByLabelText('按场景关联的素材图，共 2 个素材点')
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 })
  fireEvent(graph, event)
  expect(event.defaultPrevented).toBe(true)
  expect(screen.getByLabelText('图谱缩放比例')).toHaveTextContent('108%')
})

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolver => { resolve = resolver })
  return { promise, resolve }
}

const mountainEvidence = {
  id: 'ev-mountain',
  pipeline: 'episode-01',
  sceneId: 4,
  start: 12.5,
  end: 18,
  summary: '人物走过雪山营地',
  labels: { scene: ['雪山'], emotion: ['宁静'] },
}

const materials: MaterialGraphMaterial[] = [
  {
    id: 'material-a',
    name: '雪岭远眺.mp4',
    path: '/media/snow.mp4',
    project: 'project-a',
    labels: { scene: ['雪山'], emotion: ['宁静'] },
    evidence: [mountainEvidence],
    evidenceCount: 1,
  },
  {
    id: 'material-b',
    name: '林间清晨.mp4',
    path: '/media/forest.mp4',
    project: 'project-a',
    labels: { scene: ['雪山', '森林'], emotion: ['振奋'] },
    evidence: [{
      id: 'ev-forest',
      pipeline: 'episode-02',
      sceneId: 8,
      start: 25,
      end: 31,
      summary: '树林中的晨光',
      labels: { scene: ['森林'], emotion: ['振奋'] },
    }],
    evidenceCount: 1,
  },
]

function snapshot(items: MaterialGraphMaterial[] = materials): MaterialGraphSnapshot {
  return {
    schemaVersion: 1,
    generatedAt: '2026-09-13T08:00:00.000Z',
    materials: items,
    stats: {
      totalMaterials: items.length,
      scannedScenes: 2,
      unmatchedScenes: 0,
      unreadablePipelines: 0,
      truncated: false,
    },
  }
}

describe('MaterialGraphPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders exactly one point per video and does not duplicate points when dimensions switch', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(snapshot())))
    render(<MaterialGraphPanel projectId="project-a" onOpenMaterial={vi.fn()} />)

    expect(await screen.findAllByTestId('material-node')).toHaveLength(2)
    expect(screen.getAllByTestId('material-edge')).toHaveLength(1)

    fireEvent.change(screen.getByRole('combobox', { name: '关联维度' }), { target: { value: 'emotion' } })
    expect(screen.getAllByTestId('material-node')).toHaveLength(2)
    expect(screen.queryAllByTestId('material-edge')).toHaveLength(0)
  })

  it('uses the stable material id as the single node identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(snapshot([
      materials[0],
      { ...materials[0], name: '重复返回不应形成第二个点.mp4' },
    ]))))
    render(<MaterialGraphPanel projectId="project-a" onOpenMaterial={vi.fn()} />)

    expect(await screen.findAllByTestId('material-node')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '素材：重复返回不应形成第二个点.mp4' })).toBeInTheDocument()
  })

  it('uses an exact project query for the current work and omits it for the all-work scope', async () => {
    const fetchMock = vi.fn(async () => response(snapshot()))
    vi.stubGlobal('fetch', fetchMock)
    render(<MaterialGraphPanel projectId="project a/一" onOpenMaterial={vi.fn()} />)

    await screen.findByRole('button', { name: '素材：雪岭远眺.mp4' })
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/materials/graph?project=project%20a%2F%E4%B8%80',
      expect.objectContaining({ cache: 'no-store' }),
    )

    fireEvent.click(screen.getByRole('button', { name: '全部作品' }))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/materials/graph', expect.objectContaining({ cache: 'no-store' }))
  })

  it('filters by search and highlights a selected label without turning labels into nodes', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(snapshot())))
    render(<MaterialGraphPanel projectId="project-a" onOpenMaterial={vi.fn()} />)
    await screen.findByRole('button', { name: '素材：雪岭远眺.mp4' })

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索素材' }), { target: { value: '森林' } })
    expect(screen.queryByRole('button', { name: '素材：雪岭远眺.mp4' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '素材：林间清晨.mp4' })).toBeInTheDocument()
    expect(screen.getAllByTestId('material-node')).toHaveLength(1)

    fireEvent.change(screen.getByRole('searchbox', { name: '搜索素材' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: '森林 1' }))
    expect(screen.getByRole('button', { name: '素材：林间清晨.mp4' })).toHaveAttribute('data-emphasized', 'true')
    expect(screen.getByRole('button', { name: '素材：雪岭远眺.mp4' })).toHaveAttribute('data-dimmed', 'true')
    expect(screen.getAllByTestId('material-node')).toHaveLength(2)
  })

  it('keeps errors retryable and clearly reports an empty material range', async () => {
    let calls = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1
      return calls === 1
        ? response({ error: '图谱读取暂时失败' }, 503)
        : response(snapshot([]))
    }))
    render(<MaterialGraphPanel projectId="project-a" onOpenMaterial={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('图谱读取暂时失败')
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('heading', { name: '暂无可绘制的完整视频素材' })).toBeInTheDocument()
    expect(calls).toBe(2)
  })

  it('does not let a stale project response overwrite the newly selected project', async () => {
    const oldRequest = deferred<Response>()
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('project=project-a')) return oldRequest.promise
      return Promise.resolve(response(snapshot([{ ...materials[1], id: 'project-b-material', project: 'project-b' }])))
    })
    vi.stubGlobal('fetch', fetchMock)
    const { rerender } = render(<MaterialGraphPanel projectId="project-a" onOpenMaterial={vi.fn()} />)

    rerender(<MaterialGraphPanel projectId="project-b" onOpenMaterial={vi.fn()} />)
    expect(await screen.findByRole('button', { name: '素材：林间清晨.mp4' })).toBeInTheDocument()

    await act(async () => oldRequest.resolve(response(snapshot([{ ...materials[0], name: '旧项目素材.mp4' }]))))
    await waitFor(() => expect(screen.queryByRole('button', { name: '素材：旧项目素材.mp4' })).not.toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/api/materials/graph?project=project-b', expect.objectContaining({ cache: 'no-store' }))
  })

  it('opens the exact selected material with its chosen evidence time range', async () => {
    const onOpenMaterial = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => response(snapshot())))
    render(<MaterialGraphPanel projectId="project-a" onOpenMaterial={onOpenMaterial} />)

    const materialNode = await screen.findByRole('button', { name: '素材：雪岭远眺.mp4' })
    fireEvent.keyDown(materialNode, { key: 'Enter' })
    expect(screen.getByText('/media/snow.mp4')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '回到素材预览 · 00:12.5–00:18' }))

    expect(onOpenMaterial).toHaveBeenCalledTimes(1)
    expect(onOpenMaterial).toHaveBeenCalledWith(materials[0], mountainEvidence)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('shows when materials have no recognized labels for the active dimension', async () => {
    const unlabelled = [{
      ...materials[0],
      labels: { scene: [], emotion: ['宁静'] },
      evidence: [],
      evidenceCount: 0,
    }]
    vi.stubGlobal('fetch', vi.fn(async () => response(snapshot(unlabelled))))
    render(<MaterialGraphPanel projectId="project-a" onOpenMaterial={vi.fn()} />)

    expect(await screen.findByText('这些素材尚未识别出场景标签，因此当前没有可连接的关系。')).toBeInTheDocument()
    expect(screen.getAllByTestId('material-node')).toHaveLength(1)
  })
})
