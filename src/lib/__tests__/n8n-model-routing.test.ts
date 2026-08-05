import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  loadN8nModelRegistry,
  publicAuxiliaryModelResource,
  publicN8nModelRoute,
  resolveN8nNodeRoute,
  validateTaskRouteIds,
} from '@/lib/n8n-model-routing'

const registry = {
  version: 1,
  resources: [
    {
      id: 'whisper-large-v3-turbo',
      label: 'Whisper large-v3-turbo',
      location: 'local',
      kind: 'speech-recognition',
      model: 'large-v3-turbo',
      capabilities: ['audio', 'transcription'],
      usedBy: ['qwen-current 语音消息转写'],
      runtime: {
        type: 'cli',
        command: '/bin/sh',
        requiredFiles: ['/bin/sh'],
      },
    },
    {
      id: 'nomic-embed-text',
      label: 'nomic-embed-text',
      location: 'local',
      kind: 'embedding',
      model: 'nomic-embed-text',
      capabilities: ['text', 'embedding'],
      usedBy: ['gpt-main 长期记忆检索'],
      runtime: {
        type: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
      },
    },
  ],
  routes: [
    {
      id: 'local-qwen-direct',
      resourceId: 'qwen-local',
      resourceLabel: '本地千问',
      label: '本地千问直连',
      location: 'local',
      transport: 'openai-compatible',
      model: 'default_model',
      baseUrl: 'http://127.0.0.1:18091/v1',
      enabled: true,
    },
    {
      id: 'local-qwen',
      resourceId: 'qwen-local',
      resourceLabel: '本地千问',
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
  vi.restoreAllMocks()
  delete process.env.AIWORKER_MODEL_ROUTES_JSON
  delete process.env.TEST_DASHSCOPE_API_KEY
})

describe('n8n model routing', () => {
  it('loads local and cloud routes without storing credentials', () => {
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify(registry)
    const loaded = loadN8nModelRegistry()

    expect(loaded.errors).toEqual([])
    expect(loaded.routes.map(route => route.id)).toEqual(['local-qwen-direct', 'local-qwen', 'cloud-qwen'])
    expect(loaded.resources.map(resource => resource.id)).toEqual(['whisper-large-v3-turbo', 'nomic-embed-text'])
    expect(publicN8nModelRoute(loaded.routes[2])).toMatchObject({
      available: false,
      credentialReference: 'TEST_DASHSCOPE_API_KEY',
    })
    process.env.TEST_DASHSCOPE_API_KEY = 'not-returned-to-client'
    expect(publicN8nModelRoute(loaded.routes[2])).toMatchObject({ available: true })
    expect(JSON.stringify(publicN8nModelRoute(loaded.routes[2]))).not.toContain('not-returned-to-client')
    expect(publicN8nModelRoute(loaded.routes[0])).toMatchObject({
      id: 'local-qwen-direct',
      resourceId: 'qwen-local',
      resourceLabel: '本地千问',
      location: 'local',
      transport: 'openai-compatible',
      available: true,
    })
  })

  it('checks CLI files and Ollama tags without exposing local paths', async () => {
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify(registry)
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      models: [{ name: 'nomic-embed-text:latest' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const loaded = loadN8nModelRegistry()

    await expect(publicAuxiliaryModelResource(loaded.resources[0])).resolves.toMatchObject({
      available: true,
      endpoint: 'CLI · sh',
    })
    await expect(publicAuxiliaryModelResource(loaded.resources[1])).resolves.toMatchObject({
      available: true,
      endpoint: 'Ollama · 127.0.0.1:11434',
    })
    expect(JSON.stringify(await publicAuxiliaryModelResource(loaded.resources[0]))).not.toContain('/bin/sh')
  })

  it('rejects an auxiliary Ollama endpoint outside the local machine', () => {
    process.env.AIWORKER_MODEL_ROUTES_JSON = JSON.stringify({
      ...registry,
      resources: [{
        ...registry.resources[1],
        runtime: { type: 'ollama', baseUrl: 'https://example.com' },
      }],
    })
    const loaded = loadN8nModelRegistry()

    expect(loaded.routes).toEqual([])
    expect(loaded.resources).toEqual([])
    expect(loaded.errors.join(' ')).toContain('本地 Ollama 地址必须使用回环 HTTP')
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
