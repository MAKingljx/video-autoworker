import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import {
  directorEvidenceProjectionContractDigest,
  directorCommandTimeoutMs,
  drainDirectorEvidenceOutbox,
  enqueueDirectorEvidenceOutbox,
  getDirectorEvidenceOutbox,
  runDirectorCommand,
} from '@/lib/director-evidence-outbox'
import {
  directorEvidenceBindingForResolvedWork,
  directorEvidenceDigest,
  getDirectorEvidenceProjectionReceiptCore,
  recoverConflictedDirectorEvidenceProjectionCore,
  type DirectorCommandRunner,
} from '@/lib/director-evidence-delivery-core'
import {
  directorEvidenceFixtureItem,
  directorEvidenceFixtureProjectionResult,
  persistDirectorEvidenceFixtureReceipt,
}
  from '@/lib/__tests__/fixtures/director-evidence'
import { registerDirectorExtractionJob } from '@/lib/director-extraction-runs'
import { getN8nTaskRunByTaskId } from '@/lib/n8n-task-runs'

const scope = { tenantId: 22, workspaceId: 33 }
const binding = directorEvidenceBindingForResolvedWork('WORK-OUTBOX-001', 'root outbox')
const originalScope = {
  tenantId: process.env.MC_OPENCLAW_TENANT_ID,
  workspaceId: process.env.MC_OPENCLAW_WORKSPACE_ID,
}

function output(summary = '人物进入空间。') {
  return {
    taskType: 'video-analysis',
    materialId: 'MAT-OUTBOX-001',
    analysisVersion: 'video-analysis-v3',
    mediaDurationSeconds: 1,
    summary,
    timeline: [{
      index: 1,
      timeRange: '00:00:00-00:00:01',
      visualAnalysis: summary,
      confidence: 0.9,
    }],
  }
}

function seedRoot(db: Database.Database) {
  db.prepare(`
    INSERT INTO n8n_workflow_bindings (
      id, name, webhook_path, task_type, workspace_id, tenant_id
    ) VALUES (22, '视频分析', 'webhook/outbox', 'video-analysis', ?, ?)
  `).run(scope.workspaceId, scope.tenantId)
  db.prepare(`
    INSERT INTO n8n_task_runs (
      task_id, idempotency_key, binding_id, status, source, requested_by,
      routing, input, delivery, output, attempt_count, max_attempts,
      workspace_id, tenant_id, completed_at, updated_at
    ) VALUES ('video-outbox-source', 'video-outbox-source-idem', 22, 'succeeded',
      'openclaw', 'outbox-test', '{"taskType":"video-analysis"}', ?,
      '{"mode":"none"}', ?, 1, 1, ?, ?, 10, 10)
  `).run(JSON.stringify({ directorEvidence: binding }), JSON.stringify(output()), scope.workspaceId, scope.tenantId)
  const registered = registerDirectorExtractionJob(
    db, 'video-outbox-source', scope, { binding },
  )
  return {
    root: getN8nTaskRunByTaskId(db, registered.job.sourceTaskId)!,
    sourceTaskId: registered.job.sourceTaskId,
  }
}

function runner(calls: Array<{ command: string; input: Record<string, unknown> }>): DirectorCommandRunner {
  return async (command, input) => {
    calls.push({ command, input })
    if (command === 'transform') {
      return {
        workId: input.workId,
        items: [directorEvidenceFixtureItem(1, {
          '任务 ID': input.taskId,
          '素材 ID': input.materialId,
        })],
      }
    }
    if (command === 'project-evidence') return directorEvidenceFixtureProjectionResult(input)
    throw new Error('unexpected_command')
  }
}

describe('director evidence root outbox', () => {
  let db: Database.Database

  beforeEach(() => {
    process.env.MC_OPENCLAW_TENANT_ID = String(scope.tenantId)
    process.env.MC_OPENCLAW_WORKSPACE_ID = String(scope.workspaceId)
    db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
    if (originalScope.tenantId === undefined) delete process.env.MC_OPENCLAW_TENANT_ID
    else process.env.MC_OPENCLAW_TENANT_ID = originalScope.tenantId
    if (originalScope.workspaceId === undefined) delete process.env.MC_OPENCLAW_WORKSPACE_ID
    else process.env.MC_OPENCLAW_WORKSPACE_ID = originalScope.workspaceId
  })

  it('recovers a fully verified remote candidate without projection writes or changing the parent', async () => {
    const { root } = seedRoot(db)
    enqueueDirectorEvidenceOutbox(db, root, 100)
    db.prepare(`UPDATE n8n_director_evidence_outbox SET status='conflict', attempt_count=2,
      last_error_code='director_evidence_projection_receipt_invalid' WHERE task_id=?`).run(root.taskId)
    const before = getDirectorEvidenceOutbox(db, root.taskId)!
    const sourceBefore = db.prepare('SELECT * FROM n8n_task_runs WHERE task_id=?').get(root.taskId)
    const item = directorEvidenceFixtureItem(1, { '证据摘要': '人物：停下，观察环境。' })
    const records = (directorEvidenceFixtureProjectionResult({ workId: before.workId, items: [item] })
      .results as Array<{ record: Record<string, unknown> }>).map(entry => entry.record)
    ;(records[0].fields as Record<string, unknown>)['证据摘要'] = '人物:停下,观察环境。'
    const calls: string[] = []
    const readRunner: DirectorCommandRunner = async (command, input) => {
      calls.push(command)
      if (command === 'transform') return { workId: before.workId, items: [item] }
      expect(command).toBe('operate')
      expect(input.action).toBe('get_many')
      return { ok: true, action: 'get_many', table: 'material_evidence', workId: before.workId,
        count: 1, missing: [], records }
    }
    const options = { currentProjectionContractDigest: directorEvidenceProjectionContractDigest(),
      compatibleProjectionContractDigests: [], runner: readRunner, nowSeconds: 101 }
    const result = await recoverConflictedDirectorEvidenceProjectionCore(db, root, options)
    expect(result).toMatchObject({ origin: 'verified_read_recovery', receipt: { entries: [{
      stableId: records[0].stableId,
    }] } })
    expect(getDirectorEvidenceOutbox(db, root.taskId)).toEqual({ ...before,
      status: 'delivered', lastErrorCode: null, deliveredAt: 101, updatedAt: 101 })
    expect(db.prepare('SELECT * FROM n8n_task_runs WHERE task_id=?').get(root.taskId)).toEqual(sourceBefore)
    expect(calls).toEqual(['transform', 'operate', 'operate'])
    expect(records[0]).toMatchObject({ state: '候选', reviewed: false })
    expect(await recoverConflictedDirectorEvidenceProjectionCore(db, root, options)).toBeNull()
    expect(calls).toHaveLength(3)
  })

  it.each(['missing_record', 'changed_content', 'state_changed', 'reviewed_changed', 'remote_version_race', 'source_race', 'attempt_race', 'incompatible_contract'])(
    'leaves failed evidence confirmation untouched on %s', async failure => {
      const { root } = seedRoot(db)
      enqueueDirectorEvidenceOutbox(db, root, 100)
      db.prepare(`UPDATE n8n_director_evidence_outbox SET status='conflict', attempt_count=2,
        last_error_code='director_evidence_projection_receipt_invalid' WHERE task_id=?`).run(root.taskId)
      const before = getDirectorEvidenceOutbox(db, root.taskId)!
      const item = directorEvidenceFixtureItem()
      const records = (directorEvidenceFixtureProjectionResult({ workId: before.workId, items: [item] })
        .results as Array<{ record: Record<string, unknown> }>).map(entry => entry.record)
      let remoteReads = 0
      const readRunner: DirectorCommandRunner = async (command, input) => {
        if (command === 'transform') return { workId: before.workId, items: [item] }
        expect(command).toBe('operate')
        expect(input.action).toBe('get_many')
        remoteReads++
        if (failure === 'state_changed') records[0].state = '失效'
        if (failure === 'reviewed_changed') records[0].reviewed = true
        if (failure === 'remote_version_race' && remoteReads === 2) (records[0].fields as Record<string, unknown>)['版本'] = 'v0.2.99'
        if (failure === 'changed_content') (records[0].fields as Record<string, unknown>)['证据摘要'] = '替换内容'
        if (failure === 'source_race') db.prepare("UPDATE n8n_task_runs SET output='{}' WHERE task_id=?").run(root.taskId)
        if (failure === 'attempt_race') db.prepare('UPDATE n8n_director_evidence_outbox SET attempt_count=3 WHERE task_id=?').run(root.taskId)
        return { ok: true, action: 'get_many', table: 'material_evidence', workId: before.workId,
          count: 1, missing: failure === 'missing_record' ? ['missing'] : [], records }
      }
      await expect(recoverConflictedDirectorEvidenceProjectionCore(db, root, {
        currentProjectionContractDigest: failure === 'incompatible_contract'
          ? 'f'.repeat(64) : directorEvidenceProjectionContractDigest(),
        compatibleProjectionContractDigests: [], runner: readRunner, nowSeconds: 101,
      })).rejects.toThrow()
      expect(getDirectorEvidenceOutbox(db, root.taskId)).toEqual({ ...before,
        attemptCount: failure === 'attempt_race' ? 3 : before.attemptCount })
      expect(getDirectorEvidenceProjectionReceiptCore(db, before)).toBeNull()
    },
  )

  it('scales only bounded propose batches beyond the default operate timeout', () => {
    expect(directorCommandTimeoutMs('operate', { action: 'get', table: 'works' }))
      .toBe(30_000)
    expect(directorCommandTimeoutMs('operate', {
      action: 'get_many', table: 'material_evidence', stableIds: ['EVIDENCE-1'],
    })).toBeNull()
    expect(directorCommandTimeoutMs('operate', {
      action: 'get_many', table: 'material_evidence', stableIds: Array(20).fill('EVIDENCE'),
    })).toBeNull()
    expect(directorCommandTimeoutMs('operate', {
      action: 'get_many', table: 'material_evidence', stableIds: Array(38).fill('EVIDENCE'),
    })).toBeNull()
    expect(directorCommandTimeoutMs('operate', {
      action: 'get_many', table: 'material_evidence', stableIds: Array(50).fill('EVIDENCE'),
    })).toBeNull()
    expect(directorCommandTimeoutMs('operate', {
      action: 'search', table: 'material_evidence', query: '证据',
    })).toBe(30_000)
    expect(directorCommandTimeoutMs('propose-batch', {
      action: 'propose_batch',
      items: Array.from({ length: 8 }, () => ({})),
    })).toBe(150_000)
    expect(directorCommandTimeoutMs('propose-batch', {
      action: 'propose_batch',
      items: Array.from({ length: 50 }, () => ({})),
    })).toBe(180_000)
  })

  it('does not arm the old wall timer and waits for one get_many child to exit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'director-get-many-no-deadline-'))
    const scripts = join(root, 'runtime', 'scripts')
    const library = join(scripts, 'lib')
    const schemaDirectory = join(root, 'runtime', 'ops', 'feishu-director-brain')
    mkdirSync(library, { recursive: true })
    mkdirSync(schemaDirectory, { recursive: true })
    const cli = join(scripts, 'feishu-director-brain.mjs')
    const service = join(library, 'feishu-director-brain.mjs')
    const scanner = join(library, 'sensitive-value-scanner.mjs')
    const schema = join(schemaDirectory, 'schema.json')
    const invocation = join(root, 'invocation.txt')
    writeFileSync(cli, [
      "import { appendFileSync } from 'node:fs'",
      'let input = ""',
      'process.stdin.setEncoding("utf8")',
      'process.stdin.on("data", chunk => { input += chunk })',
      'process.stdin.on("end", () => {',
      `  appendFileSync(${JSON.stringify(invocation)}, 'once\\n')`,
      '  setTimeout(() => {',
      '    const request = JSON.parse(input)',
      '    process.stdout.write(JSON.stringify({ ok: true, action: request.action }))',
      '  }, 75)',
      '})',
    ].join('\n'), { mode: 0o600 })
    writeFileSync(service, 'export {}\n', { mode: 0o600 })
    writeFileSync(scanner, 'export {}\n', { mode: 0o600 })
    writeFileSync(schema, '{}\n', { mode: 0o600 })
    const digest = (pathname: string) => createHash('sha256')
      .update(readFileSync(pathname))
      .digest('hex')
    const keys = [
      'AIWORKER_NODE_BIN', 'AIWORKER_DIRECTOR_BRAIN_CLI_PATH',
      'AIWORKER_DIRECTOR_BRAIN_CLI_SHA256', 'AIWORKER_DIRECTOR_BRAIN_SERVICE_SHA256',
      'AIWORKER_DIRECTOR_BRAIN_SENSITIVE_VALUE_SCANNER_SHA256',
      'AIWORKER_DIRECTOR_BRAIN_SCHEMA_SHA256',
    ] as const
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    const timer = vi.spyOn(globalThis, 'setTimeout')
    try {
      process.env.AIWORKER_NODE_BIN = process.execPath
      process.env.AIWORKER_DIRECTOR_BRAIN_CLI_PATH = cli
      process.env.AIWORKER_DIRECTOR_BRAIN_CLI_SHA256 = digest(cli)
      process.env.AIWORKER_DIRECTOR_BRAIN_SERVICE_SHA256 = digest(service)
      process.env.AIWORKER_DIRECTOR_BRAIN_SENSITIVE_VALUE_SCANNER_SHA256 = digest(scanner)
      process.env.AIWORKER_DIRECTOR_BRAIN_SCHEMA_SHA256 = digest(schema)
      await expect(runDirectorCommand('operate', {
        action: 'get_many', table: 'material_evidence', workId: 'WORK-1',
        stableIds: ['EVIDENCE-1'],
      })).resolves.toMatchObject({ ok: true, action: 'get_many' })
      expect(timer.mock.calls.some(call => call[1] === 30_000)).toBe(false)
      expect(readFileSync(invocation, 'utf8')).toBe('once\n')
    } finally {
      timer.mockRestore()
      for (const key of keys) {
        const value = previous[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('uses the successful video task directly as the immutable outbox authority', async () => {
    const { root, sourceTaskId } = seedRoot(db)
    expect(enqueueDirectorEvidenceOutbox(db, root, 100)).toBe('created')
    expect(enqueueDirectorEvidenceOutbox(db, root, 101)).toBe('existing')
    const item = getDirectorEvidenceOutbox(db, root.taskId)!
    expect(item).toMatchObject({
      taskId: root.taskId,
      bindingId: root.bindingId,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      workId: binding.workId,
      queryDigest: binding.queryDigest,
      resultSha256: directorEvidenceDigest(output()),
      projectionContractDigest: directorEvidenceProjectionContractDigest(),
      status: 'pending',
    })
    expect(getDirectorEvidenceOutbox(db, sourceTaskId)).toMatchObject({ taskId: sourceTaskId })
    expect(db.prepare(`
      SELECT binding_id, tenant_id, workspace_id, work_id, query_digest
      FROM n8n_director_evidence_outbox WHERE task_id = ?
    `).get(root.taskId)).toEqual({
      binding_id: root.bindingId,
      tenant_id: scope.tenantId,
      workspace_id: scope.workspaceId,
      work_id: binding.workId,
      query_digest: binding.queryDigest,
    })

    const calls: Array<{ command: string; input: Record<string, unknown> }> = []
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 101, runner: runner(calls) }))
      .toEqual({ scanned: 1, delivered: 1, pending: 0, conflict: 0 })
    expect(calls[0]).toMatchObject({ command: 'transform', input: { taskId: sourceTaskId } })
    const delivered = getDirectorEvidenceOutbox(db, root.taskId)!
    expect(delivered.status).toBe('delivered')
    expect(getDirectorEvidenceProjectionReceiptCore(db, delivered)?.receipt.workId)
      .toBe(binding.workId)
  })

  it('fails closed without external writes when the source output drifts', async () => {
    const { root, sourceTaskId } = seedRoot(db)
    enqueueDirectorEvidenceOutbox(db, root, 100)
    db.prepare('UPDATE n8n_task_runs SET output = ? WHERE task_id = ?')
      .run(JSON.stringify(output('被篡改的结果')), sourceTaskId)
    const calls: Array<{ command: string; input: Record<string, unknown> }> = []
    expect(await drainDirectorEvidenceOutbox(db, { nowSeconds: 101, runner: runner(calls) }))
      .toEqual({ scanned: 1, delivered: 0, pending: 0, conflict: 1 })
    expect(calls).toHaveLength(0)
    expect(getDirectorEvidenceOutbox(db, root.taskId)).toMatchObject({
      status: 'conflict',
      lastErrorCode: 'director_evidence_authority_conflict',
    })
  })

  it('idempotently accepts the successful video task as the only outbox owner', () => {
    const { root, sourceTaskId } = seedRoot(db)
    const source = getN8nTaskRunByTaskId(db, sourceTaskId)!
    expect(enqueueDirectorEvidenceOutbox(db, source, 100)).toBe('created')
    expect(enqueueDirectorEvidenceOutbox(db, source, 101)).toBe('existing')
    expect(getDirectorEvidenceOutbox(db, root.taskId)).toMatchObject({ taskId: sourceTaskId })
  })

  it('settles concurrent delivery replays once without leaking a unique-key error', async () => {
    db.close()
    const directory = mkdtempSync(join(tmpdir(), 'director-outbox-'))
    const pathname = join(directory, 'outbox.sqlite')
    const first = new Database(pathname)
    const second = new Database(pathname)
    try {
      for (const connection of [first, second]) {
        connection.pragma('foreign_keys = ON')
        connection.pragma('journal_mode = WAL')
        connection.pragma('busy_timeout = 5000')
      }
      runMigrations(first)
      const { root } = seedRoot(first)
      enqueueDirectorEvidenceOutbox(first, root, 100)
      let transforms = 0
      let releaseTransforms: (() => void) | undefined
      const bothSelected = new Promise<void>(resolve => { releaseTransforms = resolve })
      const concurrentRunner: DirectorCommandRunner = async (command, input) => {
        if (command === 'transform') {
          transforms++
          if (transforms === 2) releaseTransforms?.()
          await bothSelected
          return {
            workId: input.workId,
            items: [directorEvidenceFixtureItem(1, {
              '任务 ID': input.taskId,
              '素材 ID': input.materialId,
            })],
          }
        }
        if (command === 'project-evidence') return directorEvidenceFixtureProjectionResult(input)
        throw new Error('unexpected_command')
      }
      const outcomes = await Promise.all([
        drainDirectorEvidenceOutbox(first, { nowSeconds: 101, runner: concurrentRunner }),
        drainDirectorEvidenceOutbox(second, { nowSeconds: 101, runner: concurrentRunner }),
      ])
      expect(outcomes).toEqual([
        { scanned: 1, delivered: 1, pending: 0, conflict: 0 },
        { scanned: 1, delivered: 1, pending: 0, conflict: 0 },
      ])
      expect(getDirectorEvidenceOutbox(first, root.taskId)?.status).toBe('delivered')
      expect(first.prepare(`
        SELECT COUNT(*) FROM n8n_director_evidence_projection_receipts WHERE task_id = ?
      `).pluck().get(root.taskId)).toBe(1)
    } finally {
      first.close()
      second.close()
      rmSync(directory, { recursive: true, force: true })
      db = new Database(':memory:')
    }
  })

  it('makes recovered delivered receipts idempotent and rejects a different receipt', () => {
    const { root, sourceTaskId } = seedRoot(db)
    enqueueDirectorEvidenceOutbox(db, root, 100)
    db.prepare(`
      UPDATE n8n_director_evidence_outbox
      SET status = 'delivered', delivered_at = 101, updated_at = 101
      WHERE task_id = ?
    `).run(root.taskId)
    const item = getDirectorEvidenceOutbox(db, root.taskId)!
    const evidence = [directorEvidenceFixtureItem(1, {
      '任务 ID': sourceTaskId,
      '素材 ID': output().materialId,
    })]
    const first = persistDirectorEvidenceFixtureReceipt(db, item, evidence, 102)
    const replay = persistDirectorEvidenceFixtureReceipt(db, item, evidence, 103)
    expect(replay.receiptSha256).toBe(first.receiptSha256)
    expect(() => persistDirectorEvidenceFixtureReceipt(db, item, [
      directorEvidenceFixtureItem(2, {
        '任务 ID': sourceTaskId,
        '素材 ID': output().materialId,
      }),
    ], 104)).toThrow('director_evidence_projection_receipt_conflict')
  })
})
