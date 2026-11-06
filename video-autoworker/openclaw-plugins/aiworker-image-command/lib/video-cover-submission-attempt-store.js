import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize } from 'node:path'

import { imageSessionScope, legacyImageBinding } from './image-profile-binding.js'

const SCHEMA = 'aiworker-video-cover-submission-attempts/v1'
const OPERATION_ID = /^[0-9a-f]{32}$/u
const FRAME_REF = /^[0-9a-f]{32}$/u
const JOB_ID = /^[0-9a-f]{32}$/u
const SCOPE = /^[0-9a-f]{64}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const MAX_ATTEMPTS = 128
const MAX_REVISIONS = 1
const FILE_BYTES_LIMIT = 1024 * 1024
const EDIT_ROLES = new Set(['kicker', 'title', 'subtitle', 'caption'])
const EDIT_ALIGNS = new Set(['left', 'center'])
const REVISABLE_REJECTIONS = new Set([
  'protected_title_box_too_small',
  'VIDEO_COVER_TITLE_BOX_TOO_SMALL',
])

function fail(code) { throw new Error(`video_cover_submission_attempt_${code}`) }

function plainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))
}

function safeString(value, maximum, empty = false) {
  return typeof value === 'string' && (empty || value.trim().length > 0)
    && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
}

function validStateDirectory(value) {
  return typeof value === 'string' && isAbsolute(value) && normalize(value) === value && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function clone(value) { return JSON.parse(JSON.stringify(value)) }

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function rectangle(value) {
  if (!plainObject(value) || Object.keys(value).sort().join(',') !== 'height,width,x,y'
    || ['x', 'y', 'width', 'height'].some(key => !Number.isSafeInteger(value[key])
      || value[key] < (key === 'x' || key === 'y' ? 0 : 1) || value[key] > 8192)) return null
  return { x: value.x, y: value.y, width: value.width, height: value.height }
}

// The workflow receives this only after image-command-tool normalized the
// public schema. Revalidating the persisted version makes a damaged ledger
// fail closed instead of restoring an arbitrary retry payload.
function protectedPlan(value) {
  if (!plainObject(value) || Object.keys(value).sort().join(',') !== 'eraseRegions,schema,textLayers'
    || value.schema !== 'aiworker-protected-cover/v1'
    || !Array.isArray(value.eraseRegions) || !Array.isArray(value.textLayers)
    || value.eraseRegions.length > 4 || value.textLayers.length > 4
    || value.eraseRegions.length + value.textLayers.length === 0) return null
  const eraseRegions = value.eraseRegions.map(rectangle)
  if (eraseRegions.some(item => item === null)) return null
  const textLayers = []
  for (const item of value.textLayers) {
    if (!plainObject(item) || Object.keys(item).some(key => !['text', 'box', 'style', 'align', 'role'].includes(key))
      || !safeString(item.text, 128) || item.text !== item.text.trim() || /[\r\n\t]/u.test(item.text)
      || !EDIT_ROLES.has(item.role) || (Object.hasOwn(item, 'style') && !safeString(item.style, 1000, true))
      || (Object.hasOwn(item, 'align') && !EDIT_ALIGNS.has(item.align))) return null
    const box = rectangle(item.box)
    if (!box) return null
    textLayers.push({ text: item.text, box, ...(Object.hasOwn(item, 'style') ? { style: item.style } : {}),
      ...(Object.hasOwn(item, 'align') ? { align: item.align } : {}), role: item.role })
  }
  return { schema: value.schema, eraseRegions, textLayers }
}

function sessionHash(sessionKey) {
  return createHash('sha256').update(Buffer.from(sessionKey, 'utf8')).digest('hex')
}

function identity(input, binding) {
  if (!plainObject(input) || !OPERATION_ID.test(input.operationId || '') || !FRAME_REF.test(input.frameRef || '')
    || !SCOPE.test(input.imageScope || '') || typeof input.sessionKey !== 'string'
    || !input.sessionKey || input.sessionKey.length > 4096) fail('identity_invalid')
  const expectedScope = imageSessionScope({ agentId: binding.targetAgentId, sessionKey: input.sessionKey }, binding)
  if (!expectedScope || expectedScope !== input.imageScope) fail('identity_invalid')
  const sessionKeySha256 = sessionHash(input.sessionKey)
  return {
    imageScope: input.imageScope,
    sessionKeySha256,
    operationId: input.operationId,
    frameRef: input.frameRef,
    key: `${input.imageScope}\0${sessionKeySha256}\0${input.operationId}\0${input.frameRef}`,
  }
}

function validateAttempt(value) {
  const expected = ['createdAt', 'frameRef', 'imageScope', 'jobId', 'operationId', 'protectedPlan',
    'rejectionCode', 'revisionCount', 'sessionKeySha256', 'status', 'updatedAt']
  if (!plainObject(value) || Object.keys(value).sort().join(',') !== expected.sort().join(',')
    || !OPERATION_ID.test(value.operationId || '') || !FRAME_REF.test(value.frameRef || '')
    || !SCOPE.test(value.imageScope || '') || !SHA256.test(value.sessionKeySha256 || '')
    || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0
    || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < value.createdAt
    || !Number.isSafeInteger(value.revisionCount) || value.revisionCount < 0 || value.revisionCount > MAX_REVISIONS
    || !['unconfirmed', 'submitted', 'rejected'].includes(value.status)) return null
  const plan = protectedPlan(value.protectedPlan)
  if (!plan) return null
  if (value.status === 'submitted') {
    if (!JOB_ID.test(value.jobId || '') || value.rejectionCode !== null) return null
  } else if (value.status === 'rejected') {
    if (value.jobId !== null || value.rejectionCode !== 'protected_title_box_too_small') return null
  } else if (value.jobId !== null || value.rejectionCode !== null) return null
  return {
    createdAt: value.createdAt,
    frameRef: value.frameRef,
    imageScope: value.imageScope,
    jobId: value.jobId,
    operationId: value.operationId,
    protectedPlan: plan,
    rejectionCode: value.rejectionCode,
    revisionCount: value.revisionCount,
    sessionKeySha256: value.sessionKeySha256,
    status: value.status,
    updatedAt: value.updatedAt,
  }
}

function attemptKey(value) {
  return `${value.imageScope}\0${value.sessionKeySha256}\0${value.operationId}\0${value.frameRef}`
}

function publicAttempt(value, action) {
  return {
    action,
    operationId: value.operationId,
    frameRef: value.frameRef,
    protected: clone(value.protectedPlan),
    status: value.status,
    revisionCount: value.revisionCount,
    ...(value.jobId ? { jobId: value.jobId } : {}),
  }
}

async function ensurePrivateDirectory(pathname, create = false) {
  if (create) await mkdir(pathname, { recursive: true, mode: 0o700 })
  const stat = await lstat(pathname)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())
    || (stat.mode & 0o077) !== 0) fail('unsafe_directory')
  return stat
}

async function readStore(pathname) {
  let file
  try {
    await ensurePrivateDirectory(dirname(pathname))
    file = await open(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    throw error
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 2 || stat.size > FILE_BYTES_LIMIT || stat.nlink !== 1
      || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) fail('store_invalid')
    const data = JSON.parse(await file.readFile('utf8'))
    if (!plainObject(data) || Object.keys(data).sort().join(',') !== 'attempts,schema'
      || data.schema !== SCHEMA || !Array.isArray(data.attempts) || data.attempts.length > MAX_ATTEMPTS) fail('store_invalid')
    const attempts = data.attempts.map(validateAttempt)
    if (attempts.some(item => item === null)) fail('store_invalid')
    const keys = attempts.map(attemptKey)
    if (new Set(keys).size !== keys.length) fail('store_invalid')
    return new Map(attempts.map(item => [attemptKey(item), item]))
  } finally {
    await file.close()
  }
}

async function writeStore(pathname, attempts) {
  const rows = [...attempts.values()].sort((left, right) => attemptKey(left).localeCompare(attemptKey(right)))
  const content = JSON.stringify({ schema: SCHEMA, attempts: rows })
  if (Buffer.byteLength(content) > FILE_BYTES_LIMIT) fail('store_limit')
  const parent = dirname(pathname)
  await ensurePrivateDirectory(parent, true)
  await chmod(parent, 0o700)
  const temporary = `${pathname}.${randomUUID()}.tmp`
  let file
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await file.writeFile(content)
    await file.sync()
    await file.close()
    file = undefined
    await rename(temporary, pathname)
  } finally {
    await file?.close()
    await unlink(temporary).catch(error => { if (error?.code !== 'ENOENT') throw error })
  }
}

// This ledger is deliberately distinct from image task state and completion
// notifications. It only guards a per-frame submission attempt: an uncertain
// response is recovered with its original deterministic request, rather than
// letting a model vary the layout and enqueue another image.
export function createVideoCoverSubmissionAttemptStore({ stateDir, binding = legacyImageBinding(), now = Date.now,
  maxAttempts = MAX_ATTEMPTS, maxRevisions = MAX_REVISIONS } = {}) {
  if (!validStateDirectory(stateDir) || !binding || typeof now !== 'function'
    || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS
    || !Number.isSafeInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > MAX_REVISIONS) {
    fail('configuration_invalid')
  }
  let attempts = new Map()
  let storagePath
  let started = false
  let mutation = Promise.resolve()

  function currentTime() {
    const value = now()
    if (!Number.isSafeInteger(value) || value <= 0) fail('clock_invalid')
    return value
  }

  function requireStarted() {
    if (!started || !storagePath) fail('not_started')
  }

  function enqueue(work) {
    const next = mutation.catch(() => {}).then(work)
    mutation = next.catch(() => {})
    return next
  }

  async function mutate(work) {
    return enqueue(async () => {
      requireStarted()
      const output = work()
      await writeStore(storagePath, attempts)
      return output
    })
  }

  return Object.freeze({
    async start(context = {}) {
      if (started) return
      if (!validStateDirectory(context.stateDir) || context.stateDir !== stateDir) fail('profile_binding_mismatch')
      await ensurePrivateDirectory(stateDir)
      storagePath = join(stateDir, 'aiworker-image-command', 'video-cover-submission-attempts.json')
      await ensurePrivateDirectory(dirname(storagePath), true)
      attempts = await readStore(storagePath)
      if (attempts.size > maxAttempts) fail('store_limit')
      started = true
    },
    async stop() {
      if (!started) return
      started = false
      await mutation.catch(() => {})
      attempts = new Map()
      storagePath = undefined
    },
    async beginOrResume(input) {
      return mutate(() => {
        const owner = identity(input, binding)
        const proposed = protectedPlan(input.protected)
        if (!proposed) fail('protected_plan_invalid')
        const existing = attempts.get(owner.key)
        if (!existing) {
          if (attempts.size >= maxAttempts) fail('store_limit')
          const stamp = currentTime()
          const created = {
            createdAt: stamp,
            frameRef: owner.frameRef,
            imageScope: owner.imageScope,
            jobId: null,
            operationId: owner.operationId,
            protectedPlan: proposed,
            rejectionCode: null,
            revisionCount: 0,
            sessionKeySha256: owner.sessionKeySha256,
            status: 'unconfirmed',
            updatedAt: stamp,
          }
          attempts.set(owner.key, created)
          return publicAttempt(created, 'new_submission')
        }
        if (existing.status === 'submitted') return publicAttempt(existing, 'existing_submission')
        if (existing.status === 'unconfirmed') return publicAttempt(existing, 'retry_unconfirmed')
        if (canonicalJson(existing.protectedPlan) === canonicalJson(proposed)) {
          return publicAttempt(existing, 'rejected_same_plan')
        }
        if (existing.revisionCount >= maxRevisions) return publicAttempt(existing, 'revision_limit')
        existing.protectedPlan = proposed
        existing.rejectionCode = null
        existing.revisionCount += 1
        existing.status = 'unconfirmed'
        existing.updatedAt = currentTime()
        return publicAttempt(existing, 'revision_submission')
      })
    },
    async markSubmitted(input) {
      return mutate(() => {
        const owner = identity(input, binding)
        if (!JOB_ID.test(input.jobId || '')) fail('job_invalid')
        const existing = attempts.get(owner.key)
        if (!existing) fail('unknown_attempt')
        if (existing.status === 'submitted') {
          if (existing.jobId !== input.jobId) fail('submission_conflict')
          return publicAttempt(existing, 'existing_submission')
        }
        if (existing.status !== 'unconfirmed') fail('submission_state_invalid')
        existing.jobId = input.jobId
        existing.rejectionCode = null
        existing.status = 'submitted'
        existing.updatedAt = currentTime()
        return publicAttempt(existing, 'submitted')
      })
    },
    async markRejected(input) {
      return mutate(() => {
        const owner = identity(input, binding)
        if (!REVISABLE_REJECTIONS.has(input.errorCode)) fail('rejection_not_revisable')
        const existing = attempts.get(owner.key)
        if (!existing) fail('unknown_attempt')
        if (existing.status === 'rejected') return publicAttempt(existing, 'existing_rejection')
        if (existing.status !== 'unconfirmed') fail('rejection_state_invalid')
        existing.jobId = null
        existing.rejectionCode = 'protected_title_box_too_small'
        existing.status = 'rejected'
        existing.updatedAt = currentTime()
        return publicAttempt(existing, 'rejected')
      })
    },
  })
}
