import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditingPanel } from './editing-panel'

const hash = 'a'.repeat(64)
function candidate() {
  return { schemaVersion: 1, planId: 'plan-1', revision: 1, status: 'validated', planSha256: hash,
    scope: { tenantId: 1, workspaceId: 1 }, sourceTaskIds: ['source-task'], objective: '讲清低温保存的完整故事',
    sourceFrameRate: { numerator: 25, denominator: 1 }, timelineFrameRate: { numerator: 25, denominator: 1 },
    base: { editorNodeId: 'h1', resolveVersion: '21.1', projectUniqueId: 'project', timelineName: '预览', projectFingerprint: hash },
    clips: [{ itemId: 'clip-1', asset: { assetId: 'asset', contentSha256: hash, revision: '1' },
      evidence: [{ evidenceId: 'evidence', assetId: 'asset', revision: '1', source: 'saved-summary', completeness: 'complete' }],
      sourceRange: { start: 125, endExclusive: 875 }, timelineStartFrame: 0, trackIndex: 1,
      mediaType: 'av', audioGainDb: -3, rationale: '这段介绍保存技术，承接前面的故事背景。' }],
    output: { preview: true, autoSubtitles: true, renderPreset: '三分钟短片预览' }, capabilitiesRequired: [], createdAt: 1, updatedAt: 1 }
}
function fixture(overrides: Record<string, unknown> = {}) {
  const state = { studio: true, enabled: true, canApprove: true, approved: false, token: 'browser-review-token',
    changed: false, unknown: false, ...overrides }
  const posts: Array<{ url: string; body: Record<string, unknown> }> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); posts.push({ url, body }); state.approved = true
      return response({ status: 'queued', taskId: body.taskId })
    }
    const plan = candidate()
    const detail = { planId: plan.planId, revision: 1, planSha256: state.changed ? 'b'.repeat(64) : hash,
      planStatus: state.approved ? 'approved' : 'validated', taskStatus: state.approved ? 'running' : null,
      taskId: state.approved ? 'existing-task' : null, plan,
      reviewToken: state.token, operations: state.unknown ? [{ phase: 'render', status: 'unknown' }] : [] }
    if (url === '/api/editing/status') return response({ enabled: state.enabled, schemaReady: true,
      bindingId: 4, canApprove: state.canApprove, canCancel: true, executor: { connected: true, studio: state.studio, projectName: '冷冻人' } })
    if (url === '/api/runtime/current') return response({ currentState: 'ready', sourceCommit: 'c'.repeat(40) })
    if (url === '/api/editing/plans') return response({ plans: [{ ...detail, objective: plan.objective, clipCount: 1 }] })
    if (url.startsWith('/api/editing/plans?')) return response(detail)
    throw new Error('unexpected request')
  })
  vi.stubGlobal('fetch', fetchMock)
  return { state, posts, fetchMock }
}
function response(value: unknown) { return { ok: true, json: async () => value } as Response }
afterEach(() => vi.unstubAllGlobals())

describe('EditingPanel', () => {
  it('shows evidence, volume, subtitles and export settings without a JSON editor or automatic approval', async () => {
    const { posts } = fixture()
    render(<EditingPanel />)
    expect(await screen.findByText('这段介绍保存技术，承接前面的故事背景。')).toBeInTheDocument()
    expect(screen.getByText(/音量 -3 dB/)).toBeInTheDocument()
    expect(screen.getByText(/已计划自动生成字幕/)).toBeInTheDocument()
    expect(screen.getByText(/三分钟短片预览/)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(posts).toHaveLength(0)
  })

  it('only confirms after an explicit dialog action and sends the refreshed browser review token', async () => {
    const { posts } = fixture()
    render(<EditingPanel />)
    const button = await screen.findByRole('button', { name: '审核后确认执行' })
    await waitFor(() => expect(button).toBeEnabled())
    fireEvent.click(button)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(posts).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: '确认执行此方案' }))
    await waitFor(() => expect(posts).toHaveLength(1))
    expect(posts[0].body).toMatchObject({ action: 'approve', planId: 'plan-1', revision: 1,
      expectedPlanSha256: hash, bindingId: 4, reviewToken: 'browser-review-token' })
    expect(posts[0].body.taskId).toMatch(/^edit-/)
    expect(posts[0].body.approved).toBeUndefined()
  })

  it('changed plan content stops approval and asks for another review', async () => {
    const { state, posts } = fixture()
    render(<EditingPanel />)
    const button = await screen.findByRole('button', { name: '审核后确认执行' })
    await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button)
    state.changed = true
    fireEvent.click(screen.getByRole('button', { name: '确认执行此方案' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('方案已更新')
    expect(posts).toHaveLength(0)
  })

  it('missing or expired browser confirmation does not fall back to approval', async () => {
    const { state, posts } = fixture()
    render(<EditingPanel />)
    const button = await screen.findByRole('button', { name: '审核后确认执行' })
    await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button)
    state.token = ''
    fireEvent.click(screen.getByRole('button', { name: '确认执行此方案' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('暂不能确认执行')
    expect(posts).toHaveLength(0)
  })

  it.each([{ studio: false }, { enabled: false }, { canApprove: false }])('execution stays disabled under unavailable capability %o', async flags => {
    const { posts } = fixture(flags)
    render(<EditingPanel />)
    expect(await screen.findByRole('button', { name: '审核后确认执行' })).toBeDisabled()
    expect(posts).toHaveLength(0)
  })

  it('unknown steps remain explicitly unresolved and refreshing does not execute them', async () => {
    const { posts } = fixture({ approved: true, unknown: true })
    render(<EditingPanel />)
    expect(await screen.findByText(/存在结果未知的步骤/)).toBeInTheDocument()
    expect(screen.getByText(/结果未知，等待核对/)).toBeInTheDocument()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '刷新' })) })
    expect(posts).toHaveLength(0)
  })
})
