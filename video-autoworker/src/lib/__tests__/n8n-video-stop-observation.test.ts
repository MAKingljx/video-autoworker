// @vitest-environment node
import Database from 'better-sqlite3'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { observeN8nExecutionForStop } from '@/lib/n8n-video-stop-observation'
let root: string, pathname: string
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'n8n-stop-readonly-')))
  pathname = join(root, 'database.sqlite')
  const db = new Database(pathname)
  db.exec("CREATE TABLE execution_entity(id INTEGER PRIMARY KEY,workflowId TEXT,status TEXT,stoppedAt TEXT); INSERT INTO execution_entity VALUES(381,'owned-workflow','error','2026-10-28T03:00:00.000Z')")
  db.close(); chmodSync(pathname, 0o600)
  vi.stubEnv('AIWORKER_VIDEO_STOP_TEST_MODE', '1'); vi.stubEnv('AIWORKER_TEST_N8N_DB_PATH', pathname)
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }) })
describe('credential-free system n8n stop observations', () => {
  it('reads the exact terminal workflow execution without changing any database bytes', () => {
    const before = readFileSync(pathname)
    vi.stubEnv('N8N_API_KEY', '')
    expect(observeN8nExecutionForStop('n8n-execution:owned-workflow:381', 'owned-workflow', false))
      .toMatchObject({ status: 'stopped', executionOwner: 'n8n-execution:owned-workflow:381' })
    expect(readFileSync(pathname)).toEqual(before)
  })
  it('never reinterprets a missing workflow/id or missing stoppedAt as stopped', () => {
    expect(observeN8nExecutionForStop('n8n-execution:other-workflow:381', 'owned-workflow', false).status).toBe('unconfirmed')
    expect(observeN8nExecutionForStop('n8n-execution:owned-workflow:999', 'owned-workflow', false).status).toBe('unconfirmed')
    const db = new Database(pathname); db.exec('UPDATE execution_entity SET stoppedAt=NULL'); db.close()
    expect(observeN8nExecutionForStop('n8n-execution:owned-workflow:381', 'owned-workflow', false).status).toBe('unconfirmed')
  })
  it('returns running while the owned workflow is genuinely still active', () => {
    const db = new Database(pathname); db.exec("UPDATE execution_entity SET status='running',stoppedAt=NULL"); db.close()
    expect(observeN8nExecutionForStop('n8n-execution:owned-workflow:381', 'owned-workflow', false).status).toBe('running')
  })
  it.each(['symlink', 'permissions'])('refuses an unsafe observation database: %s', fault => {
    if (fault === 'symlink') {
      const link = join(root, 'link.sqlite'); symlinkSync(pathname, link); vi.stubEnv('AIWORKER_TEST_N8N_DB_PATH', link)
    } else chmodSync(pathname, 0o666)
    expect(observeN8nExecutionForStop('n8n-execution:owned-workflow:381', 'owned-workflow', false).status).toBe('unconfirmed')
  })
  it('ignores isolated test-root overrides in production and rejects a foreign binding', () => {
    vi.stubEnv('NODE_ENV', 'production'); vi.stubEnv('AIWORKER_BG_N8N_DB_PATH', pathname)
    expect(observeN8nExecutionForStop('n8n-execution:owned-workflow:381', 'owned-workflow', false).status).toBe('unconfirmed')
  })
})
