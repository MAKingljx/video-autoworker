import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'

import { imageSessionScope, legacyImageBinding } from './image-profile-binding.js'

const SCHEMA = 'aiworker-image-job-capabilities/v1'
const JOB_ID = /^[0-9a-f]{32}$/u
const SCOPE = /^[0-9a-f]{64}$/u
const MAX_SCOPES = 256
const MAX_GRANTS_PER_SCOPE = 256
const FILE_BYTES_LIMIT = 1024 * 1024
const GRANT_TTL_MS = 90 * 24 * 60 * 60 * 1_000

function validStateDirectory(value) {
  return typeof value === 'string' && isAbsolute(value) && value === value.trim()
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function validGrant(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'issuedAt,jobId'
    && typeof value.jobId === 'string' && JOB_ID.test(value.jobId)
    && Number.isFinite(value.issuedAt) && value.issuedAt > 0
}

function validScopeRow(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'grants,scope'
    && typeof value.scope === 'string' && SCOPE.test(value.scope)
    && Array.isArray(value.grants) && value.grants.length <= MAX_GRANTS_PER_SCOPE
    && value.grants.every(validGrant)
    && new Set(value.grants.map(item => item.jobId)).size === value.grants.length
}

function normalizeRows(rows, now) {
  const floor = now - GRANT_TTL_MS
  const normalized = []
  for (const row of rows) {
    const latest = new Map()
    for (const grant of row.grants) {
      if (grant.issuedAt < floor) continue
      const current = latest.get(grant.jobId)
      if (!current || current.issuedAt < grant.issuedAt) latest.set(grant.jobId, grant)
    }
    const grants = [...latest.values()]
      .sort((left, right) => right.issuedAt - left.issuedAt || left.jobId.localeCompare(right.jobId))
      .slice(0, MAX_GRANTS_PER_SCOPE)
    if (grants.length) normalized.push({ scope: row.scope, grants })
  }
  return normalized.sort((left, right) => left.scope.localeCompare(right.scope)).slice(0, MAX_SCOPES)
}

async function readStore(path, now) {
  let file
  try {
    const parent = await lstat(dirname(path))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('image_job_capability_store_invalid')
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if (error?.code === 'ENOENT') return new Map()
    throw error
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > FILE_BYTES_LIMIT || (stat.mode & 0o077)
      || (process.getuid && stat.uid !== process.getuid())) throw new Error('image_job_capability_store_invalid')
    const data = JSON.parse(await file.readFile('utf8'))
    if (!data || typeof data !== 'object' || Array.isArray(data)
      || Object.keys(data).sort().join(',') !== 'grants,schema'
      || data.schema !== SCHEMA || !Array.isArray(data.grants) || data.grants.length > MAX_SCOPES
      || data.grants.some(row => !validScopeRow(row))
      || new Set(data.grants.map(row => row.scope)).size !== data.grants.length) {
      throw new Error('image_job_capability_store_invalid')
    }
    return new Map(normalizeRows(data.grants, now).map(row => [row.scope, row]))
  } finally {
    await file.close()
  }
}

async function writeStore(path, grants) {
  const rows = [...grants.values()]
  const content = JSON.stringify({ schema: SCHEMA, grants: rows })
  if (Buffer.byteLength(content) > FILE_BYTES_LIMIT) throw new Error('image_job_capability_store_limit')
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const parentStat = await lstat(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('image_job_capability_store_invalid')
  await chmod(parent, 0o700)
  const temporary = `${path}.${randomUUID()}.tmp`
  let file
  try {
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    await file.writeFile(content)
    await file.sync()
    await file.close()
    file = null
    await rename(temporary, path)
  } finally {
    await file?.close()
    await unlink(temporary).catch(error => { if (error?.code !== 'ENOENT') throw error })
  }
}

function trustedSubscription(value, binding) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.jobId !== 'string' || !JOB_ID.test(value.jobId)
    || typeof value.scope !== 'string' || !SCOPE.test(value.scope)
    || typeof value.sessionKey !== 'string') return false
  return imageSessionScope({ agentId: binding.targetAgentId, sessionKey: value.sessionKey }, binding) === value.scope
}

// This is an authority record, not an image-job truth store and not a delivery
// queue. A job is recorded only after the image service returns a validated
// receipt to this exact session. The application still owns state and cancel.
export function createImageJobCapabilityStore({ binding = legacyImageBinding(), now = Date.now } = {}) {
  if (!validStateDirectory(binding?.stateDir) || typeof now !== 'function') {
    throw new Error('image_job_capability_binding_invalid')
  }
  let grants = new Map()
  let storagePath
  let started = false
  let saveQueue = Promise.resolve()

  function save() {
    saveQueue = saveQueue.catch(() => {}).then(() => writeStore(storagePath, grants))
    return saveQueue
  }

  function requireStarted() {
    if (!started || !storagePath) throw new Error('image_job_capability_store_not_started')
  }

  return Object.freeze({
    async start(context) {
      if (started) return
      if (!validStateDirectory(context?.stateDir) || context.stateDir !== binding.stateDir) {
        throw new Error('image_job_capability_profile_binding_mismatch')
      }
      storagePath = join(context.stateDir, 'aiworker-image-command', 'job-capabilities.json')
      grants = await readStore(storagePath, now())
      started = true
      // Persist pruning only after the complete private record has passed validation.
      await save()
    },
    async stop() {
      if (!started) return
      started = false
      await saveQueue.catch(() => {})
      storagePath = undefined
      grants = new Map()
    },
    async grant(value) {
      requireStarted()
      if (!trustedSubscription(value, binding)) throw new Error('image_job_capability_grant_invalid')
      const current = grants.get(value.scope) ?? { scope: value.scope, grants: [] }
      const next = current.grants.filter(item => item.jobId !== value.jobId)
      next.push({ jobId: value.jobId, issuedAt: now() })
      next.sort((left, right) => right.issuedAt - left.issuedAt || left.jobId.localeCompare(right.jobId))
      current.grants = next.slice(0, MAX_GRANTS_PER_SCOPE)
      grants.set(value.scope, current)
      if (grants.size > MAX_SCOPES) {
        const oldest = [...grants.values()].sort((left, right) => left.grants.at(-1).issuedAt - right.grants.at(-1).issuedAt)[0]
        if (oldest) grants.delete(oldest.scope)
      }
      await save()
      return true
    },
    async authorize(value) {
      requireStarted()
      if (!trustedSubscription(value, binding)) return false
      const row = grants.get(value.scope)
      return Boolean(row?.grants.some(item => item.jobId === value.jobId))
    },
  })
}

// Unit-level callers receive the same least-privilege behavior without a
// filesystem lifecycle. Production registration always uses the persistent
// store above, which is why this helper intentionally is not exported.
export function createEphemeralImageJobCapabilities() {
  const grants = new Map()
  return Object.freeze({
    async grant({ jobId, scope }) {
      if (!JOB_ID.test(jobId || '') || !SCOPE.test(scope || '')) throw new Error('image_job_capability_grant_invalid')
      const known = grants.get(scope) ?? new Set()
      known.add(jobId)
      grants.set(scope, known)
      return true
    },
    async authorize({ jobId, scope }) {
      return Boolean(JOB_ID.test(jobId || '') && SCOPE.test(scope || '') && grants.get(scope)?.has(jobId))
    },
  })
}
