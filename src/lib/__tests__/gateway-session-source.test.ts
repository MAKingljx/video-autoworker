import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'

const existsSync = vi.spyOn(fs, 'existsSync')
const readdirSync = vi.spyOn(fs, 'readdirSync')
const statSync = vi.spyOn(fs, 'statSync')
const readFileSync = vi.spyOn(fs, 'readFileSync')

vi.mock('@/lib/config', () => ({
  config: {
    openclawStateDir: '/mock/openclaw',
  },
}))

describe('openclaw session source helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('exposes gateway session store files discovered under agents/*/sessions/sessions.json', async () => {
    existsSync.mockImplementation((target: any) => String(target) === '/mock/openclaw/agents')
    readdirSync.mockReturnValue(['main', 'worker'] as any)
    statSync.mockImplementation((target: any) => ({
      isFile: () => String(target).endsWith('/main/sessions/sessions.json'),
    }) as any)

    const { getGatewaySessionStoreFiles } = await import('@/lib/openclaw-session-source')
    expect(getGatewaySessionStoreFiles()).toEqual(['/mock/openclaw/agents/main/sessions/sessions.json'])
  })

  it('resolves a gateway session by key and builds transcript path from source boundary helpers', async () => {
    existsSync.mockImplementation((target: any) => String(target) === '/mock/openclaw/agents')
    readdirSync.mockReturnValue(['jarv'] as any)
    statSync.mockImplementation((target: any) => ({
      isFile: () => String(target).endsWith('/jarv/sessions/sessions.json'),
    }) as any)
    readFileSync.mockImplementation((target: any) => {
      if (String(target).endsWith('/jarv/sessions/sessions.json')) {
        return JSON.stringify({
          'agent:jarv:main': {
            sessionId: 'sess-123',
            updatedAt: 123,
            chatType: 'direct',
            channel: 'telegram',
          },
        })
      }
      throw new Error(`Unexpected read: ${String(target)}`)
    })

    const { getGatewaySessionByKey, getGatewayTranscriptPath, getGatewayTranscriptPathAtStateDir } = await import('@/lib/openclaw-session-source')
    const session = getGatewaySessionByKey('agent:jarv:main', true)

    expect(session).toMatchObject({
      key: 'agent:jarv:main',
      agent: 'jarv',
      sessionId: 'sess-123',
    })
    expect(getGatewayTranscriptPath(session!)).toBe('/mock/openclaw/agents/jarv/sessions/sess-123.jsonl')
    expect(getGatewayTranscriptPathAtStateDir('/alt/openclaw', session!)).toBe('/alt/openclaw/agents/jarv/sessions/sess-123.jsonl')
  })
})
