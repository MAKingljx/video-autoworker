import { describe, expect, it, vi } from 'vitest'
import { createRuntimeProviderRegistry } from '../runtime/registry'
import type { RuntimeProvider } from '../runtime/contracts'

function externalProvider(): RuntimeProvider {
  return {
    id: 'external',
    sessionCapabilities: { list: true, history: true, delete: true, bulkPrune: false },
    sendMessage: vi.fn(async ({ message, idempotencyKey }) => ({
      status: 'accepted', runId: 'external-run', raw: { message, idempotencyKey },
    })),
    waitForRun: vi.fn(async () => ({ status: 'completed', raw: { text: 'done' } })),
    spawnSession: vi.fn(), controlSession: vi.fn(),
    listSessions: vi.fn(async () => []),
    getSessionHistory: vi.fn(async () => ({ messages: [] })),
    updateSessionConfig: vi.fn(),
    deleteSession: vi.fn(),
    countSessionsOlderThan: vi.fn(),
    pruneSessionsOlderThan: vi.fn(),
  }
}

describe('platform independent runtime composition', () => {
  it('executes through a replacement provider without constructing OpenClaw', async () => {
    const unavailableOpenClaw = vi.fn((): RuntimeProvider => {
      throw new Error('OpenClaw is not installed')
    })
    const external = externalProvider()
    const makeExternal = vi.fn(() => external)
    const registry = createRuntimeProviderRegistry({
      openclaw: unavailableOpenClaw, external: makeExternal,
    }, 'external')
    const runtime = registry.get()
    const accepted = await runtime.sendMessage({
      agentId: 'worker-1', message: 'Process fixture', idempotencyKey: 'request-1',
    })
    expect(accepted).toMatchObject({ runId: 'external-run', raw: { idempotencyKey: 'request-1' } })
    await expect(runtime.waitForRun(accepted.runId!)).resolves.toMatchObject({ status: 'completed' })
    expect(registry.get()).toBe(runtime)
    expect(makeExternal).toHaveBeenCalledTimes(1)
    expect(unavailableOpenClaw).not.toHaveBeenCalled()
  })

  it('fails closed for an unknown or unavailable selected provider', () => {
    const fallback = vi.fn(externalProvider)
    expect(() => createRuntimeProviderRegistry({ external: fallback }, 'missing')).toThrow(/not registered/u)
    const registry = createRuntimeProviderRegistry({
      external: fallback, offline: () => { throw new Error('unavailable') },
    }, 'offline')
    expect(() => registry.get()).toThrow('unavailable')
    expect(() => registry.get('constructor')).toThrow(/not registered/u)
    expect(fallback).not.toHaveBeenCalled()
  })

  it('binds provider identity and snapshots factories for a stable composition', () => {
    const factories = { external: externalProvider }
    const registry = createRuntimeProviderRegistry(factories, 'external')
    factories.external = () => { throw new Error('mutated outside registry') }
    expect(registry.get().id).toBe('external')
    const mismatch = createRuntimeProviderRegistry({ wrong: externalProvider }, 'wrong')
    expect(() => mismatch.get()).toThrow(/identity mismatch/u)
  })
})
