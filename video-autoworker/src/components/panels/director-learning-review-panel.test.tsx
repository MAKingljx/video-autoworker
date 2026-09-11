import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DirectorLearningReviewPanel, type DirectorLearningReview } from './director-learning-review-panel'

function response(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

function candidate(index: number, kind: 'person_profile' | 'story_node') {
  return {
    candidateId: `candidate-${String(index).padStart(2, '0')}`,
    kind,
    title: kind === 'person_profile' ? `人物档案 ${index}` : `故事节点 ${index}`,
    summary: `第 ${index} 条候选的完整摘要。`,
    rationale: `第 ${index} 条候选的判断依据。`,
    confidence: 0.8 + index / 100,
  }
}

function pendingReview(): DirectorLearningReview {
  return {
    reviewId: 'a'.repeat(64), reviewRevision: 4,
    workName: '地球之极第一季第一集', phase: 'understanding',
    progress: 40, progressKnown: true, pendingCount: 7,
    candidates: [
      candidate(1, 'person_profile'), candidate(2, 'person_profile'), candidate(3, 'person_profile'),
      candidate(4, 'story_node'), candidate(5, 'story_node'), candidate(6, 'story_node'), candidate(7, 'story_node'),
    ],
  }
}

function prepared(count = 1) {
  return response({
    ok: true, action: 'prepare',
    batchId: `DRB-${'b'.repeat(32)}`, confirmationCode: 'ABC123', count,
  })
}

function list(reviews: DirectorLearningReview[] = [pendingReview()]) {
  return response({ ok: true, action: 'list', reviews })
}

afterEach(() => vi.unstubAllGlobals())

describe('DirectorLearningReviewPanel', () => {
  it('renders all seven candidates without internal identifiers', async () => {
    const review = {
      ...pendingReview(), workId: 'WORK-INTERNAL-001',
      candidates: pendingReview().candidates.map((item, index) => ({ ...item, stableId: `STABLE-INTERNAL-${index}` })),
    }
    const onPendingCountChange = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => list([review])))
    render(<DirectorLearningReviewPanel onPendingCountChange={onPendingCountChange} />)

    expect(await screen.findByRole('heading', { name: '地球之极第一季第一集' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '人物档案' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: '故事节点' })).toBeInTheDocument()
    for (let index = 1; index <= 7; index += 1) {
      expect(screen.getByText(`第 ${index} 条候选的完整摘要。`)).toBeInTheDocument()
      expect(screen.getByText(`第 ${index} 条候选的判断依据。`)).toBeInTheDocument()
    }
    expect(screen.getByText(/真实进度：40% · 待审核 7 条/)).toBeInTheDocument()
    expect(screen.queryByText('WORK-INTERNAL-001')).not.toBeInTheDocument()
    expect(screen.queryByText(/STABLE-INTERNAL/)).not.toBeInTheDocument()
    expect(onPendingCountChange).toHaveBeenCalledWith(7)
  })

  it('prepares without confirming and shows the dialog only after the batch is fixed', async () => {
    const preparation = deferred<Response>()
    const requests: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      requests.push(body)
      return body.action === 'prepare' ? preparation.promise : list()
    }))
    render(<DirectorLearningReviewPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '批准：人物档案 1' }))

    await waitFor(() => expect(requests.at(-1)).toMatchObject({
      action: 'prepare', decision: 'approve', candidateIds: ['candidate-01'], reviewRevision: 4,
    }))
    expect(requests.some(item => item.action === 'confirm')).toBe(false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await act(async () => preparation.resolve(prepared()))
    const dialog = await screen.findByRole('dialog', { name: '确认批准候选' })
    expect(dialog).toHaveFocus()
    expect(within(dialog).getByText('确认批准 1 条候选？')).toBeInTheDocument()
    expect(requests.some(item => item.action === 'confirm')).toBe(false)
  })

  it('confirms with the exact prepared identity and refreshes before unlocking', async () => {
    const requests: Array<Record<string, unknown>> = []
    let listCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      requests.push(body)
      if (body.action === 'prepare') return prepared()
      if (body.action === 'confirm') return response({ ok: true, action: 'confirm', outcome: 'completed', message: '审核完成并已回读。' })
      listCalls += 1
      return list(listCalls === 1 ? [pendingReview()] : [])
    }))
    render(<DirectorLearningReviewPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '批准：人物档案 1' }))
    const dialog = await screen.findByRole('dialog', { name: '确认批准候选' })
    fireEvent.click(within(dialog).getByRole('button', { name: '确认批准' }))

    expect(await screen.findByText('审核完成并已回读。')).toBeInTheDocument()
    expect(await screen.findByRole('heading', { name: '暂无待审核候选' })).toBeInTheDocument()
    const prepareBody = requests.find(item => item.action === 'prepare')!
    expect(requests.find(item => item.action === 'confirm')).toEqual({
      action: 'confirm', requestId: prepareBody.requestId,
      reviewId: 'a'.repeat(64), reviewRevision: 4, decision: 'approve',
      candidateIds: ['candidate-01'], batchId: `DRB-${'b'.repeat(32)}`,
      confirmationCode: 'ABC123', count: 1,
    })
  })

  it('replays an unknown result with the same batch and keeps other writes locked', async () => {
    const requests: Array<Record<string, unknown>> = []
    let confirms = 0
    let listCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      requests.push(body)
      if (body.action === 'prepare') return prepared()
      if (body.action === 'confirm') {
        confirms += 1
        return confirms === 1
          ? response({ ok: false, action: 'confirm', outcome: 'unknown' }, 503)
          : response({ ok: true, action: 'confirm', outcome: 'completed' })
      }
      listCalls += 1
      return list(listCalls === 1 ? [pendingReview()] : [])
    }))
    render(<DirectorLearningReviewPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '批准：人物档案 1' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认批准' }))

    expect(await screen.findByText('上次确认结果暂时未知。请使用同一批次继续核对，或刷新当前状态。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全部批准' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '驳回：故事节点 7' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '继续核对' }))

    await screen.findByRole('heading', { name: '暂无待审核候选' })
    const confirmBodies = requests.filter(item => item.action === 'confirm')
    expect(confirmBodies).toHaveLength(2)
    expect(confirmBodies[1]).toEqual(confirmBodies[0])
  })

  it('keeps writes locked after completion until the list readback succeeds', async () => {
    const readback = deferred<Response>()
    let listCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      if (body.action === 'prepare') return prepared()
      if (body.action === 'confirm') return response({ ok: true, action: 'confirm', outcome: 'completed' })
      listCalls += 1
      return listCalls === 1 ? list() : readback.promise
    }))
    render(<DirectorLearningReviewPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '批准：人物档案 1' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认批准' }))

    expect(await screen.findByText('审核已提交，正在等待列表回读。回读完成前不会接受新的审核操作。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '全部批准' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '提交中...' })).toBeDisabled()

    await act(async () => readback.resolve(list([])))
    expect(await screen.findByRole('heading', { name: '暂无待审核候选' })).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('focuses a prepared confirmation and Escape cancels it remotely before closing', async () => {
    const requests: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      requests.push(body)
      if (body.action === 'prepare') return prepared()
      if (body.action === 'cancel') return response({ ok: true, action: 'cancel', outcome: 'completed' })
      return list()
    }))
    render(<DirectorLearningReviewPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '驳回：人物档案 1' }))
    const dialog = await screen.findByRole('dialog', { name: '确认驳回候选' })
    expect(dialog).toHaveFocus()
    fireEvent.keyDown(document, { key: 'Escape' })

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(requests.find(item => item.action === 'cancel')).toEqual({
      action: 'cancel', batchId: `DRB-${'b'.repeat(32)}`, confirmationCode: 'ABC123',
    })
  })

  it('closes a local cancellation even when its remote outcome is unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
      if (body.action === 'prepare') return prepared()
      if (body.action === 'cancel') throw new Error('network down')
      return list()
    }))
    render(<DirectorLearningReviewPanel />)
    fireEvent.click(await screen.findByRole('button', { name: '批准：人物档案 1' }))
    fireEvent.click(await screen.findByRole('button', { name: '取消' }))

    expect(await screen.findByText('取消结果暂时无法确认。请刷新后再继续审核。')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps a failed list request visible and retryable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ error: '学习审核服务暂时不可用' }, 503)))
    render(<DirectorLearningReviewPanel />)
    expect(await screen.findByRole('alert')).toHaveTextContent('学习审核服务暂时不可用')
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled()
  })
})
