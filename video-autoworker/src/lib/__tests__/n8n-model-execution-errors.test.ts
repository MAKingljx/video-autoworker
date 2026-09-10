import { afterEach, describe, expect, it, vi } from 'vitest'
import { executeN8nModelRoute, n8nModelExecutionError } from '@/lib/n8n-model-execution'
import type { N8nModelRoute } from '@/lib/n8n-model-routing'

const route: N8nModelRoute = {
  id: 'local-test-model',
  label: '测试模型',
  description: '',
  location: 'local',
  transport: 'openai-compatible',
  model: 'test-model',
  baseUrl: 'http://127.0.0.1:18091/v1',
  enabled: true,
  timeoutSeconds: 30,
  thinking: 'off',
  capabilities: ['text'],
  systemPrompt: '',
}

afterEach(() => vi.unstubAllGlobals())

describe('n8n model execution error boundary', () => {
  it('keeps an HTTP error body out of the thrown and persisted message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: {
        message: 'failed /Users/operator/private https://private.example api_key=secret cli_a1b2c3d4e5f6g7h8',
      },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } })))

    let failure: unknown
    try {
      await executeN8nModelRoute(route, {
        nodeKey: 'planner',
        input: { prompt: 'test' },
        sessionKey: 'agent:test',
        delivery: { mode: 'none' },
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({
      publicCode: 'N8N_MODEL_HTTP_FAILED',
      message: '[N8N_MODEL_HTTP_FAILED] 模型服务调用失败',
    })
    expect(String((failure as { diagnostic?: string }).diagnostic)).toContain('statusCode')
    expect(String((failure as { diagnostic?: string }).diagnostic)).not.toContain('/Users/operator')
    expect(String((failure as { diagnostic?: string }).diagnostic)).not.toContain('private.example')
    expect(String((failure as { diagnostic?: string }).diagnostic)).not.toContain('api_key=secret')
    expect(n8nModelExecutionError(failure)).toBe(
      '[N8N_MODEL_HTTP_FAILED] 模型服务调用失败',
    )
  })
})
