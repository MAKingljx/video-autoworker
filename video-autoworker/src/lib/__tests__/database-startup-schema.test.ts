// @vitest-environment node
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { assertDatabaseSchemaCurrent, runMigrations } from '@/lib/migrations'

describe('production schema startup boundary', () => {
  it('rejects an unprepared database without creating a schema table', () => {
    const db = new Database(':memory:')
    try {
      expect(() => assertDatabaseSchemaCurrent(db)).toThrow()
      expect(db.prepare('SELECT name FROM sqlite_master').all()).toEqual([])
    } finally { db.close() }
  })

  it('verifies prepared schema without any SQLite write and refuses missing migrations', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      const before = db.prepare('SELECT total_changes() AS n').get()
      assertDatabaseSchemaCurrent(db)
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(before)
      db.prepare('DELETE FROM schema_migrations WHERE id = ?').run('053_scheduler_leader_lease')
      expect(() => assertDatabaseSchemaCurrent(db)).toThrow('database_schema_prepare_required')
      expect(db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get('053_scheduler_leader_lease')).toBeUndefined()
    } finally { db.close() }
  })
})
