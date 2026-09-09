import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  inspectVideoExecutionAvailability,
  inspectVideoExecutionControlSnapshotSync,
} from '../lib/video-batch-state.mjs'

async function writeJson(pathname, value) {
  const source = `${JSON.stringify(value)}\n`
  await writeFile(pathname, source, { mode: 0o600 })
  return source
}

test('execution availability reports no worker without mutating queue controls', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-execution-empty-'))
  try {
    assert.deepEqual(await inspectVideoExecutionAvailability(root), {
      status: 'blocked',
      reason: 'worker_unavailable',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('ordinary and unverified guardian launch markers are never called maintenance', async t => {
  for (const fixture of [
    { name: 'ordinary', value: { pid: process.pid, createdAt: '2026-09-01T00:00:00.000Z' } },
    {
      name: 'guardian without owner',
      value: {
        schema: 'video-autoworker-worker-launch-guardian/v2',
        pid: process.pid,
        token: randomBytes(32).toString('hex'),
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    },
  ]) {
    await t.test(fixture.name, async () => {
      const root = await mkdtemp(join(tmpdir(), 'aiworker-execution-marker-'))
      const markerPath = join(root, '.worker-launch.lock')
      try {
        const source = await writeJson(markerPath, fixture.value)
        const result = await inspectVideoExecutionAvailability(root)
        assert.equal(result.status, 'unknown')
        assert.notEqual(result.reason, 'maintenance_guardian')
        assert.equal(await readFile(markerPath, 'utf8'), source)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})

test('only an exact guardian pair with a live owner reports maintenance blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-execution-guardian-'))
  const markerPath = join(root, '.worker-launch.lock')
  try {
    const markerValue = {
      schema: 'video-autoworker-worker-launch-guardian/v2',
      pid: process.pid,
      token: randomBytes(32).toString('hex'),
      createdAt: '2026-09-01T00:00:00.000Z',
    }
    const markerSource = await writeJson(markerPath, markerValue)
    const marker = await lstat(markerPath, { bigint: true })
    await writeJson(`${markerPath}.owner`, {
      schema: 'video-autoworker-worker-launch-guardian-owner/v1',
      pid: process.pid,
      createdAt: '2026-09-01T00:00:01.000Z',
      marker: {
        path: markerPath,
        dev: marker.dev.toString(),
        ino: marker.ino.toString(),
        tokenSha256: createHash('sha256').update(markerValue.token).digest('hex'),
        createdAt: markerValue.createdAt,
        sourceSha256: createHash('sha256').update(markerSource).digest('hex'),
      },
    })

    assert.deepEqual(await inspectVideoExecutionAvailability(root), {
      status: 'blocked',
      reason: 'maintenance_guardian',
    })
    const snapshot = inspectVideoExecutionControlSnapshotSync(root)
    assert.equal(snapshot.status, 'blocked')
    assert.equal(snapshot.reason, 'maintenance_guardian')
    assert.equal(snapshot.guardian.marker.path, markerPath)
    assert.equal(snapshot.guardian.marker.sourceSha256, createHash('sha256').update(markerSource).digest('hex'))
    assert.equal(snapshot.guardian.owner.pid, process.pid)
    assert.equal(snapshot.guardian.owner.alive, true)
    assert.deepEqual(snapshot.worker, { present: false })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a live exact global owner reports only that the worker is active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-execution-worker-'))
  try {
    await writeJson(join(root, '.global-video-worker.lock'), {
      pid: process.pid,
      token: randomUUID(),
      createdAt: '2026-09-01T00:00:00.000Z',
    })
    assert.deepEqual(await inspectVideoExecutionAvailability(root), {
      status: 'available',
      reason: 'worker_active',
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
