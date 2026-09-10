import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import {
  getN8nRollingDatabaseCompatibility,
  N8N_ROLLING_DATABASE_COMPATIBILITY,
} from '@/lib/n8n-runtime-affinity'

describe('n8n rolling database compatibility epoch', () => {
  it('keeps published migration 057 byte-stable while appending 058 and 059', () => {
    const source = readFileSync(join(process.cwd(), 'src/lib/migrations.ts'), 'utf8')
    const start = source.indexOf("  {\n    id: '057_n8n_director_evidence_outbox'")
    const end = source.indexOf("  {\n    id: '058_director_extraction_task_runs'", start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const publishedBlock = source.slice(start, end).trimEnd().replace(/,$/u, '')
    expect(createHash('sha256').update(publishedBlock).digest('hex')).toBe(
      'bf78ce0a0784e823261bc0e55e0e4ea23ec226013a70702faa3200e285d6d048',
    )
  })

  it('keeps the declared rolling epoch additive-only through migration 059', () => {
    expect(N8N_ROLLING_DATABASE_COMPATIBILITY).toEqual({
      schemaEpoch: 1,
      rollingSafeFrom: '052_n8n_intake_controls',
      latestMigration: '059_director_evidence_projection_receipts',
    })

    const source = readFileSync(join(process.cwd(), 'src/lib/migrations.ts'), 'utf8')
    const start = source.indexOf(`id: '${N8N_ROLLING_DATABASE_COMPATIBILITY.rollingSafeFrom}'`)
    const end = source.indexOf('\n]\n\nexport function runMigrations', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    const epoch = source.slice(start, end)
    const ids = [...epoch.matchAll(/\bid:\s*'(\d{3}_[^']+)'/gu)].map(match => match[1])
    expect(ids.at(-1)).toBe('059_director_evidence_projection_receipts')
    expect(epoch).not.toMatch(/\bdb\.(?:prepare|pragma|transaction)\s*\(/gu)
    const templates = [...epoch.matchAll(/\bdb\.exec\(\s*`([\s\S]*?)`\s*\)/gu)]
      .map(match => match[1])
    expect(templates.length).toBeGreaterThan(0)
    for (const sql of templates) {
      expect(sql).not.toContain('${')
      for (const statement of sql.split(';').map(value => value.trim()).filter(Boolean)) {
        expect(statement).toMatch(/^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS\b/iu)
      }
    }
  })

  it('attests the task-run-only extraction schema without rewriting the published root outbox', () => {
    const db = new Database(':memory:')
    try {
      db.pragma('foreign_keys = ON')
      runMigrations(db)
      expect(getN8nRollingDatabaseCompatibility(db))
        .toEqual(N8N_ROLLING_DATABASE_COMPATIBILITY)

      const tables = new Set((db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table'
      `).all() as Array<{ name: string }>).map(row => row.name))
      expect(tables.has('director_extraction_jobs')).toBe(false)
      expect(tables.has('director_extraction_backfill_rejections')).toBe(false)
      expect(tables.has('director_extraction_checkpoints')).toBe(true)
      expect(tables.has('director_extraction_projection_receipts')).toBe(true)
      expect(tables.has('director_extraction_review_receipts')).toBe(true)

      const outboxColumns = (db.prepare(`
        PRAGMA table_info(n8n_director_evidence_outbox)
      `).all() as Array<{ name: string }>).map(row => row.name)
      expect(outboxColumns).toEqual([
        'task_id', 'binding_id', 'tenant_id', 'workspace_id', 'work_id', 'query_digest',
        'projection_contract_digest', 'idempotency_key', 'result_sha256',
        'status', 'attempt_count', 'next_attempt_at', 'last_error_code',
        'delivered_at', 'created_at', 'updated_at',
      ])
      const checkpointColumns = (db.prepare(`
        PRAGMA table_info(director_extraction_checkpoints)
      `).all() as Array<{ name: string }>).map(row => row.name)
      expect(checkpointColumns).toEqual([
        'phase_task_id', 'phase', 'input_sha256', 'phase_input', 'output_sha256',
        'candidate_output', 'created_at',
      ])
      const projectionColumns = (db.prepare(`
        PRAGMA table_info(director_extraction_projection_receipts)
      `).all() as Array<{ name: string }>).map(row => row.name)
      expect(projectionColumns).toEqual([
        'phase_task_id', 'receipt_json', 'receipt_sha256', 'created_at',
      ])
      const reviewColumns = (db.prepare(`
        PRAGMA table_info(director_extraction_review_receipts)
      `).all() as Array<{ name: string }>).map(row => row.name)
      expect(reviewColumns).toEqual([
        'phase_task_id', 'receipt_type', 'reviewed_references', 'error_code',
        'receipt_sha256', 'created_at',
      ])
      for (const table of [
        'director_extraction_checkpoints',
        'director_extraction_projection_receipts',
        'director_extraction_review_receipts',
      ]) {
        expect(db.prepare(`PRAGMA foreign_key_list(${table})`).all()).toEqual(expect.arrayContaining([
          expect.objectContaining({ table: 'n8n_task_runs', from: 'phase_task_id', to: 'task_id' }),
        ]))
      }
    } finally {
      db.close()
    }
  })

  it('fails closed when a required migration row is missing', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      db.prepare('DELETE FROM schema_migrations WHERE id = ?')
        .run('058_director_extraction_task_runs')
      expect(() => getN8nRollingDatabaseCompatibility(db)).toThrow(/migration is missing/u)
    } finally {
      db.close()
    }
  })

  it('fails closed when a required immutable checkpoint column is counterfeit', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      db.exec(`
        DROP TABLE director_extraction_checkpoints;
        CREATE TABLE director_extraction_checkpoints (
          phase_task_id TEXT NOT NULL PRIMARY KEY,
          phase TEXT NOT NULL,
          input_sha256 TEXT NOT NULL,
          phase_input TEXT NOT NULL,
          output_sha256 TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
      `)
      expect(() => getN8nRollingDatabaseCompatibility(db))
        .toThrow(/director_extraction_checkpoints\.candidate_output/u)
    } finally {
      db.close()
    }
  })
})
