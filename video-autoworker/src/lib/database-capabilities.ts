import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'

export const VIDEO_EDIT_MIGRATION = '060_video_edit_task_receipts'
export const CORE_DATABASE_MIGRATION = '059_director_evidence_projection_receipts'
export const VIDEO_STOP_MIGRATION = '061_n8n_video_stop_requests'
// Published 061 objects. These digests bind the exact narrow scope and final
// cancellation exception; a missing or broadened trigger is never compatible.
export const VIDEO_STOP_SCHEMA_OBJECTS = {
  n8n_video_stop_requests: ['table', 'bcb62bb77530ad19773eb71375905cf646d929e33836fdde769a0dadda08dc8b'],
  idx_n8n_video_stop_requests_scope: ['index', 'a8df1c45027800d79d448e3ea61f578e5b662c7d5d7f8f97c277ab7c51517af9'],
  n8n_video_stop_fence_run_insert: ['trigger', '2d302f60447ba8309e48ebcc5d10a446cba7b030b92af5e8c75b01af2f2fd1fa'],
  n8n_video_stop_reserve_batch_identity: ['trigger', 'e0ee26373f01e3800fb463d99e251b59a015c28089f54beb1eaae280c80e6f42'],
  n8n_video_stop_fence_run_update: ['trigger', '5090bd4d25f4a5b65ee0bd872f109f739787c290b9c7e3d530bdb6145d25e320'],
  n8n_video_stop_fence_child_lease_insert: ['trigger', '111aef0b903dad2d9960f7910159ac2089361a52ff664aa60c787947d25de90a'],
  n8n_video_stop_fence_child_lease_update: ['trigger', '76f11f160e845b51ede7effa759920ca426e29bc022c3dc9ebf4117a517ad2b7'],
  n8n_video_stop_fence_dispatch_insert: ['trigger', 'ed9b6c95ad2a75d509aeca9926e1429de8875d5960c0d921c5ec49622a42744a'],
  n8n_video_stop_fence_dispatch_update: ['trigger', 'a3f9d9d5f70d709f4f3788360d8d611fe7dac1281f9de97e454b59f737b9a739'],
  n8n_video_stop_fence_parent_claim_insert: ['trigger', '65d249e8966c15b9f4001d69f3b415e22d6c6099cfce42b80150e801fe0f2c96'],
  n8n_video_stop_fence_parent_claim_update: ['trigger', '0b5d36c7bd08dbb48bbe313e57aeb97b5404d6aa3a8a6bc0cfa53b93116b9206'],
} as const
export const VIDEO_EDIT_TABLES = ['video_edit_plans', 'video_edit_operations'] as const

/** Older readers may inspect the prior core epoch. New application startup
 * requires 061, while its existing table/column contracts stay unchanged. */
export function inspectVideoStopSchema(db: Database.Database, required = true): boolean {
  const applied = Boolean(db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(VIDEO_STOP_MIGRATION))
  const objects = db.prepare(`SELECT type,name,sql FROM sqlite_master WHERE name LIKE 'n8n_video_stop_%'
    OR name='idx_n8n_video_stop_requests_scope'`).all() as Array<{ type: string; name: string; sql: string }>
  if (!applied && objects.length === 0) {
    if (required) throw new Error('database_capability_prepare_required:video-stop')
    return false
  }
  if (!applied || objects.length !== Object.keys(VIDEO_STOP_SCHEMA_OBJECTS).length) {
    throw new Error('database_stop_schema_incomplete')
  }
  for (const [name, [type, expected]] of Object.entries(VIDEO_STOP_SCHEMA_OBJECTS)) {
    const actual = objects.find(value => value.name === name)
    const digest = actual?.sql ? createHash('sha256').update(actual.sql.replace(/\s+/gu, ' ').trim()).digest('hex') : null
    if (actual?.type !== type || digest !== expected) throw new Error(`database_stop_schema_incompatible:${name}`)
  }
  return true
}

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
