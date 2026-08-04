'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { buildModelCluster, type ModelClusterBinding } from '@/lib/model-cluster'
import type { PublicN8nModelRoute } from '@/lib/n8n-model-routing'

type ClusterFilter = 'local' | 'cloud' | 'all'

interface ModelRoutesResponse {
  routes?: PublicN8nModelRoute[]
  errors?: string[]
}

interface WorkflowBindingsResponse {
  bindings?: ModelClusterBinding[]
}

function routeEndpoint(route: PublicN8nModelRoute): string {
  if (route.transport === 'openclaw') {
    return [route.profile, route.agentId].filter(Boolean).join(' / ') || 'OpenClaw'
  }
  return route.baseUrl || 'OpenAI 兼容 API'
}

function locationLabel(location: 'local' | 'cloud'): string {
  return location === 'local' ? '本地模型' : '云端模型'
}

function transportLabel(transport: PublicN8nModelRoute['transport']): string {
  return transport === 'openclaw' ? 'OpenClaw Agent' : 'API 直连'
}

export function ModelClusterPanel() {
  const [routes, setRoutes] = useState<PublicN8nModelRoute[]>([])
  const [bindings, setBindings] = useState<ModelClusterBinding[]>([])
  const [filter, setFilter] = useState<ClusterFilter>('local')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [registryWarnings, setRegistryWarnings] = useState<string[]>([])

  const loadData = useCallback(async (quiet = false) => {
    if (quiet) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const [modelsResponse, workflowsResponse] = await Promise.all([
        fetch('/api/n8n/models', { cache: 'no-store' }),
        fetch('/api/n8n/workflows', { cache: 'no-store' }),
      ])
      if (!modelsResponse.ok) throw new Error(`读取模型注册表失败（HTTP ${modelsResponse.status}）`)
      if (!workflowsResponse.ok) throw new Error(`读取任务链职责失败（HTTP ${workflowsResponse.status}）`)

      const [modelsBody, workflowsBody] = await Promise.all([
        modelsResponse.json() as Promise<ModelRoutesResponse>,
        workflowsResponse.json() as Promise<WorkflowBindingsResponse>,
      ])
      setRoutes(Array.isArray(modelsBody.routes) ? modelsBody.routes : [])
      setBindings(Array.isArray(workflowsBody.bindings) ? workflowsBody.bindings : [])
      setRegistryWarnings(Array.isArray(modelsBody.errors) ? modelsBody.errors : [])
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '无法读取模型集群')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const resources = useMemo(() => buildModelCluster(routes, bindings), [routes, bindings])
  const visibleResources = filter === 'all'
    ? resources
    : resources.filter(resource => resource.location === filter)
  const localCount = resources.filter(resource => resource.location === 'local').length
  const cloudCount = resources.filter(resource => resource.location === 'cloud').length
  const availableCount = visibleResources.filter(resource => resource.available).length
  const assignmentCount = visibleResources.reduce((total, resource) => total + resource.assignments.length, 0)
  const routeCount = visibleResources.reduce((total, resource) => total + resource.routes.length, 0)

  return (
    <div className="min-h-[calc(100vh-13rem)] bg-background">
      <div className="border-b border-border bg-card/40 px-5 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-foreground">模型集群</h2>
              <span className="rounded-full border border-cyan-500/25 bg-cyan-500/10 px-2 py-0.5 text-2xs text-cyan-300">
                任务链按路由 ID 调用
              </span>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              查看本地和云端模型资源、访问路由及当前负责的任务链节点。同一物理模型可以同时提供 API 直连和 OpenClaw Agent 路由。
            </p>
            <p className="mt-1 text-2xs text-muted-foreground/70">
              “可调度”仅表示配置与凭据引用完整，不等同于本次实时推理健康；真实结果以任务链执行记录为准。
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline" size="sm">
              <Link href="/automation">配置任务链</Link>
            </Button>
            <Button variant="secondary" size="sm" disabled={refreshing} onClick={() => void loadData(true)}>
              {refreshing ? '刷新中…' : '刷新集群'}
            </Button>
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard label="模型资源" value={visibleResources.length} detail={`本地 ${localCount} · 云端 ${cloudCount}`} />
          <MetricCard label="配置可调度" value={availableCount} detail={`当前筛选共 ${visibleResources.length} 个`} tone="green" />
          <MetricCard label="访问路由" value={routeCount} detail="任务链保存路由 ID" tone="cyan" />
          <MetricCard label="节点职责" value={assignmentCount} detail="包含主路由和备用路由" tone="amber" />
        </div>
      </div>

      <div className="px-5 py-4">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex rounded-lg border border-border bg-card p-1">
            {([
              ['local', `本地模型 ${localCount}`],
              ['cloud', `云端模型 ${cloudCount}`],
              ['all', `全部 ${resources.length}`],
            ] as Array<[ClusterFilter, string]>).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => setFilter(value)}
                className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                  filter === value ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-xs text-muted-foreground">已读取 {bindings.length} 条任务链配置</span>
        </div>

        {error && (
          <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">{error}</div>
        )}
        {registryWarnings.length > 0 && (
          <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-300">
            {registryWarnings.join('；')}
          </div>
        )}

        {loading ? (
          <div className="grid gap-4 xl:grid-cols-2">
            {[0, 1].map(index => <div key={index} className="h-72 animate-pulse rounded-xl border border-border bg-card/50" />)}
          </div>
        ) : visibleResources.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border bg-card/30 px-6 py-14 text-center">
            <p className="text-sm font-medium text-foreground">当前筛选下没有模型资源</p>
            <p className="mt-1 text-xs text-muted-foreground">先在仓库外的模型注册表中登记路由，再刷新集群。</p>
          </div>
        ) : (
          <div className="grid gap-4 xl:grid-cols-2">
            {visibleResources.map(resource => (
              <article key={resource.id} className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                <div className="border-b border-border bg-secondary/20 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="font-semibold text-foreground">{resource.label}</h3>
                        <span className={`rounded-full border px-2 py-0.5 text-2xs ${
                          resource.location === 'local'
                            ? 'border-violet-500/30 bg-violet-500/10 text-violet-300'
                            : 'border-blue-500/30 bg-blue-500/10 text-blue-300'
                        }`}>
                          {locationLabel(resource.location)}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={resource.models.join(' · ')}>
                        {resource.models.join(' · ')}
                      </p>
                    </div>
                    <span className={`shrink-0 rounded-full border px-2 py-1 text-2xs ${
                      resource.available
                        ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                        : 'border-slate-500/30 bg-slate-500/10 text-slate-400'
                    }`}>
                      {resource.available ? '配置可调度' : '当前不可调度'}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {resource.capabilities.map(capability => (
                      <span key={capability} className="rounded bg-secondary px-2 py-0.5 text-2xs text-muted-foreground">{capability}</span>
                    ))}
                  </div>
                </div>

                <div className="space-y-4 p-4">
                  <section>
                    <div className="mb-2 flex items-center justify-between">
                      <h4 className="text-xs font-medium text-foreground">调用路由</h4>
                      <span className="text-2xs text-muted-foreground">{resource.routes.length} 条</span>
                    </div>
                    <div className="space-y-2">
                      {resource.routes.map(route => {
                        const routeAssignments = resource.assignments.filter(assignment => assignment.routeId === route.id)
                        return (
                          <div key={route.id} className="rounded-lg border border-border/70 bg-background/50 px-3 py-2.5">
                            <div className="flex items-center justify-between gap-3">
                              <div className="min-w-0">
                                <p className="truncate text-xs font-medium text-foreground">{route.label}</p>
                                <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground" title={routeEndpoint(route)}>
                                  {route.id} · {routeEndpoint(route)}
                                </p>
                              </div>
                              <div className="shrink-0 text-right">
                                <p className="text-2xs text-muted-foreground">{transportLabel(route.transport)}</p>
                                <p className={`mt-0.5 text-[10px] ${route.available ? 'text-emerald-400' : 'text-rose-400'}`}>
                                  {route.available ? `${routeAssignments.length} 项职责` : route.unavailableReason || '不可用'}
                                </p>
                              </div>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </section>

                  <section>
                    <div className="mb-2 flex items-center justify-between">
                      <h4 className="text-xs font-medium text-foreground">负责的任务链节点</h4>
                      <Link href="/automation" className="text-2xs text-primary hover:underline">前往配置</Link>
                    </div>
                    {resource.assignments.length === 0 ? (
                      <div className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                        未分配任务链节点
                      </div>
                    ) : (
                      <div className="space-y-1.5">
                        {resource.assignments.map((assignment, index) => (
                          <div
                            key={`${assignment.bindingId}-${assignment.nodeKey}-${assignment.routeId}-${index}`}
                            className="flex flex-wrap items-center gap-2 rounded-lg bg-secondary/35 px-3 py-2 text-xs"
                          >
                            <span className={assignment.bindingEnabled ? 'text-foreground' : 'text-muted-foreground line-through'}>{assignment.bindingName}</span>
                            <span className="text-muted-foreground">/</span>
                            <span className="text-cyan-300">{assignment.nodeLabel}</span>
                            <span className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${
                              assignment.fallback ? 'bg-amber-500/10 text-amber-300' : 'bg-emerald-500/10 text-emerald-300'
                            }`}>
                              {assignment.fallback ? '备用' : '主路由'} · {assignment.routeId}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function MetricCard({
  label,
  value,
  detail,
  tone,
}: {
  label: string
  value: number
  detail: string
  tone?: 'green' | 'cyan' | 'amber'
}) {
  const valueClass = tone === 'green'
    ? 'text-emerald-400'
    : tone === 'cyan'
      ? 'text-cyan-400'
      : tone === 'amber'
        ? 'text-amber-400'
        : 'text-foreground'
  return (
    <div className="rounded-xl border border-border bg-background/60 px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-1 text-2xl font-semibold font-mono-tight ${valueClass}`}>{value}</p>
      <p className="mt-0.5 text-2xs text-muted-foreground/70">{detail}</p>
    </div>
  )
}
