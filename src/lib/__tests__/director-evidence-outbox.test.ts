import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DIRECTOR_EVIDENCE_BINDING_AUTHORITY,
  directorCommandEnvironment,
  directorEvidenceProjectionContractDigest,
  drainDirectorEvidenceOutbox,
  enqueueDirectorEvidenceOutbox,
  getDirectorEvidenceOutbox,
  getDirectorEvidenceOutboxCounts,
  resolveDirectorWorkBinding,
  runDirectorCommand,
} from '@/lib/director-evidence-outbox'
import {
  DIRECTOR_COMMAND_LIMITS,
  directorEvidenceDeliveryErrorIsDeterministic,
} from '@/lib/director-evidence-delivery-core'
import { runMigrations } from '@/lib/migrations'
import { mediaChildIdentity } from '@/lib/n8n-media-execution'
import { completeN8nFinalizeRun, getN8nTaskRunByTaskId } from '@/lib/n8n-task-runs'

const binding = {
  authority: DIRECTOR_EVIDENCE_BINDING_AUTHORITY,
  workId: 'WORK-001',
  queryDigest: 'a'.repeat(64),
}

async function installDirectorCliFixture(root: string, wrapperSource?: string) {
  const scriptsRoot = join(root, 'runtime', 'scripts')
  const servicePath = join(scriptsRoot, 'lib', 'feishu-director-brain.mjs')
  const schemaPath = join(root, 'runtime', 'ops', 'feishu-director-brain', 'schema.json')
  const scriptPath = join(scriptsRoot, 'feishu-director-brain.mjs')
  await mkdir(join(scriptsRoot, 'lib'), { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'runtime', 'ops', 'feishu-director-brain'), {
    recursive: true,
    mode: 0o700,
  })
  if (wrapperSource === undefined) {
    await copyFile(join(process.cwd(), 'scripts', 'feishu-director-brain.mjs'), scriptPath)
  } else {
    await writeFile(scriptPath, wrapperSource, { mode: 0o600 })
  }
  await copyFile(join(process.cwd(), 'scripts', 'lib', 'feishu-director-brain.mjs'), servicePath)
  await copyFile(join(process.cwd(), 'ops', 'feishu-director-brain', 'schema.json'), schemaPath)
  await Promise.all([scriptPath, servicePath, schemaPath].map(path => chmod(path, 0o600)))
  return { scriptPath, servicePath, schemaPath }
}

async function installDirectorTransformerFixture(root: string) {
  const scriptPath = join(root, 'aiworker-task-flow', 'scripts', 'project-director-evidence.mjs')
  const libraryPath = join(root, 'aiworker-task-flow', 'lib', 'director-brain-evidence.mjs')
  await mkdir(join(root, 'aiworker-task-flow', 'scripts'), { recursive: true, mode: 0o700 })
  await mkdir(join(root, 'aiworker-task-flow', 'lib'), { recursive: true, mode: 0o700 })
  await copyFile(
    join(process.cwd(), 'openclaw-skills', 'aiworker-task-flow', 'scripts', 'project-director-evidence.mjs'),
    scriptPath,
  )
  await copyFile(
    join(process.cwd(), 'openclaw-skills', 'aiworker-task-flow', 'lib', 'director-brain-evidence.mjs'),
    libraryPath,
  )
  await Promise.all([scriptPath, libraryPath].map(path => chmod(path, 0o600)))
  return { scriptPath, libraryPath }
}

function output(summary = '全片形成了一条清晰的探索叙事。') {
  return {
    taskType: 'video-analysis',
    materialId: 'MATERIAL-001',
    mediaDurationSeconds: 10,
    analysisVersion: 'analysis-v1',
    summary,
    timeline: [{
      index: 1,
      timeRange: '00:00:00.000-00:00:10.000',
      confidence: 0.9,
      visualAnalysis: '人物从室内走向室外。',
    }],
  }
}

describe('director evidence outbox', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    runMigrations(db)
    db.prepare(`
      INSERT INTO n8n_workflow_bindings (
        id, name, webhook_path, task_type, workspace_id, tenant_id
      ) VALUES (7, '视频分析', 'webhook/video', 'video-analysis', 2, 3)
    `).run()
  })

  afterEach(() => db.close())

  function insertParent(options: {
    taskId?: string
    status?: string
    input?: Record<string, unknown>
    result?: Record<string, unknown>
  } = {}) {
    const taskId = options.taskId || 'video-task-1'
    db.prepare(`
      INSERT INTO n8n_task_runs (
        task_id, idempotency_key, binding_id, status, source, requested_by,
        routing, input, delivery, output, workspace_id, tenant_id
      ) VALUES (?, ?, 7, ?, 'openclaw', 'test', '{}', ?, '{"mode":"none"}', ?, 2, 3)
    `).run(
      taskId,
      taskId,
      options.status || 'succeeded',
      JSON.stringify(options.input || {}),
      options.result === undefined ? JSON.stringify(output()) : JSON.stringify(options.result),
    )
    return getN8nTaskRunByTaskId(db, taskId)!
  }

  it('skips an unbound successful video without affecting its terminal state', () => {
    const parent = insertParent()
    expect(enqueueDirectorEvidenceOutbox(db, parent, 1000)).toBe('skipped')
    expect(getDirectorEvidenceOutbox(db, parent.taskId)).toBeNull()
    expect(getN8nTaskRunByTaskId(db, parent.taskId)?.status).toBe('succeeded')
  })

  it('creates one stable outbox row and treats finalize replay as existing', () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    expect(enqueueDirectorEvidenceOutbox(db, parent, 1000)).toBe('created')
    expect(enqueueDirectorEvidenceOutbox(db, parent, 1001)).toBe('existing')
    expect(getDirectorEvidenceOutboxCounts(db)).toEqual({
      pending: 1, delivered: 0, conflict: 0, incompatiblePending: 0,
    })
    expect(getDirectorEvidenceOutbox(db, parent.taskId)).toMatchObject({
      workId: 'WORK-001', status: 'pending', attemptCount: 0,
      projectionContractDigest: directorEvidenceProjectionContractDigest(),
    })
  })

  it('includes app envelope and batching semantics in the projection contract digest', () => {
    const key = 'AIWORKER_DIRECTOR_EVIDENCE_APP_PROJECTION_SEMANTICS_SHA256'
    const previous = process.env[key]
    try {
      process.env[key] = 'c'.repeat(64)
      const first = directorEvidenceProjectionContractDigest()
      process.env[key] = 'd'.repeat(64)
      expect(directorEvidenceProjectionContractDigest()).not.toBe(first)
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  it('changes the projection contract when the hashed delivery core changes', () => {
    const key = 'AIWORKER_DIRECTOR_EVIDENCE_DELIVERY_CORE_SHA256'
    const previous = process.env[key]
    try {
      process.env[key] = 'c'.repeat(64)
      const first = directorEvidenceProjectionContractDigest()
      process.env[key] = 'd'.repeat(64)
      expect(directorEvidenceProjectionContractDigest()).not.toBe(first)
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  it('marks a changed authoritative result as conflict instead of overwriting identity', () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    expect(enqueueDirectorEvidenceOutbox(db, parent, 1000)).toBe('created')
    db.prepare('UPDATE n8n_task_runs SET output = ? WHERE task_id = ?')
      .run(JSON.stringify(output('被篡改的摘要')), parent.taskId)
    const changed = getN8nTaskRunByTaskId(db, parent.taskId)!
    expect(enqueueDirectorEvidenceOutbox(db, changed, 1001)).toBe('conflict')
    expect(getDirectorEvidenceOutbox(db, parent.taskId)).toMatchObject({
      status: 'conflict', lastErrorCode: 'director_evidence_identity_conflict',
    })
  })

  it('marks the same work with a changed query digest as an identity conflict', () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    expect(enqueueDirectorEvidenceOutbox(db, parent, 1000)).toBe('created')
    db.prepare('UPDATE n8n_task_runs SET input = ? WHERE task_id = ?').run(JSON.stringify({
      directorEvidence: { ...binding, queryDigest: 'b'.repeat(64) },
    }), parent.taskId)
    const changed = getN8nTaskRunByTaskId(db, parent.taskId)!
    expect(enqueueDirectorEvidenceOutbox(db, changed, 1001)).toBe('conflict')
    expect(getDirectorEvidenceOutbox(db, parent.taskId)).toMatchObject({
      queryDigest: 'a'.repeat(64),
      status: 'conflict',
      lastErrorCode: 'director_evidence_identity_conflict',
    })
  })

  it('projects once and accepts created plus unchanged as an idempotent success', async () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    enqueueDirectorEvidenceOutbox(db, parent, 1000)
    const runner = vi.fn(async (command: string) => command === 'transform'
      ? { workId: 'WORK-001', items: [{ '证据 ID': 'E-1' }] }
      : { ok: true, action: 'project-evidence', workId: 'WORK-001', count: 1, created: 0, unchanged: 1 })
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 1000, runner })).toEqual({
      scanned: 1, delivered: 1, pending: 0, conflict: 0,
    })
    expect(getDirectorEvidenceOutbox(db, parent.taskId)?.status).toBe('delivered')
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 1001, runner })).toEqual({
      scanned: 0, delivered: 0, pending: 0, conflict: 0,
    })
    expect(runner).toHaveBeenCalledTimes(2)
  })

  it('projects long-video evidence in bounded idempotent batches', async () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    enqueueDirectorEvidenceOutbox(db, parent, 1000)
    const items = Array.from({ length: 241 }, (_, index) => ({
      '证据 ID': `E-${index + 1}`,
      note: '片段证据',
    }))
    const projectedBatchSizes: number[] = []
    const runner = vi.fn(async (command: string, input: Record<string, unknown>) => {
      if (command === 'transform') return { workId: 'WORK-001', items }
      const batchItems = input.items as unknown[]
      projectedBatchSizes.push(batchItems.length)
      expect(Buffer.byteLength(`${JSON.stringify(input)}\n`, 'utf8')).toBeLessThanOrEqual(256 * 1024)
      return {
        ok: true,
        action: 'project-evidence',
        workId: 'WORK-001',
        count: batchItems.length,
        created: batchItems.length,
        unchanged: 0,
      }
    })
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 1000, runner })).toEqual({
      scanned: 1, delivered: 1, pending: 0, conflict: 0,
    })
    expect(projectedBatchSizes).toEqual([50, 50, 50, 50, 41])
  })

  it('blocks a partial-batch row under a new delivery core, then replays unchanged under its original core', async () => {
    const key = 'AIWORKER_DIRECTOR_EVIDENCE_DELIVERY_CORE_SHA256'
    const previous = process.env[key]
    const originalContractHash = 'a'.repeat(64)
    const upgradedContractHash = 'b'.repeat(64)
    try {
      process.env[key] = originalContractHash
      const parent = insertParent({ input: { directorEvidence: binding } })
      enqueueDirectorEvidenceOutbox(db, parent, 1000)
      const items = Array.from({ length: 51 }, (_, index) => ({
        '证据 ID': `E-${index + 1}`,
      }))
      let originalWriterCalls = 0
      const originalRunner = vi.fn(async (command: string, input: Record<string, unknown>) => {
        if (command === 'transform') return { workId: 'WORK-001', items }
        originalWriterCalls++
        const count = (input.items as unknown[]).length
        if (originalWriterCalls === 2) throw new Error('director_command_timeout')
        return {
          ok: true, action: 'project-evidence', workId: 'WORK-001', count,
          created: count, unchanged: 0,
        }
      })

      expect(await drainDirectorEvidenceOutbox(db, {
        nowSeconds: 1000, runner: originalRunner,
      })).toMatchObject({ pending: 1, delivered: 0 })
      expect(originalWriterCalls).toBe(2)
      const originalDigest = getDirectorEvidenceOutbox(db, parent.taskId)
        ?.projectionContractDigest

      process.env[key] = upgradedContractHash
      const upgradedRunner = vi.fn()
      expect(getDirectorEvidenceOutboxCounts(db)).toMatchObject({
        pending: 1, incompatiblePending: 1,
      })
      expect(await drainDirectorEvidenceOutbox(db, {
        nowSeconds: 1060, runner: upgradedRunner,
      })).toMatchObject({ pending: 1, delivered: 0 })
      expect(upgradedRunner).not.toHaveBeenCalled()
      expect(getDirectorEvidenceOutbox(db, parent.taskId)).toMatchObject({
        status: 'pending',
        projectionContractDigest: originalDigest,
        lastErrorCode: 'director_evidence_projection_contract_incompatible',
        nextAttemptAt: 1180,
      })

      process.env[key] = originalContractHash
      const compatibleReplay = vi.fn(async (command: string, input: Record<string, unknown>) => {
        if (command === 'transform') return { workId: 'WORK-001', items }
        const count = (input.items as unknown[]).length
        return {
          ok: true, action: 'project-evidence', workId: 'WORK-001', count,
          created: 0, unchanged: count,
        }
      })
      expect(await drainDirectorEvidenceOutbox(db, {
        nowSeconds: 1180, runner: compatibleReplay,
      })).toMatchObject({ pending: 0, delivered: 1 })
      expect(getDirectorEvidenceOutboxCounts(db)).toMatchObject({
        pending: 0, incompatiblePending: 0, delivered: 1,
      })
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  it('also splits projection batches by the writer byte limit', async () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    enqueueDirectorEvidenceOutbox(db, parent, 1000)
    const items = Array.from({ length: 30 }, (_, index) => ({
      '证据 ID': `E-${index + 1}`,
      note: '画'.repeat(4_000),
    }))
    const projectedBatchSizes: number[] = []
    const runner = vi.fn(async (command: string, input: Record<string, unknown>) => {
      if (command === 'transform') return { workId: 'WORK-001', items }
      const batchItems = input.items as unknown[]
      projectedBatchSizes.push(batchItems.length)
      expect(Buffer.byteLength(`${JSON.stringify(input)}\n`, 'utf8')).toBeLessThanOrEqual(256 * 1024)
      return {
        ok: true,
        action: 'project-evidence',
        workId: 'WORK-001',
        count: batchItems.length,
        created: batchItems.length,
        unchanged: 0,
      }
    })
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 1000, runner })).toMatchObject({
      delivered: 1,
    })
    expect(projectedBatchSizes.length).toBeGreaterThan(1)
    expect(projectedBatchSizes.reduce((sum, size) => sum + size, 0)).toBe(30)
  })

  it('drains a 240-segment Chinese payload through the real transformer and bounded batches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'director-transform-large-output-'))
    const previousPath = process.env.AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_PATH
    const previousTransformer = process.env.AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_SHA256
    const previousLibrary = process.env.AIWORKER_DIRECTOR_EVIDENCE_LIBRARY_SHA256
    const { scriptPath, libraryPath } = await installDirectorTransformerFixture(root)
    const clock = (seconds: number) => {
      const hours = Math.floor(seconds / 3600)
      const minutes = Math.floor((seconds % 3600) / 60)
      const remainder = seconds % 60
      return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}.000`
    }
    const visualAnalysis = '画'.repeat(2_700)
    const largeOutput = {
      ...output('这是一条覆盖全片的导演摘要。'),
      mediaDurationSeconds: 240,
      timeline: Array.from({ length: 240 }, (_, index) => ({
        index: index + 1,
        timeRange: `${clock(index)}-${clock(index + 1)}`,
        confidence: 0.9,
        visualAnalysis,
      })),
    }
    process.env.AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_PATH = scriptPath
    process.env.AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_SHA256 = createHash('sha256')
      .update(await readFile(scriptPath)).digest('hex')
    process.env.AIWORKER_DIRECTOR_EVIDENCE_LIBRARY_SHA256 = createHash('sha256')
      .update(await readFile(libraryPath)).digest('hex')
    try {
      const parent = insertParent({ input: { directorEvidence: binding }, result: largeOutput })
      enqueueDirectorEvidenceOutbox(db, parent, 1000)
      let transformInputBytes = 0
      let transformOutputBytes = 0
      const projectedBatchSizes: number[] = []
      const runner = vi.fn(async (command: string, input: Record<string, unknown>) => {
        if (command === 'transform') {
          transformInputBytes = Buffer.byteLength(`${JSON.stringify(input)}\n`, 'utf8')
          const transformed = await runDirectorCommand('transform', input)
          transformOutputBytes = Buffer.byteLength(`${JSON.stringify(transformed)}\n`, 'utf8')
          return transformed
        }
        const count = (input.items as unknown[]).length
        projectedBatchSizes.push(count)
        expect(Buffer.byteLength(`${JSON.stringify(input)}\n`, 'utf8'))
          .toBeLessThanOrEqual(DIRECTOR_COMMAND_LIMITS['project-evidence'].maxInputBytes)
        return {
          ok: true, action: 'project-evidence', workId: 'WORK-001', count,
          created: count, unchanged: 0,
        }
      })
      expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 1000, runner })).toEqual({
        scanned: 1, delivered: 1, pending: 0, conflict: 0,
      })
      expect(transformInputBytes).toBeGreaterThan(1.8 * 1024 * 1024)
      expect(transformInputBytes).toBeLessThanOrEqual(DIRECTOR_COMMAND_LIMITS.transform.maxInputBytes)
      expect(transformOutputBytes).toBeGreaterThan(2 * 1024 * 1024)
      expect(transformOutputBytes).toBeLessThanOrEqual(DIRECTOR_COMMAND_LIMITS.transform.maxOutputBytes)
      expect(projectedBatchSizes.length).toBeGreaterThan(5)
      expect(projectedBatchSizes.reduce((sum, count) => sum + count, 0)).toBe(241)
    } finally {
      if (previousPath === undefined) delete process.env.AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_PATH
      else process.env.AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_PATH = previousPath
      if (previousTransformer === undefined) delete process.env.AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_SHA256
      else process.env.AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_SHA256 = previousTransformer
      if (previousLibrary === undefined) delete process.env.AIWORKER_DIRECTOR_EVIDENCE_LIBRARY_SHA256
      else process.env.AIWORKER_DIRECTOR_EVIDENCE_LIBRARY_SHA256 = previousLibrary
      await rm(root, { recursive: true, force: true })
    }
  })

  it('backs off a transient writer failure without changing the video task', async () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    enqueueDirectorEvidenceOutbox(db, parent, 1000)
    const runner = vi.fn(async (command: string) => {
      if (command === 'transform') return { workId: 'WORK-001', items: [{}] }
      throw new Error('director_command_timeout')
    })
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 1000, runner })).toMatchObject({
      pending: 1,
    })
    expect(getDirectorEvidenceOutbox(db, parent.taskId)).toMatchObject({
      status: 'pending', attemptCount: 1, nextAttemptAt: 1060,
      lastErrorCode: 'director_command_timeout',
    })
    expect(getN8nTaskRunByTaskId(db, parent.taskId)?.status).toBe('succeeded')
  })

  it.each([
    'director_command_input_too_large',
    'director_command_output_too_large',
  ])('settles immutable command-size failures as conflicts: %s', async (errorCode) => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    enqueueDirectorEvidenceOutbox(db, parent, 1000)
    const runner = vi.fn(async () => {
      throw new Error(errorCode)
    })

    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 1000, runner })).toMatchObject({
      conflict: 1,
      pending: 0,
    })
    expect(getDirectorEvidenceOutbox(db, parent.taskId)).toMatchObject({
      status: 'conflict',
      attemptCount: 1,
      lastErrorCode: errorCode,
    })
    expect(getN8nTaskRunByTaskId(db, parent.taskId)?.status).toBe('succeeded')
  })

  it('treats output overflow as deterministic only after command input contract validation', () => {
    expect(directorEvidenceDeliveryErrorIsDeterministic(
      'director_command_output_too_large',
      { commandInputContractGuaranteed: false },
    )).toBe(false)
    expect(directorEvidenceDeliveryErrorIsDeterministic(
      'director_command_output_too_large',
      { commandInputContractGuaranteed: true },
    )).toBe(true)
  })

  it('retries an invalid writer acknowledgement because stable target writes are replay-safe', async () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    enqueueDirectorEvidenceOutbox(db, parent, 1000)
    let writerCalls = 0
    const runner = vi.fn(async (command: string) => {
      if (command === 'transform') return { workId: 'WORK-001', items: [{ '证据 ID': 'E-1' }] }
      writerCalls++
      return writerCalls === 1
        ? { ok: true, action: 'project-evidence', workId: 'WORK-001', count: '1', created: 1, unchanged: 0 }
        : { ok: true, action: 'project-evidence', workId: 'WORK-001', count: 1, created: 0, unchanged: 1 }
    })
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 1000, runner })).toMatchObject({
      pending: 1,
    })
    expect(getDirectorEvidenceOutbox(db, parent.taskId)).toMatchObject({
      status: 'pending',
      lastErrorCode: 'director_evidence_projection_result_invalid',
      nextAttemptAt: 1060,
    })
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 1060, runner })).toMatchObject({
      delivered: 1,
    })
  })

  it.each([
    { count: 1, created: -1, unchanged: 2 },
    { count: 1, created: 2, unchanged: -1 },
  ])('rejects negative projection acknowledgement counters: %o', async (acknowledgement) => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    enqueueDirectorEvidenceOutbox(db, parent, 1000)
    const runner = vi.fn(async (command: string) => command === 'transform'
      ? { workId: 'WORK-001', items: [{ '证据 ID': 'E-1' }] }
      : {
          ok: true,
          action: 'project-evidence',
          workId: 'WORK-001',
          ...acknowledgement,
        })

    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 1000, runner })).toMatchObject({
      pending: 1,
      delivered: 0,
    })
    expect(getDirectorEvidenceOutbox(db, parent.taskId)).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      lastErrorCode: 'director_evidence_projection_result_invalid',
      nextAttemptAt: 1060,
    })
  })

  it('computes retry time from external-settlement time instead of drain start time', async () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    enqueueDirectorEvidenceOutbox(db, parent, 1000)
    let clock = 1000
    const runner = vi.fn(async (command: string) => {
      if (command === 'transform') return { workId: 'WORK-001', items: [{ '证据 ID': 'E-1' }] }
      clock = 1600
      throw new Error('director_command_timeout')
    })
    expect(await drainDirectorEvidenceOutbox(db, { now: () => clock, runner })).toMatchObject({
      pending: 1,
    })
    expect(getDirectorEvidenceOutbox(db, parent.taskId)).toMatchObject({
      updatedAt: 1600,
      nextAttemptAt: 1660,
    })
  })

  it('handles a child that closes stdin early without an unhandled EPIPE', async () => {
    const root = await mkdtemp(join(tmpdir(), 'director-command-epipe-'))
    const source = "process.stdin.destroy(); setTimeout(() => process.exit(0), 25)\n"
    const previousPath = process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH
    const previousDigest = process.env.AIWORKER_DIRECTOR_BRAIN_CLI_SHA256
    const { scriptPath } = await installDirectorCliFixture(root, source)
    process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH = scriptPath
    process.env.AIWORKER_DIRECTOR_BRAIN_CLI_SHA256 = createHash('sha256').update(source).digest('hex')
    try {
      await expect(runDirectorCommand('operate', {
        action: 'health',
        padding: 'x'.repeat(30_000),
      })).rejects.toThrow(/director_command_(?:stdin_failed|result_invalid)/u)
    } finally {
      if (previousPath === undefined) delete process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH
      else process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH = previousPath
      if (previousDigest === undefined) delete process.env.AIWORKER_DIRECTOR_BRAIN_CLI_SHA256
      else process.env.AIWORKER_DIRECTOR_BRAIN_CLI_SHA256 = previousDigest
      await rm(root, { recursive: true, force: true })
    }
  })

  it('passes only the runtime variables required for home, locale, proxy, and trust roots', () => {
    expect(directorCommandEnvironment({
      HOME: '/Users/runtime',
      LANG: 'zh_CN.UTF-8',
      NODE_ENV: 'production',
      HTTPS_PROXY: 'http://127.0.0.1:8080',
      NO_PROXY: '127.0.0.1',
      NODE_USE_ENV_PROXY: '1',
      NODE_EXTRA_CA_CERTS: '/private/runtime/ca.pem',
      PATH: '/untrusted/bin',
      NODE_OPTIONS: '--require=/tmp/injected.cjs',
      FEISHU_APP_SECRET: 'must-not-cross-process-boundary',
    })).toEqual({
      HOME: '/Users/runtime',
      LANG: 'zh_CN.UTF-8',
      NODE_ENV: 'production',
      HTTPS_PROXY: 'http://127.0.0.1:8080',
      NO_PROXY: '127.0.0.1',
      NODE_USE_ENV_PROXY: '1',
      NODE_EXTRA_CA_CERTS: '/private/runtime/ca.pem',
    })
  })

  it('rejects a command script whose contents do not match the release digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'director-command-identity-'))
    const script = join(root, 'tampered.mjs')
    const previous = process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH
    await writeFile(script, 'process.stdout.write("{}\\n")\n', { mode: 0o600 })
    process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH = script
    try {
      await expect(runDirectorCommand('operate', { action: 'health' }))
        .rejects.toThrow('director_command_identity_mismatch')
    } finally {
      if (previous === undefined) delete process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH
      else process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a command script writable by group or other users', async () => {
    const root = await mkdtemp(join(tmpdir(), 'director-command-permissions-'))
    const script = join(root, 'unsafe.mjs')
    const source = 'process.stdout.write("{}\\n")\n'
    const previousPath = process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH
    const previousDigest = process.env.AIWORKER_DIRECTOR_BRAIN_CLI_SHA256
    await writeFile(script, source, { mode: 0o600 })
    await chmod(script, 0o666)
    process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH = script
    process.env.AIWORKER_DIRECTOR_BRAIN_CLI_SHA256 = createHash('sha256').update(source).digest('hex')
    try {
      await expect(runDirectorCommand('operate', { action: 'health' }))
        .rejects.toThrow('director_command_permissions_invalid')
    } finally {
      if (previousPath === undefined) delete process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH
      else process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH = previousPath
      if (previousDigest === undefined) delete process.env.AIWORKER_DIRECTOR_BRAIN_CLI_SHA256
      else process.env.AIWORKER_DIRECTOR_BRAIN_CLI_SHA256 = previousDigest
      await rm(root, { recursive: true, force: true })
    }
  })

  it('executes the real path of an administrator-pinned command symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'director-command-realpath-'))
    const configuredScript = join(root, 'configured.mjs')
    const source = 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("{}\\n"))\n'
    const previousPath = process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH
    const previousDigest = process.env.AIWORKER_DIRECTOR_BRAIN_CLI_SHA256
    const { scriptPath } = await installDirectorCliFixture(root, source)
    await symlink(scriptPath, configuredScript)
    process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH = configuredScript
    process.env.AIWORKER_DIRECTOR_BRAIN_CLI_SHA256 = createHash('sha256').update(source).digest('hex')
    try {
      await expect(runDirectorCommand('operate', { action: 'health' })).resolves.toEqual({})
    } finally {
      if (previousPath === undefined) delete process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH
      else process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH = previousPath
      if (previousDigest === undefined) delete process.env.AIWORKER_DIRECTOR_BRAIN_CLI_SHA256
      else process.env.AIWORKER_DIRECTOR_BRAIN_CLI_SHA256 = previousDigest
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects drift in the Feishu service imported by the pinned CLI', async () => {
    const root = await mkdtemp(join(tmpdir(), 'director-command-service-drift-'))
    const previous = process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH
    const { scriptPath, servicePath } = await installDirectorCliFixture(root)
    await writeFile(servicePath, 'export const tampered = true\n')
    process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH = scriptPath
    try {
      await expect(runDirectorCommand('operate', { action: 'health' }))
        .rejects.toThrow('director_command_identity_mismatch')
    } finally {
      if (previous === undefined) delete process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH
      else process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects a pinned CLI whose Feishu runtime schema is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'director-command-schema-missing-'))
    const previous = process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH
    const { scriptPath, schemaPath } = await installDirectorCliFixture(root)
    await rm(schemaPath)
    process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH = scriptPath
    try {
      await expect(runDirectorCommand('operate', { action: 'health' }))
        .rejects.toThrow('director_command_path_invalid')
    } finally {
      if (previous === undefined) delete process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH
      else process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects an unsafe library imported by the pinned evidence transformer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'director-transformer-permissions-'))
    const previous = process.env.AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_PATH
    const { scriptPath, libraryPath } = await installDirectorTransformerFixture(root)
    await chmod(libraryPath, 0o666)
    process.env.AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_PATH = scriptPath
    try {
      await expect(runDirectorCommand('transform', {}))
        .rejects.toThrow('director_command_permissions_invalid')
    } finally {
      if (previous === undefined) delete process.env.AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_PATH
      else process.env.AIWORKER_DIRECTOR_EVIDENCE_TRANSFORMER_PATH = previous
      await rm(root, { recursive: true, force: true })
    }
  })

  it('stops retrying deterministic evidence conflicts', async () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    enqueueDirectorEvidenceOutbox(db, parent, 1000)
    const runner = vi.fn(async (command: string) => {
      if (command === 'transform') return { workId: 'WORK-001', items: [{}] }
      throw new Error('evidence_projection_conflict:E-1')
    })
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 1000, runner })).toMatchObject({
      conflict: 1,
    })
    expect(getDirectorEvidenceOutbox(db, parent.taskId)?.status).toBe('conflict')
  })

  it('fails closed before external projection when the parent output digest drifts', async () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    enqueueDirectorEvidenceOutbox(db, parent, 1000)
    db.prepare('UPDATE n8n_task_runs SET output = ? WHERE task_id = ?')
      .run(JSON.stringify(output('漂移')), parent.taskId)
    const runner = vi.fn()
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 1000, runner })).toMatchObject({
      conflict: 1,
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('fails closed before external projection when the authoritative query digest drifts', async () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    enqueueDirectorEvidenceOutbox(db, parent, 1000)
    db.prepare('UPDATE n8n_task_runs SET input = ? WHERE task_id = ?').run(JSON.stringify({
      directorEvidence: { ...binding, queryDigest: 'b'.repeat(64) },
    }), parent.taskId)
    const runner = vi.fn()
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 1000, runner })).toMatchObject({
      conflict: 1,
    })
    expect(getDirectorEvidenceOutbox(db, parent.taskId)).toMatchObject({
      status: 'conflict',
      lastErrorCode: 'director_evidence_authority_conflict',
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('does not report delivered when a concurrent state change defeats the final CAS', async () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    enqueueDirectorEvidenceOutbox(db, parent, 1000)
    const runner = vi.fn(async (command: string) => {
      if (command === 'transform') return { workId: 'WORK-001', items: [{ '证据 ID': 'E-1' }] }
      db.prepare(`
        UPDATE n8n_director_evidence_outbox
        SET status = 'conflict', last_error_code = 'concurrent_guard'
        WHERE task_id = ? AND status = 'pending'
      `).run(parent.taskId)
      return {
        ok: true,
        action: 'project-evidence',
        workId: 'WORK-001',
        count: 1,
        created: 1,
        unchanged: 0,
      }
    })
    await expect(drainDirectorEvidenceOutbox(db, { nowSeconds: 1000, runner }))
      .rejects.toThrow('director_evidence_outbox_state_changed')
    expect(getDirectorEvidenceOutbox(db, parent.taskId)).toMatchObject({
      status: 'conflict', deliveredAt: null, lastErrorCode: 'concurrent_guard',
    })
  })

  it('rejects delivery when an immutable outbox identity changes before the final CAS', async () => {
    const parent = insertParent({ input: { directorEvidence: binding } })
    enqueueDirectorEvidenceOutbox(db, parent, 1000)
    const runner = vi.fn(async (command: string) => {
      if (command === 'transform') return { workId: 'WORK-001', items: [{ '证据 ID': 'E-1' }] }
      db.prepare(`
        UPDATE n8n_director_evidence_outbox
        SET query_digest = ?
        WHERE task_id = ? AND status = 'pending'
      `).run('f'.repeat(64), parent.taskId)
      return {
        ok: true, action: 'project-evidence', workId: 'WORK-001',
        count: 1, created: 1, unchanged: 0,
      }
    })
    await expect(drainDirectorEvidenceOutbox(db, { nowSeconds: 1000, runner }))
      .rejects.toThrow('director_evidence_outbox_state_changed')
    expect(getDirectorEvidenceOutbox(db, parent.taskId)).toMatchObject({
      status: 'pending', queryDigest: 'f'.repeat(64), deliveredAt: null,
    })
  })

  it('resolves a natural-language work name into a server-owned stable binding', async () => {
    const runner = vi.fn(async () => ({
      ok: true,
      action: 'resolve_work',
      found: true,
      work: { workId: 'WORK-001', name: '测试作品' },
    }))
    const resolved = await resolveDirectorWorkBinding('测试作品', { runner })
    expect(resolved).toMatchObject({
      authority: DIRECTOR_EVIDENCE_BINDING_AUTHORITY,
      workId: 'WORK-001',
    })
    expect(resolved.queryDigest).toMatch(/^[a-f0-9]{64}$/u)
    expect(runner).toHaveBeenCalledWith('operate', { action: 'resolve_work', query: '测试作品' })
  })

  it('enqueues atomically from the canonical finalize transaction, including cached replay', () => {
    const parent = insertParent({ status: 'running', input: { directorEvidence: binding }, result: {} })
    const childTaskId = mediaChildIdentity('task', parent.taskId, 'finalize')
    db.prepare(`
      INSERT INTO n8n_task_runs (
        task_id, idempotency_key, binding_id, status, source, requested_by,
        routing, input, delivery, workspace_id, tenant_id
      ) VALUES (?, ?, 7, 'running', 'n8n-media-node', 'test', '{}', '{}', '{"mode":"none"}', 2, 3)
    `).run(childTaskId, childTaskId)

    expect(completeN8nFinalizeRun(db, {
      parentTaskId: parent.taskId,
      childTaskId,
      output: output(),
      nowSeconds: 1000,
    }).outcome).toBe('completed')
    expect(getDirectorEvidenceOutbox(db, parent.taskId)?.status).toBe('pending')
    expect(completeN8nFinalizeRun(db, {
      parentTaskId: parent.taskId,
      childTaskId,
      output: output('ignored replay payload'),
      nowSeconds: 1001,
    }).outcome).toBe('cached')
    expect(getDirectorEvidenceOutboxCounts(db).pending).toBe(1)
  })

  it('rolls back the complete finalize transaction when outbox insertion fails', () => {
    const parent = insertParent({
      taskId: 'video-task-outbox-failure',
      status: 'running',
      input: { directorEvidence: binding },
      result: {},
    })
    const childTaskId = mediaChildIdentity('task', parent.taskId, 'finalize')
    db.prepare(`
      INSERT INTO n8n_task_runs (
        task_id, idempotency_key, binding_id, status, source, requested_by,
        routing, input, delivery, workspace_id, tenant_id
      ) VALUES (?, ?, 7, 'running', 'n8n-media-node', 'test', '{}', '{}', '{"mode":"none"}', 2, 3)
    `).run(childTaskId, childTaskId)
    db.exec(`
      CREATE TRIGGER reject_director_evidence_outbox_insert
      BEFORE INSERT ON n8n_director_evidence_outbox
      BEGIN
        SELECT RAISE(ABORT, 'injected_outbox_insert_failure');
      END;
    `)

    expect(() => completeN8nFinalizeRun(db, {
      parentTaskId: parent.taskId,
      childTaskId,
      output: output(),
      nowSeconds: 1000,
    })).toThrow('injected_outbox_insert_failure')

    expect(getN8nTaskRunByTaskId(db, parent.taskId)).toMatchObject({
      status: 'running',
    })
    expect(getN8nTaskRunByTaskId(db, childTaskId)).toMatchObject({
      status: 'running',
      output: null,
    })
    expect(getDirectorEvidenceOutbox(db, parent.taskId)).toBeNull()
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM n8n_media_cleanup_debts WHERE task_id = ?
    `).get(parent.taskId)).toEqual({ count: 0 })
  })
})
