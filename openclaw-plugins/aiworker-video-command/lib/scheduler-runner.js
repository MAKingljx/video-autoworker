import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

import { executeFile, parseSingleLineJson } from './json-command.js'

export const INSTALLED_TASK_FLOW_SCRIPT = resolve(
  homedir(),
  'AI-worker-second-original-workspace',
  'skills',
  'aiworker-task-flow',
  'scripts',
  'submit-task.mjs',
)

const DISPATCH_TIMEOUT_MS = 25_000
const STATUS_TIMEOUT_MS = 15_000
const STATUS_SEARCH_TIMEOUT_MS = 15_000
const TASK_ID_PATTERN = /^(?:video-command|video-natural)-[a-f0-9]{64}$/u
const BATCH_ID_PATTERN = /^video-batch-[a-f0-9]{64}$/u
const DISPATCH_STATUSES = new Set([
  'queued', 'accepted', 'running', 'succeeded', 'failed', 'cancelled',
  'completed_with_errors',
])
const TASK_STATUSES = new Set(['queued', 'accepted', 'running', 'succeeded', 'failed', 'cancelled'])
const BATCH_STATUSES = new Set([
  'queued', 'running', 'recovering', 'paused', 'succeeded', 'completed_with_errors',
])
const SEARCH_ITEM_STATUSES = new Set([
  'staging', 'queued', 'submitted', 'accepted', 'running', 'waiting', 'succeeded', 'failed',
  'cancelled', 'unknown',
])
const SEARCH_BATCH_STATUSES = new Set([
  ...BATCH_STATUSES,
  ...SEARCH_ITEM_STATUSES,
])
const MAX_SEARCH_QUERY_LENGTH = 512
const MAX_SEARCH_MATCHES = 32

export function isSchedulerTaskId(value) {
  return typeof value === 'string' && TASK_ID_PATTERN.test(value)
}

export function isSchedulerBatchId(value) {
  return typeof value === 'string' && BATCH_ID_PATTERN.test(value)
}

function normalizeSearchQuery(value) {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || !value
    || value.length > MAX_SEARCH_QUERY_LENGTH
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) throw new Error('invalid_search_query')
  return value
}

function normalizeDispatchResult(value, expectedId, kind) {
  const idKey = kind === 'batch' ? 'batchId' : 'taskId'
  if (
    !value
    || value[idKey] !== expectedId
    || !DISPATCH_STATUSES.has(value.status)
    || typeof value.duplicate !== 'boolean'
  ) {
    throw new Error('invalid_dispatch_result')
  }
  if (!value.duplicate && value.status !== 'queued') {
    throw new Error('invalid_fresh_dispatch_status')
  }
  return {
    kind,
    id: expectedId,
    status: value.status,
    duplicate: value.duplicate,
  }
}

function safeSummary(output) {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return null
  if (typeof output.summary !== 'string') return null
  const text = output.summary
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!text) return null
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

function normalizeTaskStatus(value, expectedTaskId) {
  if (
    !value
    || value.taskId !== expectedTaskId
    || !TASK_STATUSES.has(value.status)
  ) {
    throw new Error('invalid_task_status_result')
  }
  return {
    kind: 'task',
    id: expectedTaskId,
    status: value.status,
    summary: value.status === 'succeeded' ? safeSummary(value.output) : null,
  }
}

function normalizeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : undefined
}

function normalizeBatchStatus(value, expectedBatchId) {
  if (
    !value
    || value.batchId !== expectedBatchId
    || !BATCH_STATUSES.has(value.status)
    || normalizeCount(value.total) === undefined
  ) {
    throw new Error('invalid_batch_status_result')
  }
  const counts = value.counts && typeof value.counts === 'object' && !Array.isArray(value.counts)
    ? Object.fromEntries(Object.entries(value.counts)
      .filter(([, count]) => normalizeCount(count) !== undefined))
    : {}
  return {
    kind: 'batch',
    id: expectedBatchId,
    status: value.status,
    total: value.total,
    counts,
  }
}

function normalizeSearchName(value) {
  if (typeof value !== 'string') throw new Error('invalid_search_result')
  const name = value
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
  if (!name || name.length > 180) throw new Error('invalid_search_result')
  return name
}

function normalizeSearchMatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_search_result')
  if (value.kind === 'task') {
    if (
      !isSchedulerTaskId(value.taskId)
      || !SEARCH_ITEM_STATUSES.has(value.status)
      || !SEARCH_BATCH_STATUSES.has(value.batchStatus)
    ) throw new Error('invalid_search_result')
    return {
      kind: 'task',
      taskId: value.taskId,
      name: normalizeSearchName(value.name),
      status: value.status,
    }
  }
  if (value.kind === 'batch') {
    if (
      !isSchedulerBatchId(value.batchId)
      || !SEARCH_ITEM_STATUSES.has(value.status)
      || !SEARCH_BATCH_STATUSES.has(value.batchStatus)
    ) throw new Error('invalid_search_result')
    return {
      kind: 'batch',
      batchId: value.batchId,
      name: normalizeSearchName(value.name),
      status: value.status,
    }
  }
  throw new Error('invalid_search_result')
}

function normalizeSearchResult(value) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !Array.isArray(value.matches)
    || value.matches.length > MAX_SEARCH_MATCHES
    || !Number.isInteger(value.total)
    || value.total < value.matches.length
    || typeof value.truncated !== 'boolean'
    || (value.truncated !== (value.total > value.matches.length))
  ) throw new Error('invalid_search_result')
  const matches = value.matches.map(normalizeSearchMatch)
  const seen = new Set()
  for (const match of matches) {
    const key = `${match.kind}:${match.kind === 'task' ? match.taskId : match.batchId}`
    if (seen.has(key)) throw new Error('invalid_search_result')
    seen.add(key)
  }
  return { matches, total: value.total, truncated: value.truncated }
}

export function createSchedulerRunner({
  execute = executeFile,
  scriptPath = INSTALLED_TASK_FLOW_SCRIPT,
  nodePath = process.execPath,
} = {}) {
  if (!isAbsolute(scriptPath) || !isAbsolute(nodePath)) {
    throw new TypeError('runner paths must be absolute')
  }

  async function call(args, timeout) {
    const result = await execute(nodePath, [scriptPath, ...args], { timeout })
    return parseSingleLineJson(result.stdout)
  }

  return {
    async dispatchVideo({ videoPath, taskId }) {
      if (!isSchedulerTaskId(taskId)) throw new Error('invalid_task_id')
      const value = await call([
        '--video-file', videoPath,
        '--task-id', taskId,
        '--idempotency-key', taskId,
        '--delivery', 'none',
        '--wait-seconds', '0',
        '--no-trigger-recovery',
      ], DISPATCH_TIMEOUT_MS)
      return normalizeDispatchResult(value, taskId, 'task')
    },

    async dispatchDirectory({ videoDirectory, batchId }) {
      if (!isSchedulerBatchId(batchId)) throw new Error('invalid_batch_id')
      const value = await call([
        '--video-dir', videoDirectory,
        '--batch-id', batchId,
        '--delivery', 'none',
      ], DISPATCH_TIMEOUT_MS)
      return normalizeDispatchResult(value, batchId, 'batch')
    },

    async taskStatus({ taskId }) {
      if (!isSchedulerTaskId(taskId)) throw new Error('invalid_task_id')
      return normalizeTaskStatus(
        await call(['--status-brief', taskId], STATUS_TIMEOUT_MS),
        taskId,
      )
    },

    async batchStatus({ batchId }) {
      if (!isSchedulerBatchId(batchId)) throw new Error('invalid_batch_id')
      return normalizeBatchStatus(
        await call(['--batch-status', batchId], STATUS_TIMEOUT_MS),
        batchId,
      )
    },

    async searchStatus({ query }) {
      const safeQuery = normalizeSearchQuery(query)
      return normalizeSearchResult(
        await call(['--search-status', safeQuery], STATUS_SEARCH_TIMEOUT_MS),
      )
    },
  }
}

export const schedulerRunner = createSchedulerRunner()
