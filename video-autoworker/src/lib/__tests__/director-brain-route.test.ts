import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  requireN8nRole: vi.fn(() => ({ user: { workspace_id: 2, tenant_id: 3 } })),
  isDirectorBrainScope: vi.fn(() => true),
  mutationLimiter: vi.fn(() => null),
  runDirectorCommand: vi.fn(),
  loggerWarn: vi.fn(),
}))

vi.mock('@/lib/n8n', () => ({ requireN8nRole: mocks.requireN8nRole }))
vi.mock('@/lib/director-brain-scope', () => ({ isDirectorBrainScope: mocks.isDirectorBrainScope }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: mocks.mutationLimiter }))
vi.mock('@/lib/director-evidence-outbox', () => ({ runDirectorCommand: mocks.runDirectorCommand }))
vi.mock('@/lib/logger', () => ({ logger: { warn: mocks.loggerWarn } }))

import { POST } from '@/app/api/n8n/director-brain/route'

function request(body: unknown) {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/director-brain', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('director brain application runtime route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.requireN8nRole.mockReturnValue({ user: { workspace_id: 2, tenant_id: 3 } })
    mocks.isDirectorBrainScope.mockReturnValue(true)
    mocks.mutationLimiter.mockReturnValue(null)
  })

  it.each(['operate', 'review'] as const)('runs %s through the shared app runtime', async command => {
    const input = command === 'operate'
      ? { action: 'get', table: 'works', stableId: 'WORK-1' }
      : { table: 'works', stableId: 'WORK-1', targetStatus: '生效' }
    mocks.runDirectorCommand.mockResolvedValue({ ok: true, action: command === 'operate' ? 'get' : 'review' })

    const response = await POST(request({ command, input }))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ ok: true })
    expect(mocks.requireN8nRole).toHaveBeenCalledWith(expect.anything(), 'operator')
    expect(mocks.runDirectorCommand).toHaveBeenCalledWith(command, input)
  })

  it('rejects expanded commands and the wrong director scope before execution', async () => {
    const invalid = await POST(request({ command: 'project-evidence', input: {} }))
    expect(invalid.status).toBe(400)
    expect(mocks.runDirectorCommand).not.toHaveBeenCalled()

    mocks.mutationLimiter.mockClear()
    mocks.runDirectorCommand.mockClear()
    mocks.isDirectorBrainScope.mockReturnValue(false)
    const forbidden = await POST(request({ command: 'operate', input: { action: 'health' } }))
    expect(forbidden.status).toBe(403)
    expect(mocks.mutationLimiter).not.toHaveBeenCalled()
    expect(mocks.runDirectorCommand).not.toHaveBeenCalled()
  })

  it('does not expose runtime errors or retry writes', async () => {
    mocks.runDirectorCommand.mockRejectedValue(new Error('feishu_private_detail:RECORD-SECRET'))
    const response = await POST(request({
      command: 'review',
      input: { table: 'works', stableId: 'WORK-1' },
    }))
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      ok: false,
      code: 'director_brain_application_service_unavailable',
      error: '导演脑服务暂时不可用，请稍后再试',
    })
    expect(mocks.runDirectorCommand).toHaveBeenCalledTimes(1)
    expect(mocks.loggerWarn).toHaveBeenCalledWith({
      code: 'director_brain_operation_failed',
      command: 'review',
      elapsedMs: expect.any(Number),
    }, 'Director brain application operation failed')
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain('RECORD-SECRET')
  })
})
