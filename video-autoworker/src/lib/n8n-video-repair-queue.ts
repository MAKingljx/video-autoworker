import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { n8nVideoBatchRoot } from '@/lib/n8n-video-sources'
import { readVideoLearningResult } from '../../openclaw-skills/aiworker-task-flow/lib/video-learning-result.mjs'
import type { N8nTaskRun, N8nTaskScope } from '@/lib/n8n-task-runs'
import { acquireBatchLock, assertVideoRepairWorkerLease, batchStatePath, learningRepairRequestValid,
  writeBatchState } from '../../openclaw-skills/aiworker-task-flow/lib/video-batch-state.mjs'

export interface QueuedVideoSegmentRepair {
  schema: 'aiworker-video-segment-repair-request/v1'
  requestId: string
  taskId: string
  bindingId: number
  tenantId: number
  workspaceId: number
  actorId: number
  segmentIndexes: number[]
  outputSha256: string
  revisionSha256: string
  evidenceSha256: string
  generation: number
  previousStatus: string
  createdAt: string
}

interface ControlledBatch {
  schemaVersion: number
  batchId: string
  bindingId: number
  status: string
  error: string | null
  items: Array<Record<string, unknown> & { taskId: string; idempotencyKey: string }>
  [key: string]: unknown
}

async function controlledRoot() {
  const configured = n8nVideoBatchRoot()
  const entry = await lstat(configured)
  if (!entry.isDirectory() || entry.isSymbolicLink() || (entry.mode & 0o077)
    || (process.getuid && entry.uid !== process.getuid()) || await realpath(configured) !== configured) {
    throw new Error('recovery_batch_root_invalid')
  }
  return configured
}

async function readControlledBatch(pathname: string, root: string): Promise<ControlledBatch> {
  if (dirname(pathname) !== root) throw new Error('recovery_batch_path_invalid')
  const entry = await lstat(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size < 2 || entry.size > 8 * 1024 * 1024
    || (entry.mode & 0o077) || (process.getuid && entry.uid !== process.getuid())) throw new Error('recovery_batch_file_invalid')
  const file = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (before.dev !== entry.dev || before.ino !== entry.ino || before.size !== entry.size) throw new Error('recovery_batch_file_changed')
    const raw = await file.readFile('utf8')
    const after = await file.stat()
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('recovery_batch_file_changed')
    const value = JSON.parse(raw) as ControlledBatch
    if (value.schemaVersion !== 2 || !Array.isArray(value.items) || value.items.length > 20_000
      || batchStatePath(value.batchId, root) !== pathname || !Number.isSafeInteger(value.bindingId)) {
      throw new Error('recovery_batch_identity_invalid')
    }
    return value
  } finally { await file.close() }
}

export async function locateOriginalVideoRepairBatch(run: N8nTaskRun) {
  const root = await controlledRoot()
  if (typeof run.input.batchId !== 'string' || !run.input.batchId) throw new Error('recovery_original_batch_missing')
  const paths = [batchStatePath(run.input.batchId, root)]
  const matches: Array<{ pathname: string; state: ControlledBatch; itemIndex: number }> = []
  for (const pathname of paths) {
    const state = await readControlledBatch(pathname, root)
    if (state.bindingId !== run.bindingId) continue
    for (const [itemIndex, item] of state.items.entries()) {
      if (item.taskId !== run.taskId) continue
      if (item.idempotencyKey !== run.idempotencyKey || item.stagingRecovery) throw new Error('recovery_batch_item_identity_changed')
      matches.push({ pathname, state, itemIndex })
    }
  }
  if (matches.length !== 1) throw new Error(matches.length ? 'recovery_batch_item_ambiguous' : 'recovery_original_batch_missing')
  return matches[0]
}

export async function enqueueOriginalVideoRepair(run: N8nTaskRun,
  input: Omit<QueuedVideoSegmentRepair, 'schema' | 'requestId' | 'taskId' | 'bindingId' | 'tenantId' | 'workspaceId' | 'previousStatus' | 'createdAt'>,
  assertCurrent: () => void,
) {
  const found = await locateOriginalVideoRepairBatch(run)
  const lock = await acquireBatchLock(found.pathname)
  if (!lock.acquired) throw new Error('recovery_batch_busy')
  try {
    const state = await readControlledBatch(found.pathname, dirname(found.pathname))
    const item = state.items[found.itemIndex]
    if (state.bindingId !== run.bindingId || item?.taskId !== run.taskId || item.idempotencyKey !== run.idempotencyKey
      || item.stagingRecovery) throw new Error('recovery_batch_item_identity_changed')
    const identity = { taskId: run.taskId, bindingId: run.bindingId, tenantId: run.tenantId,
      workspaceId: run.workspaceId, ...input }
    const requestId = createHash('sha256').update(JSON.stringify(identity)).digest('hex')
    const request: QueuedVideoSegmentRepair = { schema: 'aiworker-video-segment-repair-request/v1',
      requestId, ...identity, previousStatus: run.status, createdAt: new Date().toISOString() }
    if (!learningRepairRequestValid(request, item, state.bindingId)) throw new Error('recovery_repair_request_invalid')
    if (item.learningRepairRequest) {
      if ((item.learningRepairRequest as QueuedVideoSegmentRepair).requestId !== requestId) throw new Error('recovery_repair_already_queued')
      return { requestId, duplicate: true }
    }
    assertCurrent()
    item.learningRepairRequest = request
    item.learningResult = readVideoLearningResult(run.output)
    item.status = 'queued'
    delete item.completedAt
    item.error = null
    state.status = 'queued'
    state.error = null
    await writeBatchState(found.pathname, state)
    return { requestId, duplicate: false }
  } finally { await lock.release() }
}

export async function readOwnedQueuedVideoRepair(run: N8nTaskRun, scope: N8nTaskScope,
  input: { requestId: string; workerLease: { pid: number; token: string } },
) {
  const found = await locateOriginalVideoRepairBatch(run)
  await assertVideoRepairWorkerLease(found.pathname, input.workerLease)
  const request = found.state.items[found.itemIndex].learningRepairRequest as QueuedVideoSegmentRepair | undefined
  if (!request || !learningRepairRequestValid(request, found.state.items[found.itemIndex], found.state.bindingId)
    || request.requestId !== input.requestId || request.tenantId !== scope.tenantId || request.workspaceId !== scope.workspaceId) {
    throw new Error('recovery_repair_request_changed')
  }
  return request
}
