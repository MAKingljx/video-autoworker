import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  access, chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { createMediaHandoff, createSchedulerRunner } from '../lib/scheduler-runner.js'

const taskId = `video-natural-${'a'.repeat(64)}`
const batchId = `video-batch-${'b'.repeat(64)}`

function sourceIdentity(details) {
  return {
    dev: details.dev,
    ino: details.ino,
    size: details.size,
    mtimeMs: details.mtimeMs,
    ctimeMs: details.ctimeMs,
  }
}

function singleStatePath(taskIdValue, root) {
  const taskDigest = createHash('sha256').update(taskIdValue).digest('hex').slice(0, 32)
  const stateDigest = createHash('sha256').update(`single:${taskDigest}`).digest('hex')
  return join(root, `${stateDigest}.json`)
}

async function writeSingleStateProof({
  stateRoot,
  inboxRoot,
  videoPath,
  materialId,
  identity,
  stagingRecovery,
}) {
  const taskDigest = createHash('sha256').update(taskId).digest('hex').slice(0, 32)
  const state = {
    schemaVersion: 2,
    batchId: `single:${taskDigest}`,
    requestFingerprint: 'f'.repeat(64),
    kind: 'single',
    inboxRoot,
    items: [{
      taskId,
      idempotencyKey: taskId,
      sourcePath: videoPath,
      trustedExistingMaterialId: materialId,
      sourceIdentity: identity,
      ...(stagingRecovery ? { stagingRecovery } : {}),
    }],
  }
  await writeFile(singleStatePath(taskId, stateRoot), `${JSON.stringify(state)}\n`, { mode: 0o600 })
}

function fixture(stdoutValue) {
  const execute = vi.fn(async () => ({
    stdout: `${JSON.stringify({ ...stdoutValue, materialHandoffPersisted: true })}\n`,
    stderr: '',
  }))
  const cleanupHandoff = vi.fn(async () => undefined)
  const createHandoff = vi.fn(async ({ videoPath }) => ({
    path: '/private/media-handoff-00000000-0000-4000-8000-000000000000.json',
    videoPath,
    cleanup: cleanupHandoff,
  }))
  return {
    execute,
    createHandoff,
    cleanupHandoff,
    runner: createSchedulerRunner({
      execute,
      scriptPath: '/installed/submit-task.mjs',
      nodePath: '/node',
      createHandoff,
    }),
  }
}

describe('0.5 scheduler runner', () => {
  it('accepts only the new fresh queued single dispatch contract', async () => {
    const { execute, runner } = fixture({ taskId, status: 'queued', duplicate: false })
    await expect(runner.dispatchVideo({ videoPath: '/data/test.mp4', taskId })).resolves.toEqual({
      kind: 'task', id: taskId, status: 'queued', duplicate: false,
    })
    expect(execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs',
      '--video-file', '/data/test.mp4',
      '--task-id', taskId,
      '--idempotency-key', taskId,
      '--delivery', 'none',
      '--wait-seconds', '0',
      '--no-trigger-recovery',
    ])
    expect(execute.mock.calls[0][2]).toEqual({ timeout: 25_000 })
  })

  it('passes a valid existing material ID and rejects non-string or malformed values before spawning', async () => {
    const trustedExistingMaterialId = 'MATERIAL-EXISTING-001'
    const { execute, runner, createHandoff, cleanupHandoff } = fixture({ taskId, status: 'queued', duplicate: false })
    await runner.dispatchVideo({ videoPath: '/data/test.mp4', taskId, trustedExistingMaterialId })
    expect(execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs',
      '--video-file', '/data/test.mp4',
      '--task-id', taskId,
      '--idempotency-key', taskId,
      '--media-handoff', '/private/media-handoff-00000000-0000-4000-8000-000000000000.json',
      '--delivery', 'none',
      '--wait-seconds', '0',
      '--no-trigger-recovery',
    ])
    expect(execute.mock.calls[0][2]).toEqual({ timeout: 25_000 })
    expect(createHandoff).toHaveBeenCalledWith({
      taskId,
      videoPath: '/data/test.mp4',
      materialId: trustedExistingMaterialId,
    })
    expect(cleanupHandoff).toHaveBeenCalledWith({ disposition: 'persisted_ack' })

    for (const trustedExistingMaterialId of [null, 123, true, {}, [], ' MATERIAL-001 ', '']) {
      const blocked = fixture({ taskId, status: 'queued', duplicate: false })
      await expect(blocked.runner.dispatchVideo({
        videoPath: '/data/test.mp4', taskId, trustedExistingMaterialId,
      })).rejects.toThrow('invalid_material_id')
      expect(blocked.execute).not.toHaveBeenCalled()
    }
    const legacyField = fixture({ taskId, status: 'queued', duplicate: false })
    await expect(legacyField.runner.dispatchVideo({
      videoPath: '/data/test.mp4', taskId, materialId: trustedExistingMaterialId,
    })).rejects.toThrow('untrusted_material_id_field')
    expect(legacyField.execute).not.toHaveBeenCalled()
  })

  it('retains a material handoff when CLI consumption is unknown', async () => {
    const failed = fixture({ taskId, status: 'queued', duplicate: false })
    failed.execute.mockRejectedValueOnce(new Error('dispatch_failed'))
    await expect(failed.runner.dispatchVideo({
      videoPath: '/data/test.mp4',
      taskId,
      trustedExistingMaterialId: 'MATERIAL-EXISTING-001',
    })).rejects.toThrow('dispatch_failed')
    expect(failed.cleanupHandoff).toHaveBeenCalledWith({ disposition: 'consumption_unknown' })
  })

  it('marks a confirmed spawn failure as not started while retaining the outbox', async () => {
    const notStarted = fixture({ taskId, status: 'queued', duplicate: false })
    notStarted.execute.mockRejectedValueOnce(Object.assign(new Error('spawn_failed'), { childStarted: false }))
    await expect(notStarted.runner.dispatchVideo({
      videoPath: '/data/test.mp4',
      taskId,
      trustedExistingMaterialId: 'MATERIAL-EXISTING-001',
    })).rejects.toThrow('spawn_failed')
    expect(notStarted.cleanupHandoff).toHaveBeenCalledWith({ disposition: 'not_started' })
  })

  it('requires an explicit durable-state ACK before removing a material handoff', async () => {
    const missingAck = fixture({ taskId, status: 'queued', duplicate: false })
    missingAck.execute.mockResolvedValueOnce({
      stdout: `${JSON.stringify({ taskId, status: 'queued', duplicate: false })}\n`,
      stderr: '',
    })
    await expect(missingAck.runner.dispatchVideo({
      videoPath: '/data/test.mp4',
      taskId,
      trustedExistingMaterialId: 'MATERIAL-EXISTING-001',
    })).rejects.toThrow('material_handoff_not_persisted')
    expect(missingAck.cleanupHandoff).toHaveBeenCalledWith({ disposition: 'consumption_unknown' })
  })

  it('keeps a task-keyed outbox for not-started or unknown consumption and deletes it only after ACK', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiworker-media-handoff-outbox-'))
    const handoffRoot = join(root, 'handoffs')
    const videoPath = join(root, 'video.mp4')
    const materialId = 'MATERIAL-OUTBOX-001'
    try {
      await writeFile(videoPath, 'outbox-video')
      const first = await createMediaHandoff({ taskId, videoPath, materialId, root: handoffRoot })
      const firstPayload = JSON.parse(await readFile(first.path, 'utf8'))
      await expect(first.cleanup({ disposition: 'not_started' })).resolves.toEqual({
        retained: true,
        disposition: 'not_started',
      })
      expect(await access(first.path).then(() => true)).toBe(true)

      const second = await createMediaHandoff({ taskId, videoPath, materialId, root: handoffRoot })
      expect(second.path).toBe(first.path)
      expect(JSON.parse(await readFile(second.path, 'utf8')).nonce).toBe(firstPayload.nonce)
      await expect(second.cleanup({ disposition: 'consumption_unknown' })).resolves.toEqual({
        retained: true,
        disposition: 'consumption_unknown',
      })
      await expect(createMediaHandoff({
        taskId,
        videoPath,
        materialId: 'MATERIAL-OUTBOX-CONFLICT',
        root: handoffRoot,
      })).rejects.toThrow('media_handoff_outbox_conflict')

      const acknowledged = await createMediaHandoff({ taskId, videoPath, materialId, root: handoffRoot })
      await expect(acknowledged.cleanup({ disposition: 'persisted_ack' })).resolves.toEqual({
        retained: false,
        disposition: 'persisted_ack',
      })
      await expect(access(acknowledged.path)).rejects.toMatchObject({ code: 'ENOENT' })
      expect((await readdir(handoffRoot)).filter(name => name.includes('outbox'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('accepts ctime drift only while a task-bound controlled hard-link anchor proves worker ownership', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiworker-media-handoff-anchor-'))
    const handoffRoot = join(root, 'handoffs')
    const stateRoot = join(root, 'state')
    const inboxRoot = join(root, 'inbox')
    const videoPath = join(root, 'video.mp4')
    const materialId = 'MATERIAL-ANCHOR-001'
    const ownershipToken = '00000000-0000-4000-8000-000000000001'
    const videoKey = '00000000-0000-4000-8000-000000000002.mp4'
    const anchorName = `.source-anchor-${process.pid}-${ownershipToken}`
    try {
      await Promise.all([
        mkdir(stateRoot, { mode: 0o700 }),
        mkdir(inboxRoot, { mode: 0o700 }),
        writeFile(videoPath, 'anchor-video'),
      ])
      const first = await createMediaHandoff({
        taskId, videoPath, materialId, root: handoffRoot, batchRoot: stateRoot,
      })
      const firstPayload = JSON.parse(await readFile(first.path, 'utf8'))
      const admittedIdentity = firstPayload.sourceIdentity
      await first.cleanup({ disposition: 'consumption_unknown' })
      await link(videoPath, join(inboxRoot, anchorName))
      const anchoredIdentity = sourceIdentity(await stat(videoPath))
      expect(anchoredIdentity.ctimeMs).not.toBe(admittedIdentity.ctimeMs)
      const taskDigest = createHash('sha256').update(taskId).digest('hex').slice(0, 32)
      await writeSingleStateProof({
        stateRoot,
        inboxRoot,
        videoPath: await realpath(videoPath),
        materialId,
        identity: admittedIdentity,
        stagingRecovery: {
          schemaVersion: 1,
          phase: 'anchor_observed',
          sourceIdentity: admittedIdentity,
          anchoredIdentity,
          anchorName,
          incomingName: `.incoming-${process.pid}-${videoKey}`,
          videoKey,
          materialId: null,
          contentSha256: null,
          incomingIdentity: null,
          stagedIdentity: null,
          ownershipToken,
          taskId,
          idempotencyKey: taskId,
          batchId: `single:${taskDigest}`,
        },
      })

      const retried = await createMediaHandoff({
        taskId, videoPath, materialId, root: handoffRoot, batchRoot: stateRoot,
      })
      const retriedPayload = JSON.parse(await readFile(retried.path, 'utf8'))
      expect(retriedPayload.nonce).toBe(firstPayload.nonce)
      expect(retriedPayload.sourceIdentity).toEqual(anchoredIdentity)
      await retried.cleanup({ disposition: 'persisted_ack' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects metadata ctime drift after the durable anchor checkpoint', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiworker-media-handoff-anchor-chmod-'))
    const handoffRoot = join(root, 'handoffs')
    const stateRoot = join(root, 'state')
    const inboxRoot = join(root, 'inbox')
    const videoPath = join(root, 'video.mp4')
    const materialId = 'MATERIAL-ANCHOR-CHMOD-001'
    const ownershipToken = '00000000-0000-4000-8000-000000000003'
    const videoKey = '00000000-0000-4000-8000-000000000004.mp4'
    const anchorName = `.source-anchor-${process.pid}-${ownershipToken}`
    try {
      await Promise.all([
        mkdir(stateRoot, { mode: 0o700 }),
        mkdir(inboxRoot, { mode: 0o700 }),
        writeFile(videoPath, 'anchor-chmod-video', { mode: 0o644 }),
      ])
      const first = await createMediaHandoff({
        taskId, videoPath, materialId, root: handoffRoot, batchRoot: stateRoot,
      })
      const admittedIdentity = JSON.parse(await readFile(first.path, 'utf8')).sourceIdentity
      await first.cleanup({ disposition: 'consumption_unknown' })
      const taskDigest = createHash('sha256').update(taskId).digest('hex').slice(0, 32)
      await writeSingleStateProof({
        stateRoot,
        inboxRoot,
        videoPath: await realpath(videoPath),
        materialId,
        identity: admittedIdentity,
        stagingRecovery: {
          schemaVersion: 1,
          phase: 'prepared',
          sourceIdentity: admittedIdentity,
          anchoredIdentity: null,
          anchorName,
          incomingName: `.incoming-${process.pid}-${videoKey}`,
          videoKey,
          materialId: null,
          contentSha256: null,
          incomingIdentity: null,
          stagedIdentity: null,
          ownershipToken,
          taskId,
          idempotencyKey: taskId,
          batchId: `single:${taskDigest}`,
        },
      })
      await link(videoPath, join(inboxRoot, anchorName))
      await chmod(videoPath, 0o600)
      expect((await stat(videoPath)).ctimeMs).not.toBe(admittedIdentity.ctimeMs)
      await expect(createMediaHandoff({
        taskId, videoPath, materialId, root: handoffRoot, batchRoot: stateRoot,
      })).rejects.toThrow('media_handoff_outbox_conflict')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers the same material and nonce after ACK loss when worker-finalized state proves ctime drift', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiworker-media-handoff-finalized-'))
    const handoffRoot = join(root, 'handoffs')
    const stateRoot = join(root, 'state')
    const inboxRoot = join(root, 'inbox')
    const videoPath = join(root, 'video.mp4')
    const anchorPath = join(inboxRoot, '.source-anchor-transient')
    const materialId = 'MATERIAL-FINALIZED-001'
    try {
      await Promise.all([
        mkdir(stateRoot, { mode: 0o700 }),
        mkdir(inboxRoot, { mode: 0o700 }),
        writeFile(videoPath, 'finalized-video'),
      ])
      const first = await createMediaHandoff({
        taskId, videoPath, materialId, root: handoffRoot, batchRoot: stateRoot,
      })
      const firstPayload = JSON.parse(await readFile(first.path, 'utf8'))
      await first.cleanup({ disposition: 'consumption_unknown' })

      await link(videoPath, anchorPath)
      await rm(anchorPath)
      const finalizedIdentity = sourceIdentity(await stat(videoPath))
      expect(finalizedIdentity.ctimeMs).not.toBe(firstPayload.sourceIdentity.ctimeMs)
      await writeSingleStateProof({
        stateRoot,
        inboxRoot,
        videoPath: await realpath(videoPath),
        materialId,
        identity: finalizedIdentity,
      })
      const primaryStatePath = singleStatePath(taskId, stateRoot)
      await rename(primaryStatePath, `${primaryStatePath}.bak`)
      await writeFile(primaryStatePath, '{damaged-primary\n', { mode: 0o600 })

      const retried = await createMediaHandoff({
        taskId, videoPath, materialId, root: handoffRoot, batchRoot: stateRoot,
      })
      const retriedPayload = JSON.parse(await readFile(retried.path, 'utf8'))
      expect(retriedPayload.nonce).toBe(firstPayload.nonce)
      expect(retriedPayload.materialId).toBe(materialId)
      expect(retriedPayload.sourceIdentity).toEqual(finalizedIdentity)
      await retried.cleanup({ disposition: 'persisted_ack' })
      expect((await readdir(handoffRoot)).filter(name => name.endsWith('.json'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects chmod ctime drift without matching task-bound worker state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiworker-media-handoff-chmod-'))
    const handoffRoot = join(root, 'handoffs')
    const stateRoot = join(root, 'state')
    const videoPath = join(root, 'video.mp4')
    const materialId = 'MATERIAL-CHMOD-001'
    try {
      await mkdir(stateRoot, { mode: 0o700 })
      await writeFile(videoPath, 'chmod-video', { mode: 0o644 })
      const first = await createMediaHandoff({
        taskId, videoPath, materialId, root: handoffRoot, batchRoot: stateRoot,
      })
      await first.cleanup({ disposition: 'consumption_unknown' })
      await chmod(videoPath, 0o600)
      await expect(createMediaHandoff({
        taskId, videoPath, materialId, root: handoffRoot, batchRoot: stateRoot,
      })).rejects.toThrow('media_handoff_outbox_conflict')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reuses the same outbox nonce after a child is killed before consumer WAL fsync', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aiworker-media-handoff-killed-child-'))
    const handoffRoot = join(root, 'handoffs')
    const videoPath = join(root, 'video.mp4')
    const materialId = 'MATERIAL-KILLED-CHILD-001'
    const createHandoff = input => createMediaHandoff({ ...input, root: handoffRoot })
    try {
      await writeFile(videoPath, 'killed-child-video')
      const killedExecute = vi.fn(() => new Promise((_resolve, reject) => {
        const child = spawn(process.execPath, ['-e', "process.kill(process.pid, 'SIGKILL')"], {
          stdio: 'ignore',
        })
        child.once('error', reject)
        child.once('exit', (code, signal) => reject(new Error(`consumer_child_killed:${signal || code}`)))
      }))
      const firstRunner = createSchedulerRunner({
        execute: killedExecute,
        scriptPath: '/installed/submit-task.mjs',
        nodePath: process.execPath,
        createHandoff,
      })
      await expect(firstRunner.dispatchVideo({
        videoPath,
        taskId,
        trustedExistingMaterialId: materialId,
      })).rejects.toThrow('consumer_child_killed')
      const retainedCredential = (await readdir(handoffRoot))
        .find(name => /^media-handoff-[0-9a-f-]{36}\.json$/u.test(name))
      expect(retainedCredential).toBeTruthy()
      const retainedPayload = JSON.parse(await readFile(join(handoffRoot, retainedCredential), 'utf8'))

      let retriedPayload = null
      const retryExecute = vi.fn(async (_file, args) => {
        const handoffIndex = args.indexOf('--media-handoff')
        retriedPayload = JSON.parse(await readFile(args[handoffIndex + 1], 'utf8'))
        return {
          stdout: `${JSON.stringify({
            taskId,
            status: 'queued',
            duplicate: false,
            materialHandoffPersisted: true,
          })}\n`,
          stderr: '',
        }
      })
      const retryRunner = createSchedulerRunner({
        execute: retryExecute,
        scriptPath: '/installed/submit-task.mjs',
        nodePath: process.execPath,
        createHandoff,
      })
      await retryRunner.dispatchVideo({
        videoPath,
        taskId,
        trustedExistingMaterialId: materialId,
      })
      expect(retriedPayload.nonce).toBe(retainedPayload.nonce)
      expect(retriedPayload.materialId).toBe(materialId)
      expect((await readdir(handoffRoot)).filter(name => name.endsWith('.json'))).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a fresh accepted result but accepts a duplicate running result', async () => {
    const fresh = fixture({ taskId, status: 'accepted', duplicate: false }).runner
    const duplicate = fixture({ taskId, status: 'running', duplicate: true }).runner
    await expect(fresh.dispatchVideo({ videoPath: '/data/test.mp4', taskId })).rejects.toThrow(
      'invalid_fresh_dispatch_status',
    )
    await expect(duplicate.dispatchVideo({ videoPath: '/data/test.mp4', taskId })).resolves.toMatchObject({
      status: 'running', duplicate: true,
    })
  })

  it('dispatches directories with one fixed batch argument vector', async () => {
    const { execute, runner } = fixture({ batchId, status: 'queued', duplicate: false })
    await expect(runner.dispatchDirectory({ videoDirectory: '/data/series', batchId })).resolves.toMatchObject({
      kind: 'batch', id: batchId,
    })
    expect(execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs',
      '--video-dir', '/data/series',
      '--batch-id', batchId,
      '--delivery', 'none',
    ])
  })

  it('returns a bounded duplicate confirmation contract without creating a task', async () => {
    const { execute, runner } = fixture({
      taskId,
      status: 'confirmation_required',
      duplicate: false,
      confirmationRequired: true,
      duplicateCount: 1,
      duplicateNames: ['S03E03.mp4'],
      truncated: false,
    })
    await expect(runner.dispatchVideo({ videoPath: '/data/S03E03.mp4', taskId })).resolves.toEqual({
      kind: 'task',
      id: taskId,
      status: 'confirmation_required',
      duplicate: false,
      confirmationRequired: true,
      duplicateCount: 1,
      duplicateNames: ['S03E03.mp4'],
      truncated: false,
    })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('retains a trusted handoff while duplicate confirmation is pending', async () => {
    const pending = fixture({
      taskId,
      status: 'confirmation_required',
      duplicate: false,
      confirmationRequired: true,
      duplicateCount: 1,
      duplicateNames: ['S03E03.mp4'],
      truncated: false,
    })
    await expect(pending.runner.dispatchVideo({
      videoPath: '/data/S03E03.mp4',
      taskId,
      trustedExistingMaterialId: 'MATERIAL-EXISTING-001',
    })).resolves.toMatchObject({ confirmationRequired: true })
    expect(pending.cleanupHandoff).toHaveBeenCalledWith({ disposition: 'consumption_unknown' })
  })

  it('adds the duplicate confirmation flag only after the caller confirms', async () => {
    const { execute, runner } = fixture({ taskId, status: 'queued', duplicate: false })
    await runner.dispatchVideo({ videoPath: '/data/S03E03.mp4', taskId, confirmDuplicate: true })
    expect(execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs',
      '--video-file', '/data/S03E03.mp4',
      '--task-id', taskId,
      '--idempotency-key', taskId,
      '--delivery', 'none',
      '--wait-seconds', '0',
      '--no-trigger-recovery',
      '--confirm-duplicate',
    ])
  })

  it('runs exactly one task or batch status command', async () => {
    const taskFixture = fixture({ taskId, status: 'running', output: null })
    const task = taskFixture.runner
    const batchFixture = fixture({
      batchId,
      status: 'running',
      total: 2,
      counts: { succeeded: 1, running: 1 },
    })
    await expect(task.taskStatus({ taskId })).resolves.toMatchObject({ kind: 'task', status: 'running' })
    await expect(batchFixture.runner.batchStatus({ batchId })).resolves.toMatchObject({
      kind: 'batch', total: 2, counts: { succeeded: 1, running: 1 },
    })
    expect(batchFixture.execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs', '--batch-status', batchId,
    ])
    expect(taskFixture.execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs', '--status-brief', taskId,
    ])
  })

  it('reads the uniquely matched item from its batch state without submitting work', async () => {
    const { execute, runner } = fixture({
      batchId,
      status: 'running',
      total: 2,
      counts: { running: 1, queued: 1 },
      items: [
        { index: 1, name: '地球之极 第三季 第三集.mp4', status: 'running' },
        { index: 2, name: '地球之极 第三季 第十一集.mp4', status: 'queued' },
      ],
    })

    await expect(runner.batchItemStatus({ batchId, index: 2 })).resolves.toEqual({
      kind: 'batch_item',
      id: batchId,
      index: 2,
      name: '地球之极 第三季 第十一集.mp4',
      status: 'queued',
      batchStatus: 'running',
      total: 2,
      counts: { running: 1, queued: 1 },
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs', '--batch-status', batchId,
    ])
  })

  it('accepts the persistent lane recovering state', async () => {
    const recovering = fixture({
      batchId,
      status: 'recovering',
      total: 2,
      counts: { queued: 1, succeeded: 1 },
    }).runner
    await expect(recovering.batchStatus({ batchId })).resolves.toMatchObject({
      kind: 'batch', status: 'recovering', total: 2,
    })
  })

  it('accepts explicit batch state availability failures without treating them as transport errors', async () => {
    const missing = fixture({
      batchId,
      status: 'not_registered',
      stateAvailable: false,
      total: 0,
      counts: {},
      items: [],
    }).runner
    const unavailable = fixture({
      batchId,
      status: 'unavailable',
      stateAvailable: false,
      total: 0,
      counts: {},
      items: [],
    }).runner

    await expect(missing.batchStatus({ batchId })).resolves.toEqual({
      kind: 'batch',
      id: batchId,
      status: 'not_registered',
      total: 0,
      counts: {},
      items: [],
      stateAvailable: false,
    })
    await expect(unavailable.batchStatus({ batchId })).resolves.toMatchObject({
      kind: 'batch',
      id: batchId,
      status: 'unavailable',
      stateAvailable: false,
    })
  })

  it('runs one bounded all-state search without constructing a task or batch query', async () => {
    const { execute, runner } = fixture({
      matches: [{
        kind: 'task',
        taskId,
        batchId: 'single:internal-only',
        name: '地球之极 第三季 第三集.mp4',
        status: 'running',
        batchStatus: 'running',
        updatedAt: '2026-08-16T12:00:00.000Z',
      }],
      total: 1,
      truncated: false,
    })
    await expect(runner.searchStatus({ query: '《地球之极》第三季第三集进度' })).resolves.toEqual({
      matches: [{
        kind: 'task',
        taskId,
        name: '地球之极 第三季 第三集.mp4',
        status: 'running',
      }],
      total: 1,
      truncated: false,
    })
    expect(execute).toHaveBeenCalledOnce()
    expect(execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs', '--search-status', '《地球之极》第三季第三集进度',
    ])
  })

  it('reads one UTF-8 bounded final-report page through the dedicated result command', async () => {
    const { execute, runner } = fixture({
      kind: 'report',
      taskId,
      name: '地球之极 第三季 第三集.mp4',
      status: 'succeeded',
      report: {
        source: 'summary',
        text: '完整学习报告',
        offset: 0,
        nextOffset: null,
        totalBytes: Buffer.byteLength('完整学习报告', 'utf8'),
      },
    })
    await expect(runner.taskResult({ query: '《地球之极》第三季第三集', offset: 0 })).resolves.toEqual({
      kind: 'report',
      taskId,
      name: '地球之极 第三季 第三集.mp4',
      status: 'succeeded',
      report: {
        source: 'summary',
        text: '完整学习报告',
        offset: 0,
        nextOffset: null,
        totalBytes: Buffer.byteLength('完整学习报告', 'utf8'),
      },
    })
    expect(execute.mock.calls[0][1]).toEqual([
      '/installed/submit-task.mjs', '--result', '《地球之极》第三季第三集', '--result-offset', '0',
    ])
  })

  it('preserves identifiers and timestamps for ambiguous result candidates', async () => {
    const secondTaskId = `video-command-${'c'.repeat(64)}`
    const batchTaskId = `${batchId}:video:002:${'d'.repeat(12)}`
    const { runner } = fixture({
      kind: 'matches',
      matches: [
        {
          kind: 'task',
          taskId: secondTaskId,
          batchId: null,
          index: null,
          name: '地球之极 S03E03.mp4',
          status: 'succeeded',
          completedAt: '2026-08-19T07:00:00.000Z',
          updatedAt: '2026-08-19T07:01:00.000Z',
        },
        {
          kind: 'batch',
          taskId: batchTaskId,
          batchId,
          index: 2,
          name: '地球之极 S03E03.mp4',
          status: 'succeeded',
          completedAt: '2026-08-18T07:00:00.000Z',
          updatedAt: '2026-08-18T07:01:00.000Z',
        },
      ],
      total: 2,
      truncated: false,
    })

    await expect(runner.taskResult({ query: 'S03E03', offset: 0 })).resolves.toEqual({
      kind: 'matches',
      matches: [
        {
          kind: 'task', taskId: secondTaskId, batchId: null, index: null,
          name: '地球之极 S03E03.mp4', status: 'succeeded',
          completedAt: '2026-08-19T07:00:00.000Z', updatedAt: '2026-08-19T07:01:00.000Z',
        },
        {
          kind: 'batch', taskId: batchTaskId, batchId, index: 2,
          name: '地球之极 S03E03.mp4', status: 'succeeded',
          completedAt: '2026-08-18T07:00:00.000Z', updatedAt: '2026-08-18T07:01:00.000Z',
        },
      ],
      total: 2,
      truncated: false,
    })
  })

  it('rejects result output that exceeds the plugin process boundary or changes the requested offset', async () => {
    const overlong = fixture({
      kind: 'report', taskId, name: null, status: 'succeeded',
      report: {
        source: 'summary', text: 'x'.repeat(24 * 1024 + 1), offset: 0, nextOffset: null, totalBytes: 24 * 1024 + 1,
      },
    }).runner
    await expect(overlong.taskResult({ query: taskId, offset: 0 })).rejects.toThrow('invalid_result_report')

    const wrongOffset = fixture({
      kind: 'report', taskId, name: null, status: 'succeeded',
      report: { source: 'summary', text: 'ok', offset: 1, nextOffset: null, totalBytes: 3 },
    }).runner
    await expect(wrongOffset.taskResult({ query: taskId, offset: 0 })).rejects.toThrow('invalid_task_result')
  })

  it('preserves a matched directory item index for an item-level status read', async () => {
    const { runner } = fixture({
      matches: [{
        kind: 'batch',
        batchId,
        index: 2,
        name: '地球之极 第三季 第十一集.mp4',
        status: 'queued',
        batchStatus: 'running',
      }],
      total: 1,
      truncated: false,
    })

    await expect(runner.searchStatus({ query: '地球之极 第三季 第十一集' })).resolves.toEqual({
      matches: [{
        kind: 'batch',
        batchId,
        index: 2,
        name: '地球之极 第三季 第十一集.mp4',
        status: 'queued',
      }],
      total: 1,
      truncated: false,
    })
  })

  it('rejects malformed search output and invalid query text before spawning', async () => {
    const malformed = fixture({
      matches: [{ kind: 'batch', batchId, name: 'one.mp4', status: 'queued', batchStatus: 'queued' }],
      total: 2,
      truncated: false,
    }).runner
    await expect(malformed.searchStatus({ query: 'one' })).rejects.toThrow('invalid_search_result')

    const execute = vi.fn()
    const runner = createSchedulerRunner({ execute, scriptPath: '/script', nodePath: '/node' })
    await expect(runner.searchStatus({ query: 'one\ntwo' })).rejects.toThrow('invalid_search_query')
    expect(execute).not.toHaveBeenCalled()
  })

  it('fails closed on malformed, multiline, or mismatched output', async () => {
    const mismatched = fixture({ taskId: `video-natural-${'c'.repeat(64)}`, status: 'queued', duplicate: false }).runner
    await expect(mismatched.dispatchVideo({ videoPath: '/data/test.mp4', taskId })).rejects.toThrow(
      'invalid_dispatch_result',
    )
    const execute = vi.fn(async () => ({ stdout: '{}\n{}\n', stderr: 'secret' }))
    const runner = createSchedulerRunner({ execute, scriptPath: '/script', nodePath: '/node' })
    await expect(runner.taskStatus({ taskId })).rejects.toThrow('invalid_output')
  })
})
