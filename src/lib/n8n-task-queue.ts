import type Database from 'better-sqlite3'
import {
  listN8nActiveTaskRunSummaries,
  listScopedN8nTaskRunStatusSummaries,
  type N8nTaskRunListItem,
  type N8nTaskScope,
} from '@/lib/n8n-task-runs'
import { listN8nVideoQueueItems } from '@/lib/n8n-video-sources'
import { listN8nWorkflowBindings } from '@/lib/n8n-workflows'
import {
  isTerminalTaskStatus,
  selectAuthoritativeTaskRecord,
} from '../../openclaw-skills/aiworker-task-flow/lib/task-status-authority.mjs'

const STALE_AFTER_SECONDS = 24 * 60 * 60
const WAITING_STATUSES = new Set(['queued', 'staging', 'submitted', 'accepted'])
const ATTENTION_STATUSES = new Set(['waiting', 'recovering', 'paused'])

export interface N8nTaskQueueItem extends N8nTaskRunListItem {
  queuePosition: number
  queueOrigin: 'durable' | 'durable+n8n' | 'n8n'
  batchStatus: string | null
  sourceAvailable: boolean | null
  stale: boolean
}

export interface N8nTaskQueueResult {
  queue: N8nTaskQueueItem[]
  total: number
  counts: {
    waiting: number
    running: number
    attention: number
  }
  generatedAt: number
}

function isStale(run: N8nTaskRunListItem, nowSeconds: number, durable: boolean): boolean {
  if (durable || !['queued', 'accepted', 'running'].includes(run.status)) return false
  return nowSeconds - run.updatedAt >= STALE_AFTER_SECONDS
}

export async function listN8nTaskQueue(
  db: Database.Database,
  scope: N8nTaskScope,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<N8nTaskQueueResult> {
  const bindings = new Map(listN8nWorkflowBindings(db, scope).map(binding => [binding.id, binding]))
  const durableItems = (await listN8nVideoQueueItems())
    .filter(item => bindings.has(item.bindingId))
  const platformRuns = new Map(
    listScopedN8nTaskRunStatusSummaries(
      db,
      scope,
      durableItems.map(item => item.taskId),
    ).map(run => [run.taskId, run]),
  )
  const activeRuns = new Map(
    listN8nActiveTaskRunSummaries(db, scope).map(run => [run.taskId, run]),
  )
  const queue: N8nTaskQueueItem[] = []

  for (const durable of durableItems) {
    const active = activeRuns.get(durable.taskId) || null
    const selected = selectAuthoritativeTaskRecord({
      platformRecord: platformRuns.get(durable.taskId) || active,
      durableRecord: durable,
    })
    if (active) activeRuns.delete(durable.taskId)
    if (!selected) continue
    if (selected.source === 'platform' && isTerminalTaskStatus(selected.record.status)) continue
    const platform = selected.source === 'platform' ? selected.record : null
    const binding = bindings.get(durable.bindingId)!
    queue.push({
      taskId: durable.taskId,
      title: platform?.title || durable.name,
      taskType: platform?.taskType || binding.taskType || 'video-analysis',
      workflowName: platform?.workflowName || binding.name || '视频分析链',
      status: platform?.status || durable.status,
      source: platform?.source || 'openclaw',
      attemptCount: platform?.attemptCount ?? 0,
      maxAttempts: platform?.maxAttempts ?? binding.retryCount + 1,
      createdAt: platform?.createdAt ?? durable.createdAt,
      acceptedAt: platform?.acceptedAt ?? durable.submittedAt,
      startedAt: platform?.startedAt ?? null,
      processingStartedAt: platform?.processingStartedAt ?? null,
      completedAt: platform?.completedAt ?? null,
      updatedAt: Math.max(platform?.updatedAt || 0, durable.updatedAt),
      error: platform ? platform.error : durable.error,
      resultAvailable: platform?.resultAvailable ?? false,
      batchId: platform?.batchId ?? durable.batchId,
      batchIndex: platform?.batchIndex ?? durable.batchIndex,
      queuePosition: 0,
      queueOrigin: platform ? 'durable+n8n' : 'durable',
      batchStatus: durable.batchStatus,
      sourceAvailable: durable.sourceAvailable,
      stale: false,
    })
  }

  for (const active of activeRuns.values()) {
    queue.push({
      ...active,
      queuePosition: 0,
      queueOrigin: 'n8n',
      batchStatus: null,
      sourceAvailable: null,
      stale: isStale(active, nowSeconds, false),
    })
  }

  const positioned = queue.map((item, index) => ({ ...item, queuePosition: index + 1 }))
  return {
    queue: positioned,
    total: positioned.length,
    counts: {
      waiting: positioned.filter(item => WAITING_STATUSES.has(item.status) && !item.stale).length,
      running: positioned.filter(item => item.status === 'running' && !item.stale).length,
      attention: positioned.filter(item => (
        item.stale || ATTENTION_STATUSES.has(item.status) || item.sourceAvailable === false
      )).length,
    },
    generatedAt: nowSeconds,
  }
}
