import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { runMigrations, assertDatabaseSchemaCurrent } from '@/lib/migrations'
import { getN8nRollingDatabaseCompatibility } from '@/lib/n8n-runtime-affinity'
import { inspectVideoEditingSchema, inspectVideoStopSchema, VIDEO_STOP_SCHEMA_OBJECTS } from '@/lib/database-capabilities'

const original = process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED
afterEach(() => {
  if (original === undefined) delete process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED
  else process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED = original
})

describe('explicit video stop schema capability', () => {
  it('keeps old 060 readers compatible while requiring an explicit 061 prepare for new startup', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      for (const [name, [kind]] of Object.entries(VIDEO_STOP_SCHEMA_OBJECTS)) {
        if (kind === 'trigger') db.exec(`DROP TRIGGER ${name}`)
      }
      db.exec(`DROP TABLE n8n_video_stop_requests; DELETE FROM schema_migrations WHERE id='061_n8n_video_stop_requests'`)
      const before = db.prepare('SELECT total_changes() AS n').get()
      expect(inspectVideoStopSchema(db, false)).toBe(false)
      expect(getN8nRollingDatabaseCompatibility(db)).toMatchObject({ schemaEpoch: 1, latestMigration: '060_video_edit_task_receipts' })
      expect(() => assertDatabaseSchemaCurrent(db)).toThrow('database_schema_prepare_required')
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
    } finally { db.close() }
  })

  it.each(['missing-trigger', 'forged-trigger', 'missing-marker'])(
    'rejects an incomplete or broadened stop fence: %s', fault => {
      const db = new Database(':memory:')
      try {
        runMigrations(db)
        if (fault === 'missing-marker') db.exec(`DELETE FROM schema_migrations WHERE id='061_n8n_video_stop_requests'`)
        else {
          db.exec('DROP TRIGGER n8n_video_stop_fence_run_update')
          if (fault === 'forged-trigger') db.exec(`CREATE TRIGGER n8n_video_stop_fence_run_update
            BEFORE UPDATE ON n8n_task_runs BEGIN SELECT 1; END`)
        }
        expect(() => inspectVideoStopSchema(db)).toThrow(/database_stop_schema_(?:incomplete|incompatible)/u)
        expect(() => getN8nRollingDatabaseCompatibility(db)).toThrow()
        expect(() => assertDatabaseSchemaCurrent(db)).toThrow()
      } finally { db.close() }
    })
})

describe('optional video editing migration', () => {
  it('prepares stop 061 read-only without enabling optional editing 060', () => {
    delete process.env.AIWORKER_VIDEO_EDIT_ADMISSION_ENABLED
    const db = new Database(':memory:')
    try {
      runMigrations(db, process.cwd(), { includeVideoEditing: false })
      const before = db.prepare('SELECT total_changes() AS n').get()
      expect(() => assertDatabaseSchemaCurrent(db)).not.toThrow()
      expect(getN8nRollingDatabaseCompatibility(db).latestMigration).toBe('061_n8n_video_stop_requests')
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
      expect(getN8nRollingDatabaseCompatibility(db).latestMigration).toBe('061_n8n_video_stop_requests')
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
