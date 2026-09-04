// @vitest-environment node

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  captureQueueBeforeFreeze,
  captureProcessIdentity,
  classifyEvidencedLegacyProcess,
  hashFileStable,
  queueState,
  revalidateDatabaseConnection,
  validateDatabaseBinding,
  validateNewDatabaseConnection,
  workerPidsFromPgrep,
} from '../../scripts/generate-legacy-freeze-evidence.mjs'

const roots: string[] = []
const projectRoot = realpathSync(process.cwd())
const generator = resolve(projectRoot, 'scripts/generate-legacy-freeze-evidence.mjs')
const guard = resolve(projectRoot, 'scripts/legacy-freeze-guard.mjs')
const rollbackGenerator = resolve(projectRoot, 'scripts/generate-legacy-bootstrap-rollback-proof.mjs')
const children: ChildProcess[] = []

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill('SIGTERM')
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Process startup can briefly exceed five seconds when the full Vitest suite
// launches several native SQLite fixtures in parallel on the same host.
async function waitFor(predicate: () => boolean, timeout = 15000) {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for test process')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 20))
  }
}

function guardStatus(socket: string, database: string, n8nDatabase: string) {
  return spawnSync(process.execPath, [
    guard, 'status', '--socket', socket, '--database', database, '--n8n-database', n8nDatabase,
  ], { encoding: 'utf8', cwd: projectRoot })
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(source).sort().map(key => [key, canonicalize(source[key])]))
  }
  return value
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

async function startLegacy(database: string) {
  const child = spawn(process.execPath, ['-e', `
    const Database = require('better-sqlite3')
    const http = require('node:http')
    const db = new Database(process.argv[1])
    http.createServer((_request, response) => response.end('ok')).listen(3017, '127.0.0.1')
    process.on('SIGTERM', () => { db.close(); process.exit(0) })
  `, database], { cwd: projectRoot, stdio: 'ignore' })
  children.push(child)
  await waitFor(() => spawnSync('/usr/sbin/lsof', [
    '-nP', '-iTCP:3017', '-sTCP:LISTEN', '-Fp',
  ], { encoding: 'utf8' }).stdout.includes(`p${child.pid}\n`))
  return child
}

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function fileIdentity(path: string) {
  const value = statSync(path, { bigint: true })
  return { path, dev: value.dev.toString(), ino: value.ino.toString() }
}

function createGuardDatabases(root: string) {
  const database = join(root, 'mission-control.db')
  const n8nDatabase = join(root, 'database.sqlite')
  for (const pathname of [database, n8nDatabase]) {
    const setup = new Database(pathname)
    setup.exec('CREATE TABLE probe (value INTEGER NOT NULL)')
    setup.close()
    chmodSync(pathname, 0o600)
  }
  return { database, n8nDatabase }
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-freeze-evidence.')))
  roots.push(root)
  const repository = join(root, 'repo')
  const releaseId = 'abcdef0123456789-runtime'
  const standalone = join(repository, '.runtime/releases', releaseId, 'standalone')
  const outputDir = join(root, 'evidence')
  const backupDir = join(root, 'rollback')
  const databaseDir = join(root, 'databases')
  const proof = join(backupDir, 'proof.json')
  const snapshotPath = join(root, 'snapshot.json')
  const snapshotCommand = join(root, 'snapshot-command')
  const output = join(outputDir, 'freeze.json')
  for (const path of [repository, standalone, outputDir, backupDir, databaseDir]) {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    chmodSync(path, 0o700)
  }
  const manifestSource = '{"schema":"test-release-manifest/v1"}\n'
  writeFileSync(join(standalone, 'release-manifest.json'), manifestSource, { mode: 0o600 })
  const target = { slot: 'blue', releaseId, manifestSha256: hash(manifestSource) }
  const identity = (name: string) => ({
    path: join(root, name), dev: '16777234', ino: String(100 + name.length),
  })
  const processValue = (pid: number) => ({
    pid,
    ppid: 1,
    uid: process.getuid!(),
    startTime: 'Sun Aug 31 18:00:00 2026',
    argvSha256: 'b'.repeat(64),
    executable: identity(`process-${pid}`),
    cwd: identity(`cwd-${pid}`),
    database: identity(`database-${pid}`),
  })
  const missionPath = join(databaseDir, 'mission-control.db')
  const n8nPath = join(databaseDir, 'database.sqlite')
  for (const path of [missionPath, n8nPath]) {
    const db = new Database(path)
    db.exec('CREATE TABLE proof_probe (value INTEGER NOT NULL)')
    db.close()
    chmodSync(path, 0o600)
  }
  const legacy = {
    ...processValue(1200), database: fileIdentity(missionPath),
    releaseId: 'legacy-runtime', routerPort: 3017,
  }
  const now = Math.floor(Date.now() / 1000)
  const snapshot = {
    legacy,
    n8n: {
      ...processValue(1300), database: fileIdentity(n8nPath),
      ppid: 1250, launchPid: 1250, port: 5678,
    },
    counts: { mediaNodes: 0, n8nActiveExecutions: 0, queueWaiting: 0, queueRunning: 0 },
    queueDigestSha256: 'c'.repeat(64),
    supervisor: { disabled: true, loaded: false, workerPids: [], lockAbsent: true },
    frozen: {
      schema: 'video-autoworker-legacy-freeze-guard/v1',
      ready: true,
      pid: 1400,
      uid: process.getuid!(),
      startedAt: 'Sun Aug 31 18:00:00 2026',
      argvSha256: 'd'.repeat(64),
      scriptSha256: 'e'.repeat(64),
      guardNonceSha256: 'f'.repeat(64),
      legacyBindingSha256: '1'.repeat(64),
      mode: 'dual',
      issuedAt: now,
      expiresAt: now + 300,
      database: legacy.database,
      n8nDatabase: fileIdentity(n8nPath),
      socket: identity('guard.sock'),
    },
  }
  const missionBackup = join(backupDir, 'mission-control.db')
  const n8nBackup = join(backupDir, 'database.sqlite')
  copyFileSync(missionPath, missionBackup)
  copyFileSync(n8nPath, n8nBackup)
  chmodSync(missionBackup, 0o600)
  chmodSync(n8nBackup, 0o600)
  writeFileSync(proof, `${JSON.stringify({
    schema: 'video-autoworker-legacy-bootstrap-rollback-proof/v2',
    generatorSha256: hashFileStable(rollbackGenerator),
    createdAt: now,
    host: spawnSync('/bin/hostname', { encoding: 'utf8' }).stdout.trim(),
    uid: process.getuid!(),
    target,
    sources: { mission: legacy.database, n8n: snapshot.n8n.database },
    backups: {
      mission: { path: missionBackup, sha256: hash(readFileSync(missionBackup)) },
      n8n: { path: n8nBackup, sha256: hash(readFileSync(n8nBackup)) },
    },
    queueDigestSha256: snapshot.queueDigestSha256,
    guardSha256: hash(canonicalJson(snapshot.frozen)),
    runtimeIdentitySha256: hash(canonicalJson(snapshot)),
  })}\n`, { mode: 0o600 })
  writeFileSync(snapshotPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 })
  writeFileSync(snapshotCommand, `#!${process.execPath}\nprocess.stdout.write(require('node:fs').readFileSync(${JSON.stringify(snapshotPath)}))\n`, {
    mode: 0o700,
  })
  chmodSync(snapshotCommand, 0o700)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'test' as const,
    AIWORKER_TEST_LEGACY_FREEZE: '1',
    AIWORKER_TEST_LEGACY_FREEZE_REPOSITORY_ROOT: repository,
    AIWORKER_TEST_LEGACY_FREEZE_SNAPSHOT_COMMAND: snapshotCommand,
    AIWORKER_TEST_LEGACY_FREEZE_SAMPLE_DELAY_MS: '0',
  }
  const args = [
    generator, '--output', output, '--slot', 'blue', '--release-id', releaseId,
    '--standalone-root', standalone, '--rollback-proof', proof,
  ]
  return {
    root, repository, standalone, releaseId, outputDir, databaseDir, output, proof, snapshotPath,
    snapshotCommand, snapshot, env, args,
  }
}

describe('managed legacy freeze evidence', () => {
  it('fails before freeze attestation when a stale accepted run is attention', async () => {
    let freezeAttestations = 0
    const fetchQueue = async () => new Response(JSON.stringify({
      counts: { attention: 1, running: 0, waiting: 0 },
      queue: [{
        taskId: 'stale-accepted', status: 'accepted', updatedAt: 1,
        stale: true, sourceAvailable: null,
      }],
      total: 1,
    }), { status: 200, headers: { 'content-type': 'application/json' } })

    await expect(captureQueueBeforeFreeze(
      { path: '/private/mission-control.db' },
      { path: '/private/database.sqlite' },
      {
        queueState: () => queueState(fetchQueue),
        freezeGuard: () => {
          freezeAttestations += 1
          return { ready: true }
        },
      },
    )).rejects.toThrow(/controlled CAS reconciliation before legacy bootstrap/u)
    expect(freezeAttestations).toBe(0)
  })

  it('keeps the zero-attention queue and freeze path unchanged', async () => {
    const calls: unknown[][] = []
    const frozen = { schema: 'video-autoworker-legacy-freeze-guard/v1', ready: true }
    const fetchQueue = async () => new Response(JSON.stringify({
      counts: { attention: 0, running: 0, waiting: 0 }, queue: [], total: 0,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    const mission = { path: '/private/mission-control.db' }
    const n8n = { path: '/private/database.sqlite' }

    const result = await captureQueueBeforeFreeze(mission, n8n, {
      queueState: () => queueState(fetchQueue),
      freezeGuard: (...args: unknown[]) => {
        calls.push(args)
        return frozen
      },
    })

    expect(result).toEqual({
      queue: { waiting: 0, running: 0, digest: hash('[]') },
      frozen,
    })
    expect(calls).toEqual([[mission, n8n]])
  })

  it.each([-1, 1.5, '1'])('rejects invalid queue attention count %j', async attention => {
    const fetchQueue = async () => new Response(JSON.stringify({
      counts: { attention, running: 0, waiting: 0 }, queue: [], total: 0,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    await expect(queueState(fetchQueue)).rejects.toThrow(/queue attention is invalid/u)
  })

  it('treats a reused legacy PID as stopped only while port 3017 remains unclaimed', () => {
    const expected = {
      pid: 30170,
      ppid: 1,
      uid: process.getuid?.() ?? 0,
      startTime: 'Mon Jan 01 00:00:00 2027',
      argvSha256: 'a'.repeat(64),
      executable: { path: '/runtime/bin/node', dev: '1', ino: '2' },
      cwd: { path: '/runtime/releases/legacy-runtime/standalone', dev: '1', ino: '3' },
      database: { path: '/runtime/mission-control.db', dev: '1', ino: '4' },
      releaseId: 'legacy-runtime',
      routerPort: 3017,
    }
    expect(classifyEvidencedLegacyProcess(expected, { ...expected }, [expected.pid])).toBe('alive')
    const reused = {
      ...expected,
      ppid: 999,
      startTime: 'Mon Jan 01 01:00:00 2027',
      argvSha256: 'b'.repeat(64),
    }
    expect(classifyEvidencedLegacyProcess(expected, reused, [])).toBe('stopped')
    expect(() => classifyEvidencedLegacyProcess(expected, reused, [expected.pid]))
      .toThrow(/PID was reused/u)
    expect(() => classifyEvidencedLegacyProcess(expected, reused, [99999]))
      .toThrow(/occupied by a process other/u)
    expect(() => classifyEvidencedLegacyProcess(expected, {
      ...expected,
      database: { ...expected.database, ino: '5' },
    }, [])).toThrow(/identity changed without a PID incarnation change/u)
  })

  it('creates guarded online backups and a proof consumed by the evidence validator', () => {
    const entry = fixture()
    const oldProof = JSON.parse(readFileSync(entry.proof, 'utf8'))
    unlinkSync(entry.proof)
    unlinkSync(oldProof.backups.mission.path)
    unlinkSync(oldProof.backups.n8n.path)
    const generated = spawnSync(process.execPath, [
      rollbackGenerator,
      '--output', entry.proof,
      '--slot', 'blue',
      '--release-id', entry.releaseId,
      '--standalone-root', entry.standalone,
      '--guard-socket', entry.snapshot.frozen.socket.path,
    ], { encoding: 'utf8', env: entry.env, cwd: projectRoot })
    expect(generated.status, generated.stderr).toBe(0)
    const proof = JSON.parse(readFileSync(entry.proof, 'utf8'))
    expect(proof).toMatchObject({
      schema: 'video-autoworker-legacy-bootstrap-rollback-proof/v2',
      queueDigestSha256: entry.snapshot.queueDigestSha256,
      guardSha256: hash(canonicalJson(entry.snapshot.frozen)),
    })
    for (const backup of Object.values(proof.backups) as Array<{ path: string; sha256: string }>) {
      expect(lstatSync(backup.path).mode & 0o777).toBe(0o600)
      expect(lstatSync(backup.path).nlink).toBe(1)
      expect(hashFileStable(backup.path)).toBe(backup.sha256)
    }
    const evidence = spawnSync(process.execPath, entry.args, { encoding: 'utf8', env: entry.env })
    expect(evidence.status, evidence.stderr).toBe(0)
    const evidenceFd = openSync(entry.output, 'r')
    writeFileSync(entry.proof, `${readFileSync(entry.proof, 'utf8')}\n`, { mode: 0o600 })
    const changedProof = spawnSync(process.execPath, [
      generator, '--verify-evidence-static-fd', '3', ...entry.args.slice(1),
    ], { encoding: 'utf8', env: entry.env, stdio: ['ignore', 'pipe', 'pipe', evidenceFd] })
    closeSync(evidenceFd)
    expect(changedProof.status).not.toBe(0)
    expect(String(changedProof.stderr)).toContain('rollback proof binding is invalid')
  })

  it('statically verifies the same evidence after the legacy guard socket is gone', () => {
    const entry = fixture()
    const generated = spawnSync(process.execPath, entry.args, { encoding: 'utf8', env: entry.env })
    expect(generated.status, generated.stderr).toBe(0)
    expect(existsSync(entry.snapshot.frozen.socket.path)).toBe(false)
    const evidenceFd = openSync(entry.output, 'r')
    const verified = spawnSync(process.execPath, [
      generator, '--verify-evidence-static-fd', '3', ...entry.args.slice(1),
    ], { encoding: 'utf8', env: entry.env, stdio: ['ignore', 'pipe', 'pipe', evidenceFd] })
    closeSync(evidenceFd)
    expect(verified.status, String(verified.stderr)).toBe(0)
    expect(String(verified.stdout).trim()).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('hashes multi-block files through one stable FD', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-stream-hash.')))
    roots.push(root)
    const pathname = join(root, 'large.bin')
    const source = Buffer.alloc(2 * 1024 * 1024 + 123, 0x5a)
    writeFileSync(pathname, source, { mode: 0o600 })
    expect(hashFileStable(pathname)).toBe(hash(source))
  })

  it('rejects rollback backup, guard, target, and source/output overlap attacks', () => {
    const backupAttack = fixture()
    const backupProof = JSON.parse(readFileSync(backupAttack.proof, 'utf8'))
    writeFileSync(backupProof.backups.mission.path, Buffer.from('not a sqlite backup'), { mode: 0o600 })
    const changedBackup = spawnSync(process.execPath, backupAttack.args, {
      encoding: 'utf8', env: backupAttack.env,
    })
    expect(changedBackup.status).not.toBe(0)
    expect(changedBackup.stderr).toMatch(/backup (digest|quick_check)/u)

    const guardAttack = fixture()
    const guardProof = JSON.parse(readFileSync(guardAttack.proof, 'utf8'))
    guardProof.guardSha256 = '0'.repeat(64)
    writeFileSync(guardAttack.proof, `${JSON.stringify(guardProof)}\n`, { mode: 0o600 })
    const changedGuard = spawnSync(process.execPath, guardAttack.args, {
      encoding: 'utf8', env: guardAttack.env,
    })
    expect(changedGuard.status).not.toBe(0)
    expect(changedGuard.stderr).toContain('identity, guard, queue, or target is invalid')

    const targetAttack = fixture()
    const targetProof = JSON.parse(readFileSync(targetAttack.proof, 'utf8'))
    targetProof.target.slot = 'green'
    writeFileSync(targetAttack.proof, `${JSON.stringify(targetProof)}\n`, { mode: 0o600 })
    const changedTarget = spawnSync(process.execPath, targetAttack.args, {
      encoding: 'utf8', env: targetAttack.env,
    })
    expect(changedTarget.status).not.toBe(0)
    expect(changedTarget.stderr).toContain('identity, guard, queue, or target is invalid')

    const overlap = fixture()
    const overlapResult = spawnSync(process.execPath, [
      rollbackGenerator,
      '--output', join(overlap.databaseDir, 'overlap-proof.json'),
      '--slot', 'blue',
      '--release-id', overlap.releaseId,
      '--standalone-root', overlap.standalone,
      '--guard-socket', overlap.snapshot.frozen.socket.path,
    ], { encoding: 'utf8', env: overlap.env, cwd: projectRoot })
    expect(overlapResult.status).not.toBe(0)
    expect(overlapResult.stderr).toContain('must be independent')

    const repositoryOverlap = fixture()
    const unsafeDirectory = join(repositoryOverlap.repository, 'unsafe-backup')
    mkdirSync(unsafeDirectory, { mode: 0o700 })
    const repositoryOverlapResult = spawnSync(process.execPath, [
      rollbackGenerator,
      '--output', join(unsafeDirectory, 'rollback-proof.json'),
      '--slot', 'blue',
      '--release-id', repositoryOverlap.releaseId,
      '--standalone-root', repositoryOverlap.standalone,
      '--guard-socket', repositoryOverlap.snapshot.frozen.socket.path,
    ], { encoding: 'utf8', env: repositoryOverlap.env, cwd: projectRoot })
    expect(repositoryOverlapResult.status).not.toBe(0)
    expect(repositoryOverlapResult.stderr).toContain('must not overlap the repository')
  })

  it('uses the real macOS lsof/ps production path for Node executable identity', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: projectRoot,
      stdio: 'ignore',
    })
    children.push(child)
    await waitFor(() => child.pid !== undefined)
    const value = captureProcessIdentity(child.pid!, 'production-path test Node')
    expect(value.pid).toBe(child.pid)
    expect(value.executable.path).toMatch(/\/bin\/node$/u)
    expect(value.argvSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('parses the deployment path with the target macOS Bash 3.2 binary', () => {
    const deploy = resolve(projectRoot, 'scripts/deploy-blue-green.sh')
    const result = spawnSync('/bin/bash', [deploy, 'help'], { encoding: 'utf8', cwd: projectRoot })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('deploy-blue-green.sh bootstrap')
  })

  it('treats only pgrep exit 1 with empty output as zero workers', () => {
    expect(workerPidsFromPgrep(1, '')).toEqual([])
    expect(workerPidsFromPgrep(0, '123\n456\n')).toEqual([123, 456])
    expect(() => workerPidsFromPgrep(2, '')).toThrow(/process query failed/u)
    expect(() => workerPidsFromPgrep(1, '123')).toThrow(/process query failed/u)
  })

  it('holds a real SQLite writer reservation, attests it, and revokes cleanly', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-freeze-guard.')))
    roots.push(root)
    const state = join(root, 'state')
    const { database, n8nDatabase } = createGuardDatabases(root)
    const socket = join(state, 'guard.sock')
    const token = join(state, 'guard.token')
    mkdirSync(state, { mode: 0o700 })
    const legacy = await startLegacy(database)
    const child = spawn(process.execPath, [
      guard, 'serve', '--database', database, '--n8n-database', n8nDatabase,
      '--socket', socket, '--token-file', token,
      '--ttl-seconds', '300', '--legacy-pid', String(legacy.pid),
    ], { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    await waitFor(() => existsSync(socket) && existsSync(token)
      && guardStatus(socket, database, n8nDatabase).status === 0)

    const status = spawnSync(process.execPath, [
      guard, 'status', '--socket', socket, '--database', database, '--n8n-database', n8nDatabase,
    ], { encoding: 'utf8', cwd: projectRoot })
    expect(status.status, status.stderr).toBe(0)
    const attestation = JSON.parse(status.stdout)
    expect(attestation).toMatchObject({
      schema: 'video-autoworker-legacy-freeze-guard/v1',
      ready: true,
      mode: 'dual',
      pid: child.pid,
      database: fileIdentity(database),
      n8nDatabase: fileIdentity(n8nDatabase),
    })
    expect(attestation.expiresAt - attestation.issuedAt).toBe(300)
    const duplicate = spawnSync(process.execPath, [
      guard, 'serve', '--database', database, '--n8n-database', n8nDatabase,
      '--socket', socket, '--token-file', token,
      '--ttl-seconds', '300', '--legacy-pid', String(legacy.pid),
    ], { encoding: 'utf8', cwd: projectRoot })
    expect(duplicate.status).not.toBe(0)
    expect(guardStatus(socket, database, n8nDatabase).status).toBe(0)
    const legacyState = spawnSync('/bin/ps', ['-p', String(legacy.pid), '-o', 'state='], {
      encoding: 'utf8',
    }).stdout.trim()
    expect(legacyState.startsWith('T')).toBe(false)

    const blocked = spawnSync(process.execPath, ['-e', `
      const Database = require('better-sqlite3')
      const db = new Database(process.argv[1], { timeout: 0 })
      db.prepare('INSERT INTO probe(value) VALUES (1)').run()
    `, database], { encoding: 'utf8', cwd: projectRoot })
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('database is locked')
    const n8nBlocked = spawnSync(process.execPath, ['-e', `
      const Database = require('better-sqlite3')
      const db = new Database(process.argv[1], { timeout: 0 })
      db.prepare('INSERT INTO probe(value) VALUES (1)').run()
    `, n8nDatabase], { encoding: 'utf8', cwd: projectRoot })
    expect(n8nBlocked.status).not.toBe(0)
    expect(n8nBlocked.stderr).toContain('database is locked')

    const handedOff = spawnSync(process.execPath, [
      guard, 'handoff', '--socket', socket, '--token-file', token, '--database', database,
      '--n8n-database', n8nDatabase,
    ], { encoding: 'utf8', cwd: projectRoot })
    expect(handedOff.status, handedOff.stderr).toBe(0)
    const recoveryStatus = guardStatus(socket, database, n8nDatabase)
    expect(recoveryStatus.status, recoveryStatus.stderr).toBe(0)
    expect(JSON.parse(recoveryStatus.stdout).mode).toBe('recovery-hold')
    const missionDuringRecovery = new Database(database)
    missionDuringRecovery.prepare('INSERT INTO probe(value) VALUES (1)').run()
    missionDuringRecovery.close()
    const n8nStillBlocked = spawnSync(process.execPath, ['-e', `
      const Database = require('better-sqlite3')
      const db = new Database(process.argv[1], { timeout: 0 })
      db.prepare('INSERT INTO probe(value) VALUES (1)').run()
    `, n8nDatabase], { encoding: 'utf8', cwd: projectRoot })
    expect(n8nStillBlocked.status).not.toBe(0)
    expect(n8nStillBlocked.stderr).toContain('database is locked')

    const revoked = spawnSync(process.execPath, [
      guard, 'revoke', '--socket', socket, '--token-file', token, '--database', database,
      '--n8n-database', n8nDatabase,
    ], { encoding: 'utf8', cwd: projectRoot })
    expect(revoked.status, revoked.stderr).toBe(0)
    await waitFor(() => child.exitCode !== null || child.signalCode !== null)
    expect(existsSync(socket)).toBe(false)
    expect(existsSync(token)).toBe(false)
    const writable = new Database(database)
    writable.prepare('INSERT INTO probe(value) VALUES (1)').run()
    expect(writable.prepare('SELECT COUNT(*) AS count FROM probe').get()).toEqual({ count: 2 })
    writable.close()
    const n8nWritable = new Database(n8nDatabase)
    n8nWritable.prepare('INSERT INTO probe(value) VALUES (1)').run()
    n8nWritable.close()
    legacy.kill('SIGTERM')
    await waitFor(() => legacy.exitCode !== null || legacy.signalCode !== null)
  })

  it('recovers only verified stale guard socket/token state after a crash', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-freeze-stale.')))
    roots.push(root)
    const state = join(root, 'state')
    const { database, n8nDatabase } = createGuardDatabases(root)
    const socket = join(state, 'guard.sock')
    const token = join(state, 'guard.token')
    mkdirSync(state, { mode: 0o700 })
    const legacy = await startLegacy(database)
    const child = spawn(process.execPath, [
      guard, 'serve', '--database', database, '--n8n-database', n8nDatabase,
      '--socket', socket, '--token-file', token,
      '--ttl-seconds', '30', '--legacy-pid', String(legacy.pid),
    ], { cwd: projectRoot, stdio: ['ignore', 'ignore', 'pipe'] })
    let startupError = ''
    child.stderr?.on('data', chunk => { startupError += String(chunk) })
    children.push(child)
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(startupError || 'guard exited during startup')
      return existsSync(socket) && existsSync(token)
        && JSON.parse(readFileSync(token, 'utf8')).state === 'ready'
    }, 12_000).catch(error => {
      throw new Error(`${error.message}; guard=${startupError}; socket=${existsSync(socket)}; token=${existsSync(token)}`)
    })
    expect(guardStatus(socket, database, n8nDatabase).status).toBe(0)
    child.kill('SIGKILL')
    await waitFor(() => child.exitCode !== null || child.signalCode !== null)
    expect(existsSync(socket)).toBe(true)
    expect(existsSync(token)).toBe(true)
    const recovered = spawnSync(process.execPath, [
      guard, 'recover-stale', '--socket', socket, '--token-file', token, '--database', database,
      '--n8n-database', n8nDatabase,
    ], { encoding: 'utf8', cwd: projectRoot })
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(existsSync(socket)).toBe(false)
    expect(existsSync(token)).toBe(false)
    legacy.kill('SIGTERM')
    await waitFor(() => legacy.exitCode !== null || legacy.signalCode !== null)
  })

  it('rebuilds a dual recovery guard from one fresh capability and refuses replay', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'lfr.')))
    roots.push(root)
    const { database, n8nDatabase } = createGuardDatabases(root)
    const socket = join(root, 'g')
    const token = join(root, 't')
    const receipt = join(root, 'resume.receipt.json')
    const resumeToken = join(root, 'resume.token.json')
    const controllerStub = join(root, 'resume-controller.mjs')
    writeFileSync(receipt, '{}\n', { mode: 0o400 })
    chmodSync(receipt, 0o400)
    writeFileSync(resumeToken, '{"capability":"test"}\n', { mode: 0o600 })
    chmodSync(resumeToken, 0o600)
    writeFileSync(controllerStub, `#!${process.execPath}
import { existsSync, lstatSync, unlinkSync } from 'node:fs'
const command = process.argv[2]
const identity = pathname => {
  const value = lstatSync(pathname, { bigint: true })
  return { path: pathname, dev: value.dev.toString(), ino: value.ino.toString() }
}
if (!['verify-bootstrap-resume', 'consume-bootstrap-resume'].includes(command)) process.exit(2)
if (!existsSync(${JSON.stringify(resumeToken)})) process.exit(3)
if (command === 'consume-bootstrap-resume') unlinkSync(${JSON.stringify(resumeToken)})
const value = {
  mode: command,
  databases: {
    mission: identity(${JSON.stringify(database)}),
    n8n: identity(${JSON.stringify(n8nDatabase)}),
  },
  expiresAt: 2_000_000_000,
}
if (command === 'consume-bootstrap-resume') value.consumed = { path: ${JSON.stringify(join(root, 'consumed.json'))} }
process.stdout.write(JSON.stringify(value))
`, { mode: 0o700 })
    chmodSync(controllerStub, 0o700)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'test' as const,
      AIWORKER_TEST_LEGACY_FREEZE: '1',
      AIWORKER_TEST_LEGACY_FREEZE_BOOTSTRAP_CONTROLLER: controllerStub,
    }
    const child = spawn(process.execPath, [
      guard, 'serve-recovery', '--database', database, '--n8n-database', n8nDatabase,
      '--socket', socket, '--token-file', token, '--resume-receipt', receipt,
      '--resume-token', resumeToken, '--ttl-seconds', '300',
    ], { cwd: projectRoot, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let recoveryError = ''
    child.stderr?.on('data', (chunk: Buffer | string) => { recoveryError += String(chunk) })
    children.push(child)
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(recoveryError || 'recovery guard exited')
      return existsSync(socket) && existsSync(token)
        && guardStatus(socket, database, n8nDatabase).status === 0
    }).catch(error => { throw new Error(`${error.message}; guard=${recoveryError}`) })
    expect(existsSync(resumeToken)).toBe(false)
    const status = guardStatus(socket, database, n8nDatabase)
    expect(status.status, status.stderr).toBe(0)
    expect(JSON.parse(status.stdout).mode).toBe('dual-recovery')

    for (const pathname of [database, n8nDatabase]) {
      const blocked = spawnSync(process.execPath, ['-e', `
        const Database = require('better-sqlite3')
        const db = new Database(process.argv[1], { timeout: 0 })
        db.prepare('INSERT INTO probe(value) VALUES (1)').run()
      `, pathname], { encoding: 'utf8', cwd: projectRoot })
      expect(blocked.status).not.toBe(0)
      expect(blocked.stderr).toContain('database is locked')
    }
    const handedOff = spawnSync(process.execPath, [
      guard, 'handoff', '--socket', socket, '--token-file', token,
      '--database', database, '--n8n-database', n8nDatabase,
    ], { encoding: 'utf8', cwd: projectRoot })
    expect(handedOff.status, handedOff.stderr).toBe(0)
    expect(JSON.parse(guardStatus(socket, database, n8nDatabase).stdout).mode).toBe('recovery-hold')
    const revoked = spawnSync(process.execPath, [
      guard, 'revoke', '--socket', socket, '--token-file', token,
      '--database', database, '--n8n-database', n8nDatabase,
    ], { encoding: 'utf8', cwd: projectRoot })
    expect(revoked.status, revoked.stderr).toBe(0)
    await waitFor(() => child.exitCode !== null || child.signalCode !== null)

    const replay = spawnSync(process.execPath, [
      guard, 'serve-recovery', '--database', database, '--n8n-database', n8nDatabase,
      '--socket', socket, '--token-file', token, '--resume-receipt', receipt,
      '--resume-token', resumeToken, '--ttl-seconds', '300',
    ], { encoding: 'utf8', cwd: projectRoot, env })
    expect(replay.status).not.toBe(0)
  }, 15_000)

  it('refuses to recover an unbound startup socket even after the recorded PID is dead', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'lfg-start.')))
    roots.push(root)
    const state = join(root, 'state')
    const { database, n8nDatabase } = createGuardDatabases(root)
    const socket = join(state, 'guard.sock')
    const token = join(state, 'guard.token')
    mkdirSync(state, { mode: 0o700 })
    const legacy = await startLegacy(database)
    const child = spawn(process.execPath, [
      guard, 'serve', '--database', database, '--n8n-database', n8nDatabase,
      '--socket', socket, '--token-file', token,
      '--ttl-seconds', '30', '--legacy-pid', String(legacy.pid),
    ], { cwd: projectRoot, stdio: ['ignore', 'ignore', 'pipe'] })
    let startupError = ''
    child.stderr?.on('data', chunk => { startupError += String(chunk) })
    children.push(child)
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(startupError || 'guard exited during startup')
      return existsSync(socket) && existsSync(token)
        && JSON.parse(readFileSync(token, 'utf8')).state === 'ready'
    }, 12_000).catch(error => {
      throw new Error(`${error.message}; guard=${startupError}; socket=${existsSync(socket)}; token=${existsSync(token)}`)
    })
    expect(guardStatus(socket, database, n8nDatabase).status).toBe(0)
    child.kill('SIGKILL')
    await waitFor(() => child.exitCode !== null || child.signalCode !== null)
    const value = JSON.parse(readFileSync(token, 'utf8'))
    Object.assign(value, {
      state: 'starting', socketIdentity: null, ownerStartTime: null, ownerArgvSha256: null,
    })
    writeFileSync(token, JSON.stringify(value), { mode: 0o600 })
    const recovered = spawnSync(process.execPath, [
      guard, 'recover-stale', '--socket', socket, '--token-file', token, '--database', database,
      '--n8n-database', n8nDatabase,
    ], { encoding: 'utf8', cwd: projectRoot })
    expect(recovered.status).not.toBe(0)
    expect(recovered.stderr).toContain('not bound to the dead recorded owner')
    expect(existsSync(socket)).toBe(true)
    expect(existsSync(token)).toBe(true)
    unlinkSync(socket)
    unlinkSync(token)
    legacy.kill('SIGTERM')
    await waitFor(() => legacy.exitCode !== null || legacy.signalCode !== null)
  }, 15_000)

  it('recovers a socket that was atomically bound to a startup-state owner before ready', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'lfg-bound.')))
    roots.push(root)
    const state = join(root, 'state')
    const { database, n8nDatabase } = createGuardDatabases(root)
    const socket = join(state, 'guard.sock')
    const token = join(state, 'guard.token')
    mkdirSync(state, { mode: 0o700 })
    const legacy = await startLegacy(database)
    const child = spawn(process.execPath, [
      guard, 'serve', '--database', database, '--n8n-database', n8nDatabase,
      '--socket', socket, '--token-file', token,
      '--ttl-seconds', '30', '--legacy-pid', String(legacy.pid),
    ], {
      cwd: projectRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: {
        ...process.env,
        NODE_ENV: 'test',
        AIWORKER_TEST_LEGACY_FREEZE: '1',
        AIWORKER_TEST_LEGACY_FREEZE_READY_DELAY_MS: '2000',
      },
    })
    let startupError = ''
    child.stderr?.on('data', chunk => { startupError += String(chunk) })
    children.push(child)
    await waitFor(() => {
      if (child.exitCode !== null) throw new Error(startupError || 'guard exited during startup')
      return existsSync(socket) && existsSync(token)
        && JSON.parse(readFileSync(token, 'utf8')).state === 'starting-bound'
    }, 12_000).catch(error => {
      throw new Error(`${error.message}; guard=${startupError}; socket=${existsSync(socket)}; token=${existsSync(token)}`)
    })
    child.kill('SIGKILL')
    await waitFor(() => child.exitCode !== null || child.signalCode !== null)
    const recovered = spawnSync(process.execPath, [
      guard, 'recover-stale', '--socket', socket, '--token-file', token, '--database', database,
      '--n8n-database', n8nDatabase,
    ], { encoding: 'utf8', cwd: projectRoot })
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(existsSync(socket)).toBe(false)
    expect(existsSync(token)).toBe(false)
    legacy.kill('SIGTERM')
    await waitFor(() => legacy.exitCode !== null || legacy.signalCode !== null)
  }, 15_000)

  it('automatically releases the writer lock and private state at TTL', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-freeze-ttl.')))
    roots.push(root)
    const state = join(root, 'state')
    const { database, n8nDatabase } = createGuardDatabases(root)
    const socket = join(state, 'guard.sock')
    const token = join(state, 'guard.token')
    mkdirSync(state, { mode: 0o700 })
    const legacy = await startLegacy(database)
    const child = spawn(process.execPath, [
      guard, 'serve', '--database', database, '--n8n-database', n8nDatabase,
      '--socket', socket, '--token-file', token,
      '--ttl-seconds', '30', '--legacy-pid', String(legacy.pid),
    ], { cwd: projectRoot, stdio: 'ignore' })
    children.push(child)
    await waitFor(() => existsSync(socket) && existsSync(token)
      && guardStatus(socket, database, n8nDatabase).status === 0)
    const hangingClient = createConnection({ path: socket })
    await new Promise<void>((resolvePromise, reject) => {
      hangingClient.once('connect', resolvePromise)
      hangingClient.once('error', reject)
    })
    await waitFor(() => !existsSync(socket) && !existsSync(token), 35_000)
    await waitFor(() => child.exitCode !== null || child.signalCode !== null)
    expect(hangingClient.destroyed).toBe(true)
    const writable = new Database(database)
    writable.prepare('INSERT INTO probe(value) VALUES (1)').run()
    writable.close()
    const n8nWritable = new Database(n8nDatabase)
    n8nWritable.prepare('INSERT INTO probe(value) VALUES (1)').run()
    n8nWritable.close()
    legacy.kill('SIGTERM')
    await waitFor(() => legacy.exitCode !== null || legacy.signalCode !== null)
  }, 40_000)

  it('creates one exclusive mode-0600 v3 artifact from two stable guarded snapshots', () => {
    const entry = fixture()
    const result = spawnSync(process.execPath, entry.args, { encoding: 'utf8', env: entry.env })
    expect(result.status, result.stderr).toBe(0)
    const evidence = JSON.parse(readFileSync(entry.output, 'utf8'))
    expect(Object.keys(evidence).sort()).toEqual([
      'counts', 'frozen', 'generatorSha256', 'legacy', 'n8n', 'observedAt',
      'queueDigestSha256', 'rollback', 'schema', 'supervisor', 'target',
    ].sort())
    expect(evidence).toMatchObject({
      schema: 'video-autoworker-legacy-freeze-evidence/v3',
      counts: { mediaNodes: 0, n8nActiveExecutions: 0, queueWaiting: 0, queueRunning: 0 },
      target: { slot: 'blue', releaseId: entry.releaseId },
      supervisor: { disabled: true, loaded: false, workerPids: [], lockAbsent: true },
    })
    expect(evidence.frozen).not.toHaveProperty('signature')
    expect(lstatSync(entry.output).mode & 0o777).toBe(0o600)
    expect(lstatSync(entry.output).nlink).toBe(1)

    const evidenceFd = openSync(entry.output, 'r')
    const verified = spawnSync(process.execPath, [
      generator, '--verify-evidence-fd', '3', ...entry.args.slice(1),
    ], {
      encoding: 'utf8',
      env: entry.env,
      stdio: ['ignore', 'pipe', 'pipe', evidenceFd],
    })
    closeSync(evidenceFd)
    expect(verified.status, String(verified.stderr)).toBe(0)
    expect(String(verified.stdout).trim()).toBe(hash(readFileSync(entry.output)))

    const before = readFileSync(entry.output)
    const refused = spawnSync(process.execPath, entry.args, { encoding: 'utf8', env: entry.env })
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('output already exists')
    expect(readFileSync(entry.output)).toEqual(before)
  })

  it('rejects forged guards, active work and unstable samples', () => {
    const unsigned = fixture()
    writeFileSync(unsigned.snapshotPath, `${JSON.stringify({
      ...unsigned.snapshot,
      frozen: { ...unsigned.snapshot.frozen, database: fileIdentity(unsigned.snapshotPath) },
    })}\n`, { mode: 0o600 })
    const forged = spawnSync(process.execPath, unsigned.args, { encoding: 'utf8', env: unsigned.env })
    expect(forged.status).not.toBe(0)
    expect(forged.stderr).toContain('does not hold the authoritative')

    const active = fixture()
    writeFileSync(active.snapshotPath, `${JSON.stringify({
      ...active.snapshot,
      counts: { ...active.snapshot.counts, mediaNodes: 1 },
    })}\n`, { mode: 0o600 })
    const busy = spawnSync(process.execPath, active.args, { encoding: 'utf8', env: active.env })
    expect(busy.status).not.toBe(0)
    expect(busy.stderr).toContain('active production work is still present')

    const drift = fixture()
    const second = { ...drift.snapshot, queueDigestSha256: 'd'.repeat(64) }
    const counter = join(drift.root, 'counter')
    writeFileSync(drift.snapshotCommand, `#!${process.execPath}
const fs = require('node:fs')
const count = fs.existsSync(${JSON.stringify(counter)}) ? 2 : 1
fs.writeFileSync(${JSON.stringify(counter)}, String(count))
process.stdout.write(JSON.stringify(count === 1 ? ${JSON.stringify(drift.snapshot)} : ${JSON.stringify(second)}))
`, { mode: 0o700 })
    const changed = spawnSync(process.execPath, drift.args, { encoding: 'utf8', env: drift.env })
    expect(changed.status).not.toBe(0)
    expect(changed.stderr).toContain('changed between stable samples')
  })

  it('rejects unsafe output paths and database symlink/mode/FD identity attacks', () => {
    const outputAttack = fixture()
    chmodSync(outputAttack.outputDir, 0o755)
    const unsafeOutput = spawnSync(process.execPath, outputAttack.args, {
      encoding: 'utf8', env: outputAttack.env,
    })
    expect(unsafeOutput.status).not.toBe(0)
    expect(unsafeOutput.stderr).toContain('output directory mode is unsafe')

    const root = realpathSync(mkdtempSync(join(tmpdir(), 'legacy-freeze-db-')))
    roots.push(root)
    const database = join(root, 'database.sqlite')
    writeFileSync(database, 'sqlite', { mode: 0o600 })
    const expected = fileIdentity(database)
    const verifierRecord = { descriptor: '10r', ...expected }
    const connectionRecord = { descriptor: '11r', ...expected }
    expect(validateNewDatabaseConnection(expected, [verifierRecord], [
      verifierRecord, connectionRecord,
    ])).toBe('11r')
    expect(() => validateNewDatabaseConnection(expected, [verifierRecord], [verifierRecord]))
      .toThrow(/newly opened SQLite FD/u)
    expect(() => validateNewDatabaseConnection(expected, [verifierRecord], [
      verifierRecord, { ...connectionRecord, ino: String(Number(expected.ino) + 1) },
    ])).toThrow(/newly opened SQLite FD/u)
    expect(() => revalidateDatabaseConnection(expected, '11r', [connectionRecord])).not.toThrow()
    expect(() => revalidateDatabaseConnection(expected, '11r', [
      { ...connectionRecord, ino: String(Number(expected.ino) + 1) },
    ])).toThrow(/connection identity changed/u)
    expect(validateDatabaseBinding(database, [{ descriptor: '12', ...expected }]))
      .toEqual(expected)
    expect(() => validateDatabaseBinding(database, [{
      descriptor: '12', path: database, dev: expected.dev, ino: String(Number(expected.ino) + 1),
    }])).toThrow(/open-file identity/)
    chmodSync(database, 0o666)
    expect(() => validateDatabaseBinding(database, [{ descriptor: '12', ...expected }]))
      .toThrow(/mode is unsafe/)
    chmodSync(database, 0o600)
    const alias = join(root, 'database-alias.sqlite')
    symlinkSync(database, alias)
    expect(() => validateDatabaseBinding(alias, [{ descriptor: '12', ...expected, path: alias }]))
      .toThrow(/contains a symlink/)
  })

  it('keeps all production command and path overrides behind the explicit test gate', () => {
    const source = readFileSync(generator, 'utf8')
    expect(source).toContain("process.env.NODE_ENV === 'test'")
    expect(source).toContain("process.env.AIWORKER_TEST_LEGACY_FREEZE === '1'")
    for (const command of ['/usr/sbin/lsof', '/bin/launchctl', '/bin/ps']) {
      expect(source).toContain(command)
    }
    expect(source).not.toContain('/usr/bin/proc_pidpath')
    const deploy = readFileSync(resolve(projectRoot, 'scripts/deploy-blue-green.sh'), 'utf8')
    expect(deploy).toContain('video-autoworker-legacy-freeze-evidence/v3')
    expect(deploy).toContain('--verify-evidence-fd "$evidence_fd"')
    expect(deploy).toContain('--verify-evidence-static-fd "$evidence_fd"')
    expect(deploy).toContain('fs.fstatSync(fd, { bigint: true })')
    expect(deploy).not.toContain('video-autoworker-legacy-freeze-evidence/v2')
  })
})
