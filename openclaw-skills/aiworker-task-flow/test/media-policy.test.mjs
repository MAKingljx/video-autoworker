import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  assertMediaCapacity,
  configuredMediaFileLimit,
  estimateMediaWorkspaceBytes,
} from '../lib/media-policy.mjs'

test('hardware-aware mode has no baked-in file-size ceiling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-media-policy-'))
  try {
    const source = join(root, 'large.mp4')
    await writeFile(source, Buffer.alloc(1024))
    assert.equal(configuredMediaFileLimit({}), null)
    const admission = await assertMediaCapacity({
      sourcePath: source,
      destinationRoot: join(root, 'inbox'),
      environment: {},
    })
    assert.equal(admission.configuredLimit, null)
    assert.equal(admission.sourceBytes, 1024)
    assert.ok(admission.requiredBytes >= estimateMediaWorkspaceBytes(1024))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an explicit system override remains available without restoring a default cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-media-policy-limit-'))
  try {
    const source = join(root, 'video.mp4')
    await writeFile(source, Buffer.alloc(1024))
    await assert.rejects(
      assertMediaCapacity({
        sourcePath: source,
        destinationRoot: root,
        maxBytes: 512,
      }),
      /超过系统准入上限/u,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('capacity checks account for a physical staged copy on non-clone filesystems', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-media-policy-copy-'))
  try {
    await mkdir(join(root, 'inbox'))
    const source = join(root, 'video.mp4')
    await writeFile(source, Buffer.alloc(2048))
    const admission = await assertMediaCapacity({
      sourcePath: source,
      destinationRoot: join(root, 'inbox'),
      environment: {},
    })
    if (process.platform !== 'darwin') {
      assert.equal(admission.cloneExpected, false)
      assert.ok(admission.requiredBytes >= admission.sourceBytes + admission.workspaceReserveBytes)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
