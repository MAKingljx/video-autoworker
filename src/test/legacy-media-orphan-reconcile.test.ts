import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
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
    supervisorLoaded: false,
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
if (args[0] === 'print-disabled') { process.stdout.write('disabled services = { "ai.aiworker.video-lane-supervisor" => true }\\n'); process.exit(0) }
const service = args[1] || ''
if (service.endsWith('/com.video-autoworker.n8n')) { process.stdout.write('state = running\\npid = 2000\\n'); process.exit(0) }
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
    root, backupRoot, queuePath, missionPath, missionData, mission, n8n,
    parentTaskId, mediaTaskId, childRowId, run, runRaw, writeState,
  }
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
  it('makes the backup-family directory entry durable before copying members', () => {
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
    const fsyncStart = source.indexOf('function fsyncDirectory')
    const fsyncEnd = source.indexOf('\nfunction writeImmutableJson', fsyncStart)
    const fsyncImplementation = source.slice(fsyncStart, fsyncEnd)
    expect(fsyncImplementation).toContain('constants.O_DIRECTORY')
    expect(fsyncImplementation).toContain('constants.O_NOFOLLOW')
    expect(fsyncImplementation).toContain('fstatSync(descriptor, { bigint: true })')
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

  it('prepares immutable forensic copies and one authoritative rollback snapshot', () => {
    const fixture = createFixture()
    try {
      const output = prepare(fixture)
      const directory = dirname(output.prepareManifest)
      expect(statSync(directory).mode & 0o777).toBe(0o500)
      expect(statSync(output.prepareManifest).mode & 0o777).toBe(0o400)
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
