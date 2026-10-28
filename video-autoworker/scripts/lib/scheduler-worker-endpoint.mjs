import { createHash } from 'node:crypto'
import { closeSync, constants, fsyncSync, linkSync, lstatSync, openSync,
  realpathSync, renameSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import { isAbsolute, join, resolve } from 'node:path'

const fail = code => { throw new Error(code) }
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function entryExists(pathname) {
  try { lstatSync(pathname); return true }
  catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
export const hasSchedulerEndpoint = stateDir => entryExists(join(stateDir, 'worker.sock'))
function directory(stateDir) {
  if (!isAbsolute(stateDir || '') || resolve(stateDir) !== stateDir || realpathSync(stateDir) !== stateDir) fail('worker_replacement_endpoint_directory_changed')
  const entry = lstatSync(stateDir, { bigint: true })
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== BigInt(process.getuid())
    || (entry.mode & 0o7777n) !== 0o700n) fail('worker_replacement_endpoint_directory_changed')
  return { dev: String(entry.dev), ino: String(entry.ino), uid: Number(entry.uid), mode: Number(entry.mode & 0o7777n) }
}
function socket(pathname) {
  let entry
  try { entry = lstatSync(pathname, { bigint: true }) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!entry.isSocket() || entry.isSymbolicLink() || entry.nlink !== 1n || entry.uid !== BigInt(process.getuid())
    || (entry.mode & 0o7777n) !== 0o600n || entry.birthtimeNs <= 0n) fail('worker_replacement_endpoint_unsafe')
  return { dev: String(entry.dev), ino: String(entry.ino), uid: Number(entry.uid), mode: Number(entry.mode & 0o7777n),
    birthtimeNs: String(entry.birthtimeNs), mtimeNs: String(entry.mtimeNs), ctimeNs: String(entry.ctimeNs) }
}
function sameGeneration(expected, actual) {
  return actual && ['dev', 'ino', 'uid', 'mode', 'birthtimeNs'].every(key => expected[key] === actual[key])
}
export function captureSchedulerEndpoint(stateDir) {
  const root = directory(stateDir), endpoint = socket(join(stateDir, 'worker.sock'))
  if (!endpoint) fail('worker_replacement_endpoint_missing')
  return { schema: 'video-autoworker-owned-scheduler-endpoint/v1', stateDir, root, endpoint }
}
export function assertSchedulerEndpointUnchanged(expected, actual) {
  if (!expected || digest(expected) !== digest(actual)) fail('worker_replacement_endpoint_changed')
}
function probe(pathname) {
  return new Promise((done, reject) => {
    const connection = net.createConnection({ path: pathname })
    connection.once('connect', () => { connection.destroy(); reject(new Error('worker_replacement_endpoint_live')) })
    connection.once('error', error => {
      connection.destroy()
      if (error.code === 'ECONNREFUSED') done()
      else reject(new Error('worker_replacement_endpoint_probe_unconfirmed'))
    })
    connection.setTimeout(2000, () => { connection.destroy(); reject(new Error('worker_replacement_endpoint_probe_unconfirmed')) })
  })
}
function syncDirectory(stateDir) {
  const fd = openSync(stateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
function preserveClaim(claim, pathname) {
  // link(2) cannot overwrite a successor. On an ambiguous restore, preserve
  // the claimed object for explicit recovery instead of deleting any object.
  try { linkSync(claim, pathname); unlinkSync(claim) }
  catch { fail('worker_replacement_endpoint_claim_preserved') }
}

/** Only an already stopped, lease-free, operation-owned worker may retire its
 * exact recorded endpoint. A stale filename or ECONNREFUSED alone is no proof. */
export async function retireExitedSchedulerEndpoint({ stateDir, operationId, expected, assertQuiescent }) {
  const pathname = join(stateDir, 'worker.sock')
  if (typeof assertQuiescent !== 'function' || !/^[a-f0-9]{64}$/u.test(operationId || '')) fail('worker_replacement_endpoint_authority_missing')
  assertQuiescent()
  const currentRoot = directory(stateDir)
  if (!expected) {
    if (!entryExists(pathname)) return { retired: false }
    fail('worker_replacement_endpoint_identity_missing')
  }
  if (expected.schema !== 'video-autoworker-owned-scheduler-endpoint/v1' || expected.stateDir !== stateDir
    || digest(currentRoot) !== digest(expected.root)) fail('worker_replacement_endpoint_changed')
  // Keep the claim shorter than worker.sock: Darwin AF_UNIX has a small
  // pathname bound. A collision is an identity-checked refusal, never overwrite.
  const claim = join(stateDir, `.w${digest({ operationId, expected }).slice(0, 8)}`)
  let recoveredClaim = false
  if (entryExists(claim)) {
    if (entryExists(pathname) || !sameGeneration(expected.endpoint, socket(claim))) fail('worker_replacement_endpoint_claim_conflict')
    recoveredClaim = true
  } else {
    const before = socket(pathname)
    if (!before) return { retired: false }
    if (!sameGeneration(expected.endpoint, before) || before.mtimeNs !== expected.endpoint.mtimeNs
      || before.ctimeNs !== expected.endpoint.ctimeNs) fail('worker_replacement_endpoint_changed')
    await probe(pathname)
    assertQuiescent()
    if (digest(directory(stateDir)) !== digest(expected.root)) fail('worker_replacement_endpoint_directory_changed')
    const after = socket(pathname)
    if (!after || digest(after) !== digest(before)) fail('worker_replacement_endpoint_changed')
    renameSync(pathname, claim)
    let captured
    try { captured = socket(claim) }
    catch { preserveClaim(claim, pathname); fail('worker_replacement_endpoint_changed') }
    if (!sameGeneration(expected.endpoint, captured)) { preserveClaim(claim, pathname); fail('worker_replacement_endpoint_changed') }
  }
  try {
    await probe(claim)
    assertQuiescent()
    if (digest(directory(stateDir)) !== digest(expected.root)
      || !sameGeneration(expected.endpoint, socket(claim))) fail('worker_replacement_endpoint_changed')
    if (entryExists(pathname)) fail('worker_replacement_endpoint_successor_present')
  } catch (error) {
    if (!entryExists(pathname)) preserveClaim(claim, pathname)
    throw error
  }
  unlinkSync(claim)
  syncDirectory(stateDir)
  if (entryExists(pathname)) fail('worker_replacement_endpoint_successor_present')
  return { retired: true, recoveredClaim, endpointSha256: digest(expected) }
}
