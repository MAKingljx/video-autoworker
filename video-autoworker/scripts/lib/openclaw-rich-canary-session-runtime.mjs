import { createRequire } from 'node:module'
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { delimiter, dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024
const PUBLIC_SESSION_RUNTIME_EXPORT = 'openclaw/plugin-sdk/session-store-runtime'

function fail(code) {
  throw new Error(`openclaw_rich_canary_session_runtime:${code}`)
}

function inside(root, pathname) {
  const candidate = relative(root, pathname)
  return candidate !== ''
    && candidate !== '..'
    && !candidate.startsWith(`..${sep}`)
    && !isAbsolute(candidate)
}

function readPackage(pathname) {
  const before = lstatSync(pathname)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size <= 0 || before.size > MAX_PACKAGE_JSON_BYTES
    || (before.mode & 0o022) !== 0 || realpathSync(pathname) !== pathname) {
    fail('package_identity_invalid')
  }
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor)
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      fail('package_changed')
    }
    return JSON.parse(readFileSync(descriptor, 'utf8'))
  } finally {
    closeSync(descriptor)
  }
}

function validateRuntime(runtime) {
  if (!runtime || typeof runtime !== 'object') fail('sdk_invalid')
  for (const name of [
    'formatSqliteSessionFileMarker',
    'getSessionEntry',
    'loadTranscriptEventsSync',
    'parseSqliteSessionFileMarker',
    'readTranscriptStatsSync',
    'resolveStorePath',
  ]) {
    if (typeof runtime[name] !== 'function') fail(`sdk_${name}_missing`)
  }
  return runtime
}

function resolveOpenClawEntry(openclawBin, pathEnv) {
  if (typeof openclawBin !== 'string' || !openclawBin.trim()) fail('arguments_invalid')
  const candidates = isAbsolute(openclawBin)
    ? [openclawBin]
    : (!openclawBin.includes('/') && !openclawBin.includes('\\'))
        ? String(pathEnv || '').split(delimiter)
          .filter(isAbsolute)
          .map(directory => resolve(directory, openclawBin))
        : []
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK)
      const entry = realpathSync(candidate)
      const metadata = lstatSync(entry)
      if (metadata.isFile() && (metadata.mode & 0o022) === 0) return entry
    } catch {
      // Try the next PATH entry.
    }
  }
  fail('openclaw_bin_unresolvable')
}

export async function loadOpenClawRichCanarySessionRuntime({
  openclawBin,
  expectedVersion,
  pathEnv = process.env.PATH,
}) {
  if (typeof expectedVersion !== 'string' || !/^2026\.9\.[0-9]+$/u.test(expectedVersion)) {
    fail('arguments_invalid')
  }
  const openclawEntry = resolveOpenClawEntry(openclawBin, pathEnv)
  const packageRoot = dirname(openclawEntry)
  const packagePath = resolve(packageRoot, 'package.json')
  const packageValue = readPackage(packagePath)
  if (packageValue?.name !== 'openclaw' || packageValue.version !== expectedVersion) {
    fail('package_version_invalid')
  }
  if (!Object.hasOwn(packageValue.exports || {}, './plugin-sdk/session-store-runtime')) {
    fail('public_export_missing')
  }
  const requireFromPackage = createRequire(packagePath)
  let modulePath
  try {
    modulePath = realpathSync(requireFromPackage.resolve(PUBLIC_SESSION_RUNTIME_EXPORT))
  } catch {
    fail('public_export_unresolvable')
  }
  if (!inside(packageRoot, modulePath)) fail('public_export_outside_package')
  const runtime = validateRuntime(await import(pathToFileURL(modulePath).href))
  return Object.freeze({
    openclawBin: openclawEntry,
    packageRoot,
    packageVersion: packageValue.version,
    modulePath,
    runtime,
  })
}

function validIdentity(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
}

function validStorePath(value) {
  return typeof value === 'string' && isAbsolute(value) && resolve(value) === value
}

export function captureOpenClawRichCanarySessionSnapshot(binding, {
  agentId,
  env,
  sessionKey,
}) {
  const runtime = validateRuntime(binding?.runtime)
  if (!validIdentity(agentId) || !validIdentity(sessionKey)) fail('session_identity_invalid')
  const storePath = runtime.resolveStorePath(undefined, { agentId, env })
  if (!validStorePath(storePath)) fail('session_store_path_invalid')
  const readParams = { agentId, env, readConsistency: 'latest', sessionKey, storePath }
  const entry = runtime.getSessionEntry(readParams)
  if (!entry || typeof entry !== 'object' || !validIdentity(entry.sessionId)) {
    fail('session_entry_missing')
  }
  const sessionFile = runtime.formatSqliteSessionFileMarker({
    agentId,
    sessionId: entry.sessionId,
    storePath,
  })
  const marker = runtime.parseSqliteSessionFileMarker(sessionFile)
  if (!marker || marker.agentId !== agentId || marker.sessionId !== entry.sessionId
    || !validStorePath(marker.storePath) || marker.storePath !== storePath) {
    fail('session_marker_invalid')
  }
  const transcriptParams = { ...readParams, sessionId: entry.sessionId }
  const events = runtime.loadTranscriptEventsSync(transcriptParams)
  const stats = runtime.readTranscriptStatsSync(transcriptParams)
  if (!Array.isArray(events) || events.some(event => (
    !event || typeof event !== 'object' || Array.isArray(event)
  ))) fail('transcript_events_invalid')
  if (!stats || !Number.isSafeInteger(stats.eventCount) || stats.eventCount !== events.length
    || !Number.isSafeInteger(stats.maxSeq) || stats.maxSeq < 0
    || !Number.isSafeInteger(stats.sizeBytes) || stats.sizeBytes < 0
    || (stats.eventCount > 0 && (stats.maxSeq <= 0 || stats.sizeBytes <= 0))) {
    fail('transcript_stats_invalid')
  }
  const identity = Object.freeze({
    agentId,
    sessionKey,
    sessionId: entry.sessionId,
    storePath: marker.storePath,
  })
  return Object.freeze({
    entry: Object.freeze({ ...entry }),
    events: Object.freeze([...events]),
    identity,
    marker: Object.freeze({ ...marker }),
    sessionFile,
    sizeBytes: stats.sizeBytes,
    stats: Object.freeze({ ...stats }),
  })
}

export function openClawSessionMarkerMatchesSnapshot(binding, value, snapshot) {
  const runtime = validateRuntime(binding?.runtime)
  if (typeof value !== 'string' || !snapshot?.marker) return false
  const marker = runtime.parseSqliteSessionFileMarker(value)
  return Boolean(marker
    && marker.agentId === snapshot.marker.agentId
    && marker.sessionId === snapshot.marker.sessionId
    && marker.storePath === snapshot.marker.storePath)
}

export function openClawSessionReferenceMatchesSnapshot(binding, value, snapshot) {
  if (typeof value !== 'string' || !snapshot?.identity) return false
  return value === snapshot.identity.sessionKey
    || openClawSessionMarkerMatchesSnapshot(binding, value, snapshot)
}

export function openClawCheckpointPostReferenceMatchesSnapshot(
  binding,
  value,
  snapshot,
  mode,
) {
  if (mode !== 'in-place' && mode !== 'generation-rotation') return false
  const identity = snapshot?.identity
  const marker = snapshot?.marker
  const sqliteBindingValid = Boolean(identity && marker
    && identity.agentId === marker.agentId
    && identity.sessionId === marker.sessionId
    && identity.storePath === marker.storePath
    && openClawSessionMarkerMatchesSnapshot(binding, snapshot.sessionFile, snapshot))
  if (!sqliteBindingValid) return false
  if (value !== undefined) {
    return openClawSessionReferenceMatchesSnapshot(binding, value, snapshot)
  }
  // OpenClaw 9.2 omits postCompaction.sessionFile after recognizing a SQLite
  // marker. The caller still binds its exact sessionId and active leaf, and
  // only an in-place checkpoint may use that omitted-reference form.
  if (mode !== 'in-place') return false
  return openClawSessionMarkerMatchesSnapshot(binding, snapshot?.sessionFile, snapshot)
}

export function openClawLinearActiveTranscriptEntryIds(events) {
  if (!Array.isArray(events) || events.length === 0) fail('transcript_events_invalid')
  const byId = new Map()
  const sessionHeaderIds = new Set()
  let leafId = null
  let appendParentId = null
  let sawTreeEntry = false
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      fail('transcript_events_invalid')
    }
    if (event.type === 'session') {
      if (sawTreeEntry || !validIdentity(event.id) || sessionHeaderIds.has(event.id)) {
        fail('transcript_branch_invalid')
      }
      sessionHeaderIds.add(event.id)
      continue
    }
    if (event.type === 'leaf') {
      const targetId = event.targetId
      const nextAppendParentId = event.appendParentId === undefined
        ? targetId
        : event.appendParentId
      if (!validIdentity(event.id) || byId.has(event.id)
        || (event.parentId !== null && !validIdentity(event.parentId))
        || (targetId !== null && (!validIdentity(targetId) || !byId.has(targetId)))
        || (nextAppendParentId !== null
          && (!validIdentity(nextAppendParentId) || !byId.has(nextAppendParentId)))
        || (event.appendMode !== undefined && event.appendMode !== 'side')) {
        fail('transcript_branch_invalid')
      }
      byId.set(event.id, {
        ...event,
        activeParentId: targetId,
        leafControl: true,
      })
      leafId = targetId
      appendParentId = nextAppendParentId
      sawTreeEntry = true
      continue
    }
    if (!validIdentity(event.id) || byId.has(event.id)) fail('transcript_branch_invalid')
    let parentId
    if (!Object.hasOwn(event, 'parentId')) {
      parentId = leafId
    } else {
      parentId = event.parentId
      if (parentId !== null && !validIdentity(parentId)) fail('transcript_branch_invalid')
      if (parentId !== null && sessionHeaderIds.has(parentId)) parentId = null
      while (parentId !== null && byId.get(parentId)?.leafControl === true) {
        parentId = byId.get(parentId).activeParentId
      }
      if (parentId !== null && !byId.has(parentId)) fail('transcript_branch_invalid')
      if (event.appendMode !== 'side' && parentId === appendParentId && leafId !== appendParentId) {
        parentId = leafId
      }
    }
    if (event.appendMode !== undefined && event.appendMode !== 'side') {
      fail('transcript_branch_invalid')
    }
    byId.set(event.id, { ...event, activeParentId: parentId, leafControl: false })
    appendParentId = event.id
    if (event.appendMode !== 'side') leafId = event.id
    sawTreeEntry = true
  }
  if (!sawTreeEntry || !leafId) fail('transcript_branch_missing')
  const activeIds = new Set()
  let currentId = leafId
  while (currentId !== null) {
    if (activeIds.has(currentId)) fail('transcript_branch_invalid')
    const event = byId.get(currentId)
    if (!event || event.leafControl) fail('transcript_branch_invalid')
    activeIds.add(event.id)
    currentId = event.activeParentId
  }
  return activeIds
}
