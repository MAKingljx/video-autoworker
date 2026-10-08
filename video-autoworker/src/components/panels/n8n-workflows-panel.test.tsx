import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { N8nWorkflowsPanel } from './n8n-workflows-panel'

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function configFixture(): Record<string, unknown> {
  return {
    customSetting: { keep: true },
    segmentSeconds: 60,
    segmentOverlapSeconds: 2,
    media: { segmentSeconds: 5, segmentOverlapSeconds: 0, language: 'en', frameWidth: 800, maxFrames: 9 },
    modelRouting: {
      allowTaskOverride: false,
      metadata: { keep: 'routing' },
      nodes: {
        planner: { routeId: 'local-route', temperature: 0.3 },
        auxiliary: { routeId: 'local-route', custom: true },
      },
    },
  }
}

function installApi(config = configFixture(), taskType = 'video-analysis', windowError?: string,
  capabilities = { create: true, update: true, delete: true, trigger: true, saveLearningWindow: true }) {
  let binding = {
    id: 4, name: '学习窗口测试', description: '', workflowId: 'workflow-4',
    webhookPath: 'webhook/video-learning', taskType, agentRole: 'executor',
    model: 'qwen36-tools-local/default_model', timeoutSeconds: 30, retryCount: 1, enabled: true,
    config, createdBy: 'test', createdAt: 1, updatedAt: 1, lastRunAt: null, lastStatus: null,
  }
  const writes: Record<string, unknown>[] = []
  const windowWrites: Record<string, unknown>[] = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === '/api/n8n/status') return response({
      health: { ok: true, baseUrl: 'http://127.0.0.1:5678', apiKeyConfigured: false,
        statusCode: 200, latencyMs: 1, error: null },
      config: { baseUrl: 'http://127.0.0.1:5678', apiKeyConfigured: false,
        defaultWebhookPath: 'webhook/aiworker-task' }, remoteWorkflows: [], managementError: null,
    })
    if (url === '/api/n8n/models') return response({ routes: [{
      id: 'local-route', label: '本地测试模型', location: 'local', transport: 'openclaw',
      model: 'qwen36-tools-local/default_model', enabled: true, available: true, unavailableReason: null,
    }] })
    if (url === '/api/n8n/workflows/learning-window' && init?.method === 'PUT') {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>
      windowWrites.push(payload)
      if (windowError) return response({ error: windowError }, 409)
      const previousMedia = binding.config.media as Record<string, unknown>
      const changed = previousMedia.segmentSeconds !== payload.segmentSeconds
      binding = { ...binding, config: { ...binding.config,
        media: { ...previousMedia, segmentSeconds: payload.segmentSeconds } } }
      return response({ binding, changed })
    }
    if (url === '/api/n8n/workflows' && (init?.method === 'PUT' || init?.method === 'POST')) {
      const payload = JSON.parse(String(init.body)) as Record<string, unknown>
      writes.push(payload)
      binding = { ...binding, ...payload, id: init.method === 'POST' ? 5 : binding.id,
        config: payload.config as Record<string, unknown> }
      return response({ binding })
    }
    if (url === '/api/n8n/workflows') return response({ bindings: [binding], capabilities,
      allowedActions: Object.entries(capabilities).filter(([, allowed]) => allowed).map(([key]) => key) })
    throw new Error(`Unexpected API call: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { writes, windowWrites, fetchMock, getBinding: () => binding }
}

async function beginEdit() {
  await screen.findByRole('heading', { name: '学习窗口测试' })
  fireEvent.click(screen.getByRole('button', { name: /^(编辑|设置窗口|查看)$/ }))
  await screen.findByRole('combobox', { name: '任务类型' })
}

function advancedConfig(): HTMLTextAreaElement {
  const summary = screen.getByText('高级配置（JSON 对象）')
  const details = summary.closest('details')
  if (details && !details.open) fireEvent.click(summary)
  return screen.getByRole('textbox', { name: '高级配置（JSON 对象）' })
}

describe('N8nWorkflowsPanel learning window', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('defaults a new video binding to five seconds with the declared number bounds', async () => {
    const api = installApi()
    render(<N8nWorkflowsPanel />)
    await screen.findByRole('heading', { name: '学习窗口测试' })
    fireEvent.click(screen.getByRole('button', { name: '新建任务链' }))
    fireEvent.change(screen.getByRole('combobox', { name: '任务类型' }), { target: { value: 'video-analysis' } })
    const input = screen.getByRole('spinbutton', { name: '学习窗口（秒）' })
    expect(input).toHaveValue(5)
    expect(input).toHaveAttribute('min', '1')
    expect(input).toHaveAttribute('max', '300')
    expect(input).toHaveAttribute('step', '1')
    expect(screen.getByText('仅影响新任务')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存窗口' })).not.toBeInTheDocument()
    expect(api.writes).toHaveLength(0)
    fireEvent.change(screen.getByPlaceholderText('例如：视频素材分析'), { target: { value: '默认学习窗口测试' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务链' }))
    await waitFor(() => expect(api.writes).toHaveLength(1))
    expect((api.writes[0].config as { media: { segmentSeconds: number } }).media.segmentSeconds).toBe(5)
  })

  it('saves three seconds in isolation, preserves media/routing fields, and reads it after refresh', async () => {
    const original = configFixture()
    const api = installApi(original)
    const first = render(<N8nWorkflowsPanel />)
    await beginEdit()
    fireEvent.change(screen.getByRole('spinbutton', { name: '学习窗口（秒）' }), { target: { value: '3' } })
    expect(JSON.parse(advancedConfig().value).media.segmentSeconds).toBe(3)
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(api.writes).toHaveLength(1))
    const saved = api.writes[0].config as Record<string, unknown>
    expect(saved.media).toEqual(expect.objectContaining({ segmentSeconds: 3, segmentOverlapSeconds: 0,
      language: 'en', frameWidth: 800, maxFrames: 9 }))
    expect(saved.modelRouting).toEqual(original.modelRouting)
    expect(saved.customSetting).toEqual(original.customSetting)
    expect(saved).not.toHaveProperty('segmentSeconds')
    expect(saved).not.toHaveProperty('segmentOverlapSeconds')
    await screen.findByText('任务链配置已更新')
    first.unmount()
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    expect(screen.getByRole('spinbutton', { name: '学习窗口（秒）' })).toHaveValue(3)
    expect(JSON.parse(advancedConfig().value).media.segmentSeconds).toBe(3)
    expect(api.fetchMock.mock.calls.some(([input]) => String(input).includes('/trigger'))).toBe(false)
  })

  it('synchronizes an advanced JSON edit back to the number control and save payload', async () => {
    const api = installApi()
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    const next = configFixture()
    next.media = { ...(next.media as Record<string, unknown>), segmentSeconds: 7 }
    fireEvent.change(advancedConfig(), { target: { value: JSON.stringify(next) } })
    expect(screen.getByRole('spinbutton', { name: '学习窗口（秒）' })).toHaveValue(7)
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(api.writes).toHaveLength(1))
    expect((api.writes[0].config as { media: { segmentSeconds: number } }).media.segmentSeconds).toBe(7)
  })

  it.each(['', '0', '301', '2.5'])('refuses invalid number draft %j without saving', async value => {
    const api = installApi()
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    fireEvent.change(screen.getByRole('spinbutton', { name: '学习窗口（秒）' }), { target: { value } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    expect(screen.getByRole('status')).toHaveTextContent('学习窗口必须是 1 到 300 秒之间的整数')
    expect(api.writes).toHaveLength(0)
    expect(JSON.parse(advancedConfig().value).media.segmentSeconds).toBe(5)
  })

  it('retains malformed advanced JSON and blocks both number edits and saving', async () => {
    const api = installApi()
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    fireEvent.change(advancedConfig(), { target: { value: '{"media":' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '学习窗口（秒）' }), { target: { value: '8' } })
    expect(advancedConfig()).toHaveValue('{"media":')
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    expect(screen.getByRole('status')).toHaveTextContent('高级配置不是有效 JSON')
    expect(api.writes).toHaveLength(0)
  })

  it('does not silently discard an invalid advanced media field', async () => {
    const api = installApi()
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    fireEvent.change(advancedConfig(), { target: { value: '{"media":{"segmentSeconds":5,"maxFrames":999}}' } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '学习窗口（秒）' }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    expect(screen.getByRole('status')).toHaveTextContent('视频学习配置无效')
    expect(JSON.parse(advancedConfig().value).media.maxFrames).toBe(999)
    expect(api.writes).toHaveLength(0)
  })

  it('repairs an invalid JSON window through the number control without discarding other fields', async () => {
    const api = installApi()
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    fireEvent.change(advancedConfig(), { target: { value: '{"media":{"segmentSeconds":0,"language":"en"},"customSetting":true}' } })
    expect(screen.getByRole('status')).toHaveTextContent('学习窗口必须是 1 到 300 秒之间的整数')
    fireEvent.change(screen.getByRole('spinbutton', { name: '学习窗口（秒）' }), { target: { value: '5' } })
    expect(JSON.parse(advancedConfig().value).media.segmentSeconds).toBe(5)
    expect(screen.queryByText('学习窗口必须是 1 到 300 秒之间的整数')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(api.writes).toHaveLength(1))
    expect(api.writes[0].config).toEqual(expect.objectContaining({ customSetting: true,
      media: expect.objectContaining({ segmentSeconds: 5, language: 'en' }) }))
  })

  it('keeps general-task media and top-level values unchanged', async () => {
    const media = { segmentSeconds: 0, customFlag: true }
    const api = installApi({ media, segmentSeconds: 37 }, 'general')
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    expect(screen.queryByRole('spinbutton', { name: '学习窗口（秒）' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存窗口' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(api.writes).toHaveLength(1))
    expect(api.writes[0].config).toEqual({ media, segmentSeconds: 37 })
  })

  it('reads the existing media window when changing task type to video analysis', async () => {
    installApi({ media: { segmentSeconds: 12 } }, 'general')
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    fireEvent.change(screen.getByRole('combobox', { name: '任务类型' }), { target: { value: 'video-analysis' } })
    expect(screen.getByRole('spinbutton', { name: '学习窗口（秒）' })).toHaveValue(12)
  })

  it('keeps an existing five-second window on a save without edits', async () => {
    const api = installApi()
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    fireEvent.click(screen.getByRole('button', { name: '保存修改' }))
    await waitFor(() => expect(api.writes).toHaveLength(1))
    expect((api.writes[0].config as { media: { segmentSeconds: number } }).media.segmentSeconds).toBe(5)
  })

  it('saves only the learning window with its current expectation and retains unrelated drafts', async () => {
    const api = installApi()
    const first = render(<N8nWorkflowsPanel />)
    await beginEdit()
    fireEvent.change(screen.getByPlaceholderText('说明这个任务链负责什么，以及预期输入输出。'), {
      target: { value: '未保存的说明' },
    })
    const draft = configFixture()
    draft.media = { ...(draft.media as Record<string, unknown>), language: 'fr' }
    fireEvent.change(advancedConfig(), { target: { value: JSON.stringify(draft) } })
    fireEvent.change(screen.getByRole('spinbutton', { name: '学习窗口（秒）' }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '保存窗口' }))
    await screen.findByText('学习窗口已更新')
    expect(api.windowWrites).toEqual([{ bindingId: 4, segmentSeconds: 3, expectedSegmentSeconds: 5 }])
    expect(api.writes).toHaveLength(0)
    expect(screen.getByPlaceholderText('说明这个任务链负责什么，以及预期输入输出。')).toHaveValue('未保存的说明')
    expect(JSON.parse(advancedConfig().value).media).toEqual(expect.objectContaining({ segmentSeconds: 3, language: 'fr' }))
    expect((api.getBinding().config.media as Record<string, unknown>).language).toBe('en')
    first.unmount()
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    expect(screen.getByRole('spinbutton', { name: '学习窗口（秒）' })).toHaveValue(3)
    expect(JSON.parse(advancedConfig().value).media.segmentSeconds).toBe(3)
  })

  it('reports an unchanged five-second window from the dedicated endpoint', async () => {
    const api = installApi()
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    fireEvent.click(screen.getByRole('button', { name: '保存窗口' }))
    await screen.findByText('学习窗口未变')
    expect(api.windowWrites).toEqual([{ bindingId: 4, segmentSeconds: 5, expectedSegmentSeconds: 5 }])
    expect(api.writes).toHaveLength(0)
  })

  it('preserves the unsaved window on a conflict and does not retry or broaden the write', async () => {
    const api = installApi(configFixture(), 'video-analysis', '学习窗口已变化，请刷新后重试')
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    fireEvent.change(screen.getByRole('spinbutton', { name: '学习窗口（秒）' }), { target: { value: '3' } })
    fireEvent.click(screen.getByRole('button', { name: '保存窗口' }))
    await screen.findByText('学习窗口已变化，请刷新后重试')
    expect(api.windowWrites).toHaveLength(1)
    expect(api.writes).toHaveLength(0)
    expect(screen.getByRole('spinbutton', { name: '学习窗口（秒）' })).toHaveValue(3)
    expect((api.getBinding().config.media as Record<string, unknown>).segmentSeconds).toBe(5)
  })

  it('blocks dedicated saving for invalid input without sending any mutation', async () => {
    const api = installApi()
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    fireEvent.change(screen.getByRole('spinbutton', { name: '学习窗口（秒）' }), { target: { value: '301' } })
    fireEvent.click(screen.getByRole('button', { name: '保存窗口' }))
    expect(screen.getByRole('status')).toHaveTextContent('学习窗口必须是 1 到 300 秒之间的整数')
    expect(api.windowWrites).toHaveLength(0)
    expect(api.writes).toHaveLength(0)
  })

  it('does not use the dedicated route to bypass invalid advanced JSON', async () => {
    const api = installApi()
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    fireEvent.change(advancedConfig(), { target: { value: '{"media":' } })
    fireEvent.click(screen.getByRole('button', { name: '保存窗口' }))
    expect(screen.getByRole('status')).toHaveTextContent('高级配置不是有效 JSON')
    expect(api.windowWrites).toHaveLength(0)
    expect(api.writes).toHaveLength(0)
  })

  it('uses declared permissions for CRUD while permitting the independent window action', async () => {
    const api = installApi(configFixture(), 'video-analysis', undefined,
      { create: false, update: false, delete: false, trigger: false, saveLearningWindow: true })
    render(<N8nWorkflowsPanel />)
    await beginEdit()
    expect(screen.getByRole('button', { name: '新建任务链' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '删除' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '保存窗口' })).toBeEnabled()
    expect(screen.getByText('当前已生效：5 秒')).toBeInTheDocument()
    expect(advancedConfig()).toBeDisabled()
    fireEvent.change(screen.getByRole('spinbutton', { name: '学习窗口（秒）' }), { target: { value: '3' } })
    expect(screen.getByText('当前已生效：5 秒')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '保存窗口' }))
    await screen.findByText('学习窗口已更新')
    expect(screen.getByText('当前已生效：3 秒')).toBeInTheDocument()
    expect(api.writes).toHaveLength(0)
  })
})
