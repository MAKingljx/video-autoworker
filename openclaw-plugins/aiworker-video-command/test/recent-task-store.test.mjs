import { describe, expect, it } from 'vitest'

import { createRecentTaskStore } from '../lib/recent-task-store.js'

const SCOPE_A = 'a'.repeat(64)
const SCOPE_B = 'b'.repeat(64)
const TASK_A = `video-natural-${'1'.repeat(64)}`
const TASK_B = `video-command-${'2'.repeat(64)}`

describe('recent task store', () => {
  it('keeps only a bounded, TTL-scoped in-memory hint', () => {
    let clock = 1_000
    const store = createRecentTaskStore({ now: () => clock, ttlMs: 100, maxEntries: 1 })

    store.set(SCOPE_A, TASK_A)
    expect(store.get(SCOPE_A)).toBe(TASK_A)

    store.set(SCOPE_B, TASK_B)
    expect(store.get(SCOPE_A)).toBeNull()
    expect(store.get(SCOPE_B)).toBe(TASK_B)

    clock += 101
    expect(store.get(SCOPE_B)).toBeNull()
  })

  it('rejects untrusted scope keys and non-plugin task ids', () => {
    const store = createRecentTaskStore()
    expect(() => store.set('raw-session', TASK_A)).toThrow()
    expect(() => store.set(SCOPE_A, 'task-1')).toThrow()
    expect(store.get('raw-session')).toBeNull()
  })
})
