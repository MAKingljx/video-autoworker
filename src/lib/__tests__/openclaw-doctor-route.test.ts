import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runOpenClaw, requireRole } = vi.hoisted(() => ({
  runOpenClaw: vi.fn(), requireRole: vi.fn(),
}))
vi.mock('@/lib/command', () => ({ runOpenClaw }))
vi.mock('@/lib/auth', () => ({ requireRole }))
vi.mock('@/lib/config', () => ({ config: { openclawStateDir: '/fixture/unused-state' } }))
vi.mock('@/lib/db', () => ({ getDatabase: () => ({ prepare: () => ({ run: vi.fn() }) }) }))
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn() } }))
vi.mock('@/lib/openclaw-doctor', () => ({ parseOpenClawDoctorOutput: () => ({ healthy: true, level: 'ok', issues: [] }) }))

describe('OpenClaw doctor adapter', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('delegates repair to official doctor and checks the result without extra history cleanup', async () => {
    requireRole.mockReturnValue({ user: { username: 'admin' } })
    runOpenClaw.mockResolvedValue({ stdout: 'healthy', stderr: '', code: 0 })
    const { POST } = await import('@/app/api/openclaw/doctor/route')
    const response = await POST(new Request('http://localhost/api/openclaw/doctor', { method: 'POST' }))
    expect(response.status).toBe(200)
    expect(runOpenClaw.mock.calls.map(call => call[0])).toEqual([['doctor', '--fix'], ['doctor']])
    expect((await response.json()).progress.map((step: { step: string }) => step.step)).toEqual(['doctor'])
  })

  it('does not run any repair for a caller without the required role', async () => {
    requireRole.mockReturnValue({ error: 'Forbidden', status: 403 })
    const { POST } = await import('@/app/api/openclaw/doctor/route')
    const response = await POST(new Request('http://localhost/api/openclaw/doctor', { method: 'POST' }))
    expect(response.status).toBe(403)
    expect(runOpenClaw).not.toHaveBeenCalled()
  })
})
