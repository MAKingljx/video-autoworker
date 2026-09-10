import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanupOwnedSyntheticSession } from './lib/openclaw-owned-synthetic-session.mjs'

const sessionKey = 'agent:second-original:codex-postdeploy-12345678-1234-4234-8234-123456789abc'
function fixture(extra = {}) {
  let entry = { sessionId: 'owned-session', updatedAt: 100, lifecycleRevision: 'revision-a' }
  const sent = []
  const options = {
    sessionKey, agentId: 'second-original', ownershipVerified: true,
    expectedSessionId: 'owned-session', readEntry: () => entry,
    deleteSession: params => { sent.push(params); entry = null; return { ok: true, key: sessionKey, deleted: true, archived: ['platform-owned-archive'] } },
    ...extra,
  }
  return { options, sent, setEntry: value => { entry = value } }
}
test('binds the exact created session and lifecycle without firing hooks, then proves absence', async () => {
  const f = fixture(); const result = await cleanupOwnedSyntheticSession(f.options)
  assert.deepEqual(f.sent, [{ key: sessionKey, agentId: 'second-original', deleteTranscript: true,
    expectedSessionId: 'owned-session', expectedSessionUpdatedAt: 100,
    expectedLifecycleRevision: 'revision-a', emitLifecycleHooks: false }])
  assert.equal(result.activeSessionAbsent, true); assert.equal(result.archivedTranscriptCount, 1)
})
test('never deletes an existing or unowned session', async () => {
  for (const extra of [{ ownershipVerified: false }, { sessionKey: 'agent:second-original:main' }, { agentId: 'someone-else' }]) {
    const f = fixture(extra); await assert.rejects(cleanupOwnedSyntheticSession(f.options), /ownership_invalid/); assert.equal(f.sent.length, 0)
  }
})
test('refuses identity drift before deletion', async () => {
  const f = fixture(); f.setEntry({ sessionId: 'replacement', updatedAt: 101 })
  await assert.rejects(cleanupOwnedSyntheticSession(f.options), /identity_changed/); assert.equal(f.sent.length, 0)
})
test('an absent owned session causes no repeated delete', async () => {
  const f = fixture(); f.setEntry(null); assert.equal((await cleanupOwnedSyntheticSession(f.options)).alreadyAbsent, true); assert.equal(f.sent.length, 0)
})
test('refuses a wrong deletion receipt even if the session disappeared', async () => {
  const f = fixture({ deleteSession: () => ({ ok: true, key: 'wrong', deleted: true, archived: [] }) })
  await assert.rejects(cleanupOwnedSyntheticSession(f.options), /receipt_invalid/)
})
test('requires a read after deletion and refuses a still-active session', async () => {
  const f = fixture({ deleteSession: () => ({ ok: true, key: sessionKey, deleted: true, archived: [] }) })
  await assert.rejects(cleanupOwnedSyntheticSession(f.options), /cleanup_incomplete/)
})
test('lost acknowledgement is resolved by absence without repeating the operation', async () => {
  let calls = 0; const f = fixture()
  f.options.deleteSession = () => { calls++; f.setEntry(null); throw new Error('response lost') }
  const result = await cleanupOwnedSyntheticSession(f.options)
  assert.equal(calls, 1); assert.equal(result.activeSessionAbsent, true); assert.equal(result.responseLost, true)
  assert.equal(result.archivedTranscriptCount, null)
})
