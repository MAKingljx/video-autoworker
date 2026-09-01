#!/usr/bin/env node

import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  closeSync, constants, lstatSync, openSync, realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  projectOfflineQueue,
  scanOfflineDurableBatchStates,
} from './lib/runtime-safe-offline-queue.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const COMMIT = /^[a-f0-9]{40}$/u
const RELEASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u

function fail(message) {
  throw new Error(`shared_runtime_install_not_ready:${message}`)
}

function parseArguments(argv) {
  let missionControlDbPath = ''
  let n8nDbPath = ''
  let legacyAttemptDir = ''
  let videoBatchRoot = ''
  let expectedSourceCommit = ''
  let expectedReleaseId = ''
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--mission-control-db-path'
      && index + 1 < argv.length && !missionControlDbPath) {
      missionControlDbPath = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--n8n-db-path' && index + 1 < argv.length && !n8nDbPath) {
      n8nDbPath = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--legacy-attempt-dir' && index + 1 < argv.length && !legacyAttemptDir) {
      legacyAttemptDir = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--video-batch-root' && index + 1 < argv.length && !videoBatchRoot) {
      videoBatchRoot = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--expected-source-commit'
      && index + 1 < argv.length && !expectedSourceCommit) {
      expectedSourceCommit = argv[index + 1]
      index += 1
      continue
    }
    if (argv[index] === '--expected-release-id'
      && index + 1 < argv.length && !expectedReleaseId) {
      expectedReleaseId = argv[index + 1]
      index += 1
      continue
    }
    fail('usage')
  }
  if (!missionControlDbPath || !n8nDbPath || !videoBatchRoot
    || !expectedSourceCommit || !expectedReleaseId) fail('usage')
  return {
    missionControlDbPath,
    n8nDbPath,
    legacyAttemptDir,
    videoBatchRoot,
    expectedSourceCommit,
    expectedReleaseId,
  }
}

function physicalDatabase(pathname, label) {
  if (!isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) fail(`${label}_path_invalid`)
  let entry
  let physical
  try {
    entry = lstatSync(pathname)
    physical = realpathSync.native(pathname)
  } catch {
    fail(`${label}_missing`)
  }
  if (!entry.isFile() || entry.isSymbolicLink() || physical !== resolve(pathname)
    || entry.uid !== process.getuid() || entry.nlink !== 1 || (entry.mode & 0o0022) !== 0) {
    fail(`${label}_unsafe`)
  }
  return {
    path: physical,
    dev: BigInt(entry.dev).toString(),
    ino: BigInt(entry.ino).toString(),
  }
}

export function validateLegacyBootstrapStatus(
  status,
  expectedSourceCommit,
  expectedReleaseId,
) {
  if (!COMMIT.test(expectedSourceCommit)
    || !RELEASE_ID.test(expectedReleaseId)
    || expectedReleaseId !== `${expectedSourceCommit}-runtime`) {
    fail('expected_release_binding_invalid')
  }
  if (!['PREPARED', 'CURRENT_CONFIRMED', 'SHUTDOWN_REQUESTED'].includes(status?.phase)
    || status?.expired !== false || !status?.bindings?.evidence?.path
    || !status?.bindings?.proof?.path || !status?.bindings?.target?.releaseRoot
    || !status?.bindings?.databases?.mission || !status?.bindings?.databases?.n8n) {
    fail('legacy_attempt_not_current')
  }
  if (status.bindings.sourceCommit !== expectedSourceCommit
    || status.bindings.target.releaseId !== expectedReleaseId) {
    fail('legacy_target_binding_mismatch')
  }
  return status.bindings
}

function legacyBootstrapGate(attemptDirectory, expectedSourceCommit, expectedReleaseId) {
  if (!isAbsolute(attemptDirectory) || resolve(attemptDirectory) !== attemptDirectory) {
    fail('legacy_attempt_path_invalid')
  }
  const controller = join(repositoryRoot, 'scripts/legacy-bootstrap-controller.mjs')
  const verifier = join(repositoryRoot, 'scripts/generate-legacy-freeze-evidence.mjs')
  const productionEnvironment = { ...process.env, NODE_ENV: 'production' }
  for (const name of Object.keys(productionEnvironment)) {
    if (name.startsWith('AIWORKER_TEST_')) delete productionEnvironment[name]
  }
  let status
  try {
    const source = execFileSync(process.execPath, [
      controller, 'status', '--attempt-dir', attemptDirectory,
    ], {
      encoding: 'utf8',
      env: productionEnvironment,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    })
    status = JSON.parse(source)
  } catch {
    fail('legacy_attempt_invalid')
  }
  const bindings = validateLegacyBootstrapStatus(
    status,
    expectedSourceCommit,
    expectedReleaseId,
  )

  const evidenceFd = openSync(
    bindings.evidence.path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  try {
    const verified = spawnSync(process.execPath, [
      verifier,
      '--verify-evidence-fd', '3',
      '--output', bindings.evidence.path,
      '--slot', bindings.target.slot,
      '--release-id', bindings.target.releaseId,
      '--standalone-root', bindings.target.releaseRoot,
      '--rollback-proof', bindings.proof.path,
    ], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: productionEnvironment,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe', evidenceFd],
    })
    if (verified.error || verified.signal || verified.status !== 0
      || verified.stdout.trim() !== status.bindings.evidence.sha256) {
      fail('legacy_live_verification_failed')
    }
  } finally {
    closeSync(evidenceFd)
  }
  return bindings
}

function tableExists(database, name) {
  return Boolean(database.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name))
}

function requireTableColumns(database, table, required) {
  if (!tableExists(database, table)) fail(`${table}_missing`)
  const columns = new Set(database.pragma(`table_info(${table})`).map(row => row.name))
  if (required.some(column => !columns.has(column))) fail(`${table}_schema_invalid`)
}

function formalQueueProjection(database, batchRoot) {
  if (!isAbsolute(batchRoot) || resolve(batchRoot) !== batchRoot) {
    fail('video_batch_root_invalid')
  }
  let durable
  try {
    durable = scanOfflineDurableBatchStates(batchRoot)
  } catch {
    fail('video_batch_root_unsafe')
  }
  const rows = database.prepare(`
    SELECT task_id AS taskId, status, updated_at AS updatedAt
    FROM n8n_task_runs
    WHERE status IN (
      'queued', 'accepted', 'running', 'staging', 'submitted', 'waiting', 'recovering', 'paused'
    )
    ORDER BY created_at, id
  `).all()
  const projection = projectOfflineQueue(rows, durable, Math.floor(Date.now() / 1_000))
  return {
    ...projection,
    attentionStale: projection.values.filter(item => item.origin === 'attention-stale').length,
  }
}

export function verifySharedRuntimeInstallGate(
  {
    missionControlDbPath,
    n8nDbPath,
    legacyAttemptDir = '',
    videoBatchRoot,
    expectedSourceCommit,
    expectedReleaseId,
  },
  dependencies = { verifyLegacyAttempt: legacyBootstrapGate },
) {
  if (!COMMIT.test(expectedSourceCommit)
    || !RELEASE_ID.test(expectedReleaseId)
    || expectedReleaseId !== `${expectedSourceCommit}-runtime`) {
    fail('expected_release_binding_invalid')
  }
  const missionIdentity = physicalDatabase(missionControlDbPath, 'mission_control_database')
  const n8nIdentity = physicalDatabase(n8nDbPath, 'n8n_database')
  let Database
  try {
    Database = createRequire(join(repositoryRoot, 'package.json'))('better-sqlite3')
  } catch {
    fail('sqlite_runtime_unavailable')
  }

  let mission
  let n8n
  try {
    mission = new Database(missionIdentity.path, { readonly: true, fileMustExist: true })
    n8n = new Database(n8nIdentity.path, { readonly: true, fileMustExist: true })
    mission.pragma('query_only = ON')
    n8n.pragma('query_only = ON')
    if (mission.pragma('quick_check', { simple: true }) !== 'ok') {
      fail('mission_control_database_integrity_failed')
    }
    if (n8n.pragma('quick_check', { simple: true }) !== 'ok') {
      fail('n8n_database_integrity_failed')
    }

    mission.exec('BEGIN')
    n8n.exec('BEGIN')
    requireTableColumns(mission, 'n8n_task_runs', [
      'task_id', 'source', 'status', 'created_at', 'updated_at',
    ])
    requireTableColumns(n8n, 'execution_entity', ['status', 'stoppedAt'])
    const hasIntake = tableExists(mission, 'n8n_intake_controls')
    const hasOutbox = tableExists(mission, 'n8n_director_evidence_outbox')
    const queue = formalQueueProjection(mission, videoBatchRoot)
    const mediaActive = Number(mission.prepare(`
      SELECT COUNT(*) AS count
      FROM n8n_task_runs
      WHERE source = 'n8n-media-node'
        AND status IN ('queued', 'accepted', 'running')
    `).get()?.count)
    const n8nActive = Number(n8n.prepare(`
      SELECT COUNT(*) AS count
      FROM execution_entity
      WHERE status IN ('new', 'running', 'waiting') AND "stoppedAt" IS NULL
    `).get()?.count)
    if (!Number.isSafeInteger(mediaActive) || mediaActive !== 0) fail('active_media_nodes_present')
    if (!Number.isSafeInteger(n8nActive) || n8nActive !== 0) fail('active_n8n_executions_present')
    if (queue.waiting !== 0 || queue.running !== 0) fail('active_tasks_present')
    if (!hasIntake || !hasOutbox) {
      if (hasIntake !== hasOutbox) fail('rolling_schema_partial')
      if (!legacyAttemptDir) fail('legacy_attempt_required')
      if (!isAbsolute(legacyAttemptDir) || resolve(legacyAttemptDir) !== legacyAttemptDir) {
        fail('legacy_attempt_path_invalid')
      }
      n8n.exec('COMMIT')
      mission.exec('COMMIT')
      n8n.close()
      mission.close()
      n8n = undefined
      mission = undefined
      const bindings = dependencies.verifyLegacyAttempt(
        legacyAttemptDir,
        expectedSourceCommit,
        expectedReleaseId,
      )
      if (bindings?.sourceCommit !== expectedSourceCommit
        || bindings?.target?.releaseId !== expectedReleaseId) {
        fail('legacy_target_binding_mismatch')
      }
      if (bindings?.databases?.mission?.path !== missionIdentity.path
        || bindings?.databases?.mission?.dev !== missionIdentity.dev
        || bindings?.databases?.mission?.ino !== missionIdentity.ino) {
        fail('legacy_mission_database_mismatch')
      }
      if (bindings?.databases?.n8n?.path !== n8nIdentity.path
        || bindings?.databases?.n8n?.dev !== n8nIdentity.dev
        || bindings?.databases?.n8n?.ino !== n8nIdentity.ino) fail('legacy_n8n_database_mismatch')
      return {
        schema: 'video-autoworker-shared-runtime-install-gate/v1',
        mode: 'legacy-bootstrap',
        sourceCommit: bindings.sourceCommit,
        targetReleaseId: bindings.target.releaseId,
        intakeRevision: null,
        activeTasks: queue.waiting + queue.running,
        activeMediaNodes: mediaActive,
        activeN8nExecutions: n8nActive,
        waiting: queue.waiting,
        running: queue.running,
        attentionStale: queue.attentionStale,
        pendingOutbox: 0,
      }
    }

    const intake = mission.prepare(`
      SELECT accepting, revision
      FROM n8n_intake_controls
      WHERE control_id = 1
    `).get()
    const outbox = mission.prepare(`
      SELECT COUNT(*) AS count
      FROM n8n_director_evidence_outbox
      WHERE status = 'pending'
    `).get()
    n8n.exec('COMMIT')
    mission.exec('COMMIT')

    const revision = Number(intake?.revision)
    const activeTasks = queue.waiting + queue.running
    const pendingOutbox = Number(outbox?.count)
    if (intake?.accepting !== 0 || !Number.isSafeInteger(revision) || revision < 1) {
      fail('intake_not_paused')
    }
    if (!Number.isSafeInteger(activeTasks) || activeTasks !== 0) fail('active_tasks_present')
    if (!Number.isSafeInteger(pendingOutbox) || pendingOutbox !== 0) {
      fail('director_outbox_pending')
    }
    return {
      schema: 'video-autoworker-shared-runtime-install-gate/v1',
      mode: 'rolling',
      sourceCommit: expectedSourceCommit,
      targetReleaseId: expectedReleaseId,
      intakeRevision: revision,
      activeTasks,
      activeMediaNodes: mediaActive,
      activeN8nExecutions: n8nActive,
      waiting: queue.waiting,
      running: queue.running,
      attentionStale: queue.attentionStale,
      pendingOutbox,
    }
  } catch (error) {
    try { n8n?.exec('ROLLBACK') } catch { /* no active read transaction */ }
    try { mission?.exec('ROLLBACK') } catch { /* no active read transaction */ }
    if (error instanceof Error && error.message.startsWith('shared_runtime_install_not_ready:')) {
      throw error
    }
    fail('live_database_query_failed')
  } finally {
    try { n8n?.close() } catch { /* the failed process remains closed to installation */ }
    try { mission?.close() } catch { /* the failed process remains closed to installation */ }
  }
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    const result = verifySharedRuntimeInstallGate(parseArguments(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  }
}
