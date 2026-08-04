import { describe, expect, it } from 'vitest'
import { buildModelCluster } from '@/lib/model-cluster'
import type { PublicN8nModelRoute } from '@/lib/n8n-model-routing'

const routes: PublicN8nModelRoute[] = [
  {
    id: 'local-direct',
    resourceId: 'qwen-local',
    resourceLabel: '本地千问',
    label: '本地千问直连',
    description: 'direct',
    location: 'local',
    transport: 'openai-compatible',
    model: 'default_model',
    enabled: true,
    available: true,
    unavailableReason: null,
    capabilities: ['text', 'reasoning'],
    baseUrl: 'http://127.0.0.1:18091/v1',
  },
  {
    id: 'local-agent',
    resourceId: 'qwen-local',
    resourceLabel: '本地千问',
    label: '本地千问 Agent',
    description: 'agent',
    location: 'local',
    transport: 'openclaw',
    model: 'qwen/default_model',
    enabled: true,
    available: true,
    unavailableReason: null,
    capabilities: ['text', 'tools'],
    profile: 'qwen-current',
    agentId: 'main',
  },
]

describe('model cluster projection', () => {
  it('groups access routes under one physical model and derives node responsibilities', () => {
    const cluster = buildModelCluster(routes, [{
      id: 7,
      name: '默认任务链',
      enabled: true,
      config: {
        modelRouting: {
          nodes: {
            planner: { routeId: 'local-direct', fallbackRouteIds: ['local-agent'] },
            executor: { routeId: 'local-direct', fallbackRouteIds: [] },
          },
        },
      },
    }])

    expect(cluster).toHaveLength(1)
    expect(cluster[0]).toMatchObject({
      id: 'qwen-local',
      label: '本地千问',
      location: 'local',
      available: true,
      capabilities: ['reasoning', 'text', 'tools'],
    })
    expect(cluster[0].routes.map(route => route.id)).toEqual(['local-agent', 'local-direct'])
    expect(cluster[0].assignments).toEqual([
      expect.objectContaining({ nodeKey: 'executor', routeId: 'local-direct', fallback: false }),
      expect.objectContaining({ nodeKey: 'planner', routeId: 'local-direct', fallback: false }),
      expect.objectContaining({ nodeKey: 'planner', routeId: 'local-agent', fallback: true }),
    ])
  })
})
