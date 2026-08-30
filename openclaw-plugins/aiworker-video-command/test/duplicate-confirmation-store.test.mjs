import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createDuplicateConfirmationStore, duplicateConfirmationScopeKey } from '../lib/duplicate-confirmation-store.js'

const temporaryDirectories = []

afterEach(() => {
  while (temporaryDirectories.length > 0) rmSync(temporaryDirectories.pop(), { recursive: true, force: true })
})

function storagePath() {
  const directory = mkdtempSync(join(tmpdir(), 'aiworker-duplicate-confirmation-'))
  temporaryDirectories.push(directory)
  return join(directory, 'state', 'duplicate-confirmations.json')
}

describe('duplicate confirmation store', () => {
  it('restores a pending operation across store instances', () => {
    let clock = 1_000
    const pathname = storagePath()
    const scopeKey = duplicateConfirmationScopeKey('agent:second-original:explicit:video-test')
    const operation = { kind: 'task', id: 'video-command-test', path: '/data/video.mov' }
    createDuplicateConfirmationStore({ now: () => clock, storagePath: pathname }).set(scopeKey, operation)

    const restored = createDuplicateConfirmationStore({ now: () => clock, storagePath: pathname })
    expect(restored.get(scopeKey)).toEqual(operation)
    expect(restored.take(scopeKey)).toEqual(operation)
    expect(createDuplicateConfirmationStore({ now: () => clock, storagePath: pathname }).get(scopeKey)).toBeNull()
    expect(JSON.parse(readFileSync(pathname, 'utf8')).entries).toEqual({})
    expect(statSync(pathname).mode & 0o777).toBe(0o600)
  })

  it('persists only the explicitly trusted task material identity field', () => {
    const pathname = storagePath()
    const scopeKey = duplicateConfirmationScopeKey('agent:second-original:explicit:material-id')
    const operation = {
      kind: 'task', id: 'video-command-test', path: '/data/video.mov',
      trustedExistingMaterialId: 'MATERIAL-EXISTING-001',
    }
    const store = createDuplicateConfirmationStore({ storagePath: pathname })
    store.set(scopeKey, operation)
    expect(createDuplicateConfirmationStore({ storagePath: pathname }).take(scopeKey)).toEqual(operation)

    for (const trustedExistingMaterialId of [null, 123, true, {}, [], ' MATERIAL-001 ']) {
      expect(() => store.set(scopeKey, {
        kind: 'task', id: 'video-command-test', path: '/data/video.mov', trustedExistingMaterialId,
      })).toThrow('valid confirmation scope and operation are required')
    }
    expect(() => store.set(scopeKey, {
      kind: 'task', id: 'video-command-test', path: '/data/video.mov',
      materialId: 'MATERIAL-MODEL-VISIBLE-001',
    })).toThrow('valid confirmation scope and operation are required')
  })

  it('expires persisted operations without returning them', () => {
    let clock = 1_000
    const pathname = storagePath()
    const scopeKey = duplicateConfirmationScopeKey('agent:second-original:explicit:expiry-test')
    const store = createDuplicateConfirmationStore({ now: () => clock, ttlMs: 100, storagePath: pathname })
    store.set(scopeKey, { kind: 'batch', id: 'video-batch-test', path: '/data/series' })

    clock = 1_100
    expect(createDuplicateConfirmationStore({ now: () => clock, ttlMs: 100, storagePath: pathname }).get(scopeKey)).toBeNull()
  })
})
