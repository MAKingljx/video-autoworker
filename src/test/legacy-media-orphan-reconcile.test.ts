import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'

const repositoryRoot = resolve(__dirname, '../..')
const script = join(repositoryRoot, 'scripts/reconcile-legacy-media-orphan.mjs')
const roots: string[] = []
const toolShaA = '1'.repeat(64)
const toolShaB = '2'.repeat(64)

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function childTaskId(parentTaskId: string, stage: string): string {
  const digest = sha256(`${parentTaskId}:${stage}`).slice(0, 24)
  return `media-task:${parentTaskId.slice(0, 70)}:${stage}:${digest}`.slice(0, 120)
}

function flattedStringify(value: unknown): string {
  const known = new Map<unknown, string>()
  const input: unknown[] = []
  const output: string[] = []
  const reference = (item: unknown) => {
    const existing = known.get(item)
    if (existing !== undefined) return existing
    const index = String(input.push(item) - 1)
    known.set(item, index)
    return index
  }
  reference(value)
  for (let index = 0; index < input.length; index += 1) {
    let root = true
    output[index] = JSON.stringify(input[index], (_key, item) => {
      if (root) { root = false; return item }
      if (item !== null && (typeof item === 'object' || typeof item === 'string')) {
        return reference(item)
      }
      return item
    })
  }
  return `[${output.join(',')}]`
}

function executionData(parentTaskId: string, options: {
  ownerTaskId?: string
  extraItem?: boolean
  arbitraryValue?: string
} = {}): string {
  const idempotencyKey = parentTaskId
  const item = (taskId: string) => ({
    json: {
      headers: { 'x-aiworker-idempotency-key': idempotencyKey },
      body: { taskId, idempotencyKey },
    },
  })
  return flattedStringify({
    executionData: {},
    resultData: {
      runData: {
        'AI-worker Video Webhook': [{
          data: { main: [[
            item(options.ownerTaskId || parentTaskId),
            ...(options.extraItem ? [item(parentTaskId)] : []),
          ]] },
        }],
      },
      arbitrary: options.arbitraryValue,
    },
    resumeToken: null,
    startData: {},
    version: 1,
  })
}

function executable(pathname: string, source: string): void {
  writeFileSync(pathname, source, { mode: 0o700 })
  chmodSync(pathname, 0o700)
}

type Fixture = ReturnType<typeof createFixture>
type ParentFixture = ReturnType<typeof createParentFixture>
type PrepareOutput = {
  mode: 'prepare'
  prepareManifest: string
  confirmationToken: string
  backupManifestSha256: string
}

function createFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-media-orphan-')))
  roots.push(root)
  const tools = join(root, 'tools')
  const backupRoot = join(root, 'backups')
  const batchRoot = join(root, 'batches')
  const missionData = join(root, 'mission-data')
  const n8nData = join(root, 'n8n-data')
  const legacyCwd = join(root, 'application', 'releases', '542eebd-runtime', 'app')
  const n8nCwd = join(root, 'n8n', 'releases', 'a'.repeat(40))
  for (const path of [tools, backupRoot, batchRoot, missionData, n8nData, legacyCwd, n8nCwd]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  const missionPath = join(missionData, 'mission-control.db')
  const missionReplacementPath = join(missionData, 'mission-control-replacement.db')
  const n8nPath = join(n8nData, 'database.sqlite')
  const queuePath = join(root, 'queue.json')
  const statePath = join(root, 'state.json')
  const executablePath = join(tools, 'node')
  executable(executablePath, '#!/bin/sh\nexit 0\n')
  const parentTaskId = 'video-parent-001'
  const stage = 'vision'
  const mediaTaskId = childTaskId(parentTaskId, stage)
  const now = Math.floor(Date.now() / 1_000)
  const updatedAt = now - 3_600

  const mission = new Database(missionPath)
  mission.pragma('journal_mode = WAL')
  mission.pragma('wal_autocheckpoint = 0')
  mission.exec(`
    CREATE TABLE n8n_workflow_bindings (
      id INTEGER PRIMARY KEY, task_type TEXT NOT NULL, workspace_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL
    );
    CREATE TABLE n8n_task_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL UNIQUE, idempotency_key TEXT NOT NULL, binding_id INTEGER NOT NULL,
      status TEXT NOT NULL, source TEXT NOT NULL, requested_by TEXT NOT NULL, routing TEXT NOT NULL,
      input TEXT NOT NULL, delivery TEXT NOT NULL, output TEXT, error TEXT,
      attempt_count INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL, tenant_id INTEGER NOT NULL, created_at INTEGER NOT NULL,
      accepted_at INTEGER, started_at INTEGER, completed_at INTEGER, updated_at INTEGER NOT NULL
    );
    CREATE TABLE n8n_child_execution_leases (
      task_id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL,
      owner_instance_id TEXT NOT NULL, lease_token TEXT NOT NULL, lease_expires_at INTEGER NOT NULL,
      heartbeat_at INTEGER NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `)
  mission.prepare('INSERT INTO n8n_workflow_bindings VALUES (1, ?, 1, 1)').run('video-analysis')
  const insert = mission.prepare(`
    INSERT INTO n8n_task_runs (
      task_id, idempotency_key, binding_id, status, source, requested_by, routing, input, delivery,
      output, error, attempt_count, max_attempts, workspace_id, tenant_id, created_at,
      accepted_at, started_at, completed_at, updated_at
    ) VALUES (?, ?, 1, ?, ?, 'tester', ?, '{}', '{"mode":"none"}', ?, ?, 1, 2, 1, 1, ?, ?, ?, ?, ?)
  `)
  insert.run(
    parentTaskId, 'parent-idem', 'failed', 'openclaw', JSON.stringify({ taskType: 'video-analysis' }),
    null, 'finalize failed', now - 4_000, now - 3_900, null, now - 1_000, now - 1_000,
  )
  insert.run(
    mediaTaskId, 'child-idem', 'running', 'n8n-media-node',
    JSON.stringify({ taskType: 'video-analysis', mediaStage: stage, memoryMode: 'none' }),
    null, null, now - 3_900, now - 3_800, now - 3_700, null, updatedAt,
  )
  const childRowId = Number((mission.prepare('SELECT id FROM n8n_task_runs WHERE task_id = ?')
    .get(mediaTaskId) as { id: number }).id)

  const n8n = new Database(n8nPath)
  n8n.pragma('journal_mode = WAL')
  n8n.pragma('wal_autocheckpoint = 0')
  n8n.exec(`
    CREATE TABLE execution_entity (
      id INTEGER PRIMARY KEY, workflowId TEXT NOT NULL, status TEXT NOT NULL, "stoppedAt" TEXT
    );
    CREATE TABLE execution_data (executionId INTEGER PRIMARY KEY, data TEXT NOT NULL);
  `)
  n8n.prepare('INSERT INTO execution_entity VALUES (65, ?, ?, ?)')
    .run('aiworker-video-analysis-v1', 'error', '2026-08-26 03:49:45.000')
  n8n.prepare('INSERT INTO execution_data VALUES (65, ?)')
    .run(executionData(parentTaskId))
  const replacement = new Database(missionReplacementPath)
  replacement.exec('CREATE TABLE replacement_marker (value TEXT NOT NULL)')
  replacement.close()

  writeFileSync(queuePath, JSON.stringify({
    counts: { attention: 1, running: 0, waiting: 0 },
    queue: [{ taskId: parentTaskId, status: 'accepted', updatedAt, stale: true, sourceAvailable: false }],
    total: 1,
  }), { mode: 0o600 })
  const state = {
    missionPath,
    n8nPath,
    legacyCwd,
    n8nCwd,
    executablePath,
    backupRoot,
    uid: process.getuid?.() ?? 0,
    badMissionIdentity: false,
    swapMissionOnSelfLsof: false,
    swappedMission: false,
    missionReplacementPath,
    disabledStyle: 'words',
    supervisorLoaded: false,
    qwenCurrentLoaded: false,
    qwenCurrentListener: false,
    workers: [] as number[],
    pgrepStatus: 1,
    processInventory: '',
  }
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 })

  const fakeLsof = join(tools, 'lsof')
  executable(fakeLsof, `#!${process.execPath}
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'))
const args = process.argv.slice(2)
if (args.includes('-iTCP:3017')) { process.stdout.write('p1101\\n'); process.exit(0) }
if (args.includes('-iTCP:5678')) { process.stdout.write('p2202\\n'); process.exit(0) }
if (args.includes('-iTCP:18889')) {
  if (state.qwenCurrentListener) { process.stdout.write('p3303\\n'); process.exit(0) }
  process.exit(1)
}
const at = args.indexOf('-p')
const pid = at >= 0 ? Number(args[at + 1]) : 0
const record = (descriptor, pathname, overrideIno) => {
  const value = fs.statSync(pathname, { bigint: true })
  return 'f' + descriptor + '\\nD' + value.dev + '\\ni' + (overrideIno || value.ino) + '\\nn' + pathname + '\\n'
}
let output = ''
if (pid === 1101) {
  const db = fs.statSync(state.missionPath, { bigint: true })
  output += record('cwd', state.legacyCwd) + record('txt', state.executablePath)
    + record('12u', state.missionPath, state.badMissionIdentity ? db.ino + 1n : null)
} else if (pid === 2202) {
  output += record('cwd', state.n8nCwd) + record('txt', state.executablePath) + record('13u', state.n8nPath)
} else {
  if (state.swapMissionOnSelfLsof && !state.swappedMission) {
    fs.renameSync(state.missionPath, state.missionPath + '.captured')
    fs.renameSync(state.missionReplacementPath, state.missionPath)
    state.swappedMission = true
    fs.writeFileSync(process.env.FAKE_STATE, JSON.stringify(state), { mode: 0o600 })
  }
  const result = require('node:child_process').spawnSync('/usr/sbin/lsof', args, { encoding: 'utf8' })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || '')
  process.exit(result.status === null ? 1 : result.status)
}
process.stdout.write(output)
`)
  const fakeLaunchctl = join(tools, 'launchctl')
  executable(fakeLaunchctl, `#!${process.execPath}
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'))
const args = process.argv.slice(2)
if (args[0] === 'print-disabled') {
  const value = state.disabledStyle === 'boolean' ? 'true' : 'disabled'
  process.stdout.write('disabled services = { "ai.aiworker.video-lane-supervisor" => ' + value + ' }\\n'); process.exit(0)
}
const service = args[1] || ''
if (service.endsWith('/com.video-autoworker.n8n')) { process.stdout.write('state = running\\npid = 2000\\n'); process.exit(0) }
if (service.endsWith('/ai.openclaw.qwen-current') && state.qwenCurrentLoaded) {
  process.stdout.write('state = running\\npid = 3303\\n'); process.exit(0)
}
if (service.endsWith('/ai.aiworker.video-lane-supervisor') && state.supervisorLoaded) {
  process.stdout.write('state = running\\npid = 3000\\n'); process.exit(0)
}
process.exit(1)
`)
  const fakePs = join(tools, 'ps')
  executable(fakePs, `#!${process.execPath}
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'))
const args = process.argv.slice(2)
if (args.includes('-axo')) { process.stdout.write(state.processInventory || ''); process.exit(0) }
const at = args.indexOf('-p')
const pid = at >= 0 ? Number(args[at + 1]) : 0
const fieldAt = args.indexOf('-o')
const field = fieldAt >= 0 ? args[fieldAt + 1] : ''
if (field === 'uid=') process.stdout.write(String(state.uid) + '\\n')
else if (field === 'ppid=') process.stdout.write(String(pid === 2202 ? 2000 : 1) + '\\n')
else if (field === 'lstart=') process.stdout.write('Tue Aug 26 11:00:00 2026\\n')
else if (field === 'command=') process.stdout.write(pid === 2202 ? 'node n8n start\\n' : 'node server.js\\n')
else process.exit(2)
`)
  const fakePgrep = join(tools, 'pgrep')
  executable(fakePgrep, `#!${process.execPath}
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'))
if (state.pgrepStatus !== 0) process.exit(state.pgrepStatus)
process.stdout.write(state.workers.join('\\n') + (state.workers.length ? '\\n' : ''))
`)
  const fakeProcPidpath = join(tools, 'proc-pidpath')
  executable(fakeProcPidpath, `#!${process.execPath}
const fs = require('node:fs')
const state = JSON.parse(fs.readFileSync(process.env.FAKE_STATE, 'utf8'))
process.stdout.write(state.executablePath + '\\n')
`)

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: root,
    NODE_ENV: 'test',
    AIWORKER_TEST_LEGACY_ORPHAN: '1',
    AIWORKER_TEST_LEGACY_ORPHAN_LSOF: fakeLsof,
    AIWORKER_TEST_LEGACY_ORPHAN_LAUNCHCTL: fakeLaunchctl,
    AIWORKER_TEST_LEGACY_ORPHAN_PS: fakePs,
    AIWORKER_TEST_LEGACY_ORPHAN_PGREP: fakePgrep,
    AIWORKER_TEST_LEGACY_ORPHAN_PROC_PIDPATH: fakeProcPidpath,
    AIWORKER_TEST_LEGACY_ORPHAN_BATCH_ROOT: batchRoot,
    AIWORKER_TEST_LEGACY_ORPHAN_QUEUE_FILE: queuePath,
    FAKE_STATE: statePath,
  }
  const commonArgs = [
    '--child-row-id', String(childRowId), '--child-task-id', mediaTaskId,
    '--execution-id', '65', '--expected-status', 'running',
    '--expected-updated-at', String(updatedAt), '--minimum-age-seconds', '900',
    '--parent-task-id', parentTaskId, '--stage', stage,
  ]
  const runRaw = (args: string[], extraEnv: Partial<NodeJS.ProcessEnv> = {}) => spawnSync(
    process.execPath,
    [script, ...args],
    { encoding: 'utf8', env: { ...env, ...extraEnv } },
  )
  const run = (extra: string[] = [], extraEnv: Partial<NodeJS.ProcessEnv> = {}) => runRaw(
    [...commonArgs, ...extra],
    extraEnv,
  )
  const writeState = (change: Partial<typeof state>) => {
    Object.assign(state, change)
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 })
  }
  return {
    root, backupRoot, queuePath, missionPath, missionData, n8nPath, mission, n8n,
    parentTaskId, mediaTaskId, childRowId, run, runRaw, writeState,
  }
}

function createParentFixture() {
  const fixture = createFixture()
  const staleUpdatedAt = Math.floor(Date.now() / 1_000) - 2 * 24 * 60 * 60
  fixture.mission.prepare('DELETE FROM n8n_task_runs WHERE task_id = ?').run(fixture.mediaTaskId)
  fixture.mission.prepare(`
    UPDATE n8n_task_runs
    SET idempotency_key = task_id, status = 'accepted', source = 'openclaw',
        routing = '{"taskType":"video-analysis"}', input = '{"request":"private"}',
        delivery = '{"mode":"none"}', output = NULL, error = NULL,
        attempt_count = 0, max_attempts = 2, accepted_at = ?, started_at = NULL,
        completed_at = NULL, updated_at = ?
    WHERE task_id = ?
  `).run(staleUpdatedAt - 60, staleUpdatedAt, fixture.parentTaskId)
  fixture.mission.exec(`
    CREATE TABLE n8n_parent_execution_claims (
      task_id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL
    );
    CREATE TABLE n8n_task_dispatch_leases (
      task_id TEXT PRIMARY KEY, tenant_id INTEGER NOT NULL, workspace_id INTEGER NOT NULL
    );
    CREATE TABLE n8n_media_cleanup_debts (task_id TEXT PRIMARY KEY);
    CREATE TABLE n8n_director_evidence_outbox (task_id TEXT PRIMARY KEY);
  `)
  writeFileSync(fixture.queuePath, JSON.stringify({
    counts: { attention: 1, running: 0, waiting: 0 },
    queue: [{
      taskId: fixture.parentTaskId,
      status: 'accepted',
      updatedAt: staleUpdatedAt,
      stale: true,
      sourceAvailable: null,
      queueOrigin: 'n8n',
    }],
    total: 1,
  }), { mode: 0o600 })
  const runParent = (extra: string[] = [], extraEnv: Partial<NodeJS.ProcessEnv> = {}) => (
    fixture.runRaw(['--parent-pre-media', '--minimum-age-seconds', '86400', ...extra], extraEnv)
  )
  const clearQueueHook = join(fixture.root, 'clear-parent-queue')
  executable(clearQueueHook, `#!${process.execPath}
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(fixture.queuePath)}, JSON.stringify({
  counts: { attention: 0, running: 0, waiting: 0 }, queue: [], total: 0,
}), { mode: 0o600 })
`)
  return { ...fixture, staleUpdatedAt, runParent, clearQueueHook }
}

function createIntakeControl(fixture: ParentFixture, accepting = 0): void {
  fixture.mission.exec(`
    CREATE TABLE n8n_intake_controls (
      control_id INTEGER PRIMARY KEY, accepting INTEGER NOT NULL, reason TEXT NOT NULL,
      changed_by_id INTEGER NOT NULL, changed_by_name TEXT NOT NULL,
      changed_at INTEGER NOT NULL, revision INTEGER NOT NULL
    );
  `)
  fixture.mission.prepare(`
    INSERT INTO n8n_intake_controls VALUES (1, ?, 'managed parent reconciliation', 1, 'tester', ?, 1)
  `).run(accepting, Math.floor(Date.now() / 1_000))
}

function prepare(fixture: Fixture, extraEnv: Partial<NodeJS.ProcessEnv> = {}): PrepareOutput {
  const result = fixture.run(['--prepare', '--backup-root', fixture.backupRoot], extraEnv)
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as PrepareOutput
}

function apply(fixture: Fixture, prepared: PrepareOutput, extraEnv: Partial<NodeJS.ProcessEnv> = {}) {
  return fixture.runRaw([
    '--apply', '--prepare-manifest', prepared.prepareManifest,
    '--confirm-token', prepared.confirmationToken,
  ], extraEnv)
}

function prepareParent(
  fixture: ParentFixture,
  extraEnv: Partial<NodeJS.ProcessEnv> = {},
): PrepareOutput {
  const result = fixture.runParent(['--prepare', '--backup-root', fixture.backupRoot], extraEnv)
  expect(result.status, result.stderr).toBe(0)
  return JSON.parse(result.stdout) as PrepareOutput
}

function mutateImmutableJson(pathname: string, mutate: (value: Record<string, unknown>) => void): void {
  const directory = dirname(pathname)
  chmodSync(directory, 0o700)
  chmodSync(pathname, 0o600)
  const value = JSON.parse(readFileSync(pathname, 'utf8')) as Record<string, unknown>
  mutate(value)
  writeFileSync(pathname, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  chmodSync(pathname, 0o400)
  chmodSync(directory, 0o500)
}

function insertTaskFromParent(
  fixture: ParentFixture,
  taskId: string,
  source: 'n8n-media-node' | 'n8n-node',
  status = 'accepted',
): void {
  fixture.mission.prepare(`
    INSERT INTO n8n_task_runs (
      task_id, idempotency_key, binding_id, status, source, requested_by, routing, input,
      delivery, output, error, attempt_count, max_attempts, workspace_id, tenant_id,
      created_at, accepted_at, started_at, completed_at, updated_at
    )
    SELECT ?, ?, binding_id, ?, ?, requested_by, routing, input, delivery, NULL, NULL,
      0, max_attempts, workspace_id, tenant_id, created_at, accepted_at, NULL, NULL, updated_at
    FROM n8n_task_runs WHERE task_id = ?
  `).run(taskId, `${taskId}-idem`, status, source, fixture.parentTaskId)
}

afterEach(() => {
  const makeWritable = (pathname: string) => {
    chmodSync(pathname, 0o700)
    for (const entry of readdirSync(pathname, { withFileTypes: true })) {
      const child = join(pathname, entry.name)
      if (entry.isDirectory()) makeWritable(child)
      else chmodSync(child, 0o600)
    }
  }
  for (const root of roots.splice(0)) {
    makeWritable(root)
    rmSync(root, { recursive: true, force: true })
  }
})

describe('managed legacy media orphan reconciliation', () => {
  it('durably stages an incomplete backup before copying and exclusively publishes it', () => {
    const source = readFileSync(script, 'utf8')
    const start = source.indexOf('async function createRollbackBackup')
    const end = source.indexOf('\nfunction manifestInput', start)
    const implementation = source.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(implementation.indexOf('mkdirSync(backupDir')).toBeGreaterThan(-1)
    expect(implementation.indexOf('fsyncDirectory(backupRoot)'))
      .toBeGreaterThan(implementation.indexOf('mkdirSync(backupDir)'))
    expect(implementation.indexOf('fsyncDirectory(backupRoot)'))
      .toBeLessThan(implementation.indexOf('copyFileSync('))
    const prepareStart = source.indexOf('async function createPrepare')
    const prepareEnd = source.indexOf('\nfunction validateBackupManifest', prepareStart)
    const prepareImplementation = source.slice(prepareStart, prepareEnd)
    expect(prepareImplementation.indexOf('loadPreparedArtifact(preparePath, true)'))
      .toBeLessThan(prepareImplementation.indexOf('renameDirectoryExclusive('))
    expect(prepareImplementation.indexOf('renameDirectoryExclusive('))
      .toBeLessThan(prepareImplementation.indexOf('loadPreparedArtifact(finalPreparePath)'))
    expect(prepareImplementation.indexOf('loadPreparedArtifact(finalPreparePath)'))
      .toBeLessThan(prepareImplementation.indexOf('confirmationToken('))
    const fsyncStart = source.indexOf('function fsyncDirectory')
    const fsyncEnd = source.indexOf('\nfunction writeImmutableJson', fsyncStart)
    const fsyncImplementation = source.slice(fsyncStart, fsyncEnd)
    expect(fsyncImplementation).toContain('constants.O_DIRECTORY')
    expect(fsyncImplementation).toContain('constants.O_NOFOLLOW')
    expect(fsyncImplementation).toContain('fstatSync(descriptor, { bigint: true })')
    expect(source).toContain('function validateSqliteCapabilities(sqlite)')
    expect(source).toContain("new sqlite.DatabaseSync(':memory:')")
    expect(source).toContain("typeof sqlite.backup !== 'function'")
    expect(source).not.toContain('REQUIRED_NODE_VERSION')
    expect(source).not.toContain('REQUIRED_SQLITE_VERSION')
  })

  it('keeps default dry-run read-only and emits no token or backup', () => {
    const fixture = createFixture()
    try {
      const result = fixture.run()
      expect(result.status, result.stderr).toBe(0)
      const output = JSON.parse(result.stdout)
      expect(output).toMatchObject({ mode: 'dry-run', eligible: true, prepareRequired: true })
      expect(output).not.toHaveProperty('confirmationToken')
      expect(readdirSync(fixture.backupRoot)).toEqual([])
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('accepts historical boolean launchctl disabled-state output', () => {
    const fixture = createFixture()
    try {
      fixture.writeState({ disabledStyle: 'boolean' })
      const result = fixture.run()
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({ mode: 'dry-run', eligible: true })
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('prepares immutable forensic copies and one authoritative rollback snapshot', () => {
    const fixture = createFixture()
    try {
      const output = prepare(fixture)
      const directory = dirname(output.prepareManifest)
      expect(basename(directory)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{9}Z-[a-f0-9]{12}$/u)
      expect(output.prepareManifest).not.toContain('.pending-')
      expect(readdirSync(fixture.backupRoot)).toEqual([basename(directory)])
      expect(statSync(directory).mode & 0o777).toBe(0o500)
      expect(statSync(output.prepareManifest).mode & 0o777).toBe(0o400)
      const prepareManifest = JSON.parse(readFileSync(output.prepareManifest, 'utf8'))
      expect(prepareManifest.schema).toBe('video-autoworker-legacy-media-orphan-prepare/v3')
      expect(prepareManifest.parserBinding).toMatchObject({
        version: expect.stringMatching(/^\d+\.\d+\.\d+$/u),
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        identity: expect.objectContaining({ dev: expect.any(String), ino: expect.any(String) }),
      })
      expect(prepareManifest.databaseRuntimeBinding).toMatchObject({
        kind: 'node:sqlite',
        nodeVersion: process.version,
        sqliteVersion: process.versions.sqlite,
        executable: {
          path: realpathSync(process.execPath),
          bytes: expect.any(Number),
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          identity: expect.objectContaining({ dev: expect.any(String), ino: expect.any(String) }),
        },
      })
      const manifest = JSON.parse(readFileSync(join(directory, 'backup-manifest.json'), 'utf8'))
      expect(manifest.schema).toBe('video-autoworker-legacy-media-orphan-backup/v2')
      expect(manifest.members.filter((item: { role: string }) => item.role === 'forensic')).toHaveLength(3)
      expect(manifest.members.filter((item: { role: string }) => item.role === 'authoritative'))
        .toEqual([expect.objectContaining({ name: 'consistent-snapshot.db' })])
      for (const member of manifest.members as Array<{ name: string; bytes: number; sha256: string }>) {
        const source = readFileSync(join(directory, member.name))
        expect(source.length).toBe(member.bytes)
        expect(sha256(source)).toBe(member.sha256)
        expect(statSync(join(directory, member.name)).mode & 0o777).toBe(0o400)
      }
      const expectedMembers = [
        'backup-manifest.json',
        'consistent-snapshot.db',
        'mission-control.db',
        'mission-control.db-shm',
        'mission-control.db-wal',
        'prepare-manifest.json',
      ].sort()
      expect(readdirSync(directory).sort()).toEqual(expectedMembers)
      const snapshot = new Database(join(directory, 'consistent-snapshot.db'), {
        readonly: true,
        fileMustExist: true,
      })
      expect(snapshot.pragma('journal_mode', { simple: true })).toBe('delete')
      expect(snapshot.pragma('quick_check', { simple: true })).toBe('ok')
      snapshot.close()
      expect(readdirSync(directory).sort()).toEqual(expectedMembers)
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('leaves an ordinary pre-publish failure only in the incomplete pending namespace', () => {
    const fixture = createFixture()
    try {
      const result = fixture.run(
        ['--prepare', '--backup-root', fixture.backupRoot],
        { AIWORKER_TEST_LEGACY_ORPHAN_PREPARE_FAILPOINT: 'raw-copies-created' },
      )
      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('test prepare failpoint reached')
      const entries = readdirSync(fixture.backupRoot)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatch(/^\.pending-/u)
      expect(statSync(join(fixture.backupRoot, entries[0])).mode & 0o777).toBe(0o700)
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it.each([
    'pending-created',
    'raw-copies-created',
    'snapshot-created',
    'backup-manifest-created',
    'before-publish',
  ])('never publishes an incomplete prepare when SIGKILL occurs at %s', failpoint => {
    const fixture = createFixture()
    try {
      const result = fixture.run(
        ['--prepare', '--backup-root', fixture.backupRoot],
        {
          AIWORKER_TEST_LEGACY_ORPHAN_PREPARE_FAILPOINT: failpoint,
          AIWORKER_TEST_LEGACY_ORPHAN_FAILPOINT_ACTION: 'sigkill',
        },
      )
      expect(result.status).toBeNull()
      expect(result.signal).toBe('SIGKILL')
      expect(result.stdout).toBe('')
      const entries = readdirSync(fixture.backupRoot)
      expect(entries).toHaveLength(1)
      expect(entries[0]).toMatch(/^\.pending-/u)
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('leaves a fully verifiable final backup if SIGKILL occurs after exclusive publish', () => {
    const fixture = createFixture()
    try {
      const result = fixture.run(
        ['--prepare', '--backup-root', fixture.backupRoot],
        {
          AIWORKER_TEST_LEGACY_ORPHAN_PREPARE_FAILPOINT: 'after-publish',
          AIWORKER_TEST_LEGACY_ORPHAN_FAILPOINT_ACTION: 'sigkill',
        },
      )
      expect(result.status).toBeNull()
      expect(result.signal).toBe('SIGKILL')
      expect(result.stdout).toBe('')
      const entries = readdirSync(fixture.backupRoot)
      expect(entries).toHaveLength(1)
      expect(entries[0]).not.toMatch(/^\.pending-/u)
      const directory = join(fixture.backupRoot, entries[0])
      expect(readdirSync(directory).sort()).toEqual([
        'backup-manifest.json',
        'consistent-snapshot.db',
        'mission-control.db',
        'mission-control.db-shm',
        'mission-control.db-wal',
        'prepare-manifest.json',
      ])
      const snapshot = new Database(join(directory, 'consistent-snapshot.db'), {
        readonly: true,
        fileMustExist: true,
      })
      expect(snapshot.pragma('journal_mode', { simple: true })).toBe('delete')
      expect(snapshot.pragma('quick_check', { simple: true })).toBe('ok')
      snapshot.close()
      expect(readdirSync(directory)).not.toContain('consistent-snapshot.db-journal')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('does not overwrite or nest into a final destination created after the absence check', () => {
    const fixture = createFixture()
    try {
      const result = fixture.run(
        ['--prepare', '--backup-root', fixture.backupRoot],
        { AIWORKER_TEST_LEGACY_ORPHAN_OCCUPY_FINAL: '1' },
      )
      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(result.stderr.trim()).toMatch(
        /^legacy media orphan reconciliation failed: exclusive directory rename failed: errno=\d{1,5} strerror=[\p{L}\p{N} .,:'()_-]{1,120}$/u,
      )
      expect(result.stderr).not.toContain(fixture.root)
      const entries = readdirSync(fixture.backupRoot).sort()
      expect(entries).toHaveLength(2)
      const pending = entries.find(name => name.startsWith('.pending-'))
      const occupied = entries.find(name => !name.startsWith('.pending-'))
      expect(pending).toBeTruthy()
      expect(occupied).toBeTruthy()
      expect(readdirSync(join(fixture.backupRoot, occupied!))).toEqual(['do-not-overwrite'])
      expect(readFileSync(join(fixture.backupRoot, occupied!, 'do-not-overwrite'), 'utf8'))
        .toBe('occupied\n')
      expect(readdirSync(join(fixture.backupRoot, occupied!))).not.toContain(pending!)
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('fingerprints multi-chunk SQLite members without loading an entire database member', () => {
    const fixture = createFixture()
    try {
      fixture.mission.exec('CREATE TABLE fingerprint_payload (value BLOB NOT NULL)')
      fixture.mission.prepare('INSERT INTO fingerprint_payload VALUES (zeroblob(?))').run(3 * 1024 * 1024)
      const output = prepare(fixture)
      const manifest = JSON.parse(readFileSync(
        join(dirname(output.prepareManifest), 'backup-manifest.json'),
        'utf8',
      )) as { members: Array<{ bytes: number; sha256: string }> }
      expect(manifest.members.some(member => member.bytes > 1024 * 1024)).toBe(true)
      expect(manifest.members.every(member => /^[a-f0-9]{64}$/u.test(member.sha256))).toBe(true)
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('applies only an existing prepare and does not create a second backup', () => {
    const fixture = createFixture()
    try {
      const prepared = prepare(fixture)
      const before = readdirSync(fixture.backupRoot)
      const result = apply(fixture, prepared)
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: 'apply', reconciled: true, handoffReady: false, releaseDecision: 'NO-GO',
        backupManifestSha256: prepared.backupManifestSha256,
      })
      expect(readdirSync(fixture.backupRoot)).toEqual(before)
      const child = fixture.mission.prepare('SELECT status, error FROM n8n_task_runs WHERE id = ?')
        .get(fixture.childRowId) as { status: string; error: string }
      expect(child.status).toBe('failed')
      expect(child.error).toContain('LEGACY_MEDIA_ORPHAN_RECONCILED')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('catches a completed n8n execution created before the child writer reservation', () => {
    const fixture = createFixture()
    try {
      const prepared = prepare(fixture)
      const hook = join(fixture.root, 'insert-child-gap-execution')
      executable(hook, `#!/bin/sh
/usr/bin/sqlite3 ${JSON.stringify(fixture.n8nPath)} "INSERT INTO execution_entity VALUES (66, 'other-workflow', 'success', '2026-09-04 20:00:00.000')"
`)
      const result = apply(fixture, prepared, {
        AIWORKER_TEST_LEGACY_ORPHAN_AFTER_MISSION_LOCK_COMMAND: hook,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('n8n execution changed after confirmation')
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE id = ?')
        .get(fixture.childRowId) as { status: string }).status).toBe('running')
      expect((fixture.n8n.prepare('SELECT status FROM execution_entity WHERE id = 66')
        .get() as { status: string }).status).toBe('success')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('holds the child n8n writer reservation until the Mission Control CAS commits', () => {
    const fixture = createFixture()
    try {
      const prepared = prepare(fixture)
      const hook = join(fixture.root, 'prove-child-n8n-writer-reservation')
      executable(hook, `#!/bin/sh
if /usr/bin/sqlite3 ${JSON.stringify(fixture.n8nPath)} "PRAGMA busy_timeout=100; INSERT INTO execution_entity VALUES (66, 'other-workflow', 'running', NULL)" >/dev/null 2>&1; then
  exit 91
fi
exit 0
`)
      const result = apply(fixture, prepared, {
        AIWORKER_TEST_LEGACY_ORPHAN_AFTER_DUAL_LOCK_COMMAND: hook,
      })
      expect(result.status, result.stderr).toBe(0)
      expect(fixture.n8n.prepare('SELECT id FROM execution_entity WHERE id = 66').get()).toBeUndefined()
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE id = ?')
        .get(fixture.childRowId) as { status: string }).status).toBe('failed')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rejects apply common arguments and forged confirmation tokens', () => {
    const fixture = createFixture()
    try {
      const prepared = prepare(fixture)
      expect(fixture.runRaw([
        '--apply', '--prepare-manifest', prepared.prepareManifest,
        '--confirm-token', prepared.confirmationToken, '--stage', 'vision',
      ]).status).not.toBe(0)
      const forged = fixture.runRaw([
        '--apply', '--prepare-manifest', prepared.prepareManifest,
        '--confirm-token', `confirm-${'0'.repeat(64)}`,
      ])
      expect(forged.status).not.toBe(0)
      expect(forged.stderr).toContain('confirmation token')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it.each([
    ['old prepare schema', (_fixture: Fixture, output: PrepareOutput) => mutateImmutableJson(
      output.prepareManifest, value => {
        value.schema = 'video-autoworker-legacy-media-orphan-prepare/v2'
      },
    ), 'invalid or expired'],
    ['expired prepare', (_fixture: Fixture, output: PrepareOutput) => mutateImmutableJson(
      output.prepareManifest, value => { value.createdAt = 1; value.expiresAt = 601 },
    ), 'invalid or expired'],
    ['prepare tamper', (_fixture: Fixture, output: PrepareOutput) => mutateImmutableJson(
      output.prepareManifest, value => { value.handoffNonce = 'f'.repeat(64) },
    ), 'confirmation token'],
    ['backup member tamper', (_fixture: Fixture, output: PrepareOutput) => {
      const pathname = join(dirname(output.prepareManifest), 'consistent-snapshot.db')
      chmodSync(dirname(pathname), 0o700)
      chmodSync(pathname, 0o600)
      writeFileSync(pathname, Buffer.from('tampered'))
      chmodSync(pathname, 0o400)
      chmodSync(dirname(pathname), 0o500)
    }, 'backup member'],
  ])('rejects %s', (_label, mutate, expected) => {
    const fixture = createFixture()
    try {
      const output = prepare(fixture)
      mutate(fixture, output)
      const result = apply(fixture, output)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(expected)
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rejects every unmanifested prepare-directory member before apply', () => {
    const fixture = createFixture()
    try {
      const output = prepare(fixture)
      const directory = dirname(output.prepareManifest)
      for (const name of [
        'consistent-snapshot.db-wal',
        'consistent-snapshot.db-shm',
        'consistent-snapshot.db-journal',
        '.hidden-temporary-member',
        'unexpected-directory',
      ]) {
        const pathname = join(directory, name)
        chmodSync(directory, 0o700)
        if (name === 'unexpected-directory') mkdirSync(pathname, { mode: 0o700 })
        else writeFileSync(pathname, Buffer.alloc(0), { mode: 0o400 })
        chmodSync(directory, 0o500)
        const result = apply(fixture, output)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('prepare directory member set is invalid')
        chmodSync(directory, 0o700)
        rmSync(pathname, { recursive: true })
        chmodSync(directory, 0o500)
      }
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rejects a complete prepare that remains in the incomplete pending namespace', () => {
    const fixture = createFixture()
    try {
      const output = prepare(fixture)
      const finalDirectory = dirname(output.prepareManifest)
      const pendingDirectory = join(fixture.backupRoot, `.pending-${basename(finalDirectory)}`)
      chmodSync(finalDirectory, 0o700)
      renameSync(finalDirectory, pendingDirectory)
      chmodSync(pendingDirectory, 0o500)
      const result = apply(fixture, {
        ...output,
        prepareManifest: join(pendingDirectory, 'prepare-manifest.json'),
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('not in a managed backup directory')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rejects a manifested backup member with an unsafe hard-link count', () => {
    const fixture = createFixture()
    try {
      const output = prepare(fixture)
      const pathname = join(dirname(output.prepareManifest), 'consistent-snapshot.db')
      linkSync(pathname, join(fixture.root, 'unexpected-snapshot-hardlink'))
      const result = apply(fixture, output)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('link count is unsafe')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rejects tool and live row drift after prepare', () => {
    const toolFixture = createFixture()
    try {
      const prepared = prepare(toolFixture, { AIWORKER_TEST_LEGACY_ORPHAN_TOOL_SHA: toolShaA })
      const result = apply(toolFixture, prepared, { AIWORKER_TEST_LEGACY_ORPHAN_TOOL_SHA: toolShaB })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('tool changed')
    } finally { toolFixture.mission.close(); toolFixture.n8n.close() }
    const rowFixture = createFixture()
    try {
      const prepared = prepare(rowFixture)
      rowFixture.mission.prepare('UPDATE n8n_task_runs SET updated_at = updated_at + 1 WHERE id = ?')
        .run(rowFixture.childRowId)
      const result = apply(rowFixture, prepared)
      expect(result.status).not.toBe(0)
    } finally { rowFixture.mission.close(); rowFixture.n8n.close() }
  })

  it('rejects an old prepare token when only a transitive local tool dependency changes', () => {
    const fixture = createFixture()
    try {
      const toolEntry = join(fixture.root, 'tool-entry.mjs')
      const directDependency = join(fixture.root, 'direct-dependency.mjs')
      const transitiveDependency = join(fixture.root, 'transitive-dependency.mjs')
      writeFileSync(toolEntry, "import './direct-dependency.mjs'\n", { mode: 0o600 })
      writeFileSync(
        directDependency,
        "export { dependencyValue } from './transitive-dependency.mjs'\n",
        { mode: 0o600 },
      )
      writeFileSync(transitiveDependency, 'export const dependencyValue = 1\n', { mode: 0o600 })
      const toolEnvironment = { AIWORKER_TEST_LEGACY_ORPHAN_TOOL_CLOSURE_ROOT: toolEntry }
      const prepared = prepare(fixture, toolEnvironment)
      writeFileSync(transitiveDependency, 'export const dependencyValue = 2\n', { mode: 0o600 })
      const result = apply(fixture, prepared, toolEnvironment)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('entry or dependency closure')
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE id = ?')
        .get(fixture.childRowId) as { status: string }).status).toBe('running')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('hashes every static import when multiple imports share one source line', () => {
    const fixture = createFixture()
    try {
      const toolEntry = join(fixture.root, 'same-line-entry.mjs')
      const firstDependency = join(fixture.root, 'same-line-first.mjs')
      const secondDependency = join(fixture.root, 'same-line-second.mjs')
      writeFileSync(
        toolEntry,
        "import './same-line-first.mjs'; import './same-line-second.mjs'\n",
        { mode: 0o600 },
      )
      writeFileSync(firstDependency, 'export const first = 1\n', { mode: 0o600 })
      writeFileSync(secondDependency, 'export const second = 1\n', { mode: 0o600 })
      const toolEnvironment = { AIWORKER_TEST_LEGACY_ORPHAN_TOOL_CLOSURE_ROOT: toolEntry }
      const prepared = prepare(fixture, toolEnvironment)
      writeFileSync(secondDependency, 'export const second = 2\n', { mode: 0o600 })
      const result = apply(fixture, prepared, toolEnvironment)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('entry or dependency closure')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it.each([
    'media-ingest.mjs',
    'director-work-policy.mjs',
    'media-policy.mjs',
  ])('binds the real video-batch-state closure when only %s changes', dependencyName => {
    const fixture = createFixture()
    try {
      const closureRoot = join(fixture.root, 'tool-closure')
      mkdirSync(closureRoot, { mode: 0o700 })
      const sourceRoot = join(repositoryRoot, 'openclaw-skills/aiworker-task-flow/lib')
      for (const name of [
        'video-batch-state.mjs',
        'media-ingest.mjs',
        'director-work-policy.mjs',
        'media-policy.mjs',
      ]) {
        copyFileSync(join(sourceRoot, name), join(closureRoot, name))
      }
      const toolEntry = join(closureRoot, 'tool-entry.mjs')
      writeFileSync(toolEntry, "import './video-batch-state.mjs'\n", { mode: 0o600 })
      const toolEnvironment = { AIWORKER_TEST_LEGACY_ORPHAN_TOOL_CLOSURE_ROOT: toolEntry }
      const prepared = prepare(fixture, toolEnvironment)
      const dependencyPath = join(closureRoot, dependencyName)
      writeFileSync(
        dependencyPath,
        `${readFileSync(dependencyPath, 'utf8')}\n// dependency-only drift\n`,
      )
      const result = apply(fixture, prepared, toolEnvironment)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('entry or dependency closure')
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE id = ?')
        .get(fixture.childRowId) as { status: string }).status).toBe('running')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it.each([
    ['comment-separated dynamic import', "await import/*comment*/('./dependency.mjs')\n", 'dynamic'],
    ['query import', "import './dependency.mjs?variant=changed'\n", 'specifier'],
  ])('fails closed for an unsupported %s in the tool closure', (_label, entrySource, expected) => {
    const fixture = createFixture()
    try {
      const toolEntry = join(fixture.root, 'unsupported-tool-entry.mjs')
      writeFileSync(toolEntry, entrySource, { mode: 0o600 })
      writeFileSync(join(fixture.root, 'dependency.mjs'), 'export const value = 1\n', { mode: 0o600 })
      const result = fixture.run(
        ['--prepare', '--backup-root', fixture.backupRoot],
        { AIWORKER_TEST_LEGACY_ORPHAN_TOOL_CLOSURE_ROOT: toolEntry },
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(expected)
      expect(readdirSync(fixture.backupRoot)).toEqual([])
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it.each(['absolute path', 'file URL'])('fails closed for a local %s import', kind => {
    const fixture = createFixture()
    try {
      const toolEntry = join(fixture.root, 'unsupported-local-entry.mjs')
      const dependency = join(fixture.root, 'unsupported-local-dependency.mjs')
      const specifier = kind === 'file URL' ? pathToFileURL(dependency).href : dependency
      writeFileSync(toolEntry, `import ${JSON.stringify(specifier)}\n`, { mode: 0o600 })
      writeFileSync(dependency, 'export const value = 1\n', { mode: 0o600 })
      const result = fixture.run(
        ['--prepare', '--backup-root', fixture.backupRoot],
        { AIWORKER_TEST_LEGACY_ORPHAN_TOOL_CLOSURE_ROOT: toolEntry },
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('specifier is unsupported')
      expect(readdirSync(fixture.backupRoot)).toEqual([])
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rejects createRequire in a non-entry closure member before creating a backup', () => {
    const fixture = createFixture()
    try {
      const toolEntry = join(fixture.root, 'runtime-loader-entry.mjs')
      const dependency = join(fixture.root, 'runtime-loader-dependency.mjs')
      writeFileSync(toolEntry, "import './runtime-loader-dependency.mjs'\n", { mode: 0o600 })
      writeFileSync(dependency, `
import { createRequire } from 'node:module'
export const localRequire = createRequire(import.meta.url)
`, { mode: 0o600 })
      const result = fixture.run(
        ['--prepare', '--backup-root', fixture.backupRoot],
        { AIWORKER_TEST_LEGACY_ORPHAN_TOOL_CLOSURE_ROOT: toolEntry },
      )
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('runtime createRequire module loading is unsupported')
      expect(readdirSync(fixture.backupRoot)).toEqual([])
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it.each([
    ['substring execution binding', (fixture: Fixture) => fixture.n8n.prepare(
      'UPDATE execution_data SET data = ? WHERE executionId = 65',
    ).run(executionData(fixture.parentTaskId, {
      ownerTaskId: 'other-parent', arbitraryValue: `prefix-${fixture.parentTaskId}-suffix`,
    })), 'not uniquely owned'],
    ['unrelated exact execution string', (fixture: Fixture) => fixture.n8n.prepare(
      'UPDATE execution_data SET data = ? WHERE executionId = 65',
    ).run(executionData(fixture.parentTaskId, {
      ownerTaskId: 'other-parent', arbitraryValue: fixture.parentTaskId,
    })), 'not uniquely owned'],
    ['duplicate webhook owner items', (fixture: Fixture) => fixture.n8n.prepare(
      'UPDATE execution_data SET data = ? WHERE executionId = 65',
    ).run(executionData(fixture.parentTaskId, {
      ownerTaskId: fixture.parentTaskId, extraItem: true,
    })), 'not uniquely owned'],
    ['duplicate execution key', (fixture: Fixture) => fixture.n8n.prepare(
      'UPDATE execution_data SET data = ? WHERE executionId = 65',
    ).run(`{"task":"${fixture.parentTaskId}","task":"${fixture.parentTaskId}"}`), 'duplicate JSON key'],
    ['duplicate queue key', (fixture: Fixture) => writeFileSync(
      fixture.queuePath,
      '{"counts":{"attention":1,"running":0,"waiting":0},"counts":{"attention":1,"running":0,"waiting":0},"queue":[],"total":0}',
      { mode: 0o600 },
    ), 'duplicate JSON key'],
    ['oversized queue JSON', (fixture: Fixture) => writeFileSync(
      fixture.queuePath, ' '.repeat(16 * 1024 * 1024 + 1), { mode: 0o600 },
    ), 'too large'],
  ])('rejects %s', (_label, mutate, expected) => {
    const fixture = createFixture()
    try {
      mutate(fixture)
      const result = fixture.run()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(expected)
      expect(readdirSync(fixture.backupRoot)).toEqual([])
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it.each([
    ['forged database FD', (fixture: Fixture) => fixture.writeState({ badMissionIdentity: true }), 'open-file identity'],
    ['pgrep failure', (fixture: Fixture) => fixture.writeState({ pgrepStatus: 2 }), 'process query failed'],
    ['loaded supervisor', (fixture: Fixture) => fixture.writeState({ supervisorLoaded: true }), 'supervisor'],
    ['live worker', (fixture: Fixture) => fixture.writeState({ pgrepStatus: 0, workers: [9001] }), 'supervisor'],
    ['active execution', (fixture: Fixture) => fixture.n8n.prepare(
      'INSERT INTO execution_entity VALUES (66, ?, ?, NULL)',
    ).run('aiworker-video-analysis-v1', 'running'), 'active executions'],
  ])('fails closed for %s', (_label, mutate, expected) => {
    const fixture = createFixture()
    try {
      mutate(fixture)
      const result = fixture.run()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(expected)
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rejects a capture-to-open database inode swap even when the pathname is restored', () => {
    const fixture = createFixture()
    try {
      fixture.writeState({ swapMissionOnSelfLsof: true })
      const result = fixture.run()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('precaptured identity')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('does not recreate any database-family member when the writable path disappears before open', () => {
    const fixture = createFixture()
    try {
      const prepared = prepare(fixture)
      const capturedPath = `${fixture.missionPath}.captured`
      const capturedHash = sha256(readFileSync(fixture.missionPath))
      const hook = join(fixture.root, 'remove-database-family-before-writable-open')
      executable(hook, `#!${process.execPath}
const fs = require('node:fs')
const source = ${JSON.stringify(fixture.missionPath)}
const captured = ${JSON.stringify(capturedPath)}
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  if (fs.existsSync(source + suffix)) fs.renameSync(source + suffix, captured + suffix)
}
`)

      const result = apply(fixture, prepared, {
        AIWORKER_TEST_LEGACY_ORPHAN_BEFORE_WRITABLE_DATABASE_OPEN_COMMAND: hook,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('unable to open database file')
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        expect(existsSync(fixture.missionPath + suffix)).toBe(false)
      }
      expect(sha256(readFileSync(capturedPath))).toBe(capturedHash)
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE id = ?')
        .get(fixture.childRowId) as { status: string }).status).toBe('running')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('leaves a replacement database and its sidecar set unchanged when writable identity changes', () => {
    const fixture = createFixture()
    try {
      const prepared = prepare(fixture)
      const replacementPath = join(fixture.missionData, 'mission-control-replacement.db')
      const replacementHash = sha256(readFileSync(replacementPath))
      const capturedPath = `${fixture.missionPath}.captured`
      const hook = join(fixture.root, 'replace-database-before-writable-open')
      executable(hook, `#!${process.execPath}
const fs = require('node:fs')
const source = ${JSON.stringify(fixture.missionPath)}
const captured = ${JSON.stringify(capturedPath)}
const replacement = ${JSON.stringify(replacementPath)}
for (const suffix of ['', '-wal', '-shm', '-journal']) {
  if (fs.existsSync(source + suffix)) fs.renameSync(source + suffix, captured + suffix)
}
fs.renameSync(replacement, source)
`)

      const result = apply(fixture, prepared, {
        AIWORKER_TEST_LEGACY_ORPHAN_BEFORE_WRITABLE_DATABASE_OPEN_COMMAND: hook,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('precaptured identity')
      expect(sha256(readFileSync(fixture.missionPath))).toBe(replacementHash)
      expect(readdirSync(fixture.missionData).filter(name => (
        name === 'mission-control.db' || name.startsWith('mission-control.db-')
      ))).toEqual(['mission-control.db'])
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE id = ?')
        .get(fixture.childRowId) as { status: string }).status).toBe('running')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('fails closed for non-ENOENT workspace lstat and backup overlap', () => {
    const fixture = createFixture()
    try {
      const workspace = join(dirname(fixture.missionPath), 'media-tasks', sha256(fixture.parentTaskId))
      const lstatFailure = fixture.run([], { AIWORKER_TEST_LEGACY_ORPHAN_LSTAT_ERROR_PATH: workspace })
      expect(lstatFailure.status).not.toBe(0)
      expect(lstatFailure.stderr).toContain('workspace state is unreadable')
      const overlap = fixture.run(['--prepare', '--backup-root', fixture.missionData])
      expect(overlap.status).not.toBe(0)
      expect(overlap.stderr).toContain('overlaps')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rechecks inside the write boundary and refuses a newly appeared workspace', () => {
    const fixture = createFixture()
    try {
      const prepared = prepare(fixture)
      const workspace = join(dirname(fixture.missionPath), 'media-tasks', sha256(fixture.parentTaskId))
      const hook = join(fixture.root, 'before-write')
      executable(hook, `#!${process.execPath}\nrequire('node:fs').mkdirSync(${JSON.stringify(workspace)}, { recursive: true })\n`)
      const result = apply(fixture, prepared, { AIWORKER_TEST_LEGACY_ORPHAN_BEFORE_WRITE_COMMAND: hook })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('workspace still exists')
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE id = ?')
        .get(fixture.childRowId) as { status: string }).status).toBe('running')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })
})

describe('managed stale parent pre-media reconciliation', () => {
  it('auto-binds the sole parent without exposing a business identity in dry-run output', () => {
    const fixture = createParentFixture()
    try {
      const result = fixture.runParent()
      expect(result.status, result.stderr).toBe(0)
      expect(JSON.parse(result.stdout)).toEqual({
        mode: 'dry-run', eligible: true, targetKind: 'parent-pre-media', prepareRequired: true,
      })
      expect(result.stdout).not.toContain(fixture.parentTaskId)
      expect(result.stdout).not.toContain(fixture.mediaTaskId)
      expect(result.stdout).not.toContain('confirmationToken')
      expect(readdirSync(fixture.backupRoot)).toEqual([])
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rejects every command-line business identifier in parent mode', () => {
    const fixture = createParentFixture()
    try {
      for (const args of [
        ['--parent-task-id', fixture.parentTaskId],
        ['--child-task-id', fixture.mediaTaskId],
        ['--child-row-id', '1'],
        ['--execution-id', '65'],
      ]) {
        const result = fixture.runParent(args)
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain('does not accept business identifiers')
      }
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('accepts a paused newer intake-control row as an additional legacy freeze gate', () => {
    const fixture = createParentFixture()
    try {
      createIntakeControl(fixture)
      const result = fixture.runParent()
      expect(result.status, result.stderr).toBe(0)
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it.each([
    ['loaded qwen-current Gateway job', { qwenCurrentLoaded: true }],
    ['qwen-current Gateway listener', { qwenCurrentListener: true }],
    ['matching qwen-current Gateway process', {
      processInventory: '3303 1 openclaw gateway --profile qwen-current --port 18889\n',
    }],
    ['active durable submit process', {
      processInventory: '4404 1 node /installed/aiworker-task-flow/scripts/submit-task.mjs --video-file /private/input.mp4\n',
    }],
    ['active material handoff process', {
      processInventory: '5505 1 node /installed/material-handoff.mjs --resume\n',
    }],
  ])('requires official legacy ingress freeze proof: %s', (_label, change) => {
    const fixture = createParentFixture()
    try {
      fixture.writeState(change)
      const result = fixture.runParent()
      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it.each([
    ['durable source', { sourceAvailable: true }],
    ['non-n8n queue origin', { queueOrigin: 'other' }],
  ])('rejects a parent queue item with %s', (_label, change) => {
    const fixture = createParentFixture()
    try {
      const queue = JSON.parse(readFileSync(fixture.queuePath, 'utf8')) as {
        queue: Array<Record<string, unknown>>
      }
      Object.assign(queue.queue[0], change)
      writeFileSync(fixture.queuePath, JSON.stringify(queue), { mode: 0o600 })
      const result = fixture.runParent()
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('stale non-durable accepted parent')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('prepares an authoritative old-row snapshot and applies exactly the four-field transition', () => {
    const fixture = createParentFixture()
    try {
      const before = fixture.mission.prepare('SELECT * FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as Record<string, unknown>
      const prepared = prepareParent(fixture)
      expect(prepared.prepareManifest).not.toContain(fixture.parentTaskId)
      const snapshot = new Database(join(dirname(prepared.prepareManifest), 'consistent-snapshot.db'), {
        readonly: true,
        fileMustExist: true,
      })
      const saved = snapshot.prepare('SELECT * FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId)
      expect(saved).toEqual(before)
      expect(snapshot.pragma('quick_check', { simple: true })).toBe('ok')
      snapshot.close()

      const result = apply(fixture, prepared, {
        AIWORKER_TEST_LEGACY_ORPHAN_AFTER_COMMIT_COMMAND: fixture.clearQueueHook,
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).not.toContain(fixture.parentTaskId)
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: 'apply', reconciled: true, targetKind: 'parent-pre-media',
        handoffReady: false, releaseDecision: 'NO-GO',
      })
      const after = fixture.mission.prepare('SELECT * FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as Record<string, unknown>
      expect(after.status).toBe('failed')
      expect(after.error).toBe(
        '[VIDEO_CALLBACK_LEASE_EXPIRED] n8n 视频任务已受理，但在 86400 秒内未建立媒体处理阶段',
      )
      expect(after.completed_at).toBe(after.updated_at)
      const restored = {
        ...after,
        status: before.status,
        error: before.error,
        completed_at: before.completed_at,
        updated_at: before.updated_at,
      }
      expect(restored).toEqual(before)
      expect(JSON.parse(readFileSync(fixture.queuePath, 'utf8'))).toMatchObject({
        counts: { attention: 0, waiting: 0, running: 0 }, total: 0,
      })
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rejects runtime dependency drift before the changed module top level can execute', () => {
    const fixture = createParentFixture()
    try {
      const runtimeModule = join(fixture.root, 'verified-submission-lock.mjs')
      const canary = join(fixture.root, 'runtime-drift-canary')
      writeFileSync(runtimeModule, `
export async function acquireVideoSubmissionLock() {
  return { acquired: true, async release() {} }
}
`, { mode: 0o600 })
      const environment = {
        AIWORKER_TEST_LEGACY_ORPHAN_TOOL_RUNTIME_ROOT: runtimeModule,
      }
      const prepared = prepareParent(fixture, environment)
      const driftedSource = `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(canary)}, 'executed\\n', { mode: 0o600 })
export async function acquireVideoSubmissionLock() {
  return { acquired: true, async release() {} }
}
`
      const mutateRuntime = join(fixture.root, 'mutate-verified-submission-lock')
      executable(mutateRuntime, `#!${process.execPath}
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(runtimeModule)}, ${JSON.stringify(driftedSource)}, { mode: 0o600 })
`)
      const result = apply(fixture, prepared, {
        ...environment,
        AIWORKER_TEST_LEGACY_ORPHAN_AFTER_TOOL_SNAPSHOT_CHECK_COMMAND: mutateRuntime,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('changed after closure verification')
      expect(existsSync(canary)).toBe(false)
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as { status: string }).status).toBe('accepted')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('loads the bound parser snapshot and never executes a raced parser top-level canary', () => {
    const fixture = createParentFixture()
    try {
      const parserPath = join(fixture.root, 'typescript-parser.cjs')
      const installedParser = realpathSync(join(
        repositoryRoot,
        'node_modules/typescript/lib/typescript.js',
      ))
      const canary = join(fixture.root, 'parser-race-canary')
      copyFileSync(installedParser, parserPath)
      chmodSync(parserPath, 0o600)
      const environment = { AIWORKER_TEST_LEGACY_ORPHAN_PARSER_PATH: parserPath }
      const prepared = prepareParent(fixture, environment)
      const mutateParser = join(fixture.root, 'mutate-typescript-parser')
      executable(mutateParser, `#!${process.execPath}
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(parserPath)}, ${JSON.stringify(`
require('node:fs').writeFileSync(${JSON.stringify(canary)}, 'executed\\n', { mode: 0o600 })
module.exports = {}
`)}, { mode: 0o600 })
`)
      const result = apply(fixture, prepared, {
        ...environment,
        AIWORKER_TEST_LEGACY_ORPHAN_AFTER_PARSER_SNAPSHOT_CHECK_COMMAND: mutateParser,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('TypeScript parser changed after verified parsing')
      expect(existsSync(canary)).toBe(false)
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as { status: string }).status).toBe('accepted')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rejects a forged token before inspecting or executing a drifted parser', () => {
    const fixture = createParentFixture()
    try {
      const parserPath = join(fixture.root, 'token-first-parser.cjs')
      const installedParser = realpathSync(join(
        repositoryRoot,
        'node_modules/typescript/lib/typescript.js',
      ))
      const canary = join(fixture.root, 'token-first-parser-canary')
      copyFileSync(installedParser, parserPath)
      chmodSync(parserPath, 0o600)
      const environment = { AIWORKER_TEST_LEGACY_ORPHAN_PARSER_PATH: parserPath }
      const prepared = prepareParent(fixture, environment)
      writeFileSync(parserPath, `
require('node:fs').writeFileSync(${JSON.stringify(canary)}, 'executed\\n', { mode: 0o600 })
module.exports = {}
`, { mode: 0o600 })
      const result = apply(fixture, {
        ...prepared,
        confirmationToken: `confirm-${'0'.repeat(64)}`,
      }, environment)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('confirmation token')
      expect(result.stderr).not.toContain('TypeScript parser changed')
      expect(existsSync(canary)).toBe(false)
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rejects Node database runtime drift before any SQLite database can open', () => {
    const fixture = createParentFixture()
    try {
      const prepared = prepareParent(fixture)
      const canary = join(fixture.root, 'unexpected-database-open')
      const result = apply(fixture, prepared, {
        AIWORKER_TEST_LEGACY_ORPHAN_DATABASE_RUNTIME_SHA: 'f'.repeat(64),
        AIWORKER_TEST_LEGACY_ORPHAN_DATABASE_OPEN_CANARY: canary,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('database runtime changed after prepare')
      expect(existsSync(canary)).toBe(false)
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as { status: string }).status).toBe('accepted')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('keeps the verified loader active while acquire rejects a delayed local require', () => {
    const fixture = createParentFixture()
    try {
      const runtimeModule = join(fixture.root, 'delayed-require-submission-lock.mjs')
      const lazyModule = join(fixture.root, 'delayed-lock-canary.cjs')
      const canary = join(fixture.root, 'delayed-require-canary')
      writeFileSync(lazyModule, `
require('node:fs').writeFileSync(${JSON.stringify(canary)}, 'executed\\n', { mode: 0o600 })
module.exports = true
`, { mode: 0o600 })
      writeFileSync(runtimeModule, `
const moduleApi = process.getBuiltinModule('node:module')
const delayedRequire = moduleApi['create' + 'Require'](new URL(${JSON.stringify(
        pathToFileURL(runtimeModule).href,
      )}))
export async function acquireVideoSubmissionLock() {
  delayedRequire('./delayed-lock-canary.cjs')
  return { acquired: true, async release() {} }
}
`, { mode: 0o600 })
      const environment = {
        AIWORKER_TEST_LEGACY_ORPHAN_TOOL_RUNTIME_ROOT: runtimeModule,
      }
      const prepared = prepareParent(fixture, environment)
      const result = apply(fixture, prepared, environment)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('unverified reconciliation runtime dependency requested')
      expect(existsSync(canary)).toBe(false)
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as { status: string }).status).toBe('accepted')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('fails closed after commit when attention does not disappear and never retries the CAS', () => {
    const fixture = createParentFixture()
    try {
      const prepared = prepareParent(fixture)
      const first = apply(fixture, prepared)
      expect(first.status).not.toBe(0)
      expect(first.stderr).toContain('queue state did not reach zero')
      const committed = fixture.mission.prepare('SELECT status, attempt_count FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as { status: string; attempt_count: number }
      expect(committed).toEqual({ status: 'failed', attempt_count: 0 })
      const second = apply(fixture, prepared)
      expect(second.status).not.toBe(0)
      expect((fixture.mission.prepare('SELECT attempt_count FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as { attempt_count: number }).attempt_count).toBe(0)
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rechecks durable queue authority inside the dual-lock write boundary', () => {
    const fixture = createParentFixture()
    try {
      const prepared = prepareParent(fixture)
      const hook = join(fixture.root, 'make-parent-durable')
      executable(hook, `#!${process.execPath}
const fs = require('node:fs')
const path = ${JSON.stringify(fixture.queuePath)}
const value = JSON.parse(fs.readFileSync(path, 'utf8'))
value.queue[0].sourceAvailable = true
value.queue[0].queueOrigin = 'durable+n8n'
fs.writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
`)
      const result = apply(fixture, prepared, {
        AIWORKER_TEST_LEGACY_ORPHAN_BETWEEN_LOCKED_QUEUE_SAMPLES_COMMAND: hook,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('persistent queue changed between locked write-boundary samples')
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as { status: string }).status).toBe('accepted')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('catches even a completed n8n execution created between the first samples and writer reservation', () => {
    const fixture = createParentFixture()
    try {
      const prepared = prepareParent(fixture)
      const hook = join(fixture.root, 'insert-n8n-gap-execution')
      executable(hook, `#!/bin/sh
/usr/bin/sqlite3 ${JSON.stringify(fixture.n8nPath)} "INSERT INTO execution_entity VALUES (66, 'other-workflow', 'success', '2026-09-04 20:00:00.000')"
`)
      const result = apply(fixture, prepared, {
        AIWORKER_TEST_LEGACY_ORPHAN_AFTER_MISSION_LOCK_COMMAND: hook,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('n8n execution changed after confirmation')
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as { status: string }).status).toBe('accepted')
      expect((fixture.n8n.prepare('SELECT status FROM execution_entity WHERE id = 66')
        .get() as { status: string }).status).toBe('success')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('holds the n8n writer reservation until the Mission Control CAS commits', () => {
    const fixture = createParentFixture()
    try {
      const prepared = prepareParent(fixture)
      const hook = join(fixture.root, 'prove-n8n-writer-reservation')
      executable(hook, `#!/bin/sh
if /usr/bin/sqlite3 ${JSON.stringify(fixture.n8nPath)} "PRAGMA busy_timeout=100; INSERT INTO execution_entity VALUES (66, 'other-workflow', 'running', NULL)" >/dev/null 2>&1; then
  exit 91
fi
exit 0
`)
      const result = apply(fixture, prepared, {
        AIWORKER_TEST_LEGACY_ORPHAN_AFTER_DUAL_LOCK_COMMAND: hook,
        AIWORKER_TEST_LEGACY_ORPHAN_AFTER_COMMIT_COMMAND: fixture.clearQueueHook,
      })
      expect(result.status, result.stderr).toBe(0)
      expect(fixture.n8n.prepare('SELECT id FROM execution_entity WHERE id = 66').get()).toBeUndefined()
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as { status: string }).status).toBe('failed')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('waits behind a submission that already owns the shared lock and then sees its durable write', () => {
    const fixture = createParentFixture()
    try {
      const prepared = prepareParent(fixture)
      const readyMarker = join(fixture.root, 'preexisting-submit-ready')
      const holder = join(fixture.root, 'preexisting-submit.mjs')
      const stateModule = pathToFileURL(join(
        repositoryRoot,
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      executable(holder, `#!${process.execPath}
import { readFileSync, writeFileSync } from 'node:fs'
import { acquireVideoSubmissionLock } from ${JSON.stringify(stateModule)}
const lock = await acquireVideoSubmissionLock(${JSON.stringify(join(fixture.root, 'batches'))})
writeFileSync(${JSON.stringify(readyMarker)}, 'ready\\n', { mode: 0o600 })
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300)
const queuePath = ${JSON.stringify(fixture.queuePath)}
const queue = JSON.parse(readFileSync(queuePath, 'utf8'))
queue.queue[0].sourceAvailable = true
writeFileSync(queuePath, JSON.stringify(queue), { mode: 0o600 })
await lock.release()
`)
      const startHolder = join(fixture.root, 'start-preexisting-submit')
      executable(startHolder, `#!${process.execPath}
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, [${JSON.stringify(holder)}], { detached: true, stdio: 'ignore' })
child.unref()
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const deadline = Date.now() + 2000
while (!fs.existsSync(${JSON.stringify(readyMarker)}) && Date.now() < deadline) wait(20)
if (!fs.existsSync(${JSON.stringify(readyMarker)})) process.exit(94)
`)
      const result = apply(fixture, prepared, {
        AIWORKER_TEST_LEGACY_ORPHAN_BEFORE_SUBMISSION_LOCK_COMMAND: startHolder,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('persistent queue changed inside the write boundary')
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as { status: string }).status).toBe('accepted')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('holds the shared durable-submission lock across both writer reservations and the CAS', () => {
    const fixture = createParentFixture()
    try {
      const prepared = prepareParent(fixture)
      const acquiredMarker = join(fixture.root, 'slow-submit-acquired')
      const startedMarker = join(fixture.root, 'slow-submit-started')
      const slowSubmit = join(fixture.root, 'slow-submit.mjs')
      const stateModule = pathToFileURL(join(
        repositoryRoot,
        'openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs',
      )).href
      executable(slowSubmit, `#!${process.execPath}
import { writeFileSync } from 'node:fs'
import { acquireVideoSubmissionLock } from ${JSON.stringify(stateModule)}
writeFileSync(${JSON.stringify(startedMarker)}, 'started\\n', { mode: 0o600 })
const lock = await acquireVideoSubmissionLock(${JSON.stringify(join(fixture.root, 'batches'))})
writeFileSync(${JSON.stringify(acquiredMarker)}, 'acquired-after-cas\\n', { mode: 0o600 })
await lock.release()
`)
      const startSlowSubmit = join(fixture.root, 'start-slow-submit')
      executable(startSlowSubmit, `#!${process.execPath}
const fs = require('node:fs')
const { spawn } = require('node:child_process')
const child = spawn(process.execPath, [${JSON.stringify(slowSubmit)}], { detached: true, stdio: 'ignore' })
child.unref()
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const deadline = Date.now() + 2000
while (!fs.existsSync(${JSON.stringify(startedMarker)}) && Date.now() < deadline) wait(20)
if (!fs.existsSync(${JSON.stringify(startedMarker)}) || fs.existsSync(${JSON.stringify(acquiredMarker)})) process.exit(91)
wait(250)
if (fs.existsSync(${JSON.stringify(acquiredMarker)})) process.exit(92)
`)
      const finishAfterCommit = join(fixture.root, 'finish-after-commit')
      executable(finishAfterCommit, `#!${process.execPath}
const fs = require('node:fs')
const wait = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const deadline = Date.now() + 4000
while (!fs.existsSync(${JSON.stringify(acquiredMarker)}) && Date.now() < deadline) wait(20)
if (!fs.existsSync(${JSON.stringify(acquiredMarker)})) process.exit(93)
fs.writeFileSync(${JSON.stringify(fixture.queuePath)}, JSON.stringify({
  counts: { attention: 0, running: 0, waiting: 0 }, queue: [], total: 0,
}), { mode: 0o600 })
`)
      const result = apply(fixture, prepared, {
        AIWORKER_TEST_LEGACY_ORPHAN_AFTER_LOCKED_QUEUE_SAMPLES_COMMAND: startSlowSubmit,
        AIWORKER_TEST_LEGACY_ORPHAN_AFTER_COMMIT_COMMAND: finishAfterCommit,
      })
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(acquiredMarker, 'utf8')).toBe('acquired-after-cas\n')
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as { status: string }).status).toBe('failed')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it('rejects parent-mode tool, token, and immutable manifest drift', () => {
    const toolFixture = createParentFixture()
    try {
      const prepared = prepareParent(toolFixture, {
        AIWORKER_TEST_LEGACY_ORPHAN_TOOL_SHA: toolShaA,
      })
      const result = apply(toolFixture, prepared, {
        AIWORKER_TEST_LEGACY_ORPHAN_TOOL_SHA: toolShaB,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('tool changed')
    } finally { toolFixture.mission.close(); toolFixture.n8n.close() }

    const tokenFixture = createParentFixture()
    try {
      const prepared = prepareParent(tokenFixture)
      const result = apply(tokenFixture, {
        ...prepared,
        confirmationToken: `confirm-${'0'.repeat(64)}`,
      })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('confirmation token')
    } finally { tokenFixture.mission.close(); tokenFixture.n8n.close() }

    const manifestFixture = createParentFixture()
    try {
      const prepared = prepareParent(manifestFixture)
      mutateImmutableJson(prepared.prepareManifest, value => {
        value.handoffNonce = 'f'.repeat(64)
      })
      const result = apply(manifestFixture, prepared)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('confirmation token')
    } finally { manifestFixture.mission.close(); manifestFixture.n8n.close() }
  })

  it.each([
    ['wrong source', (fixture: ParentFixture) => fixture.mission.prepare(
      'UPDATE n8n_task_runs SET source = ? WHERE task_id = ?',
    ).run('manual', fixture.parentTaskId)],
    ['wrong routing', (fixture: ParentFixture) => fixture.mission.prepare(
      'UPDATE n8n_task_runs SET routing = ? WHERE task_id = ?',
    ).run('{"taskType":"other"}', fixture.parentTaskId)],
    ['wrong binding', (fixture: ParentFixture) => fixture.mission.prepare(
      'UPDATE n8n_workflow_bindings SET task_type = ?',
    ).run('other')],
    ['non-accepted status', (fixture: ParentFixture) => fixture.mission.prepare(
      'UPDATE n8n_task_runs SET status = ? WHERE task_id = ?',
    ).run('running', fixture.parentTaskId)],
    ['resumed optional global intake', (fixture: ParentFixture) => createIntakeControl(fixture, 1)],
    ['deterministic child', (fixture: ParentFixture) => insertTaskFromParent(
      fixture, childTaskId(fixture.parentTaskId, 'prepare'), 'n8n-media-node', 'failed',
    )],
    ['parent claim', (fixture: ParentFixture) => fixture.mission.prepare(
      'INSERT INTO n8n_parent_execution_claims VALUES (?, 1, 1)',
    ).run(fixture.parentTaskId)],
    ['dispatch lease', (fixture: ParentFixture) => fixture.mission.prepare(
      'INSERT INTO n8n_task_dispatch_leases VALUES (?, 1, 1)',
    ).run(fixture.parentTaskId)],
    ['child lease', (fixture: ParentFixture) => fixture.mission.prepare(`
      INSERT INTO n8n_child_execution_leases VALUES (?, 1, 1, ?, ?, 1, 1, 1, 1, 1)
    `).run(childTaskId(fixture.parentTaskId, 'audio'), 'a'.repeat(64), 'b'.repeat(64))],
    ['cleanup debt', (fixture: ParentFixture) => fixture.mission.prepare(
      'INSERT INTO n8n_media_cleanup_debts VALUES (?)',
    ).run(fixture.parentTaskId)],
    ['director outbox', (fixture: ParentFixture) => fixture.mission.prepare(
      'INSERT INTO n8n_director_evidence_outbox VALUES (?)',
    ).run(fixture.parentTaskId)],
    ['media active', (fixture: ParentFixture) => insertTaskFromParent(
      fixture, 'unrelated-media-active', 'n8n-media-node',
    )],
    ['model active', (fixture: ParentFixture) => insertTaskFromParent(
      fixture, 'unrelated-model-active', 'n8n-node',
    )],
    ['n8n active', (fixture: ParentFixture) => fixture.n8n.prepare(
      'INSERT INTO execution_entity VALUES (66, ?, ?, NULL)',
    ).run('other-workflow', 'running')],
    ['target workspace', (fixture: ParentFixture) => mkdirSync(
      join(dirname(fixture.missionPath), 'media-tasks', sha256(fixture.parentTaskId)),
      { recursive: true, mode: 0o700 },
    )],
    ['target process reference', (fixture: ParentFixture) => fixture.writeState({
      processInventory: `9001 1 node worker ${fixture.parentTaskId}\n`,
    })],
  ])('refuses parent reconciliation with %s', (_label, mutate) => {
    const fixture = createParentFixture()
    try {
      mutate(fixture)
      const result = fixture.runParent()
      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
      expect(readdirSync(fixture.backupRoot)).toEqual([])
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it.each([
    ['cross-scope deterministic child', (fixture: ParentFixture) => {
      const taskId = childTaskId(fixture.parentTaskId, 'finalize')
      insertTaskFromParent(fixture, taskId, 'n8n-media-node', 'failed')
      fixture.mission.prepare(
        'UPDATE n8n_task_runs SET tenant_id = 2, workspace_id = 2 WHERE task_id = ?',
      ).run(taskId)
    }],
    ['cross-scope parent claim', (fixture: ParentFixture) => fixture.mission.prepare(
      'INSERT INTO n8n_parent_execution_claims VALUES (?, 2, 2)',
    ).run(fixture.parentTaskId)],
    ['cross-scope dispatch lease', (fixture: ParentFixture) => fixture.mission.prepare(
      'INSERT INTO n8n_task_dispatch_leases VALUES (?, 2, 2)',
    ).run(fixture.parentTaskId)],
    ['cross-scope child lease', (fixture: ParentFixture) => fixture.mission.prepare(`
      INSERT INTO n8n_child_execution_leases VALUES (?, 2, 2, ?, ?, 1, 1, 1, 1, 1)
    `).run(childTaskId(fixture.parentTaskId, 'prepare'), 'a'.repeat(64), 'b'.repeat(64))],
  ])('rejects %s by global task identity', (_label, mutate) => {
    const fixture = createParentFixture()
    try {
      mutate(fixture)
      const result = fixture.runParent()
      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })

  it.each([
    ['parent row drift', (fixture: ParentFixture) => fixture.mission.prepare(
      'UPDATE n8n_task_runs SET requested_by = ? WHERE task_id = ?',
    ).run('drifted', fixture.parentTaskId)],
    ['late deterministic child', (fixture: ParentFixture) => insertTaskFromParent(
      fixture, childTaskId(fixture.parentTaskId, 'vision'), 'n8n-media-node', 'failed',
    )],
  ])('rejects %s after prepare without changing the parent', (_label, mutate) => {
    const fixture = createParentFixture()
    try {
      const prepared = prepareParent(fixture)
      mutate(fixture)
      const result = apply(fixture, prepared, {
        AIWORKER_TEST_LEGACY_ORPHAN_AFTER_COMMIT_COMMAND: fixture.clearQueueHook,
      })
      expect(result.status).not.toBe(0)
      expect((fixture.mission.prepare('SELECT status FROM n8n_task_runs WHERE task_id = ?')
        .get(fixture.parentTaskId) as { status: string }).status).toBe('accepted')
    } finally { fixture.mission.close(); fixture.n8n.close() }
  })
})
