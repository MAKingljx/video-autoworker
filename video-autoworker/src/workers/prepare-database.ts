import Database from 'better-sqlite3'
import { lstatSync } from 'node:fs'
import { runMigrations, assertDatabaseSchemaCurrent } from '../lib/migrations'

/** Explicit maintenance entry. Normal web and worker startup never calls it. */
export function prepareExistingDatabase(pathname: string, options: { videoEditing?: boolean } = {}) {
  if (process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED === '1' && options.videoEditing !== true) {
    throw new Error('database_prepare_video_edit_explicit_opt_in_required')
  }
  const info = lstatSync(pathname)
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)
    || (typeof process.getuid === 'function' && info.uid !== process.getuid())) {
    throw new Error('database_prepare_target_unsafe')
  }
  const db = new Database(pathname, { fileMustExist: true })
  try {
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('database_prepare_integrity_failed')
    db.pragma('journal_mode = WAL')
    runMigrations(db, process.cwd(), { includeVideoEditing: options.videoEditing === true })
    assertDatabaseSchemaCurrent(db)
    return { currentState: 'prepared', database: { dev: String(info.dev), ino: String(info.ino) } }
  } finally { db.close() }
}
