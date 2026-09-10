import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, copyFile, link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  copyDarwinVideoFileFromAnchor,
  copyPhysicalVideoFile,
  deriveMaterialIdFromFile,
  normalizeMaterialId,
  StagedMediaCleanupError,
  stageVideoFile,
  inspectVideoFile,
} from '../lib/media-ingest.mjs'
import { buildVideoTaskPayload, submitStagedVideoTask, submitVideoTask } from '../lib/video-task.mjs'

function identityFromStat(details) {
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeMs: details.mtimeMs,
    ctimeMs: details.ctimeMs,
  }
}

test('video task payload stores only a safe display name and batch metadata', () => {
  const payload = buildVideoTaskPayload({
    bindingId: 2,
    taskId: 'batch-a:video:003:abcdef123456',
    idempotencyKey: 'batch-a:video:003:abcdef123456',
    prompt: '  深度分析视频  ',
    videoKey: '123e4567-e89b-42d3-a456-426614174000.mp4',
    materialId: 'MATERIAL-EXISTING-001',
    displayName: '/Users/operator/private/S03E03.mp4',
    batchId: 'batch-a',
    batchIndex: 3,
    visionRoute: 'local-qwen38-vl-direct',
    directorWork: '地球之极',
  })

  assert.deepEqual(payload.input, {
    prompt: '深度分析视频',
    videoKey: '123e4567-e89b-42d3-a456-426614174000.mp4',
    materialId: 'MATERIAL-EXISTING-001',
    displayName: 'S03E03.mp4',
    batchId: 'batch-a',
    batchIndex: 3,
  })
  assert.equal(JSON.stringify(payload).includes('/Users/operator/private'), false)
  assert.equal(payload.directorWork, '地球之极')
  assert.deepEqual(payload.routing, {
    nodes: { vision: { routeId: 'local-qwen38-vl-direct', fallbackRouteIds: [] } },
  })
})

test('reuses an existing material ID and derives a stable content ID when none exists', async () => {
  assert.equal(normalizeMaterialId(' MATERIAL-EXISTING-001 '), 'MATERIAL-EXISTING-001')
  assert.throws(() => normalizeMaterialId('/private/source/video.mp4'), /素材稳定标识无效/u)
  assert.throws(() => normalizeMaterialId(123), /素材稳定标识无效/u)
  assert.throws(() => normalizeMaterialId(true), /素材稳定标识无效/u)

  const root = await mkdtemp(join(tmpdir(), 'aiworker-material-id-'))
  try {
    const first = join(root, 'first.mp4')
    const second = join(root, 'second.mov')
    const changed = join(root, 'changed.mp4')
    await writeFile(first, 'same-video-content')
    await writeFile(second, 'same-video-content')
    await writeFile(changed, 'changed-video-content')

    const firstId = await deriveMaterialIdFromFile(first)
    assert.match(firstId, /^MATERIAL-SHA256-[0-9a-f]{64}$/u)
    assert.equal(await deriveMaterialIdFromFile(second), firstId)
    assert.notEqual(await deriveMaterialIdFromFile(changed), firstId)
    const staged = await stageVideoFile(first, { inboxRoot: join(root, 'inbox') })
    assert.equal(staged.materialId, await deriveMaterialIdFromFile(staged.stagedPath))
    assert.equal(staged.materialId, firstId)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('staging liveness reveals no media details and cleans an already-staged inbox copy on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-material-hash-cleanup-'))
  try {
    const videoFile = join(root, 'private-source-name.mp4')
    const inboxRoot = join(root, 'inbox')
    await writeFile(videoFile, 'content-that-must-not-be-left-in-the-inbox')
    const progressArguments = []

    await assert.rejects(stageVideoFile(videoFile, {
      inboxRoot,
      stagingBinding: {
        taskId: 'staging-failure-task',
        idempotencyKey: 'staging-failure-task',
        batchId: 'staging-failure-batch',
      },
      async onHashProgress(...args) {
        progressArguments.push(args)
        if (progressArguments.length === 2) {
          assert.equal((await readdir(inboxRoot)).length, 1)
          throw new Error('simulated_hash_interruption')
        }
      },
    }), /simulated_hash_interruption/u)

    assert.deepEqual(progressArguments, [[], []])
    assert.deepEqual(await readdir(inboxRoot), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('durable staging journals the destination inode before writing media bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-prewrite-journal-'))
  try {
    const videoFile = join(root, 'source.mp4')
    const inboxRoot = join(root, 'inbox')
    await writeFile(videoFile, 'durable-prewrite-identity')
    let prepared
    const staged = await stageVideoFile(videoFile, {
      inboxRoot,
      stagingBinding: {
        taskId: 'prewrite-task',
        idempotencyKey: 'prewrite-task',
        batchId: 'prewrite-batch',
      },
      async onStagingPrepared(recovery) {
        prepared = recovery
        assert.equal(recovery.incomingIdentity.size, 0)
      },
    })
    assert.ok(prepared)
    assert.equal(prepared.incomingIdentity.dev, staged.stagedIdentity.dev)
    assert.equal(prepared.incomingIdentity.ino, staged.stagedIdentity.ino)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('staging failure after source identity persistence journals cleanup before removing incoming media', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-source-identity-cleanup-'))
  try {
    const videoFile = join(root, 'source.mp4')
    const inboxRoot = join(root, 'inbox')
    const lifecycle = []
    await writeFile(videoFile, 'source-finalized-before-hash')
    await assert.rejects(stageVideoFile(videoFile, {
      inboxRoot,
      stagingBinding: {
        taskId: 'source-finalized-task',
        idempotencyKey: 'source-finalized-task',
        batchId: 'source-finalized-batch',
      },
      async onStagingPrepared() { lifecycle.push('prepared') },
      async onSourceIdentityFinalized() {
        lifecycle.push('source_finalized')
        throw new Error('persisted_then_interrupted')
      },
      async onStagingCleanupStarted() { lifecycle.push('discarding') },
      async onStagingSettled() { lifecycle.push('settled') },
    }), /persisted_then_interrupted/u)
    assert.deepEqual(lifecycle, ['prepared', 'source_finalized', 'discarding', 'settled'])
    assert.deepEqual(await readdir(inboxRoot), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('durable staging avoids the source-anchor cleanup crash window', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-anchor-cleanup-journal-'))
  try {
    const videoFile = join(root, 'source.mp4')
    const inboxRoot = join(root, 'inbox')
    const lifecycle = []
    let recovery
    let removalCalls = 0
    await writeFile(videoFile, 'anchor-cleanup-must-retry')
    const staged = await stageVideoFile(videoFile, {
      inboxRoot,
      stagingBinding: {
        taskId: 'anchor-cleanup-task',
        idempotencyKey: 'anchor-cleanup-task',
        batchId: 'anchor-cleanup-batch',
      },
      async onStagingPrepared(value) {
        recovery = value
        lifecycle.push('prepared')
      },
      async onStagingCleanupStarted() { lifecycle.push('discarding') },
      async onStagingSettled() { lifecycle.push('settled') },
      async removeSourceAnchorImpl() {
        removalCalls += 1
        throw new Error('durable_path_must_not_create_source_anchor')
      },
    })
    assert.deepEqual(lifecycle, ['prepared'])
    assert.equal(removalCalls, 0)
    assert.ok(recovery)
    assert.deepEqual(await readdir(inboxRoot), [staged.videoKey])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('physical staging rejects a source whose identity changes during copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-physical-source-drift-'))
  try {
    const source = join(root, 'source.mp4')
    const staged = join(root, 'staged.mp4')
    await writeFile(source, 'original-video')

    await assert.rejects(copyPhysicalVideoFile(source, staged, {
      async copyFileImpl(sourceHandlePath, stagedPath, mode) {
        await copyFile(sourceHandlePath, stagedPath, mode)
        await rm(source)
        await writeFile(source, 'replaced-video')
      },
    }), /视频源文件在收件期间发生变化/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('physical staging copies the admitted inode when a replacement is swapped in and back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-physical-source-swap-back-'))
  try {
    const source = join(root, 'source.mp4')
    const admitted = join(root, 'admitted.mp4')
    const replacement = join(root, 'replacement.mp4')
    const swapped = join(root, 'swapped.mp4')
    const staged = join(root, 'staged.mp4')
    await writeFile(source, 'admitted-video-content')
    await writeFile(replacement, 'replacement-video-data')

    await assert.rejects(copyPhysicalVideoFile(source, staged, {
      async copyFileImpl(sourceHandlePath, stagedPath, mode) {
        await rename(source, admitted)
        await rename(replacement, source)
        await copyFile(sourceHandlePath, stagedPath, mode)
        await rename(source, swapped)
        await rename(admitted, source)
      },
    }), /视频源文件在收件期间发生变化/u)

    assert.equal(await readFile(staged, 'utf8'), 'admitted-video-content')
    assert.equal(await readFile(source, 'utf8'), 'admitted-video-content')
    assert.equal(await readFile(swapped, 'utf8'), 'replacement-video-data')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Darwin clone and cp fallback both copy from the descriptor-verified anchor', {
  skip: process.platform !== 'darwin',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-darwin-fd-copy-'))
  const source = join(root, 'source.mp4')
  const anchor = join(root, '.source-anchor-test')
  const clone = join(root, 'clone.mp4')
  const fallback = join(root, 'fallback.mp4')
  await writeFile(source, 'darwin-descriptor-bound-video')
  await link(source, anchor)
  const sourceHandle = await open(source, 'r')
  try {
    await copyDarwinVideoFileFromAnchor(anchor, clone)
    await copyDarwinVideoFileFromAnchor(anchor, fallback, {
      async copyFileImpl() {
        const error = new Error('force cp fallback')
        error.code = 'ENOTSUP'
        throw error
      },
    })
    assert.equal(await readFile(clone, 'utf8'), 'darwin-descriptor-bound-video')
    assert.equal(await readFile(fallback, 'utf8'), 'darwin-descriptor-bound-video')
    assert.equal((await sourceHandle.stat()).ino, (await stat(anchor)).ino)
  } finally {
    await sourceHandle.close()
    await rm(root, { recursive: true, force: true })
  }
})

test('Darwin staging checkpoints the exact post-link identity before copying', {
  skip: process.platform !== 'darwin',
}, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-darwin-anchor-checkpoint-'))
  try {
    const source = join(root, 'source.mp4')
    const inboxRoot = join(root, 'inbox')
    await writeFile(source, 'darwin-anchor-checkpoint-video')
    const admittedIdentity = identityFromStat(await stat(source))
    let checkpointIdentity = null
    let anchorObserved = false
    await stageVideoFile(source, {
      inboxRoot,
      async onSourceAnchorCreated(identity) {
        checkpointIdentity = identity
        const names = await readdir(inboxRoot)
        const anchorName = names.find(name => name.startsWith('.source-anchor-'))
        assert.ok(anchorName)
        const [sourceStat, anchorStat] = await Promise.all([
          stat(source),
          stat(join(inboxRoot, anchorName)),
        ])
        assert.deepEqual(identity, identityFromStat(sourceStat))
        assert.equal(anchorStat.ino, sourceStat.ino)
        assert.equal(anchorStat.ctimeMs, sourceStat.ctimeMs)
        anchorObserved = true
      },
    })
    assert.equal(anchorObserved, true)
    assert.ok(checkpointIdentity)
    assert.notEqual(checkpointIdentity.ctimeMs, admittedIdentity.ctimeMs)
    assert.equal((await readdir(inboxRoot)).some(name => name.startsWith('.source-anchor-')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('staging rejects a same-size atomic source replacement after admission and before copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-admission-source-drift-'))
  try {
    const source = join(root, 'source.mp4')
    const replacement = join(root, 'replacement.mp4')
    const inboxRoot = join(root, 'inbox')
    await writeFile(source, 'original-video')
    await writeFile(replacement, 'replaced-video')
    let replaced = false

    await assert.rejects(stageVideoFile(source, {
      inboxRoot,
      async onHashProgress() {
        if (replaced) return
        replaced = true
        await rename(replacement, source)
      },
    }), /视频源文件在收件期间发生变化/u)

    assert.equal(replaced, true)
    assert.deepEqual(await readdir(inboxRoot), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('an externally admitted identity is carried into the descriptor open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-carried-admission-'))
  try {
    const source = join(root, 'source.mp4')
    const replacement = join(root, 'replacement.mp4')
    const inboxRoot = join(root, 'inbox')
    await writeFile(source, 'original-video')
    await writeFile(replacement, 'replaced-video')
    const admitted = await inspectVideoFile(source)
    await rename(replacement, source)

    await assert.rejects(stageVideoFile(source, {
      inboxRoot,
      expectedSourceIdentity: admitted.sourceIdentity,
    }), /视频源文件在收件期间发生变化/u)
    assert.deepEqual(await readdir(inboxRoot), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('the next staging run removes dead-process anchor and incoming orphans only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-staging-orphan-recovery-'))
  try {
    const source = join(root, 'source.mp4')
    const orphanSource = join(root, 'orphan-source.mp4')
    const inboxRoot = join(root, 'inbox')
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(source, 'new-video')
    await writeFile(orphanSource, 'orphan-video')
    const sourceMode = (await stat(orphanSource)).mode & 0o777
    const deadPid = 2_147_483_646
    const orphanAnchor = join(inboxRoot, `.source-anchor-${deadPid}-00000000-0000-4000-8000-000000000000`)
    const orphanIncoming = join(inboxRoot, `.incoming-${deadPid}-00000000-0000-4000-8000-000000000000.mp4`)
    await link(orphanSource, orphanAnchor)
    await writeFile(orphanIncoming, 'partial-copy')

    const staged = await stageVideoFile(source, { inboxRoot })
    assert.deepEqual(await readdir(inboxRoot), [staged.videoKey])
    assert.equal((await stat(orphanSource)).mode & 0o777, sourceMode)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('trusted existing material IDs still receive private lifecycle heartbeats', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-existing-material-heartbeat-'))
  try {
    const videoFile = join(root, 'private-existing-source.mp4')
    const inboxRoot = join(root, 'inbox')
    const progressArguments = []
    await writeFile(videoFile, 'trusted-existing-material-content')
    const sourceMode = (await stat(videoFile)).mode & 0o777

    const staged = await stageVideoFile(videoFile, {
      inboxRoot,
      trustedExistingMaterialId: 'MATERIAL-EXISTING-HEARTBEAT-001',
      onHashProgress(...args) {
        progressArguments.push(args)
      },
    })

    assert.equal(staged.materialId, 'MATERIAL-EXISTING-HEARTBEAT-001')
    assert.deepEqual(progressArguments, [[], []])
    assert.equal((await stat(videoFile)).mode & 0o777, sourceMode)
    assert.deepEqual(await readdir(inboxRoot), [staged.videoKey])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('legacy materialId injection fails closed at staging and submission boundaries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-untrusted-material-id-'))
  try {
    const videoFile = join(root, 'source.mp4')
    const inboxRoot = join(root, 'inbox')
    await writeFile(videoFile, 'untrusted-material-id-content')

    await assert.rejects(stageVideoFile(videoFile, {
      inboxRoot,
      materialId: 'MATERIAL-UNTRUSTED-001',
    }), /untrusted_material_id_field/u)
    await assert.rejects(submitVideoTask({
      client: { async trigger() { throw new Error('must_not_trigger') } },
      bindingId: 2,
      taskId: 'untrusted-material-id-task',
      idempotencyKey: 'untrusted-material-id-task',
      prompt: '分析视频',
      videoFile,
      inboxRoot,
      materialId: 'MATERIAL-UNTRUSTED-001',
    }), /untrusted_material_id_field/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanup failures preserve the business error and expose only a controlled orphan identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-staged-cleanup-failure-'))
  try {
    const videoFile = join(root, 'private-cleanup-source.mp4')
    const inboxRoot = join(root, 'inbox')
    await writeFile(videoFile, 'cleanup-failure-content')
    let orphanedVideoKey

    await assert.rejects(stageVideoFile(videoFile, {
      inboxRoot,
      async onHashProgress() {
        if (orphanedVideoKey) return
        const entries = await readdir(inboxRoot)
        if (!entries.length) return
        orphanedVideoKey = entries[0]
        const stagedPath = join(inboxRoot, orphanedVideoKey)
        await rm(stagedPath)
        await mkdir(stagedPath)
        await writeFile(join(stagedPath, 'sentinel'), 'keep cleanup failing')
        throw new Error('original_staging_failure:/private/original/source.mp4')
      },
    }), error => {
      assert.ok(error instanceof StagedMediaCleanupError)
      assert.equal(error.code, 'ESTAGEDCLEANUP')
      assert.equal(error.cause?.message, 'original_staging_failure:/private/original/source.mp4')
      assert.equal(error.orphanedVideoKey, orphanedVideoKey)
      assert.equal(error.message, 'staged_media_cleanup_failed')
      assert.equal(error.message.includes('original_staging_failure'), false)
      assert.equal(error.message.includes('/private/original/source.mp4'), false)
      assert.equal(error.message.includes(videoFile), false)
      assert.equal(error.message.includes('private-cleanup-source.mp4'), false)
      return true
    })

    assert.deepEqual(await readdir(inboxRoot), [orphanedVideoKey])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('trigger failure cleanup keeps the trigger error as the controlled orphan cause', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-trigger-cleanup-failure-'))
  try {
    const videoFile = join(root, 'private-trigger-source.mp4')
    const inboxRoot = join(root, 'inbox')
    await writeFile(videoFile, 'trigger-cleanup-failure-content')

    await assert.rejects(submitVideoTask({
      client: {
        async trigger(payload) {
          const stagedPath = join(inboxRoot, payload.input.videoKey)
          await rm(stagedPath)
          await mkdir(stagedPath)
          await writeFile(join(stagedPath, 'sentinel'), 'keep trigger cleanup failing')
          const error = new Error('original_trigger_failure')
          error.status = 400
          throw error
        },
        async getRun() {
          return null
        },
      },
      bindingId: 2,
      taskId: 'trigger-cleanup-task',
      idempotencyKey: 'trigger-cleanup-task',
      prompt: '分析视频',
      videoFile,
      inboxRoot,
    }), error => {
      assert.ok(error instanceof StagedMediaCleanupError)
      assert.equal(error.cause?.message, 'original_trigger_failure')
      assert.equal(error.message, 'staged_media_cleanup_failed')
      assert.equal(error.message.includes('original_trigger_failure'), false)
      assert.equal(error.message.includes(videoFile), false)
      return true
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('stage to submit to trigger preserves the provided material ID instead of replacing it with a hash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-material-trigger-'))
  try {
    const videoFile = join(root, 'source.mp4')
    const inboxRoot = join(root, 'inbox')
    const materialId = 'MATERIAL-EXISTING-TRIGGER-001'
    await writeFile(videoFile, 'content-whose-hash-must-not-become-the-material-id')
    let triggeredPayload
    const response = await submitVideoTask({
      client: {
        async trigger(payload) {
          triggeredPayload = payload
          return { taskId: 'task-1', status: 'accepted', duplicate: false }
        },
      },
      bindingId: 2,
      taskId: 'task-1',
      idempotencyKey: 'task-1',
      prompt: '分析视频',
      videoFile,
      displayName: 'source.mp4',
      inboxRoot,
      trustedExistingMaterialId: materialId,
    })

    assert.equal(response.status, 'accepted')
    assert.equal(triggeredPayload.input.materialId, materialId)
    assert.notEqual(triggeredPayload.input.materialId, await deriveMaterialIdFromFile(videoFile))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('platform-confirmed active ownership keeps the journal until the run is terminal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-platform-handoff-'))
  try {
    const sourcePath = join(root, 'source.mp4')
    const stagedPath = join(root, '00000000-0000-4000-8000-000000000010.mp4')
    await writeFile(sourcePath, 'platform-owned-video')
    await writeFile(stagedPath, 'platform-owned-video')
    const stagedIdentity = identityFromStat(await stat(stagedPath))
    const staged = {
      sourcePath,
      sourceBytes: 20,
      videoKey: '00000000-0000-4000-8000-000000000010.mp4',
      materialId: 'MATERIAL-EXISTING-010',
      stagedPath,
      inbox: root,
      stagedIdentity,
      contentSha256: createHash('sha256').update('platform-owned-video').digest('hex'),
      ownershipToken: '00000000-0000-4000-8000-000000000010',
      taskId: 'task-10',
      idempotencyKey: 'task-10',
      batchId: '',
    }
    const lifecycle = []
    const response = await submitStagedVideoTask({
      client: {
        async trigger() {
          return { taskId: 'task-10', status: 'accepted', duplicate: false }
        },
      },
      bindingId: 7,
      taskId: 'task-10',
      idempotencyKey: 'task-10',
      prompt: '分析视频',
      async onTriggerStarted() { lifecycle.push('triggering') },
      async onLocalCleanupStarted() { lifecycle.push('discarding') },
      async onMediaSettled() { lifecycle.push('settled') },
    }, staged)
    assert.equal(response.status, 'accepted')
    assert.deepEqual(lifecycle, ['triggering'])
    assert.equal(await readFile(stagedPath, 'utf8'), 'platform-owned-video')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('confirmed trigger failure marks local cleanup before deleting and settling staged media', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-trigger-failure-lifecycle-'))
  try {
    const sourcePath = join(root, 'source.mp4')
    const stagedPath = join(root, '00000000-0000-4000-8000-000000000011.mp4')
    await writeFile(sourcePath, 'locally-owned-video')
    await writeFile(stagedPath, 'locally-owned-video')
    const stagedIdentity = identityFromStat(await stat(stagedPath))
    const staged = {
      sourcePath,
      sourceBytes: 19,
      videoKey: '00000000-0000-4000-8000-000000000011.mp4',
      materialId: 'MATERIAL-EXISTING-011',
      stagedPath,
      inbox: root,
      stagedIdentity,
      contentSha256: createHash('sha256').update('locally-owned-video').digest('hex'),
      ownershipToken: '00000000-0000-4000-8000-000000000011',
      taskId: 'task-11',
      idempotencyKey: 'task-11',
      batchId: '',
    }
    const lifecycle = []
    await assert.rejects(submitStagedVideoTask({
      client: {
        async trigger() {
          const error = new Error('trigger_failed')
          error.status = 400
          throw error
        },
        async getRun() { return null },
      },
      bindingId: 7,
      taskId: 'task-11',
      idempotencyKey: 'task-11',
      prompt: '分析视频',
      async onTriggerStarted() { lifecycle.push('triggering') },
      async onLocalCleanupStarted() { lifecycle.push('discarding') },
      async onMediaSettled() { lifecycle.push('settled') },
    }, staged), /trigger_failed/u)
    assert.deepEqual(lifecycle, ['triggering', 'discarding', 'settled'])
    await assert.rejects(stat(stagedPath), error => error?.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('retryable trigger failure with no authoritative run preserves the same staged handoff', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-trigger-unconfirmed-'))
  try {
    const videoKey = '00000000-0000-4000-8000-000000000012.mp4'
    const stagedPath = join(root, videoKey)
    const content = 'retryable-unconfirmed-video'
    await writeFile(stagedPath, content)
    const staged = {
      sourcePath: join(root, 'source.mp4'),
      sourceBytes: Buffer.byteLength(content),
      videoKey,
      materialId: 'MATERIAL-EXISTING-012',
      stagedPath,
      inbox: root,
      stagedIdentity: identityFromStat(await stat(stagedPath)),
      contentSha256: createHash('sha256').update(content).digest('hex'),
      ownershipToken: '00000000-0000-4000-8000-000000000012',
      taskId: 'task-12',
      idempotencyKey: 'task-12',
      batchId: '',
    }
    const lifecycle = []
    await assert.rejects(submitStagedVideoTask({
      client: {
        async trigger() {
          const error = new Error('retryable_trigger_failed')
          error.status = 503
          throw error
        },
        async getRun() { return null },
      },
      bindingId: 7,
      taskId: 'task-12',
      idempotencyKey: 'task-12',
      prompt: '分析视频',
      async onTriggerStarted() { lifecycle.push('triggering') },
      async onLocalCleanupStarted() { lifecycle.push('discarding') },
      async onMediaSettled() { lifecycle.push('settled') },
    }, staged), /retryable_trigger_failed/u)
    assert.deepEqual(lifecycle, ['triggering'])
    assert.equal(await readFile(stagedPath, 'utf8'), content)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('empty and malformed 2xx trigger responses remain unconfirmed without deleting media', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-empty-trigger-response-'))
  try {
    for (const [index, triggerResponse] of [null, {}, [], { taskId: 'wrong-task', status: 'accepted' }].entries()) {
      const token = `00000000-0000-4000-8000-00000000002${index}`
      const videoKey = `${token}.mp4`
      const stagedPath = join(root, videoKey)
      const content = `unconfirmed-response-${index}`
      await writeFile(stagedPath, content)
      const staged = {
        sourcePath: join(root, `source-${index}.mp4`),
        sourceBytes: Buffer.byteLength(content),
        videoKey,
        materialId: `MATERIAL-UNCONFIRMED-${index}`,
        stagedPath,
        inbox: root,
        stagedIdentity: identityFromStat(await stat(stagedPath)),
        contentSha256: createHash('sha256').update(content).digest('hex'),
        ownershipToken: token,
        taskId: `task-empty-${index}`,
        idempotencyKey: `task-empty-${index}`,
        batchId: '',
      }
      const lifecycle = []
      let getRunCalls = 0
      await assert.rejects(submitStagedVideoTask({
        client: {
          async trigger() { return triggerResponse },
          async getRun(taskId) {
            assert.equal(taskId, staged.taskId)
            getRunCalls += 1
            return null
          },
        },
        bindingId: 7,
        taskId: staged.taskId,
        idempotencyKey: staged.idempotencyKey,
        prompt: '分析视频',
        async onTriggerStarted() { lifecycle.push('triggering') },
        async onLocalCleanupStarted() { lifecycle.push('discarding') },
        async onMediaSettled() { lifecycle.push('settled') },
      }, staged), /video_trigger_unconfirmed/u)
      assert.equal(getRunCalls, 1)
      assert.deepEqual(lifecycle, ['triggering'])
      assert.equal(await readFile(stagedPath, 'utf8'), content)
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('empty 2xx trigger response settles only after exact run ownership is confirmed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-empty-trigger-recovered-'))
  try {
    const videoKey = '00000000-0000-4000-8000-000000000029.mp4'
    const stagedPath = join(root, videoKey)
    const content = 'recovered-empty-response'
    await writeFile(stagedPath, content)
    const staged = {
      sourcePath: join(root, 'source.mp4'),
      sourceBytes: Buffer.byteLength(content),
      videoKey,
      materialId: 'MATERIAL-RECOVERED-EMPTY',
      stagedPath,
      inbox: root,
      stagedIdentity: identityFromStat(await stat(stagedPath)),
      contentSha256: createHash('sha256').update(content).digest('hex'),
      ownershipToken: '00000000-0000-4000-8000-000000000029',
      taskId: 'task-empty-recovered',
      idempotencyKey: 'task-empty-recovered',
      batchId: '',
    }
    const lifecycle = []
    const response = await submitStagedVideoTask({
      client: {
        async trigger() { return null },
        async getRun() {
          return { taskId: staged.taskId, status: 'accepted', input: { videoKey } }
        },
      },
      bindingId: 7,
      taskId: staged.taskId,
      idempotencyKey: staged.idempotencyKey,
      prompt: '分析视频',
      async onTriggerStarted() { lifecycle.push('triggering') },
      async onLocalCleanupStarted() { lifecycle.push('discarding') },
      async onMediaSettled() { lifecycle.push('settled') },
    }, staged)
    assert.equal(response.recoveredAfterMalformedResponse, true)
    assert.deepEqual(lifecycle, ['triggering'])
    assert.equal(await readFile(stagedPath, 'utf8'), content)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('duplicate cleanup requires an authoritative different video key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-duplicate-video-key-'))
  try {
    const runCase = async ({ taskId, videoKey, authoritativeVideoKey }) => {
      const content = `duplicate-${taskId}`
      const stagedPath = join(root, videoKey)
      await writeFile(stagedPath, content)
      const staged = {
        sourcePath: join(root, `${taskId}.mp4`),
        sourceBytes: Buffer.byteLength(content),
        videoKey,
        materialId: `MATERIAL-${taskId.toUpperCase()}`,
        stagedPath,
        inbox: root,
        stagedIdentity: identityFromStat(await stat(stagedPath)),
        contentSha256: createHash('sha256').update(content).digest('hex'),
        ownershipToken: videoKey.slice(0, 36),
        taskId,
        idempotencyKey: taskId,
        batchId: '',
      }
      const lifecycle = []
      await submitStagedVideoTask({
        client: {
          async trigger() { return { taskId, status: 'accepted', duplicate: true } },
          async getRun() {
            return { taskId, status: 'accepted', input: { videoKey: authoritativeVideoKey } }
          },
        },
        bindingId: 7,
        taskId,
        idempotencyKey: taskId,
        prompt: '分析视频',
        async onTriggerStarted() { lifecycle.push('triggering') },
        async onLocalCleanupStarted() { lifecycle.push('discarding') },
        async onMediaSettled() { lifecycle.push('settled') },
      }, staged)
      return { content, lifecycle, stagedPath }
    }

    const same = await runCase({
      taskId: 'task-same',
      videoKey: '00000000-0000-4000-8000-000000000013.mp4',
      authoritativeVideoKey: '00000000-0000-4000-8000-000000000013.mp4',
    })
    assert.deepEqual(same.lifecycle, ['triggering'])
    assert.equal(await readFile(same.stagedPath, 'utf8'), same.content)

    const different = await runCase({
      taskId: 'task-different',
      videoKey: '00000000-0000-4000-8000-000000000014.mp4',
      authoritativeVideoKey: '00000000-0000-4000-8000-000000000099.mp4',
    })
    assert.deepEqual(different.lifecycle, ['triggering', 'discarding', 'settled'])
    await assert.rejects(stat(different.stagedPath), error => error?.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('duplicate with no authoritative video key preserves the triggering journal and media', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-duplicate-unconfirmed-'))
  try {
    const videoKey = '00000000-0000-4000-8000-000000000016.mp4'
    const stagedPath = join(root, videoKey)
    const content = 'duplicate-without-authority'
    await writeFile(stagedPath, content)
    const staged = {
      sourcePath: join(root, 'source.mp4'),
      sourceBytes: Buffer.byteLength(content),
      videoKey,
      materialId: 'MATERIAL-EXISTING-016',
      stagedPath,
      inbox: root,
      stagedIdentity: identityFromStat(await stat(stagedPath)),
      contentSha256: createHash('sha256').update(content).digest('hex'),
      ownershipToken: '00000000-0000-4000-8000-000000000016',
      taskId: 'task-16',
      idempotencyKey: 'task-16',
      batchId: '',
    }
    const lifecycle = []
    await assert.rejects(submitStagedVideoTask({
      client: {
        async trigger() { return { taskId: 'task-16', status: 'accepted', duplicate: true } },
        async getRun() { return null },
      },
      bindingId: 7,
      taskId: 'task-16',
      idempotencyKey: 'task-16',
      prompt: '分析视频',
      async onTriggerStarted() { lifecycle.push('triggering') },
      async onLocalCleanupStarted() { lifecycle.push('discarding') },
      async onMediaSettled() { lifecycle.push('settled') },
    }, staged), /video_trigger_unconfirmed/u)
    assert.deepEqual(lifecycle, ['triggering'])
    assert.equal(await readFile(stagedPath, 'utf8'), content)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('same-key failed and cancelled runs settle only after exact residual cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-terminal-owner-cleanup-'))
  try {
    for (const [index, status] of ['failed', 'cancelled'].entries()) {
      const token = `00000000-0000-4000-8000-00000000008${index}`
      const videoKey = `${token}.mp4`
      const stagedPath = join(root, videoKey)
      const content = `terminal-owner-${status}`
      const taskId = `task-terminal-${status}`
      await writeFile(stagedPath, content)
      const staged = {
        sourcePath: join(root, `${status}.mp4`),
        sourceBytes: Buffer.byteLength(content),
        videoKey,
        materialId: `MATERIAL-TERMINAL-${status.toUpperCase()}`,
        stagedPath,
        inbox: root,
        stagedIdentity: identityFromStat(await stat(stagedPath)),
        contentSha256: createHash('sha256').update(content).digest('hex'),
        ownershipToken: token,
        taskId,
        idempotencyKey: taskId,
        batchId: '',
      }
      const lifecycle = []
      const response = await submitStagedVideoTask({
        client: {
          async trigger() { return { taskId, status, duplicate: true } },
          async getRun() { return { taskId, status, input: { videoKey } } },
        },
        bindingId: 7,
        taskId,
        idempotencyKey: taskId,
        prompt: '分析视频',
        async onTriggerStarted() { lifecycle.push('triggering') },
        async onLocalCleanupStarted() { lifecycle.push('discarding') },
        async onMediaSettled() { lifecycle.push('settled') },
      }, staged)
      assert.equal(response.status, status)
      assert.deepEqual(lifecycle, ['triggering', 'discarding', 'settled'])
      await assert.rejects(access(stagedPath), error => error?.code === 'ENOENT')
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('staged submission rejects fabricated bindings and inbox-external paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-staged-boundary-'))
  try {
    const inbox = join(root, 'inbox')
    await mkdir(inbox)
    const videoKey = '00000000-0000-4000-8000-000000000015.mp4'
    const outsidePath = join(root, videoKey)
    await writeFile(outsidePath, 'outside-inbox-video')
    const details = identityFromStat(await stat(outsidePath))
    const request = {
      client: { async trigger() { throw new Error('must_not_trigger') } },
      bindingId: 7,
      taskId: 'task-15',
      idempotencyKey: 'task-15',
      prompt: '分析视频',
    }
    const staged = {
      sourcePath: join(root, 'source.mp4'),
      sourceBytes: details.size,
      videoKey,
      materialId: 'MATERIAL-EXISTING-015',
      stagedPath: outsidePath,
      inbox,
      stagedIdentity: details,
      contentSha256: createHash('sha256').update('outside-inbox-video').digest('hex'),
      ownershipToken: '00000000-0000-4000-8000-000000000015',
      taskId: 'task-15',
      idempotencyKey: 'task-15',
      batchId: '',
    }
    await assert.rejects(submitStagedVideoTask(request, staged), /staged_video_task_binding_invalid/u)
    await assert.rejects(
      submitStagedVideoTask(request, { ...staged, stagedPath: join(inbox, videoKey), taskId: 'foreign-task' }),
      /staged_video_task_binding_invalid/u,
    )
    assert.equal(await readFile(outsidePath, 'utf8'), 'outside-inbox-video')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
