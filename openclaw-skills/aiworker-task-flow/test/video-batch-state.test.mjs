import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import { searchVideoTaskStates } from '../lib/video-batch-state.mjs'

test('status search keeps distinct queued items from the same directory batch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-task-flow-search-'))
  try {
    const batchId = `video-batch-${'b'.repeat(64)}`
    await writeFile(join(root, `${'a'.repeat(64)}.json`), `${JSON.stringify({
      schemaVersion: 2,
      batchId,
      requestFingerprint: 'c'.repeat(64),
      status: 'running',
      updatedAt: '2026-08-16T00:00:00.000Z',
      items: [
        { index: 1, name: '地球之极 第三季 第三集.mp4', taskId: `${batchId}:video:001`, status: 'running' },
        { index: 2, name: '地球之极 第三季 第十一集.mp4', taskId: `${batchId}:video:002`, status: 'queued' },
      ],
    })}\n`, { mode: 0o600 })

    const result = await searchVideoTaskStates('地球之极 第三季', root)

    assert.equal(result.total, 2)
    assert.deepEqual(result.matches.map(item => ({
      batchId: item.batchId,
      index: item.index,
      status: item.status,
    })), [
      { batchId, index: 1, status: 'running' },
      { batchId, index: 2, status: 'queued' },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
