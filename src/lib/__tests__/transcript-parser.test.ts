import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'

const existsSync = vi.spyOn(fs, 'existsSync')
const readFileSync = vi.spyOn(fs, 'readFileSync')

vi.mock('@/lib/config', () => ({
  config: {
    openclawStateDir: '/mock/openclaw',
  },
}))

describe('transcript parser helpers', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('reads session JSONL through the source transcript-path helper instead of inlining agents/*/sessions path joins', async () => {
    existsSync.mockImplementation((target: any) => String(target) === '/custom/openclaw/agents/jarv/sessions/sess-123.jsonl')
    readFileSync.mockImplementation((target: any) => {
      if (String(target) === '/custom/openclaw/agents/jarv/sessions/sess-123.jsonl') return '{"type":"message"}\n'
      throw new Error(`Unexpected read: ${String(target)}`)
    })

    const { readSessionJsonl } = await import('@/lib/transcript-parser')

    expect(readSessionJsonl('/custom/openclaw', 'jarv', 'sess-123')).toBe('{"type":"message"}\n')
    expect(existsSync).toHaveBeenCalledWith('/custom/openclaw/agents/jarv/sessions/sess-123.jsonl')
    expect(readFileSync).toHaveBeenCalledWith('/custom/openclaw/agents/jarv/sessions/sess-123.jsonl', 'utf-8')
  })
})
