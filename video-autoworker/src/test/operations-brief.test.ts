// @vitest-environment node
import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createOperationsBrief, readRecordedModelUsage, summarizeReleaseDurations } from '../../scripts/operations-brief.mjs'
import { appendReleaseOperationEvent, RELEASE_OPERATION_SCOPE_SCHEMA } from '../../scripts/lib/release-operation.mjs'

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const roots: string[] = []
const servers: http.Server[] = []
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function fixture() {
  const root = realpathSync(mkdtempSync('/tmp/ops-brief-')); roots.push(root)
  const options = { runDir: join(root, 'run'), operationsRoot: join(root, 'ops'),
    databasePath: join(root, 'database.db'), workerStateDir: join(root, 'worker'), controlRoot: join(root, 'control') }
  for (const directory of [options.runDir, options.operationsRoot, options.workerStateDir, options.controlRoot]) mkdirSync(directory, { mode: 0o700 })
  const db = new Database(options.databasePath)
  db.exec('CREATE TABLE token_usage (input_tokens INTEGER, output_tokens INTEGER, created_at INTEGER, session_id TEXT, model TEXT)')
  db.prepare('INSERT INTO token_usage VALUES (20,30,?,?,?)').run(Math.floor(Date.now() / 1000), 'secret-session', 'private-model-name')
  db.close(); chmodSync(options.databasePath, 0o600)
  const info = lstatSync(options.databasePath)
  const identity = { dev: String(info.dev), ino: String(info.ino), pathSha256: digest(options.databasePath) }
  const worker = http.createServer((request, response) => {
    expect(request.method).toBe('GET'); expect(request.url).toBe('/status')
    response.end(JSON.stringify({ schema: 'video-autoworker-scheduler-worker/v1', executionMode: 'external-worker',
      currentState: 'ready', healthy: true, leaseVerified: true, leadership: { state: 'leader' }, observedAt: Date.now(),
      worker: { pid: process.pid, contentSha256: 'b'.repeat(64), database: identity },
      tasks: [{ taskId: 'do-not-output-business-id', message: 'do-not-output-log' }] }))
  })
  servers.push(worker)
  const socket = join(options.workerStateDir, 'worker.sock')
  await new Promise<void>(resolve => worker.listen(socket, () => resolve())); chmodSync(socket, 0o600)
  const releaseId = `${'a'.repeat(40)}-runtime`
  const router = http.createServer((request, response) => {
    expect(request.method).toBe('GET'); expect(request.url).toBe('/__router/health')
    response.end(JSON.stringify({ schema: 'video-autoworker-standalone-router-health/v1',
      ok: true, pid: process.pid, generation: 8, active: 'green', releaseId }))
  })
  servers.push(router)
  await new Promise<void>(resolve => router.listen(0, '127.0.0.1', () => resolve()))
  const address = router.address() as { port: number }
  const json = (pathname: string, value: unknown) => writeFileSync(pathname, JSON.stringify(value), { mode: 0o600 })
  json(join(options.runDir, 'router-state.json'), { schema: 'video-autoworker-standalone-router/v1',
    generation: 8, active: 'green', previous: 'blue', slots: {
      blue: { host: '127.0.0.1', port: 3018, releaseId: 'prior-runtime' },
      green: { host: '127.0.0.1', port: 3019, releaseId },
    } })
  json(join(options.runDir, 'router.runtime.json'), { schema: 'video-autoworker-standalone-router-runtime/v1',
    pid: process.pid, host: '127.0.0.1', port: address.port, stateFile: join(options.runDir, 'router-state.json') })
  for (const [name, content] of Object.entries({ 'package.json': '{"name":"video-autoworker"}', 'pnpm-lock.yaml': 'lockfileVersion: 9', 'next.config.js': 'module.exports={}' })) {
    writeFileSync(join(options.controlRoot, name), content)
  }
  const git = (...args: string[]) => execFileSync('/usr/bin/git', ['-C', options.controlRoot, ...args], { stdio: 'ignore' })
  git('init', '-b', 'main'); git('config', 'user.name', 'Brief Test'); git('config', 'user.email', 'brief@example.invalid')
  git('config', 'commit.gpgSign', 'false'); git('add', '.'); git('commit', '-m', 'fixture')
  git('remote', 'add', 'origin', 'https://github.com/MAKingljx/video-autoworker.git')
  return { root, options, identity }
}

describe('read-only operations brief', () => {
  it('reads real local sockets and SQLite while returning only bounded identities and numeric usage', async () => {
    const { options, identity } = await fixture()
    const before = digest(readFileSync(options.databasePath))
    const brief = await createOperationsBrief(options)
    expect(brief).toMatchObject({ currentState: 'observed', errorCode: null,
      router: { status: 'live', generation: 8 }, database: { status: 'reachable', identity },
      worker: { status: 'healthy' }, modelUsage: { status: 'recorded', inputTokens: 20, outputTokens: 30, totalTokens: 50 },
      deployment: { status: 'unknown', timings: { status: 'unknown', samples: 0, p50Ms: null, p95Ms: null } } })
    const source = JSON.stringify(brief)
    for (const secret of ['secret-session', 'private-model-name', 'do-not-output-business-id', 'do-not-output-log', options.databasePath]) {
      expect(source).not.toContain(secret)
    }
    expect(source.length).toBeLessThan(4096)
    expect(digest(readFileSync(options.databasePath))).toBe(before)
    const { stdout } = await promisify(execFile)(process.execPath, ['scripts/operations-brief.mjs',
      '--run-dir', options.runDir, '--operations-root', options.operationsRoot, '--database', options.databasePath,
      '--worker-state-dir', options.workerStateDir, '--control-root', options.controlRoot], { timeout: 15_000 })
    expect(JSON.parse(stdout)).toMatchObject({ currentState: 'observed', modelUsage: { totalTokens: 50 } })
    expect(stdout.trim().split('\n')).toHaveLength(1)
    expect(digest(readFileSync(options.databasePath))).toBe(before)
  })

  it('does not promote a historical summary to a current observation and rejects router drift', async () => {
    const { options } = await fixture()
    writeFileSync(join(options.operationsRoot, 'summary.json'), JSON.stringify({ status: 'healthy', generation: 999 }), { mode: 0o600 })
    const statePath = join(options.runDir, 'router-state.json')
    const state = JSON.parse(readFileSync(statePath, 'utf8')); state.generation = 9
    writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 })
    const brief = await createOperationsBrief(options)
    expect(brief.currentState).toBe('partial')
    expect(brief.router).toMatchObject({ status: 'unknown', errorCode: 'router_unavailable_or_changed' })
    expect(brief.deployment.timings.status).toBe('unknown')
    expect(JSON.stringify(brief)).not.toContain('999')
  })

  it('aggregates authenticated release journals and reports tampering without printing raw events', async () => {
    const { options } = await fixture()
    const journal = join(options.operationsRoot, '.plan.json.release-operation.jsonl')
    const scope = { schema: RELEASE_OPERATION_SCOPE_SCHEMA, operationId: 'c'.repeat(64) }
    appendReleaseOperationEvent(journal, scope, { step: 'prepare', status: 'completed', elapsedMs: 100 })
    appendReleaseOperationEvent(journal, scope, { step: 'prepare', status: 'completed', elapsedMs: 200 })
    appendReleaseOperationEvent(journal, scope, { step: 'operation', status: 'completed', elapsedMs: 900 })
    const brief = await createOperationsBrief(options)
    expect(brief.deployment).toMatchObject({ status: 'observed', latestRecordedState: 'completed', timings: {
      samples: 3, phases: expect.arrayContaining([{ phase: 'prepare', samples: 2, failed: 0, p50Ms: 100, p95Ms: 200 }]),
    } })
    expect(JSON.stringify(brief)).not.toContain(scope.operationId)
    writeFileSync(journal, readFileSync(journal, 'utf8').replace('"elapsedMs":100', '"elapsedMs":101'), { mode: 0o600 })
    const invalid = await createOperationsBrief(options)
    expect(invalid.deployment).toMatchObject({ status: 'partial', invalidJournals: 1, timings: { status: 'unknown' } })
  })

  it('keeps missing schemas, absent records and legacy zero defaults unknown', () => {
    const db = new Database(':memory:')
    try {
      expect(readRecordedModelUsage(db)).toMatchObject({ status: 'unknown', inputTokens: null })
      db.exec('CREATE TABLE token_usage (input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0, created_at INTEGER)')
      expect(readRecordedModelUsage(db)).toMatchObject({ status: 'unknown', errorCode: 'usage_no_records' })
      db.prepare('INSERT INTO token_usage (created_at) VALUES (?)').run(Math.floor(Date.now() / 1000))
      expect(readRecordedModelUsage(db)).toMatchObject({ status: 'unknown', errorCode: 'usage_values_unknown', inputTokens: null })
    } finally { db.close() }
    expect(summarizeReleaseDurations([])).toMatchObject({ status: 'unknown', p50Ms: null, p95Ms: null })
  })
})
