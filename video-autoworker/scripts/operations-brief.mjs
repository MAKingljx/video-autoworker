#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readFileSync, realpathSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readIndependentWorkerStatus } from './lib/independent-worker-release.mjs'
import { gitSourceEnvironment, resolveGitSourceLayout } from './lib/git-source-layout.mjs'
import { readReleaseOperationJournal, releaseOperationStatus } from './lib/release-operation.mjs'
import { summarizeOperationsTelemetry } from './lib/operations-maintenance.mjs'
import { validateRouterState, ROUTER_HEALTH_SCHEMA, ROUTER_RUNTIME_SCHEMA } from './standalone-router.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const COMMIT = /^[a-f0-9]{40}$/u
const SHA = /^[a-f0-9]{64}$/u
const MAX_JOURNALS = 16
const MAX_ENTRIES = 256
const MAX_USAGE_ROWS = 10_000
const unknown = errorCode => ({ status: 'unknown', errorCode })

function boundedJson(pathname, maxBytes = 65_536) {
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const entry = fstatSync(fd)
    if (!entry.isFile() || entry.size > maxBytes || (entry.mode & 0o022)
      || (typeof process.getuid === 'function' && entry.uid !== process.getuid())) throw new Error('brief_file_unsafe')
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
}

function privateDirectory(pathname) {
  const entry = lstatSync(pathname)
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077)
    || (typeof process.getuid === 'function' && entry.uid !== process.getuid())) throw new Error('brief_directory_unsafe')
}

function databaseIdentity(pathname) {
  const entry = lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077)
    || (typeof process.getuid === 'function' && entry.uid !== process.getuid())) throw new Error('brief_database_unsafe')
  return { dev: String(entry.dev), ino: String(entry.ino), pathSha256: sha(realpathSync(pathname)) }
}

export function readRecordedModelUsage(database, { now = Date.now(), usageHours = 24 } = {}) {
  const since = Math.floor(now / 1000) - usageHours * 3600
  const unavailable = errorCode => ({ ...unknown(errorCode), source: 'token_usage',
    coverage: 'recorded_rows_only', since, rows: 0, inputTokens: null, outputTokens: null, totalTokens: null })
  try {
    const columns = database.prepare('PRAGMA table_info(token_usage)').all().map(row => row.name)
    if (!['input_tokens', 'output_tokens', 'created_at'].every(field => columns.includes(field))) return unavailable('usage_schema_unavailable')
    // Only numeric aggregates leave SQLite. Session, task, model IDs and text are never selected.
    const row = database.prepare(`
      SELECT COUNT(*) AS rows,
        SUM(CASE WHEN known THEN 1 ELSE 0 END) AS knownRows,
        SUM(CASE WHEN known THEN input_tokens ELSE NULL END) AS inputTokens,
        SUM(CASE WHEN known THEN output_tokens ELSE NULL END) AS outputTokens
      FROM (SELECT input_tokens, output_tokens,
        typeof(input_tokens) = 'integer' AND typeof(output_tokens) = 'integer'
        AND input_tokens >= 0 AND output_tokens >= 0
        AND input_tokens + output_tokens > 0 AS known
        FROM token_usage WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?)
    `).get(since, MAX_USAGE_ROWS)
    if (!row?.knownRows || ![row.inputTokens, row.outputTokens, row.inputTokens + row.outputTokens].every(Number.isSafeInteger)) {
      return { ...unavailable(row?.rows ? 'usage_values_unknown' : 'usage_no_records'), rows: row?.rows || 0 }
    }
    return { status: 'recorded', errorCode: null, source: 'token_usage', coverage: 'recorded_rows_only',
      since, rows: row.rows, knownRows: row.knownRows, unknownRows: row.rows - row.knownRows,
      limited: row.rows === MAX_USAGE_ROWS, inputTokens: row.inputTokens,
      outputTokens: row.outputTokens, totalTokens: row.inputTokens + row.outputTokens }
  } catch { return unavailable('usage_query_unavailable') }
}

function inspectDatabase(pathname, options) {
  let database
  try {
    const identity = databaseIdentity(pathname)
    const require = createRequire(import.meta.url)
    const Database = require('better-sqlite3')
    database = new Database(pathname, { readonly: true, fileMustExist: true, timeout: 3000 })
    database.pragma('query_only = ON')
    database.prepare('SELECT 1').get()
    const usage = readRecordedModelUsage(database, options)
    if (JSON.stringify(identity) !== JSON.stringify(databaseIdentity(pathname))) throw new Error('brief_database_changed')
    return { database: { status: 'reachable', identity }, modelUsage: usage }
  } catch {
    return { database: unknown('database_unavailable'), modelUsage: {
      ...unknown('database_unavailable'), inputTokens: null, outputTokens: null, totalTokens: null,
    } }
  } finally { database?.close() }
}

function readHttpJson(options) {
  return new Promise((resolveResult, reject) => {
    const request = http.get(options, response => {
      const chunks = []
      let size = 0
      response.on('data', chunk => {
        size += chunk.length
        if (size > 65_536) response.destroy(new Error('brief_response_too_large'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        try {
          if (response.statusCode !== 200) throw new Error('brief_request_failed')
          resolveResult(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch (error) { reject(error) }
      })
    })
    request.setTimeout(5000, () => request.destroy(new Error('brief_request_timeout')))
    request.on('error', reject)
  })
}

async function inspectRouter(runDir) {
  try {
    privateDirectory(runDir)
    const stateFile = join(runDir, 'router-state.json')
    const state = validateRouterState(boundedJson(stateFile))
    const runtime = boundedJson(join(runDir, 'router.runtime.json'))
    if (runtime.schema !== ROUTER_RUNTIME_SCHEMA || runtime.stateFile !== stateFile
      || !['127.0.0.1', '::1'].includes(runtime.host)
      || !Number.isSafeInteger(runtime.port) || runtime.port < 1 || runtime.port > 65535
      || !Number.isSafeInteger(runtime.pid) || runtime.pid < 1) throw new Error('brief_router_binding_invalid')
    const live = await readHttpJson({ host: runtime.host, port: runtime.port, path: '/__router/health' })
    if (live.schema !== ROUTER_HEALTH_SCHEMA || live.pid !== runtime.pid || live.ok !== true
      || live.generation !== state.generation || live.active !== state.active
      || live.releaseId !== state.slots[state.active].releaseId) throw new Error('brief_router_identity_mismatch')
    return { status: 'live', generation: live.generation, active: live.active,
      appRelease: live.releaseId, appEvidence: 'live_router_binding' }
  } catch { return unknown('router_unavailable_or_changed') }
}

async function inspectWorker(stateDir, database, now) {
  try {
    if (!database.identity) throw new Error('brief_worker_database_unknown')
    const value = await readIndependentWorkerStatus(stateDir)
    if (value?.schema !== 'video-autoworker-scheduler-worker/v1' || value.executionMode !== 'external-worker'
      || !Number.isSafeInteger(value.observedAt) || Math.abs(now - value.observedAt) > 15_000
      || !Number.isSafeInteger(value.worker?.pid) || value.worker.pid < 1
      || !SHA.test(value.worker?.contentSha256 || '')
      || Object.keys(database.identity).some(key => value.worker?.database?.[key] !== database.identity[key])) {
      throw new Error('brief_worker_identity_mismatch')
    }
    const healthy = value.healthy === true && value.leaseVerified === true
      && value.leadership?.state === 'leader' && value.currentState === 'ready'
    return { status: healthy ? 'healthy' : 'unhealthy', observedAt: value.observedAt,
      contentSha256: value.worker.contentSha256,
      errorCode: healthy ? null : 'worker_not_ready' }
  } catch { return unknown('worker_status_unavailable_or_changed') }
}

function inspectControl(controlRoot, runDir) {
  try {
    const { gitRoot } = resolveGitSourceLayout(controlRoot)
    const git = args => execFileSync('/usr/bin/git', ['-C', gitRoot, ...args], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 8192, env: gitSourceEnvironment(), stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const remote = git(['remote', 'get-url', 'origin'])
    if (!/^(?:https:\/\/github\.com\/|git@github\.com:)MAKingljx\/video-autoworker(?:\.git)?$/iu.test(remote)) {
      throw new Error('brief_control_repository_mismatch')
    }
    const gitCommit = git(['rev-parse', '--verify', 'HEAD^{commit}'])
    if (!COMMIT.test(gitCommit)) throw new Error('brief_control_commit_invalid')
    let installation = null
    try {
      const value = boundedJson(join(runDir, 'supervisor/installation.json'))
      if (value.runDir === runDir && SHA.test(value.execve?.sourceSha256 || '')) {
        installation = { sourceSha256: value.execve.sourceSha256, evidence: 'installation_receipt' }
      }
    } catch { /* A missing installation receipt does not change the checkout identity. */ }
    return { status: 'identified', gitCommit, gitEvidence: 'control_checkout', installation }
  } catch { return unknown('control_identity_unavailable') }
}

function listJournals(root) {
  privateDirectory(root)
  const candidates = []
  let limited = false
  const visit = (directory, depth) => {
    const dir = opendirSync(directory)
    let count = 0
    try {
      let entry
      while ((entry = dir.readSync())) {
        if (++count > MAX_ENTRIES) { limited = true; break }
        const pathname = join(directory, entry.name)
        if (entry.isFile() && entry.name.endsWith('.release-operation.jsonl')) {
          candidates.push({ pathname, mtime: lstatSync(pathname).mtimeMs })
        } else if (depth === 0 && entry.isDirectory() && count <= 64) {
          try { privateDirectory(pathname); visit(pathname, 1) } catch { limited = true }
        } else if (depth === 0 && entry.isDirectory()) limited = true
      }
    } finally { dir.closeSync() }
  }
  visit(root, 0)
  return { paths: candidates.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_JOURNALS).map(item => item.pathname),
    limited: limited || candidates.length > MAX_JOURNALS }
}

function percentile(values, percentile) {
  return values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(percentile * values.length) - 1)] : null
}

export function summarizeReleaseDurations(events) {
  const timed = events.filter(event => Number.isSafeInteger(event.elapsedMs) && ['completed', 'failed'].includes(event.status))
  if (!timed.length) return { status: 'unknown', samples: 0, p50Ms: null, p95Ms: null, phases: [] }
  const summary = summarizeOperationsTelemetry(timed.map(event => {
    const completedAtMs = Date.parse(event.at)
    return { phase: event.step, status: event.status === 'completed' ? 'succeeded' : 'failed',
      startedAtMs: Math.max(0, completedAtMs - event.elapsedMs), completedAtMs,
      retryCount: 0, waitLockMs: 0, bytes: 0, resources: [] }
  }))
  const grouped = new Map()
  for (const phase of summary.phases) {
    if (!grouped.has(phase.phase)) grouped.set(phase.phase, [])
    grouped.get(phase.phase).push(phase)
  }
  const durations = summary.phases.map(item => item.durationMs)
  return { status: 'observed', sampleUnit: 'terminal_step', samples: durations.length, p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95),
    phases: [...grouped].slice(0, 64).map(([phase, values]) => ({ phase, samples: values.length,
      failed: values.filter(item => item.status === 'failed').length,
      p50Ms: percentile(values.map(item => item.durationMs), 0.5), p95Ms: percentile(values.map(item => item.durationMs), 0.95) })) }
}

function inspectDeployments(root) {
  try {
    const { paths, limited } = listJournals(root)
    let invalidJournals = 0
    const journals = []
    for (const pathname of paths) {
      try { journals.push(readReleaseOperationJournal(pathname)) } catch { invalidJournals += 1 }
    }
    const events = [...new Map(journals.flat().map(event => [event.eventSha256, event])).values()]
    const recent = [...journals].filter(items => items.length).sort((a, b) => Date.parse(b.at(-1).at) - Date.parse(a.at(-1).at))[0]
    const latestState = recent ? releaseOperationStatus({ operationId: recent[0].operationId, sourceCommit: null }, recent).state : 'unknown'
    return { status: invalidJournals ? 'partial' : events.length ? 'observed' : 'unknown',
      scope: 'bounded_journals_only', journals: journals.length, invalidJournals, limited,
      nextAction: invalidJournals ? 'inspect_journal_integrity' : null,
      latestRecordedState: latestState, latestRecordedAt: recent?.at(-1).at || null,
      evidenceSha256: events.length ? sha(events.map(event => event.eventSha256).join('\n')) : null,
      timings: summarizeReleaseDurations(events) }
  } catch { return { ...unknown('release_journals_unavailable'), timings: summarizeReleaseDurations([]) } }
}

export async function createOperationsBrief({ runDir, operationsRoot, databasePath, workerStateDir, controlRoot, usageHours = 24, now = Date.now() }) {
  if (!Number.isInteger(usageHours) || usageHours < 1 || usageHours > 720) throw new Error('brief_usage_window_invalid')
  for (const pathname of [runDir, operationsRoot, databasePath, workerStateDir, controlRoot]) {
    if (typeof pathname !== 'string' || resolve(pathname) !== pathname) throw new Error('brief_path_invalid')
  }
  const db = inspectDatabase(databasePath, { now, usageHours })
  const [router, worker] = await Promise.all([inspectRouter(runDir), inspectWorker(workerStateDir, db.database, now)])
  const control = inspectControl(controlRoot, runDir)
  const deployment = inspectDeployments(operationsRoot)
  const failures = [db.database, router, worker, control].filter(item => ['unknown', 'unhealthy'].includes(item.status))
  return { schema: 'video-autoworker-operations-brief/v1', observedAt: new Date(now).toISOString(),
    currentState: worker.status === 'unhealthy' ? 'attention_required' : failures.length ? 'partial' : 'observed',
    errorCode: failures[0]?.errorCode || null, nextAction: failures.length ? 'inspect_unavailable_current_sources' : null,
    control, router, database: db.database, worker, deployment, modelUsage: db.modelUsage }
}

async function main(argv) {
  const options = {}
  const flags = { '--run-dir': 'runDir', '--operations-root': 'operationsRoot', '--database': 'databasePath',
    '--worker-state-dir': 'workerStateDir', '--control-root': 'controlRoot', '--usage-hours': 'usageHours' }
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]]
    if (!key || !argv[i + 1] || Object.hasOwn(options, key)) throw new Error('brief_arguments_invalid')
    options[key] = key === 'usageHours' ? Number(argv[i + 1]) : resolve(argv[i + 1])
  }
  const result = await createOperationsBrief(options)
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('{"currentState":"unknown","errorCode":"operations_brief_failed","nextAction":"check_explicit_inputs"}\n')
    process.exitCode = 1
  })
}
