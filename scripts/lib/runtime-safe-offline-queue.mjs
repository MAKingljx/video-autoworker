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

function readJson(pathname, label, options = {}) {
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
    return strictJson(source, label, maximumBytes)
  } finally {
    closeSync(descriptor)
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
  const primary = []
  const backups = new Set()
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
      if (!entry.isFile()) fail('bootstrap resume video batch directory contains a non-file artifact')
      if (primaryPattern.test(entry.name)) primary.push(entry.name)
      else if (backupPattern.test(entry.name)) backups.add(entry.name.slice(0, -4))
      else fail('bootstrap resume video batch directory contains an unrecognized artifact')
    }
  } finally {
    directory.closeSync()
  }
  if (primary.length > maximumStateFiles) {
    fail('bootstrap resume video batch state count exceeds the bounded limit')
  }
  const primarySet = new Set(primary)
  for (const pathname of backups) {
    if (!primarySet.has(pathname)) fail('bootstrap resume video batch backup has no authoritative primary')
  }
  const activeStatuses = new Set([
    'queued', 'staging', 'submitted', 'accepted', 'running', 'waiting', 'recovering', 'paused',
  ])
  const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled', 'attention'])
  const batchStatuses = new Set([
    ...activeStatuses, 'succeeded', 'completed_with_errors', 'failed', 'cancelled', 'attention',
  ])
  const durable = new Map()
  let visited = 0
  let totalBytes = 0
  for (const name of primary.sort()) {
    const pathname = join(root, name)
    const stateEntry = safeEntry(pathname, 'bootstrap resume video batch state', 'file', {
      maximumBytes: maximumStateBytes,
      nonempty: true,
    })
    totalBytes += Number(stateEntry.size)
    if (totalBytes > maximumTotalStateBytes) {
      fail('bootstrap resume video batch states exceed the bounded byte limit')
    }
    const state = readJson(pathname, 'bootstrap resume video batch state', {
      maximumBytes: maximumStateBytes,
    })
    if (![1, 2].includes(state?.schemaVersion) || !Array.isArray(state.items)
      || typeof state.status !== 'string' || !batchStatuses.has(state.status)) {
      fail('bootstrap resume video batch state contract is invalid')
    }
    let activeItems = 0
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
      if (durable.has(taskId)) fail('bootstrap resume video batch task identity is duplicated')
      durable.set(taskId, { taskId, status, origin: 'durable' })
    }
    if (activeStatuses.has(state.status) && activeItems === 0) {
      const batchId = typeof state.batchId === 'string' ? state.batchId.trim() : ''
      if (!/^[A-Za-z0-9._:-]{1,80}$/u.test(batchId)) {
        fail('bootstrap resume active video batch has no valid durable identity')
      }
      const taskId = `batch:${batchId}`
      if (durable.has(taskId)) fail('bootstrap resume video batch identity is duplicated')
      durable.set(taskId, {
        taskId,
        status: state.status === 'running' ? 'running' : 'waiting',
        origin: 'durable-batch',
      })
    }
  }
  return [...durable.values()]
}
