import { createHash, randomBytes } from 'node:crypto'
import { constants as fsConstants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { isAbsolute, join, normalize } from 'node:path'
import type Database from 'better-sqlite3'
import type { N8nIntakeControl } from '@/lib/n8n-intake-control'
import type { SchedulerLeadershipStatus } from '@/lib/scheduler'

export const N8N_RUNTIME_CALLBACK_PROTOCOL = 'slot-v1'
export const N8N_LEGACY_CALLBACK_PROTOCOL = 'legacy-v1'
export const N8N_CALLBACK_FREEZE_SCHEMA = 'video-autoworker-callback-freeze/v1' as const
export const N8N_RUNTIME_DRAIN_QUIET_SECONDS = 120
export const N8N_RUNTIME_DRAIN_SCHEMA = 'video-autoworker-runtime-drain/v1' as const
export const N8N_RELEASE_READINESS_SCHEMA = 'video-autoworker-release-readiness/v1' as const
export const N8N_ROLLING_DATABASE_COMPATIBILITY = {
  schemaEpoch: 1,
  rollingSafeFrom: '052_n8n_intake_controls',
  latestMigration: '057_n8n_director_evidence_outbox',
} as const

export type N8nRollingDatabaseCompatibility = typeof N8N_ROLLING_DATABASE_COMPATIBILITY

type RequiredColumn = {
  name: string
  type: 'INTEGER' | 'TEXT'
  notNull?: true
  primaryKey?: number
  defaultValue?: string
}

type RequiredIndex = {
  table: string
  name: string
  columns: string[]
  descending?: boolean[]
}

const REQUIRED_ROLLING_MIGRATIONS = [
  '052_n8n_intake_controls',
  '053_scheduler_leader_lease',
  '054_n8n_task_dispatch_leases',
  '055_n8n_child_execution_leases',
  '056_n8n_parent_execution_claims',
  '057_n8n_director_evidence_outbox',
] as const

const REQUIRED_ROLLING_TABLES: Record<string, RequiredColumn[]> = {
  schema_migrations: [
    { name: 'id', type: 'TEXT', primaryKey: 1 },
    { name: 'applied_at', type: 'INTEGER', notNull: true },
  ],
  n8n_intake_controls: [
    { name: 'control_id', type: 'INTEGER', primaryKey: 1 },
    { name: 'accepting', type: 'INTEGER', notNull: true },
    { name: 'reason', type: 'TEXT', notNull: true },
    { name: 'changed_by_id', type: 'INTEGER', notNull: true },
    { name: 'changed_by_name', type: 'TEXT', notNull: true },
    { name: 'changed_at', type: 'INTEGER', notNull: true },
    { name: 'revision', type: 'INTEGER', notNull: true },
  ],
  n8n_intake_control_events: [
    { name: 'id', type: 'INTEGER', primaryKey: 1 },
    { name: 'action', type: 'TEXT', notNull: true },
    { name: 'before_accepting', type: 'INTEGER', notNull: true },
    { name: 'after_accepting', type: 'INTEGER', notNull: true },
    { name: 'reason', type: 'TEXT', notNull: true },
    { name: 'actor_id', type: 'INTEGER', notNull: true },
    { name: 'actor_name', type: 'TEXT', notNull: true },
    { name: 'control_revision', type: 'INTEGER', notNull: true },
    { name: 'created_at', type: 'INTEGER', notNull: true },
  ],
  scheduler_leader_leases: [
    { name: 'lease_name', type: 'TEXT', primaryKey: 1 },
    { name: 'holder_id', type: 'TEXT', notNull: true },
    { name: 'lease_expires_at', type: 'INTEGER', notNull: true },
    { name: 'revision', type: 'INTEGER', notNull: true },
    { name: 'updated_at', type: 'INTEGER', notNull: true },
  ],
  n8n_task_dispatch_leases: [
    { name: 'task_id', type: 'TEXT', primaryKey: 1 },
    { name: 'tenant_id', type: 'INTEGER', notNull: true },
    { name: 'workspace_id', type: 'INTEGER', notNull: true },
    { name: 'owner_token', type: 'TEXT', notNull: true },
    { name: 'lease_expires_at', type: 'INTEGER', notNull: true },
    { name: 'revision', type: 'INTEGER', notNull: true },
    { name: 'created_at', type: 'INTEGER', notNull: true },
    { name: 'updated_at', type: 'INTEGER', notNull: true },
  ],
  n8n_child_execution_leases: [
    { name: 'task_id', type: 'TEXT', primaryKey: 1 },
    { name: 'tenant_id', type: 'INTEGER', notNull: true },
    { name: 'workspace_id', type: 'INTEGER', notNull: true },
    { name: 'owner_instance_id', type: 'TEXT', notNull: true },
    { name: 'lease_token', type: 'TEXT', notNull: true },
    { name: 'lease_expires_at', type: 'INTEGER', notNull: true },
    { name: 'heartbeat_at', type: 'INTEGER', notNull: true },
    { name: 'revision', type: 'INTEGER', notNull: true },
    { name: 'created_at', type: 'INTEGER', notNull: true },
    { name: 'updated_at', type: 'INTEGER', notNull: true },
  ],
  n8n_parent_execution_claims: [
    { name: 'task_id', type: 'TEXT', primaryKey: 1 },
    { name: 'tenant_id', type: 'INTEGER', notNull: true },
    { name: 'workspace_id', type: 'INTEGER', notNull: true },
    { name: 'execution_owner', type: 'TEXT', notNull: true },
    { name: 'created_at', type: 'INTEGER', notNull: true },
    { name: 'updated_at', type: 'INTEGER', notNull: true },
  ],
  n8n_director_evidence_outbox: [
    { name: 'task_id', type: 'TEXT', primaryKey: 1 },
    { name: 'binding_id', type: 'INTEGER', notNull: true },
    { name: 'tenant_id', type: 'INTEGER', notNull: true },
    { name: 'workspace_id', type: 'INTEGER', notNull: true },
    { name: 'work_id', type: 'TEXT', notNull: true },
    { name: 'query_digest', type: 'TEXT', notNull: true },
    { name: 'projection_contract_digest', type: 'TEXT', notNull: true },
    { name: 'idempotency_key', type: 'TEXT', notNull: true },
    { name: 'result_sha256', type: 'TEXT', notNull: true },
    { name: 'status', type: 'TEXT', notNull: true, defaultValue: "'pending'" },
    { name: 'attempt_count', type: 'INTEGER', notNull: true, defaultValue: '0' },
    { name: 'next_attempt_at', type: 'INTEGER', notNull: true, defaultValue: 'unixepoch()' },
    { name: 'last_error_code', type: 'TEXT' },
    { name: 'delivered_at', type: 'INTEGER' },
    { name: 'created_at', type: 'INTEGER', notNull: true, defaultValue: 'unixepoch()' },
    { name: 'updated_at', type: 'INTEGER', notNull: true, defaultValue: 'unixepoch()' },
  ],
}

const DIRECTOR_EVIDENCE_OUTBOX_SQL_CONSTRAINTS = [
  "CHECK(length(work_id) BETWEEN 1 AND 160 AND work_id NOT GLOB '*[^A-Za-z0-9._:-]*')",
  "CHECK(length(query_digest) = 64 AND query_digest NOT GLOB '*[^0-9a-f]*')",
  "CHECK(length(projection_contract_digest) = 64 AND projection_contract_digest NOT GLOB '*[^0-9a-f]*')",
  "CHECK(length(idempotency_key) = 64 AND idempotency_key NOT GLOB '*[^0-9a-f]*')",
  "CHECK(length(result_sha256) = 64 AND result_sha256 NOT GLOB '*[^0-9a-f]*')",
  "CHECK(status IN ('pending', 'delivered', 'conflict'))",
  'CHECK(attempt_count >= 0)',
  "CHECK(last_error_code IS NULL OR ( length(last_error_code) BETWEEN 1 AND 200 AND last_error_code NOT GLOB '*[^A-Za-z0-9_:-]*' ))",
] as const

const REQUIRED_ROLLING_INDEXES: RequiredIndex[] = [
  {
    table: 'n8n_intake_control_events',
    name: 'idx_n8n_intake_control_events_time',
    columns: ['created_at', 'id'],
    descending: [true, true],
  },
  {
    table: 'scheduler_leader_leases',
    name: 'idx_scheduler_leader_leases_expiry',
    columns: ['lease_expires_at'],
  },
  {
    table: 'n8n_task_dispatch_leases',
    name: 'idx_n8n_task_dispatch_leases_expiry',
    columns: ['lease_expires_at', 'task_id'],
  },
  {
    table: 'n8n_task_dispatch_leases',
    name: 'idx_n8n_task_dispatch_leases_scope',
    columns: ['tenant_id', 'workspace_id', 'updated_at'],
    descending: [false, false, true],
  },
  {
    table: 'n8n_child_execution_leases',
    name: 'idx_n8n_child_execution_leases_expiry',
    columns: ['lease_expires_at', 'task_id'],
  },
  {
    table: 'n8n_child_execution_leases',
    name: 'idx_n8n_child_execution_leases_owner',
    columns: ['owner_instance_id', 'lease_expires_at'],
  },
  {
    table: 'n8n_parent_execution_claims',
    name: 'idx_n8n_parent_execution_claims_owner',
    columns: ['tenant_id', 'workspace_id', 'execution_owner', 'updated_at'],
    descending: [false, false, false, true],
  },
  {
    table: 'n8n_director_evidence_outbox',
    name: 'idx_n8n_director_evidence_outbox_due',
    columns: ['status', 'next_attempt_at', 'updated_at', 'task_id'],
  },
  {
    table: 'n8n_director_evidence_outbox',
    name: 'idx_n8n_director_evidence_outbox_scope',
    columns: ['tenant_id', 'workspace_id', 'status', 'updated_at'],
    descending: [false, false, false, true],
  },
]

// Compute this once so repeated status calls cannot oscillate by one second as
// Date.now() and process.uptime() cross their fractional boundaries.
const PROCESS_STARTED_AT_SECONDS = Math.max(
  0,
  Math.floor(Date.now() / 1_000 - process.uptime()),
)
const PROCESS_EXECUTION_NONCE = randomBytes(32)

export type N8nRuntimeSlot = 'blue' | 'green'

export interface N8nRuntimeAffinity {
  callbackProtocol: typeof N8N_RUNTIME_CALLBACK_PROTOCOL
  runtimeSlot: N8nRuntimeSlot
  runtimeReleaseId: string
}

export interface N8nRuntimeIdentity extends N8nRuntimeAffinity {
  port: number
  startedAt: number
}

export type N8nCallbackAdmission =
  | { allowed: true; mode: 'slot' | 'legacy' }
  | {
    allowed: false
    code:
      | 'runtime_identity_invalid'
      | 'runtime_affinity_missing'
      | 'runtime_affinity_mismatch'
      | 'callback_freeze_invalid'
      | 'callback_frozen'
    error: string
  }

interface N8nCallbackFreezeMarker {
  schema: typeof N8N_CALLBACK_FREEZE_SCHEMA
  slot: N8nRuntimeSlot
  releaseId: string
  manifestSha256: string
  pid: number
  dbPath: string
  routerStatePath: string
  routerGeneration: number
  activeSlot: N8nRuntimeSlot
  requiredQuietSeconds: number
  runtimeStartedAt: number
  schedulerObservedAt: number
  routerActiveRequests: number
  routerUpgradedSockets: number
  freezeId: string
  frozenAt: number
  quiesceId: string | null
  quiescedAt: number | null
}

export interface N8nRuntimeDrainStatus {
  schema: typeof N8N_RUNTIME_DRAIN_SCHEMA
  globalScope: true
  runtime: N8nRuntimeIdentity
  counts: {
    tracked: number
    active: number
    queued: number
    accepted: number
    running: number
    topLevel: number
    mediaNodes: number
    modelNodes: number
    childExecutionLeases: number
    untrackedCallbacks: number
    otherReleaseActive: number
  }
  lastActivityAt: number | null
  quietSince: number
  quietSeconds: number
  requiredQuietSeconds: number
  safeToRetire: boolean
  observedAt: number
}

export interface N8nReleaseReadiness {
  schema: typeof N8N_RELEASE_READINESS_SCHEMA
  globalScope: true
  observedAt: number
  intake: {
    schema: N8nIntakeControl['schema']
    accepting: false
    mode: 'draining' | 'paused'
    revision: number
    counts: N8nIntakeControl['counts']
  }
  runtime: N8nRuntimeIdentity
  database: N8nRollingDatabaseCompatibility
  projection: {
    schema: 'video-autoworker-director-evidence-outbox-readiness/v1'
    contractDigest: string
    pending: number
    incompatiblePending: number
  }
  retirement: N8nRuntimeDrainStatus
  scheduler: SchedulerLeadershipStatus
}

type SqliteTableInfoRow = {
  name: string
  type: string
  notnull: number
  dflt_value: string | null
  pk: number
}

type SqliteIndexListRow = {
  name: string
  unique: number
  partial: number
  origin: string
}

type SqliteIndexInfoRow = {
  seqno: number
  name: string
  desc: number
  key: number
}

type SqliteForeignKeyRow = {
  table: string
  from: string
  to: string
  on_update: string
  on_delete: string
  match: string
}

function quotedSqliteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(identifier)) {
    throw new TypeError('n8n rolling schema identifier is invalid')
  }
  return `"${identifier}"`
}

/**
 * Attest the actual shared SQLite schema before publishing a rolling-release
 * compatibility epoch. Migration constants alone are not evidence that the
 * database opened by this process contains the required tables and indexes.
 */
export function getN8nRollingDatabaseCompatibility(
  db: Database.Database,
): N8nRollingDatabaseCompatibility {
  for (const [table, requiredColumns] of Object.entries(REQUIRED_ROLLING_TABLES)) {
    const tableRecord = db.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table) as { name?: string; sql?: string } | undefined
    if (tableRecord?.name !== table) throw new Error(`n8n rolling table is missing: ${table}`)

    const columns = db.prepare(
      `PRAGMA table_info(${quotedSqliteIdentifier(table)})`,
    ).all() as SqliteTableInfoRow[]
    const byName = new Map(columns.map(column => [column.name, column]))
    for (const required of requiredColumns) {
      const actual = byName.get(required.name)
      if (!actual || actual.type.toUpperCase() !== required.type
        || (required.notNull && actual.notnull !== 1)
        || (required.primaryKey !== undefined && actual.pk !== required.primaryKey)
        || (required.defaultValue !== undefined && actual.dflt_value !== required.defaultValue)) {
        throw new Error(`n8n rolling column is incompatible: ${table}.${required.name}`)
      }
    }

    if (table === 'n8n_director_evidence_outbox') {
      const compactSql = String(tableRecord.sql || '').replace(/\s+/gu, ' ').trim()
      for (const constraint of DIRECTOR_EVIDENCE_OUTBOX_SQL_CONSTRAINTS) {
        if (!compactSql.includes(constraint)) {
          throw new Error('n8n rolling director evidence constraint is incompatible')
        }
      }

      const indexes = db.prepare(
        `PRAGMA index_list(${quotedSqliteIdentifier(table)})`,
      ).all() as SqliteIndexListRow[]
      const uniqueIdentity = indexes.find((index) => {
        if (index.unique !== 1 || index.partial !== 0 || index.origin !== 'u') return false
        const columns = (db.prepare(
          `PRAGMA index_xinfo(${quotedSqliteIdentifier(index.name)})`,
        ).all() as SqliteIndexInfoRow[]).filter(column => column.key === 1)
        return columns.length === 1 && columns[0]?.name === 'idempotency_key'
      })
      if (!uniqueIdentity) {
        throw new Error('n8n rolling director evidence idempotency identity is not unique')
      }

      const foreignKeys = db.prepare(
        `PRAGMA foreign_key_list(${quotedSqliteIdentifier(table)})`,
      ).all() as SqliteForeignKeyRow[]
      const parentReference = foreignKeys.find(foreignKey => (
        foreignKey.table === 'n8n_task_runs'
        && foreignKey.from === 'task_id'
        && foreignKey.to === 'task_id'
        && foreignKey.on_update === 'NO ACTION'
        && foreignKey.on_delete === 'CASCADE'
        && foreignKey.match === 'NONE'
      ))
      if (!parentReference) {
        throw new Error('n8n rolling director evidence parent reference is incompatible')
      }
    }
  }

  const applied = new Set(
    (db.prepare(`
      SELECT id
      FROM schema_migrations
      WHERE id IN (${REQUIRED_ROLLING_MIGRATIONS.map(() => '?').join(', ')})
    `).all(...REQUIRED_ROLLING_MIGRATIONS) as Array<{ id: string }>).map(row => row.id),
  )
  for (const migration of REQUIRED_ROLLING_MIGRATIONS) {
    if (!applied.has(migration)) throw new Error(`n8n rolling migration is missing: ${migration}`)
  }

  for (const required of REQUIRED_ROLLING_INDEXES) {
    const indexes = db.prepare(
      `PRAGMA index_list(${quotedSqliteIdentifier(required.table)})`,
    ).all() as SqliteIndexListRow[]
    const actual = indexes.find(index => index.name === required.name)
    if (!actual || actual.unique !== 0 || actual.partial !== 0) {
      throw new Error(`n8n rolling index is missing or incompatible: ${required.name}`)
    }
    const columns = (db.prepare(
      `PRAGMA index_xinfo(${quotedSqliteIdentifier(required.name)})`,
    ).all() as SqliteIndexInfoRow[])
      .filter(column => column.key === 1)
      .sort((left, right) => left.seqno - right.seqno)
    const descending = required.descending ?? required.columns.map(() => false)
    if (columns.length !== required.columns.length
      || columns.some((column, index) => column.name !== required.columns[index]
        || Boolean(column.desc) !== descending[index])) {
      throw new Error(`n8n rolling index columns are incompatible: ${required.name}`)
    }
  }

  return { ...N8N_ROLLING_DATABASE_COMPATIBILITY }
}

interface DrainAggregateRow {
  tracked: number | null
  active: number | null
  queued: number | null
  accepted: number | null
  running: number | null
  top_level: number | null
  media_nodes: number | null
  model_nodes: number | null
  last_activity_at: number | null
}

interface DrainBlockerAggregateRow {
  count: number | null
  last_activity_at: number | null
}

function parsePort(value: string | undefined): number {
  const port = Number(value || 3017)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Video AutoWorker 运行端口无效')
  }
  return port
}

function parseStartedAt(now: number, uptimeSeconds: number): number {
  if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) {
    throw new Error('Video AutoWorker 运行时长无效')
  }
  return Math.max(0, now - Math.floor(uptimeSeconds))
}

/**
 * Return no affinity for the legacy single-process runtime. A partially
 * configured slot fails closed so callbacks can never be persisted without a
 * stable release owner.
 */
export function resolveN8nRuntimeIdentity(
  env: Record<string, string | undefined> = process.env,
  options: { nowSeconds?: number; uptimeSeconds?: number } = {},
): N8nRuntimeIdentity | null {
  const rawSlot = String(env.AIWORKER_SLOT || '').trim()
  const releaseId = String(env.AIWORKER_RELEASE_ID || '').trim()
  if (!rawSlot && !releaseId) return null
  if (rawSlot !== 'blue' && rawSlot !== 'green') {
    throw new Error('Video AutoWorker 运行槽位无效')
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(releaseId)) {
    throw new Error('Video AutoWorker release 标识无效')
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Video AutoWorker 运行时钟无效')
  return {
    callbackProtocol: N8N_RUNTIME_CALLBACK_PROTOCOL,
    runtimeSlot: rawSlot,
    runtimeReleaseId: releaseId,
    port: parsePort(env.PORT),
    startedAt: options.nowSeconds === undefined && options.uptimeSeconds === undefined
      ? PROCESS_STARTED_AT_SECONDS
      : parseStartedAt(now, options.uptimeSeconds ?? process.uptime()),
  }
}

export function resolveN8nRuntimeAffinity(
  env: Record<string, string | undefined> = process.env,
): N8nRuntimeAffinity | null {
  const identity = resolveN8nRuntimeIdentity(env)
  if (!identity) return null
  return {
    callbackProtocol: identity.callbackProtocol,
    runtimeSlot: identity.runtimeSlot,
    runtimeReleaseId: identity.runtimeReleaseId,
  }
}

/** Opaque, process-lifetime owner used only for durable child execution leases. */
export function resolveN8nRuntimeInstanceId(
  env: Record<string, string | undefined> = process.env,
): string {
  const runtime = resolveN8nRuntimeIdentity(env)
  const binding = runtime
    ? `${runtime.callbackProtocol}:${runtime.runtimeSlot}:${runtime.runtimeReleaseId}:${runtime.port}:${runtime.startedAt}`
    : `legacy:${PROCESS_STARTED_AT_SECONDS}`
  return createHash('sha256').update(PROCESS_EXECUTION_NONCE).update('\0').update(binding).digest('hex')
}

function freezeFilePath(
  runtime: N8nRuntimeAffinity,
  env: Record<string, string | undefined>,
): string {
  const explicit = String(env.AIWORKER_N8N_CALLBACK_FREEZE_FILE || '').trim()
  const runDir = String(env.AIWORKER_RUN_DIR || '').trim()
  const pathname = explicit || (runDir ? join(runDir, `${runtime.runtimeSlot}.callbacks-frozen.json`) : '')
  if (!pathname || !isAbsolute(pathname) || normalize(pathname) !== pathname || /[\u0000-\u001f\u007f]/u.test(pathname)) {
    throw new Error('callback freeze marker path is invalid')
  }
  return pathname
}

function readCallbackFreezeMarker(pathname: string): N8nCallbackFreezeMarker | null {
  let descriptor: number | null = null
  try {
    descriptor = openSync(pathname, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  try {
    const entry = fstatSync(descriptor)
    if (!entry.isFile() || (entry.mode & 0o777) !== 0o600
      || (typeof process.getuid === 'function' && entry.uid !== process.getuid())) {
      throw new Error('callback freeze marker is unsafe')
    }
    const value = JSON.parse(readFileSync(descriptor, 'utf8')) as Partial<N8nCallbackFreezeMarker>
    const expectedKeys = [
      'activeSlot', 'dbPath', 'freezeId', 'frozenAt', 'manifestSha256', 'pid',
      'quiesceId', 'quiescedAt', 'releaseId', 'requiredQuietSeconds',
      'routerActiveRequests', 'routerGeneration', 'routerStatePath',
      'routerUpgradedSockets', 'runtimeStartedAt', 'schedulerObservedAt', 'schema', 'slot',
    ]
    if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expectedKeys)
      || value.schema !== N8N_CALLBACK_FREEZE_SCHEMA
      || !['blue', 'green'].includes(String(value.slot))
      || !['blue', 'green'].includes(String(value.activeSlot))
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(String(value.releaseId || ''))
      || !/^[a-f0-9]{64}$/u.test(String(value.manifestSha256 || ''))
      || !Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
      || typeof value.dbPath !== 'string' || !isAbsolute(value.dbPath)
      || typeof value.routerStatePath !== 'string' || !isAbsolute(value.routerStatePath)
      || !Number.isSafeInteger(value.routerGeneration) || Number(value.routerGeneration) < 1
      || !Number.isSafeInteger(value.requiredQuietSeconds)
      || Number(value.requiredQuietSeconds) < 30 || Number(value.requiredQuietSeconds) > 900
      || !Number.isSafeInteger(value.runtimeStartedAt) || Number(value.runtimeStartedAt) < 0
      || !Number.isSafeInteger(value.schedulerObservedAt) || Number(value.schedulerObservedAt) < 0
      || value.routerActiveRequests !== 0 || value.routerUpgradedSockets !== 0
      || !/^[a-f0-9]{64}$/u.test(String(value.freezeId || ''))
      || !Number.isSafeInteger(value.frozenAt) || Number(value.frozenAt) < 0
      || !(
        value.quiesceId === null && value.quiescedAt === null
        || /^[a-f0-9]{64}$/u.test(String(value.quiesceId || ''))
          && Number.isSafeInteger(value.quiescedAt) && Number(value.quiescedAt) >= Number(value.frozenAt)
      )) {
      throw new Error('callback freeze marker is invalid')
    }
    return value as N8nCallbackFreezeMarker
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Admit an n8n callback only to the runtime release that originally owned its
 * parent task. Legacy callbacks need an explicit protocol or a temporary,
 * explicit compatibility switch; missing affinity is never inferred.
 */
export function checkN8nCallbackAdmission(
  routing: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): N8nCallbackAdmission {
  let runtime: N8nRuntimeAffinity | null
  try {
    runtime = resolveN8nRuntimeAffinity(env)
  } catch {
    return { allowed: false, code: 'runtime_identity_invalid', error: '回调运行时归属配置无效' }
  }

  const callbackProtocol = typeof routing.callbackProtocol === 'string'
    ? routing.callbackProtocol.trim()
    : ''
  const runtimeSlot = typeof routing.runtimeSlot === 'string' ? routing.runtimeSlot.trim() : ''
  const runtimeReleaseId = typeof routing.runtimeReleaseId === 'string'
    ? routing.runtimeReleaseId.trim()
    : ''

  if (!runtime) {
    const explicitLegacy = callbackProtocol === N8N_LEGACY_CALLBACK_PROTOCOL
      && !runtimeSlot && !runtimeReleaseId
    const compatibilityLegacy = env.AIWORKER_ALLOW_LEGACY_N8N_CALLBACKS === '1'
      && !callbackProtocol && !runtimeSlot && !runtimeReleaseId
    if (explicitLegacy || compatibilityLegacy) return { allowed: true, mode: 'legacy' }
    return { allowed: false, code: 'runtime_affinity_missing', error: '父任务缺少显式回调运行时归属' }
  }

  if (callbackProtocol !== runtime.callbackProtocol
    || runtimeSlot !== runtime.runtimeSlot
    || runtimeReleaseId !== runtime.runtimeReleaseId) {
    return { allowed: false, code: 'runtime_affinity_mismatch', error: '父任务回调属于其他运行版本' }
  }

  let marker: N8nCallbackFreezeMarker | null
  try {
    marker = readCallbackFreezeMarker(freezeFilePath(runtime, env))
  } catch {
    return { allowed: false, code: 'callback_freeze_invalid', error: '回调冻结标记无效，已拒绝执行' }
  }
  if (!marker) return { allowed: true, mode: 'slot' }
  if (marker.slot !== runtime.runtimeSlot || marker.releaseId !== runtime.runtimeReleaseId) {
    return { allowed: false, code: 'callback_freeze_invalid', error: '回调冻结标记与当前运行版本不匹配' }
  }
  return { allowed: false, code: 'callback_frozen', error: '当前运行版本已冻结回调接入' }
}

/**
 * Build the machine-readable switch precondition. Existing work may remain
 * active because callbacks stay pinned to their originating release; only the
 * process-wide admission gate must already be closed.
 */
export function buildN8nReleaseReadiness(
  control: N8nIntakeControl,
  runtime: N8nRuntimeIdentity,
  retirement: N8nRuntimeDrainStatus,
  scheduler: SchedulerLeadershipStatus,
  database: N8nRollingDatabaseCompatibility,
  projection: N8nReleaseReadiness['projection'],
  options: { nowSeconds?: number } = {},
): N8nReleaseReadiness {
  if (!control.globalScope || control.accepting || control.mode === 'active') {
    throw new Error('n8n global intake gate is still accepting new tasks')
  }
  const observedAt = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  if (!Number.isSafeInteger(observedAt) || observedAt < 0) {
    throw new TypeError('n8n release readiness clock is invalid')
  }
  if (
    retirement.runtime.callbackProtocol !== runtime.callbackProtocol
    || retirement.runtime.runtimeSlot !== runtime.runtimeSlot
    || retirement.runtime.runtimeReleaseId !== runtime.runtimeReleaseId
    || retirement.runtime.port !== runtime.port
    || retirement.runtime.startedAt !== runtime.startedAt
  ) throw new TypeError('n8n release retirement identity does not match the current runtime')
  if (database.schemaEpoch !== N8N_ROLLING_DATABASE_COMPATIBILITY.schemaEpoch
    || database.rollingSafeFrom !== N8N_ROLLING_DATABASE_COMPATIBILITY.rollingSafeFrom
    || database.latestMigration !== N8N_ROLLING_DATABASE_COMPATIBILITY.latestMigration) {
    throw new TypeError('n8n rolling database compatibility was not verified')
  }
  if (projection.schema !== 'video-autoworker-director-evidence-outbox-readiness/v1'
    || !/^[a-f0-9]{64}$/u.test(projection.contractDigest)
    || !Number.isSafeInteger(projection.pending) || projection.pending < 0
    || !Number.isSafeInteger(projection.incompatiblePending)
    || projection.incompatiblePending < 0
    || projection.incompatiblePending > projection.pending) {
    throw new TypeError('n8n director evidence projection readiness is invalid')
  }
  if (scheduler.state === 'unknown' || scheduler.state === 'unavailable') {
    throw new TypeError('n8n scheduler leadership is not available for release')
  }
  if (!['leader', 'follower', 'inactive'].includes(scheduler.state)
    || !Number.isSafeInteger(scheduler.observedAt) || scheduler.observedAt < 0
    || scheduler.observedAt > observedAt
    || !Number.isSafeInteger(scheduler.activeJobs) || scheduler.activeJobs < 0
    || !Number.isSafeInteger(scheduler.routerGeneration)
    || Number(scheduler.routerGeneration) < 1
    || typeof scheduler.reason !== 'string' || scheduler.reason.length < 1
    || scheduler.reason.length > 120
    || typeof scheduler.leaseExpired !== 'boolean') {
    throw new TypeError('n8n scheduler leadership status is invalid')
  }
  if (scheduler.state === 'inactive') {
    if (scheduler.leaseExpiresAt !== null || scheduler.leaseExpired || scheduler.activeJobs !== 0) {
      throw new TypeError('n8n inactive scheduler status is inconsistent')
    }
  } else if (!Number.isSafeInteger(scheduler.leaseExpiresAt)
    || Number(scheduler.leaseExpiresAt) < 0
    || (scheduler.state === 'leader'
      && (scheduler.leaseExpired || Number(scheduler.leaseExpiresAt) <= observedAt))) {
    throw new TypeError('n8n scheduler lease status is inconsistent')
  }
  return {
    schema: N8N_RELEASE_READINESS_SCHEMA,
    globalScope: true,
    observedAt,
    intake: {
      schema: control.schema,
      accepting: false,
      mode: control.mode,
      revision: control.revision,
      counts: { ...control.counts },
    },
    runtime: { ...runtime },
    database: { ...database },
    projection: { ...projection },
    retirement,
    scheduler,
  }
}

function number(value: number | null | undefined): number {
  return Number(value || 0)
}

function loopbackCallbackUrls(port: number, pathname: string): string[] {
  return [
    `http://127.0.0.1:${port}${pathname}`,
    `http://localhost:${port}${pathname}`,
    `http://[::1]:${port}${pathname}`,
  ]
}

/**
 * Compute a release-scoped retirement gate from durable task ownership. No
 * task IDs or payloads leave this function. The quiet window covers the short
 * interval in which n8n may still be closing an execution after the final
 * callback committed its terminal state.
 */
export function getN8nRuntimeDrainStatus(
  db: Database.Database,
  runtime: N8nRuntimeIdentity,
  options: { nowSeconds?: number; quietSeconds?: number } = {},
): N8nRuntimeDrainStatus {
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1_000)
  const requiredQuietSeconds = options.quietSeconds ?? N8N_RUNTIME_DRAIN_QUIET_SECONDS
  if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('n8n runtime drain clock is invalid')
  if (!Number.isSafeInteger(requiredQuietSeconds) || requiredQuietSeconds < 30 || requiredQuietSeconds > 900) {
    throw new TypeError('n8n runtime drain quiet window is invalid')
  }

  const aggregate = db.prepare(`
    SELECT
      COUNT(*) AS tracked,
      SUM(CASE WHEN status IN ('queued', 'accepted', 'running') THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
      SUM(CASE WHEN source IN ('openclaw', 'video-autoworker') THEN 1 ELSE 0 END) AS top_level,
      SUM(CASE WHEN source = 'n8n-media-node' THEN 1 ELSE 0 END) AS media_nodes,
      SUM(CASE WHEN source = 'n8n-node' THEN 1 ELSE 0 END) AS model_nodes,
      MAX(updated_at) AS last_activity_at
    FROM n8n_task_runs
    WHERE json_valid(routing)
      AND json_extract(routing, '$.callbackProtocol') = ?
      AND json_extract(routing, '$.runtimeSlot') = ?
      AND json_extract(routing, '$.runtimeReleaseId') = ?
  `).get(
    runtime.callbackProtocol,
    runtime.runtimeSlot,
    runtime.runtimeReleaseId,
  ) as DrainAggregateRow

  const claimCallbackUrls = loopbackCallbackUrls(runtime.port, '/api/n8n/claim')
  const mediaCallbackUrls = loopbackCallbackUrls(runtime.port, '/api/n8n/media-execute')
  const nodeCallbackUrls = loopbackCallbackUrls(runtime.port, '/api/n8n/node-execute')
  const untrackedCallbacks = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('queued', 'accepted', 'running') THEN 1 ELSE 0 END) AS count,
      MAX(updated_at) AS last_activity_at
    FROM n8n_task_runs
    WHERE json_valid(routing)
      AND (
        json_extract(routing, '$.claimCallbackUrl') IN (?, ?, ?)
        OR json_extract(routing, '$.mediaCallbackUrl') IN (?, ?, ?)
        OR json_extract(routing, '$.nodeCallbackUrl') IN (?, ?, ?)
      )
      AND NOT (
        COALESCE(json_extract(routing, '$.callbackProtocol'), '') = ?
        AND COALESCE(json_extract(routing, '$.runtimeSlot'), '') = ?
        AND COALESCE(json_extract(routing, '$.runtimeReleaseId'), '') = ?
      )
  `).get(
    ...claimCallbackUrls,
    ...mediaCallbackUrls,
    ...nodeCallbackUrls,
    runtime.callbackProtocol,
    runtime.runtimeSlot,
    runtime.runtimeReleaseId,
  ) as DrainBlockerAggregateRow
  const otherReleaseActive = db.prepare(`
    SELECT
      SUM(CASE WHEN status IN ('queued', 'accepted', 'running') THEN 1 ELSE 0 END) AS count,
      MAX(updated_at) AS last_activity_at
    FROM n8n_task_runs
    WHERE json_valid(routing)
      AND json_extract(routing, '$.callbackProtocol') = ?
      AND json_extract(routing, '$.runtimeSlot') = ?
      AND COALESCE(json_extract(routing, '$.runtimeReleaseId'), '') <> ?
  `).get(
    runtime.callbackProtocol,
    runtime.runtimeSlot,
    runtime.runtimeReleaseId,
  ) as DrainBlockerAggregateRow
  const childExecutionLeases = db.prepare(`
    SELECT COUNT(*) AS count, MAX(lease.updated_at) AS last_activity_at
    FROM n8n_child_execution_leases lease
    JOIN n8n_task_runs run ON run.task_id = lease.task_id
    WHERE json_valid(run.routing)
      AND json_extract(run.routing, '$.callbackProtocol') = ?
      AND json_extract(run.routing, '$.runtimeSlot') = ?
      AND json_extract(run.routing, '$.runtimeReleaseId') = ?
  `).get(
    runtime.callbackProtocol,
    runtime.runtimeSlot,
    runtime.runtimeReleaseId,
  ) as DrainBlockerAggregateRow

  const tracked = number(aggregate.tracked)
  const active = number(aggregate.active)
  const observedActivity = [
    aggregate.last_activity_at,
    untrackedCallbacks.last_activity_at,
    otherReleaseActive.last_activity_at,
    childExecutionLeases.last_activity_at,
  ].filter((value): value is number => value !== null)
  const lastActivityAt = observedActivity.length > 0 ? Math.max(...observedActivity) : null
  const quietSince = Math.max(runtime.startedAt, lastActivityAt || 0)
  const quietSeconds = Math.max(0, now - quietSince)
  const untracked = number(untrackedCallbacks.count)
  const otherRelease = number(otherReleaseActive.count)
  const executionLeases = number(childExecutionLeases.count)
  return {
    schema: N8N_RUNTIME_DRAIN_SCHEMA,
    globalScope: true,
    runtime,
    counts: {
      tracked,
      active,
      queued: number(aggregate.queued),
      accepted: number(aggregate.accepted),
      running: number(aggregate.running),
      topLevel: number(aggregate.top_level),
      mediaNodes: number(aggregate.media_nodes),
      modelNodes: number(aggregate.model_nodes),
      childExecutionLeases: executionLeases,
      untrackedCallbacks: untracked,
      otherReleaseActive: otherRelease,
    },
    lastActivityAt,
    quietSince,
    quietSeconds,
    requiredQuietSeconds,
    safeToRetire: active === 0
      && untracked === 0
      && otherRelease === 0
      && executionLeases === 0
      && quietSeconds >= requiredQuietSeconds,
    observedAt: now,
  }
}
