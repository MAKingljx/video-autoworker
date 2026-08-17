'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import {
  buildModelCluster,
  type ModelClusterBinding,
  type ModelClusterResource,
} from '@/lib/model-cluster'
import type { PublicAuxiliaryModelResource, PublicN8nModelRoute } from '@/lib/n8n-model-routing'

type ClusterFilter = 'local' | 'cloud' | 'all'

interface ModelRoutesResponse {
  routes?: PublicN8nModelRoute[]
  resources?: PublicAuxiliaryModelResource[]
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

function kindLabel(kind: 'generative' | PublicAuxiliaryModelResource['kind']): string {
  if (kind === 'speech-recognition') return '语音识别'
  if (kind === 'embedding') return '向量模型'
  if (kind === 'reranker') return '重排模型'
  if (kind === 'language-model') return '语言模型'
  if (kind === 'other') return '专用模型'
  return '生成模型'
}

function resourceStatus(resource: ModelClusterResource): { label: string; className: string } {
  if (!resource.enabled) {
    return { label: '已停用', className: 'border-border bg-secondary/60 text-muted-foreground' }
  }
  if (!resource.available) {
    return {
      label: resource.routes.length > 0 ? '当前不可调度' : '当前不可识别',
      className: 'border-destructive/20 bg-destructive/[0.06] text-destructive',
    }
  }
  if (!resource.production) {
    return { label: '已安装', className: 'border-border bg-secondary/60 text-foreground' }
  }
  return {
    label: resource.routes.length > 0 ? '配置可调度' : '生产可用',
    className: 'border-emerald-500/20 bg-emerald-500/[0.06] text-emerald-400',
  }
}

export function ModelClusterPanel() {
  const [routes, setRoutes] = useState<PublicN8nModelRoute[]>([])
  const [auxiliaryResources, setAuxiliaryResources] = useState<PublicAuxiliaryModelResource[]>([])
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
      setAuxiliaryResources(Array.isArray(modelsBody.resources) ? modelsBody.resources : [])
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

  const resources = useMemo(
    () => buildModelCluster(routes, bindings, auxiliaryResources),
    [routes, bindings, auxiliaryResources],
  )
  const visibleResources = filter === 'all'
    ? resources
    : resources.filter(resource => resource.location === filter)
  const localCount = resources.filter(resource => resource.location === 'local').length
  const cloudCount = resources.filter(resource => resource.location === 'cloud').length
  const availableCount = visibleResources.filter(resource => resource.available).length
  const productionCount = visibleResources.filter(resource => resource.production).length
  const unassignedCount = visibleResources.filter(resource => !resource.production).length
  const assignmentCount = visibleResources.reduce((total, resource) => total + resource.assignments.length, 0)
  const resourceGroups = [
    {
      id: 'production',
      label: '生产已用',
      description: '已有任务链路或专用生产流程正在调用',
      resources: visibleResources.filter(resource => resource.production),
    },
    {
      id: 'unassigned',
      label: '已安装待分配',
      description: '本机文件已识别，但尚未接入生产任务',
      resources: visibleResources.filter(resource => !resource.production),
    },
  ].filter(group => group.resources.length > 0)

  return (
    <div className="min-h-[calc(100vh-13rem)] bg-background">
      <div className="border-b border-border bg-card/40 px-5 py-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-lg font-semibold text-foreground">模型集群</h2>
              <span className="rounded-full border border-border bg-secondary/70 px-2 py-0.5 text-2xs text-muted-foreground">
                任务链按路由 ID 调用
              </span>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              查看本地和云端模型资源、访问路由及当前负责的任务。生产模型与仅安装在本机、尚未分配任务的模型会分开展示。
            </p>
            <p className="mt-1 text-2xs text-muted-foreground/70">
              “可调度”与“生产可用”表示生产链路检测通过；“已安装”只表示所需模型文件完整，不代表已经运行或接入任务链。
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
          <MetricCard label="检测通过" value={availableCount} detail={`当前筛选共 ${visibleResources.length} 个`} />
          <MetricCard label="生产已用" value={productionCount} detail={`另有 ${unassignedCount} 个待分配`} />
          <MetricCard label="节点职责" value={assignmentCount} detail="包含主路由和备用路由" />
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
          <div className="space-y-6">
            {resourceGroups.map(group => (
              <section key={group.id}>
                <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">{group.label}</h3>
                    <p className="mt-0.5 text-xs text-muted-foreground">{group.description}</p>
                  </div>
                  <span className="rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-2xs text-muted-foreground">
                    {group.resources.length} 个模型
                  </span>
                </div>
                <div className="grid gap-4 xl:grid-cols-2">
                  {group.resources.map(resource => {
                    const status = resourceStatus(resource)
                    return (
                      <article key={resource.id} className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
                        <div className="border-b border-border bg-secondary/20 px-4 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="font-semibold text-foreground">{resource.label}</h3>
                                <span className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-2xs text-muted-foreground">
                                  {locationLabel(resource.location)}
                                </span>
                                <span className="rounded-full border border-border bg-secondary/70 px-2 py-0.5 text-2xs text-muted-foreground">
                                  {kindLabel(resource.kind)}
                                </span>
                                <span className="rounded-full border border-border bg-secondary/70 px-2 py-0.5 text-2xs text-muted-foreground">
                                  {resource.production ? '生产使用' : '待分配'}
                                </span>
                              </div>
                              <p className="mt-1 truncate font-mono text-xs text-muted-foreground" title={resource.models.join(' · ')}>
                                {resource.models.join(' · ')}
                              </p>
                            </div>
                            <span className={`shrink-0 rounded-full border px-2 py-1 text-2xs ${status.className}`}>
                              {status.label}
                            </span>
                          </div>
                          {resource.description && (
                            <p className="mt-2 text-xs leading-5 text-muted-foreground">{resource.description}</p>
                          )}
                          <div className="mt-3 flex flex-wrap gap-1.5">
                            {resource.capabilities.map(capability => (
                              <span key={capability} className="rounded bg-secondary px-2 py-0.5 text-2xs text-muted-foreground">{capability}</span>
                            ))}
                          </div>
                        </div>

                        <div className="space-y-4 p-4">
                          <section>
                            <div className="mb-2 flex items-center justify-between">
                              <h4 className="text-xs font-medium text-foreground">
                                {resource.routes.length > 0 ? '调用路由' : '接入状态'}
                              </h4>
                              <span className="text-2xs text-muted-foreground">
                                {resource.routes.length > 0 ? `${resource.routes.length} 条` : resource.production ? '专用链路' : '待分配'}
                              </span>
                            </div>
                            {resource.routes.length === 0 ? (
                              <div className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                                <p>
                                  {resource.production
                                    ? '由专用生产链路调用，不作为通用文本任务节点。'
                                    : '本机模型文件已登记，尚未启动服务或分配生产任务。'}
                                </p>
                                {resource.endpoint && <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">{resource.endpoint}</p>}
                              </div>
                            ) : (
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
                                          <p className={`mt-0.5 text-[10px] ${route.available ? 'text-emerald-400' : 'text-destructive'}`}>
                                            {route.available ? `${routeAssignments.length} 项职责` : route.unavailableReason || '不可用'}
                                          </p>
                                        </div>
                                      </div>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </section>

                          {resource.usedBy.length > 0 && (
                            <section>
                              <div className="mb-2 flex items-center justify-between">
                                <h4 className="text-xs font-medium text-foreground">生产用途</h4>
                                <span className="text-2xs text-muted-foreground">{resource.usedBy.length} 项</span>
                              </div>
                              <div className="space-y-1.5">
                                {resource.usedBy.map(usage => (
                                  <div key={usage} className="rounded-lg bg-secondary/35 px-3 py-2 text-xs text-foreground">{usage}</div>
                                ))}
                              </div>
                            </section>
                          )}

                          <section>
                            <div className="mb-2 flex items-center justify-between">
                              <h4 className="text-xs font-medium text-foreground">负责的任务链节点</h4>
                              <Link href="/automation" className="text-2xs text-primary hover:underline">前往配置</Link>
                            </div>
                            {resource.assignments.length === 0 ? (
                              <div className="rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
                                {resource.routes.length > 0
                                  ? '未分配任务链节点'
                                  : resource.production
                                    ? '此类模型由专用流程调用'
                                    : '尚未分配生产任务，可在后续专用 n8n 节点中接入'}
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
                                    <span className="font-medium text-foreground">{assignment.nodeLabel}</span>
                                    <span className={`ml-auto rounded border px-1.5 py-0.5 text-[10px] ${
                                      assignment.fallback
                                        ? 'border-border bg-background/60 text-muted-foreground'
                                        : 'border-border bg-secondary/70 text-foreground'
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
                    )
                  })}
                </div>
              </section>
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
}: {
  label: string
  value: number
  detail: string
}) {
  return (
    <div className="rounded-xl border border-border bg-background/60 px-4 py-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-foreground font-mono-tight">{value}</p>
      <p className="mt-0.5 text-2xs text-muted-foreground/70">{detail}</p>
    </div>
  )
}
