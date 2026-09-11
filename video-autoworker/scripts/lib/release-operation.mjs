import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, readFileSync,
  mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const RELEASE_OPERATION_SCOPE_SCHEMA = 'video-autoworker-release-operation-scope/v1'
export const RELEASE_OPERATION_EVENT_SCHEMA = 'video-autoworker-release-operation-event/v1'
export const RELEASE_OPERATION_OWNER_SCHEMA = 'video-autoworker-release-operation-owner/v1'
export const RELEASE_OPERATION_CANCEL_SCHEMA = 'video-autoworker-release-operation-cancel/v1'

const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u
const SAFE_NAME = /^[a-z0-9][a-z0-9._:-]{0,100}$/u
const MAX_JOURNAL_BYTES = 4 * 1024 * 1024
const sha256 = value => createHash('sha256').update(value).digest('hex')
const now = () => new Date().toISOString()

function fail(message) { throw new Error(`release operation failed: ${message}`) }

function assertPrivateDirectory(pathname) {
  if (!isAbsolute(pathname) || resolve(pathname) !== pathname
    || realpathSync.native(pathname) !== pathname) fail('private directory is unsafe')
  const entry = lstatSync(pathname)
  if (!entry.isDirectory() || entry.isSymbolicLink()
    || (typeof process.getuid === 'function' && entry.uid !== process.getuid())
    || (entry.mode & 0o777) !== 0o700) fail('private directory is unsafe')
}

function assertPrivateFile(pathname, maxBytes = MAX_JOURNAL_BYTES) {
  if (!isAbsolute(pathname) || realpathSync.native(pathname) !== pathname) {
    fail('private file is unsafe')
  }
  const entry = lstatSync(pathname)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1
    || (typeof process.getuid === 'function' && entry.uid !== process.getuid())
    || (entry.mode & 0o777) !== 0o600 || entry.size > maxBytes) {
    fail('private file is unsafe')
  }
  return entry
}

function privateJson(pathname) {
  assertPrivateFile(pathname, 128 * 1024)
  return JSON.parse(readFileSync(pathname, 'utf8'))
}

function replacePrivateJson(pathname, value) {
  assertPrivateDirectory(dirname(pathname))
  if (existsSync(pathname)) assertPrivateFile(pathname, 128 * 1024)
  const temporary = join(dirname(pathname), `.${basename(pathname)}.${process.pid}.${randomUUID()}.tmp`)
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL
    | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, pathname)
  const parent = openSync(dirname(pathname), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}

/** @param {string} planPath @param {string | null} [runDir] */
export function releaseOperationPaths(planPath, runDir = null) {
  if (!isAbsolute(planPath) || resolve(planPath) !== planPath || /[\r\n\0]/u.test(planPath)) {
    fail('plan path is invalid')
  }
  if (runDir !== null) assertPrivateDirectory(runDir)
  const stem = `.${basename(planPath)}.release-operation`
  return {
    journal: join(dirname(planPath), `${stem}.jsonl`),
    owner: join(dirname(planPath), `${stem}.owner.json`),
    cancel: join(dirname(planPath), `${stem}.cancel.json`),
    globalLock: runDir === null ? null : join(runDir, '.release-operation.lock'),
  }
}

export function createReleaseOperationScope(plan) {
  if (!COMMIT.test(plan?.sourceCommit || '') || !SHA256.test(plan?.planSha256 || '')
    || !Array.isArray(plan?.actions) || !['blue', 'green'].includes(plan?.router?.target)
    || typeof plan.router.releaseId !== 'string') fail('plan cannot define an operation scope')
  const completion = Object.freeze({
    route: plan.components?.app?.changed ? 'target_active_and_verified' : 'unchanged',
    components: plan.actions.filter(action => action.startsWith('install-')),
    intake: plan.actions.length ? 'owned_revision_restored' : 'unchanged',
  })
  const identity = JSON.stringify({ planSha256: plan.planSha256, sourceCommit: plan.sourceCommit,
    actions: plan.actions, target: plan.router.target, releaseId: plan.router.releaseId, completion })
  return Object.freeze({
    schema: RELEASE_OPERATION_SCOPE_SCHEMA,
    operationId: sha256(identity),
    planSha256: plan.planSha256,
    sourceCommit: plan.sourceCommit,
    targetSlot: plan.router.target,
    releaseId: plan.router.releaseId,
    actions: Object.freeze([...plan.actions]),
    completion,
  })
}

function validateEventInput(event) {
  if (!SAFE_NAME.test(event?.step || '') || !['started', 'completed', 'failed', 'observed',
    'cancel_requested', 'cancel_acknowledged', 'skipped'].includes(event?.status)) {
    fail('event input is invalid')
  }
  if (event.phase !== undefined && !SAFE_NAME.test(event.phase)) fail('event phase is invalid')
  if (event.errorCode !== undefined && !SAFE_NAME.test(event.errorCode)) fail('event code is invalid')
  if (event.effectState !== undefined && !SAFE_NAME.test(event.effectState)) fail('effect state is invalid')
  if (event.retryable !== undefined && typeof event.retryable !== 'boolean') fail('retryable is invalid')
  if (event.elapsedMs !== undefined
    && (!Number.isSafeInteger(event.elapsedMs) || event.elapsedMs < 0)) fail('elapsed time is invalid')
  if (event.attemptId !== undefined
    && !/^[a-f0-9-]{36}$/u.test(event.attemptId)) fail('attempt id is invalid')
  if (event.at !== undefined && !Number.isFinite(Date.parse(event.at))) fail('event time is invalid')
  return event
}

/** @param {string} pathname @param {string | null} [expectedOperationId] */
export function readReleaseOperationJournal(pathname, expectedOperationId = null) {
  if (!existsSync(pathname)) return []
  assertPrivateFile(pathname)
  const source = readFileSync(pathname, 'utf8')
  if (!source.endsWith('\n')) fail('journal has an incomplete tail')
  let previousSha256 = null
  const events = source.split('\n').filter(Boolean).map((line, index) => {
    const event = JSON.parse(line)
    if (event?.schema !== RELEASE_OPERATION_EVENT_SCHEMA || event.sequence !== index + 1
      || !SHA256.test(event.operationId || '')
      || event.previousSha256 !== previousSha256 || !SHA256.test(event.eventSha256 || '')) {
      fail('journal chain is invalid')
    }
    const copy = { ...event }; delete copy.eventSha256
    if (sha256(JSON.stringify(copy)) !== event.eventSha256) fail('journal digest is invalid')
    validateEventInput(event)
    if (expectedOperationId && event.operationId !== expectedOperationId) {
      fail('journal belongs to another operation')
    }
    previousSha256 = event.eventSha256
    return event
  })
  return events
}

export function appendReleaseOperationEvent(pathname, scope, input) {
  assertPrivateDirectory(dirname(pathname))
  if (scope?.schema !== RELEASE_OPERATION_SCOPE_SCHEMA || !SHA256.test(scope.operationId || '')) {
    fail('operation scope is invalid')
  }
  const events = readReleaseOperationJournal(pathname, scope.operationId)
  const eventInput = validateEventInput(input)
  const event = {
    schema: RELEASE_OPERATION_EVENT_SCHEMA,
    operationId: scope.operationId,
    sequence: events.length + 1,
    previousSha256: events.at(-1)?.eventSha256 || null,
    at: now(),
    ...(eventInput.attemptId ? { attemptId: eventInput.attemptId } : {}),
    step: eventInput.step,
    status: eventInput.status,
    ...(eventInput.phase ? { phase: eventInput.phase } : {}),
    ...(eventInput.effectState ? { effectState: eventInput.effectState } : {}),
    ...(eventInput.errorCode ? { errorCode: eventInput.errorCode } : {}),
    ...(eventInput.retryable !== undefined ? { retryable: eventInput.retryable } : {}),
    ...(eventInput.elapsedMs !== undefined ? { elapsedMs: eventInput.elapsedMs } : {}),
  }
  event.eventSha256 = sha256(JSON.stringify(event))
  const existed = existsSync(pathname)
  const fd = openSync(pathname, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND
    | constants.O_NOFOLLOW, 0o600)
  try { writeFileSync(fd, `${JSON.stringify(event)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
  if (!existed) {
    const parent = openSync(dirname(pathname), constants.O_RDONLY)
    try { fsyncSync(parent) } finally { closeSync(parent) }
  }
  assertPrivateFile(pathname)
  return event
}

function processStartToken(pid) {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).trim()
  } catch { return '' }
}

function validateGlobalOwner(value, operationId = null) {
  if (value?.schema !== RELEASE_OPERATION_OWNER_SCHEMA
    || (operationId && value.operationId !== operationId)
    || !SHA256.test(value.operationId || '')
    || !/^[a-f0-9-]{36}$/u.test(value.attemptId || '')
    || value.status !== 'running' || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || typeof value.startToken !== 'string' || !value.startToken) {
    fail('global operation owner is invalid')
  }
  return value
}

function acquireGlobalOperationLock(paths, owner) {
  if (!paths.globalLock) return
  const parent = dirname(paths.globalLock)
  assertPrivateDirectory(parent)
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const staging = join(parent,
      `.${basename(paths.globalLock)}.staging.${process.pid}.${randomUUID()}`)
    mkdirSync(staging, { mode: 0o700 })
    replacePrivateJson(join(staging, 'owner.json'), owner)
    const stagingFd = openSync(staging, constants.O_RDONLY)
    try { fsyncSync(stagingFd) } finally { closeSync(stagingFd) }
    try {
      renameSync(staging, paths.globalLock)
      const parentFd = openSync(parent, constants.O_RDONLY)
      try { fsyncSync(parentFd) } finally { closeSync(parentFd) }
      return
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      if (!['EEXIST', 'ENOTEMPTY'].includes(error?.code)) throw error
      const entry = lstatSync(paths.globalLock)
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || (entry.mode & 0o777) !== 0o700
        || (typeof process.getuid === 'function' && entry.uid !== process.getuid())) {
        fail('global operation lock is unsafe')
      }
      if (!existsSync(join(paths.globalLock, 'owner.json'))) {
        if (readdirSync(paths.globalLock).length !== 0) fail('ownerless operation lock is unsafe')
        const ownerless = `${paths.globalLock}.stale.ownerless.${randomUUID()}`
        renameSync(paths.globalLock, ownerless)
        rmSync(ownerless, { recursive: true })
        continue
      }
      const existing = validateGlobalOwner(privateJson(join(paths.globalLock, 'owner.json')))
      if (processStartToken(existing.pid) === existing.startToken) fail('another release operation is running')
      const stale = `${paths.globalLock}.stale.${existing.attemptId}`
      if (existsSync(stale)) fail('stale operation lock requires review')
      renameSync(paths.globalLock, stale)
      rmSync(stale, { recursive: true })
    }
  }
  fail('global operation lock could not be acquired')
}

function releaseGlobalOperationLock(paths, owner) {
  if (!paths.globalLock) return
  const current = validateGlobalOwner(privateJson(join(paths.globalLock, 'owner.json')),
    owner.operationId)
  if (current.attemptId !== owner.attemptId || current.pid !== process.pid
    || current.startToken !== processStartToken(process.pid)) fail('global operation owner changed')
  rmSync(paths.globalLock, { recursive: true })
  const parent = openSync(dirname(paths.globalLock), constants.O_RDONLY)
  try { fsyncSync(parent) } finally { closeSync(parent) }
}

export function beginReleaseOperation(paths, scope) {
  assertPrivateDirectory(dirname(paths.owner))
  if (existsSync(paths.owner)) {
    const previous = privateJson(paths.owner)
    if (previous?.schema !== RELEASE_OPERATION_OWNER_SCHEMA
      || previous.operationId !== scope.operationId
      || !/^[a-f0-9-]{36}$/u.test(previous.attemptId || '')
      || !['running', 'completed', 'failed', 'cancelled'].includes(previous.status)) {
      fail('existing operation owner is invalid')
    }
    if (previous.status === 'running'
      && Number.isSafeInteger(previous.pid) && processStartToken(previous.pid) === previous.startToken) {
      fail('operation is already running')
    }
  }
  const attemptId = randomUUID()
  const owner = { schema: RELEASE_OPERATION_OWNER_SCHEMA, operationId: scope.operationId,
    attemptId, status: 'running', pid: process.pid, startToken: processStartToken(process.pid),
    startedAt: now() }
  if (!owner.startToken) fail('cannot bind operation owner')
  acquireGlobalOperationLock(paths, owner)
  try { replacePrivateJson(paths.owner, owner) }
  catch (error) { releaseGlobalOperationLock(paths, owner); throw error }
  return owner
}

export function finishReleaseOperation(paths, owner, status) {
  if (!['completed', 'failed', 'cancelled'].includes(status)) fail('owner status is invalid')
  const current = privateJson(paths.owner)
  if (current.operationId !== owner.operationId || current.attemptId !== owner.attemptId
    || current.pid !== process.pid || current.startToken !== processStartToken(process.pid)) {
    fail('operation owner changed')
  }
  replacePrivateJson(paths.owner, { ...current, status, pid: null, startToken: null, finishedAt: now() })
  releaseGlobalOperationLock(paths, owner)
}

export function requestReleaseOperationCancellation(paths, operationId) {
  const owner = privateJson(paths.owner)
  if (owner?.schema !== RELEASE_OPERATION_OWNER_SCHEMA || owner.operationId !== operationId) {
    fail('operation owner is invalid')
  }
  if (paths.globalLock && owner.status === 'running') {
    const globalOwner = validateGlobalOwner(privateJson(join(paths.globalLock, 'owner.json')),
      operationId)
    if (globalOwner.attemptId !== owner.attemptId || globalOwner.pid !== owner.pid
      || globalOwner.startToken !== owner.startToken) fail('global operation owner changed')
  }
  const request = { schema: RELEASE_OPERATION_CANCEL_SCHEMA, operationId,
    targetAttemptId: owner.attemptId, requestedAt: now() }
  replacePrivateJson(paths.cancel, request)
  let signalled = false
  if (owner.status === 'running' && Number.isSafeInteger(owner.pid)
    && processStartToken(owner.pid) === owner.startToken) {
    process.kill(owner.pid, 'SIGTERM'); signalled = true
  }
  return { ...request, signalled }
}

export function createReleaseOperationCancellation(paths, owner, { pollMs = 250 } = {}) {
  if (!Number.isSafeInteger(pollMs) || pollMs < 50 || pollMs > 5000) fail('cancel poll is invalid')
  const controller = new AbortController()
  const abort = () => controller.abort(new Error('release operation cancelled'))
  const poll = () => {
    if (!existsSync(paths.cancel)) return
    const value = privateJson(paths.cancel)
    if (value?.schema === RELEASE_OPERATION_CANCEL_SCHEMA
      && value.operationId === owner.operationId && value.targetAttemptId === owner.attemptId) abort()
  }
  process.once('SIGTERM', abort); process.once('SIGINT', abort)
  const timer = setInterval(poll, pollMs); timer.unref(); poll()
  return { signal: controller.signal, close() {
    clearInterval(timer); process.removeListener('SIGTERM', abort); process.removeListener('SIGINT', abort)
  } }
}

export class ReleaseOperationError extends Error {
  constructor(message, { phase = 'unknown', errorCode = 'release_step_failed',
    effectState = 'unknown', retryable = false, cause } = {}) {
    super(message, { cause }); this.name = 'ReleaseOperationError'
    this.phase = phase; this.errorCode = errorCode; this.effectState = effectState
    this.retryable = retryable
    if (cause?.mutationNotStarted === true) this.mutationNotStarted = true
  }
}

export function classifyReleaseOperationError(error, { phase = 'unknown', effectState = 'unknown' } = {}) {
  if (error instanceof ReleaseOperationError) return error
  const message = String(error?.message || error)
  const cancelled = /abort|cancel/iu.test(message)
  const timeout = /timeout|timed out/iu.test(message)
  const conflict = /revision|changed after plan|already running/iu.test(message)
  return new ReleaseOperationError(message, {
    phase,
    errorCode: cancelled ? 'operation_cancelled' : timeout ? 'step_timeout'
      : conflict ? 'authority_conflict' : 'release_step_failed',
    effectState,
    retryable: timeout || conflict,
    cause: error instanceof Error ? error : undefined,
  })
}

export function releaseOperationStatus(scope, events, authorities = {}) {
  const latest = new Map()
  for (const event of events) latest.set(event.step, event)
  const route = latest.get('route')
  const acceptance = latest.get('acceptance')
  const operation = latest.get('operation')
  const currentAttempt = events.at(-1)?.attemptId || null
  return {
    schema: 'video-autoworker-release-operation-status/v1', operationId: scope.operationId,
    sourceCommit: scope.sourceCommit, attemptId: currentAttempt,
    state: operation?.status === 'completed' ? 'completed'
      : operation?.status === 'failed' ? 'failed'
        : operation?.status === 'cancel_acknowledged' ? 'cancelled'
          : acceptance?.status === 'completed' ? 'acceptance_verified_pending_settlement'
            : route?.effectState === 'route_committed' ? 'route_committed_unverified' : 'pending',
    routeCommitted: route?.effectState === 'route_committed',
    acceptanceVerified: acceptance?.status === 'completed',
    completedSteps: [...latest.entries()].filter(([, value]) => value.status === 'completed')
      .map(([step]) => step),
    authorities,
  }
}

export function buildBlueGreenCommand({ script, step, plan, releasesDir }) {
  if (!isAbsolute(script) || resolve(script) !== script || !isAbsolute(releasesDir || '')
    || resolve(releasesDir) !== releasesDir) fail('command path is invalid')
  const target = plan?.router?.target
  const plannedGeneration = plan?.router?.generation
  const originalTargetRelease = plan?.router?.slots?.[target]
  if (!['blue', 'green'].includes(target) || !COMMIT.test(plan?.sourceCommit || '')
    || plan.router.releaseId !== `${plan.sourceCommit}-runtime`
    || !Number.isSafeInteger(plannedGeneration) || plannedGeneration < 1
    || typeof originalTargetRelease !== 'string' || !originalTargetRelease
    || /[\r\n\0]/u.test(originalTargetRelease)) fail('command plan is invalid')
  const definitions = {
    stage: [script, 'stage', plan.router.releaseId, plan.artifactRoot],
    retire: [script, 'retire', target],
    bind: [script, 'bind', target, plan.router.releaseId,
      join(releasesDir, plan.router.releaseId, 'standalone')],
    probe: [script, 'probe', target],
    switch: [script, 'switch', target],
    attest: [script, 'attest-current'],
    'preflight-app': [script, 'preflight-app', target, plan.router.releaseId,
      join(releasesDir, plan.router.releaseId, 'standalone'), String(plannedGeneration),
      originalTargetRelease],
    'transition-app': [script, 'transition-app', target, plan.router.releaseId,
      join(releasesDir, plan.router.releaseId, 'standalone'), String(plannedGeneration),
      originalTargetRelease],
  }
  const args = definitions[step]
  if (!args || args.some(value => typeof value !== 'string' || !value || /[\r\n\0]/u.test(value))) {
    fail('command contract is invalid')
  }
  return Object.freeze({ command: '/bin/bash', args: Object.freeze(args), step })
}
