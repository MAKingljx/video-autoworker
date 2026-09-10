import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

export const WORKER_LAUNCH_GUARDIAN_SCHEMA = 'video-autoworker-worker-launch-guardian/v2'
export const WORKER_LAUNCH_AUTHORIZATION_SCHEMA = 'video-autoworker-worker-launch-authorization/v1'

const MAX_CONTROL_FILE_BYTES = 1024 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const TOKEN_PATTERN = /^[a-f0-9]{64}$/u

function fail(message, code) {
  const error = new Error(message)
  if (code) error.code = code
  throw error
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    fail(`${label}字段无效`)
  }
}

function safeNumber(value, label) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 0) fail(`${label}超出安全范围`)
  return number
}

function identity(pathname, stat) {
  return {
    path: resolve(pathname),
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    uid: Number(stat.uid),
    mode: Number(stat.mode & 0o7777n),
    nlink: safeNumber(stat.nlink, '控制文件链接数'),
    size: safeNumber(stat.size, '控制文件大小'),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
  }
}

function sameIdentity(left, right) {
  return left.path === right.path
    && left.dev === right.dev
    && left.ino === right.ino
    && left.uid === right.uid
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
}

function assertPrivateParent(pathname) {
  const parent = lstatSync(dirname(pathname), { bigint: true })
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || Number(parent.mode & 0o7777n) !== 0o700
    || (typeof process.getuid === 'function' && Number(parent.uid) !== process.getuid())) {
    fail('视频队列启动授权目录身份无效')
  }
}

function readStableFile(pathname, {
  label,
  mode,
  maxBytes = MAX_CONTROL_FILE_BYTES,
  missingCode,
  expectedNlink = 1n,
} = {}) {
  let entry
  try {
    entry = lstatSync(pathname, { bigint: true })
  } catch (error) {
    if (error?.code === 'ENOENT' && missingCode) fail(`${label}尚未生成`, missingCode)
    throw error
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== expectedNlink
    || Number(entry.mode & 0o7777n) !== mode
    || entry.size <= 0n || entry.size > BigInt(maxBytes)
    || (typeof process.getuid === 'function' && Number(entry.uid) !== process.getuid())) {
    fail(`${label}身份无效`)
  }
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    const before = identity(pathname, entry)
    const openedIdentity = identity(pathname, opened)
    if (!sameIdentity(before, openedIdentity)) fail(`${label}在读取前已变化`)
    const source = readFileSync(descriptor, 'utf8')
    const after = identity(pathname, fstatSync(descriptor, { bigint: true }))
    if (!sameIdentity(openedIdentity, after) || Buffer.byteLength(source) !== after.size) {
      fail(`${label}在读取时已变化`)
    }
    return { identity: after, source, sha256: sha256(source) }
  } finally {
    closeSync(descriptor)
  }
}

function parseJson(loaded, label) {
  try { return JSON.parse(loaded.source) } catch { fail(`${label}不是有效 JSON`) }
}

function readGuardian(pathname) {
  const loaded = readStableFile(pathname, {
    label: '视频队列 guardian marker',
    mode: 0o600,
    maxBytes: 4096,
  })
  const value = parseJson(loaded, '视频队列 guardian marker')
  exactKeys(value, ['schema', 'pid', 'token', 'createdAt'], '视频队列 guardian marker')
  if (value.schema !== WORKER_LAUNCH_GUARDIAN_SCHEMA
    || !Number.isSafeInteger(value.pid) || value.pid <= 0
    || !TOKEN_PATTERN.test(value.token)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    fail('视频队列 guardian marker 内容无效')
  }
  return {
    ...loaded,
    value,
    reference: {
      ...loaded.identity,
      sourceSha256: loaded.sha256,
      tokenSha256: sha256(value.token),
      createdAt: value.createdAt,
    },
  }
}

function readGlobalLock(pathname, workerPid) {
  const loaded = readStableFile(pathname, {
    label: '视频队列全局锁',
    mode: 0o600,
    maxBytes: 4096,
  })
  const value = parseJson(loaded, '视频队列全局锁')
  exactKeys(value, ['pid', 'token', 'createdAt'], '视频队列全局锁')
  if (value.pid !== workerPid || !UUID_PATTERN.test(value.token)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    fail('视频队列全局锁不属于目标 worker')
  }
  return {
    ...loaded,
    value,
    reference: {
      ...loaded.identity,
      sourceSha256: loaded.sha256,
      tokenSha256: sha256(value.token),
      createdAt: value.createdAt,
    },
  }
}

function readFinalReadiness(pathname) {
  const loaded = readStableFile(resolve(pathname), {
    label: 'final readiness 报告',
    mode: 0o400,
  })
  parseJson(loaded, 'final readiness 报告')
  return { ...loaded.identity, sha256: loaded.sha256 }
}

function authorizationPaths(batchRoot) {
  const root = resolve(batchRoot)
  const markerPath = join(root, '.worker-launch.lock')
  return {
    root,
    markerPath,
    authorizationPath: `${markerPath}.authorization`,
    authorizationPendingPath: `${markerPath}.authorization.pending`,
    claimPath: `${markerPath}.authorization.claim`,
    globalLockPath: join(root, '.global-video-worker.lock'),
  }
}

export function workerLaunchAuthorizationPath(batchRoot) {
  return authorizationPaths(batchRoot).authorizationPath
}

export function workerLaunchAuthorizationClaimPath(batchRoot) {
  return authorizationPaths(batchRoot).claimPath
}

function expectedAuthorization({ workerPid, marker, globalLock, finalReadiness, issuedAt }) {
  return {
    schema: WORKER_LAUNCH_AUTHORIZATION_SCHEMA,
    issuedAt,
    workerPid,
    marker: marker.reference,
    globalLock: globalLock.reference,
    finalReadiness,
  }
}

function validateReference(value, label, { shaKey = 'sourceSha256', createdAt = true } = {}) {
  const keys = ['path', 'dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs', shaKey]
  if (createdAt) keys.push('tokenSha256', 'createdAt')
  exactKeys(value, keys, label)
  if (typeof value.path !== 'string' || resolve(value.path) !== value.path
    || !/^\d+$/u.test(value.dev) || !/^\d+$/u.test(value.ino)
    || !Number.isSafeInteger(value.uid) || value.uid < 0
    || !Number.isSafeInteger(value.mode) || !Number.isSafeInteger(value.nlink)
    || !Number.isSafeInteger(value.size) || value.size <= 0
    || !/^\d+$/u.test(value.mtimeNs) || !/^\d+$/u.test(value.ctimeNs)
    || !TOKEN_PATTERN.test(value[shaKey])) fail(`${label}身份引用无效`)
  if (createdAt && (!TOKEN_PATTERN.test(value.tokenSha256)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)))) {
    fail(`${label}内容引用无效`)
  }
}

function readAuthorization(pathname, missingCode, {
  label = '视频队列启动授权',
  expectedNlink = 1n,
} = {}) {
  const loaded = readStableFile(pathname, {
    label,
    mode: 0o600,
    missingCode,
    expectedNlink,
  })
  const value = parseJson(loaded, label)
  exactKeys(value, ['schema', 'issuedAt', 'workerPid', 'marker', 'globalLock', 'finalReadiness'], label)
  if (value.schema !== WORKER_LAUNCH_AUTHORIZATION_SCHEMA
    || typeof value.issuedAt !== 'string' || !Number.isFinite(Date.parse(value.issuedAt))
    || !Number.isSafeInteger(value.workerPid) || value.workerPid <= 0) {
    fail(`${label}内容无效`)
  }
  validateReference(value.marker, '视频队列启动授权 marker')
  validateReference(value.globalLock, '视频队列启动授权全局锁')
  validateReference(value.finalReadiness, '视频队列启动授权 final readiness', {
    shaKey: 'sha256',
    createdAt: false,
  })
  return { ...loaded, value }
}

function sameReference(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertAuthorizationBindings(authorization, { workerPid, marker, globalLock, finalReadiness }) {
  if (authorization.value.workerPid !== workerPid
    || !sameReference(authorization.value.marker, marker.reference)
    || !sameReference(authorization.value.globalLock, globalLock.reference)
    || !sameReference(authorization.value.finalReadiness, finalReadiness)) {
    fail('视频队列启动授权与 marker、worker、全局锁或 final readiness 不匹配')
  }
}

function fsyncParent(pathname) {
  const descriptor = openSync(dirname(pathname), constants.O_RDONLY | constants.O_DIRECTORY)
  try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
}

function optionalEntry(pathname) {
  try { return lstatSync(pathname, { bigint: true }) } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function removeExactControlFile(pathname, expected, label, options = {}) {
  const current = readAuthorization(pathname, undefined, { label, ...options })
  if (!sameIdentity(current.identity, expected.identity) || current.sha256 !== expected.sha256) {
    fail(`${label}在清理前发生漂移`)
  }
  unlinkSync(pathname)
  fsyncParent(pathname)
}

function repairAuthorizationPublication(paths) {
  const authorizationEntry = optionalEntry(paths.authorizationPath)
  const pendingEntry = optionalEntry(paths.authorizationPendingPath)
  if (!authorizationEntry || !pendingEntry) return
  if (!authorizationEntry.isFile() || authorizationEntry.isSymbolicLink()
    || !pendingEntry.isFile() || pendingEntry.isSymbolicLink()
    || authorizationEntry.dev !== pendingEntry.dev || authorizationEntry.ino !== pendingEntry.ino
    || authorizationEntry.nlink !== 2n || pendingEntry.nlink !== 2n) {
    fail('视频队列启动授权发布状态冲突')
  }
  const published = readAuthorization(paths.authorizationPath, undefined, {
    label: '视频队列已发布启动授权',
    expectedNlink: 2n,
  })
  const pending = readAuthorization(paths.authorizationPendingPath, undefined, {
    label: '视频队列待发布启动授权',
    expectedNlink: 2n,
  })
  if (published.sha256 !== pending.sha256) fail('视频队列启动授权发布副本不一致')
  unlinkSync(paths.authorizationPendingPath)
  fsyncParent(paths.authorizationPendingPath)
}

function repairClaimPublication(paths) {
  const authorizationEntry = optionalEntry(paths.authorizationPath)
  const claimEntry = optionalEntry(paths.claimPath)
  if (!authorizationEntry || !claimEntry) return
  if (!authorizationEntry.isFile() || authorizationEntry.isSymbolicLink()
    || !claimEntry.isFile() || claimEntry.isSymbolicLink()
    || authorizationEntry.dev !== claimEntry.dev || authorizationEntry.ino !== claimEntry.ino
    || authorizationEntry.nlink !== 2n || claimEntry.nlink !== 2n) {
    fail('视频队列启动授权与 claim 状态冲突')
  }
  const authorization = readAuthorization(paths.authorizationPath, undefined, { expectedNlink: 2n })
  const claim = readAuthorization(paths.claimPath, undefined, {
    label: '视频队列启动授权 claim', expectedNlink: 2n,
  })
  if (authorization.sha256 !== claim.sha256) fail('视频队列启动授权与 claim 内容不一致')
  unlinkSync(paths.authorizationPath)
  fsyncParent(paths.authorizationPath)
}

function inspectPending(paths) {
  const entry = optionalEntry(paths.authorizationPendingPath)
  if (!entry) return null
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n
    || Number(entry.mode & 0o7777n) !== 0o600
    || entry.size < 0n || entry.size > BigInt(MAX_CONTROL_FILE_BYTES)
    || (typeof process.getuid === 'function' && Number(entry.uid) !== process.getuid())) {
    fail('视频队列待发布启动授权状态无效')
  }
  return entry
}

function discardIncompletePending(paths) {
  const entry = inspectPending(paths)
  if (!entry) return
  if (optionalEntry(paths.authorizationPath) || optionalEntry(paths.claimPath)) {
    fail('视频队列待发布启动授权状态冲突')
  }
  const descriptor = openSync(paths.authorizationPendingPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size
      || opened.nlink !== entry.nlink || opened.mode !== entry.mode) {
      fail('视频队列待发布启动授权在清理前发生漂移')
    }
  } finally { closeSync(descriptor) }
  unlinkSync(paths.authorizationPendingPath)
  fsyncParent(paths.authorizationPendingPath)
}

function publishAuthorization(paths, source) {
  let descriptor
  try {
    descriptor = openSync(
      paths.authorizationPendingPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    )
    writeFileSync(descriptor, source)
    fsyncSync(descriptor)
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
  fsyncParent(paths.authorizationPendingPath)
  if (process.env.NODE_ENV === 'test'
    && process.env.AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_AFTER_PENDING_FSYNC === '1') {
    process.kill(process.pid, 'SIGKILL')
  }
  linkSync(paths.authorizationPendingPath, paths.authorizationPath)
  fsyncParent(paths.authorizationPath)
  if (process.env.NODE_ENV === 'test'
    && process.env.AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_AFTER_PUBLISH === '1') {
    process.kill(process.pid, 'SIGKILL')
  }
  unlinkSync(paths.authorizationPendingPath)
  fsyncParent(paths.authorizationPendingPath)
}

export function issueWorkerLaunchAuthorizationSync({ batchRoot, workerPid, finalReadinessPath }) {
  // This is deliberately a narrow publication primitive. The caller remains
  // responsible for proving that workerPid is the expected LaunchAgent and
  // that the referenced final-readiness report passed its domain verifiers.
  if (!Number.isSafeInteger(workerPid) || workerPid <= 0) fail('目标 worker PID 无效')
  const paths = authorizationPaths(batchRoot)
  assertPrivateParent(paths.authorizationPath)
  repairAuthorizationPublication(paths)
  repairClaimPublication(paths)
  if (optionalEntry(paths.claimPath)) {
    fail('视频队列启动授权已经被 worker 领取', 'EWORKERLAUNCHAUTHCLAIMED')
  }
  const marker = readGuardian(paths.markerPath)
  const globalLock = readGlobalLock(paths.globalLockPath, workerPid)
  const finalReadiness = readFinalReadiness(finalReadinessPath)
  if (optionalEntry(paths.authorizationPath)) {
    const existing = readAuthorization(paths.authorizationPath)
    assertAuthorizationBindings(existing, { workerPid, marker, globalLock, finalReadiness })
    return {
      path: paths.authorizationPath,
      ...existing.identity,
      sha256: existing.sha256,
      value: existing.value,
    }
  }
  // A killed publisher can leave only its owner-private temporary inode. The
  // shared deployment lock proves that no former controller is still writing;
  // remove that exact unlinked publication attempt before creating this grant.
  discardIncompletePending(paths)
  const issuedAt = new Date().toISOString()
  const value = expectedAuthorization({ workerPid, marker, globalLock, finalReadiness, issuedAt })
  const source = `${JSON.stringify(value)}\n`
  try {
    publishAuthorization(paths, source)
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    repairAuthorizationPublication(paths)
    const existing = readAuthorization(paths.authorizationPath)
    assertAuthorizationBindings(existing, { workerPid, marker, globalLock, finalReadiness })
    return {
      path: paths.authorizationPath,
      ...existing.identity,
      sha256: existing.sha256,
      value: existing.value,
    }
  }
  const written = readAuthorization(paths.authorizationPath)
  if (written.source !== source) fail('视频队列启动授权写后校验失败')
  assertAuthorizationBindings(written, { workerPid, marker, globalLock, finalReadiness })
  return {
    path: paths.authorizationPath,
    ...written.identity,
    sha256: written.sha256,
    value: written.value,
  }
}

export function verifyWorkerLaunchAuthorizationSync({ batchRoot, workerPid, finalReadinessPath }) {
  if (!Number.isSafeInteger(workerPid) || workerPid <= 0) fail('目标 worker PID 无效')
  const paths = authorizationPaths(batchRoot)
  assertPrivateParent(paths.authorizationPath)
  repairAuthorizationPublication(paths)
  repairClaimPublication(paths)
  if (optionalEntry(paths.claimPath)) fail('视频队列启动授权已经被 worker 领取')
  const marker = readGuardian(paths.markerPath)
  const globalLock = readGlobalLock(paths.globalLockPath, workerPid)
  const authorization = readAuthorization(paths.authorizationPath)
  const finalReadiness = readFinalReadiness(finalReadinessPath || authorization.value.finalReadiness.path)
  assertAuthorizationBindings(authorization, { workerPid, marker, globalLock, finalReadiness })
  return {
    path: paths.authorizationPath,
    ...authorization.identity,
    sha256: authorization.sha256,
    value: authorization.value,
  }
}

export function consumeWorkerLaunchAuthorizationSync({ batchRoot, workerPid = process.pid }) {
  if (!Number.isSafeInteger(workerPid) || workerPid <= 0) fail('当前 worker PID 无效')
  const paths = authorizationPaths(batchRoot)
  assertPrivateParent(paths.authorizationPath)
  const marker = readGuardian(paths.markerPath)
  const globalLock = readGlobalLock(paths.globalLockPath, workerPid)
  repairAuthorizationPublication(paths)
  repairClaimPublication(paths)
  let authorization
  const existingClaim = optionalEntry(paths.claimPath)
  if (existingClaim) {
    authorization = readAuthorization(paths.claimPath, undefined, { label: '视频队列启动授权 claim' })
  } else {
    authorization = readAuthorization(paths.authorizationPath, 'EWORKERLAUNCHAUTHPENDING')
  }
  const finalReadiness = readFinalReadiness(authorization.value.finalReadiness.path)
  assertAuthorizationBindings(authorization, { workerPid, marker, globalLock, finalReadiness })

  // Repeat every path/descriptor-bound read immediately before the irreversible
  // marker unlink. No queue work is admitted before this complete comparison.
  const finalMarker = readGuardian(paths.markerPath)
  const finalGlobalLock = readGlobalLock(paths.globalLockPath, workerPid)
  const finalAuthorization = existingClaim
    ? readAuthorization(paths.claimPath, undefined, { label: '视频队列启动授权 claim' })
    : readAuthorization(paths.authorizationPath)
  const finalReadinessAgain = readFinalReadiness(authorization.value.finalReadiness.path)
  if (!sameReference(finalMarker.reference, marker.reference)
    || !sameReference(finalGlobalLock.reference, globalLock.reference)
    || !sameIdentity(finalAuthorization.identity, authorization.identity)
    || finalAuthorization.sha256 !== authorization.sha256
    || !sameReference(finalReadinessAgain, finalReadiness)) {
    fail('视频队列启动授权在消费前发生漂移')
  }
  assertAuthorizationBindings(finalAuthorization, {
    workerPid,
    marker: finalMarker,
    globalLock: finalGlobalLock,
    finalReadiness: finalReadinessAgain,
  })

  if (!existingClaim) {
    if (process.env.NODE_ENV === 'test'
      && process.env.AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_BEFORE_CLAIM === '1') {
      process.kill(process.pid, 'SIGKILL')
    }
    // link(2) publishes the claim without overwriting an existing claimant.
    // The short auth+claim twin state is recoverable because both paths bind
    // the same inode; no controller may issue another grant while either is live.
    linkSync(paths.authorizationPath, paths.claimPath)
    fsyncParent(paths.claimPath)
    if (process.env.NODE_ENV === 'test'
      && process.env.AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_AFTER_CLAIM_PUBLISHED === '1') {
      process.kill(process.pid, 'SIGKILL')
    }
    unlinkSync(paths.authorizationPath)
    fsyncParent(paths.authorizationPath)
  }
  if (process.env.NODE_ENV === 'test'
    && process.env.AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_AFTER_CLAIM === '1') {
    process.kill(process.pid, 'SIGKILL')
  }
  const claim = readAuthorization(paths.claimPath, undefined, { label: '视频队列启动授权 claim' })
  if (claim.sha256 !== authorization.sha256) fail('视频队列启动授权 claim 内容发生漂移')
  const claimedMarker = readGuardian(paths.markerPath)
  const claimedGlobalLock = readGlobalLock(paths.globalLockPath, workerPid)
  const claimedFinalReadiness = readFinalReadiness(authorization.value.finalReadiness.path)
  if (!sameReference(claimedMarker.reference, finalMarker.reference)
    || !sameReference(claimedGlobalLock.reference, finalGlobalLock.reference)
    || !sameReference(claimedFinalReadiness, finalReadinessAgain)) {
    fail('视频队列启动授权在领取后发生漂移')
  }
  unlinkSync(paths.markerPath)
  fsyncParent(paths.markerPath)
  if (process.env.NODE_ENV === 'test'
    && process.env.AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_AFTER_MARKER_REMOVED === '1') {
    process.kill(process.pid, 'SIGKILL')
  }
  removeExactControlFile(paths.claimPath, claim, '视频队列启动授权 claim')
  if (process.env.NODE_ENV === 'test'
    && process.env.AIWORKER_TEST_WORKER_LAUNCH_AUTHORIZATION_KILL_AFTER_CLAIM_REMOVED === '1') {
    process.kill(process.pid, 'SIGKILL')
  }
  return {
    consumed: true,
    authorizationSha256: authorization.sha256,
    finalReadiness: finalReadinessAgain,
  }
}

export function inspectWorkerLaunchAuthorizationStateSync({ batchRoot }) {
  const paths = authorizationPaths(batchRoot)
  assertPrivateParent(paths.authorizationPath)
  repairAuthorizationPublication(paths)
  repairClaimPublication(paths)
  const load = (pathname, label) => optionalEntry(pathname)
    ? readAuthorization(pathname, undefined, { label })
    : null
  return {
    paths,
    authorization: load(paths.authorizationPath, '视频队列启动授权'),
    claim: load(paths.claimPath, '视频队列启动授权 claim'),
    pending: inspectPending(paths),
  }
}

export function removeWorkerLaunchAuthorizationArtifactSync({ batchRoot, kind, expected }) {
  const paths = authorizationPaths(batchRoot)
  const pathname = kind === 'claim' ? paths.claimPath
    : kind === 'authorization' ? paths.authorizationPath
      : fail('视频队列启动授权清理类型无效')
  const label = kind === 'claim' ? '视频队列启动授权 claim' : '视频队列启动授权'
  removeExactControlFile(pathname, expected, label)
}
