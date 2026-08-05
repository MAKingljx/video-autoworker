import { describe, expect, it } from 'vitest'
import { buildModelCluster } from '@/lib/model-cluster'
import type { PublicAuxiliaryModelResource, PublicN8nModelRoute } from '@/lib/n8n-model-routing'

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

const auxiliaryResources: PublicAuxiliaryModelResource[] = [{
  id: 'whisper-large-v3-turbo',
  label: 'Whisper large-v3-turbo',
  description: '语音转写',
  location: 'local',
  kind: 'speech-recognition',
  model: 'large-v3-turbo',
  production: true,
  enabled: true,
  available: true,
  unavailableReason: null,
  capabilities: ['audio', 'transcription'],
  usedBy: ['qwen-current 语音消息转写'],
  runtime: 'cli',
  endpoint: 'CLI · aiworker-whisper-transcribe',
}]

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
    }], auxiliaryResources)

    expect(cluster).toHaveLength(2)
    const qwen = cluster.find(resource => resource.id === 'qwen-local')
    const whisper = cluster.find(resource => resource.id === 'whisper-large-v3-turbo')
    expect(qwen).toMatchObject({
      id: 'qwen-local',
      label: '本地千问',
      location: 'local',
      available: true,
      kind: 'generative',
      capabilities: ['reasoning', 'text', 'tools'],
    })
    expect(qwen?.routes.map(route => route.id)).toEqual(['local-agent', 'local-direct'])
    expect(qwen?.assignments).toEqual([
      expect.objectContaining({ nodeKey: 'executor', routeId: 'local-direct', fallback: false }),
      expect.objectContaining({ nodeKey: 'planner', routeId: 'local-direct', fallback: false }),
      expect.objectContaining({ nodeKey: 'planner', routeId: 'local-agent', fallback: true }),
    ])
    expect(whisper).toMatchObject({
      kind: 'speech-recognition',
      routes: [],
      usedBy: ['qwen-current 语音消息转写'],
      endpoint: 'CLI · aiworker-whisper-transcribe',
    })
  })
})
