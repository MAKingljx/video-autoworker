import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { NextRequest } from 'next/server'
import {
  DIRECTOR_EVIDENCE_BINDING_AUTHORITY,
  directorWorkQueryDigest,
} from '@/lib/director-evidence-outbox'
import { runMigrations } from '@/lib/migrations'
import { getN8nTaskRunByTaskId } from '@/lib/n8n-task-runs'

const mocks = vi.hoisted(() => ({
  db: null as Database.Database | null,
  resolveDirectorWorkBinding: vi.fn(),
  triggerN8nWebhook: vi.fn(),
  updateN8nWorkflowRunStatus: vi.fn(),
  logAuditEvent: vi.fn(),
  acquireSharedDeploymentLock: vi.fn(),
  releaseSharedDeploymentLock: vi.fn(),
}))

const binding = {
  id: 7,
  name: '视频分析任务链',
  webhookPath: 'webhook/aiworker-video-analysis',
  taskType: 'video-analysis',
  agentRole: 'video-specialist',
  model: 'qwen36-tools-local/default_model',
  timeoutSeconds: 120,
  retryCount: 2,
  enabled: true,
  config: { queue: 'heavy-model' },
}

vi.mock('@/lib/db', () => ({
  getDatabase: () => mocks.db,
  logAuditEvent: mocks.logAuditEvent,
}))

vi.mock('@/lib/n8n', () => ({
  requireN8nRole: () => ({
    user: {
      id: 1,
      username: 'integration-operator',
      workspace_id: 2,
      tenant_id: 3,
    },
  }),
  validateN8nWebhookDispatchConfiguration: vi.fn(),
  triggerN8nWebhook: mocks.triggerN8nWebhook,
  isN8nWebhookDispatchError: () => false,
}))

vi.mock('@/lib/n8n-workflows', () => ({
  getN8nWorkflowBinding: () => binding,
  updateN8nWorkflowRunStatus: mocks.updateN8nWorkflowRunStatus,
}))

vi.mock('@/lib/rate-limit', () => ({ mutationLimiter: () => null }))

vi.mock('@/lib/n8n-runtime-affinity', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/n8n-runtime-affinity')>(),
  resolveN8nRuntimeAffinity: () => null,
}))

vi.mock('@/lib/director-evidence-outbox', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/director-evidence-outbox')>(),
  resolveDirectorWorkBinding: mocks.resolveDirectorWorkBinding,
}))

vi.mock('@/lib/shared-deployment-lock', () => ({
  acquireSharedDeploymentLock: mocks.acquireSharedDeploymentLock,
}))

import { POST } from '@/app/api/n8n/trigger/route'

function request(body: Record<string, unknown>) {
  return new NextRequest('http://127.0.0.1:3017/api/n8n/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('director-bound n8n trigger integration', () => {
  let db: Database.Database
  const originalScope = {
    tenantId: process.env.MC_OPENCLAW_TENANT_ID,
    workspaceId: process.env.MC_OPENCLAW_WORKSPACE_ID,
  }

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MC_OPENCLAW_TENANT_ID = '3'
    process.env.MC_OPENCLAW_WORKSPACE_ID = '2'
    db = new Database(':memory:')
    mocks.db = db
    runMigrations(db)
    db.prepare(`
      INSERT INTO n8n_workflow_bindings (
        id, name, webhook_path, task_type, workspace_id, tenant_id
      ) VALUES (7, '视频分析任务链', 'webhook/aiworker-video-analysis', 'video-analysis', 2, 3)
    `).run()
    mocks.resolveDirectorWorkBinding.mockResolvedValue({
      authority: DIRECTOR_EVIDENCE_BINDING_AUTHORITY,
      workId: 'WORK-001',
      queryDigest: directorWorkQueryDigest('导演脑验收片'),
    })
    mocks.triggerN8nWebhook.mockResolvedValue({
      statusCode: 202,
      latencyMs: 1,
      body: { accepted: true },
    })
    mocks.releaseSharedDeploymentLock.mockReturnValue(undefined)
    mocks.acquireSharedDeploymentLock.mockResolvedValue({
      acquired: true,
      lease: {
        path: '/private/run/.deployment.lock',
        release: mocks.releaseSharedDeploymentLock,
      },
    })
  })

  afterEach(() => {
    mocks.db = null
    db.close()
    if (originalScope.tenantId === undefined) delete process.env.MC_OPENCLAW_TENANT_ID
    else process.env.MC_OPENCLAW_TENANT_ID = originalScope.tenantId
    if (originalScope.workspaceId === undefined) delete process.env.MC_OPENCLAW_WORKSPACE_ID
    else process.env.MC_OPENCLAW_WORKSPACE_ID = originalScope.workspaceId
  })

  it('persists the trusted work binding and replays a terminal run without Feishu', async () => {
    const taskId = `video-natural-${'a'.repeat(64)}`
    const body = {
      bindingId: 7,
      taskId,
      idempotencyKey: taskId,
      source: 'openclaw',
      directorWork: '导演脑验收片',
      input: {
        prompt: '分析视频',
        videoKey: '123e4567-e89b-42d3-a456-426614174000.mp4',
        materialId: 'MATERIAL-001',
      },
      delivery: { mode: 'none' },
    }

    const first = await POST(request(body))
    expect(first.status).toBe(202)
    expect(mocks.resolveDirectorWorkBinding).toHaveBeenCalledOnce()
    expect(mocks.triggerN8nWebhook).toHaveBeenCalledOnce()

    const created = getN8nTaskRunByTaskId(db, taskId)
    expect(created).toMatchObject({
      taskId,
      status: 'accepted',
      input: {
        prompt: '分析视频',
        videoKey: '123e4567-e89b-42d3-a456-426614174000.mp4',
        materialId: 'MATERIAL-001',
        directorEvidence: {
          authority: DIRECTOR_EVIDENCE_BINDING_AUTHORITY,
          workId: 'WORK-001',
          queryDigest: directorWorkQueryDigest('导演脑验收片'),
        },
      },
    })
    expect(created?.input).not.toHaveProperty('directorWork')

    const output = { taskType: 'video-analysis', summary: '验收完成' }
    db.prepare(`
      UPDATE n8n_task_runs
      SET status = 'succeeded', output = ?, completed_at = unixepoch(), updated_at = unixepoch()
      WHERE task_id = ?
    `).run(JSON.stringify(output), taskId)
    mocks.resolveDirectorWorkBinding.mockRejectedValue(new Error('feishu_offline'))

    const replay = await POST(request(body))
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({
      taskId,
      duplicate: true,
      status: 'succeeded',
      output,
    })
    expect(mocks.resolveDirectorWorkBinding).toHaveBeenCalledTimes(1)
    expect(mocks.acquireSharedDeploymentLock).toHaveBeenCalledTimes(1)
    expect(mocks.releaseSharedDeploymentLock).toHaveBeenCalledTimes(1)
    expect(mocks.triggerN8nWebhook).toHaveBeenCalledTimes(1)
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM n8n_task_runs WHERE idempotency_key = ?
    `).get(taskId)).toEqual({ count: 1 })
  })
})
