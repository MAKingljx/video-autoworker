import { createHash } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readFileSync,
  realpathSync,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'

const MAX_JSON_BYTES = 1024 * 1024

function fail(message) {
  throw new Error(`offline queue projection failed: ${message}`)
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]))
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value))
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function strictJson(source, label, maximumBytes = MAX_JSON_BYTES) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > maximumBytes) {
    fail(`${label} is too large`)
  }
  let index = 0
  const whitespace = () => { while (/\s/u.test(source[index] || '')) index += 1 }
  const stringValue = () => {
    const start = index
    index += 1
    let escaped = false
    while (index < source.length) {
      const character = source[index]
      index += 1
      if (escaped) { escaped = false; continue }
      if (character === '\\') { escaped = true; continue }
      if (character === '"') {
        try { return JSON.parse(source.slice(start, index)) } catch {
          fail(`${label} contains an invalid string`)
        }
      }
      if (character.charCodeAt(0) < 0x20) fail(`${label} contains an invalid control character`)
    }
    fail(`${label} contains an unterminated string`)
  }
  const value = () => {
    whitespace()
    const character = source[index]
    if (character === '"') return stringValue()
    if (character === '{') {
      index += 1
      whitespace()
      const output = {}
      const keys = new Set()
      if (source[index] === '}') { index += 1; return output }
      while (index < source.length) {
        whitespace()
        if (source[index] !== '"') fail(`${label} object key is invalid`)
        const key = stringValue()
        if (keys.has(key)) fail(`${label} contains a duplicate JSON key`)
        keys.add(key)
        whitespace()
        if (source[index] !== ':') fail(`${label} object separator is invalid`)
        index += 1
        output[key] = value()
        whitespace()
        if (source[index] === '}') { index += 1; return output }
        if (source[index] !== ',') fail(`${label} object delimiter is invalid`)
        index += 1
      }
      fail(`${label} object is unterminated`)
    }
    if (character === '[') {
      index += 1
      whitespace()
      const output = []
      if (source[index] === ']') { index += 1; return output }
      while (index < source.length) {
        output.push(value())
        whitespace()
        if (source[index] === ']') { index += 1; return output }
        if (source[index] !== ',') fail(`${label} array delimiter is invalid`)
        index += 1
      }
      fail(`${label} array is unterminated`)
    }
    const token = source.slice(index).match(
      /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u,
    )?.[0]
    if (!token) fail(`${label} value is invalid`)
    index += token.length
    if (token === 'true') return true
    if (token === 'false') return false
    if (token === 'null') return null
    const number = Number(token)
    if (!Number.isFinite(number)) fail(`${label} number is invalid`)
    return number
  }
  const parsed = value()
  whitespace()
  if (index !== source.length) fail(`${label} has trailing content`)
  return parsed
}

function assertAbsolute(pathname, label) {
  if (typeof pathname !== 'string' || !isAbsolute(pathname) || resolve(pathname) !== pathname
    || /[\u0000-\u001f\u007f]/u.test(pathname)) {
    fail(`${label} must be one normalized absolute path`)
  }
}

function assertNoSymlink(pathname, label) {
  assertAbsolute(pathname, label)
  const root = parse(pathname).root
  let current = root
  for (const part of relative(root, pathname).split('/').filter(Boolean)) {
    current = join(current, part)
    let entry
    try { entry = lstatSync(current, { bigint: true }) } catch {
      fail(`${label} path component is unavailable`)
    }
    if (entry.isSymbolicLink()) fail(`${label} path contains a symlink`)
  }
}

function safeEntry(pathname, label, kind, options = {}) {
  assertNoSymlink(pathname, label)
  const entry = lstatSync(pathname, { bigint: true })
  if (kind === 'file' && !entry.isFile()) fail(`${label} is not a regular file`)
  if (kind === 'directory' && !entry.isDirectory()) fail(`${label} is not a directory`)
  if (entry.uid !== BigInt(process.getuid())) fail(`${label} owner is invalid`)
  if (kind === 'file' && entry.nlink !== 1n) fail(`${label} link count is unsafe`)
  const mode = Number(entry.mode & 0o7777n)
  if (options.mode !== undefined ? mode !== options.mode : (mode & 0o022) !== 0) {
    fail(`${label} mode is unsafe`)
  }
  if (options.maximumBytes !== undefined && entry.size > BigInt(options.maximumBytes)) {
    fail(`${label} is too large`)
  }
  if (options.nonempty === true && entry.size === 0n) fail(`${label} is empty`)
  return entry
}

function readJsonRecord(pathname, label, options = {}) {
  const maximumBytes = options.maximumBytes ?? MAX_JSON_BYTES
  const entry = safeEntry(pathname, label, 'file', {
    mode: options.mode,
    maximumBytes,
    nonempty: true,
  })
  const descriptor = openSync(pathname, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    if (opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size
      || opened.nlink !== 1n) fail(`${label} changed before open`)
    const source = readFileSync(descriptor, 'utf8')
    const after = lstatSync(pathname, { bigint: true })
    if (Buffer.byteLength(source) !== Number(opened.size) || after.dev !== opened.dev
      || after.ino !== opened.ino || after.size !== opened.size || after.nlink !== 1n) {
      fail(`${label} changed during read`)
    }
    return {
      value: strictJson(source, label, maximumBytes),
      source,
      entry: after,
    }
  } finally {
    closeSync(descriptor)
  }
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    fail(`${label} contract is invalid`)
  }
}

function sameFileRecord(left, right) {
  return left.source === right.source
    && left.entry.dev === right.entry.dev
    && left.entry.ino === right.entry.ino
    && left.entry.uid === right.entry.uid
    && left.entry.mode === right.entry.mode
    && left.entry.nlink === right.entry.nlink
    && left.entry.size === right.entry.size
}

function entryProjection(entry, includeTimes = true) {
  const projection = {
    dev: entry.dev.toString(),
    ino: entry.ino.toString(),
    uid: entry.uid.toString(),
    mode: entry.mode.toString(),
    nlink: entry.nlink.toString(),
    size: entry.size.toString(),
  }
  if (includeTimes) {
    projection.mtimeNs = entry.mtimeNs.toString()
    projection.ctimeNs = entry.ctimeNs.toString()
  }
  return projection
}

function sameProjection(left, right) {
  return canonicalJson(left) === canonicalJson(right)
}

function directoryProjection(pathname, label, options = {}) {
  const entry = safeEntry(pathname, label, 'directory', options)
  if (realpathSync(pathname) !== pathname) fail(`${label} is not physical`)
  return entryProjection(entry)
}

function livePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function validateRuntimeGuardianPair(root, names) {
  const markerName = '.worker-launch.lock'
  const ownerName = '.worker-launch.lock.owner'
  const markerPresent = names.has(markerName)
  const ownerPresent = names.has(ownerName)
  if (markerPresent !== ownerPresent) fail('bootstrap resume video batch guardian pair is incomplete')
  if (!markerPresent) return null

  const markerPath = join(root, markerName)
  const ownerPath = join(root, ownerName)
  const loadPair = () => {
    const marker = readJsonRecord(markerPath, 'bootstrap resume video batch guardian marker', {
      mode: 0o600,
      maximumBytes: 16 * 1024,
    })
    const owner = readJsonRecord(ownerPath, 'bootstrap resume video batch guardian owner', {
      mode: 0o600,
      maximumBytes: 16 * 1024,
    })
    exactKeys(marker.value, ['createdAt', 'pid', 'schema', 'token'], 'bootstrap resume video batch guardian marker')
    exactKeys(owner.value, ['createdAt', 'marker', 'pid', 'schema'], 'bootstrap resume video batch guardian owner')
    exactKeys(
      owner.value.marker,
      ['createdAt', 'dev', 'ino', 'path', 'sourceSha256', 'tokenSha256'],
      'bootstrap resume video batch guardian owner marker',
    )
    const markerCreatedAt = Date.parse(marker.value.createdAt)
    const ownerCreatedAt = Date.parse(owner.value.createdAt)
    const token = marker.value.token
    const markerSha256 = sha256(marker.source)
    if (marker.value.schema !== 'video-autoworker-worker-launch-guardian/v2'
      || !Number.isSafeInteger(marker.value.pid) || marker.value.pid <= 0
      || typeof marker.value.createdAt !== 'string' || !Number.isFinite(markerCreatedAt)
      || typeof token !== 'string' || !/^[a-f0-9]{64}$/u.test(token)
      || owner.value.schema !== 'video-autoworker-worker-launch-guardian-owner/v1'
      || !Number.isSafeInteger(owner.value.pid) || owner.value.pid <= 0
      || typeof owner.value.createdAt !== 'string' || !Number.isFinite(ownerCreatedAt)
      || owner.value.marker.path !== markerPath
      || owner.value.marker.dev !== marker.entry.dev.toString()
      || owner.value.marker.ino !== marker.entry.ino.toString()
      || owner.value.marker.createdAt !== marker.value.createdAt
      || owner.value.marker.tokenSha256 !== sha256(token)
      || owner.value.marker.sourceSha256 !== markerSha256) {
      fail('bootstrap resume video batch guardian pair contract is invalid')
    }
    return { marker, owner }
  }

  const first = loadPair()
  const second = loadPair()
  const markerMtimeMilliseconds = Number(second.marker.entry.mtimeNs / 1_000_000n)
  if (!sameFileRecord(first.marker, second.marker)
    || !sameFileRecord(first.owner, second.owner)
    || second.marker.entry.mtimeNs < first.marker.entry.mtimeNs
    || !livePid(second.owner.value.pid)
    || Math.abs(Date.now() - markerMtimeMilliseconds) > 15_000) {
    fail('bootstrap resume video batch guardian pair is stale or changed')
  }
  return second
}

function finalGuardianProjection(root, expected) {
  const markerPath = join(root, '.worker-launch.lock')
  const ownerPath = join(root, '.worker-launch.lock.owner')
  if (!expected) {
    for (const pathname of [markerPath, ownerPath]) {
      try {
        lstatSync(pathname, { bigint: true })
        fail('bootstrap resume video batch guardian appeared after projection')
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    }
    return
  }

  const marker = readJsonRecord(markerPath, 'bootstrap resume video batch final guardian marker', {
    mode: 0o600,
    maximumBytes: 16 * 1024,
  })
  const owner = readJsonRecord(ownerPath, 'bootstrap resume video batch final guardian owner', {
    mode: 0o600,
    maximumBytes: 16 * 1024,
  })
  if (!sameFileRecord(expected.marker, marker) || !sameFileRecord(expected.owner, owner)) {
    fail('bootstrap resume video batch guardian changed after projection')
  }
  const finalMarker = lstatSync(markerPath, { bigint: true })
  const finalOwner = lstatSync(ownerPath, { bigint: true })
  if (!sameProjection(entryProjection(marker.entry, false), entryProjection(finalMarker, false))
    || !sameProjection(entryProjection(owner.entry, false), entryProjection(finalOwner, false))) {
    fail('bootstrap resume video batch guardian identity changed after final read')
  }
}

export function projectOfflineQueue(rows, durableItems, now) {
  if (!Number.isSafeInteger(now) || now <= 0 || !Array.isArray(rows) || !Array.isArray(durableItems)) {
    fail('bootstrap resume queue projection input is invalid')
  }
  const durable = new Map(durableItems.map(item => [item.taskId, item]))
  const projection = new Map(durable)
  for (const row of rows) {
    const durableItem = durable.get(row.taskId)
    const stale = !durableItem && ['queued', 'accepted', 'running'].includes(row.status)
      && now - Number(row.updatedAt || 0) >= 24 * 60 * 60
    if (stale) {
      projection.set(row.taskId, { taskId: row.taskId, status: row.status, origin: 'attention-stale' })
    } else {
      projection.set(row.taskId, {
        taskId: row.taskId,
        status: durableItem?.status || row.status,
        origin: durableItem ? 'durable+n8n' : 'n8n',
      })
    }
  }
  const values = [...projection.values()].sort((left, right) => left.taskId.localeCompare(right.taskId))
  return {
    values,
    digest: sha256(canonicalJson(values)),
    waiting: values.filter(item => item.origin !== 'attention-stale'
      && ['queued', 'staging', 'submitted', 'accepted', 'waiting', 'recovering', 'paused']
        .includes(item.status)).length,
    running: values.filter(item => item.origin !== 'attention-stale' && item.status === 'running').length,
  }
}

export function scanOfflineDurableBatchStates(batchRoot) {
  const root = resolve(batchRoot)
  assertNoSymlink(root, 'bootstrap resume video batch root')
  const rootEntry = safeEntry(root, 'bootstrap resume video batch root', 'directory')
  if (realpathSync(root) !== root) fail('bootstrap resume video batch root is not physical')
  if ((Number(rootEntry.mode & 0o7777n) & 0o077) !== 0) {
    fail('bootstrap resume video batch root is not owner-private')
  }
  const maximumStateFiles = 2_000
  const maximumDirectoryEntries = maximumStateFiles * 3
  const maximumStateBytes = 8 * 1024 * 1024
  const maximumTotalStateBytes = 512 * 1024 * 1024
  const maximumItems = 20_000
  const primaryPattern = /^[a-f0-9]{64}\.json$/u
  const backupPattern = /^[a-f0-9]{64}\.json\.bak$/u
  const activeStatuses = new Set([
    'queued', 'staging', 'submitted', 'accepted', 'running', 'waiting', 'recovering', 'paused',
  ])
  const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'attention'])
  const batchStatuses = new Set([
    ...activeStatuses, 'succeeded', 'completed_with_errors', 'failed', 'cancelled', 'attention',
  ])

  const takeSample = () => {
    const rootBefore = directoryProjection(root, 'bootstrap resume video batch root')
    const primary = []
    const backups = []
    const histories = []
    const names = new Set()
    const rootEntries = []
    let seenEntries = 0
    const directory = opendirSync(root)
    try {
      for (;;) {
        const entry = directory.readSync()
        if (!entry) break
        seenEntries += 1
        if (seenEntries > maximumDirectoryEntries) {
          fail('bootstrap resume video batch directory exceeds the bounded entry limit')
        }
        names.add(entry.name)
        const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other'
        rootEntries.push({ name: entry.name, kind })
        if (entry.name === '.worker-launch.lock' || entry.name === '.worker-launch.lock.owner') continue
        if (entry.isFile() && primaryPattern.test(entry.name)) primary.push(join(root, entry.name))
        else if (entry.isFile() && backupPattern.test(entry.name)) backups.push(join(root, entry.name))
        else if (entry.isDirectory()) histories.push(join(root, entry.name))
        else fail('bootstrap resume video batch directory contains an unrecognized artifact')
      }
    } finally {
      directory.closeSync()
    }
    const guardian = validateRuntimeGuardianPair(root, names)

    const historyFiles = []
    const historyProjections = []
    for (const historyPath of histories.sort()) {
      const historyBefore = directoryProjection(
        historyPath, 'bootstrap resume video batch terminal history', { mode: 0o700 },
      )
      const historyEntries = []
      const historyDirectory = opendirSync(historyPath)
      try {
        for (;;) {
          const entry = historyDirectory.readSync()
          if (!entry) break
          seenEntries += 1
          if (seenEntries > maximumDirectoryEntries) {
            fail('bootstrap resume video batch directory exceeds the bounded entry limit')
          }
          const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : 'other'
          historyEntries.push({ name: entry.name, kind })
          if (!entry.isFile() || (!primaryPattern.test(entry.name) && !backupPattern.test(entry.name))) {
            fail('bootstrap resume video batch terminal history contains an unrecognized artifact')
          }
        }
      } finally {
        historyDirectory.closeSync()
      }
      if (historyEntries.length === 0) fail('bootstrap resume video batch terminal history is empty')
      const historyNameSet = new Set(historyEntries.map(entry => entry.name))
      for (const { name } of historyEntries) {
        if (primaryPattern.test(name) && !historyNameSet.has(`${name}.bak`)) {
          fail('bootstrap resume video batch terminal history primary has no backup')
        }
        if (backupPattern.test(name) && !historyNameSet.has(name.slice(0, -4))) {
          fail('bootstrap resume video batch terminal history backup has no primary')
        }
        historyFiles.push({
          pathname: join(historyPath, name),
          primary: primaryPattern.test(name),
        })
      }
      historyProjections.push({
        pathname: relative(root, historyPath),
        identity: historyBefore,
        entries: historyEntries.sort((left, right) => left.name.localeCompare(right.name)),
      })
    }

    const historyPrimaryCount = historyFiles.filter(item => item.primary).length
    if (primary.length + historyPrimaryCount > maximumStateFiles) {
      fail('bootstrap resume video batch state count exceeds the bounded limit')
    }
    const primarySet = new Set(primary)
    for (const pathname of backups) {
      if (!primarySet.has(pathname.slice(0, -4))) {
        fail('bootstrap resume video batch backup has no authoritative primary')
      }
    }

    const durable = new Map()
    const fileProjections = []
    let visited = 0
    let totalBytes = 0
    const readState = (pathname, terminalHistoryPrimary = false) => {
      const record = readJsonRecord(pathname, 'bootstrap resume video batch state', {
        maximumBytes: maximumStateBytes,
      })
      totalBytes += Number(record.entry.size)
      if (totalBytes > maximumTotalStateBytes) {
        fail('bootstrap resume video batch states exceed the bounded byte limit')
      }
      fileProjections.push({
        pathname: relative(root, pathname),
        identity: entryProjection(record.entry),
        sourceSha256: sha256(record.source),
      })
      const state = record.value
      if (![1, 2].includes(state?.schemaVersion) || !Array.isArray(state.items)
        || typeof state.status !== 'string' || !batchStatuses.has(state.status)) {
        fail('bootstrap resume video batch state contract is invalid')
      }
      let activeItems = 0
      const active = []
      for (const item of state.items) {
        visited += 1
        if (visited > maximumItems) {
          fail('bootstrap resume video batch items exceed the bounded limit')
        }
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          fail('bootstrap resume video batch item contract is invalid')
        }
        const taskId = typeof item.taskId === 'string' ? item.taskId.trim() : ''
        const itemStatus = typeof item.status === 'string' ? item.status : ''
        if (!/^[A-Za-z0-9._:-]{1,120}$/u.test(taskId)
          || (!activeStatuses.has(itemStatus) && !terminalStatuses.has(itemStatus))) {
          fail('bootstrap resume video batch item contract is invalid')
        }
        let status = itemStatus
        if (state.status === 'paused' && !['submitted', 'accepted', 'running'].includes(status)
          && !terminalStatuses.has(status)) status = 'paused'
        else if (state.status === 'recovering' && status === 'queued') status = 'recovering'
        if (!activeStatuses.has(status)) continue
        activeItems += 1
        active.push({ taskId, status, origin: 'durable' })
      }
      if (activeStatuses.has(state.status) && activeItems === 0) {
        const batchId = typeof state.batchId === 'string' ? state.batchId.trim() : ''
        if (!/^[A-Za-z0-9._:-]{1,80}$/u.test(batchId)) {
          fail('bootstrap resume active video batch has no valid durable identity')
        }
        const taskId = `batch:${batchId}`
        active.push({
          taskId,
          status: state.status === 'running' ? 'running' : 'waiting',
          origin: 'durable-batch',
        })
      }
      if (terminalHistoryPrimary && active.length > 0) {
        fail('bootstrap resume video batch terminal history contains an active primary')
      }
      return active
    }

    for (const pathname of primary.sort()) {
      for (const item of readState(pathname)) {
        if (durable.has(item.taskId)) fail('bootstrap resume video batch task identity is duplicated')
        durable.set(item.taskId, item)
      }
    }
    for (const pathname of backups.sort()) readState(pathname)
    for (const item of historyFiles.sort((left, right) => left.pathname.localeCompare(right.pathname))) {
      readState(item.pathname, item.primary)
    }

    for (const history of historyProjections) {
      const after = directoryProjection(
        join(root, history.pathname), 'bootstrap resume video batch terminal history', { mode: 0o700 },
      )
      if (!sameProjection(history.identity, after)) {
        fail('bootstrap resume video batch terminal history changed during projection')
      }
    }
    const rootAfter = directoryProjection(root, 'bootstrap resume video batch root')
    if (!sameProjection(rootBefore, rootAfter)) {
      fail('bootstrap resume video batch root changed during projection')
    }
    return {
      durable: [...durable.values()],
      guardian,
      projection: {
        root: rootAfter,
        entries: rootEntries.sort((left, right) => left.name.localeCompare(right.name)),
        histories: historyProjections,
        files: fileProjections.sort((left, right) => left.pathname.localeCompare(right.pathname)),
        guardian: guardian ? {
          marker: {
            identity: entryProjection(guardian.marker.entry, false),
            sourceSha256: sha256(guardian.marker.source),
          },
          owner: {
            identity: entryProjection(guardian.owner.entry, false),
            sourceSha256: sha256(guardian.owner.source),
          },
        } : null,
      },
    }
  }

  const first = takeSample()
  const second = takeSample()
  if (!sameProjection(first.projection, second.projection)) {
    fail('bootstrap resume video batch directory or file projection changed between samples')
  }
  finalGuardianProjection(root, second.guardian)
  return second.durable
}
