import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'

const existsSync = vi.spyOn(fs, 'existsSync')
const readdirSync = vi.spyOn(fs, 'readdirSync')
const statSync = vi.spyOn(fs, 'statSync')

vi.mock('@/lib/config', () => ({
  config: {
    openclawStateDir: '/mock/openclaw',
  },
}))

describe('sessions helpers', () => {
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

    const { getGatewaySessionStoreFiles } = await import('@/lib/sessions')
    expect(getGatewaySessionStoreFiles()).toEqual(['/mock/openclaw/agents/main/sessions/sessions.json'])
  })
})
