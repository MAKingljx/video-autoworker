// @vitest-environment node
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const state = vi.hoisted(() => ({ db: undefined as unknown, beforeSettle: vi.fn(), execute: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDatabase: () => state.db }))
vi.mock('@/lib/n8n-runtime-affinity', () => ({
  checkN8nCallbackAdmission: () => ({ allowed: true, mode: 'legacy' }), resolveN8nRuntimeInstanceId: () => 'a'.repeat(64),
}))
vi.mock('@/lib/n8n-media-execution', async original => ({
  ...await original<typeof import('@/lib/n8n-media-execution')>(),
  analyzeN8nVideoFrames: (...args: unknown[]) => state.execute(...args),
  synthesizeN8nMediaResults: (...args: unknown[]) => state.execute(...args),
}))
vi.mock('@/lib/n8n-task-runs', async original => {
  const actual = await original<typeof import('@/lib/n8n-task-runs')>()
  return { ...actual,
    completeN8nChildExecution: (...args: Parameters<typeof actual.completeN8nChildExecution>) => { state.beforeSettle(); return actual.completeN8nChildExecution(...args) },
    failN8nChildExecution: (...args: Parameters<typeof actual.failN8nChildExecution>) => { state.beforeSettle(); return actual.failN8nChildExecution(...args) },
    completeN8nFinalizeRun: (...args: Parameters<typeof actual.completeN8nFinalizeRun>) => { state.beforeSettle(); return actual.completeN8nFinalizeRun(...args) },
  }
})

import { POST } from '@/app/api/n8n/media-execute/route'
import { runMigrations } from '@/lib/migrations'
import { claimScopedN8nTaskRun, createN8nTaskRun, getScopedN8nTaskRunByTaskId, readN8nMediaProviderExecutionRisk } from '@/lib/n8n-task-runs'
import { inspectScopedVideoStop, requestScopedVideoStop } from '@/lib/n8n-video-stop'
import { mediaChildIdentity } from '@/lib/n8n-media-workspace'
import { executeN8nModelRoute } from '@/lib/n8n-model-execution'
import type { N8nMediaExecutionControl } from '@/lib/n8n-media-control'

const scope = { tenantId: 3, workspaceId: 2 }, taskId = 'video-stop-settle', idempotencyKey = 'video-stop-settle-idem'
const executionOwner = 'n8n-execution:original-workflow:381'
let root: string, db: Database.Database, stopper: Database.Database, bindingId: number
beforeEach(() => {
  vi.clearAllMocks(); root = mkdtempSync(join(tmpdir(), 'media-stop-settlement-'))
  const pathname = join(root, 'authority.sqlite')
  db = new Database(pathname); runMigrations(db); stopper = new Database(pathname); state.db = db
  bindingId = Number(db.prepare(`INSERT INTO n8n_workflow_bindings
    (name,task_type,workflow_id,webhook_path,agent_role,model,enabled,timeout_seconds,retry_count,config,workspace_id,tenant_id)
    VALUES ('video','video-analysis','original-workflow','webhook/video','executor','model',1,30,2,'{}',2,3)`).run().lastInsertRowid)
  createN8nTaskRun(db, { taskId, idempotencyKey, bindingId, source: 'openclaw', requestedBy: 'test',
    routing: { taskType: 'video-analysis', callbackProtocol: 'legacy-v1' }, taskInput: { videoKey: 'original.mp4' },
    delivery: { mode: 'none' }, maxAttempts: 2 }, scope)
  claimScopedN8nTaskRun(db, { taskId, idempotencyKey, bindingId, executionOwner }, scope)
  for (const stage of ['prepare', 'audio'] as const) seedSuccess(stage)
  state.beforeSettle.mockImplementation(() => {
    const inspection = inspectScopedVideoStop(stopper, taskId, scope)!
    requestScopedVideoStop(stopper, { taskId, expectedRevision: inspection.expectedRevision }, scope, 0)
  })
})
afterEach(() => { stopper.close(); db.close(); rmSync(root, { recursive: true, force: true }) })
function seedSuccess(stage: 'prepare' | 'audio' | 'vision') {
  const childId = mediaChildIdentity('task', taskId, stage)
  createN8nTaskRun(db, { taskId: childId, idempotencyKey: mediaChildIdentity('idem', idempotencyKey, stage),
    bindingId, source: 'n8n-media-node', requestedBy: 'test', routing: { mediaStage: stage },
    taskInput: {}, delivery: { mode: 'none' }, maxAttempts: 2 }, scope)
  db.prepare(`UPDATE n8n_task_runs SET status='succeeded',output=?,attempt_count=1 WHERE task_id=?`)
    .run(JSON.stringify(stage === 'prepare' ? { durationSeconds: 10 } : { text: 'retained' }), childId)
}
function request(stage: 'vision' | 'finalize') {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/media-execute', { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId, idempotencyKey, executionOwner, stage, input: {} }) })
}

describe('real authority connection stop versus media settlement', () => {
  it('persists an earlier real HTTP 504 risk when a fallback succeeds and the child lease is released', async () => {
    state.beforeSettle.mockImplementation(() => undefined)
    let requests = 0
    const server = createServer((_request, response) => {
      requests++; response.statusCode = requests === 1 ? 504 : 200
      setTimeout(() => response.end(JSON.stringify(requests === 1 ? { error: { message: 'provider may still be running' } }
        : { choices: [{ message: { content: 'fallback completed' } }] })), 20)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test provider did not bind')
    state.execute.mockImplementation(async (...args: unknown[]) => {
      const route = { id: 'local-risk', label: 'test', description: '', location: 'local' as const,
        transport: 'openai-compatible' as const, model: 'test', baseUrl: `http://127.0.0.1:${address.port}/v1`, enabled: true,
        timeoutSeconds: 5, thinking: 'off', capabilities: ['text' as const], systemPrompt: '' }
      const options = { nodeKey: 'executor', input: {}, sessionKey: 'unused', delivery: { mode: 'none' as const },
        executionControl: args.at(-1) as N8nMediaExecutionControl }
      await expect(executeN8nModelRoute(route, options)).rejects.toThrow('N8N_MODEL_HTTP_FAILED')
      return executeN8nModelRoute({ ...route, id: 'fallback' }, options)
    })
    try {
      expect((await POST(request('vision'))).status).toBe(200)
      const childId = mediaChildIdentity('task', taskId, 'vision'), child = getScopedN8nTaskRunByTaskId(db, childId, scope)!
      expect(child.status).toBe('succeeded')
      expect(child.routing.providerExecutionReceipts).toEqual([expect.objectContaining({ status: 'unconfirmed', attemptCount: 1 })])
      expect(readN8nMediaProviderExecutionRisk(child).status).toBe('unconfirmed')
      expect(db.prepare('SELECT COUNT(*) count FROM n8n_child_execution_leases WHERE task_id=?').get(childId)).toEqual({ count: 0 })
      const inspection = inspectScopedVideoStop(stopper, taskId, scope)!
      expect(requestScopedVideoStop(stopper, { taskId, expectedRevision: inspection.expectedRevision }, scope, 0).outcome).toBe('requested')
      expect(readN8nMediaProviderExecutionRisk(getScopedN8nTaskRunByTaskId(db, childId, scope)!).status).toBe('unconfirmed')
      expect(requests).toBe(2)
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
  it.each(['child', 'finalize', 'failure'] as const)('records the original local acknowledgment when a second connection wins %s commit', async mode => {
    if (mode === 'finalize') seedSuccess('vision')
    let requests = 0
    const server = createServer((_request, response) => {
      requests++; setTimeout(() => response.end(JSON.stringify({ choices: [{ message: { content: 'completed request' } }] })), 30)
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test provider did not bind')
    state.execute.mockImplementation(async (...args: unknown[]) => {
      if (mode === 'failure') throw new Error('isolated validation failure')
      const output = await executeN8nModelRoute({ id: 'local-settle', label: 'test', description: '', location: 'local',
        transport: 'openai-compatible', model: 'test', baseUrl: `http://127.0.0.1:${address.port}/v1`, enabled: true,
        timeoutSeconds: 5, thinking: 'off', capabilities: ['text'], systemPrompt: '',
      }, { nodeKey: 'executor', input: {}, sessionKey: 'unused', delivery: { mode: 'none' },
        executionControl: args.at(-1) as N8nMediaExecutionControl })
      return { combinedText: output.text }
    })
    try {
      const stage = mode === 'finalize' ? 'finalize' : 'vision', response = await POST(request(stage))
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ status: 'stopping', localAcknowledged: true,
        providerCancellation: mode === 'failure' ? 'not_started' : 'confirmed' })
      const row = db.prepare('SELECT local_ack_json FROM n8n_video_stop_requests WHERE task_id=?').get(taskId) as { local_ack_json: string }
      const childId = mediaChildIdentity('task', taskId, stage)
      expect(JSON.parse(row.local_ack_json)[childId]).toMatchObject({ localStopped: true, writersSettled: true,
        providerCancellation: mode === 'failure' ? 'not_started' : 'confirmed' })
      expect(db.prepare('SELECT status,attempt_count,error FROM n8n_task_runs WHERE task_id=?').get(childId))
        .toMatchObject({ status: 'running', attempt_count: 1, error: null })
      expect(requests).toBe(mode === 'failure' ? 0 : 1)
      expect(db.prepare('SELECT COUNT(*) count FROM n8n_media_cleanup_debts').get()).toEqual({ count: 0 })
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})
