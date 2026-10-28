import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync,
  readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
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
function reservationIdentity(entry) {
  return ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'birthtimeNs', 'mtimeNs', 'ctimeNs'].map(key => String(entry[key]))
}
function verifyReservation(claim, fd, marker) {
  const opened = fstatSync(fd, { bigint: true }), current = lstatSync(claim, { bigint: true })
  if (!opened.isFile() || opened.nlink !== 1n || opened.uid !== BigInt(process.getuid())
    || (opened.mode & 0o7777n) !== 0o600n || opened.size !== BigInt(marker.length)
    || digest(reservationIdentity(opened)) !== digest(reservationIdentity(current))) fail('worker_replacement_endpoint_claim_conflict')
  const bytes = Buffer.alloc(marker.length)
  if (readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length || !bytes.equals(marker)
    || digest(reservationIdentity(opened)) !== digest(reservationIdentity(fstatSync(fd, { bigint: true })))
    || digest(reservationIdentity(opened)) !== digest(reservationIdentity(lstatSync(claim, { bigint: true })))) fail('worker_replacement_endpoint_claim_conflict')
}
function reserveClaim(claim, marker, existing = false) {
  let fd
  try {
    fd = openSync(claim, constants.O_NOFOLLOW | (existing ? constants.O_RDONLY
      : constants.O_RDWR | constants.O_CREAT | constants.O_EXCL), 0o600)
    if (!existing) { writeFileSync(fd, marker); fsyncSync(fd) }
    verifyReservation(claim, fd, marker)
    return fd
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    // Incomplete reservations are retained, never mistaken for an owned
    // socket. A complete same-operation marker can resume after interruption.
    if (error.code === 'EEXIST') fail('worker_replacement_endpoint_claim_conflict')
    throw error
  }
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
  const marker = Buffer.from(JSON.stringify({ schema: 'scheduler-endpoint-claim-reservation/v1', operationId, endpointSha256: digest(expected) }) + '\n')
  let recoveredClaim = false, recoveredReservation = false, reservationFd
  if (entryExists(claim)) {
    if (lstatSync(claim).isFile()) {
      reservationFd = reserveClaim(claim, marker, true)
      recoveredReservation = true
    } else {
      if (entryExists(pathname) || !sameGeneration(expected.endpoint, socket(claim))) fail('worker_replacement_endpoint_claim_conflict')
      recoveredClaim = true
    }
  }
  if (!recoveredClaim) {
    try {
    const before = socket(pathname)
    if (!before) {
      if (reservationFd !== undefined) {
        assertQuiescent(); verifyReservation(claim, reservationFd, marker); unlinkSync(claim); syncDirectory(stateDir)
      }
      return { retired: false, recoveredReservation }
    }
    if (!sameGeneration(expected.endpoint, before) || before.mtimeNs !== expected.endpoint.mtimeNs
      || before.ctimeNs !== expected.endpoint.ctimeNs) fail('worker_replacement_endpoint_changed')
    await probe(pathname)
    assertQuiescent()
    if (digest(directory(stateDir)) !== digest(expected.root)) fail('worker_replacement_endpoint_directory_changed')
    const after = socket(pathname)
    if (!after || digest(after) !== digest(before)) fail('worker_replacement_endpoint_changed')
    // O_EXCL closes the ordinary creation race across await probe(). Keep its
    // descriptor open and verify that rename replaces only our reservation.
    if (reservationFd === undefined) reservationFd = reserveClaim(claim, marker)
    verifyReservation(claim, reservationFd, marker)
    renameSync(pathname, claim)
    } finally { if (reservationFd !== undefined) closeSync(reservationFd) }
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
  return { retired: true, recoveredClaim, recoveredReservation, endpointSha256: digest(expected) }
}
