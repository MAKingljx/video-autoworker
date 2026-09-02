import { access, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import {
  createBatchState,
  createSingleVideoState,
  acquireGlobalBatchLock,
  batchStateBackupPath,
  batchStatePath,
  cleanupBatchItemStagedMedia,
  listBatchStatePaths,
  loadBatchItemStagedMedia,
  readBatchState,
  recoverBatchItemStaging,
  searchVideoTaskStates,
  sourceFingerprintFromIdentity,
  verifyBatchItemSource,
  writeBatchState,
  globalBatchLockPath,
} from '../lib/video-batch-state.mjs'

function identityFromStat(details) {
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeMs: details.mtimeMs,
    ctimeMs: details.ctimeMs,
  }
}

function recoveryFixture(sourceIdentity, suffix) {
  const pid = 2_147_483_646
  const videoKey = `${suffix}.mp4`
  return {
    schemaVersion: 1,
    phase: 'prepared',
    sourceIdentity,
    anchorName: `.source-anchor-${pid}-${suffix}`,
    incomingName: `.incoming-${pid}-${videoKey}`,
    videoKey,
    materialId: null,
    contentSha256: null,
    incomingIdentity: null,
    stagedIdentity: null,
    ownershipToken: suffix,
    taskId: 'fixture-task',
    idempotencyKey: 'fixture-idempotency',
    batchId: 'fixture-batch',
  }
}

function bindRecovery(stagingRecovery) {
  return {
    taskId: stagingRecovery.taskId,
    idempotencyKey: stagingRecovery.idempotencyKey,
    batchId: stagingRecovery.batchId,
  }
}

function bindItem(stagingRecovery) {
  return {
    taskId: stagingRecovery.taskId,
    idempotencyKey: stagingRecovery.idempotencyKey,
  }
}

test('global lock release quarantines by lease inode and preserves a canonical successor', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-global-lock-successor-')))
  const statePath = join(root, 'state.json')
  const lockPath = globalBatchLockPath(statePath)
  const displaced = `${lockPath}.displaced`
  try {
    const first = await acquireGlobalBatchLock(statePath)
    assert.equal(first.acquired, true)
    await rename(lockPath, displaced)
    const successor = await acquireGlobalBatchLock(statePath)
    assert.equal(successor.acquired, true)
    const successorSource = await readFile(lockPath, 'utf8')

    await assert.rejects(first.release(), /视频队列锁在释放前已被替换/u)
    assert.equal(await readFile(lockPath, 'utf8'), successorSource)
    await successor.release()
    await assert.rejects(access(lockPath), error => error?.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('global lock reclaims a stable dead owner through quarantine', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-global-lock-stale-')))
  const statePath = join(root, 'state.json')
  const lockPath = globalBatchLockPath(statePath)
  try {
    await writeFile(lockPath, `${JSON.stringify({
      pid: 2_147_483_647,
      token: '00000000-0000-4000-8000-000000000000',
      createdAt: '2026-09-01T00:00:00.000Z',
    })}\n`, { mode: 0o600 })
    const lease = await acquireGlobalBatchLock(statePath)
    assert.equal(lease.acquired, true)
    assert.equal(JSON.parse(await readFile(lockPath, 'utf8')).pid, process.pid)
    await lease.release()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('state writes keep a durable backup and recover a damaged primary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-task-flow-state-backup-'))
  const statePath = batchStatePath('backup-fixture', root)
  const base = {
    schemaVersion: 2,
    requestFingerprint: 'a'.repeat(64),
    batchId: 'backup-fixture',
    kind: 'batch',
    items: [],
  }
  try {
    await writeBatchState(statePath, { ...base, status: 'queued' })
    const backupPath = batchStateBackupPath(statePath)
    await access(backupPath)
    assert.equal(JSON.parse(await readFile(backupPath, 'utf8')).status, 'queued')

    await writeBatchState(statePath, { ...base, status: 'running' })
    assert.equal((await readBatchState(statePath)).status, 'running')

    await assert.rejects(writeBatchState(statePath, {
      ...base,
      status: 'running',
      items: [{ materialId: 'MATERIAL-UNTRUSTED-STATE-001' }],
    }), /批次状态文件无效/u)
    assert.equal(JSON.parse(await readFile(backupPath, 'utf8')).status, 'queued')

    await writeFile(statePath, '{corrupt')
    assert.equal((await readBatchState(statePath)).status, 'queued')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('backup-only state remains visible to search and queue discovery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-task-flow-backup-discovery-'))
  const batchId = 'backup-discovery'
  const statePath = batchStatePath(batchId, root)
  try {
    await writeBatchState(statePath, {
      schemaVersion: 2,
      requestFingerprint: 'b'.repeat(64),
      batchId,
      status: 'queued',
      items: [{
        index: 1,
        name: '备份恢复样片.mp4',
        taskId: 'backup-task-1',
        status: 'queued',
      }],
    })
    await rm(statePath)

    assert.equal((await readBatchState(statePath)).status, 'queued')
    assert.deepEqual(await listBatchStatePaths(statePath), [statePath])
    const searched = await searchVideoTaskStates('备份恢复样片', root)
    assert.equal(searched.total, 1)
    assert.deepEqual(searched.matches[0], {
      kind: 'batch',
      taskId: 'backup-task-1',
      batchId,
      index: 1,
      name: '备份恢复样片.mp4',
      status: 'queued',
      batchStatus: 'queued',
      completedAt: null,
      updatedAt: (await readBatchState(statePath)).updatedAt,
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

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

test('same canonical video path requires confirmation before a new single task state is created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-task-flow-duplicate-single-'))
  const sourceDir = join(root, 'source')
  const batchRoot = join(root, 'states')
  const inboxRoot = join(root, 'inbox')
  const videoFile = join(sourceDir, 'S03E03.mp4')
  try {
    await mkdir(sourceDir, { recursive: true })
    await writeFile(videoFile, 'video-bytes')
    const common = {
      baseUrl: 'http://127.0.0.1:3017',
      bindingId: 7,
      prompt: '分析视频',
      visionRoute: null,
      videoFile,
      inboxRoot,
      batchRoot,
    }
    const first = await createSingleVideoState({
      ...common,
      taskId: 'video-command-first',
      idempotencyKey: 'video-command-first',
      directorWork: '地球之极',
      trustedExistingMaterialId: 'MATERIAL-EXISTING-001',
    })
    assert.equal(first.duplicate, false)
    assert.equal(first.state.items[0].trustedExistingMaterialId, 'MATERIAL-EXISTING-001')
    assert.equal(first.state.directorWork, '地球之极')

    await assert.rejects(createSingleVideoState({
      ...common,
      taskId: 'video-command-first',
      idempotencyKey: 'video-command-first',
      directorWork: '另一作品',
      trustedExistingMaterialId: 'MATERIAL-EXISTING-001',
    }), /同一任务 ID 已绑定其他视频、提示词或执行配置/u)

    const blocked = await createSingleVideoState({
      ...common,
      taskId: 'video-command-second',
      idempotencyKey: 'video-command-second',
      trustedExistingMaterialId: 'MATERIAL-EXISTING-002',
    })
    assert.equal(blocked.confirmationRequired, true)
    assert.equal(blocked.state, null)
    assert.equal(blocked.historical.total, 1)
    assert.equal(blocked.historical.matches[0].name, 'S03E03.mp4')
    assert.equal(Object.hasOwn(blocked.historical.matches[0], 'sourcePath'), false)
    await assert.rejects(access(blocked.statePath), error => error?.code === 'ENOENT')

    const confirmed = await createSingleVideoState({
      ...common,
      taskId: 'video-command-second',
      idempotencyKey: 'video-command-second',
      trustedExistingMaterialId: 'MATERIAL-EXISTING-002',
      confirmDuplicate: true,
    })
    assert.equal(confirmed.confirmedDuplicate, true)
    assert.equal(confirmed.state.status, 'queued')

    const idempotent = await createSingleVideoState({
      ...common,
      taskId: 'video-command-second',
      idempotencyKey: 'video-command-second',
      trustedExistingMaterialId: 'MATERIAL-EXISTING-002',
    })
    assert.equal(idempotent.duplicate, true)
    assert.equal(idempotent.confirmationRequired, undefined)
    await assert.rejects(createSingleVideoState({
      ...common,
      taskId: 'video-command-second',
      idempotencyKey: 'video-command-second',
      trustedExistingMaterialId: 'MATERIAL-DIFFERENT',
    }), /同一任务 ID 已绑定其他视频、提示词或执行配置/u)
    await assert.rejects(createSingleVideoState({
      ...common,
      taskId: 'video-command-invalid-material',
      idempotencyKey: 'video-command-invalid-material',
      trustedExistingMaterialId: 123,
    }), /素材稳定标识无效/u)
    await assert.rejects(createSingleVideoState({
      ...common,
      taskId: 'video-command-legacy-material',
      idempotencyKey: 'video-command-legacy-material',
      materialId: 'MATERIAL-UNTRUSTED-001',
    }), /untrusted_material_id_field/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('directory submission blocks the whole new batch when any exact path already exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'aiworker-task-flow-duplicate-batch-'))
  const videoDir = join(root, 'series')
  const batchRoot = join(root, 'states')
  try {
    await mkdir(videoDir, { recursive: true })
    await writeFile(join(videoDir, 'episode-01.mp4'), 'one')
    await writeFile(join(videoDir, 'episode-02.mp4'), 'two')
    const common = {
      baseUrl: 'http://127.0.0.1:3017',
      bindingId: 7,
      prompt: '分析整季',
      visionRoute: null,
      videoDir,
      inboxRoot: join(root, 'inbox'),
      batchRoot,
    }
    await createBatchState({ ...common, batchId: 'first-batch' })

    const blocked = await createBatchState({ ...common, batchId: 'second-batch' })
    assert.equal(blocked.confirmationRequired, true)
    assert.equal(blocked.historical.total, 2)
    assert.deepEqual(
      blocked.historical.matches.map(item => item.name).sort(),
      ['episode-01.mp4', 'episode-02.mp4'],
    )
    await assert.rejects(access(blocked.statePath), error => error?.code === 'ENOENT')

    const confirmed = await createBatchState({
      ...common,
      batchId: 'second-batch',
      confirmDuplicate: true,
    })
    assert.equal(confirmed.confirmedDuplicate, true)
    assert.equal(confirmed.state.items.length, 2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('same task recovers a crash while its Darwin source anchor still exists', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-anchor-crash-recovery-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, Buffer.alloc(64, 0x61))
    const admittedIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = recoveryFixture(
      admittedIdentity,
      '00000000-0000-4000-8000-000000000001',
    )
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: admittedIdentity.size,
      sourceIdentity: admittedIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, admittedIdentity),
      stagingRecovery,
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
    await link(sourcePath, join(inboxRoot, stagingRecovery.anchorName))
    const incomingPath = join(inboxRoot, stagingRecovery.incomingName)
    await writeFile(incomingPath, Buffer.alloc(13, 0x61))
    stagingRecovery.incomingIdentity = identityFromStat(await stat(incomingPath))

    const checkpoints = []
    const recovered = await recoverBatchItemStaging(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
      async onCheckpoint(checkpoint) {
        checkpoints.push(checkpoint.phase)
        item.stagingRecovery = checkpoint
      },
    })
    assert.deepEqual(checkpoints, ['anchor_observed'])
    item.sourceIdentity = recovered.sourceIdentity
    item.sourceFingerprint = sourceFingerprintFromIdentity(sourcePath, recovered.sourceIdentity)
    delete item.stagingRecovery
    await verifyBatchItemSource(item, { inboxRoot })
    await assert.rejects(access(join(inboxRoot, stagingRecovery.anchorName)), error => error?.code === 'ENOENT')
    await assert.rejects(access(incomingPath), error => error?.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('same task recovers after anchor deletion but before its final identity was persisted', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-post-anchor-crash-recovery-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, Buffer.alloc(64, 0x62))
    const admittedIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = recoveryFixture(
      admittedIdentity,
      '00000000-0000-4000-8000-000000000002',
    )
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: admittedIdentity.size,
      sourceIdentity: admittedIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, admittedIdentity),
      stagingRecovery,
    }
    const anchorPath = join(inboxRoot, stagingRecovery.anchorName)
    await new Promise(resolvePromise => setTimeout(resolvePromise, 5))
    await link(sourcePath, anchorPath)
    const incomingPath = join(inboxRoot, stagingRecovery.incomingName)
    await writeFile(incomingPath, Buffer.alloc(64, 0x62))
    stagingRecovery.incomingIdentity = identityFromStat(await stat(incomingPath))
    await rm(anchorPath)
    assert.notEqual((await stat(sourcePath)).ctimeMs, admittedIdentity.ctimeMs)

    const checkpoints = []
    const recovered = await recoverBatchItemStaging(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
      async onCheckpoint(checkpoint) {
        checkpoints.push(checkpoint.phase)
        item.stagingRecovery = checkpoint
      },
    })
    assert.deepEqual(checkpoints, ['copy_observed'])
    item.sourceIdentity = recovered.sourceIdentity
    item.sourceFingerprint = sourceFingerprintFromIdentity(sourcePath, recovered.sourceIdentity)
    delete item.stagingRecovery
    await verifyBatchItemSource(item, { inboxRoot })
    await assert.rejects(access(incomingPath), error => error?.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('staging recovery never legalizes a same-size atomic source replacement', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-staging-replacement-rejection-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  const originalPath = join(root, 'original.mp4')
  const replacementPath = join(root, 'replacement.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, Buffer.alloc(64, 0x63))
    await writeFile(replacementPath, Buffer.alloc(64, 0x64))
    const admittedIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = recoveryFixture(
      admittedIdentity,
      '00000000-0000-4000-8000-000000000003',
    )
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: admittedIdentity.size,
      sourceIdentity: admittedIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, admittedIdentity),
      stagingRecovery,
    }
    await link(sourcePath, join(inboxRoot, stagingRecovery.anchorName))
    await writeFile(join(inboxRoot, stagingRecovery.incomingName), Buffer.alloc(64, 0x63))
    await rename(sourcePath, originalPath)
    await rename(replacementPath, sourcePath)

    await assert.rejects(
      recoverBatchItemStaging(item, { inboxRoot, binding: bindRecovery(stagingRecovery) }),
      /视频源文件在暂存恢复前发生变化/u,
    )
    assert.deepEqual(item.sourceIdentity, admittedIdentity)
    assert.equal(item.sourceFingerprint, sourceFingerprintFromIdentity(sourcePath, admittedIdentity))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recovery cleans only the current task incoming file after source identity persistence', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-source-finalized-recovery-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, Buffer.alloc(64, 0x65))
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = {
      ...recoveryFixture(sourceIdentity, '00000000-0000-4000-8000-000000000004'),
      phase: 'source_finalized',
    }
    const foreignName = '.incoming-2147483646-00000000-0000-4000-8000-000000000099.mp4'
    const incomingPath = join(inboxRoot, stagingRecovery.incomingName)
    await writeFile(incomingPath, Buffer.alloc(31, 0x65))
    stagingRecovery.incomingIdentity = identityFromStat(await stat(incomingPath))
    await writeFile(join(inboxRoot, foreignName), 'foreign-task-copy')
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }

    const recovered = await recoverBatchItemStaging(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    })
    item.sourceIdentity = recovered.sourceIdentity
    item.sourceFingerprint = sourceFingerprintFromIdentity(sourcePath, recovered.sourceIdentity)
    delete item.stagingRecovery
    await verifyBatchItemSource(item, { inboxRoot })
    await assert.rejects(access(incomingPath), error => error?.code === 'ENOENT')
    assert.equal(await readFile(join(inboxRoot, foreignName), 'utf8'), 'foreign-task-copy')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('staged handoff recovery reuses or discards only its journal-bound final video', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-staged-handoff-recovery-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, Buffer.alloc(64, 0x66))
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = {
      ...recoveryFixture(sourceIdentity, '00000000-0000-4000-8000-000000000005'),
      phase: 'staged',
      materialId: 'MATERIAL-EXISTING-005',
    }
    const foreignVideoKey = '00000000-0000-4000-8000-000000000099.mp4'
    await writeFile(join(inboxRoot, stagingRecovery.videoKey), Buffer.alloc(64, 0x66))
    stagingRecovery.stagedIdentity = identityFromStat(await stat(join(inboxRoot, stagingRecovery.videoKey)))
    stagingRecovery.contentSha256 = createHash('sha256').update(Buffer.alloc(64, 0x66)).digest('hex')
    await writeFile(join(inboxRoot, foreignVideoKey), 'foreign-platform-video')
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }

    const staged = await loadBatchItemStagedMedia(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    })
    assert.equal(staged.videoKey, stagingRecovery.videoKey)
    assert.equal(await readFile(staged.stagedPath, 'utf8'), Buffer.alloc(64, 0x66).toString())
    item.stagingRecovery = { ...stagingRecovery, phase: 'discarding' }
    await cleanupBatchItemStagedMedia(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    })
    await assert.rejects(access(staged.stagedPath), error => error?.code === 'ENOENT')
    assert.equal(await readFile(join(inboxRoot, foreignVideoKey), 'utf8'), 'foreign-platform-video')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('staging journals cannot be exchanged between task bindings', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-journal-binding-swap-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, 'binding-swap-source')
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = recoveryFixture(
      sourceIdentity,
      '00000000-0000-4000-8000-000000000006',
    )
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }
    await assert.rejects(recoverBatchItemStaging(item, {
      inboxRoot,
      binding: { ...bindRecovery(stagingRecovery), taskId: 'foreign-task' },
    }), /视频暂存恢复记录与任务绑定不匹配/u)
    await assert.rejects(recoverBatchItemStaging({ ...item, taskId: 'foreign-task' }, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    }), /视频暂存恢复记录与任务绑定不匹配/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('non-SHA material IDs still require the journal content SHA-256', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-journal-content-hash-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, 'original-content')
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = {
      ...recoveryFixture(sourceIdentity, '00000000-0000-4000-8000-000000000007'),
      phase: 'staged',
      materialId: 'MATERIAL-EXISTING-NON-SHA',
      contentSha256: createHash('sha256').update('original-content').digest('hex'),
    }
    const stagedPath = join(inboxRoot, stagingRecovery.videoKey)
    await writeFile(stagedPath, 'tampered-content')
    stagingRecovery.stagedIdentity = identityFromStat(await stat(stagedPath))
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }
    await assert.rejects(loadBatchItemStagedMedia(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    }), /视频平台交接暂存文件已变化/u)
    assert.equal(await readFile(stagedPath, 'utf8'), 'tampered-content')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prepared recovery removes a partial copy by its pre-write inode identity', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-prewrite-inode-recovery-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, 'source-content-for-partial-copy')
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = recoveryFixture(
      sourceIdentity,
      '00000000-0000-4000-8000-000000000017',
    )
    const incomingPath = join(inboxRoot, stagingRecovery.incomingName)
    await writeFile(incomingPath, '')
    stagingRecovery.incomingIdentity = identityFromStat(await stat(incomingPath))
    await writeFile(incomingPath, 'partial-copy')
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }

    await recoverBatchItemStaging(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    })
    await assert.rejects(access(incomingPath), error => error?.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('staging recovery resumes a partial-copy claim left after rename and before removal', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-partial-claim-recovery-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, 'source-content-for-claimed-partial')
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = recoveryFixture(
      sourceIdentity,
      '00000000-0000-4000-8000-000000000020',
    )
    const incomingPath = join(inboxRoot, stagingRecovery.incomingName)
    await writeFile(incomingPath, '')
    stagingRecovery.incomingIdentity = identityFromStat(await stat(incomingPath))
    await writeFile(incomingPath, 'partial-copy')
    const claimPath = join(inboxRoot, `.cleanup-claim-${stagingRecovery.ownershipToken}-incoming`)
    await rename(incomingPath, claimPath)
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }

    await recoverBatchItemStaging(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    })
    await assert.rejects(access(claimPath), error => error?.code === 'ENOENT')
    await assert.rejects(access(incomingPath), error => error?.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('staging recovery resumes a final-file claim left after rename and before removal', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-final-claim-recovery-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    const content = 'source-content-for-claimed-final'
    await writeFile(sourcePath, content)
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = {
      ...recoveryFixture(sourceIdentity, '00000000-0000-4000-8000-000000000021'),
      phase: 'source_finalized',
    }
    const incomingPath = join(inboxRoot, stagingRecovery.incomingName)
    const stagedPath = join(inboxRoot, stagingRecovery.videoKey)
    await writeFile(incomingPath, '')
    stagingRecovery.incomingIdentity = identityFromStat(await stat(incomingPath))
    await writeFile(incomingPath, content)
    await rename(incomingPath, stagedPath)
    const claimPath = join(inboxRoot, `.cleanup-claim-${stagingRecovery.ownershipToken}-final`)
    await rename(stagedPath, claimPath)
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }

    await recoverBatchItemStaging(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    })
    await assert.rejects(access(claimPath), error => error?.code === 'ENOENT')
    await assert.rejects(access(stagedPath), error => error?.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('staging recovery resumes an anchor claim left after rename and before removal', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-anchor-claim-recovery-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, 'source-content-for-claimed-anchor')
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = recoveryFixture(
      sourceIdentity,
      '00000000-0000-4000-8000-000000000022',
    )
    const anchorPath = join(inboxRoot, stagingRecovery.anchorName)
    await link(sourcePath, anchorPath)
    const claimPath = join(inboxRoot, `.cleanup-claim-${stagingRecovery.ownershipToken}-anchor`)
    await rename(anchorPath, claimPath)
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }

    await recoverBatchItemStaging(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    })
    await assert.rejects(access(claimPath), error => error?.code === 'ENOENT')
    await assert.rejects(access(anchorPath), error => error?.code === 'ENOENT')
    assert.equal((await stat(sourcePath)).nlink, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('staging recovery fails closed when an original artifact and its claim both exist', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-recovery-claim-conflict-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, 'source-content-for-claim-conflict')
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = recoveryFixture(
      sourceIdentity,
      '00000000-0000-4000-8000-000000000023',
    )
    const incomingPath = join(inboxRoot, stagingRecovery.incomingName)
    const claimPath = join(inboxRoot, `.cleanup-claim-${stagingRecovery.ownershipToken}-incoming`)
    await writeFile(incomingPath, '')
    stagingRecovery.incomingIdentity = identityFromStat(await stat(incomingPath))
    await writeFile(incomingPath, 'owned-partial')
    await writeFile(claimPath, 'conflicting-claim')
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }

    await assert.rejects(recoverBatchItemStaging(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    }), /视频暂存清理认领冲突/u)
    assert.equal(await readFile(incomingPath, 'utf8'), 'owned-partial')
    assert.equal(await readFile(claimPath, 'utf8'), 'conflicting-claim')
    assert.equal(item.stagingRecovery, stagingRecovery)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('staging recovery preserves a drifted deterministic claim and its journal', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-recovery-claim-drift-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  const ownedPath = join(root, 'owned-partial')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, 'source-content-for-claim-drift')
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = recoveryFixture(
      sourceIdentity,
      '00000000-0000-4000-8000-000000000024',
    )
    const incomingPath = join(inboxRoot, stagingRecovery.incomingName)
    const claimPath = join(inboxRoot, `.cleanup-claim-${stagingRecovery.ownershipToken}-incoming`)
    await writeFile(incomingPath, '')
    stagingRecovery.incomingIdentity = identityFromStat(await stat(incomingPath))
    await writeFile(incomingPath, 'owned-partial')
    await rename(incomingPath, ownedPath)
    await writeFile(claimPath, 'foreign-claim')
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }

    await assert.rejects(recoverBatchItemStaging(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    }), /视频暂存恢复副本身份不匹配/u)
    assert.equal(await readFile(claimPath, 'utf8'), 'foreign-claim')
    assert.equal(await readFile(ownedPath, 'utf8'), 'owned-partial')
    assert.equal(item.stagingRecovery, stagingRecovery)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('discarding_prepared keeps its journal when artifact identity was never persisted', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-discarding-prepared-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, 'prepared-source-content')
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = {
      ...recoveryFixture(sourceIdentity, '00000000-0000-4000-8000-000000000008'),
      phase: 'discarding_prepared',
    }
    const incomingPath = join(inboxRoot, stagingRecovery.incomingName)
    const stagedPath = join(inboxRoot, stagingRecovery.videoKey)
    await writeFile(incomingPath, 'partial')
    await writeFile(stagedPath, 'prepared-source-content')
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }
    await assert.rejects(cleanupBatchItemStagedMedia(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    }), /身份未持久化/u)
    assert.equal(await readFile(incomingPath, 'utf8'), 'partial')
    assert.equal(await readFile(stagedPath, 'utf8'), 'prepared-source-content')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanup resumes a deterministic final claim left by a process crash', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-cleanup-claim-resume-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    const content = 'claimed-before-process-crash'
    await writeFile(sourcePath, content)
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = {
      ...recoveryFixture(sourceIdentity, '00000000-0000-4000-8000-000000000018'),
      phase: 'discarding',
      materialId: 'MATERIAL-CLAIM-RESUME',
      contentSha256: createHash('sha256').update(content).digest('hex'),
    }
    const stagedPath = join(inboxRoot, stagingRecovery.videoKey)
    await writeFile(stagedPath, content)
    stagingRecovery.stagedIdentity = identityFromStat(await stat(stagedPath))
    const claimPath = join(inboxRoot, `.cleanup-claim-${stagingRecovery.ownershipToken}-final`)
    await rename(stagedPath, claimPath)
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }

    await cleanupBatchItemStagedMedia(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    })
    await assert.rejects(access(claimPath), error => error?.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanup settles from persisted identity after the original source is removed', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-cleanup-source-gone-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    const content = 'source-removed-after-staging'
    await writeFile(sourcePath, content)
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = {
      ...recoveryFixture(sourceIdentity, '00000000-0000-4000-8000-000000000019'),
      phase: 'discarding',
      materialId: 'MATERIAL-SOURCE-GONE',
      contentSha256: createHash('sha256').update(content).digest('hex'),
    }
    const stagedPath = join(inboxRoot, stagingRecovery.videoKey)
    await writeFile(stagedPath, content)
    stagingRecovery.stagedIdentity = identityFromStat(await stat(stagedPath))
    await rm(sourcePath)
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }

    const recovered = await cleanupBatchItemStagedMedia(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    })
    assert.deepEqual(recovered.sourceIdentity, sourceIdentity)
    await assert.rejects(access(stagedPath), error => error?.code === 'ENOENT')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanup refuses a path replacement and preserves the foreign artifact', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aiworker-cleanup-path-swap-')))
  const inboxRoot = join(root, 'inbox')
  const sourcePath = join(root, 'source.mp4')
  try {
    await mkdir(inboxRoot, { mode: 0o700 })
    await writeFile(sourcePath, 'source-artifact')
    const sourceIdentity = identityFromStat(await stat(sourcePath))
    const stagingRecovery = {
      ...recoveryFixture(sourceIdentity, '00000000-0000-4000-8000-000000000009'),
      phase: 'discarding',
      materialId: 'MATERIAL-EXISTING-SWAP',
      contentSha256: createHash('sha256').update('owned-artifact!').digest('hex'),
    }
    const stagedPath = join(inboxRoot, stagingRecovery.videoKey)
    const ownedPath = join(root, 'owned.mp4')
    await writeFile(stagedPath, 'owned-artifact!')
    stagingRecovery.stagedIdentity = identityFromStat(await stat(stagedPath))
    await rename(stagedPath, ownedPath)
    await writeFile(stagedPath, 'foreign-content')
    const item = {
      ...bindItem(stagingRecovery),
      sourcePath,
      sourceBytes: sourceIdentity.size,
      sourceIdentity,
      sourceFingerprint: sourceFingerprintFromIdentity(sourcePath, sourceIdentity),
      stagingRecovery,
    }
    await assert.rejects(cleanupBatchItemStagedMedia(item, {
      inboxRoot,
      binding: bindRecovery(stagingRecovery),
    }), /视频暂存清理对象身份不匹配/u)
    assert.equal(await readFile(stagedPath, 'utf8'), 'foreign-content')
    assert.equal(await readFile(ownedPath, 'utf8'), 'owned-artifact!')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
