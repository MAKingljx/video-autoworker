'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { resolveN8nEditorTarget, type N8nEditorTarget } from '@/lib/n8n-editor-url'

interface N8nHealth {
  ok: boolean
  baseUrl: string
  apiKeyConfigured: boolean
  statusCode: number | null
  latencyMs: number
  error: string | null
}

interface N8nRuntimeConfig {
  baseUrl: string
  apiKeyConfigured: boolean
  defaultWebhookPath: string
}

interface RemoteWorkflow {
  id: string
  name: string
  active: boolean
  updatedAt?: string
}

interface N8nStatusResponse {
  health: N8nHealth
  config: N8nRuntimeConfig
  remoteWorkflows: RemoteWorkflow[]
  managementError: string | null
}

interface WorkflowBinding {
  id: number
  name: string
  description: string
  workflowId: string
  webhookPath: string
  taskType: string
  agentRole: string
  model: string
  timeoutSeconds: number
  retryCount: number
  enabled: boolean
  config: Record<string, unknown>
  createdBy: string
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  lastStatus: string | null
}

interface ExecutionSummary {
  id: string
  workflowId?: string
  status?: string
  mode?: string
  startedAt?: string
  stoppedAt?: string
  finished?: boolean
}

interface ModelRoute {
  id: string
  label: string
  location: 'local' | 'cloud'
  transport: 'openclaw' | 'openai-compatible'
  model: string
  enabled: boolean
  available: boolean
  unavailableReason: string | null
}

interface BindingForm {
  name: string
  description: string
  workflowId: string
  webhookPath: string
  taskType: string
  agentRole: string
  model: string
  timeoutSeconds: string
  retryCount: string
  enabled: boolean
  configText: string
  plannerRouteId: string
  executorRouteId: string
  reviewerRouteId: string
  allowTaskOverride: boolean
}

interface ApiErrorBody {
  error?: string
}

const inputClass = 'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/60 focus:ring-1 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60'
const labelClass = 'mb-1.5 block text-xs font-medium text-muted-foreground'

const UNAVAILABLE_EDITOR_TARGET: N8nEditorTarget = {
  href: null,
  canOpen: false,
  canEmbed: false,
  openReason: '正在读取 n8n 编辑器地址。',
  embedReason: '正在读取 n8n 编辑器地址。',
}

const EMPTY_FORM: BindingForm = {
  name: '',
  description: '',
  workflowId: '',
  webhookPath: 'webhook/aiworker-task',
  taskType: 'general',
  agentRole: 'executor',
  model: 'qwen36-tools-local/default_model',
  timeoutSeconds: '30',
  retryCount: '1',
  enabled: true,
  configText: '{}',
  plannerRouteId: '',
  executorRouteId: '',
  reviewerRouteId: '',
  allowTaskOverride: true,
}

async function readJson<T>(response: Response): Promise<T> {
  return await response.json() as T
}

function messageFrom(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function formatTimestamp(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '未记录'
  const raw = typeof value === 'number' && value < 10_000_000_000 ? value * 1_000 : value
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString('zh-CN', { hour12: false })
}

function statusTone(status: string | null | undefined): string {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'success' || normalized === 'completed' || normalized === 'new') {
    return 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400'
  }
  if (normalized.includes('fail') || normalized === 'error' || normalized === 'crashed') {
    return 'border-red-500/25 bg-red-500/10 text-red-400'
  }
  if (normalized === 'running' || normalized === 'waiting' || normalized === 'accepted') {
    return 'border-cyan-500/25 bg-cyan-500/10 text-cyan-400'
  }
  return 'border-border bg-secondary/60 text-muted-foreground'
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function routeIdFromConfig(config: Record<string, unknown>, nodeKey: string): string {
  const modelRouting = objectValue(config.modelRouting)
  const nodes = objectValue(modelRouting.nodes)
  return String(objectValue(nodes[nodeKey]).routeId || '')
}

function formFromBinding(binding: WorkflowBinding): BindingForm {
  return {
    name: binding.name,
    description: binding.description,
    workflowId: binding.workflowId,
    webhookPath: binding.webhookPath,
    taskType: binding.taskType,
    agentRole: binding.agentRole,
    model: binding.model,
    timeoutSeconds: String(binding.timeoutSeconds),
    retryCount: String(binding.retryCount),
    enabled: binding.enabled,
    configText: JSON.stringify(binding.config, null, 2),
    plannerRouteId: routeIdFromConfig(binding.config, 'planner'),
    executorRouteId: routeIdFromConfig(binding.config, 'executor'),
    reviewerRouteId: routeIdFromConfig(binding.config, 'reviewer'),
    allowTaskOverride: objectValue(binding.config.modelRouting).allowTaskOverride !== false,
  }
}

export function N8nWorkflowsPanel() {
  const [status, setStatus] = useState<N8nStatusResponse | null>(null)
  const [bindings, setBindings] = useState<WorkflowBinding[]>([])
  const [executions, setExecutions] = useState<ExecutionSummary[]>([])
  const [modelRoutes, setModelRoutes] = useState<ModelRoute[]>([])
  const [modelRegistryError, setModelRegistryError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [form, setForm] = useState<BindingForm>(EMPTY_FORM)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [triggeringId, setTriggeringId] = useState<number | null>(null)
  const [testInput, setTestInput] = useState('{\n  "prompt": "测试 n8n 任务链连接"\n}')
  const [testResult, setTestResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pageUrl, setPageUrl] = useState<string | null>(null)
  const [editorExpanded, setEditorExpanded] = useState(false)
  const [editorFrameLoaded, setEditorFrameLoaded] = useState(false)
  const [editorFrameSlow, setEditorFrameSlow] = useState(false)
  const editorFrameTimerRef = useRef<number | null>(null)

  const selectedBinding = useMemo(
    () => bindings.find(binding => binding.id === selectedId) || null,
    [bindings, selectedId],
  )

  const editorTarget = useMemo(() => {
    if (!pageUrl || !status?.config.baseUrl) return UNAVAILABLE_EDITOR_TARGET
    return resolveN8nEditorTarget(status.config.baseUrl, pageUrl)
  }, [pageUrl, status?.config.baseUrl])

  useEffect(() => {
    setPageUrl(window.location.href)
  }, [])

  useEffect(() => {
    if (!editorTarget.canEmbed) setEditorExpanded(false)
  }, [editorTarget.canEmbed])

  useEffect(() => {
    if (editorFrameTimerRef.current !== null) {
      window.clearTimeout(editorFrameTimerRef.current)
      editorFrameTimerRef.current = null
    }
    setEditorFrameLoaded(false)
    setEditorFrameSlow(false)
    if (!editorExpanded) return
    editorFrameTimerRef.current = window.setTimeout(() => {
      editorFrameTimerRef.current = null
      setEditorFrameSlow(true)
    }, 8_000)
    return () => {
      if (editorFrameTimerRef.current !== null) {
        window.clearTimeout(editorFrameTimerRef.current)
        editorFrameTimerRef.current = null
      }
    }
  }, [editorExpanded, editorTarget.href])

  const loadData = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true)
    else setLoading(true)
    setError(null)

    try {
      const [statusResponse, bindingsResponse, modelsResponse] = await Promise.all([
        fetch('/api/n8n/status', { cache: 'no-store' }),
        fetch('/api/n8n/workflows', { cache: 'no-store' }),
        fetch('/api/n8n/models', { cache: 'no-store' }),
      ])
      if (!statusResponse.ok) {
        const body = await readJson<ApiErrorBody>(statusResponse).catch((): ApiErrorBody => ({}))
        throw new Error(body.error || `读取 n8n 状态失败（HTTP ${statusResponse.status}）`)
      }
      if (!bindingsResponse.ok) {
        const body = await readJson<ApiErrorBody>(bindingsResponse).catch((): ApiErrorBody => ({}))
        throw new Error(body.error || `读取任务链失败（HTTP ${bindingsResponse.status}）`)
      }

      const [nextStatus, bindingsBody] = await Promise.all([
        readJson<N8nStatusResponse>(statusResponse),
        readJson<{ bindings?: WorkflowBinding[] }>(bindingsResponse),
      ])
      const nextBindings = Array.isArray(bindingsBody.bindings) ? bindingsBody.bindings : []
      setStatus(nextStatus)
      setBindings(nextBindings)
      if (modelsResponse.ok) {
        const modelBody = await readJson<{ routes?: ModelRoute[]; errors?: string[] }>(modelsResponse)
        setModelRoutes(Array.isArray(modelBody.routes) ? modelBody.routes : [])
        setModelRegistryError(Array.isArray(modelBody.errors) && modelBody.errors.length ? modelBody.errors.join('；') : null)
      } else {
        setModelRoutes([])
        setModelRegistryError('模型路由暂时不可用')
      }

      if (nextStatus.config.apiKeyConfigured) {
        const executionsResponse = await fetch('/api/n8n/executions?limit=20', { cache: 'no-store' })
        if (executionsResponse.ok) {
          const executionsBody = await readJson<{ executions?: ExecutionSummary[] }>(executionsResponse)
          setExecutions(Array.isArray(executionsBody.executions) ? executionsBody.executions : [])
        } else {
          setExecutions([])
        }
      } else {
        setExecutions([])
      }

      setSelectedId(current => current && nextBindings.some(binding => binding.id === current) ? current : null)
      setForm(current => {
        if (selectedId !== null || current.webhookPath !== EMPTY_FORM.webhookPath) return current
        return { ...current, webhookPath: nextStatus.config.defaultWebhookPath }
      })
    } catch (loadError) {
      setError(messageFrom(loadError, '无法读取 n8n 配置'))
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [selectedId])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const beginCreate = () => {
    setSelectedId(null)
    setForm({
      ...EMPTY_FORM,
      webhookPath: status?.config.defaultWebhookPath || EMPTY_FORM.webhookPath,
    })
    setTestResult(null)
    setError(null)
  }

  const beginEdit = (binding: WorkflowBinding) => {
    setSelectedId(binding.id)
    setForm(formFromBinding(binding))
    setTestResult(null)
    setError(null)
  }

  const updateForm = <K extends keyof BindingForm>(key: K, value: BindingForm[K]) => {
    setForm(current => ({ ...current, [key]: value }))
  }

  const saveBinding = async () => {
    setError(null)
    setNotice(null)

    let config: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(form.configText || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('高级配置必须是 JSON 对象')
      }
      config = parsed as Record<string, unknown>
    } catch (configError) {
      setError(messageFrom(configError, '高级配置不是有效 JSON'))
      return
    }

    const existingModelRouting = objectValue(config.modelRouting)
    const existingNodeRoutes = objectValue(existingModelRouting.nodes)
    const nodeRoutes = Object.fromEntries([
      ['planner', form.plannerRouteId],
      ['executor', form.executorRouteId],
      ['reviewer', form.reviewerRouteId],
    ].filter((entry): entry is [string, string] => Boolean(entry[1])).map(([nodeKey, routeId]) => [
      nodeKey,
      { ...objectValue(existingNodeRoutes[nodeKey]), routeId },
    ]))
    if (Object.keys(nodeRoutes).length) {
      config.modelRouting = {
        allowTaskOverride: form.allowTaskOverride,
        nodes: nodeRoutes,
      }
    } else {
      delete config.modelRouting
    }

    const timeoutSeconds = Number(form.timeoutSeconds)
    const retryCount = Number(form.retryCount)
    if (!form.name.trim() || !form.webhookPath.trim()) {
      setError('名称和 Webhook 路径不能为空')
      return
    }
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 5 || timeoutSeconds > 120) {
      setError('Webhook 接收超时必须是 5 到 120 秒之间的整数')
      return
    }
    if (!Number.isInteger(retryCount) || retryCount < 0 || retryCount > 10) {
      setError('重试次数必须是 0 到 10 之间的整数')
      return
    }

    setSaving(true)
    try {
      const payload = {
        ...(selectedId ? { id: selectedId } : {}),
        name: form.name.trim(),
        description: form.description.trim(),
        workflowId: form.workflowId.trim(),
        webhookPath: form.webhookPath.trim(),
        taskType: form.taskType.trim(),
        agentRole: form.agentRole.trim(),
        model: form.model.trim(),
        timeoutSeconds,
        retryCount,
        enabled: form.enabled,
        config,
      }
      const response = await fetch('/api/n8n/workflows', {
        method: selectedId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await readJson<{ binding?: WorkflowBinding; error?: string }>(response)
        .catch((): { binding?: WorkflowBinding; error?: string } => ({}))
      if (!response.ok || !body.binding) {
        throw new Error(body.error || `保存失败（HTTP ${response.status}）`)
      }
      setNotice(selectedId ? '任务链配置已更新' : '任务链配置已创建')
      setSelectedId(body.binding.id)
      setForm(formFromBinding(body.binding))
      await loadData(true)
    } catch (saveError) {
      setError(messageFrom(saveError, '保存任务链失败'))
    } finally {
      setSaving(false)
    }
  }

  const deleteBinding = async (binding: WorkflowBinding) => {
    if (!window.confirm(`确认删除任务链“${binding.name}”？此操作不会删除 n8n 中的原始工作流。`)) return
    setDeletingId(binding.id)
    setError(null)
    setNotice(null)
    try {
      const response = await fetch(`/api/n8n/workflows?id=${binding.id}`, { method: 'DELETE' })
      const body = await readJson<ApiErrorBody>(response).catch((): ApiErrorBody => ({}))
      if (!response.ok) throw new Error(body.error || `删除失败（HTTP ${response.status}）`)
      if (selectedId === binding.id) beginCreate()
      setNotice('任务链绑定已删除，n8n 原始工作流未受影响')
      await loadData(true)
    } catch (deleteError) {
      setError(messageFrom(deleteError, '删除任务链失败'))
    } finally {
      setDeletingId(null)
    }
  }

  const triggerWorkflow = async (binding: WorkflowBinding) => {
    setError(null)
    setNotice(null)
    setTestResult(null)

    let input: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(testInput || '{}')
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('测试输入必须是 JSON 对象')
      }
      input = parsed as Record<string, unknown>
    } catch (inputError) {
      setError(messageFrom(inputError, '测试输入不是有效 JSON'))
      return
    }

    setTriggeringId(binding.id)
    try {
      const response = await fetch('/api/n8n/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bindingId: binding.id, input }),
      })
      const body = await readJson<{ taskId?: string; result?: unknown; error?: string }>(response)
        .catch((): { taskId?: string; result?: unknown; error?: string } => ({}))
      if (!response.ok) throw new Error(body.error || `触发失败（HTTP ${response.status}）`)
      setNotice(`任务链“${binding.name}”触发成功`)
      setTestResult(JSON.stringify(body, null, 2))
      await loadData(true)
    } catch (triggerError) {
      const message = messageFrom(triggerError, '触发任务链失败')
      setError(message)
      setTestResult(JSON.stringify({ error: message }, null, 2))
      await loadData(true)
    } finally {
      setTriggeringId(null)
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-[420px] items-center justify-center gap-3 p-6 text-sm text-muted-foreground">
        <span className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        正在读取 n8n 任务链配置…
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-4 p-4 md:p-6">
      <section className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-semibold text-foreground">n8n 可视化任务链</h1>
              <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-2xs font-medium ${status?.health.ok ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-400' : 'border-red-500/25 bg-red-500/10 text-red-400'}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${status?.health.ok ? 'bg-emerald-400' : 'bg-red-400'}`} />
                {status?.health.ok ? 'n8n 在线' : 'n8n 离线'}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">统一配置模型、Agent 角色与 Webhook 路由，并从控制台测试任务执行。</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {editorTarget.canOpen && editorTarget.href ? (
              <Button asChild variant="outline" size="sm">
                <a href={editorTarget.href} target="_blank" rel="noopener noreferrer">打开 n8n 编辑器</a>
              </Button>
            ) : (
              <Button variant="outline" size="sm" disabled title={editorTarget.openReason || undefined}>打开 n8n 编辑器</Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!editorTarget.canEmbed}
              title={editorTarget.embedReason || undefined}
              onClick={() => setEditorExpanded(current => !current)}
            >
              {editorExpanded ? '收起 n8n 编辑器' : '嵌入 n8n 编辑器'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void loadData(true)} disabled={refreshing}>
              {refreshing ? '刷新中…' : '刷新状态'}
            </Button>
            <Button size="sm" onClick={beginCreate}>新建任务链</Button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatusCard label="n8n 地址" value={status?.config.baseUrl || '未配置'} detail={status?.health.statusCode ? `HTTP ${status.health.statusCode}` : status?.health.error || '等待连接'} />
          <StatusCard label="响应延迟" value={`${status?.health.latencyMs ?? 0} ms`} detail={status?.health.ok ? '健康检查正常' : '健康检查失败'} />
          <StatusCard label="管理 API" value={status?.config.apiKeyConfigured ? '已配置' : '未配置'} detail={status?.config.apiKeyConfigured ? `${status?.remoteWorkflows.length || 0} 个远端工作流` : '配置 N8N_API_KEY 后可读取执行记录'} />
          <StatusCard label="本地任务链" value={`${bindings.length} 条`} detail={`${bindings.filter(binding => binding.enabled).length} 条已启用`} />
        </div>
        {status?.managementError && (
          <p className="mt-3 rounded-md border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{status.managementError}</p>
        )}
        <p className={`mt-3 text-xs ${editorTarget.openReason || editorTarget.embedReason ? 'text-amber-300' : 'text-muted-foreground'}`}>
          {editorTarget.openReason || editorTarget.embedReason || '远程使用时请同时转发 3017 和 5678 端口；内嵌失败时可随时改用新窗口。'}
        </p>
      </section>

      {editorExpanded && editorTarget.canEmbed && editorTarget.href && (
        <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
          <div className="flex flex-col gap-2 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-sm font-semibold text-foreground">n8n 原生编辑器</h2>
              <p className="mt-0.5 text-2xs text-muted-foreground">工作流编辑、凭据和激活操作仍由 n8n 原生界面负责。</p>
            </div>
            <span className={`text-2xs ${editorFrameSlow ? 'text-amber-300' : editorFrameLoaded ? 'text-emerald-400' : 'text-muted-foreground'}`}>
              {editorFrameSlow ? '加载时间较长，请尝试新窗口打开' : editorFrameLoaded ? '编辑器页面已响应' : '正在加载编辑器…'}
            </span>
          </div>
          <iframe
            key={editorTarget.href}
            src={editorTarget.href}
            title="n8n 原生工作流编辑器"
            className="h-[760px] w-full bg-white"
            allow="clipboard-read; clipboard-write"
            referrerPolicy="no-referrer"
            onLoad={() => {
              if (editorFrameTimerRef.current !== null) {
                window.clearTimeout(editorFrameTimerRef.current)
                editorFrameTimerRef.current = null
              }
              setEditorFrameLoaded(true)
              setEditorFrameSlow(false)
            }}
          />
        </section>
      )}

      {(error || notice) && (
        <div className={`rounded-lg border px-4 py-3 text-sm ${error ? 'border-red-500/25 bg-red-500/10 text-red-300' : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'}`} role="status">
          {error || notice}
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(320px,0.9fr)_minmax(620px,1.6fr)]">
        <section className="min-h-[520px] overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">任务链绑定</h2>
              <p className="mt-0.5 text-2xs text-muted-foreground">控制台配置与 n8n Webhook 的映射</p>
            </div>
            <span className="rounded-full bg-secondary px-2 py-0.5 text-2xs text-muted-foreground">{bindings.length}</span>
          </div>
          <div className="max-h-[740px] space-y-2 overflow-y-auto p-3">
            {bindings.length === 0 ? (
              <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 text-center">
                <p className="text-sm font-medium text-foreground">还没有任务链绑定</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">先在 n8n 创建 Webhook 工作流，再在这里配置任务类型、Agent 和模型。</p>
                <Button className="mt-4" size="sm" onClick={beginCreate}>创建第一条任务链</Button>
              </div>
            ) : bindings.map(binding => (
              <article
                key={binding.id}
                className={`rounded-lg border p-3 transition-colors ${selectedId === binding.id ? 'border-primary/60 bg-primary/5' : 'border-border bg-background/35 hover:border-primary/25'}`}
              >
                <button type="button" className="w-full text-left" onClick={() => beginEdit(binding)}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${binding.enabled ? 'bg-emerald-400' : 'bg-muted-foreground/40'}`} />
                        <h3 className="truncate text-sm font-medium text-foreground">{binding.name}</h3>
                      </div>
                      <p className="mt-1 truncate font-mono text-2xs text-muted-foreground">/{binding.webhookPath}</p>
                    </div>
                    <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] ${statusTone(binding.lastStatus)}`}>
                      {binding.lastStatus || '未运行'}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                    <span className="rounded bg-secondary px-1.5 py-0.5">{binding.taskType}</span>
                    <span className="rounded bg-secondary px-1.5 py-0.5">{binding.agentRole}</span>
                    <span className="max-w-full truncate rounded bg-secondary px-1.5 py-0.5">{binding.model}</span>
                  </div>
                  <p className="mt-2 text-[10px] text-muted-foreground/70">上次运行：{formatTimestamp(binding.lastRunAt)}</p>
                </button>
                <div className="mt-3 flex gap-2 border-t border-border/60 pt-3">
                  <Button variant="outline" size="xs" className="flex-1" onClick={() => beginEdit(binding)}>编辑</Button>
                  <Button
                    variant="secondary"
                    size="xs"
                    className="flex-1"
                    disabled={!binding.enabled || triggeringId === binding.id}
                    onClick={() => { beginEdit(binding); void triggerWorkflow(binding) }}
                  >
                    {triggeringId === binding.id ? '执行中…' : '测试'}
                  </Button>
                  <Button variant="destructive" size="xs" disabled={deletingId === binding.id} onClick={() => void deleteBinding(binding)}>
                    删除
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">{selectedBinding ? `编辑：${selectedBinding.name}` : '新建任务链'}</h2>
              <p className="mt-0.5 text-2xs text-muted-foreground">设置路由、执行角色和运行限制</p>
            </div>
            {selectedBinding && <span className="font-mono text-2xs text-muted-foreground">ID {selectedBinding.id}</span>}
          </div>

          <div className="space-y-5 p-4 md:p-5">
            <div className="grid gap-4 md:grid-cols-2">
              <Field label="任务链名称">
                <input className={inputClass} value={form.name} maxLength={120} placeholder="例如：视频素材分析" onChange={event => updateForm('name', event.target.value)} />
              </Field>
              <Field label="n8n 工作流">
                <select className={inputClass} value={form.workflowId} onChange={event => updateForm('workflowId', event.target.value)}>
                  <option value="">手动填写或暂不绑定工作流 ID</option>
                  {status?.remoteWorkflows.map(workflow => (
                    <option key={workflow.id} value={workflow.id}>{workflow.name}{workflow.active ? '（已激活）' : '（未激活）'}</option>
                  ))}
                </select>
                {status?.remoteWorkflows.length === 0 && (
                  <input className={`${inputClass} mt-2 font-mono`} value={form.workflowId} maxLength={120} placeholder="n8n workflow ID（可选）" onChange={event => updateForm('workflowId', event.target.value)} />
                )}
              </Field>
            </div>

            <Field label="说明">
              <textarea className={`${inputClass} min-h-20 resize-y`} value={form.description} maxLength={1000} placeholder="说明这个任务链负责什么，以及预期输入输出。" onChange={event => updateForm('description', event.target.value)} />
            </Field>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Webhook 路径" hint="必须以 webhook/ 或 webhook-test/ 开头">
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-2 text-sm text-muted-foreground">/</span>
                  <input className={`${inputClass} pl-6 font-mono`} value={form.webhookPath} maxLength={240} placeholder="webhook/aiworker-task" onChange={event => updateForm('webhookPath', event.target.value.replace(/^\/+/, ''))} />
                </div>
              </Field>
              <Field label="任务类型">
                <input className={inputClass} value={form.taskType} maxLength={80} list="n8n-task-types" placeholder="general" onChange={event => updateForm('taskType', event.target.value)} />
                <datalist id="n8n-task-types">
                  <option value="general" /><option value="video-analysis" /><option value="transcription" /><option value="vision-ocr" /><option value="knowledge-search" />
                </datalist>
              </Field>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Field label="Agent 角色">
                <input className={inputClass} value={form.agentRole} maxLength={80} list="n8n-agent-roles" placeholder="executor" onChange={event => updateForm('agentRole', event.target.value)} />
                <datalist id="n8n-agent-roles">
                  <option value="coordinator" /><option value="executor" /><option value="reviewer" /><option value="researcher" /><option value="video-specialist" />
                </datalist>
              </Field>
              <Field label="兼容默认模型" hint="没有单独选择节点模型时使用">
                <input className={`${inputClass} font-mono`} value={form.model} maxLength={180} list="n8n-models" placeholder="qwen36-tools-local/default_model" onChange={event => updateForm('model', event.target.value)} />
                <datalist id="n8n-models">
                  {modelRoutes.map(route => <option key={route.id} value={route.model} />)}
                </datalist>
              </Field>
            </div>

            <div className="rounded-lg border border-border bg-background/35 p-4">
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium text-foreground">节点模型</h3>
                  <p className="mt-1 text-xs text-muted-foreground">每个节点可独立选择本地模型或云端模型。</p>
                </div>
                <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                  <input type="checkbox" className="h-4 w-4 accent-primary" checked={form.allowTaskOverride} onChange={event => updateForm('allowTaskOverride', event.target.checked)} />
                  允许 OpenClaw 临时指定
                </label>
              </div>
              {modelRegistryError && <p className="mb-3 text-xs text-red-400">{modelRegistryError}</p>}
              {!modelRegistryError && modelRoutes.length === 0 && <p className="mb-3 text-xs text-muted-foreground">尚未安装模型路由，当前沿用兼容默认模型。</p>}
              <div className="grid gap-4 md:grid-cols-3">
                {([
                  ['plannerRouteId', '规划节点'],
                  ['executorRouteId', '执行节点'],
                  ['reviewerRouteId', '审核节点'],
                ] as const).map(([field, label]) => (
                  <Field key={field} label={label}>
                    <select className={inputClass} value={form[field]} onChange={event => updateForm(field, event.target.value)}>
                      <option value="">兼容默认模型</option>
                      {modelRoutes.map(route => (
                        <option key={route.id} value={route.id} disabled={!route.available}>
                          {route.label} · {route.location === 'local' ? '本地' : '云端'}{route.available ? '' : '（不可用）'}
                        </option>
                      ))}
                    </select>
                  </Field>
                ))}
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-3">
              <Field label="Webhook 接收超时（秒）" hint="5–120；长任务应先返回 accepted">
                <input type="number" className={inputClass} min={5} max={120} step={1} value={form.timeoutSeconds} onChange={event => updateForm('timeoutSeconds', event.target.value)} />
              </Field>
              <Field label="工作流重试预算" hint="0–10；由 n8n 工作流节点执行">
                <input type="number" className={inputClass} min={0} max={10} step={1} value={form.retryCount} onChange={event => updateForm('retryCount', event.target.value)} />
              </Field>
              <Field label="运行状态">
                <label className="flex h-[38px] cursor-pointer items-center justify-between rounded-md border border-border bg-background px-3 text-sm">
                  <span className={form.enabled ? 'text-emerald-400' : 'text-muted-foreground'}>{form.enabled ? '已启用' : '已停用'}</span>
                  <input type="checkbox" className="h-4 w-4 accent-primary" checked={form.enabled} onChange={event => updateForm('enabled', event.target.checked)} />
                </label>
              </Field>
            </div>

            <Field label="高级配置（JSON 对象）" hint="传递给任务链的固定配置，不要填写密码或 API Key">
              <textarea className={`${inputClass} min-h-32 resize-y font-mono text-xs leading-5`} value={form.configText} spellCheck={false} onChange={event => updateForm('configText', event.target.value)} />
            </Field>

            <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
              {selectedBinding && <Button variant="ghost" size="sm" onClick={beginCreate}>取消编辑</Button>}
              <Button size="sm" onClick={() => void saveBinding()} disabled={saving}>{saving ? '保存中…' : selectedBinding ? '保存修改' : '创建任务链'}</Button>
            </div>

            {selectedBinding && (
              <div className="rounded-lg border border-border bg-background/40 p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div>
                    <h3 className="text-sm font-medium text-foreground">测试触发</h3>
                    <p className="mt-1 text-xs text-muted-foreground">测试使用当前已保存的配置；修改表单后请先保存。</p>
                  </div>
                  <Button size="sm" variant="secondary" disabled={!selectedBinding.enabled || triggeringId === selectedBinding.id} onClick={() => void triggerWorkflow(selectedBinding)}>
                    {triggeringId === selectedBinding.id ? '正在执行…' : selectedBinding.enabled ? '发送测试任务' : '任务链已停用'}
                  </Button>
                </div>
                <textarea className={`${inputClass} mt-3 min-h-28 resize-y font-mono text-xs leading-5`} value={testInput} spellCheck={false} onChange={event => setTestInput(event.target.value)} aria-label="测试任务输入 JSON" />
                {testResult && (
                  <pre className="mt-3 max-h-56 overflow-auto rounded-md border border-border bg-background p-3 text-2xs leading-5 text-muted-foreground">{testResult}</pre>
                )}
              </div>
            )}
          </div>
        </section>
      </div>

      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">n8n 执行记录</h2>
            <p className="mt-0.5 text-2xs text-muted-foreground">最近 20 次执行，仅展示运行摘要</p>
          </div>
          <span className="text-2xs text-muted-foreground">{status?.config.apiKeyConfigured ? `${executions.length} 条` : '需要管理 API Key'}</span>
        </div>
        {!status?.config.apiKeyConfigured ? (
          <div className="p-6 text-center text-xs text-muted-foreground">配置 <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-foreground">N8N_API_KEY</code> 后，可在这里查看 n8n 执行历史。</div>
        ) : executions.length === 0 ? (
          <div className="p-6 text-center text-xs text-muted-foreground">暂无可显示的执行记录。</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="bg-secondary/40 text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 font-medium">执行 ID</th>
                  <th className="px-4 py-2.5 font-medium">工作流</th>
                  <th className="px-4 py-2.5 font-medium">状态</th>
                  <th className="px-4 py-2.5 font-medium">模式</th>
                  <th className="px-4 py-2.5 font-medium">开始时间</th>
                  <th className="px-4 py-2.5 font-medium">结束时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {executions.map(execution => {
                  const workflow = status.remoteWorkflows.find(item => item.id === execution.workflowId)
                  return (
                    <tr key={execution.id} className="hover:bg-secondary/20">
                      <td className="px-4 py-3 font-mono text-foreground">{execution.id}</td>
                      <td className="px-4 py-3 text-muted-foreground">{workflow?.name || execution.workflowId || '未知'}</td>
                      <td className="px-4 py-3"><span className={`rounded border px-1.5 py-0.5 text-[10px] ${statusTone(execution.status)}`}>{execution.status || (execution.finished ? 'finished' : 'unknown')}</span></td>
                      <td className="px-4 py-3 text-muted-foreground">{execution.mode || '—'}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatTimestamp(execution.startedAt)}</td>
                      <td className="px-4 py-3 text-muted-foreground">{formatTimestamp(execution.stoppedAt)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}

function StatusCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/40 px-3 py-2.5">
      <p className="text-2xs text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-sm font-medium text-foreground" title={value}>{value}</p>
      <p className="mt-0.5 truncate text-[10px] text-muted-foreground/70" title={detail}>{detail}</p>
    </div>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="block min-w-0">
      <span className={labelClass}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[10px] text-muted-foreground/70">{hint}</span>}
    </div>
  )
}
