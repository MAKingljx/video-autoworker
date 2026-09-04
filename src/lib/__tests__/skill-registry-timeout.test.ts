import { afterEach, describe, expect, it, vi } from 'vitest'

describe('skill registry network deadline', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('returns the offline awesome-openclaw fallback even when fetch ignores abort', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const { searchRegistry } = await import('@/lib/skill-registry')

    const pending = searchRegistry('awesome-openclaw', 'git')
    await vi.advanceTimersByTimeAsync(15_001)

    await expect(pending).resolves.toEqual({
      skills: [],
      total: 0,
      source: 'awesome-openclaw',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
