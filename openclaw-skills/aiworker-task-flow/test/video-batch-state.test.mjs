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
        {
          index: 1,
          name: '地球之极 第三季 第三集.mp4',
          taskId: `${batchId}:video:001`,
          status: 'succeeded',
          completedAt: '2026-08-16T00:00:01.000Z',
        },
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
      { batchId, index: 1, status: 'succeeded' },
      { batchId, index: 2, status: 'queued' },
    ])
    assert.equal(result.matches[0].completedAt, '2026-08-16T00:00:01.000Z')
    assert.equal(result.matches[0].updatedAt, '2026-08-16T00:00:00.000Z')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('status search treats ep4, ep04, and 第4集 as one canonical episode without matching ep40', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-task-flow-episode-search-'))
  try {
    const batchId = `video-batch-${'e'.repeat(64)}`
    await writeFile(join(root, `${'f'.repeat(64)}.json`), `${JSON.stringify({
      schemaVersion: 2,
      batchId,
      requestFingerprint: 'd'.repeat(64),
      status: 'queued',
      updatedAt: '2026-08-17T00:00:00.000Z',
      items: [
        { index: 1, name: '地球之极 S01E04.mp4', taskId: `${batchId}:video:001`, status: 'queued' },
        { index: 2, name: '地球之极 第1季 第40集.mp4', taskId: `${batchId}:video:002`, status: 'queued' },
      ],
    })}\n`, { mode: 0o600 })

    const ep4 = await searchVideoTaskStates('地球之极 s1e4', root)
    const ep04 = await searchVideoTaskStates('地球之极 ep04', root)
    const chinese = await searchVideoTaskStates('地球之极 第1季 第4集', root)

    for (const result of [ep4, ep04, chinese]) {
      assert.equal(result.total, 1)
      assert.equal(result.matches[0].index, 1)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
