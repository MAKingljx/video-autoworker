import type Database from 'better-sqlite3'
import {
  listN8nActiveTaskRunSummaries,
  type N8nTaskRunListItem,
  type N8nTaskScope,
} from '@/lib/n8n-task-runs'
import { listN8nVideoQueueItems } from '@/lib/n8n-video-sources'
import { listN8nWorkflowBindings } from '@/lib/n8n-workflows'

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
  const activeRuns = new Map(
    listN8nActiveTaskRunSummaries(db, scope).map(run => [run.taskId, run]),
  )
  const queue: N8nTaskQueueItem[] = []

  for (const durable of durableItems) {
    const active = activeRuns.get(durable.taskId)
    if (active) activeRuns.delete(durable.taskId)
    const binding = bindings.get(durable.bindingId)!
    queue.push({
      taskId: durable.taskId,
      title: active?.title || durable.name,
      taskType: active?.taskType || binding.taskType || 'video-analysis',
      workflowName: active?.workflowName || binding.name || '视频分析链',
      status: active?.status || durable.status,
      source: active?.source || 'openclaw',
      attemptCount: active?.attemptCount || 0,
      maxAttempts: active?.maxAttempts || binding.retryCount + 1,
      createdAt: active?.createdAt || durable.createdAt,
      acceptedAt: active?.acceptedAt || durable.submittedAt,
      startedAt: active?.startedAt || null,
      processingStartedAt: active?.processingStartedAt || null,
      completedAt: null,
      updatedAt: Math.max(active?.updatedAt || 0, durable.updatedAt),
      error: active?.error || durable.error,
      resultAvailable: false,
      batchId: active?.batchId || durable.batchId,
      batchIndex: active?.batchIndex || durable.batchIndex,
      queuePosition: 0,
      queueOrigin: active ? 'durable+n8n' : 'durable',
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
