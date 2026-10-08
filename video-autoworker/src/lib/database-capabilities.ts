import type Database from 'better-sqlite3'

export const VIDEO_EDIT_MIGRATION = '060_video_edit_task_receipts'
export const CORE_DATABASE_MIGRATION = '059_director_evidence_projection_receipts'
export const VIDEO_EDIT_TABLES = ['video_edit_plans', 'video_edit_operations'] as const

export function videoEditingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED === '1'
}

/** Capability absence is valid only when it is disabled. Partial migrations
 * are corruption, not an optional capability that can be silently ignored. */
export function inspectVideoEditingSchema(db: Database.Database, required = videoEditingEnabled()): boolean {
  const applied = Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?').get(VIDEO_EDIT_MIGRATION))
  const present = VIDEO_EDIT_TABLES.filter(name => Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name)))
  if ((applied && present.length !== VIDEO_EDIT_TABLES.length) || (!applied && present.length > 0)) {
    throw new Error('database_optional_schema_incomplete:video-edit')
  }
  if (required && !applied) throw new Error('database_capability_prepare_required:video-edit')
  return applied
}
