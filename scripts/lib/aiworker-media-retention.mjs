import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdtemp, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'

const PLAN_SCHEMA = 'aiworker-media-retention-plan/v1'
const VIDEO_KEY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:mp4|mov|mkv|webm|m4v)$/iu
const WORKSPACE_PATTERN = /^[0-9a-f]{64}$/u
const SOURCE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SNAPSHOT_PREFIX = 'aiworker-media-retention-db-'

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function sha256File(pathname) {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(pathname)
    stream.on('error', rejectHash)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

function containsPath(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function requireCanonicalPath(pathname, expectedType, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname)) {
    throw new Error(`${label}_must_be_absolute`)
  }
  const normalized = resolve(pathname)
  const details = await lstat(normalized)
  if (details.isSymbolicLink()) throw new Error(`${label}_symlink_refused`)
  if (expectedType === 'directory' && !details.isDirectory()) {
    throw new Error(`${label}_must_be_directory`)
  }
  if (expectedType === 'file' && !details.isFile()) {
    throw new Error(`${label}_must_be_file`)
  }
  const physical = await realpath(normalized)
  return physical
}

function requireOlderThanHours(value) {
  if (!Number.isInteger(value) || value < 1 || value > 24 * 3650) {
    throw new Error('older_than_hours_out_of_range')
  }
  return value
}

async function fingerprintDatabaseSource(databasePath) {
  const files = []
  for (const suffix of ['', '-wal', '-shm']) {
    const pathname = `${databasePath}${suffix}`
    const details = await lstat(pathname).catch(error => {
      if (error?.code === 'ENOENT' && suffix) return null
      throw error
    })
    if (!details) {
      files.push({ suffix, state: 'absent' })
      continue
    }
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error(suffix ? 'database_sidecar_invalid' : 'database_path_must_be_file')
    }
    files.push({
      suffix,
      state: 'file',
      device: String(details.dev),
      inode: String(details.ino),
      bytes: Number(details.size),
      mtimeMs: details.mtimeMs,
      ctimeMs: details.ctimeMs,
      sha256: await sha256File(pathname),
    })
  }
  return files
}

async function createDatabaseSnapshot(databasePath) {
  const temporaryBase = await realpath(tmpdir())
  const created = await mkdtemp(resolve(temporaryBase, SNAPSHOT_PREFIX))
  await chmod(created, 0o700)
  const root = await realpath(created)
  if (dirname(root) !== temporaryBase || !basename(root).startsWith(SNAPSHOT_PREFIX)) {
    throw new Error('database_snapshot_root_invalid')
  }
  const snapshotPath = resolve(root, 'mission-control.db')
  try {
    const before = await fingerprintDatabaseSource(databasePath)
    await copyFile(databasePath, snapshotPath)
    const wal = before.find(item => item.suffix === '-wal')
    if (wal?.state === 'file') await copyFile(`${databasePath}-wal`, `${snapshotPath}-wal`)
    const after = await fingerprintDatabaseSource(databasePath)
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error('database_changed_during_snapshot')
    }
    return { root, path: snapshotPath }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function removeDatabaseSnapshot(root) {
  const temporaryBase = await realpath(tmpdir())
  const canonicalRoot = await realpath(root)
  if (dirname(canonicalRoot) !== temporaryBase || !basename(canonicalRoot).startsWith(SNAPSHOT_PREFIX)) {
    throw new Error('database_snapshot_cleanup_refused')
  }
  await rm(canonicalRoot, { recursive: true, force: false })
}

function queryDatabaseReferences(databasePath) {
  const database = new Database(databasePath, { fileMustExist: true })
  try {
    database.pragma('query_only = ON')
    const quickCheck = database.pragma('quick_check', { simple: true })
    if (quickCheck !== 'ok') throw new Error('database_quick_check_failed')
    const columns = database.prepare('PRAGMA table_info(n8n_task_runs)').all()
    const required = new Set([
      'task_id', 'status', 'attempt_count', 'max_attempts', 'input',
    ])
    for (const column of columns) required.delete(String(column.name))
    if (required.size > 0) throw new Error('database_schema_incompatible')
    const invalidInput = database.prepare(`
      SELECT count(*) AS count
      FROM n8n_task_runs
      WHERE NOT json_valid(input) OR coalesce(json_type(input), '') <> 'object'
    `).get()
    if (Number(invalidInput.count) > 0) throw new Error('database_input_json_invalid')

    const rows = database.prepare(`
      SELECT
        task_id,
        status,
        attempt_count,
        max_attempts,
        CASE
          WHEN json_type(input, '$.videoKey') = 'text' THEN json_extract(input, '$.videoKey')
          ELSE NULL
        END AS video_key,
        json_type(input, '$.videoKey') AS video_key_type
      FROM n8n_task_runs
      ORDER BY task_id ASC
    `).all()
    const inbox = new Map()
    const work = new Map()
    for (const row of rows) {
      const taskId = String(row.task_id)
      const reference = {
        taskIdHashSha256: sha256(taskId),
        status: String(row.status),
        attemptCount: Number(row.attempt_count),
        maxAttempts: Number(row.max_attempts),
      }
      const workspace = sha256(taskId)
      const workReferences = work.get(workspace) ?? []
      workReferences.push(reference)
      work.set(workspace, workReferences)

      if (row.video_key_type !== null && row.video_key_type !== 'text') {
        throw new Error('database_video_key_invalid')
      }
      const videoKey = typeof row.video_key === 'string' ? row.video_key : ''
      if (!videoKey) continue
      if (!VIDEO_KEY_PATTERN.test(videoKey)) throw new Error('database_video_key_invalid')
      const inboxReferences = inbox.get(videoKey) ?? []
      inboxReferences.push(reference)
      inbox.set(videoKey, inboxReferences)
    }
    return { inbox, work }
  } finally {
    database.close()
  }
}

async function readDatabaseReferences(databasePath) {
  const snapshot = await createDatabaseSnapshot(databasePath)
  try {
    return queryDatabaseReferences(snapshot.path)
  } finally {
    await removeDatabaseSnapshot(snapshot.root)
  }
}

function auditReference(reference) {
  return {
    taskIdHashSha256: reference.taskIdHashSha256,
    status: reference.status,
    attemptCount: reference.attemptCount,
    maxAttempts: reference.maxAttempts,
  }
}

function candidateFromStat({ kind, name, details, references }) {
  const protectedByDatabase = references.length > 0
  return {
    kind,
    name,
    bytes: Number(details.size),
    mtimeMs: Math.trunc(details.mtimeMs),
    device: String(details.dev),
    inode: String(details.ino),
    disposition: protectedByDatabase ? 'protected' : 'audit-only',
    reason: protectedByDatabase ? 'database-reference' : 'orphan-no-database-reference',
    databaseReferences: references.map(auditReference),
  }
}

async function scanRoot({ root, kind, namePattern, expectedType, cutoffMs, references }) {
  const candidates = []
  const rejections = []
  let recentIgnored = 0
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (!namePattern.test(entry.name)) continue
    const pathname = resolve(root, entry.name)
    if (!containsPath(root, pathname) || pathname === root) {
      rejections.push({ kind, nameHashSha256: sha256(entry.name), reason: 'path-outside-root' })
      continue
    }
    const details = await lstat(pathname).catch(() => null)
    if (!details) {
      rejections.push({ kind, nameHashSha256: sha256(entry.name), reason: 'stat-failed' })
      continue
    }
    if (details.isSymbolicLink()) {
      rejections.push({ kind, nameHashSha256: sha256(entry.name), reason: 'symlink-refused' })
      continue
    }
    const typeMatches = expectedType === 'file' ? details.isFile() : details.isDirectory()
    if (!typeMatches) {
      rejections.push({ kind, nameHashSha256: sha256(entry.name), reason: 'type-mismatch' })
      continue
    }
    if (details.mtimeMs > cutoffMs) {
      recentIgnored += 1
      continue
    }
    candidates.push(candidateFromStat({
      kind,
      name: entry.name,
      details,
      references: references.get(entry.name) ?? [],
    }))
  }
  return { candidates, recentIgnored, rejections }
}

function sortAuditEntries(entries) {
  return entries.sort((left, right) => (
    left.kind.localeCompare(right.kind, 'en')
    || String(left.name ?? left.nameHashSha256).localeCompare(
      String(right.name ?? right.nameHashSha256),
      'en',
    )
  ))
}

export function hashAuditPayload(payload) {
  return sha256(JSON.stringify(payload))
}

export async function buildMediaRetentionPlan({
  inboxRoot,
  workRoot,
  databasePath,
  olderThanHours,
  nowMs = Date.now(),
}) {
  const hours = requireOlderThanHours(olderThanHours)
  if (!Number.isSafeInteger(nowMs) || nowMs <= 0) throw new Error('invalid_now_ms')

  const canonicalInbox = await requireCanonicalPath(inboxRoot, 'directory', 'inbox_root')
  const canonicalWork = await requireCanonicalPath(workRoot, 'directory', 'work_root')
  const canonicalDatabase = await requireCanonicalPath(databasePath, 'file', 'database_path')
  if (containsPath(canonicalInbox, canonicalWork) || containsPath(canonicalWork, canonicalInbox)) {
    throw new Error('media_roots_must_be_disjoint')
  }
  if (containsPath(canonicalInbox, canonicalDatabase) || containsPath(canonicalWork, canonicalDatabase)) {
    throw new Error('database_inside_media_root_refused')
  }

  const references = await readDatabaseReferences(canonicalDatabase)
  const cutoffMs = nowMs - hours * 60 * 60 * 1000
  const [inboxScan, workScan] = await Promise.all([
    scanRoot({
      root: canonicalInbox,
      kind: 'inbox-video',
      namePattern: VIDEO_KEY_PATTERN,
      expectedType: 'file',
      cutoffMs,
      references: references.inbox,
    }),
    scanRoot({
      root: canonicalWork,
      kind: 'task-workspace',
      namePattern: WORKSPACE_PATTERN,
      expectedType: 'directory',
      cutoffMs,
      references: references.work,
    }),
  ])
  const candidates = sortAuditEntries([...inboxScan.candidates, ...workScan.candidates])
  const rejections = sortAuditEntries([...inboxScan.rejections, ...workScan.rejections])
  const payload = {
    schema: PLAN_SCHEMA,
    mode: 'dry-run',
    deletionSupported: false,
    generatedAt: new Date(nowMs).toISOString(),
    olderThanHours: hours,
    cutoffAt: new Date(cutoffMs).toISOString(),
    roots: {
      inbox: canonicalInbox,
      work: canonicalWork,
      database: canonicalDatabase,
    },
    policy: {
      databaseReferenced: 'protected',
      orphan: 'audit-only',
      symlink: 'refused',
    },
    candidates,
    rejections,
    summary: {
      candidates: candidates.length,
      protected: candidates.filter(item => item.disposition === 'protected').length,
      auditOnly: candidates.filter(item => item.disposition === 'audit-only').length,
      rejected: rejections.length,
      recentIgnored: inboxScan.recentIgnored + workScan.recentIgnored,
    },
  }
  return {
    ...payload,
    planHashSha256: hashAuditPayload(payload),
  }
}

export async function writeMediaRetentionPlan(planPath, plan) {
  if (typeof planPath !== 'string' || !isAbsolute(planPath)) {
    throw new Error('plan_out_must_be_absolute')
  }
  const requested = resolve(planPath)
  const parent = await requireCanonicalPath(dirname(requested), 'directory', 'plan_parent')
  const normalized = resolve(parent, basename(requested))
  if (normalized === parent) throw new Error('invalid_plan_out')
  const sourceRoot = await realpath(SOURCE_ROOT)
  if (containsPath(sourceRoot, normalized)) throw new Error('plan_out_inside_source_tree_refused')
  const parentMode = (await stat(parent)).mode & 0o777
  if (parentMode !== 0o700) throw new Error('plan_parent_must_be_private')
  const inbox = resolve(plan.roots.inbox)
  const work = resolve(plan.roots.work)
  if (containsPath(inbox, normalized) || containsPath(work, normalized)) {
    throw new Error('plan_out_inside_media_root_refused')
  }
  await writeFile(normalized, `${JSON.stringify(plan, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  })
  const written = await stat(normalized)
  if (!written.isFile()) throw new Error('plan_write_failed')
  return normalized
}
