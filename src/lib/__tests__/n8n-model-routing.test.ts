import { afterEach, describe, expect, it } from 'vitest'
import {
  loadN8nModelRegistry,
  publicN8nModelRoute,
  resolveN8nNodeRoute,
  validateTaskRouteIds,
} from '@/lib/n8n-model-routing'

const registry = {
  version: 1,
  routes: [
    {
      id: 'local-qwen',
      label: '本地千问',
      location: 'local',
      transport: 'openclaw',
      model: 'qwen36-tools-local/default_model',
      profile: 'qwen-current',
      agentId: 'second-original',
      enabled: true,
    },
    {
      id: 'cloud-qwen',
      label: '云端千问',
      location: 'cloud',
      transport: 'openai-compatible',
      model: 'qwen3.7-plus',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      apiKeyEnv: 'TEST_DASHSCOPE_API_KEY',
      enabled: true,
    },
  ],
}

afterEach(() => {
  delete process.env.AIWORKER_MODEL_ROUTES_JSON
  delete process.env.TEST_DASHSCOPE_API_KEY
})

describe('n8n model routing', () => {
  it('loads local and cloud routes without storing credentials', () => {
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify(registry)
    const loaded = loadN8nModelRegistry()

    expect(loaded.errors).toEqual([])
    expect(loaded.routes.map(route => route.id)).toEqual(['local-qwen', 'cloud-qwen'])
    expect(publicN8nModelRoute(loaded.routes[1])).toMatchObject({
      available: false,
      credentialReference: 'TEST_DASHSCOPE_API_KEY',
    })
    process.env.TEST_DASHSCOPE_API_KEY = 'not-returned-to-client'
    expect(publicN8nModelRoute(loaded.routes[1])).toMatchObject({ available: true })
    expect(JSON.stringify(publicN8nModelRoute(loaded.routes[1]))).not.toContain('not-returned-to-client')
  })

  it('uses a task route override before the saved node route', () => {
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify(registry)
    process.env.TEST_DASHSCOPE_API_KEY = 'configured'
    const resolved = resolveN8nNodeRoute({
      model: 'legacy/default',
      config: {
        modelRouting: {
          allowTaskOverride: true,
          nodes: { planner: { routeId: 'local-qwen', fallbackRouteIds: [] } },
        },
      },
      taskRouting: {
        nodes: { planner: { routeId: 'cloud-qwen', fallbackRouteIds: [] } },
      },
    }, 'planner')

    expect(resolved.route.id).toBe('cloud-qwen')
    expect(resolved.source).toBe('task')
  })

  it('uses the next registered route when the preferred route lacks its external credential', () => {
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify(registry)
    const resolved = resolveN8nNodeRoute({
      config: {
        modelRouting: {
          nodes: {
            planner: { routeId: 'cloud-qwen', fallbackRouteIds: ['local-qwen'] },
          },
        },
      },
    }, 'planner')

    expect(resolved.route.id).toBe('local-qwen')
    expect(resolved.candidates).toEqual(['cloud-qwen', 'local-qwen'])
  })

  it('falls back to the legacy binding when a node has no registered route', () => {
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify(registry)
    const resolved = resolveN8nNodeRoute({
      model: 'qwen36-tools-local/default_model',
      timeoutSeconds: 90,
      config: { profile: 'qwen-current', agentId: 'second-original' },
    }, 'executor')

    expect(resolved.route).toMatchObject({
      id: 'legacy-binding',
      transport: 'openclaw',
      profile: 'qwen-current',
      agentId: 'second-original',
    })
    expect(resolved.source).toBe('legacy')
  })

  it('reports route IDs that are not in the registry', () => {
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify(registry)
    expect(validateTaskRouteIds({
      nodes: { reviewer: { routeId: 'missing-route', fallbackRouteIds: ['local-qwen'] } },
    }, loadN8nModelRegistry())).toEqual(['missing-route'])
  })
})
