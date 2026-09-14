// @vitest-environment node
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runMigrations } from '@/lib/migrations'
import { directorEvidenceBindingForResolvedWork } from '@/lib/director-evidence-delivery-core'
import { claimNextDirectorExtractionJob, registerDirectorExtractionJob } from '@/lib/director-extraction-runs'
import { N8N_RUNTIME_CALLBACK_PROTOCOL } from '@/lib/n8n-runtime-affinity'

afterEach(() => vi.unstubAllEnvs())

describe('independent worker and persisted video callback ownership', () => {
  it('creates and claims an internal phase under the original parent without replacing its web callback binding', () => {
    vi.stubEnv('AIWORKER_SCHEDULER_MODE', 'worker')
    vi.stubEnv('AIWORKER_SLOT', '')
    vi.stubEnv('AIWORKER_RELEASE_ID', '')
    vi.stubEnv('MC_OPENCLAW_TENANT_ID', '73')
    vi.stubEnv('MC_OPENCLAW_WORKSPACE_ID', '37')
    const db = new Database(':memory:')
    try {
      runMigrations(db)
      db.prepare(`INSERT INTO n8n_workflow_bindings
        (id, name, webhook_path, task_type, workspace_id, tenant_id)
        VALUES (73, '隔离视频', 'webhook/isolated', 'video-analysis', 37, 73)`).run()
      const routing = JSON.stringify({ taskType: 'video-analysis', callbackProtocol: N8N_RUNTIME_CALLBACK_PROTOCOL,
        runtimeSlot: 'blue', runtimeReleaseId: 'original-release', claimCallbackUrl: 'http://127.0.0.1:3317/api/n8n/claim' })
      const binding = directorEvidenceBindingForResolvedWork('WORK-WORKER-ISOLATED-001', '隔离作品')
      db.prepare(`INSERT INTO n8n_task_runs
        (task_id,idempotency_key,binding_id,status,source,requested_by,routing,input,delivery,output,
          attempt_count,max_attempts,workspace_id,tenant_id,completed_at,updated_at)
        VALUES ('worker-parent','worker-parent-idem',73,'succeeded','openclaw','isolated',?,?,?, ?,1,1,37,73,10,10)`)
        .run(routing, JSON.stringify({ directorEvidence: binding }), JSON.stringify({ mode: 'none' }),
          JSON.stringify({ taskType: 'video-analysis', materialId: 'MAT-WORKER-ISOLATED',
            analysisVersion: 'video-analysis-v3', mediaDurationSeconds: 12, summary: '人物进入房间。',
            timeline: [{ index: 1, timeRange: '00:00:00-00:00:12', visualAnalysis: '人物进入房间。', confidence: 0.9 }] }))
      const scope = { tenantId: 73, workspaceId: 37 }
      const registered = registerDirectorExtractionJob(db, 'worker-parent', scope)
      expect(registered.created).toBe(true)
      const claimed = claimNextDirectorExtractionJob(db, { nowSeconds: 1_000,
        requirePerceptionEvidenceReady: false })
      expect(claimed?.sourceTaskId).toBe('worker-parent')
      const parent = db.prepare("SELECT routing FROM n8n_task_runs WHERE task_id='worker-parent'").get() as { routing: string }
      expect(parent.routing).toBe(routing)
      const child = db.prepare("SELECT binding_id,routing FROM n8n_task_runs WHERE source='n8n-node'").get() as
        { binding_id: number; routing: string }
      expect(child.binding_id).toBe(73)
      expect(JSON.parse(child.routing)).toMatchObject({ parentTaskId: 'worker-parent', childKind: 'director-extraction', directorPhase: 'perception' })
      expect(JSON.parse(child.routing)).not.toHaveProperty('claimCallbackUrl')
      expect(JSON.parse(child.routing)).not.toHaveProperty('runtimeSlot')
    } finally { db.close() }
  })
})
