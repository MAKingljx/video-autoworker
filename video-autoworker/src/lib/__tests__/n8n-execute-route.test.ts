import { readFile } from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  runOpenClaw: vi.fn(),
  getDatabase: vi.fn(),
  getN8nTaskRunByTaskId: vi.fn(),
  claimN8nTaskRun: vi.fn(),
  completeN8nTaskRun: vi.fn(),
  failN8nTaskRun: vi.fn(),
  checkN8nCallbackAdmission: vi.fn(),
}))

vi.mock('@/lib/command', () => ({ runOpenClaw: mocks.runOpenClaw }))
vi.mock('@/lib/db', () => ({ getDatabase: mocks.getDatabase }))
vi.mock('@/lib/n8n-runtime-affinity', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-runtime-affinity')>()
  return {
    ...actual,
    checkN8nCallbackAdmission: mocks.checkN8nCallbackAdmission,
  }
})
vi.mock('@/lib/n8n-task-runs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/n8n-task-runs')>()
  return {
    ...actual,
    getN8nTaskRunByTaskId: mocks.getN8nTaskRunByTaskId,
    claimN8nTaskRun: mocks.claimN8nTaskRun,
    completeN8nTaskRun: mocks.completeN8nTaskRun,
    failN8nTaskRun: mocks.failN8nTaskRun,
  }
})

import { POST } from '@/app/api/n8n/execute/route'

const run = {
  id: 1,
  taskId: 'task-1',
  idempotencyKey: 'idem-1',
  bindingId: 7,
  status: 'accepted',
  source: 'video-autoworker',
  requestedBy: 'local-desktop',
  routing: {
    callbackProtocol: 'legacy-v1',
    model: 'qwen36-tools-local/default_model',
    timeoutSeconds: 120,
    config: { profile: 'qwen-current', agentId: 'second-original' },
  },
  input: { prompt: '只输出：闭环成功' },
  delivery: { mode: 'none' as const },
  output: null,
  error: null,
  attemptCount: 0,
  maxAttempts: 2,
  workspaceId: 1,
  tenantId: 1,
  createdAt: 1,
  acceptedAt: 1,
  startedAt: null,
  completedAt: null,
  updatedAt: 1,
}

function request() {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/execute', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ taskId: 'task-1', idempotencyKey: 'idem-1' }),
  })
}

describe('n8n local execution route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getDatabase.mockReturnValue({})
    mocks.getN8nTaskRunByTaskId.mockReturnValue(run)
    mocks.checkN8nCallbackAdmission.mockReturnValue({ allowed: true, mode: 'legacy' })
    mocks.claimN8nTaskRun.mockReturnValue({
      claimed: true,
      run: { ...run, status: 'running', attemptCount: 1 },
    })
    mocks.completeN8nTaskRun.mockImplementation((_db, _taskId, output) => ({
      ...run,
      status: 'succeeded',
      output,
    }))
    mocks.runOpenClaw.mockImplementation(async (args: string[]) => {
      const promptPath = args[args.indexOf('--message-file') + 1]
      expect(await readFile(promptPath, 'utf8')).toContain('只输出：闭环成功')
      expect(args).not.toContain('只输出：闭环成功')
      return {
        stdout: JSON.stringify({
          payloads: [{ text: '闭环成功' }],
          sessionId: 'session-1',
          deliverySucceeded: false,
          meta: { agentMeta: { provider: 'qwen36-tools-local', model: 'default_model' } },
        }),
        stderr: '',
        code: 0,
      }
    })
  })

  it('runs the configured local OpenClaw model without putting the prompt in argv', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toMatchObject({
      taskId: 'task-1',
      status: 'succeeded',
      output: {
        text: '闭环成功',
        sessionId: 'session-1',
        profile: 'qwen-current',
        agentId: 'second-original',
        deliveryRequested: false,
      },
    })
    expect(mocks.runOpenClaw).toHaveBeenCalledWith(expect.arrayContaining([
      '--profile', 'qwen-current',
      '--agent', 'second-original',
      '--model', 'qwen36-tools-local/default_model',
      '--thinking', 'off',
    ]), { timeoutMs: 135_000 })
    expect(mocks.completeN8nTaskRun).toHaveBeenCalledWith({}, 'task-1', expect.objectContaining({ text: '闭环成功' }))
  })

  it.each([
    ['missing', { ...run.routing, callbackProtocol: undefined }],
    ['slot', { ...run.routing, callbackProtocol: 'slot-v1', runtimeSlot: 'blue', runtimeReleaseId: 'release-a' }],
  ])('rejects %s callback ownership before claiming the legacy task', async (_label, routing) => {
    mocks.getN8nTaskRunByTaskId.mockReturnValue({ ...run, routing })

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'N8N_LEGACY_EXECUTION_REQUIRED' })
    expect(mocks.checkN8nCallbackAdmission).not.toHaveBeenCalled()
    expect(mocks.claimN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.runOpenClaw).not.toHaveBeenCalled()
  })

  it('rejects explicit legacy work when the current runtime is a blue-green slot', async () => {
    mocks.checkN8nCallbackAdmission.mockReturnValue({
      allowed: false,
      code: 'runtime_affinity_mismatch',
      error: '父任务回调属于其他运行版本',
    })

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ code: 'runtime_affinity_mismatch' })
    expect(mocks.claimN8nTaskRun).not.toHaveBeenCalled()
    expect(mocks.runOpenClaw).not.toHaveBeenCalled()
  })

  it('returns a cached result without invoking the model twice', async () => {
    mocks.getN8nTaskRunByTaskId.mockReturnValue({
      ...run,
      status: 'succeeded',
      output: { text: 'cached' },
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ cached: true, output: { text: 'cached' } })
    expect(mocks.runOpenClaw).not.toHaveBeenCalled()
  })

  it('records a retryable failure without exposing the prompt in the error', async () => {
    mocks.runOpenClaw.mockRejectedValue(Object.assign(new Error('Command failed (openclaw --message secret)'), {
      stderr: 'model unavailable',
    }))
    mocks.failN8nTaskRun.mockReturnValue({ ...run, status: 'failed', attemptCount: 1, maxAttempts: 2 })

    const response = await POST(request())

    expect(response.status).toBe(502)
    expect(await response.json()).toMatchObject({ error: 'model unavailable', retryable: true })
    expect(mocks.failN8nTaskRun).toHaveBeenCalledWith({}, 'task-1', 'model unavailable')
  })
})
