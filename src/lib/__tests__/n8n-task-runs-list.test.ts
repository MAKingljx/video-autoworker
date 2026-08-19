import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listN8nTaskRunSummaries,
  projectN8nTaskRunListItem,
} from '@/lib/n8n-task-runs'

describe('n8n task run list projection', () => {
  it('keeps only compact display metadata and removes path details', () => {
    const item = projectN8nTaskRunListItem({
      taskId: 'season-three:video:003:abcdef123456',
      status: 'failed',
      source: 'openclaw',
      routing: { name: '视频深度分析', taskType: 'video-analysis', secret: 'hidden' },
      input: { displayName: 'C:\\private\\S03E03.mp4', prompt: 'private prompt' },
      error: '读取 /Users/operator/private/source.mp4 失败，参考 https://secret.example/token',
      attemptCount: 2,
      maxAttempts: 3,
      createdAt: 10,
      acceptedAt: 11,
      startedAt: 12,
      completedAt: 20,
      updatedAt: 20,
      workflowName: null,
      bindingTaskType: null,
      resultAvailable: false,
    })

    expect(item).toMatchObject({
      taskId: 'season-three:video:003:abcdef123456',
      title: 'S03E03.mp4',
      workflowName: '视频深度分析',
      taskType: 'video-analysis',
      batchId: 'season-three',
      batchIndex: 3,
      error: '读取 [路径] 失败，参考 [链接]',
    })
    expect(item).not.toHaveProperty('input')
    expect(item).not.toHaveProperty('routing')
    expect(item).not.toHaveProperty('output')
  })
})

describe('listN8nTaskRunSummaries', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE n8n_workflow_bindings (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        task_type TEXT NOT NULL,
        workspace_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL
      );
      CREATE TABLE n8n_task_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL UNIQUE,
        binding_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        routing TEXT NOT NULL DEFAULT '{}',
        input TEXT NOT NULL DEFAULT '{}',
        output TEXT,
        error TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        workspace_id INTEGER NOT NULL,
        tenant_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        accepted_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER,
        updated_at INTEGER NOT NULL
      );
    `)
    db.prepare(`
      INSERT INTO n8n_workflow_bindings (id, name, task_type, workspace_id, tenant_id)
      VALUES (1, '视频深度分析', 'video-analysis', 2, 3)
    `).run()

    const insert = db.prepare(`
      INSERT INTO n8n_task_runs (
        task_id, binding_id, status, source, routing, input, output, error,
        attempt_count, max_attempts, workspace_id, tenant_id,
        created_at, accepted_at, started_at, completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    insert.run(
      'batch-a:video:002:abcdef123456', 1, 'succeeded', 'openclaw',
      JSON.stringify({ name: '不可返回的路由配置' }),
      JSON.stringify({ displayName: '/Users/operator/videos/S03E03.mp4', prompt: 'private prompt' }),
      JSON.stringify({ privateResult: true }), null,
      1, 2, 2, 3, 100, 101, 102, 160, 160,
    )
    insert.run(
      'legacy-task-with-a-very-long-identifier', 999, 'failed', 'video-autoworker',
      JSON.stringify({ name: '历史任务链', taskType: 'general' }),
      JSON.stringify({ prompt: 'do not expose this prompt' }), null,
      '文件 /private/tmp/private.mov 处理失败',
      2, 2, 2, 3, 80, 81, 82, 90, 90,
    )
    insert.run(
      'internal-node', 1, 'succeeded', 'n8n-node', '{}', '{}', '{}', null,
      1, 1, 2, 3, 120, 121, 122, 123, 170,
    )
    insert.run(
      'other-workspace', 1, 'succeeded', 'openclaw', '{}', '{}', '{}', null,
      1, 1, 99, 3, 120, 121, 122, 123, 180,
    )
  })

  afterEach(() => db.close())

  it('lists only top-level runs in the requested scope', () => {
    const result = listN8nTaskRunSummaries(
      db,
      { workspaceId: 2, tenantId: 3 },
      { limit: 10 },
    )

    expect(result).toMatchObject({ total: 2, limit: 10, offset: 0 })
    expect(result.runs.map(run => run.taskId)).toEqual([
      'batch-a:video:002:abcdef123456',
      'legacy-task-with-a-very-long-identifier',
    ])
    expect(result.runs[0]).toMatchObject({
      title: 'S03E03.mp4',
      workflowName: '视频深度分析',
      taskType: 'video-analysis',
      resultAvailable: true,
      batchId: 'batch-a',
      batchIndex: 2,
    })
    expect(result.runs[1].title).toContain('历史任务链')
    expect(result.runs[1].error).toBe('文件 [路径] 处理失败')
    expect(result.runs[0]).not.toHaveProperty('output')
  })

  it('supports status, name search and pagination without exposing payloads', () => {
    const byName = listN8nTaskRunSummaries(
      db,
      { workspaceId: 2, tenantId: 3 },
      { query: 'S03E03', limit: 1, offset: 0 },
    )
    expect(byName.total).toBe(1)
    expect(byName.runs[0].title).toBe('S03E03.mp4')

    const failed = listN8nTaskRunSummaries(
      db,
      { workspaceId: 2, tenantId: 3 },
      { status: 'failed', limit: 1, offset: 0 },
    )
    expect(failed.total).toBe(1)
    expect(failed.runs[0].status).toBe('failed')

    const secondPage = listN8nTaskRunSummaries(
      db,
      { workspaceId: 2, tenantId: 3 },
      { limit: 1, offset: 1 },
    )
    expect(secondPage.total).toBe(2)
    expect(secondPage.runs[0].taskId).toBe('legacy-task-with-a-very-long-identifier')
  })
})
