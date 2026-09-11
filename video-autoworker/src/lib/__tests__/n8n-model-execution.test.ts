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

  it('passes a bounded strict JSON schema to a compatible structured-output route', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)
    const schema = {
      type: 'object', properties: { ok: { type: 'boolean' } },
      required: ['ok'], additionalProperties: false,
    }

    await executeN8nModelRoute({
      id: 'local-structured', label: 'Local', description: '', location: 'local',
      transport: 'openai-compatible', model: 'default_model',
      baseUrl: 'http://127.0.0.1:18091/v1', enabled: true,
      timeoutSeconds: 180, thinking: 'off',
      capabilities: ['text', 'structured-output'], systemPrompt: '',
    }, {
      nodeKey: 'director-understanding', input: { evidence: 'reviewed' },
      sessionKey: 'unused', delivery: noDelivery,
      structuredOutput: { name: 'director_understanding_v1', schema },
    })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(String(init.body))
    expect(body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'director_understanding_v1', strict: true, schema },
    })
  })

  it('rejects a strict response schema on a transport that cannot enforce it', async () => {
    await expect(executeN8nModelRoute({
      id: 'openclaw-qwen', label: 'OpenClaw', description: '', location: 'local',
      transport: 'openclaw', model: 'qwen/default', profile: 'qwen-current',
      agentId: 'second-original', enabled: true, timeoutSeconds: 60,
      thinking: 'off', capabilities: ['text', 'structured-output'], systemPrompt: '',
    }, {
      nodeKey: 'director', input: {}, sessionKey: 'agent:second-original:test',
      delivery: noDelivery,
      structuredOutput: {
        name: 'director_understanding_v1',
        schema: { type: 'object', additionalProperties: false },
      },
    })).rejects.toThrow('OpenClaw 路由不支持严格结构化输出')
    expect(mocks.runOpenClaw).not.toHaveBeenCalled()
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
