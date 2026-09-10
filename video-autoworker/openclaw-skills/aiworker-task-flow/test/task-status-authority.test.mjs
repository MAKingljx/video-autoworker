import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isTerminalTaskStatus,
  resolveAuthoritativeTaskRecord,
  selectAuthoritativeTaskRecord,
  toPublicDurableTaskStatus,
} from '../lib/task-status-authority.mjs'

test('platform terminal failure overrides a durable accepted record', () => {
  const selected = selectAuthoritativeTaskRecord({
    platformRecord: { taskId: 'video-1', status: 'failed' },
    durableRecord: { taskId: 'video-1', status: 'accepted' },
  })

  assert.equal(selected.source, 'platform')
  assert.equal(selected.record.status, 'failed')
  assert.equal(isTerminalTaskStatus(selected.record.status), true)
})

test('platform success overrides a durable running record', () => {
  const selected = selectAuthoritativeTaskRecord({
    platformRecord: { taskId: 'video-2', status: 'succeeded' },
    durableRecord: { taskId: 'video-2', status: 'running' },
  })

  assert.equal(selected.source, 'platform')
  assert.equal(selected.record.status, 'succeeded')
})

test('missing platform record uses the durable registry', () => {
  const selected = selectAuthoritativeTaskRecord({
    platformRecord: null,
    durableRecord: { taskId: 'video-3', status: 'queued' },
  })

  assert.equal(selected.source, 'durable')
  assert.equal(selected.record.status, 'queued')
})

test('temporarily unavailable platform falls back only when a durable record exists', async () => {
  const unavailable = new Error('platform unavailable')
  const selected = await resolveAuthoritativeTaskRecord({
    loadPlatformRecord: async () => { throw unavailable },
    loadDurableRecord: async () => ({ taskId: 'video-4', status: 'waiting' }),
    isPlatformUnavailable: error => error === unavailable,
  })

  assert.equal(selected.source, 'durable-fallback')
  assert.equal(toPublicDurableTaskStatus(selected.record.status), 'running')

  await assert.rejects(() => resolveAuthoritativeTaskRecord({
    loadPlatformRecord: async () => { throw unavailable },
    loadDurableRecord: async () => null,
    isPlatformUnavailable: () => true,
  }), unavailable)
})

test('authoritative platform record is loaded before and without touching durable state', async () => {
  let durableReads = 0
  const selected = await resolveAuthoritativeTaskRecord({
    loadPlatformRecord: async () => ({ taskId: 'video-5', status: 'failed' }),
    loadDurableRecord: async () => {
      durableReads += 1
      throw new Error('corrupt durable state')
    },
  })

  assert.equal(selected.source, 'platform')
  assert.equal(selected.record.status, 'failed')
  assert.equal(durableReads, 0)
})
