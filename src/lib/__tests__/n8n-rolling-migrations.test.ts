import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { runMigrations } from '@/lib/migrations'
import {
  getN8nRollingDatabaseCompatibility,
  N8N_ROLLING_DATABASE_COMPATIBILITY,
} from '@/lib/n8n-runtime-affinity'

describe('n8n rolling database compatibility epoch', () => {
  function replaceDirectorEvidenceOutbox(
    db: Database.Database,
    mutate: (sql: string) => string,
  ) {
    const table = db.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = 'n8n_director_evidence_outbox'
    `).get() as { sql: string }
    const changed = mutate(table.sql)
    expect(changed).not.toBe(table.sql)
    db.exec(`
      DROP TABLE n8n_director_evidence_outbox;
      ${changed};
      CREATE INDEX idx_n8n_director_evidence_outbox_due
        ON n8n_director_evidence_outbox(status, next_attempt_at, updated_at, task_id);
      CREATE INDEX idx_n8n_director_evidence_outbox_scope
        ON n8n_director_evidence_outbox(tenant_id, workspace_id, status, updated_at DESC);
    `)
  }

  it('keeps every migration in the declared epoch additive-only', () => {
    expect(N8N_ROLLING_DATABASE_COMPATIBILITY).toEqual({
      schemaEpoch: 1,
      rollingSafeFrom: '052_n8n_intake_controls',
      latestMigration: '057_n8n_director_evidence_outbox',
    })

    const source = readFileSync(join(process.cwd(), 'src/lib/migrations.ts'), 'utf8')
    const startMarker = `id: '${N8N_ROLLING_DATABASE_COMPATIBILITY.rollingSafeFrom}'`
    const start = source.indexOf(startMarker)
    const end = source.indexOf('\n]\n\nexport function runMigrations', start)
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)

    const rollingEpochSource = source.slice(start, end)
    const migrationIds = [...rollingEpochSource.matchAll(/\bid:\s*'(\d{3}_[^']+)'/gu)]
      .map(match => match[1])
    expect(migrationIds[0]).toBe(N8N_ROLLING_DATABASE_COMPATIBILITY.rollingSafeFrom)
    expect(migrationIds.at(-1)).toBe(N8N_ROLLING_DATABASE_COMPATIBILITY.latestMigration)

    // Epoch migrations may execute only static SQL templates through db.exec.
    // Any prepare/run/pragma/transaction path must raise the database epoch and
    // establish a new rolling-safe boundary before hot switching is re-enabled.
    const databaseCalls = [...rollingEpochSource.matchAll(/\bdb\.([A-Za-z_$][\w$]*)\s*\(/gu)]
      .map(match => match[1])
    expect(databaseCalls.length).toBeGreaterThan(0)
    expect(new Set(databaseCalls)).toEqual(new Set(['exec']))

    const sqlTemplates = [...rollingEpochSource.matchAll(/\bdb\.exec\(\s*`([\s\S]*?)`\s*\)/gu)]
      .map(match => match[1])
    expect(sqlTemplates).toHaveLength(databaseCalls.length)
    for (const sql of sqlTemplates) {
      expect(sql).not.toContain('${')
      const statements = sql.split(';').map(statement => statement.trim()).filter(Boolean)
      expect(statements.length).toBeGreaterThan(0)
      for (const statement of statements) {
        expect(statement).toMatch(/^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s+IF\s+NOT\s+EXISTS\b/iu)
        expect(statement).not.toMatch(/^\s*(?:ALTER|DROP|RENAME|UPDATE|DELETE|REPLACE|TRIGGER|PRAGMA)\b/iu)
      }
    }
  })

  it('attests applied migration rows plus the real rolling tables, columns, and indexes', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      expect(getN8nRollingDatabaseCompatibility(db))
        .toEqual(N8N_ROLLING_DATABASE_COMPATIBILITY)

      db.prepare('DELETE FROM schema_migrations WHERE id = ?')
        .run('054_n8n_task_dispatch_leases')
      expect(() => getN8nRollingDatabaseCompatibility(db)).toThrow(/migration is missing/)
    } finally {
      db.close()
    }
  })

  it('rejects counterfeit rolling tables with a required column missing', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      db.exec(`
        DROP INDEX idx_scheduler_leader_leases_expiry;
        DROP TABLE scheduler_leader_leases;
        CREATE TABLE scheduler_leader_leases (
          lease_name TEXT PRIMARY KEY,
          holder_id TEXT NOT NULL,
          lease_expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_scheduler_leader_leases_expiry
          ON scheduler_leader_leases(lease_expires_at);
      `)
      expect(() => getN8nRollingDatabaseCompatibility(db))
        .toThrow(/column is incompatible: scheduler_leader_leases\.revision/)
    } finally {
      db.close()
    }
  })

  it('rejects missing or directionally incompatible rolling indexes', () => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      db.exec(`
        DROP INDEX idx_n8n_intake_control_events_time;
        CREATE INDEX idx_n8n_intake_control_events_time
          ON n8n_intake_control_events(created_at ASC, id ASC);
      `)
      expect(() => getN8nRollingDatabaseCompatibility(db))
        .toThrow(/index columns are incompatible: idx_n8n_intake_control_events_time/)
    } finally {
      db.close()
    }
  })

  it.each([
    {
      name: 'idempotency uniqueness',
      mutate: (sql: string) => sql.replace(
        'idempotency_key TEXT NOT NULL UNIQUE',
        'idempotency_key TEXT NOT NULL',
      ),
      message: /idempotency identity is not unique/u,
    },
    {
      name: 'parent cascade reference',
      mutate: (sql: string) => sql.replace(
        /,\s*FOREIGN KEY \(task_id\) REFERENCES n8n_task_runs\(task_id\) ON DELETE CASCADE/u,
        '',
      ),
      message: /parent reference is incompatible/u,
    },
    {
      name: 'status check',
      mutate: (sql: string) => sql.replace(
        /\s*CHECK\(status IN \('pending', 'delivered', 'conflict'\)\)/u,
        '',
      ),
      message: /constraint is incompatible/u,
    },
    {
      name: 'query digest check',
      mutate: (sql: string) => sql.replace(
        /\s*CHECK\(length\(query_digest\) = 64\s+AND query_digest NOT GLOB '\*\[\^0-9a-f\]\*'\)/u,
        '',
      ),
      message: /constraint is incompatible/u,
    },
    {
      name: 'projection contract digest check',
      mutate: (sql: string) => sql.replace(
        /\s*CHECK\(length\(projection_contract_digest\) = 64\s+AND projection_contract_digest NOT GLOB '\*\[\^0-9a-f\]\*'\)/u,
        '',
      ),
      message: /constraint is incompatible/u,
    },
    {
      name: 'pending default',
      mutate: (sql: string) => sql.replace("DEFAULT 'pending'", "DEFAULT 'queued'"),
      message: /column is incompatible: n8n_director_evidence_outbox\.status/u,
    },
  ])('rejects a counterfeit director evidence outbox without $name', ({ mutate, message }) => {
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      replaceDirectorEvidenceOutbox(db, mutate)
      expect(() => getN8nRollingDatabaseCompatibility(db)).toThrow(message)
    } finally {
      db.close()
    }
  })
})
