import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ runOpenClaw: vi.fn() }))

vi.mock('@/lib/command', () => ({ runOpenClaw: mocks.runOpenClaw }))

import { executeN8nModelRoute } from '@/lib/n8n-model-execution'

const noDelivery = { mode: 'none' as const }

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  delete process.env.TEST_MODEL_API_KEY
})

describe('n8n model execution', () => {
  it('passes an OpenClaw prompt through a protected file instead of command arguments', async () => {
    mocks.runOpenClaw.mockImplementation(async (args: string[]) => {
      const promptPath = args[args.indexOf('--message-file') + 1]
      expect(promptPath).toBeTruthy()
      await expect(readFile(promptPath, 'utf8')).resolves.toContain('private task text')
      expect(args.join(' ')).not.toContain('private task text')
      return {
        stdout: JSON.stringify({ payloads: [{ text: 'done' }], meta: { agentMeta: { provider: 'local', model: 'qwen' } } }),
        stderr: '',
        code: 0,
      }
    })

    const output = await executeN8nModelRoute({
      id: 'local-qwen', label: 'Local', description: '', location: 'local',
      transport: 'openclaw', model: 'qwen/default', profile: 'qwen-current',
      agentId: 'second-original', enabled: true, timeoutSeconds: 60,
      thinking: 'off', capabilities: ['text'], systemPrompt: '',
    }, {
      nodeKey: 'executor', input: { task: 'private task text' },
      sessionKey: 'agent:second-original:test', delivery: noDelivery,
    })

    expect(output).toMatchObject({ text: 'done', routeId: 'local-qwen', transport: 'openclaw' })
  })

  it('reads a cloud API key only from the named environment variable', async () => {
    process.env.TEST_MODEL_API_KEY = 'external-secret-value'
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'cloud result' } }],
      usage: { total_tokens: 12 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    const output = await executeN8nModelRoute({
      id: 'cloud-qwen', label: 'Cloud', description: '', location: 'cloud',
      transport: 'openai-compatible', model: 'qwen3.7-plus',
      baseUrl: 'https://dashscope.example.test/v1', apiKeyEnv: 'TEST_MODEL_API_KEY',
      enabled: true, timeoutSeconds: 60, thinking: 'off', capabilities: ['text'], systemPrompt: '',
    }, {
      nodeKey: 'planner', input: { prompt: 'plan it' },
      sessionKey: 'unused', delivery: noDelivery,
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer external-secret-value')
    expect(output).toMatchObject({ text: 'cloud result', routeId: 'cloud-qwen', model: 'qwen3.7-plus' })
    expect(JSON.stringify(output)).not.toContain('external-secret-value')
  })

  it('does not let a direct model API perform conversation delivery', async () => {
    await expect(executeN8nModelRoute({
      id: 'cloud-qwen', label: 'Cloud', description: '', location: 'cloud',
      transport: 'openai-compatible', model: 'qwen3.7-plus',
      baseUrl: 'https://dashscope.example.test/v1', enabled: true,
      timeoutSeconds: 60, thinking: 'off', capabilities: ['text'], systemPrompt: '',
    }, {
      nodeKey: 'reviewer', input: {}, sessionKey: 'agent:main:phone',
      delivery: { mode: 'reply', sessionKey: 'agent:main:phone' },
    })).rejects.toThrow(/不能负责会话回投/)
  })
})
