import type { PublicAuxiliaryModelResource, PublicN8nModelRoute } from '@/lib/n8n-model-routing'

export interface ModelClusterBinding {
  id: number
  name: string
  enabled: boolean
  config: Record<string, unknown>
}
export interface ModelClusterAssignment {
  bindingId: number
  bindingName: string
  bindingEnabled: boolean
  nodeKey: string
  nodeLabel: string
  routeId: string
  fallback: boolean
}

export interface ModelClusterResource {
  id: string
  label: string
  description: string
  location: 'local' | 'cloud'
  available: boolean
  enabled: boolean
  kind: 'generative' | PublicAuxiliaryModelResource['kind']
  production: boolean
  models: string[]
  capabilities: string[]
  usedBy: string[]
  endpoint: string | null
  routes: PublicN8nModelRoute[]
  assignments: ModelClusterAssignment[]
}

const NODE_LABELS: Record<string, string> = {
  planner: '规划节点',
  executor: '执行节点',
  reviewer: '审核节点',
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function routeAssignments(bindings: ModelClusterBinding[]): Map<string, ModelClusterAssignment[]> {
  const byRoute = new Map<string, ModelClusterAssignment[]>()

  for (const binding of bindings) {
    const modelRouting = objectValue(binding.config.modelRouting)
    const nodes = objectValue(modelRouting.nodes)

    for (const [nodeKey, rawSelection] of Object.entries(nodes)) {
      const selection = objectValue(rawSelection)
      const primaryRouteId = String(selection.routeId || '').trim()
      const fallbackRouteIds = Array.isArray(selection.fallbackRouteIds)
        ? selection.fallbackRouteIds.map(value => String(value || '').trim()).filter(Boolean)
        : []
      const candidates = [
        ...(primaryRouteId ? [{ routeId: primaryRouteId, fallback: false }] : []),
        ...fallbackRouteIds
          .filter(routeId => routeId !== primaryRouteId)
          .map(routeId => ({ routeId, fallback: true })),
      ]

      for (const candidate of candidates) {
        const assignment: ModelClusterAssignment = {
          bindingId: binding.id,
          bindingName: binding.name,
          bindingEnabled: binding.enabled,
          nodeKey,
          nodeLabel: NODE_LABELS[nodeKey] || nodeKey,
          routeId: candidate.routeId,
          fallback: candidate.fallback,
        }
        byRoute.set(candidate.routeId, [...(byRoute.get(candidate.routeId) || []), assignment])
      }
    }
  }

  return byRoute
}

export function buildModelCluster(
  routes: PublicN8nModelRoute[],
  bindings: ModelClusterBinding[],
  auxiliaryResources: PublicAuxiliaryModelResource[] = [],
): ModelClusterResource[] {
  const assignmentsByRoute = routeAssignments(bindings)
  const grouped = new Map<string, PublicN8nModelRoute[]>()

  for (const route of routes) {
    grouped.set(route.resourceId, [...(grouped.get(route.resourceId) || []), route])
  }

  const routedResources = [...grouped.entries()].map(([resourceId, resourceRoutes]) => {
    const assignments = resourceRoutes.flatMap(route => assignmentsByRoute.get(route.id) || [])
    return {
      id: resourceId,
      label: resourceRoutes[0]?.resourceLabel || resourceId,
      description: resourceRoutes[0]?.description || '',
      location: resourceRoutes[0]?.location || 'local',
      available: resourceRoutes.some(route => route.available),
      enabled: resourceRoutes.some(route => route.enabled),
      kind: 'generative' as const,
      production: true,
      models: [...new Set(resourceRoutes.map(route => route.model))],
      capabilities: [...new Set(resourceRoutes.flatMap(route => route.capabilities))].sort(),
      usedBy: [],
      endpoint: null,
      routes: [...resourceRoutes].sort((a, b) => Number(b.available) - Number(a.available) || a.label.localeCompare(b.label)),
      assignments: assignments.sort((a, b) =>
        a.bindingName.localeCompare(b.bindingName) || a.nodeLabel.localeCompare(b.nodeLabel) || Number(a.fallback) - Number(b.fallback)),
    }
  })

  const routedIds = new Set(routedResources.map(resource => resource.id))
  const standaloneResources: ModelClusterResource[] = auxiliaryResources
    .filter(resource => !routedIds.has(resource.id))
    .map(resource => ({
      id: resource.id,
      label: resource.label,
      description: resource.description,
      location: resource.location,
      available: resource.available,
      enabled: resource.enabled,
      kind: resource.kind,
      production: resource.production,
      models: [resource.model],
      capabilities: [...new Set(resource.capabilities)].sort(),
      usedBy: [...resource.usedBy],
      endpoint: resource.endpoint,
      routes: [],
      assignments: [],
    }))

  return [...routedResources, ...standaloneResources].sort((a, b) =>
    Number(b.production) - Number(a.production)
      || Number(a.location === 'cloud') - Number(b.location === 'cloud')
      || a.label.localeCompare(b.label))
}
