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
const MAX_RESULT_OFFSET = 16 * 1024 * 1024
const MAX_RESULT_PAGE_BYTES = 24 * 1024
const BATCH_ITEM_TASK_ID_PATTERN = /^video-batch-[a-f0-9]{64}:video:\d{3}:[a-f0-9]{12}$/u

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

function normalizeResultOffset(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RESULT_OFFSET) {
    throw new Error('invalid_result_offset')
  }
  return value
}

function normalizeDispatchResult(value, expectedId, kind) {
  const idKey = kind === 'batch' ? 'batchId' : 'taskId'
  if (value?.confirmationRequired === true) {
    if (
      value[idKey] !== expectedId
      || value.status !== 'confirmation_required'
      || value.duplicate !== false
      || !Number.isInteger(value.duplicateCount)
      || value.duplicateCount < 1
      || !Array.isArray(value.duplicateNames)
      || value.duplicateNames.length < 1
      || value.duplicateNames.length > 10
      || typeof value.truncated !== 'boolean'
    ) throw new Error('invalid_dispatch_confirmation')
    return {
      kind,
      id: expectedId,
      status: value.status,
      duplicate: false,
      confirmationRequired: true,
      duplicateCount: value.duplicateCount,
      duplicateNames: value.duplicateNames.map(normalizeSearchName),
      truncated: value.truncated,
    }
  }
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

function normalizeBatchItem(value, total) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || !Number.isInteger(value.index)
    || value.index < 1
    || value.index > total
    || !SEARCH_ITEM_STATUSES.has(value.status)
  ) throw new Error('invalid_batch_status_result')
  return {
    index: value.index,
    name: normalizeSearchName(value.name),
    status: value.status,
  }
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
  const items = Array.isArray(value.items)
    ? value.items.map(item => normalizeBatchItem(item, value.total))
    : []
  if (items.length && items.length !== value.total) throw new Error('invalid_batch_status_result')
  if (new Set(items.map(item => item.index)).size !== items.length) {
    throw new Error('invalid_batch_status_result')
  }
  return {
    kind: 'batch',
    id: expectedBatchId,
    status: value.status,
    total: value.total,
    counts,
    items,
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
      || !Number.isInteger(value.index)
      || value.index < 1
      || value.index > 100
      || !SEARCH_ITEM_STATUSES.has(value.status)
      || !SEARCH_BATCH_STATUSES.has(value.batchStatus)
    ) throw new Error('invalid_search_result')
    return {
      kind: 'batch',
      batchId: value.batchId,
      index: value.index,
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
    const key = match.kind === 'task'
      ? `${match.kind}:${match.taskId}`
      : `${match.kind}:${match.batchId}:${match.index}`
    if (seen.has(key)) throw new Error('invalid_search_result')
    seen.add(key)
  }
  return { matches, total: value.total, truncated: value.truncated }
}

function isResultTaskId(value) {
  return isSchedulerTaskId(value) || (typeof value === 'string' && BATCH_ITEM_TASK_ID_PATTERN.test(value))
}

function normalizeResultName(value) {
  if (value === null) return null
  return normalizeSearchName(value)
}

function normalizeResultTimestamp(value) {
  if (value === null) return null
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || !value
    || value.length > 64
    || !Number.isFinite(Date.parse(value))
  ) throw new Error('invalid_task_result')
  return value
}

function normalizeResultMatch(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid_task_result')
  }
  const base = {
    name: normalizeSearchName(value.name),
    status: SEARCH_ITEM_STATUSES.has(value.status) ? value.status : null,
    completedAt: normalizeResultTimestamp(value.completedAt),
    updatedAt: normalizeResultTimestamp(value.updatedAt),
  }
  if (!base.status) throw new Error('invalid_task_result')
  if (value.kind === 'task') {
    if (!isSchedulerTaskId(value.taskId) || value.batchId !== null || value.index !== null) {
      throw new Error('invalid_task_result')
    }
    return { kind: 'task', taskId: value.taskId, batchId: null, index: null, ...base }
  }
  if (value.kind === 'batch') {
    if (
      typeof value.taskId !== 'string'
      || !BATCH_ITEM_TASK_ID_PATTERN.test(value.taskId)
      || !isSchedulerBatchId(value.batchId)
      || !Number.isInteger(value.index)
      || value.index < 1
      || value.index > 100
    ) throw new Error('invalid_task_result')
    return {
      kind: 'batch',
      taskId: value.taskId,
      batchId: value.batchId,
      index: value.index,
      ...base,
    }
  }
  throw new Error('invalid_task_result')
}

function normalizeResultReport(value) {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_result_report')
  if (!['summary', 'combinedText'].includes(value.source) || typeof value.text !== 'string') {
    throw new Error('invalid_result_report')
  }
  if (Buffer.byteLength(value.text, 'utf8') > MAX_RESULT_PAGE_BYTES) {
    throw new Error('invalid_result_report')
  }
  if (!Number.isSafeInteger(value.offset) || value.offset < 0 || value.offset > MAX_RESULT_OFFSET) {
    throw new Error('invalid_result_report')
  }
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes < Buffer.byteLength(value.text, 'utf8')) {
    throw new Error('invalid_result_report')
  }
  if (value.nextOffset !== null
    && (!Number.isSafeInteger(value.nextOffset)
      || value.nextOffset <= value.offset
      || value.nextOffset > value.totalBytes)) {
    throw new Error('invalid_result_report')
  }
  return {
    source: value.source,
    text: value.text,
    offset: value.offset,
    nextOffset: value.nextOffset,
    totalBytes: value.totalBytes,
  }
}

function normalizeTaskResult(value, expectedOffset) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_task_result')
  if (value.kind === 'matches') {
    if (
      !Array.isArray(value.matches)
      || value.matches.length > MAX_SEARCH_MATCHES
      || !Number.isInteger(value.total)
      || value.total < value.matches.length
      || typeof value.truncated !== 'boolean'
      || value.truncated !== (value.total > value.matches.length)
    ) throw new Error('invalid_task_result')
    return {
      kind: 'matches',
      matches: value.matches.map(normalizeResultMatch),
      total: value.total,
      truncated: value.truncated,
    }
  }
  if (
    value.kind !== 'report'
    || !isResultTaskId(value.taskId)
    || !SEARCH_ITEM_STATUSES.has(value.status)
  ) throw new Error('invalid_task_result')
  const report = normalizeResultReport(value.report)
  if (report && report.offset !== expectedOffset) throw new Error('invalid_task_result')
  if (value.status !== 'succeeded' && report !== null) throw new Error('invalid_task_result')
  return {
    kind: 'report',
    taskId: value.taskId,
    name: normalizeResultName(value.name),
    status: value.status,
    report,
  }
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
    async dispatchVideo({ videoPath, taskId, confirmDuplicate = false }) {
      if (!isSchedulerTaskId(taskId)) throw new Error('invalid_task_id')
      if (typeof confirmDuplicate !== 'boolean') throw new Error('invalid_confirmation')
      const value = await call([
        '--video-file', videoPath,
        '--task-id', taskId,
        '--idempotency-key', taskId,
        '--delivery', 'none',
        '--wait-seconds', '0',
        '--no-trigger-recovery',
        ...(confirmDuplicate ? ['--confirm-duplicate'] : []),
      ], DISPATCH_TIMEOUT_MS)
      return normalizeDispatchResult(value, taskId, 'task')
    },

    async dispatchDirectory({ videoDirectory, batchId, confirmDuplicate = false }) {
      if (!isSchedulerBatchId(batchId)) throw new Error('invalid_batch_id')
      if (typeof confirmDuplicate !== 'boolean') throw new Error('invalid_confirmation')
      const value = await call([
        '--video-dir', videoDirectory,
        '--batch-id', batchId,
        '--delivery', 'none',
        ...(confirmDuplicate ? ['--confirm-duplicate'] : []),
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

    async batchItemStatus({ batchId, index }) {
      if (!isSchedulerBatchId(batchId) || !Number.isInteger(index) || index < 1 || index > 100) {
        throw new Error('invalid_batch_item')
      }
      const batch = normalizeBatchStatus(
        await call(['--batch-status', batchId], STATUS_TIMEOUT_MS),
        batchId,
      )
      const item = batch.items.find(candidate => candidate.index === index)
      if (!item) throw new Error('batch_item_not_found')
      return {
        kind: 'batch_item',
        id: batchId,
        index,
        name: item.name,
        status: item.status,
        batchStatus: batch.status,
        total: batch.total,
        counts: batch.counts,
      }
    },

    async searchStatus({ query }) {
      const safeQuery = normalizeSearchQuery(query)
      return normalizeSearchResult(
        await call(['--search-status', safeQuery], STATUS_SEARCH_TIMEOUT_MS),
      )
    },

    async taskResult({ query, offset = 0 }) {
      const safeQuery = normalizeSearchQuery(query)
      const safeOffset = normalizeResultOffset(offset)
      return normalizeTaskResult(
        await call(['--result', safeQuery, '--result-offset', String(safeOffset)], STATUS_TIMEOUT_MS),
        safeOffset,
      )
    },
  }
}

export const schedulerRunner = createSchedulerRunner()
