import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { mediaTaskWorkspace } from '@/lib/n8n-media-workspace'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function databasePath() {
  if (process.env.NODE_ENV === 'test' && process.env.AIWORKER_VIDEO_STOP_TEST_MODE === '1'
    && process.env.AIWORKER_TEST_N8N_DB_PATH) return process.env.AIWORKER_TEST_N8N_DB_PATH
  const managed = join(homedir(), 'ai-worker/state/n8n/.n8n/database.sqlite')
  if (process.env.AIWORKER_BG_N8N_DB_PATH && process.env.AIWORKER_BG_N8N_DB_PATH !== managed) {
    throw new Error('stop_n8n_database_binding_unconfirmed')
  }
  return managed
}

/** No API key, n8n mutation, database creation or journal-mode change. */
export function observeN8nExecutionForStop(executionOwner: string | null, workflowId: string, allowNotStarted: boolean) {
  if (!executionOwner && allowNotStarted) return { status: 'not_started' as const, executionOwner: null,
    evidenceSha256: digest({ executionOwner, allowNotStarted }) }
  let database: Database.Database | undefined
  try {
    const owner = /^n8n-execution:([A-Za-z0-9._-]+):([1-9][0-9]{0,18})$/u.exec(executionOwner || '')
    if (!owner || !workflowId || owner[1] !== workflowId) throw new Error('stop_n8n_owner_unconfirmed')
    const pathname = databasePath()
    if (!isAbsolute(pathname) || resolve(pathname) !== pathname || realpathSync.native(pathname) !== pathname) throw new Error('stop_n8n_database_unsafe')
    for (let cursor = pathname; cursor !== dirname(cursor); cursor = dirname(cursor)) {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('stop_n8n_database_unsafe')
    }
    const before = lstatSync(pathname, { bigint: true })
    if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || before.nlink !== BigInt(1)
      || (before.mode & BigInt(0o077)) !== BigInt(0)) throw new Error('stop_n8n_database_unsafe')
    database = new Database(pathname, { readonly: true, fileMustExist: true })
    database.pragma('query_only = ON')
    database.exec('BEGIN')
    const row = database.prepare(`SELECT id,"workflowId" AS workflowId,status,"stoppedAt" AS stoppedAt
      FROM execution_entity WHERE id=? AND "workflowId"=?`).get(owner[2], workflowId) as {
        id: number | string; workflowId: string; status: string; stoppedAt: string | null
      } | undefined
    database.exec('COMMIT')
    const after = lstatSync(pathname, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino || after.uid !== before.uid
      || after.mode !== before.mode || realpathSync.native(pathname) !== pathname) throw new Error('stop_n8n_database_identity_changed')
    const evidenceSha256 = digest({ database: { dev: String(before.dev), ino: String(before.ino),
      pathSha256: digest(pathname) }, row: row || null })
    if (!row || String(row.id) !== owner[2] || row.workflowId !== workflowId) throw new Error('stop_n8n_execution_not_found')
    if (['success', 'error', 'canceled', 'cancelled', 'crashed'].includes(row.status)
      && typeof row.stoppedAt === 'string' && Number.isFinite(Date.parse(row.stoppedAt))) {
      return { status: 'stopped' as const, executionOwner, evidenceSha256 }
    }
    if (['new', 'running', 'waiting'].includes(row.status) && row.stoppedAt === null) {
      return { status: 'running' as const, executionOwner, evidenceSha256 }
    }
    return { status: 'unconfirmed' as const, executionOwner, evidenceSha256 }
  } catch (error) {
    const code = error instanceof Error && /^stop_[a-z_]+$/u.test(error.message) ? error.message : 'stop_n8n_observation_unavailable'
    return { status: 'unconfirmed' as const, executionOwner, evidenceSha256: digest({ code }) }
  } finally { database?.close() }
}

/** Detect orphaned local audio/ffmpeg attempts too; never signals a process. */
export function observeVideoTaskLocalProcesses(taskId: string) {
  try {
    const workspace = mediaTaskWorkspace(taskId)
    const source = execFileSync('/bin/ps', ['-axo', 'pid=,uid=,stat=,command='], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 4 * 1024 * 1024,
    })
    const matches = source.split('\n').flatMap(line => {
      const row = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line)
      if (!row || row[3].startsWith('Z') || !row[4].includes(`${workspace}/`)) return []
      return [{ pid: Number(row[1]), uid: Number(row[2]) }]
    })
    return { status: matches.some(value => value.uid !== process.getuid!()) ? 'unconfirmed' as const
      : matches.length ? 'running' as const : 'stopped' as const, evidenceSha256: digest({ matches }) }
  } catch { return { status: 'unconfirmed' as const, evidenceSha256: digest({ code: 'stop_local_observation_unavailable' }) } }
}
