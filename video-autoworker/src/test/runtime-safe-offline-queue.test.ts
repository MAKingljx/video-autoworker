// @vitest-environment node
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectOfflineQueue, scanOfflineDurableBatchStates } from '../../scripts/lib/runtime-safe-offline-queue.mjs'

const roots: string[] = []
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const makeRoot = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'offline-queue-authority-')))
  chmodSync(root, 0o700); roots.push(root); return root
}
const name = `${'a'.repeat(64)}.json`
const journal = (taskId: string, phase = 'triggering') => ({
  schemaVersion: 1, phase, taskId, idempotencyKey: taskId, batchId: 'retained-batch',
  sourceIdentity: { dev: 1, ino: 2, size: 2_470_000_000, mtimeMs: 1, ctimeMs: 1 },
  incomingIdentity: null, stagedIdentity: { dev: 1, ino: 3, size: 2_470_000_000, mtimeMs: 2, ctimeMs: 2 },
  anchoredIdentity: null, contentSha256: 'b'.repeat(64), materialId: `MATERIAL-SHA256-${'b'.repeat(64)}`,
  ownershipToken: '00000000-0000-4000-8000-000000000001',
  anchorName: '.source-anchor-100-00000000-0000-4000-8000-000000000001',
  videoKey: '00000000-0000-4000-8000-000000000002.mp4',
  incomingName: '.incoming-100-00000000-0000-4000-8000-000000000002.mp4',
})
type Item = { taskId: string; status: string; stagingRecovery?: ReturnType<typeof journal> }
const state = (status: string, items: Item[]) => ({
  schemaVersion: 2, batchId: 'retained-batch', requestFingerprint: 'c'.repeat(64),
  bindingId: 1, baseUrl: 'http://127.0.0.1:3017', status, items,
})
const write = (root: string, value: unknown, backup = false) => {
  const pathname = join(root, name + (backup ? '.bak' : ''))
  writeFileSync(pathname, JSON.stringify(value) + '\n', { mode: 0o600 }); return pathname
}
const scan = (root: string) => {
  const result = scanOfflineDurableBatchStates(root, { includeEvidence: true })
  if (Array.isArray(result)) throw new Error('Expected a queue snapshot with evidence')
  return result
}
function guardian(root: string) {
  const markerPath = join(root, '.worker-launch.lock'), createdAt = new Date().toISOString(), token = 'd'.repeat(64)
  const source = JSON.stringify({ schema: 'video-autoworker-worker-launch-guardian/v2', pid: process.pid, token, createdAt }) + '\n'
  writeFileSync(markerPath, source, { mode: 0o600 })
  const marker = statSync(markerPath, { bigint: true })
  writeFileSync(`${markerPath}.owner`, JSON.stringify({ schema: 'video-autoworker-worker-launch-guardian-owner/v1',
    pid: process.pid, createdAt, marker: { path: markerPath, dev: String(marker.dev), ino: String(marker.ino),
      sourceSha256: digest(source), tokenSha256: digest(token), createdAt } }) + '\n', { mode: 0o600 })
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe('offline queue primary and backup authority', () => {
  it('preserves valid primary-only terminal snapshots without requiring a manufactured backup', () => {
    const root = makeRoot(); write(root, state('succeeded', [{ taskId: 'completed-task', status: 'succeeded' }]))
    const result = scan(root)
    expect(result.items).toEqual([])
    expect(result.snapshot.files).toHaveLength(1)
    expect(result.snapshot).toMatchObject({ activeJournals: 0, backupActiveJournals: 0 })
  })
  it('retains a paused 29-item attention batch without inventing waiting work from its older backup', () => {
    const root = makeRoot()
    const items = Array.from({ length: 29 }, (_, i) => ({ taskId: `task-${i + 1}`, status: 'attention' }))
    const primary = write(root, state('paused', items))
    const backup = write(root, state('running', items.map((item, index) => index === 7
      ? { ...item, status: 'staging', stagingRecovery: journal(item.taskId) } : item)), true)
    const before = [readFileSync(primary), readFileSync(backup)]
    const result = scan(root)
    expect(result.items).toEqual([])
    expect(projectOfflineQueue([], result.items, 1_800_000_000)).toMatchObject({ waiting: 0, running: 0 })
    expect(result.snapshot).toMatchObject({ activeJournals: 0, backupActiveJournals: 1,
      retainedAttentionBatches: [{ classification: 'retained-attention', batchId: 'retained-batch', itemCount: 29 }],
    })
    expect(result.snapshot.files).toHaveLength(2)
    expect([readFileSync(primary), readFileSync(backup)]).toEqual(before)
  })
  it('counts a real primary staging journal once while retaining its backup as separate evidence', () => {
    const root = makeRoot(), value = state('running', [{ taskId: 'task-8', status: 'staging', stagingRecovery: journal('task-8') }])
    write(root, value); write(root, value, true)
    const result = scan(root)
    expect(result.snapshot).toMatchObject({ activeJournals: 1, backupActiveJournals: 1, retainedAttentionBatches: [] })
    expect(result.items).toEqual([{ taskId: 'task-8', status: 'staging', origin: 'durable' }])
    expect(projectOfflineQueue([], result.items, 1_800_000_000).waiting).toBe(1)
  })
  it.each([
    ['empty paused', state('paused', [])],
    ['mixed attention and queued', state('paused', [{ taskId: 'a', status: 'attention' }, { taskId: 'b', status: 'queued' }])],
    ['running attention', state('running', [{ taskId: 'a', status: 'attention' }])],
    ['paused failed', state('paused', [{ taskId: 'a', status: 'failed' }])],
  ])('keeps %s conservative instead of treating it as retained attention', (_label, value) => {
    const root = makeRoot(); write(root, value)
    const result = scan(root)
    expect(result.snapshot.retainedAttentionBatches).toEqual([])
    expect(result.items.length).toBeGreaterThan(0)
  })
  it('allows a backup to lag phase but rejects a different batch identity', () => {
    const root = makeRoot(), value = state('running', [{ taskId: 'a', status: 'staging', stagingRecovery: journal('a') }])
    write(root, value); write(root, state('queued', [{ taskId: 'a', status: 'queued' }]), true)
    expect(scan(root).snapshot.activeJournals).toBe(1)
    write(root, { ...value, batchId: 'another-batch' }, true)
    expect(() => scan(root)).toThrow(/backup identity differs/u)
  })
  it('keeps an earlier backup task set as evidence under the same batch identity', () => {
    const root = makeRoot()
    write(root, state('queued', [{ taskId: 'current-task', status: 'queued' }]))
    write(root, state('running', [
      { taskId: 'older-task', status: 'staging', stagingRecovery: journal('older-task') },
      { taskId: 'current-task', status: 'queued' },
    ]), true)
    const result = scan(root)
    expect(result.items).toEqual([{ taskId: 'current-task', status: 'queued', origin: 'durable' }])
    expect(result.snapshot).toMatchObject({ activeJournals: 0, backupActiveJournals: 1 })
    expect(result.snapshot.files).toHaveLength(2)
    expect(projectOfflineQueue([], result.items, 1_800_000_000).waiting).toBe(1)
  })
  it.each(['primary', 'backup'] as const)('rejects corrupt %s even when all primary items are attention', target => {
    const root = makeRoot(), value = state('paused', [{ taskId: 'a', status: 'attention' }])
    write(root, value); write(root, value, true)
    writeFileSync(join(root, name + (target === 'backup' ? '.bak' : '')), '{broken')
    expect(() => scan(root)).toThrow(/video batch state/u)
  })
  it('refuses a paired state whose batch identity cannot be established', () => {
    const root = makeRoot(), value = { schemaVersion: 1, status: 'queued', items: [{ taskId: 'a', status: 'queued' }] }
    write(root, value); write(root, value, true)
    expect(() => scan(root)).toThrow(/backup identity differs/u)
  })
  it('rejects orphan, symlinked and writable backup evidence', () => {
    const root = makeRoot(), value = state('paused', [{ taskId: 'a', status: 'attention' }])
    const primary = write(root, value), backup = write(root, value, true)
    rmSync(primary); expect(() => scan(root)).toThrow(/no authoritative primary/u)
    write(root, value); rmSync(backup); symlinkSync(primary, backup)
    expect(() => scan(root)).toThrow(/unrecognized artifact/u)
    rmSync(backup); write(root, value, true); chmodSync(backup, 0o666)
    expect(() => scan(root)).toThrow(/mode is unsafe/u)
  })
  it.each(['primary', 'backup'] as const)('detects valid %s content drift between samples', target => {
    const root = makeRoot(), value = state('paused', [{ taskId: 'a', status: 'attention' }])
    write(root, value); write(root, value, true); guardian(root)
    let calls = 0
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (++calls === 2) write(root, { ...value, note: 'changed only after first snapshot' }, target === 'backup')
      return true
    })
    expect(() => scan(root)).toThrow(/changed between samples/u)
  })
  it('detects an identical-byte backup inode replacement during sampling', () => {
    const root = makeRoot(), value = state('paused', [{ taskId: 'a', status: 'attention' }])
    write(root, value); const backup = write(root, value, true); guardian(root)
    const inode = lstatSync(backup).ino; let calls = 0
    vi.spyOn(process, 'kill').mockImplementation(() => {
      if (++calls === 2) {
        const temporary = join(root, 'replacement')
        writeFileSync(temporary, readFileSync(backup), { mode: 0o600 }); renameSync(temporary, backup)
      }
      return true
    })
    expect(() => scan(root)).toThrow(/changed during projection|changed between samples/u)
    expect(lstatSync(backup).ino).not.toBe(inode)
  })
  it('rejects unknown item status instead of hiding it inside a paused batch', () => {
    const root = makeRoot(); write(root, state('paused', [{ taskId: 'a', status: 'unexpected' }]))
    expect(() => scan(root)).toThrow(/item contract is invalid/u)
  })
})
