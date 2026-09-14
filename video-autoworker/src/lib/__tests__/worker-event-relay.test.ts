// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({ on: vi.fn(), getDatabase: vi.fn() }))
vi.mock('@/lib/event-bus', () => ({ eventBus: { on: hooks.on } }))
vi.mock('@/lib/db', () => ({ getDatabase: hooks.getDatabase }))

describe('worker notification relay ownership', () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks() })

  it('registers the webhook consumer once and does not deliver relayed events again', async () => {
    const { initWebhookListener } = await import('@/lib/webhooks')
    initWebhookListener()
    initWebhookListener()
    expect(hooks.on).toHaveBeenCalledTimes(1)
    const listener = hooks.on.mock.calls[0][1]
    listener({ type: 'task.created', data: { id: 91, workspace_id: 1 },
      timestamp: 1, relayed: true })
    await Promise.resolve()
    expect(hooks.getDatabase).not.toHaveBeenCalled()
  })
})
