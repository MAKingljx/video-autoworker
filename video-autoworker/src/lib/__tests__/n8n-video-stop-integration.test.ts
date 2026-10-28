// @vitest-environment node
import Database from 'better-sqlite3'
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NextRequest } from 'next/server'
import { expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { claimScopedN8nTaskRun, createAndClaimN8nChildRunFromParent, createN8nTaskRun,
  runWithN8nChildExecutionHeartbeat, N8nVideoStopRequestedError } from '@/lib/n8n-task-runs'
import { runOwnedMediaCommand } from '@/lib/n8n-media-control'
import { mediaChildIdentity } from '@/lib/n8n-media-workspace'
import { claimScopedVideoStop, observeScopedVideoStopProof, recordScopedN8nVideoChildStopAck,
  settleScopedVideoStop } from '@/lib/n8n-video-stop'
const mocks = vi.hoisted(() => ({ database: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDatabase: mocks.database, logAuditEvent: () => undefined }))
vi.mock('@/lib/n8n', () => ({ requireN8nRole: () => ({ user: { id: 9, username: 'test', tenant_id: 3, workspace_id: 2 } }) }))
vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))
import { GET, POST } from '@/app/api/n8n/runs/stop/route'

it('drives API intent through a real isolated process exit and stays blocked without an n8n proof', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'stop-api-process-')))
  const ready = join(root, 'ready.json')
  const db = new Database(':memory:')
  const n8nPath = join(root, 'n8n.sqlite')
  const external = new Database(n8nPath)
  external.exec("CREATE TABLE execution_entity(id INTEGER PRIMARY KEY,workflowId TEXT,status TEXT,stoppedAt TEXT); INSERT INTO execution_entity VALUES(381,'workflow','unknown',NULL)")
  external.close(); chmodSync(n8nPath, 0o600)
  vi.stubEnv('AIWORKER_VIDEO_STOP_TEST_MODE', '1'); vi.stubEnv('AIWORKER_TEST_N8N_DB_PATH', n8nPath)
  mocks.database.mockReturnValue(db)
  runMigrations(db)
  const scope = { tenantId: 3, workspaceId: 2 }
  const taskId = 'api-process-stop'
  const owner = 'n8n-execution:workflow:381'
  const bindingId = Number(db.prepare(`INSERT INTO n8n_workflow_bindings
    (name,task_type,workflow_id,webhook_path,agent_role,model,enabled,timeout_seconds,retry_count,config,workspace_id,tenant_id)
    VALUES ('video','video-analysis','workflow','webhook/video','executor','model',1,30,2,'{}',2,3)`).run().lastInsertRowid)
  createN8nTaskRun(db, { taskId, idempotencyKey: taskId, bindingId, source: 'openclaw', requestedBy: 'test',
    routing: { taskType: 'video-analysis' }, taskInput: { videoKey: 'test.mp4' }, delivery: { mode: 'none' }, maxAttempts: 2 }, scope)
  claimScopedN8nTaskRun(db, { taskId, idempotencyKey: taskId, bindingId, executionOwner: owner }, scope)
  const childTaskId = mediaChildIdentity('task', taskId, 'audio')
  const child = createAndClaimN8nChildRunFromParent(db, { parentTaskId: taskId, parentIdempotencyKey: taskId,
    bindingId, childTaskId, childIdempotencyKey: mediaChildIdentity('idem', taskId, 'audio'), source: 'n8n-media-node',
    routing: { mediaStage: 'audio' }, taskInput: {}, delivery: { mode: 'none' }, maxAttempts: 2,
    ownerInstanceId: 'a'.repeat(64), executionOwner: owner }, scope)
  let failure: unknown
  const running = runWithN8nChildExecutionHeartbeat(db, child.lease!, scope, control =>
    runOwnedMediaCommand(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`], { control }),
  { stopPollMilliseconds: 5 }).catch(error => { failure = error })
  try {
    const deadline = Date.now() + 3000
    while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    expect(existsSync(ready)).toBe(true)
    const pid = (JSON.parse(readFileSync(ready, 'utf8')) as { pid: number }).pid
    const before = await GET(new NextRequest(`http://localhost/api/n8n/runs/stop?taskId=${taskId}`))
    const inspection = (await before.json()).inspection
    const response = await POST(new NextRequest('http://localhost/api/n8n/runs/stop', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId, confirm: true,
        expectedRevision: inspection.expectedRevision }) }))
    expect(response.status).toBe(202)
    const intent = (await response.json()).stop
    await running
    expect(failure).toBeInstanceOf(N8nVideoStopRequestedError)
    expect(() => process.kill(pid, 0)).toThrow()
    expect((failure as N8nVideoStopRequestedError).providerCancellation).toBe('confirmed')
    expect(recordScopedN8nVideoChildStopAck(db, child.lease!, scope, { providerCancellation: 'confirmed' })).toBe(true)
    const stopLease = claimScopedVideoStop(db, taskId, intent.requestId, 'b'.repeat(64), scope).lease!
    const result = settleScopedVideoStop(db, stopLease, scope, observeScopedVideoStopProof(db, stopLease, scope))
    expect(result).toMatchObject({ outcome: 'blocked', stop: { errorCode: 'stop_n8n_execution_unconfirmed' } })
    const final = await GET(new NextRequest(`http://localhost/api/n8n/runs/stop?taskId=${taskId}`))
    expect((await final.json()).inspection).toMatchObject({ status: 'running', stop: { currentState: 'blocked' } })
    expect(db.prepare('SELECT attempt_count FROM n8n_task_runs WHERE task_id=?').get(childTaskId)).toEqual({ attempt_count: 1 })
  } finally {
    if (!failure) {
      const inspection = (await (await GET(new NextRequest(`http://localhost/api/n8n/runs/stop?taskId=${taskId}`))).json()).inspection
      await POST(new NextRequest('http://localhost/api/n8n/runs/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId, confirm: true, expectedRevision: inspection.expectedRevision }) }))
    }
    await running
    db.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs()
  }
}, 10_000)
