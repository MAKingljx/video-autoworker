import type Database from 'better-sqlite3'

export const DIRECTOR_MAINTAINABILITY_SCHEMA =
  'video-autoworker-director-maintainability-extension/v1'

const TABLE_COLUMNS = Object.freeze({
  director_review_batches: [
    'batch_id', 'tenant_id', 'workspace_id', 'actor_digest', 'request_digest', 'decision',
    'confirmation_code', 'status', 'target_count', 'completed_count', 'unknown_count',
    'expires_at', 'created_at', 'updated_at',
  ],
  director_review_batch_items: [
    'batch_id', 'ordinal', 'table_key', 'stable_id', 'work_id', 'initial_state',
    'initial_version', 'target_statuses', 'target_json', 'status', 'result_version', 'error_code',
    'updated_at',
  ],
  director_extraction_segments: [
    'phase_task_id', 'segment_index', 'segment_count', 'input_sha256', 'phase_input',
    'output_sha256', 'candidate_output', 'status', 'created_at', 'updated_at',
  ],
})
const TABLE_SQL_TOKENS = Object.freeze({
  director_review_batches: [
    "CHECK(status IN ('pending', 'applying', 'completed', 'cancelled', 'failed'))",
    'UNIQUE(tenant_id, workspace_id, actor_digest, request_digest)',
  ],
  director_review_batch_items: [
    "CHECK(status IN ('pending', 'completed', 'unknown', 'failed', 'stale'))",
    "error_code NOT GLOB '*[^A-Za-z0-9_:-]*'",
    'FOREIGN KEY(batch_id) REFERENCES director_review_batches(batch_id) ON DELETE CASCADE',
  ],
  director_extraction_segments: [
    "CHECK(status IN ('pending', 'completed'))",
    'FOREIGN KEY(phase_task_id) REFERENCES n8n_task_runs(task_id) ON DELETE CASCADE',
  ],
})
const verifiedDatabases = new WeakSet<object>()

export function ensureDirectorMaintainabilitySchema(db: Database.Database): void {
  if (verifiedDatabases.has(db)) return
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS director_review_batches (
      batch_id TEXT PRIMARY KEY,
      tenant_id INTEGER NOT NULL,
      workspace_id INTEGER NOT NULL,
      actor_digest TEXT NOT NULL
        CHECK(length(actor_digest) = 64 AND actor_digest NOT GLOB '*[^0-9a-f]*'),
      request_digest TEXT NOT NULL
        CHECK(length(request_digest) = 64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
      decision TEXT NOT NULL CHECK(decision IN ('approve', 'reject')),
      confirmation_code TEXT NOT NULL
        CHECK(length(confirmation_code) BETWEEN 6 AND 12
          AND confirmation_code NOT GLOB '*[^A-Z0-9]*'),
      status TEXT NOT NULL
        CHECK(status IN ('pending', 'applying', 'completed', 'cancelled', 'failed')),
      target_count INTEGER NOT NULL CHECK(target_count BETWEEN 1 AND 50),
      completed_count INTEGER NOT NULL DEFAULT 0 CHECK(completed_count >= 0),
      unknown_count INTEGER NOT NULL DEFAULT 0 CHECK(unknown_count >= 0),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(tenant_id, workspace_id, actor_digest, confirmation_code),
      UNIQUE(tenant_id, workspace_id, actor_digest, request_digest)
    );
    CREATE INDEX IF NOT EXISTS idx_director_review_batches_actor
      ON director_review_batches(
        tenant_id, workspace_id, actor_digest, status, updated_at DESC
      );

    CREATE TABLE IF NOT EXISTS director_review_batch_items (
      batch_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
      table_key TEXT NOT NULL,
      stable_id TEXT NOT NULL,
      work_id TEXT,
      initial_state TEXT NOT NULL,
      initial_version TEXT NOT NULL,
      target_statuses TEXT NOT NULL
        CHECK(json_valid(target_statuses) AND json_type(target_statuses) = 'array'),
      target_json TEXT NOT NULL
        CHECK(json_valid(target_json) AND json_type(target_json) = 'object'),
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'completed', 'unknown', 'failed', 'stale')),
      result_version TEXT,
      error_code TEXT CHECK(error_code IS NULL OR (
        length(error_code) BETWEEN 1 AND 200
        AND error_code NOT GLOB '*[^A-Za-z0-9_:-]*'
      )),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY(batch_id, ordinal),
      UNIQUE(batch_id, table_key, stable_id),
      FOREIGN KEY(batch_id) REFERENCES director_review_batches(batch_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS director_extraction_segments (
      phase_task_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL CHECK(segment_index >= 0),
      segment_count INTEGER NOT NULL CHECK(segment_count >= 1),
      input_sha256 TEXT NOT NULL
        CHECK(length(input_sha256) = 64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
      phase_input TEXT NOT NULL
        CHECK(json_valid(phase_input) AND json_type(phase_input) = 'object'),
      output_sha256 TEXT,
      candidate_output TEXT
        CHECK(candidate_output IS NULL OR (
          json_valid(candidate_output) AND json_type(candidate_output) = 'object'
        )),
      status TEXT NOT NULL CHECK(status IN ('pending', 'completed')),
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY(phase_task_id, segment_index),
      FOREIGN KEY(phase_task_id) REFERENCES n8n_task_runs(task_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_director_extraction_segments_progress
      ON director_extraction_segments(phase_task_id, status, segment_index);
    `)
  } catch {
    throw new Error('director_maintainability_schema_invalid')
  }
  for (const [table, expected] of Object.entries(TABLE_COLUMNS)) {
    const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>)
      .map(column => column.name)
    if (JSON.stringify(columns) !== JSON.stringify(expected)) {
      throw new Error('director_maintainability_schema_invalid')
    }
    const source = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`)
      .get(table) as { sql: string } | undefined
    const normalizedSql = source?.sql.replace(/\s+/gu, ' ') || ''
    if (!source || TABLE_SQL_TOKENS[table as keyof typeof TABLE_SQL_TOKENS]
      .some(token => !normalizedSql.includes(token.replace(/\s+/gu, ' ')))) {
      throw new Error('director_maintainability_schema_invalid')
    }
  }
  for (const index of ['idx_director_review_batches_actor',
    'idx_director_extraction_segments_progress']) {
    const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(index)
    if (!row) throw new Error('director_maintainability_schema_invalid')
  }
  verifiedDatabases.add(db)
}
