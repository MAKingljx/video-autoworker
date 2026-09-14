import { randomBytes } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync,
  readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { verifySharedDeploymentLockDelegationSync } from './shared-deployment-lock.mjs'

export const ROUTER_RETIRE_CONNECTIONS_PATH = '/__router/retire-connections'
export const ROUTER_RETIRE_CONNECTIONS_SCHEMA = 'video-autoworker-router-retire-connections/v1'
const fail = code => { throw new Error(`router_retirement_${code}`) }

function requestPath(stateFile, slot) {
  if (!['blue', 'green'].includes(slot)) fail('slot_invalid')
  return join(dirname(resolve(stateFile)), `router-retire-connections.${slot}.json`)
}

function safeRequest(pathname) {
  const fd = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid()
      || (info.mode & 0o777) !== 0o600 || info.size > 32 * 1024) fail('request_unsafe')
    return JSON.parse(readFileSync(fd, 'utf8'))
  } finally { closeSync(fd) }
}

function validateScope(value, state, routerPid) {
  if (value.schema !== ROUTER_RETIRE_CONNECTIONS_SCHEMA || value.routerPid !== routerPid
    || value.generation !== state.generation || value.active !== state.active
    || value.slot !== state.previous || value.slot === state.active
    || value.releaseId !== state.slots[value.slot]?.releaseId
    || !/^[a-f0-9]{64}$/u.test(value.requestId || '')
    || !Number.isSafeInteger(value.createdAt) || Math.abs(Date.now() - value.createdAt) > 30_000) {
    fail('scope_changed')
  }
  const drain = value.drain
  const scheduler = value.scheduler
  if (!drain || !['active', 'untrackedCallbacks', 'otherReleaseActive', 'childExecutionLeases']
    .every(key => drain[key] === 0)
    || !Number.isSafeInteger(drain.requiredQuietSeconds) || drain.requiredQuietSeconds < 30
    || !Number.isSafeInteger(drain.quietSeconds) || drain.quietSeconds < drain.requiredQuietSeconds
    || !scheduler || scheduler.schedulerState !== 'inactive'
    || scheduler.schedulerRouterGeneration !== state.generation) fail('business_not_drained')
}

/** The HTTP request alone cannot authorize closure: it needs the private,
 * single-use receipt and the live existing deployment-lock owner. */
export function consumeRouterRetirementRequest({ stateFile, state, routerPid, slot, requestId }) {
  const pathname = requestPath(stateFile, slot)
  const value = safeRequest(pathname)
  if (!requestId || value.requestId !== requestId) fail('request_not_owned')
  validateScope(value, state, routerPid)
  const owner = JSON.parse(value.lease?.ownerSource || '{}')
  const ownership = verifySharedDeploymentLockDelegationSync({
    runDirectory: dirname(resolve(stateFile)), ownerPid: value.lease?.ownerPid,
    ownerNonce: owner.nonce, expectedLease: value.lease,
  })
  ownership.assertCurrent()
  unlinkSync(pathname)
  return { slot: value.slot, generation: value.generation }
}

/** Called only after the existing retirement business and scheduler gates. */
export async function requestRouterConnectionDrain({ stateFile, state, routerPid, routerUrl,
  slot, lease, drain, scheduler }) {
  const url = new URL(routerUrl)
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('url_not_loopback')
  const value = { schema: ROUTER_RETIRE_CONNECTIONS_SCHEMA, routerPid, generation: state.generation,
    active: state.active, slot, releaseId: state.slots[slot]?.releaseId,
    requestId: randomBytes(32).toString('hex'), createdAt: Date.now(), lease, drain, scheduler }
  validateScope(value, state, routerPid)
  const owner = JSON.parse(lease?.ownerSource || '{}')
  const ownership = verifySharedDeploymentLockDelegationSync({ runDirectory: dirname(resolve(stateFile)),
    ownerPid: lease?.ownerPid, ownerNonce: owner.nonce, expectedLease: lease })
  ownership.assertCurrent()
  const pathname = requestPath(stateFile, slot)
  const fd = openSync(pathname, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const identity = fstatSync(fd)
  try { writeFileSync(fd, JSON.stringify(value)) } finally { closeSync(fd) }
  try {
    const response = await fetch(new URL(ROUTER_RETIRE_CONNECTIONS_PATH, url), {
      method: 'POST', headers: { 'x-aiworker-retire-request': value.requestId,
        'x-aiworker-retire-slot': slot }, redirect: 'error', signal: AbortSignal.timeout(5_000),
    })
    const result = await response.json()
    if (!response.ok || result.schema !== ROUTER_RETIRE_CONNECTIONS_SCHEMA || result.ok !== true
      || result.pid !== routerPid || result.generation !== state.generation || result.slot !== slot) {
      fail('response_invalid')
    }
    ownership.assertCurrent()
    return result
  } finally {
    if (existsSync(pathname)) {
      const current = lstatSync(pathname)
      if (current.dev === identity.dev && current.ino === identity.ino) unlinkSync(pathname)
    }
  }
}
