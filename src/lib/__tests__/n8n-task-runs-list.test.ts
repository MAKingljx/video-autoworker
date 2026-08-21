import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getN8nVideoResultDetail,
  listN8nActiveTaskRunSummaries,
  listN8nTaskRunSummaries,
  listN8nVideoResults,
  projectN8nTaskRunListItem,
  projectN8nVideoResultDetail,
  searchN8nVideoResults,
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

  it('projects only the formal video report fields and never returns routing or input', () => {
    const detail = projectN8nVideoResultDetail({
      taskId: 'season-three:video:003:abcdef123456',
      status: 'succeeded',
      source: 'openclaw',
      routing: { taskType: 'video-analysis', secret: 'hidden-route' },
      input: { displayName: '/Users/operator/videos/S03E03.mp4', prompt: 'private prompt' },
      output: {
        summary: '一句话总结',
        chapters: [{ index: 1, startTime: '00:00:00', endTime: '00:05:00', summary: '第一章' }],
        timeline: [{
          index: 1,
          timeRange: '00:00:00-00:01:00',
          transcript: '人物对白',
          visualAnalysis: '雪山远景',
        }],
        audio: { transcript: '完整转写', model: 'private-audio-model' },
        vision: { analysis: '完整画面证据', routeId: 'private-route' },
        combinedText: '完整报告',
        workers: { internal: true },
      },
      error: null,
      attemptCount: 1,
      maxAttempts: 2,
      createdAt: 10,
      acceptedAt: 11,
      startedAt: 12,
      completedAt: 20,
      updatedAt: 20,
      workflowName: '视频深度分析',
      bindingTaskType: 'video-analysis',
      resultAvailable: true,
    })

    expect(detail).toMatchObject({
      title: 'S03E03.mp4',
      summary: '一句话总结',
      chapterCount: 1,
      timelineCount: 1,
      transcript: '完整转写',
      visualAnalysis: '完整画面证据',
      fullReport: '完整报告',
      chapters: [{ startSeconds: 0, endSeconds: 300 }],
      timeline: [{ startSeconds: 0, endSeconds: 60 }],
    })
    expect(JSON.stringify(detail)).not.toContain('private prompt')
    expect(JSON.stringify(detail)).not.toContain('hidden-route')
    expect(JSON.stringify(detail)).not.toContain('private-audio-model')
    expect(JSON.stringify(detail)).not.toContain('/Users/operator')
  })

  it('removes private reasoning while preserving a visible final answer', () => {
    const detail = projectN8nVideoResultDetail({
      taskId: 'video-1',
      status: 'succeeded',
      source: 'openclaw',
      routing: { taskType: 'video-analysis' },
      input: { displayName: 'video.mp4' },
      output: {
        summary: '<think>private chain of thought</think>\n一句话结论：雪崩作业用于降低道路风险。',
        chapters: [{
          index: 1,
          startTime: '00:00:00',
          endTime: '00:05:00',
          summary: '<analysis>internal planning</analysis>\n章节结论：炮兵实施控制性雪崩。',
        }],
      },
      error: null,
      attemptCount: 1,
      maxAttempts: 1,
      createdAt: 1,
      acceptedAt: 2,
      startedAt: 3,
      completedAt: 4,
      updatedAt: 4,
      workflowName: '视频深度分析',
      bindingTaskType: 'video-analysis',
      resultAvailable: true,
    })

    expect(detail.summary).toBe('一句话结论：雪崩作业用于降低道路风险。')
    expect(detail.fullReport).toBe('一句话结论：雪崩作业用于降低道路风险。')
    expect(detail.chapters[0].summary).toBe('章节结论：炮兵实施控制性雪崩。')
    expect(JSON.stringify(detail)).not.toContain('private chain of thought')
    expect(JSON.stringify(detail)).not.toContain('internal planning')
  })

  it('does not publish truncated model planning as a formal result', () => {
    const detail = projectN8nVideoResultDetail({
      taskId: 'video-2',
      status: 'succeeded',
      source: 'openclaw',
      routing: { taskType: 'video-analysis' },
      input: { displayName: 'video.mp4' },
      output: {
        summary: '我们需要回答用户：根据章节汇总生成整部视频最终分析报告。只输出最终报告，不要输出思考过程。需要生成最终报告。',
        combinedText: '我们需要整合用户提供的分段结果。用户要求分析音画，只输出最终报告。需要生成章节。',
        chapters: [{
          index: 1,
          startTime: '00:00:00',
          endTime: '00:05:00',
          summary: '我们需要基于提供的分段结果汇总。用户要求只输出最终章节，不要输出思考过程。',
        }],
      },
      error: null,
      attemptCount: 1,
      maxAttempts: 1,
      createdAt: 1,
      acceptedAt: 2,
      startedAt: 3,
      completedAt: 4,
      updatedAt: 4,
      workflowName: '视频深度分析',
      bindingTaskType: 'video-analysis',
      resultAvailable: true,
    })

    expect(detail.summary).toBeNull()
    expect(detail.fullReport).toBeNull()
    expect(detail.chapters).toMatchObject([{ index: 1, summary: null }])
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
      JSON.stringify({
        summary: 'S03E03 的正式分析摘要。',
        chapters: [{ index: 1, startTime: '00:00:00', endTime: '00:05:00', summary: '开场章节' }],
        timeline: [{
          index: 1,
          timeRange: '00:00:00-00:01:00',
          transcript: '旁白内容',
          visualAnalysis: '冰川画面',
        }],
        audio: { transcript: '完整旁白' },
        vision: { analysis: '完整视觉证据' },
        combinedText: 'S03E03 完整报告',
      }), null,
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
    const mediaDigest = createHash('sha256')
      .update('batch-a:video:002:abcdef123456:prepare')
      .digest('hex')
      .slice(0, 24)
    insert.run(
      `media-task:batch-a:video:002:abcdef123456:prepare:${mediaDigest}`,
      1, 'succeeded', 'n8n-media-node', '{}', '{}', '{}', null,
      1, 2, 2, 3, 103, 103, 104, 110, 110,
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
      processingStartedAt: 104,
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

  it('returns every active top-level task without a silent queue limit', () => {
    const insert = db.prepare(`
      INSERT INTO n8n_task_runs (
        task_id, binding_id, status, source, routing, input, output, error,
        attempt_count, max_attempts, workspace_id, tenant_id,
        created_at, accepted_at, started_at, completed_at, updated_at
      ) VALUES (?, 1, 'queued', 'openclaw', '{}', '{}', NULL, NULL, 0, 1, 2, 3, ?, NULL, NULL, NULL, ?)
    `)
    db.transaction(() => {
      for (let index = 0; index < 2_001; index += 1) {
        insert.run(`active-${String(index).padStart(4, '0')}`, 1_000 + index, 1_000 + index)
      }
    })()

    const active = listN8nActiveTaskRunSummaries(db, { workspaceId: 2, tenantId: 3 })
    expect(active).toHaveLength(2_001)
    expect(active[0].taskId).toBe('active-0000')
    expect(active.at(-1)?.taskId).toBe('active-2000')
  })

  it('lists and reads only scoped video-analysis results through the safe projection', () => {
    const list = listN8nVideoResults(
      db,
      { workspaceId: 2, tenantId: 3 },
      { status: 'succeeded', query: 'S03E03', limit: 10 },
    )
    expect(list).toMatchObject({ total: 1, limit: 10, offset: 0 })
    expect(list.results[0]).toMatchObject({
      taskId: 'batch-a:video:002:abcdef123456',
      title: 'S03E03.mp4',
      summary: 'S03E03 的正式分析摘要。',
      chapterCount: 1,
      timelineCount: 1,
    })
    expect(list.results[0]).not.toHaveProperty('output')

    const detail = getN8nVideoResultDetail(
      db,
      'batch-a:video:002:abcdef123456',
      { workspaceId: 2, tenantId: 3 },
    )
    expect(detail).toMatchObject({
      transcript: '完整旁白',
      visualAnalysis: '完整视觉证据',
      fullReport: 'S03E03 完整报告',
      chapters: [{ summary: '开场章节' }],
      timeline: [{ transcript: '旁白内容', visualAnalysis: '冰川画面' }],
    })
    expect(getN8nVideoResultDetail(
      db,
      'other-workspace',
      { workspaceId: 2, tenantId: 3 },
    )).toBeNull()
    expect(getN8nVideoResultDetail(
      db,
      'legacy-task-with-a-very-long-identifier',
      { workspaceId: 2, tenantId: 3 },
    )).toBeNull()
  })

  it('searches learned content and returns exact playable time segments', () => {
    const byVisual = searchN8nVideoResults(
      db,
      { workspaceId: 2, tenantId: 3 },
      '冰川',
      20,
    )
    expect(byVisual).toMatchObject({ query: '冰川', videoCount: 1, segmentCount: 1 })
    expect(byVisual.hits[0]).toMatchObject({
      taskId: 'batch-a:video:002:abcdef123456',
      kind: 'timeline',
      startSeconds: 0,
      endSeconds: 60,
      matchedFields: ['画面'],
    })
    expect(JSON.stringify(byVisual)).not.toContain('private prompt')
    expect(JSON.stringify(byVisual)).not.toContain('/Users/operator')

    const byChapter = searchN8nVideoResults(
      db,
      { workspaceId: 2, tenantId: 3 },
      '开场章节',
      20,
    )
    expect(byChapter.hits[0]).toMatchObject({ kind: 'chapter', startSeconds: 0, endSeconds: 300 })
  })
})
