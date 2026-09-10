import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  withDetectedGatewayProcessEnvironment: vi.fn(),
  runOpenClaw: vi.fn(),
}))

vi.mock('@/lib/gateway-runtime', () => ({
  withDetectedGatewayProcessEnvironment: mocks.withDetectedGatewayProcessEnvironment,
}))

vi.mock('@/lib/command', () => ({
  runOpenClaw: mocks.runOpenClaw,
}))

import { callOpenClawGateway, parseGatewayJsonOutput } from '@/lib/openclaw-gateway'

beforeEach(() => {
  mocks.withDetectedGatewayProcessEnvironment.mockReset()
  mocks.runOpenClaw.mockReset()
})

describe('parseGatewayJsonOutput', () => {
  it('parses embedded object payloads', () => {
    expect(parseGatewayJsonOutput('warn\n{"status":"started","runId":"abc"}\n')).toEqual({
      status: 'started',
      runId: 'abc',
    })
  })

  it('parses embedded array payloads', () => {
    expect(parseGatewayJsonOutput('note\n[{"id":1},{"id":2}]')).toEqual([{ id: 1 }, { id: 2 }])
  })

  it('returns null for non-json output', () => {
    expect(parseGatewayJsonOutput('plain text only')).toBeNull()
  })
})

describe('callOpenClawGateway', () => {
  it('passes the resolved token only through the child environment', async () => {
    const token = 'b'.repeat(64)
    mocks.withDetectedGatewayProcessEnvironment.mockReturnValue({ OPENCLAW_GATEWAY_TOKEN: token })
    mocks.runOpenClaw.mockResolvedValue({
      stdout: '{"ok":true}',
      stderr: '',
      code: 0,
    })

    await expect(callOpenClawGateway('tools.catalog', {}, 5_000)).resolves.toEqual({ ok: true })

    expect(mocks.runOpenClaw).toHaveBeenCalledOnce()
    const [args, options] = mocks.runOpenClaw.mock.calls[0]
    expect(JSON.stringify(args)).not.toContain(token)
    expect(options).toMatchObject({
      timeoutMs: 7_000,
      env: { OPENCLAW_GATEWAY_TOKEN: token },
    })
  })
})
