import assert from 'node:assert/strict'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import {
  captureOpenClawRichCanarySessionSnapshot,
  loadOpenClawRichCanarySessionRuntime,
  openClawCheckpointPostReferenceMatchesSnapshot,
  openClawLinearActiveTranscriptEntryIds,
  openClawSessionReferenceMatchesSnapshot,
  openClawSessionMarkerMatchesSnapshot,
} from './lib/openclaw-rich-canary-session-runtime.mjs'

const roots = []

test.afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true })
})

function fixturePackage({ version = '2026.9.2', includeExport = true } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'openclaw-rich-canary-sdk-'))
  roots.push(parent)
  const root = join(parent, 'openclaw')
  const runtimePath = join(root, 'runtime.mjs')
  mkdirSync(root, { mode: 0o700 })
  writeFileSync(join(root, 'openclaw.mjs'), '#!/usr/bin/env node\n', { mode: 0o700 })
  writeFileSync(runtimePath, [
    'export const getSessionEntry = () => undefined',
    'export const formatSqliteSessionFileMarker = () => undefined',
    'export const loadTranscriptEventsSync = () => []',
    'export const parseSqliteSessionFileMarker = () => undefined',
    'export const readTranscriptStatsSync = () => ({ eventCount: 0, maxSeq: 0, sizeBytes: 0 })',
    'export const resolveStorePath = () => undefined',
    '',
  ].join('\n'), { mode: 0o600 })
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name: 'openclaw',
    version,
    type: 'module',
    exports: includeExport
      ? { './plugin-sdk/session-store-runtime': './runtime.mjs' }
      : { '.': './openclaw.mjs' },
  })}\n`, { mode: 0o600 })
  return { bin: join(root, 'openclaw.mjs'), root, runtimePath }
}

function binding(overrides = {}) {
  const agentId = 'second-original'
  const sessionId = 'session-1'
  const storePath = '/private/tmp/openclaw-rich-canary-sessions.sqlite'
  const marker = `sqlite:${agentId}:${sessionId}:${storePath}`
  return {
    runtime: {
      formatSqliteSessionFileMarker: value => (
        `sqlite:${value.agentId}:${value.sessionId}:${value.storePath}`
      ),
      getSessionEntry: () => ({ sessionId, updatedAt: 42 }),
      loadTranscriptEventsSync: () => [{ type: 'message', id: 'event-1', message: { role: 'user' } }],
      parseSqliteSessionFileMarker: value => value === marker
        ? { agentId, sessionId, storePath }
        : undefined,
      readTranscriptStatsSync: () => ({ eventCount: 1, maxSeq: 1, sizeBytes: 4096 }),
      resolveStorePath: () => storePath,
      ...overrides,
    },
  }
}

test('resolves only the declared public session-store runtime inside the OpenClaw package', async () => {
  const entry = fixturePackage()
  const loaded = await loadOpenClawRichCanarySessionRuntime({
    openclawBin: entry.bin,
    expectedVersion: '2026.9.2',
  })
  assert.equal(loaded.packageRoot, realpathSync(entry.root))
  assert.equal(loaded.packageVersion, '2026.9.2')
  assert.equal(loaded.modulePath, realpathSync(entry.runtimePath))
  assert.equal(typeof loaded.runtime.loadTranscriptEventsSync, 'function')
})

test('pins a PATH-resolved command to the verified executable', async () => {
  const entry = fixturePackage()
  const loaded = await loadOpenClawRichCanarySessionRuntime({
    openclawBin: 'openclaw.mjs',
    expectedVersion: '2026.9.2',
    pathEnv: entry.root,
  })
  assert.equal(loaded.openclawBin, realpathSync(entry.bin))
})

test('rejects a version mismatch and an undeclared public export', async () => {
  await assert.rejects(loadOpenClawRichCanarySessionRuntime({
    openclawBin: fixturePackage({ version: '2026.9.1' }).bin,
    expectedVersion: '2026.9.2',
  }), /package_version_invalid/u)
  await assert.rejects(loadOpenClawRichCanarySessionRuntime({
    openclawBin: fixturePackage({ includeExport: false }).bin,
    expectedVersion: '2026.9.2',
  }), /public_export_missing/u)
})

test('captures a storage-neutral SQLite session snapshot', () => {
  const value = captureOpenClawRichCanarySessionSnapshot(binding(), {
    agentId: 'second-original',
    env: { OPENCLAW_STATE_DIR: '/private/tmp/state' },
    sessionKey: 'agent:second-original:canary',
  })
  assert.equal(value.entry.sessionId, 'session-1')
  assert.deepEqual(value.marker, {
    agentId: 'second-original',
    sessionId: 'session-1',
    storePath: '/private/tmp/openclaw-rich-canary-sessions.sqlite',
  })
  assert.equal(value.events.length, 1)
  assert.deepEqual(value.identity, {
    agentId: 'second-original',
    sessionKey: 'agent:second-original:canary',
    sessionId: 'session-1',
    storePath: '/private/tmp/openclaw-rich-canary-sessions.sqlite',
  })
  assert.equal(value.sizeBytes, 4096)
  assert.equal(value.stats.sizeBytes, 4096)
  assert.equal(openClawSessionMarkerMatchesSnapshot(
    binding(), value.sessionFile, value,
  ), true)
  assert.equal(openClawSessionMarkerMatchesSnapshot(binding(), 'legacy.jsonl', value), false)
  assert.equal(openClawSessionReferenceMatchesSnapshot(
    binding(), 'agent:second-original:canary', value,
  ), true)
  assert.equal(openClawSessionReferenceMatchesSnapshot(
    binding(), 'agent:other:canary', value,
  ), false)
})

test('accepts only the official omitted SQLite checkpoint reference for in-place compaction', () => {
  const sdk = binding()
  const value = captureOpenClawRichCanarySessionSnapshot(sdk, {
    agentId: 'second-original',
    env: { OPENCLAW_STATE_DIR: '/private/tmp/state' },
    sessionKey: 'agent:second-original:canary',
  })
  assert.equal(openClawCheckpointPostReferenceMatchesSnapshot(
    sdk, undefined, value, 'in-place',
  ), true)
  assert.equal(openClawCheckpointPostReferenceMatchesSnapshot(
    sdk, value.sessionFile, value, 'in-place',
  ), true)
  assert.equal(openClawCheckpointPostReferenceMatchesSnapshot(
    sdk, value.identity.sessionKey, value, 'in-place',
  ), true)
  assert.equal(openClawCheckpointPostReferenceMatchesSnapshot(
    sdk, undefined, value, 'generation-rotation',
  ), false)
  assert.equal(openClawCheckpointPostReferenceMatchesSnapshot(
    sdk, value.sessionFile, value, 'generation-rotation',
  ), true)
})

test('rejects omitted non-SQLite and unsafe explicit checkpoint references', () => {
  const sdk = binding()
  const markerAwareSdk = binding({
    parseSqliteSessionFileMarker: input => {
      const match = /^sqlite:([^:]+):([^:]+):(.+)$/u.exec(input)
      return match
        ? { agentId: match[1], sessionId: match[2], storePath: match[3] }
        : undefined
    },
  })
  const value = captureOpenClawRichCanarySessionSnapshot(sdk, {
    agentId: 'second-original',
    env: { OPENCLAW_STATE_DIR: '/private/tmp/state' },
    sessionKey: 'agent:second-original:canary',
  })
  assert.equal(openClawCheckpointPostReferenceMatchesSnapshot(
    sdk, '/private/tmp/foreign.jsonl', value, 'in-place',
  ), false)
  for (const marker of [
    'sqlite:other-agent:session-1:/private/tmp/openclaw-rich-canary-sessions.sqlite',
    'sqlite:second-original:other-session:/private/tmp/openclaw-rich-canary-sessions.sqlite',
    'sqlite:second-original:session-1:/private/tmp/other.sqlite',
  ]) {
    assert.equal(openClawCheckpointPostReferenceMatchesSnapshot(
      markerAwareSdk, marker, value, 'in-place',
    ), false)
  }
  assert.equal(openClawCheckpointPostReferenceMatchesSnapshot(
    sdk, null, value, 'in-place',
  ), false)
  assert.equal(openClawCheckpointPostReferenceMatchesSnapshot(
    sdk, undefined, { ...value, sessionFile: '/private/tmp/legacy.jsonl' }, 'in-place',
  ), false)
  assert.equal(openClawCheckpointPostReferenceMatchesSnapshot(
    sdk,
    undefined,
    { ...value, identity: { ...value.identity, sessionId: 'other-session' } },
    'in-place',
  ), false)
  assert.equal(openClawCheckpointPostReferenceMatchesSnapshot(
    sdk, undefined, value, 'inconsistent',
  ), false)
})

test('requests the latest storage-neutral entry and transcript views', () => {
  const seen = []
  const value = captureOpenClawRichCanarySessionSnapshot(binding({
    getSessionEntry: params => {
      seen.push(params)
      return {
        sessionId: 'session-1',
      }
    },
    loadTranscriptEventsSync: params => {
      seen.push(params)
      return []
    },
    readTranscriptStatsSync: params => {
      seen.push(params)
      return { eventCount: 0, maxSeq: 0, sizeBytes: 0 }
    },
  }), {
    agentId: 'second-original',
    env: { OPENCLAW_STATE_DIR: '/private/tmp/state' },
    sessionKey: 'agent:second-original:canary',
  })
  assert.equal(value.events.length, 0)
  assert.equal(seen.length, 3)
  assert.equal(seen.every(params => params.readConsistency === 'latest'), true)
  assert.equal(seen.slice(1).every(params => (
    params.sessionId === 'session-1'
      && params.storePath === '/private/tmp/openclaw-rich-canary-sessions.sqlite'
  )), true)
})

test('fails closed on missing entries, invalid markers, event DTOs, and truncated stats', () => {
  const input = { agentId: 'second-original', sessionKey: 'agent:second-original:canary' }
  assert.throws(() => captureOpenClawRichCanarySessionSnapshot(binding({
    getSessionEntry: () => undefined,
  }), input), /session_entry_missing/u)
  assert.throws(() => captureOpenClawRichCanarySessionSnapshot(binding({
    parseSqliteSessionFileMarker: () => undefined,
  }), input), /session_marker_invalid/u)
  assert.throws(() => captureOpenClawRichCanarySessionSnapshot(binding({
    loadTranscriptEventsSync: () => [null],
  }), input), /transcript_events_invalid/u)
  assert.throws(() => captureOpenClawRichCanarySessionSnapshot(binding({
    readTranscriptStatsSync: () => ({ eventCount: 0, maxSeq: 0, sizeBytes: 1 }),
  }), input), /transcript_stats_invalid/u)
  assert.throws(() => captureOpenClawRichCanarySessionSnapshot(binding({
    readTranscriptStatsSync: () => ({ eventCount: 2, maxSeq: 2, sizeBytes: 1 }),
  }), input), /transcript_stats_invalid/u)
  assert.throws(() => captureOpenClawRichCanarySessionSnapshot(binding({
    resolveStorePath: () => 'relative.sqlite',
  }), input), /session_store_path_invalid/u)
})

test('derives one exact active parent chain and excludes a rewound suffix', () => {
  const active = openClawLinearActiveTranscriptEntryIds([
    { type: 'session', id: 'header' },
    { type: 'message', id: 'user-1', parentId: null },
    { type: 'message', id: 'assistant-old', parentId: 'user-1' },
    {
      type: 'leaf',
      id: 'leaf-control',
      parentId: 'assistant-old',
      targetId: 'user-1',
    },
    { type: 'message', id: 'assistant-current', parentId: 'leaf-control' },
  ])
  assert.deepEqual([...active], ['assistant-current', 'user-1'])
})

test('follows the current leaf and excludes abandoned and side-appended rows', () => {
  const active = openClawLinearActiveTranscriptEntryIds([
    { type: 'session', id: 'header' },
    { type: 'message', id: 'user-1', parentId: null },
    { type: 'message', id: 'assistant-1', parentId: 'user-1' },
    { type: 'custom', id: 'side-row', parentId: 'assistant-1', appendMode: 'side' },
    { type: 'message', id: 'user-2', parentId: 'side-row' },
  ])
  assert.deepEqual([...active], ['user-2', 'assistant-1', 'user-1'])
})

test('fails closed when a leaf control references an unknown transcript row', () => {
  assert.throws(() => openClawLinearActiveTranscriptEntryIds([
    { type: 'session', id: 'header' },
    { type: 'message', id: 'user-1', parentId: null },
    { type: 'leaf', id: 'leaf-control', parentId: 'user-1', targetId: 'missing' },
  ]), /transcript_branch_invalid/u)
})

test('rejects writable package metadata before resolving the SDK', async () => {
  const entry = fixturePackage()
  chmodSync(join(entry.root, 'package.json'), 0o622)
  await assert.rejects(loadOpenClawRichCanarySessionRuntime({
    openclawBin: entry.bin,
    expectedVersion: '2026.9.2',
  }), /package_identity_invalid/u)
})
