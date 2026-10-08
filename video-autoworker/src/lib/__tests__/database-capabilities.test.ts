import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { runMigrations, assertDatabaseSchemaCurrent } from '@/lib/migrations'
import { getN8nRollingDatabaseCompatibility } from '@/lib/n8n-runtime-affinity'
import { inspectVideoEditingSchema } from '@/lib/database-capabilities'

const original = process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED
afterEach(() => {
  if (original === undefined) delete process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED
  else process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED = original
})

describe('optional video editing migration', () => {
  it('keeps core-only 059 read-only and deployable while editing is off', () => {
    delete process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED
    const db = new Database(':memory:')
    try {
      runMigrations(db, process.cwd(), { includeVideoEditing: false })
      const before = db.prepare('SELECT total_changes() AS n').get()
      expect(() => assertDatabaseSchemaCurrent(db)).not.toThrow()
      expect(getN8nRollingDatabaseCompatibility(db).latestMigration).toBe('059_director_evidence_projection_receipts')
      expect(inspectVideoEditingSchema(db)).toBe(false)
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
      process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED = '1'
      expect(() => assertDatabaseSchemaCurrent(db)).toThrow('database_schema_prepare_required')
      expect(() => getN8nRollingDatabaseCompatibility(db)).toThrow('database_capability_prepare_required')
    } finally { db.close() }
  })

  it('requires a complete optional migration and retains full validation after it is installed', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED = '1'
      expect(() => assertDatabaseSchemaCurrent(db)).not.toThrow()
      expect(getN8nRollingDatabaseCompatibility(db).latestMigration).toBe('060_video_edit_task_receipts')
      db.exec('DROP TABLE video_edit_operations')
      delete process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED
      expect(() => assertDatabaseSchemaCurrent(db)).toThrow('database_optional_schema_incomplete')
    } finally { db.close() }
  })

  it('does not silently treat orphan optional tables as a disabled feature', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      db.prepare("DELETE FROM schema_migrations WHERE id = '060_video_edit_task_receipts'").run()
      delete process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED
      expect(() => assertDatabaseSchemaCurrent(db)).toThrow('database_optional_schema_incomplete')
    } finally { db.close() }
  })
})
