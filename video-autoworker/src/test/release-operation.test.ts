// @vitest-environment node

import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  appendReleaseOperationEvent,
  beginReleaseOperation,
  buildBlueGreenCommand,
  classifyReleaseOperationError,
  createReleaseOperationScope,
  finishReleaseOperation,
  readReleaseOperationJournal,
  releaseOperationPaths,
  releaseOperationStatus,
  requestReleaseOperationCancellation,
} from '../../scripts/lib/release-operation.mjs'

const commit = 'a'.repeat(40)
const cleanup: string[] = []
afterEach(() => {
  for (const pathname of cleanup.splice(0)) rmSync(pathname, { recursive: true, force: true })
})
const plan = {
  planSha256: 'b'.repeat(64), sourceCommit: commit,
  actions: ['stage-app', 'switch-target', 'attest-current'],
  components: { app: { changed: true } },
  router: { target: 'green', releaseId: `${commit}-runtime` },
}

function privateTask() {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'release-operation-')))
  cleanup.push(directory)
  chmodSync(directory, 0o700)
  const planPath = join(directory, 'plan.json')
  writeFileSync(planPath, '{}\n', { mode: 0o600 })
  return { directory, planPath }
}

describe('release operation contract', () => {
  it('binds scope, real blue-green argv and explicit completion conditions', () => {
    const scope = createReleaseOperationScope(plan)
    expect(scope).toMatchObject({ sourceCommit: commit, targetSlot: 'green',
      completion: { route: 'target_active_and_verified', intake: 'owned_revision_restored' } })
    expect(buildBlueGreenCommand({ script: '/private/tmp/deploy-blue-green.sh', step: 'bind',
      plan, releasesDir: '/private/tmp/releases' })).toEqual({
      command: '/bin/bash', step: 'bind', args: ['/private/tmp/deploy-blue-green.sh', 'bind',
        'green', `${commit}-runtime`, `/private/tmp/releases/${commit}-runtime/standalone`],
    })
  })

  it('keeps a chained private journal and distinguishes route commit from acceptance', () => {
    const { planPath } = privateTask()
    const paths = releaseOperationPaths(planPath)
    const scope = createReleaseOperationScope(plan)
    appendReleaseOperationEvent(paths.journal, scope,
      { step: 'operation', status: 'started', attemptId: crypto.randomUUID() })
    appendReleaseOperationEvent(paths.journal, scope,
      { step: 'route', status: 'observed', effectState: 'route_committed' })
    let events = readReleaseOperationJournal(paths.journal, scope.operationId)
    expect(releaseOperationStatus(scope, events)).toMatchObject({
      state: 'route_committed_unverified', routeCommitted: true, acceptanceVerified: false,
    })
    appendReleaseOperationEvent(paths.journal, scope,
      { step: 'acceptance', status: 'completed', effectState: 'acceptance_verified' })
    events = readReleaseOperationJournal(paths.journal, scope.operationId)
    expect(releaseOperationStatus(scope, events).state).toBe('acceptance_verified_pending_settlement')
    appendReleaseOperationEvent(paths.journal, scope,
      { step: 'operation', status: 'completed', effectState: 'acceptance_complete' })
    events = readReleaseOperationJournal(paths.journal, scope.operationId)
    expect(releaseOperationStatus(scope, events).state).toBe('completed')
  })

  it('fails closed when journal history is edited', () => {
    const { planPath } = privateTask()
    const paths = releaseOperationPaths(planPath)
    const scope = createReleaseOperationScope(plan)
    appendReleaseOperationEvent(paths.journal, scope,
      { step: 'operation', status: 'started' })
    writeFileSync(paths.journal,
      readFileSync(paths.journal, 'utf8').replace('"started"', '"failed"'), { mode: 0o600 })
    expect(() => readReleaseOperationJournal(paths.journal, scope.operationId))
      .toThrow('journal digest is invalid')
  })

  it('binds cancellation to the current owner process and finalizes it', () => {
    const { planPath } = privateTask()
    const paths = releaseOperationPaths(planPath)
    const scope = createReleaseOperationScope(plan)
    const owner = beginReleaseOperation(paths, scope)
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    const cancellation = requestReleaseOperationCancellation(paths, scope.operationId)
    expect(cancellation).toMatchObject({ targetAttemptId: owner.attemptId, signalled: true })
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM')
    kill.mockRestore()
    finishReleaseOperation(paths, owner, 'cancelled')
    expect(() => requestReleaseOperationCancellation(paths, scope.operationId)).not.toThrow()
  })

  it('serializes different plans through one canonical runtime owner', () => {
    const { directory, planPath } = privateTask()
    const firstScope = createReleaseOperationScope(plan)
    const firstPaths = releaseOperationPaths(planPath, directory)
    const first = beginReleaseOperation(firstPaths, firstScope)
    const secondPath = join(directory, 'second-plan.json')
    writeFileSync(secondPath, '{}\n', { mode: 0o600 })
    const secondPlan = { ...plan, planSha256: 'd'.repeat(64) }
    const secondPaths = releaseOperationPaths(secondPath, directory)
    expect(() => beginReleaseOperation(secondPaths, createReleaseOperationScope(secondPlan)))
      .toThrow('another release operation is running')
    finishReleaseOperation(firstPaths, first, 'completed')
    const second = beginReleaseOperation(secondPaths, createReleaseOperationScope(secondPlan))
    finishReleaseOperation(secondPaths, second, 'completed')
  })

  it('classifies cancellation, timeout and authority conflicts without exposing output', () => {
    expect(classifyReleaseOperationError(new Error('managed child timed out'), { phase: 'stage' }))
      .toMatchObject({ errorCode: 'step_timeout', retryable: true, phase: 'stage' })
    expect(classifyReleaseOperationError(new Error('revision changed'), { phase: 'intake' }))
      .toMatchObject({ errorCode: 'authority_conflict', retryable: true })
    expect(classifyReleaseOperationError(new Error('operation aborted'), { phase: 'switch' }))
      .toMatchObject({ errorCode: 'operation_cancelled', retryable: false })
  })
})
